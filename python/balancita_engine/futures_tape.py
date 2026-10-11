"""Trade tape on demand from Kraken's public execution history (no capture, no account, no credentials).

``GET /api/history/v3/market/{symbol}/executions`` serves every fill of every PF_* product for months back, by
time range, 1000 per page, with the aggressor side (``takerOrder.direction``). So the tape of any product can be
*asked for* around the moments that matter instead of captured all the time. Only windows are fetched, and each
one is cached in a local SQLite file (read it again and nothing is requested).

* A window is ``[lo_ms, hi_ms]``; it is fetched once, in full, and recorded as covered. ``window()`` returns a
  ``futures_maker.Tape`` whose ``covers`` is exactly that range, so a study never trusts a tape that was not asked for.
* Requests are paced (``gap_s``) and retried with backoff on 429 / 5xx; a window that cannot be completed raises
  and nothing is recorded for it.
* Public data only. Orders, accounts and private endpoints are not touched (ADR 0001).
"""

import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

BASE_URL = "https://futures.kraken.com/api/history/v3/market/{}/executions"
PAGE = 1000
MAX_PAGES = 200
USER_AGENT = "Balancita public tape study"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tape_window(product_id TEXT NOT NULL, lo_ms INTEGER NOT NULL, hi_ms INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL, PRIMARY KEY(product_id, lo_ms, hi_ms)) STRICT;
CREATE TABLE IF NOT EXISTS tape_fill(product_id TEXT NOT NULL, uid TEXT NOT NULL, time_ms INTEGER NOT NULL,
  price TEXT NOT NULL, side TEXT NOT NULL, PRIMARY KEY(product_id, uid)) STRICT;
CREATE INDEX IF NOT EXISTS tape_fill_time ON tape_fill(product_id, time_ms);
"""


def parse_execution(element):
    """``(uid, time_ms, price, side)`` of one history element, or ``None`` when it is not a fill."""
    try:
        execution = element["event"]["Execution"]["execution"]
        side = {"Buy": "buy", "Sell": "sell"}[execution["takerOrder"]["direction"]]
        Decimal(execution["price"])
        return execution["uid"], int(execution["timestamp"]), execution["price"], side
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return None


def _get_json(url, *, timeout=20, retries=5, sleep=time.sleep, opener=urllib.request.urlopen):
    delay = 1.0
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": USER_AGENT})
            with opener(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        sleep(delay)
        delay = min(delay * 2, 30)
    raise RuntimeError("unreachable")


def fetch_fills(product_id, lo_ms, hi_ms, *, fetch=_get_json, gap_s=0.1, sleep=time.sleep):
    """Every fill of ``product_id`` with ``lo_ms <= time <= hi_ms``, oldest first, paging through the history."""
    params = urllib.parse.urlencode({"since": int(lo_ms), "sort": "asc", "count": PAGE})
    url = BASE_URL.format(urllib.parse.quote(product_id)) + "?" + params
    fills = []
    for _ in range(MAX_PAGES):
        body = fetch(url)
        elements = body.get("elements") or []
        for element in elements:
            parsed = parse_execution(element)
            if parsed is not None and lo_ms <= parsed[1] <= hi_ms:
                fills.append(parsed)
        token = body.get("continuationToken")
        last = elements[-1]["timestamp"] if elements else None
        if len(elements) < PAGE or not token or (last is not None and last > hi_ms):
            return fills
        url = BASE_URL.format(urllib.parse.quote(product_id)) + "?" + urllib.parse.urlencode(
            {"sort": "asc", "count": PAGE, "continuationToken": token})
        sleep(gap_s)
    raise RuntimeError("{} {}-{}: more than {} pages".format(product_id, lo_ms, hi_ms, MAX_PAGES))


class TapeCache:
    """Windows of tape, fetched once and kept in SQLite."""

    def __init__(self, path, *, fetch=fetch_fills, clock=time.time):
        self.db = sqlite3.connect(path)
        self.db.executescript(_SCHEMA)
        self.fetch, self.clock = fetch, clock
        self.requests = 0

    def close(self):
        self.db.close()

    def _covered(self, product_id, lo_ms, hi_ms):
        return self.db.execute(
            "SELECT 1 FROM tape_window WHERE product_id=? AND lo_ms<=? AND hi_ms>=? LIMIT 1",
            (product_id, lo_ms, hi_ms)).fetchone() is not None

    def window(self, product_id, lo_ms, hi_ms):
        """The tape of ``[lo_ms, hi_ms]`` as a ``futures_maker.Tape`` that covers exactly that range."""
        from .futures_maker import Tape

        if not self._covered(product_id, lo_ms, hi_ms):
            fills = self.fetch(product_id, lo_ms, hi_ms)
            self.requests += 1
            with self.db:
                self.db.executemany("INSERT OR IGNORE INTO tape_fill VALUES(?,?,?,?,?)",
                                    [(product_id, uid, t, price, side) for uid, t, price, side in fills])
                self.db.execute("INSERT OR IGNORE INTO tape_window VALUES(?,?,?,?)",
                                (product_id, lo_ms, hi_ms, int(self.clock() * 1000)))
        rows = self.db.execute(
            "SELECT time_ms, price, side FROM tape_fill WHERE product_id=? AND time_ms BETWEEN ? AND ? ORDER BY time_ms",
            (product_id, lo_ms, hi_ms)).fetchall()
        return Tape(rows, lo=lo_ms, hi=hi_ms)
