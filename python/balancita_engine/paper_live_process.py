"""Issue #185: the life of a paper session as a process: versioned configuration, pre-flight, warm-up, orderly stop, restart.

    config file -> preflight -> start (create | recover) -> WARMUP -> LIVE -> STOPPING -> STOPPED
                                                              \\-> HALTED (a step failed; the instance never steps again)

Nothing here is a strategy, an indicator, a cost or a financial rule: it drives ``LiveSession`` (10D) and writes two small files
next to the session's own records, ``heartbeat.json`` (what the supervisor sees while it runs) and ``report.json`` (what is left
when the process ends). The clock and the sleep are injected, so a test runs a whole session without waiting.

What this module refuses, on purpose, while the real-session GATE is NO-GO (decision of Fran, unchanged by #185):

* any source that does not identify itself as the synthetic fixture (``real_session_not_authorized``): the configuration must say
  ``source_id: synthetic`` AND the SQLite file must carry the fixture's own marker table (``balancita_synthetic_fixture``). A real
  capture has neither, so it is refused whatever the configuration says; this guards against a mistake, not against someone who
  forges the marker on purpose. A session with real data needs its own written authorization and a reviewed code change;
* the wall clock (``wall_clock_not_authorized``): the command line runs on a simulated clock only;
* a restart on its own of a directory that already holds a started session (``restart_requires_operator``, BAL-DECISION-185-01): after
  ANY run that did not end in order (HALTED, REFUSED, a kill, a power cut, a full disk) the operator decides, with ``--restart``, and
  nothing is opened, recovered or stepped before that. The gate does not read marks: ``halt.json``, the heartbeat and the audit are
  only the reasons shown to the operator, because a double write failure leaves none of them and the absence of a mark is not a
  licence. Identity, lock and coherent recovery are checked as always once the operator asked. BAL-DECISION-184-01: a funding
  divergence is never taken up again by this module on its own;
* a restart after an orderly stop (``session_stopped``): a stopped session is over.

Resource limits (``resource_limits`` in the configuration, optional and OFF unless the configuration names them): the process measures the
size of the session directory and its own resident memory every ``check_every_steps`` steps, writes the readings and every warning
to the heartbeat, and when a ``*_stop_bytes`` limit is reached it stops IN ORDER (the same terminal stop as a SIGTERM, with
``stop_reason`` in the report and exit status 4). No value is approved or defaulted: Fran has not decided any (the numbers in the
Issues are proposals), so a configuration without ``resource_limits`` behaves exactly as before.

Open positions when the process stops are not touched (D-186-1): while it is down nobody evaluates their stops or targets. The
report lists them so the operator sees what was left open. No persistent process is started by this module; ``run`` ends when
it is told to stop, when it has done ``max_steps`` or when the decision window is over.
"""

import argparse
import json
import os
import re
import shutil
import signal
import stat
import sys
import time
from decimal import Decimal

from . import paper_live_integration as LI
from . import replay_driver as RP
from . import replay_specs as RS
from .futures_products import is_product_id
from .futures_simulator import ONE_MINUTE_MS
from .multi_experiment import required_warmup_ms
from .multi_signals import merged_indicators, stable_hash
from .paper_live_ingest import SourceReader
from .paper_runner import STOPPED, RunnerConfig
from .paper_runner_store import StoreError
from .portfolio import PortfolioPolicy
from .portfolio_watch import WatchPolicy

CONFIG_SCHEMA = "balancita-paper-live-process-config.v1"
HEARTBEAT_SCHEMA = "balancita-paper-live-heartbeat.v1"
REPORT_SCHEMA = "balancita-paper-live-process-report.v1"
CONFIG_FILE, HEARTBEAT_FILE, REPORT_FILE = "process-config.json", "heartbeat.json", "report.json"
HALT_FILE, RESTARTS_FILE = "halt.json", "operator-restarts.json"        # durable, independent of the heartbeat
MARKER_TABLE, MARKER = "balancita_synthetic_fixture", "balancita-synthetic-fixture.v1"
POST_WINDOW_MS = 6 * 3_600_000                  # the loop ends this long after the decision window (positions may still close)


def capital_policy_label(policy):
    """What the session really trades with, read from the portfolio policy the runner is built with (D-185-CAP-01): the shared experimental
    portfolio, sized by risk. It is NOT the ADR's fixed 100 USD per trade, and nothing in this module sizes a trade."""
    equity = format(Decimal(policy.initial_equity_usd).normalize(), "f")
    risk_pct = format((Decimal(policy.risk_per_trade) * 100).normalize(), "f")
    return "shared-portfolio-{}-usd-risk-{}pct-experimental".format(equity, risk_pct)


CAPITAL_POLICY = capital_policy_label(PortfolioPolicy())        # a label: the sizing is the portfolio policy's, this module has no money rule
SYNTHETIC_SOURCE = "synthetic"
FRESH_MS = 600_000                               # the newest warm-up candle may be this far from the first decision

INIT, WARMUP, LIVE, STOPPING, STOPPED_PHASE, HALTED, REFUSED_PHASE = "INIT", "WARMUP", "LIVE", "STOPPING", "STOPPED", "HALTED", "REFUSED"
FINAL_PHASES = (STOPPED_PHASE, HALTED, REFUSED_PHASE)
EXIT_OK, EXIT_REFUSED, EXIT_HALTED, EXIT_RESOURCE_STOP = 0, 2, 3, 4

DEFAULTS = {"source_id": SYNTHETIC_SOURCE, "decide_until_ms": None, "max_quote_gap_ms": 15_000, "block_stale_entries": True,
            "funding_mode": LI.SYNTHETIC_FUNDING, "on_funding_divergence": "halt", "ingest_kw": {}, "evaluator_kw": {},
            "strategies": "frozen", "capital_policy": CAPITAL_POLICY, "step_interval_ms": 1_000, "min_free_bytes": 1 << 30, "warmup_minutes": None}
REQUIRED = ("schema", "products", "decide_from_ms")
OPTIONAL = ("resource_limits", "clock_guard", "authorization_ref")                  # absent from DEFAULTS on purpose: a configuration without it keeps its digest
RESOURCE_KEYS = ("disk_warn_bytes", "disk_stop_bytes", "memory_warn_bytes", "memory_stop_bytes")
DEFAULT_CHECK_EVERY_STEPS = 30
AUTHORIZATION_REF = re.compile(r"^BAL-DECISION-[0-9]{1,4}-[0-9]{1,3}$")


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
    unknown = sorted(set(raw) - set(DEFAULTS) - set(REQUIRED) - set(OPTIONAL))
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
        raise ProcessError("config_invalid", "capital_policy: must be {!r}, the label of the portfolio policy the runner uses; a session cannot change it "
                                             "(an older label, such as 'adr-0001-fixed-100-usd', is refused, not migrated)".format(CAPITAL_POLICY))
    if "clock_guard" in config:
        config["clock_guard"] = _validate_clock_guard(config["clock_guard"])
    ref = config.get("authorization_ref")
    if ref is not None and not (isinstance(ref, str) and AUTHORIZATION_REF.match(ref)):
        raise ProcessError("config_invalid", "authorization_ref: expected BAL-DECISION-<issue>-<n>")
    if "resource_limits" in config:
        config["resource_limits"] = _validate_resource_limits(config["resource_limits"])
    # ``authorization_ref`` is an audit trail only: it opens nothing (the gate is a constant of the code) and is not part of the identity
    return dict(config, digest=stable_hash({k: v for k, v in config.items() if k not in ("digest", "authorization_ref")})[:20])


def _validate_clock_guard(raw):
    """``{"max_forward_jump_ms": n}``: the one value is named by the operator (nothing is approved or defaulted)."""
    if not isinstance(raw, dict) or set(raw) != {"max_forward_jump_ms"}:
        raise ProcessError("config_invalid", "clock_guard: exactly max_forward_jump_ms")
    value = raw["max_forward_jump_ms"]
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ProcessError("config_invalid", "clock_guard.max_forward_jump_ms")
    return {"max_forward_jump_ms": value}


def _validate_resource_limits(raw):
    """Named limits only, positive integers, a warning below its stop, at least one limit; nothing is defaulted but the cadence."""
    if not isinstance(raw, dict):
        raise ProcessError("config_invalid", "resource_limits: not an object")
    unknown = sorted(set(raw) - set(RESOURCE_KEYS) - {"check_every_steps"})
    if unknown:
        raise ProcessError("config_invalid", "resource_limits: unknown keys: " + ", ".join(unknown))
    limits = {k: raw[k] for k in RESOURCE_KEYS if k in raw}
    if not limits:
        raise ProcessError("config_invalid", "resource_limits: no limit named")
    every = raw.get("check_every_steps", DEFAULT_CHECK_EVERY_STEPS)
    for key, value in list(limits.items()) + [("check_every_steps", every)]:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ProcessError("config_invalid", "resource_limits." + key)
    for resource in ("disk", "memory"):
        warn, stop = limits.get(resource + "_warn_bytes"), limits.get(resource + "_stop_bytes")
        if warn is not None and stop is not None and warn >= stop:
            raise ProcessError("config_invalid", "resource_limits: {}_warn_bytes must be below {}_stop_bytes".format(resource, resource))
    return dict(limits, check_every_steps=every)


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

    check("causal_ingest", config["source_id"] == SYNTHETIC_SOURCE or config["ingest_kw"].get("causal_until_clock") is True,
          "a source that is not the synthetic fixture needs ingest_kw.causal_until_clock (no row is read before the clock reaches it; D-185-R4-01)")
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
    if os.path.exists(os.path.join(runner_dir, "runner.lock")):             # never creates the lock: a free directory has none to take
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
        try:
            marker = reader.db.execute("SELECT marker FROM {}".format(MARKER_TABLE)).fetchall()
        except Exception:               # noqa: BLE001 - no such table: not the fixture
            marker = []
        check("synthetic_marker", [m[0] for m in marker] == [MARKER], "the source does not carry the synthetic fixture's marker "
              "({}): real data is not authorized".format(MARKER_TABLE))
        strategies = strategies or RS.load_frozen()[0]
        need = config["warmup_minutes"] or required_warmup_ms(merged_indicators(strategies)) // ONE_MINUTE_MS     # the indicators' own, unless lowered
        warmup_ms = need * ONE_MINUTE_MS
        for product in config["products"]:
            try:
                newest = reader.db.execute("SELECT MAX(bucket_start) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=? "
                                           "AND bucket_start<? AND known_at<=?", (product, ONE_MINUTE_MS, config["decide_from_ms"], config["decide_from_ms"])).fetchone()[0]
                have = 0 if newest is None else reader.db.execute(
                    "SELECT COUNT(*) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=? AND bucket_start>? "
                    "AND bucket_start<=? AND known_at<=?", (product, ONE_MINUTE_MS, newest - warmup_ms, newest, config["decide_from_ms"])).fetchone()[0]
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

    def __init__(self, config, directory, source_path, *, clock, sleep=lambda seconds: None, tick=lambda now: None, strategies=None,
                 resources=None, wall_time=None):
        self.config, self.directory, self.source_path = config, directory, source_path
        self.clock, self.sleep, self.tick = clock, sleep, tick
        self.resources = resources or read_resources           # ``resources(directory) -> {"disk_bytes", "memory_bytes"}``; injected in tests
        self.resource_events, self.last_resources, self.stop_reason = [], None, None
        self._warned = set()
        self.wall_time = wall_time or (lambda: int(time.time() * 1000))     # only read when ``clock_guard`` is configured
        self.clock_events, self._last_now = [], None
        self.source_identity = None
        self.strategies = strategies
        self.session = None
        self.stop_requested = False
        self.stop_signal = None
        self.phase = INIT
        self._closed = False

    # ---- start -----------------------------------------------------------------------------------------------
    def start(self, *, restart=False):
        """Creates the session or recovers the directory. Refuses (``ProcessError``) with a stable reason; nothing is written
        before the pre-flight passes."""
        report = preflight(self.config, self.directory, self.source_path, strategies=self.strategies)
        if not report["ok"]:
            failed = [c for c in report["checks"] if not c["ok"]]
            reason = "real_session_not_authorized" if any(c["name"] in ("real_session_gate", "synthetic_marker") for c in failed) else "preflight_failed"
            raise ProcessError(reason, "; ".join("{}: {}".format(c["name"], c["detail"]) for c in failed))
        self.source_identity = file_identity(self.source_path)      # taken once the pre-flight passed, before the session opens the file
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
            ended = _read_json(os.path.join(self.directory, REPORT_FILE)) or {}
            if STOPPED_PHASE in (last.get("phase"), ended.get("ended_as")):
                raise ProcessError("session_stopped", "the operator stopped this session; a stopped session is over")
            # BAL-DECISION-185-01: a directory that holds a started session that was not stopped in order is never taken up again
            # without an explicit operator request, whatever the files say (heartbeat LIVE or missing, no halt.json, no audit line:
            # a double write failure leaves no mark, and the absence of a mark is not a licence). Nothing is opened or written first.
            pending = self.unacknowledged_halts()
            if not restart:
                why = "; ".join(pending) or "the previous run did not end in order (a cut, a crash or a kill)"
                raise ProcessError("restart_requires_operator", "{}: restart explicitly after reading the report".format(why))
            self.session = LI.LiveSession.recover(self.directory, self.source_path, strategies, self.config["products"],
                                                  runner_config_of(self.config), self.clock(), **kwargs)
            self._acknowledge()                     # only after the recovery worked: a death before this leaves the gate closed
        self.phase = phase_of(self.session)
        self._beat(self.clock(), None)
        return self.session

    def unacknowledged_halts(self):
        """Why a restart needs the operator, from files that do not depend on the heartbeat (a heartbeat that is missing, unreadable or
        still says LIVE changes nothing): the durable ``halt.json``, an unacknowledged ``funding_book_diverged`` record in the audit
        journal (BAL-DECISION-184-01: the contradiction is not resolved by a restart), and, as a last resort, a heartbeat that says
        HALTED or REFUSED."""
        reasons = []
        if os.path.exists(os.path.join(self.directory, HALT_FILE)):
            reasons.append("{} exists: the last run halted".format(HALT_FILE))
        diverged = self._divergences_in_audit()
        if diverged > (_read_json(os.path.join(self.directory, RESTARTS_FILE)) or {}).get("acknowledged_divergences", 0):
            reasons.append("the audit journal holds a funding_book_diverged record that no operator restart has acknowledged")
        last = _read_json(os.path.join(self.directory, HEARTBEAT_FILE)) or {}
        if last.get("phase") in (HALTED, REFUSED_PHASE):
            reasons.append("the heartbeat says {}".format(last["phase"]))
        return reasons

    def _divergences_in_audit(self):
        """How many ``funding_book_diverged`` records the audit file holds. Reads the file as it is (a torn last line is skipped, nothing
        is cut or written: opening the journal is the session's job)."""
        count = 0
        try:
            with open(os.path.join(self.directory, LI.AUDIT_FILE), "rb") as handle:
                lines = handle.read().split(b"\n")
        except OSError:
            return 0
        for line in lines:
            try:
                entry = json.loads(line.decode("utf-8"))
                if entry["kind"] == "audit" and entry["data"]["record"]["kind"] == "funding_book_diverged":
                    count += 1
            except (ValueError, KeyError, TypeError, UnicodeDecodeError):
                continue
        return count

    def _acknowledge(self):
        """The operator restarted after a halt: it is on record (the divergences seen so far are acknowledged and ``halt.json`` is kept
        under another name, not deleted)."""
        previous = _read_json(os.path.join(self.directory, RESTARTS_FILE)) or {}
        number = previous.get("restarts", 0) + 1
        _write_json(os.path.join(self.directory, RESTARTS_FILE), {"restarts": number, "acknowledged_divergences": self._divergences_in_audit()})
        halt = os.path.join(self.directory, HALT_FILE)
        if os.path.exists(halt):
            os.replace(halt, os.path.join(self.directory, "halt-acknowledged-{}.json".format(number)))
            LI._fsync_dir(halt)

    def request_stop(self, signum=None):
        """Only sets a flag (safe in a signal handler): the loop stops after the step it is in."""
        self.stop_requested, self.stop_signal = True, signum

    # ---- resources -------------------------------------------------------------------------------------------
    def _check_resources(self, now, steps):
        """Every ``check_every_steps`` steps (and on the first): measure, record, warn once per level and, at a stop limit, ask for the
        same orderly stop as a SIGTERM. A measurement that fails is a reason to stop in order too: a limit that cannot be checked is
        not a limit that holds."""
        limits = self.config.get("resource_limits")
        if not limits or (steps != 1 and steps % limits["check_every_steps"]):
            return
        try:
            reading = self.resources(self.directory)
        except (OSError, ValueError) as error:
            self._resource_event(now, "stop", "measurement", None, None, "resources could not be measured: " + repr(error))
            return
        self.last_resources = dict(reading, observed_now_ms=now)
        for resource in ("disk", "memory"):
            value = reading.get(resource + "_bytes")
            stop, warn = limits.get(resource + "_stop_bytes"), limits.get(resource + "_warn_bytes")
            if value is None:
                continue
            if stop is not None and value >= stop:
                self._resource_event(now, "stop", resource, value, stop, "{} {} bytes reached the stop limit {}".format(resource, value, stop))
            elif warn is not None and value >= warn and resource not in self._warned:
                self._warned.add(resource)
                self._resource_event(now, "warning", resource, value, warn, "{} {} bytes reached the warning limit {}".format(resource, value, warn))

    def _check_source(self):
        """A live capture file is written all the time, so its size and mtime always change: its identity is the FILE (device and inode).
        If the path now names another file, or none, the session is reading something it did not start on: halt (reason or None)."""
        try:
            now_identity = file_identity(self.source_path)
        except OSError as error:
            return "source_unreadable: " + repr(error)
        if now_identity != self.source_identity:
            return "source_replaced: the path no longer names the file the session started on (device/inode {} -> {})".format(
                self.source_identity, now_identity)
        return None

    def _check_clock(self, now):
        """Time must not run backwards and must not jump past the named bound between two steps. Returns the reason, or None. A clock
        anomaly is an insufficiency of continuity (rule 10D), not a Kraken outage: the caller HALTS durably (a restart needs the operator,
        BAL-DECISION-184-01 / 185-01) and nothing is reordered or corrected; positions, stops and risk are not touched."""
        guard, last, self._last_now = self.config.get("clock_guard"), self._last_now, now
        if not guard or last is None:
            return None
        if now < last:
            reason, detail = "clock_regression", "the clock went back {} ms".format(last - now)
        elif now - last > guard["max_forward_jump_ms"]:
            reason, detail = "clock_jump", "the clock jumped {} ms (bound {})".format(now - last, guard["max_forward_jump_ms"])
        else:
            return None
        self.clock_events.append({"kind": reason, "previous_now_ms": last, "observed_now_ms": now, "detail": detail})
        return reason + ": " + detail

    def _resource_event(self, now, kind, resource, value, limit, detail):
        self.resource_events.append({"kind": kind, "resource": resource, "value_bytes": value, "limit_bytes": limit,
                                     "observed_now_ms": now, "detail": detail})
        if kind == "stop":
            # The limit is always on record (and the exit status is 4) even if a SIGTERM got there first in the same step.
            self.stop_reason = self.stop_reason or "resource_limit:" + resource
            if not self.stop_requested:
                self.request_stop(None)

    # ---- run -------------------------------------------------------------------------------------------------
    def run(self, max_steps=None):
        """Steps until told to stop, until ``max_steps`` or until the decision window is over. Returns the exit code."""
        steps = 0
        while not self.stop_requested and (max_steps is None or steps < max_steps):
            now = self.clock()
            if self.config["decide_until_ms"] is not None and now >= self.config["decide_until_ms"] + POST_WINDOW_MS:
                break
            anomaly = self._check_clock(now)         # before the step: a bad instant is never stepped on
            if anomaly:
                return self._halt(now, anomaly)
            self.tick(now)
            anomaly = self._check_source()           # as late as possible: right before the step that reads the file
            if anomaly:
                return self._halt(now, anomaly)
            try:
                state = self.session.step(now)
            except Exception as error:               # noqa: BLE001
                return self._halt(now, repr(error))
            steps += 1
            self.phase = phase_of(self.session)
            self._check_resources(now, steps)
            try:
                self._beat(now, state)
            except OSError as error:                 # the supervisor cannot even say it is alive: that is a halt too
                return self._halt(now, "heartbeat: " + repr(error))
            self.sleep(self.config["step_interval_ms"] / 1000.0)
        code = self.end()
        return EXIT_RESOURCE_STOP if code == EXIT_OK and self.stop_reason else code

    def end(self):
        """Orderly end (decision D-186-1): pending orders are cancelled with their own reason, open positions are left as they are,
        and the report says so. A halted process never reports STOPPED, and ending twice writes nothing twice."""
        now = self.clock()
        if self.session.halted is not None or self.phase == HALTED:
            return self._halt(now, self.session.halted or "halted before the end")
        if self.phase == STOPPED_PHASE and self.session.stopped is not None and os.path.exists(os.path.join(self.directory, REPORT_FILE)):
            return EXIT_OK
        self.phase = STOPPING
        try:
            self._beat(now, None)
            self.session.stop(now)
        except Exception as error:               # noqa: BLE001
            return self._halt(now, repr(error))
        self.phase = STOPPED_PHASE
        try:
            self._finish(now)
        except OSError as error:
            return self._halt(now, "report: " + repr(error))
        return EXIT_OK

    def _close(self):
        if not self._closed:
            self._closed = True
            self.session.close()

    def _halt(self, now, reason):
        """The process cannot go on. The halt is made durable FIRST (``halt.json``), then the heartbeat and the report are tried: if the
        disk refuses them the exit status is still 3 and the next start still needs the operator."""
        self.phase = HALTED
        try:
            _write_json(os.path.join(self.directory, HALT_FILE), {"schema": "balancita-paper-live-halt.v1", "reason": reason,
                                                                   "session_id": self.session.identity["session_id"],
                                                                   "steps": self.session.stats["steps"], "observed_now_ms": now})
        except OSError:
            pass
        try:
            self._beat(now, None)
            self._finish(now, halted=reason)
        except OSError:
            pass
        finally:
            self._close()
        return EXIT_HALTED

    def abandon(self):
        """The process ends without an orderly stop (what a kill does, for a test or an exception): the lock goes with it."""
        self.session.runner.close()

    # ---- files -----------------------------------------------------------------------------------------------
    def _beat(self, now, state):
        session = self.session
        beat = {
            "schema": HEARTBEAT_SCHEMA, "session_id": session.identity["session_id"], "config_digest": self.config["digest"],
            "phase": self.phase, "pid": os.getpid(), "observed_now_ms": now, "steps": session.stats["steps"],
            "ingest_state": state, "runner_status": session.runner.status, "halted": session.halted,
            "pending_orders": len(session.runner.executor.pending), "open_positions": session.runner.portfolio.snapshot()["open_positions"]}
        if self.config.get("clock_guard"):
            beat["wall_ms"] = self.wall_time()                  # lets a supervisor tell a stuck process from a simulated clock
        if self.config.get("resource_limits"):
            beat["resources"] = {"last": self.last_resources, "events": self.resource_events}
        _write_json(os.path.join(self.directory, HEARTBEAT_FILE), beat)

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
        if self.config.get("clock_guard"):
            body["clock"] = {"events": self.clock_events}
        if self.config.get("resource_limits"):
            body["resources"] = {"last": self.last_resources, "events": self.resource_events, "stop_reason": self.stop_reason}
        if self.config["funding_mode"] == LI.OBSERVED_FUNDING:
            body["funding"] = session.funding_report()
        _write_json(os.path.join(self.directory, REPORT_FILE), body)
        self._beat(now, None)
        self._close()
        return body


def file_identity(path):
    """``(device, inode)`` of a regular file (symlinks followed, as the reader does). Raises ``OSError`` for anything else."""
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode):
        raise OSError("not a regular file: " + path)
    return (info.st_dev, info.st_ino)


def read_resources(directory):
    """Bytes in the session directory (every file, the runner's journals included) and the resident memory of this process now (Linux:
    ``/proc/self/statm``; elsewhere the peak, which only goes up and so stops sooner, never later)."""
    disk = 0

    def unreadable(error):                                   # os.walk would skip it and count 0 bytes: that is not a measurement
        raise error
    for root, _dirs, names in os.walk(directory, onerror=unreadable):
        for name in names:
            try:
                disk += os.lstat(os.path.join(root, name)).st_size
            except FileNotFoundError:                        # a temporary file replaced between the listing and the stat
                continue
    return {"disk_bytes": disk, "memory_bytes": _resident_bytes()}


def _resident_bytes():
    try:
        with open("/proc/self/statm", encoding="ascii") as handle:
            return int(handle.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak if sys.platform == "darwin" else peak * 1024


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
    """``preflight`` and ``run`` on the simulated clock. Exit status: 0 ok, 2 refused (no file was written), 3 halted, 4 stopped in order by a resource limit."""
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
    parser.add_argument("--restart", action="store_true", help="take up a directory whose last run did not end in order (halt, refusal, kill, power cut)")
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
    except (OSError, StoreError) as error:               # the directory or the source cannot be opened: refused, nothing was started
        print(json.dumps({"refused": "cannot_start", "detail": repr(error)}, sort_keys=True), file=sys.stderr)
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())
