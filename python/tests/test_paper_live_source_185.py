"""Issue #185: the source file of a paper session. Its identity is the file (device and inode), and nothing that arrives after the clock
enters a decision, even when the source already holds it. The market is the real one."""

import os
import shutil
import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine.paper_live_ingest import Ingestor, SourceReader
from real_session import DECIDE_FROM, DECIDE_UNTIL as LAST_DECISION, INGEST_KW, Base, Clock, config_dict
from real_world import BTC, MIN


class TestSourceIdentity(Base):
    def test_the_identity_is_device_and_inode_of_a_regular_file(self):
        self.assertEqual(LP.file_identity(self.world.path), (os.stat(self.world.path).st_dev, os.stat(self.world.path).st_ino))
        with self.assertRaises(OSError):
            LP.file_identity(self.root)
        with self.assertRaises(OSError):
            LP.file_identity(os.path.join(self.root, "missing.sqlite"))

    def test_a_source_that_keeps_growing_is_the_same_file(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.assertEqual(supervisor.run(max_steps=6), LP.EXIT_OK)         # the world writes rows at every step: size and mtime change

    def test_a_path_that_now_names_another_file_halts_before_the_step(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        original = supervisor.tick

        def tick(now):
            original(now)
            if supervisor.session.stats["steps"] == 3:                     # the capture is swapped under the same name
                other = os.path.join(self.root, "other.sqlite")
                shutil.copyfile(self.world.path, other)
                os.replace(other, self.world.path)
                supervisor.tick = lambda now: None                         # the old writer holds the old inode
        supervisor.tick = tick
        self.assertEqual(supervisor.run(max_steps=10), LP.EXIT_HALTED)
        self.assertIn("source_replaced", self.read(LP.REPORT_FILE)["halted"])
        self.assertEqual(self.read(LP.REPORT_FILE)["steps"], 3)
        self.assertTrue(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))

    def test_a_source_that_disappears_halts(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        original = supervisor.tick

        def tick(now):
            original(now)
            if supervisor.session.stats["steps"] == 2:
                os.rename(self.world.path, self.world.path + ".gone")
                supervisor.tick = lambda now: None
        supervisor.tick = tick
        self.assertEqual(supervisor.run(max_steps=6), LP.EXIT_HALTED)
        self.assertIn("source_unreadable", self.read(LP.REPORT_FILE)["halted"])
        os.rename(self.world.path + ".gone", self.world.path)


class TestCausality(Base):
    def report_of(self, name, preload, causal):
        self.tearDown()
        self.setUp()
        self.directory = os.path.join(self.root, name)
        clock = Clock()
        supervisor = self.supervisor(clock, ingest_kw=dict(INGEST_KW, causal_until_clock=True) if causal else dict(INGEST_KW))
        supervisor.start()
        if preload:
            self.world.release_until(LAST_DECISION)                       # the file already holds every row, arrivals included
            supervisor.tick = lambda now: None
        self.assertEqual(supervisor.run(max_steps=8), LP.EXIT_OK)
        self.ahead = supervisor.session.ingestor.max_seen_ms - clock.now()           # how far past the clock the ingestor has read
        return self.read(LP.REPORT_FILE)["digests"], supervisor.session.ingestor.stats.get("held_after_clock", 0)

    def test_with_the_option_rows_that_arrive_after_the_clock_do_not_change_a_decision(self):
        just_in_time, held_a = self.report_of("jit", False, True)
        in_advance, held_b = self.report_of("advance", True, True)
        self.assertEqual(just_in_time, in_advance)
        self.assertGreater(held_b, 0)                                      # the future was in the file and was held back
        self.assertLessEqual(self.ahead, 0)                                # and nothing past the clock was read

    def test_without_the_option_a_file_that_holds_the_future_is_read_ahead_of_the_clock(self):
        # Documents today's behaviour: the ingestor is source-time driven. This is why a live source needs the option (D-185-R4).
        # With the real density the 40 minutes of the run hold a handful of decisions, so the proof is how far the ingestor read.
        self.report_of("jit-off", False, False)
        self.assertLessEqual(self.ahead, 0)                                # fed as the clock moves, it reads nothing past it
        self.report_of("advance-off", True, False)
        self.assertGreater(self.ahead, 60 * MIN)                           # the file holds the future: it is read hours ahead of the clock

    def test_a_row_received_after_the_clock_is_held_even_if_it_was_persisted_before(self):
        import sqlite3
        self.tearDown()
        self.setUp()
        self.directory = os.path.join(self.root, "received")
        self.world.release_until(DECIDE_FROM)                           # nothing in the file is persisted after the clock
        db = sqlite3.connect(self.world.path)
        # a week later than it was persisted: with the real density (5000 rows are read at a time) only the first batch is checked
        db.execute("UPDATE paper_futures_market_events SET received_at = persisted_at + 604800000 WHERE feed='ticker'")
        db.commit()
        db.close()
        clock = Clock()
        supervisor = self.supervisor(clock, ingest_kw=dict(INGEST_KW, causal_until_clock=True))
        supervisor.start()
        supervisor.tick = lambda now: None
        self.assertEqual(supervisor.run(max_steps=1), LP.EXIT_OK)
        self.assertGreater(supervisor.session.ingestor.stats.get("held_after_clock", 0), 0)     # only the received_at rule can hold these


class TestHeldRows(Base):
    """D-219-01 / D-219-02: what exactly is held, and that a held row is never skipped."""

    @staticmethod
    def drain(ingestor, now):
        """A poll reads one batch: poll again while the source still has rows to read (held rows do not count as backlog)."""
        for _ in range(200):
            ingestor.poll(now)
            if not (ingestor.ticker_more or ingestor.candle_more):
                return
        raise AssertionError("the source never drained")

    def clone_row(self, db, **over):
        db.row_factory = __import__("sqlite3").Row
        row = dict(db.execute("SELECT * FROM paper_futures_market_events WHERE feed='ticker' ORDER BY rowid DESC LIMIT 1").fetchone())
        row.update(over)
        db.execute("INSERT INTO paper_futures_market_events({}) VALUES({})".format(
            ",".join(row), ",".join(":" + k for k in row)), row)
        db.commit()

    def test_a_candle_known_before_it_closes_is_held_until_its_close(self):
        import sqlite3
        self.world.release_until(DECIDE_FROM)
        now = DECIDE_FROM
        db = sqlite3.connect(self.world.path)
        bucket = (now // 60_000) * 60_000                                  # still open at ``now``: it closes after the clock
        db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (BTC, 60_000, bucket, "early", now - 1, "1", "1", "1", "1", "1", "x"))
        db.commit()
        db.close()
        reader = SourceReader(self.world.path)
        ingestor = Ingestor(reader, causal_until_clock=True, expected_products=(BTC,), **INGEST_KW)
        self.drain(ingestor, now)
        self.assertGreater(ingestor.stats.get("held_after_clock", 0), 0)   # known_at is before the clock, the close is not
        reader.close()

    def test_a_held_row_is_not_skipped_when_a_later_row_arrived_earlier(self):
        import sqlite3
        self.world.release_until(DECIDE_FROM)
        now = DECIDE_FROM
        db = sqlite3.connect(self.world.path)
        template = db.execute("SELECT MAX(rowid) FROM paper_futures_market_events").fetchone()[0]
        late = dict(event_id="late-A", content_hash="hash-A", seq=10 ** 7, event_time=now + 600_000, persisted_at=now + 600_000,
                    received_at=now + 600_000)
        early = dict(event_id="early-B", content_hash="hash-B", seq=10 ** 7 + 1, event_time=now - 1_000, persisted_at=now - 1_000,
                     received_at=now - 1_000)
        self.clone_row(db, **late)                                         # lower rowid, arrives after the clock
        self.clone_row(db, **early)                                        # higher rowid, arrived before it
        db.close()
        self.assertGreater(template, 0)
        reader = SourceReader(self.world.path)
        ingestor = Ingestor(reader, causal_until_clock=True, expected_products=(BTC,), **INGEST_KW)
        self.drain(ingestor, now)
        read_then = ingestor.order
        self.drain(ingestor, now + 700_000)                                       # the clock has reached both
        self.assertEqual(ingestor.order, read_then + 2)                   # the held row and the one behind it were both read
        reader.close()


class TestPreflightCausal(Base):
    def checks(self, **over):
        config = LP.validate_config(dict(config_dict(**over)))
        return {c["name"]: c["ok"] for c in LP.preflight(config, os.path.join(self.root, "pf"), self.world.path)["checks"]}

    def test_a_source_that_is_not_the_fixture_needs_the_causal_option(self):
        self.assertFalse(self.checks(source_id="real", ingest_kw=dict(INGEST_KW))["causal_ingest"])
        self.assertTrue(self.checks(source_id="real", ingest_kw=dict(INGEST_KW, causal_until_clock=True))["causal_ingest"])
        self.assertFalse(self.checks(source_id="real", ingest_kw=dict(INGEST_KW, causal_until_clock=True))["real_session_authorized"])   # still refused
        self.assertTrue(self.checks()["causal_ingest"])                                                                              # the fixture


if __name__ == "__main__":
    unittest.main()
