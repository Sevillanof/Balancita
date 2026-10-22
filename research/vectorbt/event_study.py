"""Signal analyzer before any backtest: what the price does after a strong move, against comparable random entries.

``python -m research.vectorbt.event_study --datasets DIR_BTC DIR_ETH DIR_SOL``

Preregistered family (docs: analisis/validacion-operativa-y-analizador-senales.md). Nothing is tuned:

* events: a move over 5, 15 or 60 minutes larger than ``THRESHOLD_SIGMA`` times the recent volatility,
* directions: follow the move or fade it,
* horizons: 5, 15, 30 and 60 minutes, measured from the OPEN of the bar after the signal bar,
* products: the datasets given (practice window only: ``lab_common.check_dataset`` refuses the holdout),
* leader test: a strong BTC move as a warning for ETH and SOL (same direction) at 5, 15 and 30 minutes.

Causal policy: the signal is read on the CLOSE of bar ``i``; sigma is the EWMA of squared 1m log returns up to the bar
BEFORE the window starts, so no move contributes to its own threshold. Events of the same product and kind start only
after the largest horizon of the previous one. Controls are random bars of the same product, UTC hour and volatility
tercile, with a full horizon ahead and outside any event window, scored with the event's direction.
Every cell goes through ``Ledger`` before the report is written and the multiplicity is the whole declared family
(Holm over every cell), never the cells that look good.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

from . import data_contract as contract
from .engine import ROOT, futures_costs

FAMILY = "event-study-moves"
MOVE_WINDOWS = (5, 15, 60)
HORIZONS = (5, 15, 30, 60)
DIRECTIONS = ("follow", "fade")
THRESHOLD_SIGMA = 3.0
EWMA_HALF_LIFE_MIN = 7 * 1440
CONTROLS_PER_EVENT = 20
LEADER_WINDOW = 15
LEADER_HORIZONS = (5, 15, 30)
IC90_Z = 1.645


def ewma_sigma(close):
    """Per-minute volatility known at each bar: EWMA of squared 1m log returns, shifted so bar i uses returns <= i."""
    r = np.diff(np.log(close), prepend=np.log(close[0]))
    alpha = 1.0 - 0.5 ** (1.0 / EWMA_HALF_LIFE_MIN)
    var = np.empty_like(r)
    acc = float(np.mean(r[:1440] ** 2)) if len(r) >= 1440 else float(np.mean(r ** 2))
    for i, x in enumerate(r):
        acc = (1.0 - alpha) * acc + alpha * x * x
        var[i] = acc
    return np.sqrt(var)


def find_events(close, sigma, window, max_horizon, threshold=THRESHOLD_SIGMA):
    """Signal bars (index, sign) where the ``window``-minute move exceeds the threshold, independent in time."""
    n = len(close)
    events, last = [], None
    for i in range(window + 1, n - max_horizon - 1):
        move = math.log(close[i] / close[i - window])
        scale = sigma[i - window] * math.sqrt(window)
        if scale > 0 and abs(move) > threshold * scale:
            if last is not None and i <= last + max_horizon:
                continue
            last = i
            events.append((i, 1.0 if move > 0 else -1.0))
    return events


def forward_return_bp(o, c, i, horizon, sign):
    """Return from the OPEN of bar i+1 to the CLOSE of bar i+horizon, in bp, positive in the direction ``sign``."""
    entry = o[i + 1]
    return sign * (c[i + horizon] - entry) / entry * 10_000


def tercile_labels(sigma):
    cuts = np.quantile(sigma, [1 / 3, 2 / 3])
    return np.digitize(sigma, cuts)


def control_returns(rng, o, c, hours, terciles, event_i, blocked, horizon, sign, n_controls=CONTROLS_PER_EVENT):
    """Mean return of ``n_controls`` random bars with the event's UTC hour and volatility tercile (None if none)."""
    n = len(c)
    pool = np.nonzero((hours == hours[event_i]) & (terciles == terciles[event_i]) & ~blocked)[0]
    pool = pool[(pool + horizon + 1 < n) & (pool > 0)]
    if len(pool) == 0:
        return None
    picks = rng.choice(pool, size=min(n_controls, len(pool)), replace=False)
    return float(np.mean([forward_return_bp(o, c, int(i), horizon, sign) for i in picks]))


def cluster_by_day(values, days):
    """Mean and standard error of ``values`` with errors grouped by day (a day is one observation)."""
    values, days = np.asarray(values, dtype=np.float64), np.asarray(days)
    sums = {}
    for v, d in zip(values, days):
        sums.setdefault(int(d), []).append(v)
    centered = [np.mean(g) for g in sums.values()]
    n_days = len(centered)
    mean = float(np.mean(values))
    if n_days < 2:
        return mean, float("nan"), n_days
    resid = [(np.sum(g) - len(g) * mean) for g in sums.values()]
    se = math.sqrt(sum(r * r for r in resid)) / len(values) * math.sqrt(n_days / (n_days - 1))
    return mean, se, n_days


def p_value(mean, se):
    if not se or math.isnan(se) or se <= 0:
        return 1.0
    return math.erfc(abs(mean / se) / math.sqrt(2.0))


def holm(p_values):
    """Holm adjusted p-values over the whole declared family, in the order given."""
    order = sorted(range(len(p_values)), key=lambda k: p_values[k])
    m, adjusted, running = len(p_values), [1.0] * len(p_values), 0.0
    for rank, k in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p_values[k]))
        adjusted[k] = running
    return adjusted


def evaluate_cell(rng, product_data, kind, window, direction, horizon, signal_sign_of=None, events=None):
    """Event-minus-control gross return (bp) of one preregistered cell. ``events`` may come from another product."""
    o, c, hours, terciles, days = (product_data[k] for k in ("o", "c", "hours", "terciles", "days"))
    events = events if events is not None else product_data["events"][window]
    blocked = np.zeros(len(c), dtype=bool)
    for i, _ in events:
        blocked[i:i + max(HORIZONS) + 1] = True
    diffs, raw, day_of = [], [], []
    for i, move_sign in events:
        sign = move_sign if direction == "follow" else -move_sign
        ev = forward_return_bp(o, c, i, horizon, sign)
        ctl = control_returns(rng, o, c, hours, terciles, i, blocked, horizon, sign)
        if ctl is None:
            continue
        diffs.append(ev - ctl)
        raw.append(ev)
        day_of.append(days[i])
    if not diffs:
        return {"events": 0}
    mean, se, n_days = cluster_by_day(diffs, day_of)
    raw_mean = float(np.mean(raw))
    return {"events": len(diffs), "days": n_days, "gross_bp": raw_mean, "excess_bp": mean, "se_bp": se,
            "ic90_low_bp": mean - IC90_Z * se if not math.isnan(se) else None,
            "p": p_value(mean, se)}


def prepare(index, o, c):
    sigma = ewma_sigma(c)
    return {"o": o, "c": c, "sigma": sigma, "terciles": tercile_labels(sigma),
            "hours": ((index // 3_600_000) % 24).astype(np.int64), "days": (index // 86_400_000).astype(np.int64),
            "events": {w: find_events(c, sigma, w, max(HORIZONS)) for w in MOVE_WINDOWS}}


def split_halves(cell_fn, events, midpoint_day, days):
    first = [e for e in events if days[e[0]] < midpoint_day]
    second = [e for e in events if days[e[0]] >= midpoint_day]
    return cell_fn(first), cell_fn(second)


def run_family(data_by_product, seed):
    """Every cell of the declared family. Returns the list of cells (all of them, good or bad)."""
    cells = []
    for product, data in data_by_product.items():
        mid = int(np.median(data["days"]))
        for window in MOVE_WINDOWS:
            for direction in DIRECTIONS:
                for horizon in HORIZONS:
                    rng = np.random.default_rng(seed)
                    cell = evaluate_cell(rng, data, "move", window, direction, horizon)
                    evs = data["events"][window]
                    halves = []
                    for part in ([e for e in evs if data["days"][e[0]] < mid], [e for e in evs if data["days"][e[0]] >= mid]):
                        rng = np.random.default_rng(seed)
                        halves.append(evaluate_cell(rng, data, "move", window, direction, horizon, events=part))
                    cells.append(dict(kind="move", product=product, window=window, direction=direction,
                                      horizon=horizon, halves=halves, **cell))
    btc = data_by_product.get("PF_XBTUSD")
    if btc is not None:
        for target in ("PF_ETHUSD", "PF_SOLUSD"):
            data = data_by_product.get(target)
            if data is None or len(data["c"]) != len(btc["c"]):
                continue
            mid = int(np.median(data["days"]))
            leader_events = btc["events"][LEADER_WINDOW]
            for horizon in LEADER_HORIZONS:
                rng = np.random.default_rng(seed)
                cell = evaluate_cell(rng, data, "leader", LEADER_WINDOW, "follow", horizon, events=leader_events)
                halves = []
                for part in ([e for e in leader_events if data["days"][e[0]] < mid],
                             [e for e in leader_events if data["days"][e[0]] >= mid]):
                    rng = np.random.default_rng(seed)
                    halves.append(evaluate_cell(rng, data, "leader", LEADER_WINDOW, "follow", horizon, events=part))
                cells.append(dict(kind="leader", product=target, window=LEADER_WINDOW, direction="follow",
                                  horizon=horizon, halves=halves, **cell))
    adjusted = holm([c.get("p", 1.0) if c["events"] else 1.0 for c in cells])
    for cell, p_adj in zip(cells, adjusted):
        cell["p_holm"] = p_adj
    return cells


def verdict(cells, cost_bp):
    """Passes only if one (kind, window, direction, horizon) clears Holm, the IC90 floor over the cost, both halves
    and every product it was tested on. Anything else is 'sin señal' and the study closes."""
    groups = {}
    for cell in cells:
        groups.setdefault((cell["kind"], cell["window"], cell["direction"], cell["horizon"]), []).append(cell)
    winners = []
    for key, group in groups.items():
        ok = all(c["events"] and c["p_holm"] < 0.05 and c["ic90_low_bp"] is not None and c["ic90_low_bp"] > cost_bp
                 and all(h["events"] and h["excess_bp"] > 0 for h in c["halves"]) for c in group)
        if ok and (key[0] == "leader" or len(group) >= 3):
            winners.append(key)
    return {"passes": bool(winners), "winners": [list(k) for k in winners],
            "text": "pasa" if winners else "sin señal: ninguna celda cumple todo; el estudio se cierra"}


def render(cells, result, window, dataset_sha):
    lines = ["# Analizador de señales (movimientos fuertes)", "", "## Veredicto", "", result["verdict"]["text"], "",
             "Celdas probadas (todas, no solo las buenas): {}. Datos de práctica {} a {}, dataset {}. Coste de ida y vuelta: "
             "{:.1f} bp. Esto es una hipótesis sobre datos de práctica, no una aprobación.".format(
                 len(cells), window[0][:10], window[1][:10], dataset_sha[:12], result["round_trip_cost_bp"]), "",
             "| Tipo | Producto | Ventana | Dirección | Horizonte | Eventos | Bruto (bp) | Exceso vs azar (bp) | IC90 bajo | p Holm |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    def f(x):
        return "-" if x is None else "{:.1f}".format(x)
    for c in cells:
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            c["kind"], c["product"], c["window"], c["direction"], c["horizon"], c["events"],
            f(c.get("gross_bp")), f(c.get("excess_bp")), f(c.get("ic90_low_bp")),
            "-" if "p_holm" not in c else "{:.3f}".format(c["p_holm"])))
    return "\n".join(lines) + "\n"


def run(args):
    from . import lab_common
    data, manifests = {}, {}
    for directory in args.datasets:
        manifest = lab_common.check_dataset(directory, args.gate_config)
        index, o, h, l, c, v = lab_common.load_1m(directory, manifest)
        data[manifest["product_id"]] = prepare(index, o, c)
        manifests[manifest["product_id"]] = manifest
    shas = sorted(m["dataset_sha256"] for m in manifests.values())
    first = next(iter(manifests.values()))
    cells = run_family(data, args.seed)
    cost = max(float(futures_costs.round_trip_cost_bps(p)) for p in data)
    result = {"family": FAMILY, "seed": args.seed, "round_trip_cost_bp": cost, "cells": cells,
              "verdict": verdict(cells, cost), "datasets": shas,
              "window": [first["start_inclusive_utc"], first["end_exclusive_utc"]]}
    from .trial_ledger import Ledger
    with Ledger(args.ledger) as ledger:
        for cell in cells:
            params = {k: cell[k] for k in ("kind", "product", "window", "direction", "horizon")}
            ledger.record_run(experiment_id=args.experiment_id, family=FAMILY, source_strategy_id=FAMILY + "-v1",
                              params=params, seed=args.seed, dataset_sha256=shas[0],
                              status="ok" if cell["events"] else "no_trades", metrics=cell)
    os.makedirs(args.out_dir, exist_ok=True)
    base = os.path.join(args.out_dir, args.experiment_id)
    with open(base + ".json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True, default=float)
        handle.write("\n")
    with open(base + ".md", "w", encoding="utf-8") as handle:
        handle.write(render(cells, result, result["window"], shas[0]))
    return result, base


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--datasets", nargs="+", required=True)
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--seed", type=int, default=20261022)
    parser.add_argument("--gate-config", default=None)
    parser.add_argument("--ledger", default=os.path.join(ROOT, "data", "research-vectorbt", "ledger.sqlite"))
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
