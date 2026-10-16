"""Issue #187: ``session_status`` blocks built from the files a REAL ``Supervisor`` leaves (heartbeat, halt, report) in sessions run on
invented data with a simulated clock, so the TypeScript decoder is tested against what Python emits. ``python3
python/tests/session_status_blocks_187.py`` rewrites the JSON; ``test_paper_session_blocks_187.py`` fails if it is out of date.
Nothing here reads a database, a capture or a real clock."""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.join(_HERE, "..")]            # so the command above works without PYTHONPATH

from balancita_engine import paper_live_process as LP           # noqa: E402
from balancita_engine import paper_live_publish as PUB          # noqa: E402

import test_paper_live_process_185 as P185                      # noqa: E402

TARGET = os.path.join(_HERE, "..", "..", "docs", "mission-control", "b3", "estado-sesion-publicador-real.json")
HEARTBEAT_AGE_MS = 500
HEARTBEAT_MAX_AGE_MS = 5_000                  # a test value, not an approved threshold
_CACHE = {}


def _lifecycle():
    """Warm-up, live (the first LIVE heartbeat) and an orderly stop of one invented session."""
    P185.TestLifecycle.setUpClass()
    case = P185.TestLifecycle("test_a_stopped_session_is_over")
    case.setUp()
    try:
        supervisor = case.supervisor(P185.Clock())
        supervisor.start()
        warming = case.read(LP.HEARTBEAT_FILE)
        seen = {}
        original = supervisor._beat

        def spy(now, state):
            original(now, state)
            if supervisor.phase == LP.LIVE and "live" not in seen:
                seen["live"] = case.read(LP.HEARTBEAT_FILE)
        supervisor._beat = spy
        assert supervisor.run(max_steps=len(P185.TIMES) // 2) == LP.EXIT_OK
        return warming, seen["live"], case.read(LP.HEARTBEAT_FILE), case.read(LP.REPORT_FILE)
    finally:
        case.tearDown()
        P185.TestLifecycle.tearDownClass()


def _halted():
    """A funding divergence halts the process (BAL-DECISION-184-01): heartbeat, halt file, report and the session's funding report."""
    case = P185.TestObservedLifecycle("test_the_halt_does_not_depend_on_the_heartbeat")
    case.setUp()
    try:
        supervisor, _ = case.halted_run()
        return (case.read(LP.HEARTBEAT_FILE), case.read(LP.HALT_FILE), case.read(LP.REPORT_FILE),
                supervisor.session.funding_report())
    finally:
        case.doCleanups()


def build():
    if "blocks" in _CACHE:
        return _CACHE["blocks"]
    warming, live, stopped_beat, report = _lifecycle()
    halted_beat, halt, halted_report, funding = _halted()
    age = dict(heartbeat_age_ms=HEARTBEAT_AGE_MS, max_age_ms=HEARTBEAT_MAX_AGE_MS)
    blocks = {
        "warming_up": PUB.session_status(warming, **age),
        "live_threshold_hypothesis": PUB.session_status(live, **age),
        "live_alive_threshold_approved": PUB.session_status(live, threshold_approved=True, **age),
        "live_heartbeat_stale": PUB.session_status(live, heartbeat_age_ms=60_000, max_age_ms=HEARTBEAT_MAX_AGE_MS),
        "stopped_orderly": PUB.session_status(stopped_beat, None, report, **age),
        "halted_funding_diverged": PUB.session_status(halted_beat, halt, halted_report, funding=funding, **age),
        "unavailable": PUB.session_status(None),
    }
    _CACHE["blocks"] = blocks
    return blocks


def dumps(blocks):
    return json.dumps(blocks, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(TARGET, "w", encoding="utf-8") as out:
        out.write(dumps(build()))
    print("wrote", os.path.normpath(TARGET))
