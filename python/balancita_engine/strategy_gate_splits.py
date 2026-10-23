"""Purged stability samples using the legacy backtest's observed-hold embargo.

Nothing is fitted: these blocks do not establish leakage-free learning or
out-of-sample generalization. Global statistics retain every observed close.
"""

import bisect
import collections
import copy

from .futures_purged import EMBARGO_MAX_SHARE, embargo_ms, purged_split

SCHEMA = "balancita.strategy-gate-temporal.v1"
METHOD = "purged_stability_observed_hold.v1"


def fold_edges(start_ms, end_ms, folds):
    return [start_ms + (end_ms - start_ms) * i // folds for i in range(folds + 1)]


def stability_samples(trades, start_ms, end_ms, folds, *, embargo_supported=True, open_at_end=0):
    """Return samples and auditable exclusions, never modifying the input trades.

    Keep the gate's integer edges and configured fold denominator. Reuse the
    legacy embargo duration and inclusive exit-at-cut predicate. Unlike legacy
    open-ended outer blocks, the gate has an explicit finite evaluation window.
    No duration is inferred for recorded-model producers lacking that policy.
    """
    edges = fold_edges(start_ms, end_ms, folds)
    closed = [{"entry_time_ms": t["entry_ms"], "exit_time_ms": t["exit_ms"]}
              for t in trades if t.get("exit_ms") is not None and t["exit_ms"] >= t["entry_ms"]]
    supported = embargo_supported and bool(closed)
    duration = embargo_ms(closed, (end_ms - start_ms) / folds) if supported else None
    source = ("legacy_longest_observed_closed_hold" if supported else
              "no_closed_holds" if embargo_supported else "unsupported_recorded_model_horizon")
    samples = [[] for _ in range(folds)]
    rows = [dict(index=i + 1, from_ms=edges[i], to_ms=edges[i + 1],
                 usable_from_ms=edges[i] + (duration if i and duration is not None else 0),
                 embargo_ms=0 if i == 0 else duration, used=0, excluded=0, excluded_reasons={})
            for i in range(folds)]
    excluded = collections.Counter()
    for trade in trades:
        entry, exit_ = trade["entry_ms"], trade.get("exit_ms")
        if not start_ms <= entry < end_ms:
            excluded["entry_out_of_range"] += 1
            continue
        slot = bisect.bisect_right(edges, entry) - 1
        row = rows[slot]
        adapter = {"entry_time_ms": entry, "exit_time_ms": exit_}
        if exit_ is None:
            reason = "open_at_cut"
        elif exit_ < entry:
            reason = "invalid_interval"
        elif not purged_split([adapter], edges[slot + 1], 0)[0]:
            reason = "crosses_fold_end"
        elif not supported:
            reason = "unsupported_embargo"
        elif entry < row["usable_from_ms"]:
            reason = "embargo"
        else:
            samples[slot].append(trade)
            continue
        excluded[reason] += 1
        row["excluded_reasons"][reason] = row["excluded_reasons"].get(reason, 0) + 1
        row["excluded"] += 1
    for row, sample in zip(rows, samples):
        row["used"] = len(sample)
        row["sample_state"] = "no_trades" if not sample else "single_trade" if len(sample) == 1 else "observed"
    reasons = []
    if not supported:
        reasons.append(source)
    if any(not sample for sample in samples):
        reasons.append("empty_folds")
    if any(len(sample) == 1 for sample in samples):
        reasons.append("single_trade_folds")
    censored = open_at_end + excluded["open_at_cut"]
    if censored:
        reasons.append("open_at_cut")
    state = ("unsupported" if not embargo_supported else "censored" if censored else
             "no_trades" if not trades else "insufficient" if reasons else "observed")
    metadata = dict(schema=SCHEMA, method=METHOD, scope="temporal_stability_only", state=state, reasons=reasons,
                    training_testing_walk_forward=False, from_ms=start_ms, to_ms=end_ms,
                    entry_bounds="[from,to)", exit_bound="exit<=to", fold_count=folds,
                    embargo_ms=duration, embargo_source=source, embargo_supported=supported,
                    embargo_max_fold_share=EMBARGO_MAX_SHARE,
                    input_trades=len(trades), used_trades=sum(map(len, samples)),
                    excluded_trades=sum(excluded.values()), excluded_reasons=dict(excluded),
                    open_at_end=censored, folds=rows)
    return samples, metadata


_EXCLUSIONS = ("entry_out_of_range", "open_at_cut", "invalid_interval", "crosses_fold_end",
               "unsupported_embargo", "embargo")


def _counts(value, allowed=_EXCLUSIONS):
    return (isinstance(value, dict) and all(key in allowed and type(count) is int and count > 0
                                           for key, count in value.items()))


def _valid_saved(value):
    """Check v1's saved claims against each other, never against today's trades."""
    required = ("schema", "method", "scope", "state", "reasons", "training_testing_walk_forward", "from_ms", "to_ms",
                "entry_bounds", "exit_bound", "fold_count", "embargo_ms", "embargo_source", "embargo_supported",
                "embargo_max_fold_share", "input_trades", "used_trades", "excluded_trades", "excluded_reasons",
                "open_at_end", "folds")
    if (not isinstance(value, dict) or not all(key in value for key in required)
            or value["schema"] != SCHEMA or value["method"] != METHOD
            or value["scope"] != "temporal_stability_only" or value["training_testing_walk_forward"] is not False
            or value["entry_bounds"] != "[from,to)" or value["exit_bound"] != "exit<=to"):
        return False
    if (any(type(value[k]) is not int or value[k] < 0
            for k in ("input_trades", "used_trades", "excluded_trades", "open_at_end", "fold_count"))
            or value["fold_count"] < 1 or type(value["from_ms"]) is not int or type(value["to_ms"]) is not int
            or value["to_ms"] <= value["from_ms"] or not isinstance(value["folds"], list)
            or len(value["folds"]) != value["fold_count"] or not _counts(value["excluded_reasons"])
            or type(value["embargo_supported"]) is not bool
            or type(value["embargo_max_fold_share"]) not in (int, float)
            or value["embargo_max_fold_share"] != EMBARGO_MAX_SHARE):
        return False
    source, supported, duration = (value[k] for k in ("embargo_source", "embargo_supported", "embargo_ms"))
    if source not in ("legacy_longest_observed_closed_hold", "no_closed_holds", "unsupported_recorded_model_horizon"):
        return False
    if supported != (source == "legacy_longest_observed_closed_hold"):
        return False
    if supported:
        cap = int((value["to_ms"] - value["from_ms"]) / value["fold_count"] * EMBARGO_MAX_SHARE)
        if type(duration) is not int or not 0 <= duration <= cap or not value["input_trades"]:
            return False
        if value["input_trades"] <= sum(value["excluded_reasons"].get(k, 0) for k in ("open_at_cut", "invalid_interval")):
            return False
    elif duration is not None or value["used_trades"]:
        return False
    excluded = value["excluded_reasons"]
    if (value["input_trades"] != value["used_trades"] + value["excluded_trades"]
            or value["excluded_trades"] != sum(excluded.values())
            or value["open_at_end"] < excluded.get("open_at_cut", 0)
            or (supported and "unsupported_embargo" in excluded)
            or (not supported and "embargo" in excluded)
            or (source == "no_closed_holds" and any(k in excluded for k in ("crosses_fold_end", "unsupported_embargo")))):
        return False
    edges = fold_edges(value["from_ms"], value["to_ms"], value["fold_count"])
    combined, used = collections.Counter(), 0
    for i, row in enumerate(value["folds"]):
        if (not isinstance(row, dict)
                or any(type(row.get(k)) is not int for k in ("index", "from_ms", "to_ms", "usable_from_ms", "used", "excluded"))
                or row["index"] != i + 1 or row["from_ms"] != edges[i] or row["to_ms"] != edges[i + 1]
                or row["used"] < 0 or row["excluded"] < 0 or "embargo_ms" not in row
                or not _counts(row.get("excluded_reasons"), _EXCLUSIONS[1:])):
            return False
        applied = duration if i else 0
        if (type(row["embargo_ms"]) is not type(applied) or row["embargo_ms"] != applied
                or row["usable_from_ms"] != edges[i] + (applied or 0)
                or row["excluded"] != sum(row["excluded_reasons"].values())
                or (i == 0 and "embargo" in row["excluded_reasons"])):
            return False
        sample_state = "no_trades" if not row["used"] else "single_trade" if row["used"] == 1 else "observed"
        if row.get("sample_state") != sample_state:
            return False
        used += row["used"]
        combined.update(row["excluded_reasons"])
    if "entry_out_of_range" in excluded:
        combined["entry_out_of_range"] = excluded["entry_out_of_range"]
    if used != value["used_trades"] or combined != collections.Counter(excluded):
        return False
    reasons = [] if supported else [source]
    if any(not row["used"] for row in value["folds"]):
        reasons.append("empty_folds")
    if any(row["used"] == 1 for row in value["folds"]):
        reasons.append("single_trade_folds")
    if value["open_at_end"]:
        reasons.append("open_at_cut")
    state = ("unsupported" if source == "unsupported_recorded_model_horizon" else
             "censored" if value["open_at_end"] else "no_trades" if not value["input_trades"] else
             "insufficient" if reasons else "observed")
    return value["state"] == state and value["reasons"] == reasons


def stored(value):
    """Copy saved evidence only; old or contradictory metadata remains unknown."""
    try:
        if _valid_saved(value):
            return copy.deepcopy(value)
    except OverflowError:  # Unrepresentable JSON integer bounds cannot substantiate a duration.
        pass
    return dict(schema=SCHEMA, method=None, scope=None, state="unknown",
                reasons=["missing_or_invalid_temporal_metadata"], embargo_ms=None,
                embargo_source=None, embargo_supported=None, folds=None, fold_count=None,
                training_testing_walk_forward=None)
