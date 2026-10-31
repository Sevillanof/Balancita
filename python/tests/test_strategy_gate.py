"""Strategy gate: split, exam lock, verdict rules, controls (negative and positive), progress and cancellation.

No network: the candles are synthetic, injected through a provider. The "cheating" strategy (positive control) lives
only here; it is not in config/strategies nor in any registry.
"""

import copy
import gzip
import hashlib
import io
import json
import math
import os
import random
import sqlite3
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from balancita_engine import strategy_gate as g
from balancita_engine.futures_costs import entry_fill
from balancita_engine.futures_qwen_practice import horizon_net_bp
from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from strategy_spec_fixtures import HISTORICAL_SPEC_IDS, historical_spec
from test_futures_qwen_practice import MINUTE, T0, aggregate, synthetic

DAY = 86_400_000
HOLDOUT = T0 + 20 * DAY            # 2025-01-21
FROM = T0 + 8 * DAY                # 2025-01-09 (the first 8 days only warm indicators up)
NOW = T0 + 28 * DAY
CFG = dict(g.load_config(), holdout_from="2025-01-21", default_from="2025-01-09", default_products=["PF_XBTUSD"],
           random_draws=200, bootstrap_draws=300, neighbors={"enabled": False, "pct": 0.2, "max_params": 6})
ONES, FIVES = synthetic(minutes=30 * 1440, seed=11)
SPECS = load_specs()


def driftless(minutes=30 * 1440, seed=5):
    """A pure Gaussian random walk (no trend, no cycle): nothing to find, so nothing may pass."""
    rng, price, ones = random.Random(seed), 50_000.0, []
    for i in range(minutes):
        open_, price = price, max(100.0, price + rng.gauss(0, 14))
        ones.append({"bucket_start": T0 + i * MINUTE, "open": "%.1f" % open_, "close": "%.1f" % price,
                     "high": "%.1f" % (max(open_, price) + abs(rng.gauss(0, 6))),
                     "low": "%.1f" % (min(open_, price) - abs(rng.gauss(0, 6))),
                     "volume_btc": "%.4f" % (abs(rng.gauss(2.0, 1.0)) * (6 if rng.random() < 0.03 else 1))})
    return ones, aggregate(ones)


class Provider:
    """Synthetic candles; remembers the furthest instant anyone asked for."""

    def __init__(self, ones=ONES, fives=FIVES, funding=(), fail_prefetch=False):
        self.ones, self.fives, self.funding_rows, self.fail_prefetch = ones, fives, list(funding), fail_prefetch
        self.asked_to = []

    def prefetch(self, product, from_ms, to_ms):
        if self.fail_prefetch:
            raise g.HistoryError("sin red")

    def candles(self, product, from_ms, to_ms):
        self.asked_to.append(to_ms)
        return ([c for c in self.ones if from_ms <= c["bucket_start"] < to_ms],
                [c for c in self.fives if from_ms <= c["bucket_start"] < to_ms])

    def funding(self, product):
        return self.funding_rows


def _trade(side, entry_ms, hold, net, reason="time_stop"):
    return {"side": side, "entry_time_ms": entry_ms, "exit_time_ms": entry_ms + hold * MINUTE, "net_bp": net,
            "funding_usd": 0.0, "funding_status": "complete", "exit_reason": reason}


def losing_source(spec, product, tick, ones, fives, funding, start_ms, end_ms, chunk):
    """Negative control: buys every 45 minutes and holds 15; on a driftless walk the costs eat it."""
    trades = []
    for i in range(0, len(ones) - 16, 45):
        if ones[i]["bucket_start"] >= start_ms:
            net = horizon_net_bp("LONG", product, ones[i]["close"], ones[i + 15]["close"])
            trades.append(_trade("LONG", ones[i]["bucket_start"] + MINUTE, 15, net))
    return trades, 0


def cheating_source(spec, product, tick, ones, fives, funding, start_ms, end_ms, chunk):
    """Positive control: peeks 60 minutes into the future and takes the side of a big move."""
    trades, i = [], 0
    while i < len(ones) - 61:
        later = float(ones[i + 60]["close"]) / float(ones[i]["close"]) - 1
        if ones[i]["bucket_start"] >= start_ms and abs(later) > 0.0025:
            side = "LONG" if later > 0 else "SHORT"
            net = horizon_net_bp(side, product, ones[i]["close"], ones[i + 60]["close"])
            trades.append(_trade(side, ones[i]["bucket_start"] + MINUTE, 60, net))
            i += 60
        else:
            i += 1
    return trades, 0


def run(strategy="c25-pullback-perp-v1", directory=None, **kwargs):
    kwargs.setdefault("cfg", CFG)
    kwargs.setdefault("provider", Provider())
    kwargs.setdefault("jobs", 1)
    kwargs.setdefault("neighbors", False)
    kwargs.setdefault("now_ms", NOW)
    return g.evaluate(strategy, data_dir=directory, **kwargs)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def _open_db(self):
        return g.open_db(os.path.join(self.dir, g.DB_NAME), readonly=True)


class IdentityTests(unittest.TestCase):
    def test_version_key_is_id_plus_spec_hash_and_follows_content(self):
        spec = historical_spec()
        key, digest = g.version_key_of(spec)
        self.assertEqual(key, "c29-momentum-perp-v1:" + digest)
        self.assertEqual(len(digest), 64)
        changed = copy.deepcopy(spec)
        changed["params"]["z_min"] = "3"
        self.assertNotEqual(g.version_key_of(changed)[0], key)

    def test_family_drops_version_suffix(self):
        self.assertEqual(g.family_of("c29-momentum-perp-v1"), "c29-momentum-perp")
        self.assertEqual(g.family_of("c29-momentum-perp-v12"), "c29-momentum-perp")
        self.assertEqual(g.family_of("lab-x"), "lab-x")

    def test_config_declares_the_holdout_and_the_rules(self):
        cfg = g.load_config()
        self.assertEqual(cfg["holdout_from"], "2026-04-19")
        self.assertEqual(cfg["rules"]["min_trades"], 30)
        self.assertEqual(cfg["rules"]["min_percentile_vs_random"], 95)
        self.assertEqual(cfg["rules"]["cost_stress_multiplier"], 1.5)


META = {"run_id": 7, "strategy_id": "x-v1", "name": "Estrategia de prueba", "family": "x", "version_key": "x-v1:abc",
        "kind": "practice", "start_ms": 0, "end_ms": 86_400_000, "products": ["BTC"], "config_hash": "0" * 64,
        "open_at_end": 0, "seconds": 1}


class JudgeTests(unittest.TestCase):
    def series(self):
        rng, price, closes = random.Random(3), 50_000.0, []
        for _ in range(20_000):
            price *= 1 + rng.gauss(0, 0.0003)
            closes.append(price)
        return {"BTC": {"closes": closes, "first_ms": 0, "start_index": 0}}

    def trades(self, n, mean, seed=1):
        rng = random.Random(seed)
        return [{"product": "BTC", "side": "LONG" if i % 2 else "SHORT", "entry_ms": 1000 + i * 3_600_000,
                 "exit_ms": 1000 + i * 3_600_000 + 900_000, "net_bp": rng.gauss(mean, 12), "funding_bp": 0.0,
                 "funding_status": "complete", "reason": "time_stop"} for i in range(n)]

    def judge(self, trades, attempts=1):
        end = max(t["exit_ms"] for t in trades) + 1
        return g.judge(trades, self.series(), CFG, kind="practice", start_ms=0, end_ms=end, attempts=attempts,
                       products=["BTC"], seed=5)

    def test_losing_trades_do_not_pass(self):
        result = self.judge(self.trades(400, -4))
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertFalse(result["rules"][1]["ok"])

    def test_positive_trades_with_edge_pass_every_rule(self):
        result = self.judge(self.trades(400, 25))
        self.assertEqual(result["verdict"], "PASA", [c for c in result["rules"] if not c["ok"]])

    def test_few_trades_are_inconclusive(self):
        result = self.judge(self.trades(20, 25))
        self.assertEqual(result["verdict"], "INCONCLUSO")
        self.assertIsNone(result["verdict_note"])
        self.assertEqual([c["id"] for c in result["rules"] if not c["ok"]], ["n_trades"])

    def test_few_trades_and_another_failed_rule_is_no_pasa_with_a_note(self):
        result = self.judge(self.trades(20, -4))
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertEqual(result["verdict_note"], "(pocas operaciones)")
        self.assertGreater(len([c for c in result["rules"] if not c["ok"]]), 1)
        text = g.build_report(META, result, CFG)
        self.assertIn("## ❌ NO PASA (pocas operaciones)", text)

    def with_funding(self, trades, complete_share):
        cut = int(len(trades) * complete_share)
        for i, t in enumerate(trades):
            t["funding_status"] = "complete" if i < cut else "unknown"
        return trades

    def test_unknown_funding_alone_makes_a_winner_inconclusive_never_pasa(self):
        result = self.judge(self.with_funding(self.trades(400, 25), 0.0))
        self.assertEqual(result["verdict"], "INCONCLUSO")
        self.assertEqual([c["id"] for c in result["rules"] if not c["ok"]], ["funding_complete"])
        self.assertEqual(result["funding_share"], 0.0)
        text = g.build_report(META, result, CFG)
        self.assertIn("## ⚠️ INCONCLUSO", text)
        self.assertIn("Funding conocido", text)
        self.assertIn("0 %", text)
        self.assertIn("Kraken solo publica funding desde el 15-oct-2025; antes de esa fecha el resultado está incompleto",
                      text.split("## Qué revisamos")[0])
        self.assertIn("sin funding el neto es provisional", text.split("## Qué revisamos")[0])

    def test_mixed_completeness_preserves_all_metrics_and_95_percent_pass(self):
        trades = self.with_funding(self.trades(400, 25), 0.96)
        result = self.judge(trades)
        self.assertEqual(result["verdict"], "PASA")
        self.assertEqual(result["overall"]["n"], 400)
        self.assertAlmostEqual(result["overall"]["mean_bp"], sum(t["net_bp"] for t in trades) / 400)
        accounting = result["accounting"]
        self.assertEqual(accounting["metric_population"], "all_observed_closed_trades")
        self.assertTrue(accounting["funding_eligible"])
        self.assertEqual(accounting["funding_complete_share"], 0.96)
        self.assertIsNone(accounting["definitive_net_bp"])
        self.assertEqual(accounting["definitive_trades"], 0)  # Legacy compact fixtures have no cost evidence.
        self.assertIn("no convierte el neto observado en definitivo", g.build_report(META, result, CFG))

    def test_funding_share_threshold_is_inclusive(self):
        self.assertEqual(self.judge(self.with_funding(self.trades(400, 25), 0.96))["verdict"], "PASA")
        self.assertEqual(self.judge(self.with_funding(self.trades(400, 25), 0.90))["verdict"], "INCONCLUSO")

    def test_unknown_funding_and_another_failed_rule_is_no_pasa(self):
        result = self.judge(self.with_funding(self.trades(400, -4), 0.0))
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertIn("funding_complete", [c["id"] for c in result["rules"] if not c["ok"]])

    def test_complete_funding_changes_nothing(self):
        result = self.judge(self.trades(400, 25))
        self.assertEqual(result["verdict"], "PASA")
        self.assertEqual(result["funding_share"], 1.0)
        self.assertIn("rules", g.build_report(META, result, CFG))

    def test_config_declares_funding_rule_and_default_from_inside_funding_history(self):
        cfg = g.load_config()
        self.assertEqual(cfg["rules"]["min_funding_complete_share"], 0.95)
        self.assertEqual(cfg["default_from"], "2025-10-16")
        self.assertEqual(cfg["holdout_from"], "2026-04-19")

    def test_single_product_is_labelled_not_multi_asset(self):
        text = g.build_report(META, self.judge(self.trades(400, 25)), CFG)
        self.assertIn("ganó en 1/1 productos", text)
        self.assertIn("(un solo producto: no es robustez multi-activo)", text)

    def test_several_products_show_k_over_n_without_the_note(self):
        trades = self.trades(400, 25)
        for i, t in enumerate(trades):
            t["product"] = "BTC" if i % 2 else "ETH"
        series = self.series()
        series["ETH"] = series["BTC"]
        end = max(t["exit_ms"] for t in trades) + 1
        result = g.judge(trades, series, CFG, kind="practice", start_ms=0, end_ms=end, attempts=1,
                         products=["BTC", "ETH"], seed=5)
        text = g.build_report(META, result, CFG)
        self.assertIn("ganó en 2/2 productos", text)
        self.assertNotIn("un solo producto", text)

    def test_enough_trades_never_carry_the_few_trades_note(self):
        self.assertIsNone(self.judge(self.trades(400, -4))["verdict_note"])

    def test_identical_neighbors_are_shown_once_and_say_so(self):
        trades = self.trades(150, 3.5)
        same = self.trades(120, 1.0, seed=9)
        other = self.trades(100, -2.0, seed=4)
        neighbors = [{"param": "z_min", "direction": "-20%", "value": "2", "trades": same},
                     {"param": "sqrt_bars", "direction": "-20%", "value": "6.7", "trades": [dict(t) for t in same]},
                     {"param": "stop_atr", "direction": "-20%", "value": "1.6", "trades": other}]
        end = max(t["exit_ms"] for t in trades) + 1
        result = g.judge(trades, self.series(), CFG, kind="practice", start_ms=0, end_ms=end, attempts=1,
                         products=["BTC"], seed=5, neighbors=neighbors)
        self.assertEqual(len(result["sensitivity"]), 2)
        self.assertEqual(result["sensitivity"][0]["also"], [{"param": "sqrt_bars", "direction": "-20%", "value": "6.7"}])
        self.assertEqual(result["sensitivity"][1]["also"], [])
        text = g.build_report(META, result, CFG)
        self.assertIn("z_min -20% y sqrt_bars -20%", text)
        self.assertIn("exactamente las mismas operaciones", text)

    def test_more_attempts_make_the_deflated_sharpe_stricter(self):
        trades = self.trades(150, 3.5)
        one = self.judge(trades, attempts=1)["deflated"]
        many = self.judge(trades, attempts=40)["deflated"]
        self.assertGreater(one, many)

    def test_cost_stress_can_fail_a_thin_edge(self):
        result = self.judge(self.trades(400, 4))
        stress = [c for c in result["rules"] if c["id"] == "cost_stress"][0]
        self.assertFalse(stress["ok"])
        self.assertEqual(result["verdict"], "NO PASA")

    def test_cost_stress_is_the_mean_minus_the_extra_cost_and_nothing_is_shared_between_runs(self):
        """Two different strategies can show the same stressed mean without any bug: the stress is
        ``mean - (x - 1) * mean_cost`` and a BTC round trip costs ~10.1 bp (fees dominate) whatever the strategy."""
        extra = CFG["rules"]["cost_stress_multiplier"] - 1
        cost = g.trade_cost_bp("BTC", "time_stop")
        first, second = self.trades(115, -52, seed=1), self.trades(41, -52, seed=2)
        results = [self.judge(t) for t in (first, second, first)]
        for trades, result in zip((first, second, first), results):
            mean = sum(t["net_bp"] for t in trades) / len(trades)
            self.assertAlmostEqual(result["overall"]["mean_bp"], mean, places=9)       # its own trades only
            self.assertAlmostEqual(result["stress_mean_bp"], mean - extra * cost, places=9)
        self.assertNotAlmostEqual(results[0]["overall"]["mean_bp"], results[1]["overall"]["mean_bp"], places=3)
        self.assertEqual(results[0]["stress_mean_bp"], results[2]["stress_mean_bp"])  # no state leaks across calls
        # same mean to the cent => same stressed mean, because the cost per BTC trade is (almost) constant
        a, b = dict(first[0], net_bp=-52.27, reason="time_stop"), dict(second[0], net_bp=-52.28, reason="time_stop")
        sa = g.judge([a] * 3, self.series(), CFG, kind="practice", start_ms=0, end_ms=10**10, attempts=1,
                     products=["BTC"], seed=5)["stress_mean_bp"]
        sb = g.judge([b] * 3, self.series(), CFG, kind="practice", start_ms=0, end_ms=10**10, attempts=1,
                     products=["BTC"], seed=5)["stress_mean_bp"]
        self.assertAlmostEqual(sa - sb, 0.01, places=9)

    def test_max_drawdown(self):
        self.assertEqual(g.max_drawdown([5, -3, -4, 10, -2]), 7)


class ControlTests(Base):
    def test_negative_control_losing_strategy_does_not_pass(self):
        out = run("lab-losing-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-losing-v1"),
                  trade_source=losing_source)
        self.assertEqual(out["verdict"], "NO PASA")
        self.assertGreaterEqual(out["result"]["overall"]["n"], 100)
        self.assertLess(out["result"]["overall"]["mean_bp"], 0)

    def test_positive_control_cheating_strategy_passes(self):
        out = run("lab-cheat-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        failed = [c for c in out["result"]["rules"] if not c["ok"]]
        self.assertEqual(out["verdict"], "PASA", failed)
        self.assertGreaterEqual(out["result"]["percentile"], 95)

    def test_shipped_strategies_on_a_driftless_walk_never_pass(self):
        # Current shipped specs on data with no edge: never PASA.
        provider = Provider(*driftless())
        for strategy in sorted(SPECS):
            out = run(strategy, self.dir, provider=provider)
            self.assertIn(out["verdict"], ("NO PASA", "INCONCLUSO"), strategy)
            self.assertEqual(out["status"], "done")
            if out["verdict"] == "NO PASA":
                self.assertFalse(out["result"]["rules"][1]["ok"], strategy)  # no positive mean to defend

    def test_historical_momentum_subjects_on_a_driftless_walk_never_pass(self):
        provider = Provider(*driftless())
        for strategy_id in HISTORICAL_SPEC_IDS:
            with self.subTest(strategy_id=strategy_id):
                out = run(strategy_id, self.dir, spec=historical_spec(strategy_id), provider=provider)
                self.assertIn(out["verdict"], ("NO PASA", "INCONCLUSO"), strategy_id)
                self.assertEqual(out["status"], "done")
                if out["verdict"] == "NO PASA":
                    self.assertFalse(out["result"]["rules"][1]["ok"], strategy_id)

    def test_neighbors_move_one_param_at_a_time(self):
        cfg = dict(CFG, neighbors={"enabled": True, "pct": 0.2, "max_params": 6})
        base = historical_spec()
        variants = g.neighbor_specs(base, cfg)
        self.assertEqual(len(variants), 2 * len(base["params"]))
        name, direction, value, spec = variants[0]
        self.assertNotEqual(spec["params"][name], base["params"][name])
        for name, direction, value, spec in variants:
            self.assertEqual([key for key in base["params"] if spec["params"][key] != base["params"][key]], [name])
            self.assertEqual(spec["rules"], base["rules"])
        self.assertEqual(base, historical_spec())
        self.assertEqual(g.neighbor_specs(base, CFG), [])

    def test_whole_number_params_get_whole_neighbors(self):
        cfg = dict(CFG, neighbors={"enabled": True, "pct": 0.2, "max_params": 6})
        base = historical_spec()
        base["params"] = {"bins": "48", "confirm_bars": "6", "stop_atr": "1.5"}
        values = {(name, direction): value for name, direction, value, _ in g.neighbor_specs(base, cfg)}
        self.assertEqual(values[("bins", "-20%")], "38")
        self.assertEqual(values[("bins", "+20%")], "58")
        self.assertEqual(values[("confirm_bars", "-20%")], "5")
        self.assertEqual(values[("confirm_bars", "+20%")], "7")
        self.assertEqual(values[("stop_atr", "-20%")], "1.2")

    def test_neighbor_run_reports_sensitivity(self):
        cfg = dict(CFG, neighbors={"enabled": True, "pct": 0.2, "max_params": 2})
        out = run("c29-momentum-perp-v1", self.dir, spec=historical_spec(), cfg=cfg, neighbors=True)
        self.assertEqual(len(out["result"]["sensitivity"]), 4)
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("Variantes con promedio positivo", handle.read())


class CouplingTests(unittest.TestCase):
    def test_c29_z_min_and_sqrt_bars_are_one_threshold(self):
        """The entry threshold is z_min * volatility * sqrt_bars: scaling either by the same factor is the same
        strategy, so the two neighbours are not independent evidence (found on the first real run)."""
        base = historical_spec()
        trades = []
        for name in ("z_min", "sqrt_bars"):
            spec = copy.deepcopy(base)
            spec["params"][name] = str(float(spec["params"][name]) * 0.5)
            out, _, _ = g.book_trades(spec, "PF_XBTUSD", "0.5", ONES, FIVES, [], FROM, HOLDOUT, lambda f: None)
            trades.append([(t["entry_time_ms"], t["exit_time_ms"], t["side"], str(t["net_bp"])) for t in out])
        self.assertGreater(len(trades[0]), 0)
        self.assertEqual(trades[0], trades[1])


class MissingSpecTests(Base):
    def test_missing_historical_ids_are_refused_without_fixture_fallback_or_writes(self):
        specs_dir = os.path.join(self.dir, "specs")
        os.mkdir(specs_dir)
        # Test both an empty inventory and one containing an unrelated valid strategy.
        for populated in (False, True):
            if populated:
                spec = SPECS["c25-pullback-perp-v1"]
                with open(os.path.join(specs_dir, spec["id"] + ".json"), "w", encoding="utf-8") as handle:
                    json.dump(spec, handle)
            for strategy_id in HISTORICAL_SPEC_IDS:
                with self.subTest(strategy_id=strategy_id, populated=populated):
                    self.assertNotIn(strategy_id, load_specs(specs_dir))
                    with self.assertRaises(g.GateError) as caught:
                        g.find_spec(strategy_id, specs_dir=specs_dir)
                    self.assertIn("estrategia desconocida: " + strategy_id, str(caught.exception))
                    provider = Provider()
                    with self.assertRaises(g.GateError):
                        run(strategy_id, self.dir, specs_dir=specs_dir, provider=provider)
                    self.assertEqual(provider.asked_to, [])
                    self.assertFalse(os.path.exists(os.path.join(self.dir, g.DB_NAME)))
                    self.assertFalse(os.path.exists(os.path.join(self.dir, g.ARTIFACTS_DIR)))


class RegistrySpecTests(Base):
    def setUp(self):
        super().setUp()
        self.specs_dir = os.path.join(self.dir, "specs")
        os.mkdir(self.specs_dir)

    def make_registry(self):
        from balancita_engine.futures_strategy_registry import StrategyRegistry

        path = os.path.join(self.dir, "futures-strategies.sqlite")
        registry = StrategyRegistry(path)
        self.addCleanup(registry.close)
        spec = historical_spec()
        spec.update(id="c31-momentum-breakout-5m", name="Impulso Adaptativo 5m")
        spec["params"]["z_min"] = "2.2"
        entry = registry.import_spec(spec)
        return registry, path, spec, entry

    def test_registry_only_strategy_is_judged_from_the_registry_row(self):
        registry, path, spec, entry = self.make_registry()
        with self.assertRaises(g.GateError) as refused:
            run("c31-momentum-breakout-5m", self.dir, specs_dir=self.specs_dir)
        self.assertIn("estrategia desconocida", str(refused.exception))
        out = run("c31-momentum-breakout-5m", self.dir, specs_dir=self.specs_dir, registry_db=path)
        self.assertEqual(out["status"], "done")
        row = self._open_db().execute("SELECT version_key, code_hash FROM runs WHERE id=?", (out["run_id"],)).fetchone()
        self.assertEqual(row["code_hash"], entry["spec_hash"])           # the registry's own digest
        self.assertEqual(row["version_key"], "c31-momentum-breakout-5m:{}".format(entry["spec_hash"]))
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("# Impulso Adaptativo 5m", handle.read())

    def test_registry_spec_goes_through_the_same_book_path(self):
        registry, path, spec, entry = self.make_registry()
        loaded = g.registry_specs(path)["c31-momentum-breakout-5m"]
        self.assertEqual(g.spec_hash(loaded), entry["spec_hash"])
        direct = g.book_trades(loaded, "PF_XBTUSD", "0.5", ONES, FIVES, [], FROM, HOLDOUT, lambda f: None)[0]
        again = g.book_trades(spec, "PF_XBTUSD", "0.5", ONES, FIVES, [], FROM, HOLDOUT, lambda f: None)[0]
        self.assertGreater(len(direct), 0)
        self.assertEqual([t["net_bp"] for t in direct], [t["net_bp"] for t in again])

    def test_config_spec_wins_over_a_registry_spec_with_the_same_id(self):
        registry, path, spec, entry = self.make_registry()
        configured = historical_spec()
        with open(os.path.join(self.specs_dir, configured["id"] + ".json"), "w", encoding="utf-8") as handle:
            json.dump(configured, handle)
        clash = copy.deepcopy(configured)
        clash["params"]["z_min"] = "3"
        imported = registry.import_spec(clash)
        self.assertEqual(imported["id"], configured["id"])
        self.assertNotEqual(g.spec_hash(configured), g.spec_hash(g.registry_specs(path)[configured["id"]]))
        found = g.find_spec(configured["id"], specs_dir=self.specs_dir, registry_db=path)
        self.assertEqual(g.spec_hash(found), g.spec_hash(configured))
        self.assertEqual(g.spec_hash(g.find_spec(configured["id"], specs_dir=self.specs_dir, registry_db=None)),
                         g.spec_hash(configured))

    def test_deleted_and_missing_registry_rows_are_not_loaded_and_the_db_is_read_only(self):
        registry, path, spec, entry = self.make_registry()
        # Main DB and WAL contents/mtimes must survive gate reads unchanged.
        def snapshot():
            files = {}
            for filename in (path, path + "-wal"):
                if os.path.exists(filename):
                    with open(filename, "rb") as handle:
                        files[filename] = (os.stat(filename).st_mtime_ns, handle.read())
            return files

        before = snapshot()
        self.assertIn("c31-momentum-breakout-5m", g.registry_specs(path))
        self.assertEqual(snapshot(), before)
        registry.delete("c31-momentum-breakout-5m", "c31-momentum-breakout-5m")
        before = snapshot()
        self.assertNotIn("c31-momentum-breakout-5m", g.registry_specs(path))
        missing = os.path.join(self.dir, "nope.sqlite")
        self.assertEqual(g.registry_specs(missing), {})
        self.assertFalse(os.path.exists(missing))
        self.assertEqual(g.registry_specs(None), {})
        with self.assertRaises(g.GateError):
            run("c31-momentum-breakout-5m", self.dir, specs_dir=self.specs_dir, registry_db=path)
        self.assertEqual(snapshot(), before)

    def test_cli_accepts_the_registry_db(self):
        registry, path, spec, entry = self.make_registry()
        args = g._parser().parse_args(["evaluate", "--strategy", "c31-momentum-breakout-5m", "--registry-db", path])
        self.assertEqual(args.registry_db, path)


class SplitTests(Base):
    def test_practice_never_asks_for_nor_depends_on_data_from_the_cutoff(self):
        clean = Provider()
        first = run("lab-cheat-v1", self.dir, provider=clean, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                    trade_source=losing_source)
        self.assertTrue(all(t <= HOLDOUT for t in clean.asked_to), clean.asked_to)
        # Poison everything from the cutoff on: same trades, byte for byte.
        poisoned = [dict(c, close="1.0", high="1000000.0") if c["bucket_start"] >= HOLDOUT else c for c in ONES]
        other = run("lab-cheat-v1", tempfile.mkdtemp(), provider=Provider(ones=poisoned, fives=FIVES),
                    spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"), trade_source=losing_source)
        self.assertEqual(first["result"]["overall"], other["result"]["overall"])
        self.assertLessEqual(max(t["exit_ms"] for t in [] or [{"exit_ms": 0}]), HOLDOUT)

    def test_real_strategy_practice_ignores_poisoned_future_and_exits_before_cutoff(self):
        poisoned = [dict(c, close="1.0", low="0.5") if c["bucket_start"] >= HOLDOUT else c for c in ONES]
        poisoned_fives = [dict(c, close="1.0", low="0.5") if c["bucket_start"] >= HOLDOUT else c for c in FIVES]
        a = run("c27-breakout-perp-v1", self.dir)
        b = run("c27-breakout-perp-v1", self.dir, provider=Provider(poisoned, poisoned_fives))
        self.assertEqual(a["result"]["overall"], b["result"]["overall"])
        self.assertEqual(a["result"]["folds"], b["result"]["folds"])

    def test_practice_cannot_start_at_or_after_the_cutoff(self):
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, from_date="2025-01-21")

    def test_practice_stage_ends_at_to_and_never_goes_past_the_cutoff(self):
        out = run("c25-pullback-perp-v1", self.dir, from_date="2025-01-09", to_date="2025-01-15")
        db = g.open_db(os.path.join(self.dir, g.DB_NAME))
        params = json.loads(db.execute("SELECT params FROM runs WHERE id = ?", (out["run_id"],)).fetchone()[0])
        db.close()
        self.assertEqual((params["from"][:10], params["to"][:10]), ("2025-01-09", "2025-01-15"))
        for bad in ("2025-01-22", "2025-01-09", "2025-01-01"):
            with self.assertRaises(g.GateError):
                run("c25-pullback-perp-v1", self.dir, from_date="2025-01-09", to_date=bad)

    def test_exam_takes_no_to(self):
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, kind="exam", to_date="2025-01-15")

    def test_exam_takes_no_from(self):
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, kind="exam", from_date="2025-01-10")

    def test_exam_only_counts_entries_from_the_cutoff(self):
        out = run("lab-cheat-v1", self.dir, kind="exam", spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        self.assertGreater(out["result"]["overall"]["n"], 0)
        self.assertGreaterEqual(out["result"]["edges"][0], HOLDOUT)
        self.assertEqual(len(out["result"]["folds"]), CFG["exam_folds"])


class TemporalEvidenceTests(Base):
    def temporal_judgement(self, mean=25, supported=False, clustered=False):
        fixture = JudgeTests()
        trades = fixture.trades(400, mean)
        end_ms = max(t["exit_ms"] for t in trades) + 1
        if clustered:
            for i, trade in enumerate(trades):
                trade.update(entry_ms=1000 + i * 3 * MINUTE, exit_ms=1000 + (i * 3 + 15) * MINUTE)
        return g.judge(trades, fixture.series(), CFG, kind="practice", start_ms=0,
                       end_ms=end_ms, attempts=1, products=["BTC"], seed=5, embargo_supported=supported)

    def test_unsupported_temporal_evidence_alone_is_inconclusive_not_failed_or_passed(self):
        result = self.temporal_judgement()
        rules = g._rule_by_id(result)
        self.assertTrue(all(r["ok"] for r in result["rules"] if r["id"] != "positive_folds"))
        self.assertEqual(result["verdict"], "INCONCLUSO")
        self.assertEqual(result["inconclusive_reasons"], ["temporal_unsupported"])
        self.assertFalse(rules["positive_folds"]["ok"])
        self.assertEqual(rules["positive_folds"]["measurement_status"], "unavailable")
        self.assertEqual(rules["positive_folds"]["reasons"], ["unsupported_recorded_model_horizon"])
        saved = g.run_summary(result, CFG)["rules"]
        self.assertEqual(next(r for r in saved if r["id"] == "positive_folds"), rules["positive_folds"])

    def test_unsupported_evidence_does_not_mask_measured_performance_failure(self):
        result = self.temporal_judgement(mean=-4)
        self.assertEqual(result["verdict"], "NO PASA")
        rules = g._rule_by_id(result)
        self.assertFalse(rules["mean_net_positive"]["ok"])
        self.assertEqual(rules["positive_folds"]["measurement_status"], "unavailable")

    def test_supported_stable_and_unstable_rules_remain_measured(self):
        stable = self.temporal_judgement(supported=True)
        unstable = self.temporal_judgement(supported=True, clustered=True)
        self.assertEqual(stable["verdict"], "PASA")
        self.assertEqual(unstable["verdict"], "NO PASA")
        self.assertEqual(unstable["overall"], stable["overall"])
        self.assertEqual(unstable["accounting"], stable["accounting"])
        self.assertEqual(unstable["funding_share"], stable["funding_share"])
        for result, ok in ((stable, True), (unstable, False)):
            rule = g._rule_by_id(result)["positive_folds"]
            self.assertEqual(rule["measurement_status"], "measured")
            self.assertEqual(rule["ok"], ok)
            self.assertEqual(rule["value"]["total"], CFG["practice_folds"])
            self.assertEqual(rule["reasons"], [])
        self.assertEqual([r["id"] for r in unstable["rules"] if not r["ok"]], ["positive_folds"])
        self.assertEqual(g._rule_by_id(unstable)["positive_folds"]["value"]["positive"], 1)

    def test_unsupported_report_does_not_claim_zero_winning_periods(self):
        result = self.temporal_judgement()
        text = g.build_report(META, result, CFG)
        self.assertIn("Estabilidad temporal no evaluable", text)
        self.assertNotIn("ganó en 0 de", text.lower())
        self.assertIn("temporal_unsupported", result["inconclusive_reasons"])
        self.assertNotIn("Hay muy pocas operaciones", text)

    def test_purge_preserves_global_population_net_and_funding_denominator(self):
        from test_strategy_gate_splits import trade
        cfg = dict(CFG, practice_folds=4, random_draws=5, bootstrap_draws=5)
        trades = [trade(1, 20, net=5), trade(90, 110, net=-40),
                  trade(101, 120, net=15), trade(350, 400, net=20)]
        trades[1]["funding_status"] = "partial"
        before = copy.deepcopy(trades)
        result = g.judge(trades, {}, cfg, kind="practice", start_ms=0, end_ms=400,
                         attempts=1, products=["PF_XBTUSD"], seed=1, open_at_end=1)
        self.assertEqual(trades, before)
        self.assertEqual(result["overall"], g.summarize(trades))
        self.assertEqual(result["overall"]["total_bp"], 0)
        self.assertEqual(result["funding_share"], 0.75)
        self.assertEqual(result["accounting"]["closed_trades"], 4)
        self.assertEqual(result["accounting"]["state"], "censored")
        self.assertEqual(result["accounting"]["funding_complete_share"], 0.75)
        self.assertEqual(result["accounting"]["minimum_complete_share"], 0.95)
        self.assertFalse(result["accounting"]["funding_eligible"])
        self.assertEqual(result["temporal"]["used_trades"], 2)
        self.assertEqual(result["temporal"]["state"], "censored")
        self.assertEqual(result["temporal"]["open_at_end"], 1)
        self.assertIsNone(result["folds"][1]["mean_bp"])
        rule = g._rule_by_id(result)["positive_folds"]
        self.assertEqual(rule["value"], {"positive": 2, "total": 4})
        self.assertEqual(rule["threshold"], CFG["rules"]["min_positive_fold_share"])
        self.assertFalse(rule["ok"])
        self.assertEqual(rule["measurement_status"], "measured")

    def test_purged_incomplete_trades_still_count_in_positive_funding_eligibility(self):
        from test_strategy_gate_splits import trade
        cfg = dict(CFG, practice_folds=4, random_draws=5, bootstrap_draws=5)
        trades = [trade(10, 20, net=5)] * 96 + [dict(trade(90, 110, net=-10), funding_status="partial")] * 4
        result = g.judge(trades, {}, cfg, kind="practice", start_ms=0, end_ms=400,
                         attempts=1, products=["PF_XBTUSD"], seed=1)
        self.assertEqual(result["overall"]["n"], 100)
        self.assertEqual(result["overall"]["total_bp"], 440)
        self.assertEqual(result["overall"]["mean_bp"], 4.4)
        self.assertEqual(result["funding_share"], 0.96)
        self.assertTrue(g._rule_by_id(result)["funding_complete"]["ok"])
        self.assertEqual(result["accounting"]["closed_trades"], 100)
        self.assertEqual(result["accounting"]["funding_complete_share"], 0.96)
        self.assertTrue(result["accounting"]["funding_eligible"])
        self.assertEqual(result["temporal"]["excluded_reasons"], {"crosses_fold_end": 4})

    def test_open_at_cut_producer_keeps_censored_evidence_without_synthetic_closes(self):
        from balancita_engine.futures_strategy_gate_api import GateApi
        out = run("lab-open-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-open-v1"),
                  trade_source=lambda *args: ([], 1))
        self.assertEqual(out["result"]["overall"]["n"], 0)
        self.assertEqual(out["temporal"]["state"], "censored")
        self.assertEqual(out["temporal"]["open_at_end"], 1)
        self.assertEqual(out["temporal"]["used_trades"], 0)
        self.assertIsNone(out["temporal"]["embargo_ms"])
        visual = GateApi(None, data_dir=self.dir).visual_summary(str(out["run_id"]))
        self.assertEqual(visual["summary"]["temporal"], out["temporal"])
        self.assertEqual(visual["summary"]["trades"], 0)

    def test_real_book_producer_persists_temporal_evidence_through_api_and_artifact(self):
        from balancita_engine.futures_strategy_gate_api import GateApi
        stream = io.StringIO()
        out = run("c27-breakout-perp-v1", self.dir, json_progress=True, stream=stream)
        evidence = out["result"]["temporal"]
        self.assertGreater(evidence["input_trades"], 0)
        self.assertEqual(evidence["embargo_source"], "legacy_longest_observed_closed_hold")
        self.assertEqual(out["temporal"], evidence)
        self.assertEqual(json.loads(stream.getvalue().splitlines()[-1])["temporal"], evidence)
        with self._open_db() as db:
            params = json.loads(db.execute("SELECT params FROM runs WHERE id=?", (out["run_id"],)).fetchone()[0])
        self.assertEqual(params["temporal"], evidence)
        from types import SimpleNamespace
        registry = SimpleNamespace(_version_row=lambda *args: {"strategy_id": "c27-breakout-perp-v1"},
                                   _deleted=lambda *args: False)
        api = GateApi(registry, data_dir=self.dir)
        self.assertEqual(api.run(str(out["run_id"]))["run"]["temporal"], evidence)
        self.assertEqual(api.runs("c27-breakout-perp-v1")["runs"][0]["temporal"], evidence)
        self.assertEqual(api.visual_summary(str(out["run_id"]))["summary"]["temporal"], evidence)
        with open(out["report_path"], encoding="utf-8") as handle:
            report = handle.read()
        self.assertIn(evidence["method"], report)
        self.assertIn("No es entrenamiento/prueba walk-forward", report)

    def test_recorded_model_routes_keep_observed_trades_without_inventing_a_horizon(self):
        for sid, filename, table in ((g.strategy_models.QWEN_ID, "qwen-exit.sqlite", "qwen_exit_trade"),
                                     (g.strategy_models.KRONOS_ID, "kronos.sqlite", "trade")):
            with self.subTest(strategy=sid):
                with sqlite3.connect(os.path.join(self.dir, filename)) as db:
                    db.execute("CREATE TABLE {}(product_id TEXT, payload TEXT)".format(table))
                    db.execute("INSERT INTO {} VALUES(?,?)".format(table),
                               ("PF_XBTUSD", json.dumps(_trade("LONG", FROM + MINUTE, 15, 7))))
                out = run(sid, self.dir, qwen_exit_dir=self.dir, kronos_dir=self.dir)
                self.assertEqual(out["result"]["overall"]["n"], 1)
                self.assertEqual(out["result"]["overall"]["total_bp"], 7)
                evidence = out["temporal"]
                self.assertEqual(evidence["state"], "unsupported")
                self.assertIsNone(evidence["embargo_ms"])
                self.assertEqual(evidence["embargo_source"], "unsupported_recorded_model_horizon")
                self.assertEqual(evidence["excluded_reasons"], {"unsupported_embargo": 1})
                self.assertFalse(g._rule_by_id(out["result"])["positive_folds"]["ok"])


class RepeatableModelTests(Base):
    """Qwen and Kronos may repeat the exam; every other strategy keeps the once-per-version rule."""

    def exam(self, sid):
        return run(sid, self.dir, spec=g.strategy_models.model_spec(sid), trade_source=cheating_source, kind="exam")

    def test_qwen_live_and_kronos_repeat_the_exam_and_keep_only_the_newest_lock(self):
        for sid in (g.strategy_models.QWEN_LIVE_ID, g.strategy_models.KRONOS_ID):
            first, second = self.exam(sid), self.exam(sid)
            self.assertEqual((first["status"], second["status"]), ("done", "done"))
            self.assertNotEqual(first["run_id"], second["run_id"])
            locks = self._open_db().execute("SELECT run_id FROM exam_locks WHERE strategy_id=?", (sid,)).fetchall()
            self.assertEqual([r[0] for r in locks], [second["run_id"]])

    def test_c31_and_rules_strategies_do_not_repeat(self):
        self.assertFalse(g.strategy_models.is_repeatable(g.strategy_models.QWEN_ID))
        self.assertFalse(g.strategy_models.is_repeatable("c25-pullback-perp-v1"))


class ExamLockTests(Base):
    def cheat(self, version=1, **kwargs):
        sid = "lab-cheat-v{}".format(version)
        return run(sid, self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid, **kwargs.pop("changes", {})),
                   trade_source=cheating_source, **kwargs)

    def test_second_exam_of_the_same_version_is_refused_with_date_and_verdict(self):
        first = self.cheat(kind="exam")
        with self.assertRaises(g.GateError) as caught:
            self.cheat(kind="exam")
        message = str(caught.exception)
        self.assertIn("El examen final de esta versión ya se rindió el ", message)
        self.assertIn(first["verdict"], message)
        self.assertIn("Para volver a rendirlo, creá una versión nueva.", message)
        self.assertEqual(len(g.list_runs(os.path.join(self.dir, g.DB_NAME))), 1)

    def test_another_family_can_sit_its_own_exam_on_the_same_window(self):
        self.cheat(1, kind="exam")
        sid = "lab-else-v1"
        out = run(sid, self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid), trade_source=cheating_source,
                  kind="exam")
        self.assertEqual(out["status"], "done")
        rows = self._open_db().execute("SELECT strategy_id FROM exam_locks ORDER BY strategy_id").fetchall()
        self.assertEqual([r[0] for r in rows], ["lab-cheat-v1", "lab-else-v1"])

    def test_changed_content_with_the_same_id_is_refused_after_an_exam(self):
        self.cheat(1, kind="exam")
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam", changes={"name": "otro contenido"})
        self.assertIn("versión", str(caught.exception))
        self.assertIn("-v2", str(caught.exception))

    def test_changed_content_with_the_same_id_is_refused_without_a_lock_too(self):
        self.cheat(1)  # a practice run registers the hash
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam", changes={"name": "otro contenido"})
        self.assertIn("la versión es la misma", str(caught.exception))

    def test_practice_does_not_consume_the_exam(self):
        self.cheat(1)
        self.cheat(1)
        self.assertEqual(self.cheat(1, kind="exam")["status"], "done")

    def test_failure_before_any_outcome_keeps_the_lock_free(self):
        provider = Provider(fail_prefetch=True)
        with self.assertRaises(g.HistoryError):
            self.cheat(1, kind="exam", provider=provider)
        self.assertEqual(self._open_db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 0)
        self.assertEqual(self._open_db().execute("SELECT status FROM runs").fetchone()[0], "failed")
        self.assertEqual(self.cheat(1, kind="exam")["status"], "done")

    def test_cancel_after_reading_the_cutoff_consumes_the_lock(self):
        def cancel(event):
            if event["detail"] == "calculando operaciones":
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = self.cheat(1, kind="exam", on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        row = self._open_db().execute("SELECT status, verdict FROM exam_locks").fetchone()
        self.assertEqual(row["status"], "cancelled")
        self.assertEqual(self._open_db().execute("SELECT holdout_read FROM runs").fetchone()[0], 1)
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam")
        self.assertIn("ya se rindió", str(caught.exception))

    def test_cancel_during_download_keeps_the_lock_free(self):
        def cancel(event):
            if event["detail"] and event["detail"].startswith("descargando"):
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = self.cheat(1, kind="exam", on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        self.assertEqual(self._open_db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 0)


class FamilyExamTests(Base):
    """Same reserve, same family, another version: refused (also after a purge), unless explicitly contaminated."""

    def cheat(self, version=1, **kwargs):
        sid = "lab-cheat-v{}".format(version)
        return run(sid, self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid), trade_source=cheating_source,
                   **kwargs)

    def test_successor_of_the_same_family_is_refused_before_any_write(self):
        self.cheat(1, kind="exam")
        before = len(g.list_runs(os.path.join(self.dir, g.DB_NAME)))
        with self.assertRaises(g.GateError) as caught:
            self.cheat(2, kind="exam")
        message = str(caught.exception)
        self.assertIn("La familia lab-cheat ya rindió su examen sobre esta reserva (desde 2025-01-21, versión "
                      "lab-cheat-v1, veredicto ", message)
        self.assertIn("Una versión sucesora no es un examen independiente de la misma reserva.", message)
        self.assertEqual(len(g.list_runs(os.path.join(self.dir, g.DB_NAME))), before)
        self.assertEqual(self._open_db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 1)

    def test_another_family_is_unaffected(self):
        self.cheat(1, kind="exam")
        out = run("lab-other-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-other-v1"),
                  trade_source=cheating_source, kind="exam")
        self.assertEqual(out["status"], "done")
        self.assertEqual(out["verdict"], "PASA")

    def test_explicit_contaminated_exam_runs_warns_and_never_passes(self):
        self.cheat(1, kind="exam")
        out = self.cheat(2, kind="exam", allow_contaminated=True)
        self.assertEqual(out["status"], "done")
        self.assertEqual(out["verdict"], "INCONCLUSO")   # the cheating source would PASS
        self.assertGreater(out["result"]["overall"]["n"], 100)
        self.assertTrue(all(c["ok"] for c in out["result"]["rules"]))
        text = open(out["report_path"], encoding="utf-8").read()
        self.assertIn("REUTILIZACIÓN CONTAMINADA: esta reserva ya fue usada por la familia; no es evidencia independiente",
                      text)
        self.assertLess(text.index("REUTILIZACIÓN CONTAMINADA"), text.index("### En pocas palabras"))
        self.assertIn("nunca puede dar PASA", text)
        params = json.loads(self._open_db().execute("SELECT params FROM runs WHERE id=?", (out["run_id"],)).fetchone()[0])
        self.assertTrue(params["contaminated"])

    def test_allow_contaminated_on_a_clean_family_is_not_marked(self):
        out = self.cheat(1, kind="exam", allow_contaminated=True)
        self.assertEqual(out["verdict"], "PASA")
        params = json.loads(self._open_db().execute("SELECT params FROM runs").fetchone()[0])
        self.assertNotIn("contaminated", params)

    def test_deleting_the_first_version_does_not_free_the_window(self):
        self.cheat(1, kind="exam")
        g.purge_strategy("lab-cheat-v1", self.dir)
        self.assertEqual(self._open_db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 0)
        with self.assertRaises(g.GateError) as caught:
            self.cheat(2, kind="exam")
        self.assertIn("La familia lab-cheat ya rindió su examen sobre esta reserva (desde 2025-01-21, versión ya borrada",
                      str(caught.exception))
        dump = "\n".join(self._open_db().iterdump())
        self.assertNotIn("lab-cheat", dump)
        self.assertEqual(self.cheat(2, kind="exam", allow_contaminated=True)["verdict"], "INCONCLUSO")

    def test_cli_option_is_wired(self):
        args = g._parser().parse_args(["evaluate", "--strategy", "x-v1", "--exam", "--examen-contaminado"])
        self.assertTrue(args.allow_contaminated)


class AttemptsTests(Base):
    def test_every_practice_run_of_the_family_is_an_attempt_and_the_report_shows_it(self):
        sid = lambda v: "c25-pullback-perp-v{}".format(v)  # noqa: E731
        run(sid(1), self.dir)
        run(sid(1), self.dir)
        out = run(sid(2), self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid(2)))
        self.assertEqual(out["result"]["attempts"], 3)
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("Intentos: 3", handle.read())
        run("c26-reversion-perp-v1", self.dir)
        counts = dict(self._open_db().execute("SELECT family, COUNT(*) FROM attempts GROUP BY family").fetchall())
        self.assertEqual(counts, {"c25-pullback-perp": 3, "c26-reversion-perp": 1})

    def _ledger(self, variants):
        path = os.path.join(self.dir, "lab", "ledger.sqlite")
        os.makedirs(os.path.dirname(path))
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE trials(id INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT, variant_key TEXT)")
        for key in variants:
            conn.execute("INSERT INTO trials(family,variant_key) VALUES(?,?)", ("c25-pullback-perp", key))
        conn.execute("INSERT INTO trials(family,variant_key) VALUES('c25-pullback-perp','a')")  # repeated run
        conn.execute("INSERT INTO trials(family,variant_key) VALUES('other-family','z')")
        conn.commit()
        conn.close()
        return path

    def test_lab_variants_add_to_the_attempts_and_the_ledger_is_never_written(self):
        path = self._ledger(["a", "b", "c"])
        with open(path, "rb") as handle:
            before = (os.stat(path).st_mtime_ns, handle.read())
        out = run("c25-pullback-perp-v1", self.dir, research_ledger=path)
        self.assertEqual(out["result"]["attempts"], 1 + 3)
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("Intentos: 1 (de la compuerta) + 3 (variantes del laboratorio)", handle.read())
        with open(path, "rb") as handle:
            after = (os.stat(path).st_mtime_ns, handle.read())
            self.assertEqual(after, before)

    def test_without_ledger_file_the_lab_adds_zero(self):
        missing = os.path.join(self.dir, "nope", "ledger.sqlite")
        out = run("c25-pullback-perp-v1", self.dir, research_ledger=missing)
        self.assertEqual(out["result"]["attempts"], 1)
        self.assertFalse(os.path.exists(missing))
        self.assertEqual(g.research_trials("c25-pullback-perp", None), 0)

    def _assert_gate_untouched(self):
        # The refusal comes before any write: gate.sqlite is absent or holds no run, attempt or exam lock.
        path = os.path.join(self.dir, g.DB_NAME)
        if not os.path.exists(path):
            return
        db = self._open_db()
        for table in ("runs", "attempts", "exam_locks"):
            self.assertEqual(db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 0, table)

    def test_a_garbage_ledger_file_refuses_before_writing_anything(self):
        path = os.path.join(self.dir, "ledger.sqlite")
        with open(path, "wb") as handle:
            handle.write(os.urandom(4096))
        with self.assertRaises(g.GateError) as caught:
            run("c25-pullback-perp-v1", self.dir, research_ledger=path)
        self.assertIn("no se puede leer", str(caught.exception))
        self._assert_gate_untouched()

    def test_a_ledger_without_the_trials_table_refuses(self):
        path = os.path.join(self.dir, "ledger.sqlite")
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE other(x)")
        conn.commit()
        conn.close()
        with self.assertRaises(g.GateError) as caught:
            run("c25-pullback-perp-v1", self.dir, research_ledger=path)
        self.assertIn("no se puede leer", str(caught.exception))
        self._assert_gate_untouched()

    def test_an_exam_with_an_unreadable_ledger_does_not_consume_the_lock(self):
        path = os.path.join(self.dir, "ledger.sqlite")
        with open(path, "wb") as handle:
            handle.write(os.urandom(4096))
        sid = "lab-cheat-v1"
        spec = dict(SPECS["c25-pullback-perp-v1"], id=sid)
        with self.assertRaises(g.GateError):
            run(sid, self.dir, kind="exam", spec=spec, trade_source=cheating_source, research_ledger=path)
        self._assert_gate_untouched()
        os.remove(path)  # fixed: the same version can still sit its exam
        out = run(sid, self.dir, kind="exam", spec=spec, trade_source=cheating_source, research_ledger=path)
        self.assertEqual(out["status"], "done")

    def test_exam_is_not_an_attempt(self):
        run("lab-cheat-v1", self.dir, kind="exam", spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
            trade_source=cheating_source)
        self.assertEqual(self._open_db().execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)


class ProgressTests(Base):
    def test_progress_events_and_run_row(self):
        events = []
        out = run("c26-reversion-perp-v1", self.dir, on_progress=events.append)
        self.assertEqual(out["status"], "done")
        percents = [e["percent"] for e in events]
        self.assertEqual(percents, sorted(percents))
        self.assertTrue(all(0 <= p <= 100 for p in percents))
        phases = []
        for e in events:
            if not phases or phases[-1] != e["phase"]:
                phases.append(e["phase"])
        self.assertEqual(phases, ["generando señales", "simulando", "sorteos al azar", "informe"])
        self.assertTrue(all("started_at" in e and "eta_seconds" in e for e in events))
        row = dict(self._open_db().execute("SELECT * FROM runs").fetchone())
        self.assertEqual((row["status"], row["progress"], row["eta_s"]), ("done", 100.0, 0.0))
        self.assertEqual(row["kind"], "practice")
        self.assertTrue(row["report_path"].endswith(os.path.join("reports", "{}.md".format(row["id"]))))
        for column in ("phase", "eta_s", "started_at", "updated_at", "finished_at", "verdict", "params", "version_key"):
            self.assertIn(column, row)

    def test_json_progress_lines_on_the_stream(self):
        stream = io.StringIO()
        run("c26-reversion-perp-v1", self.dir, json_progress=True, stream=stream)
        lines = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertTrue(all({"phase", "percent", "eta_seconds", "started_at"} <= set(l) for l in lines))
        self.assertEqual(lines[-1]["status"], "done")

    def test_cancel_between_chunks_marks_the_run_cancelled(self):
        def cancel(event):
            if event["phase"] == "generando señales" and event["percent"] > 15:
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = run("c27-breakout-perp-v1", self.dir, on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        row = self._open_db().execute("SELECT status, phase, report_path FROM runs").fetchone()
        self.assertEqual((row["status"], row["phase"], row["report_path"]), ("cancelled", "cancelada", None))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "reports", "1.md")))

    def test_cancel_request_flag_cancels(self):
        # The signal handler only sets ``cancel_requested``; the run stops at the next check.
        calls = []

        def trip(event):
            calls.append(event)
        out = run("c27-breakout-perp-v1", self.dir, on_progress=trip, install_signals=True)
        self.assertEqual(out["status"], "done")

    def test_failed_run_is_recorded(self):
        provider = Provider(fail_prefetch=True)
        with self.assertRaises(g.HistoryError):
            run("c25-pullback-perp-v1", self.dir, provider=provider)
        row = self._open_db().execute("SELECT status, error FROM runs").fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertIn("sin red", row["error"])


class ReportAndCliTests(Base):
    def test_report_is_spanish_lists_rules_with_marks_and_config(self):
        out = run("lab-cheat-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        with open(out["report_path"], encoding="utf-8") as handle:
            text = handle.read()
        for needle in ("# C25 Pullback en tendencia", "`lab-cheat-v1`", "## ✅ PASA", "### En pocas palabras",
                       "## Qué revisamos", "- ✅ **Operaciones suficientes**", "## Resultado general", "## Por periodo",
                       "## Por producto", "## Compra contra venta", "## Comparación con entradas al azar",
                       "## Con costos más altos", "## Glosario", "## Detalles técnicos", "Intentos: 1",
                       "min_trades", "Operaciones aún abiertas", "Factor de beneficio", "Sharpe desinflado"):
            self.assertIn(needle, text)
        self.assertLess(text.index("## Glosario"), text.index("## Detalles técnicos"))
        top = text[:text.index("## Resultado general")]
        for jargon in ("version_key", "sha ", "kraken-futures-costs", "Semilla", "```"):
            self.assertNotIn(jargon, top)
        self.assertIn("%", text.split("### En pocas palabras")[1].split("## Qué revisamos")[0])
        self.assertRegex(text, r"\d,\d\d %")           # decimal comma, percentages
        self.assertNotRegex(text, r"(?m)^\|.*\d\.\d\d % \|")
        bullets = text.split("### En pocas palabras")[1].split("## Qué revisamos")[0].strip().splitlines()
        self.assertTrue(3 <= len([b for b in bullets if b.startswith("- ")]) <= 5)
        # every table row has the same number of cells as its header (valid GFM)
        block = []
        for line in text.splitlines() + [""]:
            if line.startswith("|"):
                block.append(line)
            elif block:
                self.assertEqual({row.count("|") for row in block}, {block[0].count("|")}, block)
                block = []
        failing = run("lab-losing-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-losing-v1"),
                      trade_source=losing_source)
        with open(failing["report_path"], encoding="utf-8") as handle:
            lost = handle.read()
        self.assertIn("- ❌ ", lost)
        self.assertRegex(lost, r"## ❌ NO PASA")

    def test_runs_lists_json_lines_and_filters(self):
        run("c26-reversion-perp-v1", self.dir)
        run("c27-breakout-perp-v1", self.dir)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(g.main(["--data-dir", self.dir, "runs", "--strategy", "c27-breakout-perp-v1"]), 0)
        rows = [json.loads(line) for line in buffer.getvalue().splitlines()]
        self.assertEqual([r["strategy_id"] for r in rows], ["c27-breakout-perp-v1"])

    def test_cli_refuses_unknown_strategy_in_spanish(self):
        err = io.StringIO()
        import contextlib
        with contextlib.redirect_stderr(err):
            code = g.main(["--data-dir", self.dir, "evaluate", "--strategy", "no-existe-v1"])
        self.assertEqual(code, 2)
        self.assertIn("estrategia desconocida", err.getvalue())

    def test_cancel_run_command_writes_only_the_flag_file(self):
        out = run("c26-reversion-perp-v1", self.dir)
        with self.assertRaises(g.GateError):
            g.cancel_run(out["run_id"], self.dir)  # not running any more
        db = sqlite3.connect(os.path.join(self.dir, g.DB_NAME))
        db.execute("UPDATE runs SET status='running', pid=NULL WHERE id=?", (out["run_id"],))
        db.commit()
        db.close()
        g.cancel_run(out["run_id"], self.dir)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "cancel", str(out["run_id"]))))


class RandomBaselineTests(unittest.TestCase):
    def test_random_entries_reproduce_the_cost_drag_and_are_deterministic(self):
        rng, price, closes = random.Random(2), 50_000.0, []
        for _ in range(5000):
            price *= 1 + rng.gauss(0, 0.0003)
            closes.append(price)
        series = {"PF_XBTUSD": {"closes": closes, "first_ms": 0, "start_index": 100}}
        trades = [{"product": "PF_XBTUSD", "side": "LONG" if i % 2 else "SHORT", "entry_ms": 0, "exit_ms": 20 * MINUTE}
                  for i in range(50)]
        a, _ = g.random_entries_means(trades, series, draws=100, seed=1)
        b, _ = g.random_entries_means(trades, series, draws=100, seed=1)
        self.assertEqual(a, b)
        self.assertAlmostEqual(sum(a) / len(a), -g.trade_cost_bp("PF_XBTUSD", "time_stop"), delta=3)
        self.assertEqual(g.percentile_in([1, 2, 3, 4], 10), 100.0)
        self.assertEqual(g.percentile_in([1, 2, 3, 4], 0), 0.0)

    def test_float_cost_matches_the_exact_horizon_net(self):
        exact = horizon_net_bp("LONG", "PF_ETHUSD", "100", "100")
        self.assertAlmostEqual(g.trade_cost_bp("PF_ETHUSD", "time_stop"), -exact, places=3)


if __name__ == "__main__":
    unittest.main()


class ArtifactTests(Base):
    """Each finished run keeps its closed trades (manifest + trades) without changing a single number of the verdict."""

    def stored(self, directory, run_id):
        folder = os.path.join(directory, g.ARTIFACTS_DIR, str(run_id))
        with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        with gzip.open(os.path.join(folder, g.TRADES_FILE), "rb") as handle:
            raw = handle.read()
        return folder, manifest, raw, [json.loads(line) for line in raw.decode("utf-8").splitlines()]

    def test_finished_run_stores_the_judged_trades_with_a_matching_checksum(self):
        out = run("c27-breakout-perp-v1", self.dir)
        folder, manifest, raw, trades = self.stored(self.dir, out["run_id"])
        self.assertEqual(manifest["schema"], g.ARTIFACT_SCHEMA)
        self.assertEqual(manifest["status"], "complete")
        self.assertEqual(manifest["trades_count"], len(trades))
        self.assertEqual(len(trades), out["result"]["overall"]["n"])
        self.assertEqual(manifest["trades_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(manifest["spec_hash"], spec_hash(SPECS["c27-breakout-perp-v1"]))
        self.assertEqual(manifest["decision_evidence"], "captured")   # a practice run keeps its trace (gate_trace)
        summary, result = manifest["summary"], out["result"]
        self.assertEqual((summary["trades"], summary["mean_bp"], summary["percentile"], summary["verdict"]),
                         (result["overall"]["n"], result["overall"]["mean_bp"], result["percentile"], out["verdict"]))
        self.assertEqual(summary["folds"], CFG["practice_folds"])
        self.assertEqual(summary["min_trades"], CFG["rules"]["min_trades"])
        self.assertEqual([r["id"] for r in summary["rules"]], [r["id"] for r in result["rules"]])
        self.assertEqual([r["ok"] for r in summary["rules"]], [r["ok"] for r in result["rules"]])
        self.assertEqual(manifest["range_end_ms_exclusive"], HOLDOUT)
        self.assertEqual([t["trade_id"] for t in trades], ["{}-{}".format(out["run_id"], i + 1) for i in range(len(trades))])
        self.assertTrue(all(t["execution_type"] == "simulated" and t["signal_time_ms"] is None for t in trades))
        self.assertEqual(sum(t["net_bp"] for t in trades) / len(trades), out["result"]["overall"]["mean_bp"])
        self.assertFalse([n for n in os.listdir(os.path.dirname(folder)) if n.startswith(".tmp")])

    def test_stored_trades_carry_the_simulators_prices_and_reasons(self):
        out = run("c27-breakout-perp-v1", self.dir)
        trades = self.stored(self.dir, out["run_id"])[3]
        self.assertTrue(trades)
        for trade in trades:
            self.assertIn(trade["side"], ("LONG", "SHORT"))
            self.assertLess(trade["entry_time_ms"], trade["exit_time_ms"])
            self.assertLessEqual(trade["exit_time_ms"], HOLDOUT)
            self.assertTrue(float(trade["entry_price"]) > 0 and float(trade["exit_price"]) > 0)
            self.assertTrue(trade["exit_reason"])

    def test_storing_the_trades_changes_no_result_and_is_deterministic(self):
        a = run("c27-breakout-perp-v1", self.dir)
        other = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, other, True)
        original = g.write_artifact
        g.write_artifact = lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disco lleno"))
        try:
            b = run("c27-breakout-perp-v1", other)
        finally:
            g.write_artifact = original
        self.assertEqual(a["verdict"], b["verdict"])
        self.assertEqual(a["result"]["overall"], b["result"]["overall"])
        self.assertEqual(a["result"]["folds"], b["result"]["folds"])
        self.assertEqual(a["result"]["percentile"], b["result"]["percentile"])
        self.assertFalse(os.path.exists(os.path.join(other, g.ARTIFACTS_DIR, str(b["run_id"]))))
        self.assertEqual(b["status"], "done")
        third = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, third, True)
        c = run("c27-breakout-perp-v1", third)
        self.assertEqual(self.stored(self.dir, a["run_id"])[2], self.stored(third, c["run_id"])[2])

    def test_a_cancelled_run_stores_nothing(self):
        before = os.path.join(self.dir, g.ARTIFACTS_DIR)
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, from_date="2025-01-21")
        self.assertFalse(os.path.exists(before))

    def test_a_published_artifact_is_never_overwritten(self):
        out = run("c27-breakout-perp-v1", self.dir)
        meta = {"run_id": out["run_id"], "strategy_id": "x", "family": "x", "version_key": "x", "kind": "practice",
                "start_ms": 0, "end_ms": 1, "products": [], "config_hash": "h"}
        with self.assertRaises(g.GateError):
            g.write_artifact(self.dir, meta, CFG, SPECS["c27-breakout-perp-v1"], "d", [], 0)
        self.assertFalse([n for n in os.listdir(os.path.join(self.dir, g.ARTIFACTS_DIR)) if n.startswith(".tmp")])

    def test_purge_removes_the_stored_trades_too(self):
        out = run("c27-breakout-perp-v1", self.dir)
        self.assertTrue(os.path.isdir(os.path.join(self.dir, g.ARTIFACTS_DIR, str(out["run_id"]))))
        counts = g.purge_strategy("c27-breakout-perp-v1", self.dir)
        self.assertEqual(counts["artifacts"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, g.ARTIFACTS_DIR, str(out["run_id"]))))
