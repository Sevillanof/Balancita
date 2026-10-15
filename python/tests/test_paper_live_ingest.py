"""Stage 10B: the offline ingestor against synthetic capture-shaped databases. Everything is invented data: no network, no
wall clock, no real capture. The databases follow the schema the capture writes (market_events, official_candles v5,
data_gaps) for the columns the ingestor reads."""

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock
from decimal import Decimal

from balancita_engine import paper_live_ingest as ING
from balancita_engine import signal_continuity as SC
from balancita_engine import paper_live_publish as PUB
from balancita_engine import paper_live_session as SES
from balancita_engine.paper_live_ingest import IngestError, Ingestor, SourceReader, classify_expiry
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, make_event
from balancita_engine.portfolio_scenarios import ScriptedStrategy

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
BTC, ETH = "PF_XBTUSD", "PF_ETHUSD"
FUNDING = tuple((p, ((CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0"),)) for p in (BTC, ETH))
REST_EPOCH = 1_000_000
LIVE = {"source": "live"}

SCHEMA = """
CREATE TABLE paper_futures_market_events (
  event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
  event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
  raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL) STRICT;
CREATE TABLE paper_futures_official_candles (
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL,
  known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL, low_price TEXT NOT NULL,
  close_price TEXT NOT NULL, volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL,
  PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash)) STRICT;
CREATE TABLE paper_futures_data_gaps (
  gap_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL, epoch INTEGER NOT NULL, expected_seq INTEGER,
  actual_seq INTEGER, detected_at INTEGER NOT NULL, reason TEXT NOT NULL, policy_version TEXT NOT NULL) STRICT;
"""


class Source(object):
    """Writes a capture-shaped database the way ``ticker-poll.ts`` does: ``seq = persisted_at = received_at``."""

    def __init__(self, path):
        self.path, self.n = path, 0
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def ticker(self, product, t, mid, half_bps="0.5", seq=None, epoch=REST_EPOCH):
        mid = D(str(mid))
        half = D(half_bps) / D(10_000)
        body = {"type": "ticker", "productId": product, "seq": t if seq is None else seq, "epoch": epoch,
                "eventTime": t, "receivedAt": t, "persistedAt": t, "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}
        self.n += 1
        self.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("t{}".format(self.n), "ticker", product, epoch, body["seq"], t, t, t, None, "{}",
                         json.dumps(body, sort_keys=True), "h{}".format(self.n)))

    def candle(self, product, bucket, o, h, l, c, known_at=None, revision="r1", volume="1"):   # noqa: E741
        self.db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (product, MIN, bucket, revision, bucket + MIN + 2 * SEC if known_at is None else known_at,
                         str(o), str(h), str(l), str(c), volume, "s"))

    def gap(self, product, t, reason="seq_gap", epoch=1):
        self.n += 1
        self.db.execute("INSERT INTO paper_futures_data_gaps VALUES(?,?,?,?,?,?,?,?,?)",
                        ("g{}".format(self.n), "ticker", product, epoch, 1, 3, t, reason, "p"))

    def commit(self):
        self.db.commit()

    def close(self):
        self.db.commit()
        self.db.close()


def fingerprint(path):
    with open(path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    stat = os.stat(path)
    return digest, stat.st_size, stat.st_mtime_ns


def ingest_all(path, observed_now_ms, **kw):
    """Polls until the ingestor has nothing more to release; returns (events, last state, ingestor)."""
    reader = SourceReader(path)
    ing = Ingestor(reader, **kw)
    events = []
    while True:
        out = ing.poll(observed_now_ms)
        events += out["events"]
        if not out["events"] and not out["state"]["more_to_read"]:
            break
    reader.close()
    return events, out["state"], ing


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "market.sqlite")
        self.src = Source(self.path)

    def runner_dir(self, name):
        return os.path.join(self.dir, name)


class TestMapping(Base):
    def test_ticker_seq_is_a_timestamp_not_a_contiguous_counter(self):
        """Measured on a database written like ``ticker-poll.ts`` writes: ``seq`` is the arrival time, so consecutive rows
        of a product differ by the polling interval, never by one. An offset built on it would be wrong."""
        for i in range(10):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.commit()
        rows = SourceReader(self.path).tickers(0, 100)
        steps = {b["seq"] - a["seq"] for a, b in zip(rows, rows[1:])}
        self.assertEqual(steps, {SEC})
        self.assertNotIn(1, steps)

    def test_events_carry_the_envelope_the_runner_expects(self):
        self.src.ticker(BTC, CYCLE + 1 * SEC, "100000")
        self.src.ticker(BTC, CYCLE + 5 * SEC, "100000")
        self.src.ticker(BTC, CYCLE + 3 * MIN, "100000")                       # moves the watermark past both candles
        self.src.candle(BTC, CYCLE, 1, 2, 1, 2)
        self.src.candle(BTC, CYCLE + MIN, 1, 2, 1, 2)
        self.src.commit()
        events, _, _ = ingest_all(self.path, CYCLE + 70 * SEC)
        quotes = [e for e in events if e["kind"] == "quote"]
        candles = [e for e in events if e["kind"] == "candle"]
        self.assertTrue(quotes and candles)
        for q in quotes:
            self.assertIsNone(q["source_offset"])                 # tickers: no OffsetLedger
            self.assertEqual((q["source"], q["stream"]), ("kraken-capture", "ticker:" + BTC))
            self.assertEqual(q["payload"]["received_ms"], q["t_ms"])
        self.assertEqual([c["source_offset"] for c in candles], [CYCLE // MIN, CYCLE // MIN + 1])   # contiguous
        self.assertEqual([c["t_ms"] for c in candles], [CYCLE + MIN + 2 * SEC, CYCLE + 2 * MIN + 2 * SEC])
        self.assertEqual([e["t_ms"] for e in events], sorted(e["t_ms"] for e in events))

    def test_candle_never_arrives_before_it_closes(self):
        self.src.ticker(BTC, CYCLE + 3 * MIN, "100000")
        self.src.candle(BTC, CYCLE, 1, 2, 1, 2, known_at=CYCLE + 10 * SEC)      # impossible: known before closing
        self.src.commit()
        events, _, _ = ingest_all(self.path, CYCLE + 3 * MIN)
        self.assertEqual([e["t_ms"] for e in events if e["kind"] == "candle"], [CYCLE + MIN])

    def test_first_candle_revision_wins_and_later_ones_are_only_counted(self):
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11)
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + 5 * MIN, revision="r2")        # same content
        self.src.candle(BTC, CYCLE, 10, 13, 9, 11, known_at=CYCLE + 6 * MIN, revision="r3")        # revised
        self.src.ticker(BTC, CYCLE + 10 * MIN, "100000")
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 10 * MIN)
        candles = [e for e in events if e["kind"] == "candle"]
        self.assertEqual(len(candles), 1)
        self.assertEqual(candles[0]["payload"]["candle"]["high"], "12")
        self.assertEqual(state["stats"]["candle_revisions_seen"], 2)
        self.assertEqual(state["stats"]["candle_revisions_differing"], 1)

    def test_the_candle_carries_the_volume_exactly_as_stored(self):
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, volume="123.456789012345")
        self.src.candle(BTC, CYCLE + MIN, 11, 12, 10, 11, volume="0")
        self.src.ticker(BTC, CYCLE + 5 * MIN, "100000")
        self.src.commit()
        events, _, _ = ingest_all(self.path, CYCLE + 5 * MIN)
        volumes = [e["payload"]["candle"]["volume_btc"] for e in events if e["kind"] == "candle"]
        self.assertEqual(volumes, ["123.456789012345", "0"])                  # text, not float: nothing is rounded

    def test_a_revision_that_differs_only_in_volume_is_counted_as_different(self):
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, volume="5")
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + 5 * MIN, revision="r2", volume="6")
        self.src.ticker(BTC, CYCLE + 10 * MIN, "100000")
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 10 * MIN)
        candles = [e for e in events if e["kind"] == "candle"]
        self.assertEqual([c["payload"]["candle"]["volume_btc"] for c in candles], ["5"])      # the first revision still wins
        self.assertEqual(state["stats"]["candle_revisions_differing"], 1)

    def test_the_runner_accepts_a_candle_that_carries_volume(self):
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, volume="5")
        self.src.ticker(BTC, CYCLE + 5 * MIN, "100000")
        self.src.commit()
        events, _, _ = ingest_all(self.path, CYCLE + 5 * MIN)
        candle = next(e for e in events if e["kind"] == "candle")["payload"]["candle"]
        self.assertEqual(sorted(candle), ["close", "high", "low", "open", "volume_btc"])
        from balancita_engine.paper_runner import valid_candle
        self.assertTrue(valid_candle(candle))

    def test_source_database_is_never_modified_and_cannot_be_written(self):
        for i in range(5):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.candle(BTC, CYCLE, 1, 2, 1, 2)
        self.src.close()
        before = fingerprint(self.path)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        ing.poll(CYCLE + 10 * SEC)
        with self.assertRaises(sqlite3.OperationalError):
            reader.db.execute("DELETE FROM paper_futures_market_events")
        reader.close()
        self.assertEqual(fingerprint(self.path), before)


class TestOrderingAndLateRows(Base):
    def test_rows_in_arrival_order_across_products_and_kinds_never_trip_the_runners_order_rule(self):
        for i in range(0, 130):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
            self.src.ticker(ETH, CYCLE + i * SEC + 400, "3500")
        self.src.candle(BTC, CYCLE, 1, 2, 1, 2)
        self.src.candle(ETH, CYCLE, 1, 2, 1, 2)
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 130 * SEC)
        times = [e["t_ms"] for e in events]
        self.assertEqual(times, sorted(times))
        runner = PaperRunner.create(self.runner_dir("o"), RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR),
                                    [ScriptedStrategy("scripted-a", {})])
        self.addCleanup(runner.close)
        runner.run(events)
        self.assertEqual(runner.stats.get("rejected:out_of_order_event", 0), 0)
        self.assertEqual(state["stats"]["late_source_rows"], 0)

    def test_a_row_written_after_its_time_was_released_is_counted_not_emitted(self):
        for i in range(0, 60):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC)
        first = ing.poll(CYCLE + 60 * SEC)["events"]
        self.assertTrue(first)
        # the capture commits a ticker stamped long ago (slower than hold_ms)
        self.src.ticker(ETH, CYCLE + 10 * SEC, "3500")
        self.src.commit()
        second = ing.poll(CYCLE + 61 * SEC)
        reader.close()
        self.assertEqual([e for e in second["events"] if e["kind"] == "quote" and e["payload"]["product_id"] == ETH], [])
        self.assertEqual(second["state"]["stats"]["late_source_rows"], 1)
        self.assertEqual(second["state"]["late_sample"][0]["stream"], "ticker:" + ETH)

    def test_hold_back_keeps_the_last_seconds_until_they_are_safe(self):
        for i in range(0, 20):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        out = Ingestor(reader, hold_ms=5 * SEC).poll(CYCLE + 20 * SEC)
        reader.close()
        quotes = [e["t_ms"] for e in out["events"] if e["kind"] == "quote"]
        self.assertEqual(max(quotes), CYCLE + 14 * SEC)
        self.assertEqual(out["state"]["pending"], 5)


class TestWatermarkAndCandles(Base):
    """Review fixes: a late-written candle is not lost, revision choice does not depend on ``rowid``, unreadable rows
    leave evidence."""

    def quotes(self, upto_s):
        for i in range(0, upto_s):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")

    def late_candle_run(self, **kw):
        self.src.candle(BTC, CYCLE - MIN, 1, 2, 1, 2)                       # on time: its stream is active
        self.quotes(90)
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, **kw)
        first = ing.poll(CYCLE + 90 * SEC)["events"]
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + MIN + 5 * SEC)   # written after quotes to +90 s
        self.src.commit()
        second = ing.poll(CYCLE + 91 * SEC)
        reader.close()
        return first, second

    def test_a_candle_written_late_is_not_left_behind_by_released_quotes(self):
        first, second = self.late_candle_run()
        self.assertLess(max(e["t_ms"] for e in first), CYCLE + MIN)             # quotes held back at the overdue candle
        candles = [e for e in first + second["events"] if e["kind"] == "candle" and e["payload"]["bucket_ms"] == CYCLE]
        self.assertEqual(len(candles), 1)
        self.assertEqual(second["state"]["stats"]["late_source_rows"], 0)
        self.assertGreater(second["state"]["stats"]["watermark_held_for_candle"], 0)
        times = [e["t_ms"] for e in first + second["events"]]
        self.assertEqual(times, sorted(times))

    def test_without_the_candle_hold_the_same_candle_is_lost_as_late(self):
        first, second = self.late_candle_run(candle_lag_ms=0)
        candles = [e for e in first + second["events"] if e["kind"] == "candle" and e["payload"]["bucket_ms"] == CYCLE]
        self.assertEqual(candles, [])
        self.assertEqual(second["state"]["stats"]["late_source_rows"], 1)

    def test_a_candle_that_never_comes_does_not_stall_quotes_for_ever(self):
        self.src.candle(BTC, CYCLE - MIN, 1, 2, 1, 2)
        self.quotes(400)
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 400 * SEC)
        self.assertGreaterEqual(max(e["t_ms"] for e in events if e["kind"] == "quote"), CYCLE + 390 * SEC)
        self.assertEqual(state["stats"]["late_source_rows"], 0)

    def test_first_revision_is_the_lowest_known_at_whatever_the_rowid_order(self):
        self.src.candle(BTC, CYCLE, 10, 13, 9, 11, known_at=CYCLE + 6 * MIN, revision="r3")      # rowid 1, known last
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + 2 * MIN, revision="r1")      # rowid 2, known first
        self.src.candle(BTC, CYCLE, 10, 14, 9, 11, known_at=CYCLE + 4 * MIN, revision="r2")
        self.src.ticker(BTC, CYCLE + 10 * MIN, "100000")
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 10 * MIN)
        candles = [e for e in events if e["kind"] == "candle"]
        self.assertEqual([c["payload"]["candle"]["high"] for c in candles], ["12"])
        self.assertEqual(candles[0]["t_ms"], CYCLE + 2 * MIN)
        self.assertEqual(state["stats"]["candle_revisions_seen"], 2)
        self.assertEqual(state["stats"]["candle_revisions_differing"], 2)

    def test_an_earlier_revision_after_a_later_one_was_emitted_is_counted_not_swapped(self):
        self.src.candle(BTC, CYCLE, 10, 13, 9, 11, known_at=CYCLE + 2 * MIN, revision="r2")
        self.src.ticker(BTC, CYCLE + 10 * MIN, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        first = ing.poll(CYCLE + 10 * MIN)["events"]
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + MIN + 5 * SEC, revision="r1")
        self.src.commit()
        second = ing.poll(CYCLE + 10 * MIN)
        reader.close()
        self.assertEqual([e["payload"]["candle"]["high"] for e in first if e["kind"] == "candle"], ["13"])
        self.assertEqual([e for e in second["events"] if e["kind"] == "candle"], [])
        self.assertEqual(second["state"]["stats"]["candle_earlier_revision_after_emit"], 1)

    def test_unreadable_rows_are_not_emitted_but_keep_identity_and_reason(self):
        self.src.ticker(BTC, CYCLE, "100000")
        for n, (body, reason) in enumerate([("not json", "json_invalid"), ('{"bid": "1"}', "missing_bid_or_ask"),
                                            ('{"bid": "x", "ask": "2"}', "price_not_decimal")]):
            t = CYCLE + (n + 1) * SEC
            self.src.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                ("bad{}".format(n), "ticker", ETH, REST_EPOCH, t, t, t, t, None, "{}", body, "hash{}".format(n)))
        self.src.ticker(BTC, CYCLE + 10 * SEC, "100000")
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 10 * SEC)
        self.assertEqual([e["payload"]["product_id"] for e in events if e["kind"] == "quote"], [BTC])
        self.assertEqual(state["stats"]["unreadable_rows"], 3)
        sample = state["rejected_sample"]
        self.assertEqual([r["reason"] for r in sample], ["json_invalid", "missing_bid_or_ask", "price_not_decimal"])
        self.assertEqual([(r["event_id"], r["content_hash"], r["product_id"]) for r in sample],
                         [("bad{}".format(n), "hash{}".format(n), ETH) for n in range(3)])
        self.assertTrue(all(r["rowid"] and r["persisted_at"] for r in sample))


class TestBatchesAndDurability(Base):
    """Review (D-10B-01, -02): small read batches never turn on-time rows into late ones, and a restored checkpoint
    reproduces the uninterrupted run."""

    def fill(self):
        self.src.candle(BTC, CYCLE - MIN, 1, 2, 1, 2)
        for i in range(30):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.candle(BTC, CYCLE, 10, 12, 9, 11, known_at=CYCLE + 29 * SEC + MIN)   # ahead of most of the quotes
        for i in range(30, 140):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
            if i % 4 == 0:
                self.src.ticker(ETH, CYCLE + i * SEC + 300, "3500")
        self.src.commit()

    def test_no_on_time_row_is_dropped_whatever_the_batch_size(self):
        self.fill()
        base, state0, _ = ingest_all(self.path, CYCLE + 140 * SEC, batch=5_000)
        for batch in (1, 2, 7, 10):
            events, state, _ = ingest_all(self.path, CYCLE + 140 * SEC, batch=batch)
            self.assertEqual(state["stats"]["late_source_rows"], 0, batch)
            self.assertEqual([e["event_id"] for e in events if e["kind"] != "clock"],
                             [e["event_id"] for e in base if e["kind"] != "clock"], batch)

    def test_six_thousand_tickers_with_the_default_batch_lose_nothing(self):
        self.src.candle(BTC, CYCLE - MIN, 1, 2, 1, 2)
        for i in range(6_000):
            self.src.ticker(BTC, CYCLE + i * SEC, "100000")
        self.src.candle(BTC, CYCLE + 100 * MIN, 1, 2, 1, 2)                # a candle far ahead of most quotes
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 6_000 * SEC)
        quotes = [e for e in events if e["kind"] == "quote"]
        self.assertEqual(state["stats"]["late_source_rows"], 0)
        self.assertGreaterEqual(len(quotes), 6_000 - 2)                    # all but the last hold_ms of rows
        self.assertEqual(len({e["event_id"] for e in quotes}), len(quotes))

    def test_same_time_rows_come_out_in_the_same_order_whatever_the_batch_size(self):
        for i in range(8):
            for product in (BTC, ETH):
                self.src.ticker(product, CYCLE + 5 * SEC, "100000" if product == BTC else "3500", seq=i)
        self.src.ticker(BTC, CYCLE + 60 * SEC, "100000")
        self.src.commit()
        base, _, _ = ingest_all(self.path, CYCLE + 61 * SEC, batch=5_000)
        small, _, _ = ingest_all(self.path, CYCLE + 61 * SEC, batch=3)
        self.assertEqual([e["event_id"] for e in small], [e["event_id"] for e in base])

    def test_both_streams_are_read_in_one_snapshot(self):
        self.fill()
        reader = SourceReader(self.path)
        seen = []
        original = reader.db.execute

        class Spy(object):
            def __init__(self, db):
                self.db = db

            def execute(self, sql, *a):
                seen.append(sql.split()[0])
                return self.db.execute(sql, *a)

            def __getattr__(self, name):
                return getattr(self.db, name)

        reader.db = Spy(reader.db)
        Ingestor(reader).poll(CYCLE + 140 * SEC)
        reader.close()
        self.assertEqual(seen[0], "BEGIN")                           # every table is read between one BEGIN and one COMMIT
        self.assertEqual(seen[-1], "COMMIT")
        self.assertTrue(len(seen) > 4 and set(seen[1:-1]) == {"SELECT"}, seen)

    def test_a_restored_checkpoint_continues_exactly_like_the_uninterrupted_run(self):
        self.fill()
        reader = SourceReader(self.path)
        whole = Ingestor(reader, hold_ms=2 * SEC)
        a1 = whole.poll(CYCLE + 140 * SEC)["events"]
        reader.close()

        reader = SourceReader(self.path)
        part = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        got = part.poll(CYCLE + 60 * SEC)["events"]
        saved = json.loads(json.dumps(part.checkpoint()))
        reader.close()
        reader = SourceReader(self.path)                                    # new process, state restored from JSON
        again = Ingestor.from_checkpoint(reader, saved, hold_ms=2 * SEC, batch=40)
        while True:
            out = again.poll(CYCLE + 140 * SEC)
            got += out["events"]
            if not out["events"] and not out["state"]["more_to_read"]:
                break
        reader.close()
        self.assertEqual([e["event_id"] for e in got], [e["event_id"] for e in a1])
        self.assertEqual(again.stats["late_source_rows"], 0)


class TestSessionCheckpoint(Base):
    """D-10B-02: the ingestor checkpoint is written atomically after the runner has journaled the poll's events, never ahead
    of the runner, and any crash leaves a state that resumes to the uninterrupted result. ``paper_runner.py`` is untouched."""

    def setUp(self):
        super().setUp()
        for i in range(3, 241):
            self.src.ticker(BTC, CYCLE + i * SEC, "100010" if i < 90 else "103400")
        for n, (o, h, l, c) in enumerate([(100000, 100100, 99900, 100010), (100010, 100100, 99900, 100010),
                                          (100010, 103500, 100000, 103400), (103400, 103500, 103300, 103400)]):
            self.src.candle(BTC, CYCLE + n * MIN, o, h, l, c)
        self.src.commit()
        self.config = RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR)
        self.script = {(BTC, CYCLE): {"action": "BUY", "strength": "0.8"}}
        self.cycle = make_event("cycle", {"product_id": BTC, "cycle_ms": CYCLE, "price": "100000", "atr": "1000"},
                                t_ms=CYCLE + 2 * SEC, source="test", stream="cycle", source_offset=None)
        self.polls = [CYCLE + 60 * SEC, CYCLE + 120 * SEC, CYCLE + 180 * SEC, CYCLE + 250 * SEC, CYCLE + 250 * SEC]

    def new_runner(self, name):
        runner = PaperRunner.create(self.runner_dir(name), self.config, [ScriptedStrategy("scripted-a", self.script)])
        self.addCleanup(runner.close)
        runner.run([self.cycle])
        return runner

    def recover(self, name, clock):
        runner = PaperRunner.recover(self.runner_dir(name), self.config, [ScriptedStrategy("scripted-a", self.script)], clock)
        self.addCleanup(runner.close)
        return runner

    def uninterrupted(self):
        runner = self.new_runner("whole")
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        for now in self.polls:
            SES.step(self.runner_dir("whole"), ing, runner, now)
        reader.close()
        self.assertTrue(runner.portfolio.positions or runner.portfolio.trades)
        return runner

    def resume(self, name, runner_clock, from_poll):
        runner = self.recover(name, runner_clock)
        reader = SourceReader(self.path)
        self.addCleanup(reader.close)
        ing = SES.restore(self.runner_dir(name), reader, runner, hold_ms=2 * SEC, batch=40)
        for now in self.polls[from_poll:]:
            SES.step(self.runner_dir(name), ing, runner, now)
        return runner

    def same_result(self, a, b):
        self.assertEqual(a.financial_digest(), b.financial_digest())
        self.assertEqual(a.portfolio.snapshot(), b.portfolio.snapshot())

    def test_process_restart_between_steps_resumes_to_the_uninterrupted_result(self):
        whole = self.uninterrupted()
        runner = self.new_runner("cut")
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        for now in self.polls[:2]:
            SES.step(self.runner_dir("cut"), ing, runner, now)
        clock = runner.clock
        reader.close()
        runner.close()
        self.same_result(self.resume("cut", clock, 2), whole)

    def test_crash_after_the_runner_but_before_the_ingestor_checkpoint_replays_duplicates_harmlessly(self):
        whole = self.uninterrupted()
        runner = self.new_runner("late")
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        SES.step(self.runner_dir("late"), ing, runner, self.polls[0])
        out = ing.poll(self.polls[1])                      # the runner takes the events ...
        runner.run(out["events"])                          # ... and the process dies before SES.save
        clock = runner.clock
        reader.close()
        runner.close()
        resumed = self.resume("late", clock, 1)            # the older checkpoint re-emits the same rows
        self.same_result(resumed, whole)
        self.assertGreater(resumed.stats.get("rejected:duplicate_event", 0), 0)

    def test_a_crash_while_writing_leaves_the_previous_checkpoint_and_no_partial_file(self):
        whole = self.uninterrupted()
        runner = self.new_runner("mid")
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        SES.step(self.runner_dir("mid"), ing, runner, self.polls[0])
        path = os.path.join(self.runner_dir("mid"), SES.CHECKPOINT_FILE)
        before = open(path, "rb").read()
        runner.run(ing.poll(self.polls[1])["events"])
        with self.assertRaises(SystemError):
            SES.save(self.runner_dir("mid"), ing, runner, _crash_before_rename=True)
        self.assertEqual(open(path, "rb").read(), before)               # the old, complete file stands
        self.assertTrue(os.path.exists(path + ".tmp"))
        clock = runner.clock
        reader.close()
        runner.close()
        self.same_result(self.resume("mid", clock, 1), whole)

    def test_a_checkpoint_never_ahead_of_the_runner_and_foreign_or_damaged_files_are_refused(self):
        runner = self.new_runner("ref")
        reader = SourceReader(self.path)
        ing = Ingestor(reader, hold_ms=2 * SEC, batch=40)
        SES.step(self.runner_dir("ref"), ing, runner, self.polls[0])
        path = os.path.join(self.runner_dir("ref"), SES.CHECKPOINT_FILE)
        self.assertEqual(json.load(open(path))["runner_seq"], len(runner.journal.entries))
        self.assertIsNotNone(SES.load(self.runner_dir("ref"), runner))
        other = self.new_runner("other")                                 # another journal: shorter and different
        other_dir = self.runner_dir("other")
        shutil.copy(path, os.path.join(other_dir, SES.CHECKPOINT_FILE))
        with self.assertRaises(SES.SessionError) as ahead:
            SES.load(other_dir, other)
        self.assertEqual(ahead.exception.reason, "checkpoint_ahead_of_runner")
        text = open(path).read()
        open(path, "w").write(text.replace('"runner_seq": ', '"runner_seq": 0, "x": ', 1))
        with self.assertRaises(SES.SessionError) as damaged:
            SES.load(self.runner_dir("ref"), runner)
        self.assertEqual(damaged.exception.reason, "checkpoint_digest_mismatch")
        open(path, "w").write("{not json")
        with self.assertRaises(SES.SessionError) as bad:
            SES.load(self.runner_dir("ref"), runner)
        self.assertEqual(bad.exception.reason, "checkpoint_unreadable")
        os.remove(path)
        self.assertIsNone(SES.load(self.runner_dir("ref"), runner))
        reader.close()


class TestSourceOutageVersusQuietMarket(Base):
    """C5: a capture outage and a product with no quotes are different things and are not confused."""

    def feed(self, outage):
        for i in range(0, 361):
            t = CYCLE + i * SEC
            if outage and 100 < i < 300:
                continue                                            # nothing arrives at all
            self.src.ticker(BTC, t, "100000")
            if outage or not 60 < i < 300:
                self.src.ticker(ETH, t, "3500")                     # quiet market: ETH goes silent, BTC keeps ticking
        self.src.commit()

    def ticks(self, events):
        return [e["t_ms"] - CYCLE for e in events if e["kind"] == "clock"]

    def test_capture_outage_stops_the_clock_and_is_recorded(self):
        self.feed(outage=True)
        events, state, _ = ingest_all(self.path, CYCLE + 361 * SEC)
        ticks = self.ticks(events)
        self.assertEqual([t for t in ticks if 100 * SEC < t < 300 * SEC], [105 * SEC, 110 * SEC, 115 * SEC, 120 * SEC, 125 * SEC,
                                                                          130 * SEC, 135 * SEC, 140 * SEC, 145 * SEC])
        self.assertEqual(len(state["outages"]), 1)
        self.assertEqual((state["outages"][0]["from_ms"], state["outages"][0]["to_ms"]), (CYCLE + 100 * SEC, CYCLE + 300 * SEC))

    def test_stale_source_is_decided_from_the_source_clock_the_caller_passes(self):
        self.feed(outage=True)
        reader = SourceReader(self.path)
        stale = Ingestor(reader).poll(CYCLE + 10 * MIN)["state"]      # the caller reads the source clock 10 minutes later
        reader.close()
        self.assertEqual(stale["source"], "stale")
        reader = SourceReader(self.path)
        live = Ingestor(reader).poll(CYCLE + 362 * SEC)["state"]
        reader.close()
        self.assertEqual(live["source"], "live")

    def test_one_silent_product_with_the_others_ticking_is_a_quiet_market_and_the_clock_runs(self):
        self.feed(outage=False)
        events, state, _ = ingest_all(self.path, CYCLE + 361 * SEC)
        ticks = self.ticks(events)
        self.assertEqual({b - a for a, b in zip(ticks, ticks[1:])}, {5 * SEC})
        self.assertEqual(state["outages"], [])
        self.assertEqual(state["source"], "live")

    def test_silent_product_is_flagged_while_it_is_silent(self):
        self.feed(outage=False)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        # read only until +250 s: ETH has been silent since +60 s while BTC kept ticking
        rows = [r for r in reader.tickers(0, 10_000) if r["event_time"] <= CYCLE + 250 * SEC]
        ing.reader = type("Cut", (), {"tickers": lambda self_, a, n: rows if a == 0 else [],
                                      "candles": lambda self_, a, n: [], "gaps": lambda self_, a, n: [],
                                      "max_rowids": lambda self_: {"ticker": None, "candle": None, "gap": None},
                                      "begin": lambda self_: None, "end": lambda self_: None})()
        state = ing.poll(CYCLE + 251 * SEC)["state"]
        reader.close()
        self.assertEqual(state["source"], "live")
        self.assertEqual(state["streams"][ETH]["state"], "silent")
        self.assertEqual(state["streams"][BTC]["state"], "alive")

    def run_order(self, outage, stop_ms=None):
        """A scripted BUY on ETH decided at +105 s (execution window to +165 s); returns the runner and the ingestor state."""
        self.path = os.path.join(self.dir, "case-{}-{}.sqlite".format(outage, stop_ms))      # a fresh database per case
        self.src = Source(self.path)
        self.feed(outage=outage)
        events, state, _ = ingest_all(self.path, CYCLE + 361 * SEC)
        script = {(ETH, CYCLE + 100 * SEC): {"action": "BUY", "strength": "0.8"}}
        cycle = make_event("cycle", {"product_id": ETH, "cycle_ms": CYCLE + 100 * SEC, "price": "3500", "atr": "70"},
                           t_ms=CYCLE + 105 * SEC, source="test", stream="cycle", source_offset=None)
        runner = PaperRunner.create(self.runner_dir("out" if outage else "mute"),
                                    RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR),
                                    [ScriptedStrategy("scripted-a", script)])
        self.addCleanup(runner.close)
        for event in sorted(events + [cycle], key=lambda e: e["t_ms"]):
            if stop_ms is not None and event["t_ms"] > stop_ms:
                break
            runner.handle(event)
        return runner, state

    def test_expired_order_is_attributed_to_the_outage_or_to_the_market_not_mixed(self):
        runner, state = self.run_order(outage=True)
        expired = [o for o in runner.orders() if o["state"] == "expired"]
        self.assertTrue(expired, runner.orders())
        self.assertEqual(classify_expiry(expired[0], state["outages"]), "expired_during_source_outage")
        runner2, state2 = self.run_order(outage=False)
        expired2 = [o for o in runner2.orders() if o["state"] == "expired"]
        self.assertTrue(expired2, runner2.orders())
        self.assertEqual(classify_expiry(expired2[0], state2["outages"]), "no_market_quote")
        # the runner's own reason is the same in both: the attribution is read-side only (known gap G1)
        self.assertEqual(expired[0]["reasons"], expired2[0]["reasons"])

    def test_order_is_not_expired_by_the_clock_while_the_source_is_down(self):
        """Current behavior of the ingestor (not a rule; D-10-01 = B is pending): during the outage no tick moves the executor past the last evidence plus
        ``dead_after_ms`` (+145 s), so the order (deadline +165 s) is still pending when the outage is almost over. In the
        quiet-market case the same order is already expired by then."""
        runner, _ = self.run_order(outage=True, stop_ms=CYCLE + 290 * SEC)
        self.assertEqual([o["state"] for o in runner.orders()], ["pending"])
        self.assertLessEqual(runner.clock, CYCLE + 145 * SEC)
        runner2, _ = self.run_order(outage=False, stop_ms=CYCLE + 290 * SEC)
        self.assertEqual([o["state"] for o in runner2.orders()], ["expired"])


class TestSourceContinuityEvidence(Base):
    """D-10B-06 and D-10B-07: what the capture says about its own gaps, which product or source was silent, and where each
    quote came from. All of it is evidence; none of it changes an event the runner receives."""

    def run_all(self, **kw):
        events, state, ing = ingest_all(self.path, CYCLE + 3_000 * SEC, **kw)
        return events, state, ing

    def test_a_quote_keeps_its_transport_epoch_and_row_and_the_stream_stays_one_per_product(self):
        self.src.ticker(BTC, CYCLE, "100000", epoch=REST_EPOCH)
        self.src.ticker(BTC, CYCLE + 5 * SEC, "100000", epoch=3, seq=41)
        self.src.ticker(BTC, CYCLE + 60 * SEC, "100000", epoch=3, seq=42)                  # releases the two before it
        self.src.commit()
        quotes = [e for e in self.run_all()[0] if e["kind"] == "quote"]
        rest, ws = (q["payload"]["origin"] for q in quotes[:2])
        self.assertEqual((rest["transport"], rest["epoch"]), ("rest", REST_EPOCH))
        self.assertEqual((ws["transport"], ws["epoch"], ws["seq"]), ("ws", 3, 41))
        self.assertTrue(all(o[k] for o in (rest, ws) for k in ("rowid", "event_id", "content_hash")))
        self.assertNotEqual(rest["rowid"], ws["rowid"])
        self.assertEqual({q["stream"] for q in quotes}, {"ticker:" + BTC})                 # what the runner sees is unchanged
        self.assertEqual({(q["source_offset"], q["source_epoch"]) for q in quotes}, {(None, 0)})   # no offset is invented

    def test_an_epoch_change_inside_a_product_transport_is_recorded_exactly(self):
        for i, epoch in enumerate((1, 1, 2, 2, 2, 3)):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000", epoch=epoch, seq=i)
            self.src.ticker(ETH, CYCLE + i * 5 * SEC, "3500", epoch=REST_EPOCH)            # another transport: no change
        self.src.commit()
        changes = self.run_all()[1]["epoch_changes"]
        self.assertEqual(changes["total"], 2)
        self.assertEqual([(c["product_id"], c["transport"], c["from_epoch"], c["to_epoch"]) for c in changes["sample"]],
                         [(BTC, "ws", 1, 2), (BTC, "ws", 2, 3)])

    def test_the_evidence_sample_keeps_the_latest_events_and_the_counts_stay_exact(self):
        """D-10D-11: a full sample must hold what happened last, not first, because the session classifies a hole by it."""
        with mock.patch.object(ING, "SILENCE_SAMPLE", 3), mock.patch.object(ING, "GAP_SAMPLE", 2):
            for i in range(10):
                self.src.ticker(BTC, CYCLE + i * 40 * SEC, "100000")                        # every one is a 40 s silence of the source
            for i in range(4):
                self.src.gap(BTC, CYCLE + (10 + i) * SEC)
            self.src.ticker(BTC, CYCLE + 600 * SEC, "100000")
            self.src.commit()
            state = self.run_all()[1]
        silences = state["silences"]
        self.assertEqual(silences["source"], 10)
        self.assertEqual([x["to_ms"] for x in silences["sample"]], [CYCLE + 320 * SEC, CYCLE + 360 * SEC, CYCLE + 600 * SEC])
        self.assertEqual(state["data_gaps"]["total"], 4)
        self.assertEqual([g["detected_at"] for g in state["data_gaps"]["sample"]], [CYCLE + 12 * SEC, CYCLE + 13 * SEC])

    def test_the_capture_gaps_become_evidence_once_their_time_is_released_and_never_an_event(self):
        for i in range(0, 12):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000")
        self.src.gap(BTC, CYCLE + 20 * SEC)
        self.src.gap(ETH, CYCLE + 30 * SEC, reason="reconnect")
        self.src.gap(BTC, CYCLE + 10_000 * SEC)                                           # detected far after what is released
        self.src.commit()
        events, state, ing = self.run_all()
        gaps = state["data_gaps"]
        self.assertEqual((gaps["total"], gaps["by_product"], gaps["pending"]), (2, {BTC: 1, ETH: 1}, 1))
        self.assertEqual([g["reason"] for g in gaps["sample"]], ["seq_gap", "reconnect"])
        self.assertEqual({e["kind"] for e in events}, {"quote", "clock"})                  # no gap_declared, no new kind
        self.assertEqual(ing.cursor["gap"], 3)

    def test_a_product_silence_is_told_apart_from_a_source_silence(self):
        for i in range(0, 25):                                                             # BTC every 5 s for two minutes
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000")
        for i in range(0, 5):                                                              # ETH quotes, then 30 s of nothing
            self.src.ticker(ETH, CYCLE + i * 5 * SEC, "3500")
        self.src.ticker(ETH, CYCLE + 50 * SEC, "3500")
        self.src.commit()
        silences = self.run_all()[1]["silences"]
        self.assertEqual((silences["product"], silences["source"]), (1, 0))
        record = silences["sample"][0]
        self.assertEqual((record["kind"], record["product_id"], record["from_ms"], record["to_ms"], record["outage"]),
                         ("product_silence", ETH, CYCLE + 20 * SEC, CYCLE + 50 * SEC, False))

    def test_a_silence_of_the_whole_source_is_recorded_once_and_flags_a_real_outage(self):
        for t in (0, 5, 10, 40, 45, 120):                                                  # 30 s and then 75 s without any product
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
            self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        self.src.commit()
        events, state, ing = self.run_all()
        silences = state["silences"]
        self.assertEqual((silences["source"], silences["product"]), (2, 0))                # not told again once per product
        source = [s for s in silences["sample"] if s["kind"] == "source_silence"]
        self.assertEqual([(s["from_ms"] - CYCLE, s["to_ms"] - CYCLE, s["outage"]) for s in source],
                         [(10 * SEC, 40 * SEC, False), (45 * SEC, 120 * SEC, True)])
        self.assertEqual(len(state["outages"]), 1)                                         # the old outage rule is untouched

    def test_an_interruption_of_the_whole_source_is_one_record_not_one_per_product(self):
        """D-10B-14: eight products come back after 30 s of nothing: one source_silence and no product_silence."""
        products = ["PF_P{}USD".format(i) for i in range(8)]
        for t in (0, 5, 10, 40, 45, 50):
            for product in products:
                self.src.ticker(product, CYCLE + t * SEC, "100")
        self.src.commit()
        silences = self.run_all()[1]["silences"]
        self.assertEqual((silences["source"], silences["product"]), (1, 0))
        self.assertEqual((silences["sample"][0]["kind"], silences["sample"][0]["from_ms"] - CYCLE, silences["sample"][0]["to_ms"] - CYCLE),
                         ("source_silence", 10 * SEC, 40 * SEC))

    def test_a_product_that_was_silent_while_the_source_was_alive_keeps_its_own_record_even_across_an_interruption(self):
        for t in range(0, 21, 5):                                                          # both quote until +20 s
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
            self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        for t in range(25, 61, 5):                                                         # BTC alone: ETH silent while the source lives
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        for t in (95, 100):                                                                # then nothing for 35 s, then both back
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
            self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        self.src.commit()
        silences = self.run_all()[1]["silences"]
        kinds = [(s["kind"], s["product_id"], s["source_silence_overlap"] if s["kind"] == "product_silence" else None) for s in silences["sample"]]
        self.assertEqual(kinds, [("source_silence", None, None), ("product_silence", ETH, True)])    # BTC's gap is the source's only
        eth = silences["sample"][1]
        self.assertEqual(eth["alive_ms"], 75 * SEC - 35 * SEC)                              # ETH: +20..+95 minus the +60..+95 interruption

    def test_the_threshold_is_a_parameter_not_a_rule(self):
        for t in (0, 10, 20):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
            self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        self.src.commit()
        self.assertEqual(self.run_all()[1]["silences"]["source"], 0)                       # 10 s is under the 15 s hypothesis
        self.assertEqual(self.run_all(product_silence_ms=5 * SEC)[1]["silences"]["source"], 2)

    def test_a_silence_that_has_not_ended_is_reported_open_while_the_source_is_live(self):
        for t in range(0, 61, 5):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        for t in range(0, 21, 5):
            self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        state = ing.poll(CYCLE + 62 * SEC)["state"]
        reader.close()
        self.assertEqual(state["source"], "live")
        self.assertEqual([(o["product_id"], o["silent_for_ms"]) for o in state["silences"]["open"]], [(ETH, 42 * SEC)])
        stale = Ingestor(SourceReader(self.path)).poll(CYCLE + 600 * SEC)["state"]
        self.assertEqual((stale["source"], stale["silences"]["open"]), ("stale", []))      # an outage is told by the outage

    def test_the_evidence_and_the_gap_cursor_survive_a_checkpoint_in_the_middle(self):
        for i in range(0, 30):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000", epoch=1 + i // 10, seq=i)
        self.src.gap(BTC, CYCLE + 20 * SEC)
        self.src.gap(BTC, CYCLE + 60 * SEC)
        self.src.commit()
        whole = ingest_all(self.path, CYCLE + 3_000 * SEC)
        reader = SourceReader(self.path)
        first = Ingestor(reader)
        out = first.poll(CYCLE + 3_000 * SEC)
        saved = json.loads(json.dumps(first.checkpoint()))
        reader.close()
        reader = SourceReader(self.path)
        second = Ingestor.from_checkpoint(reader, saved)
        more = second.poll(CYCLE + 3_000 * SEC)
        reader.close()
        self.assertEqual(more["events"], [])                                              # nothing is read or evidenced twice
        for key in ("data_gaps", "silences", "epoch_changes"):
            self.assertEqual(more["state"][key], whole[1][key])
        self.assertEqual(second.cursor, whole[2].cursor)

    def test_a_checkpoint_from_before_the_evidence_fields_still_loads(self):
        for i in range(0, 10):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        ing.poll(CYCLE + 3_000 * SEC)
        old = ing.checkpoint()
        for name in Ingestor.EVIDENCE_FIELDS:
            old.pop(name)
        old["cursor"].pop("gap")
        old["stats"] = {k: v for k, v in old["stats"].items() if k not in ("data_gaps", "product_silences", "source_silences", "epoch_changes")}
        again = Ingestor.from_checkpoint(reader, old)
        reader.close()
        self.assertEqual((again.cursor["gap"], again.silences, again.data_gaps, again.stats["data_gaps"]), (0, [], [], 0))

    def test_a_table_refilled_with_other_rows_past_the_cursor_is_noticed_by_the_row_at_the_cursor(self):
        """D-10B-16: MAX(rowid) alone would not see a source that was emptied and refilled past the cursor."""
        for i in range(0, 10):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        ing.poll(CYCLE + 3_000 * SEC)
        saved = ing.checkpoint()
        reader.close()
        other = Source(os.path.join(self.dir, "refilled.sqlite"))                           # same table shape, other rows, longer
        other.n = 1_000                                                                     # other event ids
        for i in range(0, 30):
            other.ticker(BTC, CYCLE + 1_000 * SEC + i * 5 * SEC, "100000")
        other.close()
        reader = SourceReader(other.path)
        again = Ingestor.from_checkpoint(reader, saved)
        with self.assertRaises(IngestError) as caught:
            again.poll(CYCLE + 3_000 * SEC)
        reader.close()
        self.assertEqual(caught.exception.reason, "cursor_anchor_mismatch")

    def test_a_cursor_beyond_the_source_stops_the_ingestor_instead_of_skipping_rows(self):
        for i in range(0, 10):
            self.src.ticker(BTC, CYCLE + i * 5 * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        ing.poll(CYCLE + 3_000 * SEC)
        saved = ing.checkpoint()
        reader.close()
        other = Source(os.path.join(self.dir, "replaced.sqlite"))                           # a different, shorter source
        other.ticker(BTC, CYCLE, "100000")
        other.close()
        reader = SourceReader(other.path)
        again = Ingestor.from_checkpoint(reader, saved)
        with self.assertRaises(IngestError) as caught:
            again.poll(CYCLE + 3_000 * SEC)
        reader.close()
        self.assertEqual(caught.exception.reason, "cursor_ahead_of_source")


class TestOpenSilencesAreDurable(Base):
    """D-10B-17: a silence that has not ended yet is evidence too. How far the source was observed is kept (in the source's
    clock), a silence that crosses a process death stays one silence with the unobserved stretch told apart, and nothing
    here is a quote: no event is invented and the runner receives exactly what it did before."""

    def feed(self, btc_until, eth_until=None, step=5):
        for t in range(0, btc_until + 1, step):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        for t in range(0, (eth_until if eth_until is not None else btc_until) + 1, step):
            if eth_until is not None:
                self.src.ticker(ETH, CYCLE + t * SEC, "3500")
        self.src.commit()

    def poll(self, ing, at_s, **kw):
        return ing.poll(CYCLE + at_s * SEC, **kw)

    def reopen(self, ing, reader):
        saved = json.loads(json.dumps(ing.checkpoint()))
        reader.close()
        reader = SourceReader(self.path)
        again = Ingestor.from_checkpoint(reader, saved, **{"expected_products": ing.expected_products})
        again.mark_recovered()
        return again, reader

    def test_an_open_silence_keeps_its_start_and_how_far_it_was_observed(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 62)
        first = ing.observation()
        self.poll(ing, 80)
        second = ing.observation()
        reader.close()
        self.assertEqual(first["open_silences"][ETH]["since_ms"], CYCLE + 20 * SEC)
        self.assertEqual(first["open_silences"][ETH]["observed_until_ms"], CYCLE + 62 * SEC - ING.DEFAULT_HOLD_MS)
        self.assertEqual(second["open_silences"][ETH]["since_ms"], CYCLE + 20 * SEC)           # extended, never restarted
        self.assertEqual(second["open_silences"][ETH]["observed_until_ms"], CYCLE + 80 * SEC - ING.DEFAULT_HOLD_MS)
        self.assertEqual(second["observation_gaps"], [])

    def test_a_silence_across_a_process_death_is_one_silence_with_the_unobserved_stretch_told_apart(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 40)
        ing, reader = self.reopen(ing, reader)
        self.poll(ing, 90)
        seen = ing.observation()
        self.assertEqual(seen["observation_gaps"], [[CYCLE + 40 * SEC - ING.DEFAULT_HOLD_MS, CYCLE + 90 * SEC - ING.DEFAULT_HOLD_MS]])
        self.assertEqual(seen["open_silences"][ETH]["since_ms"], CYCLE + 20 * SEC)
        self.assertTrue(seen["open_silences"][ETH]["partial"])
        self.src.ticker(ETH, CYCLE + 100 * SEC, "3500")
        self.src.ticker(BTC, CYCLE + 110 * SEC, "100000")
        self.src.commit()
        self.poll(ing, 200)
        reader.close()
        closed = [x for x in ing.silences if x["kind"] == "product_silence" and x["product_id"] == ETH]
        self.assertEqual([x["observed"] for x in closed], ["partial"])
        self.assertEqual(ing.open_silences[ETH]["since_ms"], CYCLE + 100 * SEC)               # a new silence, not the old one
        self.assertFalse(ing.open_silences[ETH]["partial"])

    def test_the_same_silence_without_a_death_is_observed_in_full(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 40)
        self.poll(ing, 90)
        self.src.ticker(ETH, CYCLE + 100 * SEC, "3500")
        self.src.ticker(BTC, CYCLE + 110 * SEC, "100000")
        self.src.commit()
        self.poll(ing, 200)
        reader.close()
        self.assertEqual([x["observed"] for x in ing.silences if x["product_id"] == ETH], ["complete"])
        self.assertEqual(ing.observation_gaps, [])

    def test_a_short_death_is_still_an_observation_gap(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 40)
        ing, reader = self.reopen(ing, reader)
        self.poll(ing, 41)
        reader.close()
        self.assertEqual(len(ing.observation_gaps), 1)

    def test_a_source_that_never_emits_again_leaves_the_silence_open_and_invents_nothing(self):
        self.feed(30)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        base = self.poll(ing, 40)["events"]
        later = [self.poll(ing, at) for at in (100, 400, 1_000)]
        reader.close()
        self.assertTrue(all(o["events"] == [] or all(e["kind"] == "clock" for e in o["events"]) for o in later))
        self.assertFalse([e for o in later for e in o["events"] if e["kind"] in ("quote", "candle")])
        seen = ing.observation()
        self.assertEqual(seen["open_silences"]["*"]["scope"], "source")
        self.assertEqual(seen["open_silences"]["*"]["since_ms"], CYCLE + 30 * SEC)
        self.assertEqual(seen["open_silences"]["*"]["observed_until_ms"], CYCLE + 1_000 * SEC - ING.DEFAULT_HOLD_MS)
        self.assertEqual(ing.last_any_ticker_ms, CYCLE + 30 * SEC)
        self.assertTrue(base is not None)

    def test_the_process_clock_is_kept_apart_and_never_feeds_the_source_bound(self):
        self.feed(30)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 40)
        before = ing.observation()
        self.poll(ing, 500, clock="process")
        mid = ing.observation()
        self.assertEqual(mid["observed_until_ms"], before["observed_until_ms"])
        self.assertEqual(mid["open_process"]["*"]["observed_until_ms"], CYCLE + 500 * SEC - ING.DEFAULT_HOLD_MS)
        self.src.ticker(BTC, CYCLE + 520 * SEC, "100000")                                    # the source is back
        self.src.ticker(BTC, CYCLE + 600 * SEC, "100000")
        self.src.commit()
        self.poll(ing, 700)
        reader.close()
        self.assertEqual(ing.contradicted, [])                                               # no spurious contradiction
        self.assertEqual(ing.open_process, {})

    def test_a_quote_inside_what_was_already_observed_contradicts_it_and_is_still_delivered(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 62)
        self.assertIn(ETH, ing.open_silences)
        self.src.ticker(ETH, CYCLE + 59 * SEC, "3500")                                       # persisted late, inside the bound
        self.src.ticker(BTC, CYCLE + 120 * SEC, "100000")
        self.src.commit()
        out = self.poll(ing, 125)
        reader.close()
        self.assertEqual([(c["product_id"], c["since_ms"], c["quote_ms"]) for c in ing.contradicted],
                         [(ETH, CYCLE + 20 * SEC, CYCLE + 59 * SEC)])
        self.assertIn((ETH, CYCLE + 59 * SEC), [(e["payload"]["product_id"], e["t_ms"]) for e in out["events"] if e["kind"] == "quote"])
        self.assertEqual(ing.open_silences[ETH]["since_ms"], CYCLE + 59 * SEC)                # the old silence is closed

    def test_a_silence_nobody_saw_open_is_not_called_observed(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 125)                                                                   # first look, after it already ended
        reader.close()
        self.assertTrue([x for x in ing.silences if x["product_id"] == ETH] == [] or
                        {x["observed"] for x in ing.silences if x["product_id"] == ETH} <= {"not_observed", "complete"})

    def test_a_product_that_never_quoted_is_a_silence_from_the_first_observation(self):
        self.feed(60)
        reader = SourceReader(self.path)
        ing = Ingestor(reader, expected_products=(BTC, ETH))
        self.poll(ing, 62)
        self.assertNotIn(ETH, ing.open_silences)                                              # not over the limit yet
        self.poll(ing, 90)
        reader.close()
        self.assertEqual(ing.observation()["open_silences"][ETH]["since_ms"], ing.first_observed_ms)

    def test_an_unfinished_read_proves_nothing(self):
        self.feed(60)
        reader = SourceReader(self.path)
        ing = Ingestor(reader, batch=3)
        self.poll(ing, 62)
        self.assertTrue(ing.ticker_more)
        self.assertIsNone(ing.observed_until_ms)
        reader.close()

    def test_the_observation_log_is_bounded_by_time_not_by_the_number_of_silent_products(self):
        self.feed(10)
        reader = SourceReader(self.path)
        ing = Ingestor(reader, expected_products=tuple("PF_P{}".format(i) for i in range(8)) + (BTC,))
        for at in range(12, 400, 3):
            self.poll(ing, at)
        reader.close()
        self.assertLessEqual(len(ing.observation_log), 400 // 15 + 1)

    def test_the_observation_evidence_survives_the_checkpoint_and_an_old_checkpoint_loads_empty(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 62)
        saved = json.loads(json.dumps(ing.checkpoint()))
        reader.close()
        for name in ING.Ingestor.EVIDENCE_FIELDS[-10:]:
            self.assertIn(name, saved)
        self.assertEqual(Ingestor.from_checkpoint(SourceReader(self.path), saved).observation(), ing.observation())
        old = {k: v for k, v in saved.items() if k not in ING.Ingestor.EVIDENCE_FIELDS[-10:]}
        loaded = Ingestor.from_checkpoint(SourceReader(self.path), old)
        self.assertEqual((loaded.observed_until_ms, loaded.open_silences, loaded.observation_gaps), (None, {}, []))

    def test_a_silence_that_crosses_a_death_is_partial_even_if_a_row_read_in_the_first_poll_ends_it(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 38)
        saved = json.loads(json.dumps(ing.checkpoint()))
        reader.close()
        self.src.ticker(ETH, CYCLE + 70 * SEC, "3500")                                       # written while the process was dead
        for t in range(65, 91, 5):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        again = Ingestor.from_checkpoint(reader, saved)
        again.mark_recovered()
        self.poll(again, 90)
        self.poll(again, 120)
        reader.close()
        self.assertEqual([x["observed"] for x in again.silences if x["product_id"] == ETH], ["partial"])
        self.assertEqual(len(again.observation_gaps), 1)

    def test_a_first_poll_that_does_not_exhaust_the_read_still_ends_the_silence_as_partial(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 38)
        saved = json.loads(json.dumps(ing.checkpoint()))
        reader.close()
        self.src.ticker(ETH, CYCLE + 70 * SEC, "3500")
        for t in range(65, 121, 5):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        self.src.commit()
        reader = SourceReader(self.path)
        again = Ingestor.from_checkpoint(reader, saved, batch=3)
        again.mark_recovered()
        self.poll(again, 130)
        self.assertTrue(again.ticker_more)
        for _ in range(10):
            self.poll(again, 130)
        reader.close()
        self.assertEqual({x["observed"] for x in again.silences if x["product_id"] == ETH}, {"partial"})

    def test_any_late_row_ends_the_whole_source_silence_and_a_changed_start_is_a_new_silence(self):
        self.feed(30)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        self.poll(ing, 40)
        self.poll(ing, 100)
        self.assertEqual(ing.open_silences["*"]["since_ms"], CYCLE + 30 * SEC)
        self.src.ticker(BTC, CYCLE + 35 * SEC, "100000")                                     # inside the observed stretch, 5 s after the last row
        self.src.commit()
        self.poll(ing, 101)
        reader.close()
        self.assertIn(None, [c["product_id"] for c in ing.contradicted])
        self.assertTrue(all(e["since_ms"] != CYCLE + 30 * SEC for e in ing.open_silences.values()))

    def test_a_death_before_the_first_exhausted_poll_still_leaves_an_observation_gap(self):
        self.feed(60, 20)
        reader = SourceReader(self.path)
        ing = Ingestor(reader, batch=4)
        self.poll(ing, 70)
        self.assertIsNone(ing.observed_until_ms)
        released = ing.released_ms
        self.assertIsNotNone(released)
        ing, reader = self.reopen(ing, reader)
        ing.batch = 5_000
        self.poll(ing, 90)
        reader.close()
        self.assertEqual(len(ing.observation_gaps), 1)
        self.assertEqual(ing.observation_gaps[0][0], released)                              # what was read is all that is known

    def test_what_a_silent_source_said_last_is_released_only_up_to_what_is_proven(self):
        self.feed(30)
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        out = self.poll(ing, 31)
        held = [e for e in out["events"] if e["kind"] == "quote"]
        self.assertTrue(ing.pending)                                                          # the last rows wait for the watermark
        self.poll(ing, 200)
        self.assertTrue(ing.pending)                                                          # a mute source never moves it
        proven = ing.proven_until()
        self.assertEqual(proven, CYCLE + 200 * SEC - ING.DEFAULT_HOLD_MS)
        with self.assertRaises(IngestError) as caught:
            ing.release_proven(proven + 1)
        self.assertEqual(caught.exception.reason, "release_beyond_proof")
        late = ing.release_proven(CYCLE + 100 * SEC)
        reader.close()
        self.assertEqual([e["t_ms"] for e in late if e["kind"] == "quote"], [CYCLE + 30 * SEC])
        self.assertTrue(held)
        self.assertEqual(ing.pending, [])
        self.assertEqual(ing.released_ms, CYCLE + 100 * SEC)
        self.assertEqual(ing.release_proven(CYCLE + 100 * SEC), [])                           # nothing twice

    def test_nothing_is_proven_while_the_read_is_unfinished_or_a_death_is_not_told(self):
        self.feed(30)
        reader = SourceReader(self.path)
        ing = Ingestor(reader, batch=3)
        self.poll(ing, 100)
        self.assertIsNone(ing.proven_until())
        reader.close()
        reader = SourceReader(self.path)
        again = Ingestor(reader)
        self.poll(again, 100)
        self.assertIsNotNone(again.proven_until())
        again, reader = self.reopen(again, reader)
        self.assertIsNone(again.proven_until())                                               # the stretch nobody observed comes first
        self.poll(again, 120)
        self.assertIsNotNone(again.proven_until())
        reader.close()

    def test_an_overdue_candle_limits_what_is_proven_until_the_lag_has_passed(self):
        """D-172-05 / D-172-06: the candle of a minute may still turn up until ``candle_lag_ms`` after it was due. While that
        holds, what is proven stops at its due time; once the observed time is past the lag (the source being mute, the
        tickers no longer move), it stops limiting."""
        for t in range(0, 231, 5):
            self.src.ticker(BTC, CYCLE + t * SEC, "100000")
        for bucket in (0, 1, 2):
            self.src.candle(BTC, CYCLE + bucket * MIN, 1, 1, 1, 1)
        self.src.commit()
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        due_ms = CYCLE + 2 * MIN + 2 * MIN - 1                                                # the last bucket read is minute 2: due at 4 min
        lag = ING.DEFAULT_CANDLE_LAG_MS
        self.poll(ing, 250)
        self.assertEqual(ing.proven_until(), due_ms)
        self.poll(ing, 2 * MIN // SEC + 120 + 120)                                            # still inside the lag: 4 min + 120 s after the due minute
        self.assertEqual(ing.proven_until(), due_ms)
        past = (due_ms + 1 + lag - CYCLE) // SEC + ING.DEFAULT_HOLD_MS // SEC + 1
        self.poll(ing, past)
        self.assertEqual(ing.proven_until(), ing.observed_until_ms)                           # the mute source: the lag is over
        reader.close()

    def test_the_events_the_runner_receives_do_not_change(self):
        self.feed(60, 20)
        plain = ingest_all(self.path, CYCLE + 3_000 * SEC)[0]
        reader = SourceReader(self.path)
        ing = Ingestor(reader)
        events = []
        for at in (30, 62, 90, 3_000):
            events += self.poll(ing, at)["events"]
        reader.close()
        self.assertEqual([e for e in events if e["kind"] != "clock"], [e for e in plain if e["kind"] != "clock"])


class TestShortOutageInsideTheWindow(Base):
    """D-10-01: with the clock stopped, a short outage does not cancel the order: the first quote after the outage fills
    it if it still falls inside the execution window. That is the behavior to decide on (docs section 6), not a rule."""

    def test_fill_after_a_short_outage_uses_the_first_quote_after_it_and_never_one_past_the_deadline(self):
        for i in range(0, 200):
            t = CYCLE + i * SEC
            if 100 < i < 126:
                continue
            self.src.ticker(BTC, t, "100000")
            self.src.ticker(ETH, t, "3500" if i < 126 else "3520")
        self.src.commit()
        events, state, _ = ingest_all(self.path, CYCLE + 200 * SEC)
        script = {(ETH, CYCLE + 100 * SEC): {"action": "BUY", "strength": "0.8"}}
        cycle = make_event("cycle", {"product_id": ETH, "cycle_ms": CYCLE + 100 * SEC, "price": "3500", "atr": "70"},
                           t_ms=CYCLE + 100 * SEC + 500, source="test", stream="cycle", source_offset=None)
        runner = PaperRunner.create(self.runner_dir("short"), RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR),
                                    [ScriptedStrategy("scripted-a", script)])
        self.addCleanup(runner.close)
        runner.run(sorted(events + [cycle], key=lambda e: e["t_ms"]))
        order = [o for o in runner.orders() if o["product_id"] == ETH][0]
        self.assertEqual(state["outages"], [])      # 26 s is below dead_after_ms: not an outage, just a quiet stretch
        self.assertEqual(order["state"], "opened")
        self.assertGreater(order["timeline"]["entry_ms"], CYCLE + 100 * SEC + 25 * SEC)      # a price from after the outage
        self.assertLessEqual(order["timeline"]["entry_ms"], order["timeline"]["deadline_ms"])


class TestRunnerEquivalence(Base):
    """The ingested stream drives the real runner; continuous, interrupted-and-recovered and re-read-from-zero agree."""

    def build(self):
        for i in range(0, 241):
            t = CYCLE + i * SEC
            mid = "100010" if i < 90 else "103400"
            self.src.ticker(BTC, t, mid)
        self.src.candle(BTC, CYCLE, 100000, 100100, 99900, 100010)
        self.src.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010)
        self.src.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400)
        self.src.candle(BTC, CYCLE + 3 * MIN, 103400, 103500, 103300, 103400)
        self.src.commit()
        events, _, _ = ingest_all(self.path, CYCLE + 250 * SEC)
        cycle = make_event("cycle", {"product_id": BTC, "cycle_ms": CYCLE, "price": "100000", "atr": "1000"},
                           t_ms=CYCLE + 2 * SEC, source="test", stream="cycle", source_offset=None)
        return sorted(events + [cycle], key=lambda e: e["t_ms"])

    def runner(self, name, **kw):
        script = {(BTC, CYCLE): {"action": "BUY", "strength": "0.8"}}
        r = PaperRunner.create(self.runner_dir(name), RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR),
                               [ScriptedStrategy("scripted-a", script)])
        self.addCleanup(r.close)
        return r

    def test_continuous_equals_interrupted_and_reread(self):
        events = self.build()
        cont = self.runner("cont")
        cont.run(events)
        self.assertTrue(cont.portfolio.positions or cont.portfolio.trades, "the scripted entry must have opened")
        cut = len(events) // 2
        part = self.runner("part")
        part.run(events[:cut])
        clock = part.clock
        part.close()
        config = RunnerConfig(funding=FUNDING, start_ms=CYCLE - HOUR)
        script = {(BTC, CYCLE): {"action": "BUY", "strength": "0.8"}}
        recovered = PaperRunner.recover(self.runner_dir("part"), config, [ScriptedStrategy("scripted-a", script)], clock)
        self.addCleanup(recovered.close)
        recovered.run(events)                      # the ingestor re-reads from zero: seen events are duplicates
        self.assertEqual(recovered.financial_digest(), cont.financial_digest())
        self.assertEqual(recovered.portfolio.snapshot(), cont.portfolio.snapshot())
        self.assertGreater(recovered.stats.get("rejected:duplicate_event", 0), 0)

    def test_same_database_gives_the_same_events(self):
        a = self.build()
        reader = SourceReader(self.path)
        b = []
        ing = Ingestor(reader)
        while True:
            out = ing.poll(CYCLE + 250 * SEC)
            if not out["events"]:
                break
            b += out["events"]
        reader.close()
        self.assertEqual([e["event_id"] for e in a if e["source"] == "kraken-capture"], [e["event_id"] for e in b])


class TestPublishedContracts(TestRunnerEquivalence):
    """C6: the B5 (positions) and B3 (intervals) blocks are built from the runner's own report, tagged as an integration
    session, and say "not verified" when the evidence is not fresh. No frontend, gateway or file is involved."""

    def test_positions_block(self):
        events = self.build()
        runner = self.runner("pos")
        runner.run(events[:len(events) // 2])           # the long is open
        block = PUB.positions(runner, report_age_ms=1_000, max_age_ms=15_000, source_state=LIVE, threshold_approved=True)
        self.assertEqual((block["mode"], block["evidence_class"], block["execution_class"]),
                         ("integration", "not_forward_evidence", "observed_quotes"))
        self.assertEqual(len(block["positions"]), 1)
        row = block["positions"][0]
        self.assertEqual((row["product_id"], row["side"], row["classes"]["pnl"]), (BTC, "LONG", "estimated"))
        self.assertTrue(row["verified"], block["verification"])
        self.assertEqual(block["unrealized_class"], "estimated")
        json.dumps(block)                                # the block is plain JSON

    def test_positions_are_not_verified_when_the_report_is_stale_or_the_runner_is_closed(self):
        events = self.build()
        runner = self.runner("stale")
        runner.run(events[:len(events) // 2])
        stale = PUB.positions(runner, report_age_ms=60_000, max_age_ms=15_000, source_state=LIVE, threshold_approved=True)
        self.assertFalse(stale["positions"][0]["verified"])
        self.assertEqual(stale["verification"]["reasons"], ["report_stale"])
        self.assertFalse(PUB.positions(runner, None, 15_000, LIVE, threshold_approved=True)["positions"][0]["verified"])

    def test_a_limit_that_is_not_approved_never_makes_anything_fresh_or_verified(self):
        """BAL-DECISION-187-01, P2: the publisher carries the limits, labelled hypothesis; there is no default and no limit is
        approved. Without an approved limit the report is never ``fresh`` and the positions are never ``verified``, with live
        data and a brand-new report alike; an older report than the limit still degrades to ``stale``."""
        events = self.build()
        runner = self.runner("nolimit")
        runner.run(events[:len(events) // 2])
        none = PUB.positions(runner, report_age_ms=0, source_state=LIVE)
        self.assertFalse(none["positions"][0]["verified"])
        self.assertFalse(none["positions"][0]["accounting_verified"])
        self.assertEqual(none["verification"]["reasons"], ["freshness_threshold_not_approved"])
        self.assertEqual((none["verification"]["freshness"], none["verification"]["thresholds"]),
                         ("unknown", {"report_max_age_ms": None, "status": "not_approved"}))
        hypothesis = PUB.positions(runner, report_age_ms=1_000, max_age_ms=15_000, source_state=LIVE)
        self.assertFalse(hypothesis["positions"][0]["verified"])
        self.assertEqual(hypothesis["verification"]["reasons"], ["freshness_threshold_not_approved"])
        self.assertEqual((hypothesis["verification"]["freshness"], hypothesis["verification"]["thresholds"]),
                         ("unknown", {"report_max_age_ms": 15_000, "status": "hypothesis"}))
        old = PUB.positions(runner, report_age_ms=60_000, max_age_ms=15_000, source_state=LIVE)["verification"]
        self.assertEqual((old["freshness"], old["reasons"]), ("stale", ["report_stale", "freshness_threshold_not_approved"]))
        no_age = PUB.positions(runner, None, 15_000, LIVE)["verification"]
        self.assertEqual((no_age["freshness"], no_age["reasons"]), ("unknown", ["report_age_unknown", "freshness_threshold_not_approved"]))
        approved = PUB.positions(runner, 1_000, 15_000, LIVE, threshold_approved=True)["verification"]    # a fixture, not a real approval
        self.assertEqual((approved["freshness"], approved["thresholds"]["status"], approved["verified"]), ("fresh", "approved", True))
        self.assertFalse(PUB.positions(runner, 1_000, None, LIVE, threshold_approved=True)["verification"]["verified"])
        json.dumps(none)

    def test_positions_are_not_verified_when_the_data_is_stale_even_if_the_report_is_fresh(self):
        events = self.build()
        runner = self.runner("datastale")
        runner.run(events[:len(events) // 2])
        stale = PUB.positions(runner, 1_000, 15_000, {"source": "stale"}, threshold_approved=True)
        self.assertFalse(stale["positions"][0]["verified"])
        self.assertTrue(stale["positions"][0]["accounting_verified"] is False)
        self.assertEqual(stale["verification"]["reasons"], ["source_stale"])
        unknown = PUB.positions(runner, 1_000, 15_000, threshold_approved=True)
        self.assertEqual(unknown["verification"]["reasons"], ["source_state_unknown"])
        self.assertFalse(unknown["positions"][0]["verified"])

    def test_a_stop_nobody_has_watched_since_the_entry_is_not_verified(self):
        events = self.build()
        runner = self.runner("fresh")
        for event in events:
            runner.run([event])
            if runner.portfolio.positions:
                break
        block = PUB.positions(runner, report_age_ms=1_000, max_age_ms=15_000, source_state=LIVE, threshold_approved=True)
        row = block["positions"][0]
        self.assertEqual(row["protection_evidence"], "not_yet_observed")
        self.assertTrue(row["accounting_verified"])
        self.assertFalse(row["verified"])
        runner.run([e for e in events if e["t_ms"] > runner.clock][:20])
        later = PUB.positions(runner, 1_000, 15_000, LIVE, threshold_approved=True)["positions"][0]
        self.assertEqual(later["protection_evidence"], "observed")
        self.assertTrue(later["verified"])

    def test_intervals_block_follows_signal_to_trade_and_filters(self):
        events = self.build()
        runner = self.runner("int")
        runner.run(events)
        block = PUB.intervals(runner)
        self.assertEqual(len(block["intervals"]), 1)
        row = block["intervals"][0]
        self.assertEqual(block["contract"], {"complete": False, "stages_present": ["decision", "order", "trade"],
                                             "stages_missing": ["signal"]})
        self.assertEqual(row["stages"]["signal"]["state"], "not_available")
        self.assertEqual(row["stages"]["order"]["state"], "opened")
        self.assertIn(row["stages"]["trade"]["state"], ("closed", "open"))
        self.assertEqual(PUB.intervals(runner, product=ETH)["intervals"], [])
        self.assertEqual(PUB.intervals(runner, from_ms=row["decided_ms"] + 1)["intervals"], [])
        self.assertEqual(len(PUB.intervals(runner, from_ms=row["decided_ms"], to_ms=row["decided_ms"] + 1)["intervals"]), 1)


if __name__ == "__main__":
    unittest.main()
