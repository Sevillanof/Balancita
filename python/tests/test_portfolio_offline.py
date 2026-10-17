"""Offline executor for the shared portfolio: scenarios, independent invariants, journal, determinism, event
idempotency, and restart from a persisted checkpoint (a re-run from the start is not a recovery)."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import portfolio_offline, portfolio_scenarios as S
from balancita_engine.portfolio import Portfolio, PortfolioPolicy
from balancita_engine import portfolio_two_process as TP
from balancita_engine.portfolio_offline import (
    Journal, OfflineExecutor, RecoveryError, _groups, read_checkpoint, run_scenario, write_checkpoint,
)

D = Decimal
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MIN = 60_000


def kinds(run, kind, **where):
    return [e for e in run["journal"].entries if e["kind"] == kind and all(e["data"].get(k) == v for k, v in where.items())]


def closes(run):
    return [e["data"] for e in kinds(run, "position_closed") if not e["data"].get("replay")]


def concurrency(run):
    """Maximum number of positions open at once, from the journal alone."""
    live, peak = set(), 0
    for e in run["journal"].entries:
        d = e["data"]
        if e["kind"] == "decision" and d["status"] == "opened":
            live.add(d["intent_id"])
        elif e["kind"] == "position_closed":
            live.discard(d["intent_id"])
        peak = max(peak, len(live))
    return peak


class Scenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenarios = {s["name"]: s for s in S.all_scenarios()}
        cls.runs = {name: run_scenario(s) for name, s in cls.scenarios.items()}

    def test_every_scenario_passes_every_independent_check(self):
        for name, run in self.runs.items():
            self.assertEqual(run["violations"], [], name)
            self.assertGreater(run["checks"], 5, name)
            self.assertTrue(run["journal_chain_intact"] and run["time_order_ok"], name)

    def test_simultaneous_long_and_short_positions_within_the_limits(self):
        run = self.runs["s1_posiciones_simultaneas"]
        self.assertGreaterEqual(concurrency(run), 3)
        sides = {e["data"]["side"] for e in kinds(run, "decision", status="opened")}
        self.assertEqual(sides, {"LONG", "SHORT"})
        reasons = run["snapshot"] and run["stats"]
        self.assertEqual(reasons.get("rejected:contradictory_signals"), 2)
        # the aggregate planned risk never exceeded 2 % of the definitive capital at the time
        for e in kinds(run, "decision", status="opened"):
            d = e["data"]
            self.assertLessEqual(D(d["open_risk_after_usd"]), D("0.02") * D(d["capital_definitive_usd"]))
        # invalid levels (ATR 0) never became an intent
        self.assertEqual(run["stats"]["intents_not_built"], 1)

    def test_consecutive_losses_shrink_the_budget_and_the_daily_limit_stops_new_risk(self):
        run = self.runs["s2_perdidas_consecutivas"]
        trades = closes(run)
        self.assertEqual([t["exit_reason"] for t in trades], ["stop"] * 4)
        self.assertTrue(all(D(str(t["pnl_usd"])) < 0 for t in trades))
        budgets = [D(e["data"]["risk_budget_usd"]) for e in kinds(run, "decision", status="opened")]
        self.assertEqual(budgets, sorted(budgets, reverse=True))
        self.assertLess(budgets[-1], budgets[0])
        self.assertEqual(run["stats"]["rejected:daily_loss_budget"], 1)
        lost = D(run["snapshot"]["equity_usd"]) - D(1000)
        self.assertGreater(lost, D("-20.0001"))  # admitted risk plus realized loss never passes the 20 USD limit

    def test_duplicates_stale_forged_and_inconsistent_inputs(self):
        run = self.runs["s3_duplicados_y_orden"]
        stats = run["stats"]
        self.assertEqual(stats["rejected:inconsistent_signal"], 2)
        self.assertEqual(stats["rejected:duplicate_signal"], 1)
        self.assertEqual(stats["rejected:duplicate_intent"], 1)
        self.assertEqual(stats["rejected:stale_data"], 1)
        self.assertEqual(stats["signals_invalid"], 1)
        self.assertEqual(stats["duplicate_candles_ignored"], 1)
        self.assertEqual(stats["conflicting_candles_rejected"], 1)
        self.assertEqual(stats["late_candles_refused"], 1)
        self.assertTrue(kinds(run, "candle_gap"))
        # one XBT position, one SOL position: nothing opened twice, nothing opened from the forged or stale copies
        opened = kinds(run, "decision", status="opened")
        self.assertEqual(sorted(e["data"]["product_id"] for e in opened), ["PF_SOLUSD", "PF_XBTUSD"])
        self.assertEqual(run["snapshot"]["closed_trades"], 2)

    def test_verified_and_provisional_results_are_kept_apart(self):
        run = self.runs["s4_funding_incompleto"]
        trades = run["executor"].portfolio.trades
        verified = [t for t in trades if t["net_complete"]]
        provisional = [t for t in trades if not t["net_complete"]]
        self.assertEqual((len(verified), len(provisional)), (1, 3))
        self.assertEqual({t["funding_status"] for t in provisional}, {"partial", "unknown"})
        self.assertTrue(all(t["net_usd"] is None for t in provisional))
        snap = run["snapshot"]
        gains = sum(D(str(t["pnl_usd"])) for t in provisional if D(str(t["pnl_usd"])) > 0)
        losses = sum(D(str(t["pnl_usd"])) for t in provisional if D(str(t["pnl_usd"])) < 0)
        self.assertGreater(gains, 0)
        self.assertEqual(D(snap["provisional_gains_usd"]), gains)
        # definitive capital = initial + verified net + provisional LOSSES only
        self.assertEqual(D(snap["capital_definitive_usd"]), D(1000) + sum(D(str(t["net_usd"])) for t in verified) + losses)
        self.assertEqual(D(snap["equity_usd"]) - D(snap["capital_definitive_usd"]), gains)
        for entry in kinds(run, "position_closed"):
            self.assertEqual(entry["data"]["accounting"], "verified" if entry["data"]["net_complete"] else "provisional")

    def test_integrated_scenario_has_every_required_ingredient(self):
        run = self.runs["s5_integral_reinicio_replay_log"]
        self.assertGreaterEqual(concurrency(run), 3)
        pnl = [D(str(t["pnl_usd"])) for t in run["executor"].portfolio.trades]  # effective ledger, replays included once
        streak = best = 0
        for value in pnl:
            streak = streak + 1 if value < 0 else 0
            best = max(best, streak)
        self.assertGreaterEqual(best, 3, pnl)
        self.assertTrue(any(t["funding_status"] != "complete" for t in closes(run)))
        self.assertGreater(run["stats"]["duplicate_events_ignored"], 0)
        self.assertGreater(run["stats"]["rejected:duplicate_signal"] + run["stats"]["rejected:duplicate_intent"], 0)
        self.assertTrue(kinds(run, "restart"))

    def test_every_position_can_be_traced_from_signal_to_capital(self):
        for name in ("s1_posiciones_simultaneas", "s4_funding_incompleto", "s5_integral_reinicio_replay_log"):
            run = self.runs[name]
            entries = run["journal"].entries
            for e in [x for x in entries if x["kind"] == "position_closed" and not x["data"].get("replay") and x["epoch"] == 0]:
                d = e["data"]
                opened = [x for x in entries if x["kind"] == "decision" and x["data"]["status"] == "opened"
                          and x["data"]["intent_id"] == d["intent_id"] and x["seq"] < e["seq"]]
                self.assertEqual(len(opened), 1, (name, d["intent_id"]))
                intent = [x for x in entries if x["kind"] == "intent_built" and x["data"]["intent_id"] == d["intent_id"]]
                self.assertTrue(intent and intent[0]["seq"] < opened[0]["seq"])
                signal = [x for x in entries if x["kind"] == "signal_received" and x["data"]["signal_id"] == opened[0]["data"]["signal_id"]]
                self.assertTrue(signal and signal[0]["seq"] < intent[0]["seq"])
                for field in ("notional_usd", "entry_price", "stop_price", "exit_price", "fees_usd", "funding_status", "capital_after_usd"):
                    self.assertIn(field, d)
                self.assertEqual(opened[0]["data"]["stop"], intent[0]["data"]["stop"])
            # capital continuity: each close starts from where the previous one left it
            seq = [x["data"] for x in entries if x["kind"] == "position_closed" and not x["data"].get("replay") and x["epoch"] == 0]
            previous = D(1000)
            for d in seq:
                self.assertEqual(D(d["capital_before_usd"]), previous)
                previous = D(d["capital_after_usd"])

    def test_stop_losses_match_the_plan_so_sizing_and_execution_agree(self):
        for name, run in self.runs.items():
            for d in closes(run):
                if d["exit_reason"] == "stop":
                    realized = -(D(d["gross_usd"]) - D(str(d["fees_usd"])))
                    self.assertAlmostEqual(float(realized), float(d["planned_loss_usd"]), places=3, msg=name)


class Determinism(unittest.TestCase):
    def test_same_scenario_same_hashes(self):
        for scenario in S.all_scenarios():
            a, b = run_scenario(scenario), run_scenario(scenario)
            for key in ("journal_hash", "ledger_hash", "state_digest", "feed_hash"):
                self.assertEqual(a[key], b[key], (scenario["name"], key))

    def test_hashes_do_not_depend_on_the_interpreter_hash_seed(self):
        code = ("import json;from balancita_engine import portfolio_scenarios as S;from balancita_engine.portfolio_offline import run_scenario;"
                "print(json.dumps([[r['journal_hash'],r['ledger_hash'],r['state_digest']] for r in (run_scenario(s) for s in S.all_scenarios())]))")
        outs = []
        for seed in ("1", "424242"):
            env = dict(os.environ, PYTHONHASHSEED=seed, PYTHONPATH=os.path.join(ROOT, "python"))
            outs.append(subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(outs[0], outs[1])

    def test_whole_event_stream_delivered_twice_changes_nothing(self):
        scenario = S.s1_simultaneous()
        single = run_scenario(scenario)
        doubled = dict(scenario, events=scenario["events"] + [dict(e) for e in scenario["events"]])
        twice = run_scenario(doubled)
        self.assertEqual(single["ledger_hash"], twice["ledger_hash"])
        self.assertEqual(single["snapshot"], twice["snapshot"])
        self.assertEqual(twice["stats"]["duplicate_events_ignored"], len(scenario["events"]))


class Journal_(unittest.TestCase):
    def test_tampering_with_the_journal_is_detected(self):
        run = run_scenario(S.s1_simultaneous())
        journal = run["journal"]
        self.assertIsNone(journal.verify())
        journal.entries[5]["data"]["notional_usd"] = "999999"
        self.assertEqual(journal.verify(), journal.entries[5]["seq"])


class Checker(unittest.TestCase):
    """The independent checks must fail when the portfolio misbehaves, otherwise 'zero violations' proves nothing."""

    def test_oversized_position_is_flagged(self):
        scenario = S.s1_simultaneous()
        original = Portfolio._size

        def too_big(self, intent, plan, now_ms):
            return D("900"), [], []
        with mock.patch.object(Portfolio, "_size", too_big):
            run = run_scenario(scenario)
        rules = {v["rule"] for v in run["violations"]}
        self.assertTrue({"risk_per_trade", "product_exposure", "gross_exposure", "aggregate_open_risk"} <= rules, rules)
        self.assertIsNotNone(original)

    def test_capital_that_counts_provisional_gains_is_flagged(self):
        scenario = S.s4_incomplete_funding()
        with mock.patch.object(Portfolio, "capital_usd", lambda self: self.equity_usd()):
            run = run_scenario(scenario)
        self.assertTrue({"provisional_gains_never_spendable", "capital_recomputed"} & {v["rule"] for v in run["violations"]})

    def test_cost_disagreement_between_sizing_and_execution_is_flagged(self):
        scenario = S.s2_consecutive_losses()  # stops are hit here
        real_plan = Portfolio.plan

        def optimistic(self, intent):
            plan = real_plan(self, intent)
            plan["loss_fraction"] = plan["loss_fraction"] / 2
            return plan
        with mock.patch.object(Portfolio, "plan", optimistic):
            run = run_scenario(scenario)
        self.assertIn("stop_loss_matches_plan", {v["rule"] for v in run["violations"]})

    def test_parameters_cannot_be_changed_by_a_scenario(self):
        scenario = dict(S.s1_simultaneous(), policy={"risk_per_trade": "0.5"})
        executor = OfflineExecutor(scenario, Journal())
        self.assertEqual(executor.policy, PortfolioPolicy())
        self.assertEqual(executor.portfolio.policy, PortfolioPolicy())


class Restart(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = S.s5_integral("replay_log")

    def interrupted(self, stop_after_ms):
        """Runs the first part of the scenario with executor A and returns (journal, checkpoint, remaining groups)."""
        journal = Journal()
        a = OfflineExecutor(self.scenario, journal)
        groups = _groups(self.scenario["events"])
        done = [g for g in groups if g[0] <= stop_after_ms]
        for arrival, batch in done:
            a.process(arrival, batch)
        return journal, a.checkpoint(), groups[len(done):], a

    def test_restored_executor_is_a_new_object_and_ends_in_the_same_state(self):
        reference = run_scenario(dict(self.scenario, restart=None))
        journal, ckpt, rest, a = self.interrupted(S.START_MS + 140 * MIN)
        self.assertGreater(len(a.portfolio.positions), 0, "the checkpoint must be taken with a position open")
        b = OfflineExecutor.restore(self.scenario, journal, ckpt)
        self.assertIsNot(a, b)
        self.assertIsNot(a.portfolio, b.portfolio)
        self.assertEqual(b.state_digest(), ckpt["state_digest"])
        for arrival, batch in rest:
            b.process(arrival, batch)
        b._check_state(0)
        self.assertEqual(b.portfolio.ledger_hash(), reference["ledger_hash"])
        self.assertEqual(b.state_digest(), reference["state_digest"])
        self.assertEqual(b.violations, [])

    def test_restart_scenario_through_a_real_file(self):
        with tempfile.TemporaryDirectory() as scratch:
            run = run_scenario(self.scenario, checkpoint_dir=scratch)
            self.assertTrue(os.path.exists(os.path.join(scratch, self.scenario["name"] + ".ckpt")))
            self.assertEqual([f for f in os.listdir(scratch) if f.startswith(".ckpt-")], [], "no temp file left behind")
        self.assertEqual(run["restart"]["restored_from"], "file")
        self.assertTrue(run["restart"]["equivalent_ledger"] and run["restart"]["equivalent_state"])
        self.assertEqual(run["restart"]["lost_signal_events"], [])
        restarts = kinds(run, "restart")
        self.assertEqual(len(restarts), 1)
        self.assertGreater(restarts[0]["data"]["uncommitted_tail_entries"], 0)
        # the work done between the checkpoint and the crash is in the journal, but only the replayed work counts
        pre_crash = [e for e in run["journal"].entries if e["epoch"] == 0 and e["seq"] > restarts[0]["data"]["checkpoint_journal_seq"]]
        self.assertTrue(any(e["kind"] == "decision" for e in pre_crash))
        self.assertTrue(any(e["data"].get("replay") for e in run["journal"].entries if e["kind"] == "decision"))

    def test_losing_signals_during_the_downtime_is_visible_and_is_not_presented_as_recovered(self):
        run = run_scenario(S.s5_integral("live_gap"))
        info = run["restart"]
        self.assertFalse(info["equivalent_ledger"])
        self.assertFalse(info["equivalent_state"])
        self.assertEqual(len(info["lost_signal_events"]), 1)
        self.assertLess(run["snapshot"]["closed_trades"], info["reference_closed_trades"])
        notes = [e for e in kinds(run, "simulation_note") if e["data"].get("detectable_by_the_system") is False]
        self.assertEqual(len(notes), 1)
        self.assertEqual(run["violations"], [])

    def test_no_checkpoint_means_no_recovery(self):
        with self.assertRaises(RecoveryError) as ctx:
            OfflineExecutor.restore(self.scenario, Journal(), None)
        self.assertEqual(ctx.exception.reason, "no_checkpoint")

    def test_unusable_checkpoints_are_refused(self):
        journal, ckpt, _, _ = self.interrupted(S.START_MS + 140 * MIN)
        flipped = dict(ckpt, blob=ckpt["blob"][:-1] + bytes([ckpt["blob"][-1] ^ 1]))
        cases = {
            "corrupt_checkpoint": (self.scenario, journal, flipped),
            "configuration_changed": (S.s1_simultaneous(), journal, ckpt),
            "state_mismatch": (self.scenario, journal, dict(ckpt, state_digest="0" * 64)),
        }
        for reason, (scenario, jr, checkpoint) in cases.items():
            with self.assertRaises(RecoveryError, msg=reason) as ctx:
                OfflineExecutor.restore(scenario, jr, checkpoint)
            self.assertEqual(ctx.exception.reason, reason)
        short = Journal()
        with self.assertRaises(RecoveryError) as ctx:
            OfflineExecutor.restore(self.scenario, short, ckpt)
        self.assertEqual(ctx.exception.reason, "journal_mismatch")
        journal.entries[2]["data"]["x"] = 1
        with self.assertRaises(RecoveryError) as ctx:
            OfflineExecutor.restore(self.scenario, journal, ckpt)
        self.assertIn(ctx.exception.reason, ("journal_chain_broken", "journal_mismatch"))

    def test_a_tampered_checkpoint_stops_the_scenario_instead_of_rerunning_it(self):
        with self.assertRaises(RecoveryError):
            run_scenario(self.scenario, tamper=lambda c: dict(c, blob=c["blob"][:-2] + b"xx"))

    def test_checkpoint_file_roundtrip_is_atomic_and_missing_file_is_none(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "c.ckpt")
            self.assertIsNone(read_checkpoint(path))
            _, ckpt, _, _ = self.interrupted(S.START_MS + 60 * MIN)
            write_checkpoint(path, ckpt)
            write_checkpoint(path, ckpt)
            self.assertEqual(read_checkpoint(path)["digest"], ckpt["digest"])
            self.assertEqual(os.listdir(scratch), ["c.ckpt"])
            with open(path, "wb") as handle:
                handle.write(b"garbage")
            with self.assertRaises(RecoveryError):
                read_checkpoint(path)


class TwoProcesses(unittest.TestCase):
    """The first Python process writes a checkpoint and a journal to disk and ends; a second, independent one recovers
    both from disk and finishes. Nothing is shared except the files."""

    NAME = "s5_integral_reinicio_replay_log"

    def test_second_process_recovers_from_disk_and_equals_an_uninterrupted_run(self):
        scenario = S.s5_integral("replay_log")
        reference = run_scenario(dict(scenario, restart=None))
        single_process = run_scenario(scenario)
        with tempfile.TemporaryDirectory() as directory:
            two, result = TP.run_two_process(self.NAME, directory)
            self.assertEqual(two.returncode, 0, two.stderr)
            files = sorted(os.listdir(directory))
            self.assertEqual(files, [TP.CHECKPOINT, TP.JOURNAL, TP.RESULT])
            on_disk = Journal.load(os.path.join(directory, TP.JOURNAL), scenario)
        # book, capital, state, open positions and hashes all equal the uninterrupted run
        self.assertEqual(result["ledger_hash"], reference["ledger_hash"])
        self.assertEqual(result["state_digest"], reference["state_digest"])
        self.assertEqual(result["feed_hash"], reference["feed_hash"])
        self.assertEqual(result["capital_definitive_usd"], reference["snapshot"]["capital_definitive_usd"])
        self.assertEqual(result["closed_trades"], reference["snapshot"]["closed_trades"])
        self.assertEqual(result["positions"], TP.positions(reference["executor"]))
        self.assertEqual({k: v for k, v in result["snapshot"].items()}, reference["snapshot"])
        self.assertTrue(result["restart"]["equivalent_ledger"] and result["restart"]["equivalent_state"])
        self.assertEqual(result["violations"], [])
        # the journal written by two processes is the one a single process writes, and what is on disk verifies
        self.assertEqual(result["journal_hash"], single_process["journal_hash"])
        self.assertEqual(on_disk.head, result["journal_hash"])
        self.assertEqual(on_disk.epoch, 1)
        self.assertEqual(len(kinds({"journal": on_disk}, "restart")), 1)

    def test_the_checkpoint_was_taken_with_a_position_open(self):
        scenario = S.s5_integral("replay_log")
        with tempfile.TemporaryDirectory() as directory:
            TP.run_python("first", self.NAME, directory)
            ckpt = read_checkpoint(os.path.join(directory, TP.CHECKPOINT))
            executor = OfflineExecutor.restore(scenario, Journal.load(os.path.join(directory, TP.JOURNAL), scenario), ckpt)
        self.assertTrue(executor.portfolio.positions)
        self.assertEqual(executor.state_digest(), ckpt["state_digest"])

    def test_losing_signals_still_changes_the_result_across_processes(self):
        reference = run_scenario(dict(S.s5_integral("live_gap"), restart=None))
        with tempfile.TemporaryDirectory() as directory:
            two, result = TP.run_two_process("s5_integral_reinicio_live_gap", directory)
        self.assertEqual(two.returncode, 0, two.stderr)
        self.assertFalse(result["restart"]["equivalent_ledger"])
        self.assertFalse(result["restart"]["equivalent_state"])
        self.assertEqual(len(result["restart"]["lost_signal_events"]), 1)
        self.assertNotEqual(result["capital_definitive_usd"], reference["snapshot"]["capital_definitive_usd"])
        self.assertLess(result["closed_trades"], reference["snapshot"]["closed_trades"])

    def test_a_missing_corrupt_or_foreign_journal_or_checkpoint_is_refused_not_worked_around(self):
        expected = {
            "diario_ausente": "journal_missing", "diario_vacio": "journal_missing",
            "diario_con_entrada_alterada": "journal_corrupt", "diario_con_linea_basura": "journal_corrupt",
            "diario_con_cola_cortada": "journal_corrupt", "diario_reordenado": "journal_corrupt",
            "diario_truncado_valido": "journal_mismatch", "diario_de_otro_escenario": "journal_incompatible",
            "checkpoint_ausente": "no_checkpoint", "checkpoint_alterado": "corrupt_checkpoint"}
        with tempfile.TemporaryDirectory() as base:
            matrix = TP.refusal_matrix(self.NAME, "s1_posiciones_simultaneas", base)
        self.assertEqual({k: v[1] for k, v in matrix.items()}, expected)
        for case, (code, reason, wrote_result) in matrix.items():
            self.assertEqual(code, 3, case)
            self.assertFalse(wrote_result, "{} must not produce a result".format(case))

    def test_journal_loading_in_process(self):
        scenario = S.s1_simultaneous()
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "j.jsonl")
            with self.assertRaises(RecoveryError) as ctx:
                Journal.load(path)
            self.assertEqual(ctx.exception.reason, "journal_missing")
            journal = Journal(path)
            executor = portfolio_offline.begin(scenario, journal)
            executor.process(*_groups(scenario["events"])[5])
            loaded = Journal.load(path, scenario)
            self.assertEqual((loaded.head, len(loaded.entries)), (journal.head, len(journal.entries)))
            loaded.add(0, "x", {})  # a loaded journal keeps appending to the same file
            self.assertEqual(Journal.load(path).head, loaded.head)
        with self.assertRaises(RecoveryError) as ctx:
            OfflineExecutor.restore(scenario, None, {"fingerprint": "x"})
        self.assertEqual(ctx.exception.reason, "journal_missing")


class Isolation(unittest.TestCase):
    def test_the_offline_modules_import_nothing_that_touches_the_outside_world(self):
        forbidden = re.compile(r"^\s*(?:import|from)\s+(sqlite3|socket|http|urllib|requests|ssl|subprocess|random|time|datetime|asyncio|"
                               r"threading)\b|kronos|qwen|futures_forward|futures_replay|capture", re.I | re.M)
        base = os.path.join(ROOT, "python", "balancita_engine")
        for name in ("portfolio_offline.py", "portfolio_scenarios.py"):
            with open(os.path.join(base, name), encoding="utf-8") as handle:
                source = handle.read()
            imports = "\n".join(line for line in source.splitlines() if re.match(r"\s*(import|from)\s", line))
            self.assertIsNone(forbidden.search(imports), name)
        with open(os.path.join(base, "portfolio_offline.py"), encoding="utf-8") as handle:
            code = handle.read()
        self.assertNotIn("time.time", code)
        self.assertNotIn("datetime", code)

    def test_no_scenario_signal_uses_a_frozen_strategy_id(self):
        for scenario in S.all_scenarios():
            for event in scenario["events"]:
                if event["kind"] == "signal":
                    self.assertTrue(event["signal"]["strategy_id"].startswith("scripted-"))


if __name__ == "__main__":
    unittest.main()
