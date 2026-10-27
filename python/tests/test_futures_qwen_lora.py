"""El dataset LoRA (``futures_qwen_lora``), el adaptador a GGUF (``futures_qwen_lora_adapter``) y la llave ``--lora`` del examen."""
import copy
import importlib.util
import io
import json
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_lora as lora
from balancita_engine import futures_qwen_lora_adapter as adapter
from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine.futures_qwen_ficha import FACTORS, VOTING

LIVE = qt.load_config(qt.CONFIG_PATH_LIVE)


def read_jsonl(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def photo(product, day, hour, move4, move24=0.0, state="STATE A", mirror="STATE B", z24=-1.0):
    """A photo like ``make_photos`` gives: the teacher reads ``hechos`` (here only z_24h carries a value)."""
    t_ms = qt.date_ms(day) + hour * qt.HOUR_MS
    hechos = {f: 0.0 for f in maestro.DIRECTIONAL + maestro.SYMMETRIC}
    hechos["z_24h"] = z24
    return {"product": product, "t_ms": t_ms, "wake": ["cada_15_min"], "state_text": state, "mirror_text": mirror,
            "moves": {"240": move4, "1440": move24}, "cost_bp": 10.0, "ficha": {"F1": 0.1, "F6": None}, "hechos": hechos}


# a teacher that only reads z_24h, inverted: z_24h = -1 -> score 1 -> strong long (+2); |z_24h| < 0.5 -> nothing
TEACHER = {"schema": "balancita-qwen-lora-maestro.v1", "plazo_min": 720, "umbrales": {"flojo": 0.5, "fuerte": 1.0},
           "sd": {f: 1.0 for f in maestro.DIRECTIONAL}, "coeficientes": {**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": -1.0}}


class LabelTests(unittest.TestCase):
    def test_the_line_is_what_the_grammar_accepts(self):
        line = lora.line_of([1, 1, 1, 1, 0, 1, 1, 0])
        self.assertEqual(line, "F1:+1 F2:+1 F3:+1 F4:+1 F5:0 F6:+1 F7:+1 F8:0")
        self.assertEqual(fq.parse_line(line), [1, 1, 1, 1, 0, 1, 1, 0])
        self.assertEqual(fq.parse_line(lora.line_of([-2, -2, -2, -2, 0, -2, -2, 0])), [-2, -2, -2, -2, 0, -2, -2, 0])
        self.assertEqual(fq.parse_line(lora.line_of([0] * 8)), [0] * 8)

    def test_an_example_is_the_live_prompt_with_the_teachers_verdict_and_the_mirror_turns_it_over(self):
        p = photo("PF_XBTUSD", "2024-01-01", 0, 20.0)
        real, mirror = lora.examples_of(LIVE, p, TEACHER)
        self.assertEqual([m["role"] for m in real["messages"]], ["system", "user", "assistant"])
        self.assertEqual(real["messages"][0]["content"], LIVE["prompt"]["system"])
        self.assertEqual(real["messages"][1]["content"], fq.build_prompt("STATE A", LIVE["factors"]["question"]))
        self.assertEqual(mirror["messages"][1]["content"], fq.build_prompt("STATE B", LIVE["factors"]["question"]))
        self.assertEqual(real["messages"][2]["content"], "F1:+2 F2:+2 F3:+2 F4:+2 F5:0 F6:+2 F7:+2 F8:0")
        self.assertEqual(mirror["messages"][2]["content"], "F1:-2 F2:-2 F3:-2 F4:-2 F5:0 F6:-2 F7:-2 F8:0")
        weak, weak_mirror = lora.examples_of(LIVE, photo("PF_XBTUSD", "2024-01-01", 1, 20.0, z24=0.7), TEACHER)
        self.assertEqual(weak["messages"][2]["content"], "F1:-1 F2:-1 F3:-1 F4:-1 F5:0 F6:-1 F7:-1 F8:0")
        self.assertEqual(weak_mirror["messages"][2]["content"], "F1:+1 F2:+1 F3:+1 F4:+1 F5:0 F6:+1 F7:+1 F8:0")
        none, none_mirror = lora.examples_of(LIVE, photo("PF_XBTUSD", "2024-01-01", 2, 20.0, z24=0.1), TEACHER)
        self.assertEqual(none["messages"][2]["content"], none_mirror["messages"][2]["content"])
        self.assertEqual(none["messages"][2]["content"], "F1:0 F2:0 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0")


def bars_from(day, closes, span=1.0, lead=0):
    """Synthetic 5m candles from ``lead`` bars before ``day`` 00:00 with the given closes (high = close + span, low = close - span)."""
    start = qt.date_ms(day) - lead * qt.BAR_MS
    return [{"bucket_start": start + i * qt.BAR_MS, "open": str(c), "high": str(c + span), "low": str(c - span), "close": str(c),
             "volume": "1"} for i, c in enumerate(closes)]


class EntryTests(unittest.TestCase):
    def test_the_nets_of_the_five_ways_in(self):
        # price steps down to 99.5 at once and stays: the market entry loses 50 bp, waiting an hour enters at the bottom,
        # the 15 min candle goes against the long so the confirmation does not enter, the limit orders fill on the first bar
        nxt = [(100.0, 99.0, 99.5)] * lora.ENTRY_BARS
        nets = lora.entry_nets(1, 100.0, nxt, "PF_XBTUSD")
        self.assertAlmostEqual(nets[0], -50.0 - 10.12, places=6)
        self.assertAlmostEqual(nets[2], -10.12, places=6)
        self.assertEqual(nets[1], 0.0)
        self.assertAlmostEqual(nets[-1], (99.5 / 99.9 - 1) * 1e4 - 7.06, places=6)
        self.assertAlmostEqual(nets[-2], (99.5 / 99.7 - 1) * 1e4 - 7.06, places=6)
        self.assertEqual(lora.entry_label(nets), 1)
        # a short in the same path: the price went its way, the market entry wins 50 bp, the limits above never fill
        nets = lora.entry_nets(-1, 100.0, nxt, "PF_XBTUSD")
        self.assertAlmostEqual(nets[0], 50.0 - 10.12, places=6)
        self.assertEqual((nets[-1], nets[-2]), (0.0, 0.0))
        self.assertAlmostEqual(nets[1], -10.12, places=6)                 # confirmed at 99.5, flat afterwards
        self.assertEqual(lora.entry_label(nets), 0)
        with self.assertRaises(ValueError):
            lora.entry_nets(1, 100.0, nxt[:10], "PF_XBTUSD")

    def test_a_limit_fills_when_a_later_bar_touches_it_and_exits_four_hours_after_the_fill(self):
        closes = [100.0] * 5 + [99.85] + [100.0] * 60 + [101.0] * 20     # bar 5 dips 15 bp (low 99.75): only the 10 bp order fills
        nxt = [(c + 0.1, c - 0.1, c) for c in closes][:lora.ENTRY_BARS]
        nets = lora.entry_nets(1, 100.0, nxt, "PF_ETHUSD")
        exit_price = nxt[5 + 48][2]
        self.assertAlmostEqual(nets[-1], (exit_price / 99.9 - 1) * 1e4 - (2 + 5 + 0.19), places=6)
        self.assertEqual(nets[-2], 0.0)
        self.assertEqual(lora.entry_label(nets), -1)

    def test_ties_go_to_the_simplest_option(self):
        self.assertEqual(lora.entry_label({-2: 0.0, -1: 0.0, 0: 0.0, 1: 0.0, 2: 0.0}), 0)
        self.assertEqual(lora.entry_label({-2: 3.0, -1: 3.0, 0: 0.0, 1: 0.0, 2: 0.0}), -1)
        self.assertEqual(lora.entry_label({-2: 3.0, -1: 1.0, 0: 0.0, 1: 0.0, 2: 3.0}), 2)

    def test_the_entry_line_and_its_grammar(self):
        for value in (-2, -1, 0, 1, 2):
            self.assertEqual(lora.parse_entry_line(lora.entry_line(value)), value)
        self.assertEqual(lora.entry_line(1), "E:+1")
        self.assertIsNone(lora.parse_entry_line("E:+3"))
        self.assertIsNone(lora.parse_entry_line("F1:+1"))
        self.assertIn('"E:"', lora.ENTRY_GRAMMAR)


class SamplingTests(unittest.TestCase):
    def photos(self):
        out = []
        for product in ("PF_XBTUSD", "PF_ETHUSD"):
            for month, n in (("2024-01", 40), ("2024-02", 40), ("2024-03", 2)):
                out += [photo(product, month + "-01", h, 1.0) for h in range(n)]
        return out

    def test_the_sample_is_seeded_spread_over_months_and_fills_from_the_full_months(self):
        photos = self.photos()
        chosen = lora.sample_photos(photos, 30, "s")
        self.assertEqual(len(chosen), 60)
        self.assertEqual(sum(1 for p in chosen if p["product"] == "PF_XBTUSD"), 30)
        months = {}
        for p in chosen:
            if p["product"] == "PF_XBTUSD":
                months[lora.month_of(p["t_ms"])] = months.get(lora.month_of(p["t_ms"]), 0) + 1
        self.assertEqual(months["2024-03"], 2)                       # the short month gives what it has
        self.assertEqual(months["2024-01"] + months["2024-02"], 28)   # the rest is filled from the others
        self.assertEqual([p["t_ms"] for p in chosen], [p["t_ms"] for p in lora.sample_photos(photos, 30, "s")])
        self.assertNotEqual([p["t_ms"] for p in chosen], [p["t_ms"] for p in lora.sample_photos(photos, 30, "other")])

    def test_valid_is_the_last_months_by_time(self):
        train, valid = lora.split_valid(self.photos(), 1)
        self.assertTrue(all(lora.month_of(p["t_ms"]) == "2024-03" for p in valid))
        self.assertEqual(len(valid), 4)
        self.assertEqual(len(train), 160)
        self.assertEqual(lora.split_valid(self.photos(), 0)[1], [])


class FakeHistory:
    def __init__(self):
        self.calls = []

    def bars(self, product, from_ms, to_ms):
        self.calls.append((product, from_ms, to_ms))
        out = []
        for day in ("2024-01-01", "2024-02-01", "2024-03-01"):
            out += bars_from(day, [100.0 + 0.01 * i for i in range(300)], lead=12)   # the bar that closes at 00:00 too
        return out


class BuildTests(unittest.TestCase):
    def test_build_dataset_writes_jsonl_and_meta_without_touching_the_holdout(self):
        z = {0: -1.5, 1: 0.7, 2: 0.1, 3: 2.0, 4: -0.6, 5: 0.0}                        # verdicts +2, -1, 0, -2, +1, 0
        photos = {"PF_XBTUSD": [photo("PF_XBTUSD", "2024-0{}-01".format(m), h, (-1) ** h * (10.0 + h), move24=5.0 * (-1) ** m, z24=z[h])
                                for m in (1, 2, 3) for h in range(6)]}
        calls = []
        history = FakeHistory()

        def fake_between(history, cfg, product, from_day, to_day, log=print):
            calls.append((product, from_day, to_day))
            return photos[product]

        original = lora.photos_between
        lora.photos_between = fake_between
        try:
            with tempfile.TemporaryDirectory() as tmp:
                meta = lora.build_dataset(history, LIVE, tmp, teacher=dict(TEACHER, _path=os.path.join(qt.ROOT, "config", "x.json")),
                                          products=("PF_XBTUSD",), from_day="2024-01-01", to_day="2024-04-01", per_product=9,
                                          valid_months=1, log=lambda *a: None)
                train, valid = read_jsonl(os.path.join(tmp, "train.jsonl")), read_jsonl(os.path.join(tmp, "valid.jsonl"))
                with open(os.path.join(tmp, "meta.json"), encoding="utf-8") as handle:
                    stored = json.load(handle)
        finally:
            lora.photos_between = original
        self.assertEqual(calls, [("PF_XBTUSD", "2024-01-01", "2024-04-01")])
        self.assertEqual(history.calls, [])                                       # the teacher needs no candles beyond the photos
        self.assertEqual(meta["photos_sampled"], 9)
        self.assertEqual(len(train) + len(valid), 18)                              # two examples per photo: real and mirror
        self.assertEqual(len(valid), 6)                                            # the 3 photos of March, twice
        self.assertEqual(stored["schema"], "balancita-qwen-lora-dataset.v3")
        self.assertEqual(stored["config_hash"], qt.config_hash(LIVE))
        self.assertEqual(stored["maestro"], {"archivo": "config/x.json", "hash": maestro.teacher_hash(TEACHER), "plazo_min": 720,
                                             "umbrales": {"flojo": 0.5, "fuerte": 1.0}})
        self.assertAlmostEqual(sum(stored["label_share"].values()), 1.0)
        self.assertEqual(set(stored["label_share"]), {"-2", "-1", "0", "1", "2"})
        self.assertEqual(set(stored["acierto_maestro"]), {"240", "1440"})
        self.assertNotIn("entry_options", stored)
        for row in train + valid:
            values = fq.parse_line(row["messages"][2]["content"])
            self.assertIsNotNone(values)
            self.assertEqual(len(set(values[i] for i, f in enumerate(FACTORS) if f in VOTING)), 1)
            self.assertEqual([values[i] for i, f in enumerate(FACTORS) if f not in VOTING], [0, 0])
        # every real sheet has its mirror with the opposite verdict
        answers = sorted(fq.parse_line(r["messages"][2]["content"])[0] for r in train + valid)
        self.assertEqual(answers, sorted(-a for a in answers))

    def test_build_dataset_refuses_photos_without_the_facts(self):
        bare = [{k: v for k, v in photo("PF_XBTUSD", "2024-01-01", h, 1.0).items() if k != "hechos"} for h in range(3)]
        original = lora.photos_between
        lora.photos_between = lambda *a, **k: bare
        try:
            with tempfile.TemporaryDirectory() as tmp, self.assertRaises(qt.TraderError):
                lora.build_dataset(FakeHistory(), LIVE, tmp, teacher=TEACHER, products=("PF_XBTUSD",), from_day="2024-01-01",
                                   to_day="2024-02-01", per_product=3, valid_months=0, log=lambda *a: None)
        finally:
            lora.photos_between = original

    def test_facts_rows_flatten_the_photo(self):
        rows = list(lora.facts_rows([photo("PF_XBTUSD", "2024-01-01", 0, 20.0, move24=-3.0)]))
        self.assertEqual(rows[0]["product"], "PF_XBTUSD")
        self.assertEqual((rows[0]["z_24h"], rows[0]["move_240"], rows[0]["move_1440"]), (-1.0, 20.0, -3.0))
        self.assertIn("realized", rows[0])

    def test_the_cli_refuses_a_period_that_reaches_the_holdout(self):
        holdout = qt.stamp(qt.load_holdout_ms())[:10]
        with self.assertRaises(qt.TraderError):
            lora.main(["numbers", "--offline", "--cache-dir", tempfile.gettempdir(), "--from", "2026-01-01", "--to",
                       "2027-01-01", "--out", os.path.join(tempfile.gettempdir(), "never.jsonl")])
        self.assertTrue(holdout <= "2027-01-01")


PLAIN = {k: v for k, v in LIVE.items() if k != "lora"}      # the live config before version 7: no adapter


class ExamLoraSwitchTests(unittest.TestCase):
    def test_without_an_adapter_no_request_names_one_and_the_identity_is_the_old_one(self):
        self.assertIsNone(qt.lora_of(PLAIN))
        body = fq.request_body("hola", qt.template_of(PLAIN))
        self.assertNotIn("lora", body)
        self.assertNotIn("lora", ex.exam_identity(PLAIN, qt.load_holdout_ms()))

    def test_with_the_flag_every_request_carries_it_and_the_identity_changes_but_not_the_config_hash(self):
        cfg = dict(PLAIN, runtime=dict(PLAIN.get("runtime") or {}, lora=qt.parse_lora("0")))
        self.assertEqual(qt.lora_of(cfg), [{"id": 0, "scale": 1.0}])
        self.assertEqual(qt.parse_lora("1:0.5"), [{"id": 1, "scale": 0.5}])
        with self.assertRaises(qt.TraderError):
            qt.parse_lora("a")
        body = fq.request_body("hola", qt.template_of(cfg))
        self.assertEqual(body["lora"], [{"id": 0, "scale": 1.0}])
        self.assertEqual(qt.config_hash(cfg), qt.config_hash(PLAIN))            # runtime is not identity...
        self.assertEqual(ex.exam_identity(cfg, 1)["lora"], [{"id": 0, "scale": 1.0}])   # ...but the exam's own identity is

    def test_the_live_config_version_7_carries_the_adapter_as_identity(self):
        # Fran (27-oct-2026): «dejalo en vivo». Every live request asks for the adapter at scale 1 (llama-server starts it at
        # scale 0, scripts/dev-provider-env.mjs), the hash changes so the version 6 database archives itself.
        self.assertEqual(LIVE["lora"]["request"], [{"id": 0, "scale": 1.0}])
        self.assertEqual(qt.lora_of(LIVE), [{"id": 0, "scale": 1.0}])
        self.assertEqual(fq.request_body("hola", qt.template_of(LIVE))["lora"], [{"id": 0, "scale": 1.0}])
        self.assertNotEqual(qt.config_hash(LIVE), qt.config_hash(PLAIN))
        self.assertEqual(ex.exam_identity(LIVE, 1)["lora"], [{"id": 0, "scale": 1.0}])
        # the exam's own flag still wins (another adapter or scale on the same config)
        cfg = dict(LIVE, runtime=dict(LIVE["runtime"], lora=qt.parse_lora("1:0.5")))
        self.assertEqual(qt.lora_of(cfg), [{"id": 1, "scale": 0.5}])

    def test_the_exam_cli_applies_exam_from_and_lora_before_running(self):
        seen = {}

        def fake_run(history, db, provider, cfg, holdout_ms, **kw):
            seen["cfg"] = cfg
            return {"stop_reason": "done", "answered": 0, "total": 0, "calls": 0, "remaining": 0}

        class Provider:
            base_url = "http://127.0.0.1:1"

            def health(self):
                return True

        original_run, original_provider = ex.run_exam, qt._provider
        ex.run_exam, qt._provider = fake_run, lambda url: Provider()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = io.StringIO()
                import contextlib
                with contextlib.redirect_stdout(out):
                    qt.main(["exam", "--version", "live", "--offline", "--cache-dir", tmp, "--exam-db",
                             os.path.join(tmp, "e.sqlite"), "--lora", "0", "--exam-from", "2025-10-16"])
        finally:
            ex.run_exam, qt._provider = original_run, original_provider
        self.assertEqual(seen["cfg"]["practice"]["from"], "2025-10-16")
        self.assertEqual(seen["cfg"]["runtime"]["lora"], [{"id": 0, "scale": 1.0}])
        self.assertNotEqual(qt.config_hash(seen["cfg"]), qt.config_hash(LIVE))   # another period: another database


class AdapterMathTests(unittest.TestCase):
    def test_pairs_groups_lora_a_and_lora_b_per_module_and_rejects_a_lone_half(self):
        tensors = {"model.layers.0.self_attn.q_proj.lora_a": "A", "model.layers.0.self_attn.q_proj.lora_b": "B",
                   "model.layers.12.mlp.down_proj.lora_a": "C", "model.layers.12.mlp.down_proj.lora_b": "D"}
        self.assertEqual(adapter.pairs(tensors), {"model.layers.0.self_attn.q_proj": ("A", "B"),
                                                  "model.layers.12.mlp.down_proj": ("C", "D")})
        self.assertEqual(adapter.n_layers(adapter.pairs(tensors)), 13)
        with self.assertRaises(ValueError):
            adapter.pairs({"model.layers.0.self_attn.q_proj.lora_a": "A"})
        with self.assertRaises(ValueError):
            adapter.pairs({"lm_head.lora_a": "A", "lm_head.lora_b": "B"})

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "numpy no instalado")
    def test_to_llama_gives_the_peft_orientation_and_the_same_delta_as_mlx_fuse(self):
        import numpy as np
        rng = np.random.default_rng(1)
        lora_a, lora_b = rng.normal(size=(6, 2)).astype(np.float32), rng.normal(size=(2, 5)).astype(np.float32)   # in 6, r 2, out 5
        a, b = adapter.to_llama(lora_a, lora_b, 20.0)
        self.assertEqual((a.shape, b.shape), ((2, 6), (5, 2)))
        # llama.cpp applies alpha / rank (= 1 here) x B @ A on W (out, in); mlx fuse adds scale x lora_b.T @ lora_a.T
        np.testing.assert_allclose(b @ a, adapter.delta(lora_a, lora_b, 20.0), rtol=1e-5)
        x = rng.normal(size=(6,)).astype(np.float32)
        np.testing.assert_allclose((b @ a) @ x, 20.0 * ((x @ lora_a) @ lora_b), rtol=1e-4)
        with self.assertRaises(ValueError):
            adapter.to_llama(lora_a, rng.normal(size=(3, 5)), 20.0)

    @unittest.skipUnless(importlib.util.find_spec("gguf") and importlib.util.find_spec("safetensors"), "gguf no instalado")
    def test_convert_writes_an_adapter_gguf_llama_cpp_understands(self):
        import gguf
        import numpy as np
        from safetensors.numpy import save_file
        rng = np.random.default_rng(2)
        tensors = {}
        for layer in (0, 1):
            for proj, (i, o) in (("self_attn.q_proj", (16, 32)), ("mlp.down_proj", (24, 16))):
                tensors["model.layers.{}.{}.lora_a".format(layer, proj)] = rng.normal(size=(i, 4)).astype(np.float32)
                tensors["model.layers.{}.{}.lora_b".format(layer, proj)] = rng.normal(size=(4, o)).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            save_file(tensors, os.path.join(tmp, "adapters.safetensors"))
            with open(os.path.join(tmp, "adapter_config.json"), "w") as handle:
                json.dump({"lora_parameters": {"rank": 4, "scale": 10.0, "dropout": 0.0}}, handle)
            out = os.path.join(tmp, "a.gguf")
            info = adapter.convert(tmp, out, log=lambda *a: None)
            reader = gguf.GGUFReader(out)
            fields = {k: v for k, v in reader.fields.items()}
            names = {t.name: t for t in reader.tensors}
        self.assertEqual(info, {"tensors": 8, "rank": 4, "scale": 10.0, "alpha": 4.0})
        self.assertEqual(set(names), {"blk.0.attn_q.weight.lora_a", "blk.0.attn_q.weight.lora_b", "blk.0.ffn_down.weight.lora_a",
                                      "blk.0.ffn_down.weight.lora_b", "blk.1.attn_q.weight.lora_a", "blk.1.attn_q.weight.lora_b",
                                      "blk.1.ffn_down.weight.lora_a", "blk.1.ffn_down.weight.lora_b"})
        self.assertIn("adapter.type", fields)
        self.assertIn("adapter.lora.alpha", fields)
        self.assertEqual(float(fields["adapter.lora.alpha"].parts[-1][0]), 4.0)
        a, b = names["blk.0.attn_q.weight.lora_a"], names["blk.0.attn_q.weight.lora_b"]
        # ggml lists dimensions reversed: (r, in) is stored as ne = [in, r]
        self.assertEqual([int(x) for x in a.shape], [16, 4])
        self.assertEqual([int(x) for x in b.shape], [4, 32])
        np.testing.assert_allclose(np.asarray(a.data).reshape(4, 16), tensors["model.layers.0.self_attn.q_proj.lora_a"].T, rtol=1e-6)
        np.testing.assert_allclose(np.asarray(b.data).reshape(32, 4), 10.0 * tensors["model.layers.0.self_attn.q_proj.lora_b"].T, rtol=1e-5)


if __name__ == "__main__":
    unittest.main()
