import contextlib
import io
import os
import shutil
import sqlite3
import tempfile
import unittest
from decimal import Decimal

from balancita_engine.canonical import canonical_hash
from balancita_engine.futures_forecast_scores import (
    SCORE_CONFIG,
    ForecastScoreService,
    ScoreStore,
    forecast_score_report,
    main,
    process_available,
    summarize_net,
)
from balancita_engine.futures_verdicts import VERDICT_CONFIG, VerdictStore
from test_futures_verdicts import BTC, ETH, OLD_OFFICIAL_DDL, SOL, MarketDb, official

MINUTE = 60_000
HOUR = 3_600_000
# 2026-09-25 00:00:00 UTC, a whole UTC day boundary: bucket 0 is hour 0.
ENTRY = 1_790_208_000_000
ENTRY_PRICE = 100000
DAY = 1440

C25 = "c25-mean-reversion-perp-v1"
C27 = "c27-breakout-perp-v1"


def proposal(strategy_id, action, stop=None, target=None):
    return {
        "strategy_id": strategy_id, "action": action, "reason_code": "test",
        "proposed_stop": stop, "proposed_target": target,
        "signal_key": "{}:{}:{}".format(strategy_id, action, ENTRY),
    }


def verdict(bucket, proposals, selected=None, regime="range", lag=3_000, product=BTC):
    selected = selected if selected is not None else {"action": "WAIT", "reason_code": "none"}
    return {
        "schema_version": "futures-verdict.v1", "product_id": product, "interval_ms": MINUTE,
        "bucket_start_ms": bucket,
        "close_at_ms": bucket + MINUTE, "decision_known_at_ms": bucket + MINUTE + lag,
        "knowledge_lag_ms": lag, "regime": regime, "action": selected["action"],
        "reason_code": selected["reason_code"], "selected": selected, "proposals": proposals,
        "verdict_hash": "vh-{}".format(bucket),
    }


def candle(bucket, close="100000", high=None, low=None):
    high = high if high is not None else str(max(Decimal(close), Decimal(ENTRY_PRICE)))
    low = low if low is not None else str(min(Decimal(close), Decimal(ENTRY_PRICE)))
    return official(MINUTE, bucket, bucket + MINUTE + 3_000, close=close, high=high, low=low,
                    open_=close)


def series(count, entry=ENTRY, overrides=None):
    """Minutes 0..count-1 after (and including) the entry bucket; flat at 100000
    unless `overrides` {minute: dict(close, high, low)} says otherwise."""
    overrides = overrides or {}
    result = []
    for minute in range(count):
        spec = overrides.get(minute, {})
        flat = {"close": "100000", "high": "100000", "low": "100000"}
        flat.update(spec)
        result.append(candle(entry + minute * MINUTE, **flat))
    return result


def rows(path, sql):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


TABLE_DUMPS = {
    "verdicts": ("SELECT product_id, bucket_start, verdict_hash, forecasts "
                 "FROM paper_futures_forecast_verdicts ORDER BY 1, 2"),
    "forecasts": (
        "SELECT product_id, bucket_start, source, strategy_id, side, regime, utc_hour, knowledge_lag_ms, "
        "backfill, entry_price, proposed_stop, proposed_target, signal_key, verdict_hash "
        "FROM paper_futures_forecasts ORDER BY 1, 2, 3, 4"
    ),
    "returns": (
        "SELECT product_id, bucket_start, source, strategy_id, horizon_min, gross_bp, net_bp, exit_bucket_start "
        "FROM paper_futures_forecast_returns ORDER BY 1, 2, 3, 4, 5"
    ),
    "barriers": (
        "SELECT product_id, bucket_start, source, strategy_id, outcome, ambiguous, hit_after_ms "
        "FROM paper_futures_forecast_barriers ORDER BY 1, 2, 3, 4"
    ),
    "excursions": (
        "SELECT product_id, bucket_start, source, strategy_id, window_min, mfe_bp, mae_bp "
        "FROM paper_futures_forecast_excursions ORDER BY 1, 2, 3, 4"
    ),
}


def dump(path):
    return {name: rows(path, sql) for name, sql in TABLE_DUMPS.items()}


class Rig(unittest.TestCase):
    PRODUCTS = [BTC]

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-scores-")
        self.market = MarketDb(self.path("market.sqlite"))
        self.verdicts = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)
        self.store = ScoreStore(self.path("scores.sqlite"), SCORE_CONFIG)
        self.logs = []
        self.service = ForecastScoreService(
            self.market.path, self.path("verdicts.sqlite"), self.store, log=self.logs.append,
            products=self.PRODUCTS,
        )

    def tearDown(self):
        self.service.close()
        self.store.close()
        self.verdicts.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def scores(self):
        return self.path("scores.sqlite")

    def returns(self, product=BTC):
        return {
            (row[0], row[1], row[2]): (row[3], row[4])
            for row in rows(
                self.scores(),
                "SELECT source, strategy_id, horizon_min, gross_bp, net_bp "
                "FROM paper_futures_forecast_returns WHERE product_id='{}'".format(product),
            )
        }

    def barriers(self, product=BTC):
        return {
            (row[0], row[1]): row[2:]
            for row in rows(
                self.scores(),
                "SELECT source, strategy_id, outcome, ambiguous, hit_after_ms "
                "FROM paper_futures_forecast_barriers WHERE product_id='{}'".format(product),
            )
        }

    def scored(self, proposals, count, overrides=None, selected=None, **verdict_kwargs):
        self.market.insert(series(count, overrides=overrides))
        self.verdicts.append(verdict(ENTRY, proposals, selected=selected, **verdict_kwargs))
        self.service.poll()


class HorizonReturnTests(Rig):
    def test_signed_gross_and_net_returns_at_each_horizon(self):
        overrides = {
            15: {"close": "100100", "high": "100100"},
            60: {"close": "99900", "low": "99900"},
            240: {"close": "100500", "high": "100500"},
            1440: {"close": "99000", "low": "99000"},
        }
        self.scored(
            [proposal(C27, "LONG", stop="1", target="900000"),
             proposal(C25, "SHORT", stop="900000", target="1")],
            DAY + 1, overrides,
        )
        returns = self.returns()
        # Round trip: 2 x 5 bp taker + 2 bp slippage proxy = 12 bp.
        self.assertEqual(returns[("proposal", C27, 15)], ("10", "-2"))
        self.assertEqual(returns[("proposal", C27, 60)], ("-10", "-22"))
        self.assertEqual(returns[("proposal", C27, 240)], ("50", "38"))
        self.assertEqual(returns[("proposal", C27, 1440)], ("-100", "-112"))
        self.assertEqual(returns[("proposal", C25, 15)], ("-10", "-22"))
        self.assertEqual(returns[("proposal", C25, 60)], ("10", "-2"))
        self.assertEqual(returns[("proposal", C25, 240)], ("-50", "-62"))
        self.assertEqual(returns[("proposal", C25, 1440)], ("100", "88"))
        entry = rows(self.scores(), "SELECT entry_price, side FROM paper_futures_forecasts "
                                    "WHERE strategy_id='{}'".format(C25))
        self.assertEqual(entry, [("100000", "SHORT")])

    def test_wait_and_abstain_proposals_are_not_scored_and_selected_is_scored_separately(self):
        selected = proposal(C27, "LONG", stop="1", target="900000")
        self.scored(
            [proposal(C25, "WAIT"), proposal("c26-x", "ABSTAIN"), selected],
            20, {15: {"close": "100100", "high": "100100"}}, selected=selected,
        )
        sources = rows(self.scores(), "SELECT source, strategy_id, side FROM paper_futures_forecasts ORDER BY 1")
        self.assertEqual(sources, [("proposal", C27, "LONG"), ("selected", C27, "LONG")])
        returns = self.returns()
        self.assertEqual(returns[("selected", C27, 15)], ("10", "-2"))
        self.assertEqual(returns[("proposal", C27, 15)], ("10", "-2"))

    def test_metadata_regime_hour_lag_and_backfill_flag(self):
        # Entry bucket 00:00 closes at 00:01 UTC; use a later hour for the second verdict.
        later = ENTRY + 5 * HOUR + 59 * MINUTE  # closes 06:00 UTC
        self.market.insert(series(3) + series(3, entry=later))
        self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", "1", "900000")], regime="trend", lag=15_000))
        self.verdicts.append(verdict(later, [proposal(C27, "SHORT", "900000", "1")], regime="range", lag=15_001))
        self.service.poll()
        self.assertEqual(
            rows(self.scores(), "SELECT bucket_start, regime, utc_hour, knowledge_lag_ms, backfill "
                                "FROM paper_futures_forecasts ORDER BY 1"),
            [(ENTRY, "trend", 0, 15_000, 0), (later, "range", 6, 15_001, 1)],
        )


class BarrierRaceTests(Rig):
    def outcome(self, proposals, overrides, count=40):
        self.scored(proposals, count, overrides)
        return self.barriers()

    def test_target_first_then_stop(self):
        result = self.outcome(
            [proposal(C27, "LONG", stop="99900", target="100200")],
            {5: {"high": "100250"}, 9: {"low": "99800"}},
        )
        self.assertEqual(result[("proposal", C27)], ("target", 0, 5 * MINUTE))

    def test_stop_first_then_target(self):
        result = self.outcome(
            [proposal(C27, "LONG", stop="99900", target="100200")],
            {3: {"low": "99890"}, 4: {"high": "100300"}},
        )
        self.assertEqual(result[("proposal", C27)], ("stop", 0, 3 * MINUTE))

    def test_both_touched_in_the_same_minute_counts_the_stop_first(self):
        result = self.outcome(
            [proposal(C27, "LONG", stop="99900", target="100200"),
             proposal(C25, "SHORT", stop="100100", target="99800")],
            {6: {"high": "100250", "low": "99790"}},
        )
        self.assertEqual(result[("proposal", C27)], ("stop", 1, 6 * MINUTE))
        self.assertEqual(result[("proposal", C25)], ("stop", 1, 6 * MINUTE))

    def test_short_side_levels_are_mirrored(self):
        result = self.outcome(
            [proposal(C25, "SHORT", stop="100100", target="99800")],
            {2: {"low": "99790"}, 4: {"high": "100100"}},
        )
        self.assertEqual(result[("proposal", C25)], ("target", 0, 2 * MINUTE))

    def test_neither_is_recorded_only_after_the_whole_24h_exist(self):
        proposals = [proposal(C27, "LONG", stop="99000", target="101000")]
        self.market.insert(series(DAY))  # minutes 0..1439
        self.verdicts.append(verdict(ENTRY, proposals))
        self.service.poll()
        self.assertEqual(self.barriers(), {})
        self.market.insert([candle(ENTRY + DAY * MINUTE)])
        self.service.poll()
        self.assertEqual(self.barriers(), {("proposal", C27): ("neither", 0, None)})

    def test_levels_missing_are_recorded_as_no_levels(self):
        result = self.outcome([proposal(C27, "LONG", stop=None, target="100200")], {}, count=3)
        self.assertEqual(result[("proposal", C27)], ("no_levels", 0, None))

    def test_up_to_30m_excursions_are_signed_by_side_and_floored_at_zero(self):
        overrides = {10: {"high": "100300", "low": "99900"}, 20: {"low": "99800"}}
        self.scored(
            [proposal(C27, "LONG", "1", "900000"), proposal(C25, "SHORT", "900000", "1")],
            31, overrides,
        )
        found = {
            row[0]: row[1:]
            for row in rows(self.scores(), "SELECT strategy_id, window_min, mfe_bp, mae_bp "
                                           "FROM paper_futures_forecast_excursions")
        }
        self.assertEqual(found[C27], (30, "30", "20"))
        self.assertEqual(found[C25], (30, "20", "30"))


class NoLookaheadTests(Rig):
    def test_nothing_is_scored_before_its_candles_exist_and_each_score_waits_for_its_own(self):
        proposals = [proposal(C27, "LONG", stop="1", target="900000")]
        self.verdicts.append(verdict(ENTRY, proposals))
        self.market.insert(series(15))  # minutes 0..14: horizon 15 needs minute 15
        self.service.poll()
        self.assertEqual(self.returns(), {})
        self.assertEqual(len(rows(self.scores(), "SELECT 1 FROM paper_futures_forecasts")), 1)
        self.market.insert(series(16, overrides={15: {"close": "100100", "high": "100100"}})[15:])
        self.service.poll()
        self.assertEqual(sorted(self.returns()), [("proposal", C27, 15)])
        self.assertEqual(self.barriers(), {})
        self.assertEqual(rows(self.scores(), "SELECT 1 FROM paper_futures_forecast_excursions"), [])
        self.market.insert(series(31)[16:])
        self.service.poll()
        self.assertEqual(len(rows(self.scores(), "SELECT 1 FROM paper_futures_forecast_excursions")), 1)
        self.assertEqual(sorted(self.returns()), [("proposal", C27, 15)])

    def test_candles_beyond_each_horizon_are_never_used(self):
        overrides = {
            15: {"close": "100100", "high": "100100"},
            # Beyond the 15m horizon only the close is touched: the 15m score must ignore it.
            16: {"close": "120000"},
            # Beyond the 30m excursion window.
            31: {"high": "130000", "low": "90000"},
            # Beyond the 24h barrier and return horizon.
            DAY + 1: {"close": "120000", "high": "130000", "low": "90000"},
        }
        self.scored([proposal(C27, "LONG", stop="1", target="900000")], DAY + 2, overrides)
        returns = self.returns()
        self.assertEqual(returns[("proposal", C27, 15)], ("10", "-2"))
        self.assertEqual(returns[("proposal", C27, 1440)], ("0", "-12"))
        excursion = rows(self.scores(), "SELECT mfe_bp, mae_bp FROM paper_futures_forecast_excursions")
        self.assertEqual(excursion, [("10", "0")])
        self.assertEqual(self.barriers()[("proposal", C27)], ("neither", 0, None))


    def test_a_touch_after_the_24h_barrier_horizon_is_not_a_hit(self):
        self.scored([proposal(C27, "LONG", stop="99000", target="101000")], DAY + 2,
                    {DAY + 1: {"high": "130000", "low": "90000"}})
        self.assertEqual(self.barriers()[("proposal", C27)], ("neither", 0, None))


class AggregateTests(Rig):
    def test_summarize_net_statistics(self):
        stats = summarize_net([Decimal(x) for x in ("10", "-4", "6", "-2")])
        self.assertEqual(stats["n"], 4)
        self.assertEqual(stats["hit_rate"], "0.5")
        self.assertEqual(stats["mean_net_bp"], "2.5")
        self.assertEqual(stats["median_net_bp"], "2")
        self.assertEqual(stats["profit_factor"], "2.6667")
        # sd = sqrt((7.5^2 + 6.5^2 + 3.5^2 + 4.5^2) / 3) = 6.6081; half = 1.96 * sd / 2 = 6.4759
        self.assertEqual(stats["ci95_low"], "-3.9759")
        self.assertEqual(stats["ci95_high"], "8.9759")
        single = summarize_net([Decimal("5")])
        self.assertEqual((single["n"], single["ci95_low"], single["profit_factor"]), (1, None, None))
        empty = summarize_net([])
        self.assertEqual((empty["n"], empty["hit_rate"], empty["mean_net_bp"]), (0, None, None))

    def test_baseline_buy_and_hold_and_always_opposite_control(self):
        # Two forecasts over the same series: a LONG and a SHORT, price +10bp at 15m.
        self.scored(
            [proposal(C27, "LONG", stop="1", target="900000"),
             proposal(C25, "SHORT", stop="900000", target="1")],
            16, {15: {"close": "100100", "high": "100100"}},
        )
        report = forecast_score_report(self.scores())
        by = {(row["strategy"], row["horizon_min"]): row for row in report}
        long_row = by[(C27, 15)]
        short_row = by[(C25, 15)]
        self.assertEqual(long_row["side"], "LONG")
        self.assertEqual(long_row["model"]["mean_net_bp"], "-2")
        # Buy & hold over the same window: +10 gross, -12 cost.
        self.assertEqual(long_row["baseline"]["mean_net_bp"], "-2")
        self.assertEqual(long_row["inverse"]["mean_net_bp"], "-22")
        self.assertEqual(short_row["model"]["mean_net_bp"], "-22")
        # Buy & hold ignores the side: still +10 gross for a SHORT forecast.
        self.assertEqual(short_row["baseline"]["mean_net_bp"], "-2")
        self.assertEqual(short_row["inverse"]["mean_net_bp"], "-2")
        self.assertEqual(long_row["model"]["n"], 1)
        self.assertEqual(long_row["model"]["hit_rate"], "0")

    def test_grouping_by_regime_hour_bucket_and_barrier_win_rate_with_inverse(self):
        # One continuous series from ENTRY covering both entries and their 24 h: the
        # target is touched 3 minutes after the first entry, the stop 4 minutes after the second.
        second_minute = 5 * 60 + 59
        overrides = {3: {"high": "100250"}, second_minute + 4: {"low": "99890"}}
        self.market.insert(series(second_minute + DAY + 1, overrides=overrides))
        later = ENTRY + second_minute * MINUTE
        levels = dict(stop="99900", target="100200")
        self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", **levels)], regime="trend"))
        self.verdicts.append(verdict(later, [proposal(C27, "LONG", **levels)], regime="range"))
        # A backfilled verdict (lag far above the 15 s freshness threshold).
        self.verdicts.append(verdict(ENTRY + 10 * MINUTE, [proposal(C27, "LONG", **levels)],
                                     regime="unknown", lag=90_000))
        self.service.poll()
        report = forecast_score_report(self.scores(), hour_bucket=6)
        groups = {(row["regime"], row["hours"], row["horizon_min"]): row for row in report}
        trend = groups[("trend", "00-05", 15)]
        rng = groups[("range", "06-11", 15)]
        self.assertEqual(trend["barrier"]["target"], 1)
        self.assertEqual(trend["barrier"]["win_rate"], "1")
        self.assertEqual(trend["barrier"]["inverse_win_rate"], "0")
        self.assertEqual(rng["barrier"]["stop"], 1)
        self.assertEqual(rng["barrier"]["win_rate"], "0")
        self.assertEqual(rng["barrier"]["inverse_win_rate"], "1")
        merged = {(row["regime"], row["hours"]) for row in forecast_score_report(self.scores())}
        self.assertEqual(merged, {("trend", "all"), ("range", "all"), ("unknown", "all")})
        live_only = {row["regime"] for row in forecast_score_report(self.scores(), live_only=True)}
        self.assertEqual(live_only, {"trend", "range"})

    def test_report_cli_prints_a_compact_table(self):
        self.scored([proposal(C27, "LONG", stop="1", target="900000")], 16,
                    {15: {"close": "100100", "high": "100100"}})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--scores-db", self.scores(), "--report"]), 0)
        text = out.getvalue()
        self.assertIn(C27, text)
        self.assertIn("LONG", text)
        self.assertIn("15m", text)
        self.assertIn("-2", text)


class ReplayTests(unittest.TestCase):
    PRODUCTS = [BTC, ETH, SOL]

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-scores-replay-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def walk(self, count, seed=12345):
        state = seed
        price = 100000
        out = []
        for minute in range(count):
            state = (state * 1103515245 + 12345) % 2**31
            step = (state >> 8) % 61 - 30
            state = (state * 1103515245 + 12345) % 2**31
            wick = (state >> 8) % 25
            previous = price
            price = max(1000, price + step)
            high = max(previous, price) + wick
            low = min(previous, price) - wick
            out.append({"close": str(price), "high": str(high), "low": str(low)})
        return out

    def test_live_incremental_run_equals_a_full_replay_for_every_product(self):
        count = DAY + 80
        walks = {product: self.walk(count, seed=12345 + 777 * index)
                 for index, product in enumerate(self.PRODUCTS)}
        # Entry price of verdict k is walk[k].close; levels are sized around it.
        verdicts = {}
        for offset, product in enumerate(self.PRODUCTS):
            for index, minute in enumerate(range(offset, 60, 3)):
                close = int(walks[product][minute]["close"])
                long = (index + offset) % 2 == 0
                proposals = [
                    proposal(C27, "LONG" if long else "SHORT",
                             stop=str(close - 150 if long else close + 150),
                             target=str(close + 250 if long else close - 250)),
                    proposal(C25, "WAIT"),
                ]
                selected = proposals[0] if index % 4 != 3 else None
                verdicts[(product, minute)] = verdict(
                    ENTRY + minute * MINUTE, proposals, selected=selected,
                    regime=("trend", "range", "unknown")[(index + offset) % 3],
                    lag=3_000 if index % 5 else 90_000, product=product)
        market = MarketDb(self.path("market.sqlite"))
        verdict_store = VerdictStore(self.path("verdicts.sqlite"), VERDICT_CONFIG)

        def new_service():
            store = ScoreStore(self.path("live.sqlite"), SCORE_CONFIG)
            return store, ForecastScoreService(market.path, self.path("verdicts.sqlite"), store,
                                               log=lambda line: None, products=self.PRODUCTS)

        store, service = new_service()
        for minute in range(count):
            if minute and minute % 397 == 0:  # restart the service, as a crash would
                service.close()
                store.close()
                store, service = new_service()
            for product in self.PRODUCTS:
                market.insert([candle(ENTRY + minute * MINUTE, **walks[product][minute])], product)
                if (product, minute) in verdicts:
                    verdict_store.append(verdicts[(product, minute)])
            service.poll()
        service.close()
        store.close()
        verdict_store.close()

        replay = ScoreStore(self.path("replay.sqlite"), SCORE_CONFIG)
        process_available(market.path, self.path("verdicts.sqlite"), replay, products=self.PRODUCTS)
        replay.close()
        again = ScoreStore(self.path("replay-2.sqlite"), SCORE_CONFIG)
        process_available(market.path, self.path("verdicts.sqlite"), again, products=self.PRODUCTS)
        again.close()

        live_dump = dump(self.path("live.sqlite"))
        self.assertEqual(live_dump, dump(self.path("replay.sqlite")))
        self.assertEqual(live_dump, dump(self.path("replay-2.sqlite")))
        self.assertEqual(len(live_dump["verdicts"]), len(verdicts))
        self.assertEqual({row[0] for row in live_dump["returns"]}, set(self.PRODUCTS))
        self.assertGreater(len(live_dump["returns"]), 3 * 80)
        self.assertEqual(len(live_dump["excursions"]), len(live_dump["forecasts"]))
        self.assertEqual(len(live_dump["barriers"]), len(live_dump["forecasts"]))
        self.assertGreaterEqual(len({row[4] for row in live_dump["barriers"]}), 2)
        self.assertEqual(
            forecast_score_report(self.path("live.sqlite")),
            forecast_score_report(self.path("replay.sqlite")),
        )


class MultiProductTests(Rig):
    PRODUCTS = [BTC, ETH, SOL]

    def two_products(self):
        """BTC rises 10 bp at 15 m, ETH falls 30 bp at 15 m; both LONG from the same bucket."""
        self.market.insert(series(16, overrides={15: {"close": "100100", "high": "100100"}}), BTC)
        self.market.insert(series(16, overrides={15: {"close": "99700", "low": "99700"}}), ETH)
        for product in (BTC, ETH):
            self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", stop="1", target="900000")],
                                         product=product))
        self.service.poll()

    def test_each_product_is_scored_against_its_own_candles(self):
        self.two_products()
        self.assertEqual(self.returns(BTC)[("proposal", C27, 15)], ("10", "-2"))
        self.assertEqual(self.returns(ETH)[("proposal", C27, 15)], ("-30", "-42"))
        self.assertEqual(self.returns(SOL), {})
        keys = [row[1] for row in rows(self.scores(), "PRAGMA table_info(paper_futures_forecasts)") if row[5]]
        self.assertEqual(keys, ["product_id", "bucket_start", "source", "strategy_id"])

    def test_another_products_data_never_changes_a_products_scores(self):
        self.two_products()
        solo_market = MarketDb(self.path("solo-market.sqlite"))
        solo_market.insert(series(16, overrides={15: {"close": "100100", "high": "100100"}}), BTC)
        solo_verdicts = VerdictStore(self.path("solo-verdicts.sqlite"), VERDICT_CONFIG)
        solo_verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", stop="1", target="900000")]))
        solo_verdicts.close()
        solo = ScoreStore(self.path("solo-scores.sqlite"), SCORE_CONFIG)
        process_available(solo_market.path, self.path("solo-verdicts.sqlite"), solo, products=[BTC])
        solo.close()
        btc_only = {name: [row for row in table if row[0] == BTC]
                    for name, table in dump(self.scores()).items()}
        self.assertEqual(btc_only, dump(self.path("solo-scores.sqlite")))

    def test_a_missing_entry_candle_of_one_product_does_not_block_the_others(self):
        self.market.insert(series(16, overrides={15: {"close": "100100", "high": "100100"}}), BTC)
        self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", stop="1", target="900000")], product=ETH))
        self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", stop="1", target="900000")], product=BTC))
        # ETH has a candle (so its probe passes) but not the verdict's entry bucket.
        self.market.insert([candle(ENTRY + 1000 * MINUTE)], ETH)
        self.service.poll()
        self.assertIn(("proposal", C27, 15), self.returns(BTC))
        self.assertEqual(self.returns(ETH), {})
        self.assertTrue(any("PF_ETHUSD" in line and "missing" in line for line in self.logs), self.logs)
        # Once the entry candle lands, ETH catches up.
        self.market.insert(series(16, overrides={15: {"close": "99700", "low": "99700"}}), ETH)
        self.service.poll()
        self.assertEqual(self.returns(ETH)[("proposal", C27, 15)], ("-30", "-42"))

    def test_report_groups_by_product_first_and_can_filter_one(self):
        self.two_products()
        report = forecast_score_report(self.scores())
        self.assertEqual([row["product"] for row in report], [ETH, BTC] if ETH < BTC else [BTC, ETH])
        self.assertEqual([row["product"] for row in report], sorted(row["product"] for row in report))
        by = {row["product"]: row for row in report}
        self.assertEqual(by[BTC]["model"]["mean_net_bp"], "-2")
        self.assertEqual(by[ETH]["model"]["mean_net_bp"], "-42")
        # Buy & hold and the inverse control are per product too.
        self.assertEqual(by[ETH]["baseline"]["mean_net_bp"], "-42")
        self.assertEqual(by[ETH]["inverse"]["mean_net_bp"], "18")
        only = forecast_score_report(self.scores(), product=ETH)
        self.assertEqual([row["product"] for row in only], [ETH])
        self.assertEqual(forecast_score_report(self.scores(), product=SOL), [])

    def test_report_cli_prints_the_product_column_and_filters(self):
        self.two_products()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--scores-db", self.scores(), "--report"]), 0)
        text = out.getvalue()
        self.assertIn("product", text.splitlines()[0])
        self.assertIn(BTC, text)
        self.assertIn(ETH, text)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--scores-db", self.scores(), "--report", "--product", ETH]), 0)
        self.assertIn(ETH, out.getvalue())
        self.assertNotIn(BTC, out.getvalue())

    def test_a_market_db_still_in_the_single_product_shape_scores_nothing_yet(self):
        old = MarketDb(self.path("old-market.sqlite"), ddl=OLD_OFFICIAL_DDL)
        self.verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", stop="1", target="900000")]))
        service = ForecastScoreService(old.path, self.path("verdicts.sqlite"), self.store,
                                       log=lambda line: None, products=[BTC])
        self.assertEqual(service.poll(), 0)
        service.close()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-scores-store-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_refuses_a_different_config_and_keeps_every_table_append_only(self):
        path = os.path.join(self.dir, "scores.sqlite")
        ScoreStore(path, SCORE_CONFIG).close()
        with self.assertRaises(ValueError):
            ScoreStore(path, dict(SCORE_CONFIG, horizons_min=[15, 60]))
        ScoreStore(path, SCORE_CONFIG).close()  # same config reopens
        raw = sqlite3.connect(path)
        with raw:
            raw.execute("INSERT INTO paper_futures_forecast_verdicts VALUES('PF_XBTUSD',1,'h',0,0)")
            raw.execute(
                "INSERT INTO paper_futures_forecasts VALUES('PF_XBTUSD',1,'proposal','s','LONG','range',0,1,0,'1',NULL,NULL,NULL,'h',0)"
            )
            raw.execute("INSERT INTO paper_futures_forecast_returns VALUES('PF_XBTUSD',1,'proposal','s',15,'1','1',2,0)")
            raw.execute("INSERT INTO paper_futures_forecast_barriers VALUES('PF_XBTUSD',1,'proposal','s','neither',0,NULL,0)")
            raw.execute("INSERT INTO paper_futures_forecast_excursions VALUES('PF_XBTUSD',1,'proposal','s',30,'0','0',0)")
        updates = {
            "paper_futures_forecast_meta": "SET value='x'",
            "paper_futures_forecast_verdicts": "SET written_at=1",
            "paper_futures_forecasts": "SET written_at=1",
            "paper_futures_forecast_returns": "SET written_at=1",
            "paper_futures_forecast_barriers": "SET written_at=1",
            "paper_futures_forecast_excursions": "SET written_at=1",
        }
        for table, assignment in updates.items():
            for statement in ("UPDATE {} {}".format(table, assignment), "DELETE FROM {}".format(table)):
                with self.assertRaises(sqlite3.DatabaseError, msg=statement):
                    raw.execute(statement)
        raw.close()

    def test_refuses_a_single_product_scores_db_from_before_the_split_by_product_untouched(self):
        path = os.path.join(self.dir, "old-scores.sqlite")
        old_config = dict(SCORE_CONFIG, version="futures-forecast-scores-config.v1")
        connection = sqlite3.connect(path)
        connection.executescript(
            """
            CREATE TABLE paper_futures_forecast_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE paper_futures_forecasts(bucket_start INTEGER NOT NULL, source TEXT NOT NULL,
              strategy_id TEXT NOT NULL, PRIMARY KEY(bucket_start, source, strategy_id)) STRICT;
            """
        )
        connection.execute("INSERT INTO paper_futures_forecast_meta VALUES('config_hash', ?)",
                           (canonical_hash(old_config),))
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ValueError, "different config"):
            ScoreStore(path, SCORE_CONFIG)
        names = [row[0] for row in rows(path, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        self.assertEqual(names, ["paper_futures_forecast_meta", "paper_futures_forecasts"])

    def test_poll_never_raises_and_logs_a_missing_or_locked_database_once(self):
        logs = []
        store = ScoreStore(os.path.join(self.dir, "scores.sqlite"), SCORE_CONFIG)
        service = ForecastScoreService(os.path.join(self.dir, "none.sqlite"),
                                       os.path.join(self.dir, "nov.sqlite"), store, log=logs.append,
                                       products=[BTC])
        self.assertEqual(service.poll(), 0)
        self.assertEqual(service.poll(), 0)
        self.assertEqual(len([line for line in logs if "unavailable" in line]), 1)
        service.close()
        store.close()

    def test_idle_poll_is_two_cheap_probes_over_persistent_connections(self):
        market = MarketDb(os.path.join(self.dir, "market.sqlite"))
        verdicts = VerdictStore(os.path.join(self.dir, "verdicts.sqlite"), VERDICT_CONFIG)
        market.insert(series(5))
        verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", "1", "900000")]))
        store = ScoreStore(os.path.join(self.dir, "scores.sqlite"), SCORE_CONFIG)
        service = ForecastScoreService(market.path, os.path.join(self.dir, "verdicts.sqlite"), store,
                                       log=lambda line: None, products=[BTC])
        self.assertGreater(service.poll(), 0)
        statements = []
        service.market.db.set_trace_callback(statements.append)
        service.verdicts.db.set_trace_callback(statements.append)
        market_reader, verdict_reader = service.market, service.verdicts
        for _ in range(3):
            self.assertEqual(service.poll(), 0)
        self.assertIs(service.market, market_reader)
        self.assertIs(service.verdicts, verdict_reader)
        self.assertEqual(len(statements), 6)
        self.assertTrue(all("MAX(bucket_start)" in statement for statement in statements))
        service.close()
        store.close()
        verdicts.close()

    def test_survives_a_locked_market_db_then_recovers(self):
        market = MarketDb(os.path.join(self.dir, "market.sqlite"))
        verdicts = VerdictStore(os.path.join(self.dir, "verdicts.sqlite"), VERDICT_CONFIG)
        market.insert(series(20))
        verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", "1", "900000")]))
        store = ScoreStore(os.path.join(self.dir, "scores.sqlite"), SCORE_CONFIG)
        service = ForecastScoreService(market.path, os.path.join(self.dir, "verdicts.sqlite"), store,
                                       log=lambda line: None, products=[BTC])

        def locked(product_id):
            raise sqlite3.OperationalError("database is locked")

        service.poll()
        service.market.latest_bucket = locked
        self.assertEqual(service.poll(), 0)
        market.insert(series(31)[20:])
        self.assertGreater(service.poll(), 0)
        service.close()
        store.close()
        verdicts.close()

    def test_once_cli_scores_available_data_and_prints_the_count(self):
        market = MarketDb(os.path.join(self.dir, "market.sqlite"))
        verdicts = VerdictStore(os.path.join(self.dir, "verdicts.sqlite"), VERDICT_CONFIG)
        market.insert(series(20))
        verdicts.append(verdict(ENTRY, [proposal(C27, "LONG", "1", "900000")]))
        verdicts.close()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["--market-db", market.path, "--verdicts-db", os.path.join(self.dir, "verdicts.sqlite"),
                         "--scores-db", os.path.join(self.dir, "scores.sqlite"), "--once"])
        self.assertEqual(code, 0)
        self.assertIn("forecast scores", out.getvalue())
        self.assertEqual(len(rows(os.path.join(self.dir, "scores.sqlite"),
                                  "SELECT 1 FROM paper_futures_forecast_returns")), 1)


if __name__ == "__main__":
    unittest.main()
