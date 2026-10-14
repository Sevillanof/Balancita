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
from decimal import Decimal

from balancita_engine import signal_continuity as SC
from balancita_engine import paper_live_publish as PUB
from balancita_engine.paper_live_ingest import Ingestor, SourceReader, classify_expiry
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

    def ticker(self, product, t, mid, half_bps="0.5", seq=None):
        mid = D(str(mid))
        half = D(half_bps) / D(10_000)
        body = {"type": "ticker", "productId": product, "seq": t if seq is None else seq, "epoch": REST_EPOCH,
                "eventTime": t, "receivedAt": t, "persistedAt": t, "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}
        self.n += 1
        self.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("t{}".format(self.n), "ticker", product, REST_EPOCH, body["seq"], t, t, t, None, "{}",
                         json.dumps(body, sort_keys=True), "h{}".format(self.n)))

    def candle(self, product, bucket, o, h, l, c, known_at=None, revision="r1"):   # noqa: E741
        self.db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (product, MIN, bucket, revision, bucket + MIN + 2 * SEC if known_at is None else known_at,
                         str(o), str(h), str(l), str(c), "1", "s"))

    def gap(self, product, t, reason="seq_gap"):
        self.n += 1
        self.db.execute("INSERT INTO paper_futures_data_gaps VALUES(?,?,?,?,?,?,?,?,?)",
                        ("g{}".format(self.n), "ticker", product, 1, 1, 3, t, reason, "p"))

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
        self.assertEqual(seen, ["BEGIN", "SELECT", "SELECT", "COMMIT"])

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
                                      "candles": lambda self_, a, n: [],
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
        """The stop-the-clock rule: during the outage no tick moves the executor past the last evidence plus
        ``dead_after_ms`` (+145 s), so the order (deadline +165 s) is still pending when the outage is almost over. In the
        quiet-market case the same order is already expired by then."""
        runner, _ = self.run_order(outage=True, stop_ms=CYCLE + 290 * SEC)
        self.assertEqual([o["state"] for o in runner.orders()], ["pending"])
        self.assertLessEqual(runner.clock, CYCLE + 145 * SEC)
        runner2, _ = self.run_order(outage=False, stop_ms=CYCLE + 290 * SEC)
        self.assertEqual([o["state"] for o in runner2.orders()], ["expired"])


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
        block = PUB.positions(runner, report_age_ms=1_000, max_age_ms=15_000, source_state=LIVE)
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
        stale = PUB.positions(runner, report_age_ms=60_000, max_age_ms=15_000, source_state=LIVE)
        self.assertFalse(stale["positions"][0]["verified"])
        self.assertEqual(stale["verification"]["reasons"], ["report_stale"])
        self.assertFalse(PUB.positions(runner, None, 15_000, LIVE)["positions"][0]["verified"])

    def test_positions_are_not_verified_when_the_data_is_stale_even_if_the_report_is_fresh(self):
        events = self.build()
        runner = self.runner("datastale")
        runner.run(events[:len(events) // 2])
        stale = PUB.positions(runner, 1_000, 15_000, {"source": "stale"})
        self.assertFalse(stale["positions"][0]["verified"])
        self.assertTrue(stale["positions"][0]["accounting_verified"] is False)
        self.assertEqual(stale["verification"]["reasons"], ["source_stale"])
        unknown = PUB.positions(runner, 1_000, 15_000)
        self.assertEqual(unknown["verification"]["reasons"], ["source_state_unknown"])
        self.assertFalse(unknown["positions"][0]["verified"])

    def test_a_stop_nobody_has_watched_since_the_entry_is_not_verified(self):
        events = self.build()
        runner = self.runner("fresh")
        for event in events:
            runner.run([event])
            if runner.portfolio.positions:
                break
        block = PUB.positions(runner, report_age_ms=1_000, max_age_ms=15_000, source_state=LIVE)
        row = block["positions"][0]
        self.assertEqual(row["protection_evidence"], "not_yet_observed")
        self.assertTrue(row["accounting_verified"])
        self.assertFalse(row["verified"])
        runner.run([e for e in events if e["t_ms"] > runner.clock][:20])
        later = PUB.positions(runner, 1_000, 15_000, LIVE)["positions"][0]
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
