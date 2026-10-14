"""Historical data for the replay (stage 9A): read-only access with a hard range gate, and integrity checks.

Everything read from a market database goes through ``ReplayDataGate``:

* the database is opened ``mode=ro`` with ``PRAGMA query_only=ON`` (never ``immutable=1``);
* ``LO_MS`` / ``HI_EXCL_MS`` are constants of this module. A window that starts before ``LO_MS`` or ends after
  ``HI_EXCL_MS`` raises ``RangeGateError`` *before* the file is opened. ``HI_EXCL_MS`` is 2026-08-02T00:00:00Z: the reserved
  period (2026-08-02 .. 2026-10-01) is never read, although the backfilled databases hold it physically;
* every statement is parameterised with the window; funding is read through incremental blob I/O (only the pages of the
  prefix of the stored response, nothing is loaded whole) and abandoned at the first period at or after the *local* limit of
  the read, which may not be later than ``HI_EXCL_MS - FUNDING_MARGIN_MS``: the global cap is never reached, not even by the
  block read past the stop. No SQLite JSON function is applied to the stored response.

Candles are the first-known revision of each bucket. Their ``known_at`` is the time of the backfill (October 2026), so it
says nothing about when a candle was known: the replay fixes availability by rule (``replay_driver``).
"""

import hashlib
import json
import re
import sqlite3
from decimal import Decimal, InvalidOperation

D = Decimal
ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
HOUR_MS = 3_600_000
LO_MS = 1_760_313_600_000          # 2025-10-13T00:00:00Z: start of the audited range (and of the public funding history)
HI_EXCL_MS = 1_785_628_800_000     # 2026-08-02T00:00:00Z: exclusive; everything from here on is the reserved period
FUNDING_MARGIN_MS = 48 * HOUR_MS   # funding is read at most this long before the cap (see ``relative_funding``)
SCHEMA = "balancita-replay-data.v1"
INTERVALS = (ONE_MINUTE_MS, FIVE_MINUTES_MS)


class RangeGateError(ValueError):
    """A window outside the authorised range. Raised before any database is opened."""


class DataError(ValueError):
    """The data fails an integrity check that the replay cannot run without."""


def check_window(lo_ms, hi_excl_ms):
    for value in (lo_ms, hi_excl_ms):
        if isinstance(value, bool) or not isinstance(value, int):
            raise RangeGateError("window bounds must be integer milliseconds")
    if lo_ms < LO_MS:
        raise RangeGateError("window starts before the authorised range ({} < {})".format(lo_ms, LO_MS))
    if hi_excl_ms > HI_EXCL_MS:
        raise RangeGateError("window ends after the cap ({} > {}): the reserved period is not readable".format(hi_excl_ms, HI_EXCL_MS))
    if hi_excl_ms <= lo_ms:
        raise RangeGateError("window is empty")


def _plain(value):
    return json.loads(json.dumps(value, sort_keys=True, default=str))


_STAMP = re.compile(r'"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')


_CAP_ISO = "2026-08-02T00:00:00"


class _Blob:
    """Incremental read of one stored value. ``read(offset, n)`` touches only the pages that hold those bytes."""

    def __init__(self, backend, size, reader, closer):
        self.backend, self.size, self._read, self._close = backend, size, reader, closer

    def read(self, offset, n):
        return self._read(offset, n)

    def close(self):
        self._close()


def open_incremental_blob(path, db, table, column, rowid, prefer=None):
    """``blobopen`` of Python >= 3.11 or, where it is missing, SQLite's own ``sqlite3_blob_*`` through ctypes (read-only
    connection of its own). There is no third option: a read that would load the whole value is refused."""
    if prefer != "ctypes" and hasattr(db, "blobopen"):
        handle = db.blobopen(table, column, rowid, readonly=True)

        def read(offset, n):
            handle.seek(offset)
            return handle.read(n)
        return _Blob("blobopen", len(handle), read, handle.close)
    return _ctypes_blob(path, table, column, rowid)


def _ctypes_blob(path, table, column, rowid):
    import ctypes
    import ctypes.util
    name = ctypes.util.find_library("sqlite3")
    if not name:
        raise DataError("no incremental blob I/O available (Python < 3.11 and no libsqlite3 for ctypes): the funding "
                        "response cannot be read without loading it whole, so it is not read")
    lib = ctypes.CDLL(name)
    c_p, c_i = ctypes.c_void_p, ctypes.c_int
    lib.sqlite3_open_v2.argtypes = [ctypes.c_char_p, ctypes.POINTER(c_p), c_i, ctypes.c_char_p]
    lib.sqlite3_blob_open.argtypes = [c_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int64, c_i, ctypes.POINTER(c_p)]
    lib.sqlite3_blob_bytes.argtypes = [c_p]
    lib.sqlite3_blob_read.argtypes = [c_p, c_p, c_i, c_i]
    lib.sqlite3_blob_close.argtypes = [c_p]
    lib.sqlite3_close.argtypes = [c_p]
    conn = c_p()
    if lib.sqlite3_open_v2(path.encode(), ctypes.byref(conn), 1, None) != 0:      # SQLITE_OPEN_READONLY
        raise DataError("cannot open the database read-only through ctypes")
    handle = c_p()
    if lib.sqlite3_blob_open(conn, b"main", table.encode(), column.encode(), rowid, 0, ctypes.byref(handle)) != 0:
        lib.sqlite3_close(conn)
        raise DataError("cannot open the stored funding response for incremental reading")
    size = lib.sqlite3_blob_bytes(handle)

    def read(offset, n):
        buffer = ctypes.create_string_buffer(n)
        if lib.sqlite3_blob_read(handle, buffer, n, offset) != 0:
            raise DataError("incremental read of the funding response failed")
        return buffer.raw

    def close():
        lib.sqlite3_blob_close(handle)
        lib.sqlite3_close(conn)
    return _Blob("sqlite3_blob(ctypes)", size, read, close)


class ReplayDataGate:
    def __init__(self, path, lo_ms, hi_excl_ms):
        check_window(lo_ms, hi_excl_ms)
        self.path, self.lo_ms, self.hi_excl_ms = path, lo_ms, hi_excl_ms
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.db.execute("PRAGMA query_only=ON")
        self.funding_bytes_read, self.funding_stopped_at, self.funding_reader, self.funding_bytes_stored = 0, None, None, 0
        self._reads, self._decoded_max, self._decoded_n, self._stop_reason = [], None, 0, None
        self._sha, self._ts_max, self._tail = hashlib.sha256(), None, ""
        self.blob_backend = None        # None: blobopen when Python has it, else ctypes; tests may force one
        self.statements = []            # every statement executed with its bounds: the audit trail of what was read

    def close(self):
        self.db.close()

    def _run(self, name, sql, params):
        self.statements.append({"name": name, "params": [p for p in params]})
        return self.db.execute(sql, params).fetchall()

    # ---- candles --------------------------------------------------------------------------------------------------
    _CANDLES = """
        WITH ranked AS (
          SELECT bucket_start, known_at, open_price, high_price, low_price, close_price, volume_btc,
                 ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY known_at, rowid) AS revision_rank
          FROM paper_futures_official_candles
          WHERE product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<?)
        SELECT bucket_start, known_at, open_price, high_price, low_price, close_price, volume_btc
        FROM ranked WHERE revision_rank=1 ORDER BY bucket_start"""

    def candles(self, product_id, interval_ms):
        """First-known revision of every stored bucket of the window, ordered. The same shape ``futures_simulator.frames``
        reads (``bucket_start``, ``open/high/low/close/volume_btc`` as text)."""
        if interval_ms not in INTERVALS:
            raise ValueError("interval must be 1m or 5m")
        rows = self._run("candles", self._CANDLES, (product_id, interval_ms, self.lo_ms, self.hi_excl_ms))
        out = [{"bucket_start": int(r[0]), "known_at": int(r[1]), "open": r[2], "high": r[3], "low": r[4], "close": r[5],
                "volume_btc": r[6]} for r in rows]
        if out and out[-1]["bucket_start"] + interval_ms > self.hi_excl_ms:
            raise RangeGateError("a candle crosses the cap")      # defence in depth: the query already excludes it
        return out

    def conflicting_revisions(self, product_id, interval_ms):
        """Buckets of the window with more than one revision whose OHLCV differ (the replay refuses to start on any)."""
        rows = self._run("conflicts", """
            SELECT bucket_start FROM paper_futures_official_candles
            WHERE product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<?
            GROUP BY bucket_start HAVING COUNT(DISTINCT open_price||high_price||low_price||close_price||volume_btc)>1""",
                         (product_id, interval_ms, self.lo_ms, self.hi_excl_ms))
        return [int(r[0]) for r in rows]

    # ---- funding --------------------------------------------------------------------------------------------------
    CHUNK = 512

    def _response_shas(self, product_id):
        """The responses the forward reads (``futures_funding_context.load_periods``): the oldest and the two newest."""
        columns = [r[1] for r in self.db.execute("PRAGMA table_info(paper_futures_funding_periods)")]
        if "product_id" in columns:
            shas = [r[0] for r in self._run("funding_responses", """
                SELECT sha256 FROM paper_futures_funding_responses WHERE sha256 IN
                  (SELECT response_sha256 FROM paper_futures_funding_periods WHERE product_id=?)
                ORDER BY received_at, rowid""", (product_id,))]
        else:
            shas = []
        return list(dict.fromkeys(shas[:1] + shas[-2:]))

    def _open_blob(self, sha):
        row = self.db.execute("SELECT rowid FROM paper_futures_funding_responses WHERE sha256=?", (sha,)).fetchone()
        if row is None:
            raise DataError("funding response not found")
        return open_incremental_blob(self.path, self.db, "paper_futures_funding_responses", "raw_response", row[0],
                                     prefer=self.blob_backend)

    def _chunks(self, sha):
        """The stored response as text chunks of ``CHUNK`` bytes, read on demand through SQLite's incremental blob I/O, which
        reads only the pages it is asked for. The caller stops asking at the first period at or after its limit."""
        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")()
        blob = self._open_blob(sha)
        self.funding_reader = blob.backend
        self.funding_bytes_stored = blob.size
        offset = 0
        try:
            while offset < blob.size:
                n = min(self.CHUNK, blob.size - offset)
                raw = blob.read(offset, n)
                self._reads.append((offset, n, len(raw)))
                if len(raw) != n:
                    raise DataError("incremental read returned a different length than requested")
                offset += n
                self.funding_bytes_read += n
                text = decoder.decode(raw, final=offset >= blob.size)
                self._scan_delivered(raw, text)
                yield text
        finally:
            blob.close()

    def _stream_rates(self, sha):
        """Yields ``(start_ms, relative_rate)`` of one response in file order and stops at the first period at or after the
        limit. Reading stops there: at most one ``CHUNK`` beyond the limit is read (and one period parsed to detect it)."""
        from datetime import datetime
        decoder = json.JSONDecoder()
        chunks = self._chunks(sha)
        buffer, pos, state, last = "", 0, "seek", None

        def more():
            nonlocal buffer
            try:
                buffer += next(chunks)
                return True
            except StopIteration:
                return False

        try:
            while True:
                if state == "seek":                 # up to the opening bracket of "rates"
                    key = buffer.find('"rates"', pos)
                    if key >= 0:
                        bracket = buffer.find("[", key)
                        if bracket >= 0:
                            pos, state = bracket + 1, "items"
                            continue
                    if not more():
                        raise DataError("funding response has no 'rates' array")
                    continue
                while pos < len(buffer) and buffer[pos] in " \t\r\n,":
                    pos += 1
                if pos >= len(buffer):
                    if not more():
                        raise DataError("funding response ends inside the 'rates' array")
                    continue
                if buffer[pos] == "]":
                    self._stop_reason = "end_of_rates_array"
                    return
                try:
                    item, end = decoder.raw_decode(buffer, pos)
                except ValueError:
                    if not more():
                        raise DataError("funding response has a broken period")
                    continue
                pos = end
                try:
                    start_ms = int(datetime.fromisoformat(item["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
                    rate = item["relativeFundingRate"]
                except (KeyError, TypeError, ValueError, AttributeError):
                    raise DataError("funding period without timestamp / relativeFundingRate")
                if last is not None and start_ms <= last:
                    raise DataError("funding response is not in increasing order: the bound cannot be applied")
                last = start_ms
                if start_ms >= HI_EXCL_MS:
                    raise DataError("a reserved funding period reached the decoder: the isolation guarantee does not hold")
                self._decoded_n += 1
                self._decoded_max = start_ms if self._decoded_max is None else max(self._decoded_max, start_ms)
                if start_ms >= self.hi_excl_ms:
                    self.funding_stopped_at = start_ms
                    self._stop_reason = "first_period_at_or_after_local_limit"
                    return                           # the first period at or after the limit: stop, read nothing further
                if start_ms >= self.lo_ms:
                    yield start_ms, rate
                buffer, pos = buffer[pos:], 0        # keep the buffer small
        finally:
            chunks.close()

    def begin_stream(self):
        self.funding_stopped_at = None
        self._reads, self._decoded_max, self._decoded_n, self._stop_reason = [], None, 0, None
        self._sha, self._ts_max, self._tail = hashlib.sha256(), None, ""

    def _scan_delivered(self, raw, text):
        """Independent of the parser: hash of every byte delivered and the latest timestamp that appears in them. A timestamp at
        or after the global cap in delivered bytes is an isolation failure, whatever the parser would have done with it."""
        self._sha.update(raw)
        window = self._tail + text
        for stamp in _STAMP.findall(window):
            if self._ts_max is None or stamp > self._ts_max:
                self._ts_max = stamp
        self._tail = window[-64:]
        if self._ts_max is not None and self._ts_max >= _CAP_ISO:
            raise DataError("a reserved funding period reached the reader: the isolation guarantee does not hold")

    def stream_trail(self, sha, bytes_read):
        """The audit record of one response read: every byte range delivered (summarised, with a hash of the full list), the
        stop and the periods decoded."""
        reads = self._reads
        return {"source": "/".join(self.path.rsplit("/", 2)[-2:]), "sha256": sha,
                "bytes_read": bytes_read, "bytes_stored": self.funding_bytes_stored,
                "stopped_at_ms": self.funding_stopped_at, "stop_reason": self._stop_reason or "end_of_blob",
                "local_limit_ms": self.hi_excl_ms, "read_count": len(reads),
                "first_read": list(reads[0]) if reads else None, "last_read": list(reads[-1]) if reads else None,
                "max_offset_excl": max((o + r for o, _, r in reads), default=0),
                "requested_bytes": sum(n for _, n, _ in reads), "received_bytes": sum(r for _, _, r in reads),
                "contiguous_from_zero": all(reads[i][0] == (reads[i - 1][0] + reads[i - 1][2] if i else 0) for i in range(len(reads))),
                "reads_sha256": hashlib.sha256(json.dumps(reads).encode()).hexdigest(),
                "delivered_sha256": self._sha.hexdigest(), "max_timestamp_in_delivered_bytes": self._ts_max,
                "periods_decoded": self._decoded_n, "max_decoded_period_ms": self._decoded_max,
                "read_whole_value": sum(r for _, _, r in reads) >= self.funding_bytes_stored > 0}

    def relative_funding(self, product_id):
        """``[(start_ms, relative_rate_text)]`` of the hourly funding periods inside ``[lo, hi_excl)``, first seen wins.

        The rate is Kraken's ``relativeFundingRate`` (what ``accrue_funding`` and ``FundingContext`` use; the absolute
        ``funding_rate`` is never converted). Two limits, kept apart: the *local* limit ``hi_excl_ms`` of this read and the
        *global* cap ``HI_EXCL_MS`` (the reserved period). The local limit may not be later than
        ``HI_EXCL_MS - FUNDING_MARGIN_MS``, so that the block read past the local limit is still inside the authorised
        history; a later one is refused before the file is opened.

        The stored response lists a year of periods, including reserved ones, so it is read through incremental blob I/O
        (``Connection.blobopen``, or ``sqlite3_blob_*`` through ctypes on Python < 3.11): only the pages of the prefix up to
        the stop are read from the file. There is no fallback to a full-value read: without incremental I/O the read is
        refused. Responses are the oldest and the two newest, as in the forward."""
        if self.hi_excl_ms > HI_EXCL_MS - FUNDING_MARGIN_MS:
            raise RangeGateError("funding is read up to {} h before the cap at most (local limit {} > {}): the block read past "
                                 "the limit must stay inside the authorised history".format(
                                     FUNDING_MARGIN_MS // HOUR_MS, self.hi_excl_ms, HI_EXCL_MS - FUNDING_MARGIN_MS))
        self.funding_bytes_read, self.funding_stopped_at = 0, None
        found, trail, backend = {}, [], None
        for sha in self._response_shas(product_id):
            before = self.funding_bytes_read
            self.begin_stream()
            for start_ms, rate in self._stream_rates(sha):
                found.setdefault(start_ms, _decimal_text(rate))
            backend = self.funding_reader
            trail.append(self.stream_trail(sha, self.funding_bytes_read - before))
        self.statements.append({"name": "funding_stream", "params": [product_id, self.lo_ms, self.hi_excl_ms],
                                "reader": backend, "chunk_bytes": self.CHUNK, "local_limit_ms": self.hi_excl_ms,
                                "global_cap_ms": HI_EXCL_MS, "margin_ms": FUNDING_MARGIN_MS, "responses": trail})
        return sorted(found.items())


def _decimal_text(value):
    try:
        d = D(repr(value)) if isinstance(value, float) else D(str(value))
    except InvalidOperation:
        raise DataError("funding rate is not a number: {!r}".format(value))
    if not d.is_finite():
        raise DataError("funding rate is not finite")
    return format(d, "f")


# ---------------------------------------------------------------------------------------------------- integrity
def series_report(candles, interval_ms, lo_ms, hi_excl_ms):
    """Order, alignment, gaps and OHLC consistency of one series over ``[lo_ms, hi_excl_ms)``. Nothing is corrected."""
    first = -(-lo_ms // interval_ms) * interval_ms
    last = (hi_excl_ms // interval_ms) * interval_ms - interval_ms
    present = [c["bucket_start"] for c in candles]
    unordered = sum(1 for a, b in zip(present, present[1:]) if b <= a)
    misaligned = sum(1 for b in present if b % interval_ms)
    outside = sum(1 for b in present if b < first or b > last)
    have = set(present)
    gaps, start = [], None
    expected = (last - first) // interval_ms + 1 if last >= first else 0
    missing = 0
    bucket = first
    while bucket <= last:
        if bucket not in have:
            missing += 1
            start = bucket if start is None else start
        elif start is not None:
            gaps.append([start, bucket - interval_ms])
            start = None
        bucket += interval_ms
    if start is not None:
        gaps.append([start, last])
    invalid = 0
    zero_volume = 0
    for c in candles:
        try:
            o, h, l, cl, v = (D(str(c[k])) for k in ("open", "high", "low", "close", "volume_btc"))   # noqa: E741
        except InvalidOperation:
            invalid += 1
            continue
        if not all(x.is_finite() for x in (o, h, l, cl, v)) or min(o, h, l, cl) <= 0 or l > min(o, cl) or h < max(o, cl) or v < 0:
            invalid += 1
        if v == 0:
            zero_volume += 1
    return {"interval_ms": interval_ms, "n": len(candles), "expected": expected, "missing": missing,
            "gaps": gaps[:50], "gap_count": len(gaps), "unordered": unordered, "misaligned": misaligned,
            "outside_window": outside, "invalid_ohlc": invalid, "zero_volume": zero_volume,
            "first": present[0] if present else None, "last": present[-1] if present else None}


def consistency_5m_vs_1m(candles_1m, candles_5m):
    """Each 5m bar against the five 1m bars it covers (high, low, close, volume). Counted and reported, never corrected."""
    by_minute = {c["bucket_start"]: c for c in candles_1m}
    compared = mismatched = incomplete = 0
    examples = []
    for bar in candles_5m:
        minutes = [by_minute.get(bar["bucket_start"] + i * ONE_MINUTE_MS) for i in range(5)]
        if any(m is None for m in minutes):
            incomplete += 1
            continue
        compared += 1
        try:
            high, low = max(D(m["high"]) for m in minutes), min(D(m["low"]) for m in minutes)
            close, volume = D(minutes[-1]["close"]), sum((D(m["volume_btc"]) for m in minutes), D(0))
            ok = (high == D(bar["high"]) and low == D(bar["low"]) and close == D(bar["close"])
                  and abs(volume - D(bar["volume_btc"])) <= max(D("0.000001"), volume * D("0.000001")))
        except InvalidOperation:
            ok = False
        if not ok:
            mismatched += 1
            if len(examples) < 5:
                examples.append(bar["bucket_start"])
    return {"compared": compared, "mismatched": mismatched, "incomplete": incomplete, "examples": examples}


def funding_report(periods, lo_ms, hi_excl_ms):
    """Hours of the window with no funding row. They are *unknown*, never zero."""
    first = -(-lo_ms // HOUR_MS) * HOUR_MS
    last = (hi_excl_ms // HOUR_MS) * HOUR_MS - HOUR_MS
    have = {s for s, _ in periods}
    starts = sorted(have)
    lo_seen = starts[0] if starts else None
    missing = [h for h in range(max(first, lo_seen if lo_seen is not None else first), last + 1, HOUR_MS) if h not in have]
    return {"n": len(periods), "first": lo_seen, "last": starts[-1] if starts else None, "missing_hours": missing[:200],
            "missing_count": len(missing), "outside_window": sum(1 for s in starts if s < lo_ms or s >= hi_excl_ms)}


def data_hash(candles_1m, candles_5m, funding):
    """Identity of the data a run used: the candles' OHLCV and the funding rates, not their ``known_at`` (a backfill time)."""
    digest = hashlib.sha256()
    for name, rows in (("1m", candles_1m), ("5m", candles_5m)):
        digest.update(name.encode())
        for c in rows:
            digest.update("|{}|{}|{}|{}|{}|{}".format(c["bucket_start"], c["open"], c["high"], c["low"], c["close"],
                                                       c["volume_btc"]).encode())
    digest.update(b"funding")
    for start, rate in funding:
        digest.update("|{}|{}".format(start, rate).encode())
    return digest.hexdigest()
