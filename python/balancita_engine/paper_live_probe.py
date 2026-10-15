"""Stage 10B measurement probe: what the quote policy costs in journal size and replay time, and what a sparser policy
changes in fills and stop detection. Offline, seeded, synthetic prices only; it writes only into a directory the caller
gives. It measures; it does not recommend a policy, and the numbers are for a synthetic random walk, not for Kraken.

    PYTHONPATH=python python3 -m balancita_engine.paper_live_probe size DIR --seconds 600 --products 8
    PYTHONPATH=python python3 -m balancita_engine.paper_live_probe fidelity DIR --seed-count 40
"""

import argparse
import json
import os
import random
import shutil
import time
from decimal import Decimal

from . import signal_continuity as SC
from .paper_runner import PaperRunner, RunnerConfig, make_event
from .portfolio_scenarios import ScriptedStrategy

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
PRODUCTS = ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_DOGEUSD", "PF_LINKUSD", "PF_ADAUSD", "PF_LTCUSD"]
BASE = {"PF_XBTUSD": 100000, "PF_ETHUSD": 3500, "PF_SOLUSD": 150, "PF_XRPUSD": 2, "PF_DOGEUSD": 0.2, "PF_LINKUSD": 15,
        "PF_ADAUSD": 0.6, "PF_LTCUSD": 80}
ATR = {"PF_XBTUSD": "1000", "PF_ETHUSD": "70", "PF_SOLUSD": "3", "PF_XRPUSD": "0.04", "PF_DOGEUSD": "0.004",
       "PF_LINKUSD": "0.3", "PF_ADAUSD": "0.012", "PF_LTCUSD": "1.6"}


def path(seed, product, seconds, drift_bps_per_s=0.0, vol_bps_per_s=0.4):
    """Seeded random walk, one mid per second (``vol_bps_per_s`` of volatility per second)."""
    rng = random.Random("{}|{}".format(seed, product))
    mid, out = float(BASE[product]), []
    for _ in range(seconds):
        mid *= 1 + rng.gauss(drift_bps_per_s, vol_bps_per_s) / 10_000
        out.append(mid)
    return out


def quote(product, t, mid):
    half = D("0.5") / D(10_000)
    mid = D(repr(round(mid, 8)))
    return make_event("quote", {"product_id": product, "time_ms": t, "received_ms": t, "bid": str(mid * (1 - half)),
                                "ask": str(mid * (1 + half))}, t_ms=t, source="probe", stream="ticker:" + product,
                      source_offset=None)


def events(seed, products, seconds, every_s=1):
    """Quotes of every product every ``every_s`` seconds (the sparser policy keeps one in ``every_s``)."""
    walks = {p: path(seed, p, seconds) for p in products}
    out = []
    for i in range(0, seconds, every_s):
        for p in products:
            out.append(quote(p, CYCLE + 3 * SEC + i * SEC, walks[p][i]))
    return out


def build(directory, products, ev, product_for_entry="PF_XBTUSD"):
    script = {(product_for_entry, CYCLE): {"action": "BUY", "strength": "0.8"}}
    config = RunnerConfig(funding=tuple((p, ((CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0"),)) for p in products),
                          start_ms=CYCLE - HOUR)
    runner = PaperRunner.create(directory, config, [ScriptedStrategy("scripted-a", script)])
    cycle = make_event("cycle", {"product_id": product_for_entry, "cycle_ms": CYCLE, "price": str(BASE[product_for_entry]),
                                 "atr": ATR[product_for_entry]}, t_ms=CYCLE + 2 * SEC, source="probe", stream="cycle",
                       source_offset=None)
    return config, script, runner, [cycle] + ev


MARKER = ".paper_live_probe"


def fresh(directory):
    """Empties a probe directory. Refuses to delete anything this probe did not create: an existing directory must be
    empty or carry the marker the probe writes."""
    if os.path.isdir(directory) and os.listdir(directory) and not os.path.exists(os.path.join(directory, MARKER)):
        raise SystemExit("refusing to empty {!r}: not a probe directory (no {} marker)".format(directory, MARKER))
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory)
    open(os.path.join(directory, MARKER), "w").close()


def size(directory, seconds, products, every_s):
    fresh(directory)
    ev = events(1, products, seconds, every_s)
    config, script, runner, evs = build(directory, products, ev)
    t0 = time.perf_counter()
    runner.run(evs)
    write_s = time.perf_counter() - t0
    clock, digest = runner.clock, runner.financial_digest()
    runner.close()
    bytes_ = os.path.getsize(os.path.join(directory, "runner-journal.jsonl"))
    t1 = time.perf_counter()
    again = PaperRunner.recover(directory, config, [ScriptedStrategy("scripted-a", script)], clock)
    replay_s = time.perf_counter() - t1
    same = again.financial_digest() == digest
    again.close()
    n = len(ev)
    return {"quotes": n, "products": len(products), "every_s": every_s, "seconds": seconds, "journal_bytes": bytes_,
            "bytes_per_quote": round(bytes_ / n), "write_s": round(write_s, 2), "replay_s": round(replay_s, 2),
            "replay_matches_continuous": same,
            "day_quotes": round(n * 86_400 / seconds), "day_journal_mb": round(bytes_ * 86_400 / seconds / 1e6, 1),
            "day_replay_s": round(replay_s * 86_400 / seconds, 1)}


def one(directory, seed, every_s, drift, phase=0):
    """A scripted long on BTC with a seeded drift; what the runner did (entry, exit, reason, prices)."""
    fresh(directory)
    walk = path(seed, "PF_XBTUSD", 7200, drift, 2.5)       # 2.5 bp/s so that stops and targets are reached
    ev = [quote("PF_XBTUSD", CYCLE + 3 * SEC + i * SEC, walk[i]) for i in range(phase, 7200, every_s)]
    config, script, runner, evs = build(directory, ["PF_XBTUSD"], ev)
    runner.run(evs)
    clock = runner.clock
    rows = [o for o in runner.orders()]
    watch = runner.portfolio.positions
    res = {"order": rows[0]["state"] if rows else None, "entry_ms": rows[0]["timeline"].get("entry_ms") if rows else None,
           "closed": None}
    runner_trades = runner.portfolio.trades
    if runner_trades:
        t = runner_trades[0]
        res["closed"] = {"exit_ms": t.get("exit_time_ms"), "reason": t.get("exit_reason"), "entry_price": str(t.get("entry_price"))}
    res["open_at_end"] = len(watch)
    runner.close()
    return res, clock


def fidelity(directory, seed_count, every_s):
    """Same prices, full vs one-in-``every_s`` quotes: how many entries, exit reasons and exit times differ."""
    rows = []
    for k in range(seed_count):
        drift = (-1) ** k * 0.01
        full, _ = one(os.path.join(directory, "full"), k, 1, drift)
        sparse, _ = one(os.path.join(directory, "sparse"), k, every_s, drift, phase=(k * 7) % every_s)
        rows.append((full, sparse))
    both = [(f, s) for f, s in rows if f["closed"] and s["closed"]]
    return {"runs": seed_count, "every_s": every_s,
            "entry_time_differs": sum(1 for f, s in rows if f["entry_ms"] != s["entry_ms"]),
            "entry_opened_full": sum(1 for f, _ in rows if f["order"] == "opened"),
            "entry_opened_sparse": sum(1 for _, s in rows if s["order"] == "opened"),
            "closed_both": len(both),
            "exit_reason_differs": sum(1 for f, s in both if f["closed"]["reason"] != s["closed"]["reason"]),
            "exit_time_differs": sum(1 for f, s in both if f["closed"]["exit_ms"] != s["closed"]["exit_ms"]),
            "entry_price_differs": sum(1 for f, s in both if f["closed"]["entry_price"] != s["closed"]["entry_price"]),
            "exit_delay_s_mean": round(sum((s["closed"]["exit_ms"] - f["closed"]["exit_ms"]) / 1000 for f, s in both)
                                       / max(1, len(both)), 1)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=("size", "fidelity"))
    ap.add_argument("directory")
    ap.add_argument("--seconds", type=int, default=600)
    ap.add_argument("--products", type=int, default=8)
    ap.add_argument("--every", type=int, default=1)
    ap.add_argument("--seed-count", type=int, default=20)
    args = ap.parse_args(argv)
    if args.what == "size":
        print(json.dumps(size(args.directory, args.seconds, PRODUCTS[:args.products], args.every), sort_keys=True))
    else:
        print(json.dumps(fidelity(args.directory, args.seed_count, args.every), sort_keys=True))


if __name__ == "__main__":
    main()
