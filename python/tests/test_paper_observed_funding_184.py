"""Issue #184: the session's accounting funding comes from the capture's own responses (``paper_futures_funding_responses`` /
``paper_futures_funding_periods``) through the #167 adapter, and stays apart from the funding the signals use. The market and the
funding are the real ones of PF_XBTUSD (17-oct 12:40Z to 18-oct 08:07Z): the 20 hourly responses Kraken sent, each cut to its newest
48 hours with the text of every rate untouched. Only the scenarios edit them by hand (drop an hour, correct a rate, add a response)
and say so; the clock is simulated and the entries are the ones ``Forcing`` makes (see ``real_session``)."""

import inspect
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock
from decimal import Decimal as D

from balancita_engine import paper_live_integration as LI
from balancita_engine import portfolio_audit as AU
from balancita_engine import signal_continuity as SC
from balancita_engine.futures_simulator import accrue_funding
from balancita_engine.multi_signals import stable_hash
from real_session import (BUY_AT, DECIDE_FROM, STEP, abandon, journal_clock, new_session, recover_session, record, strategies)
from real_world import BTC, HOUR, MIN, T0, Raw, RealWorld, dumps_exact, loads_exact

LAG = 600_000                                      # the adapter's settle lag: an hour is definitive 10 minutes after it ends
HELD = (T0 + 420 * MIN) // HOUR * HOUR             # 19:00Z: inside the second position (19:40 to 21:25) from its start to its end
HELD_ISO = "2026-10-17T19:00:00Z"
PRE_ENTRY = DECIDE_FROM + 145 * MIN                # 19:35Z, five minutes before the second forced entry
CUT = DECIDE_FROM + 380 * MIN                      # 23:30Z: every hour of the second position is definitive and applied
TIMES = [DECIDE_FROM + k * STEP for k in range((CUT - DECIDE_FROM) // STEP + 1)]
PRE_INDEX = next(i for i, t in enumerate(TIMES) if t >= PRE_ENTRY)


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def make_session(world, directory, strats, **kw):
    world.release_until(DECIDE_FROM - MIN)
    return new_session(world, directory, strats, **kw)


def run(session, world, first, last=len(TIMES)):
    records = []
    for now in TIMES[first:last]:
        world.release_until(now)
        session.step(now)
        records.append(record(session, now))
    return records


def money(session):
    snap = session.runner.portfolio.snapshot()
    return {"funding_usd": snap["funding_usd"], "fees": snap["fees_usd"], "closed": snap["closed_trades"], "open": snap["open_positions"],
            "trades": [(t["product_id"], t["exit_reason"], str(t["pnl_usd"]), t["funding_status"]) for t in session.runner.portfolio.trades]}


def micro(amount):
    """The session reports money to the millionth of a USD; the exact amount is compared at that precision, not with a tolerance."""
    return amount.quantize(D("0.000001"))


def LI_alerts(session):
    from balancita_engine import paper_runner_report as REP
    return REP.alerts(session.runner)


# ---- hand edits of the real responses (the scenarios say which) ------------------------------------------------------------------------
def with_rate(row, hour_iso, factor):
    """A copy of a real response where the rate of ``hour_iso`` is ``factor`` times what Kraken sent (both the absolute and the relative one)."""
    body = loads_exact(row["raw"])
    for item in body["rates"]:
        if item["timestamp"] == hour_iso:
            item["fundingRate"] = Raw(format(D(item["fundingRate"]) * factor, "f"))
            item["relativeFundingRate"] = Raw(format(D(item["relativeFundingRate"]) * factor, "f"))
    return renamed(row, dumps_exact(body))


def without_hour(row, hour_iso):
    body = loads_exact(row["raw"])
    body["rates"] = [item for item in body["rates"] if item["timestamp"] != hour_iso]
    return renamed(row, dumps_exact(body))


def renamed(row, raw):
    return dict(row, raw=raw, sha256=stable_hash(raw))


def real_rate(hour_iso):
    """The relative rate Kraken finally listed for ``hour_iso`` (the newest real response that lists it)."""
    from real_world import funding
    for row in reversed(funding()):
        for item in loads_exact(row["raw"])["rates"]:
            if item["timestamp"] == hour_iso:
                return D(item["relativeFundingRate"])
    raise AssertionError(hour_iso)


class TestObservedFunding(unittest.TestCase):
    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"] = strategies(BUY_AT)
        for name, with_funding in (("bare", False), ("observed", True)):
            where = os.path.join(root, name)
            os.makedirs(where)
            world = RealWorld(where, with_funding=with_funding)
            session = make_session(world, os.path.join(where, "s"), cls.cache["strategies"])
            cls.cache[name] = {"session": session, "world": world, "records": run(session, world, 0)}

    @classmethod
    def tearDownClass(cls):
        for name in ("bare", "observed"):
            if name in cls.cache:
                abandon(cls.cache[name]["session"])
                cls.cache[name]["world"].close()
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def test_the_funding_paid_is_what_the_real_rates_say_for_the_hours_each_position_was_held(self):
        session = self.cache["observed"]["session"]
        trades = session.runner.portfolio.trades
        self.assertEqual(len(trades), 2)
        expected = D(0)
        for trade in trades:
            hours = [(h, h + HOUR, real_rate(iso(h)[:-5] + "Z")) for h in range(trade["entry_time_ms"] // HOUR * HOUR, trade["exit_time_ms"] + HOUR, HOUR)]
            amount, covered = accrue_funding(hours, trade["entry_time_ms"], trade["exit_time_ms"], D(trade["entry_price"]) * D(trade["quantity"]))
            self.assertEqual(covered, trade["exit_time_ms"] - trade["entry_time_ms"])
            expected += amount if trade["side"] == "LONG" else -amount
        self.assertNotEqual(expected, 0)
        self.assertEqual(D(money(session)["funding_usd"]), micro(expected))

    def test_the_signals_and_the_trades_are_the_same_with_or_without_the_accounting_funding(self):
        a, b = self.cache["bare"]["records"], self.cache["observed"]["records"]
        self.assertEqual([r["signals"] for r in b], [r["signals"] for r in a])               # the signal channel is apart from the accounting one
        self.assertEqual([r["orders"] for r in b], [r["orders"] for r in a])
        self.assertEqual(money(self.cache["bare"]["session"])["funding_usd"], "0")            # nothing is charged without the responses

    def test_the_book_and_the_portfolio_agree_and_the_result_is_verified_only_when_every_hour_was_applied(self):
        session = self.cache["observed"]["session"]
        report = session.funding_report()
        self.assertEqual(report["divergence"], {"missing": [], "extra": [], "rate_differs": []})
        self.assertGreater(report["counts"]["accepted"], 0)
        self.assertGreater(report["counts"]["duplicate"], 0)                    # the responses overlap 48 hours: repeats are recognised, not applied twice
        self.assertGreater(report["counts"]["provisional"], 0)                  # the hour that has just begun is listed before it is settled
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(report["incomplete_trades"], [])
        self.assertTrue(report["pnl_verified"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "funding_book_diverged"], [])

    def test_a_trade_closed_before_the_newest_settled_hour_is_never_called_verified(self):
        """At 22:00Z the second position (open until 21:25) still lacks the hour 21:00, which is settled at 22:10: partial, not verified."""
        world = RealWorld(tempfile.mkdtemp(), with_funding=True)
        self.addCleanup(world.close)
        session = make_session(world, tempfile.mkdtemp(), self.cache["strategies"])
        self.addCleanup(abandon, session)
        run(session, world, 0, next(i for i, t in enumerate(TIMES) if t >= DECIDE_FROM + 290 * MIN))        # until 22:00Z
        report = session.funding_report()
        [first, second] = session.runner.portfolio.trades
        self.assertTrue(first["net_complete"])
        self.assertFalse(second["net_complete"])
        self.assertEqual(report["incomplete_trades"], [second["trade_id"]])
        self.assertFalse(report["pnl_verified"])

    def test_no_synthetic_accrual_is_read_in_the_observed_path(self):
        session = self.cache["observed"]["session"]
        self.assertIsInstance(session.funding, LI.ObservedFundingSource)
        self.assertEqual(session.identity["funding_channels"]["accrual"], "paper_futures_funding_responses")
        self.assertFalse(hasattr(session.funding, "accrual"))


class TestObservedFundingScenarios(unittest.TestCase):
    """Coverage, contradictions, provisional hours, divergence and recovery. Every scenario starts from the same session, stopped five
    minutes before its second position, and edits its own copy of the responses that have not arrived yet."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"] = strategies(BUY_AT)
        world = RealWorld(root, with_funding=True)
        session = make_session(world, os.path.join(root, "a"), cls.cache["strategies"])
        run(session, world, 0, PRE_INDEX)
        os.makedirs(os.path.join(root, "snap"))
        shutil.copytree(session.directory, os.path.join(root, "snap", "session"))
        cls.cache["snap"] = {"session": os.path.join(root, "snap", "session"), "world": world.snapshot(os.path.join(root, "snap"))}
        cls.cache["world"] = world
        abandon(session)

    @classmethod
    def tearDownClass(cls):
        cls.cache["world"].close()
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def start(self, tweak=None, **kw):
        """A recovered session on its own copy of the world; ``tweak(rows)`` returns the responses that have not arrived yet."""
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        if tweak is not None:
            world.funding_rows = world.funding_rows[:world.next_funding] + sorted(tweak(world.funding_rows[world.next_funding:]),
                                                                                  key=lambda r: r["received_at"])
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        session = self.open(world, directory, **kw)
        return world, directory, session

    def open(self, world, directory, **kw):
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), **kw)
        self.addCleanup(abandon, session)
        return session

    def go(self, world, session, first=PRE_INDEX, last=len(TIMES)):
        run(session, world, first, last)

    def baseline(self):
        if "baseline" not in self.cache:
            world, _, session = self.start()
            self.go(world, session)
            self.cache["baseline"] = {"money": money(session), "report": session.funding_report(), "signals": session.digests()["signals"]}
        return self.cache["baseline"]

    def test_a_clean_run_is_verified_and_pays_funding(self):
        base = self.baseline()
        self.assertTrue(base["report"]["pnl_verified"])
        self.assertEqual(base["report"]["incomplete_trades"], [])
        self.assertNotEqual(base["money"]["funding_usd"], "0")
        self.assertEqual(base["money"]["closed"], 2)

    def test_a_missing_hour_leaves_the_trade_partial_and_the_result_unverified(self):
        """Hand edit: the hour 19:00 is left out of every response that has not arrived yet."""
        base = self.baseline()
        world, _, session = self.start(lambda rows: [without_hour(r, HELD_ISO) for r in rows])
        self.go(world, session)
        report = session.funding_report()
        trade = session.runner.portfolio.trades[1]
        self.assertFalse(trade["net_complete"])
        self.assertIsNone(trade["net_usd"])                                     # a net result is not announced from a hole
        self.assertEqual(report["incomplete_trades"], [trade["trade_id"]])
        self.assertFalse(report["pnl_verified"])
        self.assertIn("funding_incomplete", [a["code"] for a in LI_alerts(session)])
        self.assertNotEqual(money(session)["funding_usd"], base["money"]["funding_usd"])
        self.assertEqual(session.digests()["signals"], base["signals"])           # the signals do not know about the accounting channel

    def revised_session(self, revised_at, extra_at=None):
        """Hand edit: Kraken lists the hour 19:00 with 1.5 times its rate in every response from ``revised_at`` on. With ``extra_at``, a copy
        of the response of 20:00:30 is added at that instant (the hour is then settled with the rate in use before the correction)."""
        def tweak(rows):
            out = [with_rate(r, HELD_ISO, D("1.5")) if r["received_at"] >= revised_at else r for r in rows]
            if extra_at is not None:
                source = next(r for r in rows if r["received_at"] > HELD + HOUR and r["received_at"] < HELD + 2 * HOUR)       # the real 20:00:30
                body = loads_exact(source["raw"])
                body["serverTime"] = iso(extra_at)
                out.append(renamed(dict(source, received_at=extra_at, server_time=iso(extra_at)), dumps_exact(body)))
            return out

        world, _, session = self.start(tweak)
        self.go(world, session)
        return session

    def assert_revised(self, session, base, expect_adjustment):
        """The rate seen last is used, the funding of the trade moves by exactly the difference, nothing is quarantined, the session does
        not stop, the signals do not notice and the replaced rate stays in the evidence (BAL-DECISION-184-03)."""
        report, portfolio = session.funding_report(), session.runner.portfolio
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(report["disputed_trades"], [])
        self.assertEqual(report["revised_periods"], [[BTC, HELD]])
        self.assertEqual(report["divergence"], {"missing": [], "extra": [], "rate_differs": []})        # book and portfolio agree
        self.assertEqual(report["counts"]["revision_applied"], 1)                                      # once, not once per delivery
        revisions = [a for a in portfolio.adjustments if a["kind"] == "funding_revision"]
        self.assertEqual(len(revisions), 1 if expect_adjustment else 0)
        trade = portfolio.trades[1]
        notional = D(trade["entry_price"]) * D(trade["quantity"])
        old, _ = accrue_funding([(HELD, HELD + HOUR, real_rate(HELD_ISO))], trade["entry_time_ms"], trade["exit_time_ms"], notional)
        new, _ = accrue_funding([(HELD, HELD + HOUR, real_rate(HELD_ISO) * D("1.5"))], trade["entry_time_ms"], trade["exit_time_ms"], notional)
        sign = 1 if trade["side"] == "LONG" else -1
        self.assertEqual(D(money(session)["funding_usd"]) - D(base["money"]["funding_usd"]), micro(sign * (new - old)))
        if expect_adjustment:
            self.assertEqual(micro(D(revisions[0]["after"]["funding_usd"]) - D(revisions[0]["before"]["funding_usd"])), micro(sign * (new - old)))
            self.assertEqual(revisions[0]["revised_periods"], [[HELD, HELD + HOUR]])
        evidence = [r for r in session.audit.records() if r["kind"] == "funding_evidence" and r["start_ms"] == HELD]
        self.assertIn("revision_applied", [e["evidence_kind"] for e in evidence])
        replaced = [e for e in evidence if e["evidence_kind"] == "revision_applied"][0]
        self.assertNotEqual(replaced["previous_rate"], replaced["rate"])                              # the replaced rate is kept
        self.assertEqual(session.digests()["signals"], base["signals"])
        self.assertTrue(report["pnl_verified"])
        self.assertNotIn("funding_conflict", [a["code"] for a in LI_alerts(session)])
        self.assertEqual([v for v in AU.audit(portfolio)["violations"]], [])

    def test_a_rate_revised_while_the_trade_is_open_prices_its_close_and_needs_no_adjustment(self):
        """The hour 19:00 is settled at 20:12 (the added copy) and corrected at 21:00:30, while the position is still open (until 21:25)."""
        base = self.baseline()
        self.assert_revised(self.revised_session(HELD + 2 * HOUR, extra_at=HELD + HOUR + 12 * MIN), base, expect_adjustment=False)

    def test_a_rate_revised_after_the_trade_closed_is_an_adjustment_and_the_session_goes_on(self):
        """The hour 19:00 is settled by the real response of 21:00:30 and corrected at 22:00:30, after the position closed (21:25)."""
        base = self.baseline()
        self.assert_revised(self.revised_session(HELD + 3 * HOUR), base, expect_adjustment=True)

    def test_a_provisional_hour_is_evidence_only_and_the_later_definitive_one_is_applied(self):
        """The real response of 20:00:30 lists the hour 19:00 30 seconds after it ended: not settled. Nothing from it reaches the money."""
        base = self.baseline()
        world, _, session = self.start()
        self.go(world, session)
        report = session.funding_report()
        self.assertGreaterEqual(report["counts"]["provisional"], 1)
        self.assertEqual(money(session), base["money"])
        kinds = [r["evidence_kind"] for r in session.audit.records() if r["kind"] == "funding_evidence" and r["start_ms"] == HELD]
        self.assertEqual(kinds[0], "provisional")
        self.assertNotIn("revision_applied", kinds)                                  # the settled rate is the one the provisional hour already had
        self.assertTrue(report["pnl_verified"])

    def test_a_death_and_recovery_in_the_middle_never_count_a_period_twice(self):
        base = self.baseline()
        world, directory, session = self.start()
        middle = PRE_INDEX + 20
        self.go(world, session, PRE_INDEX, middle)
        abandon(session)                                                           # the process dies: nothing is flushed
        again = self.open(world, directory)
        self.go(world, again, middle)
        self.assertEqual(money(again), base["money"])
        self.assertEqual(again.funding_report()["counts"]["accepted"], base["report"]["counts"]["accepted"])
        self.assertEqual(again.funding_report()["divergence"], {"missing": [], "extra": [], "rate_differs": []})
        audit = [r for r in again.audit.records() if r["kind"] == "funding_response"]
        self.assertEqual(len(audit), len({r["sha256"] for r in audit}))            # one record per response, replays included

    def test_with_alert_a_divergence_is_written_and_the_session_goes_on(self):
        world, directory, session = self.start(on_funding_divergence="alert")
        self.go(world, session, PRE_INDEX, PRE_INDEX + 36)                         # past 21:00:30: the hour 19:00 is in the book
        del session.runner.portfolio.funding[BTC][0]                                # the two authoritative states now disagree
        self.go(world, session, PRE_INDEX + 36, PRE_INDEX + 38)
        records = [r for r in session.audit.records() if r["kind"] == "funding_book_diverged"]
        self.assertTrue(records)
        self.assertEqual(len(records[0]["missing"]), 1)
        self.assertFalse(session.funding_report()["pnl_verified"])
        self.assertIsNone(session.halted)

    def test_an_unexplained_divergence_stops_the_session_by_default_and_repairs_nothing(self):
        base = self.baseline()
        world, directory, session = self.start()
        self.go(world, session, PRE_INDEX, PRE_INDEX + 36)
        del session.runner.portfolio.funding[BTC][0]
        with self.assertRaises(LI.IntegrationError) as stop:
            self.go(world, session, PRE_INDEX + 36, PRE_INDEX + 38)
        self.assertEqual(stop.exception.reason, "funding_book_diverged")
        self.assertIsNotNone(session.halted)
        with self.assertRaises(LI.IntegrationError):
            session.step(TIMES[PRE_INDEX + 38])
        self.assertEqual(len([r for r in session.audit.records() if r["kind"] == "funding_book_diverged"]), 1)     # the evidence is kept
        self.assertFalse(session.funding_report()["pnl_verified"])
        abandon(session)
        again = self.open(world, directory)                                         # recovered from the last checkpoint, by hand
        report = again.funding_report()
        self.assertEqual(report["divergence"], {"missing": [], "extra": [], "rate_differs": []})
        self.assertEqual(report["divergence_evidence"], 1)                          # the evidence survived the recovery
        self.assertFalse(report["pnl_verified"])                                    # and the P&L stays not verified
        self.assertIn("divergence_evidence_recorded", report["unverified_reasons"])
        self.go(world, again, PRE_INDEX + 36)
        self.assertEqual(money(again), base["money"])                               # no period charged twice, nothing rewritten

    def test_a_different_rate_in_the_portfolio_halts_the_session_like_a_missing_one(self):
        """D-204-02: ``rate_differs`` and ``extra`` stop the session as ``missing`` does."""
        for name, tamper, key in (("rate_differs", lambda f: f.__setitem__(0, (f[0][0], f[0][1], D("0.5"))), "rate_differs"),
                                  ("extra", lambda f: f.append((f[-1][1] + HOUR * 100, f[-1][1] + HOUR * 101, D("0.0001"))), "extra")):
            with self.subTest(difference=name):
                world, directory, session = self.start()
                self.go(world, session, PRE_INDEX, PRE_INDEX + 36)
                tamper(session.runner.portfolio.funding[BTC])
                with self.assertRaises(LI.IntegrationError) as stop:
                    self.go(world, session, PRE_INDEX + 36, PRE_INDEX + 38)
                self.assertEqual(stop.exception.reason, "funding_book_diverged")
                record_ = [r for r in session.audit.records() if r["kind"] == "funding_book_diverged"][0]
                self.assertEqual(len(record_[key]), 1)
                self.assertFalse(session.funding_report()["pnl_verified"])

    def test_the_default_of_the_session_is_to_halt_on_a_divergence(self):
        for method in (LI.LiveSession.create, LI.LiveSession.recover, LI.LiveSession.__init__):
            self.assertEqual(inspect.signature(method).parameters["on_funding_divergence"].default, "halt", method)

    def test_the_source_and_the_funding_mode_have_no_default(self):
        """D-262-01: a session never starts from a source or a funding mode nobody chose."""
        both = ("source_id", "funding_mode")
        for method, names in ((LI.LiveSession.create, both), (LI.LiveSession.recover, both), (LI.LiveSession._identity, both),
                              (LI.LiveSession.__init__, ("funding_mode",))):      # __init__ gets the source through ``identity``
            parameters = inspect.signature(method).parameters
            for name in names:
                self.assertIn(name, parameters, (method, name))      # a renamed parameter fails here instead of passing unseen
                self.assertIs(parameters[name].default, inspect.Parameter.empty, (method, name))

    def test_a_failing_read_of_the_signal_funding_stops_the_session_and_an_absent_table_does_not(self):
        """D-204-01: only a table that is not there means "no signal funding"; a lock or a disk error is not mistaken for it."""
        world, directory, session = self.start()
        world.db.execute("CREATE TABLE synthetic_fundpct(product_id TEXT, start_ms INTEGER, rate TEXT, arrival_ms INTEGER)")       # empty, written by hand
        world.db.commit()
        with mock.patch.object(LI.FundingSource, "fundpct", side_effect=sqlite3.OperationalError("database is locked")):
            with self.assertRaises(sqlite3.OperationalError):
                session.funding.fundpct(0)
            with self.assertRaises(sqlite3.OperationalError):
                self.go(world, session, PRE_INDEX, PRE_INDEX + 3)
        self.assertIsNotNone(session.halted)                                       # the session did not go on as if nothing was wrong

    def test_without_a_signal_funding_table_the_signal_channel_is_empty(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        path = os.path.join(root, "bare.sqlite")
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE paper_futures_market_events(x)")
        db.commit()
        db.close()
        source = LI.ObservedFundingSource(path)
        self.addCleanup(source.close)
        self.assertEqual(source.fundpct(0), [])

    def test_the_reference_price_is_the_newest_quote_that_arrived_in_the_hour_before(self):
        """The capture has no index on ``event_time``: the lookup goes through ``(product_id, received_at, seq)`` over the hour before
        the period, so it never walks the days of rows of a product (the first real session sat 11 minutes in that query)."""
        world, directory, session = self.start()
        self.go(world, session, PRE_INDEX, PRE_INDEX + 2)
        db = session.funding.db
        last = db.execute("SELECT MAX(event_time) FROM paper_futures_market_events WHERE feed='ticker' AND product_id=?", (BTC,)).fetchone()[0]
        expected = db.execute("SELECT normalized_json FROM paper_futures_market_events WHERE feed='ticker' AND product_id=? AND event_time=?",
                              (BTC, last)).fetchone()[0]
        body = loads_exact(expected)
        mid = (D(str(body["bid"])) + D(str(body["ask"]))) / 2
        self.assertEqual(session.funding.reference_price(BTC, last + 30 * MIN), mid)                    # half an hour later: still the newest quote
        self.assertIsNone(session.funding.reference_price(BTC, last + 30 * 86_400_000))                 # a month later: none in the hour before, never invented
        self.assertIsNone(session.funding.reference_price(BTC, 0))                                      # before any quote: none

    def test_the_reference_price_lookup_uses_the_capture_index_and_does_not_scan_the_product(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
CREATE TABLE paper_futures_market_events (
  event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
  event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
  raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX paper_futures_market_trade_uid ON paper_futures_market_events(feed, product_id, uid) WHERE uid IS NOT NULL;
CREATE INDEX paper_futures_market_received ON paper_futures_market_events(product_id, received_at, seq);
""")                                                                  # the capture's own schema (futures-market-store.ts)
        source = LI.ObservedFundingSource.__new__(LI.ObservedFundingSource)
        source.db, source._references = db, {}
        source.db.row_factory = sqlite3.Row
        sql = inspect.getsource(LI.ObservedFundingSource.reference_price)
        self.assertIn("received_at>=?", sql)
        plan = " ".join(r[3] for r in db.execute(
            "EXPLAIN QUERY PLAN SELECT event_time, normalized_json FROM paper_futures_market_events WHERE product_id=? AND received_at>=? "
            "AND received_at<=? AND feed='ticker' AND event_time<=? ORDER BY event_time DESC LIMIT 1", (BTC, 0, 1, 1)))
        self.assertIn("paper_futures_market_received (product_id=? AND received_at>? AND received_at<?)", plan.replace(">=", ">").replace("<=", "<"))
        self.assertIsNone(source.reference_price(BTC, 10))
        db.close()

    def test_the_former_synthetic_accounting_no_longer_exists(self):
        world, directory, session = self.start()
        abandon(session)
        with self.assertRaises(LI.IntegrationError) as bad:
            self.open(world, directory, funding_mode="synthetic")
        self.assertEqual(bad.exception.reason, "config_incompatible")


if __name__ == "__main__":
    unittest.main()
