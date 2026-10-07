"""Measured reliability of every strategy, the numbers a decision can lean on.

A strategy is judged only by the trades the shared simulator (``futures_simulator``,
real cost model, fixed notional, long or short, one position at a time) takes on
official candles. Nothing here is a calibrated probability or a prediction: it is
what happened, plus how much of it could be luck.

``summarize_trades`` gives, over the trades of one strategy (all products pooled):

* hit rate with its Wilson 95 % interval, mean and median net bp per trade;
* the mean's t-statistic with standard errors clustered by entry day (trades of
  different products on the same day share the market's move, so they are not
  independent);
* the number of equal time folds in which the mean is positive;
* a verdict, deliberately hard to earn:

  ``insufficient_data``  fewer than ``MIN_TRADES`` trades;
  ``negative_edge``      mean below zero and t <= -1.64: it loses after costs;
  ``no_edge``            no positive mean, or positive in too few folds to mean anything;
  ``candidate_edge``     positive mean in at least three quarters of the folds, but t < 1.64: it may be luck;
  ``tentative_edge``     mean above zero, t >= 1.64 and at least three quarters of the folds positive;
  ``reliable_edge``      t >= 2.58, every fold positive and at least ``RELIABLE_TRADES`` trades.

``build_reliability`` runs the specs over each product's candles and the result is
stored in ``config/strategy-reliability.json``; Qwen reads it through the
``strategy_reliability`` STATE field (``futures_llm_decisions``), pooled over
products so its state keeps excluding the product name. An entry is bound to
the hash of the spec it was measured on and is ignored once the spec changes.
"""

import hashlib
import json
import math
import os
import statistics

from .futures_costs import COST_MODEL_VERSION, cost_model_hash
from .futures_simulator import DEFAULT_PERIODS, Book, frames, merge_periods
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs, spec_hash

RELIABILITY_SCHEMA = "futures-strategy-reliability.v1"
DEFAULT_PATH = os.path.normpath(os.path.join(DEFAULT_SPEC_DIR, "..", "strategy-reliability.json"))
MIN_TRADES = 30
RELIABLE_TRADES = 100
FOLDS = 4
T_TENTATIVE = 1.64
T_RELIABLE = 2.58
DAY_MS = 86_400_000
VERDICTS = ("insufficient_data", "negative_edge", "no_edge", "candidate_edge", "tentative_edge", "reliable_edge")


def wilson_interval(wins, total, z=1.96):
    if total == 0:
        return None, None
    p = wins / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return max(0.0, centre - margin), min(1.0, centre + margin)


def _clustered_t(trades):
    """t-statistic of the mean net bp with standard errors clustered by entry day."""
    values = [t["net_bp"] for t in trades]
    mean = statistics.fmean(values)
    by_day = {}
    for trade in trades:
        by_day.setdefault(trade["entry_time_ms"] // DAY_MS, []).append(trade["net_bp"] - mean)
    days = len(by_day)
    if days < 2:
        return None
    variance = sum(sum(group) ** 2 for group in by_day.values()) / len(values) ** 2 * days / (days - 1)
    return mean / math.sqrt(variance) if variance > 0 else None


def _folds_positive(trades, first_ms, last_ms, folds=FOLDS):
    """(folds with a positive mean, folds that had trades) over equal slices of the period."""
    if first_ms is None or last_ms is None or last_ms <= first_ms:
        return 0, 0
    width = (last_ms - first_ms) / folds
    groups = [[] for _ in range(folds)]
    for trade in trades:
        index = min(folds - 1, max(0, int((trade["entry_time_ms"] - first_ms) / width)))
        groups[index].append(trade["net_bp"])
    judged = [g for g in groups if g]
    return sum(1 for g in judged if statistics.fmean(g) > 0), len(judged)


def verdict_for(count, mean, t_stat, positive_folds, judged_folds):
    if count < MIN_TRADES:
        return "insufficient_data"
    if t_stat is None:
        return "no_edge"
    if mean < 0 and t_stat <= -T_TENTATIVE:
        return "negative_edge"
    if mean <= 0:
        return "no_edge"
    if (t_stat >= T_RELIABLE and count >= RELIABLE_TRADES
            and judged_folds >= FOLDS and positive_folds == judged_folds):
        return "reliable_edge"
    mostly_positive = judged_folds and positive_folds >= math.ceil(judged_folds * 0.75)
    if mostly_positive and t_stat >= T_TENTATIVE:
        return "tentative_edge"
    return "candidate_edge" if mostly_positive else "no_edge"


def summarize_trades(trades, *, first_ms=None, last_ms=None):
    """Reliability figures over trades (dicts with ``net_bp``, ``pnl_usd``, ``entry_time_ms``)."""
    count = len(trades)
    if count == 0:
        return {"trades": 0, "wins": 0, "hit_rate": None, "hit_rate_ci95": [None, None], "mean_net_bp": None,
                "median_net_bp": None, "t_stat": None, "folds_positive": 0, "folds_judged": 0,
                "pnl_usd": 0.0, "verdict": "insufficient_data"}
    values = [t["net_bp"] for t in trades]
    wins = sum(1 for t in trades if t["pnl_usd"] > 0)
    low, high = wilson_interval(wins, count)
    mean = statistics.fmean(values)
    t_stat = _clustered_t(trades)
    first = first_ms if first_ms is not None else min(t["entry_time_ms"] for t in trades)
    last = last_ms if last_ms is not None else max(t["entry_time_ms"] for t in trades)
    positive, judged = _folds_positive(trades, first, last)
    return {
        "trades": count, "wins": wins, "hit_rate": round(wins / count, 4),
        "hit_rate_ci95": [round(low, 4), round(high, 4)],
        "mean_net_bp": round(mean, 2), "median_net_bp": round(statistics.median(values), 2),
        "t_stat": None if t_stat is None else round(t_stat, 2),
        "folds_positive": positive, "folds_judged": judged,
        "pnl_usd": round(sum(t["pnl_usd"] for t in trades), 2),
        "verdict": verdict_for(count, mean, t_stat, positive, judged),
    }


def run_books(specs, candles_1m, candles_5m, *, product_id, tick_size="1", start_ms=None):
    """One independent book per spec over one product; frames before ``start_ms`` only warm up."""
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(spec) for spec in specs))
    books = [Book(spec, product_id=product_id, tick_size=tick_size) for spec in specs]
    for frame in frames(candles_1m, candles_5m, periods):
        if start_ms is None or frame[0] >= start_ms:
            for book in books:
                book.on_frame(*frame)
    return books


def aggregate(specs, trades_by_strategy, *, first_ms, last_ms, products, warmup_ms, source=None):
    """The reliability table from ``{strategy_id: {product: trades}}``."""
    strategies = {}
    for spec in specs:
        per_product = trades_by_strategy.get(spec["id"], {})
        pooled = [t for rows in per_product.values() for t in rows]
        entry = summarize_trades(pooled, first_ms=first_ms, last_ms=last_ms)
        entry["spec_hash"] = spec_hash(spec)
        entry["version"] = spec["version"]
        entry["by_product"] = {
            product: {k: v for k, v in summarize_trades(rows, first_ms=first_ms, last_ms=last_ms).items()
                      if k in ("trades", "hit_rate", "mean_net_bp", "pnl_usd")}
            for product, rows in sorted(per_product.items())}
        strategies[spec["id"]] = entry
    return {
        "schema": RELIABILITY_SCHEMA,
        "cost_model": {"version": COST_MODEL_VERSION, "hash": cost_model_hash()},
        "period": {"first_bucket_ms": first_ms, "last_bucket_ms": last_ms, "warmup_ms": warmup_ms,
                   "products": sorted(products), "folds": FOLDS},
        "source": source,
        "thresholds": {"min_trades": MIN_TRADES, "reliable_trades": RELIABLE_TRADES,
                       "t_tentative": T_TENTATIVE, "t_reliable": T_RELIABLE},
        "strategies": strategies,
    }


def build_reliability(specs, candles_by_product, *, tick_sizes=None, warmup_ms=3 * DAY_MS, source=None):
    """Run ``specs`` over every product's ``(candles_1m, candles_5m)`` and summarize each strategy.

    Candle dicts carry ``bucket_start`` (ms) and decimal-string ``open/high/low/close/volume_btc``.
    The first ``warmup_ms`` of every product only warms the indicators up.
    """
    specs = list(specs)
    trades = {spec["id"]: {} for spec in specs}
    first = last = None
    for product, (candles_1m, candles_5m) in candles_by_product.items():
        if not candles_1m:
            continue
        start = candles_1m[0]["bucket_start"] + warmup_ms
        first = start if first is None else min(first, start)
        end = candles_1m[-1]["bucket_start"]
        last = end if last is None else max(last, end)
        books = run_books(specs, candles_1m, candles_5m, product_id=product,
                          tick_size=(tick_sizes or {}).get(product, "1"), start_ms=start)
        for book in books:
            trades[book.spec["id"]][product] = book.trades
    return aggregate(specs, trades, first_ms=first, last_ms=last, products=candles_by_product,
                     warmup_ms=warmup_ms, source=source)


def table_hash(table):
    """Hash of the table without its own ``table_hash`` (the canonical JSON module refuses floats)."""
    body = {k: v for k, v in table.items() if k != "table_hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def load_reliability(path=None):
    """The stored table, or ``None`` when there is none (or it is not this schema)."""
    try:
        with open(path or DEFAULT_PATH, encoding="utf-8") as handle:
            table = json.load(handle)
    except (FileNotFoundError, ValueError):
        return None
    return table if isinstance(table, dict) and table.get("schema") == RELIABILITY_SCHEMA else None


def reliability_for(table, spec):
    """The entry measured on exactly this spec, else ``None`` (a changed spec is a new, unmeasured strategy)."""
    if table is None or spec is None:
        return None
    entry = (table.get("strategies") or {}).get(spec.get("id"))
    return entry if entry is not None and entry.get("spec_hash") == spec_hash(spec) else None


def charts_to_candles(rows):
    """Kraken Futures charts API ``candles`` into the simulator's candle dicts."""
    return [{"bucket_start": int(r["time"]), "open": str(r["open"]), "high": str(r["high"]),
             "low": str(r["low"]), "close": str(r["close"]), "volume_btc": str(r["volume"])} for r in rows]


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(
        description="Measure every strategy on official candles and write the reliability table.")
    parser.add_argument("--charts-dir", required=True,
                        help="directory with <PRODUCT>_1m.json and <PRODUCT>_5m.json (charts API 'candles' arrays)")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--products", default=None, help="comma list; default: config/futures-products.json")
    parser.add_argument("--out", default=DEFAULT_PATH)
    args = parser.parse_args(argv)
    products_path = os.path.normpath(os.path.join(DEFAULT_SPEC_DIR, "..", "futures-products.json"))
    with open(products_path, encoding="utf-8") as handle:
        pinned = {p["product_id"]: p["tick_size"] for p in json.load(handle)["products"]}
    wanted = args.products.split(",") if args.products else list(pinned)
    candles = {}
    for product in wanted:
        pair = []
        for resolution in ("1m", "5m"):
            path = os.path.join(args.charts_dir, "{}_{}.json".format(product, resolution))
            with open(path, encoding="utf-8") as handle:
                pair.append(charts_to_candles(json.load(handle)))
        candles[product] = tuple(pair)
    table = build_reliability(load_specs(args.specs_dir).values(), candles, tick_sizes=pinned,
                              source="Kraken Futures charts API, trade candles, 1m and 5m")
    table["table_hash"] = table_hash(table)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(table, handle, indent=2, sort_keys=True)
        handle.write("\n")
    for strategy_id, entry in table["strategies"].items():
        print("{:28} {:18} trades={} hit={} net_bp={} t={}".format(
            strategy_id, entry["verdict"], entry["trades"], entry["hit_rate"], entry["mean_net_bp"], entry["t_stat"]))


if __name__ == "__main__":
    main()
