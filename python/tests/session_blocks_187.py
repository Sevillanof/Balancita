"""Issue #187: session blocks produced by the REAL publisher (``paper_live_publish``) from a runner fed with invented events. They are
the input of the TypeScript gateway and decoder tests, so those run against what Python really emits and not against hand-written
shapes. ``python3 python/tests/session_blocks_187.py`` rewrites the JSON; ``test_paper_session_blocks_187.py`` fails if it is out of date.
Nothing here reads a database, a capture or a real clock."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from balancita_engine import paper_live_publish as PUB          # noqa: E402

import test_paper_runner as T                                    # noqa: E402

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "mission-control", "b3", "bloques-publicador-real.json")
LIVE = {"source": "live"}
REPORT_AGE_MS = 1_000
REPORT_MAX_AGE_MS = 15_000                    # a test value, not an approved threshold


class _Case(T.Rig):
    def runTest(self):                                           # pragma: no cover - only to instantiate the Rig
        pass


def build():
    """Two products on the same cycle: BTC buys and opens, ETH waits. The blocks are what the publisher says about that runner."""
    case = _Case()
    case.setUp()
    try:
        script = {"scripted-a": {(T.BTC, T.CYCLE): case.call("BUY"), (T.ETH, T.CYCLE): case.call("WAIT")}}
        runner = case.runner(script)
        runner.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC), T.cycle(T.CYCLE + 3 * T.SEC, T.ETH),
                    T.quote(T.BTC, T.CYCLE + 5 * T.SEC, "100010")])
        positions = PUB.positions(runner, REPORT_AGE_MS, REPORT_MAX_AGE_MS, LIVE, threshold_approved=False)
        approved = PUB.positions(runner, REPORT_AGE_MS, REPORT_MAX_AGE_MS, LIVE, threshold_approved=True)
        intervals = PUB.intervals(runner)
        broken = PUB.intervals(_with_damaged_reference(runner))
        return {"positions": positions, "positions_threshold_approved": approved, "intervals": intervals, "intervals_with_unverified_reference": broken}
    finally:
        case.doCleanups()


def _with_damaged_reference(runner):
    for entry in runner.journal.entries:
        if entry["kind"] == "signals_persisted":
            for ref in entry["data"]["refs"]:
                if ref["action"] == "WAIT":
                    ref["entry_hash"] = "0" * 64
    return runner


def dumps(blocks):
    return json.dumps(blocks, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(TARGET, "w", encoding="utf-8") as out:
        out.write(dumps(build()))
    print("wrote", os.path.normpath(TARGET))
