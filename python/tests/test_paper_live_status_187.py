"""Issue #187: the operating block published from the files the process leaves. Invented data only; nothing reads a real database."""

import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine import paper_live_publish as PUB


def beat(phase="LIVE", **extra):
    return dict({"schema": LP.HEARTBEAT_SCHEMA, "session_id": "s", "config_digest": "d", "phase": phase, "steps": 12, "observed_now_ms": 1_000,
                 "pending_orders": 0, "open_positions": 0}, **extra)


class TestContractWithTheProcess(unittest.TestCase):
    def test_the_published_names_cover_every_phase_the_process_writes(self):
        phases = {LP.INIT, LP.WARMUP, LP.LIVE, LP.STOPPING, LP.STOPPED_PHASE, LP.HALTED, LP.REFUSED_PHASE}
        self.assertEqual(set(PUB.PUBLISHED_PHASE), phases)
        self.assertEqual(PUB.HEARTBEAT_SCHEMA, LP.HEARTBEAT_SCHEMA)
        self.assertEqual(set(PUB.FINAL_PHASES), set(LP.FINAL_PHASES))


class TestSessionStatus(unittest.TestCase):
    def test_a_running_phase_is_never_promoted_without_an_approved_limit(self):
        for age, limit, approved in ((None, None, False), (500, None, False), (500, 5_000, False)):
            with self.subTest(age=age, limit=limit):
                block = PUB.session_status(beat(), heartbeat_age_ms=age, max_age_ms=limit, threshold_approved=approved)
                self.assertEqual((block["phase"], block["liveness"]), ("LIVE", "unknown"))
                self.assertNotEqual(block["liveness"], "alive")
        ok = PUB.session_status(beat(), heartbeat_age_ms=500, max_age_ms=5_000, threshold_approved=True)
        self.assertEqual(ok["liveness"], "alive")
        self.assertEqual(ok["thresholds"]["status"], "approved")

    def test_an_old_heartbeat_degrades_the_phase_to_unverified(self):
        block = PUB.session_status(beat(), heartbeat_age_ms=60_000, max_age_ms=5_000)
        self.assertEqual((block["phase"], block["liveness"], block["reported_phase"]), ("unverified", "stale", "LIVE"))
        self.assertIn("heartbeat_stale", block["reasons"])

    def test_the_names_of_the_phases(self):
        self.assertEqual(PUB.session_status(beat("WARMUP"))["phase"], "WARMING_UP")
        self.assertEqual(PUB.session_status(beat("INIT"))["phase"], "INIT")

    def test_an_ended_phase_is_final_whatever_the_age(self):
        for phase in ("STOPPED", "HALTED", "REFUSED"):
            block = PUB.session_status(beat(phase), heartbeat_age_ms=10 ** 9, max_age_ms=1)
            self.assertEqual((block["phase"], block["liveness"]), (phase, "final"))

    def test_the_halt_file_outranks_a_heartbeat_that_never_said_halted(self):
        block = PUB.session_status(beat("LIVE"), halt={"reason": "funding_book_diverged: x"}, heartbeat_age_ms=1, max_age_ms=1_000)
        self.assertEqual((block["phase"], block["liveness"]), ("HALTED", "final"))
        self.assertEqual(block["halt_reason"], "funding_book_diverged: x")
        self.assertIn("halt_file_outranks_heartbeat", block["reasons"])
        only_halt = PUB.session_status(None, halt={"reason": "r"})              # the heartbeat is gone as well
        self.assertEqual((only_halt["phase"], only_halt["halt_reason"]), ("HALTED", "r"))

    def test_a_report_that_ended_after_the_last_heartbeat_wins_only_for_the_same_run(self):
        report = {"ended_as": "STOPPED", "stop": {"signal": "SIGTERM"}, "session_id": "s", "config_digest": "d", "ended_at_observed_ms": 1_000}
        block = PUB.session_status(beat("LIVE", observed_now_ms=900), report=report)             # written after the last heartbeat: the report wins
        self.assertEqual((block["phase"], block["liveness"], block["orderly_stop"]), ("STOPPED", "final", {"signal": "SIGTERM"}))
        self.assertIn("report_ended_after_heartbeat", block["reasons"])
        self.assertEqual(PUB.session_status(beat("LIVE"), report=report)["phase"], "LIVE")        # a tie goes to the heartbeat
        # D-223-01: an older report (a previous run, kept across an operator restart) never outranks the heartbeat
        # (report, observed time of the heartbeat): the identity cases use a heartbeat OLDER than the report, so only the identity rejects them (D-223-04)
        cases = {"older report": (dict(report, ended_at_observed_ms=999), 1_000), "same time": (dict(report, ended_at_observed_ms=1_000), 1_000),
                 "other session": (dict(report, session_id="x"), 900), "other configuration": (dict(report, config_digest="y"), 900),
                 "no time": ({k: v for k, v in report.items() if k != "ended_at_observed_ms"}, 900)}
        for name, (other, seen) in cases.items():
            with self.subTest(name=name):
                block = PUB.session_status(beat("WARMUP", observed_now_ms=seen), report=other)
                self.assertEqual(block["phase"], "WARMING_UP")
                self.assertNotIn("report_ended_after_heartbeat", block["reasons"])
                self.assertIsNone(block["orderly_stop"])
        only_report = PUB.session_status(None, report=dict(report, ended_as="HALTED", halted="boom"))     # no heartbeat: nothing to compare
        self.assertEqual((only_report["phase"], only_report["halt_reason"]), ("HALTED", "boom"))
        refused = PUB.session_status(beat("LIVE", observed_now_ms=900), report=dict(report, ended_as="REFUSED"))              # D-223-02: handled like the others
        self.assertEqual(refused["phase"], "REFUSED")

    def test_the_report_of_the_run_that_just_ended_is_kept_when_its_time_ties_with_the_final_heartbeat(self):
        """A run writes its report and then the final heartbeat at the same observation time: they are the same run, nothing to discard."""
        report = {"ended_as": "STOPPED", "stop": {"signal": "SIGTERM"}, "session_id": "s", "config_digest": "d", "ended_at_observed_ms": 1_000,
                  "clock": {"events": []}, "funding": {"mode": "synthetic"}}
        block = PUB.session_status(beat("STOPPED"), report=report)
        self.assertEqual((block["phase"], block["orderly_stop"], block["clock"]), ("STOPPED", {"signal": "SIGTERM"}, {"events": []}))
        self.assertEqual(block["funding"]["source"], "synthetic")
        stale = PUB.session_status(beat("STOPPED", observed_now_ms=1_001), report=report)          # a report older than the final heartbeat is not this run's
        self.assertIsNone(stale["orderly_stop"])

    def test_what_cannot_be_read_is_unavailable_never_a_quiet_live(self):
        cases = {"heartbeat_missing": (None, None), "heartbeat_schema_unknown": (dict(beat(), schema="other.v9"), None),
                 "heartbeat_phase_unknown": (beat("DEGRADED"), None), "heartbeat_phase_missing": (beat(phase=None), None)}
        for reason, (heartbeat, halt) in cases.items():
            with self.subTest(reason=reason):
                block = PUB.session_status(heartbeat, halt)
                self.assertEqual(block["phase"], "unavailable")
                self.assertEqual(block["reasons"], [reason])

    def test_the_block_is_tagged_as_integration_and_carries_resources_and_clock_as_the_process_wrote_them(self):
        resources = {"last": {"disk_bytes": 5, "memory_bytes": 7}, "events": []}
        block = PUB.session_status(beat(resources=resources), report={"ended_as": "HALTED", "halted": "clock_regressed", "session_id": "s", "config_digest": "d",
                                                                      "ended_at_observed_ms": 2_000, "clock": {"events": [{"kind": "regression"}]}})
        self.assertEqual((block["mode"], block["evidence_class"]), ("integration", "not_forward_evidence"))
        self.assertEqual(block["resources"], resources)
        self.assertEqual(block["clock"], {"events": [{"kind": "regression"}]})
        self.assertNotIn("execution_class", block)
        self.assertNotIn("verified", block)                                          # this block never says an account is verified


def observed(**over):
    """A funding report as ``LiveSession.funding_report()`` writes it for a session that reads the funding the capture stored."""
    return dict({"mode": "observed", "counts": {}, "quarantined": [], "disputed_trades": [], "incomplete_trades": [], "divergence": {},
                 "divergence_evidence": 0, "unverified_reasons": [], "pnl_verified": True}, **over)


class TestFundingBlock(unittest.TestCase):
    def test_where_the_funding_comes_from_is_always_said(self):
        self.assertEqual(PUB.funding_block({"mode": "synthetic"})["source"], "synthetic")
        self.assertEqual(PUB.funding_block(observed())["source"], "observed")
        for nothing in (None, {}, "observed", {"counts": {}}):
            with self.subTest(nothing=nothing):
                block = PUB.funding_block(nothing)
                self.assertEqual((block["source"], block["pnl_verified"], block["reasons"]), ("unknown", False, ["funding_report_missing"]))
        self.assertEqual(PUB.funding_block({"mode": "real"})["source"], "unknown")

    def test_a_synthetic_result_is_never_verified(self):
        block = PUB.funding_block({"mode": "synthetic"})
        self.assertFalse(block["pnl_verified"])
        self.assertEqual(block["reasons"], ["synthetic_funding"])

    def test_only_a_complete_observed_report_is_verified(self):
        self.assertTrue(PUB.funding_block(observed())["pnl_verified"])
        for name, over in {"incomplete": {"incomplete_trades": ["t1"]}, "disputed": {"disputed_trades": ["t2"]},
                           "diverge": {"divergence": {"BTC": True}}, "evidence": {"divergence_evidence": 1},
                           "listed reason": {"unverified_reasons": ["x"]}}.items():
            with self.subTest(name=name):
                block = PUB.funding_block(observed(**over))                      # the producer still says pnl_verified: true
                self.assertFalse(block["pnl_verified"])
                self.assertTrue(block["reasons"])

    def test_a_producer_that_does_not_say_verified_is_not_overruled(self):
        self.assertFalse(PUB.funding_block(observed(pnl_verified=False))["pnl_verified"])         # no reason listed, still not verified
        self.assertFalse(PUB.funding_block(observed(pnl_verified=None))["pnl_verified"])

    def test_the_reasons_are_recomputed_from_the_facts_and_a_gap_in_the_report_is_not_fine(self):
        block = PUB.funding_block(observed(incomplete_trades=["t1"], disputed_trades=["t2"]))
        self.assertIn("trade_funding_incomplete", block["reasons"])
        self.assertIn("trade_funding_disputed", block["reasons"])
        missing = observed()
        del missing["divergence_evidence"]
        block = PUB.funding_block(missing)
        self.assertFalse(block["pnl_verified"])
        self.assertIn("funding_report_incomplete", block["reasons"])

    def test_the_status_block_carries_it_from_the_argument_or_from_the_report(self):
        self.assertEqual(PUB.session_status(beat())["funding"]["source"], "unknown")
        self.assertEqual(PUB.session_status(beat(), funding=observed())["funding"]["source"], "observed")
        report = {"ended_as": "STOPPED", "session_id": "s", "config_digest": "d", "ended_at_observed_ms": 2_000, "funding": {"mode": "synthetic"}}
        self.assertEqual(PUB.session_status(beat(), report=report)["funding"]["source"], "synthetic")
        self.assertEqual(PUB.session_status(beat(), report=report, funding=observed(incomplete_trades=["t"]))["funding"]["reasons"],
                         ["trade_funding_incomplete"])                           # the live report of the session outranks the copy in the file
        gone = PUB.session_status(None)                                          # nothing readable: the funding is unknown too, not absent
        self.assertEqual((gone["phase"], gone["funding"]["source"]), ("unavailable", "unknown"))


if __name__ == "__main__":
    unittest.main()
