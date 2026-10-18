import json
import os
import random
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_funding_context as fc
from balancita_engine import futures_llm_decisions as llm
from balancita_engine.futures_replay import run
from balancita_engine.futures_replay_qwen import AnswerCache, BlindQwen, FundingRule
from balancita_engine.futures_spec_strategy import load_specs

from test_futures_replay import DDL, ONES, FIVES
from test_futures_llm_decisions import QUESTION_PINS

H = fc.HOUR_MS


def ramp(n=800, start=0, base=1e-5):
    """Hourly periods whose rate rises by 1e-8 per hour: the newest is always the highest of its window."""
    return [(start + i * H, base + i * 1e-8) for i in range(n)]


class FundingContextTests(unittest.TestCase):
    def test_a_period_counts_only_after_it_closed_plus_the_publication_lag(self):
        ctx = fc.FundingContext(ramp())
        period = fc.WINDOW + 5  # judged period index; it closes at (period + 1) * H
        closes = (period + 1) * H
        self.assertEqual(ctx.percentile(closes + fc.PUBLICATION_LAG_MS - 1)[0], ramp()[period - 1][1])
        self.assertEqual(ctx.percentile(closes + fc.PUBLICATION_LAG_MS)[0], ramp()[period][1])

    def test_the_percentile_excludes_the_period_it_judges_and_the_future(self):
        ctx = fc.FundingContext(ramp())
        _, pct = ctx.percentile((fc.WINDOW + 1) * H + fc.PUBLICATION_LAG_MS)
        self.assertEqual(pct, 100.0)  # above all 720 earlier periods
        later = fc.FundingContext(ramp() + [(800 * H, 9.0)])  # a spike after the decision changes nothing
        self.assertEqual(later.percentile((fc.WINDOW + 1) * H + fc.PUBLICATION_LAG_MS), ctx.percentile((fc.WINDOW + 1) * H + fc.PUBLICATION_LAG_MS))

    def test_unknown_until_thirty_days_of_history(self):
        ctx = fc.FundingContext(ramp(100))
        self.assertIsNone(ctx.percentile(100 * H))
        self.assertEqual(ctx.line(100 * H), "funding: unknown")

    def test_line_levels_and_payer(self):
        rates = [(i * H, 1e-5 + (i % 7) * 1e-7) for i in range(760)]
        rates.append((760 * H, 5e-5))
        rates.append((761 * H, -5e-5))
        ctx = fc.FundingContext(rates)
        self.assertEqual(ctx.line(761 * H + fc.PUBLICATION_LAG_MS), "funding: high (pctl30d=100, longs pay)")
        self.assertEqual(ctx.line(762 * H + fc.PUBLICATION_LAG_MS), "funding: low (pctl30d=0, shorts pay)")
        rates.append((762 * H, 1e-5 + 3e-7))
        self.assertEqual(fc.FundingContext(rates).level(763 * H + fc.PUBLICATION_LAG_MS), "normal")

    def test_placebo_shows_the_line_of_seven_days_before(self):
        real, placebo = fc.FundingContext(ramp()), fc.FundingContext(ramp(), fc.PLACEBO_SHIFT_MS)
        at = 780 * H
        self.assertEqual(placebo.percentile(at), real.percentile(at - fc.PLACEBO_SHIFT_MS))

    def test_periods_from_kraken_bodies_keep_the_first_seen_rate_and_skip_garbage(self):
        body = lambda *rows: json.dumps({"result": "success", "rates": [
            {"timestamp": t, "fundingRate": 1, "relativeFundingRate": r} for t, r in rows]})
        got = fc.periods_from_responses([
            body(("1970-01-01T00:00:00Z", 1.0), ("1970-01-01T01:00:00Z", 2.0)), "{}", "not json",
            body(("1970-01-01T01:00:00Z", 9.0), ("1970-01-01T02:00:00Z", 3.0))])
        self.assertEqual(got, [(0, 1.0), (H, 2.0), (2 * H, 3.0)])

    def test_load_periods_reads_one_product_from_the_market_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.sqlite")
            db = sqlite3.connect(path)
            db.executescript(
                "CREATE TABLE paper_futures_funding_responses(sha256 TEXT, received_at INTEGER, server_time TEXT, raw_response TEXT);"
                "CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT, start_ms INTEGER, end_ms INTEGER,"
                " funding_rate TEXT, known_at INTEGER, unit TEXT, product_id TEXT);")
            for sha, product, rate in (("a", "PF_XBTUSD", 1.0), ("b", "PF_ETHUSD", 2.0)):
                raw = json.dumps({"rates": [{"timestamp": "1970-01-01T00:00:00Z", "relativeFundingRate": rate}]})
                db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, 1, "t", raw))
                db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)", (sha, 0, H, "0", H + 5, "u", product))
            db.commit()
            db.close()
            self.assertEqual(fc.load_periods(path, "PF_ETHUSD"), [(0, 2.0, H + 5)])
            self.assertEqual(fc.load_periods(path, "PF_SOLUSD"), [])


class FundingQuestionTests(unittest.TestCase):
    def test_v5_is_v4_plus_the_funding_line_and_v4_keeps_its_pin(self):
        v4 = llm.load_questions()["trade_action"]
        self.assertEqual(llm.question_hash(v4), QUESTION_PINS["trade_action@4"])
        v5 = fc.funding_question(v4)
        self.assertEqual(v5["version"], 5)
        self.assertEqual([f for f in v5["state_fields"] if f not in v4["state_fields"]], ["funding"])
        self.assertLess(v5["state_fields"].index("funding"), v5["state_fields"].index("lessons"))
        self.assertEqual({k: v for k, v in v5.items() if k not in ("version", "state_fields")},
                         {k: v for k, v in v4.items() if k not in ("version", "state_fields")})


class FundingReplayTests(unittest.TestCase):
    SPECS = list(load_specs().values())

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        db = sqlite3.connect(self.market)
        db.executescript(DDL)
        for c in ONES + FIVES:
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "PF_XBTUSD", c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
                c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "r"))
        db.commit()
        db.close()
        first = ONES[0]["bucket_start"]
        self.periods = [(first - 800 * H + i * H, 1e-5 + (i % 11) * 1e-7) for i in range(1000)]

    def tearDown(self):
        self.dir.cleanup()

    def _blind(self, funding, provider=None):
        prompts = llm.load_prompt_config()
        question = fc.funding_question(llm.load_questions()["trade_action"])
        return BlindQwen(provider or llm.FakeProvider(), self.SPECS, question, llm.load_calibration(),
                         prompts["templates"][prompts["default_version"]], trigger="5min", mode="raw_logprobs",
                         cache=AnswerCache(), funding=funding)

    def test_the_state_carries_the_funding_line_and_nothing_else_changes(self):
        qwen = self._blind(fc.FundingContext(self.periods))
        run(self.market, os.path.join(self.dir.name, "a.sqlite"), "PF_XBTUSD", ONES[300]["bucket_start"],
            ONES[600]["bucket_start"], self.SPECS, qwen=qwen)
        self.assertTrue(qwen.decisions)
        self.assertTrue(all("funding: " in d["state_text"] and "pctl30d=" in d["state_text"] for d in qwen.decisions))

    def test_funding_rule_sells_high_buys_low_and_the_follower_inverts(self):
        question = fc.funding_question(llm.load_questions()["trade_action"])
        spike = [(s, 1e-3 if i == 900 else r) for i, (s, r) in enumerate(self.periods)]
        ctx = fc.FundingContext(spike)
        bucket = spike[900][0] + H + fc.PUBLICATION_LAG_MS  # first minute the spike is usable
        bucket -= bucket % 60_000
        bucket += 60_000
        contrarian = FundingRule(self.SPECS, question, ctx, "contrarian")
        follow = FundingRule(self.SPECS, question, ctx, "follow")
        self.assertEqual(contrarian._answer("", {}, bucket - 60_000)["chosen"], "sell")
        self.assertEqual(follow._answer("", {}, bucket - 60_000)["chosen"], "buy")
        self.assertEqual(contrarian._answer("", {}, spike[0][0])["chosen"], "hold")  # unknown -> no trade
        with self.assertRaises(ValueError):
            FundingRule(self.SPECS, question, ctx, "sideways")


if __name__ == "__main__":
    unittest.main()


class FundingStrategyTests(unittest.TestCase):
    """C32: the funding percentile as a 5m feature and the spec that trades it."""

    def test_frames_add_fundpct_only_with_funding_and_without_lookahead(self):
        from balancita_engine.futures_simulator import frames

        first = ONES[0]["bucket_start"]
        periods = [(first - 800 * H + i * H, 1e-5 + i * 1e-8) for i in range(1000)]
        plain = [f for f in frames(ONES, FIVES)]
        with_funding = [f for f in frames(ONES, FIVES, funding=fc.FundingContext(periods))]
        self.assertEqual(len(plain), len(with_funding))
        self.assertTrue(all("fundpct" not in f[3] for f in plain if f[3]))
        seen = [f[3]["fundpct"] for f in with_funding if f[3] and "fundpct" in f[3]]
        self.assertTrue(seen)
        # A future spike in the funding changes nothing for earlier frames.
        spiked = periods + [(first + 100 * H, 1.0)]
        again = [f for f in frames(ONES, FIVES, funding=fc.FundingContext(spiked))]
        cut = first + 90 * H
        self.assertEqual([f[3].get("fundpct") for f in with_funding if f[3] and f[0] < cut],
                         [f[3].get("fundpct") for f in again if f[3] and f[0] < cut])

    def test_c32_sells_high_funding_buys_low_and_is_flat_without_funding(self):
        from balancita_engine.futures_replay import replay
        from balancita_engine.futures_spec_strategy import load_specs

        spec = load_specs()["c32-funding-contrarian-24h-perp-v1"]
        first, last = ONES[0]["bucket_start"], ONES[-1]["bucket_start"]
        hours = (last - first) // H + 900
        start = first - 800 * H
        rising = fc.FundingContext([(start + i * H, 1e-5 + i * 1e-8) for i in range(hours)])  # always the top of its month
        falling = fc.FundingContext([(start + i * H, 1e-5 - i * 1e-8) for i in range(hours)])
        args = dict(start_ms=ONES[400]["bucket_start"], product_id="PF_XBTUSD")
        (flat,) = replay([spec], ONES, FIVES, **args)
        (short,) = replay([spec], ONES, FIVES, funding=rising, **args)
        (long,) = replay([spec], ONES, FIVES, funding=falling, **args)
        self.assertEqual(len(flat.trades) + (flat.position is not None), 0)
        sides = lambda b: {t["side"] for t in b.trades} | ({b.position["side"]} if b.position else set())
        self.assertEqual(sides(short), {"SHORT"})
        self.assertEqual(sides(long), {"LONG"})
