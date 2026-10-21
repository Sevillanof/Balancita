"""A session that starts at its first need and not at the first row the capture ever stored: lower bounds for tickers, candles and capture gaps
(``Ingestor(not_before_*)``, opt-in ``bounded_start`` of ``LiveSession``), a cursor seeded through the capture's indexes, and the evaluator's
warm-up inputs fsynced once per step instead of once per candle. Decisions must not change: the same real market is run with and without the
bounds, and the digests of every step have to be equal. Rows the bounds skip are old rows of the real sample and old rows of a second product
the session does not list, written before the first real row (so they have the lowest rowids, as the capture's old rows do)."""

import json
import os
import tempfile
import unittest

from balancita_engine import paper_live_evaluator as LE
from balancita_engine import paper_live_ingest as ING
from balancita_engine import paper_live_integration as LI
from balancita_engine import signal_continuity as SC

from real_session import (DECIDE_FROM, INGEST_KW, STEP, Base, abandon, new_session, record, recover_session,
                          strategies)
from real_world import BTC, HOUR, MIN, T0, RealWorld
from test_paper_live_ingest import Source

ETH = "PF_ETHUSD"
STEPS = 14                                      # 70 minutes: the first forced entry (30 minutes in) is decided, filled and followed
OLD_MINUTES = 120


class WorldWithOldRows(RealWorld):
    """The real world plus, written first, OLD_MINUTES of tickers and candles of a product the session does not list and one old capture
    gap, all before ``T0``: nothing the session needs, everything an unbounded read has to walk."""

    def __init__(self, directory, **kw):
        RealWorld.__init__(self, directory, **kw)
        for k in range(OLD_MINUTES):
            t = T0 - (OLD_MINUTES - k) * MIN
            body = {"type": "ticker", "productId": ETH, "seq": t, "epoch": 1, "eventTime": t, "receivedAt": t, "persistedAt": t,
                    "bid": "3500", "ask": "3501"}
            text = json.dumps(body, sort_keys=True)
            self.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            ("old:{}".format(t), "ticker", ETH, 1, t, t, t, t, None, "{}", text, "h{}".format(t)))
            self.db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (ETH, MIN, t - t % MIN, "r", t + MIN, "3500", "3501", "3499", "3500", "1", "s"))
        self.db.execute("INSERT INTO paper_futures_data_gaps VALUES(?,?,?,?,?,?,?,?,?)", ("old-gap", "ticker", BTC, 1, 1, 3, T0 - HOUR, "seq_gap", "p"))
        self.db.commit()


def session_world(test):
    """A fresh world with the old rows, released up to the minute before the first decision."""
    world = WorldWithOldRows(tempfile.mkdtemp(dir=test.root))
    test.addCleanup(world.close)
    world.release_until(DECIDE_FROM - MIN)
    return world


def counting(session):
    """How many rows each read of the source returned."""
    counts = {"tickers": 0, "candles": 0, "gaps": 0}
    for name in counts:
        original = getattr(session.reader, name)

        def wrapped(*args, _original=original, _name=name, **kw):
            rows = _original(*args, **kw)
            counts[_name] += len(rows)
            return rows
        setattr(session.reader, name, wrapped)
    return counts


class FastStart(Base):
    def run_session(self, ingest_kw, name):
        """A session on a world of its own (the same real rows every time, released step by step); returns the per-step records, the
        counters and the session."""
        world = session_world(self)
        session = new_session(world, os.path.join(self.root, name), self.strategies(), ingest_kw)
        session.world = world
        self.addCleanup(abandon, session)
        counts = counting(session)
        records = []
        for index in range(STEPS):
            now = DECIDE_FROM + index * STEP
            world.release_until(now)
            session.step(now)
            records.append(record(session, now))
        return records, counts, session

    def strategies(self):
        return strategies(self.buckets)

    def test_the_bounds_skip_rows_and_change_no_decision(self):
        # the world is shared by the two runs, so the second one reads the very rows the first one did
        whole, whole_counts, whole_session = self.run_session(INGEST_KW, "whole")
        bounded, bounded_counts, bounded_session = self.run_session(dict(INGEST_KW, bounded_start=True), "bounded")
        # a bounded session has fewer rows to read, so it is ahead of the whole one in the middle of the catch-up: what must be equal is where
        # both end (financial state, every signal id, every order, portfolio), and the steps once both have caught up
        self.assertEqual(bounded[-1], whole[-1])
        self.assertEqual(bounded[-3:], whole[-3:])
        self.assertEqual(bounded_session.digests(), whole_session.digests())
        self.assertTrue(whole_session.runner.orders())                              # the comparison holds an entry: it is not an empty run
        self.assertGreater(bounded_session.ingestor.seeded["ticker"], 0)            # the ticker cursor was put by the index, not found by reading
        self.assertLess(bounded_counts["tickers"], whole_counts["tickers"])
        # the candle bound precedes every candle of the product, but the cursor is seeded at its first row: the old rows of the other product go
        self.assertEqual(whole_counts["candles"] - bounded_counts["candles"], OLD_MINUTES)
        self.assertLess(bounded_counts["gaps"], whole_counts["gaps"])
        # what the strategies read is the same: every candle of the product the session trades reached the evaluator, in both runs
        self.assertEqual(bounded_session.evaluator.stats["candles"], whole_session.evaluator.stats["candles"])
        def candles_of(session):          # the history enters at its close in a bounded start (not when the capture wrote it): same candles, same order
            return [(e["data"]["product_id"], e["data"]["candle"]) for e in session.evaluator.log.entries if e["kind"] == "candle"]
        self.assertEqual(candles_of(bounded_session), candles_of(whole_session))

    def test_a_candle_bound_before_the_first_needed_candle_skips_the_rows_before_it(self):
        whole, whole_counts, whole_session = self.run_session(INGEST_KW, "whole")
        kw = dict(INGEST_KW, not_before_candle_ms=T0, not_before_ticker_ms=DECIDE_FROM - HOUR, not_before_gap_ms=DECIDE_FROM - HOUR)
        bounded, bounded_counts, bounded_session = self.run_session(kw, "bounded")
        self.assertEqual(bounded[-3:], whole[-3:])
        self.assertGreater(bounded_session.ingestor.seeded["candle"], 0)
        self.assertEqual(whole_counts["candles"] - bounded_counts["candles"], OLD_MINUTES)       # exactly the old rows of the other product
        self.assertEqual(bounded_session.evaluator.log.head, whole_session.evaluator.log.head)

    def test_the_session_identity_is_the_one_of_its_configuration_and_a_recovery_uses_the_same_bounds(self):
        kw = dict(INGEST_KW, bounded_start=True)
        records, _counts, session = self.run_session(kw, "bounded")
        self.assertEqual(session.identity["ingestor"]["bounded_start"], True)
        self.assertNotEqual(session.identity["session_id"], self.run_session(INGEST_KW, "other")[2].identity["session_id"])
        abandon(session)
        revived = recover_session(session.world, session.directory, self.strategies(), DECIDE_FROM + STEPS * STEP, kw)
        self.addCleanup(abandon, revived)
        self.assertEqual(revived.ingestor.not_before, session.ingestor.not_before)
        self.assertEqual(revived.ingestor.cursor, session.ingestor.cursor)                        # the checkpoint's cursors: nothing is seeded again
        now = DECIDE_FROM + STEPS * STEP
        session.world.release_until(now)
        revived.step(now)
        self.assertEqual(revived.ingestor.seeded, {})


class WarmupHelpers(object):
    def drain(self, session, world):
        """Steps at the first decision until everything the source holds has been read, then three steps of the clock."""
        for _ in range(300):
            if not session.step(DECIDE_FROM)["more_to_read"]:
                break
        for index in range(1, 4):
            now = DECIDE_FROM + index * STEP
            world.release_until(now)
            session.step(now)

    def continuous(self):
        world = session_world(self)
        session = new_session(world, os.path.join(self.root, "reference"), strategies(self.buckets))
        self.addCleanup(abandon, session)
        self.drain(session, world)
        return session

    def buckets_in_log(self, session):
        return [e["data"]["candle"]["bucket_start"] for e in session.evaluator.log.entries if e["kind"] == "candle"]


class TestWarmupLog(WarmupHelpers, Base):
    """A crash in the middle of the warm-up, with the candle inputs written but not yet fsynced: the log keeps only whole lines, and the
    recovery loses no candle and repeats none."""

    def crash(self, world, cut_bytes):
        """The process dies at the 40th warm-up candle it logs, a few steps (and checkpoints) after the start; ``cut_bytes`` > 0: the last
        line is cut, as a power cut leaves it."""
        directory = os.path.join(self.root, "crashed")
        session = new_session(world, directory, strategies(self.buckets))
        seen = {"n": 0}

        def fault(name, info=None):
            if name == "input_logged":
                seen["n"] += 1
                if seen["n"] == 40:
                    raise LI.FaultInjected(name)
        session.fault = fault
        with self.assertRaises(LI.FaultInjected):
            for _ in range(300):
                session.step(DECIDE_FROM)
        self.assertEqual(len(self.buckets_in_log(session)), 40)
        self.assertGreater(session.evaluator.log.entries[-1]["seq"], 1)
        path = os.path.join(directory, "evaluator.jsonl")
        abandon(session)
        if cut_bytes:
            with open(path, "rb") as handle:
                data = handle.read()
            with open(path, "wb") as handle:
                handle.write(data[:-cut_bytes])
        return directory

    def check_recovery(self, cut_bytes):
        reference = self.continuous()
        world = session_world(self)
        directory = self.crash(world, cut_bytes)
        revived = recover_session(world, directory, strategies(self.buckets), DECIDE_FROM)
        self.addCleanup(abandon, revived)
        self.assertEqual(revived.evaluator.log.tail_discarded, 1 if cut_bytes else 0)
        self.assertEqual(len(self.buckets_in_log(revived)), 39 if cut_bytes else 40)               # only whole lines are left
        self.drain(revived, world)
        buckets = self.buckets_in_log(revived)
        self.assertGreater(len(buckets), 40)
        self.assertEqual(buckets, self.buckets_in_log(reference))                                  # no candle lost, none twice, same order
        self.assertEqual(len(buckets), len(set(buckets)))
        self.assertEqual(revived.evaluator.log.head, reference.evaluator.log.head)
        now = DECIDE_FROM + 3 * STEP
        self.assertEqual(record(revived, now), record(reference, now))
        with open(os.path.join(directory, "evaluator.jsonl"), "rb") as handle:
            self.assertEqual(len(handle.read().splitlines()), len(revived.evaluator.log.entries))   # the file holds exactly the entries in memory

    def test_a_crash_in_the_middle_of_the_warmup_batch_recovers_without_loss_or_repeats(self):
        self.check_recovery(0)

    def test_a_crash_that_cut_the_last_line_of_the_batch_recovers_without_loss_or_repeats(self):
        self.check_recovery(25)


class TestInputLogSync(unittest.TestCase):
    def test_warmup_inputs_share_one_fsync_and_a_decision_input_syncs_what_came_before_it(self):
        from balancita_engine import replay_specs as RS
        SC.disarm()
        calls = []
        real_fsync, LE.os.fsync = LE.os.fsync, lambda fd: (calls.append(fd), real_fsync(fd))[1]
        self.addCleanup(setattr, LE.os, "fsync", real_fsync)
        with tempfile.TemporaryDirectory() as root:
            first_decision = T0 + 200 * MIN
            evaluator = LE.LiveEvaluator.create(os.path.join(root, "e.jsonl"), RS.load_frozen()[0], [BTC], decide_from_ms=first_decision)
            created = len(calls)
            candle = {"open": "100", "high": "101", "low": "99", "close": "100", "volume_btc": "1"}
            for k in range(50):                                                       # warm-up: the minute closes before the first decision
                bucket = T0 + k * MIN
                evaluator.feed_candle(BTC, dict(candle, bucket_start=bucket), bucket + MIN + 1)
            self.assertEqual(len(calls), created)                                      # nothing fsynced yet ...
            with open(evaluator.log.path, "rb") as handle:
                self.assertEqual(len(handle.read().splitlines()), 51)                  # ... but every line is already in the file
            evaluator.flush()
            self.assertEqual(len(calls), created + 1)                                  # one fsync for the 50 entries
            evaluator.flush()
            self.assertEqual(len(calls), created + 1)                                  # nothing waiting: no second one
            for k in range(50, 199):
                evaluator.feed_candle(BTC, dict(candle, bucket_start=T0 + k * MIN), T0 + k * MIN + MIN + 1)
            self.assertEqual(len(calls), created + 1)
            evaluator.feed_candle(BTC, dict(candle, bucket_start=T0 + 199 * MIN), T0 + 200 * MIN + 1)     # closes at the first decision: durable on its own
            self.assertEqual(len(calls), created + 2)                                  # and it carried the 149 warm-up lines before it
            evaluator.feed_candle(BTC, dict(candle, bucket_start=T0 + 200 * MIN), T0 + 201 * MIN + 1)
            self.assertEqual(len(calls), created + 3)                                  # from here one fsync per entry
            self.assertEqual(LE.InputLog.open(evaluator.log.path).head, evaluator.log.head)


class TestRunnerJournalSync(WarmupHelpers, Base):
    """The runner's journal on the same terms as the evaluator's log: warm-up events (before the first decision, no order, no position) share
    one fsync; from the first decision on there is one per entry; a crash in the middle of a warm-up batch recovers the same journal."""

    JOURNAL = os.path.join(LI.RUNNER_DIR, "journal.jsonl")

    def journal_path(self, directory):
        from balancita_engine.paper_runner_store import JOURNAL_FILE
        return os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE)

    def fsyncs(self):
        from balancita_engine import paper_runner_store as RS
        calls = []
        real = RS.os.fsync
        RS.os.fsync = lambda fd: (calls.append(fd), real(fd))[1]
        self.addCleanup(setattr, RS.os, "fsync", real)
        return calls

    def test_warmup_entries_share_one_fsync_and_a_decision_entry_syncs_what_came_before_it(self):
        from balancita_engine import paper_runner_store as RS
        with tempfile.TemporaryDirectory() as root:
            calls = self.fsyncs()
            journal = RS.FileRunnerJournal.create(os.path.join(root, "j.jsonl"))
            for k in range(50):
                journal.add(T0 + k, "event_accepted", {"n": k}, durable=False)
            self.assertEqual(len(calls), 0)
            with open(journal.path, "rb") as handle:
                self.assertEqual(len(handle.read().splitlines()), 50)                  # every line is already in the file
            journal.sync()
            self.assertEqual(len(calls), 1)
            journal.sync()
            self.assertEqual(len(calls), 1)                                            # nothing waiting
            for k in range(50, 80):
                journal.add(T0 + k, "event_accepted", {"n": k}, durable=False)
            journal.add(T0 + 80, "event_accepted", {"n": 80})                          # a durable entry carries the 30 before it
            self.assertEqual(len(calls), 2)
            journal.add(T0 + 81, "event_accepted", {"n": 81})
            self.assertEqual(len(calls), 3)                                            # durable by default: one fsync per entry
            self.assertEqual(RS.FileRunnerJournal.load(journal.path).head, journal.head)

    def test_a_session_syncs_the_runner_journal_once_in_the_warmup_and_per_entry_from_the_first_decision(self):
        world = session_world(self)
        session = new_session(world, os.path.join(self.root, "s"), strategies(self.buckets))
        self.addCleanup(abandon, session)
        calls = self.fsyncs()
        journal = session.runner.journal
        added, durable_adds = [], []
        original = journal.add

        def spy(t_ms, kind, data, durable=True):
            added.append((t_ms, kind))
            durable_adds.append(durable)
            return original(t_ms, kind, data, durable=durable)
        journal.add = spy
        for _ in range(300):
            if not session.step(DECIDE_FROM - MIN)["more_to_read"]:
                break
        warm = [(t, k) for (t, k) in added]
        self.assertGreater(len(warm), 100)
        self.assertTrue(all(t < DECIDE_FROM for t, _ in warm))
        self.assertFalse(any(durable_adds))                                            # no entry waited for its own fsync
        # the runner's fsyncs: checkpoint writes (tmp + dir, two sessions' files) plus one per step for the journal, never one per entry
        self.assertLess(len(calls), len(warm) // 4)
        before = len(calls)
        count = len(added)
        world.release_until(DECIDE_FROM + 2 * STEP)
        session.step(DECIDE_FROM + 2 * STEP)
        late = added[count:]
        self.assertTrue(any(t >= DECIDE_FROM for t, _ in late))
        flags = durable_adds[count:]
        self.assertTrue(all(flag for (t, _), flag in zip(late, flags) if t >= DECIDE_FROM))   # from the first decision, durable again
        self.assertGreaterEqual(len(calls) - before, sum(1 for (t, _), f in zip(late, flags) if f))

    def test_deferring_the_warmup_journal_changes_no_financial_result_and_no_journal_byte(self):
        out = {}
        for name, defer in (("deferred", True), ("per_entry", False)):
            world = session_world(self)
            session = new_session(world, os.path.join(self.root, name), strategies(self.buckets))
            self.addCleanup(abandon, session)
            if not defer:
                session.runner.defer_before_ms = None
            records = []
            for index in range(STEPS):
                now = DECIDE_FROM + index * STEP
                world.release_until(now)
                session.step(now)
                records.append(record(session, now))
            out[name] = (records, session.digests(), session.runner.journal.head, session.runner.journal.entries[-1]["seq"])
            with open(self.journal_path(session.directory), "rb") as handle:
                out[name] += (handle.read(),)
        self.assertEqual(out["deferred"], out["per_entry"])
        self.assertTrue(out["deferred"][0][-1]["accounting_orders"] or out["deferred"][1]["orders"])        # the comparison holds an order

    def test_no_entry_is_deferred_while_an_order_is_pending_or_a_position_is_open(self):
        world = session_world(self)
        session = new_session(world, os.path.join(self.root, "s"), strategies(self.buckets))
        self.addCleanup(abandon, session)
        runner = session.runner
        self.assertTrue(runner._deferrable(DECIDE_FROM - 1, "event_accepted"))
        self.assertFalse(runner._deferrable(DECIDE_FROM, "event_accepted"))            # decide_from itself is not warm-up
        self.assertFalse(runner._deferrable(DECIDE_FROM - 1, "decision"))              # only event entries
        runner.executor.pending["x"] = {}
        self.assertFalse(runner._deferrable(DECIDE_FROM - 1, "event_accepted"))
        del runner.executor.pending["x"]
        runner.portfolio.positions["P"] = object()
        self.assertFalse(runner._deferrable(DECIDE_FROM - 1, "event_rejected"))
        del runner.portfolio.positions["P"]

    def crash(self, world, cut):
        """The process dies at the 150th event of the warm-up, after some steps and checkpoints. ``cut`` bytes are then taken off the end of the
        runner journal (a power cut that lost the last deferred bytes); ``cut`` may take whole lines."""
        directory = os.path.join(self.root, "crashed")
        session = new_session(world, directory, strategies(self.buckets))
        seen = {"n": 0}

        def fault(name, info=None):
            if name == "before_handle":
                seen["n"] += 1
                if seen["n"] == 150:
                    raise LI.FaultInjected(name)
        session.fault = fault
        with self.assertRaises(LI.FaultInjected):
            for _ in range(300):
                session.step(DECIDE_FROM)
        abandon(session)
        path = self.journal_path(directory)
        with open(path, "rb") as handle:
            data = handle.read()
        if cut:
            with open(path, "wb") as handle:
                handle.write(data[:-cut])
        return directory, len(data.splitlines())

    def check_recovery(self, cut):
        from balancita_engine.paper_runner_store import FileRunnerJournal
        reference = self.continuous()
        world = session_world(self)
        directory, written = self.crash(world, cut)
        kept = FileRunnerJournal.load(self.journal_path(directory))
        self.assertLessEqual(len(kept.entries), written)
        self.assertEqual([e["hash"] for e in kept.entries], [e["hash"] for e in reference.runner.journal.entries[:len(kept.entries)]])
        kept_clock = max(e["t_ms"] for e in kept.entries if e["kind"] == "event_accepted")
        revived = recover_session(world, directory, strategies(self.buckets), kept_clock)     # restart at the last event the journal kept
        self.addCleanup(abandon, revived)
        self.drain(revived, world)
        events = [e["data"]["event"]["event_id"] for e in revived.runner.journal.entries if e["kind"] == "event_accepted"]
        wanted = [e["data"]["event"]["event_id"] for e in reference.runner.journal.entries if e["kind"] == "event_accepted"]
        self.assertEqual(len(events), len(set(events)))                                # none twice
        self.assertEqual(sorted(events), sorted(wanted))                               # none lost
        now = DECIDE_FROM + 3 * STEP
        self.assertEqual(record(revived, now), record(reference, now))
        with open(self.journal_path(directory), "rb") as handle:
            self.assertEqual(len(handle.read().splitlines()), len(revived.runner.journal.entries))   # the file holds exactly the entries in memory
        from balancita_engine.paper_runner import RunnerJournal
        self.assertIsNone(RunnerJournal.verify(revived.runner.journal.entries))

    def test_a_crash_in_the_middle_of_a_warmup_batch_recovers_the_same_journal(self):
        self.check_recovery(0)

    def test_a_crash_that_cut_the_last_line_of_the_batch_recovers_the_same_journal(self):
        self.check_recovery(25)

    def test_a_crash_that_lost_whole_deferred_lines_recovers_without_loss_or_repeats(self):
        self.check_recovery(1)                  # the last newline is gone: a torn last line
        self.root = tempfile.mkdtemp(dir=self.root)
        self.check_recovery(6000)               # several whole lines of the deferred batch are gone: the replay brings them back


class TestReaderBounds(unittest.TestCase):
    def test_the_bounds_filter_and_the_seed_is_the_rowid_below_the_first_row_at_or_after_them(self):
        with tempfile.TemporaryDirectory() as root:
            src = Source(os.path.join(root, "m.sqlite"))
            for t in range(0, 600_000, 10_000):
                src.ticker(BTC, t, 100)
                src.ticker(ETH, t, 10)
            for k in range(10):
                src.candle(BTC, k * MIN, 1, 2, 1, 1)
                src.candle(ETH, k * MIN, 1, 2, 1, 1)
            src.gap(BTC, 100_000)
            src.gap(BTC, 500_000)
            src.close()
            reader = ING.SourceReader(os.path.join(root, "m.sqlite"))
            self.assertEqual(len(reader.tickers(0, 10_000)), 120)
            self.assertEqual({r["persisted_at"] >= 300_000 for r in reader.tickers(0, 10_000, 300_000)}, {True})
            self.assertEqual(len(reader.tickers(0, 10_000, 300_000)), 60)
            self.assertEqual([r["bucket_start"] for r in reader.candles(0, 100, 8 * MIN) if r["product_id"] == BTC], [8 * MIN, 9 * MIN])
            self.assertEqual([r["detected_at"] for r in reader.gaps(0, 10, 300_000)], [500_000])
            self.assertEqual(len(reader.gaps(0, 10)), 2)
            seeded = reader.seed_cursors((BTC,), 300_000, 8 * MIN)
            first_btc = reader.db.execute("SELECT MIN(rowid) FROM paper_futures_market_events WHERE product_id=? AND received_at>=300000", (BTC,)).fetchone()[0]
            self.assertEqual(seeded["ticker"], first_btc - 1)
            self.assertEqual(seeded["candle"], reader.db.execute(
                "SELECT MIN(rowid) FROM paper_futures_official_candles WHERE product_id=? AND bucket_start>=?", (BTC, 8 * MIN)).fetchone()[0] - 1)
            self.assertEqual(reader.seed_cursors((BTC,), None, None), {"ticker": None, "candle": None})
            late = reader.seed_cursors((BTC,), 10 ** 12, 10 ** 12)       # nothing that late exists yet (a start before the first quotes): the end of the table, not 0
            top = reader.max_rowids()
            self.assertEqual(late, {"ticker": top["ticker"], "candle": top["candle"]})
            self.assertEqual(reader.seed_cursors((), 300_000, None)["ticker"], None)                                   # no product, no index to ask
            reader.close()


if __name__ == "__main__":
    unittest.main()
