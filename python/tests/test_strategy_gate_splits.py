"""Temporal stability samples, not training/testing walk-forward."""

import copy
import unittest

from balancita_engine import strategy_gate as gate
from balancita_engine import strategy_gate_splits as splits
from balancita_engine.futures_purged import embargo_ms, purged_folds


def trade(entry, exit_, product="PF_XBTUSD", side="LONG", net=10):
    return {"entry_ms": entry, "exit_ms": exit_, "product": product, "side": side,
            "net_bp": net, "funding_status": "complete", "funding_bp": 0, "reason": "target"}


class BoundaryRegressionTests(unittest.TestCase):
    def test_cross_boundary_outcome_is_not_fold_evidence(self):
        crossing = trade(90, 110)
        samples, edges = gate.split_folds([crossing], 0, 200, 2)
        self.assertEqual(edges, [0, 100, 200])
        self.assertEqual(samples, [[], []])


class TemporalSamplesTests(unittest.TestCase):
    def split(self, trades, **kwargs):
        return splits.stability_samples(trades, 0, 400, 4, **kwargs)

    def test_boundaries_embargo_and_containment_across_sides_and_products(self):
        trades = [trade(0, 100), trade(90, 101), trade(100, 101), trade(124, 130),
                  trade(125, 200, "PF_ETHUSD", "SHORT"), trade(150, 160),
                  trade(200, 201), trade(225, 300), trade(325, 400), trade(399, 401),
                  trade(-1, 1), trade(400, 400)]
        before = copy.deepcopy(trades)
        samples, meta = self.split(trades)
        self.assertEqual([[t["entry_ms"] for t in sample] for sample in samples],
                         [[0], [125, 150], [225], [325]])
        self.assertEqual(trades, before)
        self.assertEqual(meta["embargo_ms"], 25)
        self.assertEqual(meta["excluded_reasons"],
                         {"crosses_fold_end": 2, "embargo": 3, "entry_out_of_range": 2})
        self.assertEqual((meta["used_trades"], meta["excluded_trades"]), (5, 7))
        self.assertEqual([r["embargo_ms"] for r in meta["folds"]], [0, 25, 25, 25])
        self.assertEqual(meta["folds"][1]["usable_from_ms"], 125)
        self.assertEqual(samples[1][0]["side"], "SHORT")
        self.assertEqual(samples[1][0]["product"], "PF_ETHUSD")

    def test_long_multifold_hold_is_purged_once_and_legacy_cap_is_reused(self):
        samples, meta = self.split([trade(10, 350)])
        self.assertEqual(samples, [[], [], [], []])
        self.assertEqual(meta["excluded_reasons"], {"crosses_fold_end": 1})
        self.assertEqual(meta["embargo_ms"], 25)
        self.assertEqual(meta["state"], "insufficient")

    def test_legacy_parity_for_bounded_closed_trades(self):
        trades = [trade(0, 10), trade(95, 110), trade(100, 110), trade(125, 150),
                  trade(220, 230), trade(330, 400)]
        legacy = [dict(entry_time_ms=t["entry_ms"], exit_time_ms=t["exit_ms"],
                       net_bp=t["net_bp"], pnl_usd=t["net_bp"] / 100) for t in trades]
        samples, meta = self.split(trades)
        blocks = purged_folds(legacy, 0, 400, 4)
        self.assertEqual(meta["embargo_ms"], embargo_ms(legacy, 100))
        for sample, evidence, block in zip(samples, meta["folds"], blocks):
            self.assertEqual((len(sample), evidence["excluded"]), (block["trades"], block["dropped"]))
            self.assertEqual(evidence["from_ms"], block["start_ms"])
            self.assertEqual(evidence["to_ms"], block["end_ms"])

    def test_no_new_minimum_embargo_and_nondivisible_gate_edges_are_preserved(self):
        _, meta = self.split([trade(1, 4)])
        self.assertEqual(meta["embargo_ms"], 3)
        _, meta = self.split([trade(1, 1)])
        self.assertEqual(meta["embargo_ms"], 0)  # Measured zero hold, not a new default.
        _, meta = splits.stability_samples([trade(1, 4)], 0, 403, 4)
        self.assertEqual([r["to_ms"] for r in meta["folds"]], [100, 201, 302, 403])

    def test_empty_sparse_open_and_unsupported_are_not_measured_zero(self):
        samples, empty = self.split([])
        self.assertEqual(empty["state"], "no_trades")
        self.assertIsNone(empty["embargo_ms"])
        self.assertEqual(len(samples), 4)
        _, sparse = self.split([trade(1, 4)])
        self.assertEqual(sparse["folds"][0]["sample_state"], "single_trade")
        self.assertEqual(sparse["folds"][1]["sample_state"], "no_trades")
        _, opened = self.split([trade(10, None)], open_at_end=1)
        self.assertEqual(opened["state"], "censored")
        self.assertEqual(opened["excluded_reasons"], {"open_at_cut": 1})
        self.assertEqual(opened["open_at_end"], 2)
        samples, unknown = self.split([trade(1, 4)], embargo_supported=False)
        self.assertEqual(samples, [[], [], [], []])
        self.assertEqual(unknown["state"], "unsupported")
        self.assertIsNone(unknown["embargo_ms"])
        self.assertEqual(unknown["excluded_reasons"], {"unsupported_embargo": 1})
        self.assertFalse(unknown["training_testing_walk_forward"])

    def test_relabelled_unsupported_metadata_cannot_claim_observed_evidence(self):
        _, payload = self.split([trade(1, 4)], embargo_supported=False)
        payload["state"] = "observed"
        self.assertEqual(splits.stored(payload)["state"], "unknown")

    def test_saved_semantic_contradictions_and_json_types_are_rejected(self):
        _, valid = self.split([trade(1, 4), trade(125, 130)])
        changes = [("state", "observed"), ("embargo_supported", False), ("embargo_supported", 1),
                   ("embargo_ms", None), ("embargo_ms", -1), ("embargo_ms", True), ("embargo_ms", 26),
                   ("embargo_ms", "5"), ("embargo_source", "invented"), ("embargo_source", []),
                   ("embargo_max_fold_share", "0.25"), ("embargo_max_fold_share", 0.5),
                   ("from_ms", "0"), ("to_ms", 0), ("from_ms", False), ("fold_count", True),
                   ("input_trades", True), ("used_trades", -1), ("open_at_end", 1),
                   ("training_testing_walk_forward", True), ("entry_bounds", "inclusive"),
                   ("exit_bound", "exit<to"), ("reasons", []), ("reasons", "empty_folds"),
                   ("excluded_reasons", {"unknown": 0})]
        for key, value in changes:
            with self.subTest(field=key, value=value):
                self.assertEqual(splits.stored(dict(valid, **{key: value}))["state"], "unknown")
        row_changes = [("index", 2), ("index", True), ("from_ms", 1), ("to_ms", 99),
                       ("usable_from_ms", 4), ("embargo_ms", 1), ("used", 2), ("used", True),
                       ("excluded", -1), ("sample_state", "observed"),
                       ("excluded_reasons", {"embargo": 1}), ("excluded_reasons", {"open_at_cut": False})]
        for key, value in row_changes:
            payload = copy.deepcopy(valid)
            payload["folds"][0][key] = value
            with self.subTest(row_field=key, value=value):
                self.assertEqual(splits.stored(payload)["state"], "unknown")
        for key in valid:
            payload = copy.deepcopy(valid)
            del payload[key]
            with self.subTest(missing=key):
                self.assertEqual(splits.stored(payload)["state"], "unknown")
        _, excluded = self.split([trade(90, 110), trade(-1, 1), trade(1, None)])
        for counts in ({"crosses_fold_end": 3}, {"crosses_fold_end": 1, "entry_out_of_range": 2},
                       {"crosses_fold_end": 1, "entry_out_of_range": 1, "open_at_cut": True}):
            with self.subTest(exclusions=counts):
                self.assertEqual(splits.stored(dict(excluded, excluded_reasons=counts))["state"], "unknown")

    def test_every_current_producer_state_round_trips_without_recertification(self):
        import json
        dense = [trade(i * 100 + offset, i * 100 + offset + 2)
                 for i in range(4) for offset in (30, 40)]
        cases = [self.split(dense)[1], self.split([])[1], self.split([trade(1, 4)])[1],
                 self.split([], open_at_end=1)[1], self.split([trade(1, 4)], open_at_end=1)[1],
                 self.split([trade(1, None)])[1], self.split([trade(1, 0)])[1],
                 self.split([trade(90, 310), trade(-1, 1)])[1], self.split([trade(1, 1)])[1],
                 self.split([trade(1, 4)], embargo_supported=False)[1],
                 self.split([], embargo_supported=False, open_at_end=1)[1],
                 splits.stability_samples(dense, 0, 403, 4)[1]]
        self.assertEqual({v["state"] for v in cases},
                         {"observed", "no_trades", "insufficient", "censored", "unsupported"})
        for value in cases:
            with self.subTest(state=value["state"], reasons=value["reasons"]):
                saved = json.loads(json.dumps(value, allow_nan=False))
                self.assertEqual(splits.stored(saved), saved)

    def test_saved_metadata_is_copied_and_old_metadata_is_unknown(self):
        _, meta = self.split([trade(1, 4)])
        self.assertEqual(splits.stored(meta), meta)
        saved = splits.stored(meta)
        saved["folds"][0]["used"] = 999
        self.assertEqual(meta["folds"][0]["used"], 1)
        for invalid in (None, {}, {"schema": "old"}, dict(meta, input_trades=999)):
            self.assertEqual(splits.stored(invalid)["state"], "unknown")


if __name__ == "__main__":
    unittest.main()
