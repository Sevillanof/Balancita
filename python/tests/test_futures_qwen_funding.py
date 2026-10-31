from decimal import Decimal as D
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_qwen_trader as qt


class ExactFundingTests(unittest.TestCase):
    def module(self):
        from balancita_engine import futures_qwen_funding
        return futures_qwen_funding

    def history(self, rates=None):
        f = self.module()
        return f.from_public("PF_ETHUSD", {
            "result": "success", "rates": rates or [
                {"timestamp": "2026-01-01T13:00:00Z", "fundingRate": "18.5", "relativeFundingRate": "0.0005"},
            ],
        }, known_at_ms=qt.date_ms("2026-01-02"))

    def test_uses_absolute_quantity_and_elapsed_time_not_entry_notional(self):
        history = self.history()
        start = qt.date_ms("2026-01-01") + 13 * qt.HOUR_MS + 30 * qt.MINUTE_MS
        end = start + 30 * qt.MINUTE_MS
        paid, covered = history.accrue(start, end, D("4"), False)
        self.assertEqual(paid, D("-37"))
        self.assertEqual(covered, 30 * qt.MINUTE_MS)
        self.assertEqual(history.accrue(start, end, D("4"), True)[0], D("37"))

    def test_live_public_adapter_keeps_the_absolute_period_records(self):
        from balancita_engine import futures_qwen_live as live
        history = self.history()
        feed = live.PublicFeed("unused", fetch_funding_fn=lambda product: history)
        self.assertIs(feed.funding("PF_ETHUSD"), history)

    def test_missing_hours_remain_unknown_instead_of_charging_another_exchange(self):
        history = self.history()
        start = qt.date_ms("2026-01-01") + 13 * qt.HOUR_MS
        paid, covered = history.accrue(start, start + 2 * qt.HOUR_MS, D("4"), True)
        self.assertEqual(paid, D("74"))
        self.assertEqual(covered, qt.HOUR_MS)
        funding = self.module()
        with self.assertRaises(ValueError):
            funding.from_public("ETHUSDT", {"rates": []}, known_at_ms=start)
        with self.assertRaises(ValueError):
            funding.from_public("PF_ETHUSD", {"rates": [{"fundingTime": start, "fundingRate": "0.001"}]}, known_at_ms=start)

    def test_settlement_pins_the_legacy_basis_and_uses_exact_basis_for_new_positions(self):
        f = self.module()
        line = qt.FundingLine(self.history())
        start = qt.date_ms("2026-01-01") + 13 * qt.HOUR_MS + 30 * qt.MINUTE_MS
        position = qt.Position(side="SHORT", entry_ms=start, entry_px=D("38000"), qty=D("4"),
                               notional_usd=D("152000"), funding_model=f.EXACT_MODEL)
        exact = qt.settle("PF_ETHUSD", position, 38000, "strategy_exit", start + 30 * qt.MINUTE_MS, line, D("152000"))
        self.assertEqual(exact["funding_usd"], D("-37"))
        position.funding_model = f.LEGACY_MODEL
        legacy = qt.settle("PF_ETHUSD", position, 38000, "strategy_exit", start + 30 * qt.MINUTE_MS, line, D("152000"))
        self.assertEqual(legacy["funding_usd"], D("-38"))

    def test_invalid_rates_and_conflicting_periods_fail_explicitly(self):
        row = {"timestamp": "2026-01-01T13:00:00Z", "fundingRate": "NaN", "relativeFundingRate": "0.0005"}
        with self.assertRaises(ValueError):
            self.history([row])
        row["fundingRate"] = "18.5"
        with self.assertRaises(ValueError):
            self.history([row, dict(row, fundingRate="19")])

    def test_public_local_archive_preserves_units_product_and_provenance(self):
        f = self.module()
        start = qt.date_ms("2026-01-01")
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "market.sqlite")
            db = sqlite3.connect(path)
            db.executescript(
                "CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT,start_ms INTEGER,end_ms INTEGER,"
                "funding_rate TEXT,known_at INTEGER,unit TEXT,product_id TEXT)")
            db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                       ("a" * 64, start, start + qt.HOUR_MS, "0.123", start + qt.HOUR_MS, "USD/ETH/hour", "PF_ETHUSD"))
            db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                       ("b" * 64, start, start + qt.HOUR_MS, "999", start + qt.HOUR_MS, "USD/BTC/hour", "PF_XBTUSD"))
            db.commit()
            db.close()
            history = f.from_archive(path, "PF_ETHUSD", until_ms=start + qt.HOUR_MS)
            self.assertEqual(history.accrue(start, start + qt.HOUR_MS, D("2"), True)[0], D("0.246"))
            self.assertEqual(history.periods[0].response_sha256, "a" * 64)
            self.assertEqual(history.product, "PF_ETHUSD")
            line = qt.FundingLine(history)
            self.assertTrue(line)
            trader = qt.Trader(
                qt.load_config(qt.CONFIG_PATH_LIVE), "PF_ETHUSD", None, line)
            self.assertIs(trader.funding, line)

    def test_training_labels_use_observed_entry_exit_prices_and_the_shared_settlement(self):
        from balancita_engine import futures_qwen_independent_gate as gate
        start = qt.date_ms("2026-01-01") + 13 * qt.HOUR_MS + 30 * qt.MINUTE_MS
        end = start + 12 * qt.HOUR_MS
        rates = [
            {"timestamp": qt.time.strftime("%Y-%m-%dT%H:00:00Z", qt.time.gmtime(at / 1000)),
             "fundingRate": "18.5", "relativeFundingRate": "0.0005"}
            for at in range(start - 30 * qt.MINUTE_MS, end, qt.HOUR_MS)
        ]
        funding = self.history(rates)
        history = mock.Mock()
        history.bars.return_value = [
            {"bucket_start": start - qt.BAR_MS, "close": "38000"},
            {"bucket_start": end - qt.BAR_MS, "close": "39000"},
        ]
        row = dict.fromkeys(gate.FEATURES, 0.1)
        row.update(t_ms=start, product="PF_ETHUSD", close=38000, move_720=999999)
        rows, skipped = gate.funded_examples([row], history, funding, end + qt.HOUR_MS)
        self.assertEqual(skipped, {"missing_price": 0, "missing_funding": 0})
        self.assertEqual(rows[0]["funding_model"], self.module().EXACT_MODEL)
        entry = qt.entry_fill(D("38000"), "LONG", "PF_ETHUSD")
        position = qt.Position(side="LONG", entry_ms=start, entry_px=entry, qty=D(100) / entry,
                               funding_model=self.module().EXACT_MODEL)
        expected = qt.settle("PF_ETHUSD", position, 39000, "strategy_exit", end, qt.FundingLine(funding), D(100))
        self.assertEqual(rows[0]["long_net_bp"], expected["net_bp"])
        self.assertNotEqual(rows[0]["move_720"], row["move_720"])


if __name__ == "__main__":
    unittest.main()
