"""Child process of the session-level real-termination tests (#186, S-K1/S-K2): recovers a session directory, arms ONE fault of the
runner's store (``paper_runner_store.arm``) and steps once. When the fault fires the process ends with SIGKILL at that very place:
for ``mid_journal`` the half of the line has already been written and fsynced, as a power cut leaves it; nothing else runs.

Run as ``python live_kill_store_worker.py <directory> <world.sqlite> <recovery_ms> <fault> <kind|-> <nth> <step_index>``.
Exit status 0 means the fault was never reached. With ``KILL_IN_RECOVERY=1`` the fault is armed BEFORE the directory is recovered, so
it can fire inside the recovery itself (S-K3, matrix A4 at the level of the session)."""
import os
import signal
import sys
import types

import test_paper_live_integration as T
from balancita_engine import paper_runner_store as PS
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC


def main(argv):
    directory, world_path, recovery_ms, fault, kind, nth, index = argv
    strategies, _ = RS.load_frozen()
    world = types.SimpleNamespace(path=world_path)
    arm = lambda: PS.arm(fault, int(nth), None if kind == "-" else kind)      # noqa: E731
    try:
        if os.environ.get("KILL_IN_RECOVERY") == "1":
            arm()
        session = T.recover_session(world, directory, strategies, int(recovery_ms), products=(T.BTC, T.ETH))
        if os.environ.get("KILL_IN_RECOVERY") != "1":
            arm()
        session.step(T.TIMES[int(index)])
    except SC.SimulatedCrash:
        os.kill(os.getpid(), signal.SIGKILL)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
