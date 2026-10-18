"""Child process of the session-level real-termination tests (#186, S-K1/S-K2): recovers a session directory, arms ONE fault of the
runner's store (``paper_runner_store.arm``) and steps once. When the fault fires the process ends with SIGKILL at that very place:
for ``mid_journal`` the half of the line has already been written and fsynced, as a power cut leaves it. The simulated crash unwinds the stack to ``main`` before the SIGKILL (that only releases the process's locks; no journal write, flush or checkpoint is made on the way).

Run as ``python live_kill_store_worker.py <directory> <world.sqlite> <recovery_ms> <fault> <kind|-> <nth> <step_index>`` (the instant in ms for the real world, the index of the step for the invented one, ``KILL_INVENTED=1``).
Exit status 0 means the fault was never reached. With ``KILL_IN_RECOVERY=1`` the fault is armed BEFORE the directory is recovered, so
it can fire inside the recovery itself (S-K3, matrix A4 at the level of the session) and is disarmed once the recovery returns, so a death
in the step cannot pass for a death in the recovery. If ``KILL_STAGE_FILE`` is set the worker writes it as soon as the recovery has returned:
its absence after the kill proves that the process died inside the recovery."""
import os
import signal
import sys
import types

import real_session as R
import test_paper_live_integration as T
from balancita_engine import paper_runner_store as PS
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC


def main(argv):
    directory, world_path, recovery_ms, fault, kind, nth, index = argv
    invented = os.environ.get("KILL_INVENTED") == "1"       # the S-K5 scenarios still run on the invented world
    strategies = RS.load_frozen()[0] if invented else R.strategies()
    world = types.SimpleNamespace(path=world_path)
    arm = lambda: PS.arm(fault, int(nth), None if kind == "-" else kind)      # noqa: E731
    try:
        if os.environ.get("KILL_IN_RECOVERY") == "1":
            arm()
        if invented:
            session = T.recover_session(world, directory, strategies, int(recovery_ms), products=(T.BTC, T.ETH))
        else:
            session = R.recover_session(world, directory, strategies, int(recovery_ms))
        if os.environ.get("KILL_STAGE_FILE"):
            with open(os.environ["KILL_STAGE_FILE"], "w", encoding="utf-8") as marker:
                marker.write("recovered")
        if os.environ.get("KILL_IN_RECOVERY") != "1":
            arm()
        else:
            PS.disarm()
        session.step(T.TIMES[int(index)] if invented else int(index))
    except SC.SimulatedCrash:
        os.kill(os.getpid(), signal.SIGKILL)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
