"""Paper trading runner (stage 8A): coordination only, offline, isolated.

The runner receives events from an explicit source, orders and de-duplicates them, writes them to an append-only
hash-chained journal *before* applying them, and hands them to the components that already exist:

    cycle -> strategies (``signal_continuity.evaluate_cycle``) -> ``SignalLog`` -> decision -> ``TimedExecutor``
    quote / candle / clock -> ``TimedExecutor`` (-> ``QuoteWatch`` -> ``Portfolio`` -> ``Book`` -> ``futures_costs``)

It adds no trading, risk, cost or accounting rule. The durable truth is the journal of *inputs*; every financial state
is a pure function of it (``PaperRunner`` built from the same entries gives the same ``state_digest``). That is what
makes recovery a replay and keeps ``pickle`` and any serialised ``Book`` out of the design
(docs/paper-runner-arquitectura.md).

Stage 8A keeps the journal in memory (same entry layout as the file formats of stages 5-7; the file, checkpoints and
offsets arrive in 8B). Not connected to the forward, ``capture``, Kronos, Qwen, any database or any public feed; no
wall clock (every time is an argument), no network, no randomness, no credentials.
"""

from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation, getcontext

from . import signal_continuity as SC
from .execution_timing import SCHEMA as EXECUTION_SCHEMA, ExecutionPolicy, TimedExecutor
from .futures_costs import COST_MODEL_VERSION, cost_model_hash
from .multi_risk import RiskPolicy
from .multi_signals import BUY, SELL, stable_hash
from .portfolio import PORTFOLIO_SCHEMA, Portfolio, PortfolioPolicy
from .portfolio_audit import accounting_digest
from .portfolio_watch import SCHEMA as WATCH_SCHEMA, WatchPolicy

D = Decimal
JOURNAL_SCHEMA = "balancita-paper-runner-journal.v1"
REPORT_SCHEMA = "balancita-paper-runner-report.v1"
ONE_MINUTE_MS = 60_000
GENESIS = "0" * 64

# Event kinds the runner accepts from a source. ``reconstructed`` is evidence for the audit and never an order.
EVENT_KINDS = ("cycle", "quote", "candle", "clock", "reconstructed")
CREATED, PROCESSING, FINISHED, REFUSED = "CREATED", "PROCESSING", "FINISHED", "REFUSED"
# 8B/8C add RECOVERING, DEGRADED and STOPPED; SUSPENDED_ENTRIES is not a runner state but a flag derived from the
# portfolio (it only blocks new entries).
RUNNER_STATES = (CREATED, PROCESSING, FINISHED, REFUSED)


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

    def funding_map(self):
        return {product: [tuple(row) for row in rows] for product, rows in self.funding}


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
        "stop_policy": config.stop_policy,
        "risk_policy_hash": RiskPolicy().policy_hash(),      # stop/target levels (``multi_risk``), default policy
        "decimal_context": {"prec": getcontext().prec, "rounding": getcontext().rounding},
        "cost_model_version": COST_MODEL_VERSION, "cost_model_hash": cost_model_hash(),
        "funding_hash": stable_hash([[p, [[a, b, str(r)] for a, b, r in rows]] for p, rows in config.funding]),
        "policy_status": "execution, watch and gap policies are experimental hypotheses, not validated values",
    }


# ------------------------------------------------------------------------------------------------ events
def make_event(kind, payload, *, t_ms, source="synthetic", source_offset=None, event_id=None):
    """The envelope every source uses. ``t_ms`` is the arrival time; ``event_id`` identifies the event for
    de-duplication (default: a hash of what it says and where it came from)."""
    if kind not in EVENT_KINDS:
        raise ValueError("unknown event kind {!r}".format(kind))
    event = {"kind": kind, "t_ms": int(t_ms), "source": source, "source_offset": source_offset, "payload": payload}
    event["event_id"] = event_id or stable_hash(["event.v1", kind, source, source_offset, int(t_ms), payload])[:24]
    return event


def _check_event(event):
    if not isinstance(event, dict) or event.get("kind") not in EVENT_KINDS:
        return "invalid_event"
    if not isinstance(event.get("t_ms"), int) or isinstance(event["t_ms"], bool):
        return "invalid_event"
    if not isinstance(event.get("payload"), dict) or not isinstance(event.get("event_id"), str):
        return "invalid_event"
    return None


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


# ------------------------------------------------------------------------------------------------ the runner
class PaperRunner:
    def __init__(self, config, strategies, log, *, entries=None, evaluator=None):
        """New run when ``entries`` is ``None``; otherwise a recovery: the components are rebuilt by re-applying the
        journal ``entries`` (verified first). ``log`` is the durable ``SignalLog`` shared with the run that wrote them."""
        self.config, self.strategies, self.log = config, list(strategies), log
        self.evaluator = evaluator or minimal_evaluator
        self.portfolio = Portfolio(config.portfolio, funding=config.funding_map(), stop_policy=config.stop_policy)
        self.executor = TimedExecutor(self.portfolio, config.execution, watch=config.watch)
        self.status, self.clock = CREATED, None
        self.seen = {}               # event_id -> digest of its payload (accepted events only)
        self.candle_digest = {}      # (product, bucket) -> digest of the first candle accepted
        self.stats = {}
        self.submits = {}            # signal key -> result of the submission
        self.persisted = {}          # signal key -> reference to its SignalLog entry
        self.replaying = False
        if entries is None:
            for strategy in self.strategies:
                log.freeze_strategy(strategy, config.start_ms)
            self.manifest = manifest(config, log, self.strategies)
            self.journal = RunnerJournal()
            self._record(config.start_ms, "run_start", {"manifest": self.manifest, "manifest_hash": stable_hash(self.manifest)})
        else:
            self._recover(entries)

    # ---- journal ---------------------------------------------------------------------------------------------
    def _count(self, name, n=1):
        self.stats[name] = self.stats.get(name, 0) + n

    def _record(self, t_ms, kind, data):
        """Write-ahead: the entry is in the journal before any effect of it exists."""
        entry = self.journal.add(t_ms, kind, data)
        self._apply(entry)
        return entry

    def _recover(self, entries):
        broken = RunnerJournal.verify(entries)
        if broken is not None:
            self.status = REFUSED
            raise RunnerError("journal_corrupt", "chain broken at entry {}".format(broken))
        if not entries or entries[0]["kind"] != "run_start" or entries[0]["data"]["manifest"]["journal_schema"] != JOURNAL_SCHEMA:
            self.status = REFUSED
            raise RunnerError("journal_incompatible", "does not start with a run_start of this schema")
        self.manifest = manifest(self.config, self.log, self.strategies)
        if entries[0]["data"]["manifest_hash"] != stable_hash(self.manifest):
            self.status = REFUSED
            raise RunnerError("config_incompatible", "the configuration differs from the one the journal was written with")
        self.journal, self.replaying = RunnerJournal(), True
        for entry in entries:
            self.journal.entries.append(entry)
            self.journal.head = entry["hash"]
            self._apply(entry)
        self.replaying = False

    # ---- applying an entry (live and replay share this, and only this, path) ---------------------------------
    def _apply(self, entry):
        kind, data = entry["kind"], entry["data"]
        if kind == "run_start":
            self.status = PROCESSING
        elif kind == "event_accepted":
            event = data["event"]
            self.seen[event["event_id"]] = stable_hash(event["payload"])
            self.clock = event["t_ms"] if self.clock is None else max(self.clock, event["t_ms"])
            self._count("events_accepted")
            self._apply_market(event)
        elif kind == "event_rejected":
            self._count("events_rejected")
            self._count("rejected:" + data["reason"])
        elif kind == "signals_persisted":
            for ref in data["refs"]:
                stored = self.log.entries[ref["seq"] - 1] if ref["seq"] <= len(self.log.entries) else None
                if stored is None or stored["hash"] != ref["entry_hash"] or stored["data"]["key"] != ref["key"]:
                    raise RunnerError("signal_log_mismatch", "reference {} is not in the signal log".format(ref["key"]))
                self.persisted[ref["key"]] = ref
            self._count("signals_persisted", len(data["refs"]))
        elif kind == "decision":
            seq = self.persisted[data["signal_key"]]["seq"]
            result = self.executor.submit(self.log.entries[seq - 1], reference_price=data["reference_price"],
                                          atr=data["atr"], decided_ms=data["decided_ms"])
            self.submits[data["signal_key"]] = result["status"]
            self._count("decisions")
        # checkpoint / recovery entries (8B) carry no financial effect

    def _apply_market(self, event):
        kind, payload = event["kind"], event["payload"]
        if kind == "quote":
            self.executor.on_quote(payload)
        elif kind == "candle":
            product, bucket = payload["product_id"], int(payload["bucket_ms"])
            self.candle_digest[(product, bucket)] = stable_hash(payload["candle"])
            self.executor.on_candle(product, bucket, payload["candle"])
        elif kind == "clock":
            self.executor.advance(event["t_ms"])

    # ---- the single entry point for a source -----------------------------------------------------------------
    def handle(self, event):
        """Validates, orders and de-duplicates one event, records it and applies it. Returns ``{"status", ...}`` with
        status ``accepted`` | ``duplicate`` | ``conflict`` | ``rejected``. An event that is not accepted is journaled as
        ``event_rejected`` and changes no financial state."""
        if self.status not in (PROCESSING,):
            raise RunnerError("not_processing", self.status)
        why = _check_event(event)
        if why is not None:
            return self._reject(self.clock or 0, event, why)
        digest = stable_hash(event["payload"])
        known = self.seen.get(event["event_id"])
        if known is not None:
            return self._reject(event["t_ms"], event, "duplicate_event" if known == digest else "conflicting_event",
                                status="duplicate" if known == digest else "conflict")
        if self.clock is not None and event["t_ms"] < self.clock:
            return self._reject(event["t_ms"], event, "out_of_order_event")
        why = self._market_check(event)
        if why is not None:
            return self._reject(event["t_ms"], event, why)
        self._record(event["t_ms"], "event_accepted", {"event": event})
        if event["kind"] in ("cycle", "reconstructed"):
            self._signals(event)
        return {"status": "accepted", "event_id": event["event_id"]}

    def _reject(self, t_ms, event, reason, status="rejected"):
        ident = event.get("event_id") if isinstance(event, dict) else None
        self._record(t_ms, "event_rejected", {"event_id": ident, "kind": event.get("kind") if isinstance(event, dict) else None,
                                              "reason": reason, "event_hash": stable_hash(event)})
        return {"status": status, "reason": reason, "event_id": ident}

    def _market_check(self, event):
        kind, payload, t_ms = event["kind"], event["payload"], event["t_ms"]
        try:
            if kind == "candle":
                product, bucket = payload["product_id"], int(payload["bucket_ms"])
                if bucket + ONE_MINUTE_MS > t_ms:
                    return "candle_not_closed"
                digest = stable_hash(payload["candle"])
                seen = self.candle_digest.get((product, bucket))
                if seen is not None:
                    return "duplicate_candle" if seen == digest else "conflicting_candle"
                last = self.portfolio.last_bucket.get(product)
                if last is not None and bucket <= last:
                    return "late_candle"
            elif kind in ("cycle", "reconstructed"):
                cycle_ms = int(payload["cycle_ms"] if kind == "cycle" else payload["signal"]["bucket_ms"])
                if t_ms < cycle_ms:
                    return "candle_not_closed"
                if kind == "cycle":      # validated *before* the journal: an entry that cannot be applied would poison every replay
                    for field_name in ("price", "atr"):
                        if not isinstance(payload[field_name], str) or D(payload[field_name]) <= 0:
                            return "invalid_event"
                    if not isinstance(payload["product_id"], str):
                        return "invalid_event"
        except (KeyError, TypeError, ValueError, InvalidOperation):
            return "invalid_event"
        return None

    # ---- signals and decisions -------------------------------------------------------------------------------
    def _signals(self, event):
        payload, t_ms = event["payload"], event["t_ms"]
        offset = event.get("source_offset")
        if event["kind"] == "reconstructed":
            results = [(payload["signal"], payload["inputs"])]
            origin = "reconstructed"
        else:
            results = self.evaluator(self.strategies, payload)
            origin = "original"
        refs, actionable = [], []
        for signal, inputs in results:
            receipt = self.log.ingest(signal, inputs, t_ms, origin=origin, source_offset=offset)
            seq = receipt["seq"]
            if receipt["status"] in ("persisted", "duplicate", "already_present"):
                refs.append({"key": receipt["key"], "seq": seq, "entry_hash": self.log.entries[seq - 1]["hash"],
                             "origin": origin, "status": receipt["status"], "action": signal["action"]})
            if receipt["status"] == "persisted" and origin == "original" and signal["action"] in (BUY, SELL):
                actionable.append(receipt["key"])
        if refs:
            self._record(t_ms, "signals_persisted", {"event_id": event["event_id"], "refs": refs})
        for key in actionable:
            self._record(t_ms, "decision", {"signal_key": key, "decided_ms": t_ms,
                                            "reference_price": str(payload["price"]), "atr": str(payload["atr"])})

    # ---- lifecycle and reading -------------------------------------------------------------------------------
    def run(self, events):
        """Feeds a whole source in order. Returns the per-event results."""
        return [self.handle(event) for event in events]

    def finish(self, t_ms=None):
        self.status = FINISHED
        self._record(self.clock if t_ms is None else t_ms, "run_end", {"state_digest": self.state_digest()})

    def state_digest(self):
        """Everything the financial state and the order book are made of, in one hash."""
        return stable_hash({
            "accounting": accounting_digest(self.portfolio), "executor": self.executor.ledger_hash(),
            "watch": self.executor.watch.events_hash() if self.executor.watch else None,
            "pending": sorted((i, o["timeline"]) for i, o in self.executor.pending.items()),
            "seen": sorted(self.seen.items()), "candles": sorted((list(k), v) for k, v in self.candle_digest.items()),
            "stats": sorted(self.stats.items()), "clock": self.clock})

    def orders(self):
        """One row per order, with its state and the reason when it was refused (``observed`` facts of the executor)."""
        rows = [{"state": "pending", "intent_id": i, "product_id": o["product_id"], "strategy_id": o["strategy_id"],
                 "side": o["side"], "timeline": dict(o["timeline"])} for i, o in sorted(self.executor.pending.items())]
        for record in self.executor.records:
            expired = record["status"] == "rejected" and any(r in ("no_quote_in_window", "no_valid_quote_in_window")
                                                               for r in record.get("reasons", ()))
            rows.append({"state": "expired" if expired else record["status"], "intent_id": record["intent_id"],
                         "product_id": record["product_id"], "strategy_id": record["strategy_id"],
                         "side": record["side"], "reasons": record.get("reasons", []), "timeline": record["timeline"],
                         "record_id": record["record_id"]})
        return rows

    def report(self):
        return {"schema": REPORT_SCHEMA, "status": self.status, "clock_ms": self.clock,
                "labels": {"orders": "observed", "portfolio": "simulated", "policies": "experimental"},
                "orders": self.orders(), "portfolio": self.portfolio.snapshot(), "stats": dict(sorted(self.stats.items())),
                "journal": {"entries": len(self.journal.entries), "head": self.journal.head},
                "state_digest": self.state_digest()}
