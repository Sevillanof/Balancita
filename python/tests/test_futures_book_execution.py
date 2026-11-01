import json
import unittest
from decimal import Decimal as D, localcontext

from balancita_engine import futures_book_execution as book


BASE = 1_793_462_400_000


def snapshot(bids=None, asks=None, *, at=BASE, product="PF_ETHUSD"):
    body = {
        "result": "success",
        "serverTime": book.utc_text(at),
        "orderBook": {
            "bids": bids or [["0.1", "999"], ["99", "2"], ["100", "0.2"]],
            "asks": asks or [["102", "2"], ["101", "0.2"]],
        },
    }
    return book.BookSnapshot.from_response(
        json.dumps(body).encode(), product, requested_at_ms=at, received_at_ms=at + 100,
    )


class BookExecutionTests(unittest.TestCase):
    def executor(self, snap=None, *, now=BASE + 200):
        return book.BookExecution(lambda product: snap or snapshot(), lambda: now)

    def test_normalizes_both_sides_and_ignores_zero_quantity(self):
        snap = snapshot(bids=[["0.1", "999"], ["101", "0"], ["100", "0.2"], ["99", "2"]])
        self.assertEqual(snap.bids[0], (D("100"), D("0.2")))
        self.assertEqual(snap.asks[0], (D("101"), D("0.2")))
        self.assertEqual(snap.mid, D("100.5"))

    def test_entry_walks_actual_depth_and_preserves_budget(self):
        fill = self.executor().entry("PF_ETHUSD", "LONG", D("50"), BASE)
        self.assertGreater(fill.price, D("101"))
        self.assertLess(fill.price, D("102"))
        self.assertLessEqual(fill.notional, D("50"))
        self.assertEqual(len(fill.levels), 2)
        self.assertEqual(fill.fee, fill.notional * D("0.0005"))
        self.assertEqual(fill.signal_at_ms, BASE)
        self.assertEqual(fill.decision_at_ms, BASE + 200)
        self.assertEqual(fill.executed_at_ms, BASE + 200)
        self.assertEqual(fill.quote.requested_at_ms, BASE)

    def test_short_entry_and_fixed_quantity_exit_use_correct_sides(self):
        fill = self.executor().entry("PF_ETHUSD", "SHORT", D("30"), BASE)
        self.assertLess(fill.price, D("100"))
        closing = self.executor().exit("PF_ETHUSD", "SHORT", fill.quantity, BASE)
        self.assertGreaterEqual(closing.price, D("101"))
        self.assertEqual(closing.quantity, fill.quantity)

    def test_insufficient_depth_never_invents_a_partial_fill(self):
        with self.assertRaises(book.BookError) as error:
            self.executor().entry("PF_ETHUSD", "LONG", D("1000000"), BASE)
        self.assertEqual(error.exception.kind, "liquidez_insuficiente")
        with self.assertRaises(book.BookError):
            self.executor().exit("PF_ETHUSD", "LONG", D("1000000"), BASE)

    def test_stale_quote_and_late_execution_are_rejected(self):
        with self.assertRaises(book.BookError) as error:
            self.executor(now=BASE + 4000).entry("PF_ETHUSD", "LONG", D("10"), BASE)
        self.assertEqual(error.exception.kind, "libro_obsoleto")
        with self.assertRaises(book.BookError) as error:
            self.executor(now=BASE + 200).entry("PF_ETHUSD", "LONG", D("10"), BASE - 16000)
        self.assertEqual(error.exception.kind, "ejecucion_tarde")

    def test_deadline_is_checked_again_after_fetch(self):
        now = [BASE]
        def delayed(product):
            now[0] += 16000
            return snapshot(at=now[0] - 100)
        execution = book.BookExecution(delayed, lambda: now[0])
        with self.assertRaises(book.BookError) as error:
            execution.entry("PF_ETHUSD", "LONG", D("10"), BASE)
        self.assertEqual(error.exception.kind, "ejecucion_tarde")

    def test_invalid_books_and_products_fail_explicitly(self):
        for bids, asks in (
            ([["102", "1"]], [["101", "1"]]),
            ([["100", "-1"]], [["101", "1"]]),
            ([["100", "NaN"]], [["101", "1"]]),
        ):
            with self.subTest(bids=bids), self.assertRaises(book.BookError):
                snapshot(bids, asks)
        with self.assertRaises(book.BookError):
            self.executor().entry("ETHUSDT", "LONG", D("10"), BASE)
        with self.assertRaises(book.BookError):
            self.executor().entry("PF_ETHUSD", "INVALID", D("10"), BASE)
        with self.assertRaises(book.BookError):
            self.executor().entry("PF_ETHUSD", "LONG", D("-1"), BASE)

    def test_raw_numeric_tokens_keep_decimal_precision(self):
        raw = (
            '{"result":"success","serverTime":"' + book.utc_text(BASE) +
            '","orderBook":{"bids":[[100.123456789012345678,1]],'
            '"asks":[[100.223456789012345678,1]]}}'
        ).encode()
        snap = book.BookSnapshot.from_response(raw, "PF_ETHUSD", requested_at_ms=BASE, received_at_ms=BASE + 100)
        self.assertEqual(snap.bids[0][0], D("100.123456789012345678"))

    def test_invalid_server_time_has_a_repository_error_code(self):
        raw = b'{"result":"success","serverTime":"invalid","orderBook":{"bids":[[100,1]],"asks":[[101,1]]}}'
        with self.assertRaises(book.BookError) as error:
            book.BookSnapshot.from_response(raw, "PF_ETHUSD", requested_at_ms=BASE, received_at_ms=BASE + 100)
        self.assertEqual(error.exception.kind, "libro_invalido")

    def test_fill_evidence_does_not_depend_on_ambient_decimal_precision(self):
        expected = self.executor().entry("PF_ETHUSD", "LONG", D("50"), BASE).evidence()
        with localcontext() as ctx:
            ctx.prec = 10
            observed = self.executor().entry("PF_ETHUSD", "LONG", D("50"), BASE).evidence()
        self.assertEqual(observed, expected)


if __name__ == "__main__":
    unittest.main()
