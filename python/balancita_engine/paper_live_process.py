"""Issue #185: the life of a paper session as a process: versioned configuration, pre-flight, warm-up, orderly stop, restart.

    config file -> preflight -> start (create | recover) -> WARMUP -> LIVE -> STOPPING -> STOPPED
                                                              \\-> HALTED (a step failed; the instance never steps again)

Nothing here is a strategy, an indicator, a cost or a financial rule: it drives ``LiveSession`` (10D) and writes two small files
next to the session's own records, ``heartbeat.json`` (what the supervisor sees while it runs) and ``report.json`` (what is left
when the process ends). The clock and the sleep are injected, so a test runs a whole session without waiting.

What this module refuses, on purpose, while the real-session GATE is NO-GO (decision of Fran, unchanged by #185):

* any source other than the synthetic fixture (``real_session_not_authorized``): a session with real data needs its own written
  authorization, and enabling it is a code change, not a flag;
* the wall clock (``wall_clock_not_authorized``): the command line runs on a simulated clock only;
* a restart on its own after ``HALTED`` or ``REFUSED`` (``restart_requires_operator``): the operator decides, with ``--restart``;
* a restart after an orderly stop (``session_stopped``): a stopped session is over.

Open positions when the process stops are not touched (D-186-1): while it is down nobody evaluates their stops or targets. The
report lists them so the operator sees what was left open. No persistent process is started by this module; ``run`` ends when
it is told to stop, when it has done ``max_steps`` or when the decision window is over.
"""

import argparse
import json
import os
import shutil
import signal
import sys
import time

from . import paper_live_integration as LI
from . import replay_driver as RP
from . import replay_specs as RS
from .futures_products import is_product_id
from .futures_simulator import ONE_MINUTE_MS
from .multi_experiment import required_warmup_ms
from .multi_signals import merged_indicators, stable_hash
from .paper_live_ingest import SourceReader
from .paper_runner import STOPPED, RunnerConfig
from .portfolio import PortfolioPolicy
from .portfolio_watch import WatchPolicy

CONFIG_SCHEMA = "balancita-paper-live-process-config.v1"
HEARTBEAT_SCHEMA = "balancita-paper-live-heartbeat.v1"
REPORT_SCHEMA = "balancita-paper-live-process-report.v1"
CONFIG_FILE, HEARTBEAT_FILE, REPORT_FILE = "process-config.json", "heartbeat.json", "report.json"
CAPITAL_POLICY = "adr-0001-fixed-100-usd"        # a label: the sizing is the portfolio policy's, this module has no money rule
SYNTHETIC_SOURCE = "synthetic"
FRESH_MS = 600_000                               # the newest warm-up candle may be this far from the first decision

INIT, WARMUP, LIVE, STOPPING, STOPPED_PHASE, HALTED, REFUSED_PHASE = "INIT", "WARMUP", "LIVE", "STOPPING", "STOPPED", "HALTED", "REFUSED"
FINAL_PHASES = (STOPPED_PHASE, HALTED, REFUSED_PHASE)
EXIT_OK, EXIT_REFUSED, EXIT_HALTED = 0, 2, 3

DEFAULTS = {"source_id": SYNTHETIC_SOURCE, "decide_until_ms": None, "max_quote_gap_ms": 15_000, "block_stale_entries": True,
            "funding_mode": LI.SYNTHETIC_FUNDING, "on_funding_divergence": "halt", "ingest_kw": {}, "evaluator_kw": {},
            "strategies": "frozen", "capital_policy": CAPITAL_POLICY, "step_interval_ms": 1_000, "min_free_bytes": 1 << 30, "warmup_minutes": None}
REQUIRED = ("schema", "products", "decide_from_ms")


class ProcessError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


# ---- configuration -----------------------------------------------------------------------------------------------
def load_config(path):
    """The configuration of a session, validated. The digest identifies it: a directory created with one configuration is
    never continued with another."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise ProcessError("config_unreadable", str(error))
    return validate_config(raw)


def validate_config(raw):
    if not isinstance(raw, dict):
        raise ProcessError("config_invalid", "not an object")
    unknown = sorted(set(raw) - set(DEFAULTS) - set(REQUIRED))
    if unknown:
        raise ProcessError("config_invalid", "unknown keys: " + ", ".join(unknown))
    missing = [k for k in REQUIRED if k not in raw]
    if missing:
        raise ProcessError("config_invalid", "missing keys: " + ", ".join(missing))
    config = dict(DEFAULTS, **raw)
    if config["schema"] != CONFIG_SCHEMA:
        raise ProcessError("config_invalid", "schema")
    products = config["products"]
    if not isinstance(products, list) or not products or len(set(products)) != len(products) or not all(is_product_id(p) for p in products):
        raise ProcessError("config_invalid", "products")
    config["products"] = sorted(products)
    for key in ("decide_from_ms", "max_quote_gap_ms", "step_interval_ms", "min_free_bytes"):
        if isinstance(config[key], bool) or not isinstance(config[key], int) or config[key] < 0:
            raise ProcessError("config_invalid", key)
    if config["warmup_minutes"] is not None and (isinstance(config["warmup_minutes"], bool) or not isinstance(config["warmup_minutes"], int)
                                                  or config["warmup_minutes"] < 1):
        raise ProcessError("config_invalid", "warmup_minutes")
    if config["decide_until_ms"] is not None and (isinstance(config["decide_until_ms"], bool) or not isinstance(config["decide_until_ms"], int)
                                                   or config["decide_until_ms"] <= config["decide_from_ms"]):
        raise ProcessError("config_invalid", "decide_until_ms")
    if not isinstance(config["block_stale_entries"], bool):
        raise ProcessError("config_invalid", "block_stale_entries")
    if config["funding_mode"] not in (LI.SYNTHETIC_FUNDING, LI.OBSERVED_FUNDING):
        raise ProcessError("config_invalid", "funding_mode")
    if config["on_funding_divergence"] != "halt":                    # BAL-DECISION-184-01: an unexplained divergence stops the session
        raise ProcessError("config_invalid", "on_funding_divergence")
    for key in ("ingest_kw", "evaluator_kw"):
        if not isinstance(config[key], dict):
            raise ProcessError("config_invalid", key)
    if config["strategies"] != "frozen":
        raise ProcessError("config_invalid", "strategies: only the frozen set exists")
    if config["capital_policy"] != CAPITAL_POLICY:
        raise ProcessError("config_invalid", "capital_policy: the sizing is the ADR's, a session cannot change it")
    return dict(config, digest=stable_hash({k: v for k, v in config.items() if k != "digest"})[:20])


def runner_config_of(config):
    return RunnerConfig(portfolio=PortfolioPolicy(), execution=RP.execution_policy(), watch=WatchPolicy(), funding=(),
                        start_ms=config["decide_from_ms"], execution_mode="quotes")


def session_kwargs(config):
    return dict(decide_from_ms=config["decide_from_ms"], decide_until_ms=config["decide_until_ms"], source_id=config["source_id"],
                ingest_kw=config["ingest_kw"], evaluator_kw=config["evaluator_kw"], max_quote_gap_ms=config["max_quote_gap_ms"],
                block_stale_entries=config["block_stale_entries"], funding_mode=config["funding_mode"],
                on_funding_divergence=config["on_funding_divergence"])


# ---- pre-flight --------------------------------------------------------------------------------------------------
def preflight(config, directory, source_path, *, strategies=None):
    """Read-only checks before anything is created or opened for writing. ``{"ok", "checks": [{name, ok, detail}]}``; every check
    runs, so the operator sees all that is wrong at once."""
    checks = []

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    check("real_session_gate", config["source_id"] == SYNTHETIC_SOURCE,
          "source_id {!r}: real data needs a written authorization (the GATE is NO-GO)".format(config["source_id"]))
    stored_path = os.path.join(directory, CONFIG_FILE)
    if os.path.exists(os.path.join(directory, LI.SESSION_FILE)):
        stored = _read_json(stored_path)
        check("configuration_matches_directory", stored is not None and stored.get("digest") == config["digest"],
              "the directory was created with another configuration" if stored else "process-config.json is missing")
    elif os.path.exists(directory) and os.listdir(directory):
        check("directory_is_free", False, "not empty and not a session: " + directory)
    parent = directory if os.path.isdir(directory) else os.path.dirname(os.path.abspath(directory))
    free = shutil.disk_usage(parent).free if os.path.isdir(parent) else 0
    check("disk_free", free >= config["min_free_bytes"], "{} bytes free, {} required".format(free, config["min_free_bytes"]))
    runner_dir = os.path.join(directory, LI.RUNNER_DIR)
    if os.path.isdir(runner_dir):
        try:
            LI._take_lock(runner_dir).release()
            check("directory_unlocked", True)
        except LI.IntegrationError as error:
            check("directory_unlocked", False, str(error))
    try:
        reader = SourceReader(source_path)
    except Exception as error:               # noqa: BLE001
        check("source_readable", False, str(error))
        return {"ok": False, "checks": checks}
    try:
        check("source_readable", True)
        strategies = strategies or RS.load_frozen()[0]
        need = config["warmup_minutes"] or required_warmup_ms(merged_indicators(strategies)) // ONE_MINUTE_MS     # the indicators' own, unless lowered
        warmup_ms = need * ONE_MINUTE_MS
        for product in config["products"]:
            try:
                newest = reader.db.execute("SELECT MAX(bucket_start) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=? "
                                           "AND bucket_start<?", (product, ONE_MINUTE_MS, config["decide_from_ms"])).fetchone()[0]
                have = 0 if newest is None else reader.db.execute(
                    "SELECT COUNT(*) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=? AND bucket_start>? "
                    "AND bucket_start<=?", (product, ONE_MINUTE_MS, newest - warmup_ms, newest)).fetchone()[0]
            except Exception as error:       # noqa: BLE001
                check("warmup_" + product, False, "source has no candles table: " + str(error))
                continue
            fresh = newest is not None and newest >= config["decide_from_ms"] - FRESH_MS
            check("warmup_" + product, fresh and have >= need,
                  "{} of {} one-minute candles in the {} ms up to the newest before the first decision ({}; at most {} ms before it)".format(
                      have, need, warmup_ms, newest, FRESH_MS))
    finally:
        reader.close()
    return {"ok": all(c["ok"] for c in checks), "checks": checks}


# ---- the supervisor ----------------------------------------------------------------------------------------------
def phase_of(session):
    """The state of a session, derived from what it holds (nothing is stored apart from the heartbeat that reports it)."""
    if session.halted is not None:
        return HALTED
    if session.stopped is not None or session.runner.status == STOPPED:
        return STOPPED_PHASE
    evaluator = session.evaluator
    for state in evaluator.state.values():
        if state["last_one"] < 0 or state["last_one"] + ONE_MINUTE_MS < max(evaluator.decide_from_ms, state["suppress_until"]):
            return WARMUP
    return LIVE


class Supervisor(object):
    """Starts, runs and ends one session. ``clock()`` returns the observation time in ms; ``sleep(seconds)`` waits between steps;
    ``tick(now)`` is called before each step (a test releases the invented market there)."""

    def __init__(self, config, directory, source_path, *, clock, sleep=lambda seconds: None, tick=lambda now: None, strategies=None):
        self.config, self.directory, self.source_path = config, directory, source_path
        self.clock, self.sleep, self.tick = clock, sleep, tick
        self.strategies = strategies
        self.session = None
        self.stop_requested = False
        self.stop_signal = None
        self.phase = INIT

    # ---- start -----------------------------------------------------------------------------------------------
    def start(self, *, restart=False):
        """Creates the session or recovers the directory. Refuses (``ProcessError``) with a stable reason; nothing is written
        before the pre-flight passes."""
        report = preflight(self.config, self.directory, self.source_path, strategies=self.strategies)
        if not report["ok"]:
            failed = [c for c in report["checks"] if not c["ok"]]
            reason = "real_session_not_authorized" if any(c["name"] == "real_session_gate" for c in failed) else "preflight_failed"
            raise ProcessError(reason, "; ".join("{}: {}".format(c["name"], c["detail"]) for c in failed))
        strategies = self.strategies or RS.load_frozen()[0]
        kwargs = session_kwargs(self.config)
        existing = os.path.exists(os.path.join(self.directory, LI.SESSION_FILE))
        if not existing:
            os.makedirs(self.directory, exist_ok=True)
            self.session = LI.LiveSession.create(self.directory, self.source_path, strategies, self.config["products"],
                                                 runner_config_of(self.config), **kwargs)
            _write_json(os.path.join(self.directory, CONFIG_FILE), self.config)
        else:
            last = _read_json(os.path.join(self.directory, HEARTBEAT_FILE)) or {}
            if last.get("phase") == STOPPED_PHASE:
                raise ProcessError("session_stopped", "the operator stopped this session; a stopped session is over")
            if last.get("phase") in (HALTED, REFUSED_PHASE) and not restart:
                raise ProcessError("restart_requires_operator", "the last run ended {}: restart explicitly after reading its report".format(last["phase"]))
            self.session = LI.LiveSession.recover(self.directory, self.source_path, strategies, self.config["products"],
                                                  runner_config_of(self.config), self.clock(), **kwargs)
        self.phase = phase_of(self.session)
        self._beat(self.clock(), None)
        return self.session

    def request_stop(self, signum=None):
        """Only sets a flag (safe in a signal handler): the loop stops after the step it is in."""
        self.stop_requested, self.stop_signal = True, signum

    # ---- run -------------------------------------------------------------------------------------------------
    def run(self, max_steps=None):
        """Steps until told to stop, until ``max_steps`` or until the decision window is over. Returns the exit code."""
        steps = 0
        while not self.stop_requested and (max_steps is None or steps < max_steps):
            now = self.clock()
            if self.config["decide_until_ms"] is not None and now >= self.config["decide_until_ms"] + 6 * 3_600_000:
                break
            self.tick(now)
            try:
                state = self.session.step(now)
            except Exception as error:               # noqa: BLE001
                self.phase = HALTED
                self._beat(now, None)
                self._finish(now, halted=repr(error))
                return EXIT_HALTED
            steps += 1
            self.phase = phase_of(self.session)
            self._beat(now, state)
            self.sleep(self.config["step_interval_ms"] / 1000.0)
        return self.end()

    def end(self):
        """Orderly end (decision D-186-1): pending orders are cancelled with their own reason, open positions are left as they are,
        and the report says so."""
        now = self.clock()
        self.phase = STOPPING
        self._beat(now, None)
        try:
            self.session.stop(now)
        except Exception as error:               # noqa: BLE001
            self.phase = HALTED
            self._beat(now, None)
            self._finish(now, halted=repr(error))
            return EXIT_HALTED
        self.phase = STOPPED_PHASE
        self._finish(now)
        return EXIT_OK

    def abandon(self):
        """The process ends without an orderly stop (what a kill does, for a test or an exception): the lock goes with it."""
        self.session.runner.close()

    # ---- files -----------------------------------------------------------------------------------------------
    def _beat(self, now, state):
        session = self.session
        _write_json(os.path.join(self.directory, HEARTBEAT_FILE), {
            "schema": HEARTBEAT_SCHEMA, "session_id": session.identity["session_id"], "config_digest": self.config["digest"],
            "phase": self.phase, "pid": os.getpid(), "observed_now_ms": now, "steps": session.stats["steps"],
            "ingest_state": state, "runner_status": session.runner.status, "halted": session.halted,
            "pending_orders": len(session.runner.executor.pending), "open_positions": session.runner.portfolio.snapshot()["open_positions"]})

    def _finish(self, now, halted=None):
        session = self.session
        snapshot = session.runner.portfolio.snapshot()
        body = {"schema": REPORT_SCHEMA, "session_id": session.identity["session_id"], "config_digest": self.config["digest"],
                "ended_as": self.phase, "ended_at_observed_ms": now, "halted": halted or session.halted,
                "stop": session.stopped, "steps": session.stats["steps"], "digests": session.digests(),
                "positions": {"open_at_end": snapshot["open_positions"], "closed": snapshot["closed_trades"],
                              "note": "open positions are not closed or modified by a stop; while the process is down nobody evaluates their stops or targets"},
                "pending_at_end": len(session.runner.executor.pending),
                "capital_policy": self.config["capital_policy"], "policy_status": "experimental", "evidence_class": "not_forward_evidence",
                "stop_signal": self.stop_signal}
        if self.config["funding_mode"] == LI.OBSERVED_FUNDING:
            body["funding"] = session.funding_report()
        _write_json(os.path.join(self.directory, REPORT_FILE), body)
        self._beat(now, None)
        session.close()
        return body


def _write_json(path, body):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(body, handle, sort_keys=True, indent=1)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    LI._fsync_dir(path)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


# ---- command line ------------------------------------------------------------------------------------------------
def main(argv=None, *, tick=lambda now: None):
    """``preflight`` and ``run`` on the simulated clock. Exit status: 0 ok, 2 refused (no file was written), 3 halted."""
    parser = argparse.ArgumentParser(prog="paper_live_process", description="Offline paper session lifecycle (synthetic source only).")
    parser.add_argument("command", choices=("preflight", "run"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--source", required=True, help="SQLite file of the synthetic source")
    parser.add_argument("--clock-from-ms", type=int, help="start of the simulated clock")
    parser.add_argument("--clock-step-ms", type=int, default=60_000)
    parser.add_argument("--wall-clock", action="store_true", help="refused while the real-session GATE is NO-GO")
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--step-sleep-s", type=float, default=0.0, help="real seconds between steps (to give a signal time to arrive)")
    parser.add_argument("--restart", action="store_true", help="continue a directory whose last run ended HALTED or REFUSED")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        if args.command == "preflight":
            report = preflight(config, args.directory, args.source)
            print(json.dumps(report, sort_keys=True, indent=1))
            return EXIT_OK if report["ok"] else EXIT_REFUSED
        if args.wall_clock:
            raise ProcessError("wall_clock_not_authorized", "the command line runs on a simulated clock only (--clock-from-ms)")
        if args.clock_from_ms is None:
            raise ProcessError("config_invalid", "--clock-from-ms is required")
        state = {"now": args.clock_from_ms}

        def sleep(_seconds):
            if args.step_sleep_s:
                time.sleep(args.step_sleep_s)
            state["now"] += args.clock_step_ms

        supervisor = Supervisor(config, args.directory, args.source, clock=lambda: state["now"], sleep=sleep, tick=tick)
        supervisor.start(restart=args.restart)
        signal.signal(signal.SIGTERM, lambda signum, _frame: supervisor.request_stop(signum))
        signal.signal(signal.SIGINT, lambda signum, _frame: supervisor.request_stop(signum))
        return supervisor.run(args.max_steps)
    except ProcessError as error:
        print(json.dumps({"refused": error.reason, "detail": str(error)}, sort_keys=True), file=sys.stderr)
        return EXIT_REFUSED
    except LI.IntegrationError as error:
        print(json.dumps({"refused": error.reason, "detail": str(error)}, sort_keys=True), file=sys.stderr)
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())
