"""Durable signal continuity: idempotency, offsets, gaps, reconstruction, frozen versions, retroactive-entry guard,
and recovery across independent Python processes (crashes, duplicates, lost events, damaged files)."""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from balancita_engine import signal_continuity as SC, signal_continuity_demo as demo
from balancita_engine.multi_signals import make_signal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MS = SC.FIVE_MINUTES_MS
CANDLES = os.path.join(ROOT, "python", "tests", "fixtures", "muestra-parcial", "paper_futures_official_candles.jsonl")
T0 = SC.real_candles(CANDLES)[0][0]["bucket_start"]   # the first captured minute


def one_signal(action="BUY", cycle=T0 + 100 * MS, strategy=None):
    strategy = strategy or SC.demo_strategies()[0]
    return make_signal(strategy_id=strategy.id, strategy_version=strategy.version, product_id=SC.DEMO_PRODUCT,
                       bucket_ms=cycle, action=action, strength="0.8", horizon_minutes=60, evidence={"x": "1"})


class LogTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.log = SC.SignalLog.create(os.path.join(self.dir, "s.jsonl"), T0)
        self.strategy = SC.demo_strategies()[0]
        self.log.freeze_strategy(self.strategy, T0)
        SC.disarm()
        self.addCleanup(SC.disarm)

    def test_duplicate_delivery_changes_nothing(self):
        signal = one_signal()
        first = self.log.ingest(signal, {"a": "1"}, T0, source_offset=1)
        size = os.path.getsize(self.log.path)
        again = self.log.ingest(signal, {"a": "1"}, T0 + 5, source_offset=1)
        self.assertEqual((first["status"], again["status"]), ("persisted", "duplicate"))
        self.assertEqual(os.path.getsize(self.log.path), size)

    def test_different_decision_for_same_key_is_a_conflict_and_first_wins(self):
        self.log.ingest(one_signal("BUY"), {}, T0)
        receipt = self.log.ingest(one_signal("SELL"), {}, T0 + 1)
        self.assertEqual(receipt["status"], "conflict")
        self.assertEqual(self.log.ingest(one_signal("SELL"), {}, T0 + 2)["status"], "conflict")   # recorded once
        self.assertEqual(sum(1 for e in self.log.entries if e["kind"] == "conflict"), 1)
        kept = list(self.log.signals())
        self.assertEqual((len(kept), kept[0]["data"]["signal"]["action"]), (1, "BUY"))

    def test_signal_needs_a_frozen_strategy(self):
        other = make_signal(strategy_id="mx-unknown", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0, action="BUY",
                            strength="0.5", horizon_minutes=60, evidence={})
        with self.assertRaises(SC.ContinuityError) as caught:
            self.log.ingest(other, {}, T0)
        self.assertEqual(caught.exception.reason, "strategy_not_frozen")

    def test_entry_records_what_is_needed_to_audit(self):
        self.log.ingest(one_signal(), {"price": "1"}, T0 + 7, source_offset=3)
        data = next(self.log.signals())["data"]
        for field in ("key", "origin", "signal", "decision_hash", "inputs", "inputs_hash", "code_hash", "generated_ms",
                      "cycle_ms", "product_id", "valid_until_ms", "executable", "source_offset"):
            self.assertIn(field, data)
        self.assertEqual((data["origin"], data["generated_ms"], data["executable"]), ("original", T0 + 7, True))

    def test_late_original_supersedes_a_reconstruction_and_is_compared_with_it(self):
        signal = one_signal()
        self.log.ingest(signal, {}, T0 + 10 * MS, origin="reconstructed")
        self.assertEqual(self.log.ingest(signal, {}, T0 + 11 * MS, origin="reconstructed")["status"], "already_present")
        self.log.ingest(signal, {}, T0 + 12 * MS)
        counted = list(self.log.signals())
        self.assertEqual([e["data"]["origin"] for e in counted], ["original"])
        self.assertTrue(counted[0]["data"]["matches_reconstruction"])

    def test_reconstruction_never_replaces_an_original(self):
        self.log.ingest(one_signal(), {}, T0)
        self.assertEqual(self.log.ingest(one_signal(), {}, T0 + 1, origin="reconstructed")["status"], "already_present")

    def test_same_version_with_other_code_cannot_be_frozen(self):
        with self.assertRaises(SC.ContinuityError) as caught:
            self.log.freeze_strategy(SC._MomentumEdited(), T0)
        self.assertEqual(caught.exception.reason, "code_changed_same_version")

    def test_torn_last_line_is_dropped_but_other_damage_is_refused(self):
        self.log.ingest(one_signal(), {}, T0)
        good = os.path.getsize(self.log.path)
        with open(self.log.path, "ab") as handle:
            handle.write(b'{"seq":9,"hash":"abc')
        loaded = SC.SignalLog.load(self.log.path)
        self.assertGreater(loaded.tail_discarded, 0)
        self.assertEqual(loaded.entries[-1]["kind"], "tail_discarded")
        self.assertIsNone(loaded.verify())
        self.assertGreater(os.path.getsize(self.log.path), good)
        with open(self.log.path, "ab") as handle:
            handle.write(b"garbage\n")
        with self.assertRaises(SC.ContinuityError) as caught:
            SC.SignalLog.load(self.log.path)
        self.assertEqual(caught.exception.reason, "log_corrupt")

    def test_fault_points_leave_a_consistent_log(self):
        for point in ("before_persist", "mid_persist", "after_persist"):
            with self.subTest(point=point):
                path = os.path.join(self.dir, point + ".jsonl")
                log = SC.SignalLog.create(path, T0)
                log.freeze_strategy(self.strategy, T0)
                SC.arm(point)
                with self.assertRaises(SC.SimulatedCrash):
                    log.ingest(one_signal(), {}, T0)
                reopened = SC.SignalLog.load(path)
                present = len(list(reopened.signals()))
                self.assertEqual(present, 1 if point == "after_persist" else 0)
                self.assertEqual(reopened.tail_discarded > 0, point == "mid_persist")
                self.assertIsNone(reopened.verify())


class GuardTests(unittest.TestCase):
    def entry(self, origin, executable, valid_until=T0 + MS, cycle=T0, generated=T0 + 1000):
        return {"seq": 5, "data": {"origin": origin, "executable": executable, "valid_until_ms": valid_until,
                                   "cycle_ms": cycle, "generated_ms": generated}}

    def test_reconstructed_is_never_executable(self):
        for now in (0, T0, T0 + 10 ** 9):
            with self.assertRaises(SC.RetroactiveEntryError):
                SC.guard_entry(self.entry("reconstructed", False, None), now)

    def test_original_is_executable_only_inside_its_window(self):
        self.assertEqual(SC.entry_status(self.entry("original", True), T0 + MS), (True, None))
        self.assertEqual(SC.entry_status(self.entry("original", True), T0 + MS + 1), (False, "signal_expired"))

    def test_causality_is_enforced(self):
        entry = self.entry("original", True, cycle=T0 + 10 * MS, valid_until=T0 + 11 * MS, generated=T0 + 10 * MS + 1000)
        self.assertEqual(SC.entry_status(entry, T0 + 10 * MS + 1000), (True, None))
        self.assertEqual(SC.entry_status(entry, T0 + 10 * MS - 1), (False, "candle_not_closed"))
        self.assertEqual(SC.entry_status(entry, T0 + 10 * MS + 999), (False, "generated_after_evaluation"))
        early = self.entry("original", True, cycle=T0 + 10 * MS, valid_until=T0 + 11 * MS, generated=T0 + 10 * MS - 1)
        self.assertEqual(SC.entry_status(early, T0 + 10 * MS + 1000), (False, "generated_before_candle_close"))

    def test_a_forged_executable_flag_does_not_help_a_reconstruction(self):
        with self.assertRaises(SC.RetroactiveEntryError):
            SC.guard_entry(self.entry("reconstructed", True), T0)


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.seen = []
        SC.disarm()
        self.addCleanup(SC.disarm)
        self.strategy = SC.demo_strategies()[0]

    def start(self, now=T0 + 100 * MS + 1000):
        consumer = SC.Consumer.start(self.dir, self.seen.append, lambda: now, T0)
        consumer.log.freeze_strategy(self.strategy, T0)
        return consumer

    def test_offset_moves_only_after_the_handler_and_a_crash_redelivers_once(self):
        consumer = self.start()
        for n in range(3):
            consumer.log.ingest(one_signal(cycle=T0 + (100 + n) * MS), {}, T0 + (100 + n) * MS + 1000, source_offset=n + 1)
        SC.arm("before_ack", 2)
        with self.assertRaises(SC.SimulatedCrash):
            consumer.run()
        self.assertEqual(len(self.seen), 2)               # the handler ran for the second one...
        self.assertEqual(consumer.confirmed_offset, 1)    # ...but only the first was acknowledged; 3 are persisted
        restarted = self.start()
        self.assertEqual(restarted.run(), 2)              # ...and it comes again, plus the third; the first does not
        self.assertEqual([d.key for d in self.seen].count(self.seen[0].key), 1)
        self.assertEqual(len(self.seen), 4)
        self.assertEqual(restarted.confirmed_offset, 3)
        self.assertEqual(restarted.run(), 0)

    def test_checkpoint_offset_is_what_was_acknowledged_not_what_was_seen(self):
        consumer = self.start()
        for n in range(3):
            consumer.log.ingest(one_signal(cycle=T0 + (100 + n) * MS), {}, T0 + (100 + n) * MS + 1000, source_offset=n + 1)
        consumer.run(limit=1)
        with open(consumer.path, encoding="utf-8") as handle:
            stored = json.load(handle)
        self.assertEqual((stored["confirmed_source_offset"], consumer.log.max_source_offset), (1, 3))
        self.assertEqual(self.start().confirmed_offset, 1)

    def test_expired_and_reconstructed_deliveries_cannot_open_positions(self):
        consumer = self.start(now=T0 + 500 * MS)
        consumer.log.ingest(one_signal(cycle=T0 + 100 * MS), {}, T0 + 100 * MS + 1000)
        consumer.log.ingest(one_signal(cycle=T0 + 101 * MS), {}, T0 + 400 * MS, origin="reconstructed")
        consumer.run()
        self.assertEqual([(d.executable, d.reason) for d in self.seen], [(False, "signal_expired"), (False, "reconstructed_signal")])
        for delivery in self.seen:
            with self.assertRaises(SC.RetroactiveEntryError):
                delivery.require_executable()

    def test_damaged_checkpoint_is_refused_and_rebuild_is_explicit(self):
        consumer = self.start()
        consumer.log.ingest(one_signal(), {}, T0)
        consumer.run()
        with open(consumer.path, "w") as handle:
            handle.write("{not json")
        with self.assertRaises(SC.ContinuityError) as caught:
            self.start()
        self.assertEqual(caught.exception.reason, "corrupt_checkpoint")
        fresh = SC.Consumer(SC.SignalLog.load(os.path.join(self.dir, SC.LOG_FILE)), self.dir, self.seen.append, lambda: T0)
        fresh.rebuild_checkpoint(T0)
        self.assertEqual(fresh.committed_seq, 1)
        self.assertEqual(self.start().committed_seq, 1)   # a valid checkpoint again; the rebuild is in the log
        self.assertTrue(any(e["kind"] == "checkpoint_rebuilt" for e in fresh.log.entries))


class ReconstructionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strategies = SC.demo_strategies()
        cls.ones, cls.fives = SC.real_candles(CANDLES)
        cls.live = SC.live_cycles(cls.strategies, cls.ones, cls.fives)

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.log = SC.SignalLog.create(os.path.join(self.dir, "s.jsonl"), T0)
        for strategy in self.strategies:
            self.log.freeze_strategy(strategy, T0)

    def feed(self, skip=()):
        for index, (cycle_ms, pairs) in enumerate(self.live):
            if index not in skip:
                for signal, inputs in pairs:
                    self.log.ingest(signal, inputs, cycle_ms + 1000)

    def gaps(self):
        return SC.detect_gaps(self.log, self.strategies, [SC.DEMO_PRODUCT], self.live[-1][0], from_ms=self.live[0][0])

    def test_gap_detection_finds_runs_and_nothing_else(self):
        self.feed(skip=set(range(10, 15)) | {30})
        gaps = self.gaps()
        self.assertEqual(sorted((g["cycles"], g["from_ms"]) for g in gaps if g["strategy_id"] == self.strategies[0].id),
                         [(1, self.live[30][0]), (5, self.live[10][0])])
        self.assertEqual(SC.record_gaps(self.log, gaps, T0), len(gaps))
        self.assertEqual(SC.record_gaps(self.log, gaps, T0 + 1), 0)       # recorded once

    def test_reconstruction_equals_the_live_path_and_is_marked(self):
        skip = set(range(10, 15))
        self.feed(skip=skip)
        stats = SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, self.gaps(), T0 + 10 ** 7)
        self.assertEqual(stats["persisted"], 5 * len(self.strategies))
        rebuilt = [e["data"] for e in self.log.signals() if e["data"]["origin"] == "reconstructed"]
        self.assertTrue(all(not d["executable"] and d["valid_until_ms"] is None and d["generated_ms"] == T0 + 10 ** 7 for d in rebuilt))
        live = {SC.decision_hash(s) for index in skip for s, _ in self.live[index][1]}
        self.assertEqual({d["decision_hash"] for d in rebuilt}, live)
        self.assertEqual(self.gaps(), [])
        self.assertTrue(SC.verify_log(self.log, self.strategies)["ok"])

    def test_several_separate_gaps_are_all_rebuilt(self):
        skip = set(range(10, 13)) | {30} | set(range(50, 52))
        self.feed(skip=skip)
        gaps = self.gaps()
        self.assertEqual(len([g for g in gaps if g["strategy_id"] == self.strategies[0].id]), 3)
        stats = SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, gaps, 99)
        self.assertEqual((stats["persisted"], stats["failed"]), (len(skip) * len(self.strategies), 0))
        self.assertEqual(self.gaps(), [])
        live = {SC.decision_hash(s) for index in skip for s, _ in self.live[index][1]}
        self.assertEqual({e["data"]["decision_hash"] for e in self.log.signals() if e["data"]["origin"] == "reconstructed"}, live)

    def test_a_cycle_that_cannot_be_rebuilt_is_recorded_and_stays_a_gap(self):
        gap = {"strategy_id": self.strategies[0].id, "strategy_version": 1, "product_id": SC.DEMO_PRODUCT,
               "from_ms": T0 + MS, "to_ms": T0 + 2 * MS, "cycles": 2}   # before any indicator is ready
        stats = SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, [gap], 5)
        self.assertEqual((stats["persisted"], stats["failed"], stats["skipped_warmup"]), (0, 2, 2))
        self.assertEqual(sum(1 for e in self.log.entries if e["kind"] == "reconstruction_failed"), 2)
        SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, [gap], 6)
        self.assertEqual(sum(1 for e in self.log.entries if e["kind"] == "reconstruction_failed"), 2)   # once per cycle
        self.assertEqual(len(list(self.log.signals())), 0)

    def test_changed_pipeline_is_refused_like_changed_strategy_code(self):
        self.feed(skip={12})
        with mock.patch.object(SC, "pipeline_hash", return_value="another-pipeline"):
            with self.assertRaises(SC.ContinuityError) as caught:
                SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, self.gaps(), 5)
            self.assertEqual(caught.exception.reason, "pipeline_changed")
            with self.assertRaises(SC.ContinuityError) as frozen:
                self.log.freeze_strategy(self.strategies[0], 5)
            self.assertEqual(frozen.exception.reason, "pipeline_changed")
        self.assertEqual(SC.pipeline_hash(), SC.pipeline_hash())

    def test_verify_separates_integrity_from_proven_reproducibility(self):
        self.feed()
        full = SC.verify_log(self.log, self.strategies)
        self.assertEqual((full["integrity_ok"], full["reproducibility_proven"], full["reproduced"]), (True, True, full["signals"]))
        blind = SC.verify_log(self.log, [])
        self.assertEqual((blind["integrity_ok"], blind["ok"], blind["reproducibility_proven"], blind["reproduced"]),
                         (True, True, False, 0))
        self.assertEqual(blind["not_checked"], blind["signals"])
        with mock.patch.object(SC, "pipeline_hash", return_value="other"):
            self.assertFalse(SC.verify_log(self.log, self.strategies)["reproducibility_proven"])

    def test_reconstruction_is_deterministic(self):
        hashes = []
        for n in range(2):
            self.setUp()
            self.feed(skip=set(range(20, 40)))
            SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives, self.gaps(), 77)
            hashes.append(self.log.head)
        self.assertEqual(hashes[0], hashes[1])

    def test_incompatible_strategy_versions_are_refused(self):
        self.feed(skip={12})
        for variant, reason in (("bumped", "version_incompatible"), ("edited", "code_changed_same_version")):
            before = os.path.getsize(self.log.path)
            with self.assertRaises(SC.ContinuityError) as caught:
                SC.reconstruct(self.log, SC.demo_strategies(variant), SC.DEMO_PRODUCT, self.ones, self.fives, self.gaps(), 5)
            self.assertEqual(caught.exception.reason, reason)
            self.assertEqual(os.path.getsize(self.log.path), before)

    def test_incomplete_candles_are_refused(self):
        self.feed(skip={12})
        holey = self.ones[:300] + self.ones[301:]
        with self.assertRaises(SC.ContinuityError) as caught:
            SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, holey, self.fives, self.gaps(), 5)
        self.assertEqual(caught.exception.reason, "incomplete_candles")
        with self.assertRaises(SC.ContinuityError):
            SC.reconstruct(self.log, self.strategies, SC.DEMO_PRODUCT, self.ones, self.fives[:5], self.gaps(), 5)

    def test_verify_reproduces_and_detects_tampering(self):
        self.feed()
        report = SC.verify_log(self.log, self.strategies)
        self.assertTrue(report["ok"])
        self.assertEqual((report["not_reproducible"], report["bad_hashes"], report["not_checked"]), ([], [], 0))
        entry = next(self.log.signals())
        entry["data"]["signal"]["strength"] = "0.01"
        self.assertFalse(SC.verify_log(self.log, self.strategies)["ok"])


class RealCandlesTests(unittest.TestCase):
    def test_the_five_minute_bars_are_built_from_their_own_five_minutes(self):
        ones, fives = SC.real_candles(CANDLES)
        self.assertEqual((len(ones), len(fives)), (1168, 233))
        by_start = {c["bucket_start"]: c for c in ones}
        for bar in fives:
            self.assertEqual(bar["bucket_start"] % MS, 0)
            chunk = [by_start[bar["bucket_start"] + i * SC.ONE_MINUTE_MS] for i in range(5)]
            self.assertEqual((bar["open"], bar["close"]), (chunk[0]["open"], chunk[-1]["close"]))
            self.assertEqual(SC.D(bar["high"]), max(SC.D(c["high"]) for c in chunk))
            self.assertEqual(SC.D(bar["low"]), min(SC.D(c["low"]) for c in chunk))
            self.assertEqual(SC.D(bar["volume_btc"]), sum(SC.D(c["volume_btc"]) for c in chunk))
            self.assertEqual((bar["close_at"], bar["known_at"]), (chunk[-1]["close_at"], chunk[-1]["known_at"]))

    def test_a_hole_in_the_captured_minutes_is_refused(self):
        with open(CANDLES, encoding="utf-8") as handle:
            lines = handle.readlines()
        path = os.path.join(tempfile.mkdtemp(), "holey.jsonl")
        self.addCleanup(shutil.rmtree, os.path.dirname(path), True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.writelines(lines[:300] + lines[301:])
        with self.assertRaises(SC.ContinuityError) as caught:
            SC.real_candles(path)
        self.assertEqual(caught.exception.reason, "candles_not_consecutive")

    def test_the_last_revision_of_a_minute_wins(self):
        with open(CANDLES, encoding="utf-8") as handle:
            lines = handle.readlines()
        newer = json.loads(lines[10])
        newer.update(known_at=newer["known_at"] + 5_000, close_price="1", revision_hash="z" * 64)
        path = os.path.join(tempfile.mkdtemp(), "revised.jsonl")
        self.addCleanup(shutil.rmtree, os.path.dirname(path), True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.writelines(lines + [json.dumps(newer) + "\n"])
        ones, _ = SC.real_candles(path)
        self.assertEqual((ones[10]["close"], len(ones)), ("1", 1168))


class TwoProcessTests(unittest.TestCase):
    """Real, independent interpreters that share only files. The whole matrix is demo.scenarios; here its results
    are asserted."""

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp()
        cls.results = demo.scenarios(cls.base, CANDLES)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, True)

    def test_reference_run_is_clean(self):
        ref = self.results["referencia_sin_caidas"]
        self.assertEqual((ref["huecos"], ref["verificacion_ok"]), (0, True))
        self.assertGreater(ref["podian_abrir_posicion"], 0)

    def test_no_crash_point_changes_what_can_be_opened_or_duplicates_effects(self):
        for name in ("caida_a_mitad_de_persistir_con_reenvio", "caida_despues_de_persistir_con_reenvio", "caida_antes_de_confirmar_con_reenvio"):
            with self.subTest(name=name):
                r = self.results[name]
                self.assertEqual(r["codigo_de_salida_primer_proceso"], 137)
                self.assertTrue(r["mismas_posiciones_abribles_que_la_referencia"])
                self.assertEqual((r["efectos_duplicados"], r["decisiones_distintas_de_la_referencia"], r["senales_reconstruidas"]), (0, 0, 0))
        self.assertGreater(self.results["caida_a_mitad_de_persistir_con_reenvio"]["bytes_de_cola_descartados"], 0)

    def test_lost_signals_are_rebuilt_identically_but_never_open_positions(self):
        for name in ("caida_antes_de_persistir_sin_reenvio", "eventos_perdidos_y_duplicados", "caida_despues_de_persistir_reinicio_tardio"):
            with self.subTest(name=name):
                r = self.results[name]
                self.assertGreater(r["senales_reconstruidas"], 0)
                self.assertEqual((r["decisiones_distintas_de_la_referencia"], r["reconstruidas_que_abririan_posicion"], r["efectos_duplicados"]), (0, 0, 0))
                self.assertTrue(r["verificacion_ok"])
                self.assertTrue(r["recuperado_por_completo"])
                self.assertEqual(r["senales_originales"] + r["senales_reconstruidas"], self.results["referencia_sin_caidas"]["senales"])
        late = self.results["caida_despues_de_persistir_reinicio_tardio"]
        self.assertEqual((late["originales_vencidas_sin_posicion"], late["motivos"]), (1, ["signal_expired"]))

    def test_lost_events_show_up_as_offset_holes_and_cycle_gaps(self):
        r = self.results["eventos_perdidos_y_duplicados"]
        self.assertEqual(r["huecos_en_la_numeracion_de_origen"], [[7, 9], [60, 60]])
        self.assertGreater(r["huecos_de_ciclos"], 0)

    def test_incompatible_builds_are_refused_without_trace(self):
        for case in self.results["reconstruccion_con_versiones_incompatibles"].values():
            self.assertEqual((case["codigo"], case["registro_intacto"], case["escribio_informe"]), (3, True, False))
        reasons = {c["motivo"] for c in self.results["reconstruccion_con_versiones_incompatibles"].values()}
        self.assertEqual(reasons, {"version_incompatible", "code_changed_same_version"})

    def test_damaged_files_are_refused_never_recovered_silently(self):
        expected = {"checkpoint_alterado": "corrupt_checkpoint", "checkpoint_vacio": "corrupt_checkpoint",
                    "checkpoint_ausente": "checkpoint_missing", "registro_ausente": "log_missing",
                    "registro_con_entrada_alterada": "log_corrupt", "registro_reordenado": "log_corrupt",
                    "registro_truncado_antes_del_checkpoint": "log_behind_checkpoint", "registro_de_otra_corrida": "log_mismatch"}
        got = {k: v["motivo"] for k, v in self.results["archivos_danados"].items()}
        self.assertEqual(got, expected)
        for case in self.results["archivos_danados"].values():
            self.assertEqual((case["codigo"], case["escribio_informe"]), (3, False))


class IsolationTests(unittest.TestCase):
    def test_module_imports_nothing_that_touches_live_systems(self):
        for name in ("signal_continuity", "signal_continuity_demo"):
            with open(os.path.join(ROOT, "python", "balancita_engine", name + ".py"), encoding="utf-8") as handle:
                source = handle.read()
            for forbidden in ("sqlite3", "urllib", "socket", "requests", "futures_forward", "portfolio import", "multi_store", "kronos"):
                self.assertNotIn(forbidden, source, name)


if __name__ == "__main__":
    unittest.main()
