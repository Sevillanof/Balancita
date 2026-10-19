"""Everything starts as a draft; activation wakes the forward; a delete leaves nothing (but the anonymous exam tombstone)."""
import copy
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_forward as fwd
from balancita_engine import strategy_gate, strategy_purge
from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from balancita_engine.futures_strategy_gate_api import GateApi
from balancita_engine.futures_strategy_lifecycle import Lifecycle, LifecycleError
from balancita_engine.futures_strategy_registry import RegistryError, StrategyRegistry, forward_candidates

SPECS = load_specs()
C29, C30 = "c29-momentum-perp-v1", "c30-momentum-12h-perp-v1"
HOUR = 3_600_000


class Clock:
    def __init__(self, now=1_000_000):
        self.now = now

    def __call__(self):
        self.now += 1
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.clock = Clock()
        self.registry = StrategyRegistry(os.path.join(self.dir, "s.sqlite"), clock=self.clock)
        self.addCleanup(self.registry.close)

    def states(self, strategy_id=None):
        return {e["id"]: e["state"] for e in self.registry.list() if strategy_id in (None, e["id"])}


class AllDraftTests(Base):
    def test_a_legacy_registry_with_active_strategies_goes_to_draft_once_by_events(self):
        self.registry.seed(SPECS)
        with self.registry.db:  # what an old database looks like: shipped versions active since the start
            for sid in (C29, C30):
                self.registry.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                         "VALUES(?,1,'active','builtin',0)", (sid,))
        self.registry.set_state(C30, 1, "shadow", skip_gates=True)
        self.registry.apply_closed()
        before = self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0]
        moved = self.registry.migrate_all_to_draft()
        self.assertGreaterEqual(moved, 2)
        self.assertEqual({k: v for k, v in self.states().items()}, {sid: "draft" for sid in self.states()})
        reasons = {r[0] for r in self.registry.db.execute(
            "SELECT reason FROM strategy_events WHERE seq>?", (before,))}
        self.assertEqual(reasons, {"todas a borrador por decisión del usuario"})
        after = self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0]
        self.assertEqual(after - before, moved)
        # Closed (deleted) strategies are not brought back.
        self.assertNotIn("c25-pullback-perp-v1", self.states())

    def test_it_is_idempotent_and_what_the_user_activates_afterwards_stays(self):
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        self.assertEqual(self.registry.migrate_all_to_draft(), 0)
        self.assertEqual(self.states(C29), {C29: "active"})

    def test_a_fresh_registry_seeds_drafts_and_forward_expects_nothing(self):
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        found = forward_candidates(self.registry.path)
        self.assertTrue(all(c["state"] == "draft" for c in found.values()))
        registration = {"strategies": {C30: {"start_ms": 5, "why": "file"}}, "min_forward_trades": 15}
        out, specs = fwd.effective_registration(os.path.join(self.dir, "f.sqlite"), registration, SPECS, found, 10**12)
        self.assertEqual(out["strategies"], {})

    def test_the_forward_file_only_supplies_a_start_and_needs_the_registry_to_say_active(self):
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        self.registry.set_state(C30, 1, "active", "manual", skip_gates=True)
        activated = forward_candidates(self.registry.path)[C30]["active_since_ms"]
        self.assertGreater(activated, 0)
        registration = {"strategies": {C30: {"start_ms": 5, "why": "file"}}}
        out, _ = fwd.effective_registration(os.path.join(self.dir, "f.sqlite"), registration, SPECS,
                                            forward_candidates(self.registry.path), 10**12)
        self.assertEqual(list(out["strategies"]), [C30])
        self.assertEqual(out["strategies"][C30]["start_ms"], activated)  # never measured while it was a draft


class ForwardLoopTests(Base):
    def make(self, **kwargs):
        self.ran = []
        loop = fwd.ForwardLoop("m.sqlite", self.dir, SPECS, {"strategies": {}}, [], strategies_db=self.registry.path,
                               purge_dir=os.path.join(self.dir, "purge"), loop_seconds=3600, poll_seconds=60,
                               cycle=lambda candidates: self.ran.append(sorted(
                                   k for k, v in (candidates or {}).items() if v["state"] == "active")), **kwargs)
        return loop

    def test_a_newly_active_strategy_gets_a_cycle_at_once_not_after_the_hour(self):
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        loop = self.make()
        self.assertEqual(loop.step(1000.0), "full")  # first look: the regular cycle
        self.assertEqual(loop.step(1060.0), None)  # a minute later nothing changed: cheap look only
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        self.assertEqual(loop.step(1120.0), "activation")
        self.assertEqual(self.ran[-1], [C29])
        self.assertEqual(loop.step(1180.0), None)  # not repeated
        self.registry.set_state(C29, 1, "retired")
        self.assertEqual(loop.step(1240.0), None)  # switching off needs no wake-up
        self.assertEqual(loop.step(1000.0 + 3600), "full")

    def test_a_second_activation_wakes_again(self):
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        loop = self.make()
        loop.step(0.0)
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        self.registry.set_state(C30, 1, "active", "manual", skip_gates=True)
        self.assertEqual(loop.step(60.0), "activation")
        self.assertEqual(self.ran[-1], [C29, C30])


class HardDeleteTests(Base):
    def setUp(self):
        super().setUp()
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()

    def test_hard_delete_removes_every_row_but_keeps_the_append_only_guard(self):
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        digest = self.registry.version(C29)["spec_hash"]
        self.registry.record_backtest(digest, C29, 1, "PF_XBTUSD", {
            "period": {"first_bucket_ms": 1, "last_bucket_ms": 2}, "oos_sharpe_per_trade": 0.1, "days": 30})
        counts = self.registry.hard_delete(C29)
        self.assertEqual(counts["strategy_versions"], 1)
        for table, column in (("strategy_versions", "strategy_id"), ("strategy_events", "strategy_id"),
                              ("strategy_backtests", "strategy_id")):
            self.assertEqual(self.registry.db.execute(
                "SELECT COUNT(*) FROM {} WHERE {}=?".format(table, column), (C29,)).fetchone()[0], 0)
        self.assertNotIn(C29, self.states())
        with self.assertRaises(RegistryError):
            self.registry.version(C29)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.registry.db:
                self.registry.db.execute("DELETE FROM strategy_events")
        # The same rules can be created again and the builtin does not reappear without its file.
        again = self.registry.save(SPECS[C29], "new", new_id=C29)
        self.assertEqual(again["state"], "draft")

    def test_time_active_is_the_sum_of_its_active_periods(self):
        self.assertEqual(self.registry.active_ms(C29), 0)
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        self.clock.now += 5000
        self.registry.set_state(C29, 1, "retired")
        first = self.registry.active_ms(C29, now_ms=10**12)
        self.assertTrue(5000 <= first < 5100)
        self.registry.set_state(C29, 1, "active", "manual", skip_gates=True)
        total = self.registry.active_ms(C29, now_ms=self.clock.now + 7000)
        self.assertTrue(12000 <= total < 12200)

    def test_replays_include_drafts(self):
        self.assertIn(C29, self.registry.replayable_specs())


class DeleteFlowTests(Base):
    """A shipped strategy with data in the registry, the gate, the forward and the config files."""

    def setUp(self):
        super().setUp()
        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        self.gate_dir = os.path.join(self.dir, "gate")
        self.purge_dir = os.path.join(self.dir, "purge")
        self.specs_dir = os.path.join(self.dir, "specs")
        os.makedirs(self.specs_dir)
        self.spec = SPECS[C29]
        with open(os.path.join(self.specs_dir, C29 + ".json"), "w") as handle:
            json.dump(self.spec, handle)
        self.keep_spec = os.path.join(self.specs_dir, C30 + ".json")
        with open(self.keep_spec, "w") as handle:
            json.dump(SPECS[C30], handle)
        self.forward_json = os.path.join(self.dir, "forward-strategies.json")
        with open(self.forward_json, "w") as handle:
            json.dump({"strategies": {C29: {"start_ms": 1}, C30: {"start_ms": 2}}}, handle)
        self.freeze = os.path.join(self.dir, "freeze.json")
        with open(self.freeze, "w") as handle:
            json.dump({"ids": [C29, C30]}, handle)
        self.qwen_config = os.path.join(self.dir, "qwen-exit.json")
        with open(self.qwen_config, "w") as handle:
            json.dump({"entry_specs": ["other"], "off": {"reason": "x"}}, handle)
        self.forward_dir = os.path.join(self.dir, "forward")
        os.makedirs(self.forward_dir)
        self.seed_gate()
        self.seed_forward()
        self.gate = GateApi(self.registry, data_dir=self.gate_dir, python="py", spawn=self.spawn_inline, wait_s=1)
        self.life = Lifecycle(self.registry, self.gate, forward_db_path=os.path.join(self.forward_dir, "forward.sqlite"),
                              purge_dir=self.purge_dir, specs_dir=self.specs_dir,
                              forward_registration_path=self.forward_json, freeze_path=self.freeze,
                              qwen_exit_config=self.qwen_config)

    def spawn_inline(self, args, env, cwd, log_path):
        """Runs the gate's purge command in this process: same code, same data dir."""
        assert args[3:5] == ["--data-dir", self.gate_dir] and args[5] == "purge"
        self.last_counts = strategy_gate.purge_strategy(args[-1], self.gate_dir)

        class Done:
            pid, returncode = os.getpid(), 0

            def poll(self):
                return 0

        return Done()

    def seed_gate(self):
        digest = spec_hash(self.spec)
        db = strategy_gate.open_db(os.path.join(self.gate_dir, "gate.sqlite"))
        with db:
            for kind in ("practice", "practice", "exam"):
                db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,verdict,"
                           "started_at,updated_at,report_path) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                           (C29, "c29-momentum-perp", "k", digest, "{}", kind, "done", "NO PASA", 1_760_000_000_000,
                            1, os.path.join(self.gate_dir, "reports", "1.md")))
            db.execute("INSERT INTO exam_locks VALUES(?,?,?,?,?,?,?,?)",
                       (C29, "k", digest, "2026-04-19", 3, 1_760_000_000_000, "done", "NO PASA"))
            db.execute("INSERT INTO attempts(family,strategy_id,version_key,run_id,at) VALUES(?,?,?,?,?)",
                       ("c29-momentum-perp", C29, "k", 1, 1))
            db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,started_at,updated_at)"
                       " VALUES('otra','otra','k','h','{}','practice','done',1,1)")
        db.close()
        os.makedirs(os.path.join(self.gate_dir, "reports"))
        for n in (1, 2, 3, 99):
            with open(os.path.join(self.gate_dir, "reports", "{}.md".format(n)), "w") as handle:
                handle.write("informe")
        os.makedirs(os.path.join(self.gate_dir, "logs"))
        with open(os.path.join(self.gate_dir, "logs", "launch-1.log"), "w") as handle:
            handle.write("error en {}".format(C29))
        with open(os.path.join(self.gate_dir, "logs", "launch-2.log"), "w") as handle:
            handle.write("nada")

    def seed_forward(self):
        db = sqlite3.connect(os.path.join(self.forward_dir, "forward.sqlite"))
        db.executescript(fwd._SCHEMA + fwd._FIRST_SEEN_SCHEMA)
        for sid in (C29, C30):
            db.execute("INSERT INTO forward_status VALUES(?,?,?)", (sid, "PF_XBTUSD", "{}"))
            db.execute("INSERT INTO forward_open VALUES(?,?,?,?)", (sid, "PF_XBTUSD", "h", "null"))
            db.execute("INSERT INTO forward_diverged VALUES(?,?,?)", (sid, "PF_XBTUSD", 1))
            db.execute("INSERT INTO forward_first_seen VALUES(?,?,?)", (sid, "h", 1))
            db.execute("INSERT INTO forward_trade VALUES(?,?,?,?,?)", (sid, "PF_XBTUSD", 1, "h",
                                                                       json.dumps({"pnl_usd": -1.25})))
        db.commit()
        db.close()
        with open(os.path.join(self.forward_dir, "forward-reliability.json"), "w") as handle:
            json.dump({"strategies": {C29: {}, C30: {}}}, handle)

    def count(self, path, table, column="strategy_id", value=C29):
        db = sqlite3.connect(path)
        try:
            return db.execute("SELECT COUNT(*) FROM {} WHERE {}=?".format(table, column), (value,)).fetchone()[0]
        finally:
            db.close()

    # ------------------------------------------------------------------ tests

    def test_preview_shows_name_versions_state_trades_runs_and_exam(self):
        preview = self.life.preview(C29)
        self.assertEqual((preview["id"], preview["state"], preview["active_ms"]), (C29, "draft", 0))
        self.assertEqual((preview["forward_trades"], preview["forward_net_usd"]), (1, -1.25))
        self.assertEqual((preview["gate_runs"], preview["exam"]["taken"], preview["exam"]["verdict"]),
                         (3, True, "NO PASA"))
        self.assertTrue(preview["builtin"])
        self.assertFalse(preview["ledger_kept"])  # ADR amendment 2026-10-19: the trades go too
        self.assertEqual(preview["versions"][0]["version"], 1)

    def test_the_name_or_a_wrong_text_is_checked_before_anything_is_touched(self):
        with self.assertRaises(LifecycleError) as raised:
            self.life.delete(C29, "otra cosa")
        self.assertEqual(raised.exception.code, "confirmation_required")
        self.assertEqual(self.states(C29), {C29: "draft"})
        self.assertEqual(self.count(os.path.join(self.gate_dir, "gate.sqlite"), "runs"), 3)

    def test_qwen_and_kronos_cannot_be_deleted(self):
        for strategy_id in ("kronos-small-1h-h4-v1", "c31-qwen-exit-perp-v1"):
            for call in (lambda: self.life.delete(strategy_id, strategy_id), lambda: self.life.preview(strategy_id)):
                with self.assertRaises(LifecycleError) as raised:
                    call()
                self.assertEqual((raised.exception.status, str(raised.exception)),
                                 (400, "Qwen y Kronos solo se pueden quitar desde el código"))

    def test_a_delete_removes_registry_gate_config_and_leaves_the_rest_to_the_forward(self):
        result = self.life.delete(C29, self.registry.version(C29)["spec"]["name"])
        self.assertEqual(result["state"], "running")
        # Registry, config files, gate: gone at once.
        self.assertNotIn(C29, self.states())
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM strategy_events WHERE strategy_id=?",
                                                  (C29,)).fetchone()[0], 0)
        self.assertFalse(os.path.exists(os.path.join(self.specs_dir, C29 + ".json")))
        self.assertTrue(os.path.exists(self.keep_spec))
        self.assertEqual(json.load(open(self.forward_json))["strategies"], {C30: {"start_ms": 2}})
        self.assertEqual(json.load(open(self.freeze))["ids"], [C30])
        gate_db = os.path.join(self.gate_dir, "gate.sqlite")
        for table in ("runs", "exam_locks", "attempts"):
            self.assertEqual(self.count(gate_db, table), 0, table)
        self.assertEqual(self.count(gate_db, "runs", value="otra"), 1)
        for name in ("1.md", "2.md", "3.md"):
            self.assertFalse(os.path.exists(os.path.join(self.gate_dir, "reports", name)))
        self.assertTrue(os.path.exists(os.path.join(self.gate_dir, "reports", "99.md")))
        self.assertEqual(sorted(os.listdir(os.path.join(self.gate_dir, "logs"))), ["launch-2.log"])
        # The forward still has its rows until it consumes the request on its next loop.
        forward_db = os.path.join(self.forward_dir, "forward.sqlite")
        self.assertEqual(self.count(forward_db, "forward_status"), 1)
        self.assertEqual(self.life.purge_status(result["purge_id"])["state"], "running")
        fwd.consume_purges(self.forward_dir, self.purge_dir)
        for table in ("forward_status", "forward_open", "forward_diverged", "forward_first_seen"):
            self.assertEqual(self.count(forward_db, table), 0, table)
            self.assertEqual(self.count(forward_db, table, value=C30), 1, table)
        self.assertNotIn(C29, json.load(open(os.path.join(self.forward_dir, "forward-reliability.json")))["strategies"])
        # ADR 0001 amendment 2026-10-19: the paper trades go too; the other strategy's stay.
        self.assertEqual(self.count(forward_db, "forward_trade"), 0)
        self.assertEqual(self.count(forward_db, "forward_trade", value=C30), 1)
        done = self.life.purge_status(result["purge_id"])
        self.assertEqual((done["state"], done["consumers"]), ("done", {"forward": "done"}))
        self.assertEqual(os.listdir(self.purge_dir), [])  # nothing about the delete is left behind

    def test_the_only_thing_the_gate_keeps_is_an_anonymous_exam_tombstone(self):
        self.life.delete(C29, C29)
        db = sqlite3.connect(os.path.join(self.gate_dir, "gate.sqlite"))
        rows = db.execute("SELECT * FROM exam_tombstones").fetchall()
        dump = "\n".join(db.iterdump())
        db.close()
        self.assertEqual(rows, [(spec_hash(self.spec), "2025-10-09", "NO PASA")])
        self.assertNotIn(C29, dump)
        self.assertNotIn("momentum", dump)
        # A deleted-and-recreated identical version cannot take the exam again; different content can.
        db = strategy_gate.open_db(os.path.join(self.gate_dir, "gate.sqlite"))
        with self.assertRaises(strategy_gate.GateError) as raised:
            strategy_gate.check_exam_allowed(db, self.spec, {})
        self.assertIn("ya se rindió el 2025-10-09: NO PASA", str(raised.exception))
        changed = copy.deepcopy(self.spec)
        changed["params"][next(iter(changed["params"]))] = "123"
        strategy_gate.check_exam_allowed(db, changed, {})
        db.close()

    def test_without_the_tombstone_flag_nothing_at_all_remains_in_the_gate(self):
        old = strategy_purge.KEEP_EXAM_TOMBSTONE
        strategy_purge.KEEP_EXAM_TOMBSTONE = False
        self.addCleanup(setattr, strategy_purge, "KEEP_EXAM_TOMBSTONE", old)
        self.life.delete(C29, C29)
        self.assertEqual(self.count(os.path.join(self.gate_dir, "gate.sqlite"), "exam_tombstones",
                                    "spec_hash", spec_hash(self.spec)), 0)

    def test_the_forward_ledger_guard_is_restored_after_the_purge_and_the_switch_can_keep_trades(self):
        self.life.delete(C29, C29)
        fwd.consume_purges(self.forward_dir, self.purge_dir)
        forward_db = os.path.join(self.forward_dir, "forward.sqlite")
        with self.assertRaises(sqlite3.IntegrityError):  # the guard is back
            db = sqlite3.connect(forward_db)
            try:
                with db:
                    db.execute("DELETE FROM forward_trade")
            finally:
                db.close()
        old = strategy_purge.PURGE_PAPER_LEDGER
        strategy_purge.PURGE_PAPER_LEDGER = False
        self.addCleanup(setattr, strategy_purge, "PURGE_PAPER_LEDGER", old)
        self.life.delete(C30, C30)
        fwd.consume_purges(self.forward_dir, self.purge_dir)
        self.assertEqual(self.count(forward_db, "forward_trade", value=C30), 1)

    def test_attempts_survive_deletion_only_as_an_anonymous_counter_per_hashed_family(self):
        import hashlib
        self.life.delete(C29, C29)
        db = strategy_gate.open_db(os.path.join(self.gate_dir, "gate.sqlite"))
        family = "c29-momentum-perp"
        self.assertEqual(strategy_gate.attempts_of(db, family), 1)
        rows = db.execute("SELECT * FROM attempt_counts").fetchall()
        self.assertEqual([tuple(r) for r in rows], [(hashlib.sha256(family.encode()).hexdigest(), 1)])
        with db:
            db.execute("INSERT INTO attempts(family,strategy_id,version_key,run_id,at) VALUES(?,?,?,?,?)",
                       (family, "c29-momentum-perp-v2", "k", 9, 1))
        self.assertEqual(strategy_gate.attempts_of(db, family), 2)  # recreating does not reset the trial count
        db.close()

    def test_a_running_gate_test_blocks_the_delete_and_qwen_inputs_are_protected(self):
        db = strategy_gate.open_db(os.path.join(self.gate_dir, "gate.sqlite"))
        with db:
            db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,started_at,"
                       "updated_at,pid) VALUES(?,?,?,?,?,?,?,?,?,?)", (C29, "f", "k", "h", "{}", "practice", "running",
                                                                    1, 1, os.getpid()))
        db.close()
        from balancita_engine.futures_strategy_gate_api import GateApiError
        with self.assertRaises(GateApiError):
            self.life.delete(C29, C29)
        self.assertEqual(self.states(C29), {C29: "draft"})
        with open(self.qwen_config, "w") as handle:
            json.dump({"entry_specs": [C30]}, handle)
        with self.assertRaises(LifecycleError) as raised:
            self.life.delete(C30, C30)
        self.assertEqual(raised.exception.code, "in_use")

    def test_gate_accepts_draft_shadow_and_retired_strategies_and_models(self):
        gate = GateApi(self.registry, data_dir=self.gate_dir, python="py", spawn=self.spawn_inline, wait_s=0.1)
        for state in ("draft", "shadow", "retired"):
            self.registry.set_state(C30, 1, state, skip_gates=True)
            self.assertEqual(gate.runs(C30)["runs"], [])
        for model in ("kronos-small-1h-h4-v1", "c31-qwen-exit-perp-v1"):
            self.assertEqual(gate.runs(model)["runs"], [])

    def test_passed_tells_whether_this_exact_version_passed(self):
        gate = self.gate
        self.assertEqual(gate.runs(C29)["passed"], {"practice": False, "exam": False, "any": False})
        digest = spec_hash(self.spec)
        db = strategy_gate.open_db(os.path.join(self.gate_dir, "gate.sqlite"))
        with db:
            db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,verdict,"
                       "started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (C29, "f", "k", digest, "{}", "practice", "done", "PASA", 9_000_000_000_000, 1))
            db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,verdict,"
                       "started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (C30, "f", "k", "otro-hash", "{}", "practice", "done", "PASA", 9_000_000_000_000, 1))
        db.close()
        self.assertTrue(gate.runs(C29)["passed"]["any"])
        self.assertFalse(gate.runs(C30)["passed"]["any"])  # a PASA of another content does not count


class PaperAccountPurgeTests(unittest.TestCase):
    """D's hash-chained account DB: the purge keeps the chain valid and the other books untouched."""

    def build(self):
        from balancita_engine import futures_paper_execution as d

        self.d = d
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "account.sqlite")
        self.config = {"version": "x", "books": [C29, C30], "products": ["PF_XBTUSD"], "initial_cash_usd": "1000"}
        store = d.AccountStore(self.path, self.config)
        books = {"{}:PF_XBTUSD".format(C29): {"cash": "900", "events_since_snapshot": 2},
                 "{}:PF_XBTUSD".format(C30): {"cash": "1010", "events_since_snapshot": 1}}
        order = [C29, C30, C29, C30, C30, C29]
        for i, sid in enumerate(order, 1):
            store.emit("fill", 1000 + i, {"book": "{}:PF_XBTUSD".format(sid), "pnl": str(i), "strategy_id": sid})
            if i in (3, 5):
                store.snapshot(1000 + i, {"version": 1, "books": books, "events_since_snapshot": 3, "last_snapshot_time": 1},
                               {"ticker": i})
        store.flush()
        store.close()
        return order

    def test_the_chain_verifies_after_the_purge_and_other_books_are_untouched(self):
        self.build()
        before = [r for r in self.rows() if C30 in r[3]]
        out = __import__("balancita_engine.futures_paper_account_purge", fromlist=["x"]).purge_strategy(self.path, C29)
        self.assertEqual((out["events_removed"], out["events_kept"], out["snapshots"]), (3, 3, 2))
        self.assertEqual(self.d.verify_chain(self.path), out["head_hash"])
        after = self.rows()
        self.assertEqual([r[0] for r in after], [1, 2, 3])
        self.assertEqual([r[3] for r in after], [r[3] for r in before])  # payloads of the other strategy: identical
        dump = sqlite3.connect(self.path)
        text = "\n".join(dump.iterdump())
        dump.close()
        self.assertNotIn(C29, text)  # no trace: events, snapshots, config
        # Snapshots keep pointing at the same events, the surviving book keeps its balance, the DB reopens.
        store = self.d.AccountStore(self.path, dict(self.config, books=[C30]))
        engine, cursors = store.restored
        self.assertEqual(engine["books"], {"{}:PF_XBTUSD".format(C30): {"cash": "1010", "events_since_snapshot": 1}})
        self.assertEqual((store.head_seq, cursors), (3, {"ticker": 5}))
        store.close()

    def test_the_guards_come_back_and_a_second_purge_changes_nothing(self):
        from balancita_engine import futures_paper_account_purge as purge

        self.build()
        purge.purge_strategy(self.path, C29)
        head = self.d.verify_chain(self.path)
        self.assertEqual(purge.purge_strategy(self.path, C29)["events_removed"], 0)
        self.assertEqual(self.d.verify_chain(self.path), head)
        db = sqlite3.connect(self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            with db:
                db.execute("DELETE FROM paper_execution_events")
        db.close()
        self.assertFalse(purge.has_strategy(self.path, C29))
        self.assertTrue(purge.has_strategy(self.path, C30))

    def test_a_delete_through_the_lifecycle_rewrites_the_account_db(self):
        self.build()
        registry = StrategyRegistry(os.path.join(self.dir, "s.sqlite"))
        self.addCleanup(registry.close)
        registry.seed(SPECS)
        registry.migrate_all_to_draft()

        class Child:
            returncode = 0

            def poll(self):
                return 0

        def spawn(args, env, cwd, log_path):
            from balancita_engine import futures_paper_account_purge as purge
            purge.main(args[3:])
            return Child()

        gate = GateApi(registry, data_dir=os.path.join(self.dir, "gate"), python="py", spawn=spawn)
        life = Lifecycle(registry, gate, account_db_path=self.path)
        result = life.delete(C29, C29)
        self.assertEqual(result["steps"]["paper_account"], {"skipped": False})
        self.d.verify_chain(self.path)
        self.assertFalse(__import__("balancita_engine.futures_paper_account_purge", fromlist=["x"]).has_strategy(self.path, C29))

    def rows(self):
        db = sqlite3.connect(self.path)
        try:
            return db.execute("SELECT seq, kind, time_ms, payload_json FROM paper_execution_events ORDER BY seq").fetchall()
        finally:
            db.close()


class HttpTests(Base):
    def setUp(self):
        super().setUp()
        import threading
        import urllib.request
        from http.server import ThreadingHTTPServer
        from balancita_engine.futures_strategy_registry import StrategyService, make_handler

        self.registry.seed(SPECS)
        self.registry.migrate_all_to_draft()
        self.service = StrategyService(self.registry, None, {}, gate_data_dir=os.path.join(self.dir, "gate"),
                                       purge_dir=os.path.join(self.dir, "purge"),
                                       forward_db_path=os.path.join(self.dir, "forward.sqlite"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.service))
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:{}/api-strategies".format(server.server_address[1])
        self.urllib = urllib.request

    def call(self, path, body=None):
        request = self.urllib.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                      headers={"Content-Type": "application/json"})
        try:
            with self.urllib.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except Exception as error:  # noqa: BLE001
            return error.code, json.loads(error.read())

    def test_protected_models_are_refused_in_spanish_and_the_preview_and_purges_answer(self):
        for model in ("kronos-small-1h-h4-v1", "c31-qwen-exit-perp-v1"):
            status, body = self.call("/strategies/{}/delete".format(model), {"confirm": model})
            self.assertEqual((status, body["detail"]), (400, "Qwen y Kronos solo se pueden quitar desde el código"))
        status, preview = self.call("/strategies/{}/delete-preview".format(C29))
        self.assertEqual((status, preview["state"], preview["forward_trades"]), (200, "draft", 0))
        self.assertEqual(self.call("/strategies/nope/delete-preview")[0], 404)
        self.assertEqual(self.call("/purges")[1], {"purges": []})
        self.assertEqual(self.call("/strategies/{}/delete".format(C29), {"confirm": "no"})[0], 409)
        status, result = self.call("/strategies/{}/delete".format(C29), {"confirm": C29})
        self.assertEqual((status, result["deleted"]), (200, True))
        self.assertEqual(self.call("/purges/{}".format(result["purge_id"]))[1]["state"], "running")
        self.assertEqual(self.call("/strategies/{}".format(C29))[0], 404)


class ModelGateTests(unittest.TestCase):
    def test_recorded_trades_of_a_model_are_the_trade_source_and_the_report_says_so(self):
        from balancita_engine import strategy_gate_models as models

        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        db = sqlite3.connect(os.path.join(directory, "kronos.sqlite"))
        db.execute("CREATE TABLE trade(product_id TEXT, decision_ms INTEGER, mode TEXT, payload TEXT)")
        for i, (entry, net) in enumerate(((1000, 5.0), (10**13, 7.0))):
            db.execute("INSERT INTO trade VALUES('PF_XBTUSD',?,?,?)", (entry, "live", json.dumps(
                {"side": "LONG", "entry_time_ms": entry, "exit_time_ms": entry + HOUR, "net_bp": net})))
        db.commit()
        db.close()
        spec, source = models.model_subject(models.KRONOS_ID, kronos_dir=directory)
        self.assertEqual(spec["id"], models.KRONOS_ID)
        trades, open_at_end = source(spec, "PF_XBTUSD", "1", [], [], [], 0, 5 * 10**12, lambda fraction: None)
        self.assertEqual([t["net_bp"] for t in trades], [5.0])
        self.assertEqual(open_at_end, 0)
        self.assertIn("no se puede volver a correr", source.note)
        self.assertEqual(source(spec, "PF_ETHUSD", "1", [], [], [], 0, 10**14, lambda f: None)[0], [])

    def test_the_gate_judges_kronos_by_its_recorded_trades_and_can_run_its_exam_once(self):
        import test_strategy_gate as tg
        from balancita_engine import strategy_gate_models as models

        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        db = sqlite3.connect(os.path.join(directory, "kronos.sqlite"))
        db.execute("CREATE TABLE trade(product_id TEXT, decision_ms INTEGER, mode TEXT, payload TEXT)")
        for i in range(3):  # inside the synthetic window, after the cut: the exam sees them
            entry = tg.HOLDOUT + (i + 1) * 3 * HOUR
            db.execute("INSERT INTO trade VALUES('PF_XBTUSD',?,'live',?)", (entry, json.dumps(
                {"side": "LONG", "entry_time_ms": entry, "exit_time_ms": entry + 4 * HOUR, "net_bp": 12.0})))
        db.commit()
        db.close()
        data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, data, True)
        practice = tg.run(models.KRONOS_ID, data, kronos_dir=directory)
        self.assertEqual(practice["status"], "done")  # no history before the cut: it cannot be judged, and says so
        with open(practice["report_path"], encoding="utf-8") as handle:
            self.assertIn("no se puede volver a correr", handle.read())
        exam = tg.run(models.KRONOS_ID, data, kronos_dir=directory, kind="exam")
        self.assertEqual(exam["status"], "done")
        with self.assertRaises(strategy_gate.GateError):
            tg.run(models.KRONOS_ID, data, kronos_dir=directory, kind="exam")


if __name__ == "__main__":
    unittest.main()
