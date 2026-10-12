import copy
import unittest

from balancita_engine.futures_paper_execution import PAPER_EXECUTION_CONFIG
from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from balancita_engine.futures_strategy_plan import all_plans, kronos_plan, qwen_exit_plan, spec_plan

SPECS = load_specs()
# Frozen: reliability and forward trades are bound to these hashes; a plan must never move them.
GOLDEN_HASHES = {
    "c25-pullback-perp-v1": "f61f87676ca938c9deb2e966a05c4b0578e97133ffb151e372dfa26304b693fc",
    "c26-reversion-perp-v1": "a3c2f54faa1301e5a8171bab8afd26b4223ebbd2bc59795e7579d2a1d457ae57",
    "c27-breakout-perp-v1": "81fb82c817b5887daad3c972aeeb7d1bd5e36f268b295f0264463629dccee280",
    "c28-adapter-perp-v1": "2b06c3ee07b6cf6d9552bde928a995dce21891e9d36ffd7eae53bca1e5439f2f",
    "c29-momentum-perp-v1": "ca81f9ce070d1db8410e9a8b06688555d9c80e33fd6f6eab056f84d8d452f871",
    "c30-momentum-12h-perp-v1": "29de8c4ff4d53cd477a1689508035455d402bd57aa6028390bd2a7e8f54da2e1",
    "c32-funding-contrarian-24h-perp-v1": "1481148d45aea9b0969d0a5a4a37126d002ccf1f8c14d504338ee7279cba7612",
}


class StrategyPlanTest(unittest.TestCase):
    def test_spec_hash_unchanged_and_input_untouched(self):
        for spec in SPECS.values():
            before, digest = copy.deepcopy(spec), spec_hash(spec)
            plan = spec_plan(spec)
            self.assertEqual(spec, before)
            self.assertEqual(plan["spec_hash"], digest)
            self.assertEqual(spec_plan(spec), plan)

    def test_every_strategy_has_the_same_fields(self):
        keys = None
        for plan in all_plans(SPECS).values():
            if plan["signal"]["type"] == "regime_adapter":
                continue
            keys = keys or set(plan)
            self.assertEqual(set(plan), keys, plan["id"])
            self.assertEqual(set(plan["exit"]), {"stop_atr", "target_stop_ratio", "volatility", "time_minutes", "rule"})

    def test_shipped_spec_hashes_are_frozen(self):
        self.assertEqual({k: spec_hash(v) for k, v in SPECS.items()}, GOLDEN_HASHES)

    def test_all_shipped_strategies_are_covered(self):
        plans = all_plans(SPECS)
        for strategy_id in SPECS:
            self.assertIn(strategy_id, plans)
        self.assertIn("c31-qwen-exit-perp-v1", plans)
        self.assertIn("kronos-small-1h-h4-v1", plans)

    def test_time_stop_of_c25_c28_matches_live_d(self):
        for strategy_id in ("c25-pullback-perp-v1", "c26-reversion-perp-v1", "c27-breakout-perp-v1"):
            self.assertEqual(spec_plan(SPECS[strategy_id])["exit"]["time_minutes"] * 60_000,
                             PAPER_EXECUTION_CONFIG["time_stop_ms"])
        for branch in spec_plan(SPECS["c28-adapter-perp-v1"])["branches"].values():
            self.assertEqual(branch["exit"]["time_minutes"] * 60_000, PAPER_EXECUTION_CONFIG["time_stop_ms"])

    def test_fixed_notional_is_100_everywhere(self):
        for plan in all_plans(SPECS).values():
            self.assertEqual(plan["size"], {"mode": "fixed_notional", "notional_usd": "100"})

    def test_c29_values(self):
        plan = spec_plan(SPECS["c29-momentum-perp-v1"])
        self.assertEqual(plan["exit"]["time_minutes"], 1440)
        self.assertEqual(plan["exit"]["stop_atr"], "2")
        self.assertEqual(plan["exit"]["volatility"], "5m.logvol288")

    def test_kronos_descriptor_matches_the_lab_constants(self):
        from kronos_lab import lab
        plan = kronos_plan()
        self.assertEqual(plan["id"], lab.STRATEGY_ID)
        self.assertEqual(plan["exit"]["time_minutes"], lab.HORIZON * 60)
        self.assertEqual(plan["signal"]["threshold_cost_multiple"], lab.K)
        self.assertEqual(plan["size"]["notional_usd"], str(lab.NOTIONAL))

    def test_freeze_list_names_real_strategies(self):
        from balancita_engine.futures_strategy_plan import load_freeze
        self.assertEqual(set(load_freeze()["ids"]), set(all_plans(SPECS)))

    def test_qwen_exit_plan(self):
        self.assertEqual(qwen_exit_plan()["signal"]["entry_specs"][0], "c25-pullback-perp-v1")


if __name__ == "__main__":
    unittest.main()
