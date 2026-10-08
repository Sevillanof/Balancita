"""Paired comparison of Qwen replays (the A/B behind ``--qwen-arm``).

Two or more run DBs written by ``futures_replay`` over the same range and product ask the same question with
different context lines. For every bucket both answered, each answer earns the +1 / -1 of the live scorer
(``futures_llm_lessons.right_action``: the action that wins after costs 30 minutes later). The arms are compared on
those buckets only, so the difference is not a matter of which frames each one happened to answer.

* ``mean_diff``: mean of (point of B - point of A) over the shared buckets.
* ``p_value``: sign-flip permutation test with whole UTC days as the unit (decisions of one day share the
  market's move, so they are not independent); two-sided, exact below ``EXACT_DAYS`` days, Monte Carlo above.
* ``baselines.always_hold``: the +1 rate of answering ``hold`` every time on the shared buckets, the floor an arm has to beat.

    python -m balancita_engine.futures_replay_compare --market-db market.sqlite run-original.sqlite run-learning.sqlite
"""

import argparse
import itertools
import json
import random
import sqlite3
import statistics
import sys

from .futures_llm_lessons import right_action
from .futures_llm_scores import HORIZON_MIN
from .futures_replay import load_range
from .futures_verdicts import ONE_MINUTE_MS

DAY_MS = 86_400_000
EXACT_DAYS = 14
SAMPLES = 20_000


def read_run(path):
    """``(meta, {bucket: chosen})`` of one replay run DB."""
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        meta = {k: json.loads(v) for k, v in db.execute("SELECT key, value FROM replay_run")}
        chosen = {}
        for (payload,) in db.execute("SELECT payload FROM replay_qwen_decision ORDER BY id"):
            row = json.loads(payload)
            chosen[row["bucket_start"]] = row["chosen"]
    finally:
        db.close()
    return meta, chosen


def points(chosen, closes, product_id):
    """``{bucket: +1 / -1}`` for the decisions whose horizon close exists."""
    out = {}
    for bucket, answer in chosen.items():
        entry, exit_close = closes.get(bucket), closes.get(bucket + HORIZON_MIN * ONE_MINUTE_MS)
        if entry is not None and exit_close is not None:
            out[bucket] = 1 if answer == right_action(entry, exit_close, product_id) else -1
    return out


def sign_flip_p(day_sums, rng=None):
    """Two-sided p-value that the mean paired difference is zero, flipping the sign of whole days."""
    observed = abs(sum(day_sums))
    if observed == 0 or not day_sums:
        return 1.0
    if len(day_sums) <= EXACT_DAYS:
        signs = list(itertools.product((1, -1), repeat=len(day_sums)))
    else:
        rng = rng or random.Random(0)
        signs = [[rng.choice((1, -1)) for _ in day_sums] for _ in range(SAMPLES)]
    hits = sum(1 for s in signs if abs(sum(a * b for a, b in zip(s, day_sums))) >= observed - 1e-9)
    return hits / len(signs)


def compare(base, other, base_points, other_points, closes, product_id):
    shared = sorted(set(base_points) & set(other_points))
    if not shared:
        return {"shared": 0, "mean_diff": None, "p_value": None}
    diffs = [other_points[b] - base_points[b] for b in shared]
    days = {}
    for bucket, diff in zip(shared, diffs):
        days[bucket // DAY_MS] = days.get(bucket // DAY_MS, 0) + diff
    return {"shared": len(shared), "days": len(days), "mean_diff": round(statistics.fmean(diffs), 4),
            "p_value": round(sign_flip_p(list(days.values())), 4),
            "rate_base": round(sum(1 for b in shared if base_points[b] == 1) / len(shared), 4),
            "rate_other": round(sum(1 for b in shared if other_points[b] == 1) / len(shared), 4)}


def baselines(buckets, closes, product_id):
    """+1 rate of answering ``hold`` on every one of ``buckets``."""
    rights = {b: right_action(closes[b], closes[b + HORIZON_MIN * ONE_MINUTE_MS], product_id) for b in buckets}
    hold = sum(1 for r in rights.values() if r == "hold") / len(rights)
    return {"always_hold": round(hold, 4)} if rights else {}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--market-db", required=True)
    parser.add_argument("runs", nargs="+", help="run DBs; the first is the baseline arm")
    args = parser.parse_args(argv)
    runs = [read_run(path) for path in args.runs]
    meta = runs[0][0]
    if any((m["product_id"], m["start_ms"], m["end_ms"]) != (meta["product_id"], meta["start_ms"], meta["end_ms"])
           for m, _ in runs):
        parser.error("the runs must cover the same product and range")
    ones, _ = load_range(args.market_db, meta["product_id"], meta["start_ms"], meta["end_ms"] + HORIZON_MIN * ONE_MINUTE_MS)
    closes = {c["bucket_start"]: c["close"] for c in ones}
    pts = [points(chosen, closes, meta["product_id"]) for _, chosen in runs]
    result = {"product_id": meta["product_id"], "arms": []}
    shared = sorted(set.intersection(*(set(p) for p in pts)))
    result["shared_all"] = len(shared)
    if shared:
        result["baselines"] = baselines(shared, closes, meta["product_id"])
    for path, (m, _), p in zip(args.runs, runs, pts):
        entry = {"run": path, "question": (m.get("qwen") or {}).get("question"),
                 "version": (m.get("qwen") or {}).get("version"), "decisions": len(p),
                 "rate": round(sum(1 for v in p.values() if v == 1) / len(p), 4) if p else None}
        if p is not pts[0]:
            entry["vs_first"] = compare(args.runs[0], path, pts[0], p, closes, meta["product_id"])
        result["arms"].append(entry)
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
