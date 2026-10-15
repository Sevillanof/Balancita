"""Comparison of replay scenarios (stage 9A, A5). Pure: it reads the ``results.json`` of runs and writes nothing but its report.

The scenarios of a replay share the signals but not the orders, the trades or the portfolio path: a different fill price
changes the stop and the target the portfolio derives, which changes what is accepted and when positions close, which
changes the capital the next order sees. So a difference in P&L between scenarios is *not* slippage alone. The report
separates, in this order:

1. signals: are they identical across scenarios (same set, by hash);
2. comparable decisions: orders (strategy, product, decision cycle, side) that exist in every scenario;
3. diverging orders: comparable orders with a different status, rejection reasons or entry price;
4. trades that exist only in some scenarios;
5. execution differences of comparable opportunities: the same decision, opened in both, entry / exit / P&L differences;
6. global portfolio trajectory: capital, fees, funding and trades per scenario, with the P&L difference to the base split into
   comparable trades, trades only in the scenario and trades only in the base.

``S0`` is counterfactual (a price from before the decision was delivered); ``S2`` is a non-causal stress (it uses the entry
minute's extreme after the fill). Neither is evidence; no inequality between scenarios is assumed or enforced.
"""

import json
import os
import sys
from decimal import Decimal

D = Decimal
SCHEMA = "balancita-replay-compare.v1"
LABEL = {"counterfactual": "COUNTERFACTUAL (price from before the decision was delivered)",
         "modelled_base": "modelled base", "non_causal_stress": "NON-CAUSAL STRESS (uses information after the fill)",
         "experimental_sensitivity": "EXPERIMENTAL SENSITIVITY (not validated for future operations)"}


def _key(order):
    return (order["strategy_id"], order["product_id"], order["cycle_ms"], order["side"])


def _name(key):
    return "{}|{}|{}|{}".format(*key)


def _bps(a, b):
    a, b = D(str(a)), D(str(b))
    return None if a == 0 else str((b - a) / a * 10_000)


def compare(results, base=None):
    """``results``: ``{label: results.json content}``. ``base``: the label the others are measured against (default: the
    ``modelled_base`` run if there is one, else the first)."""
    labels = list(results)
    if len(labels) < 2:
        raise ValueError("a comparison needs at least two runs")
    base = base or next((k for k in labels if results[k].get("scenario_class") == "modelled_base"), labels[0])
    others = [k for k in labels if k != base]
    out = {"schema": SCHEMA, "base": base,
           "runs": {k: {"scenario": results[k]["scenario"], "class": results[k].get("scenario_class"),
                        "label": LABEL.get(results[k].get("scenario_class"), ""),
                        "manifest_hash": results[k]["manifest"]["manifest_hash"]} for k in labels},
           "note": "the P&L difference between scenarios is not attributable to slippage alone: orders, trades and the "
                   "portfolio path differ"}
    # 1. signals
    hashes = {k: results[k]["signals"]["set_hash"] for k in labels}
    out["signals"] = {"identical_across_scenarios": len(set(hashes.values())) == 1, "set_hash": hashes,
                      "entries": {k: results[k]["signals"]["entries"] for k in labels}}
    # 2-3. orders
    orders = {k: {_key(o): o for o in results[k]["orders"]} for k in labels}
    all_keys = sorted(set().union(*[set(v) for v in orders.values()]))
    comparable = [key for key in all_keys if all(key in orders[k] for k in labels)]
    diverging = []
    for key in comparable:
        views = {k: {"status": orders[k][key]["status"], "reasons": orders[k][key]["reasons"],
                     "entry_price": orders[k][key]["entry_price"]} for k in labels}
        if len({(v["status"], tuple(v["reasons"])) for v in views.values()}) > 1:
            diverging.append({"order": _name(key), "kind": "status_or_reasons", "views": views})
        elif len({v["entry_price"] for v in views.values()}) > 1:
            diverging.append({"order": _name(key), "kind": "entry_price_only", "views": views})
    out["orders"] = {"total_distinct": len(all_keys), "comparable_in_all": len(comparable),
                     "present_only_in_some": len(all_keys) - len(comparable), "diverging": diverging}
    # 4-5. trades
    trades = {}
    for k in labels:
        by_intent = {o["intent_id"]: _key(o) for o in results[k]["orders"] if o["intent_id"]}
        trades[k] = {by_intent[t["intent_id"]]: t for t in results[k]["trades"] if t["intent_id"] in by_intent}
    trade_keys = sorted(set().union(*[set(v) for v in trades.values()]))
    only_some = [{"order": _name(key), "in": [k for k in labels if key in trades[k]]}
                 for key in trade_keys if sum(1 for k in labels if key in trades[k]) < len(labels)]
    out["trades"] = {"total_distinct": len(trade_keys), "in_every_scenario": len(trade_keys) - len(only_some),
                     "counts": {k: len(trades[k]) for k in labels}, "only_in_some": only_some}
    execution = {}
    for k in others:
        rows = []
        for key in sorted(set(trades[base]) & set(trades[k])):
            a, b = trades[base][key], trades[k][key]
            rows.append({"order": _name(key), "entry_price_diff_bps": _bps(a["entry_price"], b["entry_price"]),
                         "entry_time_diff_ms": b["entry_time_ms"] - a["entry_time_ms"],
                         "exit_reason": [a["exit_reason"], b["exit_reason"]],
                         "exit_price_diff_bps": _bps(a["exit_price"], b["exit_price"]),
                         "pnl_diff_usd": str(D(str(b["pnl_usd"])) - D(str(a["pnl_usd"]))),
                         "fees_diff_usd": str(D(str(b["fees_usd"])) - D(str(a["fees_usd"])))})
        execution[k] = rows
    out["execution_differences_of_comparable_trades"] = execution
    # 6. trajectory
    trajectory = {k: {"capital": results[k]["capital"], "counts": {x: results[k]["counts"][x] for x in
                                                                    ("signals", "accepted", "rejected", "closed", "wins", "open")}}
                  for k in labels}
    split = {}
    for k in others:
        pnl = lambda key, who: D(str(trades[who][key]["pnl_usd"]))   # noqa: E731
        common = set(trades[base]) & set(trades[k])
        split[k] = {"pnl_difference_usd": str(sum((D(str(t["pnl_usd"])) for t in trades[k].values()), D(0))
                                              - sum((D(str(t["pnl_usd"])) for t in trades[base].values()), D(0))),
                    "from_comparable_trades_usd": str(sum((pnl(key, k) - pnl(key, base) for key in common), D(0))),
                    "from_trades_only_in_scenario_usd": str(sum((pnl(key, k) for key in set(trades[k]) - common), D(0))),
                    "from_trades_only_in_base_usd": str(-sum((pnl(key, base) for key in set(trades[base]) - common), D(0)))}
    open_counts = {k: results[k].get("pnl_split", {}).get("open_positions_at_window_end", len(results[k].get("open_at_window_end", {})))
                   for k in labels}
    out["trajectory"] = {"runs": trajectory, "pnl_split_against_base": split,
                         "open_positions_at_window_end": open_counts,
                         "realized_closed_trades_usd": {k: results[k].get("pnl_split", {}).get("realized_closed_trades_usd") for k in labels},
                         "unrealized_open_positions_usd": {k: results[k].get("pnl_split", {}).get("unrealized_open_positions_usd") for k in labels},
                         "equity_comparable_as_realized": len(set(open_counts.values())) == 1 and set(open_counts.values()) == {0},
                         "note_open_positions": "equity includes unrealized P&L; the split above uses closed trades only; runs with "
                                                "open positions are not comparable with runs without them unless stated"}
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) < 3:
        print("usage: replay_compare OUT.json RESULTS_DIR_1 RESULTS_DIR_2 [...]", file=sys.stderr)
        return 2
    results = {}
    for directory in argv[1:]:
        with open(os.path.join(directory, "results.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        results["{}:{}".format(data["scenario"], os.path.basename(directory.rstrip("/")))] = data
    report = compare(results)
    partial = argv[0] + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1, sort_keys=True)
    os.replace(partial, argv[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
