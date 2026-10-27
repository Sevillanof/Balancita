"""La Prueba rápida de Qwen con menos trabajo de GPU: respuestas reutilizadas del examen, tiempos crudos y la ficha con el
texto fijo primero (variante ``ficha-prefijo``)."""
import copy
import hashlib
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_quick_variants as qv
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from test_futures_qwen_exam import CFG3, cfg3
from test_futures_qwen_trader import HOLDOUT, MemHistory
from test_futures_qwen_factors import LINE_OK, ChatProvider, build_trader, completion, row_of


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def common_prefix(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
        self.ref = os.path.join(self.dir.name, "exam-live.sqlite")
        self.provider = ChatProvider(lambda body: completion(LINE_OK))
        pdb = self.pdb(self.ref)
        decider = fq.FactorsDecider(self.provider, self.cfg, store=pdb, model="m")
        decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        pdb.close()
        self.assertEqual(self.provider.calls, 2)
        self.ref_hash = digest(self.ref)

    def pdb(self, path):
        pdb = qt.PracticeDB(path)
        pdb.db.executescript(ex._EXAM_SQL + fq.FICHA_SQL)
        self.addCleanup(pdb.close)
        return pdb

    def decider(self, cfg=None, model="m", reference="ref", name="quick.sqlite"):
        provider = ChatProvider(lambda body: completion([-1] * 8))
        pdb = self.pdb(os.path.join(self.dir.name, name))
        decider = fq.FactorsDecider(provider, cfg or self.cfg, store=pdb, model=model,
                                    reference=self.ref if reference == "ref" else reference)
        return decider, provider, pdb

    def test_the_same_question_is_copied_without_calling_and_the_reference_stays_intact(self):
        decider, provider, pdb = self.decider()
        real, mirror = decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual((provider.calls, decider.reused, decider.calls), (0, 2, 0))
        self.assertEqual(real["values"], LINE_OK)
        self.assertEqual(pdb.db.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 2)
        self.assertEqual(pdb.db.execute("SELECT COUNT(*) FROM exam_timings").fetchone()[0], 0)    # nothing was asked
        decider.ask("exam:X:1", 1, "action", "estado real")                                       # now it is its own row
        self.assertEqual(decider.reused, 2)
        decider.close()
        self.assertEqual(digest(self.ref), self.ref_hash)

    def test_a_different_prompt_model_or_version_is_asked_again(self):
        other_state, provider, _ = self.decider(name="a.sqlite")
        other_state.ask("exam:X:1", 1, "action", "otro estado")
        self.assertEqual((provider.calls, other_state.reused), (1, 0))
        other_model, provider, _ = self.decider(model="otro", name="b.sqlite")
        other_model.ask("exam:X:1", 1, "action", "estado real")
        self.assertEqual((provider.calls, other_model.reused), (1, 0))
        cfg = copy.deepcopy(self.cfg)
        cfg["prompt"]["version"] = self.cfg["prompt"]["version"] + 0.1
        other_version, provider, _ = self.decider(cfg=cfg, name="c.sqlite")
        other_version.ask("exam:X:1", 1, "action", "estado real")
        self.assertEqual((provider.calls, other_version.reused), (1, 0))
        self.assertEqual(digest(self.ref), self.ref_hash)

    def test_without_a_reference_or_with_one_that_is_not_an_exam_everything_goes_on_as_before(self):
        for reference in (None, os.path.join(self.dir.name, "no-existe.sqlite")):
            decider, provider, _ = self.decider(reference=reference, name="n{}.sqlite".format(bool(reference)))
            decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
            self.assertEqual((provider.calls, decider.reused), (2, 0))
        junk = os.path.join(self.dir.name, "junk.sqlite")
        sqlite3.connect(junk).close()
        decider, provider, _ = self.decider(reference=junk, name="j.sqlite")
        decider.ask("exam:X:1", 1, "action", "estado real")
        self.assertEqual((provider.calls, decider.reused), (1, 0))


class TimingsTests(unittest.TestCase):
    def run_one(self, timings):
        with tempfile.TemporaryDirectory() as tmp:
            def script(body):
                out = completion(LINE_OK)
                if timings is not None:
                    out["timings"] = timings
                return out
            pdb = qt.PracticeDB(os.path.join(tmp, "x.sqlite"))
            pdb.db.executescript(ex._EXAM_SQL + fq.FICHA_SQL)
            cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
            fq.FactorsDecider(ChatProvider(script), cfg, store=pdb, model="m").ask("exam:X:1", 1, "action", "estado")
            row = pdb.db.execute("SELECT * FROM exam_timings").fetchone()
            factors = pdb.db.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0]
            pdb.close()
            return dict(row), factors

    def test_the_raw_timings_of_llama_server_are_kept_per_call(self):
        row, factors = self.run_one({"prompt_n": 80, "cache_n": 812, "predicted_n": 30, "prompt_ms": 410.5, "predicted_ms": 900.25})
        self.assertEqual((row["snap_id"], row["step"], row["prompt_n"], row["cache_n"], row["predicted_n"]),
                         ("exam:X:1", "action", 80, 812, 30))
        self.assertEqual((row["prompt_ms"], row["predicted_ms"]), (410.5, 900.25))
        self.assertEqual(factors, 1)

    def test_an_answer_without_timings_still_keeps_the_latency(self):
        row, factors = self.run_one(None)
        self.assertEqual((row["prompt_n"], row["cache_n"], row["prompt_ms"]), (None, None, None))
        self.assertIsNotNone(row["latency_ms"])
        self.assertEqual(factors, 1)


class MirrorEveryTests(unittest.TestCase):
    def run_quick(self, **kwargs):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as tmp:
            variant = qv.get_variant("ficha")
            cfg = qv.apply_variant(cfg3(), variant)
            cfg["state_context"] = ["PF_ETHUSD"]
            db = os.path.join(tmp, "q.sqlite")
            provider = ChatProvider(lambda body: completion(LINE_OK))
            state = ex.run_quick(MemHistory(), db, provider, cfg, HOLDOUT, snapshots=30, max_minutes=500,
                                 clock=lambda: clock[0], log=lambda *a: None, state_path=os.path.join(tmp, "q.json"),
                                 variant=variant, **kwargs)
            con = sqlite3.connect(db)
            rows = con.execute("SELECT a.real_action, a.mirror_action, s.ord FROM exam_answers a JOIN exam_snapshots s "
                               "USING(snap_id)").fetchall()
            mirrors = con.execute("SELECT COUNT(*) FROM exam_factors WHERE step='mirror'").fetchone()[0]
            con.close()
            return state, provider, rows, mirrors

    def test_the_quick_test_asks_the_mirror_for_one_photo_in_two_by_default(self):
        self.assertEqual(ex.QUICK_MIRROR_EVERY, 2)
        state, provider, rows, mirrors = self.run_quick()
        self.assertEqual(state["state"], "done")
        self.assertEqual((len(rows), mirrors, provider.calls), (30, 15, 45))
        self.assertTrue(all(r[0] is not None for r in rows))
        self.assertEqual({r[2] % 2 == 0 for r in rows if r[1] is not None}, {True})
        self.assertEqual(sum(1 for r in rows if r[1] is None), 15)

    def test_asking_every_photo_still_gives_the_full_mirror(self):
        _, provider, rows, mirrors = self.run_quick(mirror_every=1)
        self.assertEqual((mirrors, provider.calls), (30, 60))
        self.assertTrue(all(r[1] is not None for r in rows))


class PrefixSheetTests(unittest.TestCase):
    def setUp(self):
        self.variant = qv.get_variant("ficha-prefijo")
        self.cfg = qv.apply_variant(cfg3(), self.variant)
        plain = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
        self.trader, self.t_ms = build_trader(cfg=self.cfg)
        self.plain, self.plain_t = build_trader(cfg=plain)
        self.later, self.later_t = build_trader(cfg=copy.deepcopy(self.cfg), bars_after=640)

    def test_the_variant_is_its_own_version_and_leaves_the_plain_sheet_alone(self):
        self.assertEqual(self.cfg["state_ficha_layout"], "prefijo")
        plain = qv.apply_variant(CFG3, qv.get_variant("ficha"))
        self.assertNotIn("state_ficha_layout", plain)
        self.assertNotEqual(qt.config_hash(plain), qt.config_hash(qv.apply_variant(CFG3, self.variant)))
        self.assertEqual(self.variant["factors"], qv.get_variant("ficha")["factors"])
        self.assertEqual(qv.db_name("ficha-prefijo"), "exam-v3-rapida-ficha-prefijo.sqlite")

    def test_two_photos_share_a_long_prefix_and_the_plain_sheet_does_not(self):
        question = qv.get_variant("ficha-prefijo")["factors"]["question"]
        a = fq.build_prompt(self.trader.state_text(self.t_ms, ["hora_cerrada"]), question)
        b = fq.build_prompt(self.later.state_text(self.later_t, ["hora_cerrada"]), question)
        plain = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
        pb, _ = build_trader(cfg=copy.deepcopy(plain), bars_after=640)
        c = fq.build_prompt(self.plain.state_text(self.plain_t, ["hora_cerrada"]), question)
        d = fq.build_prompt(pb.state_text(self.later_t, ["hora_cerrada"]), question)
        long_prefix, short_prefix = common_prefix(a, b), common_prefix(c, d)
        self.assertGreater(long_prefix, 2 * short_prefix)
        self.assertGreater(long_prefix, 219 * 3)                    # about 219 tokens or more at ~3 characters each
        self.assertIn("F8 Momento", a[long_prefix:])                # the data begins after the common part

    def test_the_numbers_are_the_same_as_in_the_plain_sheet_and_the_data_lines_are_unchanged(self):
        new, old = self.trader.state_text(self.t_ms, ["hora_cerrada"]), self.plain.state_text(self.plain_t, ["hora_cerrada"])
        self.assertEqual(self.t_ms, self.plain_t)
        for number in (1, 2, 3, 4, 5, 6, 7, 8):
            self.assertIn(row_of(old, number), new.splitlines())
        self.assertEqual(old.splitlines()[-1], new.splitlines()[-1])           # the position stays last
        for line in old.splitlines():
            if line.startswith(("Costo de entrar", "Reglas fijas")):
                self.assertIn(line, new.splitlines())
        self.assertIn("Despertaste por: hora_cerrada", new)
        self.assertEqual(new.index("Reglas fijas") < new.index("Datos de esta foto"), True)
        self.assertEqual(new.splitlines().index(row_of(new, 1)) > new.splitlines().index(
            next(x for x in new.splitlines() if x.startswith("Costo de entrar"))), True)

    def test_the_mirror_flips_the_same_lines_as_before_and_nothing_else(self):
        real = self.trader.state_text(self.t_ms, ["hora_cerrada"])
        mirror = self.trader.state_text(self.t_ms, ["hora_cerrada"], mirror=True)
        for number in (1, 2, 3, 4, 6, 7):
            self.assertNotEqual(row_of(real, number), row_of(mirror, number), "F{}".format(number))
        for number in (5, 8):
            self.assertEqual(row_of(real, number), row_of(mirror, number))
        flipped = [i for i, (a, b) in enumerate(zip(real.splitlines(), mirror.splitlines())) if a != b]
        plain_real = self.plain.state_text(self.plain_t, ["hora_cerrada"])
        plain_mirror = self.plain.state_text(self.plain_t, ["hora_cerrada"], mirror=True)
        self.assertEqual(len(flipped), sum(1 for a, b in zip(plain_real.splitlines(), plain_mirror.splitlines()) if a != b))
        self.assertGreater(common_prefix(real, mirror), 900)                   # real and mirror also share the long prefix


if __name__ == "__main__":
    unittest.main()
