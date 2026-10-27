"""ops/qwen-lora/ckpt_eval.py: el emparejado real/espejo y la lectura de respuestas (lo que no necesita mlx)."""
import importlib.util
import json
import os
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = importlib.util.spec_from_file_location("ckpt_eval", os.path.join(ROOT, "ops", "qwen-lora", "ckpt_eval.py"))
ce = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ce)

STATE = ("QUESTION: F1 a F8.\nSTATE: Mercado.\nF1 Tendencia larga: retorno de 7d {s7}{r7} % (z {s7}1,0) | de 24h {s24}0,37 %.\n"
         "F2 Impulso corto: retorno de 4h {s4}0,10 % | de 1h {s1}0,18 %.\nF3 Lugar en el rango: 0,13.\n")


def example(signs, answer, r7="3,09"):
    user = STATE.format(s7=signs[0], s24=signs[1], s4=signs[2], s1=signs[3], r7=r7)
    return {"messages": [{"role": "system", "content": "x"}, {"role": "user", "content": user}, {"role": "assistant", "content": answer}]}


class PairsTests(unittest.TestCase):
    def test_pairs_the_real_photo_with_its_mirror_and_skips_entry_examples(self):
        rows = [
            example("-+++", "F1:+1 F2:+1 F3:+1 F4:+1 F5:0 F6:+1 F7:+1 F8:0"),
            example("++--", "E:-1"),
            example("+-+-", "F1:-2 F2:-2 F3:-2 F4:-2 F5:0 F6:-2 F7:-2 F8:0", r7="8,20"),   # otra foto, sin espejo en el archivo
            example("+---", "F1:-1 F2:-1 F3:-1 F4:-1 F5:0 F6:-1 F7:-1 F8:0"),   # espejo de la primera
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "valid.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
            pairs = ce.direction_pairs(path, 10)
        self.assertEqual(len(pairs), 1)
        answers = sorted(p["messages"][-1]["content"][:5] for p in pairs[0])
        self.assertEqual(answers, ["F1:+1", "F1:-1"])

    def test_a_sheet_and_its_mirror_that_both_say_nothing_are_still_a_pair(self):
        zero = "F1:0 F2:0 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0"
        rows = [example("-+++", zero), example("+---", zero)]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "valid.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
            self.assertEqual(len(ce.direction_pairs(path, 10)), 1)

    def test_values_and_sign(self):
        self.assertEqual(ce.values_of("F1:-1 F2:+2 F5:0"), {"F1": -1, "F2": 2, "F5": 0})
        self.assertEqual(ce.values_of("hola"), {})
        self.assertEqual([ce.sign(-2), ce.sign(0), ce.sign(1)], [-1, 0, 1])

    def test_adapter_dir_links_a_checkpoint_or_a_loose_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapters = os.path.join(tmp, "adapters"); os.makedirs(adapters)
            for name in ("0000500_adapters.safetensors", "adapters.safetensors", "adapter_config.json", "paso-1500.safetensors"):
                open(os.path.join(adapters, name), "w").close()
            out = os.path.join(tmp, "out")
            d500 = ce.adapter_dir(out, adapters, step="500")
            self.assertEqual(os.path.realpath(os.path.join(d500, "adapters.safetensors")), os.path.realpath(os.path.join(adapters, "0000500_adapters.safetensors")))
            dlast = ce.adapter_dir(out, adapters, step="7600")      # sin checkpoint con ese número: el adaptador final
            self.assertEqual(os.path.realpath(os.path.join(dlast, "adapters.safetensors")), os.path.realpath(os.path.join(adapters, "adapters.safetensors")))
            dfile = ce.adapter_dir(out, adapters, file=os.path.join(adapters, "paso-1500.safetensors"))
            self.assertTrue(dfile.endswith("paso-1500"))
            self.assertTrue(os.path.exists(os.path.join(dfile, "adapter_config.json")))
            self.assertIsNone(ce.adapter_dir(out, adapters, step="base"))


if __name__ == "__main__":
    unittest.main()
