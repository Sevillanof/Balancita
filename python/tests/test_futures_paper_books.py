import json
import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(__file__))

from balancita_engine.futures_paper_execution import (  # noqa: E402
    BOOKS_EXECUTION_CONFIG,
    AccountStore,
    process_available,
)
from balancita_engine.futures_strategies import C25_ID as C25, C26_ID as C26, C27_ID as C27  # noqa: E402
from test_futures_paper_execution import (  # noqa: E402
    BASE,
    MINUTE,
    SECOND,
    Case,
    account_rows,
    body,
    events_of,
    verdict_payload,
)


BTC = "PF_XBTUSD"


def key(strategy, product=BTC):
    return "{}:{}".format(strategy, product)


def proposal(strategy, action, stop, target, bucket):
    return {
        "strategy_id": strategy, "action": action, "delegated_strategy_id": None,
        "proposed_stop": stop, "proposed_target": target, "invalidation": "opposite_donchian_mid_cross@99000" if strategy == C27 else "close_below_ema21",
        "signal_key": "{}:{}:{}".format(strategy, action, bucket), "reason_code": "test",
    }


class BooksCase(Case):
    def add_verdict(self, proposals, written_at=BASE + 4 * SECOND, product=BTC):
        bucket = written_at - MINUTE - 3 * SECOND
        bucket -= bucket % MINUTE
        payload = verdict_payload(bucket)
        payload["proposals"] = [proposal(s, a, st, tg, bucket) for s, a, st, tg in proposals]
        payload["action"] = "ABSTAIN"  # what the shared selection says when strategies disagree
        payload["selected"] = {"action": "ABSTAIN", "reason_code": "conflicting_signals"}
        self.verdicts.add(bucket, written_at, payload, product=product)
        return bucket, written_at

    def books_replay(self, name="books.sqlite"):
        store = AccountStore(self.path(name), BOOKS_EXECUTION_CONFIG)
        process_available(self.market.path, self.verdicts.path, store)
        head = store.head_hash
        store.close()
        return head

    def by_book(self, kind, name="books.sqlite"):
        out = {}
        for event in events_of(self.path(name), kind):
            out.setdefault(body(event)["book"], []).append(body(event))
        return out


class IndependentBookTests(BooksCase):
    def test_opposite_signals_both_trade_each_in_its_own_book_with_100_usd(self):
        _, written = self.add_verdict([
            (C25, "LONG", "95001", "100500"), (C26, "SHORT", "105001", "99500"),
        ])
        self.market.tickers([(written + 150, "100010", "100011", "100010", "100", "100")])
        self.books_replay()
        opened = self.by_book("position_opened")
        self.assertEqual(set(opened), {key(C25), key(C26)})
        self.assertEqual(opened[key(C25)][0]["side"], "long")
        self.assertEqual(opened[key(C26)][0]["side"], "short")
        for book, events in opened.items():
            notional = Decimal(events[0]["quantity"]) * Decimal(events[0]["entry_price"])
            self.assertLessEqual(notional, Decimal("100"), book)
            self.assertGreater(notional, Decimal("99.9") - Decimal("0.0001") * Decimal("100011"), book)
        self.assertEqual(len(self.by_book("verdict_considered")), 2)

    def test_an_open_position_in_one_book_does_not_block_another(self):
        _, first = self.add_verdict([(C25, "LONG", "95001", "100500")])
        _, second = self.add_verdict([(C25, "LONG", "95001", "100500"), (C27, "LONG", "95001", "100500")],
                                     written_at=first + MINUTE)
        self.market.tickers([
            (first + 150, "100010", "100011", "100010", "100", "100"),
            (second + 150, "100010", "100011", "100010", "100", "100"),
        ])
        self.books_replay()
        opened = self.by_book("position_opened")
        self.assertEqual(len(opened[key(C25)]), 1)
        self.assertEqual(len(opened[key(C27)]), 1)
        skipped = [b for b in self.by_book("verdict_considered")[key(C25)] if b["outcome"] == "skipped"]
        self.assertEqual([b["reason"] for b in skipped], ["position_open"])

    def test_a_strategy_with_no_signal_never_trades(self):
        _, written = self.add_verdict([(C25, "LONG", "95001", "100500")])
        self.market.tickers([(written + 150, "100010", "100011", "100010", "100", "100")])
        self.books_replay()
        self.assertEqual(set(self.by_book("position_opened")), {key(C25)})

    def test_replay_is_deterministic_and_restart_resumes_the_same_chain(self):
        _, written = self.add_verdict([
            (C25, "LONG", "95001", "100500"), (C26, "SHORT", "105001", "99500"),
        ])
        self.market.tickers([(written + 150, "100010", "100011", "100010", "100", "100")])
        first = self.books_replay("a.sqlite")
        second = self.books_replay("b.sqlite")
        self.assertEqual(first, second)
        # Running again on the same DB re-derives and matches every stored event.
        self.assertEqual(self.books_replay("a.sqlite"), first)
        books = {json.loads(r[2])["body"].get("book") for r in account_rows(self.path("a.sqlite"))}
        self.assertEqual(books, {key(C25), key(C26)})

    def test_state_snapshots_restore_every_book(self):
        _, written = self.add_verdict([
            (C25, "LONG", "95001", "100500"), (C26, "SHORT", "105001", "99500"),
        ])
        self.market.tickers([(written + 150, "100010", "100011", "100010", "100", "100")])
        plain = self.books_replay("plain.sqlite")
        store = AccountStore(self.path("snap.sqlite"), BOOKS_EXECUTION_CONFIG)
        process_available(self.market.path, self.verdicts.path, store, snapshot_every_events=1)
        self.assertGreater(store.snapshot_seq, 0)
        store.close()
        restored = AccountStore(self.path("snap.sqlite"), BOOKS_EXECUTION_CONFIG)
        self.assertEqual(len(restored.restored[0]["books"]), 4 * len(BOOKS_EXECUTION_CONFIG["products"]))
        process_available(self.market.path, self.verdicts.path, restored)
        self.assertEqual(restored.head_hash, plain)
        restored.close()

    def test_every_pinned_product_has_its_own_books_and_lot(self):
        _, written = self.add_verdict([(C25, "LONG", "1900", "2100")], product="PF_ETHUSD")
        self.market.tickers([(written + 150, "2000.0", "2000.2", "2000.1", "50", "50")], product="PF_ETHUSD")
        # A BTC tick right after must not fill the ETH book, and BTC books have no signal.
        self.market.tickers([(written + 160, "100010", "100011", "100010", "100", "100")])
        self.books_replay()
        opened = self.by_book("position_opened")
        self.assertEqual(set(opened), {key(C25, "PF_ETHUSD")})
        quantity = Decimal(opened[key(C25, "PF_ETHUSD")][0]["quantity"])
        self.assertEqual(quantity % Decimal("0.001"), 0)
        self.assertEqual(opened[key(C25, "PF_ETHUSD")][0]["product_id"], "PF_ETHUSD")
        self.assertLessEqual(quantity * Decimal("2000.2"), Decimal("100"))
        self.assertGreater(quantity * Decimal("2000.2"), Decimal("97"))

    def test_the_same_strategy_trades_two_products_independently(self):
        _, written = self.add_verdict([(C25, "LONG", "1900", "2100")], product="PF_ETHUSD")
        self.add_verdict([(C25, "SHORT", "105001", "99500")])
        self.market.tickers([(written + 150, "2000.0", "2000.2", "2000.1", "50", "50")], product="PF_ETHUSD")
        self.market.tickers([(written + 160, "100010", "100011", "100010", "100", "100")])
        self.books_replay()
        opened = self.by_book("position_opened")
        self.assertEqual(opened[key(C25, "PF_ETHUSD")][0]["side"], "long")
        self.assertEqual(opened[key(C25)][0]["side"], "short")


class FundingProductsTests(unittest.TestCase):
    def test_funding_unit_per_product(self):
        from balancita_engine.futures_instruments import funding_unit
        self.assertEqual(funding_unit("PF_XBTUSD"), "USD/BTC/hour")
        self.assertEqual(funding_unit("PF_ETHUSD"), "USD/ETH/hour")
        with self.assertRaises(ValueError):
            funding_unit("PF_X")

    def test_each_product_has_its_own_funding_stream(self):
        import sqlite3
        import tempfile
        from balancita_engine.futures_paper_execution import _FundingSource, _MarketReader
        from test_futures_paper_execution import MARKET_DDL
        products = [BTC, "PF_ETHUSD"]
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "market.sqlite")
            db = sqlite3.connect(path)
            db.executescript(MARKET_DDL)
            db.execute("ALTER TABLE paper_futures_funding_periods ADD COLUMN product_id TEXT NOT NULL DEFAULT 'PF_XBTUSD'")
            for number, (product, unit) in enumerate([(BTC, "USD/BTC/hour"), ("PF_ETHUSD", "USD/ETH/hour")]):
                db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", ("r%d" % number, 5, "t", "{}"))
                db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                           ("r%d" % number, 1000, 4600, "0.5", 5, unit, product))
            db.commit()
            db.close()
            reader = _MarketReader(path, 1.0, products)
            source = _FundingSource({}, products)
            items = []
            while source.peek(reader, None) is not None:
                items.append(source.pop())
            self.assertEqual([(i["product_id"], i["data"]["unit"]) for i in items],
                             [(BTC, "USD/BTC/hour"), ("PF_ETHUSD", "USD/ETH/hour")])
            resumed = _FundingSource(source.state(), products)
            self.assertIsNone(resumed.peek(reader, None))


if __name__ == "__main__":
    unittest.main()
