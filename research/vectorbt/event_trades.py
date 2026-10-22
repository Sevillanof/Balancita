"""Event by event export of the signal analyzer, so the app can simulate leverage and different entry sizes.

``python -m research.vectorbt.event_trades --datasets DIR_BTC DIR_ETH DIR_SOL --out data/research-vectorbt/analyzer/events.json``

It does NOT change ``event_study``: it imports it and reuses ``prepare`` (same events), ``forward_return_bp`` and
``run_family`` (the same 78 cells of the report). Practice data only: ``lab_common.check_dataset`` refuses the holdout.
Nothing is written to the trial ledger and no report is touched.

Schema ``balancita.analyzer-events.v1`` (sorted keys, floats rounded to 2 decimals; ``p_holm`` to 4):

* ``cells``: the 78 cells of the family, with ``id`` = ``kind|product|window|direction|horizon``, and ``events_exported``.
* ``events``: one list per (product, kind, window) used by some cell, key ``"<product>|<kind>|<window>"``. Each event has
  ``t`` (UTC ms of the OPEN of bar i+1, the entry), ``s`` (+1/-1 sign of the move that fired; in ``leader`` the sign of the
  BTC move) and, per horizon h in minutes, ``r`` (long return in bp from that open to the close of bar i+h, NO direction
  sign), ``up`` / ``dn`` (highest high / lowest low between i+1 and i+h against the entry, in bp) and ``f`` (funding in
  bp that a LONG pays over the holding; a short receives the opposite). An event missing a horizon is dropped.
* ``funding_complete``: false if some holding is not fully covered by the funding table (without funding, ``f`` = 0).

The count per cell can differ slightly from the report: the report drops events with no comparable control; this export
keeps every event of the list (``events_exported``). Events of one key are independent in time (``find_events`` spaces them
by the largest horizon). In ``leader`` the events are BTC's, with the prices and indices of the target.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

from . import data_contract as contract
from . import event_study as es
from .engine import ROOT, futures_costs

SCHEMA = "balancita.analyzer-events.v1"
BTC = "PF_XBTUSD"
LEADER_TARGETS = ("PF_ETHUSD", "PF_SOLUSD")
ONE_MINUTE_MS = 60_000


def _r2(x):
    return round(float(x), 2) + 0.0


def _funding(periods, start_ms, end_ms):
    """Funding in bp that a LONG pays between the two instants (same rule as ``parity.funding_bp``)."""
    if not periods:
        return 0.0, False
    from .parity import funding_bp
    return funding_bp(periods, "LONG", start_ms, end_ms, 0.0)


def event_horizons(extra, i, horizons=es.HORIZONS):
    """Per-horizon numbers of an event whose signal bar is ``i``; None if some horizon does not fit in the data."""
    o, h, l, c, index = extra["o"], extra["h"], extra["l"], extra["c"], extra["index"]
    if i + 1 + max(horizons) >= len(c):
        return None
    entry = o[i + 1]
    out = {}
    for hz in horizons:
        up = (float(np.max(h[i + 1:i + hz + 1])) / entry - 1.0) * 10_000
        dn = (float(np.min(l[i + 1:i + hz + 1])) / entry - 1.0) * 10_000
        fund, complete = _funding(extra.get("funding"), int(index[i + 1]), int(index[i + hz]) + ONE_MINUTE_MS)
        out[str(hz)] = {"r": _r2(es.forward_return_bp(o, c, i, hz, 1.0)), "up": _r2(up), "dn": _r2(dn),
                        "f": _r2(fund), "_complete": complete}
    return out


def build_events(extra, signal_events):
    """Exported events on the prices of ``extra`` for ``signal_events`` [(i, sign)]; also the funding coverage flag."""
    out, complete = [], True
    for i, sign in signal_events:
        hz = event_horizons(extra, i)
        if hz is None:
            continue
        for v in hz.values():
            complete = complete and v.pop("_complete")
        out.append({"t": int(extra["index"][i + 1]), "s": int(sign), "h": hz})
    return out, complete


def build_payload(data, extras, window, generated_at, seed=20261022, cells=None):
    """The whole document. ``data``: ``event_study.prepare`` per product; ``extras``: index, o, h, l, c, funding."""
    cells = cells if cells is not None else es.run_family(data, seed)
    events, state = {}, {"complete": True}

    def add(key, extra, signal_events):
        listed, ok = build_events(extra, signal_events)
        events[key] = listed
        state["complete"] = state["complete"] and ok

    for product in data:
        for w in es.MOVE_WINDOWS:
            add("{}|move|{}".format(product, w), extras[product], data[product]["events"][w])
    if BTC in data:
        for target in LEADER_TARGETS:
            if target in data and len(data[target]["c"]) == len(data[BTC]["c"]):
                add("{}|leader|{}".format(target, es.LEADER_WINDOW), extras[target], data[BTC]["events"][es.LEADER_WINDOW])
    out_cells = []
    for cell in cells:
        key = "{}|{}|{}".format(cell["product"], cell["kind"], cell["window"])
        out_cells.append({
            "id": "{}|{}|{}|{}|{}".format(cell["kind"], cell["product"], cell["window"], cell["direction"], cell["horizon"]),
            "kind": cell["kind"], "product": cell["product"], "window": cell["window"], "direction": cell["direction"],
            "horizon": cell["horizon"], "events": cell["events"], "events_exported": len(events.get(key, [])),
            "gross_bp": _r2(cell.get("gross_bp", 0.0)), "excess_bp": _r2(cell.get("excess_bp", 0.0)),
            "ic90_low_bp": None if cell.get("ic90_low_bp") is None else _r2(cell["ic90_low_bp"]),
            "p_holm": round(float(cell["p_holm"]), 4)})
    return {"schema": SCHEMA, "family": es.FAMILY, "generated_at": generated_at,
            "window": {"from": window[0], "to": window[1]}, "horizons": list(es.HORIZONS),
            "round_trip_cost_bp": {p: _r2(futures_costs.round_trip_cost_bps(p)) for p in data},
            "funding_complete": bool(state["complete"]), "cells": out_cells, "events": events}


def load_product(directory, gate_config):
    from . import lab_common, parity
    manifest = lab_common.check_dataset(directory, gate_config)
    index, o, h, l, c, v = lab_common.load_1m(directory, manifest)
    product = manifest["product_id"]
    funding = list(parity.funding_periods(directory, product))
    return manifest, es.prepare(index, o, c), {"index": index, "o": o, "h": h, "l": l, "c": c, "funding": funding}


def run(args):
    data, extras, manifests = {}, {}, {}
    for directory in args.datasets:
        manifest, prepared, extra = load_product(directory, args.gate_config)
        product = manifest["product_id"]
        data[product], extras[product], manifests[product] = prepared, extra, manifest
    first = next(iter(manifests.values()))
    payload = build_payload(data, extras, [first["start_inclusive_utc"], first["end_exclusive_utc"]],
                            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), args.seed)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
    return payload, sorted(m["dataset_sha256"] for m in manifests.values())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--datasets", nargs="+", required=True)
    parser.add_argument("--out", default=os.path.join(ROOT, "data", "research-vectorbt", "analyzer", "events.json"))
    parser.add_argument("--seed", type=int, default=20261022)
    parser.add_argument("--gate-config", default=None)
    args = parser.parse_args(argv)
    try:
        payload, shas = run(args)
    except contract.ContractError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    print("Eventos: {} ({} celdas, {} claves, datasets {})".format(
        args.out, len(payload["cells"]), len(payload["events"]), ",".join(s[:12] for s in shas)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
