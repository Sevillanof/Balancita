"""Stage 10B: offline ingestor from a capture-shaped SQLite database to ``PaperRunner`` events.

Read-only, deterministic and offline. It turns what the capture already stored (REST/WS tickers and official 1-minute
candles) into the envelopes ``PaperRunner.handle`` accepts. It adds no trading, risk, cost or accounting rule, never
evaluates a strategy (no ``cycle`` events are built here: the evaluator is stage 9A's) and has no wall clock: the only
"now" it knows is the ``observed_now_ms`` argument of ``poll`` (the caller's reading of the source clock) and the times
of the rows themselves. Nothing here opens a network connection or writes to the source database.

Rules (docs/etapa-10-integracion-paper-tiempo-real.md, section 3):

* arrival time of an event is the source row's own time (``persisted_at`` for tickers, ``max(known_at, bucket + 60 s)``
  for candles), never the wall clock;
* quotes carry ``source_offset = None``: ticker ``seq`` is a timestamp (REST) or only monotonic (WS), not a contiguous
  counter, so it cannot drive the ``OffsetLedger``; candles use ``bucket // 60 s``, which is contiguous by construction;
* the first revision of a candle is the one with the lowest ``(known_at, revision_hash)`` among the revisions read before
  its release, whatever their ``rowid`` order; later revisions are counted, never applied. An earlier revision that shows
  up after a later one was already emitted is counted (``candle_earlier_revision_after_emit``), never swapped in;
* a ticker row that cannot be parsed is not emitted but is kept as evidence (``rejected_sample``: rowid, event id,
  product, times, content hash and a stable reason code); the count is exact, the sample is capped;
* events are released in order up to a watermark (``latest source time seen - hold_ms``). The watermark is also held
  back while a 1-minute candle is overdue (``candle_lag_ms``): a candle written late must not be left behind by quotes
  that were released first. A row older than what was already released is counted as ``late_source_rows`` and not
  emitted (the runner would reject it as out of order); it stays counted, with a sample, as evidence;
* ``clock`` ticks are emitted only while there is evidence that the capture was alive around the tick (a ticker row
  within ``dead_after_ms`` before it). A silent product with other products still ticking is a quiet market for that
  product; no stream advancing at all is a source outage, and the clock does not move through it.
"""

import json
import sqlite3
from decimal import Decimal, InvalidOperation

from .paper_runner import make_event

SOURCE = "kraken-capture"
ONE_MINUTE_MS = 60_000
DEFAULT_HOLD_MS = 2_000                # hypothesis to test, not an approved value
DEFAULT_DEAD_AFTER_MS = 45_000         # the capture's own ticker-silence limit
DEFAULT_CLOCK_EVERY_MS = 5_000
DEFAULT_CANDLE_LAG_MS = 120_000        # hypothesis: how long an overdue candle holds the watermark back (0 = never)
LATE_SAMPLE = 20                       # late rows kept as evidence (the count is exact)
REJECT_SAMPLE = 50                     # unreadable rows kept as evidence (the count is exact)


class IngestError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


class SourceReader(object):
    """Read-only access to the capture's tables (``mode=ro`` + ``query_only``); opened per poll batch by the caller."""

    def __init__(self, path):
        try:
            self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
            self.db.execute("PRAGMA query_only=ON")
            self.db.row_factory = sqlite3.Row
        except sqlite3.Error as error:
            raise IngestError("source_unreadable", str(error))

    def close(self):
        self.db.close()

    def tickers(self, after_rowid, limit):
        rows = self.db.execute(
            "SELECT rowid AS rid, event_id, product_id, epoch, seq, event_time, received_at, persisted_at, content_hash, "
            "normalized_json "
            "FROM paper_futures_market_events WHERE feed='ticker' AND rowid>? ORDER BY rowid LIMIT ?",
            (after_rowid, limit)).fetchall()
        return [dict(r) for r in rows]

    def candles(self, after_rowid, limit):
        rows = self.db.execute(
            "SELECT rowid AS rid, product_id, bucket_start, revision_hash, known_at, open_price, high_price, low_price, "
            "close_price FROM paper_futures_official_candles WHERE interval_ms=? AND rowid>? ORDER BY rowid LIMIT ?",
            (ONE_MINUTE_MS, after_rowid, limit)).fetchall()
        return [dict(r) for r in rows]

    def begin(self):
        """Both streams of one poll are read inside one transaction, so they come from the same WAL snapshot."""
        self.db.execute("BEGIN")

    def end(self):
        self.db.execute("COMMIT")


def _quote_event(row):
    """``(persisted_at, event)`` or ``(None, reason)``: the reason is a stable code, never free text."""
    try:
        data = json.loads(row["normalized_json"])
    except (ValueError, TypeError):
        return None, "json_invalid"
    if not isinstance(data, dict) or "bid" not in data or "ask" not in data:
        return None, "missing_bid_or_ask"
    try:
        bid, ask = str(data["bid"]), str(data["ask"])
        Decimal(bid), Decimal(ask)
    except (InvalidOperation, ValueError):
        return None, "price_not_decimal"
    payload = {"product_id": row["product_id"], "time_ms": row["event_time"], "received_ms": row["received_at"],
               "bid": bid, "ask": ask}
    return row["persisted_at"], make_event("quote", payload, t_ms=row["persisted_at"], source=SOURCE,
                                           stream="ticker:" + row["product_id"], source_offset=None)


def _candle_event(row):
    t_ms = max(row["known_at"], row["bucket_start"] + ONE_MINUTE_MS)
    payload = {"product_id": row["product_id"], "bucket_ms": row["bucket_start"],
               "candle": {"open": row["open_price"], "high": row["high_price"], "low": row["low_price"],
                          "close": row["close_price"]}}
    return t_ms, make_event("candle", payload, t_ms=t_ms, source=SOURCE, stream="candle1m:" + row["product_id"],
                            source_offset=row["bucket_start"] // ONE_MINUTE_MS)


class Ingestor(object):
    """Reads new rows, holds them until they are safely ordered, and returns the runner events that are ready."""

    def __init__(self, reader, *, hold_ms=DEFAULT_HOLD_MS, dead_after_ms=DEFAULT_DEAD_AFTER_MS,
                 clock_every_ms=DEFAULT_CLOCK_EVERY_MS, candle_lag_ms=DEFAULT_CANDLE_LAG_MS, batch=5_000):
        self.reader, self.hold_ms, self.dead_after_ms = reader, hold_ms, dead_after_ms
        self.clock_every_ms, self.batch, self.candle_lag_ms = clock_every_ms, batch, candle_lag_ms
        self.cursor = {"ticker": 0, "candle": 0}
        self.ticker_more = self.candle_more = False   # a full batch means rows may remain unread
        self.last_candle_read_ms = None
        self._last_candle_t = 0
        self.pending = []                 # (t_ms, order, event, candle key or None) waiting for the watermark
        self.max_ticker_ms = None         # latest ticker time read
        self.last_candle_bucket = {}      # product -> latest candle bucket read (drives the overdue-candle hold)
        self.order = 0
        self.max_seen_ms = None           # latest source time of any row read
        self.released_ms = None           # everything at or below this was released
        self.last_ticker_ms = {}          # product -> latest ticker time read
        self.last_any_ticker_ms = None
        self.clock_cursor = None          # last clock tick emitted
        self.candle_first = {}            # (product, bucket) -> {digest, known} of the revision emitted
        self.candle_pending = {}          # (product, bucket) -> {digest, known} of the revision waiting for release
        self.stats = {"emitted": 0, "late_source_rows": 0, "candle_revisions_seen": 0, "candle_revisions_differing": 0,
                      "unreadable_rows": 0, "candle_earlier_revision_after_emit": 0, "watermark_held_for_candle": 0}
        self.late = []
        self.rejected = []                # unreadable ticker rows kept as evidence
        self.alive_until = None           # last quote time + dead_after_ms: clock ticks only up to here
        self.outages = []                 # intervals where no ticker of any product arrived for dead_after_ms

    # ---- reading ---------------------------------------------------------------------------------------------
    def _queue(self, t_ms, event, key=None):
        if self.released_ms is not None and t_ms <= self.released_ms:
            self.stats["late_source_rows"] += 1
            if len(self.late) < LATE_SAMPLE:
                self.late.append({"stream": event["stream"], "t_ms": t_ms, "released_ms": self.released_ms})
            return False
        self.pending.append((t_ms, self.order, event, key))
        self.order += 1
        return True

    def _read(self):
        self.reader.begin()
        try:
            self._read_streams()
        finally:
            self.reader.end()

    def _read_streams(self):
        rows = self.reader.tickers(self.cursor["ticker"], self.batch)
        self.ticker_more = len(rows) >= self.batch
        for row in rows:
            self.cursor["ticker"] = row["rid"]
            t_ms, event = _quote_event(row)
            if t_ms is None:
                self.stats["unreadable_rows"] += 1
                if len(self.rejected) < REJECT_SAMPLE:
                    self.rejected.append({"rowid": row["rid"], "event_id": row["event_id"], "product_id": row["product_id"],
                                          "persisted_at": row["persisted_at"], "content_hash": row["content_hash"],
                                          "reason": event})
                continue
            self.max_seen_ms = t_ms if self.max_seen_ms is None else max(self.max_seen_ms, t_ms)
            self.max_ticker_ms = t_ms if self.max_ticker_ms is None else max(self.max_ticker_ms, t_ms)
            if self.last_any_ticker_ms is not None and t_ms - self.last_any_ticker_ms > self.dead_after_ms:
                self.outages.append({"from_ms": self.last_any_ticker_ms, "to_ms": t_ms})
            self.last_ticker_ms[row["product_id"]] = max(t_ms, self.last_ticker_ms.get(row["product_id"], t_ms))
            self.last_any_ticker_ms = max(t_ms, self.last_any_ticker_ms or t_ms)
            self._queue(t_ms, event)
        rows = self.reader.candles(self.cursor["candle"], self.batch)
        self.candle_more = len(rows) >= self.batch
        for row in rows:
            self.cursor["candle"] = row["rid"]
            self._read_candle(row)
            self.last_candle_read_ms = max(self.last_candle_read_ms or 0, self._last_candle_t)

    def _read_candle(self, row):
        key = (row["product_id"], row["bucket_start"])
        known = (row["known_at"], row["revision_hash"])
        digest = (row["open_price"], row["high_price"], row["low_price"], row["close_price"])
        self.last_candle_bucket[row["product_id"]] = max(row["bucket_start"],
                                                         self.last_candle_bucket.get(row["product_id"], row["bucket_start"]))
        if key in self.candle_first:                              # a revision was already emitted
            self.stats["candle_revisions_seen"] += 1
            first = self.candle_first[key]
            if first["digest"] != digest:
                self.stats["candle_revisions_differing"] += 1
            if known < first["known"]:
                self.stats["candle_earlier_revision_after_emit"] += 1
            return
        waiting = [p for p in self.pending if p[3] == key]
        if waiting:                                               # same release batch: the lowest (known_at, hash) wins
            held = waiting[0]
            self.stats["candle_revisions_seen"] += 1
            if self.candle_pending[key]["digest"] != digest:
                self.stats["candle_revisions_differing"] += 1
            if known < self.candle_pending[key]["known"]:
                t_ms, event = _candle_event(row)
                self.pending.remove(held)
                if self._queue(t_ms, event, key):
                    self.candle_pending[key] = {"digest": digest, "known": known}
                else:                                             # too late to replace: keep the revision already held
                    self.pending.append(held)
            return
        t_ms, event = _candle_event(row)
        self._last_candle_t = t_ms
        self.max_seen_ms = t_ms if self.max_seen_ms is None else max(self.max_seen_ms, t_ms)
        if self._queue(t_ms, event, key):
            self.candle_pending[key] = {"digest": digest, "known": known}

    # ---- release ---------------------------------------------------------------------------------------------
    def poll(self, observed_now_ms):
        """One reading pass. ``observed_now_ms``: the caller's reading of the source clock (used only to tell a stale
        source from a quiet one). Returns ``{"events": [...], "state": {...}}``; events are in ``t_ms`` order."""
        self._read()
        out = []
        if self.max_seen_ms is not None:
            watermark = self._watermark()
            ready = sorted((p for p in self.pending if p[0] <= watermark), key=lambda p: (p[0], p[2]["event_id"]))
            self.pending = [p for p in self.pending if p[0] > watermark]
            for _, _, _, key in ready:
                if key is not None:
                    self.candle_first[key] = self.candle_pending.pop(key)
            out = self._with_clock(ready, watermark)
            if watermark is not None and (self.released_ms is None or watermark > self.released_ms):
                self.released_ms = watermark
        self.stats["emitted"] += len(out)
        return {"events": out, "state": self.state(observed_now_ms)}

    def _watermark(self):
        """``latest source time seen - hold_ms``, held back while a 1-minute candle is overdue. A product's next candle is
        due when its bucket closes (``bucket + 2 min`` for the one after the latest read); until it shows up, or until
        tickers are ``candle_lag_ms`` past that point, quotes are not released beyond it, so a candle written late is not
        left behind (and dropped as late) by quotes that were released first. Never moves the watermark backwards."""
        watermark = self.max_seen_ms - self.hold_ms
        # a stream with unread rows has not caught up: the others must not run ahead of it (rows would turn up "late")
        if self.ticker_more and self.max_ticker_ms is not None:
            watermark = min(watermark, self.max_ticker_ms - self.hold_ms)
        if self.candle_more and self.last_candle_read_ms is not None:
            watermark = min(watermark, self.last_candle_read_ms - self.hold_ms)
        if self.candle_lag_ms > 0 and self.max_ticker_ms is not None:
            due = [bucket + 2 * ONE_MINUTE_MS - 1 for bucket in self.last_candle_bucket.values()
                   if self.max_ticker_ms < bucket + 2 * ONE_MINUTE_MS + self.candle_lag_ms]
            if due and min(due) < watermark:
                self.stats["watermark_held_for_candle"] += 1
                watermark = min(due)
        if self.released_ms is not None:
            watermark = max(watermark, self.released_ms)
        return watermark

    def _with_clock(self, ready, watermark):
        """Merges ``clock`` ticks into the ordered events, only where the capture was alive around the tick."""
        out, alive_until = [], self.alive_until
        if self.clock_cursor is None and ready:
            self.clock_cursor = (ready[0][0] // self.clock_every_ms) * self.clock_every_ms
        for t_ms, _, event, _ in ready:
            self._ticks(out, t_ms, alive_until)
            out.append(event)
            if event["kind"] == "quote":
                alive_until = t_ms + self.dead_after_ms
        self._ticks(out, watermark, alive_until)
        self.alive_until = alive_until
        return out

    def _ticks(self, out, upto, alive_until):
        if self.clock_cursor is None:
            return
        tick = self.clock_cursor + self.clock_every_ms
        while tick <= upto:
            if alive_until is not None and tick <= alive_until:
                out.append(make_event("clock", {}, t_ms=tick, source=SOURCE, stream="clock:main", source_offset=None))
            self.clock_cursor = tick
            tick += self.clock_every_ms

    # ---- durability --------------------------------------------------------------------------------------------
    STATE_FIELDS = ("cursor", "order", "max_seen_ms", "max_ticker_ms", "released_ms", "last_ticker_ms", "last_any_ticker_ms",
                    "clock_cursor", "last_candle_bucket", "stats", "late", "rejected", "alive_until", "outages",
                    "ticker_more", "candle_more", "last_candle_read_ms")

    def checkpoint(self):
        """Everything the ingestor knows, as plain JSON: cursors, rows held for the watermark, candle revisions already
        chosen, outages and counters. The ingestor writes nothing itself; whoever runs it stores this next to the runner's
        checkpoint. Re-reading the source from zero is NOT a substitute: it does not reproduce what an incremental run
        released (late rows and outages depend on when each poll happened) and the capture's ``market:prune`` removes
        old source rows."""
        out = {name: getattr(self, name) for name in self.STATE_FIELDS}
        out["pending"] = [[t, o, e, list(k) if k else None] for t, o, e, k in self.pending]
        out["candle_first"] = [[list(k), v] for k, v in sorted(self.candle_first.items())]
        out["candle_pending"] = [[list(k), v] for k, v in sorted(self.candle_pending.items())]
        return json.loads(json.dumps(out))

    @classmethod
    def from_checkpoint(cls, reader, state, **kw):
        ing = cls(reader, **kw)
        for name in cls.STATE_FIELDS:
            setattr(ing, name, state[name])
        ing.pending = [(t, o, e, tuple(k) if k else None) for t, o, e, k in state["pending"]]
        ing.candle_first = {tuple(k): dict(v, known=tuple(v["known"]), digest=tuple(v["digest"])) for k, v in state["candle_first"]}
        ing.candle_pending = {tuple(k): dict(v, known=tuple(v["known"]), digest=tuple(v["digest"])) for k, v in state["candle_pending"]}
        return ing

    # ---- what the ingestor knows about the source ------------------------------------------------------------
    def state(self, observed_now_ms):
        """``source``: ``stale`` when no ticker advanced for ``dead_after_ms`` before ``observed_now_ms`` (the capture is
        not delivering anything), else ``live``. ``streams``: per product ``alive`` or ``silent`` (silent only while the
        source is live: a quiet market for that product, not an outage)."""
        stale = self.last_any_ticker_ms is None or observed_now_ms - self.last_any_ticker_ms > self.dead_after_ms
        streams = {}
        for product, last in sorted(self.last_ticker_ms.items()):
            silent = (not stale) and self.last_any_ticker_ms - last > self.dead_after_ms
            streams[product] = {"state": "silent" if silent else "alive", "last_source_ms": last}
        return {"source": "stale" if stale else "live", "watermark_ms": self.released_ms,
                "pending": len(self.pending), "more_to_read": self.ticker_more or self.candle_more, "outages": list(self.outages), "streams": streams, "stats": dict(self.stats),
                "late_sample": list(self.late), "rejected_sample": list(self.rejected)}


def classify_expiry(order, outages):
    """Why an order that expired found no quote. ``expired_during_source_outage`` when its execution window overlaps an
    interval in which no ticker of any product reached the capture's database (the capture was not delivering), else
    ``no_market_quote`` (the source was alive; that product simply had no usable quote). Read-side classification only:
    the runner's own reason (``no_quote_in_window``) is not changed."""
    line = order["timeline"]
    start, end = line.get("earliest_fill_ms", line["decided_ms"]), line["deadline_ms"]
    hit = [o for o in outages if o["from_ms"] < end and o["to_ms"] > start]
    return "expired_during_source_outage" if hit else "no_market_quote"
