"""Producer receipts, not independent audits. Hash parsed inputs incrementally, never provider bytes.

Only the fixed engine file set is read. No Git, database, environment or network inspection.
"""
import hashlib
import json
import math
import os
import re
from decimal import Decimal

from .canonical import canonical_hash, canonical_json, normalize_decimal
from . import futures_costs as costs

SCHEMA = "balancita.strategy-gate-provenance.v1"
AUDIT_SCHEMA = "balancita.strategy-gate-audit.v1"
REPRESENTATION = "parsed_records_in_consumption_order.v1"
ENGINE_FILES = (
    "canonical.py", "strategy_gate_provenance.py", "strategy_gate.py", "gate_trace.py",
    "strategy_gate_accounting.py", "strategy_gate_splits.py", "strategy_evaluation_policy.py",
    "strategy_gate_models.py", "futures_simulator.py", "futures_spec_strategy.py",
    "futures_indicators.py", "indicator_catalog.py", "futures_strategies.py", "futures_hits.py",
    "futures_costs.py", "futures_funding_context.py", "futures_history.py", "futures_products.py",
    "futures_qwen_practice.py", "futures_qwen_practice_report.py", "futures_strategy_reliability.py",
    "futures_purged.py",
)
CONFIG_KEYS = ("schema", "version", "holdout_from", "practice_folds", "exam_folds", "random_draws",
               "bootstrap_draws", "seed", "neighbors", "rules")
HASH = re.compile(r"^[0-9a-f]{64}$")
NAME = re.compile(r"^[A-Za-z0-9_.<>-]{1,160}$")
DECIMAL_FIELDS = {"open", "high", "low", "close", "volume_btc", "rate", "entry_price", "exit_price",
                  "stop_price", "target_price", "quantity", "notional_usd"}


def _canonical(value):
    # Floats here describe actual statistical inputs, not financial arithmetic. Tag their shortest
    # round-trippable decimal representation; do not normalize arbitrary strings or round values.
    if isinstance(value, (float, Decimal)):
        if not math.isfinite(value):
            raise ValueError("non-finite provenance number")
        return {"decimal": normalize_decimal(str(value))}
    if isinstance(value, dict):
        return {k: _canonical(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    return value


def digest(value):
    return canonical_hash(_canonical(value))


def component(value):
    return {"value": value, "sha256": digest(value)}


def _hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def _int(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


class Records:
    """Length-framed canonical records; constant working memory beyond one already-loaded record."""
    def __init__(self, kind):
        self.kind, self.count, self.first, self.last = kind, 0, None, None
        self.hash = hashlib.sha256()
        self.valid = True

    def add(self, row):
        try:
            if self.kind == "funding":
                row = {"bucket_start": row[0], "rate": normalize_decimal(str(row[1]))}
            else:
                row = {k: normalize_decimal(str(v)) if k in DECIMAL_FIELDS and v is not None else v
                       for k, v in row.items()}
            at = row.get("bucket_start", row.get("entry_time_ms"))
            if not _int(at):
                raise ValueError("missing input time")
            body = canonical_json(_canonical(row)).encode("utf-8")
            self.hash.update(len(body).to_bytes(8, "big"))
            self.hash.update(body)
            if self.count == 0:
                self.first = at
            self.last = at
        except (TypeError, ValueError, ArithmeticError):
            self.valid = False
        self.count += 1
        return row

    def consume(self, rows, before_ms=None, step_ms=0):
        for row in rows:
            # frames reads one pending 5m candle ahead; that lookahead is not an indicator input.
            if before_ms is None or row["bucket_start"] + step_ms <= before_ms:
                self.add(row)
            yield row

    def summary(self):
        return {"representation": REPRESENTATION, "sha256": self.hash.hexdigest() if self.valid else None,
                "count": self.count, "first_ms": self.first, "last_ms": self.last,
                "state": "available" if self.valid else "unavailable"}


def record_digest(rows, kind):
    records = Records(kind)
    for row in rows:
        records.add(row)
    return records.summary()


def engine_identity(root=None, names=ENGINE_FILES):
    files = {}
    for name in names:
        try:
            hasher = hashlib.sha256()
            with open(os.path.join(root or os.path.dirname(__file__), name), "rb") as handle:
                for block in iter(lambda: handle.read(65536), b""):
                    hasher.update(block)
            files[name] = hasher.hexdigest()
        except OSError:
            files[name] = None
    return {"files": files, "sha256": digest(files), "state": "complete" if all(files.values()) else "partial"}


def cost_identity(product_list, book):
    applied = [{"product": product, "tick_size": normalize_decimal(tick),
                "maker_rate": str(costs.fee_rate("maker")), "taker_rate": str(costs.fee_rate("taker")),
                "spread_bp": str(costs.spread_bps(product)), "side_impact_bp": str(costs.side_impact_bps(product)),
                "stop_exit_bp": str(costs.stop_exit_bps(product))} for product, tick in product_list]
    return component({"version": costs.COST_MODEL_VERSION, "model_sha256": costs.cost_model_hash(),
                      "applied": applied, "evaluated_trade_costs": "current_book" if book else None,
                      "control_costs": "current_model"})


def producer_name(value):
    target = value if callable(value) and hasattr(value, "__qualname__") else type(value)
    name = target.__module__ + "." + target.__qualname__
    return name if NAME.fullmatch(name) else "unidentified"


def input_receipt(job, records, book):
    source = job.get("trade_source")
    provider = producer_name(job["provider"])
    source_name = "balancita_engine.futures_simulator.Book" if book else producer_name(source)
    known_provider = provider == "balancita_engine.strategy_gate.KrakenProvider"
    reasons = [] if book else ["original_decision_inputs_not_captured"]
    if not known_provider:
        reasons.append("provider_source_not_in_engine_identity")
    for key, value in records.items():
        if value["state"] != "available" or (key in ("candles_1m", "candles_5m", "funding") and not value["count"]):
            reasons.append("missing_or_invalid_" + key)
    return {"product": job["product"], "label": job["label"], "spec_sha256": job["spec_sha256"],
            "producer": source_name, "provider": provider,
            "scope": "book_inputs" if book else "observed_trades_only", "decision_inputs_captured": book,
            "records": records, "state": "partial" if reasons else "complete", "reasons": reasons}


def _seal(value):
    return dict(value, sha256=digest(value))


def start(cfg, spec_sha256, kind, start_ms, end_ms, product_list, family, gate_attempts, lab_variants, neighbors, book):
    evaluation = {"config": {k: cfg[k] for k in CONFIG_KEYS},
                  "gate_config_sha256": hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest(),
                  "kind": kind, "from_ms": start_ms, "to_ms": end_ms,
                  "products": [{"product": p, "tick_size": normalize_decimal(t)} for p, t in product_list],
                  "family_sha256": hashlib.sha256(family.encode()).hexdigest(), "gate_trials": gate_attempts,
                  "lab_trials": lab_variants, "total_trials": gate_attempts + lab_variants,
                  "neighbors_requested": bool(neighbors), "book": book,
                  "account_profile": "independent_fixed_notional_100_usd" if book else "observed_trades_unknown_account",
                  "execution_profile": "Book_defaults_stop_level" if book else "recorded_execution_unknown"}
    return _seal({"schema": SCHEMA, "state": "pending", "reasons": ["inputs_pending"],
                  "spec_sha256": spec_sha256, "evaluation": component(evaluation),
                  "costs": cost_identity(product_list, book), "engine": engine_identity(), "inputs": []})


def finish(receipt, inputs):
    value = {k: v for k, v in receipt.items() if k != "sha256"}
    reasons = []
    if value["engine"]["state"] != "complete":
        reasons.append("engine_source_unavailable")
    if any(i["state"] != "complete" for i in inputs):
        reasons.append("input_identity_partial")
    if [i["product"] for i in inputs if i["label"] == "base"] != [
            p["product"] for p in value["evaluation"]["value"]["products"]]:
        reasons.append("input_set_incomplete")
    value.update(inputs=inputs, reasons=reasons, state="partial" if reasons else "complete")
    return _seal(value)


def unknown():
    return {"schema": SCHEMA, "state": "unknown", "sha256": None,
            "reasons": ["missing_or_invalid_provenance"]}


def _bounded(value, depth=0):
    if depth > 16:
        raise ValueError("metadata nesting")
    if isinstance(value, dict):
        if len(value) > 64 or not all(isinstance(k, str) and len(k) <= 160 for k in value):
            raise ValueError("metadata keys")
        return 1 + sum(_bounded(v, depth + 1) for v in value.values())
    if isinstance(value, list):
        if len(value) > 256:
            raise ValueError("metadata list")
        return 1 + sum(_bounded(v, depth + 1) for v in value)
    if isinstance(value, str) and (len(value) > 256 or "/" in value or "\\" in value):
        raise ValueError("metadata text")
    if value is not None and type(value) not in (str, bool, int, float):
        raise ValueError("metadata type")
    if isinstance(value, (int, float)) and (not math.isfinite(value) or abs(value) > 2**53 - 1):
        raise ValueError("metadata number")
    return 1


def stored(value):
    """Validate bounded JSON, digest bindings AND state/count/scope invariants; never certify input truth."""
    try:
        if _bounded(value) > 20000 or not isinstance(value, dict) or value.get("schema") != SCHEMA:
            raise ValueError("schema")
        if set(value) != {"schema", "state", "reasons", "sha256", "spec_sha256", "evaluation", "costs", "engine", "inputs"}:
            raise ValueError("fields")
        if not _hash(value["spec_sha256"]) or value != _seal({k: v for k, v in value.items() if k != "sha256"}):
            raise ValueError("receipt digest")
        for key in ("evaluation", "costs"):
            if value[key] != component(value[key]["value"]):
                raise ValueError("component digest")
        ev, cost, engine = value["evaluation"]["value"], value["costs"]["value"], value["engine"]
        if (ev["kind"] not in ("practice", "exam") or type(ev["book"]) is not bool
                or type(ev["neighbors_requested"]) is not bool or not _int(ev["from_ms"])
                or not _int(ev["to_ms"]) or ev["from_ms"] >= ev["to_ms"]
                or any(not _int(ev[k]) for k in ("gate_trials", "lab_trials", "total_trials"))
                or ev["total_trials"] != ev["gate_trials"] + ev["lab_trials"]
                or not _hash(ev["family_sha256"]) or not _hash(ev["gate_config_sha256"])
                or set(ev["config"]) != set(CONFIG_KEYS) or not _int(ev["config"]["seed"])
                or not ev["products"] or len(ev["products"]) > 16):
            raise ValueError("evaluation")
        if (ev["account_profile"] != ("independent_fixed_notional_100_usd" if ev["book"] else "observed_trades_unknown_account")
                or ev["execution_profile"] != ("Book_defaults_stop_level" if ev["book"] else "recorded_execution_unknown")
                or cost["evaluated_trade_costs"] != ("current_book" if ev["book"] else None)
                or cost["control_costs"] != "current_model" or not _hash(cost["model_sha256"])
                or not isinstance(cost["version"], str) or not cost["version"]):
            raise ValueError("execution/cost scope")
        products = ev["products"]
        if len({row["product"] for row in products}) != len(products) or len(cost["applied"]) != len(products):
            raise ValueError("products")
        for product, applied in zip(products, cost["applied"]):
            if (not NAME.fullmatch(product["product"]) or Decimal(product["tick_size"]) <= 0
                    or any(applied[k] != product[k] for k in ("product", "tick_size"))):
                raise ValueError("applied product")
            for key in ("maker_rate", "taker_rate", "spread_bp", "side_impact_bp", "stop_exit_bp"):
                if normalize_decimal(applied[key]) != normalize_decimal(str(Decimal(applied[key]))) or Decimal(applied[key]) < 0:
                    raise ValueError("cost number")
            if Decimal(applied["stop_exit_bp"]) != Decimal(applied["spread_bp"]) + Decimal(applied["side_impact_bp"]):
                raise ValueError("stop cost")
        files = engine["files"]
        if (set(files) != set(ENGINE_FILES) or any(v is not None and not _hash(v) for v in files.values())
                or engine != {"files": files, "sha256": digest(files),
                              "state": "complete" if all(files.values()) else "partial"}):
            raise ValueError("engine identity")
        inputs = value["inputs"]
        if not isinstance(inputs, list):
            raise ValueError("inputs")
        for item in inputs:
            book = item["scope"] == "book_inputs"
            if (book != ev["book"] or item["decision_inputs_captured"] is not book
                    or item["product"] not in [r["product"] for r in products]
                    or not _hash(item["spec_sha256"]) or not NAME.fullmatch(item["producer"])
                    or not NAME.fullmatch(item["provider"])):
                raise ValueError("input scope")
            if item["label"] == "base" and item["spec_sha256"] != value["spec_sha256"]:
                raise ValueError("input spec")
            keys = {"candles_1m", "candles_5m", "funding", "observed_trades"} if book else {"control_candles_1m", "observed_trades"}
            if set(item["records"]) != keys:
                raise ValueError("record components")
            for record in item["records"].values():
                n = record["count"]
                if (record["representation"] != REPRESENTATION or not _int(n)
                        or record["state"] not in ("available", "unavailable")
                        or (record["state"] == "available") != _hash(record["sha256"])):
                    raise ValueError("record identity")
                if n == 0:
                    if record["first_ms"] is not None or record["last_ms"] is not None or record["sha256"] != hashlib.sha256(b"").hexdigest():
                        raise ValueError("empty records")
                elif record["state"] == "available" and not all(_int(record[k]) for k in ("first_ms", "last_ms")):
                    raise ValueError("record bounds")
            # Reconstruct the producer's reasons; a recomputed envelope cannot elevate a limited source.
            reasons = [] if book else ["original_decision_inputs_not_captured"]
            if item["provider"] != "balancita_engine.strategy_gate.KrakenProvider":
                reasons.append("provider_source_not_in_engine_identity")
            for key, record in item["records"].items():
                if record["state"] != "available" or (key in ("candles_1m", "candles_5m", "funding") and not record["count"]):
                    reasons.append("missing_or_invalid_" + key)
            if item["reasons"] != reasons or item["state"] != ("partial" if reasons else "complete"):
                raise ValueError("input completeness")
            if book and item["producer"] != "balancita_engine.futures_simulator.Book":
                raise ValueError("book producer")
        if value["state"] == "pending":
            if inputs or value["reasons"] != ["inputs_pending"]:
                raise ValueError("pending")
        else:
            base = [i for i in inputs if i["label"] == "base"]
            if (len({i["product"] for i in base}) != len(base) or value != finish(value, inputs)):
                raise ValueError("final state")
        return value
    except (KeyError, TypeError, ValueError, ArithmeticError, RecursionError, OverflowError):
        return unknown()


def audit(receipt, artifact_state="pending", trace_required=True, trace_captured=False, reason=None):
    receipt = stored(receipt)
    state = artifact_state
    reasons = []
    if artifact_state == "available":
        if receipt["state"] != "complete":
            reasons.append("provenance_incomplete")
        if trace_required and not trace_captured:
            reasons.append("decision_trace_not_captured")
        state = "partial" if reasons else "available"
    else:
        reasons = [reason or {"pending": "artifact_pending", "unavailable": "artifact_write_failed",
                              "unknown": "missing_or_invalid_audit_metadata"}[artifact_state]]
    return {"schema": AUDIT_SCHEMA, "state": state, "artifact_state": artifact_state,
            "provenance_sha256": receipt["sha256"], "trace_required": trace_required, "trace_captured": trace_captured,
            "boundary": "atomic_bundle_publish", "evidence_ready": state == "available",
            "independently_verified": False, "full_policy_replay": False, "reasons": reasons}


def stored_audit(value, receipt):
    try:
        if (not isinstance(value, dict) or type(value["trace_required"]) is not bool
                or type(value["trace_captured"]) is not bool or len(value["reasons"]) > 2):
            raise ValueError("audit")
        reason = value["reasons"][0] if value["artifact_state"] != "available" else None
        allowed = {"pending": {"artifact_pending"}, "unavailable": {"artifact_write_failed", "run_failed", "run_cancelled"},
                   "unknown": {"missing_or_invalid_audit_metadata"}}
        if value["artifact_state"] != "available" and reason not in allowed.get(value["artifact_state"], set()):
            raise ValueError("audit reason")
        expected = audit(receipt, value["artifact_state"], value["trace_required"], value["trace_captured"], reason)
        if value != expected or stored(receipt)["state"] == "unknown":
            raise ValueError("audit consistency")
        return value
    except (TypeError, KeyError, ValueError, IndexError):
        return audit(unknown(), "unknown")
