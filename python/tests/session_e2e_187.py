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
    _CACHE["files"] = seen
    return seen


def dumps(files):
    return json.dumps(files, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(TARGET, "w", encoding="utf-8") as out:
        out.write(dumps(build()))
    print("wrote", os.path.normpath(TARGET))
