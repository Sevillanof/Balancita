"""Issue #186, criterion C8: with an explicit limit, an entry for a product without a quote or with an old one is not
accepted (no order is created) and the rejection is journaled. Without the limit nothing changes. Invented data."""

import os
import unittest

from balancita_engine.paper_runner import RunnerError, manifest

import test_paper_runner_recovery as T

LIMIT = 45 * T.SEC


def with_limit(limit=LIMIT):
    return T.cfg(entry_max_quote_age_ms=limit)


class Blocked(T.Base):
    def runner(self, limit=LIMIT, name="run"):
        from balancita_engine.paper_runner import PaperRunner
        path = os.path.join(self.dir, name)
        r = PaperRunner.create(path, with_limit(limit), T.strategies())
        self.live.append(r)
        return path, r

    def states(self, r):
        return [(o["product_id"], o["state"], tuple(o.get("reasons", ()))) for o in r.orders()]

    def test_no_quote_at_all_blocks_the_entry_and_creates_no_order(self):
        path, r = self.runner()
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC, 1)])
        self.assertEqual(self.states(r), [(T.BTC, "rejected", ("entry_blocked_source_stale",))])
        self.assertEqual((len(r.executor.pending), len(r.portfolio.positions)), (0, 0))

    def test_an_old_quote_blocks_and_one_exactly_at_the_limit_does_not(self):
        for age, blocked in ((LIMIT, False), (LIMIT + 1, True)):
            with self.subTest(age=age):
                path, r = self.runner(name="age{}".format(age))
                t = T.CYCLE + 2 * T.SEC
                r.run([T.quote(T.BTC, t - age, "100010", 1), T.cycle(t, T.BTC, 2)])
                reasons = [o for o in self.states(r) if o[1] == "rejected"]
                self.assertEqual(bool(reasons), blocked)
                self.assertEqual(len(r.executor.pending), 0 if blocked else 1)

    def test_only_the_stale_product_is_blocked(self):
        path, r = self.runner()
        t = T.CYCLE + 2 * T.SEC
        r.run([T.quote(T.ETH, t - T.SEC, "3500", 1), T.cycle(t, T.BTC, 2), T.cycle(t + T.SEC, T.ETH, 3)])
        by_product = {o[0]: o[1] for o in self.states(r)}
        self.assertEqual(by_product, {T.BTC: "rejected", T.ETH: "pending"})

    def test_open_positions_and_their_stops_are_not_touched(self):
        path, r = self.runner(limit=10 * T.MIN)
        c = T.CYCLE
        r.run([T.quote(T.BTC, c + T.SEC, "100010", 1), T.quote(T.ETH, c + T.SEC, "3500", 2),
               T.cycle(c + 2 * T.SEC, T.BTC, 3), T.cycle(c + 3 * T.SEC, T.ETH, 4),
               T.quote(T.BTC, c + 5 * T.SEC, "100010", 5), T.quote(T.ETH, c + 6 * T.SEC, "3500", 6),
               T.candle(T.BTC, c + T.MIN, 100010, 100100, 99900, 100010, 7), T.candle(T.ETH, c + T.MIN, 3500, 3510, 3490, 3500, 8)])
        def view():
            return [(p, b.position["opened_at"], str(b.position.get("stop"))) for p, b in sorted(r.portfolio.positions.items())]
        before = view()
        self.assertEqual(len(before), 2)
        later = c + 60 * T.MIN                         # both quotes are now far older than the limit
        r.run([T.cycle(later, T.BTC, 9, at=later)])
        self.assertEqual(view(), before)
        self.assertEqual(len(r.portfolio.positions), 2)

    def test_the_default_does_not_block_and_leaves_the_identity_as_it_was(self):
        path, r = self.fresh()
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC, 1)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        self.assertNotIn("entry_max_quote_age_ms", manifest(T.cfg(), r.log, T.strategies()))
        self.assertEqual(manifest(with_limit(), r.log, T.strategies())["entry_max_quote_age_ms"], LIMIT)

    def test_the_rejection_is_journaled_and_recovers_to_the_continuous_run(self):
        events = [T.cycle(T.CYCLE + 2 * T.SEC, T.BTC, 1), T.quote(T.BTC, T.CYCLE + 5 * T.SEC, "100010", 2)]
        path, r = self.runner(name="a")
        r.run(events)
        want = (r.financial_digest(), self.states(r))
        r2 = self.recover(path, events[-1]["t_ms"], config=with_limit())
        self.assertEqual((r2.financial_digest(), self.states(r2)), want)

    def test_another_limit_is_a_different_configuration(self):
        path, r = self.runner()
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC, 1)])
        for other in (with_limit(LIMIT + 1), T.cfg()):
            with self.subTest(other=other.entry_max_quote_age_ms):
                with self.assertRaises(RunnerError) as caught:
                    self.recover(path, r.clock + 1, config=other)
                self.assertEqual(caught.exception.reason, "config_incompatible")


if __name__ == "__main__":
    unittest.main()
