"""Isolated historical replay (stage 9A): public Kraken candles and funding -> the existing ``PaperRunner``, with modelled execution.

What this module is: an event generator and a result writer around the runner that already decides, sizes, costs and
accounts (``execution_mode="modelled"``). It adds no financial rule and no second engine.

What it is not: evidence of profitability. The candles are the ones earlier research used, and every fill is a
*modelled* price (``MODELLED_EXECUTION``): no bid/ask of the past exists. Four scenarios (S0-S3) show how much the result
moves with the execution hypothesis; none of them is an observation.

Causality, by rule (not by the ``known_at`` of a backfill, which is the day the data was downloaded):

* the 1-minute candle ``b`` is delivered at ``b + 60 s + data_lag``; the cycle that decides on the 5-minute bar closing at
  ``c`` is delivered at ``c + data_lag``, after the candle that closes at ``c`` (candles first, then funding, then cycles);
* the funding of hour ``[s, s+1h)`` is delivered at ``s + 1h + 10 min`` (the publication lag ``FundingContext`` uses), never
  earlier; an hour with no row is *unknown*, not zero;
* a fill price is dated at the instant of the fill and comes from a candle that opened at or before it (S2, the adverse
  stress, deliberately does not: it uses the extreme of the entry minute and is declared as such);
* nothing at or after ``replay_data.HI_EXCL_MS`` is read (``ReplayDataGate``).

Nothing here uses the wall clock, the network or randomness. Reads are ``mode=ro``; the only writes are the run directory
the caller names (``signals.jsonl`` and ``results.json``, written once).
"""

import argparse
import bisect
import hashlib
import heapq
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal

from . import replay_data as RD
from . import signal_continuity as SC
from .execution_timing import ExecutionPolicy
from .futures_costs import cost_model_hash, side_impact_bps
from .futures_funding_context import PUBLICATION_LAG_MS, WINDOW, FundingContext, with_publication_wait
from .futures_simulator import ONE_MINUTE_MS, FIVE_MINUTES_MS
from .multi_experiment import FrameFeeder
from .multi_signals import default_strategies, merged_indicators, stable_hash
from .paper_runner import PaperRunner, RunnerConfig, build_identity, engine_behavior, make_event
from .paper_runner_report import counts, integrated_audit
from .portfolio import PortfolioPolicy
from .portfolio_audit import accounting_digest
from .portfolio_watch import WatchPolicy
from . import replay_funding_audit as RFA
from .replay_specs import FROZEN_IDS, load_frozen

D = Decimal
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
SCHEMA = "balancita-replay.v1"
EXECUTION_LABEL = "MODELLED_EXECUTION"
SOURCE = "replay-history"
SCENARIOS = ("S0", "S1", "S2", "S3")
SCENARIO_TEXT = {
    "S0": "COUNTERFACTUAL: the open of the minute the decision closes on, a price from before the decision was delivered (cycle + 2 s)",
    "S1": "base: the open of the next minute (about one minute after the decision)",
    "S2": "adverse stress, NOT causal: the worst extreme of the entry minute (high for a buy, low for a sell)",
    "S3": "EXPERIMENTAL SENSITIVITY: S1 plus one more side impact of the product as extra slippage (authorised by Fran 2026-10-14 only as a sensitivity; not validated for future operations nor for changing the financial model)",
}
DATA_LAG_MS = 2_000                  # a closed candle / a cycle is delivered this long after the close (hypothesis)
FUNDING_LAG_MS = 600_000             # the funding of an hour is usable 10 minutes after the hour ends (hypothesis)
MAX_EXECUTION_DELAY_MS = 120_000     # S1-S3 fill about one minute after the decision; the default 60 s would expire them
TAIL_MS = DAY_MS                     # candles after the last decision (policy cut_decisions_24h_before_end); C29/C30/C32 hold up to 24 h
SCENARIO_CLASS = {"S0": "counterfactual", "S1": "modelled_base", "S2": "non_causal_stress", "S3": "experimental_sensitivity"}
WINDOW_POLICIES = {
    "cut_decisions_24h_before_end": "decisions stop 24 h before the end of the data so that positions can close with data; "
                                    "a position still open at the end is reported, never closed",
    "decide_until_data_end": "decisions run until the end of the data; positions still open at the end are reported as "
                             "open_at_window_end, marked to the last authorised candle, and are never closed with later data",
}
KIND_RANK = {"candle": 0, "funding": 1, "cycle": 2}
CODE_MODULES = ("replay_data", "replay_execution", "replay_driver", "replay_specs", "paper_runner", "signal_continuity",
                "multi_experiment", "multi_signals", "multi_risk", "futures_funding_context", "futures_spec_strategy",
                "futures_simulator", "futures_costs", "execution_timing", "portfolio")


class ReplayError(ValueError):
    """The replay cannot start or continue honestly."""


@dataclass(frozen=True)
class ReplayConfig:
    products: tuple
    decision_start_ms: int
    decision_end_ms: int                 # exclusive: no decision from here on
    scenario: str = "S1"
    strategy_ids: tuple = ()             # () = every native strategy (mx-funding, mx-momentum, mx-meanrev)
    data_end_ms: int = 0                 # exclusive end of the candles read; 0 = decision_end + 24 h, capped
    load_start_ms: int = 0               # first candle read (warm-up); 0 = 21 days before the first decision, floored
    allow_gaps: bool = False             # declared in the manifest when true
    extra_slippage_bps: str = ""         # S3 only; "" = one more side impact of each product
    strategy_set: str = "frozen"         # "frozen": C29, C30, C32 from their spec files; "mx": the native mx-* fixtures
    dedupe_modelled_prices: bool = True  # one price event per (product, instant, price, scenario)
    window_policy: str = "decide_until_data_end"   # target policy (Fran 2026-10-14); or "cut_decisions_24h_before_end"

    def resolved(self):
        tail = TAIL_MS if self.window_policy == "cut_decisions_24h_before_end" else 0
        data_end = self.data_end_ms or min(self.decision_end_ms + tail, RD.HI_EXCL_MS)
        load_start = self.load_start_ms or max(RD.LO_MS, self.decision_start_ms - 21 * DAY_MS)
        return ReplayConfig(**dict(asdict(self), products=tuple(self.products), strategy_ids=tuple(self.strategy_ids),
                                   data_end_ms=data_end, load_start_ms=load_start))

    def validate(self):
        if self.scenario not in SCENARIOS:
            raise ReplayError("unknown scenario {!r}".format(self.scenario))
        if self.strategy_set not in ("frozen", "mx"):
            raise ReplayError("unknown strategy set {!r}".format(self.strategy_set))
        if self.window_policy not in WINDOW_POLICIES:
            raise ReplayError("unknown window policy {!r}".format(self.window_policy))
        if not self.products:
            raise ReplayError("no products")
        if self.decision_end_ms <= self.decision_start_ms:
            raise ReplayError("empty decision window")
        if self.window_policy == "cut_decisions_24h_before_end" and self.decision_end_ms > RD.HI_EXCL_MS - RD.FUNDING_MARGIN_MS - TAIL_MS:
            raise ReplayError("decisions must stop {} hours before the cap so positions can close "
                              "(or choose window_policy=decide_until_data_end)".format(TAIL_MS // HOUR_MS))
        RD.check_window(self.load_start_ms, self.data_end_ms)
        if self.data_end_ms > RD.HI_EXCL_MS - RD.FUNDING_MARGIN_MS:
            raise ReplayError("the data window must end at least {} h before the global cap {}: funding is not read closer, so "
                              "that nothing at or after the cap is ever reached".format(RD.FUNDING_MARGIN_MS // HOUR_MS, iso(RD.HI_EXCL_MS)))
        if self.load_start_ms > self.decision_start_ms or self.data_end_ms < self.decision_end_ms:
            raise ReplayError("the data window must cover the decision window")


def execution_policy():
    return ExecutionPolicy(max_execution_delay_ms=MAX_EXECUTION_DELAY_MS)


# ---------------------------------------------------------------------------------------------------- identity
def code_identity():
    here = os.path.dirname(os.path.abspath(__file__))
    modules = {}
    for name in CODE_MODULES:
        with open(os.path.join(here, name + ".py"), "rb") as handle:
            modules[name] = stable_hash(handle.read().replace(b"\r\n", b"\n").decode("utf-8"))[:16]
    return {"schema": SCHEMA, "modules": modules, "digest": stable_hash(modules)[:16]}


def file_fingerprint(path):
    """Size and the hash of the first 64 KiB (the SQLite header changes with every write): the version of a database,
    independent of where it lives."""
    with open(path, "rb") as handle:
        head = handle.read(65_536)
    return {"size": os.path.getsize(path), "head_sha256": hashlib.sha256(head).hexdigest()}


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------------- data
def load_data(candles_db, funding_db, config):
    """Reads and verifies everything the run needs. Returns ``{"products": {...}, "reports": {...}, "hash": ...}``.

    The replay refuses to start if a series is unordered, misaligned, has invalid OHLC, has two different revisions of a
    bucket, or has missing buckets inside the decision window (unless ``allow_gaps``, which the manifest then declares)."""
    cfg = config.resolved()
    cfg.validate()
    problems, reports, per_product = [], {}, {}
    gate = RD.ReplayDataGate(candles_db, cfg.load_start_ms, cfg.data_end_ms)
    fgate = RD.ReplayDataGate(funding_db, RD.LO_MS, cfg.data_end_ms)
    try:
        for product in cfg.products:
            one, five = gate.candles(product, ONE_MINUTE_MS), gate.candles(product, FIVE_MINUTES_MS)
            funding = fgate.relative_funding(product)
            conflicts = gate.conflicting_revisions(product, ONE_MINUTE_MS) + gate.conflicting_revisions(product, FIVE_MINUTES_MS)
            r1 = RD.series_report(one, ONE_MINUTE_MS, cfg.load_start_ms, cfg.data_end_ms)
            r5 = RD.series_report(five, FIVE_MINUTES_MS, cfg.load_start_ms, cfg.data_end_ms)
            decision_gaps = [g for g in r1["gaps"] if g[1] >= cfg.decision_start_ms - FIVE_MINUTES_MS and g[0] < cfg.data_end_ms]
            report = {"1m": r1, "5m": r5, "aggregation_5m_vs_1m": RD.consistency_5m_vs_1m(one, five),
                      "funding": RD.funding_report(funding, RD.LO_MS, cfg.data_end_ms),
                      "conflicting_revisions": conflicts[:20], "gaps_in_decision_window_1m": decision_gaps[:20],
                      "candles_max_bucket": one[-1]["bucket_start"] if one else None}
            for name, rep in (("1m", r1), ("5m", r5)):
                for key in ("unordered", "misaligned", "outside_window", "invalid_ohlc"):
                    if rep[key]:
                        problems.append("{} {}: {}={}".format(product, name, key, rep[key]))
            if conflicts:
                problems.append("{}: {} buckets with conflicting revisions".format(product, len(conflicts)))
            if not one or not five:
                problems.append("{}: no candles".format(product))
            if decision_gaps and not cfg.allow_gaps:
                problems.append("{}: {} gaps of 1m candles inside the decision window".format(product, len(decision_gaps)))
            if one and one[-1]["bucket_start"] + ONE_MINUTE_MS > RD.HI_EXCL_MS:
                problems.append("{}: a candle reaches the cap".format(product))
            if funding and funding[-1][0] + HOUR_MS > RD.HI_EXCL_MS:
                problems.append("{}: a funding hour reaches the cap".format(product))
            reports[product] = report
            per_product[product] = {"1m": one, "5m": five, "funding": funding,
                                    "data_hash": RD.data_hash(one, five, funding)}
    finally:
        gate.close()
        fgate.close()
    if problems:
        raise ReplayError("data check failed: " + "; ".join(problems))
    return {"products": per_product, "reports": reports,
            "hash": stable_hash({p: v["data_hash"] for p, v in sorted(per_product.items())}),
            "statements": gate.statements + fgate.statements,
            "files": {"candles": file_fingerprint(candles_db), "funding": file_fingerprint(funding_db)}}


# ---------------------------------------------------------------------------------------------------- events
def _candle_event(product, candle):
    bucket = candle["bucket_start"]
    return make_event("candle", {"product_id": product, "bucket_ms": bucket,
                                 "candle": {k: str(candle[k]) for k in ("open", "high", "low", "close")}},
                      t_ms=bucket + ONE_MINUTE_MS + DATA_LAG_MS, source=SOURCE, stream="candles:" + product)


def funding_flags(context, at_ms):
    """How the funding line the forward would use looks at ``at_ms``: ``unknown`` (under 30 days), ``stale`` (the newest usable
    hour is not the latest one that was due: the forward then carries the older rate silently) and ``long_window`` (the 720
    rows reach back more than 30 days because hours are missing). Diagnostic only: ``FundingContext`` is not changed."""
    index = bisect.bisect_right(context.starts, at_ms - HOUR_MS - PUBLICATION_LAG_MS) - 1
    if index < WINDOW:
        return {"unknown": True, "stale": False, "long_window": False}
    due = ((at_ms - PUBLICATION_LAG_MS - HOUR_MS) // HOUR_MS) * HOUR_MS
    return {"unknown": False, "stale": context.starts[index] < due,
            "long_window": context.starts[index - 1] - context.starts[index - WINDOW] > (WINDOW - 1) * HOUR_MS}


def make_cycle_event(product, close_ms, frame, cycle_atr=None, source=None, lag_ms=None):
    """The ``cycle`` event of one closed 5-minute bar. ``cycle_atr(frame)`` is the strategies' own volatility (the frozen specs'
    stop distance), else the frame's default ATR. Reusable: the same assembly for any producer of cycles."""
    trend = frame[3]
    atr = cycle_atr(frame) if cycle_atr is not None else None
    atr = trend["atr14"] if atr is None or atr <= 0 else atr
    return make_event("cycle", {"product_id": product, "cycle_ms": close_ms, "price": str(trend["candidate_close"]), "atr": str(atr)},
                      t_ms=close_ms + (DATA_LAG_MS if lag_ms is None else lag_ms), source=source or SOURCE, stream="cycles:" + product)


def funding_audit_row(strategy, product, original_action, flag):
    """One audit row of a funding-dependent strategy's evaluation: the forward's funding line (``flag`` from
    ``replay_funding_audit.audit_record``), the signal that was produced and how the strict reading relates to it."""
    row = dict(flag, strategy_id=strategy.id, product_id=product, original=original_action)
    row["incomplete_evidence"] = original_action != "WAIT" and bool(flag.get("carry_forward") or flag.get("long_window"))
    row["strict_class"] = RFA.classify(original_action, flag["strict_signal"])
    return row


def product_events(product, data, strategies, cfg, frames, cycle_atr=None, flags=None):
    """``(key, event)`` for one product, in time order: its candles and its cycles. ``frames`` receives the frame of each
    cycle (keyed by product and cycle) for the evaluator; nothing is looked up that was not known at that frame."""
    periods = merged_indicators(strategies)
    bands = next((s.funding_bands for s in strategies if getattr(s, "funding_bands", None)), None)
    feeder = FrameFeeder(periods)
    context = FundingContext(with_publication_wait([(s, float(r)) for s, r in data["funding"]]))
    feed_from = cfg.decision_start_ms - FIVE_MINUTES_MS
    seq = 0
    for frame in feeder.stream(data["1m"], data["5m"], context):
        bucket = frame[0]
        close_ms = bucket + ONE_MINUTE_MS
        if close_ms + DATA_LAG_MS > cfg.data_end_ms + DATA_LAG_MS:
            break
        if close_ms >= feed_from:
            seq += 1
            candle = data["_by_minute"][bucket]
            event = _candle_event(product, candle)
            yield (event["t_ms"], KIND_RANK["candle"], product, seq), event
        if cfg.decision_start_ms <= close_ms < cfg.decision_end_ms and SC.on_cycle(frame):
            trend = frame[3]
            seq += 1
            frames[(product, close_ms)] = frame
            if flags is not None:
                flags[(product, close_ms)] = RFA.audit_record(context, close_ms, bands)
            event = make_cycle_event(product, close_ms, frame, cycle_atr)
            yield (event["t_ms"], KIND_RANK["cycle"], product, seq), event


def funding_events(product, data, cfg):
    """One event per funding hour, delivered at its end plus the publication lag. Hours without a row produce nothing."""
    first = cfg.decision_start_ms - 2 * HOUR_MS
    for number, (start, rate) in enumerate(data["funding"]):
        t_ms = start + HOUR_MS + FUNDING_LAG_MS
        if start < first or t_ms > cfg.data_end_ms + DATA_LAG_MS:
            continue
        event = make_event("funding", {"product_id": product, "periods": [[start, start + HOUR_MS, rate]]}, t_ms=t_ms,
                           source=SOURCE, stream="funding:" + product)
        yield (t_ms, KIND_RANK["funding"], product, number), event


def modelled_fill(scenario, order, one_minute, extra_bps):
    """``(fill_ms, price_text, source)`` of an order under a scenario, or ``None`` when the candle it needs is missing.
    The fill instant is dated by the scenario; the price is a real historical price (S2: the extreme of the entry minute)."""
    line = order["timeline"]
    cycle_ms, side, product = line["candle_close_ms"], order["side"], order["product_id"]
    if scenario == "S0":
        bucket, fill_ms = cycle_ms, line["earliest_fill_ms"]
    else:
        bucket, fill_ms = cycle_ms + ONE_MINUTE_MS, cycle_ms + ONE_MINUTE_MS + DATA_LAG_MS + 1_000   # after the candle before it
    candle = one_minute.get(bucket)
    if candle is None:
        return None
    if scenario == "S2":
        price, name = D(candle["high"] if side == "LONG" else candle["low"]), "extreme_of_entry_minute"
    else:
        price, name = D(candle["open"]), "open_of_minute"
    if scenario == "S3":
        extra = D(extra_bps) if extra_bps else side_impact_bps(product)
        price = price * (1 + extra / 10_000) if side == "LONG" else price * (1 - extra / 10_000)
        name = "open_of_minute_plus_slippage"
    return fill_ms, format(price, "f"), "{}:{}".format(name, bucket)


# ---------------------------------------------------------------------------------------------------- run
def run_replay(candles_db, funding_db, config, out_dir, *, data=None, strategies=None, on_runner=None):
    """Runs the replay and writes ``signals.jsonl`` and ``results.json`` (once) into ``out_dir``. Returns the results."""
    cfg = config.resolved()
    cfg.validate()
    if os.path.exists(os.path.join(out_dir, "results.json")):
        raise ReplayError("results.json already exists: a run is written once")
    os.makedirs(out_dir, exist_ok=True)
    data = data or load_data(candles_db, funding_db, cfg)
    for blob in data["products"].values():
        blob.setdefault("_by_minute", {c["bucket_start"]: c for c in blob["1m"]})
    spec_identity = None
    if strategies is None:       # ``strategies`` is for tests (scripted strategies); a real run uses the configured set
        if cfg.strategy_set == "frozen":
            strategies, spec_identity = load_frozen(ids=cfg.strategy_ids or FROZEN_IDS)
        else:
            strategies = [s for s in default_strategies() if not cfg.strategy_ids or s.id in cfg.strategy_ids]
    if not strategies:
        raise ReplayError("no strategy selected")
    runner_config = RunnerConfig(portfolio=PortfolioPolicy(), execution=execution_policy(), watch=WatchPolicy(), funding=(),
                                 start_ms=cfg.decision_start_ms, execution_mode="modelled")
    signals_path = os.path.join(out_dir, "signals.jsonl")
    if os.path.exists(signals_path):
        raise ReplayError("signals.jsonl already exists")
    log = SC.SignalLog.create(signals_path, cfg.decision_start_ms)
    frames, flags, audit_rows = {}, {}, []
    funding_diag = {"cycles": 0, "unknown": 0, "stale": 0, "long_window": 0, "funding_decisions": 0,
                    "funding_decisions_with_stale_hour": 0, "funding_decisions_with_long_window": 0}

    def evaluator(chosen, payload):
        key = (payload["product_id"], payload["cycle_ms"])
        frame, flag = frames.pop(key), flags.pop(key)
        results = SC.evaluate_cycle(chosen, payload["product_id"], payload["cycle_ms"], frame)
        funding_diag["cycles"] += 1
        for name in ("unknown", "stale", "long_window"):
            funding_diag[name] += 1 if flag[name] else 0
        for strategy, (signal, _inputs) in zip(chosen, results):
            if getattr(strategy, "uses_funding", False):
                audit_rows.append(funding_audit_row(strategy, payload["product_id"], signal["action"], flag))
            if getattr(strategy, "uses_funding", False) and signal["action"] != "WAIT":
                funding_diag["funding_decisions"] += 1
                funding_diag["funding_decisions_with_stale_hour"] += 1 if flag["stale"] else 0
                funding_diag["funding_decisions_with_long_window"] += 1 if flag["long_window"] else 0
        return results

    runner = PaperRunner(runner_config, strategies, log, evaluator=evaluator)
    manifest = run_manifest(cfg, data, runner, strategies, spec_identity)
    cycle_atr = next((s.cycle_atr for s in strategies if hasattr(s, "cycle_atr")), None)
    streams = []
    for product in cfg.products:
        streams.append(product_events(product, data["products"][product], strategies, cfg, frames, cycle_atr, flags))
        streams.append(funding_events(product, data["products"][product], cfg))
    heap, scheduled, rejections, last_t = [], set(), {}, cfg.decision_start_ms
    fills = {"scheduled": 0, "unpriced": 0, "deduplicated": 0}
    priced = set()
    counter = [0]

    def push(event):
        counter[0] += 1
        heapq.heappush(heap, (event["t_ms"], counter[0], event))

    def deliver(event):
        nonlocal last_t
        result = runner.handle(event)
        last_t = max(last_t, event["t_ms"])
        if result["status"] != "accepted":
            key = "{}:{}".format(event["kind"], result.get("reason"))
            rejections[key] = rejections.get(key, 0) + 1

    def schedule(product):
        by_minute = data["products"][product]["_by_minute"]
        for intent_id, order in sorted(runner.executor.pending.items()):
            if intent_id in scheduled or order["product_id"] != product:
                continue
            scheduled.add(intent_id)
            found = modelled_fill(cfg.scenario, order, by_minute, cfg.extra_slippage_bps)
            if found is None or found[0] > order["timeline"]["deadline_ms"]:
                fills["unpriced"] += 1
                push(make_event("clock", {}, t_ms=order["timeline"]["deadline_ms"] + 1, source=SOURCE, stream="clock"))
                continue
            fill_ms, price, source = found
            if cfg.dedupe_modelled_prices:       # one event per product / instant / price / scenario; acceptance is unchanged
                key = (product, fill_ms, price, cfg.scenario)
                if key in priced:
                    fills["deduplicated"] += 1
                    continue
                priced.add(key)
            fills["scheduled"] += 1
            push(make_event("modelled_price", {"product_id": product, "price": price, "source": source, "scenario": cfg.scenario},
                            t_ms=fill_ms, source=SOURCE, stream="modelled:" + product))

    for key, event in heapq.merge(*streams):
        while heap and heap[0][0] < event["t_ms"]:
            deliver(heapq.heappop(heap)[2])
        deliver(event)
        if event["kind"] == "cycle":
            schedule(event["payload"]["product_id"])
    while heap:
        deliver(heapq.heappop(heap)[2])
    runner.finish(last_t)
    if audit_rows:
        funding_diag["audit"] = RFA.summarize(audit_rows)
        audit_path = os.path.join(out_dir, "funding_audit.jsonl")
        text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in audit_rows)
        with open(audit_path + ".partial", "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(audit_path + ".partial", audit_path)
        funding_diag["audit_file"] = {"path": "funding_audit.jsonl", "rows": len(audit_rows),
                                      "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    results = build_results(cfg, data, runner, manifest, rejections, fills, funding_diag)
    _write_once(os.path.join(out_dir, "results.json"), results)
    if on_runner is not None:            # tests: the finished runner (journal, ledger) for recovery checks
        on_runner(runner)
    return results


def scenario_parameters(cfg):
    """What the scenario assumed, with its authorisation status, so a result can never be read without it."""
    if cfg.scenario != "S3":
        return {"scenario": cfg.scenario, "class": SCENARIO_CLASS[cfg.scenario]}
    return {"scenario": "S3", "class": SCENARIO_CLASS["S3"],
            "extra_slippage": cfg.extra_slippage_bps or "side_impact_bps of each product (current cost model)",
            "per_product_side_impact_bps": {p: str(side_impact_bps(p)) for p in cfg.products},
            "authorisation": "experimental sensitivity only (Fran 2026-10-14)",
            "warnings": ["the value is not validated for future operations", "it does not modify the financial model",
                         "it is applied on top of the S1 fill price and charged nowhere else"]}


def run_manifest(cfg, data, runner, strategies, spec_identity=None):
    manifest = {
        "schema": SCHEMA, "execution": EXECUTION_LABEL, "scenario": cfg.scenario, "scenario_text": SCENARIO_TEXT[cfg.scenario],
        "window": {"load_start": iso(cfg.load_start_ms), "decision_start": iso(cfg.decision_start_ms),
                   "decision_end_excl": iso(cfg.decision_end_ms), "data_end_excl": iso(cfg.data_end_ms),
                   "cap_excl": iso(RD.HI_EXCL_MS), "floor": iso(RD.LO_MS)},
        "products": list(cfg.products), "strategies": ["{}@{}".format(s.id, s.version) for s in strategies],
        "data_hash": data["hash"], "data_files": data["files"], "allow_gaps": cfg.allow_gaps,
        "assumptions": {"data_lag_ms": DATA_LAG_MS, "funding_lag_ms": FUNDING_LAG_MS,
                        "max_execution_delay_ms": MAX_EXECUTION_DELAY_MS,
                        "extra_slippage_bps": cfg.extra_slippage_bps or "one side impact of the product (S3 only)",
                        "funding_known_at_start_of_hour": "unproven hypothesis, not used"},
        "scenario_parameters": scenario_parameters(cfg),
        "funding_source": {"declared": "the funding database given to the run (see data_files); parity of that source with the "
                                       "forward's source is a separate audit (replay_funding_parity)",
                           "synthetic_parity_tests_are_not_a_check_on_real_data": True,
                           "holdout_isolation": {"global_cap": iso(RD.HI_EXCL_MS), "funding_margin_h": RD.FUNDING_MARGIN_MS // HOUR_MS,
                                                 "local_limit": iso(cfg.data_end_ms),
                                                 "claim": "bytes delivered to the reader are traced per response (reads.funding_stream.responses: "
                                                          "offsets, lengths, delivered_sha256, max timestamp in the delivered bytes, "
                                                          "stop reason); a timestamp at or after the cap in delivered bytes aborts the "
                                                          "run; destroying the pages from the cap on does not change the read (test); "
                                                          "no OS-level I/O trace (not required)"}},
        "runner_manifest_hash": stable_hash(runner.manifest), "cost_model_hash": cost_model_hash(),
        "build_identity": build_identity(), "engine_behavior": engine_behavior(), "code": code_identity(),
        "reads": data["statements"], "strategy_set": cfg.strategy_set, "window_policy": cfg.window_policy,
        "dedupe_modelled_prices": cfg.dedupe_modelled_prices, "spec_identity": spec_identity,
    }
    manifest["manifest_hash"] = stable_hash(manifest)
    return manifest


def _tag(trade):
    return dict(trade, execution=EXECUTION_LABEL)


def build_results(cfg, data, runner, manifest, rejections, fills, funding_diag=None):
    p = runner.portfolio
    audit_result = integrated_audit(runner)
    trades = [_tag(t) for t in p.trades]
    summary = counts(runner)
    by_strategy, by_product = {}, {}
    for t in p.trades:
        for table, key in ((by_strategy, t["strategy_id"]), (by_product, t["product_id"])):
            row = table.setdefault(key, {"trades": 0, "wins": 0, "pnl_usd": D(0), "fees_usd": D(0), "provisional": 0})
            row["trades"] += 1
            row["wins"] += 1 if t["hit"] else 0
            row["pnl_usd"] += D(str(t["pnl_usd"]))
            row["fees_usd"] += D(str(t["fees_usd"]))
            row["provisional"] += 0 if t["net_complete"] else 1
    reasons = {}
    for r in runner.executor.records:
        if r["status"] != "opened":
            for why in r.get("reasons", ()):
                reasons[why] = reasons.get(why, 0) + 1
    opened = {}
    for b in p.positions.values():
        opened[b.intent["product_id"]] = {"side": b.position["side"], "entry_price": str(b.position["entry"]),
                                          "mark": str(p.marks.get(b.intent["product_id"])), "strategy_id": b.position["strategy_id"],
                                          "status": "open_at_window_end", "execution": EXECUTION_LABEL}
    snap = p.snapshot()
    signal_entries = [e["data"]["signal"] for e in runner.log.signals() if e["data"]["origin"] == "original"]
    stop_assumed = {x["trade_id"] for x in runner.executor.modelled_log if x["kind"] == "entry_minute_stop"}
    evidence = {"uncertain_entry_minute_stop": 0, "estimated_by_ohlc": 0}
    for t in trades:
        t["evidence_class"] = "uncertain_entry_minute_stop" if t["trade_id"] in stop_assumed else "estimated_by_ohlc"
        evidence[t["evidence_class"]] += 1
    orders = [{"strategy_id": r["strategy_id"], "product_id": r["product_id"], "side": r["side"],
               "cycle_ms": r["timeline"]["candle_close_ms"], "signal_key": r["signal_key"], "status": r["status"],
               "reasons": r.get("reasons", []), "entry_price": r.get("entry_price"), "intent_id": r["intent_id"]}
              for r in runner.executor.records]
    return {
        "schema": SCHEMA, "execution": EXECUTION_LABEL,
        "label": "MODELLED_EXECUTION: integration and reproducibility test; not independent evidence of profitability",
        "scenario": cfg.scenario, "scenario_class": SCENARIO_CLASS[cfg.scenario], "manifest": manifest,
        "window": {"policy": cfg.window_policy, "policy_text": WINDOW_POLICIES[cfg.window_policy],
                   "decision_start": iso(cfg.decision_start_ms), "decision_end_excl": iso(cfg.decision_end_ms),
                   "data_end_excl": iso(cfg.data_end_ms), "positions_open_at_window_end": len(p.positions),
                   "forced_closes_with_later_data": 0},
        "signals": {"all": len(signal_entries), "entries": len([x for x in signal_entries if x["action"] != "WAIT"]),
                    "set_hash": stable_hash(sorted(x["signal_id"] for x in signal_entries)),
                    "entries_hash": stable_hash(sorted(x["signal_id"] for x in signal_entries if x["action"] != "WAIT"))},
        "orders": orders, "funding_diagnostics": funding_diag or {},
        "pnl_split": {"realized_closed_trades_usd": str(sum((D(str(t["pnl_usd"])) for t in p.trades), D(0))),
                      "unrealized_open_positions_usd": str(snap["unrealized_usd"]),
                      "open_positions_at_window_end": len(p.positions),
                      "note": "equity includes unrealized P&L of open positions; compare realized results only with realized "
                              "results, and only with the open positions stated"},
        "evidence": {"classes": evidence, "stops": "OHLC candles are not quotes: a stop or target on a candle is estimated; "
                                                    "a stop assumed inside the entry minute is uncertain (the extreme may "
                                                    "have preceded the fill)", "observed_by_quotes": 0},
        "data_quality": data["reports"],
        "counts": {k: (str(v) if isinstance(v, D) else v) for k, v in summary.items()},
        "capital": {k: snap[k] for k in ("initial_equity_usd", "capital_definitive_usd", "provisional_gains_usd", "equity_usd",
                                          "unrealized_usd", "gross_exposure_usd", "net_exposure_usd", "drawdown_usd",
                                          "realized_complete_usd", "realized_partial_usd", "fees_usd", "funding_usd")},
        "by_strategy": {k: {kk: (str(vv) if isinstance(vv, D) else vv) for kk, vv in v.items()} for k, v in sorted(by_strategy.items())},
        "by_product": {k: {kk: (str(vv) if isinstance(vv, D) else vv) for kk, vv in v.items()} for k, v in sorted(by_product.items())},
        "rejection_reasons": dict(sorted(reasons.items())), "event_rejections": dict(sorted(rejections.items())),
        "modelled_prices": fills, "entry_minute": _entry_minute_summary(runner),
        "open_at_window_end": opened, "pending_orders_at_end": len(runner.executor.pending),
        "trades": trades,
        "audit": {"passed": audit_result["passed"], "violations": audit_result["violations"], "checks": audit_result["checks"]},
        "digests": {"ledger_hash": runner.executor.ledger_hash(), "accounting_digest": accounting_digest(p),
                    "financial_digest": runner.financial_digest(), "state_digest": runner.state_digest(),
                    "journal_head": runner.journal.head, "journal_entries": len(runner.journal.entries)},
        "limitations": [
            "every fill is modelled (MODELLED_EXECUTION): there is no historical bid/ask",
            "the stop evidence is OHLC (estimated); the order of events inside a candle is unknown",
            "the candles were used by earlier research: this is not an out-of-sample test",
            "funding known at the start of the hour is an unproven hypothesis: it is delivered 10 minutes after the hour ends",
            "the execution, risk and sizing parameters are hypotheses, not approved values",
            "S2 uses information of the entry minute after the fill: it is a stress, not a causal scenario",
            "signal parity with the forward is parity of code path (same interpreter and indicator pipeline on the same candles); it was not contrasted with real forward results, which start inside the reserved period",
            "orders and trades are not comparable with the forward 100 USD books: different cadence, one shared portfolio"]}


def _entry_minute_summary(runner):
    log = runner.executor.modelled_log
    return {"stop_assumed": len([x for x in log if x["kind"] == "entry_minute_stop"]),
            "clear": len([x for x in log if x["kind"] == "entry_minute_clear"]),
            "prices_ignored": len([x for x in log if x["kind"] == "modelled_price_ignored"])}


def _write_once(path, results):
    partial = path + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(results, handle, sort_keys=True, indent=1, default=str)
    os.replace(partial, path)


# ---------------------------------------------------------------------------------------------------- command line
def _ms(text):
    return int(datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Isolated historical replay with MODELLED_EXECUTION (read-only on the databases).")
    parser.add_argument("--candles-db", required=True)
    parser.add_argument("--funding-db", required=True)
    parser.add_argument("--products", required=True, help="comma-separated, e.g. PF_XBTUSD")
    parser.add_argument("--decision-start", required=True, help="YYYY-MM-DD (UTC)")
    parser.add_argument("--decision-end", required=True, help="YYYY-MM-DD (UTC), exclusive")
    parser.add_argument("--scenario", default="S1", choices=SCENARIOS)
    parser.add_argument("--strategies", default="", help="comma-separated strategy ids; empty = every strategy of the set")
    parser.add_argument("--out", required=True)
    parser.add_argument("--load-start", default="", help="YYYY-MM-DD (UTC): first candle read (warm-up); default 21 days before")
    parser.add_argument("--allow-gaps", action="store_true")
    parser.add_argument("--strategy-set", default="frozen", choices=("frozen", "mx"),
                        help="frozen: C29, C30, C32 from their spec files (default); mx: the native fixtures")
    parser.add_argument("--window-policy", default="decide_until_data_end", choices=sorted(WINDOW_POLICIES))
    args = parser.parse_args(argv)
    config = ReplayConfig(products=tuple(args.products.split(",")), decision_start_ms=_ms(args.decision_start),
                          decision_end_ms=_ms(args.decision_end), scenario=args.scenario,
                          strategy_ids=tuple(x for x in args.strategies.split(",") if x), allow_gaps=args.allow_gaps,
                          load_start_ms=_ms(args.load_start) if args.load_start else 0,
                          strategy_set=args.strategy_set, window_policy=args.window_policy)
    try:
        results = run_replay(args.candles_db, args.funding_db, config, args.out)
    except (ReplayError, RD.RangeGateError, RD.DataError) as error:
        print("replay refused: {}".format(error), file=sys.stderr)
        return 2
    print(json.dumps({"scenario": results["scenario"], "execution": results["execution"], "counts": results["counts"],
                      "capital": results["capital"], "audit_passed": results["audit"]["passed"],
                      "digests": results["digests"]}, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
