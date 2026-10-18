"""PR 100: the nine acceptance criteria of the multi-strategy architecture, end to end, with a stubbed Qwen."""

import hashlib
import os
import random
import re
import tempfile
import unittest

from balancita_engine.futures_funding_context import FundingContext
from balancita_engine.futures_llm_decisions import FakeProvider
from balancita_engine.futures_simulator import frames
from balancita_engine.multi_experiment import Experiment, FrameFeeder, verify_against_rebuild
from balancita_engine.multi_risk import RiskEngine, RiskPolicy
from balancita_engine.multi_select import DeterministicCombiner, QwenSelector
from balancita_engine.multi_signals import (
    BUY, SELL, WAIT, FIVE_MINUTES_MS, Strategy, default_strategies, make_signal, validate_signal,
)
from balancita_engine.multi_store import ConflictError, DecisionStore

from test_futures_spec_strategy import START, _random_walk

PRODUCT = "PF_XBTUSD"
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
HOUR = 3_600_000
FUNDING = {PRODUCT: [(START - 20 * 86_400_000, START + 40 * 86_400_000, "0.00001")]}
WALK = _random_walk(random.Random(11), 1500)


class Scripted(Strategy):
    """Emits BUY (or SELL) at the listed 5-minute cycle indices and WAIT otherwise."""

    id, version, horizon_minutes, indicators = "mx-scripted-v1", 1, 120, {}

    def __init__(self, cycles, action=BUY, strength="0.9"):
        self.cycles, self.action, self.strength = set(cycles), action, strength

    def decide(self, ctx):
        from decimal import Decimal
        index = (ctx.bucket_ms - START) // FIVE_MINUTES_MS
        if index in self.cycles:
            return self.action, Decimal(self.strength), {"scripted": "yes"}, "scripted"
        return WAIT, Decimal(0), {}, "scripted_wait"


def qwen_says(action, flip_after=None, flag=None):
    """FakeProvider entries that always pick ``action`` (buy / wait / sell) whatever letter it sits behind."""
    calls = {"n": 0}

    def entries(prompt, letters):
        calls["n"] += 1
        if flip_after is not None and calls["n"] >= flip_after:
            flag["down"] = True
        names = dict((name, letter) for letter, name in re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
        return [{"token": letter, "logprob": -0.01 if letter == names[action] else -6.0} for letter in letters]
    return entries


def selector(action, **kwargs):
    return QwenSelector(FakeProvider(entries=qwen_says(action, **kwargs)))


OPEN_STORES = []


def tearDownModule():
    for store in OPEN_STORES:
        try:
            store.close()
        except Exception:
            pass


def run(strategies, qwen=None, policy=None, funding=FUNDING, store=None, experiment_id="t", candles=WALK, **kwargs):
    store = store or DecisionStore()
    OPEN_STORES.append(store)
    experiment = Experiment(store, [PRODUCT], strategies=strategies, qwen=qwen, policy=policy, experiment_id=experiment_id,
                            funding_periods_by_product=funding, **kwargs)
    report = experiment.run({PRODUCT: candles})
    return experiment, store, report


def arm_trades(store, arm):
    return [t for t in store.trades() if t["arm"] == arm]


class AcceptanceTests(unittest.TestCase):
    def test_1_no_strategy_signal_and_qwen_buy_does_not_trade(self):
        provider = FakeProvider(entries=qwen_says("buy"))
        experiment, store, report = run([Scripted([])], QwenSelector(provider))
        self.assertEqual(store.trades(), [])
        self.assertEqual(provider.calls, 0)  # no candidate: the model is not even asked
        # And if it is asked anyway, a BUY with nothing behind it is a WAIT.
        waiting = [make_signal(strategy_id="mx-x-v1", strategy_version=1, product_id=PRODUCT, bucket_ms=START,
                               action=WAIT, strength=0, horizon_minutes=60, evidence={})]
        chosen = QwenSelector(FakeProvider(entries=qwen_says("buy"))).select(PRODUCT, START, waiting)
        self.assertEqual((chosen["action"], chosen["reason"]), (WAIT, "no_backing_signal"))
        self.assertIsNone(chosen["signal_id"])
        self.assertEqual(report["candidates"], 0)

    def test_2_strategy_buy_and_qwen_wait_does_not_trade(self):
        experiment, store, report = run([Scripted([60])], selector("wait"))
        self.assertEqual(arm_trades(store, "C"), [])
        self.assertTrue(arm_trades(store, "A") and arm_trades(store, "B"))  # the other arms did take it
        row = report["candidate_table"][0]
        self.assertEqual(row["arms"]["C"], "rejected_by_selector:qwen_wait")
        self.assertEqual(report["selector_filters"]["C"]["rejected_candidates"], 1)
        self.assertEqual(report["selector_filters"]["C"]["judged"], 1)  # its shadow outcome says what it would have earned

    def test_3_qwen_buy_backed_but_risk_rejects(self):
        policy = RiskPolicy(max_notional_global_usd="50")
        experiment, store, report = run([Scripted([60])], selector("buy"), policy=policy)
        self.assertEqual(store.trades(), [])
        self.assertEqual(store.executions(), [])
        reasons = [r["reasons"] for r in store.risk_outcomes().values()]
        self.assertTrue(reasons and all("global_exposure_limit" in r for r in reasons))
        self.assertEqual(report["candidate_table"][0]["arms"]["C"], "rejected_by_risk:global_exposure_limit")

    def test_4_qwen_buy_and_risk_authorizes_the_executor_enters(self):
        experiment, store, report = run([Scripted([60])], selector("buy"))
        (trade,) = arm_trades(store, "C")
        self.assertEqual((trade["side"], trade["notional_usd"]), ("LONG", "100"))
        self.assertTrue(trade["meta"]["auth_id"] and trade["meta"]["signal_id"])
        why = experiment.explain(trade["meta"]["decision_id"])
        self.assertEqual(why["selection"]["reason"], "qwen_buy")
        self.assertTrue(why["risk"]["authorized"])
        self.assertEqual([e["kind"] for e in why["executions"]], ["entry", "exit"])
        self.assertTrue(why["selection"]["detail"]["prompt_hash"])
        # The executor refuses anything the risk engine did not issue.
        self.assertEqual(experiment.executor.submit({"auth_id": "forged"}, 0, 0)["reason"], "unknown_authorization")

    def test_5_open_position_is_managed_with_qwen_down(self):
        flag = {"down": False}
        provider = FakeProvider(entries=qwen_says("buy", flip_after=3, flag=flag))
        real = provider.complete

        def complete(*args, **kwargs):
            if flag["down"]:
                provider.healthy = False
            return real(*args, **kwargs)

        provider.complete = complete
        experiment, store, report = run([Scripted([60, 62])], QwenSelector(provider))
        (trade,) = arm_trades(store, "C")
        self.assertIn(trade["exit_reason"], ("stop", "target", "time_stop"))
        self.assertGreater(trade["exit_bucket_ms"], trade["entry_bucket_ms"])
        second = [s for s in store.selections("C") if s["cycle_ms"] == START + 62 * FIVE_MINUTES_MS]
        self.assertEqual(second[0]["reason"], "qwen_failure:ModelUnavailable")  # it was down, and nothing depended on it

    def test_6_repeated_events_do_not_duplicate(self):
        once, store_once, _ = run([Scripted([60, 90])], selector("buy"))
        store = DecisionStore()
        OPEN_STORES.append(store)
        twice = Experiment(store, [PRODUCT], strategies=[Scripted([60, 90])], qwen=selector("buy"), experiment_id="t",
                           funding_periods_by_product=FUNDING)
        twice.run({PRODUCT: WALK})
        again = twice.run({PRODUCT: WALK})  # every candle arrives a second time
        self.assertEqual(twice.ledger_hash(), once.ledger_hash())
        self.assertEqual(len(store.trades()), len(store_once.trades()))
        self.assertGreaterEqual(again["already_processed_candles"], len(WALK[0]))
        # An authorization can be redeemed once only.
        risk = RiskEngine()
        verdict = risk.evaluate(
            decision={"decision_id": "d", "arm": "C", "scope": "qwen", "product_id": PRODUCT, "action": BUY,
                      "signal_id": "s"},
            signals=[{"signal_id": "s", "action": BUY, "product_id": PRODUCT, "horizon_minutes": 60,
                      "strategy_id": "x", "strategy_version": 1}],
            snapshot={"price": "100000", "atr": "300", "ready": True, "data_close_ms": 10}, now_ms=20,
            account={"open_notional_usd": "0", "product_open": False, "realized_usd": "0",
                     "realized_today_usd": "0", "drawdown_usd": "0"})
        self.assertTrue(verdict["authorized"])
        risk.redeem(verdict["authorization"], 21)
        with self.assertRaises(Exception) as caught:
            risk.redeem(verdict["authorization"], 22)
        self.assertEqual(str(caught.exception), "duplicate_authorization")
        # The store refuses an id reused with other content.
        with self.assertRaises(ConflictError):
            store.put_selection(dict(store.selections()[0], reason="tampered"))

    def test_7_replay_with_stored_decisions_gives_identical_accounting(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "multi.sqlite")
            first, store, _ = run([Scripted([60, 100, 140])], selector("buy"), store=DecisionStore(path))
            expected, trades = first.ledger_hash(), len(store.trades())
            self.assertGreater(trades, 0)
            store.close()
            provider = FakeProvider(entries=qwen_says("sell"))  # would answer differently, and must not be asked
            replayed, store2, _ = run([Scripted([60, 100, 140])], QwenSelector(provider), store=DecisionStore(path))
            self.assertEqual(provider.calls, 0)
            self.assertEqual(replayed.ledger_hash(), expected)
            self.assertEqual(len(store2.trades()), trades)

    def test_8_missing_funding_or_costs_never_invent_a_complete_net(self):
        experiment, store, report = run([Scripted([60])], selector("buy"), funding={})
        trades = store.trades()
        self.assertTrue(trades)
        for trade in trades:
            self.assertFalse(trade["net_complete"])
            self.assertIsNone(trade["net_usd"])
            self.assertIn("partial_usd", trade)
        for arm in report["arms"].values():
            if arm["trades"]:
                self.assertIsNone(arm["net_pnl_usd"])
                self.assertIsNotNone(arm["partial_pnl_usd"])
        complete, store2, report2 = run([Scripted([60])], selector("buy"))
        self.assertTrue(all(t["net_complete"] and t["net_usd"] is not None for t in store2.trades()))
        # A product without a measured cost row is not traded at all.
        experiment3 = Experiment(DecisionStore(), ["PF_FOOUSD"], strategies=[Scripted([60])], qwen=selector("buy"),
                                 funding_periods_by_product=FUNDING)
        experiment3.run({"PF_FOOUSD": WALK})
        self.assertEqual(experiment3.store.trades(), [])
        self.assertTrue(all("cost_data_missing" in r["reasons"] for r in experiment3.store.risk_outcomes().values()))

    def test_9_protected_strategies_and_their_records_are_untouched(self):
        pinned = {
            "config/strategies/c25-pullback-perp-v1.json": "95ac63523926c07d30e240830a1c7cab2468888769ed0028a4032eea1f3552d3",
            "config/strategies/c26-reversion-perp-v1.json": "262e691234910a03a4dbd9f79c08e078a18de050fd9e5eb9fbf16e972ced2bec",
            "config/strategies/c27-breakout-perp-v1.json": "9df21fbe6207debbb3d868fc28b42d4c74aeef19ca82431e15a7a589f254da65",
            "config/strategies/c28-adapter-perp-v1.json": "562b7b52f850fc6f7d1c30ff65f30a669fef6bb0b0ac2b4081541736a55e7271",
            "config/strategies/c29-momentum-perp-v1.json": "998284cf51e317838a456fbbba789ee3c479a1471fcbb5f0b3dabadf95742628",
            "config/strategies/c30-momentum-12h-perp-v1.json": "c4d2184134365c454d391dc5f7569eff445eff789634405e0e26066a851a75ec",
            "config/forward-strategies.json": "f36987b348257ca2720e33453dbdd99c9bb94c4220e12e645aa19170597e9df9",
            "config/strategy-freeze.json": "13117739b4603f477ddca04ad9b72693dc19d3132a3d72f80a14acce9b1000b7",
            "config/strategy-closed.json": "75dfc20e5c5e7dfd6a58d658602298ec04d2e09d0b9e9982232952ffc447fee7",
        }
        for relative, digest in pinned.items():
            with open(os.path.join(ROOT, relative), "rb") as handle:
                self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), digest, relative)
        # The experiment ids are new and live in no registry the forward runner reads.
        ids = {s.id for s in default_strategies()}
        self.assertEqual(ids, {"mx-funding-v1", "mx-momentum-v1", "mx-meanrev-v1"})
        for name in os.listdir(os.path.join(ROOT, "config", "strategies")):
            self.assertFalse(name.startswith("mx-"))
        with open(os.path.join(ROOT, "config", "forward-strategies.json"), encoding="utf-8") as handle:
            self.assertFalse(any(i in handle.read() for i in ids))


class ComponentTests(unittest.TestCase):
    def test_signal_contract_rejects_tampering_and_never_claims_calibration(self):
        signal = make_signal(strategy_id="mx-a-v1", strategy_version=1, product_id=PRODUCT, bucket_ms=1, action=BUY,
                             strength="0.8", horizon_minutes=60, evidence={"k": 1},
                             reliability={"sample_size": 12, "hit_rate": "0.50"})
        self.assertIs(validate_signal(signal)["calibrated"], False)
        self.assertEqual(signal["scores"], {"BUY": "0.90", "SELL": "0.00", "WAIT": "0.10"})
        with self.assertRaises(ValueError):
            validate_signal(dict(signal, strength="0.1"))
        with self.assertRaises(ValueError):
            make_signal(strategy_id="x", strategy_version=1, product_id=PRODUCT, bucket_ms=1, action="HOLD",
                        strength=0, horizon_minutes=1, evidence={})

    def test_qwen_asks_three_rotations_one_letter_and_failures_are_wait(self):
        buy = [make_signal(strategy_id="mx-a-v1", strategy_version=1, product_id=PRODUCT, bucket_ms=1, action=BUY,
                           strength="0.8", horizon_minutes=60, evidence={})]
        provider = FakeProvider(entries=qwen_says("buy"))
        chosen = QwenSelector(provider).select(PRODUCT, 1, buy)
        self.assertEqual((chosen["action"], chosen["signal_id"]), (BUY, buy[0]["signal_id"]))
        self.assertEqual(provider.calls, 3)
        self.assertEqual(len({p.split("A) ")[1].split("\n")[0] for p in provider.prompts}), 3)  # rotated options
        down = FakeProvider(entries=qwen_says("buy"), healthy=False)
        self.assertEqual(QwenSelector(down).select(PRODUCT, 1, buy)["reason"], "qwen_failure:ModelUnavailable")
        garbage = FakeProvider(entries=[{"token": "Z", "logprob": -1.0}])
        self.assertTrue(QwenSelector(garbage).select(PRODUCT, 1, buy)["reason"].startswith("qwen_failure"))
        slow = FakeProvider(entries=qwen_says("buy"))
        real = slow.complete
        slow.complete = lambda *a, **k: dict(real(*a, **k), latency_ms=60_000)
        self.assertEqual(QwenSelector(slow, timeout_ms=1_000).select(PRODUCT, 1, buy)["reason"], "qwen_timeout")

    def test_the_time_budget_covers_all_rotated_questions_and_cuts_the_socket_timeout(self):
        buy = [make_signal(strategy_id="mx-a-v1", strategy_version=1, product_id=PRODUCT, bucket_ms=1, action=BUY,
                           strength="0.8", horizon_minutes=60, evidence={})]
        now = {"t": 0.0}
        seen = []

        def slow_provider(step):
            provider = FakeProvider(entries=qwen_says("buy"))
            provider.timeout = 30.0
            real = provider.complete

            def complete(*args, **kwargs):
                seen.append(provider.timeout)
                now["t"] += step
                return real(*args, **kwargs)
            provider.complete = complete
            return provider

        within = slow_provider(9)  # 3 x 9 s fits in 30 s
        self.assertEqual(QwenSelector(within, clock=lambda: now["t"]).select(PRODUCT, 1, buy)["action"], BUY)
        self.assertEqual(seen, [30.0, 21.0, 12.0])  # each request may only use what is left
        self.assertEqual(within.timeout, 30.0)  # and the provider is left as it was
        now["t"], seen[:] = 0.0, []
        over = slow_provider(15)  # the third question would start at 30 s: never asked
        chosen = QwenSelector(over, clock=lambda: now["t"]).select(PRODUCT, 1, buy)
        self.assertEqual((chosen["action"], chosen["reason"]), (WAIT, "qwen_timeout"))
        self.assertEqual(over.calls, 2)

    def test_combiner_needs_agreement(self):
        def sig(sid, action, strength):
            return make_signal(strategy_id=sid, strategy_version=1, product_id=PRODUCT, bucket_ms=1, action=action,
                               strength=strength, horizon_minutes=60, evidence={})
        combiner = DeterministicCombiner()
        self.assertEqual(combiner.select(PRODUCT, 1, [sig("a", BUY, "0.9")])["reason"], "weak" if False else "combined_buy")
        self.assertEqual(combiner.select(PRODUCT, 1, [sig("a", BUY, "0.4")])["reason"], "weak")
        self.assertEqual(combiner.select(PRODUCT, 1, [sig("a", BUY, "0.9"), sig("b", SELL, "0.8")])["reason"], "contradiction")
        both = combiner.select(PRODUCT, 1, [sig("a", BUY, "0.9"), sig("b", BUY, "0.5"), sig("c", SELL, "0.2")])
        self.assertEqual(both["action"], BUY)

    def test_the_three_experimental_strategies_run_the_whole_path(self):
        rng = random.Random(5)
        periods = [(START - 800 * HOUR + i * HOUR, rng.uniform(-0.0002, 0.0002)) for i in range(900)]
        ones, fives = _random_walk(random.Random(3), 4000)
        experiment = Experiment(DecisionStore(), [PRODUCT], qwen=selector("buy"), experiment_id="full",
                                funding_contexts={PRODUCT: FundingContext(periods)})
        report = experiment.run({PRODUCT: (ones, fives)})
        self.assertEqual(report["schema"], "balancita-multi-report.v1")
        self.assertIn("no edge asserted", report["verdict"])
        self.assertGreater(experiment.cycles, 700)
        seen = {s["strategy_id"] for s in experiment.store.signals()}
        self.assertEqual(seen, {"mx-funding-v1", "mx-momentum-v1", "mx-meanrev-v1"})
        for signal in experiment.store.signals():
            validate_signal(signal)


def scaled(candles, factor):
    """The same candles at another price level (another product)."""
    from decimal import Decimal
    result = []
    for candle in candles:
        copy = dict(candle)
        for key in ("open", "high", "low", "close"):
            copy[key] = str(Decimal(candle[key]) * Decimal(factor))
        result.append(copy)
    return result


class ManyProductsTests(unittest.TestCase):
    def test_every_frame_keeps_its_own_product_and_prices(self):
        # Regression: a generator expression in a loop bound `product` late and mixed all products into the last one.
        eth = (scaled(WALK[0], "0.02"), scaled(WALK[1], "0.02"))
        both = {PRODUCT: WALK, "PF_ETHUSD": eth}
        store = DecisionStore()
        OPEN_STORES.append(store)
        experiment = Experiment(store, list(both), strategies=[Scripted([60, 100, 140])], qwen=selector("buy"),
                                experiment_id="m", funding_periods_by_product={
                                    PRODUCT: FUNDING[PRODUCT], "PF_ETHUSD": FUNDING[PRODUCT]})
        experiment.run(both)
        from decimal import Decimal
        ranges = {p: (min(Decimal(c["low"]) for c in ones), max(Decimal(c["high"]) for c in ones))
                  for p, (ones, _) in both.items()}
        self.assertEqual({t["product_id"] for t in store.trades()}, set(both))
        for trade in store.trades():
            low, high = ranges[trade["product_id"]]
            self.assertTrue(low * Decimal("0.99") <= Decimal(trade["entry_price"]) <= high * Decimal("1.01"), trade)
        self.assertEqual({c["product_id"] for c in store.candidates()}, set(both))
        for signal in store.signals():
            low, high = ranges[signal["product_id"]]
            if "close" in signal["evidence"]:
                self.assertTrue(low <= Decimal(signal["evidence"]["close"]) <= high)
        # A product's trades do not depend on the others being there.
        alone = Experiment(DecisionStore(), ["PF_ETHUSD"], strategies=[Scripted([60, 100, 140])], qwen=selector("buy"),
                           experiment_id="m", funding_periods_by_product={"PF_ETHUSD": FUNDING[PRODUCT]})
        alone.run({"PF_ETHUSD": eth})
        OPEN_STORES.append(alone.store)
        key = lambda trades: sorted((t["arm"], t["entry_bucket_ms"], t["entry_price"], t["exit_price"], t["exit_reason"])
                                    for t in trades)
        self.assertEqual(key([t for t in store.trades() if t["product_id"] == "PF_ETHUSD"]), key(alone.store.trades()))


class CheckpointTests(unittest.TestCase):
    CYCLES = [60, 100, 140, 200, 250]

    def make(self, store, qwen=None, **kwargs):
        OPEN_STORES.append(store)
        return Experiment(store, [PRODUCT], strategies=[Scripted(self.CYCLES)], qwen=qwen or selector("buy"),
                          experiment_id="t", funding_periods_by_product=FUNDING, **kwargs)

    def test_feeder_yields_exactly_what_frames_yields(self):
        from balancita_engine.multi_signals import merged_indicators
        periods = merged_indicators([Scripted([])])
        feeder = FrameFeeder(periods)
        self.assertEqual(list(feeder.stream(*WALK)), list(frames(WALK[0], WALK[1], periods)))
        self.assertEqual(list(feeder.stream(*WALK)), [])  # all consumed: a repeat yields nothing

    def test_resuming_from_a_checkpoint_equals_rebuilding_from_scratch(self):
        whole = self.make(DecisionStore())
        whole.run({PRODUCT: WALK})
        open_at_a_split = False
        for split in (310, 330, 360, 700, 1000):
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, "multi.sqlite")
                first = self.make(DecisionStore(path))
                first.run({PRODUCT: (WALK[0][:split], WALK[1])})
                open_at_a_split = open_at_a_split or bool(first.executor.open_positions())
                first.save_checkpoint()
                first.store.close()
                # A restart: new process objects, same file; the candles overlap what was already consumed.
                store = DecisionStore(path)
                second = self.make(store)
                self.assertIsNone(second.load_checkpoint())
                second.run({PRODUCT: WALK})
                self.assertEqual(second.ledger_hash(), whole.ledger_hash(), split)
                self.assertEqual(second.cycles, whole.cycles)
                self.assertEqual({k: v["entry"] for k, v in second.executor.open_positions().items()},
                                 {k: v["entry"] for k, v in whole.executor.open_positions().items()})
                self.assertEqual(second.report()["arms"], whole.report()["arms"])
                self.assertGreaterEqual(second.already_processed, split)
                self.assertIs(next(iter(second.executor.books.values())).funding,
                              second.executor.shared_funding(PRODUCT))
                check = verify_against_rebuild(second, {PRODUCT: WALK})
                self.assertTrue(check["equal"], check)
        self.assertTrue(open_at_a_split)  # at least one checkpoint was taken with a position open

    def test_a_checkpoint_is_never_used_when_it_does_not_fit(self):
        store = DecisionStore()
        base = self.make(store)
        self.assertEqual(base.load_checkpoint(), "no_checkpoint")
        base.run({PRODUCT: (WALK[0][:400], WALK[1])})
        base.save_checkpoint()
        other = Experiment(store, [PRODUCT], strategies=[Scripted(self.CYCLES)], qwen=selector("buy"),
                           experiment_id="t", policy=RiskPolicy(stop_atr_mult="3"), funding_periods_by_product=FUNDING)
        self.assertEqual(other.load_checkpoint(), "configuration_changed")
        self.assertEqual(other.last, {})
        with store.lock, store.db:
            store.db.execute("UPDATE checkpoints SET blob = ? ", (b"garbage",))
        again = self.make(store)
        self.assertEqual(again.load_checkpoint(), "corrupt_checkpoint")
        # Falling back to a full rebuild gives the same ledger as never having had a checkpoint.
        again.run({PRODUCT: WALK})
        whole = self.make(DecisionStore())
        whole.run({PRODUCT: WALK})
        self.assertEqual(again.ledger_hash(), whole.ledger_hash())


if __name__ == "__main__":
    unittest.main()
