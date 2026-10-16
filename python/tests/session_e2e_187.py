"""Issue #187 (BAL-DECISION-187-05): the two files a REAL ``Supervisor`` leaves with ``publish_blocks`` on (the derived blocks file and the
heartbeat of the same run) in an invented session on a simulated clock, taken while it runs and after its orderly stop. They are the input of
the server reader test (``server/.../session-blocks-reader.e2e.test.ts``), which proves that what Python writes is what the server reads.
``python3 python/tests/session_e2e_187.py`` rewrites the JSON; ``test_paper_session_publication_187.py`` fails if it is out of date. The pid
and the run id are replaced by invented constants (the real ones change every start). Nothing here reads a database, a capture or a real clock."""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.join(_HERE, "..")]

from balancita_engine import paper_live_process as LP           # noqa: E402

import test_paper_live_process_185 as P185                      # noqa: E402

TARGET = os.path.join(_HERE, "..", "..", "docs", "mission-control", "b3", "sesion-supervisor-sintetica-187.json")
RUN_PID, RUN_ID = 4242, "run-synthetic-0001"
OLD_RUN_ID, NEW_RUN_ID = RUN_ID, "run-synthetic-0002"      # the cut run and the operator restart that follows it
KEEP_INTERVALS = 3
_CACHE = {}


def _pair(case):
    """The blocks file and the heartbeat as the Supervisor left them, the run mark replaced by the invented one."""
    beat, blocks = case.read(LP.HEARTBEAT_FILE), case.read(LP.BLOCKS_FILE)
    beat.update(pid=RUN_PID, run_id=RUN_ID)
    blocks["run"] = {"pid": RUN_PID, "id": RUN_ID}
    kept = blocks["intervals"]["intervals"]
    blocks["intervals"]["intervals"] = kept[:KEEP_INTERVALS]                  # only for the size of the committed file: the real document keeps them all
    return {"heartbeat": beat, "blocks": blocks, "intervals_before_trimming": len(kept)}


def build():
    if "files" in _CACHE:
        return _CACHE["files"]
    P185.TestLifecycle.setUpClass()
    case = P185.TestLifecycle("test_a_stopped_session_is_over")
    case.setUp()
    try:
        supervisor = case.supervisor(P185.Clock(), publish_blocks=True)
        supervisor.start()
        seen = {}
        original = supervisor._beat

        def spy(now, state):
            original(now, state)
            if supervisor.phase == LP.LIVE and "operating" not in seen:
                seen["operating"] = _pair(case)
        supervisor._beat = spy
        assert supervisor.run(max_steps=len(P185.TIMES) // 2) == LP.EXIT_OK
        seen["stopped"] = _pair(case)
    finally:
        case.tearDown()
        P185.TestLifecycle.tearDownClass()
    seen.update(_restarts())
    _CACHE["files"] = seen
    return seen


def _restarts():
    """The operator restart (BAL-DECISION-185-01) of a session that was cut, taken twice: the new start publishes (its pair belongs to the new run),
    or its first publication fails (the heartbeat is the new run's, the blocks file is still the cut run's: same pid, same session, same
    configuration, another start). Both come from real Supervisors on the same directory, not from different scenarios."""
    out = {}
    for name, fail_first in (("restart_published", False), ("restart_publication_failed", True)):
        P185.TestAnyCutNeedsTheOperator.setUpClass()
        case = P185.TestAnyCutNeedsTheOperator("test_the_request_is_on_record_and_the_checks_still_run")
        case.setUp()
        try:
            clock = P185.Clock()
            first = case.supervisor(clock, publish_blocks=True)
            first.start()
            for _ in range(3):
                now = clock.now()
                first.tick(now)
                first.session.step(now)
                first._beat(now, None)
                clock.sleep(0)
            first.abandon()
            second = case.supervisor(clock, publish_blocks=True)
            if fail_first:
                def refuse(path, body):
                    raise OSError(28, "No space left on device")
                second._write_blocks = refuse
            second.start(restart=True)
            beat, blocks = case.read(LP.HEARTBEAT_FILE), case.read(LP.BLOCKS_FILE)
            assert beat["run_id"] == second.run_id and beat["run_id"] != first.run_id
            assert (blocks["run"]["id"] == second.run_id) != fail_first            # the cut run's file survives only when publishing failed
            assert beat["pid"] == blocks["run"]["pid"]                              # the same process id: the pid cannot tell the starts apart
            beat.update(pid=RUN_PID, run_id=NEW_RUN_ID)
            blocks["run"] = {"pid": RUN_PID, "id": OLD_RUN_ID if fail_first else NEW_RUN_ID}
            kept = blocks["intervals"]["intervals"]
            blocks["intervals"]["intervals"] = kept[:KEEP_INTERVALS]
            out[name] = {"heartbeat": beat, "blocks": blocks, "intervals_before_trimming": len(kept)}
            second.abandon()
        finally:
            case.tearDown()
            P185.TestAnyCutNeedsTheOperator.tearDownClass()
    return out


def dumps(files):
    return json.dumps(files, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(TARGET, "w", encoding="utf-8") as out:
        out.write(dumps(build()))
    print("wrote", os.path.normpath(TARGET))
