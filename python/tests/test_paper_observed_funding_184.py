"""Issue #184: the session's accounting funding comes from the capture's own responses (``paper_futures_funding_responses`` /
``paper_futures_funding_periods``) through the #167 adapter, instead of the synthetic ``synthetic_accrual`` table, and stays apart
from the funding the signals use. Invented data only: the responses are written by the tests into a capture-shaped file."""

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal as D

from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_driver as RP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.multi_signals import stable_hash
from live_world import HOUR, LOAD_START, QUOTE_FROM, World
from test_paper_live_integration import (BTC, FIRST_DECISION, INGEST_KW, LAST_DECISION, MAX_QUOTE_GAP_MS, TIMES, abandon, journal_clock,
                                         record, runner_config)

RATE = "0.0001"
LAG = RP.FUNDING_LAG_MS
FIRST_HOUR = (FIRST_DECISION // HOUR) * HOUR
TABLES = """
CREATE TABLE paper_futures_funding_responses(
  sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL, raw_response TEXT NOT NULL) STRICT;
CREATE TABLE paper_futures_funding_periods(
  response_sha256 TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL,
  known_at INTEGER NOT NULL, unit TEXT NOT NULL, product_id TEXT NOT NULL, PRIMARY KEY(response_sha256, start_ms)) STRICT;
"""


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def mid_at(world, at_ms):
    """The same price the source's ``reference_price`` finds: the newest quote at or before the hour."""
    last = None
    for t, mid in world.quotes:
        if t > at_ms:
            break
        last = mid
    return last


def plan_response(hours, received_ms, product=BTC, rates=None):
    return {"hours": list(hours), "received_ms": received_ms, "product": product, "rates": dict(rates or {})}


def write_plan(world, plan):
    """Inserts the responses in the order they arrived (the capture appends them as they come, so row order is arrival order)."""
    for item in sorted(plan, key=lambda x: x["received_ms"]):
        write_response(world, item["hours"], item["received_ms"], item["product"], rates=item["rates"])


def write_response(world, hours, received_ms, product=BTC, *, rates=None):
    """One response of ``historical-funding-rates`` with the given hour starts, arrived at ``received_ms``."""
    rates = rates or {}
    items = []
    for start in hours:
        relative = D(rates.get(start, RATE))
        price = mid_at(world, start)
        items.append({"timestamp": iso(start), "fundingRate": float(relative * price), "relativeFundingRate": float(relative)})
    raw = json.dumps({"result": "success", "serverTime": iso(received_ms), "rates": items}, sort_keys=True)
    sha = stable_hash(raw)
    db = world.source.db
    db.execute("INSERT OR IGNORE INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, received_ms, iso(received_ms), raw))
    for start in hours:
        db.execute("INSERT OR IGNORE INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                   (sha, start, start + HOUR, str(rates.get(start, RATE)), received_ms, "USD/BTC/hour", product))
    world.source.commit()
    return sha


def hourly_plan(first_hour, last_hour, *, skip=(), overlap=3):
    """What the capture would have stored: one response per hour, a LAG after the hour ends, with the ``overlap`` newest hours."""
    plan, hour = [], first_hour
    while hour <= last_hour:
        if hour not in skip:
            hours = [h for h in range(hour - (overlap - 1) * HOUR, hour + 1, HOUR) if h >= first_hour and h not in skip]
            plan.append(plan_response(hours, hour + HOUR + LAG))
        hour += HOUR
    return plan


def hourly_responses(world, first_hour, last_hour, **kw):
    write_plan(world, hourly_plan(first_hour, last_hour, **kw))


def new_world(root, *, observed, **kw):
    world = World(root, **kw)
    if observed:
        world.source.db.execute("DROP TABLE synthetic_accrual")              # nothing synthetic is left in the accounting path
        world.source.db.executescript(TABLES)
        world.source.commit()
    return world


def make_session(world, directory, strategies, *, observed, **kw):
    world.release_until(LOAD_START)
    return LI.LiveSession.create(directory, world.path, strategies, (BTC,), runner_config(), decide_from_ms=FIRST_DECISION,
                                 decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW, max_quote_gap_ms=MAX_QUOTE_GAP_MS,
                                 funding_mode="observed" if observed else "synthetic", **kw)


def run(session, world, upto):
    records = []
    for now in TIMES[:upto]:
        world.release_until(now)
        session.step(now)
        records.append(record(session, now))
    return records


def money(session):
    snap = session.runner.portfolio.snapshot()
    return {"funding_usd": snap["funding_usd"], "fees": snap["fees_usd"], "closed": snap["closed_trades"], "open": snap["open_positions"],
            "trades": [(t["product_id"], t["exit_reason"], str(t["pnl_usd"]), t["funding_status"]) for t in session.runner.portfolio.trades]}


class TestObservedFunding(unittest.TestCase):
    cache = {}
    STEPS = len(TIMES)

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"], _ = RS.load_frozen()
        last_hour = ((TIMES[cls.STEPS - 1] - LAG) // HOUR - 1) * HOUR
        cls.cache["last_hour"] = last_hour
        for name, observed in (("synthetic", False), ("observed", True)):
            where = os.path.join(root, name)
            os.makedirs(where)
            world = new_world(where, observed=observed)
            if observed:
                hourly_responses(world, FIRST_HOUR, last_hour)
            session = make_session(world, os.path.join(where, "s"), cls.cache["strategies"], observed=observed)
            records = run(session, world, cls.STEPS)
            cls.cache[name] = {"session": session, "world": world, "records": records, "where": where}

    @classmethod
    def tearDownClass(cls):
        for name in ("synthetic", "observed"):
            if name in cls.cache:
                abandon(cls.cache[name]["session"])
                cls.cache[name]["world"].close()
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def test_the_observed_accounting_gives_the_same_money_as_the_synthetic_one_with_the_same_rates(self):
        a, b = self.cache["synthetic"]["session"], self.cache["observed"]["session"]
        self.assertGreater(money(a)["closed"], 0)
        self.assertNotEqual(money(a)["funding_usd"], "0")                      # the comparison is not between two empty accruals
        self.assertEqual(money(b), money(a))

    def test_the_signals_are_the_same_whatever_the_accounting_channel(self):
        a, b = self.cache["synthetic"]["records"], self.cache["observed"]["records"]
        self.assertEqual([r["signals"] for r in b], [r["signals"] for r in a])

    def test_the_book_and_the_portfolio_agree_and_an_incomplete_trade_is_never_called_verified(self):
        session, reference = self.cache["observed"]["session"], self.cache["synthetic"]["session"]
        report = session.funding_report()
        self.assertEqual(report["divergence"], {"missing": [], "extra": [], "rate_differs": []})
        self.assertGreater(report["counts"]["accepted"], 0)
        self.assertGreater(report["counts"]["duplicate"], 0)                    # overlapping responses are recognised, not applied twice
        self.assertEqual(report["quarantined"], [])
        # the last trade closed after the newest published hour: its funding is partial in both modes, and the report says so
        partial = sorted(t["trade_id"] for t in reference.runner.portfolio.trades if not t["net_complete"])
        self.assertNotEqual(partial, [])
        self.assertEqual(report["incomplete_trades"], partial)
        self.assertFalse(report["pnl_verified"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "funding_book_diverged"], [])

    def test_no_synthetic_accrual_is_read_in_the_observed_path(self):
        session = self.cache["observed"]["session"]
        self.assertIsInstance(session.funding, LI.ObservedFundingSource)
        self.assertEqual(session.identity["funding_channels"]["accrual"], "paper_futures_funding_responses")
        with self.assertRaises(LI.IntegrationError):
            session.funding.accrual(0)


CUT = 125                                          # steps: the first position (hours FIRST_HOUR .. FIRST_HOUR+2) is closed by then
HOUR_HELD = FIRST_HOUR + HOUR                      # a whole hour inside the first position's holding time
LAST_HOUR = FIRST_HOUR + 8 * HOUR


class TestObservedFundingScenarios(unittest.TestCase):
    """Coverage, contradictions, provisional hours, divergence and recovery. Every scenario starts from the same session, stopped
    before its first position, in a world that has no funding response yet; each writes its own responses into its own copy."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"], _ = RS.load_frozen()
        world = new_world(root, observed=True)
        session = make_session(world, os.path.join(root, "a"), cls.cache["strategies"], observed=True)
        index = next(i for i, t in enumerate(TIMES) if t >= FIRST_DECISION + 50 * 60_000) - 1
        run(session, world, index)
        cls.cache["index"] = index
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
        """A recovered session on its own copy of the world, with the funding responses ``tweak`` writes (default: every hour)."""
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        write_plan(world, (tweak or (lambda: hourly_plan(FIRST_HOUR, LAST_HOUR)))())
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        session = self.open(world, directory, **kw)
        return world, directory, session

    def open(self, world, directory, **kw):
        session = LI.LiveSession.recover(directory, world.path, self.cache["strategies"], (BTC,), runner_config(), journal_clock(directory),
                                         decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                         max_quote_gap_ms=MAX_QUOTE_GAP_MS, **dict({"funding_mode": "observed"}, **kw))
        self.addCleanup(abandon, session)
        return session

    def go(self, world, session, first, last=CUT):
        for now in TIMES[first:last]:
            world.release_until(now)
            session.step(now)

    def baseline(self):
        if "baseline" not in self.cache:
            world, _, session = self.start()
            self.go(world, session, self.cache["index"])
            self.cache["baseline"] = {"money": money(session), "report": session.funding_report(), "signals": session.digests()["signals"]}
        return self.cache["baseline"]

    def test_a_clean_run_is_verified_and_pays_funding(self):
        base = self.baseline()
        self.assertTrue(base["report"]["pnl_verified"])
        self.assertEqual(base["report"]["incomplete_trades"], [])
        self.assertNotEqual(base["money"]["funding_usd"], "0")
        self.assertGreaterEqual(base["money"]["closed"], 1)

    def test_a_missing_hour_leaves_the_trade_partial_and_the_result_unverified(self):
        base = self.baseline()
        world, _, session = self.start(lambda: hourly_plan(FIRST_HOUR, LAST_HOUR, skip=(HOUR_HELD,)))
        self.go(world, session, self.cache["index"])
        report = session.funding_report()
        trade = session.runner.portfolio.trades[0]
        self.assertFalse(trade["net_complete"])
        self.assertIsNone(trade["net_usd"])                                     # a net result is not announced from a hole
        self.assertEqual(report["incomplete_trades"], [trade["trade_id"]])
        self.assertFalse(report["pnl_verified"])
        self.assertIn("funding_incomplete", [a["code"] for a in LI_alerts(session)])
        self.assertNotEqual(money(session)["funding_usd"], base["money"]["funding_usd"])
        self.assertEqual(session.digests()["signals"], base["signals"])           # the signals do not know about the accounting channel

    def test_a_contradictory_revision_is_quarantined_flagged_and_never_replaces_the_first_one(self):
        base = self.baseline()

        def tweak():
            return hourly_plan(FIRST_HOUR, LAST_HOUR) + [plan_response([HOUR_HELD], HOUR_HELD + HOUR + LAG + 5 * 60_000, rates={HOUR_HELD: "0.0009"})]

        world, _, session = self.start(tweak)
        self.go(world, session, self.cache["index"])
        report = session.funding_report()
        self.assertEqual([(p, s) for p, s, _ in report["quarantined"]], [(BTC, HOUR_HELD)])
        self.assertEqual(money(session)["funding_usd"], base["money"]["funding_usd"])          # the first rate seen stays in use
        self.assertEqual(report["disputed_trades"], [session.runner.portfolio.trades[0]["trade_id"]])
        self.assertFalse(report["pnl_verified"])
        self.assertIn("funding_conflict", [a["code"] for a in LI_alerts(session)])
        evidence = [r for r in session.audit.records() if r["kind"] == "funding_evidence" and r["start_ms"] == HOUR_HELD]
        self.assertEqual([e["evidence_kind"] for e in evidence], ["revision_conflict"])
        self.assertEqual(evidence[0]["rates"], ["0.0001", "0.0009"])               # both rates are kept as evidence
        self.assertEqual(session.digests()["signals"], base["signals"])

    def test_a_provisional_hour_is_evidence_only_and_the_later_definitive_one_is_applied(self):
        base = self.baseline()

        def tweak():
            return hourly_plan(FIRST_HOUR, LAST_HOUR) + [plan_response([HOUR_HELD], HOUR_HELD + HOUR + 60_000)]    # not settled yet

        world, _, session = self.start(tweak)
        self.go(world, session, self.cache["index"])
        report = session.funding_report()
        self.assertGreaterEqual(report["counts"]["provisional"], 1)
        self.assertEqual(money(session), base["money"])                              # nothing from the provisional value reached the money
        self.assertTrue(report["pnl_verified"])
        self.assertEqual([r["evidence_kind"] for r in session.audit.records() if r["kind"] == "funding_evidence" and r["start_ms"] == HOUR_HELD],
                         ["provisional"])

    def test_a_death_and_recovery_in_the_middle_never_count_a_period_twice(self):
        base = self.baseline()
        world, directory, session = self.start()
        middle = self.cache["index"] + 8
        self.go(world, session, self.cache["index"], middle)
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
        self.go(world, session, self.cache["index"], self.cache["index"] + 14)
        del session.runner.portfolio.funding[BTC][0]                                # the two authoritative states now disagree
        self.go(world, session, self.cache["index"] + 14, self.cache["index"] + 16)
        records = [r for r in session.audit.records() if r["kind"] == "funding_book_diverged"]
        self.assertTrue(records)
        self.assertEqual(len(records[0]["missing"]), 1)
        self.assertFalse(session.funding_report()["pnl_verified"])
        self.assertIsNone(session.halted)

    def test_an_unexplained_divergence_stops_the_session_by_default_and_repairs_nothing(self):
        base = self.baseline()
        world, directory, session = self.start()
        self.go(world, session, self.cache["index"], self.cache["index"] + 14)
        del session.runner.portfolio.funding[BTC][0]
        with self.assertRaises(LI.IntegrationError) as stop:
            self.go(world, session, self.cache["index"] + 14, self.cache["index"] + 16)
        self.assertEqual(stop.exception.reason, "funding_book_diverged")
        self.assertIsNotNone(session.halted)
        with self.assertRaises(LI.IntegrationError):
            session.step(TIMES[self.cache["index"] + 16])
        self.assertEqual(len([r for r in session.audit.records() if r["kind"] == "funding_book_diverged"]), 1)     # the evidence is kept
        self.assertFalse(session.funding_report()["pnl_verified"])
        abandon(session)
        again = self.open(world, directory)                                         # recovered from the last checkpoint, by hand
        report = again.funding_report()
        self.assertEqual(report["divergence"], {"missing": [], "extra": [], "rate_differs": []})
        self.assertEqual(report["divergence_evidence"], 1)                          # the evidence survived the recovery
        self.assertFalse(report["pnl_verified"])                                    # and the P&L stays not verified
        self.assertIn("divergence_evidence_recorded", report["unverified_reasons"])
        self.go(world, again, self.cache["index"] + 14)
        self.assertEqual(money(again), base["money"])                               # no period charged twice, nothing rewritten

    def test_a_directory_made_with_the_observed_accounting_is_not_opened_as_a_synthetic_one(self):
        world, directory, session = self.start()
        abandon(session)
        with self.assertRaises(LI.IntegrationError) as bad:
            self.open(world, directory, funding_mode="synthetic")
        self.assertEqual(bad.exception.reason, "session_mismatch")


def LI_alerts(session):
    from balancita_engine import paper_runner_report as REP
    return REP.alerts(session.runner)


if __name__ == "__main__":
    unittest.main()
