import random
import unittest

from balancita_engine import futures_qwen_memory as mem
from balancita_engine import futures_qwen_weights as wt
from balancita_engine.futures_qwen_ficha import VOTING

H = 3_600_000
CFG = {"memory": {"k": 3, "horizon_min": 240, "min_cases": 2, "library_step_h": 1}}


def photo(hour, f1, move, product="PF_XBTUSD"):
    return {"product": product, "t_ms": hour * H, "moves": {"240": move}, "state_text": "S", "mirror_text": "M",
            "ficha": {"F1": f1, "F2": 0.0, "F3": 0.0, "F4": 0.0, "F5": 1.0, "F6": None, "F7": 0.0}}


class MemoryTests(unittest.TestCase):
    def test_only_cases_already_resolved_enter(self):
        photos = [photo(h, 1.0, 10.0) for h in range(0, 40, 5)]
        target = photo(20, 1.0, 0.0)
        found = mem.neighbors(mem.library(photos, CFG), mem.vector(target["ficha"]), target["t_ms"], CFG)
        self.assertTrue(found)
        for _, case in found:
            self.assertLessEqual(case["t_ms"] + 240 * 60_000, target["t_ms"])

    def test_neighbors_are_spaced_by_the_horizon(self):
        photos = [photo(h, 1.0, 10.0) for h in range(0, 30)]
        found = mem.neighbors(mem.library(photos, CFG), mem.vector(photos[0]["ficha"]), 100 * H, CFG)
        times = sorted(c["t_ms"] for _, c in found)
        self.assertTrue(all(b - a >= 4 * H for a, b in zip(times, times[1:])))

    def test_mirror_is_the_same_cases_with_the_result_flipped(self):
        photos = [photo(h, 1.0, 20.0) for h in range(0, 60, 5)]
        found = mem.neighbors(mem.library(photos, CFG), mem.vector(photos[0]["ficha"]), 200 * H, CFG)
        real, mirror = mem.lines(found, CFG, 1.0)[0], mem.lines(found, CFG, -1.0)[0]
        self.assertIn("subió en 3 y bajó en 0", real)
        self.assertIn("subió en 0 y bajó en 3", mirror)

    def test_without_enough_cases_it_says_so_and_attach_keeps_going(self):
        chosen = [photo(1, 1.0, 0.0)]
        self.assertEqual(mem.attach(chosen, chosen, CFG), 0)
        self.assertIn("todavía no hay casos", chosen[0]["state_text"])
        self.assertTrue(chosen[0]["mirror_text"].startswith("M\n"))

    def test_missing_numbers_do_not_break_the_distance(self):
        a, b = mem.vector({"F1": 1.0}), mem.vector({"F1": 1.0, "F2": 2.0})
        self.assertEqual(mem.distance(a, b), 0.0)
        self.assertIsNone(mem.distance(mem.vector({}), b))


class WeightsTests(unittest.TestCase):
    def rows(self, n, slope, seed=1):
        rng = random.Random(seed)
        out = []
        for i in range(n):
            lect = [rng.choice([-2, -1, 0, 1, 2]) * 1.0 for _ in range(8)]
            move = slope * lect[0] + rng.gauss(0, 10)
            out.append({"t_ms": i * 2 * H, "moves": {"240": move}, "cost_bp": 5.0,
                        "factors": {"lectura": lect, "numbers": {"F1": lect[0], "F2": lect[1], "F3": lect[2], "F4": 0.0, "F6": 0.0}}})
        return out

    def test_it_learns_a_reversed_line_and_wins_out_of_sample(self):
        res = wt.evaluate(self.rows(900, -6.0), 240)
        self.assertLess(res["weights"]["F1"], 0)
        self.assertGreater(res["learned"]["spearman"], 0.2)
        self.assertLess(res["equal"]["spearman"], res["learned"]["spearman"])

    def test_pure_noise_does_not_show_an_edge(self):
        res = wt.evaluate(self.rows(900, 0.0, seed=3), 240)
        self.assertLess(abs(res["learned"]["spearman"]), 0.15)

    def test_training_never_sees_the_block_it_predicts(self):
        items = wt.rows_for(self.rows(300, -6.0), 240)
        pairs = wt.walk_forward(items, 240)
        first_predicted = min(it[0] for it, _ in pairs)
        self.assertGreater(first_predicted, items[0][0])
        self.assertLessEqual(len(pairs), len(items) - len(items) // wt.BLOCKS)

    def test_few_photos_are_inconclusive(self):
        self.assertEqual(wt.evaluate(self.rows(40, -6.0), 240)["verdict"], "INCONCLUSO")

    def test_weighted_lean_is_bounded(self):
        w = [1.0, -2.0, 0.5, 0.0, 3.0, 1.0]
        self.assertLessEqual(abs(wt.weighted_lean([2.0] * 8, w)), 1.0)
        self.assertEqual(len(VOTING), len(w))


if __name__ == "__main__":
    unittest.main()
