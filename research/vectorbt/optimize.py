"""Bounded, deterministic search over the C27 family, run in VectorBT and written to the append-only ledger.

``python -m research.vectorbt.optimize --dataset DIR --experiment-id ID --budget 9 --seed 1``

* The grid (Donchian period x volume multiplier) must fit the budget; it is never widened on its own.
* The dataset must end at or before the gate's holdout and match its manifest hashes, or nothing runs.
* Net result per trade = VectorBT bp - funding (Kraken's real hourly rates) - the stop's execution cost that VectorBT
  does not model, so it is comparable with the engine's net.
* EVERY variant (also the failed ones) goes into the ledger BEFORE the report is written. Repeating the command adds
  new runs to the ledger but no new variants.
* The result is a set of HYPOTHESES on practice data, never a gate PASS.
"""

import argparse
import json
import os
import random
import statistics
import sys
import time

import numpy as np

from . import data_contract as contract
from . import lab_common, parity, trial_ledger
from .engine import ROOT, futures_costs, load_spec
from .variants import make_c27_variant
from balancita_engine.futures_strategy_backtest import deflated_sharpe

WARNING = ("Son HIPÓTESIS sobre datos de práctica, no un PASA de la compuerta. Elegir lo mejor de varias pruebas "
           "infla el resultado; el único veredicto es la compuerta (strategy_gate evaluate) sobre la reserva.")


def parse_grid(text, cast):
    values = sorted({cast(part) for part in text.split(",") if part.strip()})
    if not values:
        raise contract.ContractError("grilla vacía: {!r}".format(text))
    return values


def _sharpe(values):
    if len(values) < 2:
        return None
    deviation = statistics.pstdev(values)
    return None if deviation == 0 else statistics.fmean(values) / deviation


def _stop_hit(trade, arrays, h, l):
    """The VectorBT exit was the stop (not the target, the strategy's own exit or the time stop)."""
    i, j, price = trade["entry_i"], trade["exit_i"], trade["exit_price"]
    if trade["side"] == "LONG":
        stop, target, touched = arrays["long_stop"][i], arrays["long_target"][i], l[j] <= arrays["long_stop"][i]
    else:
        stop, target, touched = arrays["short_stop"][i], arrays["short_target"][i], h[j] >= arrays["short_stop"][i]
    return bool(touched and abs(price - stop) < abs(price - target))


def net_trades(spec, directory, manifest, data, donchian_period):
    """Net bp per closed trade and how many exited on the stop."""
    index, o, h, l, c, v = data
    product = manifest["product_id"]
    arrays = parity.c27_arrays(spec, o, h, l, c, v, donchian_period=donchian_period)
    trades, _ = parity.vectorbt_trades(spec, product, index, o, h, l, c, v, arrays)
    funding = parity.funding_periods(directory, product)
    stop_cost = float(futures_costs.stop_exit_bps(product))
    nets, stops = [], 0
    for trade in trades:
        if trade["status"] != "Closed":
            continue
        fund, _ = parity.funding_bp(funding, trade["side"], int(index[trade["entry_i"]]) + parity.ONE_MINUTE_MS,
                                    int(index[trade["exit_i"]]) + parity.ONE_MINUTE_MS, trade["entry_price"])
        stopped = _stop_hit(trade, arrays, h, l)
        stops += stopped
        nets.append(trade["net_bp_before_funding"] - fund - (stop_cost if stopped else 0.0))
    return nets, stops


def metrics_of(nets, stops):
    n = len(nets)
    return {"n": n, "mean_net_bp": statistics.fmean(nets), "hit_rate": sum(1 for x in nets if x > 0) / n,
            "std_bp": statistics.pstdev(nets), "sharpe_per_trade": _sharpe(nets), "stop_exits": stops}


def neighbours(grid_d, grid_v, d, v):
    i, j = grid_d.index(d), grid_v.index(v)
    return [(grid_d[a], grid_v[b]) for a in range(max(0, i - 1), min(len(grid_d), i + 2))
            for b in range(max(0, j - 1), min(len(grid_v), j + 2)) if (a, b) != (i, j)]


def run_experiment(dataset, spec, grid_d, grid_v, seed, gate_config=None):
    """Runs every variant in memory. Returns the manifest and the variants (with deflated Sharpe and neighbourhood)."""
    random.seed(seed)
    np.random.seed(seed)
    manifest = lab_common.check_dataset(dataset, gate_config)
    data = lab_common.load_1m(dataset, manifest)
    variants, values = [], {}
    for d in grid_d:
        for v in grid_v:
            row = {"params": {"donchian_period": d, "volume_multiplier": v}, "status": "ok", "error": None,
                   "metrics": None}
            started = time.time()
            try:
                nets, stops = net_trades(make_c27_variant(spec, d, v), dataset, manifest, data, d)
                if nets:
                    row["metrics"], values[(d, v)] = metrics_of(nets, stops), nets
                else:
                    row["status"] = "no_trades"
            except Exception as error:  # a failed variant is still a variant tried: it is recorded
                row["status"], row["error"] = "error", "{}: {}".format(type(error).__name__, error)
            row["duration_ms"] = int((time.time() - started) * 1000)
            variants.append(row)
    sharpes = [r["metrics"]["sharpe_per_trade"] for r in variants if r["metrics"]]
    for r in variants:
        if r["metrics"]:
            key = (r["params"]["donchian_period"], r["params"]["volume_multiplier"])
            r["metrics"]["deflated_sharpe"] = deflated_sharpe(values[key], sharpes)
            r["metrics"]["trials_deflated_over"] = len(variants)
    add_neighbourhood(variants, grid_d, grid_v)
    return manifest, variants


def add_neighbourhood(variants, grid_d, grid_v):
    by_key = {(r["params"]["donchian_period"], r["params"]["volume_multiplier"]): r for r in variants}
    for key, r in by_key.items():
        near = [by_key[k] for k in neighbours(grid_d, grid_v, *key)]
        means = [x["metrics"]["mean_net_bp"] for x in near if x["metrics"]]
        positive = sum(1 for m in means if m > 0)
        r["neighbourhood"] = {
            "neighbours": len(near), "with_trades": len(means), "positive": positive,
            "positive_share": positive / len(near) if near else 0.0,
            "mean_of_means_bp": statistics.fmean(means) if means else None,
            "worst_bp": min(means) if means else None}


def record_all(ledger_path, experiment_id, spec, variants, seed, dataset_sha, gate_sha):
    """One ledger row per variant (failed ones too). The neighbourhood goes in with the metrics."""
    with trial_ledger.Ledger(ledger_path) as ledger:
        for r in variants:
            metrics = None if r["metrics"] is None else dict(r["metrics"], neighbourhood=r["neighbourhood"])
            r["trial_id"] = ledger.record_run(
                experiment_id=experiment_id, source_strategy_id=spec["id"], params=r["params"], status=r["status"],
                seed=seed, dataset_sha256=dataset_sha, gate_config_sha256=gate_sha, metrics=metrics,
                error=r["error"], duration_ms=r["duration_ms"])
        return ledger.distinct_variants(trial_ledger.family_of(spec["id"]))


def ranked(variants):
    def key(r):
        nb, m = r["neighbourhood"], r["metrics"]
        return (-nb["positive_share"], -(nb["mean_of_means_bp"] if nb["mean_of_means_bp"] is not None else -1e9),
                -(m["mean_net_bp"] if m else -1e9), r["params"]["donchian_period"], r["params"]["volume_multiplier"])
    return sorted(variants, key=key)


def build_report(experiment_id, spec, manifest, variants, seed, budget, gate_sha, family_variants):
    order = ranked(variants)
    return {
        "experiment_id": experiment_id, "strategy": spec["id"], "seed": seed, "budget": budget,
        "dataset_sha256": manifest["dataset_sha256"], "product": manifest["product_id"],
        "window": [manifest["start_inclusive_utc"], manifest["end_exclusive_utc"]], "gate_config_sha256": gate_sha,
        "cost_model_version": futures_costs.COST_MODEL_VERSION, "variants_in_experiment": len(variants),
        "variants_in_ledger_family": family_variants, "warning": WARNING,
        "order": "estabilidad del vecindario (parte de vecinas con media neta > 0), no máximo P&L",
        "variants": [{k: r[k] for k in ("params", "status", "error", "metrics", "neighbourhood")} for r in order]}


def _fmt(x, places=2):
    return "-" if x is None else ("{:.%df}" % places).format(x).replace(".", ",")


def render_markdown(report):
    rows = report["variants"]
    ok = [r for r in rows if r["metrics"]]
    best = rows[0] if rows else None
    lines = ["# Barrido de C27: {}".format(report["experiment_id"]), "", "## En pocas palabras", "",
             "Se probaron {} variantes de {} (período Donchian y múltiplo de volumen) en {}, del {} al {}. "
             "Semilla {}, presupuesto {}.".format(report["variants_in_experiment"], report["strategy"],
                                                 report["product"], report["window"][0][:10], report["window"][1][:10],
                                                 report["seed"], report["budget"]),
             "{} variantes tuvieron operaciones; {} tuvieron media neta positiva.".format(
                 len(ok), sum(1 for r in ok if r["metrics"]["mean_net_bp"] > 0)),
             ""]
    if best is not None and best["metrics"]:
        lines += ["La variante con vecindario más estable es donchian {} / volumen {}: media neta {} bp en {} operaciones, "
                  "{} de {} vecinas positivas.".format(
                      best["params"]["donchian_period"], _fmt(best["params"]["volume_multiplier"]),
                      _fmt(best["metrics"]["mean_net_bp"]), best["metrics"]["n"], best["neighbourhood"]["positive"],
                      best["neighbourhood"]["neighbours"]), ""]
    lines += ["**Advertencia:** " + report["warning"], "",
              "Orden: " + report["order"] + ". Neto = VectorBT menos funding menos el costo de ejecución del stop "
              "(que VectorBT no modela). Sharpe desinflado calculado con las {} variantes del experimento.".format(
                  report["variants_in_experiment"]), "",
              "## Variantes", "",
              "| Donchian | Volumen | Estado | Operaciones | Media neta (bp) | Acierto | Desvío (bp) | Sharpe/op. | "
              "Sharpe desinflado | Vecinas > 0 | Media de vecinas (bp) |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        m, nb = r["metrics"], r["neighbourhood"]
        status = r["status"] if r["error"] is None else "error: " + r["error"]
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {}/{} | {} |".format(
            r["params"]["donchian_period"], _fmt(r["params"]["volume_multiplier"]), status,
            m["n"] if m else "-", _fmt(m and m["mean_net_bp"]), _fmt(m and m["hit_rate"] * 100, 1) + (" %" if m else ""),
            _fmt(m and m["std_bp"]), _fmt(m and m["sharpe_per_trade"], 3), _fmt(m and m["deflated_sharpe"], 3),
            nb["positive"], nb["neighbours"], _fmt(nb["mean_of_means_bp"])))
    lines += ["", "## Estabilidad de vecindario", "",
              "Cada variante se compara con sus vecinas de la grilla (un paso en período, en volumen o en ambos). Una "
              "ventaja que desaparece al mover un parámetro un paso suele ser ruido. Registro de intentos: "
              "{} variantes distintas en la familia.".format(report["variants_in_ledger_family"]), "",
              "## Qué sigue", "",
              "Nada de esto es una conclusión. Los candidatos se resumen con `summarize` y el único paso que decide es la "
              "compuerta (`strategy_gate evaluate`)."]
    return "\n".join(lines) + "\n"


def run(args):
    spec = load_spec(lab_common.resolve_path(args.spec))
    grid_d, grid_v = parse_grid(args.grid_donchian, int), parse_grid(args.grid_volume, float)
    count = len(grid_d) * len(grid_v)
    if count > args.budget:
        raise contract.ContractError("la grilla tiene {} variantes y el presupuesto es {}: no se amplía solo "
                                     "(subí --budget o achicá la grilla)".format(count, args.budget))
    gate_path = args.gate_config or contract.DEFAULT_GATE_CONFIG
    gate_sha = lab_common.sha256_file(gate_path)
    manifest, variants = run_experiment(args.dataset, spec, grid_d, grid_v, args.seed, args.gate_config)
    family_variants = record_all(args.ledger, args.experiment_id, spec, variants, args.seed,
                                 manifest["dataset_sha256"], gate_sha)
    report = build_report(args.experiment_id, spec, manifest, variants, args.seed, args.budget, gate_sha, family_variants)
    os.makedirs(args.out_dir, exist_ok=True)
    base = os.path.join(args.out_dir, args.experiment_id)
    with open(base + ".json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    with open(base + ".md", "w", encoding="utf-8") as handle:
        handle.write(render_markdown(report))
    return report, base


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--budget", type=int, required=True, help="maximum number of variants; never widened")
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--spec", default="config/strategies/c27-breakout-perp-v1.json")
    parser.add_argument("--grid-donchian", default="15,20,25")
    parser.add_argument("--grid-volume", default="1.25,1.5,1.75")
    parser.add_argument("--ledger", default=trial_ledger.DEFAULT_PATH)
    parser.add_argument("--gate-config", default=None)
    parser.add_argument("--out-dir", default=os.path.join(ROOT, "data", "research-vectorbt", "reports"))
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        report, base = run(args)
    except contract.ContractError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    print("Informe: {}.md / {}.json ({} variantes)".format(base, base, report["variants_in_experiment"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
