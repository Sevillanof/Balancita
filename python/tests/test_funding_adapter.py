"""Stage 10 (D-10C-4): the funding adapter against synthetic Kraken-shaped responses. Invented data only: no network, no
database, no wall clock. The runner side uses the real ``PaperRunner`` and its existing funding accounting."""

import json
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import funding_adapter as FA
from balancita_engine import replay_driver as RP
from balancita_engine.futures_simulator import accrue_funding
from balancita_engine.paper_runner import PaperRunner, RunnerConfig
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_watch import WatchPolicy

D = Decimal
HOUR = 3_600_000
BTC, ETH = "PF_XBTUSD", "PF_ETHUSD"
T0 = 1_767_258_000_000                               # 2026-01-01T09:00:00Z, an hour boundary
assert T0 % HOUR == 0


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def response(rates, server_ms):
    """``rates``: ``[(start_ms, relative, absolute)]`` written the way Kraken writes numbers (JSON numbers, not strings)."""
    items = ",".join('{{"timestamp":"{}","fundingRate":{},"relativeFundingRate":{}}}'.format(iso(s), a, r) for s, r, a in rates)
    return '{{"result":"success","serverTime":"{}","rates":[{}]}}'.format(iso(server_ms), items)


def settled(n=3, rate="0.0000125", price=80_000, product_hour=T0, base=0):
    """``n`` definitive hours starting at ``product_hour``: the absolute rate is the relative one times the price."""
    return [(product_hour + i * HOUR, rate, str(D(rate) * price)) for i in range(n)]


SERVER = T0 + 10 * HOUR


def parse(raw, product_id, received_ms, **kw):
    """Synthetic responses have no stored row nor a price series: they opt out of the strict mode that real data needs."""
    kw.setdefault("strict", False)
    return FA.parse_response(raw, product_id, received_ms, **kw)


class TestChecks(unittest.TestCase):
    def test_the_unit_follows_the_product_and_only_perpetual_usd_products_exist(self):
        self.assertEqual(FA.unit_for(BTC), "USD/BTC/hour")
        self.assertEqual(FA.unit_for(ETH), "USD/ETH/hour")
        for bad in ("BTC-EUR", "PF_XBTEUR", "pf_xbtusd", "PF_USD", None):
            with self.assertRaises(FA.FundingAdapterError) as caught:
                FA.unit_for(bad)
            self.assertEqual(caught.exception.reason, "unsupported_product")

    def test_a_settled_period_keeps_its_exact_decimals_and_the_event_carries_the_relative_rate_only(self):
        raw = response(settled(2, rate="0.00001250"), SERVER)
        parsed = parse(raw, BTC, SERVER + 1)
        self.assertEqual([r["relative_rate"] for r in parsed["definitive"]], ["0.00001250"] * 2)
        self.assertEqual(parsed["definitive"][0]["absolute_rate"], "1.00000000")      # 0.0000125 x 80000
        book = FA.FundingBook()
        (event,) = book.add(parsed)
        self.assertEqual(event["kind"], "funding")
        self.assertEqual((event["source"], event["stream"]), (FA.SOURCE, "funding:" + BTC))
        self.assertEqual(event["payload"], {"product_id": BTC, "periods": [[T0, T0 + HOUR, "0.00001250"], [T0 + HOUR, T0 + 2 * HOUR, "0.00001250"]]})
        self.assertEqual(event["t_ms"], SERVER + 1)                                    # the arrival of the response, not the period

    def test_a_positive_rate_is_paid_by_the_long_and_the_event_never_flips_it(self):
        parsed = parse(response(settled(1, rate="0.0001"), SERVER), BTC, SERVER)
        (event,) = FA.FundingBook().add(parsed)
        periods = [(s, e, D(r)) for s, e, r in event["payload"]["periods"]]
        total, covered = accrue_funding(periods, T0, T0 + HOUR, D(100))
        self.assertEqual((total, covered), (D("0.0100"), HOUR))                         # 100 USD x 0.0001: paid by a long
        negative = parse(response(settled(1, rate="-0.0001"), SERVER), BTC, SERVER)
        self.assertEqual(negative["definitive"][0]["relative_rate"], "-0.0001")

    def test_swapping_the_absolute_and_the_relative_rate_is_caught_when_there_is_a_reference_price(self):
        swapped = [(T0, "1.0000000", "0.0000125")]                                      # relative=1.0, absolute=0.0000125
        price = lambda start: D("80000")                                                # noqa: E731
        parsed = parse(response(swapped, SERVER), BTC, SERVER, reference_price=price, max_abs_relative=D("5"))
        self.assertEqual(parsed["definitive"], [])
        self.assertEqual(parsed["rejected"][0]["reason"], "unit_mismatch")
        good = parse(response(settled(1), SERVER), BTC, SERVER, reference_price=price)
        self.assertEqual(len(good["definitive"]), 1)
        none = parse(response(settled(1), SERVER), BTC, SERVER, reference_price=lambda start: None)
        self.assertEqual(len(none["definitive"]), 1)                                    # no price for that hour: no judgement

    def test_malformed_periods_are_rejected_with_a_reason_and_the_rest_still_count(self):
        rates = [(T0 + 60_000, "0.0001", "8"), (T0 + HOUR, "0.0001", "8"), (SERVER + HOUR, "0.0001", "8"), (T0 + 2 * HOUR, "0.5", "9")]
        parsed = parse(response(rates, SERVER), BTC, SERVER)
        self.assertEqual([(r["reason"]) for r in parsed["rejected"]], ["period_not_hour_aligned", "period_future_dated", "rate_out_of_bounds"])
        self.assertEqual([r["start_ms"] for r in parsed["definitive"]], [T0 + HOUR])
        broken = '{{"result":"success","serverTime":"{}","rates":[{{"timestamp":"{}","fundingRate":"x","relativeFundingRate":null}}]}}'.format(iso(SERVER), iso(T0))
        self.assertEqual(parse(broken, BTC, SERVER)["rejected"][0]["reason"], "rate_not_a_number")
        local = '{{"result":"success","serverTime":"{}","rates":[{{"timestamp":"2026-01-01T09:00:00","fundingRate":1,"relativeFundingRate":0.0001}}]}}'.format(iso(SERVER))
        self.assertEqual(parse(local, BTC, SERVER)["rejected"][0]["reason"], "timestamp_not_utc")

    def test_whole_responses_that_are_not_funding_raise(self):
        for raw, reason in (("not json", "json_invalid"), ('{"result":"error","rates":[]}', "schema_invalid"),
                            ('{"result":"success","serverTime":"nope","rates":[]}', "server_time_invalid"),
                            ('{"result":"success","rates":[]}', "server_time_invalid")):
            with self.assertRaises(FA.FundingAdapterError) as caught:
                parse(raw, BTC, SERVER)
            self.assertEqual(caught.exception.reason, reason)
        with self.assertRaises(FA.FundingAdapterError):
            parse(response(settled(1), SERVER), BTC, -1)

    def test_a_period_in_progress_or_just_ended_is_provisional_and_never_emitted(self):
        now = T0 + 5 * HOUR + 4 * 60_000                                                # 4 minutes into the hour
        rates = [(T0 + 3 * HOUR, "0.0001", "8"), (T0 + 4 * HOUR, "0.0001", "8"), (T0 + 5 * HOUR, "0.0002", "16")]
        parsed = parse(response(rates, now), BTC, now)
        self.assertEqual([r["start_ms"] for r in parsed["definitive"]], [T0 + 3 * HOUR])
        self.assertEqual([(p["start_ms"], p["reason"]) for p in parsed["provisional"]],
                         [(T0 + 4 * HOUR, "not_settled_at_server_time"), (T0 + 5 * HOUR, "not_settled_at_server_time")])
        late = parse(response(rates[:1], now), BTC, T0 + 3 * HOUR + 10)       # received before the period ended
        self.assertEqual((late["definitive"], late["provisional"][0]["reason"]), ([], "not_settled_at_receipt"))
        eager = parse(response(rates, now), BTC, now, settle_lag_ms=0)
        self.assertEqual(len(eager["definitive"]), 2)                                    # the lag is a parameter (a hypothesis)


class TestRealDataMode(unittest.TestCase):
    """``strict`` is what a read of real responses has to use: product from the stored row, a price for every hour."""
    price = staticmethod(lambda start: D("80000"))

    def test_strict_is_the_default(self):
        with self.assertRaises(FA.FundingAdapterError) as caught:
            FA.parse_response(response(settled(1), SERVER), BTC, SERVER)
        self.assertEqual(caught.exception.reason, "reference_price_required")

    def test_a_contradiction_inside_a_period_still_in_progress_is_provisional_and_is_not_quarantined(self):
        """D-10F-05: the publication check comes before any search for contradictions."""
        arrival = T0 + 30 * 60_000                                                                 # half way into hour T0
        raw = response([(T0, "0.0001", "8"), (T0, "0.0002", "16")], arrival)
        parsed = parse(raw, BTC, arrival)
        self.assertEqual((parsed["definitive"], parsed["conflicts"]), ([], []))
        self.assertEqual([(p["start_ms"], p["reason"]) for p in parsed["provisional"]], [(T0, "not_settled_at_server_time")])
        book = FA.FundingBook()
        self.assertEqual(book.add(parsed), [])                                                     # no event dated after its arrival
        self.assertEqual(book.quarantined, {})
        later = parse(response([(T0, "0.0001", "8")], T0 + 3 * HOUR), BTC, T0 + 3 * HOUR)
        self.assertEqual(len(book.add(later)), 1)                                                  # the hour can still become definitive

    def test_every_event_is_dated_no_earlier_than_its_arrival_and_no_later_than_it(self):
        arrival = T0 + 2 * HOUR + 15 * 60_000
        parsed = parse(response([(T0, "0.0001", "8"), (T0, "0.0002", "16"), (T0 + HOUR, "0.0001", "8")], SERVER), BTC, arrival)
        for event in FA.FundingBook().add(parsed):
            self.assertEqual(event["t_ms"], arrival)

    def test_strict_needs_a_reference_price_and_the_product_the_stored_row_declares(self):
        raw = response(settled(1), SERVER)
        for kwargs, reason in (({"strict": True, "stored_product_id": BTC}, "reference_price_required"),
                               ({"strict": True, "reference_price": self.price, "stored_product_id": ETH}, "product_mismatch"),
                               ({"strict": True, "reference_price": self.price}, "product_mismatch")):
            with self.assertRaises(FA.FundingAdapterError) as caught:
                parse(raw, BTC, SERVER, **kwargs)
            self.assertEqual(caught.exception.reason, reason)
        good = parse(raw, BTC, SERVER, strict=True, reference_price=self.price, stored_product_id=BTC)
        self.assertEqual(len(good["definitive"]), 1)

    def test_an_hour_without_a_price_is_rejected_in_strict_mode_and_accepted_otherwise(self):
        raw = response(settled(2), SERVER)
        only_first = lambda start: D("80000") if start == T0 else None                          # noqa: E731
        strict = parse(raw, BTC, SERVER, strict=True, reference_price=only_first, stored_product_id=BTC)
        self.assertEqual(([r["start_ms"] for r in strict["definitive"]], strict["rejected"][0]["reason"]), ([T0], "reference_price_missing"))
        loose = parse(raw, BTC, SERVER, reference_price=only_first)
        self.assertEqual(len(loose["definitive"]), 2)

    def test_a_response_of_another_product_is_caught_by_the_price_check(self):
        eth_like = response(settled(1, price=3_000), SERVER)                                      # absolute = relative x 3000
        parsed = parse(eth_like, BTC, SERVER, strict=True, reference_price=self.price, stored_product_id=BTC)
        self.assertEqual((parsed["definitive"], parsed["rejected"][0]["reason"]), ([], "unit_mismatch"))

    def test_a_zero_relative_rate_with_an_absolute_one_is_a_unit_problem(self):
        parsed = parse(response([(T0, "0", "5")], SERVER), BTC, SERVER, strict=True, reference_price=self.price,
                                   stored_product_id=BTC)
        self.assertEqual(parsed["rejected"][0]["reason"], "unit_mismatch")
        zero = parse(response([(T0, "0", "0")], SERVER), BTC, SERVER, strict=True, reference_price=self.price,
                                 stored_product_id=BTC)
        self.assertEqual(len(zero["definitive"]), 1)


class TestReconciliation(unittest.TestCase):
    def test_the_first_seen_rate_stays_in_use_and_a_different_one_is_handed_to_the_runner_as_a_dispute(self):
        book = FA.FundingBook()
        first = book.add(parse(response([(T0, "0.0001", "8")], SERVER), BTC, SERVER))
        self.assertEqual(len(first), 1)
        again = book.add(parse(response([(T0, "0.0001", "8")], SERVER + 1), BTC, SERVER + 1))
        revised = book.add(parse(response([(T0, "0.0002", "16")], SERVER + 2), BTC, SERVER + 2))
        self.assertEqual(again, [])
        self.assertEqual([e["payload"]["periods"] for e in revised], [[[T0, T0 + HOUR, "0.0002"]]])      # the runner is told, once
        self.assertEqual((book.counts["accepted"], book.counts["duplicate"], book.counts["revision_conflict"]), (1, 1, 1))
        self.assertEqual(book.periods[(BTC, T0)]["relative_rate"], "0.0001")                              # the first is still in use
        self.assertEqual(book.quarantined[(BTC, T0)], ["0.0001", "0.0002"])
        self.assertEqual(book.evidence[-1]["kind"], "revision_conflict")
        again_disputed = book.add(parse(response([(T0, "0.0002", "16")], SERVER + 3), BTC, SERVER + 3))
        original = book.add(parse(response([(T0, "0.0001", "8")], SERVER + 4), BTC, SERVER + 4))
        self.assertEqual((again_disputed, original), ([], []))                                            # nothing is sent twice
        self.assertEqual((book.counts["revision_conflict"], book.counts["duplicate"]), (2, 2))

    def test_two_rates_for_one_period_inside_a_response_are_both_handed_to_the_runner_and_none_is_accepted_here(self):
        rates = [(T0, "0.0001", "8"), (T0, "0.0002", "16"), (T0 + HOUR, "0.0001", "8")]
        book = FA.FundingBook()
        accepted, disputed = book.add(parse(response(rates, SERVER), BTC, SERVER))
        self.assertEqual([p[0] for p in accepted["payload"]["periods"]], [T0 + HOUR])
        self.assertEqual(sorted(p[2] for p in disputed["payload"]["periods"]), ["0.0001", "0.0002"])
        self.assertNotIn((BTC, T0), book.periods)
        self.assertEqual((book.evidence[0]["kind"], book.evidence[0]["reason"]), ("conflicts", "conflict_inside_response"))
        self.assertEqual((book.counts["conflict_inside_response"], book.counts["rejected"]), (1, 0))   # not mixed with malformed periods

    def test_two_products_get_their_own_events_and_the_same_hour_is_not_confused(self):
        book = FA.FundingBook()
        a = book.add(parse(response(settled(2), SERVER), BTC, SERVER))
        b = book.add(parse(response(settled(2, rate="-0.00003", price=3000), SERVER), ETH, SERVER))
        self.assertEqual([(e["payload"]["product_id"], e["stream"]) for e in a + b], [(BTC, "funding:" + BTC), (ETH, "funding:" + ETH)])
        self.assertEqual({k[0] for k in book.periods}, {BTC, ETH})

    def test_the_book_survives_a_restart_without_repeating_an_event(self):
        book = FA.FundingBook()
        book.add(parse(response(settled(3), SERVER), BTC, SERVER))
        book.add(parse(response([(T0, "0.0009", "72")], SERVER + 1), BTC, SERVER + 1))
        restored = FA.FundingBook.from_state(json.loads(json.dumps(book.state())))
        self.assertEqual(restored.state(), book.state())
        self.assertEqual(restored.add(parse(response(settled(3), SERVER), BTC, SERVER + 2)), [])
        more = restored.add(parse(response(settled(4), SERVER + HOUR), BTC, SERVER + HOUR))
        self.assertEqual([p[0] for p in more[0]["payload"]["periods"]], [T0 + 3 * HOUR])


class TestAgainstTheRunnersAccounting(unittest.TestCase):
    def runner(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        config = RunnerConfig(portfolio=PortfolioPolicy(), execution=RP.execution_policy(), watch=WatchPolicy(), funding=(),
                              start_ms=T0 - HOUR, execution_mode="quotes")
        runner = PaperRunner.create(os.path.join(directory, "r"), config, [])
        self.addCleanup(runner.close)
        return runner

    def test_the_runner_accepts_the_events_and_its_known_funding_equals_the_adapters(self):
        runner, book = self.runner(), FA.FundingBook()
        for product, price, rate in ((BTC, 80_000, "0.0000125"), (ETH, 3_000, "-0.00003")):
            for event in book.add(parse(response(settled(3, rate=rate, price=price), SERVER), product, SERVER)):
                self.assertEqual(runner.handle(event)["status"], "accepted")
        self.assertEqual(FA.compare_with_portfolio(book, runner.portfolio.funding), {"missing": [], "extra": [], "rate_differs": []})
        self.assertEqual(runner.portfolio.funding[ETH][0], (T0, T0 + HOUR, D("-0.00003")))
        self.assertEqual(runner.integrity()["open_funding"], [])

    def test_redelivering_the_same_response_changes_nothing_in_the_runner(self):
        runner, book = self.runner(), FA.FundingBook()
        (event,) = book.add(parse(response(settled(2), SERVER), BTC, SERVER))
        runner.handle(event)
        digest = runner.financial_digest()
        self.assertEqual(runner.handle(event)["status"], "duplicate")
        self.assertEqual(runner.financial_digest(), digest)

    def test_a_revision_is_quarantined_by_the_runner_and_the_first_rate_keeps_being_used(self):
        runner, book = self.runner(), FA.FundingBook()
        for raw, at in ((response([(T0, "0.0001", "8")], SERVER), SERVER), (response([(T0, "0.0002", "16")], SERVER + 2), SERVER + 2)):
            for event in book.add(parse(raw, BTC, at)):
                runner.handle(event)
        self.assertEqual(runner.portfolio.funding[BTC], [(T0, T0 + HOUR, D("0.0001"))])           # the first stays in use
        self.assertEqual(runner.portfolio.funding_conflicts[BTC], [[T0, T0 + HOUR, "0.0002"]])    # the dispute is on the portfolio
        self.assertEqual(FA.compare_with_portfolio(book, runner.portfolio.funding), {"missing": [], "extra": [], "rate_differs": []})
        self.assertEqual([e["kind"] for e in runner.portfolio.funding_log].count("period_conflict"), 1)

    def test_a_contradiction_inside_one_response_leaves_no_rate_in_use_on_the_runner(self):
        runner, book = self.runner(), FA.FundingBook()
        for event in book.add(parse(response([(T0, "0.0001", "8"), (T0, "0.0002", "16")], SERVER), BTC, SERVER)):
            runner.handle(event)
        self.assertEqual(runner.portfolio.funding.get(BTC, []), [])                                # contradictory versions: none is used
        self.assertEqual(sorted(c[2] for c in runner.portfolio.funding_conflicts[BTC]), ["0.0001", "0.0002"])

    def test_a_period_the_adapter_never_accepted_shows_up_as_extra_and_a_missing_one_as_missing(self):
        runner, book = self.runner(), FA.FundingBook()
        (event,) = book.add(parse(response(settled(2), SERVER), BTC, SERVER))
        runner.handle(event)
        other = FA.FundingBook()
        other.add(parse(response(settled(3, product_hour=T0 + HOUR), SERVER), BTC, SERVER))
        diff = FA.compare_with_portfolio(other, runner.portfolio.funding)
        self.assertEqual((diff["missing"], diff["extra"]), ([(BTC, T0 + 2 * HOUR), (BTC, T0 + 3 * HOUR)], [(BTC, T0)]))


if __name__ == "__main__":
    unittest.main()
