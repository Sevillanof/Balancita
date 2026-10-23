"""Evaluation scope is producer-owned metadata, not a replacement for the statistical verdict."""

import io
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from balancita_engine import strategy_gate as gate


class PolicyTests(unittest.TestCase):
    def test_baseline_contract_never_certifies_full_policy(self):
        from balancita_engine import strategy_evaluation_policy as policy

        self.assertEqual(policy.require_mode("baseline_only"), "baseline_only")
        meta = policy.metadata()
        self.assertEqual(meta["schema"], "balancita.strategy-evaluation-policy.v1")
        self.assertEqual(meta["classification"], "baseline_only")
        self.assertEqual(meta["account_scope"], "independent_fixed_notional")
        self.assertEqual(meta["notional_per_trade_usd"], "100")
        self.assertFalse(meta["qwen_open_decisions_replayed"])
        self.assertFalse(meta["full_policy_validated"])
        self.assertIn("qwen_open_not_replayed", meta["reasons"])
        self.assertEqual(policy.stored(meta), meta)
        meta["reasons"].clear()
        self.assertTrue(policy.metadata()["reasons"])

    def test_unsupported_and_malformed_modes_never_default_to_baseline(self):
        from balancita_engine import strategy_evaluation_policy as policy

        for mode in ("full_policy", "", "baseline", None, False, 1, [], {}):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                policy.require_mode(mode)

    def test_missing_invalid_and_model_metadata_stay_unclassified(self):
        from balancita_engine import strategy_evaluation_policy as policy

        for value in (None, {}, [], "baseline_only", {"classification": "full_policy"},
                      dict(policy.metadata(), full_policy_validated=True),
                      dict(policy.metadata(), schema="future.v2")):
            with self.subTest(value=value):
                meta = policy.stored(value)
                self.assertEqual(meta["classification"], "unclassified")
                self.assertIsNone(meta["account_scope"])
                self.assertIsNone(meta["qwen_open_decisions_replayed"])
                self.assertFalse(meta["full_policy_validated"])
        model = policy.metadata(recorded_model=True)
        self.assertEqual(model["classification"], "unclassified")
        self.assertIn("recorded_model_trades_not_policy_replay", model["reasons"])


class GatePolicyTests(unittest.TestCase):
    def test_rejection_precedes_config_model_data_and_database_access(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, "untouched")
            for mode in ("full_policy", "", None, [], {}):
                with self.subTest(mode=mode), patch.object(gate, "load_config") as config, \
                        patch.object(gate.strategy_models, "model_subject") as model, \
                        patch.object(gate, "KrakenProvider") as provider, \
                        patch.object(gate, "open_db") as db:
                    with self.assertRaisesRegex(gate.GateError, "modo de evaluación"):
                        gate.evaluate("c31-qwen-exit-perp-v1", kind="exam", data_dir=target,
                                      evaluation_mode=mode)
                    for untouched in (config, model, provider, db):
                        untouched.assert_not_called()
                    self.assertFalse(os.path.exists(target))

    def test_cli_refuses_full_policy_without_creating_a_run(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, "untouched")
            with patch("sys.stderr", new_callable=io.StringIO) as err:
                code = gate.main(["--data-dir", target, "evaluate", "--strategy", "c25-pullback-perp-v1",
                                  "--evaluation-mode", "full_policy", "--exam"])
            self.assertEqual(code, 2)
            self.assertIn("modo de evaluación", err.getvalue())
            self.assertFalse(os.path.exists(target))

    def test_new_run_persists_scope_in_params_summary_report_and_cli_event(self):
        start = 1736467200000  # 2025-01-10 UTC
        candle = {"bucket_start": start, "open": "100", "high": "101", "low": "99",
                  "close": "100", "volume_btc": "1"}
        provider = Mock()
        provider.candles.return_value = ([candle], [candle])
        provider.funding.return_value = []
        cfg = dict(gate.load_config(), default_from="2025-01-10", holdout_from="2025-01-11",
                   default_products=["PF_XBTUSD"], random_draws=2, bootstrap_draws=2)
        with tempfile.TemporaryDirectory() as root:
            stream = io.StringIO()
            out = gate.evaluate("c25-pullback-perp-v1", cfg=cfg, data_dir=root, provider=provider,
                                jobs=1, neighbors=False, json_progress=True, stream=stream)
            meta = out["evaluation_policy"]
            self.assertEqual(meta["classification"], "baseline_only")
            self.assertFalse(meta["full_policy_validated"])
            self.assertEqual(out["result"]["evaluation_policy"], meta)
            db = gate.open_db(os.path.join(root, gate.DB_NAME), readonly=True)
            try:
                params = json.loads(db.execute("SELECT params FROM runs").fetchone()[0])
            finally:
                db.close()
            self.assertEqual(params["evaluation_policy"], meta)
            with open(os.path.join(root, "artifacts", str(out["run_id"]), "manifest.json")) as handle:
                self.assertEqual(json.load(handle)["summary"]["evaluation_policy"], meta)
            with open(out["report_path"]) as handle:
                self.assertIn("baseline_only", handle.read())
            self.assertEqual(json.loads(stream.getvalue().splitlines()[-1])["evaluation_policy"], meta)
            # Metadata does not alter the judge's numerical/statistical contract.
            self.assertEqual(out["verdict"], "NO PASA")
            self.assertEqual(out["result"]["overall"]["n"], 0)


if __name__ == "__main__":
    unittest.main()
