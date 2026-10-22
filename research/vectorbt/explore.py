"""Explore ANY rules strategy (``balancita-strategy.v1``) with VectorBT and get a plain-language report.

``python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode diagnostic``
``python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode variants --vary stop_atr --values 1,1.5,2,2.5``

* ``diagnostic``: runs the strategy as it is on the practice datasets (the products and window of
  ``config/strategy-gate.json``; never a candle from ``holdout_from``) and says what works and what fails.
* ``variants``: varies ONE thing (a name of ``params``, or a numeric constant of a condition by its path, e.g.
  ``rules.checks[3].node.right``) over at most 12 values you give. Every run, also the failed ones, is appended to the trial
  ledger BEFORE the report is written, and the report carries the number of attempts of the strategy's family.
* One JSON line per step goes to stdout: ``{"progress": 0-100, "phase": "...", "detail": "..."}``. The report is written to
  ``data/research-vectorbt/explorations/<exploration_id>/report.json`` (+ ``report.md``). Format: docs/vectorbt-exploration-api.md.

Everything here is a HYPOTHESIS on practice data. The gate (``strategy_gate evaluate``) is the only verdict.
"""

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

from . import data_contract as contract
from . import exploration_report as rep
from . import lab_common, trial_ledger
from .engine import ROOT, futures_costs
from .generic_signals import FeatureStore, Market, UnsupportedSpec, evaluate_spec
from .generic_sim import simulate_plan
from balancita_engine.canonical import canonical_hash
from balancita_engine import spec_variation
from balancita_engine.futures_spec_strategy import SpecError, load_spec, validate_spec
from balancita_engine.spec_variation import VariationError

MAX_VALUES = 12
DEFAULT_DATASETS = os.path.join(ROOT, "data", "research-vectorbt", "practice")
DEFAULT_OUT = os.path.join(ROOT, "data", "research-vectorbt", "explorations")
SPEC_DIR = os.path.join(ROOT, "config", "strategies")
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


# ------------------------------------------------------------------------------------------------ progress
class Progress:
    """JSON lines on ``stream`` (stdout) and/or a callback; the percentage never goes down."""

    def __init__(self, stream=None, callback=None):
        self.stream, self.callback, self.last = stream, callback, 0.0

    def emit(self, percent, phase, detail=""):
        self.last = max(self.last, min(100.0, round(float(percent), 1)))
        event = {"progress": self.last, "phase": phase, "detail": detail}
        if self.stream is not None:
            print(json.dumps(event, ensure_ascii=False), file=self.stream, flush=True)
        if self.callback is not None:
            self.callback(event)


# ----------------------------------------------------------------------------------------------- variations
# The logic lives in the engine (stdlib only) so the registry API applies exactly the same change; here the errors become
# the lab's ``ContractError``.
def _lab(function):
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except VariationError as error:
            raise contract.ContractError(str(error)) from None
    wrapped.__name__, wrapped.__doc__ = function.__name__, function.__doc__
    return wrapped


normalize_value = _lab(spec_variation.normalize_value)
describe_variation = _lab(spec_variation.describe_variation)
apply_value = _lab(spec_variation.apply_value)
check_values = _lab(spec_variation.check_values)


# ------------------------------------------------------------------------------------------------- the run
def resolve_spec(strategy):
    """A spec dict, a path to a spec file, or the id of a spec in ``config/strategies``."""
    if isinstance(strategy, dict):
        return validate_spec(copy.deepcopy(strategy))
    path = lab_common.resolve_path(strategy)
    if os.path.isfile(path):
        return load_spec(path)
    for name in sorted(os.listdir(SPEC_DIR)):
        if name.endswith(".json"):
            candidate = load_spec(os.path.join(SPEC_DIR, name))
            if name[:-5] == strategy or candidate["id"] == strategy:
                return candidate
    raise contract.ContractError("no encuentro la estrategia «{}» (ni como archivo ni en config/strategies)".format(strategy))


def load_markets(products, datasets_dir, gate_config, progress):
    markets = {}
    for k, product in enumerate(products):
        progress.emit(2 + 6 * k / max(1, len(products)), "Cargando datos", "Leyendo las velas de {}".format(product))
        directory = os.path.join(datasets_dir, product)
        if not os.path.isfile(os.path.join(directory, "manifest.json")):
            raise contract.ContractError(
                "falta el dataset de práctica de {} en {} (se crea con research.vectorbt.export_practice)".format(product, directory))
        markets[product] = Market.from_dataset(directory, gate_config)   # refuses anything that touches the holdout
    return markets


def _combined_sha(markets):
    if len(markets) == 1:
        return next(iter(markets.values())).dataset_sha256
    return hashlib.sha256("".join("{}:{}\n".format(p, markets[p].dataset_sha256) for p in sorted(markets)).encode()).hexdigest()


class _Runner:
    """Runs specs over the markets, sharing the features of each market between runs."""

    def __init__(self, markets, progress, units, base=8.0, span=86.0):
        self.markets, self.progress, self.units, self.done = markets, progress, max(1, units), 0
        self.stores = {p: FeatureStore(m) for p, m in markets.items()}
        self.base, self.span, self.compiled = base, span, False

    def _at(self, fraction):
        return self.base + self.span * (self.done + fraction) / self.units

    def run(self, spec, phase, detail):
        start = self.done
        try:
            return self._run(spec, phase, detail)
        except Exception:
            self.done = start + len(self.markets)   # a failed run still takes its share of the bar
            raise

    def _run(self, spec, phase, detail):
        trades, raw, skipped, open_end, codes = [], 0, 0, 0, []
        for product, market in self.markets.items():
            self.progress.emit(self._at(0.0), phase, "{} en {}".format(detail, product))
            plan = evaluate_spec(spec, market, self.stores[product])
            self.progress.emit(self._at(0.3), phase, "{} en {}: simulando".format(detail, product))
            if not self.compiled:
                self.progress.emit(self._at(0.3), "Preparando el simulador",
                                   "La primera vez compila el simulador y tarda unos 30 segundos")
            found, still_open = simulate_plan(plan, market)
            self.compiled = True
            trades += found
            raw += int((plan.raw_side != 0).sum())
            skipped += int(plan.skipped_cost.sum())
            open_end += still_open
            codes = plan.exit_codes
            self.done += 1
        self.progress.emit(self._at(0.0), phase, detail)
        return {"trades": trades, "signals": {"raw": raw, "skipped_by_cost": skipped}, "open_at_end": open_end,
                "exit_codes": codes}


def _days(markets):
    return {p: m.days for p, m in markets.items()}


def _variant_row(value, label, is_base, result, days, error=None):
    base = {"value": value, "label": label, "is_base": is_base}
    if error is not None:
        return dict(base, trades=0, entries_per_day=0.0, net_bp_mean=None, gross_bp_mean=None, hit_rate=None,
                    status="error", error=error[:300])
    trades = result["trades"]
    if not trades:
        return dict(base, trades=0, entries_per_day=0.0, net_bp_mean=None, gross_bp_mean=None, hit_rate=None,
                    status="no_trades", error=None)
    stats = rep.group_stats(trades)
    per_day = sum(rep.entries_per_day(sum(1 for t in trades if t["product"] == p), d) for p, d in days.items())
    return dict(base, trades=stats["trades"], entries_per_day=per_day, net_bp_mean=stats["net_bp_mean"],
                gross_bp_mean=stats["gross_bp_mean"], hit_rate=stats["hit_rate"], status="ok", error=None,
                # Extra figures for the side-by-side with the simulator (registry API ``compare``).
                funding_bp_mean=stats["funding_bp_mean"], funding_complete_share=stats["funding_complete_share"],
                stop_share=sum(1 for t in trades if t["exit_reason"] == "stop") / len(trades),
                signals=dict(result["signals"]))


def _rank(rows):
    ok = sorted((r for r in rows if r["status"] == "ok"), key=lambda r: (-r["net_bp_mean"], -r["entries_per_day"]))
    rest = [r for r in rows if r["status"] != "ok"]
    for k, row in enumerate(ok + rest, 1):
        row["rank"] = k
    return ok + rest


def _write_report(directory, report):
    os.makedirs(directory, exist_ok=True)
    for name, text in (("report.json", json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n"),
                       ("report.md", rep.render_markdown(report))):
        tmp = os.path.join(directory, name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, os.path.join(directory, name))


def run_exploration(strategy, *, mode="diagnostic", vary=None, values=None, exploration_id=None, products=None,
                    datasets_dir=DEFAULT_DATASETS, out_dir=DEFAULT_OUT, ledger_path=trial_ledger.DEFAULT_PATH,
                    gate_config=None, stream=None, on_progress=None, markets=None, now=None):
    """Runs an exploration and writes ``<out_dir>/<exploration_id>/report.json`` (+ ``report.md``). Returns the report.

    ``strategy``: spec dict, path, or id in ``config/strategies``. ``markets``: ready ``{product: Market}`` (tests); when
    omitted the sealed datasets of ``datasets_dir`` are read (and checked against the holdout and their manifests).
    Raises ``contract.ContractError`` for a request the lab refuses; a spec it cannot evaluate is NOT an error: the
    report says so (``status: "unsupported"``).
    """
    progress = Progress(stream, on_progress)
    spec = resolve_spec(strategy)
    if mode not in ("diagnostic", "variants"):
        raise contract.ContractError("modo desconocido «{}» (diagnostic o variants)".format(mode))
    variation, wanted = None, []
    if mode == "variants":
        if not vary:
            raise contract.ContractError("el modo variants necesita qué variar (--vary)")
        variation = describe_variation(spec, vary)
        wanted = check_values(values or [])
    started_at = datetime.fromtimestamp(now if now is not None else time.time(), tz=timezone.utc)
    exploration_id = exploration_id or "{}-{}".format(spec["id"], started_at.strftime("%Y%m%d-%H%M%S"))
    if not _SLUG.match(exploration_id):
        raise contract.ContractError("el id de la exploración solo puede tener letras, números, punto, guion y guion bajo")
    directory = os.path.join(out_dir, exploration_id)
    if os.path.exists(os.path.join(directory, "report.json")):
        raise contract.ContractError("ya existe la exploración {}: usá otro id".format(exploration_id))
    gate_path = gate_config or contract.DEFAULT_GATE_CONFIG
    gate = contract.load_gate_config(gate_path)
    requested = bool(products)
    products = list(products or gate["default_products"])
    progress.emit(0, "Preparando", "Estrategia {}".format(spec["id"]))
    if markets is None:
        markets = load_markets(products, datasets_dir, gate_path, progress)
    else:
        missing = [p for p in products if p not in markets] if requested else []
        if missing:
            raise contract.ContractError("faltan los mercados de: {}".format(", ".join(missing)))
        markets = {p: markets[p] for p in products} if requested else dict(markets)
    products = list(markets)
    family = trial_ledger.family_of(spec["id"])
    min_trades = int(gate.get("rules", {}).get("min_trades", 100))
    spec_hash = canonical_hash(spec)
    others = [v for v in wanted if v != (variation or {}).get("base_value")]
    runner = _Runner(markets, progress, (1 + len(others)) * len(markets))
    report = {
        "schema": rep.SCHEMA, "exploration_id": exploration_id, "mode": mode, "status": "ok",
        "strategy_id": spec["id"], "strategy_name": spec.get("name"), "family": family, "spec_hash": spec_hash,
        "window": {"from": min(m.start_utc for m in markets.values()), "to": max(m.end_utc for m in markets.values())},
        "products": products, "dataset_sha256": _combined_sha(markets),
        "datasets": [{"product": p, "dataset_sha256": m.dataset_sha256, "from": m.start_utc, "to": m.end_utc}
                     for p, m in markets.items()],
        "generated_at": started_at.strftime("%Y-%m-%dT%H:%M:%SZ"), "cost_model_version": futures_costs.COST_MODEL_VERSION,
        "warning": rep.WARNING, "glossary": rep.GLOSSARY, "unsupported": None, "diagnostic": None,
        "vary": None, "variants": None, "variants_headline": None, "attempts_in_family": None,
    }
    try:
        base = runner.run(spec, "Probando la estrategia", "Estrategia tal cual")
    except UnsupportedSpec as error:
        report["status"], report["unsupported"] = "unsupported", {"reason": str(error)}
        progress.emit(96, "Armando el informe", "La estrategia no se puede evaluar")
        report["attempts_in_family"] = trial_ledger.count_distinct_variants(ledger_path, family)
        _write_report(directory, report)
        progress.emit(100, "Listo", os.path.join(directory, "report.json"))
        return report
    days = _days(markets)
    diagnostic = rep.build_diagnostic(base["trades"], days, base["signals"], base["exit_codes"], min_trades)
    diagnostic["open_at_end"] = base["open_at_end"]
    report["diagnostic"] = diagnostic
    if mode == "variants":
        rows = []
        gate_sha = lab_common.sha256_file(gate_path)
        with trial_ledger.Ledger(ledger_path) as ledger:
            for value in wanted:
                label = "{} = {}".format(variation["label"], value)
                is_base = value == variation["base_value"]
                started = time.time()
                result, error = base if is_base else None, None
                if not is_base:
                    try:
                        result = runner.run(apply_value(spec, variation, value), "Probando variantes", label)
                    except (UnsupportedSpec, SpecError, contract.ContractError, ArithmeticError, ValueError) as failure:
                        error = "{}: {}".format(type(failure).__name__, failure)
                row = _variant_row(value, label, is_base, result, days, error)
                metrics = None if row["status"] != "ok" else {
                    k: row[k] for k in ("trades", "entries_per_day", "net_bp_mean", "gross_bp_mean", "hit_rate")}
                row["trial_id"] = ledger.record_run(
                    experiment_id=exploration_id, source_strategy_id=spec["id"],
                    params={"spec_hash": spec_hash, "vary": variation["name"], "value": value},
                    status=row["status"], dataset_sha256=report["dataset_sha256"], gate_config_sha256=gate_sha,
                    metrics=metrics, error=row["error"], duration_ms=int((time.time() - started) * 1000))
                rows.append(row)
            report["attempts_in_family"] = ledger.distinct_variants(family)
        report["vary"] = {k: variation[k] for k in ("kind", "name", "label", "base_value")}
        report["variants"] = _rank(rows)
        report["variants_headline"] = rep.variants_headline(report["variants"], variation["label"], min_trades)
    else:
        report["attempts_in_family"] = trial_ledger.count_distinct_variants(ledger_path, family)
    progress.emit(96, "Armando el informe", "Escribiendo el informe")
    _write_report(directory, report)
    progress.emit(100, "Listo", os.path.join(directory, "report.json"))
    return report


# --------------------------------------------------------------------------------------------------- the CLI
def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--strategy", required=True, help="id in config/strategies, or the path of a spec file")
    parser.add_argument("--mode", choices=("diagnostic", "variants"), default="diagnostic")
    parser.add_argument("--vary", help="variants: a parameter name, or the path of a numeric constant of a condition")
    parser.add_argument("--values", help="variants: comma separated values (at most {})".format(MAX_VALUES))
    parser.add_argument("--products", help="comma separated; default: the gate's default products")
    parser.add_argument("--exploration-id")
    parser.add_argument("--datasets-dir", default=DEFAULT_DATASETS, help="folder with one practice dataset per product")
    parser.add_argument("--out-dir", default=DEFAULT_OUT)
    parser.add_argument("--ledger", default=trial_ledger.DEFAULT_PATH)
    parser.add_argument("--gate-config", default=None)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    progress = Progress(sys.stdout)
    try:
        run_exploration(
            args.strategy, mode=args.mode, vary=args.vary,
            values=[v for v in (args.values or "").split(",") if v.strip()], exploration_id=args.exploration_id,
            products=[p.strip() for p in args.products.split(",")] if args.products else None,
            datasets_dir=args.datasets_dir, out_dir=args.out_dir, ledger_path=args.ledger, gate_config=args.gate_config,
            stream=sys.stdout)
    except (contract.ContractError, SpecError) as error:
        progress.emit(0, "Error", str(error))
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    return 0   # an unsupported spec is a finished report (status "unsupported"), not a failure of the run


if __name__ == "__main__":
    sys.exit(main())
