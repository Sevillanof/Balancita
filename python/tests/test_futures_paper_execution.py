import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_paper_execution import (
    PAPER_EXECUTION_CONFIG,
    AccountStore,
    PaperExecutionService,
    process_available,
    verify_chain,
)
from balancita_engine.futures_verdicts import VERDICT_CONFIG, VerdictStore

SECOND = 1_000
MINUTE = 60_000
HOUR = 3_600_000
DAY = 86_400_000
C25 = "c25-pullback-perp-v1"
C27 = "c27-breakout-perp-v1"
C28 = "c28-adapter-perp-v1"
# Noon UTC of some day: far from any rollover.
BASE = (1_791_000_000_000 // DAY) * DAY + 12 * HOUR

# Same DDL as the market store (server/src/features/kraken-futures/futures-market-store.ts).
MARKET_DDL = """
CREATE TABLE paper_futures_market_events (
  event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
  raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL
) STRICT;
CREATE TABLE paper_futures_funding_responses(
  sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL, raw_response TEXT NOT NULL
) STRICT;
CREATE TABLE paper_futures_funding_periods(
  response_sha256 TEXT NOT NULL REFERENCES paper_futures_funding_responses(sha256),
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL,
  known_at INTEGER NOT NULL, unit TEXT NOT NULL, PRIMARY KEY(response_sha256,start_ms)
) STRICT;
"""


class MarketDb:
    def __init__(self, path):
        self.path = path
        self.count = 0
        self.responses = 0
        connection = sqlite3.connect(path)
        connection.executescript(MARKET_DDL)
        connection.close()

    def tickers(self, rows):
        """rows: (received_at, bid, ask, mark[, bid_size, ask_size])."""
        connection = sqlite3.connect(self.path)
        with connection:
            for row in rows:
                received_at, bid, ask, mark = row[:4]
                bid_size, ask_size = (row[4], row[5]) if len(row) > 4 else ("5", "5")
                self.count += 1
                normalized = {
                    "type": "ticker", "bid": bid, "ask": ask, "mark": mark,
                    "eventTime": received_at - 20, "receivedAt": received_at,
                    "raw": {"feed": "ticker", "bid_size": bid_size, "ask_size": ask_size},
                }
                connection.execute(
                    "INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("e{}".format(self.count), "ticker", "PF_XBTUSD", 1, self.count, received_at - 20,
                     received_at, received_at, None, "{}", json.dumps(normalized), "h{}".format(self.count)),
                )
                # Interleaved non-ticker rows must be ignored.
                self.count += 1
                connection.execute(
                    "INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("e{}".format(self.count), "book", "PF_XBTUSD", 1, self.count, received_at,
                     received_at, received_at, None, "{}", "{}", "h{}".format(self.count)),
                )
        connection.close()

    def funding(self, start, end, rate, known_at, unit="USD/BTC/hour", repeat=1):
        connection = sqlite3.connect(self.path)
        with connection:
            for _ in range(repeat):
                self.responses += 1
                sha = "r{}".format(self.responses)
                connection.execute(
                    "INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, known_at, "t", "{}")
                )
                connection.execute(
                    "INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?)",
                    (sha, start, end, rate, known_at, unit),
                )
        connection.close()


def features(close, **extra):
    base = {"ready": True, "candidate_close": close}
    base.update(extra)
    return base


def verdict_payload(bucket, action="LONG", strategy=C25, delegated=None, stop="95001", target="100500",
                    invalidation="close_below_ema21", signal_key=None, lag=3 * SECOND, regime="trend",
                    one=None, previous=None, five=None):
    selected = {
        "action": action, "strategy_id": strategy, "delegated_strategy_id": delegated,
        "proposed_stop": stop, "proposed_target": target, "invalidation": invalidation,
        "signal_key": signal_key or "{}:{}:{}".format(strategy, action, bucket),
        "reason_code": "test",
    }
    return {
        "action": action, "bucket_start_ms": bucket, "regime": regime,
        "decision_known_at_ms": bucket + MINUTE + lag, "knowledge_lag_ms": lag,
        "selected": selected,
        "features": {
            "1m": one if one is not None else features("100000", ema21="99000"),
            "1m_previous": previous if previous is not None else features("100000", ema21="99000"),
            "5m": five if five is not None else features("100000"),
        },
    }


class VerdictsDb:
    def __init__(self, path):
        self.path = path
        VerdictStore(path, VERDICT_CONFIG).close()

    def add(self, bucket, written_at, payload, product="PF_XBTUSD"):
        connection = sqlite3.connect(self.path)
        with connection:
            connection.execute(
                "INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)",
                (product, bucket, MINUTE, payload["decision_known_at_ms"], payload["regime"], payload["action"],
                 "test", "hash{}".format(bucket), json.dumps(payload, sort_keys=True), written_at),
            )
        connection.close()


def account_rows(path):
    connection = sqlite3.connect(path)
    rows = connection.execute(
        "SELECT seq, kind, payload_json, record_hash FROM paper_execution_events ORDER BY seq"
    ).fetchall()
    connection.close()
    return rows


def events_of(path, kind=None):
    rows = account_rows(path)
    return [json.loads(row[2]) for row in rows if kind is None or row[1] == kind]


def body(event):
    return event["body"]


def cfg(**overrides):
    return dict(PAPER_EXECUTION_CONFIG, **overrides)


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-paper-")
        self.market = MarketDb(self.path("market.sqlite"))
        self.verdicts = VerdictsDb(self.path("verdicts.sqlite"))
        # A known funding period that ends just before BASE: entries are not funding-blocked.
        self.market.funding(BASE - HOUR, BASE, "0", BASE - 5 * SECOND)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def replay(self, name="account.sqlite", config=None, **kwargs):
        store = AccountStore(self.path(name), config or PAPER_EXECUTION_CONFIG)
        count = process_available(self.market.path, self.verdicts.path, store, **kwargs)
        store.close()
        return count

    def long_entry(self, written_at=BASE + SECOND, **overrides):
        bucket = written_at - MINUTE - 3 * SECOND
        bucket -= bucket % MINUTE
        self.verdicts.add(bucket, written_at, verdict_payload(bucket, **overrides))
        return bucket, written_at

    def kinds(self, name="account.sqlite"):
        return [row[1] for row in account_rows(self.path(name))]


class EntryTests(Case):
    def test_long_fills_at_ask_after_latency_with_risk_capped_size(self):
        bucket, written = self.long_entry()
        self.market.tickers([
            (written + 50, "100000", "100001", "100000"),  # inside the latency: not eligible
            (written + 120, "100010", "100011", "100010"),  # first eligible, valid
            (written + 400, "100020", "100021", "100020"),
        ])
        self.replay()
        considered = events_of(self.path("account.sqlite"), "verdict_considered")
        self.assertEqual(body(considered[0])["outcome"], "entered")
        created = body(events_of(self.path("account.sqlite"), "order_created")[0])
        self.assertEqual(created["eligible_at_ms"], written + 100)
        filled = body(events_of(self.path("account.sqlite"), "order_filled")[0])
        self.assertEqual(filled["price"], "100011")
        self.assertEqual(filled["liquidity"], "taker")
        # risk: 10 USD / (|100011-95001| + 100011*0.0012) = 10/5130.0132 -> floor 0.0001 lot = 0.0019
        self.assertEqual(filled["quantity"], "0.0019")
        opened = body(events_of(self.path("account.sqlite"), "position_opened")[0])
        self.assertEqual(opened["side"], "long")
        self.assertEqual(opened["stop"], "95001")
        self.assertEqual(opened["fee"], "0.09501045")
        self.assertEqual(events_of(self.path("account.sqlite"), "order_filled")[0]["time_ms"], written + 120)

    def test_acts_on_pf_xbtusd_verdicts_only_when_other_products_share_the_verdicts_db(self):
        written = BASE + SECOND
        bucket = written - MINUTE - 3 * SECOND
        bucket -= bucket % MINUTE
        self.verdicts.add(bucket, written, verdict_payload(bucket))
        # Other products' proposals before and after the BTC one: never considered or traded.
        self.verdicts.add(bucket - MINUTE, written - MINUTE, verdict_payload(bucket - MINUTE), product="PF_ETHUSD")
        self.verdicts.add(bucket, written, verdict_payload(bucket), product="PF_ETHUSD")
        self.verdicts.add(bucket + MINUTE, written + MINUTE, verdict_payload(bucket + MINUTE), product="PF_SOLUSD")
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        considered = events_of(self.path("account.sqlite"), "verdict_considered")
        self.assertEqual([body(item)["outcome"] for item in considered], ["entered"])
        self.assertEqual(len(events_of(self.path("account.sqlite"), "order_filled")), 1)

    def test_short_fills_at_bid(self):
        bucket, written = self.long_entry(action="SHORT", stop="105001", target="99500",
                                          invalidation="close_above_ema21")
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        filled = body(events_of(self.path("account.sqlite"), "order_filled")[0])
        self.assertEqual(filled["price"], "100010")
        self.assertEqual(body(events_of(self.path("account.sqlite"), "position_opened")[0])["side"], "short")

    def test_size_is_capped_by_the_displayed_size_at_that_price(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010", "9", "0.0005")])
        self.replay()
        filled = body(events_of(self.path("account.sqlite"), "order_filled")[0])
        self.assertEqual(filled["quantity"], "0.0005")
        self.assertEqual(filled["displayed_size"], "0.0005")

    def test_size_is_capped_by_the_notional_limit(self):
        # Tight stop: risk size is large, so the 1000 USD notional cap binds: 1000/100011 -> 0.0099.
        _, written = self.long_entry(stop="99900", target="100500")
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        filled = body(events_of(self.path("account.sqlite"), "order_filled")[0])
        self.assertEqual(filled["quantity"], "0.0099")

    def test_rejects_when_the_size_falls_below_the_minimum(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010", "9", "0.00001")])
        self.replay()
        rejected = body(events_of(self.path("account.sqlite"), "order_rejected")[0])
        self.assertEqual(rejected["reason"], "quantity_below_minimum")
        self.assertEqual(events_of(self.path("account.sqlite"), "position_opened"), [])

    def test_rejects_when_the_stop_is_on_the_wrong_side_of_the_fill(self):
        _, written = self.long_entry(stop="100500", target="101500")
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        rejected = body(events_of(self.path("account.sqlite"), "order_rejected")[0])
        self.assertEqual(rejected["reason"], "invalid_stop")

    def test_rejects_a_target_that_does_not_clear_the_costs(self):
        _, written = self.long_entry(stop="95001", target="100100")
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        rejected = body(events_of(self.path("account.sqlite"), "order_rejected")[0])
        self.assertEqual(rejected["reason"], "target_does_not_clear_cost_buffer")

    def test_stale_verdict_is_skipped_with_a_reason(self):
        _, written = self.long_entry(lag=20 * SECOND)
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        considered = body(events_of(self.path("account.sqlite"), "verdict_considered")[0])
        self.assertEqual(considered["outcome"], "skipped")
        self.assertEqual(considered["reason"], "verdict_stale")
        self.assertNotIn("order_created", self.kinds())

    def test_wait_verdicts_are_not_reported(self):
        bucket = BASE - 2 * MINUTE
        self.verdicts.add(bucket, BASE, verdict_payload(bucket, action="WAIT"))
        self.market.tickers([(BASE + 150, "100010", "100011", "100010")])
        self.replay()
        self.assertEqual(self.kinds(), [])

    def test_duplicate_signal_key_never_enters_twice(self):
        _, written = self.long_entry(signal_key="same-signal", stop="99900")
        self.market.tickers([
            (written + 150, "100010", "100011", "100010"),
            # target hit: the position closes, then the very same signal arrives again
            (written + 20 * SECOND, "100600", "100601", "100600"),
            (written + 21 * SECOND, "100600", "100601", "100600"),
        ])
        second = written + 25 * SECOND
        self.verdicts.add(BASE + 5 * MINUTE, second, verdict_payload(
            BASE + 5 * MINUTE, signal_key="same-signal", stop="99900"))
        self.market.tickers([(second + 150, "100600", "100601", "100600")])
        self.replay()
        considered = [body(e) for e in events_of(self.path("account.sqlite"), "verdict_considered")]
        self.assertEqual([c["outcome"] for c in considered], ["entered", "skipped"])
        self.assertEqual(considered[1]["reason"], "signal_already_consumed")
        self.assertEqual(len(events_of(self.path("account.sqlite"), "position_opened")), 1)

    def test_entry_expires_when_no_valid_ticker_arrives(self):
        _, written = self.long_entry()
        self.market.tickers([
            (written + 150, "100000", "100100", "100050"),  # spread ~10 bps: invalid
            (written + 4 * SECOND, "100000", "100100", "100050"),
            (written + 5_200, "100010", "100011", "100010"),  # valid but past eligible+5s
        ])
        self.replay()
        kinds = self.kinds()
        self.assertIn("order_expired", kinds)
        self.assertNotIn("order_filled", kinds)

    def test_entry_fills_on_a_later_valid_ticker_within_the_wait(self):
        _, written = self.long_entry()
        self.market.tickers([
            (written + 150, "100000", "100100", "100050"),
            (written + 3 * SECOND, "100010", "100011", "100010"),
        ])
        self.replay()
        filled = events_of(self.path("account.sqlite"), "order_filled")[0]
        self.assertEqual(filled["time_ms"], written + 3 * SECOND)

    def test_no_entry_when_funding_is_unresolved(self):
        # Fresh inputs whose only funding period ended nine hours earlier.
        self.market = MarketDb(self.path("stale-market.sqlite"))
        self.market.funding(BASE - 10 * HOUR, BASE - 9 * HOUR, "0", BASE - 9 * HOUR)
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        considered = body(events_of(self.path("account.sqlite"), "verdict_considered")[0])
        self.assertEqual(considered["outcome"], "skipped")
        self.assertEqual(considered["reason"], "funding_unresolved")
        self.assertIn("funding_unresolved", considered["causes"])

    def test_ties_break_funding_before_verdict_before_ticker(self):
        # The funding period becomes known at the very millisecond the verdict is written.
        self.market = MarketDb(self.path("tie-market.sqlite"))
        written = BASE + SECOND
        self.market.funding(BASE - HOUR, BASE, "0", written)
        self.long_entry(written_at=written)
        self.market.tickers([(written + 100, "100010", "100011", "100010")])  # at eligible
        self.replay()
        considered = body(events_of(self.path("account.sqlite"), "verdict_considered")[0])
        self.assertEqual(considered["outcome"], "entered")
        self.assertEqual(self.kinds().count("order_filled"), 1)

    def test_no_second_entry_while_an_order_is_pending_or_a_position_is_open(self):
        _, written = self.long_entry(stop="99900")
        second_bucket = BASE + 10 * MINUTE
        self.verdicts.add(second_bucket, written + 30, verdict_payload(second_bucket))  # order pending
        third_bucket = BASE + 11 * MINUTE
        self.verdicts.add(third_bucket, written + 5 * SECOND, verdict_payload(third_bucket))  # position open
        self.market.tickers([(written + 150, "100010", "100011", "100010"),
                             (written + 6 * SECOND, "100010", "100011", "100010")])
        self.replay()
        considered = [body(e) for e in events_of(self.path("account.sqlite"), "verdict_considered")]
        self.assertEqual([c["outcome"] for c in considered], ["entered", "skipped", "skipped"])
        self.assertEqual(considered[1]["reason"], "order_pending")
        self.assertEqual(considered[2]["reason"], "position_open")


class ExitTests(Case):
    def open_long(self, **overrides):
        overrides.setdefault("stop", "99900")
        overrides.setdefault("target", "100500")
        _, written = self.long_entry(**overrides)
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        return written

    def test_stop_exit_sells_at_the_bid_on_the_next_valid_ticker_after_latency(self):
        written = self.open_long()
        self.market.tickers([
            (written + 5 * SECOND, "99890", "99891", "99890"),  # mark <= stop
            (written + 5 * SECOND + 50, "99880", "99881", "99880"),  # inside latency
            (written + 5 * SECOND + 300, "99870", "99871", "99870"),
        ])
        self.replay()
        triggered = body(events_of(self.path("account.sqlite"), "exit_triggered")[0])
        self.assertEqual(triggered["reason"], "protective_stop")
        fills = [body(e) for e in events_of(self.path("account.sqlite"), "order_filled")]
        self.assertEqual(fills[1]["side"], "sell")
        self.assertEqual(fills[1]["price"], "99870")
        closed = body(events_of(self.path("account.sqlite"), "position_closed")[0])
        self.assertEqual(closed["reason"], "protective_stop")
        # gross = 0.0099 * (99870 - 100011) ; fees = 0.0099 * (100011 + 99870) * 0.0005
        self.assertEqual(closed["gross"], "-1.3959")
        self.assertEqual(closed["fees"], "0.98941095")
        self.assertEqual(closed["funding"], "0")
        self.assertEqual(closed["net"], "-2.38531095")

    def test_target_exit(self):
        written = self.open_long()
        self.market.tickers([
            (written + 5 * SECOND, "100510", "100511", "100510"),
            (written + 6 * SECOND, "100520", "100521", "100520"),
        ])
        self.replay()
        self.assertEqual(body(events_of(self.path("account.sqlite"), "exit_triggered")[0])["reason"],
                         "profit_target")
        closed = body(events_of(self.path("account.sqlite"), "position_closed")[0])
        self.assertEqual(closed["exit_price"], "100520")

    def test_c25_invalidation_exits_through_propose(self):
        written = self.open_long()
        bucket = BASE
        self.verdicts.add(bucket, written + 30 * SECOND, verdict_payload(
            bucket, action="WAIT", one=features("98999", ema21="99000")))
        self.market.tickers([(written + 31 * SECOND, "100010", "100011", "100010"),
                             (written + 32 * SECOND, "100010", "100011", "100010")])
        self.replay()
        triggered = body(events_of(self.path("account.sqlite"), "exit_triggered")[0])
        self.assertEqual(triggered["reason"], "strategy_exit")
        self.assertEqual(triggered["detail"], "owner_exit_condition_met")

    def test_c25_holds_when_the_close_stays_above_ema21(self):
        written = self.open_long()
        self.verdicts.add(BASE, written + 30 * SECOND, verdict_payload(
            BASE, action="WAIT", one=features("99500", ema21="99000")))
        self.market.tickers([(written + 31 * SECOND, "100010", "100011", "100010")])
        self.replay()
        self.assertNotIn("exit_triggered", self.kinds())

    def test_c27_exits_on_the_frozen_donchian_mid(self):
        written = self.open_long(strategy=C27, invalidation="opposite_donchian_mid_cross@100000")
        # The new verdict's own donchian mid differs: only the frozen entry mid counts.
        self.verdicts.add(BASE, written + 30 * SECOND, verdict_payload(
            BASE, action="WAIT", strategy=C27, one=features("99990", donchian_mid20="99000")))
        self.market.tickers([(written + 31 * SECOND, "100010", "100011", "100010"),
                             (written + 32 * SECOND, "100010", "100011", "100010")])
        self.replay()
        triggered = body(events_of(self.path("account.sqlite"), "exit_triggered")[0])
        self.assertEqual(triggered["reason"], "strategy_exit")

    def test_c28_uses_the_delegated_strategy_recorded_at_entry(self):
        written = self.open_long(strategy=C28, delegated=C25)
        self.verdicts.add(BASE, written + 30 * SECOND, verdict_payload(
            BASE, action="WAIT", strategy=C28, regime="range", one=features("98999", ema21="99000")))
        self.market.tickers([(written + 31 * SECOND, "100010", "100011", "100010"),
                             (written + 32 * SECOND, "100010", "100011", "100010")])
        self.replay()
        self.assertEqual(body(events_of(self.path("account.sqlite"), "exit_triggered")[0])["reason"],
                         "strategy_exit")

    def test_stale_verdicts_do_not_drive_exits(self):
        written = self.open_long()
        self.verdicts.add(BASE, written + 30 * SECOND, verdict_payload(
            BASE, action="WAIT", lag=10 * MINUTE, one=features("98999", ema21="99000")))
        self.market.tickers([(written + 31 * SECOND, "100010", "100011", "100010")])
        self.replay()
        self.assertNotIn("exit_triggered", self.kinds())

    def test_time_stop_after_thirty_minutes(self):
        written = self.open_long()
        opened_at = written + 150
        self.market.tickers([
            (opened_at + 29 * MINUTE, "100010", "100011", "100010"),
            (opened_at + 30 * MINUTE, "100010", "100011", "100010"),
            (opened_at + 30 * MINUTE + 200, "100020", "100021", "100020"),
        ])
        self.replay()
        triggered = events_of(self.path("account.sqlite"), "exit_triggered")
        self.assertEqual(len(triggered), 1)
        self.assertEqual(body(triggered[0])["reason"], "time_stop")
        self.assertEqual(triggered[0]["time_ms"], opened_at + 30 * MINUTE)

    def test_daily_loss_latches_blocks_entries_and_clears_on_the_utc_rollover(self):
        config = cfg(daily_loss_fraction="0.0005")
        written = self.open_long(stop="98500")
        self.market.tickers([
            (written + 5 * SECOND, "99000", "99001", "99000"),  # 0.0061*1011 = 6 USD loss >= 5 USD
            (written + 6 * SECOND, "99000", "99001", "99000"),
        ])
        # While latched a fresh LONG verdict is blocked...
        blocked_bucket = BASE + 20 * MINUTE
        self.verdicts.add(blocked_bucket, written + 10 * SECOND, verdict_payload(blocked_bucket, stop="98500"))
        # ... and after the UTC rollover it is allowed again.
        next_day = (BASE // DAY + 1) * DAY
        self.market.funding(next_day - HOUR, next_day, "0", next_day + SECOND)
        self.market.tickers([(next_day + 10 * SECOND, "99000", "99001", "99000")])
        reopened_bucket = BASE + 30 * MINUTE
        self.verdicts.add(reopened_bucket, next_day + 20 * SECOND, verdict_payload(reopened_bucket, stop="98500"))
        self.market.tickers([(next_day + 21 * SECOND, "99000", "99001", "99000")])
        self.replay(config=config)
        path = self.path("account.sqlite")
        latch = events_of(path, "latch_set")
        self.assertEqual(len(latch), 1)
        self.assertEqual(body(events_of(path, "exit_triggered")[0])["reason"], "daily_loss_limit")
        considered = [body(e) for e in events_of(path, "verdict_considered")]
        self.assertEqual(considered[1]["reason"], "daily_loss_latched")
        self.assertEqual(considered[2]["outcome"], "entered")
        cleared = events_of(path, "latch_cleared")
        self.assertEqual(len(cleared), 1)
        self.assertGreaterEqual(cleared[0]["time_ms"], next_day)
        # latch set -> exit -> blocked -> cleared -> entered, in chain order
        order = [kind for kind in self.kinds() if kind in ("latch_set", "latch_cleared", "position_closed")]
        self.assertEqual(order, ["latch_set", "position_closed", "latch_cleared"])


class FundingTests(Case):
    def funded_position(self, side):
        action = "LONG" if side == "long" else "SHORT"
        stop, target = ("90000", "101500") if side == "long" else ("110000", "98500")
        invalidation = "close_below_ema21" if side == "long" else "close_above_ema21"
        _, written = self.long_entry(action=action, stop=stop, target=target, invalidation=invalidation)
        opened_at = written + 150
        self.market.tickers([(opened_at, "100010", "100011", "100010")])
        # a funding period for the hour after BASE, known after it ends
        self.market.funding(BASE, BASE + HOUR, "2", BASE + HOUR + 500)
        self.market.tickers([(BASE + HOUR + 10 * SECOND, "100010", "100011", "100010")])
        return opened_at

    def test_long_pays_positive_funding(self):
        opened_at = self.funded_position("long")
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        accrued = events_of(self.path("account.sqlite"), "funding_accrued")
        self.assertEqual(len(accrued), 1)
        amount = body(accrued[0])["funding_paid"]
        quantity = float(body(events_of(self.path("account.sqlite"), "position_opened")[0])["quantity"])
        # quantity * 2 USD/BTC/h * (BASE+1h - opened_at)/1h
        hours = (BASE + HOUR - opened_at) / HOUR
        self.assertAlmostEqual(float(amount), quantity * 2 * hours, places=8)
        self.assertGreater(float(amount), 0)

    def test_short_receives_positive_funding(self):
        self.funded_position("short")
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        amount = body(events_of(self.path("account.sqlite"), "funding_accrued")[0])["funding_paid"]
        self.assertLess(float(amount), 0)

    def test_close_reports_funding_paid_and_completeness(self):
        self.funded_position("long")
        self.market.tickers([(BASE + HOUR + 20 * SECOND, "89000", "89001", "89000"),
                             (BASE + HOUR + 21 * SECOND, "89000", "89001", "89000")])
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        closed = body(events_of(self.path("account.sqlite"), "position_closed")[0])
        self.assertGreater(float(closed["funding"]), 0)
        self.assertIn("funding_complete", closed)

    def test_repeated_funding_responses_count_once(self):
        self.funded_position("long")
        self.market.funding(BASE, BASE + HOUR, "2", BASE + HOUR + 900, repeat=3)
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        self.assertEqual(len(events_of(self.path("account.sqlite"), "funding_accrued")), 1)

    def test_deduped_capture_one_new_period_per_response_is_followed_incrementally(self):
        # The capture process stores a funding response only when it adds a period,
        # and then only the new period: one row per hour, never a re-listed history.
        opened_at = self.funded_position("long")
        store = AccountStore(self.path("live.sqlite"), cfg(time_stop_ms=10 * HOUR))
        service = PaperExecutionService(self.market.path, self.verdicts.path, store, log=lambda line: None)
        service.poll(now_ms=BASE + HOUR + 20 * SECOND)
        self.market.funding(BASE + HOUR, BASE + 2 * HOUR, "3", BASE + 2 * HOUR + 500)
        self.market.tickers([(BASE + 2 * HOUR + 10 * SECOND, "100010", "100011", "100010")])
        service.poll(now_ms=BASE + 2 * HOUR + 20 * SECOND)
        self.market.funding(BASE + 2 * HOUR, BASE + 3 * HOUR, "4", BASE + 3 * HOUR + 500)
        self.market.tickers([(BASE + 3 * HOUR + 10 * SECOND, "100010", "100011", "100010")])
        service.poll(now_ms=BASE + 3 * HOUR + 20 * SECOND)
        service.close()
        store.close()
        live = events_of(self.path("live.sqlite"), "funding_accrued")
        # every new period reached the engine in order, none skipped or repeated
        self.assertEqual([body(event)["to_ms"] for event in live],
                         [BASE + HOUR, BASE + 2 * HOUR, BASE + 3 * HOUR])
        self.replay("replay.sqlite", config=cfg(time_stop_ms=10 * HOUR))
        self.assertEqual(account_rows(self.path("live.sqlite")), account_rows(self.path("replay.sqlite")))
        self.assertGreater(opened_at, BASE)


class AccountBlockTests(Case):
    """Every state-changing event carries the running totals after it."""

    def account_of(self, kind, index=0):
        return body(events_of(self.path("account.sqlite"), kind)[index])["account"]

    def test_entry_fill_and_position_opened_carry_the_account_after_the_fill(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 120, "100010", "100011", "100010")])
        self.replay()
        expected = {
            "cash_usd": "9999.90498955", "realized_gross_usd": "0", "fees_usd": "0.09501045",
            "funding_paid_usd": "0", "funding_complete": True, "net_usd": "-0.09501045",
            "position": {
                "side": "long", "quantity_btc": "0.0019", "entry_price_usd_per_btc": "100011",
                "opened_at_ms": written + 120, "stop": "95001", "target": "100500", "strategy_id": C25,
            },
        }
        self.assertEqual(self.account_of("order_filled"), expected)
        self.assertEqual(self.account_of("position_opened"), expected)

    def test_close_carries_the_realized_totals_and_no_position(self):
        _, written = self.long_entry(stop="99900")
        self.market.tickers([
            (written + 150, "100010", "100011", "100010"),
            (written + 5 * SECOND, "99890", "99891", "99890"),
            (written + 5 * SECOND + 300, "99870", "99871", "99870"),
        ])
        self.replay()
        closed = body(events_of(self.path("account.sqlite"), "position_closed")[0])
        for account in (self.account_of("position_closed"), self.account_of("order_filled", 1)):
            self.assertIsNone(account["position"])
            # Closed before the hour's funding is published: completeness is never inferred.
            self.assertFalse(closed["funding_complete"])
            self.assertFalse(account["funding_complete"])
            self.assertIsNone(account["net_usd"])
            self.assertEqual(account["fees_usd"], closed["fees"])
            self.assertEqual(account["realized_gross_usd"], closed["gross"])
            self.assertEqual(account["cash_usd"], "9997.61468905")
            self.assertEqual(account["funding_paid_usd"], "0")

    def test_funding_accrual_carries_the_running_funding_total(self):
        FundingTests.funded_position(self, "long")
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        paid = body(events_of(self.path("account.sqlite"), "funding_accrued")[0])["funding_paid"]
        account = self.account_of("funding_accrued")
        self.assertEqual(account["funding_paid_usd"], paid)
        self.assertEqual(account["position"]["side"], "long")
        self.assertEqual(account["position"]["strategy_id"], C25)

    def test_net_is_reported_exactly_when_funding_is_complete(self):
        FundingTests.funded_position(self, "long")
        self.market.tickers([(BASE + HOUR + 20 * SECOND, "89000", "89001", "89000"),
                             (BASE + HOUR + 21 * SECOND, "89000", "89001", "89000")])
        self.replay(config=cfg(time_stop_ms=10 * HOUR))
        closed = body(events_of(self.path("account.sqlite"), "position_closed")[0])
        account = self.account_of("position_closed")
        self.assertEqual(account["funding_complete"], closed["funding_complete"])
        self.assertEqual(account["net_usd"], closed["net"] if closed["funding_complete"] else None)
        self.assertEqual(account["funding_paid_usd"], closed["funding"])

    def test_only_account_changing_events_carry_an_account(self):
        _, written = self.long_entry(stop="99900")
        self.market.tickers([
            (written + 150, "100010", "100011", "100010"),
            (written + 5 * SECOND, "99890", "99891", "99890"),
            (written + 5 * SECOND + 300, "99870", "99871", "99870"),
        ])
        self.replay()
        with_account = {"order_filled", "position_opened", "position_closed", "funding_accrued"}
        seen = set()
        for event in events_of(self.path("account.sqlite")):
            self.assertEqual("account" in event["body"], event["kind"] in with_account, event["kind"])
            seen.add(event["kind"])
        self.assertTrue(with_account - {"funding_accrued"} <= seen)

    def test_an_account_db_from_the_previous_event_schema_is_refused(self):
        old = cfg(version="futures-paper-execution-config.v1")
        AccountStore(self.path("old.sqlite"), old).close()
        with self.assertRaises(ValueError):
            AccountStore(self.path("old.sqlite"), PAPER_EXECUTION_CONFIG)
        self.assertEqual(PAPER_EXECUTION_CONFIG["version"], "futures-paper-execution-config.v2")


class ReplayAndRestartTests(Case):
    def busy_inputs(self):
        """Entry, stop, re-entry on a new signal, with funding, all in one input set."""
        steps = []
        for index in range(6):
            written = BASE + index * 5 * MINUTE + SECOND
            bucket = written - MINUTE - 3 * SECOND
            bucket -= bucket % MINUTE
            stop = "99900" if index % 2 == 0 else "99950"
            self.verdicts.add(bucket, written, verdict_payload(bucket, stop=stop, target="100400"))
            ticks = [
                (written + 150, "100010", "100011", "100010"),
                (written + 2 * MINUTE, "99890", "99891", "99890"),
                (written + 2 * MINUTE + 300, "99880", "99881", "99880"),
                (written + 3 * MINUTE, "100030", "100031", "100030"),
            ]
            steps.append((written, ticks))
        return steps

    def test_incremental_run_equals_two_full_replays(self):
        steps = self.busy_inputs()
        store = AccountStore(self.path("live.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(self.market.path, self.verdicts.path, store, log=lambda line: None,
                                        snapshot_every_events=3)
        # Inputs were all written up front; "arrive" them in chunks through the horizon.
        for written, ticks in steps:
            self.market.tickers(ticks)
        total = 0
        horizon_now = BASE
        while horizon_now < BASE + 40 * MINUTE:
            horizon_now += 37 * SECOND
            total += service.poll(now_ms=horizon_now + 2_000)
        total += service.poll(now_ms=BASE + 10 * DAY)
        self.assertEqual(service.poll(now_ms=BASE + 10 * DAY), 0)
        service.close()
        store.close()

        self.replay("replay-1.sqlite")
        self.replay("replay-2.sqlite", snapshot_every_events=2)
        live_rows = account_rows(self.path("live.sqlite"))
        self.assertGreater(len(live_rows), 20)
        self.assertEqual(live_rows, account_rows(self.path("replay-1.sqlite")))
        self.assertEqual(live_rows, account_rows(self.path("replay-2.sqlite")))
        self.assertEqual(verify_chain(self.path("live.sqlite")), live_rows[-1][3])

    def test_chunks_arriving_in_between_polls_equal_a_full_replay(self):
        steps = self.busy_inputs()
        # A second market/verdicts pair is fed chunk by chunk, polling in between.
        live_market = MarketDb(self.path("live-market.sqlite"))
        live_market.funding(BASE - HOUR, BASE, "0", BASE - 5 * SECOND)
        live_verdicts = VerdictsDb(self.path("live-verdicts.sqlite"))
        store = AccountStore(self.path("live.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(live_market.path, live_verdicts.path, store, log=lambda line: None,
                                        snapshot_every_events=4)
        source = sqlite3.connect(self.verdicts.path)
        rows = source.execute("SELECT * FROM paper_futures_verdicts ORDER BY bucket_start").fetchall()
        source.close()
        for index, (written, ticks) in enumerate(steps):
            connection = sqlite3.connect(live_verdicts.path)
            with connection:
                connection.execute("INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)", rows[index])
            connection.close()
            service.poll(now_ms=written + 2_500)
            live_market.tickers(ticks[:2])
            service.poll(now_ms=written + 2 * MINUTE + 2_100)
            live_market.tickers(ticks[2:])
            service.poll(now_ms=written + 4 * MINUTE)
        service.poll(now_ms=BASE + 10 * DAY)
        service.close()
        store.close()
        self.market = live_market
        self.verdicts = live_verdicts
        self.replay("replay-a.sqlite")
        self.replay("replay-b.sqlite")
        live_rows = account_rows(self.path("live.sqlite"))
        self.assertGreater(len(live_rows), 20)
        self.assertEqual(live_rows, account_rows(self.path("replay-a.sqlite")))
        self.assertEqual(live_rows, account_rows(self.path("replay-b.sqlite")))

    def test_restart_from_a_snapshot_equals_an_uninterrupted_run(self):
        self.busy_inputs()
        # Uninterrupted run.
        self.replay("whole.sqlite", snapshot_every_events=3)
        # Restarted run: stop after a few polls with a growing horizon, reopen every time.
        rederived = 0
        for now in range(0, 40 * MINUTE, 20 * SECOND):
            store = AccountStore(self.path("restarted.sqlite"), PAPER_EXECUTION_CONFIG)
            rederived += len(store.expected)
            service = PaperExecutionService(self.market.path, self.verdicts.path, store,
                                            log=lambda line: None, snapshot_every_events=5)
            service.poll(now_ms=BASE + now + 2_000)
            service.close()
            store.close()
        store = AccountStore(self.path("restarted.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(self.market.path, self.verdicts.path, store,
                                        log=lambda line: None, snapshot_every_events=3)
        service.poll(now_ms=BASE + 10 * DAY)
        service.close()
        store.close()
        self.assertEqual(account_rows(self.path("restarted.sqlite")), account_rows(self.path("whole.sqlite")))
        connection = sqlite3.connect(self.path("restarted.sqlite"))
        snapshots = connection.execute("SELECT COUNT(*) FROM paper_execution_snapshots").fetchone()[0]
        connection.close()
        self.assertGreater(snapshots, 1)
        # Events written after the last snapshot were re-derived and compared on restart.
        self.assertGreater(rederived, 0)

    def test_restart_refuses_inputs_that_no_longer_reproduce_the_stored_events(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        other = VerdictsDb(self.path("other-verdicts.sqlite"))
        bucket = written - MINUTE - 3 * SECOND
        bucket -= bucket % MINUTE
        other.add(bucket, written, verdict_payload(bucket, stop="95002"))
        store = AccountStore(self.path("account.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(self.market.path, other.path, store, log=lambda line: None)
        with self.assertRaises(RuntimeError):
            service.poll()
        service.close()
        store.close()

    def test_restart_resumes_from_the_snapshot_without_rereading_history(self):
        self.busy_inputs()
        store = AccountStore(self.path("a.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(self.market.path, self.verdicts.path, store, log=lambda line: None,
                                        snapshot_every_events=2, snapshot_interval_ms=MINUTE)
        service.poll(now_ms=BASE + 10 * DAY)
        service.close()
        store.close()
        store = AccountStore(self.path("a.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(self.market.path, self.verdicts.path, store, log=lambda line: None)
        statements = []
        service.on_trace = statements.append
        self.assertEqual(service.poll(now_ms=BASE + 10 * DAY), 0)
        # Only availability and MAX() probes: no history is read again.
        self.assertTrue(all("MAX(" in s or "sqlite_master" in s for s in statements), statements)
        service.close()
        store.close()

    def test_a_snapshot_whose_head_hash_disagrees_with_the_chain_is_refused(self):
        self.busy_inputs()
        self.replay("a.sqlite", snapshot_every_events=2)
        connection = sqlite3.connect(self.path("a.sqlite"))
        connection.execute("DROP TRIGGER paper_execution_snapshots_no_update")
        connection.execute("UPDATE paper_execution_snapshots SET head_hash=?", ("f" * 64,))
        connection.commit()
        connection.close()
        with self.assertRaises(ValueError):
            AccountStore(self.path("a.sqlite"), PAPER_EXECUTION_CONFIG)


class StoreTests(Case):
    def test_events_are_hash_chained_and_immutable(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay(snapshot_every_events=1)
        path = self.path("account.sqlite")
        rows = account_rows(path)
        self.assertGreaterEqual(len(rows), 3)
        self.assertEqual(verify_chain(path), rows[-1][3])
        connection = sqlite3.connect(path)
        first = connection.execute("SELECT prev_hash FROM paper_execution_events WHERE seq=1").fetchone()[0]
        self.assertEqual(first, "0" * 64)
        for statement in (
            "UPDATE paper_execution_events SET kind='x'",
            "DELETE FROM paper_execution_events",
            "UPDATE paper_execution_snapshots SET time_ms=0",
            "DELETE FROM paper_execution_snapshots",
            "UPDATE paper_execution_meta SET value='x'",
            "DELETE FROM paper_execution_meta",
        ):
            with self.assertRaises(sqlite3.DatabaseError, msg=statement):
                connection.execute(statement)
        connection.close()

    def test_events_are_emitted_only_on_state_changes_never_per_ticker(self):
        _, written = self.long_entry(stop="99900")
        self.market.tickers([(written + 150 + index * 100, "100010", "100011", "100010")
                             for index in range(200)])
        self.replay()
        self.assertLess(len(account_rows(self.path("account.sqlite"))), 10)

    def test_refuses_a_different_config_on_an_existing_db(self):
        self.replay()
        with self.assertRaises(ValueError):
            AccountStore(self.path("account.sqlite"), cfg(risk_fraction="0.002"))
        AccountStore(self.path("account.sqlite"), PAPER_EXECUTION_CONFIG).close()

    def test_numbers_in_events_are_canonical_decimal_strings(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        self.replay()
        for row in account_rows(self.path("account.sqlite")):
            self.assertNotIn(".0,", row[2])
            json.loads(row[2], parse_float=lambda value: self.fail("float in " + row[2]))


class ServiceResilienceTests(Case):
    def service(self, market_path, verdicts_path, logs=None, **kwargs):
        store = AccountStore(self.path("account.sqlite"), PAPER_EXECUTION_CONFIG)
        service = PaperExecutionService(market_path, verdicts_path, store,
                                        log=(logs.append if logs is not None else (lambda line: None)), **kwargs)
        return service, store

    def test_survives_missing_then_created_input_dbs(self):
        logs = []
        service, store = self.service(self.path("nope-market.sqlite"), self.path("nope-verdicts.sqlite"), logs)
        self.assertEqual(service.poll(now_ms=BASE + DAY), 0)
        self.assertEqual(service.poll(now_ms=BASE + DAY), 0)
        self.assertEqual(len([line for line in logs if "unavailable" in line]), 1)
        service.close()
        store.close()
        service, store = self.service(self.market.path, self.path("nope-verdicts.sqlite"), logs)
        self.assertEqual(service.poll(now_ms=BASE + DAY), 0)  # verdicts DB still missing: wait
        service.close()
        store.close()

    def test_survives_a_locked_market_db_and_a_recreated_one(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        service, store = self.service(self.market.path, self.verdicts.path)
        self.assertGreater(service.poll(now_ms=BASE + DAY), 0)

        def locked(*args, **kwargs):
            raise sqlite3.OperationalError("database is locked")

        service.market.probe_ticker = locked
        self.assertEqual(service.poll(now_ms=BASE + DAY), 0)
        self.market.tickers([(written + 4 * SECOND, "100010", "100011", "100010")])
        self.assertGreaterEqual(service.poll(now_ms=BASE + DAY), 1)
        service.close()
        store.close()

    def test_survives_a_real_lock_held_by_another_connection(self):
        service, store = self.service(self.market.path, self.verdicts.path, busy_timeout_s=0.05)
        service.poll(now_ms=BASE + DAY)
        blocker = sqlite3.connect(self.market.path)
        blocker.execute("BEGIN EXCLUSIVE")
        self.assertEqual(service.poll(now_ms=BASE + DAY), 0)
        blocker.rollback()
        blocker.close()
        service.close()
        store.close()

    def test_idle_poll_is_one_probe_per_source(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        service, store = self.service(self.market.path, self.verdicts.path)
        service.poll(now_ms=BASE + DAY)
        statements = []
        service.on_trace = statements.append
        for _ in range(3):
            self.assertEqual(service.poll(now_ms=BASE + DAY), 0)
        self.assertEqual(len(statements), 9, statements)
        self.assertTrue(all("MAX(" in statement for statement in statements))
        service.close()
        store.close()

    def test_live_horizon_holds_back_events_newer_than_the_margin(self):
        _, written = self.long_entry()
        self.market.tickers([(written + 150, "100010", "100011", "100010")])
        service, store = self.service(self.market.path, self.verdicts.path)
        service.poll(now_ms=written + 1_000)  # horizon = written - 1000: only the funding period
        self.assertEqual(self.kinds(), [])
        self.assertEqual(service.poll(now_ms=written + 2_000), 1)  # the verdict is now inside it
        self.assertEqual(self.kinds(), ["verdict_considered", "order_created"])
        self.assertEqual(service.poll(now_ms=written + 2_100), 0)  # the ticker is 150 ms after
        self.assertEqual(service.poll(now_ms=written + 2_200), 1)
        self.assertEqual(self.kinds().count("order_filled"), 1)
        service.close()
        store.close()


if __name__ == "__main__":
    unittest.main()
