"""Durable signal continuity for the shared portfolio (offline, isolated).

What it adds around the existing pieces, and nothing else:

* ``SignalLog``: append-only JSON-lines log of ``balancita-signal.v1`` signals (same discipline as the offline
  portfolio journal: one hash-chained entry per line, ``fsync`` before an entry counts as written). Each signal entry
  carries a stable key, the strategy version and code hash, the product, the source candle, the generation time and
  the exact inputs the strategy saw, so the decision can be re-derived and audited.
* Idempotent ingestion: a delivery already in the log changes nothing; a different decision for an existing key is
  recorded as a conflict and never replaces the first.
* ``Consumer``: processes log entries strictly after a durable checkpoint (``committed_seq``). A signal is "processed"
  only after the handler returned and the checkpoint was committed; the checkpoint is bound to the log by hash.
* Gap detection on the 5-minute cycle grid and reconstruction of the missing signals from complete historical candles
  and *frozen* strategy versions. Reconstructed signals are marked ``origin = "reconstructed"`` and are never
  executable: ``guard_entry`` refuses them (and expired originals) so no retroactive position can be opened.
* Fault injection (``arm``) to crash before persisting, in the middle of persisting, after persisting and before the
  acknowledgement, plus a CLI so that every step can run in a separate Python process.

Not connected to the forward, ``capture``, Kronos, Qwen, the shared portfolio or any active database; no wall clock
(every time is passed in), no network, no randomness. It adds no trading logic and no second engine: strategies, the
signal contract and the feature pipeline are ``multi_signals`` and ``futures_simulator.frames``.
"""

import argparse
import functools
import inspect
import json
import os
import sys
import tempfile
from decimal import Decimal

from . import futures_funding_context, futures_indicators, futures_simulator, futures_strategies, multi_signals
from .futures_simulator import frames
from .multi_experiment import FrameFeeder
from .multi_signals import (
    FIVE_MINUTES_MS, WAIT, MomentumStrategy, SignalContext, default_strategies, is_candidate, merged_indicators, stable_hash, validate_signal,
)

D = Decimal
LOG_SCHEMA = "balancita-signal-log.v1"
CHECKPOINT_SCHEMA = "balancita-signal-checkpoint.v1"
ONE_MINUTE_MS = 60_000
GENESIS = "0" * 64
# A signal may open a position only within one cycle of its candle's close. Stricter than the portfolio's own
# ``max_data_age_ms`` (600 000); this module does not change any risk parameter.
MAX_EXECUTABLE_AGE_MS = FIVE_MINUTES_MS
LOG_FILE, CHECKPOINT_FILE, EFFECTS_FILE = "signals.jsonl", "checkpoint.json", "effects.jsonl"


class ContinuityError(Exception):
    """A restart or reconstruction cannot be trusted. ``reason`` is a stable code; nothing is repaired silently."""

    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


class RetroactiveEntryError(ContinuityError):
    """A reconstructed or expired signal was offered as a basis to open a position."""


class SimulatedCrash(BaseException):
    """Raised by an armed fault point. BaseException so that no ``except Exception`` can swallow a 'power cut'."""


# ------------------------------------------------------------------------------------------------ fault injection
_FAULTS = {}
FAULT_POINTS = ("before_persist", "mid_persist", "after_persist", "before_ack")


def arm(point, nth=1):
    if point not in FAULT_POINTS:
        raise ValueError("unknown fault point {!r}".format(point))
    _FAULTS[point] = nth


def disarm():
    _FAULTS.clear()


def _due(point):
    """True exactly on the n-th call after ``arm(point, n)``."""
    if point in _FAULTS:
        _FAULTS[point] -= 1
        if _FAULTS[point] <= 0:
            del _FAULTS[point]
            return True
    return False


def _hit(point):
    if _due(point):
        raise SimulatedCrash(point)


# ------------------------------------------------------------------------------------------------ identities
def code_hash(strategy):
    """Hash of the strategy's behaviour: identity, version, parameters and the source of its class. A change in code
    without a version bump changes this value, which is how an 'incompatible' reconstruction is detected."""
    try:
        source = inspect.getsource(type(strategy))
    except (OSError, TypeError):
        source = type(strategy).__qualname__
    params = {k: str(v) for k, v in sorted(vars(strategy).items())}
    return stable_hash({"id": strategy.id, "version": strategy.version, "horizon": strategy.horizon_minutes,
                        "indicators": strategy.indicators, "class": type(strategy).__qualname__,
                        "constants": {k: str(v) for k, v in sorted(vars(type(strategy)).items())
                                      if k.isupper()}, "params": params, "source": source})


def _source(obj):
    try:
        return inspect.getsource(obj)
    except (OSError, TypeError):
        return repr(obj)


@functools.lru_cache(maxsize=1)
def pipeline_hash():
    """Hash of everything outside the strategy class that decides what a stored signal means: the feature pipeline
    (indicators, incremental features, regime chain, funding percentile), the signal contract and the way this module
    builds inputs, keys and decision hashes. Freezing it next to ``code_hash`` makes a reconstruction fail closed when
    any of it changed; it is deliberately narrower than 'whole modules' so unrelated edits do not block recovery."""
    me = sys.modules[__name__]
    sim = futures_simulator
    parts = {
        "indicators": _source(futures_indicators),
        "simulator": [_source(sim.IncrementalFeatures), _source(sim.frames), _source(sim.merge_periods), _source(sim._n),
                      repr(sim.DEFAULT_PERIODS), repr(sim.REGIME_PERIODS), repr(sim.LOG_KINDS)],
        "regime": _source(futures_strategies.update_regime),
        "funding_percentile": _source(futures_funding_context.FundingContext),
        "contract": [_source(f) for f in (multi_signals.make_signal, multi_signals.validate_signal, multi_signals.Strategy,
                                          multi_signals.SignalContext, multi_signals.stable_hash, multi_signals._two,
                                          multi_signals._dec, multi_signals._clip)],
        "this_module": [_source(f) for f in (me.context_inputs, me.context_from_inputs, me.evaluate_cycle, me.on_cycle,
                                             me.signal_key, me.decision_hash, me._plain)],
    }
    return stable_hash(["pipeline.v1", parts])


def signal_key(strategy_id, strategy_version, product_id, bucket_ms):
    """Stable identity of 'what this strategy version said about this product at this cycle'."""
    return stable_hash(["signal-key.v1", strategy_id, int(strategy_version), product_id, int(bucket_ms)])[:24]


def decision_hash(signal):
    """Identity of the decision itself. ``reliability`` is excluded on purpose: it is the live track record at
    emission time, which a reconstruction cannot know, and it does not change the decision."""
    body = {k: v for k, v in signal.items() if k not in ("signal_id", "reliability")}
    return stable_hash(["decision.v1", body])


def _plain(value):
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def context_inputs(ctx):
    """Everything a strategy may read, frozen into plain JSON."""
    return _plain({"price": ctx.price, "one": ctx.one, "five": ctx.five, "regime": ctx.regime})


def context_from_inputs(product_id, bucket_ms, inputs):
    return SignalContext(product_id, bucket_ms, inputs["price"], inputs["one"], inputs["five"], inputs["regime"])


def evaluate_cycle(strategies, product_id, cycle_ms, frame, reliability=None):
    """One cycle for every strategy -> ``[(signal, inputs)]``. The only place that builds a context from a frame,
    used both by the live producer and by the reconstruction."""
    _, current, _, trend, regime = frame
    out = []
    for strategy in strategies:
        ctx = SignalContext(product_id, cycle_ms, trend.get("candidate_close"), current, trend, regime, reliability)
        out.append((validate_signal(strategy.evaluate(ctx)), context_inputs(ctx)))
    return out


def on_cycle(frame):
    """The same cycle condition as the experiment: last minute of a 5m bar, indicators ready."""
    bucket, current, _, trend, _ = frame
    return (bucket + ONE_MINUTE_MS) % FIVE_MINUTES_MS == 0 and trend is not None and bool(trend.get("ready")) \
        and bool(current.get("ready"))


# ------------------------------------------------------------------------------------------------ the log
class SignalLog:
    def __init__(self, path):
        self.path, self.entries, self.head = path, [], GENESIS
        self.canonical = {}        # key -> seq of the entry that counts (originals win over reconstructions)
        self.frozen = {}           # (strategy_id, version) -> code hash
        self.conflicts, self.tail_discarded, self.max_source_offset = set(), 0, None

    # ---- opening
    @classmethod
    def create(cls, path, t_ms):
        if os.path.exists(path):
            raise ContinuityError("log_exists", path)
        log = cls(path)
        with open(path, "w", encoding="utf-8"):
            pass
        log.append("log_start", {"schema": LOG_SCHEMA}, t_ms)
        return log

    @classmethod
    def load(cls, path):
        """Reads and verifies the log. An unterminated final line is a write that never completed (it was never
        reported as durable) and is cut off; any other damage refuses the whole file."""
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise ContinuityError("log_missing", path)
        log = cls(path)
        with open(path, "rb") as handle:
            raw = handle.read()
        cut = raw.rfind(b"\n") + 1
        if cut < len(raw):
            log.tail_discarded = len(raw) - cut
            raw_text = raw[:cut]
        else:
            raw_text = raw
        try:
            for number, line in enumerate(raw_text.decode("utf-8").splitlines(), start=1):
                entry = json.loads(line)
                if not isinstance(entry, dict) or entry.get("seq") != number or "hash" not in entry:
                    raise ValueError("line {} is not entry {}".format(number, number))
                log._index(entry)
        except (ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
            raise ContinuityError("log_corrupt", repr(error)) from error
        broken = log.verify()
        if broken is not None:
            raise ContinuityError("log_corrupt", "hash chain broken at entry {}".format(broken))
        if not log.entries or log.entries[0]["kind"] != "log_start" or log.entries[0]["data"].get("schema") != LOG_SCHEMA:
            raise ContinuityError("log_incompatible", "does not start with a log_start of this schema")
        if log.tail_discarded:
            with open(path, "r+b") as handle:   # drop the torn bytes so the next append starts on a clean line
                handle.truncate(cut)
                handle.flush()
                os.fsync(handle.fileno())
            log.append("tail_discarded", {"bytes": log.tail_discarded}, log.entries[-1]["t_ms"])
        return log

    def _index(self, entry):
        self.entries.append(entry)
        self.head = entry["hash"]
        data, kind = entry["data"], entry["kind"]
        if kind == "strategy_frozen":
            self.frozen[(data["strategy_id"], data["strategy_version"])] = (data["code_hash"], data["pipeline_hash"])
        elif kind == "signal":
            if "source_offset" in data:
                self.max_source_offset = max(data["source_offset"], self.max_source_offset or 0)
            current = self.canonical.get(data["key"])
            if current is None or (data["origin"] == "original"
                                   and self.entries[current - 1]["data"]["origin"] != "original"):
                self.canonical[data["key"]] = entry["seq"]
        elif kind == "conflict":
            self.conflicts.add(data["conflict_id"])

    def verify(self):
        """Returns ``None`` when the chain is intact, else the first broken sequence number."""
        prev = GENESIS
        for entry in self.entries:
            body = {k: v for k, v in entry.items() if k != "hash"}
            if body["prev"] != prev or stable_hash(body) != entry["hash"]:
                return entry["seq"]
            prev = entry["hash"]
        return None

    # ---- writing
    def append(self, kind, data, t_ms):
        """Appends and fsyncs one entry. When this returns the entry is durable."""
        body = {"seq": len(self.entries) + 1, "t_ms": int(t_ms), "kind": kind, "data": _plain(data), "prev": self.head}
        body["hash"] = stable_hash(body)
        line = json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n"
        _hit("before_persist")
        with open(self.path, "ab") as handle:
            if _due("mid_persist"):
                handle.write(line.encode("utf-8")[: len(line) // 2])   # a torn write, as a power cut leaves it
                handle.flush()
                os.fsync(handle.fileno())
                raise SimulatedCrash("mid_persist")
            handle.write(line.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        self._index(body)
        _hit("after_persist")
        return body

    def freeze_strategy(self, strategy, t_ms):
        """Registers (idempotently) the exact behaviour of a strategy version. The same version with different code
        is refused: a new behaviour needs a new version."""
        fingerprint = (code_hash(strategy), pipeline_hash())
        known = self.frozen.get((strategy.id, strategy.version))
        if known == fingerprint:
            return None
        if known is not None:
            raise ContinuityError("code_changed_same_version" if known[0] != fingerprint[0] else "pipeline_changed",
                                  "{} v{}".format(strategy.id, strategy.version))
        return self.append("strategy_frozen", {"strategy_id": strategy.id, "strategy_version": strategy.version,
                                               "code_hash": fingerprint[0], "pipeline_hash": fingerprint[1]}, t_ms)

    def ingest(self, signal, inputs, t_ms, *, origin="original", source_offset=None, reconstruction=None):
        """Persists a signal. Returns ``{"status", "key", "seq"}`` with status ``persisted`` | ``duplicate`` |
        ``conflict`` | ``already_present`` (a reconstruction of a cycle that already has an entry)."""
        validate_signal(signal)
        if origin not in ("original", "reconstructed"):
            raise ValueError(origin)
        version = signal["strategy_version"]
        fingerprint = self.frozen.get((signal["strategy_id"], version))
        if fingerprint is None:
            raise ContinuityError("strategy_not_frozen", "{} v{}".format(signal["strategy_id"], version))
        key = signal_key(signal["strategy_id"], version, signal["product_id"], signal["bucket_ms"])
        decided = decision_hash(signal)
        seq = self.canonical.get(key)
        existing = None if seq is None else self.entries[seq - 1]["data"]
        supersedes = None
        if existing is not None:
            if origin == "reconstructed":
                return {"status": "already_present", "key": key, "seq": seq}
            if existing["origin"] == "original":
                if existing["decision_hash"] == decided:
                    return {"status": "duplicate", "key": key, "seq": seq}
                conflict_id = stable_hash([key, decided])[:24]
                if conflict_id in self.conflicts:
                    return {"status": "conflict", "key": key, "seq": seq}
                entry = self.append("conflict", {"conflict_id": conflict_id, "key": key, "kept_seq": seq,
                                                 "kept_decision": existing["decision_hash"], "rejected_decision": decided,
                                                 "rejected_signal_id": signal["signal_id"]}, t_ms)
                return {"status": "conflict", "key": key, "seq": entry["seq"]}
            supersedes = seq   # a late original replaces a reconstruction as the entry that counts
        executable = origin == "original"
        data = {"key": key, "origin": origin, "signal": signal, "decision_hash": decided,
                "inputs": inputs, "inputs_hash": stable_hash(inputs), "code_hash": fingerprint[0],
                "pipeline_hash": fingerprint[1],
                "product_id": signal["product_id"], "cycle_ms": signal["bucket_ms"], "generated_ms": int(t_ms),
                "valid_until_ms": signal["bucket_ms"] + MAX_EXECUTABLE_AGE_MS if executable else None,
                "executable": executable,
                "not_executable_reason": None if executable else "reconstructed_after_the_fact"}
        if source_offset is not None:
            data["source_offset"] = int(source_offset)
        if supersedes is not None:
            data["supersedes_seq"] = supersedes
            data["matches_reconstruction"] = self.entries[supersedes - 1]["data"]["decision_hash"] == decided
        if reconstruction is not None:
            data["reconstruction"] = reconstruction
        entry = self.append("signal", data, t_ms)
        return {"status": "persisted", "key": key, "seq": entry["seq"]}

    # ---- reading
    def signals(self, *, canonical_only=True):
        for entry in self.entries:
            if entry["kind"] != "signal":
                continue
            if canonical_only and self.canonical.get(entry["data"]["key"]) != entry["seq"]:
                continue
            yield entry

    def present_cycles(self, strategy_id, version, product_id):
        return {e["data"]["cycle_ms"] for e in self.signals()
                if e["data"]["signal"]["strategy_id"] == strategy_id
                and e["data"]["signal"]["strategy_version"] == version and e["data"]["product_id"] == product_id}

    def source_offsets(self):
        return sorted({e["data"]["source_offset"] for e in self.signals(canonical_only=False)
                       if "source_offset" in e["data"]})


# ------------------------------------------------------------------------------------------------ gaps
def detect_gaps(log, strategies, products, until_ms, *, from_ms=None):
    """Runs of cycles with no entry (original or reconstructed, WAIT included) between the first cycle ever logged
    for the pair (or ``from_ms``) and ``until_ms``. Returns a list of ``{strategy_id, strategy_version, product_id,
    from_ms, to_ms, cycles}`` with both bounds inclusive cycle times."""
    gaps = []
    until = until_ms - until_ms % FIVE_MINUTES_MS
    for strategy in strategies:
        for product in products:
            present = log.present_cycles(strategy.id, strategy.version, product)
            first = from_ms if from_ms is not None else min(present, default=None)
            if first is None:
                continue
            run = None
            for cycle in range(first, until + 1, FIVE_MINUTES_MS):
                if cycle in present:
                    if run:
                        gaps.append(run)
                        run = None
                elif run is None:
                    run = {"strategy_id": strategy.id, "strategy_version": strategy.version, "product_id": product,
                           "from_ms": cycle, "to_ms": cycle, "cycles": 1}
                else:
                    run["to_ms"], run["cycles"] = cycle, run["cycles"] + 1
            if run:
                gaps.append(run)
    return gaps


def record_gaps(log, gaps, t_ms):
    """Writes each gap once (identified by its content). Returns the number of new gap entries."""
    known = {e["data"]["gap_id"] for e in log.entries if e["kind"] == "gap"}
    new = 0
    for gap in gaps:
        gap_id = stable_hash(["gap", gap])[:24]
        if gap_id not in known:
            log.append("gap", dict(gap, gap_id=gap_id, detected_ms=int(t_ms)), t_ms)
            known.add(gap_id)
            new += 1
    return new


def source_offset_holes(log):
    """Missing numbers in the upstream's delivery sequence (lost events), as inclusive ``(first, last)`` ranges."""
    offsets = log.source_offsets()
    return [(a + 1, b - 1) for a, b in zip(offsets, offsets[1:]) if b > a + 1]


# ------------------------------------------------------------------------------------------------ reconstruction
def check_frozen(log, strategies):
    """Every strategy used to reconstruct must be exactly the frozen one. Raises ``ContinuityError``."""
    for strategy in strategies:
        known = log.frozen.get((strategy.id, strategy.version))
        if known is None:
            others = sorted(v for (i, v) in log.frozen if i == strategy.id)
            if others:
                raise ContinuityError("version_incompatible", "{} v{} given, frozen versions in the log: {}".format(
                    strategy.id, strategy.version, others))
            raise ContinuityError("strategy_not_frozen", "{} v{}".format(strategy.id, strategy.version))
        if known[0] != code_hash(strategy):
            raise ContinuityError("code_changed_same_version", "{} v{}".format(strategy.id, strategy.version))
        if known[1] != pipeline_hash():
            raise ContinuityError("pipeline_changed", "feature pipeline or signal contract differs from the frozen one "
                                                      "({} v{})".format(strategy.id, strategy.version))


def check_candles(candles_1m, candles_5m, last_cycle_ms):
    """Complete means: no missing or repeated bucket in either series, and the 5m bar of ``last_cycle_ms`` closed.
    Returns a hash of both series. Raises ``ContinuityError('incomplete_candles')`` otherwise."""
    for name, series, step in (("1m", candles_1m, ONE_MINUTE_MS), ("5m", candles_5m, FIVE_MINUTES_MS)):
        if not series:
            raise ContinuityError("incomplete_candles", name + " series is empty")
        for previous, current in zip(series, series[1:]):
            if current["bucket_start"] - previous["bucket_start"] != step:
                raise ContinuityError("incomplete_candles", "{} hole or repeat after {}".format(name, previous["bucket_start"]))
    if candles_1m[-1]["bucket_start"] + ONE_MINUTE_MS < last_cycle_ms or candles_5m[-1]["bucket_start"] + FIVE_MINUTES_MS < last_cycle_ms:
        raise ContinuityError("incomplete_candles", "history ends before cycle {}".format(last_cycle_ms))
    return stable_hash([candles_1m, candles_5m])


def reconstruct(log, strategies, product_id, candles_1m, candles_5m, gaps, generated_ms, *, funding=None):
    """Rebuilds the signals of ``gaps`` for one product from complete historical candles and frozen strategies and
    appends them as ``origin = "reconstructed"``. They are evidence for audit and counterfactual evaluation, never
    executable. Returns ``{"persisted", "skipped_warmup", "already_present"}``."""
    check_frozen(log, strategies)
    mine = [g for g in gaps if g["product_id"] == product_id]
    if not mine:
        return {"persisted": 0, "skipped_warmup": 0, "already_present": 0, "candles_hash": None}
    candles_hash = check_candles(candles_1m, candles_5m, max(g["to_ms"] for g in mine))
    wanted = {}
    for g in mine:   # several separate gaps of the same strategy version accumulate, none replaces another
        wanted.setdefault((g["strategy_id"], g["strategy_version"]), set()).update(
            range(g["from_ms"], g["to_ms"] + 1, FIVE_MINUTES_MS))
    by_id = {(s.id, s.version): s for s in strategies}
    cycles = sorted(set().union(*wanted.values()))
    stats = {"persisted": 0, "skipped_warmup": 0, "already_present": 0, "candles_hash": candles_hash, "failed": 0}
    ready = set()
    for frame in frames(candles_1m, candles_5m, merged_indicators(strategies), funding):
        cycle_ms = frame[0] + ONE_MINUTE_MS
        if cycle_ms not in cycles or not on_cycle(frame):
            continue
        ready.add(cycle_ms)
        for strategy in strategies:
            if cycle_ms not in wanted.get((strategy.id, strategy.version), ()):
                continue
            (signal, inputs), = evaluate_cycle([by_id[(strategy.id, strategy.version)]], product_id, cycle_ms, frame)
            receipt = log.ingest(signal, inputs, generated_ms, origin="reconstructed", reconstruction={
                "candles_hash": candles_hash, "source_candle_5m_start_ms": cycle_ms - FIVE_MINUTES_MS,
                "source_candle_1m_start_ms": frame[0], "rebuilt_at_ms": int(generated_ms)})
            stats["already_present" if receipt["status"] == "already_present" else "persisted"] += 1
    # A cycle that could not be rebuilt is not "recovered": say so durably, once per cycle.
    known = {e["data"]["failure_id"] for e in log.entries if e["kind"] == "reconstruction_failed"}
    for (strategy_id, version), cycles_wanted in sorted(wanted.items()):
        for cycle_ms in sorted(cycles_wanted - ready):
            failure_id = stable_hash(["reconstruction-failed", strategy_id, version, product_id, cycle_ms])[:24]
            if failure_id not in known and log.canonical.get(signal_key(strategy_id, version, product_id, cycle_ms)) is None:
                log.append("reconstruction_failed", {"failure_id": failure_id, "strategy_id": strategy_id,
                                                     "strategy_version": version, "product_id": product_id, "cycle_ms": cycle_ms,
                                                     "reason": "indicators_not_ready_or_cycle_not_in_candles",
                                                     "candles_hash": candles_hash}, generated_ms)
                known.add(failure_id)
                stats["failed"] += 1
    stats["skipped_warmup"] = sum(len(c - ready) for c in wanted.values())
    return stats


def verify_log(log, strategies):
    """Integrity and determinism: the chain, every signal's hashes, and (when a compatible strategy is given) that
    re-evaluating the stored inputs gives the stored decision."""
    by_id = {(s.id, s.version): s for s in strategies}
    report = {"chain_intact": log.verify() is None, "head": log.head, "entries": len(log.entries), "signals": 0,
              "originals": 0, "reconstructed": 0, "bad_hashes": [], "not_reproducible": [], "reproduced": 0,
              "not_checked": 0, "not_checked_seqs": []}
    for entry in log.signals(canonical_only=False):
        data, report["signals"] = entry["data"], report["signals"] + 1
        report["originals" if data["origin"] == "original" else "reconstructed"] += 1
        signal = data["signal"]
        try:
            validate_signal(signal)
            ok = (decision_hash(signal) == data["decision_hash"] and stable_hash(data["inputs"]) == data["inputs_hash"]
                  and data["key"] == signal_key(signal["strategy_id"], signal["strategy_version"], signal["product_id"], signal["bucket_ms"]))
        except ValueError:
            ok = False
        if not ok:
            report["bad_hashes"].append(entry["seq"])
            continue
        strategy = by_id.get((signal["strategy_id"], signal["strategy_version"]))
        if strategy is None or (code_hash(strategy), pipeline_hash()) != (data["code_hash"], data["pipeline_hash"]):
            report["not_checked"] += 1   # integrity holds, but nobody proved the decision can be re-derived
            report["not_checked_seqs"].append(entry["seq"])
            continue
        again = strategy.evaluate(context_from_inputs(signal["product_id"], signal["bucket_ms"], data["inputs"]))
        if decision_hash(again) != data["decision_hash"]:
            report["not_reproducible"].append(entry["seq"])
        else:
            report["reproduced"] += 1
    # Two separate claims. integrity_ok: the file and every hash are intact. reproducibility_proven: every signal was
    # re-derived from its stored inputs with the frozen code (none skipped, none different). ``ok`` keeps meaning "no
    # evidence of damage"; only ``reproducibility_proven`` says the decisions were actually re-checked.
    report["integrity_ok"] = report["chain_intact"] and not report["bad_hashes"]
    report["ok"] = report["integrity_ok"] and not report["not_reproducible"]
    report["reproducibility_proven"] = report["ok"] and report["not_checked"] == 0 and report["signals"] > 0
    return report


# ------------------------------------------------------------------------------------------------ entry guard
def guard_entry(entry, now_ms):
    """The single question a future executor must ask before opening a position from a logged signal. Returns the
    entry when it may be used; raises ``RetroactiveEntryError`` for reconstructed signals, for originals whose
    validity window has passed, and for causality violations: the candle has not closed at ``now_ms``, the signal was
    generated after ``now_ms`` (it did not exist yet) or before its candle closed (it cannot have seen that candle)."""
    data = entry["data"]
    if data["origin"] != "original" or not data["executable"]:
        raise RetroactiveEntryError("reconstructed_signal", "seq {} is evidence, not an order".format(entry["seq"]))
    if now_ms < data["cycle_ms"]:
        raise RetroactiveEntryError("candle_not_closed", "seq {}: now {} < candle close {}".format(entry["seq"], now_ms, data["cycle_ms"]))
    if data["generated_ms"] > now_ms:
        raise RetroactiveEntryError("generated_after_evaluation", "seq {}: generated {} > now {}".format(entry["seq"], data["generated_ms"], now_ms))
    if data["generated_ms"] < data["cycle_ms"]:
        raise RetroactiveEntryError("generated_before_candle_close", "seq {}: generated {} < candle close {}".format(
            entry["seq"], data["generated_ms"], data["cycle_ms"]))
    if now_ms > data["valid_until_ms"]:
        raise RetroactiveEntryError("signal_expired", "seq {}: now {} > valid until {}".format(entry["seq"], now_ms, data["valid_until_ms"]))
    return entry


def entry_status(entry, now_ms):
    """``(executable, reason)`` without raising."""
    try:
        guard_entry(entry, now_ms)
        return True, None
    except RetroactiveEntryError as error:
        return False, error.reason


# ------------------------------------------------------------------------------------------------ checkpoint
def write_atomic(path, text):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class Delivery:
    """What the handler receives: the log entry and whether it may open a position right now."""

    def __init__(self, entry, executable, reason, now_ms):
        self.entry, self.executable, self.reason, self.now_ms = entry, executable, reason, now_ms
        self.key, self.signal = entry["data"]["key"], entry["data"]["signal"]

    def require_executable(self):
        return guard_entry(self.entry, self.now_ms)


class Consumer:
    """Processes the log after a durable offset. Order of every step: the signal is already durable in the log ->
    the handler runs (and must be idempotent by ``delivery.key``) -> the checkpoint moves. A crash anywhere repeats at
    most the handler call, never skips a signal."""

    def __init__(self, log, directory, handler, clock):
        self.log, self.directory, self.handler, self.clock = log, directory, handler, clock
        self.path = os.path.join(directory, CHECKPOINT_FILE)
        self.committed_seq, self.processed, self.confirmed_offset = 0, 0, None

    # ---- checkpoint file
    def _body(self, seq):
        entry = self.log.entries[seq - 1]
        return {"schema": CHECKPOINT_SCHEMA, "committed_seq": seq, "log_hash_at_seq": entry["hash"],
                "log_start_hash": self.log.entries[0]["hash"], "confirmed_source_offset": self.confirmed_offset}

    def commit(self, seq):
        body = self._body(seq)
        write_atomic(self.path, json.dumps(dict(body, digest=stable_hash(body)), sort_keys=True, indent=1))
        self.committed_seq = seq

    @classmethod
    def start(cls, directory, handler, clock, t_ms):
        """New directory: creates log and checkpoint. Existing: refuses a missing half instead of starting over."""
        log_path, ckpt_path = os.path.join(directory, LOG_FILE), os.path.join(directory, CHECKPOINT_FILE)
        has_log, has_ckpt = os.path.exists(log_path), os.path.exists(ckpt_path)
        if not has_log and not has_ckpt:
            os.makedirs(directory, exist_ok=True)
            consumer = cls(SignalLog.create(log_path, t_ms), directory, handler, clock)
            consumer.commit(1)
            return consumer
        if not has_log:
            raise ContinuityError("log_missing", "checkpoint exists without a log")
        log = SignalLog.load(log_path)
        consumer = cls(log, directory, handler, clock)
        if not has_ckpt:
            if len(log.entries) <= 1:   # crashed between creating the log and its first checkpoint
                consumer.commit(1)
                return consumer
            raise ContinuityError("checkpoint_missing", "log has {} entries but no checkpoint".format(len(log.entries)))
        consumer.restore()
        return consumer

    def restore(self):
        try:
            with open(self.path, encoding="utf-8") as handle:
                stored = json.load(handle)
            body = {k: v for k, v in stored.items() if k != "digest"}
            if stable_hash(body) != stored["digest"]:
                raise ValueError("digest mismatch")
        except (ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
            raise ContinuityError("corrupt_checkpoint", str(error)) from error
        if body.get("schema") != CHECKPOINT_SCHEMA:
            raise ContinuityError("checkpoint_incompatible", str(body.get("schema")))
        if "confirmed_source_offset" not in body:
            raise ContinuityError("checkpoint_incompatible", "no confirmed offset")
        seq = body["committed_seq"]
        if not isinstance(seq, int) or seq < 1:
            raise ContinuityError("corrupt_checkpoint", "bad offset")
        if seq > len(self.log.entries):
            raise ContinuityError("log_behind_checkpoint", "checkpoint at {}, log has {}".format(seq, len(self.log.entries)))
        if self.log.entries[seq - 1]["hash"] != body["log_hash_at_seq"] or self.log.entries[0]["hash"] != body["log_start_hash"]:
            raise ContinuityError("log_mismatch", "checkpoint does not belong to this log")
        self.committed_seq = seq
        self.confirmed_offset = body["confirmed_source_offset"]

    def rebuild_checkpoint(self, t_ms):
        """Explicit operator action after ``corrupt_checkpoint``: forget the offset and reprocess from the start.
        Safe only because handlers are idempotent; the decision is written in the log."""
        self.log.append("checkpoint_rebuilt", {"reason": "operator", "from_seq": 1}, t_ms)
        self.confirmed_offset = None
        self.commit(1)

    # ---- processing
    def run(self, limit=None):
        """Delivers every signal after the offset, in log order. Returns the number delivered."""
        done = 0
        while self.committed_seq < len(self.log.entries) and (limit is None or done < limit):
            entry = self.log.entries[self.committed_seq]   # seq = committed_seq + 1
            if entry["kind"] == "signal":
                now = self.clock()
                executable, reason = entry_status(entry, now)
                self.handler(Delivery(entry, executable, reason, now))
                _hit("before_ack")
                offset = entry["data"].get("source_offset")
                if offset is not None:   # confirmed = delivered AND acknowledged, never merely persisted
                    self.confirmed_offset = max(offset, self.confirmed_offset or 0)
                done += 1
            self.commit(entry["seq"])
        self.processed += done
        return done


class EffectSink:
    """Demo handler. Idempotent by key: records what a downstream consumer would do, and never reaches a portfolio.
    A BUY/SELL that may open a position is a ``would_open``; everything else is ``audit`` or ``counterfactual``."""

    def __init__(self, path):
        self.path, self.keys = path, set()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                self.keys = {json.loads(line)["key"] for line in handle if line.strip()}

    def __call__(self, delivery):
        if delivery.key in self.keys:
            return False
        action = delivery.signal["action"]
        if action == WAIT:
            kind = "wait"
        elif delivery.executable:
            delivery.require_executable()
            kind = "would_open"
        else:
            kind = "counterfactual"
        line = json.dumps({"key": delivery.key, "kind": kind, "origin": delivery.entry["data"]["origin"],
                           "reason": delivery.reason, "strategy_id": delivery.signal["strategy_id"],
                           "product_id": delivery.signal["product_id"], "cycle_ms": delivery.entry["data"]["cycle_ms"],
                           "action": action}, sort_keys=True, separators=(",", ":"))
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.keys.add(delivery.key)
        return True


# ------------------------------------------------------------------------------------------------ demo on captured candles
DEMO_PRODUCT = "PF_XBTUSD"
DEMO_START_MS = 1_791_000_000_000 - (1_791_000_000_000 % FIVE_MINUTES_MS)


class _MomentumV2(MomentumStrategy):
    """A *new version* of the momentum strategy (different threshold, version bumped)."""
    version = 2
    Z_MIN = D("1.2")


class _MomentumEdited(MomentumStrategy):
    """The same version with different behaviour: exactly what freezing must catch."""
    Z_MIN = D("1.0")


def demo_strategies(variant="same"):
    """The demo strategies. ``bumped``/``edited`` swap momentum for an incompatible implementation."""
    base = [s for s in default_strategies() if s.id != "mx-funding-v1"]   # funding needs 30 days of funding history
    swap = {"bumped": _MomentumV2, "edited": _MomentumEdited}.get(variant)
    return base if swap is None else [swap() if s.id == "mx-momentum-v1" else s for s in base]


def real_candles(path, product=DEMO_PRODUCT):
    """Official candles of one product from a captured ``paper_futures_official_candles.jsonl``: ``(ones, fives)`` in the
    shape the strategies read. The 1-minute rows are the capture's own (last revision per bucket); each 5-minute bar is
    built from its five consecutive minutes. Raises ``ContinuityError`` if the minutes are not consecutive."""
    latest = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line) if line.strip() else None
            if row and row["product_id"] == product and row["interval_ms"] == ONE_MINUTE_MS:
                kept = latest.get(row["bucket_start"])
                if kept is None or (row["known_at"], row["revision_hash"]) > (kept["known_at"], kept["revision_hash"]):
                    latest[row["bucket_start"]] = row
    ones = [{"interval_ms": ONE_MINUTE_MS, "bucket_start": r["bucket_start"], "close_at": r["bucket_start"] + ONE_MINUTE_MS,
             "known_at": r["known_at"], "open": r["open_price"], "high": r["high_price"], "low": r["low_price"],
             "close": r["close_price"], "volume_btc": r["volume_btc"], "revision_hash": r["revision_hash"]}
            for _, r in sorted(latest.items())]
    if not ones or any(b["bucket_start"] - a["bucket_start"] != ONE_MINUTE_MS for a, b in zip(ones, ones[1:])):
        raise ContinuityError("candles_not_consecutive", "the captured candles have a hole or are empty")
    first = -(-ones[0]["bucket_start"] // FIVE_MINUTES_MS) * FIVE_MINUTES_MS
    fives = []
    for start in range((first - ones[0]["bucket_start"]) // ONE_MINUTE_MS, len(ones) - 4, 5):
        chunk = ones[start:start + 5]
        fives.append({"interval_ms": FIVE_MINUTES_MS, "bucket_start": chunk[0]["bucket_start"],
                      "close_at": chunk[0]["bucket_start"] + FIVE_MINUTES_MS, "known_at": chunk[-1]["known_at"],
                      "open": chunk[0]["open"], "high": str(max(D(c["high"]) for c in chunk)),
                      "low": str(min(D(c["low"]) for c in chunk)), "close": chunk[-1]["close"],
                      "volume_btc": str(sum(D(c["volume_btc"]) for c in chunk)),
                      "revision_hash": stable_hash([c["revision_hash"] for c in chunk])})
    return ones, fives


def live_cycles(strategies, ones, fives, product=DEMO_PRODUCT):
    """The incremental (live) path: ``[(cycle_ms, [(signal, inputs)])]`` through ``FrameFeeder``."""
    out = []
    for frame in FrameFeeder(merged_indicators(strategies)).stream(ones, fives):
        if on_cycle(frame):
            out.append((frame[0] + ONE_MINUTE_MS, evaluate_cycle(strategies, product, frame[0] + ONE_MINUTE_MS, frame)))
    return out


def _list(text):
    return [int(x) for x in text.split(",") if x != ""]


def cmd_produce(args):
    """Process A: delivers cycles [from, to) to the log + consumer. ``--drop`` loses events, ``--duplicate`` delivers
    every event twice, ``--crash point[:n]`` kills the process hard at a fault point."""
    strategies, (ones, fives) = demo_strategies(), real_candles(args.candles)
    start_ms = ones[0]["bucket_start"]
    sink = EffectSink(os.path.join(args.dir, EFFECTS_FILE))
    clock_state = {"now": 0}
    consumer = Consumer.start(args.dir, sink, lambda: clock_state["now"], start_ms)
    for strategy in strategies:
        consumer.log.freeze_strategy(strategy, start_ms)
    if args.crash:
        point, _, nth = args.crash.partition(":")
        arm(point, int(nth or 1))
    drop = set(_list(args.drop))
    cycles = live_cycles(strategies, ones, fives)
    try:
        for index, (cycle_ms, pairs) in enumerate(cycles):
            if not args.start <= index < args.stop:
                continue
            clock_state["now"] = cycle_ms + 2_000
            for position, (signal, inputs) in enumerate(pairs, start=1):
                offset = index * len(strategies) + position   # the upstream's delivery number, stable across runs
                if offset in drop:
                    continue   # the event never reached us
                for _ in range(2 if args.duplicate else 1):
                    consumer.log.ingest(signal, inputs, clock_state["now"], source_offset=offset)
            consumer.run()
    except SimulatedCrash as crash:
        sys.stderr.write("SIMULATED_CRASH {}\n".format(crash))
        sys.stderr.flush()
        os._exit(137)
    return 0


def cmd_recover(args):
    """Process B: restores, finishes the unprocessed tail, detects gaps, reconstructs, writes ``report.json``."""
    strategies, (ones, fives) = demo_strategies(args.variant), real_candles(args.candles)
    sink = EffectSink(os.path.join(args.dir, EFFECTS_FILE))
    now = ones[-1]["close_at"] + 3_600_000   # 'long after' every cycle: nothing is executable
    try:
        consumer = Consumer.start(args.dir, sink, lambda: now, now)
        check_frozen(consumer.log, strategies)   # before writing anything: an incompatible build must leave no trace
        replayed = consumer.run()
        until = max(c for c, _ in live_cycles(strategies, ones, fives))
        first = min(c for c, _ in live_cycles(strategies, ones, fives))
        gaps = detect_gaps(consumer.log, strategies, [DEMO_PRODUCT], until, from_ms=first)
        record_gaps(consumer.log, gaps, now)
        stats = reconstruct(consumer.log, strategies, DEMO_PRODUCT, ones, fives, gaps, now)
        replayed += consumer.run()
        remaining = detect_gaps(consumer.log, strategies, [DEMO_PRODUCT], until, from_ms=first)
    except ContinuityError as error:
        sys.stderr.write("RECOVERY_REFUSED {}\n".format(error.reason))
        return 3
    result = {"replayed": replayed, "gaps": gaps, "unrecovered_gaps": remaining, "recovered_completely": not remaining,
              "confirmed_source_offset": consumer.confirmed_offset, "reconstruction": stats, "source_offset_holes": source_offset_holes(consumer.log),
              "verify": verify_log(consumer.log, strategies), "log_head": consumer.log.head,
              "committed_seq": consumer.committed_seq, "tail_discarded_bytes": consumer.log.tail_discarded}
    write_atomic(os.path.join(args.dir, "report.json"), json.dumps(result, sort_keys=True, indent=1))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="role", required=True)
    produce = sub.add_parser("produce")
    produce.add_argument("--dir", required=True)
    produce.add_argument("--candles", required=True, help="captured paper_futures_official_candles.jsonl")
    produce.add_argument("--start", type=int, default=0)
    produce.add_argument("--stop", type=int, default=10 ** 9)
    produce.add_argument("--drop", default="")
    produce.add_argument("--duplicate", action="store_true")
    produce.add_argument("--crash", default="")
    recover = sub.add_parser("recover")
    recover.add_argument("--dir", required=True)
    recover.add_argument("--candles", required=True, help="captured paper_futures_official_candles.jsonl")
    recover.add_argument("--variant", choices=("same", "bumped", "edited"), default="same")
    args = parser.parse_args(argv)
    try:
        return cmd_produce(args) if args.role == "produce" else cmd_recover(args)
    except ContinuityError as error:
        sys.stderr.write("RECOVERY_REFUSED {}\n".format(error.reason))
        return 3


if __name__ == "__main__":
    sys.exit(main())
