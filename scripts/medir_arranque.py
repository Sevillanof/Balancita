#!/usr/bin/env python3
"""Measures the start-up (warm-up) of a paper session on a capture, read-only, phase by phase.

Usage: python3 scripts/medir_arranque.py --source /path/futures-market.sqlite [--products PF_XBTUSD ...] [--decide-from-ms N]
                                          [--bounded | --whole] [--max-steps N] [--keep]

It runs the same warm-up path as a real session (``LiveSession``: SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner, journals,
audit and checkpoints) with the clock at ``decide_from``, until the session leaves the WARMUP phase. What it guarantees:

* the capture is opened with ``mode=ro`` + ``query_only`` (``SourceReader`` and the funding source) and is never written;
* every file it writes is inside a fresh temporary directory (removed at the end unless ``--keep``), never a session folder; it does not go
  through the real-session GATE (``paper_live_process.preflight``) and does not start a process, a wall clock or a network connection;
* ``--bounded`` (default) uses the opt-in ``bounded_start`` of the ingestor; ``--whole`` reads everything, as a session without it does.

It prints the time of each phase (cursor seeding, rows read per table, candles fed to the evaluator, events handled by the runner by kind,
fsyncs, checkpoints and their size) and the same as one JSON line at the end. The numbers are wall time of this process on this disk: run it
while the capture is writing to see the contended fsync the live session sees.
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from balancita_engine import paper_live_integration as LI            # noqa: E402
from balancita_engine import paper_live_process as LP                # noqa: E402
from balancita_engine import replay_specs as RS                      # noqa: E402
from balancita_engine.futures_strategy_reliability import LATE_CANDLE_TOLERANCE_MS   # noqa: E402

ONE_MINUTE_MS = 60_000


class Clock(object):
    """Accumulates the seconds and the calls of what it wraps."""

    def __init__(self):
        self.seconds, self.calls, self.rows = {}, {}, {}

    def wrap(self, owner, name, label=None, rows=None):
        original, label = getattr(owner, name), label or name

        def timed(*args, **kw):
            started = time.perf_counter()
            try:
                out = original(*args, **kw)
            finally:
                self.seconds[label] = self.seconds.get(label, 0.0) + time.perf_counter() - started
                self.calls[label] = self.calls.get(label, 0) + 1
            if rows is not None:
                self.rows[label] = self.rows.get(label, 0) + rows(out)
            return out
        setattr(owner, name, timed)


def newest_close(path, product):
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        newest = db.execute("SELECT MAX(bucket_start) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=?",
                            (product, ONE_MINUTE_MS)).fetchone()[0]
    finally:
        db.close()
    return None if newest is None else newest + ONE_MINUTE_MS


def measure(args, directory):
    products = args.products
    decide_from = args.decide_from_ms or newest_close(args.source, products[0])
    if decide_from is None:
        raise SystemExit("the capture has no 1-minute candle of {}".format(products[0]))
    strategies = RS.load_frozen()[0]
    config = {"notional_per_trade_usd": LP.DEFAULTS["notional_per_trade_usd"], "decide_from_ms": decide_from}
    ingest_kw = {"causal_until_clock": True}
    if args.bounded:
        ingest_kw["bounded_start"] = True
    clock, fsyncs = Clock(), {"calls": 0, "seconds": 0.0}
    real_fsync = os.fsync

    def timed_fsync(fd):
        started = time.perf_counter()
        try:
            return real_fsync(fd)
        finally:
            fsyncs["calls"] += 1
            fsyncs["seconds"] += time.perf_counter() - started
    os.fsync = timed_fsync
    out = {"source": args.source, "products": products, "decide_from_ms": decide_from, "bounded": args.bounded, "phases": {}}
    started = time.perf_counter()
    try:
        session = LI.LiveSession.create(directory, args.source, strategies, products, LP.runner_config_of(config), decide_from_ms=decide_from,
                                        source_id="medir-arranque", ingest_kw=ingest_kw, max_quote_gap_ms=LP.DEFAULTS["max_quote_gap_ms"],
                                        evaluator_kw={"candle_tolerance_ms": LATE_CANDLE_TOLERANCE_MS}, funding_mode=LI.OBSERVED_FUNDING)
        out["phases"]["create_session"] = time.perf_counter() - started
        print("progress create_session {:.1f}s".format(out["phases"]["create_session"]), file=sys.stderr, flush=True)
        try:
            ing, reader = session.ingestor, session.reader
            for name in ("tickers", "candles", "gaps"):
                clock.wrap(reader, name, "read_" + name, rows=len)
            clock.wrap(session.evaluator, "feed_candle", "evaluator_feed_candle")
            clock.wrap(session.evaluator, "flush", "evaluator_flush")
            clock.wrap(session, "save_checkpoint", "checkpoint")
            clock.wrap(session, "flush_audit", "audit")
            kinds = {}
            handle = session.runner.handle

            def counted(event):
                kinds[event["kind"]] = kinds.get(event["kind"], 0) + 1
                return handle(event)
            session.runner.handle = counted
            clock.wrap(session.runner, "handle", "runner_handle")
            before = time.perf_counter()
            ing._seed()                                    # idempotent: the first read finds it done
            out["phases"]["seed_cursors"] = time.perf_counter() - before
            out["seeded_cursors"] = dict(ing.seeded)
            print("progress seed_cursors {:.1f}s {}".format(out["phases"]["seed_cursors"], out["seeded_cursors"]), file=sys.stderr, flush=True)
            steps, began, delivered = 0, time.perf_counter(), -1
            while steps < args.max_steps:                  # until the source has nothing more for this clock (or the session is past the warm-up)
                state = session.step(decide_from)
                steps += 1
                progressed = session.stats["events"] != delivered
                delivered = session.stats["events"]
                if steps <= 3 or steps % 10 == 0:
                    print("progress step {} t={:.1f}s events={} fsyncs={} phase={}".format(
                        steps, time.perf_counter() - began, delivered, fsyncs["calls"], LP.phase_of(session)), file=sys.stderr, flush=True)
                if not state["more_to_read"] and (not progressed or LP.phase_of(session) != LP.WARMUP):
                    break
            out["phases"]["steps_total"] = time.perf_counter() - began
            out["steps"] = steps
            out["phase_at_end"] = LP.phase_of(session)
            out["rows_read"] = {k[5:]: v for k, v in clock.rows.items() if k.startswith("read_")}
            out["seconds"] = {k: round(v, 3) for k, v in sorted(clock.seconds.items())}
            out["calls"] = dict(sorted(clock.calls.items()))
            out["events_to_runner"] = dict(sorted(kinds.items()))
            out["evaluator_candles"] = session.evaluator.stats["candles"]
            out["evaluator_stats"] = dict(session.evaluator.stats)
            out["evaluator_gaps"] = {"count": len(session.evaluator.gaps), "last": session.evaluator.gaps[-1] if session.evaluator.gaps else None}
            out["evaluator_state"] = {p: {"last_one": st["last_one"], "suppress_until": st["suppress_until"]} for p, st in session.evaluator.state.items()}
            out["evaluator_log_entries"] = len(session.evaluator.log.entries)
            out["cursors"] = dict(ing.cursor)
            checkpoint = os.path.join(directory, LI.CHECKPOINT_FILE)
            out["checkpoint_bytes"] = os.path.getsize(checkpoint)
            out["runner_journal_entries"] = len(session.runner.journal.entries)
        finally:
            session.close()
    finally:
        os.fsync = real_fsync
    out["fsyncs"] = {"calls": fsyncs["calls"], "seconds": round(fsyncs["seconds"], 3)}
    out["phases"]["total"] = time.perf_counter() - started
    out["phases"] = {k: round(v, 3) for k, v in out["phases"].items()}
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--source", required=True, help="the capture's sqlite file (opened read-only)")
    parser.add_argument("--products", nargs="+", default=["PF_XBTUSD"])
    parser.add_argument("--decide-from-ms", type=int, default=None, help="default: the end of the newest 1-minute candle of the first product")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--bounded", dest="bounded", action="store_true", default=True)
    mode.add_argument("--whole", dest="bounded", action="store_false", help="read the whole source (a session without bounded_start)")
    parser.add_argument("--max-steps", type=int, default=400)
    parser.add_argument("--keep", action="store_true", help="keep the temporary directory it wrote to")
    args = parser.parse_args(argv)
    if not os.path.isfile(args.source):
        raise SystemExit("no such file: " + args.source)
    directory = tempfile.mkdtemp(prefix="medir-arranque-")
    try:
        result = measure(args, os.path.join(directory, "session"))
    finally:
        if args.keep:
            print("temporary directory kept: " + directory, file=sys.stderr)
        else:
            shutil.rmtree(directory, True)
    for key in ("phases", "seconds", "calls", "rows_read", "events_to_runner", "fsyncs"):
        print("{:18} {}".format(key, json.dumps(result[key], sort_keys=True)))
    for key in ("steps", "phase_at_end", "seeded_cursors", "cursors", "evaluator_candles", "evaluator_stats", "evaluator_gaps", "evaluator_state", "evaluator_log_entries", "runner_journal_entries", "checkpoint_bytes"):
        print("{:18} {}".format(key, result[key]))
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
