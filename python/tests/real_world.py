"""The real market for the session tests: a capture-shaped SQLite that grows as the real capture did, built only from rows Kraken
sent (fixtures/muestra-parcial: 1168 official 1-minute candles of PF_XBTUSD and the 125 589 WebSocket tickers of the same span, each
row with the arrival time it really had). Nothing is generated: a row is written when the instant handed to ``release_until`` reaches
the time it really arrived, and a hole in the quotes is made by leaving real rows out. The file still carries the fixture marker,
because it is a replay built by a test and not the capture itself (the real source needs an authorization that does not exist yet)."""

import copy
import csv
import gzip
import json
import hashlib
import os
import shutil
import sqlite3

import real_sample
from test_paper_live_ingest import SCHEMA

BTC = "PF_XBTUSD"
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
T0 = 1792240800000                          # 2026-10-17T12:40:00Z, the first real candle
CANDLES = 1168
T_END = T0 + CANDLES * MIN                  # the end of the last real candle (2026-10-18T08:08Z)
QUOTES_FILE = os.path.join(real_sample.PARTIAL_DIR, "paper_futures_xbt_quotes.csv.gz")
MARKER = "CREATE TABLE balancita_synthetic_fixture(marker TEXT NOT NULL); INSERT INTO balancita_synthetic_fixture VALUES('balancita-synthetic-fixture.v1');"
FUNDING_TABLES = """
CREATE TABLE paper_futures_funding_responses(sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL,
  raw_response TEXT NOT NULL) STRICT;
CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  funding_rate TEXT NOT NULL, known_at INTEGER NOT NULL, unit TEXT NOT NULL, product_id TEXT NOT NULL) STRICT;
"""

_cache = {}


def candles():
    if "candles" not in _cache:
        _cache["candles"] = sorted(real_sample.rows("official_candles", real_sample.PARTIAL_DIR), key=lambda r: (r["known_at"], r["bucket_start"]))
    return _cache["candles"]


def quotes():
    """The real WebSocket tickers, in the order they arrived: (epoch, seq, received_at, event_time, persisted_at, bid, ask)."""
    if "quotes" not in _cache:
        with gzip.open(QUOTES_FILE, "rt", encoding="utf-8") as handle:
            reader = csv.reader(handle)
            next(reader)
            _cache["quotes"] = [(int(r[0]), int(r[1]), int(r[2]), int(r[3]), int(r[4]), r[5], r[6]) for r in reader]
    return _cache["quotes"]


class RealWorld(object):
    """``release_until(t)`` writes every real candle known by ``t`` and every real quote received by ``t`` that is not in a hole."""

    def __init__(self, directory, quote_holes=()):
        self.dir = directory
        self.path = os.path.join(directory, "capture.sqlite")
        self.db = sqlite3.connect(self.path)
        self.db.executescript(SCHEMA)
        self.db.executescript(MARKER)
        self.db.executescript(FUNDING_TABLES)
        self.holes = tuple(quote_holes)
        self.next_candle = self.next_quote = 0
        self.db.commit()

    def release_until(self, t_ms):
        rows, quotes_ = candles(), quotes()
        while self.next_candle < len(rows) and rows[self.next_candle]["known_at"] <= t_ms:
            row = rows[self.next_candle]
            self.db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            tuple(row[k] for k in ("product_id", "interval_ms", "bucket_start", "revision_hash", "known_at", "open_price",
                                                   "high_price", "low_price", "close_price", "volume_btc", "response_sha256")))
            self.next_candle += 1
        while self.next_quote < len(quotes_) and quotes_[self.next_quote][2] <= t_ms:
            epoch, seq, received, event_time, persisted, bid, ask = quotes_[self.next_quote]
            self.next_quote += 1
            if any(a <= received < b for a, b in self.holes):
                continue
            body = {"type": "ticker", "productId": BTC, "seq": seq, "epoch": epoch, "eventTime": event_time, "receivedAt": received,
                    "persistedAt": persisted, "bid": bid, "ask": ask}
            text = json.dumps(body, sort_keys=True)
            self.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            ("ticker:{}:{}:{}".format(BTC, epoch, seq), "ticker", BTC, epoch, seq, event_time, received, persisted, None, "{}",
                             text, hashlib.sha256(text.encode()).hexdigest()))
        self.db.commit()

    def snapshot(self, directory):
        """A byte copy of the capture-shaped file as it is now, with the release pointers, to fork a scenario from it."""
        self.db.commit()
        path = os.path.join(directory, "capture-snapshot.sqlite")
        shutil.copyfile(self.path, path)
        return {"capture": path, "next_candle": self.next_candle, "next_quote": self.next_quote}

    def fork(self, directory, snap):
        """A world that continues from ``snap`` in its own file (the real rows are shared, nothing is read again)."""
        other = copy.copy(self)
        other.path = os.path.join(directory, "capture.sqlite")
        shutil.copyfile(snap["capture"], other.path)
        other.db = sqlite3.connect(other.path)
        other.next_candle, other.next_quote = snap["next_candle"], snap["next_quote"]
        return other

    def close(self):
        self.db.commit()
        self.db.close()
