import os
import shutil
import sqlite3
import tempfile
import unittest
from decimal import Decimal

import json

from balancita_engine.canonical import canonical_hash, canonical_json
from balancita_engine.futures_verdicts import (
    VERDICT_CONFIG,
    VerdictService,
    VerdictStore,
    evaluate_verdict,
    process_available,
    product_config,
)

MINUTE = 60_000
FIVE = 300_000
START = 1_791_000_000_000 - (1_791_000_000_000 % FIVE)

BTC = "PF_XBTUSD"
ETH = "PF_ETHUSD"
SOL = "PF_SOLUSD"
BTC_CONFIG = product_config(VERDICT_CONFIG, BTC, "1")
PRODUCTS = [(BTC, "1")]
THREE = [(BTC, "1"), (ETH, "0.1"), (SOL, "0.01")]

# Same DDL as the market store's migration 5 (server/src/features/kraken-futures/futures-market-store.ts).
OFFICIAL_DDL = """
CREATE TABLE paper_futures_official_candle_responses(
  product_id TEXT NOT NULL, sha256 TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
  raw_response TEXT NOT NULL, PRIMARY KEY(product_id, sha256)
) STRICT;
CREATE TABLE paper_futures_official_candles(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
  revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
  volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL,
  PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash),
  FOREIGN KEY(product_id, response_sha256) REFERENCES paper_futures_official_candle_responses(product_id, sha256)
) STRICT;
"""
# The schema-4 shape (no product_id): a market DB the writer has not migrated yet.
OLD_OFFICIAL_DDL = """
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
    def __init__(self, path, ddl=OFFICIAL_DDL):
        self.path = path
        connection = sqlite3.connect(path)
        connection.executescript(ddl)
        connection.close()
        self.responses = 0

    def insert(self, candles, product=BTC):
        connection = sqlite3.connect(self.path)
        with connection:
            for candle in candles:
                self.responses += 1
                sha = "r{}-{}".format(self.responses, candle["known_at"])
                connection.execute(
                    "INSERT OR IGNORE INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?,?)",
                    (product, sha, candle["interval_ms"], 0, 0, candle["known_at"], "{}"),
                )
                connection.execute(
                    "INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        product, candle["interval_ms"], candle["bucket_start"], candle["revision_hash"], candle["known_at"],
                        candle["open"], candle["high"], candle["low"], candle["close"], candle["volume_btc"], sha,
                    ),
                )
        connection.close()


def verdict_rows(path, product=BTC):
    """(bucket_start, verdict_hash, payload_json) of one product; every product when None."""
    connection = sqlite3.connect(path)
    if product is None:
        rows = connection.execute(
            "SELECT product_id, bucket_start, verdict_hash, payload_json FROM paper_futures_verdicts "
            "ORDER BY product_id, bucket_start"
        ).fetchall()
    else:
        rows = connection.execute(
            "SELECT bucket_start, verdict_hash, payload_json FROM paper_futures_verdicts "
            "WHERE product_id=? ORDER BY bucket_start", (product,)
        ).fetchall()
    connection.close()
    return rows


class EvaluateVerdictTests(unittest.TestCase):
    def test_breakout_yields_a_long_entry_verdict_with_protective_levels(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        verdict = evaluate_verdict(ones, fives, previous_regime="unknown", config=BTC_CONFIG)
        self.assertEqual(verdict["action"], "LONG")
        self.assertEqual(verdict["selected"]["reason_code"], "c27_long_breakout")
        self.assertEqual(verdict["selected"]["strategy_id"], "c27-breakout-perp-v1")
        self.assertIsNotNone(verdict["selected"]["proposed_stop"])
        self.assertEqual(verdict["bucket_start_ms"], START + 300 * MINUTE)
        self.assertEqual(verdict["decision_known_at_ms"], known_at)
        self.assertEqual(verdict["knowledge_lag_ms"], 3_000)
        self.assertEqual(verdict["inputs"]["1m"]["count"], VERDICT_CONFIG["window_1m"])
        self.assertEqual(verdict["product_id"], BTC)
        self.assertEqual(len(verdict["proposals"]), 4)
        # Canonical (no floats) and deterministic.
        canonical_json(verdict)
        again = evaluate_verdict(ones, fives, previous_regime="unknown", config=BTC_CONFIG)
        self.assertEqual(again, verdict)

    def test_ignores_candles_closing_after_or_known_after_the_candidate(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        base = evaluate_verdict(ones, fives, previous_regime="unknown", config=BTC_CONFIG)
        later_one = official(MINUTE, START + 301 * MINUTE, known_at, close="1", high="2", low="1")
        later_five = official(FIVE, START + 300 * MINUTE, known_at, close="1", high="2", low="1")
        unknown_five = dict(fives[-1], known_at=known_at + 1, close="5", revision_hash="late")
        with_future = evaluate_verdict(
            ones + [later_one], fives + [later_five, unknown_five],
            previous_regime="unknown", config=BTC_CONFIG, candidate_bucket=START + 300 * MINUTE,
        )
        self.assertEqual(with_future, base)

    def test_chains_regime_hysteresis_from_the_previous_verdict(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        # Flat 5m bars: EMA9 == EMA21, ratio 0 < 0.2 -> range regardless of the prior.
        verdict = evaluate_verdict(ones, fives, previous_regime="trend", config=BTC_CONFIG)
        self.assertEqual(verdict["previous_regime"], "trend")
        self.assertEqual(verdict["regime"], "range")

    def test_warms_up_with_wait_when_history_is_short_or_gapped(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        short = evaluate_verdict(ones[-10:], fives, previous_regime="unknown", config=BTC_CONFIG)
        self.assertEqual(short["action"], "WAIT")
        gapped = ones[:-30] + ones[-29:]
        verdict = evaluate_verdict(gapped, fives, previous_regime="unknown", config=BTC_CONFIG)
        self.assertEqual(verdict["action"], "WAIT")
        self.assertIn("candle_sequence_gap", verdict["features"]["1m"]["reason_codes"])


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-verdicts-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def live_market(self, name, products=(BTC,)):
        """Backfill, then 1m candles arriving one poll at a time (5m first on boundaries)."""
        market = MarketDb(self.path(name))
        backfill_at = START + 240 * MINUTE + 1_500
        for product in products:
            market.insert(flat_series(FIVE, 80, START + 235 * MINUTE, backfill_at), product)
            market.insert(flat_series(MINUTE, 240, START + 239 * MINUTE, backfill_at + 1), product)
        return market

    def arrive(self, market, bucket, close="100000", volume="1", product=BTC):
        known_at = bucket + MINUTE + 3_000
        if (bucket + MINUTE) % FIVE == 0:
            market.insert([official(FIVE, bucket + MINUTE - FIVE, known_at)], product)
        market.insert([official(MINUTE, bucket, known_at + 5, close=close,
                                high=max(close, "100050"), volume=volume)], product)


class VerdictServiceTests(ServiceCase):
    def test_incremental_live_processing_equals_a_later_full_replay(self):
        market = self.live_market("market.sqlite")
        live = VerdictStore(self.path("live-verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, live, PRODUCTS), 240)
        for offset in range(240, 252):
            close = "100100" if offset == 247 else "100000"
            self.arrive(market, START + offset * MINUTE, close=close, volume="2" if offset == 247 else "1")
            self.assertEqual(process_available(market.path, live, PRODUCTS), 1)
        self.assertEqual(process_available(market.path, live, PRODUCTS), 0)
        live.close()

        replay = VerdictStore(self.path("replay-verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, replay, PRODUCTS), 252)
        replay.close()
        again = VerdictStore(self.path("replay-2-verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, again, PRODUCTS)
        again.close()

        live_rows = verdict_rows(self.path("live-verdicts.sqlite"))
        self.assertEqual(live_rows, verdict_rows(self.path("replay-verdicts.sqlite")))
        self.assertEqual(live_rows, verdict_rows(self.path("replay-2-verdicts.sqlite")))
        actions = {row[0]: __import__("json").loads(row[2])["action"] for row in live_rows}
        self.assertEqual(actions[START + 247 * MINUTE], "LONG")

    def test_resumes_after_restart_and_chains_the_stored_regime(self):
        market = self.live_market("market.sqlite")
        first = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, first, PRODUCTS)
        last_bucket, regime = first.last_verdict(BTC)
        first.close()
        self.arrive(market, START + 240 * MINUTE)
        reopened = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(reopened.last_verdict(BTC), (last_bucket, regime))
        self.assertEqual(process_available(market.path, reopened, PRODUCTS), 1)
        rows = verdict_rows(self.path("verdicts.sqlite"))
        payload = __import__("json").loads(rows[-1][2])
        self.assertEqual(payload["previous_regime"], regime)
        reopened.close()

    def test_refuses_a_different_config_and_keeps_verdicts_immutable(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, store, PRODUCTS)
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
        self.assertEqual(process_available(path, store, PRODUCTS), 0)
        store.close()


class MultiProductEvaluationTests(unittest.TestCase):
    def test_tick_size_comes_from_the_product_and_shapes_its_levels(self):
        known_at = START + 301 * MINUTE + 3_000
        ones, fives = breakout_series(known_at)
        coarse = evaluate_verdict(ones, fives, previous_regime="unknown",
                                  config=product_config(VERDICT_CONFIG, "PF_COARSEUSD", "25"))
        fine = evaluate_verdict(ones, fives, previous_regime="unknown",
                                config=product_config(VERDICT_CONFIG, "PF_FINEUSD", "0.01"))
        for verdict, tick in ((coarse, 25), (fine, Decimal("0.01"))):
            stop = Decimal(verdict["selected"]["proposed_stop"])
            self.assertEqual(stop % Decimal(tick), 0)
        self.assertEqual(Decimal(coarse["selected"]["proposed_stop"]) % 25, 0)
        self.assertNotEqual(coarse["selected"]["proposed_stop"], fine["selected"]["proposed_stop"])
        self.assertEqual(coarse["product_id"], "PF_COARSEUSD")
        self.assertEqual(fine["product_id"], "PF_FINEUSD")
        # The product and its tick are part of the verdict identity.
        self.assertNotEqual(coarse["config_hash"], fine["config_hash"])
        self.assertEqual(coarse["config_hash"], canonical_hash(product_config(VERDICT_CONFIG, "PF_COARSEUSD", "25")))
        self.assertNotEqual(coarse["verdict_hash"], fine["verdict_hash"])

    def test_the_base_config_is_versioned_past_the_single_product_one(self):
        self.assertNotEqual(VERDICT_CONFIG["version"], "futures-verdict-config.v1")
        self.assertNotIn("tick_size", VERDICT_CONFIG)


class MultiProductServiceTests(ServiceCase):
    def feed(self, market, offsets, products):
        """The same arrival schedule for each product; BTC breaks out at minute 247, ETH at 248, SOL never."""
        for offset in offsets:
            for product in products:
                hot = offset == {BTC: 247, ETH: 248}.get(product)
                close = "100100" if hot else "100000"
                self.arrive(market, START + offset * MINUTE, close=close,
                            volume="2" if hot else "1", product=product)

    def test_each_product_has_its_own_stream_regime_and_tick_and_live_equals_replay(self):
        market = self.live_market("market.sqlite", products=(BTC, ETH, SOL))
        live = VerdictStore(self.path("live.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, live, THREE), 3 * 240)
        for offset in range(240, 252):
            self.feed(market, [offset], (BTC, ETH, SOL))
            self.assertEqual(process_available(market.path, live, THREE), 3)
        self.assertEqual(process_available(market.path, live, THREE), 0)
        live.close()

        replay = VerdictStore(self.path("replay.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, replay, THREE), 3 * 252)
        replay.close()
        again = VerdictStore(self.path("again.sqlite"), VERDICT_CONFIG)
        process_available(market.path, again, THREE)
        again.close()

        live_rows = verdict_rows(self.path("live.sqlite"), None)
        self.assertEqual(len(live_rows), 3 * 252)
        self.assertEqual(live_rows, verdict_rows(self.path("replay.sqlite"), None))
        self.assertEqual(live_rows, verdict_rows(self.path("again.sqlite"), None))
        by_product = {}
        for product, bucket, _hash, payload in live_rows:
            by_product.setdefault(product, {})[bucket] = json.loads(payload)
        self.assertEqual(sorted(by_product), sorted([BTC, ETH, SOL]))
        for product, tick in THREE:
            self.assertTrue(all(item["product_id"] == product for item in by_product[product].values()))
            self.assertEqual(len(by_product[product]), 252)
        # The breakout lands on the product that had it, on its own bucket.
        self.assertEqual(by_product[BTC][START + 247 * MINUTE]["action"], "LONG")
        self.assertEqual(by_product[ETH][START + 248 * MINUTE]["action"], "LONG")
        self.assertNotEqual(by_product[ETH][START + 247 * MINUTE]["action"], "LONG")
        self.assertNotIn("LONG", [item["action"] for item in by_product[SOL].values()])

    def test_the_service_uses_each_products_own_pinned_tick_size(self):
        market = self.live_market("market.sqlite", products=(BTC, ETH))
        for product in (BTC, ETH):
            self.arrive(market, START + 240 * MINUTE, product=product)
            for offset in range(241, 247):
                self.arrive(market, START + offset * MINUTE, product=product)
            self.arrive(market, START + 247 * MINUTE, close="100100", volume="2", product=product)
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, store, [(BTC, "1"), (ETH, "25")])
        store.close()
        payloads = {
            product: json.loads(dict((row[0], row[2]) for row in verdict_rows(
                self.path("verdicts.sqlite"), product))[START + 247 * MINUTE])
            for product in (BTC, ETH)
        }
        for product, tick in ((BTC, "1"), (ETH, "25")):
            self.assertEqual(payloads[product]["action"], "LONG")
            self.assertEqual(payloads[product]["config_hash"],
                             canonical_hash(product_config(VERDICT_CONFIG, product, tick)))
        self.assertEqual(Decimal(payloads[ETH]["selected"]["proposed_stop"]) % 25, 0)
        self.assertNotEqual(payloads[BTC]["selected"]["proposed_stop"], payloads[ETH]["selected"]["proposed_stop"])

    def test_other_products_never_change_a_products_verdicts(self):
        solo = self.live_market("solo.sqlite", products=(BTC,))
        both = self.live_market("both.sqlite", products=(BTC, ETH))
        self.feed(solo, range(240, 250), (BTC,))
        # ETH candles at different prices share the same buckets and intervals.
        self.feed(both, range(240, 250), (BTC, ETH))
        a = VerdictStore(self.path("a.sqlite"), VERDICT_CONFIG)
        b = VerdictStore(self.path("b.sqlite"), VERDICT_CONFIG)
        process_available(solo.path, a, [(BTC, "1")])
        process_available(both.path, b, [(BTC, "1"), (ETH, "0.1")])
        a.close()
        b.close()
        self.assertEqual(verdict_rows(self.path("a.sqlite"), BTC), verdict_rows(self.path("b.sqlite"), BTC))
        self.assertGreater(len(verdict_rows(self.path("b.sqlite"), ETH)), 0)

    def test_a_product_without_candles_does_not_block_the_others(self):
        market = self.live_market("market.sqlite", products=(BTC, SOL))
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(market.path, store, THREE), 2 * 240)
        self.assertIsNone(store.last_verdict(ETH))
        # ETH starts later: only then does it get verdicts.
        market.insert(flat_series(FIVE, 80, START + 235 * MINUTE, START + 241 * MINUTE), ETH)
        market.insert(flat_series(MINUTE, 240, START + 239 * MINUTE, START + 241 * MINUTE + 1), ETH)
        self.assertEqual(process_available(market.path, store, THREE), 240)
        store.close()

    def test_resumes_each_product_after_a_restart_with_its_own_regime_chain(self):
        market = self.live_market("market.sqlite", products=(BTC, ETH))
        first = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, first, THREE[:2])
        last = {product: first.last_verdict(product) for product in (BTC, ETH)}
        first.close()
        self.arrive(market, START + 240 * MINUTE, product=ETH)
        reopened = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual({product: reopened.last_verdict(product) for product in (BTC, ETH)}, last)
        self.assertEqual(process_available(market.path, reopened, THREE[:2]), 1)
        rows = verdict_rows(self.path("verdicts.sqlite"), ETH)
        self.assertEqual(json.loads(rows[-1][2])["previous_regime"], last[ETH][1])
        reopened.close()

    def test_a_pinned_tick_size_cannot_change_in_an_existing_verdicts_db(self):
        market = self.live_market("market.sqlite")
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, store, [(BTC, "1"), (ETH, "0.1")])
        store.close()
        reopened = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, reopened, [(BTC, "1"), (ETH, "0.1")])  # same ticks: fine
        with self.assertRaises(ValueError):
            process_available(market.path, reopened, [(BTC, "1"), (ETH, "0.01")])
        reopened.close()

    def test_refuses_a_single_product_verdicts_db_from_before_the_split_by_product(self):
        path = self.path("old-verdicts.sqlite")
        old_config = {
            "version": "futures-verdict-config.v1", "strategy_config": "x", "feature_schema": "y",
            "window_1m": 200, "window_5m": 200, "tick_size": "1",
            "maker_rate": "0.0002", "taker_rate": "0.0005",
        }
        connection = sqlite3.connect(path)
        connection.executescript(
            """
            CREATE TABLE paper_futures_verdict_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE paper_futures_verdicts(
              bucket_start INTEGER PRIMARY KEY, interval_ms INTEGER NOT NULL,
              decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
              action TEXT NOT NULL, reason_code TEXT NOT NULL,
              verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
              written_at INTEGER NOT NULL
            ) STRICT;
            """
        )
        connection.execute("INSERT INTO paper_futures_verdict_meta VALUES('config_hash', ?)",
                           (canonical_hash(old_config),))
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ValueError, "different config"):
            VerdictStore(path, VERDICT_CONFIG)
        # The refusal changed nothing in the old file.
        check = sqlite3.connect(path)
        names = [row[0] for row in check.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        check.close()
        self.assertEqual(names, ["paper_futures_verdict_meta", "paper_futures_verdicts"])

    def test_waits_for_a_market_db_that_still_has_the_single_product_candle_tables(self):
        old = MarketDb(self.path("old-market.sqlite"), ddl=OLD_OFFICIAL_DDL)
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.assertEqual(process_available(old.path, store, PRODUCTS), 0)
        service = VerdictService(old.path, store, PRODUCTS, log=lambda line: None)
        self.assertEqual(service.poll(), 0)
        service.close()
        store.close()

    def test_verdicts_are_keyed_by_product_and_stay_immutable(self):
        market = self.live_market("market.sqlite", products=(BTC, ETH))
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        process_available(market.path, store, THREE[:2])
        store.close()
        raw = sqlite3.connect(self.path("verdicts.sqlite"))
        keys = [row[1] for row in raw.execute("PRAGMA table_info(paper_futures_verdicts)") if row[5]]
        self.assertEqual(keys, ["product_id", "bucket_start"])
        for statement in ("UPDATE paper_futures_verdicts SET action='LONG'",
                          "DELETE FROM paper_futures_verdicts",
                          "UPDATE paper_futures_verdict_products SET tick_size='9'",
                          "DELETE FROM paper_futures_verdict_products"):
            with self.assertRaises(sqlite3.DatabaseError):
                raw.execute(statement)
        raw.close()

    def test_the_service_loops_over_every_product_with_one_cheap_probe_each_when_idle(self):
        market = self.live_market("market.sqlite", products=(BTC, ETH, SOL))
        store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        service = VerdictService(market.path, store, THREE, log=lambda line: None)
        self.assertEqual(service.poll(), 3 * 240)
        statements = []
        service.market.db.set_trace_callback(statements.append)
        for _ in range(2):
            self.assertEqual(service.poll(), 0)
        self.assertEqual(len(statements), 2 * 3)
        self.assertTrue(all("MAX(bucket_start)" in statement for statement in statements))
        service.close()
        store.close()


class VerdictServiceLoopTests(ServiceCase):
    """Idle cost, query plans and resilience of the long-running poll loop."""

    def service(self, market_path, store, logs=None):
        return VerdictService(market_path, store, PRODUCTS,
                              log=(logs.append if logs is not None else (lambda line: None)))

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
        plans = service.market.query_plans(BTC, START + 100 * MINUTE, START + 100 * MINUTE + 3_000)
        self.assertGreaterEqual(len(plans), 4)
        for plan in plans:
            for step in plan:
                if "paper_futures_official_candles" in step:
                    self.assertIn("USING INDEX sqlite_autoindex_paper_futures_official_candles_1", step)
                    self.assertIn("product_id=?", step.split("(", 1)[-1], step)
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
        def locked(product_id):
            raise sqlite3.OperationalError("database is locked")

        service.market.latest_bucket = locked
        self.assertEqual(service.poll(), 0)
        self.arrive(market, START + 240 * MINUTE)
        self.assertEqual(service.poll(), 1)
        service.close()
        store.close()


if __name__ == "__main__":
    unittest.main()
