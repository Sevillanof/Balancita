"""Paper trading runner (stages 8A-8B): coordination, durability and recovery; offline, isolated.

The runner receives events from an explicit source, orders and de-duplicates them, writes them to an append-only
hash-chained journal *before* applying them, and hands them to the components that already exist:

    cycle -> strategies (``signal_continuity.evaluate_cycle``) -> ``SignalLog`` -> decision -> ``TimedExecutor``
    quote / candle / clock -> ``TimedExecutor`` (-> ``QuoteWatch`` -> ``Portfolio`` -> ``Book`` -> ``futures_costs``)

It adds no trading, risk, cost or accounting rule. The durable truth is the journal of *inputs*; every financial state
is a pure function of it (``PaperRunner`` built from the same entries gives the same ``state_digest``). That is what
makes recovery a replay and keeps ``pickle`` and any serialised ``Book`` out of the design
(docs/paper-runner-arquitectura.md).

Stage 8B adds the file journal and checkpoint (``paper_runner_store``), the offset ledger, recovery in another process
and the obligations a crash leaves behind. Recovery is always a replay of the journal plus, separately, the work the
interrupted process owed (a signal not yet recorded, a decision not yet taken), done with the *recovery* clock: it never
writes into the past. Not connected to the forward, ``capture``, Kronos, Qwen, any database or any public feed; no
wall clock (every time is an argument), no network, no randomness, no credentials.
"""

import functools
import os
from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation, getcontext

from . import signal_continuity as SC
from .execution_timing import SCHEMA as EXECUTION_SCHEMA, ExecutionPolicy, TimedExecutor
from .futures_costs import COST_MODEL_VERSION, cost_model_hash
from .multi_risk import RiskPolicy
from .multi_signals import BUY, SELL, make_signal, stable_hash, validate_signal
from .paper_runner_store import (
    CHECKPOINT_FILE, JOURNAL_FILE, SIGNALS_FILE, DirectoryLock, FileRunnerJournal, OffsetLedger, StoreError, hit, quarantine,
    read_checkpoint, write_checkpoint,
)
from .portfolio import PORTFOLIO_SCHEMA, Portfolio, PortfolioPolicy
from .portfolio_audit import accounting_digest
from .portfolio_funding import ingest_funding, reconcile_funding
from .portfolio_watch import SCHEMA as WATCH_SCHEMA, WatchPolicy, parse_quote

D = Decimal
JOURNAL_SCHEMA = "balancita-paper-runner-journal.v3"
REPORT_SCHEMA = "balancita-paper-runner-report.v2"
ONE_MINUTE_MS = 60_000
GENESIS = "0" * 64

# Event kinds the runner accepts from a source. ``reconstructed`` is evidence for the audit and never an order.
EVENT_KINDS = ("cycle", "quote", "candle", "clock", "reconstructed", "gap_declared", "funding", "reconcile", "modelled_price")
# ``execution_mode``: "quotes" (stages 8A-8C: orders fill on observed quotes) or "modelled" (stage 9A replay: orders fill on a
# price the replay driver models from candles, delivered as ``modelled_price``; observed quotes are refused in this mode).
EXECUTION_MODES = ("quotes", "modelled")
CREATED, PROCESSING, RECOVERING, FINISHED, REFUSED = "CREATED", "PROCESSING", "RECOVERING", "FINISHED", "REFUSED"
# 8C adds DEGRADED and STOPPED; SUSPENDED_ENTRIES is not a runner state but a flag derived from the portfolio (it only
# blocks new entries).
RUNNER_STATES = (CREATED, PROCESSING, RECOVERING, FINISHED, REFUSED)
ENGINE_BEHAVIOR_VERSION = "balancita-paper-engine.1"
# Offsets that are marked processed when their event is rejected (the journal holds the rejection). Not these: a repeat
# of an event still being processed, or an offset another event already took.
_MARKS_OFFSET = frozenset({"out_of_order_event", "candle_not_closed", "invalid_candle", "invalid_quote", "late_candle",
                           "duplicate_candle", "conflicting_candle", "evaluation_failed", "invalid_event"})


class RunnerError(Exception):
    """The runner cannot continue safely. ``reason`` is a stable code; nothing is repaired silently."""

    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


# ------------------------------------------------------------------------------------------------ configuration
@dataclass(frozen=True)
class RunnerConfig:
    """Every policy the run depends on. The approved risk parameters stay in ``PortfolioPolicy`` (never changed here).
    ``ExecutionPolicy``, ``WatchPolicy`` and ``stop_policy`` are experimental hypotheses, not validated values."""
    portfolio: PortfolioPolicy = field(default_factory=PortfolioPolicy)
    execution: ExecutionPolicy = field(default_factory=ExecutionPolicy)
    watch: WatchPolicy = field(default_factory=WatchPolicy)
    stop_policy: str = "level"
    funding: tuple = ()          # ((product, ((start_ms, end_ms, rate), ...)), ...) known when the run starts
    start_ms: int = 0
    coverage_gap_ms: int = 120_000   # experimental hypothesis: longer without a quote while a position is open = unobserved
    execution_mode: str = "quotes"

    def funding_map(self):
        return {product: [tuple(row) for row in rows] for product, rows in self.funding}


@functools.lru_cache(maxsize=1)
def engine_behavior():
    """Versioned identification of how the engine behaves (decision D3). A fixed synthetic scenario (a LONG that hits its
    target and a SHORT that hits its stop) is run through ``TimedExecutor`` -> ``Portfolio`` -> ``Book`` ->
    ``futures_costs`` and the resulting ledgers are hashed. Any change of cost, sizing, fill or exit behaviour changes
    the fingerprint, so a journal written by other behaviour is refused as ``engine_behavior_changed`` instead of being
    replayed into a different state. Source code is not hashed: a refactor that keeps behaviour keeps the id."""
    cycle = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
    funding = {p: [(cycle - 2 * 3_600_000, cycle + 48 * 3_600_000, "0")] for p in ("PF_XBTUSD", "PF_ETHUSD")}
    cases = (("PF_XBTUSD", "BUY", "100000", "1000", ("103500", "100000")), ("PF_ETHUSD", "SELL", "3500", "70", ("3700", "3499")))
    digests = []
    for number, (product, action, price, atr, (high, low)) in enumerate(cases, start=1):
        executor = TimedExecutor(Portfolio(PortfolioPolicy(), funding=funding, stop_policy="level"), ExecutionPolicy(), WatchPolicy())
        signal = make_signal(strategy_id="fingerprint", strategy_version=1, product_id=product, bucket_ms=cycle, action=action,
                             strength="0.8", horizon_minutes=60, evidence={"x": "1"})
        entry = {"seq": number, "t_ms": cycle + 2_000, "kind": "signal", "data": {
            "key": "fp{}".format(number), "origin": "original", "executable": True, "signal": signal, "cycle_ms": cycle,
            "generated_ms": cycle + 2_000, "valid_until_ms": cycle + 300_000}}
        executor.submit(entry, reference_price=price, atr=atr, decided_ms=cycle + 2_000)
        mid = D(price)
        executor.on_quote({"product_id": product, "time_ms": cycle + 5_000, "received_ms": cycle + 5_000,
                           "bid": str(mid * D("0.99995")), "ask": str(mid * D("1.00005"))})
        executor.on_candle(product, cycle, {"open": price, "high": price, "low": price, "close": price})
        executor.on_candle(product, cycle + 60_000, {"open": price, "high": high, "low": low, "close": price})
        digests.append([accounting_digest(executor.portfolio), executor.ledger_hash(), len(executor.portfolio.trades)])
    fingerprint = stable_hash(digests)[:16]
    return {"version": ENGINE_BEHAVIOR_VERSION, "fingerprint": fingerprint}


BUILD_IDENTITY_VERSION = "balancita-paper-build.1"
# The modules whose code decides money, fills, costs, funding, risk levels or signals. Their bytes (line endings
# normalised) are the build identity: a journal is only replayed by the code that wrote it.
BUILD_MODULES = ("execution_timing", "futures_costs", "futures_simulator", "multi_risk", "multi_signals", "portfolio",
                 "portfolio_audit", "portfolio_funding", "portfolio_watch", "signal_continuity")


@functools.lru_cache(maxsize=1)
def build_identity():
    """Versioned identity of the financial code (decision D3, second layer). It complements ``engine_behavior``: the
    synthetic scenarios only see the paths they exercise, the build identity sees *any* change in these modules."""
    here = os.path.dirname(os.path.abspath(__file__))
    modules = {}
    for name in BUILD_MODULES:
        with open(os.path.join(here, name + ".py"), "rb") as handle:
            modules[name] = stable_hash(handle.read().replace(b"\r\n", b"\n").decode("utf-8"))[:16]
    return {"version": BUILD_IDENTITY_VERSION, "modules": modules, "digest": stable_hash(modules)[:16]}


def manifest(config, log, strategies):
    """What a recovery must find unchanged. Any difference is a refusal, never a silent continuation."""
    frozen = {}
    for strategy in strategies:
        fingerprint = log.frozen.get((strategy.id, strategy.version))
        frozen["{}@{}".format(strategy.id, strategy.version)] = list(fingerprint) if fingerprint else None
    return {
        "journal_schema": JOURNAL_SCHEMA, "signal_log_schema": SC.LOG_SCHEMA, "execution_schema": EXECUTION_SCHEMA,
        "watch_schema": WATCH_SCHEMA, "portfolio_schema": PORTFOLIO_SCHEMA,
        "strategies": frozen,
        "portfolio_policy": asdict(config.portfolio), "portfolio_policy_hash": config.portfolio.policy_hash(),
        "execution_policy": asdict(config.execution), "execution_policy_hash": config.execution.policy_hash(),
        "watch_policy": asdict(config.watch), "watch_policy_hash": config.watch.policy_hash(),
        "stop_policy": config.stop_policy, "coverage_gap_ms": config.coverage_gap_ms,
        "risk_policy_hash": RiskPolicy().policy_hash(),      # stop/target levels (``multi_risk``), default policy
        "decimal_context": {"prec": getcontext().prec, "rounding": getcontext().rounding},
        "cost_model_version": COST_MODEL_VERSION, "cost_model_hash": cost_model_hash(),
        "funding_hash": stable_hash([[p, [[a, b, str(r)] for a, b, r in rows]] for p, rows in config.funding]),
        "engine_behavior": engine_behavior(),
        "build_identity": build_identity(),
        "offset_identity": "source|stream|epoch",
        **({"execution_mode": config.execution_mode} if config.execution_mode != "quotes" else {}),
        "policy_status": "execution, watch and gap policies are experimental hypotheses, not validated values",
    }


# ------------------------------------------------------------------------------------------------ events
def make_event(kind, payload, *, t_ms, source="synthetic", stream="main", source_offset=None, source_epoch=0, event_id=None):
    """The envelope every source uses. ``t_ms`` is the arrival time; ``event_id`` identifies the event for
    de-duplication (default: a hash of what it says and where it came from)."""
    if kind not in EVENT_KINDS:
        raise ValueError("unknown event kind {!r}".format(kind))
    event = {"kind": kind, "t_ms": int(t_ms), "source": source, "stream": stream, "source_offset": source_offset,
             "source_epoch": source_epoch, "payload": payload}
    event["event_id"] = event_id or stable_hash(["event.v2", kind, source, stream, source_epoch, source_offset, int(t_ms), payload])[:24]
    return event


def _check_event(event):
    if not isinstance(event, dict) or event.get("kind") not in EVENT_KINDS:
        return "invalid_event"
    if not isinstance(event.get("t_ms"), int) or isinstance(event["t_ms"], bool):
        return "invalid_event"
    if not isinstance(event.get("payload"), dict) or not isinstance(event.get("event_id"), str):
        return "invalid_event"
    offset = event.get("source_offset")
    epoch = event.get("source_epoch", 0)
    if not _valid_name(event.get("source")) or not _valid_name(event.get("stream")) \
            or (offset is not None and (not isinstance(offset, int) or isinstance(offset, bool))):
        return "invalid_event"
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        return "invalid_event"
    return None


def _valid_name(name):
    """A source or stream name: a non-empty string without the characters the canonical identity uses as separators."""
    return isinstance(name, str) and bool(name) and "|" not in name and "#" not in name


def valid_candle(candle):
    """A closed OHLC candle: four finite positive Decimals with ``low <= open, close <= high``. ``Portfolio`` reads these
    four fields, so anything else must never reach the journal."""
    try:
        o, h, l, c = (D(str(candle[k])) for k in ("open", "high", "low", "close"))   # noqa: E741
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return False
    if not all(x.is_finite() and x > 0 for x in (o, h, l, c)):
        return False
    return l <= min(o, c) and h >= max(o, c)




class RunnerJournal:
    """Append-only, hash-chained list of entries ``{seq, t_ms, kind, data, prev, hash}`` (in memory in 8A)."""

    def __init__(self, entries=None):
        self.entries, self.head = [], GENESIS
        for entry in entries or ():
            self.entries.append(entry)
            self.head = entry["hash"]

    def add(self, t_ms, kind, data):
        body = {"seq": len(self.entries) + 1, "t_ms": int(t_ms), "kind": kind, "data": SC._plain(data), "prev": self.head}
        body["hash"] = stable_hash(body)
        self.entries.append(body)
        self.head = body["hash"]
        return body

    @staticmethod
    def verify(entries):
        """``None`` when the chain is intact, else the first broken sequence number."""
        prev = GENESIS
        for number, entry in enumerate(entries, start=1):
            body = {k: v for k, v in entry.items() if k != "hash"}
            if entry.get("seq") != number or body.get("prev") != prev or stable_hash(body) != entry.get("hash"):
                return number
            prev = entry["hash"]
        return None




# ------------------------------------------------------------------------------------------------ evaluation
def minimal_evaluator(strategies, payload):
    """The frame a scripted or simple strategy needs; real strategies plug their own feature pipeline here."""
    cycle_ms = int(payload["cycle_ms"])
    frame = (cycle_ms - ONE_MINUTE_MS, {}, None, {"candidate_close": payload["price"]}, {})
    return SC.evaluate_cycle(strategies, payload["product_id"], cycle_ms, frame)


def _manifest_diff(stored, current):
    return sorted(k for k in set(stored) | set(current) if stored.get(k) != current.get(k))


# ------------------------------------------------------------------------------------------------ the runner
class PaperRunner(object):
    def __init__(self, config, strategies, log, *, entries=None, journal=None, evaluator=None, directory=None,
                 checkpoint=None):
        """New run when ``entries`` is ``None``; otherwise a recovery: the components are rebuilt by re-applying the
        journal ``entries`` (verified first, and against ``checkpoint`` when given). ``log`` is the durable ``SignalLog``
        shared with the run that wrote them. ``journal``: where entries are written (default: in memory)."""
        self.config, self.strategies, self.log = config, list(strategies), log
        self.evaluator = evaluator or minimal_evaluator
        self.directory = directory
        self.lock = None
        self.closed = False         # a durable runner that released its lock never writes again
        self.portfolio = Portfolio(config.portfolio, funding=config.funding_map(), stop_policy=config.stop_policy)
        if config.execution_mode not in EXECUTION_MODES:
            raise RunnerError("invalid_execution_mode", repr(config.execution_mode))
        if config.execution_mode == "modelled":
            from .replay_execution import ModelledExecutor      # imported late: the replay layer reads the runner, never the reverse
            self.executor = ModelledExecutor(self.portfolio, config.execution)
        else:
            self.executor = TimedExecutor(self.portfolio, config.execution, watch=config.watch)
        self.status, self.clock = CREATED, None
        self.seen = {}               # event_id -> digest of its payload (accepted events only)
        self.candle_digest = {}      # (product, bucket) -> digest of the first candle accepted
        self.stats = {}
        self.submits = {}            # signal key -> result of the submission
        self.persisted = {}          # signal key -> reference to its SignalLog entry
        self.offsets = OffsetLedger()
        self.open_cycles = {}        # event_id -> a cycle (or reconstructed) event whose signals/decisions are not all recorded
        self.decision_owner = {}     # signal key -> event_id of the cycle that must decide it
        self.cycles_seen = set()     # (product, cycle_ms) of every accepted cycle
        self.open_funding = {}       # event_id -> funding/reconcile event whose reconciliation entry is not recorded yet
        self.quote_t_ms = {}         # product -> journal time (t_ms) of the last quote delivered: the clock a source loss is measured in
        self.source_losses = {}      # (product, gap_from_ms, gap_to_ms) -> {"intent_ids": [...], "windows": {intent_id: [lo, hi]}}
        self.coverage = {"last_quote": {}, "watch": {}, "candles": {}, "gaps": []}     # market coverage while positions are open (observed facts)
        self.recoveries, self.last_recovery, self.last_checkpoint = 0, None, None
        self.replaying = False
        if entries is None:
            for strategy in self.strategies:
                log.freeze_strategy(strategy, config.start_ms)
            self.manifest = manifest(config, log, self.strategies)
            self.journal = journal if journal is not None else RunnerJournal()
            self._record(config.start_ms, "run_start", {"manifest": self.manifest, "manifest_hash": stable_hash(self.manifest)})
        else:
            self._recover(entries, journal, checkpoint)

    # ---- journal ---------------------------------------------------------------------------------------------
    def _count(self, name, n=1):
        self.stats[name] = self.stats.get(name, 0) + n

    def _guard_open(self):
        if self.closed:
            raise RunnerError("runner_closed", "this instance released the single-writer lock and can no longer write")

    def _record(self, t_ms, kind, data):
        """Write-ahead: the entry is in the journal before any effect of it exists."""
        self._guard_open()
        entry = self.journal.add(t_ms, kind, data)
        self._apply(entry)
        hit("after_apply", kind)
        return entry

    def _refuse(self, reason, detail=""):
        self.status = REFUSED
        raise RunnerError(reason, detail)

    def _recover(self, entries, journal, checkpoint):
        broken = RunnerJournal.verify(entries)
        if broken is not None:
            self._refuse("journal_corrupt", "chain broken at entry {}".format(broken))
        if not entries or entries[0]["kind"] != "run_start" or entries[0]["data"]["manifest"]["journal_schema"] != JOURNAL_SCHEMA:
            self._refuse("journal_incompatible", "does not start with a run_start of this schema")
        self.manifest = manifest(self.config, self.log, self.strategies)
        stored = entries[0]["data"]["manifest"]
        if entries[0]["data"]["manifest_hash"] != stable_hash(self.manifest):
            diff = _manifest_diff(stored, self.manifest)
            if "build_identity" in diff:
                reason = "build_incompatible"
            elif diff == ["engine_behavior"]:
                reason = "engine_behavior_changed"
            else:
                reason = "config_incompatible"
            self._refuse(reason, "differs in: " + ", ".join(diff))
        ended = [e["seq"] for e in entries if e["kind"] == "run_end"]
        if ended and ended[0] != len(entries):
            self._refuse("journal_incompatible", "entries after run_end (seq {})".format(ended[0]))
        if checkpoint is not None:
            at = checkpoint["upto_seq"]
            if at > len(entries):
                self._refuse("journal_behind_checkpoint", "checkpoint at {}, journal has {}".format(at, len(entries)))
            if entries[at - 1]["hash"] != checkpoint["journal_hash"] or entries[0]["hash"] != checkpoint.get("journal_start_hash", entries[0]["hash"]):
                self._refuse("checkpoint_mismatch", "the checkpoint does not belong to this journal")
            if checkpoint["manifest_hash"] != entries[0]["data"]["manifest_hash"] or \
                    checkpoint["engine_behavior_id"] != engine_behavior_id() or \
                    checkpoint.get("build_identity") != build_identity()["digest"]:
                self._refuse("checkpoint_incompatible", "manifest or engine behaviour differ")
        self.journal = journal if journal is not None else RunnerJournal(entries)
        self.replaying = True
        for entry in entries:
            self._apply(entry)
            if checkpoint is not None and entry["seq"] == checkpoint["upto_seq"]:
                if self.state_digest() != checkpoint["state_digest"] or self.financial_digest() != checkpoint.get("financial_digest"):
                    self._refuse("replay_diverged", "the replay does not reproduce the digests of the checkpoint")
        self.replaying = False
        if checkpoint is not None and checkpoint.get("signal_log_entries"):
            n = checkpoint["signal_log_entries"]
            if len(self.log.entries) < n or self.log.entries[n - 1]["hash"] != checkpoint["signal_log_hash"]:
                self._refuse("signal_log_behind_checkpoint", "the signal log is shorter or different")
        self.last_checkpoint = checkpoint
        self._check_signal_log()

    def _check_signal_log(self):
        """I14: every signal of the log is explained by an event the journal accepted. Anything else is an orphan."""
        pending_reconstructed = set()
        for c in self.open_cycles.values():
            if c["event"]["kind"] == "reconstructed":
                s = c["event"]["payload"]["signal"]
                pending_reconstructed.add(SC.signal_key(s["strategy_id"], s["strategy_version"], s["product_id"], s["bucket_ms"]))
        for entry in self.log.signals():
            d = entry["data"]
            if d["origin"] == "original":
                explained = (d["product_id"], d["cycle_ms"]) in self.cycles_seen
            else:
                explained = d["key"] in self.persisted or d["key"] in pending_reconstructed
            if not explained:
                self._refuse("orphan_signal", "signal log entry {} has no accepted event in the journal".format(entry["seq"]))

    # ---- applying an entry (live and replay share this, and only this, path) ---------------------------------
    def _apply(self, entry):
        kind, data = entry["kind"], entry["data"]
        if kind == "run_start":
            self.status = PROCESSING
        elif kind == "run_end":
            self.status = FINISHED
        elif kind == "event_accepted":
            self._accepted(data["event"], entry["t_ms"])
        elif kind == "event_rejected":
            self._count("events_rejected")
            self._count("rejected:" + data["reason"])
            if data.get("mark_offset"):
                line, epoch, offset = (data["source"], data["stream"]), data["source_epoch"], data["source_offset"]
                self.offsets.observe(line, epoch, offset, data["event_id"])
                self.offsets.process(line, epoch, offset)
        elif kind == "signals_persisted":
            for ref in data["refs"]:
                stored = self.log.entries[ref["seq"] - 1] if ref["seq"] <= len(self.log.entries) else None
                if stored is None or stored["hash"] != ref["entry_hash"] or stored["data"]["key"] != ref["key"]:
                    self._refuse("signal_log_mismatch", "reference {} is not in the signal log".format(ref["key"]))
                self.persisted[ref["key"]] = ref
            self._count("signals_persisted", len(data["refs"]))
            cycle = self.open_cycles.get(data["event_id"])
            if cycle is not None:
                cycle["signals_persisted"] = True
                cycle["actionable"] = list(data["actionable"])
                cycle["undecided"] = set(data["actionable"])
                for key in data["actionable"]:
                    self.decision_owner[key] = data["event_id"]
                self._maybe_close(data["event_id"])
        elif kind == "decision":
            seq = self.persisted[data["signal_key"]]["seq"]
            result = self.executor.submit(self.log.entries[seq - 1], reference_price=data["reference_price"],
                                          atr=data["atr"], decided_ms=data["decided_ms"])
            self.submits[data["signal_key"]] = result["status"]
            self._count("decisions")
            owner = self.decision_owner.get(data["signal_key"])
            if owner in self.open_cycles:
                self.open_cycles[owner]["undecided"].discard(data["signal_key"])
                self._maybe_close(owner)
        elif kind == "reconciliation":
            made = reconcile_funding(self.portfolio, data["now_ms"])
            self._count("funding_adjustments", len(made))
            self._count("reconciliations")
            item = self.open_funding.pop(data["event_id"], None)
            if item is not None and item["stream"] is not None:
                self.offsets.process(*item["stream"])
        elif kind == "source_loss":
            key = (data["product_id"], data["gap_from_ms"], data["gap_to_ms"])
            self.source_losses[key] = {"intent_ids": list(data["intent_ids"]), "windows": {k: list(v) for k, v in data["windows"].items()}}
            self._count("source_losses")
        elif kind == "order_cancelled":
            extra = {"recovery_ms": data["recovery_ms"]} if "recovery_ms" in data else {}
            record = self.executor.cancel(data["intent_id"], data["reason"], entry["t_ms"],
                                          uncovered_from_ms=data["uncovered_from_ms"], uncovered_to_ms=data["uncovered_to_ms"],
                                          **extra)
            self._count("orders_cancelled" if record is not None else "cancel_without_order")
        elif kind == "recovery":
            self.clock = data["recovery_ms"] if self.clock is None else max(self.clock, data["recovery_ms"])
            self.recoveries += 1
            self.last_recovery = {k: data[k] for k in ("recovery_ms", "journal_clock_ms", "uncovered_ms", "obligations",
                                                        "interrupted_orders", "open_positions", "tail_discarded_bytes")}
            self.coverage["gaps"].extend(data.get("coverage_gaps", ()))
            self._count("recoveries")

    def _accepted(self, event, t_ms):
        kind, payload = event["kind"], event["payload"]
        self.seen[event["event_id"]] = stable_hash(payload)
        self.clock = event["t_ms"] if self.clock is None else max(self.clock, event["t_ms"])
        self._count("events_accepted")
        stream = self._stream_of(event)
        if stream is not None:
            self.offsets.observe(stream[0], stream[1], stream[2], event["event_id"])
        if kind == "gap_declared":
            self.offsets.declare((payload["source"], payload["stream"]), payload["epoch"], payload["from_offset"], payload["to_offset"],
                                 payload["reason"], payload["evidence"], payload["operator"], event["t_ms"])
            self._count("gaps_declared")
        if kind in ("cycle", "reconstructed"):
            self.open_cycles[event["event_id"]] = {"event": event, "t_ms": event["t_ms"], "stream": stream,
                                                   "signals_persisted": False, "actionable": [], "undecided": set()}
            if kind == "cycle":
                self.cycles_seen.add((payload["product_id"], int(payload["cycle_ms"])))
        elif kind in ("funding", "reconcile"):
            self.open_funding[event["event_id"]] = {"event": event, "stream": stream}
        elif stream is not None:
            self.offsets.process(stream[0], stream[1], stream[2])
        self._apply_market(event)

    def _open_snapshot(self):
        """Who is open right now: ``product -> (intent_id, entry_ms, entry_bucket_ms)``."""
        out = {}
        for product, book in self.portfolio.positions.items():
            if book.position is not None:
                out[product] = (book.intent["intent_id"], int(book.position.get("entry_ms", book.position["opened_at"])),
                                int(book.position.get("opened_bucket", 0)))
        return out

    def _watch_record(self, product, intent_id, entry_ms):
        return self.coverage["watch"].setdefault(intent_id, {"product_id": product, "entry_ms": entry_ms, "quotes": 0,
                                                              "last_ms": entry_ms, "silences": []})

    def _note_silence(self, record, since, now):
        """Every silence longer than the threshold between two moments of watch evidence is kept by itself, apart from the
        gap list: the audit later demands that the recorded gaps cover it."""
        if now - since > self.config.coverage_gap_ms:
            record["silences"].append([since, now])

    def _record_gap(self, product, intent_id, since, now):
        known = [g["to_ms"] for g in self.coverage["gaps"] if g["intent_id"] == intent_id]
        since = max([since] + known)             # a silence already recorded (an interruption) is not counted twice
        if now - since > self.config.coverage_gap_ms:
            self.coverage["gaps"].append({"product_id": product, "from_ms": since, "to_ms": now, "kind": "quote_gap",
                                          "intent_id": intent_id})

    def _note_quote(self, quote, before):
        """A quote is evidence that a stop was watched only if ``QuoteWatch`` accepted it for that position (after the
        entry, in order, not covered by a candle). Whatever the watch ignored proves nothing. A silence longer than
        ``coverage_gap_ms`` between two evidenced moments is recorded as a fact and never filled in later."""
        product, now = quote["product_id"], int(quote["time_ms"])
        self.coverage["last_quote"][product] = max(self.coverage["last_quote"].get(product, 0), now)
        if product not in before or self.executor.watch is None:
            return
        intent_id, entry_ms, _ = before[product]
        state = self.executor.watch.state.get(product)
        record = self._watch_record(product, intent_id, entry_ms)
        if state is None or state["intent_id"] != intent_id or state["quotes"] <= record["quotes"]:
            return                               # ignored by the watch: it did not watch anything
        self._note_silence(record, record["last_ms"], now)
        self._record_gap(product, intent_id, record["last_ms"], now)
        record["quotes"], record["last_ms"] = state["quotes"], now

    def _note_candle(self, product, bucket, before):
        """A processed candle after the entry minute covers [bucket, bucket + 1 min]; it is evidence of its own kind."""
        if product not in before:
            return
        intent_id, _, entry_bucket = before[product]
        if bucket < entry_bucket + 60_000:
            return                               # the entry minute never evaluates the stop
        ranges = self.coverage["candles"].setdefault(intent_id, [])
        if ranges and ranges[-1][1] == bucket:
            ranges[-1][1] = bucket + 60_000
        elif not ranges or bucket >= ranges[-1][1]:
            ranges.append([bucket, bucket + 60_000])
        else:
            ranges.append([bucket, bucket + 60_000])
            ranges.sort()
            merged = [ranges[0]]
            for lo, hi in ranges[1:]:
                if lo <= merged[-1][1]:
                    merged[-1][1] = max(merged[-1][1], hi)
                else:
                    merged.append([lo, hi])
            self.coverage["candles"][intent_id] = merged

    def _settle_closed(self, before):
        """A position that closed keeps its coverage history: the silence between the last evidence and the close is
        recorded now, so closing never erases the warning."""
        after = self._open_snapshot()
        for product, (intent_id, entry_ms, _) in before.items():
            if after.get(product, (None,))[0] == intent_id:
                continue
            trade = next((t for t in self.portfolio.trades if t["intent_id"] == intent_id), None)
            if trade is not None:
                record = self._watch_record(product, intent_id, entry_ms)
                exit_ms = int(trade["exit_time_ms"])
                self._note_silence(record, record["last_ms"], exit_ms)
                self._record_gap(product, intent_id, record["last_ms"], exit_ms)
                if record["quotes"] == 0 and not any(g["intent_id"] == intent_id for g in self.coverage["gaps"]):
                    # never watched by a single quote: living less than the threshold does not make it observed
                    self.coverage["gaps"].append({"product_id": product, "from_ms": entry_ms, "to_ms": exit_ms,
                                                  "kind": "no_watched_quotes", "intent_id": intent_id})

    @staticmethod
    def _stream_of(event):
        offset = event.get("source_offset")
        return None if offset is None else ((event["source"], event["stream"]), event.get("source_epoch", 0), offset)

    def _maybe_close(self, event_id):
        """A cycle is processed (its offset may be confirmed) only when its signals and all its decisions are recorded."""
        cycle = self.open_cycles.get(event_id)
        if cycle is not None and cycle["signals_persisted"] and not cycle["undecided"]:
            if cycle["stream"] is not None:
                self.offsets.process(*cycle["stream"])
            del self.open_cycles[event_id]

    def _apply_market(self, event):
        kind, payload = event["kind"], event["payload"]
        if kind == "quote":
            before = self._open_snapshot()
            self.quote_t_ms[payload["product_id"]] = max(self.quote_t_ms.get(payload["product_id"], 0), event["t_ms"])
            self.executor.on_quote(payload)
            self._note_quote(payload, before)
            self._settle_closed(before)
        elif kind == "modelled_price":
            before = self._open_snapshot()
            self.executor.on_modelled_price(dict(payload, time_ms=event["t_ms"]))
            self._settle_closed(before)
        elif kind == "funding":
            counts = ingest_funding(self.portfolio, payload["product_id"], payload["periods"], received_ms=event["t_ms"],
                                    source=event["source"])
            for name, number in counts.items():
                self._count("funding_" + name, number)
        elif kind == "candle":
            product, bucket = payload["product_id"], int(payload["bucket_ms"])
            self.candle_digest[(product, bucket)] = stable_hash({k: str(payload["candle"][k]) for k in ("open", "high", "low", "close")})
            before = self._open_snapshot()
            self.executor.on_candle(product, bucket, payload["candle"])
            self._note_candle(product, bucket, before)
            self._settle_closed(before)
        elif kind == "clock":
            before = self._open_snapshot()
            self.executor.advance(event["t_ms"])
            self._settle_closed(before)

    # ---- the single entry point for a source -----------------------------------------------------------------
    def handle(self, event):
        """Validates, orders and de-duplicates one event, records it and applies it. Returns ``{"status", ...}`` with
        status ``accepted`` | ``duplicate`` | ``conflict`` | ``rejected``. An event that is not accepted is journaled as
        ``event_rejected`` and changes no financial state."""
        self._guard_open()
        if self.status != PROCESSING:
            raise RunnerError("not_processing", self.status)
        why = _check_event(event)
        if why is not None:
            return self._reject(self.clock or 0, event, why)
        digest = stable_hash(event["payload"])
        known = self.seen.get(event["event_id"])
        if known is not None:
            return self._reject(event["t_ms"], event, "duplicate_event" if known == digest else "conflicting_event",
                                status="duplicate" if known == digest else "conflict")
        stream = self._stream_of(event)
        if stream is not None:
            if self.offsets.stale_epoch(stream[0], stream[1]):
                return self._reject(event["t_ms"], event, "stale_epoch")
            if self.offsets.reused(stream[0], stream[1], stream[2], event["event_id"]):
                return self._reject(event["t_ms"], event, "offset_reused")
        if self.clock is not None and event["t_ms"] < self.clock:
            return self._reject(event["t_ms"], event, "out_of_order_event")
        why = self._market_check(event)
        if why is not None:
            return self._reject(event["t_ms"], event, why)
        results = None
        if event["kind"] in ("cycle", "reconstructed"):
            results = self._evaluate(event)
            if isinstance(results, str):
                return self._reject(event["t_ms"], event, results)
        self._record(event["t_ms"], "event_accepted", {"event": event})
        if results is not None:
            self._persist_and_decide(event, results, event["t_ms"])
        if event["kind"] in ("funding", "reconcile"):
            self._reconcile(event, event["t_ms"])
        return {"status": "accepted", "event_id": event["event_id"]}

    def _reject(self, t_ms, event, reason, status="rejected"):
        valid = isinstance(event, dict)
        offset = event.get("source_offset") if valid else None
        offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else None
        source = event.get("source") if valid else None
        stream = event.get("stream") if valid else None
        epoch = event.get("source_epoch", 0) if valid else 0
        line = (source, stream)
        mark = (reason in _MARKS_OFFSET and offset is not None and _valid_name(source) and _valid_name(stream)
                and isinstance(epoch, int) and not isinstance(epoch, bool) and epoch >= 0
                and not self.offsets.stale_epoch(line, epoch)
                and not self.offsets.reused(line, epoch, offset, event.get("event_id")))
        self._record(t_ms, "event_rejected", {"event_id": event.get("event_id") if valid else None,
                                              "kind": event.get("kind") if valid else None, "reason": reason,
                                              "event_hash": stable_hash(event), "source": source, "stream": stream, "source_offset": offset,
                                              "source_epoch": epoch, "mark_offset": mark})
        return {"status": status, "reason": reason, "event_id": event.get("event_id") if valid else None}

    def _market_check(self, event):
        """Everything that could make applying the event fail is decided here, before the journal: an accepted entry
        that cannot be applied would poison every replay."""
        kind, payload, t_ms = event["kind"], event["payload"], event["t_ms"]
        try:
            if kind == "quote":
                if self.config.execution_mode == "modelled":
                    return "quote_not_allowed_in_modelled_mode"     # no observed or synthetic quote reaches the watch in a replay
                try:
                    parse_quote(payload)
                except ValueError:
                    return "invalid_quote"
            elif kind == "modelled_price":
                if self.config.execution_mode != "modelled":
                    return "invalid_event"
                if not isinstance(payload["product_id"], str) or not isinstance(payload["source"], str) \
                        or not isinstance(payload["scenario"], str) or not D(str(payload["price"])).is_finite() \
                        or D(str(payload["price"])) <= 0:
                    return "invalid_event"
            elif kind == "candle":
                product, bucket = payload["product_id"], payload["bucket_ms"]
                if not isinstance(product, str) or not isinstance(bucket, int) or isinstance(bucket, bool):
                    return "invalid_event"
                if not valid_candle(payload["candle"]):
                    return "invalid_candle"
                if bucket % ONE_MINUTE_MS or bucket + ONE_MINUTE_MS > t_ms:
                    return "candle_not_closed" if bucket % ONE_MINUTE_MS == 0 else "invalid_event"
                digest = stable_hash({k: str(payload["candle"][k]) for k in ("open", "high", "low", "close")})
                seen = self.candle_digest.get((product, bucket))
                if seen is not None:
                    return "duplicate_candle" if seen == digest else "conflicting_candle"
                last = self.portfolio.last_bucket.get(product)
                if last is not None and bucket <= last and not self._entry_minute_candle(product, bucket):
                    return "late_candle"
            elif kind == "cycle":
                cycle_ms = payload["cycle_ms"]
                if not isinstance(payload["product_id"], str) or not isinstance(cycle_ms, int) or isinstance(cycle_ms, bool):
                    return "invalid_event"
                if t_ms < cycle_ms:
                    return "candle_not_closed"
                for field_name in ("price", "atr"):
                    if not isinstance(payload[field_name], str) or not D(payload[field_name]).is_finite() \
                            or D(payload[field_name]) <= 0:
                        return "invalid_event"
            elif kind == "reconstructed":
                signal = validate_signal(payload["signal"])
                if not isinstance(payload["inputs"], dict) or (signal["strategy_id"], signal["strategy_version"]) not in self.log.frozen:
                    return "invalid_event"
                if t_ms < signal["bucket_ms"]:
                    return "candle_not_closed"
            elif kind == "gap_declared":
                return self._gap_check(payload)
            elif kind == "funding":
                periods = payload["periods"]
                if not isinstance(payload["product_id"], str) or not isinstance(periods, list) \
                        or any(not isinstance(p, (list, tuple)) for p in periods):
                    return "invalid_event"
            elif kind == "reconcile":
                return None
        except (KeyError, TypeError, ValueError, InvalidOperation):
            return "invalid_event"
        return None

    def _entry_minute_candle(self, product, bucket):
        """True for the candle of the minute a modelled order entered on: the replay executor resolves that minute (the
        portfolio never shows a position the candle it entered on), so the runner must let the candle through once."""
        accepts = getattr(self.executor, "accepts_entry_minute_candle", None)
        return bool(accepts and accepts(product, bucket))

    def _gap_check(self, payload):
        source, stream, epoch, lo, hi = (payload["source"], payload["stream"], payload["epoch"], payload["from_offset"],
                                         payload["to_offset"])
        texts = (payload["reason"], payload["evidence"], payload["operator"])
        ints = (epoch, lo, hi)
        if not _valid_name(source) or not _valid_name(stream) or any(not isinstance(x, str) or not x.strip() for x in texts) \
                or any(not isinstance(x, int) or isinstance(x, bool) for x in ints) or lo > hi or epoch < 0:
            return "invalid_event"
        if not any(a <= lo and hi <= b for a, b in self.offsets.missing((source, stream), epoch)):
            return "gap_not_a_hole"      # only offsets that are really missing can be declared, never processed ones
        return None

    # ---- signals and decisions -------------------------------------------------------------------------------
    def _evaluate(self, event):
        """The strategies' answer for a cycle (or the reconstructed signal), checked *before* the event is journaled.
        A string is a rejection reason. Evaluation is not part of replay: replay reads the persisted signals."""
        payload = event["payload"]
        if event["kind"] == "reconstructed":
            return [(payload["signal"], payload["inputs"])]
        try:
            results = list(self.evaluator(self.strategies, payload))
            for signal, inputs in results:
                validate_signal(signal)
                if (signal["strategy_id"], signal["strategy_version"]) not in self.log.frozen or not isinstance(inputs, dict):
                    return "evaluation_failed"
        except Exception:    # a strategy that raises or answers badly rejects the event; it never reaches the journal
            return "evaluation_failed"
        return results

    def _persist_and_decide(self, event, results, t_ms):
        """Signals first (durable in the ``SignalLog``), then their references, then one decision per actionable signal.
        ``t_ms`` is the arrival time live and the *recovery* time when this finishes work a crash interrupted."""
        payload, offset = event["payload"], event.get("source_offset")
        origin = "reconstructed" if event["kind"] == "reconstructed" else "original"
        refs, actionable = [], []
        for signal, inputs in results:
            receipt = self.log.ingest(signal, inputs, t_ms, origin=origin, source_offset=offset)
            if receipt["status"] not in ("persisted", "duplicate", "already_present"):
                continue
            seq = receipt["seq"]
            stored = self.log.entries[seq - 1]["data"]
            refs.append({"key": receipt["key"], "seq": seq, "entry_hash": self.log.entries[seq - 1]["hash"],
                         "origin": stored["origin"], "status": receipt["status"], "action": signal["action"]})
            if origin == "original" and stored["origin"] == "original" and signal["action"] in (BUY, SELL) \
                    and receipt["key"] not in self.persisted and receipt["key"] not in actionable:
                actionable.append(receipt["key"])
        self._record(t_ms, "signals_persisted", {"event_id": event["event_id"], "refs": refs, "actionable": actionable})
        for key in actionable:
            self._decide(key, payload, t_ms)

    def _reconcile(self, event, now_ms):
        """Late funding is applied in two durable steps (the event, then its reconciliation), so a crash between them
        leaves a visible obligation. ``reconcile_funding`` recomputes from the accepted periods and acts only when the
        covered time grew: doing it twice, here or after a recovery, adjusts nothing twice."""
        self._record(now_ms, "reconciliation", {"event_id": event["event_id"], "now_ms": int(now_ms)})

    def _decide(self, key, payload, t_ms):
        self._record(t_ms, "decision", {"signal_key": key, "decided_ms": t_ms,
                                        "reference_price": str(payload["price"]), "atr": str(payload["atr"])})

    # ---- source continuity lost while an order waited (D-10C-3) ----------------------------------------------
    def cancel_for_source_loss(self, product_id, gap_from_ms, gap_to_ms, t_ms):
        """Cancels the pending orders of ``product_id`` whose execution window overlaps ``[gap_from_ms, gap_to_ms]`` (the time
        the source lost continuity), with the reason ``source_stale``. Returns the ids of the orders the loss affects.

        * Only pending orders of that product whose window overlaps the gap are touched; an order that already filled,
          expired or was cancelled, another product, open positions (their stops) and the risk rules are not.
        * A new declaration needs ``t_ms >= gap_to_ms``: the interruption is declared once its end is known
          (``source_loss_before_gap_end`` otherwise). A declaration already persisted is repeated with any ``t_ms``.
        * It must happen before the quote that ends the gap is delivered: after it the order may already have been judged
          on that quote, so the call is refused (``source_loss_after_quote``). The gap bounds are in the journal clock
          (``t_ms`` of the events); the check compares them with both the journal time and the ``time_ms`` of the last
          quote delivered, whichever is later.
        * An order whose earliest fill falls inside the gap is cancelled too, even if it was decided during the gap
          (conservative: nobody was watching the source while it waited).
        * Idempotent by ``(product_id, gap_from_ms, gap_to_ms)``: the loss is a journal entry written before any
          cancellation, so a repeated call, or a recovery that finds the entry with orders still pending, cancels each
          order once and returns the same ids.
        * The cancellation is the executor's own (``cancel``) and each one is an ``order_cancelled`` entry, as in
          ``runner_interrupted``; nothing else of the book changes."""
        self._guard_open()
        if self.status != PROCESSING:
            raise RunnerError("not_processing", self.status)
        if self.config.execution_mode != "quotes":
            raise RunnerError("source_loss_not_applicable", "orders fill on modelled prices, not on a source of quotes")
        if not isinstance(product_id, str) or not product_id:
            raise RunnerError("source_loss_invalid", "product_id")
        for name, value in (("gap_from_ms", gap_from_ms), ("gap_to_ms", gap_to_ms), ("t_ms", t_ms)):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise RunnerError("source_loss_invalid", name)
        if gap_to_ms <= gap_from_ms:
            raise RunnerError("source_loss_invalid", "gap_to_ms must be after gap_from_ms")
        key = (product_id, gap_from_ms, gap_to_ms)
        known = self.source_losses.get(key)
        if known is None:
            if self.clock is not None and t_ms < self.clock:
                raise RunnerError("source_loss_in_the_past", "t_ms {} is before the runner clock {}".format(t_ms, self.clock))
            if t_ms < gap_to_ms:
                raise RunnerError("source_loss_before_gap_end",
                                  "t_ms {} is before the end of the gap {}: an interruption is not complete until its end is observed"
                                  .format(t_ms, gap_to_ms))
            # the gap is measured in journal time (``t_ms``, when the source persisted the quote), which can be later than the
            # quote's own ``time_ms``: a quote delivered at either time at or after the end of the gap closes the window
            last = max(self.executor.last_quote_ms.get(product_id, 0), self.quote_t_ms.get(product_id, 0))
            if last >= gap_to_ms and last > 0:
                raise RunnerError("source_loss_after_quote",
                                  "a quote at {} was already delivered; the gap ended at {}".format(last, gap_to_ms))
            affected, windows = [], {}
            for intent_id, order in sorted(self.executor.pending.items()):
                if order["product_id"] != product_id:
                    continue
                lo = max(gap_from_ms, order["timeline"]["earliest_fill_ms"])
                hi = min(gap_to_ms, order["timeline"]["deadline_ms"])
                if hi > lo:
                    affected.append(intent_id)
                    windows[intent_id] = [lo, hi]
            self._record(max(t_ms, self.journal.entries[-1]["t_ms"] if self.journal.entries else 0), "source_loss", {"product_id": product_id, "gap_from_ms": gap_from_ms, "gap_to_ms": gap_to_ms,
                                               "intent_ids": affected, "windows": windows})
            known = self.source_losses[key]
        for intent_id in known["intent_ids"]:
            if intent_id in self.executor.pending:
                lo, hi = known["windows"][intent_id]
                self._record(max(t_ms, self.journal.entries[-1]["t_ms"]), "order_cancelled",
                             {"intent_id": intent_id, "reason": "source_stale", "uncovered_from_ms": lo, "uncovered_to_ms": hi})
        return list(known["intent_ids"])

    def _finish_source_losses(self, recovery_ms):
        """A process that died between the ``source_loss`` entry and the cancellations it announced: the recovery finishes them."""
        for key, loss in sorted(self.source_losses.items()):
            for intent_id in loss["intent_ids"]:
                if intent_id in self.executor.pending:
                    lo, hi = loss["windows"][intent_id]
                    self._record(recovery_ms, "order_cancelled", {"intent_id": intent_id, "reason": "source_stale",
                                                                  "uncovered_from_ms": lo, "uncovered_to_ms": hi,
                                                                  "recovery_ms": recovery_ms})

    # ---- recovery (8B) ---------------------------------------------------------------------------------------
    def _begin_recovery(self, recovery_ms, tail_discarded=0, rebuilt_checkpoint=None):
        """After the replay: what the interrupted process owed is paid with the recovery clock.

        * a pending order whose execution window overlaps the time nobody was watching is cancelled
          (``runner_interrupted``): it neither gets a fresh, more favourable window nor is its expiry blamed on the market;
        * a cycle whose signals were not recorded is evaluated again and the signals are persisted *now*;
        * a recorded signal that was never decided is decided *now* (``guard_entry`` refuses it if its window passed).
        Nothing is ever written with an earlier time than the recovery's."""
        before = self.clock if self.clock is not None else self.journal.entries[0]["t_ms"]
        if recovery_ms < before:
            self._refuse("recovery_clock_behind", "recovery at {} but the journal reached {}".format(recovery_ms, before))
        self.status = RECOVERING
        self._finish_source_losses(recovery_ms)
        interrupted = []
        for intent_id, order in sorted(self.executor.pending.items()):
            lo = max(before, order["timeline"]["earliest_fill_ms"])
            hi = min(recovery_ms, order["timeline"]["deadline_ms"])
            if hi > lo:
                interrupted.append({"intent_id": intent_id, "uncovered_from_ms": lo, "uncovered_to_ms": hi})
        obligations = []
        for event_id, c in sorted(self.open_cycles.items(), key=lambda kv: (kv[1]["t_ms"], kv[0])):
            if not c["signals_persisted"]:
                obligations.append({"event_id": event_id, "obligation": "signals_not_recorded"})
            else:
                obligations.extend({"event_id": event_id, "obligation": "decision_pending", "signal_key": k}
                                   for k in c["actionable"] if k in c["undecided"])
        obligations.extend({"event_id": event_id, "obligation": "reconciliation_pending"}
                           for event_id in sorted(self.open_funding))
        self._record(recovery_ms, "recovery", {
            "recovery_ms": recovery_ms, "journal_clock_ms": before, "uncovered_ms": recovery_ms - before,
            "tail_discarded_bytes": tail_discarded, "obligations": obligations, "interrupted_orders": interrupted,
            "open_positions": sorted(self.portfolio.positions), "checkpoint_rebuilt": rebuilt_checkpoint,
            "coverage_gaps": self._interruption_gaps(before, recovery_ms)})
        for item in interrupted:
            self._record(recovery_ms, "order_cancelled", dict(item, reason="runner_interrupted", recovery_ms=recovery_ms))
        for event_id in sorted(self.open_funding):         # accounting first: nothing new is decided on stale capital
            self._reconcile(self.open_funding[event_id]["event"], recovery_ms)
        for event_id, c in sorted(self.open_cycles.items(), key=lambda kv: (kv[1]["t_ms"], kv[0])):
            event = c["event"]
            if not c["signals_persisted"]:
                results = self._evaluate(event)
                if isinstance(results, str):
                    self._refuse("recovery_evaluation_failed", results)
                self._persist_and_decide(event, results, recovery_ms)
            else:
                for key in [k for k in c["actionable"] if k in c["undecided"]]:
                    self._decide(key, event["payload"], recovery_ms)
        self.status = PROCESSING

    def _interruption_gaps(self, before, recovery_ms):
        """Every open position was unobserved while the process was down: no quote proves its stop was safe."""
        if recovery_ms <= before:
            return []
        gaps = []
        for product, book in sorted(self.portfolio.positions.items()):
            entry = int(book.position.get("entry_ms", book.position["opened_at"]))
            watched = self.coverage["watch"].get(book.intent["intent_id"], {}).get("last_ms", entry)
            known = [g["to_ms"] for g in self.coverage["gaps"] if g["intent_id"] == book.intent["intent_id"]]
            since = max([watched, entry] + known)    # from the last evidence, not from the last journal entry
            if recovery_ms > since:
                gaps.append({"product_id": product, "from_ms": since, "to_ms": recovery_ms, "kind": "runner_interrupted",
                             "intent_id": book.intent["intent_id"]})
        return gaps

    @classmethod
    def create(cls, directory, config, strategies, *, evaluator=None):
        """A new durable run in an empty ``directory``: signal log, journal and a first checkpoint."""
        lock = _lock(directory)
        try:
            log = SC.SignalLog.create(os.path.join(directory, SIGNALS_FILE), config.start_ms)
            journal = FileRunnerJournal.create(os.path.join(directory, JOURNAL_FILE))
            runner = cls(config, strategies, log, journal=journal, evaluator=evaluator, directory=directory)
            runner.lock = lock
            runner.checkpoint()
        except BaseException:
            lock.release()
            raise
        return runner

    @classmethod
    def recover(cls, directory, config, strategies, recovery_ms, *, evaluator=None, bad_checkpoint="refuse"):
        """Rebuilds a run from its directory, in this or another process. Refuses (``RunnerError`` with a stable reason)
        a damaged or foreign journal, signal log or checkpoint, another configuration or engine behaviour, a checkpoint
        the replay does not reproduce, and signals no accepted event explains. ``bad_checkpoint="rebuild"`` is the
        explicit operator action after a damaged checkpoint: the file is kept as evidence, the journal replayed in full
        and a new checkpoint written."""
        if not os.path.isdir(directory):
            raise RunnerError("journal_missing", directory)
        lock = _lock(directory)         # before reading anything: a second opener must not touch a single byte
        try:
            runner = cls._recover_dir(directory, config, strategies, recovery_ms, evaluator, bad_checkpoint, lock)
        except BaseException:
            lock.release()
            raise
        return runner

    @classmethod
    def _recover_dir(cls, directory, config, strategies, recovery_ms, evaluator, bad_checkpoint, lock):
        paths = {name: os.path.join(directory, name) for name in (JOURNAL_FILE, CHECKPOINT_FILE, SIGNALS_FILE)}
        try:
            journal = FileRunnerJournal.load(paths[JOURNAL_FILE])
        except StoreError as error:
            raise RunnerError(error.reason, str(error))
        try:
            log = SC.SignalLog.load(paths[SIGNALS_FILE])
        except SC.ContinuityError as error:
            raise RunnerError("signal_log_" + error.reason, str(error))
        checkpoint, rebuilt = None, None
        try:
            checkpoint = read_checkpoint(paths[CHECKPOINT_FILE])
        except StoreError as error:
            kept = quarantine(directory, paths[CHECKPOINT_FILE], error.reason)
            if bad_checkpoint != "rebuild":
                raise RunnerError(error.reason, "evidence kept in " + kept)
            rebuilt = {"reason": error.reason, "evidence": os.path.basename(kept)}
        if checkpoint is None and rebuilt is None and len(journal.entries) > 1:
            raise RunnerError("checkpoint_missing", "the journal has entries but no checkpoint")
        runner = cls(config, strategies, log, entries=journal.entries, journal=journal, evaluator=evaluator,
                     directory=directory, checkpoint=checkpoint)
        runner.lock = lock
        if runner.status != FINISHED:
            runner._begin_recovery(recovery_ms, journal.tail_discarded, rebuilt)
            runner.checkpoint()
        return runner

    def close(self):
        """Releases the single-writer lock. The process dying does the same; this is for orderly shutdowns and tests.
        Idempotent. A durable instance is disabled for writing for good (another process may now own the directory);
        reading (``report``, digests) still works. An in-memory runner has no lock and is not affected."""
        if self.lock is not None:
            self.closed = True
            self.lock.release()
            self.lock = None

    # ---- checkpoint ------------------------------------------------------------------------------------------
    def checkpoint(self):
        """Writes the verification checkpoint for everything durable so far (the journal entries are already on disk)."""
        self._guard_open()
        if self.directory is None:
            raise RunnerError("no_directory", "this runner is not durable")
        entries = self.journal.entries
        body = {"upto_seq": len(entries), "journal_hash": self.journal.head, "journal_start_hash": entries[0]["hash"],
                "manifest_hash": entries[0]["data"]["manifest_hash"], "engine_behavior_id": engine_behavior_id(), "build_identity": build_identity()["digest"],
                "state_digest": self.state_digest(), "financial_digest": self.financial_digest(),
                "confirmable_offsets": self.offsets.confirmable(), "signal_log_entries": len(self.log.entries),
                "signal_log_hash": self.log.head}
        write_checkpoint(os.path.join(self.directory, CHECKPOINT_FILE), body)
        self.last_checkpoint = body
        return body

    # ---- lifecycle and reading -------------------------------------------------------------------------------
    def run(self, events):
        """Feeds a whole source in order. Returns the per-event results."""
        return [self.handle(event) for event in events]

    def declare_gap(self, source, stream, epoch, from_offset, to_offset, *, reason, evidence, operator, t_ms):
        """The operator's durable statement that a range of offsets will not arrive (decision D8)."""
        return self.handle(make_event("gap_declared", {"source": source, "stream": stream, "epoch": epoch, "from_offset": from_offset,
                                                       "to_offset": to_offset, "reason": reason, "evidence": evidence,
                                                       "operator": operator}, t_ms=t_ms, source="operator"))

    def finish(self, t_ms=None):
        """Ends the session durably: ``run_end`` is replayed, so a recovered session stays ``FINISHED``."""
        self._guard_open()
        if self.status != PROCESSING:
            raise RunnerError("not_processing", self.status)
        self._record(self.clock if t_ms is None else t_ms, "run_end", {"state_digest": self.state_digest()})

    def financial_digest(self):
        """The financial result and the order book, without counters, offsets or journal position: two runs that reach
        the same state through different histories (a crash, a redelivery) have the same one."""
        return stable_hash({"accounting": accounting_digest(self.portfolio), "executor": self.executor.ledger_hash(),
                            "pending": sorted((i, o["timeline"]) for i, o in self.executor.pending.items()),
                            "positions": sorted(b.intent["intent_id"] for b in self.portfolio.positions.values())})

    def state_digest(self):
        """Everything the financial state, the order book and the offsets are made of, in one hash."""
        return stable_hash({
            "financial": self.financial_digest(),
            "watch": self.executor.watch.events_hash() if self.executor.watch else None,
            "seen": sorted(self.seen.items()), "candles": sorted((list(k), v) for k, v in self.candle_digest.items()),
            "offsets": self.offsets.summary(), "open_cycles": sorted(self.open_cycles),
            "open_funding": sorted(self.open_funding), "coverage": self.coverage,
            "stats": sorted(self.stats.items()), "clock": self.clock,
            **({"source_losses": sorted((list(k), v) for k, v in self.source_losses.items())} if self.source_losses else {})})

    def operational_digest(self):
        """The operational state (what the runner will accept next), apart from the financial one."""
        return stable_hash({"status": self.status, "clock": self.clock, "journal_head": self.journal.head,
                            "entries": len(self.journal.entries), "stats": sorted(self.stats.items())})

    def orders(self):
        """One row per order, with its state and the reason when it was refused (``observed`` facts of the executor)."""
        rows = [{"state": "pending", "intent_id": i, "product_id": o["product_id"], "strategy_id": o["strategy_id"],
                 "side": o["side"], "timeline": dict(o["timeline"])} for i, o in sorted(self.executor.pending.items())]
        for record in self.executor.records:
            reasons = record.get("reasons", ())
            state = record["status"]
            if state == "rejected" and ("runner_interrupted" in reasons or "source_stale" in reasons):
                state = "cancelled"
            elif state == "rejected" and any(r in ("no_quote_in_window", "no_valid_quote_in_window") for r in reasons):
                state = "expired"
            rows.append({"state": state, "intent_id": record["intent_id"], "product_id": record["product_id"],
                         "strategy_id": record["strategy_id"], "side": record["side"], "reasons": list(reasons),
                         "timeline": record["timeline"], "record_id": record["record_id"]})
        return rows

    def integrity(self):
        return {"last_checkpoint": None if self.last_checkpoint is None else {
                    k: self.last_checkpoint[k] for k in ("upto_seq", "journal_hash", "state_digest")},
                "journal_entries": len(self.journal.entries), "unprocessed_events": len(self.open_cycles) + len(self.open_funding),
                "open_cycles": sorted(self.open_cycles), "open_funding": sorted(self.open_funding), "confirmable_offsets": self.offsets.confirmable(),
                "offset_holes": self.offsets.holes_count(), "offsets": self.offsets.summary(),
                "recoveries": self.recoveries, "last_recovery": self.last_recovery}

    def report(self):
        """The versioned read contract (``paper_runner_report.observability``) plus the flat legacy keys of 8A/8B."""
        from .paper_runner_report import observability      # imported late: the report reads the runner, never the reverse
        out = observability(self)
        out.update({"status": self.status, "clock_ms": self.clock, "orders": self.orders(),
                    "portfolio": self.portfolio.snapshot(), "stats": dict(sorted(self.stats.items())),
                    "integrity": self.integrity(), "journal": {"entries": len(self.journal.entries), "head": self.journal.head},
                    "state_digest": self.state_digest()})
        return out


def _lock(directory):
    try:
        return DirectoryLock(directory)
    except StoreError as error:
        raise RunnerError(error.reason, str(error))


def engine_behavior_id():
    behavior = engine_behavior()
    return "{}:{}".format(behavior["version"], behavior["fingerprint"])
