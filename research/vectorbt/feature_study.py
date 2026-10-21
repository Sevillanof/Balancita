"""Mode A, signal study: what the price does after a C27 signal, without simulating a position.

``python -m research.vectorbt.feature_study --dataset DIR --strategy SPEC --horizons 5,15,30,60``

Causal policy, written in the report: the signal is read on the CLOSE of bar ``i``; the entry is the OPEN of bar
``i + 1``; the return at horizon ``h`` is the CLOSE of bar ``i + h`` against that entry (bars ``i + 1 .. i + h``);
MFE/MAE use the highs and lows of those same bars. Per side, a new event starts only after the largest horizon of the
previous event of the same side has passed, so the events are independent. MFE/MAE do NOT prove that an order would
have been filled at those prices.
"""

import argparse
import json
import os
import sys

import numpy as np

from . import data_contract as contract
from . import lab_common, parity
from .engine import ROOT, declared_indicators, futures_costs, load_spec

PERCENTILES = (5, 25, 75, 95)


def donchian_period(spec):
    periods = declared_indicators(spec).get("donchian")
    return int(periods[0]) if periods else 20


def independent_events(raw, max_horizon, n):
    """Indices of the signal bars that start an independent event; events without a full max horizon are dropped."""
    events, last = [], None
    for i in np.nonzero(raw)[0]:
        i = int(i)
        if last is not None and i <= last + max_horizon:
            continue
        last = i
        if i + max_horizon < n:
            events.append(i)
    return events


def _stats(values):
    arr = np.asarray(values, dtype=np.float64)
    out = {"mean": float(arr.mean()), "median": float(np.median(arr))}
    for p, x in zip(PERCENTILES, np.percentile(arr, PERCENTILES)):
        out["p{}".format(p)] = float(x)
    return out


def study(spec, index, o, h, l, c, v, horizons, product):
    horizons = sorted(set(horizons))
    top = horizons[-1]
    arrays = parity.c27_arrays(spec, o, h, l, c, v, donchian_period=donchian_period(spec))
    cost = float(futures_costs.round_trip_cost_bps(product))
    n = len(c)
    sides, all_events = {}, {}
    for side, raw, sign in (("LONG", arrays["long_raw"], 1.0), ("SHORT", arrays["short_raw"], -1.0)):
        events = independent_events(raw, top, n)
        records = []
        for i in events:
            entry = float(o[i + 1])
            record = {"signal_i": i, "signal_bucket_ms": int(index[i]), "entry_i": i + 1, "entry_price": entry,
                      "returns_bp": {}, "mfe_bp": {}, "mae_bp": {}}
            for hz in horizons:
                hi, lo = float(h[i + 1:i + hz + 1].max()), float(l[i + 1:i + hz + 1].min())
                record["returns_bp"][hz] = sign * (float(c[i + hz]) - entry) / entry * 10_000
                favorable, adverse = (hi - entry, entry - lo) if sign > 0 else (entry - lo, hi - entry)
                record["mfe_bp"][hz] = max(favorable, 0.0) / entry * 10_000
                record["mae_bp"][hz] = max(adverse, 0.0) / entry * 10_000
            records.append(record)
        all_events[side] = records
        per_horizon = {}
        for hz in horizons:
            if not records:
                per_horizon[str(hz)] = None
                continue
            ret = _stats([r["returns_bp"][hz] for r in records])
            per_horizon[str(hz)] = {
                "return_bp": ret, "mfe_bp": _stats([r["mfe_bp"][hz] for r in records]),
                "mae_bp": _stats([r["mae_bp"][hz] for r in records]),
                "mean_return_minus_round_trip_cost_bp": ret["mean"] - cost}
        sides[side] = {"signal_bars": int(raw.sum()), "independent_events": len(records), "horizons": per_horizon}
    result = {"product": product, "strategy": spec["id"], "donchian_period": donchian_period(spec),
              "horizons_minutes": horizons, "round_trip_cost_bp": cost, "sides": sides,
              "entry_policy": "OPEN de la vela siguiente a la señal", "bars": n}
    return result, all_events


def _fmt(x, places=1):
    return "-" if x is None else ("{:.%df}" % places).format(x).replace(".", ",")


def render(result, dataset_sha, window):
    lines = ["# Estudio de señales de {}".format(result["strategy"]), "", "## En pocas palabras", ""]
    for side, info in result["sides"].items():
        lines.append("- {}: {} velas con señal, {} eventos independientes.".format(
            side, info["signal_bars"], info["independent_events"]))
    lines += ["", "Es un estudio descriptivo de lo que hace el precio después de la señal, no una simulación de operaciones. "
              "Costo de ida y vuelta del producto: {} bp. Datos de práctica ({} a {}), dataset {}.".format(
                  _fmt(result["round_trip_cost_bp"]), window[0][:10], window[1][:10], dataset_sha[:12]), "",
              "## Política causal", "",
              "La señal se lee al cierre de la vela `i`; la entrada es el OPEN de la vela `i+1`; el retorno a `h` minutos es "
              "el cierre de la vela `i+h` contra esa entrada, con el signo del lado (positivo = a favor). Un evento nuevo "
              "del mismo lado no empieza hasta pasado el mayor horizonte ({} min) del anterior, así que los eventos no se "
              "solapan. MFE es el máximo favorable y MAE el máximo adverso (magnitud positiva) dentro del horizonte, con "
              "máximos y mínimos de las velas. **MFE y MAE no prueban que una orden se hubiera ejecutado a esos precios.**".format(
                  result["horizons_minutes"][-1]), ""]
    for side, info in result["sides"].items():
        lines += ["## {}".format(side), "", "| Horizonte (min) | Retorno medio (bp) | Mediana | p5 | p25 | p75 | p95 | "
                  "MFE medio | MAE medio | Medio menos costo (bp) |", "|---|---|---|---|---|---|---|---|---|---|"]
        for hz, row in info["horizons"].items():
            if row is None:
                lines.append("| {} | sin eventos | | | | | | | | |".format(hz))
                continue
            r = row["return_bp"]
            lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                hz, _fmt(r["mean"]), _fmt(r["median"]), _fmt(r["p5"]), _fmt(r["p25"]), _fmt(r["p75"]), _fmt(r["p95"]),
                _fmt(row["mfe_bp"]["mean"]), _fmt(row["mae_bp"]["mean"]),
                _fmt(row["mean_return_minus_round_trip_cost_bp"])))
        lines.append("")
    lines += ["## Cómo leerlo", "",
              "Si el retorno medio no supera el costo de ida y vuelta, la señal sola no alcanza para operar. Aunque lo "
              "supere, es una hipótesis sobre datos de práctica; la decisión la toma la compuerta."]
    return "\n".join(lines) + "\n"


def run(args):
    spec = load_spec(lab_common.resolve_path(args.strategy))
    try:
        horizons = sorted({int(x) for x in args.horizons.split(",") if x.strip()})
    except ValueError as error:
        raise contract.ContractError("horizontes inválidos: {}".format(args.horizons)) from error
    if not horizons or horizons[0] < 1:
        raise contract.ContractError("los horizontes deben ser enteros positivos (minutos)")
    manifest = lab_common.check_dataset(args.dataset, args.gate_config)
    index, o, h, l, c, v = lab_common.load_1m(args.dataset, manifest)
    result, _ = study(spec, index, o, h, l, c, v, horizons, manifest["product_id"])
    result.update(dataset_sha256=manifest["dataset_sha256"],
                  window=[manifest["start_inclusive_utc"], manifest["end_exclusive_utc"]])
    os.makedirs(args.out_dir, exist_ok=True)
    base = os.path.join(args.out_dir, "feature-study-{}-{}".format(spec["id"], manifest["product_id"]))
    with open(base + ".json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    with open(base + ".md", "w", encoding="utf-8") as handle:
        handle.write(render(result, manifest["dataset_sha256"], result["window"]))
    return result, base


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--strategy", default="config/strategies/c27-breakout-perp-v1.json")
    parser.add_argument("--horizons", default="5,15,30,60")
    parser.add_argument("--gate-config", default=None)
    parser.add_argument("--out-dir", default=os.path.join(ROOT, "data", "research-vectorbt", "reports"))
    args = parser.parse_args(argv)
    try:
        _, base = run(args)
    except contract.ContractError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    print("Informe: {}.md / {}.json".format(base, base))
    return 0


if __name__ == "__main__":
    sys.exit(main())
