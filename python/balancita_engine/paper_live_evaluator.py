"""Stage 10C: the session-side evaluator. Closed candles and funding in, ``cycle`` events and signals out, with the exact
pipeline the 9A replay uses.

What is shared with the replay (imported, not copied): ``FrameFeeder`` (incremental indicators), ``FundingContext`` (the
forward's funding line), ``signal_continuity.on_cycle`` / ``evaluate_cycle`` (the cycle condition and the only place a
signal context is built), the frozen specs (``replay_specs.load_frozen`` with their pinned hashes), the volatility the
runner takes as ``atr`` (``cycle_atr``), and the funding audit record. This module adds no indicator, no strategy rule, no
risk, cost or accounting rule and does not open a source: whoever runs it hands it closed candles and funding hours.

What it adds, because a session is not a batch:

* it works one closed 1-minute candle at a time and derives the 5-minute bar from the five minutes it covers (the replay
  reads the stored 5-minute series; ``replay_data.consistency_5m_vs_1m`` is the check that both agree, see docs);
* a missing minute is a gap: the features after it are not trusted, so the feeder is rebuilt and cycles stay suppressed for
  the warm-up the declared indicators need (the replay refuses to start on a gap in its decision window);
* every input is written, hash-chained, to its own log *before* it is used, so a crash is recovered by feeding the log again
  (no pickle, no dependence on how long the capture retains rows). A candle handed in again returns the cycle it produced
  the first time (same ``event_id``), so a crash between "evaluated" and "journaled by the runner" loses nothing and
  duplicates nothing;
* ``candle_tolerance_ms`` (optional, named by the operator): a candle that arrives more than that after its minute closed keeps feeding
  the indicators but makes no cycle (``suppressed`` with reason ``candle_late``): data that old does not decide an entry;
* a funding hour that arrives after cycles that needed it is counted (``late_funding``): those cycles used what was
  published at the time, which is causal but not what a replay with the complete series would have used.

No wall clock, no network, no randomness. The cycle's arrival time is the arrival time of the candle that closed its bar.
"""

import hashlib
import json
import os
from decimal import Decimal, InvalidOperation

from . import replay_driver as RP
from . import replay_funding_audit as RFA
from . import signal_continuity as SC
from .futures_funding_context import PUBLICATION_LAG_MS, FundingContext, with_publication_wait
from .futures_simulator import FIVE_MINUTES_MS, ONE_MINUTE_MS
from .multi_experiment import FrameFeeder, required_warmup_ms
from .multi_signals import merged_indicators, stable_hash

D = Decimal
HOUR_MS = 3_600_000
SCHEMA = "balancita-paper-live-evaluator.v1"
LOG_SCHEMA = "balancita-paper-live-evaluator-log.v1"
GENESIS = "0" * 64
SEEN_MINUTES = 2880                        # candles remembered to detect a revised repeat (two days)
MAX_PENDING_FRAMES = 288                   # per product: one day of 5-minute cycles waiting for the runner to evaluate them
RETAIN_CYCLES = 2880                       # per product: cycles and funding flags kept for duplicates and late-funding counts
CYCLE_ASSEMBLY = "cycle-payload.v1"        # product_id, cycle_ms, price = candidate_close, atr = cycle_atr or atr14


class EvaluatorError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


def aggregate_five(minutes):
    """The 5-minute candle covered by five consecutive 1-minute candles, in the shape ``futures_simulator.frames`` reads.
    Open and close are the first and last minute's own text; high and low keep the text of the extreme minute."""
    high = max(minutes, key=lambda c: D(c["high"]))
    low = min(minutes, key=lambda c: D(c["low"]))
    volume = sum((D(c["volume_btc"]) for c in minutes), D(0))
    return {"bucket_start": minutes[0]["bucket_start"], "open": minutes[0]["open"], "high": high["high"],
            "low": low["low"], "close": minutes[-1]["close"], "volume_btc": format(volume, "f")}


def _valid_candle(candle):
    try:
        o, h, l, c, v = (D(str(candle[k])) for k in ("open", "high", "low", "close", "volume_btc"))   # noqa: E741
        bucket = candle["bucket_start"]
    except (KeyError, InvalidOperation, TypeError):
        return False
    return isinstance(bucket, int) and not isinstance(bucket, bool) and bucket % ONE_MINUTE_MS == 0 \
        and all(x.is_finite() for x in (o, h, l, c, v)) and min(o, h, l, c) > 0 and v >= 0 and l <= min(o, c) and h >= max(o, c)


class InputLog(object):
    """Append-only, hash-chained, ``fsync`` per entry. A last line that is not complete is a crash: it is dropped and counted."""

    def __init__(self, path):
        self.path, self.head, self.entries, self.tail_discarded = path, GENESIS, [], 0

    @classmethod
    def create(cls, path, header):
        if os.path.exists(path):
            raise EvaluatorError("log_exists", path)
        log = cls(path)
        open(path, "w", encoding="utf-8").close()
        log.append("header", header)
        return log

    @classmethod
    def open(cls, path):
        log = cls(path)
        with open(path, "rb") as handle:
            data = handle.read()
        lines = data.split(b"\n")
        complete, tail = lines[:-1], lines[-1]
        if tail:                                    # bytes after the last newline: an append that never finished
            log.tail_discarded = 1
            with open(path, "wb") as handle:        # leave only whole lines on disk
                handle.write(b"\n".join(complete) + (b"\n" if complete else b""))
        for number, line in enumerate(complete, 1):
            try:
                entry = json.loads(line)
                body = {k: entry[k] for k in ("seq", "kind", "data", "prev")}
                ok = entry["seq"] == number and entry["prev"] == log.head and entry["hash"] == stable_hash(body)
            except (ValueError, KeyError, TypeError):
                ok = False
            if not ok:
                raise EvaluatorError("log_corrupt", "line {}".format(number))
            log.entries.append(entry)
            log.head = entry["hash"]
        if not log.entries or log.entries[0]["kind"] != "header" or log.entries[0]["data"].get("schema") != LOG_SCHEMA:
            raise EvaluatorError("log_header", path)
        return log

    def append(self, kind, data):
        body = {"seq": len(self.entries) + 1, "kind": kind, "data": data, "prev": self.head}
        entry = dict(body, hash=stable_hash(body))
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.entries.append(entry)
        self.head = entry["hash"]
        return entry


class LiveEvaluator(object):
    def __init__(self, strategies, products, log, *, decide_from_ms, decide_until_ms=None, source="paper-live-eval",
                 max_pending_frames=MAX_PENDING_FRAMES, retain_cycles=RETAIN_CYCLES, candle_tolerance_ms=None):
        if not strategies:
            raise EvaluatorError("no_strategy")
        if candle_tolerance_ms is not None and (not isinstance(candle_tolerance_ms, int) or isinstance(candle_tolerance_ms, bool)
                                                or candle_tolerance_ms <= 0):
            raise EvaluatorError("candle_tolerance_invalid", "a positive integer number of milliseconds")
        self.candle_tolerance_ms = candle_tolerance_ms
        self.strategies, self.products = list(strategies), list(products)
        self.decide_from_ms, self.decide_until_ms, self.source = int(decide_from_ms), decide_until_ms, source
        self.periods = merged_indicators(self.strategies)
        self.warmup_ms = required_warmup_ms(self.periods)
        self.bands = next((s.funding_bands for s in self.strategies if getattr(s, "funding_bands", None)), None)
        self.cycle_atr = next((s.cycle_atr for s in self.strategies if hasattr(s, "cycle_atr")), None)
        self.log = log
        self.state = {p: self._fresh_product() for p in self.products}
        self.cycles, self.frames, self.flags = {}, {}, {}
        self.audit_rows, self.gaps, self.suppressed, self.late_funding, self.rejected = [], [], [], [], []
        self.conflicts, self.seen = [], {}
        self.max_pending_frames, self.retain_cycles = int(max_pending_frames), int(retain_cycles)
        self.frames_expired, self.evaluation_misses = [], []
        self.recovering, self.dropped_on_recovery = False, set()
        self.fault = None                    # tests only: ``fault(point)`` may raise to simulate a process death at ``point``
        self.config = self._config()
        self.config_digest = stable_hash(self.config)[:16]
        self.stats = {"candles": 0, "duplicates": 0, "cycles": 0, "funding_hours": 0}

    # ---- construction ----------------------------------------------------------------------------------------
    @classmethod
    def create(cls, path, strategies, products, *, decide_from_ms, decide_until_ms=None, **kw):
        evaluator = cls(strategies, products, None, decide_from_ms=decide_from_ms, decide_until_ms=decide_until_ms, **kw)
        header = {"schema": LOG_SCHEMA, "products": list(products), "decide_from_ms": int(decide_from_ms),
                  "decide_until_ms": decide_until_ms, "strategies": ["{}@{}".format(s.id, s.version) for s in strategies],
                  "config": evaluator.config, "config_digest": evaluator.config_digest}
        evaluator.log = InputLog.create(path, header)
        return evaluator

    @classmethod
    def recover(cls, path, strategies, **kw):
        """Feeds the logged inputs again, in order, to a fresh evaluator: same cycles, same events, same frames. The
        configuration written in the log header must be the one in force now: otherwise ``strategies_changed`` (another
        id@version) or ``config_incompatible`` (anything else: a spec hash, ticks, indicators, source, window, warm-up, pipeline
        or evaluator code). Nothing is replayed under a different configuration."""
        log = InputLog.open(path)
        header = log.entries[0]["data"]
        if header["strategies"] != ["{}@{}".format(s.id, s.version) for s in strategies]:
            raise EvaluatorError("strategies_changed", "the log was written for {}".format(header["strategies"]))
        if "config_digest" not in header or "config" not in header:
            raise EvaluatorError("log_header", "no configuration identity in the header")
        kw.setdefault("source", header["config"]["source"])
        for name in ("max_pending_frames", "retain_cycles"):
            kw.setdefault(name, header["config"].get("bounds", {}).get(name, kw.get(name, globals()[name.upper()])))
        evaluator = cls(strategies, header["products"], log, decide_from_ms=header["decide_from_ms"],
                        decide_until_ms=header["decide_until_ms"], **kw)
        if evaluator.config_digest != header["config_digest"]:
            differs = sorted(k for k in set(evaluator.config) | set(header["config"])
                             if evaluator.config.get(k) != header["config"].get(k))
            raise EvaluatorError("config_incompatible", "the log was written under another configuration: " + ", ".join(differs))
        evaluator.recovering = True
        for entry in log.entries[1:]:
            if entry["kind"] == "candle":
                evaluator._apply_candle(entry["data"]["product_id"], entry["data"]["candle"], entry["data"]["arrival_ms"])
            elif entry["kind"] == "conflict":
                evaluator.conflicts.append(entry["data"])
            elif entry["kind"] == "funding":
                d = entry["data"]
                evaluator._apply_funding(d["product_id"], d["start_ms"], d["rate"], d["arrival_ms"])
            else:
                raise EvaluatorError("log_entry_kind", entry["kind"])
        evaluator.recovering = False
        return evaluator

    @staticmethod
    def _fresh_product():
        return {"feeder": None, "last_one": -1, "bar": {}, "funding": {}, "context": FundingContext([]),
                "suppress_until": -1}

    # ---- inputs ----------------------------------------------------------------------------------------------
    def feed_candle(self, product, candle, arrival_ms):
        """One closed 1-minute candle. Returns ``{"cycle": event or None, "duplicate": bool, "rejected": reason or None}``."""
        if product not in self.state:
            raise EvaluatorError("unknown_product", product)
        if not _valid_candle(candle):
            self.rejected.append({"product_id": product, "bucket_start": candle.get("bucket_start") if isinstance(candle, dict) else None,
                                  "reason": "invalid_candle"})
            return {"cycle": None, "duplicate": False, "rejected": "invalid_candle"}
        bucket = candle["bucket_start"]
        if int(arrival_ms) < bucket + ONE_MINUTE_MS:                      # a candle cannot arrive before its minute ends
            self.rejected.append({"product_id": product, "bucket_start": bucket, "reason": "arrival_before_close"})
            return {"cycle": None, "duplicate": False, "rejected": "arrival_before_close"}
        if bucket > self.state[product]["last_one"]:                      # a repeat is not logged twice
            self.log.append("candle", {"product_id": product, "arrival_ms": int(arrival_ms), "candle": candle})
            if self.fault is not None:
                self.fault("input_logged")
        else:
            known = self.seen.get((product, bucket))
            if known is not None and known != stable_hash(candle):         # the source revised a minute we already used
                data = {"product_id": product, "bucket_start": bucket, "arrival_ms": int(arrival_ms), "candle": candle}
                self.log.append("conflict", data)
                self.conflicts.append(data)
        return self._apply_candle(product, candle, arrival_ms)

    def feed_funding(self, product, start_ms, rate, arrival_ms):
        """One funding hour (``rate`` is Kraken's relative hourly rate, as text or number)."""
        if product not in self.state:
            raise EvaluatorError("unknown_product", product)
        if start_ms in self.state[product]["funding"]:
            return False                                                 # first seen wins, as in the forward
        if int(arrival_ms) < int(start_ms) + HOUR_MS:                    # an hour that has not ended is provisional: never fixed
            self.rejected.append({"product_id": product, "hour_ms": int(start_ms), "reason": "funding_before_hour_end"})
            return False
        self.log.append("funding", {"product_id": product, "start_ms": int(start_ms), "rate": float(rate),
                                    "arrival_ms": int(arrival_ms)})
        return self._apply_funding(product, start_ms, float(rate), arrival_ms)

    # ---- the pipeline (shared with recovery) -------------------------------------------------------------------
    def _apply_funding(self, product, start_ms, rate, arrival_ms):
        state = self.state[product]
        if start_ms in state["funding"]:
            return False
        state["funding"][start_ms] = rate
        state["context"] = FundingContext(with_publication_wait(sorted(state["funding"].items())))
        self.stats["funding_hours"] += 1
        due = start_ms + HOUR_MS + PUBLICATION_LAG_MS
        if arrival_ms > due:
            used = sum(1 for (p, close), _ in self.cycles.items() if p == product and due <= close)
            self.late_funding.append({"product_id": product, "hour_ms": start_ms, "due_ms": due, "arrival_ms": int(arrival_ms),
                                      "cycles_evaluated_without_it": used})
        return True

    def _apply_candle(self, product, candle, arrival_ms):
        state = self.state[product]
        bucket = candle["bucket_start"]
        close_ms = bucket + ONE_MINUTE_MS
        if bucket <= state["last_one"]:
            self.stats["duplicates"] += 1
            return {"cycle": self.cycles.get((product, close_ms)), "duplicate": True, "rejected": None}
        if state["last_one"] >= 0 and bucket != state["last_one"] + ONE_MINUTE_MS:
            self.gaps.append({"product_id": product, "from_ms": state["last_one"] + ONE_MINUTE_MS, "to_ms": bucket})
            state["feeder"], state["bar"] = None, {}
            state["suppress_until"] = bucket + self.warmup_ms
        if state["feeder"] is None:
            state["feeder"] = FrameFeeder(self.periods)
        self.stats["candles"] += 1
        self.seen[(product, bucket)] = stable_hash(candle)
        self.seen.pop((product, bucket - SEEN_MINUTES * ONE_MINUTE_MS), None)
        bar_start = bucket - bucket % FIVE_MINUTES_MS
        state["bar"][bucket] = candle
        five = None
        if close_ms % FIVE_MINUTES_MS == 0:
            minutes = [state["bar"].get(bar_start + i * ONE_MINUTE_MS) for i in range(5)]
            if all(m is not None for m in minutes):
                five = aggregate_five(minutes)
            state["bar"] = {}
        frame = next(iter(state["feeder"].stream([candle], [five] if five else [], state["context"])))
        state["last_one"] = bucket
        if not SC.on_cycle(frame):
            return {"cycle": None, "duplicate": False, "rejected": None}
        if close_ms < self.decide_from_ms or (self.decide_until_ms is not None and close_ms >= self.decide_until_ms):
            return {"cycle": None, "duplicate": False, "rejected": None}
        if close_ms < state["suppress_until"]:
            self.suppressed.append({"product_id": product, "cycle_ms": close_ms, "reason": "gap_warmup",
                                    "until_ms": state["suppress_until"]})
            return {"cycle": None, "duplicate": False, "rejected": None}
        if self.candle_tolerance_ms is not None and int(arrival_ms) - close_ms > self.candle_tolerance_ms:
            # the minute ended too long ago for this candle to drive a decision: the features are kept (the candle is real), no cycle is made
            self.suppressed.append({"product_id": product, "cycle_ms": close_ms, "reason": "candle_late",
                                    "lag_ms": int(arrival_ms) - close_ms, "tolerance_ms": self.candle_tolerance_ms})
            return {"cycle": None, "duplicate": False, "rejected": None}
        event = RP.make_cycle_event(product, close_ms, frame, self.cycle_atr, source=self.source,
                                    lag_ms=max(int(arrival_ms) - close_ms, 0))
        key = (product, close_ms)
        self.cycles[key], self.frames[key] = event, frame
        self._bound(product)
        self.flags[key] = RFA.audit_record(state["context"], close_ms, self.bands)
        self.stats["cycles"] += 1
        return {"cycle": event, "duplicate": False, "rejected": None}

    def _bound(self, product):
        """Memory is bounded by count, never by age: a frame waits for the runner for as long as fewer than
        ``max_pending_frames`` newer ones are pending. Past that the oldest is dropped *with a record*
        (``frames_expired``); asking for it then raises ``frame_expired`` and the runner rejects the cycle (no signal is made
        or changed). Cycles and funding flags older than ``retain_cycles`` are forgotten (they only serve duplicates and the
        late-funding count)."""
        pending = sorted(k for k in self.frames if k[0] == product)
        for key in pending[:max(len(pending) - self.max_pending_frames, 0)]:
            del self.frames[key]
            if self.recovering:             # rebuilding from the log: most of these were evaluated long ago, so it is no evidence
                self.dropped_on_recovery.add(key)
            else:
                self.frames_expired.append({"product_id": key[0], "cycle_ms": key[1], "reason": "frame_expired"})
        kept = sorted(k for k in self.cycles if k[0] == product)
        for key in kept[:max(len(kept) - self.retain_cycles, 0)]:
            self.cycles.pop(key, None)
            self.flags.pop(key, None)

    # ---- what the runner calls ---------------------------------------------------------------------------------
    def evaluator(self, chosen, payload):
        """``PaperRunner(..., evaluator=live.evaluator)``: the frame of this cycle through ``evaluate_cycle``. A cycle the
        evaluator did not produce has no frame and the runner rejects it (``evaluation_failed``)."""
        key = (payload["product_id"], payload["cycle_ms"])
        if key not in self.frames:
            expired = key in self.dropped_on_recovery or any(e["product_id"] == key[0] and e["cycle_ms"] == key[1]
                                                            for e in self.frames_expired)
            reason = "frame_expired" if expired else ("already_evaluated" if key in self.cycles else "unknown_cycle")
            self.evaluation_misses.append({"product_id": key[0], "cycle_ms": key[1], "reason": reason})
            raise EvaluatorError(reason, "{} {}".format(key[0], key[1]))
        frame, flag = self.frames.pop(key), self.flags[key]
        results = SC.evaluate_cycle(chosen, payload["product_id"], payload["cycle_ms"], frame)
        for strategy, (signal, _inputs) in zip(chosen, results):
            if getattr(strategy, "uses_funding", False):
                row = RP.funding_audit_row(strategy, payload["product_id"], signal["action"], flag)
                self.audit_rows.append(row)
        return results

    # ---- identity ------------------------------------------------------------------------------------------------
    def _config(self):
        """Everything that decides what the evaluator produces from a given input, and nothing that depends on the inputs."""
        body = {"schema": SCHEMA, "strategies": {s.id: {"version": s.version, "spec_hash": getattr(s, "spec_hash", None)}
                                                for s in self.strategies},
                "products": sorted(self.products),
                "indicators": {k: list(v) for k, v in sorted(self.periods.items())}, "cycle_assembly": CYCLE_ASSEMBLY,
                "tick_sizes": dict(sorted(getattr(self.strategies[0], "tick_sizes", {}).items())),
                "warmup_ms": self.warmup_ms, "five_minute_bar": "aggregated_from_1m", "source": self.source,
                "decide_from_ms": self.decide_from_ms, "decide_until_ms": self.decide_until_ms,
                "bounds": {"max_pending_frames": self.max_pending_frames, "retain_cycles": self.retain_cycles}}
        if self.candle_tolerance_ms is not None:                # named only when set: a configuration without it keeps its digest
            body["candle_tolerance_ms"] = self.candle_tolerance_ms
        with open(os.path.abspath(__file__), "rb") as handle:
            body["code"] = {"replay_pipeline": RP.code_identity()["digest"],
                            "evaluator_sha256": hashlib.sha256(handle.read().replace(b"\r\n", b"\n")).hexdigest()[:16]}
        return body

    def identity(self, spec_identity=None):
        """``config`` / ``config_digest``: the immutable configuration, stored in the log header and checked by ``recover``.
        ``digest``: the full identity of a result, which adds the head of the input log. ``spec_identity`` is the second value
        ``load_frozen`` returns (file hashes); it is reported but is not part of the digest the header holds."""
        out = dict(self.config, config=self.config, config_digest=self.config_digest,
                   input_log={"entries": len(self.log.entries), "head": self.log.head})
        out["digest"] = stable_hash({"config_digest": self.config_digest, "input_log": out["input_log"]})[:16]
        if spec_identity is not None:
            out["spec_files"] = spec_identity
        return out

    def report(self):
        return {"stats": dict(self.stats), "gaps": list(self.gaps), "suppressed": list(self.suppressed),
                "late_funding": list(self.late_funding), "rejected": list(self.rejected), "candle_conflicts": list(self.conflicts), "frames_expired": list(self.frames_expired), "frames_dropped_on_recovery": len(self.dropped_on_recovery),
                "evaluation_misses": list(self.evaluation_misses),
                "memory": {"pending_frames": len(self.frames), "cycles": len(self.cycles), "flags": len(self.flags),
                           "seen_candles": len(self.seen), "audit_rows": len(self.audit_rows)}, "log_tail_discarded": self.log.tail_discarded}
