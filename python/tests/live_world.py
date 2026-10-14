"""Synthetic world for the 10D integration tests: a capture-shaped SQLite that grows slice by slice (as the real capture does),
built from the 9A fixture's minute candles, with deterministic bid/ask around them and two separate funding tables. Invented
data only: no real database, no network, no wall clock."""

import copy
import os
import shutil
import sqlite3
from decimal import Decimal

from balancita_engine import replay_data as RD
from balancita_engine import replay_driver as RP
from balancita_engine.futures_simulator import FIVE_MINUTES_MS, ONE_MINUTE_MS

from test_paper_live_ingest import Source
from test_replay_9a_audit import BTC, FIRST_DECISION, LAST_DECISION, fixture_db

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
DAY = 24 * HOUR
LOAD_START = FIRST_DECISION - 4 * DAY
QUOTE_FROM = FIRST_DECISION - 10 * MIN
WORLD_END = LAST_DECISION + 6 * HOUR           # market keeps moving after the last decision, so positions can close
ACCRUAL_RATE = "0.0001"                        # explicit synthetic rate applied to open positions (relative, per hour)
FUNDING_TABLES = """
CREATE TABLE synthetic_fundpct (product_id TEXT NOT NULL, start_ms INTEGER NOT NULL, rate REAL NOT NULL, arrival_ms INTEGER NOT NULL);
CREATE TABLE synthetic_accrual (product_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, rate TEXT NOT NULL,
  arrival_ms INTEGER NOT NULL);
"""


def quotes_of(candle):
    """Three deterministic quotes inside a minute (at 10, 30 and 50 s), moving from the open to the close, with a 1.0 spread."""
    o, c = D(candle["open"]), D(candle["close"])
    out = []
    for second, k in ((10, 1), (30, 3), (50, 5)):
        mid = (o + (c - o) * k / 6).quantize(D("0.1"))
        out.append((candle["bucket_start"] + second * SEC, mid))
    return out


class World(object):
    """Builds the market once and releases it into the capture-shaped file with ``release_until``."""

    def __init__(self, directory, accrual_rate=ACCRUAL_RATE, with_quotes=True, quote_holes=()):
        self.dir = directory
        history = os.path.join(directory, "history.sqlite")
        fixture_db(history)
        gate = RD.ReplayDataGate(history, LOAD_START, WORLD_END)
        self.ones = gate.candles(BTC, ONE_MINUTE_MS)
        self.fives = gate.candles(BTC, FIVE_MINUTES_MS)
        gate.close()
        fgate = RD.ReplayDataGate(history, RD.LO_MS, WORLD_END)
        self.fundpct = fgate.relative_funding(BTC)
        fgate.close()
        self.path = os.path.join(directory, "capture.sqlite")
        self.source = Source(self.path)
        self.source.db.executescript(FUNDING_TABLES)
        self.source.commit()
        self.next_candle = self.next_quote = 0
        self.quotes = []
        if with_quotes:
            for candle in self.ones:
                if candle["bucket_start"] >= QUOTE_FROM:
                    self.quotes += [q for q in quotes_of(candle) if not any(a <= q[0] < b for a, b in quote_holes)]
        self.accrual_rate = accrual_rate
        self._write_funding()

    def _write_funding(self):
        db = self.source.db
        for start, rate in self.fundpct:
            db.execute("INSERT INTO synthetic_fundpct VALUES(?,?,?,?)", (BTC, start, float(rate), start + HOUR + RP.FUNDING_LAG_MS))
        hour = (FIRST_DECISION // HOUR) * HOUR - 2 * HOUR
        while hour < WORLD_END:
            db.execute("INSERT INTO synthetic_accrual VALUES(?,?,?,?,?)",
                       (BTC, hour, hour + HOUR, self.accrual_rate, hour + HOUR + RP.FUNDING_LAG_MS))
            hour += HOUR
        self.source.commit()

    def release_until(self, t_ms):
        """Writes every market row whose time is not after ``t_ms`` (candles at close + 2 s, quotes at their instant)."""
        while self.next_candle < len(self.ones):
            candle = self.ones[self.next_candle]
            if candle["bucket_start"] + MIN + 2 * SEC > t_ms:
                break
            self.source.candle(BTC, candle["bucket_start"], candle["open"], candle["high"], candle["low"], candle["close"],
                               volume=str(candle["volume_btc"]))
            self.next_candle += 1
        while self.next_quote < len(self.quotes) and self.quotes[self.next_quote][0] <= t_ms:
            t, mid = self.quotes[self.next_quote]
            self.source.ticker(BTC, t, mid, half_bps="0.05")
            self.next_quote += 1
        self.source.commit()

    def snapshot(self, directory):
        """A byte copy of the capture-shaped file as it is now, with the release pointers, to fork a scenario from it."""
        self.source.commit()
        path = os.path.join(directory, "capture-snapshot.sqlite")
        shutil.copyfile(self.path, path)
        return {"capture": path, "next_candle": self.next_candle, "next_quote": self.next_quote, "n": self.source.n}

    def fork(self, directory, snap):
        """A world that continues from ``snap`` in its own file (the market lists are shared, nothing is rebuilt)."""
        other = copy.copy(self)
        other.path = os.path.join(directory, "capture.sqlite")
        shutil.copyfile(snap["capture"], other.path)
        other.source = Source.__new__(Source)
        other.source.path, other.source.n = other.path, snap["n"]
        other.source.db = sqlite3.connect(other.path)
        other.next_candle, other.next_quote = snap["next_candle"], snap["next_quote"]
        return other

    def close(self):
        self.source.close()
