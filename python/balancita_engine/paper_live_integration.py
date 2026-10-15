"""Stage 10D: the offline integration of the session circuit.

    synthetic SQLite -> SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner -> Portfolio -> journals -> recovery

Nothing here is a strategy, an indicator or a financial rule. It only wires the pieces that already exist (9A replay pipeline,
10B ingestor, 10C evaluator, the 8x runner) and makes the wiring durable and checkable:

* one directory per session with four durable records and one checkpoint, all bound to the same ``session_id``:
  ``runner/`` (the runner's own journal, signal log and checkpoint), ``evaluator.jsonl`` (the evaluator's input log),
  ``audit.jsonl`` (this module's evidence journal) and ``session-checkpoint.json`` (ingestor state + cursors + the heads of the
  three journals), plus ``session.json`` (the immutable identity of the session);
* the order of one step is the whole protocol: poll -> deliver (evaluator input log first, runner journal after) -> audit
  evidence -> checkpoint. The checkpoint is therefore never ahead of any journal, and everything a crash leaves undone is
  re-derived from source rows that the older checkpoint will read again; every event has a deterministic id, so a repeat is a
  ``duplicate_event`` for the runner and a ``duplicate`` for the evaluator, never a second effect;
* funding has two separate channels that share nothing: ``fundpct`` rows feed the evaluator's percentile line (the signal's
  input) and ``accrual`` rows reach the runner as ``funding`` events (the accounting of open positions).

No wall clock, no network, no process: the caller decides when to ``step``. ``FaultInjected`` exists only so the tests can
kill the "process" at a named point.
"""

import json
import os
import sqlite3

from . import paper_live_evaluator as LE
from .multi_signals import stable_hash
from .paper_live_ingest import GAP_SAMPLE, SILENCE_SAMPLE, Ingestor, SourceReader
from .paper_runner import STOPPED, PaperRunner, RunnerError, make_event
from .paper_runner_store import CHECKPOINT_FILE as RUNNER_CHECKPOINT_FILE
from .paper_runner_store import JOURNAL_FILE as RUNNER_JOURNAL_FILE
from .paper_runner_store import DirectoryLock, FileRunnerJournal, StoreError, read_checkpoint

SCHEMA = "balancita-paper-live-session.v1"
CHECKPOINT_SCHEMA = "balancita-paper-live-session-checkpoint.v1"
AUDIT_SCHEMA = "balancita-paper-live-audit.v1"
SESSION_FILE, CHECKPOINT_FILE = "session.json", "session-checkpoint.json"
EVALUATOR_FILE, AUDIT_FILE, RUNNER_DIR = "evaluator.jsonl", "audit.jsonl", "runner"
GENESIS = "0" * 64
FUNDING_SOURCE = "synthetic-funding"
HOUR_MS = 3_600_000
FUNDING_RANK = 0                         # a funding event goes before a market event at the same instant (as in the replay)
POINTS = ("after_poll", "before_handle", "input_logged", "after_evaluation", "after_runner", "after_audit", "after_runner_checkpoint",
          "checkpoint_tmp_written", "after_checkpoint")


class IntegrationError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


class FaultInjected(BaseException):
    """A simulated process death. ``BaseException`` so that no ``except Exception`` of the pipeline can swallow it."""


# ------------------------------------------------------------------------------------------------ the audit journal
class AuditJournal(object):
    """Append-only, hash-chained, ``fsync`` per entry, and **idempotent**: a record is identified by the hash of its content
    (no wall clock in it), so writing the same evidence again after a crash is a no-op. Evidence is never lost (it is on disk
    before the checkpoint that stops re-deriving it) and never duplicated."""

    def __init__(self, path):
        self.path, self.head, self.entries, self.ids, self.tail_discarded = path, GENESIS, [], set(), 0
        self.failed = None                  # set by the first write the disk refused: nothing more is appended from this instance

    @classmethod
    def create(cls, path, header):
        journal = cls(path)
        if os.path.exists(path):
            raise IntegrationError("audit_exists", path)
        journal._write("header", dict(header, schema=AUDIT_SCHEMA))
        return journal

    @classmethod
    def open(cls, path):
        journal = cls(path)
        with open(path, "rb") as handle:
            raw = handle.read()
        lines = raw.split(b"\n")
        if lines and lines[-1] == b"":
            lines.pop()
        elif lines:                                     # no final newline: the last write was cut by a crash
            lines.pop()
            journal.tail_discarded = 1
        if journal.tail_discarded:
            with open(path, "wb") as handle:             # keep only the complete lines, so the next append starts clean
                handle.write(b"".join(line + b"\n" for line in lines))
                handle.flush()
                os.fsync(handle.fileno())
        for number, line in enumerate(lines, 1):
            try:
                entry = json.loads(line.decode("utf-8"))
                body = {k: entry[k] for k in ("seq", "kind", "data", "prev")}
                ok = entry["seq"] == number and entry["prev"] == journal.head and entry["hash"] == stable_hash(body)
            except (ValueError, KeyError, TypeError, UnicodeDecodeError):
                ok = False
            if not ok:
                raise IntegrationError("audit_corrupt", "line {}".format(number))
            journal.entries.append(entry)
            journal.head = entry["hash"]
            if entry["kind"] == "audit":
                journal.ids.add(entry["data"]["record_id"])
        if not journal.entries or journal.entries[0]["kind"] != "header" or journal.entries[0]["data"].get("schema") != AUDIT_SCHEMA:
            raise IntegrationError("audit_header", path)
        return journal

    def _write(self, kind, data):
        if self.failed is not None:
            raise IntegrationError("audit_write_failed", self.failed)
        body = {"seq": len(self.entries) + 1, "kind": kind, "data": data, "prev": self.head}
        entry = dict(body, hash=stable_hash(body))
        try:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as error:
            # memory may now be behind the file (a cut line, or a full one that was never synced): nothing may be appended after
            # it from this instance, and the record is not remembered as written; the next open() cuts a torn tail
            self.failed = repr(error)
            raise IntegrationError("audit_write_failed", self.failed) from error
        self.entries.append(entry)
        self.head = entry["hash"]
        return entry

    def add(self, record):
        """Writes ``record`` unless the same evidence is already there. Returns ``True`` when it was new."""
        record_id = stable_hash(record)[:20]
        if record_id in self.ids:
            return False
        self._write("audit", {"record_id": record_id, "record": record})
        self.ids.add(record_id)             # only once it is on disk: a refused write must not make the evidence look written
        return True

    def records(self):
        return [e["data"]["record"] for e in self.entries if e["kind"] == "audit"]


# ------------------------------------------------------------------------------------------------ funding channels
class FundingSource(object):
    """The two separate funding channels of a synthetic source, each with its own table and cursor.

    * ``synthetic_fundpct(product_id, start_ms, rate, arrival_ms)``: the hourly rates the evaluator's percentile line uses.
    * ``synthetic_accrual(product_id, start_ms, end_ms, rate, arrival_ms)``: the funding periods the runner applies to open
      positions through its existing accounting (``funding`` events).

    They are never joined, never derived from each other and never share a cursor: changing one cannot change the other."""

    def __init__(self, path):
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.db.execute("PRAGMA query_only=ON")
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def fundpct(self, after, limit=5000):
        return [dict(r) for r in self.db.execute(
            "SELECT rowid AS rid, product_id, start_ms, rate, arrival_ms FROM synthetic_fundpct WHERE rowid>? ORDER BY rowid LIMIT ?",
            (after, limit))]

    def accrual(self, after, limit=5000):
        return [dict(r) for r in self.db.execute(
            "SELECT rowid AS rid, product_id, start_ms, end_ms, rate, arrival_ms FROM synthetic_accrual WHERE rowid>? ORDER BY rowid LIMIT ?",
            (after, limit))]


def accrual_event(row):
    return make_event("funding", {"product_id": row["product_id"], "periods": [[row["start_ms"], row["end_ms"], row["rate"]]]},
                      t_ms=row["arrival_ms"], source=FUNDING_SOURCE, stream="funding:" + row["product_id"])


# ------------------------------------------------------------------------------------------------ the policy for stale sources
def stale_quote_gaps(quote_times, max_gap_ms):
    """Pure: the intervals in which a product's quotes had a hole longer than ``max_gap_ms`` (the continuity limit), from the
    observed quote times (sorted). It does not rely on the 45 s outage of the ingestor, which a 26 s cut never reaches."""
    return [{"from_ms": a, "to_ms": b} for a, b in zip(quote_times, quote_times[1:]) if b - a > max_gap_ms]


def affected_orders(pending, gaps_by_product, max_gap_ms=None):
    """Pure: the pending orders (``executor.pending`` shape) whose execution window overlaps a continuity hole of their own
    product (the overlap rule of ``PaperRunner.cancel_for_source_loss``). Decision D-10-01 = B plus D-17-19: with
    ``max_gap_ms`` (the continuity threshold) an order whose deadline is not after ``gap.from_ms + max_gap_ms`` (equality
    included) was over before the silence became excessive, so its ``action`` is ``expire`` (it ends with the executor's own
    expiry reason); any other is ``cancel`` (``source_stale``). Open positions are not affected."""
    out = []
    for intent_id, order in sorted(pending.items()):
        line = order["timeline"]
        for gap in gaps_by_product.get(order["product_id"], ()):
            if gap["from_ms"] < line["deadline_ms"] and gap["to_ms"] > line["earliest_fill_ms"]:
                action = "cancel"
                if max_gap_ms is not None and line["deadline_ms"] <= gap["from_ms"] + max_gap_ms:
                    action = "expire"
                out.append({"intent_id": intent_id, "product_id": order["product_id"], "gap": dict(gap), "action": action,
                            "window": [line["earliest_fill_ms"], line["deadline_ms"]]})
                break
    return out


# ------------------------------------------------------------------------------------------------ the session
class LiveSession(object):
    """One synthetic session. ``create`` starts a new directory; ``recover`` continues it after any interruption."""

    def __init__(self, directory, source_path, strategies, runner_config, runner, evaluator, audit, ingestor, reader, funding,
                 identity, *, max_quote_gap_ms):
        self.directory, self.source_path, self.strategies, self.runner_config = directory, source_path, list(strategies), runner_config
        self.runner, self.evaluator, self.audit, self.ingestor, self.reader, self.funding = runner, evaluator, audit, ingestor, reader, funding
        self.identity, self.max_quote_gap_ms = identity, int(max_quote_gap_ms)
        self.cursors = {"fundpct": 0, "accrual": 0}
        self.fault = None
        self.stopped = None                           # the runner's answer once the operator stopped the session (D-186-1)
        self.halted = None                            # why this instance stopped: set by a step that failed before its checkpoint
        self.last_quote = {}                          # product -> time of the previous quote this process saw
        self.stats = {"steps": 0, "events": 0, "duplicates": 0, "rejected_by_runner": 0, "audit_new": 0, "clock_events": 0}
        evaluator.fault = lambda point: self._fault(point)

    # ---- construction ----------------------------------------------------------------------------------------
    @staticmethod
    def _identity(products, ingest_kw, evaluator, first_runner_entry, source_id, max_quote_gap_ms):
        """The immutable identity of the session: what each component was configured with, and the start of each journal."""
        body = {"schema": SCHEMA, "source_id": source_id, "products": sorted(products), "ingestor": dict(sorted(ingest_kw.items())),
                "max_quote_gap_ms": int(max_quote_gap_ms),
                "evaluator_config_digest": evaluator.config_digest, "evaluator_header_hash": evaluator.log.entries[0]["hash"],
                "runner_manifest_hash": first_runner_entry["data"]["manifest_hash"],
                "runner_start_hash": first_runner_entry["hash"],
                "funding_channels": {"fundpct": "synthetic_fundpct", "accrual": "synthetic_accrual"}}
        return dict(body, session_id=stable_hash(body)[:20])

    @classmethod
    def create(cls, directory, source_path, strategies, products, runner_config, *, decide_from_ms, decide_until_ms=None,
               source_id="synthetic", ingest_kw=None, evaluator_kw=None, max_quote_gap_ms=15_000):
        if os.path.exists(os.path.join(directory, SESSION_FILE)):
            raise IntegrationError("session_exists", directory)
        os.makedirs(directory, exist_ok=True)
        ingest_kw = dict(ingest_kw or {})
        runner_dir = os.path.join(directory, RUNNER_DIR)
        os.makedirs(runner_dir, exist_ok=True)
        lock = _take_lock(runner_dir)                  # the writer's lock first: nothing below is written without owning it
        try:
            evaluator = LE.LiveEvaluator.create(os.path.join(directory, EVALUATOR_FILE), strategies, products,
                                                decide_from_ms=decide_from_ms, decide_until_ms=decide_until_ms,
                                                **dict(evaluator_kw or {}))
            runner = PaperRunner.create(runner_dir, runner_config, strategies, evaluator=evaluator.evaluator, lock=lock)
            identity = cls._identity(products, ingest_kw, evaluator, runner.journal.entries[0], source_id, max_quote_gap_ms)
            audit = AuditJournal.create(os.path.join(directory, AUDIT_FILE), {"session_id": identity["session_id"]})
            reader = SourceReader(source_path)
            session = cls(directory, source_path, strategies, runner_config, runner, evaluator, audit, Ingestor(reader, expected_products=tuple(products), **ingest_kw),
                          reader, FundingSource(source_path), identity, max_quote_gap_ms=max_quote_gap_ms)
            _atomic_write(os.path.join(directory, SESSION_FILE), identity)
            session.save_checkpoint()
        except BaseException:
            lock.release()                              # a session that failed to start leaves the directory free
            raise
        return session

    @classmethod
    def recover(cls, directory, source_path, strategies, products, runner_config, recovery_ms, *, decide_from_ms,
                decide_until_ms=None, source_id="synthetic", ingest_kw=None, evaluator_kw=None, max_quote_gap_ms=15_000):
        """Rebuilds a session from its directory. Refuses (``IntegrationError`` with a stable reason) a directory whose parts
        do not belong to the same session, a checkpoint ahead of any journal, or any configuration that differs from the one
        that created it. ``recovery_ms`` is the restart clock handed to the runner.

        The runner's writer lock is taken BEFORE anything is opened: opening the evaluator log and the audit journal cuts a half
        line (a write), and a half line may be the live writer's own write in flight. The same lock is then handed to the
        runner, so the directory is owned without a gap from the first byte read to ``close``; a second opener is refused
        (``runner_directory_locked``) before it touches a file, and a recovery that fails releases the lock."""
        runner_dir = os.path.join(directory, RUNNER_DIR)
        if not os.path.isdir(runner_dir):             # nothing to own: refuse before opening (and so cutting) any file
            raise IntegrationError("runner_missing", directory)
        lock = _take_lock(runner_dir)
        try:
            return cls._recover(lock, directory, source_path, strategies, products, runner_config, recovery_ms,
                                decide_from_ms=decide_from_ms, decide_until_ms=decide_until_ms, source_id=source_id,
                                ingest_kw=ingest_kw, evaluator_kw=evaluator_kw, max_quote_gap_ms=max_quote_gap_ms)
        except BaseException:
            lock.release()
            raise

    @classmethod
    def _recover(cls, lock, directory, source_path, strategies, products, runner_config, recovery_ms, *, decide_from_ms,
                 decide_until_ms, source_id, ingest_kw, evaluator_kw, max_quote_gap_ms):
        try:
            with open(os.path.join(directory, SESSION_FILE), encoding="utf-8") as handle:
                stored = json.load(handle)
        except (OSError, ValueError):
            raise IntegrationError("session_unreadable", directory)
        ingest_kw = dict(ingest_kw or {})
        evaluator_kw = dict(evaluator_kw or {})
        # the evaluator first: its header carries the configuration it was created with (bounds included)
        try:
            evaluator = LE.LiveEvaluator.recover(os.path.join(directory, EVALUATOR_FILE), strategies, **evaluator_kw)
        except LE.EvaluatorError as error:
            raise IntegrationError("evaluator_" + error.reason, str(error))
        if evaluator.decide_from_ms != int(decide_from_ms) or evaluator.decide_until_ms != decide_until_ms:
            raise IntegrationError("config_incompatible", "decision window")
        # everything is verified from the files BEFORE the runner is recovered: recovering writes (a recovery entry and a
        # checkpoint), and a session that is refused must be left exactly as it was found
        runner_dir = os.path.join(directory, RUNNER_DIR)
        try:
            runner_journal = FileRunnerJournal.load(os.path.join(runner_dir, RUNNER_JOURNAL_FILE))
            runner_checkpoint = read_checkpoint(os.path.join(runner_dir, RUNNER_CHECKPOINT_FILE))
        except StoreError as error:
            raise IntegrationError("runner_" + error.reason, str(error))
        identity = cls._identity(products, ingest_kw, evaluator, runner_journal.entries[0], source_id, max_quote_gap_ms)
        if identity != stored:
            differs = sorted(k for k in set(identity) | set(stored) if identity.get(k) != stored.get(k))
            raise IntegrationError("session_mismatch", "the parts do not belong to the session that was created: " + ", ".join(differs))
        audit = AuditJournal.open(os.path.join(directory, AUDIT_FILE))
        if audit.entries[0]["data"].get("session_id") != stored["session_id"]:
            raise IntegrationError("audit_foreign_session", directory)
        checkpoint = _read_checkpoint(os.path.join(directory, CHECKPOINT_FILE))
        _verify_checkpoint(checkpoint, stored, runner_journal.entries, runner_checkpoint, evaluator, audit)
        runner = PaperRunner.recover(runner_dir, runner_config, strategies, recovery_ms, evaluator=evaluator.evaluator, lock=lock)
        reader = SourceReader(source_path)
        ingestor = Ingestor.from_checkpoint(reader, checkpoint["ingestor"], expected_products=tuple(products), **ingest_kw)
        ingestor.mark_recovered()               # the stretch nobody observed is told as an observation_gap, never as a silence
        for (_product, _from, gap_to), _loss in runner.source_losses.items():     # a loss the runner made durable is never delivered under
            ingestor.released_ms = max(ingestor.released_ms or 0, gap_to - 1)     # (the quote that ends it, at gap_to, still comes)
        session = cls(directory, source_path, strategies, runner_config, runner, evaluator, audit, ingestor, reader,
                      FundingSource(source_path), stored, max_quote_gap_ms=max_quote_gap_ms)
        session.cursors = dict(checkpoint["cursors"])
        # the previous quote of a product is the last one the runner received, so a hole that was open when the process died is
        # still seen when the quote that ends it is delivered again (journal time: the clock a source loss is measured in)
        session.last_quote = {product: max(runner.quote_t_ms.get(product, 0), runner.executor.last_quote_ms.get(product, 0))
                              for product in set(runner.quote_t_ms) | set(runner.executor.last_quote_ms)}
        session._recover_operator_stop()
        return session

    # ---- faults (tests only) ---------------------------------------------------------------------------------
    def _fault(self, point, info=None):
        if self.fault is not None:
            self.fault(point, info)

    # ---- one step --------------------------------------------------------------------------------------------
    def step(self, observed_now_ms):
        """Poll -> deliver -> audit -> checkpoint. Returns the poll's state.

        A step that fails before its checkpoint (a runner that refuses, a disk that refuses the audit) leaves the ingestor
        ahead of what the runner took: this instance never steps or checkpoints again, so a cursor that moved past events the
        runner did not journal is never written down. The directory is recovered from the last checkpoint. Any exception of this part halts the instance,
        transient source reads included, and nothing is retried on it (decision P3 of #186, ``Mantener``). A failure of the checkpoint itself halts it too
        (``save_checkpoint``, decision D-186-2, ``Toda``)."""
        if self.halted is not None:
            raise IntegrationError("session_halted", self.halted)
        if self.stopped is not None or self.runner.status == STOPPED:       # also a directory recovered from a stopped run
            raise IntegrationError("session_stopped", "the operator stopped this session")
        try:
            out = self.ingestor.poll(observed_now_ms)
            self._fault("after_poll")
            self._deliver_batch(out["events"])
            self._declare_from_observation()
            self._fault("after_runner")
            self.stats["steps"] += 1
            self.flush_audit(out["state"])
            self._fault("after_audit")
        except Exception as error:               # noqa: BLE001 - a simulated death is a BaseException and is not caught here
            self.halted = repr(error)
            raise
        self.save_checkpoint()
        self._fault("after_checkpoint")
        return out["state"]

    def _deliver_batch(self, events):
        funding = self._due_funding(events[-1]["t_ms"] if events else None)
        for _t, _rank, kind, item in sorted(funding + [(e["t_ms"], 1, "event", e) for e in events],
                                            key=lambda x: (x[0], x[1])):
            self._deliver(kind, item)

    def _due_funding(self, upto_ms):
        """Funding rows whose arrival is not after the newest released market event (so the runner sees time in order)."""
        if upto_ms is None:
            return []
        items = []
        for row in self.funding.fundpct(self.cursors["fundpct"]):
            if row["arrival_ms"] > upto_ms:
                break
            self.cursors["fundpct"] = row["rid"]
            items.append((row["arrival_ms"], FUNDING_RANK, "fundpct", row))
        for row in self.funding.accrual(self.cursors["accrual"]):
            if row["arrival_ms"] > upto_ms:
                break
            self.cursors["accrual"] = row["rid"]
            items.append((row["arrival_ms"], FUNDING_RANK, "accrual", row))
        return items

    def _handle(self, event):
        self._fault("before_handle", event)
        result = self.runner.handle(event)
        self.stats["events"] += 1
        if event["kind"] == "clock":
            self.stats["clock_events"] += 1
        if result["status"] == "duplicate":
            self.stats["duplicates"] += 1
        elif result["status"] != "accepted":
            self.stats["rejected_by_runner"] += 1
        return result

    def _deliver(self, kind, item):
        if kind == "fundpct":                               # the evaluator's input only: never the accounting
            self.evaluator.feed_funding(item["product_id"], item["start_ms"], item["rate"], item["arrival_ms"])
            return
        if kind == "accrual":                               # the accounting only: never the signal's input
            self._open_holes(item["arrival_ms"])
            self._handle(accrual_event(item))
            return
        event = item
        self._open_holes(event["t_ms"])
        if event["kind"] == "candle":
            payload = event["payload"]
            candle = dict(payload["candle"], bucket_start=payload["bucket_ms"])      # nothing is invented: no volume stays absent
            made = self.evaluator.feed_candle(payload["product_id"], candle, event["t_ms"])
            self._fault("after_evaluation")
            self._handle(event)
            if made["cycle"] is not None:                    # a duplicate returns its cycle too; the runner dedups by event_id
                self._handle(made["cycle"])
            return
        if event["kind"] == "quote":
            self._track_quote(event)
        self._handle(event)

    def _track_quote(self, event):
        self._continuity(event, self.runner.executor.pending)

    def _continuity(self, event, pending):
        """Looks at the hole before this quote, the moment it arrives and before the runner receives it, while the pending
        orders are still pending: a check at the end of the step would find them already filled. The orders the hole affects
        are cancelled through the runner's own entry point (``cancel_for_source_loss``: durable, idempotent, only the pending
        orders of that product whose window overlaps the hole). The previous quote of a recovered session is the last one the
        runner received, so a hole open when the process died is still seen; the downtime itself belongs to the runner's own
        recovery policy.

        The audit trail has three parts, none of which can be lost between two writes: ``source_stale_detected`` is written
        before the call (it is derived again, identical, if the process dies before it), the ids that were cancelled are
        derived from the runner's ``source_losses`` by ``flush_audit`` (they are in the runner's journal before anything else
        can be lost), and a refusal is written as ``source_stale_refused``."""
        product, t_ms = event["payload"]["product_id"], event["t_ms"]
        previous = self.last_quote.get(product)
        self.last_quote[product] = t_ms if previous is None else max(previous, t_ms)        # a quote delivered again never moves it back
        if previous is None:
            return
        gaps = {product: stale_quote_gaps([previous, t_ms], self.max_quote_gap_ms)}
        if gaps[product]:
            self._declare(product, gaps[product][0], t_ms, "closing_quote", pending)

    def _open_holes(self, t_ms):
        """The same rule while the silence is still open (D-10B-17): before an event later than the first instant at which
        a product's silence exceeded the limit (``last quote + limit + 1``) is delivered, the orders that silence affects are
        handled, from the event flow alone, so the declaration is the same whenever the source was polled and whether or not
        the process died. They go in ascending ``(gap_to, product)`` order, so no declaration is earlier than the journal
        clock; the product of the event itself is included: its own closing quote, later than that instant, is declared here first,
        so the loss is the same whether or not anything else flowed or the source was polled in between; ``_continuity`` keeps
        only what is still pending with a window after that instant."""
        pending = self.runner.executor.pending
        if not pending:
            return
        due = []
        for product in sorted({order["product_id"] for order in pending.values()}):
            since = self.last_quote.get(product)
            if since is None:
                continue
            gap_to = since + self.max_quote_gap_ms + 1
            if gap_to < t_ms:
                due.append((gap_to, product, since))
        for gap_to, product, since in sorted(due):
            self._declare(product, {"from_ms": since, "to_ms": gap_to}, gap_to, "open_silence", pending)

    def _declare(self, product, gap, t_decl, trigger, pending):
        """Records what is about to be cancelled or expired and declares the source loss through the runner. The orders that
        only expire (their window was over before the silence was excessive) are listed apart from the cancelled ones."""
        hits = affected_orders(pending, {product: [gap]}, self.max_quote_gap_ms)
        if not hits or (trigger != "closing_quote" and not any(h["action"] == "cancel" for h in hits)):
            return                           # an order that only expires does it in the normal flow, with the next quote
        record = {"source": "session", "kind": "source_stale_detected", "trigger": trigger, "product_id": product, "gap": dict(gap),
                  "pending_hit": [h["intent_id"] for h in hits if h["action"] == "cancel"],
                  "expiring": [h["intent_id"] for h in hits if h["action"] == "expire"], "limit_ms": self.max_quote_gap_ms}
        record["ingestor"] = self.classify_gap(product, gap)
        if self.audit.add(record):
            self.stats["audit_new"] += 1
        try:
            self.runner.cancel_for_source_loss(product, gap["from_ms"], gap["to_ms"], t_decl, self.max_quote_gap_ms)
        except RunnerError as error:
            # the declaration did not happen: the evidence says so and the session stops here rather than hand the next event
            # to orders that should have been cancelled
            try:
                self.audit.add({"source": "session", "kind": "source_stale_refused", "trigger": trigger, "product_id": product,
                                "gap": dict(gap), "applied": False, "reason": error.reason})
            except (IntegrationError, OSError):
                pass                         # the disk refused the evidence too: the runner's refusal is still the error that stops
            raise
        self._fault("after_open_declaration" if trigger != "closing_quote" else "after_closing_declaration")

    def _declare_from_observation(self):
        """Nothing else is coming (a single product, or a source that stopped): the event flow cannot tie the declaration.
        Only then the observation does, and only with the ingestor's proof (``proven_until``: exhausted read in the source's
        own clock, no overdue candle, no stretch waiting to be told as unobserved). What the watermark still holds at or before
        the instant is released and delivered first (``release_proven``), so a quote that was already read is never declared
        silent; the declaration is then the one the flow would make, and the ingestor never releases under it again."""
        done = set()                                  # one declaration per product and silence in a step
        while True:
            pending = self.runner.executor.pending
            bound = self.ingestor.proven_until()
            if not pending or bound is None:
                return
            clock = self.runner.clock
            due = []
            for product in sorted({order["product_id"] for order in pending.values()}):
                since = self.last_quote.get(product)
                if since is None or (product, since) in done:
                    continue
                gap_to = since + self.max_quote_gap_ms + 1
                if gap_to <= bound and (clock is None or clock <= gap_to):
                    due.append((gap_to, product, since))
            if not due:
                return
            gap_to, product, since = min(due)
            released = self.ingestor.release_proven(gap_to)
            self._deliver_batch(released)
            if self.last_quote.get(product) != since or product not in {o["product_id"] for o in self.runner.executor.pending.values()}:
                continue                          # what was released changed the picture: look again
            self._declare(product, {"from_ms": since, "to_ms": gap_to}, gap_to, "observed_silence", self.runner.executor.pending)
            done.add((product, since))

    def classify_gap(self, product, gap):
        """What the ingestor knew about this hole when it was detected (evidence only: it does not decide the cancellation).
        ``source_silence``: the whole source was silent in it; ``product_silence``: only this product (others were alive);
        ``data_gaps`` and ``epoch_changes``: the capture's own gap rows and transport epoch changes inside it. A hole none of
        them explains has ``unexplained`` true. The ingestor keeps a capped sample: ``sample_capped`` says when it is full."""
        ing = self.ingestor
        inside = lambda a, b: a < gap["to_ms"] and b > gap["from_ms"]           # noqa: E731
        silences = [x for x in ing.silences if inside(x["from_ms"], x["to_ms"]) and x["product_id"] in (None, product)]
        gaps = [x for x in ing.data_gaps if x["product_id"] in (None, product) and gap["from_ms"] <= x["detected_at"] <= gap["to_ms"]]
        changes = [x for x in ing.epoch_changes if x["product_id"] == product and gap["from_ms"] <= x["t_ms"] <= gap["to_ms"]]
        still_open = {key: ing.open_silences.get(key) for key in (product, "*")}            # a silence the ingestor has seen but not ended
        open_source = still_open["*"] is not None and still_open["*"]["since_ms"] < gap["to_ms"]
        open_product = still_open[product] is not None and still_open[product]["since_ms"] < gap["to_ms"] and not open_source
        out = {"source_silence": open_source or any(x["kind"] == "source_silence" for x in silences),
               "product_silence": open_product or any(x["kind"] == "product_silence" for x in silences),
               "data_gaps": len(gaps), "epoch_changes": len(changes),
               "sample_capped": len(ing.silences) >= SILENCE_SAMPLE or len(ing.data_gaps) >= GAP_SAMPLE}
        out["unexplained"] = not (out["source_silence"] or out["product_silence"] or out["data_gaps"] or out["epoch_changes"])
        return out

    # ---- evidence ---------------------------------------------------------------------------------------------
    def flush_audit(self, ingest_state=None):
        """Writes every piece of evidence the components hold, before the checkpoint that would stop re-deriving it."""
        new = 0
        report = self.evaluator.report()
        records = []
        for row in self.ingestor.rejected:
            records.append({"source": "ingestor", "kind": "unreadable_row", "row": row})
        for outage in self.ingestor.outages:
            records.append({"source": "ingestor", "kind": "source_outage", "outage": outage})
        for row in self.ingestor.late:
            records.append({"source": "ingestor", "kind": "late_source_row", "row": row})
        for kind, key in (("rejected_input", "rejected"), ("candle_conflict", "candle_conflicts"), ("frame_expired", "frames_expired"),
                          ("evaluation_failed", "evaluation_misses"), ("late_funding", "late_funding"),
                          ("gap", "gaps"), ("suppressed_cycle", "suppressed")):
            for item in report[key]:
                records.append({"source": "evaluator", "kind": kind, "item": item})
        for (product, gap_from, gap_to), loss in sorted(self.runner.source_losses.items()):      # what the runner made durable
            records.append({"source": "runner", "kind": "source_loss", "product_id": product, "gap": {"from_ms": gap_from, "to_ms": gap_to},
                            "cancelled": list(loss["intent_ids"]), "expired": list(loss.get("expire_ids", [])),
                            "expired_reasons": self._expiry_reasons(loss.get("expire_ids", [])),
                            "threshold_ms": loss.get("threshold_ms"), "declared_ms": loss.get("declared_ms"),
                            "windows": {k: list(v) for k, v in sorted(loss["windows"].items())}})
        records += self._observation_records()
        for record in records:
            new += 1 if self.audit.add(record) else 0
        self.stats["audit_new"] += new
        return new

    def _expiry_reasons(self, intent_ids):
        """Why each order the declaration found over before the silence was excessive ended: the executor's own expiry reasons,
        read from its records (never a ``source_stale`` cancellation). An order that has not ended yet has none."""
        wanted = set(intent_ids)
        return {r["intent_id"]: list(r["reasons"]) for r in self.runner.executor.records
                if r.get("status") == "rejected" and r.get("intent_id") in wanted}

    def _observation_records(self):
        """D-10B-17 evidence, derived from the ingestor's durable state and the runner's pending orders. None of it is a quote
        and none decides anything: ``silence_open`` (insufficient continuity), ``observation_gap`` (nobody was observing: the
        process was down), ``silence_contradicted`` (a quote that arrived inside what had been observed as silent),
        ``observation`` (how far the source was observed, one per ``product_silence_ms``) and ``silence_at_window_end``."""
        seen = self.ingestor.observation()
        records = []
        for a, b in seen["observation_gaps"]:
            records.append({"source": "ingestor", "kind": "observation_gap", "gap": {"from_ms": a, "to_ms": b}})
        for item in seen["contradicted"]:
            records.append({"source": "ingestor", "kind": "silence_contradicted", "item": item})
        for item in seen["log"]:
            records.append({"source": "ingestor", "kind": "observation", "item": item})
        for clock, table in (("source", seen["open_silences"]), ("process", seen["open_process"])):
            for key, entry in sorted(table.items()):
                records.append({"source": "ingestor", "kind": "silence_open", "clock": clock, "product_id": None if key == "*" else key,
                                "scope": entry["scope"], "since_ms": entry["since_ms"], "partial": entry["partial"]})
        for intent_id, order in sorted(self.runner.executor.pending.items()):
            line = order["timeline"]
            for clock, table in (("source", seen["open_silences"]), ("process", seen["open_process"])):
                entry = table.get(order["product_id"]) or table.get("*")
                if entry is not None and entry["since_ms"] < line["deadline_ms"] <= entry["observed_until_ms"]:
                    records.append({"source": "session", "kind": "silence_at_window_end", "clock": clock, "intent_id": intent_id,
                                    "product_id": order["product_id"], "deadline_ms": line["deadline_ms"],
                                    "since_ms": entry["since_ms"], "scope": entry["scope"]})
                    break
        return records

    # ---- durability --------------------------------------------------------------------------------------------
    def save_checkpoint(self):
        """Makes the session durable up to here. If it cannot be written (decision D-186-2 of #186, ``Toda``) the whole session
        stops: this instance is halted (``session_halted``, with the failure as its reason), processes nothing more and writes
        nothing more, the previous checkpoint stays as it was and the directory is recovered from it and the journals. A stop
        caused by a failing disk does not ask for successful writes after the error."""
        if self.halted is not None:
            raise IntegrationError("session_halted", self.halted)
        try:
            return self._write_checkpoint()
        except Exception as error:               # noqa: BLE001 - a simulated death is a BaseException and is not caught here
            self.halted = repr(error)
            raise

    def _write_checkpoint(self):
        runner_checkpoint = self.runner.checkpoint()           # the runner's own, written atomically by the runner
        self._fault("after_runner_checkpoint")
        entries = self.runner.journal.entries
        body = {"schema": CHECKPOINT_SCHEMA, "session_id": self.identity["session_id"],
                "runner": {"seq": len(entries), "hash": self.runner.journal.head, "start_hash": entries[0]["hash"],
                           "checkpoint_upto_seq": runner_checkpoint["upto_seq"],
                           "checkpoint_manifest_hash": runner_checkpoint["manifest_hash"]},
                "evaluator": {"entries": len(self.evaluator.log.entries), "head": self.evaluator.log.head},
                "audit": {"entries": len(self.audit.entries), "head": self.audit.head},
                "cursors": dict(self.cursors), "ingestor": self.ingestor.checkpoint()}
        text = json.dumps(dict(body, digest=stable_hash(body)), sort_keys=True)
        path = os.path.join(self.directory, CHECKPOINT_FILE)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        self._fault("checkpoint_tmp_written")
        os.replace(tmp, path)
        _fsync_dir(path)
        return body

    def stop(self, t_ms):
        """The operator stops the session in order (decision D-186-1 of #186): the runner cancels what is still pending with the
        reason ``operator_stop`` (journal first), the audit says so, and the stop is made durable with a checkpoint. Open
        positions are not touched, and while the engine is stopped nobody evaluates their stops or targets: this is not
        protection. The stop is reported done only after the runner has journaled it; if the runner refuses (a journal that
        cannot be written) the call raises ``RunnerError`` and this instance never steps again. A halted session never reports a
        stop (``session_halted``), whatever happened before it halted. A failure of the checkpoint after a stop halts the
        session like any checkpoint failure (D-186-2, ``Toda``). Asking again returns the same answer, also for a session
        recovered from a run that was already stopped: nothing is written twice. The session is closed separately with
        ``close()``."""
        if self.halted is not None:
            raise IntegrationError("session_halted", self.halted)
        if self.stopped is not None:
            return self.stopped
        try:
            result = self.runner.stop_orderly(t_ms)
        except Exception as error:               # noqa: BLE001
            self.halted = repr(error)
            raise
        self.stopped = result
        try:
            self._audit_operator_stop(result["declared_ms"], result["cancelled"], result["expired"])
            self.flush_audit()
        except Exception as error:               # noqa: BLE001
            self.halted = repr(error)
            raise
        self.save_checkpoint()
        return result

    def _audit_operator_stop(self, declared_ms, cancelled, expired):
        """The audit's record of a stop, built only from what the runner's journal holds (so the live stop and the recovery of
        a process that died between the journal and the audit write the very same record, once)."""
        return self.audit.add({"source": "runner", "kind": "operator_stop", "declared_ms": declared_ms,
                               "cancelled": list(cancelled), "expired": list(expired),
                               "expired_reasons": self._expiry_reasons(expired)})

    def _recover_operator_stop(self):
        """A run that was stopped: the stop is in the runner's journal, so the audit gets its record if the process died before
        writing it, and this instance answers ``stop`` and refuses ``step`` like the one that stopped it."""
        stops = [e["data"] for e in self.runner.journal.entries if e["kind"] == "operator_stop"]
        if not stops:
            return
        for data in stops:
            self._audit_operator_stop(data["declared_ms"], data["cancel_ids"], data["expire_ids"])
        last = stops[-1]
        self.stopped = {"cancelled": list(last["cancel_ids"]), "expired": list(last["expire_ids"]), "declared_ms": last["declared_ms"]}

    def close(self):
        self.runner.close()
        self.reader.close()
        self.funding.close()

    # ---- reading -----------------------------------------------------------------------------------------------
    def comparable_state(self):
        """The runner's state without what a recovery changes by design (counters, clock, coverage, journal position): two runs
        that reach the same point, one of them through a process death, have the same one. ``paper_runner.py`` is not touched;
        this is made of the parts its own ``state_digest`` is made of."""
        runner = self.runner
        return stable_hash({"financial": runner.financial_digest(),
                            "watch": runner.executor.watch.events_hash() if runner.executor.watch else None,
                            "seen": sorted(runner.seen.items()), "candles": sorted((list(k), v) for k, v in runner.candle_digest.items()),
                            "offsets": runner.offsets.summary(), "open_cycles": sorted(runner.open_cycles),
                            "open_funding": sorted(runner.open_funding),
                            "source_losses": sorted((list(k), v) for k, v in runner.source_losses.items())})

    def digests(self):
        """What two runs must share to be called the same: the financial state, the signals and the orders."""
        runner = self.runner
        return {"financial": runner.financial_digest(),
                "signals": stable_hash([e["data"]["signal"]["signal_id"] for e in runner.log.signals() if e["data"]["origin"] == "original"]),
                "orders": stable_hash([{k: o[k] for k in ("state", "intent_id", "product_id", "strategy_id", "side")} for o in runner.orders()])}


def _take_lock(runner_dir):
    """The runner's own single-writer lock (``runner.lock``), taken by the session and handed to the runner."""
    try:
        return DirectoryLock(runner_dir)
    except StoreError as error:
        raise IntegrationError("runner_" + error.reason, str(error))


def _fsync_dir(path):
    fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path, body):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(body, sort_keys=True))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    _fsync_dir(path)


def _read_checkpoint(path):
    try:
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
        body = {k: v for k, v in stored.items() if k != "digest"}
        ok = stable_hash(body) == stored["digest"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise IntegrationError("checkpoint_unreadable", path)
    if not ok:
        raise IntegrationError("checkpoint_digest_mismatch", path)
    if body.get("schema") != CHECKPOINT_SCHEMA:
        raise IntegrationError("checkpoint_schema", str(body.get("schema")))
    return body


def _verify_checkpoint(checkpoint, identity, entries, own, evaluator, audit):
    """The checkpoint may be older than the journals (they are written first) but never ahead of them, and every journal
    must still contain the entry the checkpoint saw. ``own`` is the runner's own checkpoint file."""
    if checkpoint["session_id"] != identity["session_id"]:
        raise IntegrationError("checkpoint_foreign_session", "the checkpoint belongs to another session")
    seq = checkpoint["runner"]
    if seq["seq"] > len(entries):
        raise IntegrationError("checkpoint_ahead_of_runner", "{} > {}".format(seq["seq"], len(entries)))
    if seq["start_hash"] != entries[0]["hash"] or (seq["seq"] and entries[seq["seq"] - 1]["hash"] != seq["hash"]):
        raise IntegrationError("checkpoint_foreign_runner_journal", "the runner journal is not the one the checkpoint saw")
    if own["manifest_hash"] != identity["runner_manifest_hash"] or own["journal_start_hash"] != identity["runner_start_hash"]:
        raise IntegrationError("runner_checkpoint_foreign_session", "the runner's checkpoint belongs to another run")
    if own["upto_seq"] < seq["checkpoint_upto_seq"]:
        raise IntegrationError("runner_checkpoint_behind", "{} < {}".format(own["upto_seq"], seq["checkpoint_upto_seq"]))
    for name, journal, ref in (("evaluator", evaluator.log, checkpoint["evaluator"]), ("audit", audit, checkpoint["audit"])):
        if ref["entries"] > len(journal.entries):
            raise IntegrationError("checkpoint_ahead_of_" + name, "{} > {}".format(ref["entries"], len(journal.entries)))
        if ref["entries"] and journal.entries[ref["entries"] - 1]["hash"] != ref["head"]:
            raise IntegrationError("checkpoint_foreign_" + name + "_journal", "the {} journal is not the one the checkpoint saw".format(name))
