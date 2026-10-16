"""Issues #186 and #187: the blocks file published by the Supervisor when the process dies or the clock misbehaves, seen from the files.
Invented data, simulated clock, nothing real. What is asserted is what the process leaves today: a derived file that never says the session is
alive, a leftover temporary file that is not mistaken for the document, a restart that publishes its own run mark, and a clock jump that ends
in a halted file. No limit of age is created or assumed: the file carries no age."""

import hashlib
import os
import unittest

from balancita_engine import paper_live_process as LP
from test_paper_live_clock_185 import GUARD, Scripted
from test_paper_live_integration import TIMES
from test_paper_live_process_185 import START, Base, Clock

STEPS = 6


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


class TestBlocksWhenTheProcessDies(Base):
    def killed(self, steps=STEPS):
        clock = Clock()
        first = self.supervisor(clock, publish_blocks=True)
        first.start()
        for _ in range(steps):
            now = clock.now()
            first.tick(now)
            state = first.session.step(now)
            first.phase = LP.phase_of(first.session)
            first._beat(now, state)                                                           # what run() does: heartbeat, then the blocks file
            clock.sleep(0)
        first.abandon()
        return first, clock

    def blocks(self):
        return self.read(LP.BLOCKS_FILE)

    def test_a_killed_process_leaves_a_file_of_its_run_that_never_says_it_is_alive(self):
        first, _ = self.killed()
        doc = self.blocks()
        self.assertEqual(doc["run"], {"pid": os.getpid(), "id": first.run_id})
        self.assertTrue(doc["derived"])
        self.assertEqual(doc["authority"], "none")
        self.assertEqual((doc["status"]["phase"], doc["status"]["liveness"]), ("LIVE", "unknown"))   # the last thing it said, with no claim of life
        self.assertEqual(doc["positions"]["verification"]["freshness"], "unknown")
        self.assertFalse(doc["positions"]["verification"]["verified"])

    def test_a_temporary_file_left_by_a_write_that_died_is_not_the_document_and_the_next_publication_replaces_it(self):
        first, clock = self.killed()
        path = os.path.join(self.directory, LP.BLOCKS_FILE)
        before = sha(path)
        with open(path + ".tmp", "w", encoding="utf-8") as handle:
            handle.write('{"schema": "half')                                                  # the write died before os.replace
        self.assertEqual(sha(path), before)                                                   # the document itself is untouched
        self.assertEqual(self.blocks()["run"]["id"], first.run_id)
        second = self.supervisor(Clock(STEPS - 1), publish_blocks=True)
        second.start(restart=True)
        second.run(max_steps=3)
        doc = self.blocks()                                                                    # parses: the leftover did not get into it
        self.assertEqual(doc["run"]["id"], second.run_id)
        self.assertFalse(os.path.exists(path + ".tmp"))

    def test_the_operator_restart_publishes_its_own_run_mark_and_the_old_one_is_gone(self):
        first, _ = self.killed()
        old = self.blocks()
        second = self.supervisor(Clock(STEPS - 1), publish_blocks=True)
        second.start(restart=True)
        second.run(max_steps=3)
        doc = self.blocks()
        self.assertNotEqual(second.run_id, first.run_id)
        self.assertEqual(doc["run"]["id"], second.run_id)
        self.assertNotEqual(doc["run"], old["run"])
        self.assertEqual((doc["session_id"], doc["config_digest"]), (old["session_id"], old["config_digest"]))
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["run_id"], second.run_id)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["publication"]["failures"], 0)

    def test_an_unattended_start_after_the_kill_is_refused_and_leaves_the_file_as_it_was(self):
        self.killed()
        path = os.path.join(self.directory, LP.BLOCKS_FILE)
        before = sha(path)
        again = self.supervisor(Clock(STEPS - 1), publish_blocks=True)
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        self.assertEqual(sha(path), before)


class TestBlocksWhenTheClockJumps(Base):
    def go(self, instants, name):
        clock = Scripted(instants)
        self.directory = os.path.join(self.root, name)
        supervisor = self.supervisor(clock, clock_guard=GUARD, publish_blocks=True)
        supervisor.wall_time = lambda: 123
        supervisor.start()
        return supervisor, supervisor.run(max_steps=20)

    def test_a_jump_ends_in_a_halted_file_with_the_reason_and_never_in_an_alive_one(self):
        t = TIMES[START]
        supervisor, code = self.go([t, t + 60_000, t + 60_000 + GUARD["max_forward_jump_ms"] + 1], "jump")
        self.assertEqual(code, LP.EXIT_HALTED)
        doc = self.read(LP.BLOCKS_FILE)
        self.assertEqual(doc["run"]["id"], supervisor.run_id)
        self.assertEqual(doc["status"]["phase"], "HALTED")
        self.assertIn("clock_jump", doc["status"]["halt_reason"])
        self.assertNotEqual(doc["status"]["liveness"], "alive")
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.HALTED)

    def test_a_regression_ends_the_same_way_and_a_restart_needs_the_operator_without_touching_the_file(self):
        t = [TIMES[START + i] for i in range(4)]
        supervisor, code = self.go([t[0], t[1], t[2], t[1], t[3]], "back")
        self.assertEqual(code, LP.EXIT_HALTED)
        doc = self.read(LP.BLOCKS_FILE)
        self.assertIn("clock_regression", doc["status"]["halt_reason"])
        self.assertEqual(doc["status"]["phase"], "HALTED")
        path = os.path.join(self.directory, LP.BLOCKS_FILE)
        before = sha(path)
        again = self.supervisor(Scripted([t[3]]), clock_guard=GUARD, publish_blocks=True)
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        self.assertEqual(sha(path), before)


if __name__ == "__main__":
    unittest.main()
