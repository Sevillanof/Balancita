"""Purged validation and stress tests, so a strategy's test cannot flatter it.

A trade is not a point in time: it lives from entry to exit. Cutting a period into
blocks by entry time lets a trade that opens in one block and closes in the next
feed both, and a trade that opens right after a boundary still depends on the
market state that decided the previous block. Lopez de Prado's remedies, as used here
for rules that are fixed (nothing is trained, so the "train" side is only the
human's tuning):

* **purge**: a trade belongs to a block only if its whole life (entry to exit)
  lies inside it; trades that cross a boundary are dropped, not assigned;
* **embargo**: the first ``embargo`` of every block after the first is skipped, as
  long as the longest trade held, so no trade there was opened while the previous
  block's last trade was still alive.

On top of that:

* ``purged_folds`` gives the mean net bp per block, a distribution instead of one
  70/30 cut;
* ``cscv_pbo`` is the probability of backtest overfitting (Bailey, Borwein, Lopez de
  Prado and Zhu): across the variants that were tried, how often does the best
  variant of half the blocks land below the median on the other half;
* ``stress`` re-prices the same trades with extra cost and with the entry one bar
  late, which is how much room the edge has before reality eats it;
* ``lookahead_leaks`` is the sentinel: trades that closed before a cut must not
  change when the candles after the cut are removed.
"""

import itertools
import math
import statistics

from .futures_costs import round_trip_cost_bps

ONE_MINUTE_MS = 60_000
FOLDS = 6
MIN_FOLD_TRADES = 5
MIN_VARIANT_TRADES = 30
EMBARGO_MAX_SHARE = 0.25  # of a block's width: a very long hold must not empty the block
PBO_BLOCKS = 8
DEFAULT_EXTRA_COST_SHARE = 0.5  # extra cost as a share of the product's round trip


def hold_ms(trade):
    exit_ms = trade.get("exit_time_ms")
    return 0 if exit_ms is None else max(0, exit_ms - trade["entry_time_ms"])


def embargo_ms(trades, width_ms=None):
    """The longest hold, capped at a share of the block width."""
    longest = max((hold_ms(t) for t in trades), default=0)
    return longest if width_ms is None else min(longest, int(width_ms * EMBARGO_MAX_SHARE))


def _exit_ms(trade):
    exit_ms = trade.get("exit_time_ms")
    return trade["entry_time_ms"] if exit_ms is None else exit_ms


def purged_split(trades, split_ms, embargo):
    """``(in_sample, out_of_sample, dropped)``: in-sample trades are over by the split, out-of-sample ones start
    ``embargo`` after it; the rest overlap the cut and are in neither."""
    inside = [t for t in trades if _exit_ms(t) <= split_ms]
    outside = [t for t in trades if t["entry_time_ms"] >= split_ms + embargo]
    return inside, outside, len(trades) - len(inside) - len(outside)


def purged_folds(trades, first_ms, last_ms, folds=FOLDS):
    """Equal blocks of the period with their purged trades: one dict per block.

    A block keeps a trade only if it enters after the block's embargo (none for the first block) and exits by
    the block's end. ``dropped`` counts the block's trades that were left out.
    """
    if first_ms is None or last_ms is None or last_ms <= first_ms or folds < 1:
        return []
    width = (last_ms - first_ms) / folds
    embargo = embargo_ms(trades, width)
    blocks = []
    for index in range(folds):
        start, end = first_ms + index * width, first_ms + (index + 1) * width
        last_block = index == folds - 1
        usable = start + (embargo if index else 0)
        # the first and last blocks are open-ended, so every trade of the period belongs to some block
        owned = [t for t in trades if (index == 0 or t["entry_time_ms"] >= start)
                 and (last_block or t["entry_time_ms"] < end)]
        kept = [t for t in owned if t["entry_time_ms"] >= usable and (_exit_ms(t) <= end or last_block)]
        values = [t["net_bp"] for t in kept]
        blocks.append({
            "index": index, "start_ms": int(start), "end_ms": int(end), "trades": len(kept),
            "dropped": len(owned) - len(kept),
            "mean_net_bp": round(statistics.fmean(values), 2) if values else None,
            "hit_rate": round(sum(1 for t in kept if t["pnl_usd"] > 0) / len(kept), 4) if kept else None,
            "pnl_usd": round(sum(t["pnl_usd"] for t in kept), 4),
        })
    return blocks


def fold_summary(blocks, min_trades=MIN_FOLD_TRADES):
    """How many judged blocks have a positive mean: a block with fewer than ``min_trades`` is not judged."""
    judged = [b for b in blocks if b["trades"] >= min_trades]
    positive = sum(1 for b in judged if b["mean_net_bp"] > 0)
    means = [b["mean_net_bp"] for b in judged]
    return {
        "folds": len(blocks), "judged": len(judged), "positive": positive,
        "dropped": sum(b["dropped"] for b in blocks),
        "mean_of_means_net_bp": round(statistics.fmean(means), 2) if means else None,
        "worst_net_bp": min(means) if means else None,
    }


def purged_positive(trades, first_ms, last_ms, folds, min_trades=1):
    """``(positive blocks, judged blocks)`` of the purged blocks, for the reliability verdict."""
    summary = fold_summary(purged_folds(trades, first_ms, last_ms, folds), min_trades)
    return summary["positive"], summary["judged"]


# --- probability of backtest overfitting ---------------------------------------------------------------


def cscv_pbo(variants, first_ms, last_ms, blocks=PBO_BLOCKS, min_trades=MIN_VARIANT_TRADES):
    """Probability of backtest overfitting over ``{name: trades}``; ``None`` below two variants.

    The period is cut into ``blocks`` purged blocks; every way of choosing half of them as "in sample" picks the
    variant with the best mean there and looks at its rank on the other half. PBO is the share of splits in which
    that variant ends below the median out of sample. 0.5 means the choice is as good as a coin.

    A variant with fewer than ``min_trades`` trades is left out (``excluded`` lists them): a block in which it
    did nothing scores 0, which beats every losing variant and would make "doing nothing" the winner.
    """
    excluded = sorted(n for n in variants if len(variants[n]) < min_trades)
    names = sorted(n for n in variants if n not in excluded)
    if len(names) < 2 or blocks < 4 or blocks % 2:
        return None
    grid = {}
    for name in names:
        row = purged_folds(variants[name], first_ms, last_ms, blocks)
        if len(row) != blocks:
            return None
        grid[name] = [b["mean_net_bp"] if b["mean_net_bp"] is not None else 0.0 for b in row]
    logits, picked = [], {}
    for chosen in itertools.combinations(range(blocks), blocks // 2):
        rest = [i for i in range(blocks) if i not in chosen]
        training = {n: statistics.fmean(grid[n][i] for i in chosen) for n in names}
        best = max(names, key=lambda n: (training[n], n))
        testing = {n: statistics.fmean(grid[n][i] for i in rest) for n in names}
        rank = sum(1 for n in names if testing[n] < testing[best]) + 0.5 * sum(
            1 for n in names if n != best and testing[n] == testing[best])
        omega = (rank + 0.5) / (len(names) + 1)
        logits.append(math.log(omega / (1 - omega)))
        picked[best] = picked.get(best, 0) + 1
    return {"pbo": round(sum(1 for x in logits if x <= 0) / len(logits), 4), "combinations": len(logits),
            "variants": len(names), "blocks": blocks, "picked": picked, "excluded": excluded}


# --- stress -------------------------------------------------------------------------------------------


def stress(trades, candles_1m, product_id, *, extra_cost_share=DEFAULT_EXTRA_COST_SHARE):
    """The same trades under worse conditions.

    ``extra_cost``: every trade pays ``extra_cost_share`` of the round trip again.
    ``late_entry``: the entry fills at the open of the bar after the signal instead of at the close the signal
    was read on (a one-bar delay), the exit staying where it was. It is an estimate: a stop or target that the
    later entry would have changed is not re-simulated.
    ``break_even_extra_bp``: extra cost per trade that would zero the mean, the edge's margin.
    """
    if not trades:
        return {"extra_cost_bp": None, "extra_cost_mean_net_bp": None, "late_entry_mean_net_bp": None,
                "break_even_extra_bp": None}
    extra = float(round_trip_cost_bps(product_id)) * extra_cost_share
    mean = statistics.fmean(t["net_bp"] for t in trades)
    opens = {c["bucket_start"]: c for c in candles_1m}
    late = []
    for trade in trades:
        signal, following = opens.get(trade["entry_bucket_ms"]), opens.get(trade["entry_bucket_ms"] + ONE_MINUTE_MS)
        if signal is None or following is None:
            late.append(trade["net_bp"])
            continue
        move = (float(following["open"]) / float(signal["close"]) - 1) * 10_000
        late.append(trade["net_bp"] - (move if trade["side"] == "LONG" else -move))
    return {"extra_cost_bp": round(extra, 2), "extra_cost_mean_net_bp": round(mean - extra, 2),
            "late_entry_mean_net_bp": round(statistics.fmean(late), 2), "break_even_extra_bp": round(mean, 2)}


# --- look-ahead sentinel ------------------------------------------------------------------------------


def lookahead_leaks(run, candles_1m, candles_5m, cut_index):
    """Trades whose result changes when the candles after ``cut_index`` do not exist.

    ``run(ones, fives)`` returns the closed trades of one strategy. Trades closed before the cut must be
    identical in the truncated run; any difference means a decision used a candle that had not closed.
    """
    cut_ms = candles_1m[cut_index]["bucket_start"] + ONE_MINUTE_MS
    ones = candles_1m[:cut_index + 1]
    fives = [c for c in candles_5m if c["bucket_start"] + 5 * ONE_MINUTE_MS <= cut_ms]
    full = [t for t in run(candles_1m, candles_5m) if t["exit_time_ms"] <= cut_ms]
    truncated = [t for t in run(ones, fives) if t["exit_time_ms"] <= cut_ms]
    return [a for a, b in itertools.zip_longest(full, truncated) if a != b]
