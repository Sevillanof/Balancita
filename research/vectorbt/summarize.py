"""Candidate card of one experiment, read from the ledger (read-only).

``python -m research.vectorbt.summarize --ledger PATH --experiment-id ID``

"Promising in practice" is a plain, declared filter, NOT a verdict: n >= 100 trades, mean net > 0 and most of the
neighbouring variants of the grid also > 0. The only step that decides is the gate (``strategy_gate evaluate``).
"""

import argparse
import json
import os
import sys

from . import data_contract as contract
from . import trial_ledger

MIN_TRADES = 100
NEIGHBOUR_MAJORITY = 0.5   # strictly more than this share of the neighbours must also have a mean net > 0


def read_experiment(path, experiment_id):
    """All non-selection runs of the experiment, oldest first. Never writes."""
    if not os.path.isfile(path):
        raise contract.ContractError("no existe el registro de intentos: {}".format(path))
    try:
        conn = trial_ledger._readonly(path)
        try:
            cur = conn.execute("SELECT * FROM trials WHERE experiment_id=? AND status!='selection' ORDER BY id",
                               (experiment_id,))
            names = [d[0] for d in cur.description]
            return [dict(zip(names, row)) for row in cur.fetchall()]
        finally:
            conn.close()
    except trial_ledger.sqlite3.Error as error:
        raise contract.ContractError("no se puede leer el registro de intentos ({}): {}".format(path, error)) from error


def card_rows(runs):
    """One row per distinct variant (its latest run), with the number of runs and the promising flag."""
    by_variant = {}
    for run in runs:
        entry = by_variant.setdefault(run["variant_key"], {"runs": 0})
        entry["runs"] += 1
        entry["latest"] = run
    rows = []
    for entry in by_variant.values():
        run = entry["latest"]
        rows.append({"params": json.loads(run["params_json"]), "runs": entry["runs"], "status": run["status"],
                     "error": run["error"], "metrics": json.loads(run["metrics_json"]) if run["metrics_json"] else None})
    periods = sorted({r["params"].get("donchian_period") for r in rows})
    volumes = sorted({r["params"].get("volume_multiplier") for r in rows})
    index = {(r["params"].get("donchian_period"), r["params"].get("volume_multiplier")): r for r in rows}
    for (d, v), r in index.items():
        i, j = periods.index(d), volumes.index(v)
        near = [index[(periods[a], volumes[b])] for a in range(max(0, i - 1), min(len(periods), i + 2))
                for b in range(max(0, j - 1), min(len(volumes), j + 2)) if (a, b) != (i, j)
                and (periods[a], volumes[b]) in index]
        positive = sum(1 for x in near if x["metrics"] and x["metrics"]["mean_net_bp"] > 0)
        m = r["metrics"]
        r["neighbours"], r["neighbours_positive"] = len(near), positive
        r["promising"] = bool(m and m["n"] >= MIN_TRADES and m["mean_net_bp"] > 0 and near
                              and positive / len(near) > NEIGHBOUR_MAJORITY)
    rows.sort(key=lambda r: (r["params"].get("donchian_period"), r["params"].get("volume_multiplier")))
    return rows


def _fmt(x, places=2):
    return "-" if x is None else ("{:.%df}" % places).format(x).replace(".", ",")


def render(experiment_id, runs, rows):
    seeds = sorted({r["seed"] for r in runs if r["seed"] is not None})
    promising = [r for r in rows if r["promising"]]
    lines = ["# Tarjeta de candidatas: {}".format(experiment_id), "", "## En pocas palabras", "",
             "{} variantes distintas en {} corridas (repetir una configuración suma una corrida, no una variante). "
             "Semillas: {}.".format(len(rows), len(runs), ", ".join(map(str, seeds)) or "-"),
             "{} variantes son «prometedoras en práctica»; ninguna está aprobada.".format(len(promising)), "",
             "**Criterios (simples y declarados):** al menos {} operaciones, media neta mayor que 0 y más de la mitad "
             "de las vecinas de la grilla también con media neta mayor que 0. No es un PASA: son hipótesis sobre "
             "datos de práctica.".format(MIN_TRADES), "",
             "## Variantes", "",
             "| Donchian | Volumen | Corridas | Estado | Operaciones | Media neta (bp) | Sharpe desinflado | Vecinas > 0 | "
             "Prometedora en práctica |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        m = r["metrics"]
        status = r["status"] if not r["error"] else "error: " + r["error"]
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {}/{} | {} |".format(
            r["params"].get("donchian_period"), _fmt(r["params"].get("volume_multiplier")), r["runs"], status,
            m["n"] if m else "-", _fmt(m and m["mean_net_bp"]), _fmt(m and m.get("deflated_sharpe"), 3),
            r["neighbours_positive"], r["neighbours"], "sí" if r["promising"] else "no"))
    lines += ["", "## Qué sigue", "",
              "Para decidir hay un solo paso: la compuerta (`strategy_gate evaluate`), que usa el registro de intentos "
              "para desinflar el Sharpe y evalúa sobre la reserva. Esta tarjeta no reemplaza ese paso."]
    return "\n".join(lines) + "\n"


def summarize(path, experiment_id):
    runs = read_experiment(path, experiment_id)
    if not runs:
        raise contract.ContractError("el experimento {} no tiene corridas en el registro".format(experiment_id))
    rows = card_rows(runs)
    return render(experiment_id, runs, rows), rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--ledger", default=trial_ledger.DEFAULT_PATH)
    parser.add_argument("--experiment-id", required=True)
    args = parser.parse_args(argv)
    try:
        text, _ = summarize(args.ledger, args.experiment_id)
    except contract.ContractError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
