import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine.canonical import canonical_json
from balancita_engine.futures_verdicts import (
    VERDICT_CONFIG,
    VerdictService,
    VerdictStore,
    evaluate_verdict,
    process_available,
)

MINUTE = 60_000
FIVE = 300_000
START = 1_791_000_000_000 - (1_791_000_000_000 % FIVE)

# Same DDL as the market store's migration 4 (server/src/features/kraken-futures/futures-market-store.ts).
OFFICIAL_DDL = """
CREATE TABLE paper_futures_official_candle_responses(
  sha256 TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL, received_at INTEGER NOT NULL, raw_response TEXT NOT NULL
) STRICT;
CREATE TABLE paper_futures_official_candles(
  interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL,
  known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL,
  low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
  response_sha256 TEXT NOT NULL REFERENCES paper_futures_official_candle_responses(sha256),
  PRIMARY KEY(interval_ms, bucket_start, revision_hash)
) STRICT;
"""


def official(interval, bucket, known_at, close="100000", high="100050", low="99950", volume="1", open_="100000"):
    return {
        "interval_ms": interval,
        "bucket_start": bucket,
        "close_at": bucket + interval,
        "known_at": known_at,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume_btc": volume,
        "revision_hash": "h-{}-{}-{}".format(interval, bucket, close),
    }


def flat_series(interval, count, end_bucket, known_at):
    return [official(interval, end_bucket - (count - 1 - index) * interval, known_at) for index in range(count)]


def breakout_series(known_at):
    """MOCK-like data: flat minutes, then a close above the 20-bar high on 2x volume."""
    candidate = START + 300 * MINUTE
    ones = flat_series(MINUTE, 260, candidate, known_at)
    ones[-1] = official(MINUTE, candidate, known_at, close="100100", high="100101", volume="2")
    # The last 5m bar closes when the candidate minute opens.
    fives = flat_series(FIVE, 80, candidate - FIVE, known_at)
    return ones, fives


class MarketDb:
    def __init__(self, path):
        self.path = path
        connection = sqlite3.connect(path)
        connection.executescript(OFFICIAL_DDL)
        connection.close()
        self.responses = 0

    def insert(self, candles):
        connection = sqlite3.connect(self.path)
        with connection:
            for candle in candles:
                self.responses += 1
                sha = "r{}-{}".format(self.responses, candle["known_at"])
                connection.execute(
                    "INSERT OR IGNORE INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?)",
                    (sha, candle["interval_ms"], 0, 0, candle["known_at"], "{}"),
                )
                connection.execute(
                    "INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        candle["interval_ms"], candle["bucket_start"], candle["revision_hash"], candle["known_at"],
                        candle["open"], candle["high"], candle["low"], candle["close"], candle["volume_btc"], sha,
                    ),
                )
        connection.close()


def verdict_rows(path):
    connection = sqlite3.connect(path)
    rows = connection.execute(
        "SELECT bucket_start, verdict_hash, payload_json FROM paper_futures_verdicts ORDER BY bucket_start"
    ).fetchall()
    connection.close()
    return rows


class EvaluateVerdictTests(unittest.TestCase):
    def test_breakout_yields_a_long_entry_verdict_with_protective_levels(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        verdict = evaluate_verdict(ones, fives, previous_regime="unknown", config=VERDICT_CONFIG)
        self.assertEqual(verdict["action"], "LONG")
        self.assertEqual(verdict["selected"]["reason_code"], "c27_long_breakout")
        self.assertEqual(verdict["selected"]["strategy_id"], "c27-breakout-perp-v1")
        self.assertIsNotNone(verdict["selected"]["proposed_stop"])
        self.assertEqual(verdict["bucket_start_ms"], START + 300 * MINUTE)
        self.assertEqual(verdict["decision_known_at_ms"], known_at)
        self.assertEqual(verdict["knowledge_lag_ms"], 3_000)
        self.assertEqual(verdict["inputs"]["1m"]["count"], VERDICT_CONFIG["window_1m"])
        self.assertEqual(len(verdict["proposals"]), 4)
        # Canonical (no floats) and deterministic.
        canonical_json(verdict)
        again = evaluate_verdict(ones, fives, previous_regime="unknown", config=VERDICT_CONFIG)
        self.assertEqual(again, verdict)

    def test_ignores_candles_closing_after_or_known_after_the_candidate(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        base = evaluate_verdict(ones, fives, previous_regime="unknown", config=VERDICT_CONFIG)
        later_one = official(MINUTE, START + 301 * MINUTE, known_at, close="1", high="2", low="1")
        later_five = official(FIVE, START + 300 * MINUTE, known_at, close="1", high="2", low="1")
        unknown_five = dict(fives[-1], known_at=known_at + 1, close="5", revision_hash="late")
        with_future = evaluate_verdict(
            ones + [later_one], fives + [later_five, unknown_five],
            previous_regime="unknown", config=VERDICT_CONFIG, candidate_bucket=START + 300 * MINUTE,
        )
        self.assertEqual(with_future, base)

    def test_chains_regime_hysteresis_from_the_previous_verdict(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        # Flat 5m bars: EMA9 == EMA21, ratio 0 < 0.2 -> range regardless of the prior.
        verdict = evaluate_verdict(ones, fives, previous_regime="trend", config=VERDICT_CONFIG)
        self.assertEqual(verdict["previous_regime"], "trend")
        self.assertEqual(verdict["regime"], "range")

    def test_warms_up_with_wait_when_history_is_short_or_gapped(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        short = evaluate_verdict(ones[-10:], fives, previous_regime="unknown", config=VERDICT_CONFIG)
        self.assertEqual(short["action"], "WAIT")
        gapped = ones[:-30] + ones[-29:]
        verdict = evaluate_verdict(gapped, fives, previous_regime="unknown", config=VERDICT_CONFIG)
        self.assertEqual(verdict["action"], "WAIT")
        self.assertIn("candle_sequence_gap", verdict["features"]["1m"]["reason_codes"])


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-verdicts-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def live_market(self, name):
        """Backfill, then 1m candles arriving one poll at a time (5m first on boundaries)."""
        market = MarketDb(self.path(name))
        backfill_at = START + 240 * MINUTE + 1_500
        market.insert(flat_series(FIVE, 80, START + 235 * MINUTE, backfill_at))
        market.insert(flat_series(MINUTE, 240, START + 239 * MINUTE, backfill_at + 1))
        return market

    def arrive(self, market, bucket, close="100000", volume="1"):
        known_at = bucket + MINUTE + 3_000
        if (bucket + MINUTE) % FIVE == 0:
            market.insert([official(FIVE, bucket + MINUTE - FIVE, known_at)])
        market.insert([official(MINUTE, bucket, known_at + 5, close=close,
                                high=max(close, "100050"), volume=volume)])


class VerdictServiceTests(ServiceCase):
    def test_incremental_live_processing_equals_a_later_full_replay(self):
        market = self.live_market("market.sqlite")
        live = VerdictStore(self.path("live-verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, live), 240)
        for offset in range(240, 252):
            close = "100100" if offset == 247 else "100000"
            self.arrive(market, START + offset * MINUTE, close=close, volume="2" if offset == 247 else "1")
            self.assertEqual(process_available(market.path, live), 1)
        self.assertEqual(process_available(market.path, live), 0)
        live.close()

        replay = VerdictStore(self.path("replay-verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, replay), 252)
        replay.close()
        again = VerdictStore(self.path("replay-2-verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, again)
        again.close()

        live_rows = verdict_rows(self.path("live-verdicts.sqlite"))
        self.assertEqual(live_rows, verdict_rows(self.path("replay-verdicts.sqlite")))
        self.assertEqual(live_rows, verdict_rows(self.path("replay-2-verdicts.sqlite")))
        actions = {row[0]: __import__("json").loads(row[2])["action"] for row in live_rows}
        self.assertEqual(actions[START + 247 * MINUTE], "LONG")

    def test_resumes_after_restart_and_chains_the_stored_regime(self):
        market = self.live_market("market.sqlite")
        first = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, first)
        last_bucket, regime = first.last_verdict()
        first.close()
        self.arrive(market, START + 240 * MINUTE)
        reopened = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(reopened.last_verdict(), (last_bucket, regime))
        self.assertEqual(process_available(market.path, reopened), 1)
        rows = verdict_rows(self.path("verdicts.sqlite"))
        payload = __import__("json").loads(rows[-1][2])
        self.assertEqual(payload["previous_regime"], regime)
        reopened.close()

    def test_refuses_a_different_config_and_keeps_verdicts_immutable(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, store)
        store.close()
        with self.assertRaises(ValueError):
            VerdictStore(self.path("verdicts.sqlite"), dict(VERDICT_CONFIG, window_1m=100))
        raw = sqlite3.connect(self.path("verdicts.sqlite"))
        for statement in (
            "UPDATE paper_futures_verdicts SET action='LONG'",
            "DELETE FROM paper_futures_verdicts",
        ):
            with self.assertRaises(sqlite3.DatabaseError):
                raw.execute(statement)
        raw.close()

    def test_waits_for_a_market_db_without_official_candles(self):
        path = self.path("old-market.sqlite")
        sqlite3.connect(path).close()
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(path, store), 0)
        store.close()


class VerdictServiceLoopTests(ServiceCase):
    """Idle cost, query plans and resilience of the long-running poll loop."""

    def service(self, market_path, store, logs=None):
        return VerdictService(market_path, store, log=(logs.append if logs is not None else (lambda line: None)))

    def test_idle_poll_runs_one_cheap_statement_over_a_persistent_connection(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        service = self.service(market.path, store)
        self.assertEqual(service.poll(), 240)
        statements = []
        service.market.db.set_trace_callback(statements.append)
        connection = service.market
        for _ in range(3):
            self.assertEqual(service.poll(), 0)
        self.assertIs(service.market, connection)
        self.assertEqual(len(statements), 3)
        self.assertTrue(all("MAX(bucket_start)" in statement for statement in statements))
        self.arrive(market, START + 240 * MINUTE)
        self.assertEqual(service.poll(), 1)
        service.close()
        store.close()

    def test_window_and_pending_queries_use_the_primary_key_range(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        service = self.service(market.path, store)
        service.poll()
        plans = service.market.query_plans(START + 100 * MINUTE, START + 100 * MINUTE + 3_000)
        self.assertGreaterEqual(len(plans), 4)
        for plan in plans:
            for step in plan:
                if "paper_futures_official_candles" in step:
                    self.assertIn("USING INDEX sqlite_autoindex_paper_futures_official_candles_1", step)
                    self.assertIn("bucket_start", step.split("(", 1)[-1], step)
        service.close()
        store.close()

    def test_survives_a_missing_then_created_then_recreated_market_db(self):
        path = self.path("market.sqlite")
        logs = []
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        service = self.service(path, store, logs)
        self.assertEqual(service.poll(), 0)
        self.assertEqual(service.poll(), 0)
        self.assertEqual(len([line for line in logs if "unavailable" in line]), 1)
        market = self.live_market("market.sqlite")
        self.assertEqual(service.poll(), 240)
        os.remove(path)
        self.assertEqual(service.poll(), 0)
        recreated = self.live_market("market.sqlite")
        self.arrive(recreated, START + 240 * MINUTE)
        self.assertEqual(service.poll(), 1)
        service.close()
        store.close()

    def test_survives_a_locked_market_db(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        service = self.service(market.path, store)
        service.poll()
        def locked():
            raise sqlite3.OperationalError("database is locked")

        service.market.latest_bucket = locked
        self.assertEqual(service.poll(), 0)
        self.arrive(market, START + 240 * MINUTE)
        self.assertEqual(service.poll(), 1)
        service.close()
        store.close()


if __name__ == "__main__":
    unittest.main()
