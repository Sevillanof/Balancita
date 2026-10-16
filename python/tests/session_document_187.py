"""Issue #187 (BAL-DECISION-187-05): ``session_blocks`` documents built by the REAL publisher from a runner fed with invented events and
from the real heartbeat, halt and report files a ``Supervisor`` leaves in invented sessions. They are the input of the TypeScript reader
and decoder tests. ``python3 python/tests/session_document_187.py`` rewrites the JSON; ``test_paper_session_document_187.py`` fails if it
is out of date. Nothing here reads a database, a capture or a real clock."""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.join(_HERE, "..")]            # so the command above works without PYTHONPATH

from balancita_engine import paper_live_publish as PUB          # noqa: E402

import session_status_blocks_187 as STATUS                      # noqa: E402
import test_paper_runner as T                                    # noqa: E402

TARGET = os.path.join(_HERE, "..", "..", "docs", "mission-control", "b3", "documento-bloques-publicador-real.json")
LIVE = {"source": "live"}
RUN_PID = 4242                                   # an invented process id: the fixture must be byte-stable
MAX_AGE_MS = 15_000                           # a test value, not an approved threshold
_CACHE = {}


class _Case(T.Rig):
    def runTest(self):                                           # pragma: no cover - only to instantiate the Rig
        pass


def _runner(case):
    """Two products on the same cycle: BTC buys and opens, ETH waits."""
    script = {"scripted-a": {(T.BTC, T.CYCLE): case.call("BUY"), (T.ETH, T.CYCLE): case.call("WAIT")}}
    runner = case.runner(script)
    runner.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC), T.cycle(T.CYCLE + 3 * T.SEC, T.ETH), T.quote(T.BTC, T.CYCLE + 5 * T.SEC, "100010")])
    return runner


def build():
    if "doc" in _CACHE:
        return _CACHE["doc"]
    warming, live, stopped_beat, report = STATUS._lifecycle()
    halted_beat, halt, halted_report, funding = STATUS._halted()
    live, stopped_beat, halted_beat = (dict(beat, pid=RUN_PID) for beat in (live, stopped_beat, halted_beat))   # the real pid changes every run
    case = _Case()
    case.setUp()
    try:
        runner = _runner(case)
        documents = {
            "operating_threshold_hypothesis": PUB.session_blocks(runner, live, max_age_ms=MAX_AGE_MS, source_state=LIVE),
            "operating_no_threshold": PUB.session_blocks(runner, live, source_state=LIVE),
            "stopped_orderly": PUB.session_blocks(runner, stopped_beat, None, report, max_age_ms=MAX_AGE_MS, source_state=LIVE),
            "halted_funding_diverged": PUB.session_blocks(runner, halted_beat, halt, halted_report, max_age_ms=MAX_AGE_MS, funding=funding),
            "without_status": PUB.session_blocks(runner, None, max_age_ms=MAX_AGE_MS),
        }
    finally:
        case.doCleanups()
    _CACHE["doc"] = documents
    return documents


def dumps(documents):
    return json.dumps(documents, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(TARGET, "w", encoding="utf-8") as out:
        out.write(dumps(build()))
    print("wrote", os.path.normpath(TARGET))
