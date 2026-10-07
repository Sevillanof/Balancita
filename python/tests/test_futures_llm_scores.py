import io
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as q
from balancita_engine import futures_llm_scores as s
from balancita_engine.futures_strategy_backtest import BOOK_CONFIG

from test_futures_llm_decisions import Fixture
from test_futures_verdicts import BTC

MINUTE = 60_000
START = 1_791_000_000_000 - (1_791_000_000_000 % 300_000)


def verdict(index, close, high=None, low=None, atr="10"):
    return {"bucket_start_ms": START + index * MINUTE, "features": {"1m": {
        "ready": True, "candidate_close": str(close), "candidate_high": str(high if high is not None else close),
        "candidate_low": str(low if low is not None else close), "atr14": atr}}}


def path(closes, at=None):
    return [verdict(i, c, **(at or {}).get(i, {})) for i, c in enumerate(closes)]


def decision(index, chosen, confidence=0.5):
    return {"bucket_start": START + index * MINUTE, "chosen": chosen, "confidence": confidence,
            "probabilities": {"buy": 0.2, "hold": 0.6, "sell": 0.2}, "written_at": 0}


class PointTests(unittest.TestCase):
    # 10.12 bp round trip (taker 5 bp on both sides plus 2 x 0.06 bp impact), judged 30 buckets later.
    def score(self, chosen, exit_close, horizon=30):
        closes = [10_000] * horizon + [exit_close]
        return s.score_decisions([decision(0, chosen)], path(closes), horizon_min=horizon)[0]

    def test_buy_is_a_hit_only_when_the_move_clears_the_round_trip(self):
        self.assertEqual(self.score("buy", 10_020)["point"], 1)
        self.assertEqual(self.score("buy", 10_020)["net_bp"], 9.88)
        self.assertEqual(self.score("buy", 10_010)["point"], -1)
        self.assertEqual(self.score("buy", 9_900)["point"], -1)

    def test_sell_is_the_mirror(self):
        self.assertEqual(self.score("sell", 9_980)["point"], 1)
        self.assertEqual(self.score("sell", 10_050)["point"], -1)
        self.assertEqual(self.score("sell", 10_050)["net_bp"], -60.12)

    def test_hold_is_right_when_no_trade_would_have_paid(self):
        hit = self.score("hold", 10_005)
        self.assertEqual((hit["point"], hit["net_bp"]), (1, 0.0))
        self.assertEqual(self.score("hold", 10_030)["point"], -1)
        self.assertEqual(self.score("hold", 9_970)["point"], -1)

    def test_a_decision_without_its_horizon_is_pending_not_scored(self):
        row = s.score_decisions([decision(0, "buy")], path([10_000] * 10))[0]
        self.assertEqual((row["status"], row["point"]), ("pending", None))

    def test_hits_and_misses_are_counted_separately(self):
        closes = [10_000] * 30 + [10_100] * 40
        decisions = [decision(0, "buy"), decision(1, "sell"), decision(2, "hold"), decision(40, "hold")]
        result = s.report(decisions, path(closes))
        d = result["decisions"]
        # buy +1, sell -1, hold -1 (the move cleared the cost), last hold pending.
        self.assertEqual((d["hits"], d["misses"], d["points"], d["pending"]), (1, 2, -1, 1))
        self.assertAlmostEqual(d["hit_rate"], 1 / 3, places=4)
        self.assertEqual(result["by_option"]["buy"]["hits"], 1)
        self.assertEqual(result["by_option"]["sell"]["misses"], 1)
        self.assertEqual(result["by_option"]["hold"]["misses"], 1)

    def test_the_report_is_deterministic(self):
        closes = [10_000 + (i * 7) % 23 for i in range(80)]
        decisions = [decision(i, ("buy", "hold", "sell")[i % 3]) for i in range(0, 50, 2)]
        self.assertEqual(json.dumps(s.report(decisions, path(closes)), sort_keys=True),
                         json.dumps(s.report(decisions, path(closes)), sort_keys=True))


class BookTests(unittest.TestCase):
    def test_a_buy_hits_its_target_with_the_backtest_costs(self):
        # ATR 10 -> stop 15 below, target 30 above.
        closes = [10_000, 10_000, 10_000]
        verdicts = path(closes, {2: {"high": 10_031, "low": 9_999}})
        trades, _ = s.simulate_book([decision(0, "buy")], verdicts)
        self.assertEqual(len(trades), 1)
        trade = trades[0]
        self.assertEqual((trade["side"], trade["exit_reason"], trade["exit_price"]), ("LONG", "target", "10030.0"))
        quantity = float(trade["quantity"])
        # The market entry pays PF_XBTUSD's 0.06 bp of impact; the limit target fills at its level.
        entry = 10_000.06
        expected = (10_030 - entry) * quantity - (entry + 10_030) * quantity * float(BOOK_CONFIG["taker_rate"])
        self.assertAlmostEqual(trade["pnl_usd"], expected, places=3)

    def test_the_stop_wins_when_one_candle_touches_both(self):
        verdicts = path([10_000, 10_000], {1: {"high": 10_040, "low": 9_980}})
        trades, _ = s.simulate_book([decision(0, "buy")], verdicts)
        self.assertEqual(trades[0]["exit_reason"], "stop")
        self.assertLess(trades[0]["pnl_usd"], 0)

    def test_an_opposite_decision_closes_and_hold_keeps_the_position(self):
        verdicts = path([10_000, 10_002, 10_001, 9_995])
        decisions = [decision(0, "sell"), decision(1, "hold"), decision(2, "buy")]
        trades, _ = s.simulate_book(decisions, verdicts)
        self.assertEqual([(t["side"], t["exit_reason"], t["exit_bucket_ms"]) for t in trades],
                         [("SHORT", "opposite_decision", START + 2 * MINUTE)])

    def test_the_time_stop_closes_after_the_horizon(self):
        verdicts = path([10_000] * 40)
        trades, _ = s.simulate_book([decision(0, "buy")], verdicts, horizon_min=30)
        self.assertEqual((trades[0]["exit_reason"], trades[0]["exit_bucket_ms"]), ("time_stop", START + 30 * MINUTE))

    def test_a_target_that_does_not_clear_the_cost_buffer_is_skipped(self):
        verdicts = [verdict(0, 10_000, atr="0.1")] + path([10_000] * 5)[1:]
        trades, skipped = s.simulate_book([decision(0, "buy")], verdicts)
        self.assertEqual(trades, [])
        self.assertEqual(skipped[0]["reason"], "target_does_not_clear_cost_buffer")

    def test_the_trading_summary_has_the_backtest_shape(self):
        verdicts = path([10_000, 10_000, 10_000], {2: {"high": 10_031}})
        trading = s.report([decision(0, "buy")], verdicts)["trading"]
        for key in ("trades", "wins", "hit_rate", "mean_net_bp", "pnl_usd", "return_pct", "max_drawdown"):
            self.assertIn(key, trading)
        self.assertEqual((trading["trades"], trading["wins"], trading["hit_rate"]), (1, 1, 1.0))


class StoredDataTests(unittest.TestCase):
    """End to end over a real verdicts DB and a real decisions DB, read-only."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.fixture = Fixture(self.dir)
        self.decisions_path = os.path.join(self.dir, "decisions.sqlite")
        store = q.DecisionStore(self.decisions_path, q.DECISION_CONFIG)
        db = sqlite3.connect(self.fixture.verdicts_path)
        self.buckets = [r[0] for r in db.execute(
            "SELECT bucket_start FROM paper_futures_verdicts WHERE product_id=? ORDER BY bucket_start", (BTC,))]
        db.close()
        for index, bucket in enumerate(self.buckets[:-35]):
            store.append_decision({
                "product_id": BTC, "bucket_start": bucket, "question_id": "trade_action", "question_version": 1,
                "verdict_hash": "h", "question_type": "choice", "model_ref": "m", "model_info": {},
                "prompt_hash": "p", "prompt_version": 2, "probability_source": "raw_logprobs",
                "state_text": "s", "top_logprobs": [], "probabilities": {"buy": 0.3, "hold": 0.4, "sell": 0.3},
                "temperature": 1.0, "chosen": ("buy", "hold", "sell")[index % 3], "value": None,
                "confidence": 0.1, "latency_ms": 1, "timings": {},
            })
        store.close()
        self.fixture.close()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_product_report_scores_every_decision_with_a_closed_horizon(self):
        result = s.product_report(self.decisions_path, self.fixture.verdicts_path, BTC)
        d = result["decisions"]
        self.assertEqual(result["question_version"], 1)
        self.assertEqual(d["decisions"], len(self.buckets) - 35)
        self.assertEqual(d["hits"] + d["misses"], d["scored"])
        self.assertGreater(d["scored"], 0)

    def test_cli_prints_hits_misses_and_returns(self):
        out = io.StringIO()
        code = s.main(["--decisions-db", self.decisions_path, "--verdicts-db", self.fixture.verdicts_path,
                       "--products", BTC], out=out)
        self.assertEqual(code, 0)
        text = out.getvalue()
        for needle in ("Aciertos (+1):", "Fallos (-1):", "Puntaje:", "Acierto:", "Operando", "Resultado:"):
            self.assertIn(needle, text)

    def test_cli_json_keeps_the_totals_and_trims_the_rows(self):
        out = io.StringIO()
        s.main(["--decisions-db", self.decisions_path, "--verdicts-db", self.fixture.verdicts_path,
                "--products", BTC, "--json", "--max-rows", "5"], out=out)
        result = json.loads(out.getvalue())[0]
        self.assertEqual(len(result["rows"]), 5)
        self.assertEqual(result["rows"][-1]["bucket_start"], self.buckets[-36])
        self.assertEqual(result["decisions"]["decisions"], len(self.buckets) - 35)

    def test_a_product_without_decisions_reports_zero(self):
        result = s.product_report(self.decisions_path, self.fixture.verdicts_path, "PF_ETHUSD")
        self.assertEqual((result["decisions"]["decisions"], result["trading"]["trades"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
