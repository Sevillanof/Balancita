"""PR 105: the historical validation machinery (episodes, bootstrap, Holm, verdict rules, frozen protocol, sealed reserve)."""

import os
import random
import tempfile
import unittest

from balancita_engine import multi_validation as mv
from balancita_engine.multi_experiment import Experiment
from balancita_engine.multi_signals import default_strategies
from balancita_engine.multi_store import DecisionStore

from test_futures_spec_strategy import START
from test_multi_pr104 import LONG, PRODUCT, market_db, OPEN_STORES, tearDownModule  # noqa: F401
from test_multi_strategy import FUNDING

FIVE = 300_000


def cand(strategy, product, action, cycle, sid=None):
    return {"signal_id": sid or "{}-{}-{}-{}".format(strategy, product, action, cycle), "product_id": product,
            "cycle_ms": cycle, "strategy_id": strategy, "strategy_version": 1, "action": action, "strength": "0.8",
            "reason": "x"}


def store_with(candidates, outcomes=None):
    store = DecisionStore()
    OPEN_STORES.append(store)
    for c in candidates:
        store.put_candidate(c)
    for sid, outcome in (outcomes or {}).items():
        store.put_candidate_outcome(sid, outcome)
    return store


class EpisodeTests(unittest.TestCase):
    def test_a_persistent_signal_is_one_episode_and_a_gap_or_a_new_side_starts_another(self):
        base = START
        run = [cand("s", "P", "BUY", base + i * FIVE) for i in range(30)]  # 2.5 h of the same condition
        later = [cand("s", "P", "BUY", base + (30 + 13 + i) * FIVE) for i in range(3)]  # after > 1 h of silence
        other = [cand("s", "P", "SELL", base + 5 * FIVE)]
        elsewhere = [cand("s", "Q", "BUY", base + 5 * FIVE)]
        eps = mv.episodes(store_with(run + later + other + elsewhere))
        by = {(e["product_id"], e["action"], e["cycle_ms"]): e for e in eps}
        self.assertEqual(len(eps), 4)
        self.assertEqual(by[("P", "BUY", base)]["evaluations"], 30)
        self.assertEqual(by[("P", "BUY", base + 43 * FIVE)]["evaluations"], 3)
        self.assertEqual(by[("P", "BUY", base)]["hourly_observations"], 3)

    def test_only_complete_outcomes_are_judged(self):
        a, b = cand("s", "P", "BUY", START), cand("s", "P", "BUY", START + 100 * FIVE)
        outcome = {"status": "closed", "net_bp": 12.0, "net_usd": 1.2, "entry_time_ms": START, "exit_time_ms": START + 1000}
        eps = mv.episodes(store_with([a, b], {a["signal_id"]: outcome, b["signal_id"]: {"status": "closed", "net_bp": None,
                                                                                    "net_usd": None, "exit_time_ms": 9}}))
        self.assertEqual(len(eps), 2)
        self.assertEqual(len(mv.judged(eps)), 1)


class StatisticsTests(unittest.TestCase):
    def test_holm_adjusts_in_order_and_never_exceeds_one(self):
        adjusted = mv.holm({"a": 0.01, "b": 0.02, "c": 0.04})
        self.assertEqual(adjusted, {"a": 0.03, "b": 0.04, "c": 0.04})
        self.assertEqual(mv.holm({"a": 0.6, "b": 0.7})["b"], 1.0)

    def test_bootstrap_separates_a_real_mean_from_noise_and_is_reproducible(self):
        rng = random.Random(3)
        noise = [rng.gauss(0, 10) for _ in range(180)]
        edge = [x + 8 for x in noise]
        flat = mv.stationary_bootstrap(noise, "x")
        good = mv.stationary_bootstrap(edge, "x")
        self.assertGreater(flat["p_one_sided"], 0.05)
        self.assertLess(good["p_one_sided"], 0.01)
        self.assertGreater(good["ci95"][0], 0)
        self.assertEqual(mv.stationary_bootstrap(edge, "x"), good)

    def test_dsr_drops_when_more_trials_are_assumed(self):
        rng = random.Random(4)
        series = [rng.gauss(0.3, 3) for _ in range(180)]
        few, many = mv.deflated_sharpe(series, 4, 0.05), mv.deflated_sharpe(series, 60, 0.05)
        self.assertGreater(few, many)

    def test_daily_series_assigns_pnl_to_the_exit_day_and_stress_costs_more(self):
        day = 1_791_000_000_000 // mv.DAY_MS * mv.DAY_MS
        e = {"product_id": PRODUCT, "net_usd": 1.0, "exit_time_ms": day + 5 * mv.DAY_MS // 2}
        plain = mv.daily_series([e], day, day + 4 * mv.DAY_MS)
        self.assertEqual(plain, [0.0, 0.0, 1.0, 0.0])
        self.assertLess(mv.daily_series([e], day, day + 4 * mv.DAY_MS, 30)[2], 1.0)


class VerdictTests(unittest.TestCase):
    PROTO = {"min_episodes": 300, "min_active_days": 60, "alpha": 0.05, "max_product_share": 0.5}

    def row(self, **kw):
        base = {"independent_episodes": 400, "active_days": 120,
                "daily_net_pnl": {"ci95": [0.1, 2.0], "mean_daily_usd": 1, "p_one_sided": 0.001}, "holm_adjusted_p": 0.003,
                "stress_30bp": {"ci95": [0.05, 1.5]}, "positive_thirds": 3, "top_product_share": 0.3,
                "random_control": {"p_control": 0.02}}
        base.update(kw)
        return base

    def test_small_samples_are_insufficient_not_negative(self):
        self.assertTrue(mv.verdict(self.row(independent_episodes=40), self.PROTO).startswith("evidencia insuficiente"))

    def test_every_check_must_hold(self):
        self.assertTrue(mv.verdict(self.row(), self.PROTO).startswith("pasa validacion"))
        for change in ({"holm_adjusted_p": 0.2}, {"positive_thirds": 1}, {"top_product_share": 0.8},
                       {"stress_30bp": {"ci95": [-0.1, 1]}}, {"random_control": {"p_control": 0.3}}):
            self.assertTrue(mv.verdict(self.row(**change), self.PROTO).startswith("no pasa"), change)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = market_db(self.dir.name, *LONG)
        self.first, self.last = START + 6000 * 60_000, START + 9000 * 60_000

    def test_run_resumes_and_analysis_reports_every_section_without_overclaiming(self):
        messages = []
        products = [(PRODUCT, "1")]
        for _ in range(2):
            mv.run_history(self.db, self.dir.name, "real", self.first, self.last, products, chunk_days=1, say=messages.append, funding_periods=FUNDING)
        self.assertTrue(any("resumed" in m for m in messages))
        # the controls only need to exist structurally here
        mv.run_history(self.db, self.dir.name, "controls", self.first, self.last, products, chunk_days=1, say=messages.append, funding_periods=FUNDING)
        real = DecisionStore(os.path.join(self.dir.name, "real.sqlite"))
        controls = DecisionStore(os.path.join(self.dir.name, "controls.sqlite"))
        try:
            self.assertEqual(real.signals() and all(s["action"] != "WAIT" for s in real.signals()), True)  # waits are not kept
            proto = mv.protocol(self.last, [PRODUCT])
            report = mv.analyze(real, controls, proto, (self.first, self.last))
        finally:
            real.close()
            controls.close()
        self.assertEqual(set(report["strategies"]), {s.id for s in default_strategies()})
        for row in report["strategies"].values():
            self.assertTrue(row["verdict"].startswith(("evidencia insuficiente", "no pasa")), row["verdict"])  # 3 days of data
            self.assertLessEqual(row["independent_episodes"], row["candidates_evaluated_every_5_min"])
        judged_total = sum(r["episodes"] for r in report["strategies"].values())
        self.assertGreater(judged_total, 0)  # with funding the episodes have complete net results
        self.assertIn("combiner_vs_strategies", report)
        self.assertIn("pbo_diagnostic", report)

    def test_protocol_is_frozen_and_the_final_reserve_runs_once(self):
        proto = mv.protocol(self.last, [PRODUCT])
        mv.write_protocol(self.dir.name, proto)
        mv.write_protocol(self.dir.name, proto)  # same protocol: fine
        with self.assertRaises(SystemExit):
            mv.write_protocol(self.dir.name, mv.protocol(self.last, [PRODUCT], min_episodes=10))
        with open(os.path.join(self.dir.name, "holdout.lock"), "w") as handle:
            handle.write("{}")
        end = "2026-10-01"
        with self.assertRaises(SystemExit):
            mv.main(["holdout", "--market-db", self.db, "--out", self.dir.name, "--end", end])
        self.assertEqual(mv.span(mv.DAY_MS * 1000)["holdout_start_ms"], mv.DAY_MS * 1000 - mv.HOLDOUT_DAYS * mv.DAY_MS)

    def test_controls_are_reproducible_and_do_not_feed_the_combiner(self):
        a, b = mv.control_strategies(seeds=2), mv.control_strategies(seeds=2)
        self.assertEqual([s.id for s in a], [s.id for s in b])
        self.assertEqual(len(a), 2 * len(mv.CONTROL_HORIZONS))


if __name__ == "__main__":
    unittest.main()
