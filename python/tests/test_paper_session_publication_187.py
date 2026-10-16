"""Issue #187 (BAL-DECISION-187-05, option A): the Supervisor publishes the derived blocks file. Invented data and a simulated clock only:
nothing here is a real session, a real capture or a real clock, and it proves the chain works, not that any result is valid."""

import hashlib
import json
import os
import time
import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine import paper_live_publish as PUB

import session_e2e_187 as E2E
import test_paper_live_process_185 as P185
from test_paper_live_integration import TIMES


def hash_tree(directory, skip=()):
    """Every file of the session directory but the ones named: the bytes the session itself wrote."""
    out = {}
    for root, _dirs, names in os.walk(directory):
        for name in sorted(names):
            if name in skip or name.endswith(".tmp"):
                continue
            path = os.path.join(root, name)
            with open(path, "rb") as handle:
                out[os.path.relpath(path, directory)] = hashlib.sha256(handle.read()).hexdigest()
    return out


class TestConfiguration(unittest.TestCase):
    def test_publishing_is_opt_in_and_does_not_change_the_identity_of_a_session_that_does_not_use_it(self):
        plain = LP.validate_config(P185.config_dict())
        self.assertNotIn("publish_blocks", plain)
        on = LP.validate_config(P185.config_dict(publish_blocks=True))
        self.assertTrue(on["publish_blocks"])
        self.assertNotEqual(plain["digest"], on["digest"])             # another configuration, another session identity
        for bad in (False, "yes", 1, None, {}):
            with self.assertRaises(LP.ProcessError, msg=repr(bad)):
                LP.validate_config(P185.config_dict(publish_blocks=bad))


class Rig(P185.Base):
    def run_session(self, max_steps, **over):
        supervisor = self.supervisor(P185.Clock(), **over)
        supervisor.start()
        code = supervisor.run(max_steps=max_steps)
        return supervisor, code

    def blocks(self):
        return self.read(LP.BLOCKS_FILE)


class TestPublication(Rig):
    def test_off_by_default_no_file_and_no_publication_in_the_heartbeat(self):
        self.run_session(3)
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.BLOCKS_FILE)))
        self.assertNotIn("publication", self.read(LP.HEARTBEAT_FILE))

    def test_operation_the_file_carries_the_run_and_matches_the_heartbeat_that_reports_it(self):
        supervisor, code = self.run_session(len(TIMES) // 2, publish_blocks=True)
        self.assertEqual(code, LP.EXIT_OK)
        beat, doc = self.read(LP.HEARTBEAT_FILE), self.blocks()
        self.assertEqual((doc["session_id"], doc["config_digest"], doc["run"]), (beat["session_id"], beat["config_digest"], {"pid": os.getpid(), "id": supervisor.run_id}))
        self.assertEqual(beat["run_id"], supervisor.run_id)
        self.assertEqual((doc["schema"], doc["derived"], doc["authority"]), (PUB.BLOCKS_SCHEMA, True, "none"))
        self.assertEqual(beat["publication"], {"attempts": doc["attempt"], "failures": 0, "last_error": None, "last_ok_observed_now_ms": beat["observed_now_ms"]})
        self.assertGreaterEqual(doc["attempt"], 1)
        self.assertEqual(doc["status"]["phase"], "STOPPED")                  # the last file is the orderly stop, after the report
        self.assertEqual(doc["status"]["liveness"], "final")

    def test_while_running_the_file_is_never_alive_or_fresh_and_has_no_age(self):
        seen = []
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        original = supervisor._beat

        def spy(now, state):
            original(now, state)
            if supervisor.phase == LP.LIVE:
                seen.append(self.blocks())
        supervisor._beat = spy
        supervisor.run(max_steps=4)
        self.assertTrue(seen)
        for doc in seen:
            self.assertEqual(doc["status"]["phase"], "LIVE")
            self.assertEqual(doc["status"]["liveness"], "unknown")
            self.assertEqual(doc["positions"]["verification"]["freshness"], "unknown")
            self.assertFalse(doc["positions"]["verification"]["verified"])

    def test_a_halt_leaves_a_halted_file_with_the_reason(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        supervisor._halt(supervisor.clock(), "invented halt")
        doc = self.blocks()
        self.assertEqual((doc["status"]["phase"], doc["status"]["halt_reason"]), ("HALTED", "invented halt"))
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["publication"]["failures"], 0)

    def test_the_evaluator_runs_before_its_step_is_published_and_never_waits_for_a_publication(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        order = []
        step, publish = supervisor.session.step, supervisor._publish
        supervisor.session.step = lambda now: (order.append("step"), step(now))[1]
        supervisor._publish = lambda beat, state: (order.append("publish"), publish(beat, state))[1]
        supervisor.run(max_steps=4)
        loop = order[:order.index("publish") + 1]
        self.assertEqual(loop, ["step", "publish"])                             # each publication follows the step it reports
        steps = [i for i, event in enumerate(order) if event == "step"]
        for before, after in zip(steps, steps[1:]):
            self.assertIn("publish", order[before:after])                       # one publication per step, between two steps

    def test_the_session_bytes_are_the_same_with_and_without_publication(self):
        skip = (LP.HEARTBEAT_FILE, LP.REPORT_FILE, LP.CONFIG_FILE, LP.BLOCKS_FILE)
        self.run_session(len(TIMES) // 2)
        plain = hash_tree(self.directory, skip=skip)
        os.makedirs(os.path.join(self.root, "other"))
        other = P185.World(os.path.join(self.root, "other"))
        try:
            other.release_until(P185.FIRST_DECISION - P185.MIN)
            directory = os.path.join(self.root, "published")
            supervisor = self.supervisor(P185.Clock(), world=other, directory=directory, publish_blocks=True)
            supervisor.start()
            supervisor.run(max_steps=len(TIMES) // 2)
            published = hash_tree(directory, skip=skip)
            self.assertTrue(os.path.exists(os.path.join(directory, LP.BLOCKS_FILE)))
        finally:
            other.close()
        self.assertTrue(plain)
        self.assertEqual(plain, published)


class TestFailure(Rig):
    def failing(self, supervisor, error, fail):
        """Makes the n-th publication attempts in ``fail`` raise ``error``; records the phase and the file around each failure and every heartbeat."""
        seen = {"n": 0, "phases": [], "files": [], "beats": []}
        original, path = supervisor._write_blocks, os.path.join(self.directory, LP.BLOCKS_FILE)

        def write(target, body):
            seen["n"] += 1
            if seen["n"] in fail:
                seen["phases"].append(supervisor.phase)
                with open(path, "rb") as handle:
                    seen["files"].append(handle.read())
                raise error
            original(target, body)
        supervisor._write_blocks = write
        beat = supervisor._beat

        def spy(now, state):
            beat(now, state)
            seen["beats"].append(self.read(LP.HEARTBEAT_FILE))
        supervisor._beat = spy
        return seen

    def test_a_write_failure_does_not_stop_the_session_leaves_the_old_file_and_is_reported(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        seen = self.failing(supervisor, OSError(28, "No space left on device: '/secret/abs/path/session-blocks.json'"), {3, 4, 5})
        self.assertEqual(supervisor.run(max_steps=6), LP.EXIT_OK)             # three failed publications, still an orderly stop
        self.assertEqual(seen["phases"], [LP.LIVE] * 3)                       # failed while the session was running: not a halt
        self.assertEqual(len(set(seen["files"])), 1)                          # the old file stayed the same through all three
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(beat["publication"]["failures"], 3)
        self.assertEqual(beat["publication"]["last_error"], {"type": "OSError", "text": "ENOSPC"})
        self.assertNotIn("/secret", json.dumps(beat))
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))
        self.assertEqual(self.read(LP.REPORT_FILE)["ended_as"], LP.STOPPED_PHASE)

    def test_a_failure_that_is_not_an_oserror_is_also_swallowed_and_reported(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        original = PUB.session_blocks

        def boom(*args, **kwargs):
            raise ValueError("invented failure while building")
        PUB.session_blocks = boom
        try:
            self.assertEqual(supervisor.run(max_steps=3), LP.EXIT_OK)
        finally:
            PUB.session_blocks = original
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertGreaterEqual(beat["publication"]["failures"], 3)
        self.assertEqual(beat["publication"]["last_error"], {"type": "ValueError", "text": "invented failure while building"})

    def test_publication_describes_this_attempt_and_recovers_when_the_failure_ends(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        seen = self.failing(supervisor, OSError(5, "Input/output error"), {3})
        supervisor.run(max_steps=4)
        by_publication = [b["publication"] for b in seen["beats"]]
        failed = [p for p in by_publication if p["failures"] == 1][0]
        self.assertEqual(failed["last_error"]["text"], "EIO")                 # the heartbeat of the failed step already says so
        self.assertNotEqual(failed["last_ok_observed_now_ms"], seen["beats"][by_publication.index(failed)]["observed_now_ms"])
        last = by_publication[-1]
        self.assertEqual(last["failures"], 1)                                 # counted, not retried, not capped
        self.assertEqual(last["last_ok_observed_now_ms"], seen["beats"][-1]["observed_now_ms"])

    def test_a_heartbeat_failure_still_halts_the_session(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        original = LP._write_json

        def write(path, body):
            if os.path.basename(path) == LP.HEARTBEAT_FILE and body.get("phase") == LP.LIVE:
                raise OSError(28, "No space left on device")
            original(path, body)
        LP._write_json = write
        try:
            code = supervisor.run(max_steps=len(TIMES) // 2)
        finally:
            LP._write_json = original
        self.assertEqual(code, LP.EXIT_HALTED)
        self.assertIn("heartbeat", self.read(LP.HALT_FILE)["reason"])


class TestFilesForTheServer(unittest.TestCase):
    def test_the_committed_files_are_what_a_real_supervisor_leaves(self):
        with open(E2E.TARGET, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), E2E.dumps(E2E.build()), "run: python3 python/tests/session_e2e_187.py")

    def test_the_pair_belongs_to_one_run_and_the_running_one_is_not_alive(self):
        files = E2E.build()
        for name in ("operating", "stopped"):
            beat, doc = files[name]["heartbeat"], files[name]["blocks"]
            self.assertEqual((doc["session_id"], doc["config_digest"], doc["run"]),
                             (beat["session_id"], beat["config_digest"], {"pid": E2E.RUN_PID, "id": E2E.RUN_ID}), name)
        self.assertEqual(files["operating"]["blocks"]["status"]["phase"], "LIVE")
        self.assertEqual(files["operating"]["blocks"]["status"]["liveness"], "unknown")
        self.assertEqual(files["stopped"]["blocks"]["status"]["phase"], "STOPPED")


class TestOperatorRestartFromRealSupervisors(unittest.TestCase):
    def test_a_restart_with_the_same_pid_session_and_configuration_is_told_apart_only_by_the_run_mark(self):
        files = E2E.build()
        failed, published = files["restart_publication_failed"], files["restart_published"]
        for name, pair in (("failed", failed), ("published", published)):
            self.assertEqual(pair["heartbeat"]["pid"], pair["blocks"]["run"]["pid"], name)
            self.assertEqual(pair["heartbeat"]["session_id"], pair["blocks"]["session_id"], name)
            self.assertEqual(pair["heartbeat"]["config_digest"], pair["blocks"]["config_digest"], name)
        self.assertEqual(published["heartbeat"]["run_id"], published["blocks"]["run"]["id"])
        self.assertNotEqual(failed["heartbeat"]["run_id"], failed["blocks"]["run"]["id"])
        self.assertEqual(failed["heartbeat"]["publication"]["failures"], 1)
        self.assertEqual(failed["heartbeat"]["publication"]["last_error"], {"type": "OSError", "text": "ENOSPC"})
        self.assertIsNone(failed["heartbeat"]["publication"]["last_ok_observed_now_ms"])
        self.assertEqual(published["heartbeat"]["publication"]["failures"], 0)


class TestRestartAndCost(Rig):
    def test_every_start_has_its_own_run_mark_so_an_old_file_never_matches_a_new_run(self):
        first, _ = self.run_session(3, publish_blocks=True)
        old = self.blocks()
        first.abandon()
        # same session directory and same pid (a container), another start: the mark differs, the reader refuses the old file
        second = LP.Supervisor(first.config, self.directory, first.source_path, clock=P185.Clock().now)
        self.assertNotEqual(second.run_id, old["run"]["id"])
        self.assertEqual(old["run"]["pid"], os.getpid())

    def test_the_cost_of_publishing_is_measured_with_synthetic_data_over_a_whole_session(self):
        supervisor = self.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        costs = []
        original = supervisor._publish

        def timed(beat, state):
            started = time.perf_counter()
            original(beat, state)
            costs.append(((time.perf_counter() - started) * 1000, os.path.getsize(os.path.join(self.directory, LP.BLOCKS_FILE))))
        supervisor._publish = timed
        self.assertEqual(supervisor.run(max_steps=len(TIMES) // 2), LP.EXIT_OK)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["publication"]["failures"], 0)
        ms = [c[0] for c in costs]
        print("\n[187-05 cost, synthetic] {} publications; first {:.1f} ms / {} bytes; last {:.1f} ms / {} bytes; max {:.1f} ms; mean {:.1f} ms".format(
            len(costs), costs[0][0], costs[0][1], costs[-1][0], costs[-1][1], max(ms), sum(ms) / len(ms)))
        self.assertGreater(costs[-1][1], costs[0][1])                     # the document grows with the intervals of the session


if __name__ == "__main__":
    unittest.main()
