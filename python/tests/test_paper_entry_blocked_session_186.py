"""Issue #186, criterion C8 seen from the SESSION: an entry whose product has no quote, or whose last quote is older than the session's
``max_quote_gap_ms``, is blocked when it is decided (``entry_blocked_source_stale``, no order is created). The runner side is
``test_paper_entry_blocked_186``; here the session wires its own limit into the runner, the block is durable across a recovery, and
a configuration that disagrees is refused. The limit is the session's explicit parameter (an unapproved hypothesis), never a default
of the runner. Invented data only."""

import os
import shutil
import tempfile
import unittest
from dataclasses import replace

from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from live_world import LOAD_START, World
from test_paper_live_integration import (BTC, FIRST_DECISION, INGEST_KW, LAST_DECISION, MAX_QUOTE_GAP_MS, TIMES, ENTRY_STEP, abandon,
                                         journal_clock, record, recover_session, runner_config)

DECISION_MS = 1763254200000                                  # the candle close at which the first BTC entry is decided
HOLE = (DECISION_MS - 100_000, DECISION_MS + 30_000)         # no BTC quote for 130 s around it: the last one is older than the limit
LAST_STEP = ENTRY_STEP + 1


def block_reasons(session):
    return [o["reasons"] for o in session.runner.orders()]


class TestEntryBlockedInTheSession(unittest.TestCase):
    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"], _ = RS.load_frozen()
        for block in (True, False):
            where = os.path.join(root, "w-{}".format(block))
            os.makedirs(where)
            world = World(where, quote_holes=[HOLE])
            world.release_until(LOAD_START)
            session = LI.LiveSession.create(os.path.join(where, "s"), world.path, cls.cache["strategies"], (BTC,), runner_config(),
                                            decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                            max_quote_gap_ms=MAX_QUOTE_GAP_MS, block_stale_entries=block)
            records = []
            snap = None
            for index, now in enumerate(TIMES[:LAST_STEP + 1]):
                if index == ENTRY_STEP - 1:
                    snap = os.path.join(where, "snap")
                    shutil.copytree(session.directory, snap)
                    cls.cache.setdefault("worlds", {})[block] = world.snapshot(where)
                world.release_until(now)
                session.step(now)
                records.append(record(session, now))
            cls.cache[block] = {"session": session, "world": world, "records": records, "snap": snap, "where": where}

    @classmethod
    def tearDownClass(cls):
        for block in (True, False):
            if block in cls.cache:
                abandon(cls.cache[block]["session"])
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def test_the_entry_decided_with_an_old_last_quote_is_rejected_and_no_order_is_created(self):
        session = self.cache[True]["session"]
        first = session.runner.orders()[0]
        self.assertEqual((first["state"], first["reasons"]), ("rejected", ["entry_blocked_source_stale"]))
        kinds = [e["kind"] for e in session.runner.journal.entries]
        self.assertNotIn("source_loss", kinds)                             # nothing was pending, so nothing had to be cancelled
        self.assertEqual([e for e in session.runner.journal.entries if e["kind"] == "order_cancelled"], [])

    def test_without_the_block_the_same_entry_waits_and_the_loss_cancels_it(self):
        session = self.cache[False]["session"]
        first = session.runner.orders()[0]
        self.assertEqual((first["state"], first["reasons"]), ("cancelled", ["source_stale"]))      # the earlier, later behaviour

    def test_the_session_hands_its_own_limit_to_the_runner(self):
        self.assertEqual(self.cache[True]["session"].runner.config.entry_max_quote_age_ms, MAX_QUOTE_GAP_MS)
        self.assertIsNone(self.cache[False]["session"].runner.config.entry_max_quote_age_ms)

    def test_a_recovery_before_the_decision_blocks_the_entry_exactly_as_the_continuous_run(self):
        cached = self.cache[True]
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = cached["world"].fork(root, self.cache["worlds"][True])
        directory = os.path.join(root, "s")
        shutil.copytree(cached["snap"], directory)
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC,))
        self.addCleanup(abandon, session)
        for index in range(ENTRY_STEP - 1, LAST_STEP + 1):
            world.release_until(TIMES[index])
            session.step(TIMES[index])
            self.assertEqual(record(session, TIMES[index]), cached["records"][index], "step {} differs".format(index))
        self.assertEqual(session.runner.orders()[0]["reasons"], ["entry_blocked_source_stale"])

    def test_a_configuration_with_another_limit_is_refused(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = World(root, quote_holes=[HOLE])
        world.release_until(LOAD_START)
        other = replace(runner_config(), entry_max_quote_age_ms=MAX_QUOTE_GAP_MS + 1)
        with self.assertRaises(LI.IntegrationError) as bad:
            LI.LiveSession.create(os.path.join(root, "s"), world.path, self.cache["strategies"], (BTC,), other,
                                  decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                  max_quote_gap_ms=MAX_QUOTE_GAP_MS)
        self.assertEqual(bad.exception.reason, "config_incompatible")
        self.assertFalse(os.path.exists(os.path.join(root, "s")))          # refused before anything was written
        world.close()


if __name__ == "__main__":
    unittest.main()
