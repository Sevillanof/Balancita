"""Child process of the real-termination test: recovers a session directory, arms a SIGKILL at one boundary and steps once.

Run as ``python live_kill_worker.py <directory> <world.sqlite> <recovery_ms> <point> <occurrence> <step_index> <clock>``.
The process ends with SIGKILL at the ``occurrence``-th time the boundary ``point`` is crossed: no ``finally``, no ``atexit``,
no flush that the session did not already do itself. Exit status 0 means the boundary was never crossed.
"""
import os
import signal
import sys
import types

import test_paper_live_circuit_184 as T


def main(argv):
    directory, world_path, recovery_ms, point, occurrence, index, clock = argv
    strategies = T.circuit_strategies()
    world = types.SimpleNamespace(path=world_path)
    ingest_kw = {} if clock == "clock" else T.INGEST_KW
    session = T.recover_session(world, directory, strategies, int(recovery_ms), ingest_kw)
    crossed = {"n": 0}

    def fault(name, info=None):
        if name == point:
            crossed["n"] += 1
            if crossed["n"] >= int(occurrence):
                os.kill(os.getpid(), signal.SIGKILL)
    session.fault = fault
    session.step(T.TIMES[int(index)])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
