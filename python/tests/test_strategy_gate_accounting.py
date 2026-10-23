"""Small deterministic fixtures for observed versus definitive gate accounting."""

import json
import unittest

from balancita_engine import strategy_gate_accounting as a
from balancita_engine import strategy_gate as g
from balancita_engine.futures_costs import COST_MODEL_VERSION


def trade(**changes):
    row = dict(side="LONG", entry_time_ms=0, exit_time_ms=1000, entry_price="100",
               exit_price="101", quantity="1", notional_usd="100", pnl_usd=0.9, net_bp=90.0,
               funding_usd=0.0, funding_status="complete", funding_complete=True,
               funding_covered_ms=1000, funding_held_ms=1000, exit_reason="target")
    row.update(changes)
    return row


def classified(**changes):
    return a.classify(trade(**changes), cost_model_version=COST_MODEL_VERSION)


class AccountingTests(unittest.TestCase):
    def test_complete_measured_zero_keeps_the_books_net_without_another_debit(self):
        out = classified()
        self.assertEqual(out["schema"], "balancita.strategy-gate-accounting.v1")
        self.assertEqual(out["state"], "complete")
        self.assertEqual((out["definitive_net_usd"], out["definitive_net_bp"]), (0.9, 90.0))
        self.assertEqual(out["funding_bp"], 0.0)

    def test_unknown_and_partial_amounts_remain_observed_not_definitive(self):
        for status, amount, covered in (("unknown", None, 0), ("partial", -0.02, 400)):
            with self.subTest(status=status):
                out = classified(funding_status=status, funding_usd=amount,
                                 funding_complete=False, funding_covered_ms=covered)
                self.assertEqual(out["state"], "provisional")
                self.assertEqual(out["observed_net_bp"], 90.0)
                self.assertIsNone(out["definitive_net_usd"])
                self.assertIsNone(out["definitive_net_bp"])
                self.assertEqual(out["funding_bp"], None if amount is None else -2.0)
                self.assertEqual(out["funding_time_share"], None if status == "unknown" else 0.4)

    def test_signed_measured_funding_is_never_reinverted_by_side(self):
        for side in ("LONG", "SHORT"):
            for amount in (-0.1, 0, 0.1):
                with self.subTest(side=side, amount=amount):
                    self.assertAlmostEqual(classified(side=side, funding_usd=amount)["funding_bp"], amount * 100)
                    self.assertEqual(classified(side=side, funding_usd=amount)["definitive_net_usd"], 0.9)

    def test_legacy_flags_and_missing_cost_identity_cannot_certify(self):
        legacy = trade()
        del legacy["funding_complete"]
        self.assertEqual(a.classify(legacy)["state"], "unclassified")
        self.assertIsNone(a.classify(legacy)["funding_time_share"])
        out = a.classify(trade())
        self.assertEqual(out["cost_evidence"], "unclassified")
        self.assertIsNone(out["definitive_net_bp"])

    def test_invalid_or_missing_evidence_never_certifies_zero(self):
        for field in ("funding_usd", "pnl_usd", "net_bp", "entry_price", "quantity", "notional_usd"):
            for value in (None, "bad", "NaN", float("inf"), True):
                with self.subTest(field=field, value=value):
                    out = classified(**{field: value})
                    self.assertIsNone(out["definitive_net_bp"])
        for changes in (dict(funding_covered_ms=1001), dict(funding_held_ms=-1),
                        dict(funding_status="complete", funding_complete=False),
                        dict(funding_covered_ms=None)):
            with self.subTest(changes=changes):
                self.assertIsNone(classified(**changes)["definitive_net_usd"])

    def test_recorded_source_cannot_borrow_current_cost_evidence(self):
        class Provider:
            def candles(self, *args):
                return [{"bucket_start": 0, "close": "100"}], []
        out = g.simulate_task(dict(index=0, label="recorded", spec={}, product="PF_XBTUSD", tick="0.5",
                                   start_ms=0, end_ms=2000, provider=Provider(), funding=[],
                                   trade_source=lambda *args: ([trade()], 0), want_closes=True))
        for row in (out["trades"][0], out["full_trades"][0]):
            self.assertEqual(row["accounting"]["cost_evidence"], "unclassified")
            self.assertIsNone(row["accounting"]["definitive_net_usd"])
        self.assertEqual(out["trades"][0]["net_bp"], 90.0)

    def test_unknown_identity_and_overflow_cannot_be_complete(self):
        self.assertEqual(a.classify(trade(), cost_model_version="future.v9")["cost_evidence"], "unclassified")
        self.assertIsNone(classified(funding_usd=1e308, notional_usd="0.001")["funding_bp"])
        self.assertIsNone(classified(funding_usd=1e308, notional_usd="0.001")["definitive_net_bp"])
        self.assertEqual(a.stored(dict(schema=a.SCHEMA, state="complete",
                                       metric_population=a.METRIC_POPULATION))["state"], "unclassified")

    def test_public_unknown_funding_is_nullable_but_observed_adapter_is_explicit(self):
        compact = g._compact("PF_XBTUSD", trade(funding_usd=None, funding_status="unknown",
                                                funding_complete=False, funding_covered_ms=0))
        self.assertIsNone(compact["funding_bp"])
        self.assertEqual(compact["observed_funding_bp"], 0.0)
        self.assertIsNone(compact["accounting"]["definitive_net_bp"])

    def test_empty_censored_and_legacy_summaries_are_distinct(self):
        empty = a.summarize([], minimum_complete_share=0.95)
        self.assertEqual(empty["state"], "no_trades")
        self.assertIsNone(empty["funding_complete_share"])
        self.assertIsNone(empty["funding_eligible"])
        self.assertIsNone(empty["definitive_net_bp"])
        censored = a.summarize([], minimum_complete_share=0.95, open_at_end=1)
        self.assertEqual(censored["state"], "censored")
        self.assertEqual(censored["open_at_end"], 1)
        self.assertEqual(a.stored(None)["state"], "unclassified")
        self.assertEqual(a.stored({"schema": "future"})["state"], "unclassified")

    def test_count_policy_is_separate_from_time_and_complete_net(self):
        rows = [dict(trade(), accounting=classified()) for _ in range(96)]
        rows += [dict(trade(funding_status="partial"), accounting=classified(
            funding_status="partial", funding_complete=False, funding_covered_ms=500)) for _ in range(4)]
        out = a.summarize(rows, minimum_complete_share=0.95)
        self.assertEqual((out["closed_trades"], out["definitive_trades"]), (100, 96))
        self.assertEqual(out["funding_complete_share"], 0.96)
        self.assertTrue(out["funding_eligible"])
        self.assertEqual(out["funding_time_share"], 0.98)
        self.assertIsNone(out["definitive_net_bp"])
        self.assertEqual(out["observed_net_bp"], 9000.0)
        rows[-1]["accounting"] = classified(funding_status="unknown", funding_complete=False,
                                             funding_usd=None, funding_covered_ms=0)
        self.assertIsNone(a.summarize(rows, minimum_complete_share=0.95)["funding_time_share"])


class SavedSummaryTests(unittest.TestCase):
    def summary(self, **changes):
        row = dict(trade(**changes), accounting=classified(**changes))
        return a.summarize([row], minimum_complete_share=0.95)

    def assertRejected(self, payload):
        self.assertEqual(a.stored(payload), a.stored(None))

    def test_json_safe_corruption_probe_is_not_complete(self):
        payload = a.summarize([], minimum_complete_share=0.95)
        payload.update(state="complete", observed_net_usd="invalid", definitive_net_usd="invalid",
                       observed_net_bp=10, definitive_net_bp=10)
        self.assertRejected(json.loads(json.dumps(payload, allow_nan=False)))

    def test_saved_numeric_types_shares_and_counts_are_validated(self):
        numeric = ("observed_net_usd", "observed_net_bp", "definitive_net_usd", "definitive_net_bp",
                   "funding_complete_share", "minimum_complete_share", "funding_time_share",
                   "funding_covered_ms", "funding_held_ms")
        counts = ("closed_trades", "open_at_end", "definitive_trades", "provisional_trades",
                  "funding_complete_count", "funding_evidence_complete_count",
                  "cost_evidence_complete_count", "funding_time_known_trades")
        for field in numeric:
            for bad in ("invalid", "1", True, [], {}, float("nan"), float("inf")):
                with self.subTest(field=field, bad=bad):
                    self.assertRejected(dict(self.summary(), **{field: bad}))
        for field in counts:
            for bad in (-1, 1.5, 1.0, "1", True, None):
                with self.subTest(field=field, bad=bad):
                    self.assertRejected(dict(self.summary(), **{field: bad}))
        for field in ("funding_complete_share", "minimum_complete_share", "funding_time_share"):
            for bad in (-0.01, 1.01):
                with self.subTest(field=field, bad=bad):
                    self.assertRejected(dict(self.summary(), **{field: bad}))
        for field in ("funding_covered_ms", "funding_held_ms"):
            self.assertRejected(dict(self.summary(), **{field: -1}))
        for bad in (0, 1, "true", None):
            self.assertRejected(dict(self.summary(), funding_eligible=bad))
        self.assertRejected(dict(self.summary(), scope="portfolio"))
        self.assertRejected(dict(self.summary(), metric_population="definitive_only"))
        for field in self.summary():
            payload = self.summary()
            del payload[field]
            with self.subTest(missing=field):
                self.assertRejected(payload)

    def test_state_counts_amounts_and_coverage_must_agree(self):
        for changes in (dict(closed_trades=0), dict(open_at_end=1), dict(definitive_trades=0),
                        dict(provisional_trades=1), dict(funding_evidence_complete_count=0),
                        dict(cost_evidence_complete_count=0), dict(funding_complete_count=2),
                        dict(funding_time_known_trades=2), dict(observed_net_usd=None),
                        dict(definitive_net_bp=None), dict(definitive_net_usd=5),
                        dict(observed_net_bp=5), dict(funding_covered_ms=1001),
                        dict(funding_complete_share=0.5), dict(funding_eligible=False),
                        dict(funding_time_share=0.5), dict(funding_time_share=None),
                        dict(funding_time_known_trades=0), dict(funding_held_ms=None),
                        dict(funding_covered_ms=None), dict(funding_covered_ms=500, funding_time_share=0.5),
                        dict(state="no_trades"),
                        dict(state="censored"), dict(state="unclassified"), dict(state="provisional")):
            with self.subTest(changes=changes):
                self.assertRejected(dict(self.summary(), **changes))
        unknown = self.summary(funding_usd=None, funding_status="unknown", funding_complete=False,
                               funding_covered_ms=0)
        for key in ("definitive_net_usd", "definitive_net_bp"):
            self.assertRejected(dict(unknown, **{key: 0}))
        self.assertRejected(dict(unknown, funding_time_share=0))
        empty = a.summarize([], minimum_complete_share=0.95)
        self.assertRejected(dict(empty, observed_net_bp=0))
        for payload in (empty, a.summarize([], minimum_complete_share=0.95, open_at_end=1),
                        a.summarize([trade()], minimum_complete_share=0.95)):
            for field in ("definitive_net_usd", "definitive_net_bp"):
                with self.subTest(state=payload["state"], field=field):
                    self.assertRejected(dict(payload, **{field: 0}))

    def test_all_real_summary_states_survive_json_round_trip(self):
        partial = self.summary(funding_status="partial", funding_complete=False, funding_covered_ms=400)
        unknown = self.summary(funding_usd=None, funding_status="unknown", funding_complete=False,
                               funding_covered_ms=0)
        legacy_row = trade()
        legacy = a.summarize([legacy_row], minimum_complete_share=0.95)
        complete_row = dict(trade(), accounting=classified())
        mixed_rows = [complete_row] * 96 + [dict(trade(funding_status="partial"),
                     accounting=classified(funding_status="partial", funding_complete=False,
                                           funding_covered_ms=500))] * 4
        mixed = a.summarize(mixed_rows, minimum_complete_share=0.95)
        self.assertTrue(mixed["funding_eligible"])
        cases = [self.summary(), self.summary(pnl_usd=0, net_bp=0), self.summary(pnl_usd=-1, net_bp=-100),
                 partial, unknown, legacy, mixed, a.summarize([], minimum_complete_share=0.95),
                 a.summarize([], minimum_complete_share=0.95, open_at_end=1),
                 a.summarize([complete_row], minimum_complete_share=0.95, open_at_end=1),
                 self.summary(funding_covered_ms=0, funding_held_ms=0),
                 self.summary(funding_covered_ms=None, funding_held_ms=None),
                 a.summarize([{"net_bp": 5, "funding_status": "complete"}], minimum_complete_share=0.8),
                 a.summarize([dict(trade(net_bp=1e308, pnl_usd=1e308),
                                  accounting=classified(net_bp=1e308, pnl_usd=1e308))] * 2,
                             minimum_complete_share=0.95)]
        self.assertEqual({p["state"] for p in cases},
                         {"complete", "provisional", "unclassified", "no_trades", "censored"})
        for payload in cases:
            with self.subTest(state=payload["state"], observed=payload["observed_net_usd"]):
                saved = json.loads(json.dumps(payload, allow_nan=False))
                self.assertEqual(a.stored(saved), saved)
        self.assertRejected(a.stored(None))  # The fallback is not full saved evidence.


if __name__ == "__main__":
    unittest.main()
