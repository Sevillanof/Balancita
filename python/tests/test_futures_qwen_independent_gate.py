import copy
import hashlib
import contextlib
import importlib.util
import io
import json
import math
import os
import random
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_qwen_corta as sheet
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG, make


class IndependentGateTests(unittest.TestCase):
    def module(self):
        from balancita_engine import futures_qwen_independent_gate
        return futures_qwen_independent_gate

    def model(self):
        gate = self.module()
        return {
            "schema": gate.SCHEMA, "features": ["ret_1h", "range24"],
            "mean": [0.0, 0.0], "sd": [1.0, 1.0], "horizon_min": 720,
            "fit_until_ms": qt.date_ms("2025-12-01"),
            "heads": {
                "LARGO": {"coef": [1.0, 0.0], "intercept": 0.0},
                "CORTO": {"coef": [-1.0, 0.0], "intercept": 0.0},
                "ESPERAR": {"coef": [0.0, 0.0], "intercept": 0.0},
            },
        }

    def test_vote_uses_only_raw_facts_and_ties_wait(self):
        gate = self.module()
        model = self.model()
        raw = {"ret_1h": 2.0, "range24": 0.04}
        before = copy.deepcopy(raw)
        with mock.patch("balancita_engine.futures_qwen_maestro.score", side_effect=AssertionError("shared prediction")):
            self.assertEqual(gate.vote(model, raw)["side"], 1)
            self.assertEqual(gate.vote(model, dict(raw, ret_1h=-2))["side"], -1)
            self.assertEqual(gate.vote(model, dict(raw, ret_1h=0))["side"], 0)
        self.assertEqual(raw, before)

    def test_missing_invalid_or_shared_prediction_features_are_refused(self):
        gate = self.module()
        for field in ("claridad", "maestro", "portero_p"):
            bad = self.model()
            bad["features"][0] = field
            with self.subTest(field=field), self.assertRaises(qt.TraderError):
                gate.validate(bad)
        model = self.model()
        invalid_facts = {"ret_1h": float("nan"), "range24": 0.04}
        with self.assertRaises(qt.TraderError):
            gate.vote(model, invalid_facts)
        with self.assertRaises(qt.TraderError):
            gate.vote(model, {"ret_1h": 0.1})
        bad = self.model()
        bad["fit_until_ms"] = qt.load_holdout_ms() + 1
        with self.assertRaises(qt.HoldoutError):
            gate.validate(bad)

    def test_model_identity_is_verified_before_reading(self):
        gate = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "independent.json")
            body = json.dumps(self.model()).encode()
            with open(path, "wb") as handle:
                handle.write(body)
            spec = {"path": path, "sha256": hashlib.sha256(body).hexdigest()}
            self.assertEqual(gate.read(spec, {"ret_1h": 2, "range24": 0.04})["side"], 1)
            fit_until = self.model()["fit_until_ms"]
            with self.assertRaises(qt.TraderError):
                gate.read(spec, {"ret_1h": 2, "range24": 0.04}, at_ms=fit_until - 1)
            self.assertEqual(
                gate.read(spec, {"ret_1h": 2, "range24": 0.04}, at_ms=fit_until)["side"], 1)
            with self.assertRaises(qt.TraderError):
                gate.read(dict(spec, sha256="0" * 64), {"ret_1h": 2, "range24": 0.04})

    def test_full_sheet_uses_the_autonomous_vote_without_legacy_keeper_predictions(self):
        model = self.model()
        model["heads"]["LARGO"]["intercept"] = 10.0
        folder = self.enterContext(tempfile.TemporaryDirectory())
        path = os.path.join(folder, "independent.json")
        body = json.dumps(model).encode()
        with open(path, "wb") as handle:
            handle.write(body)
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["corta"]["portero_autonomo"] = {"path": path, "sha256": hashlib.sha256(body).hexdigest()}
        cfg["corta"].pop("portero")
        cfg["corta"].pop("portero_hash")
        env = make(self, cfg=cfg, db=folder)
        env.op.start()
        trader = env.op.traders["PF_ETHUSD"]
        at = trader.t[-1] + qt.BAR_MS
        votes = []
        with mock.patch.object(sheet.portero, "verdict", side_effect=AssertionError("legacy prediction dependency")):
            for master_score in (10.0, -10.0):
                with mock.patch.object(sheet.maestro, "score", return_value=master_score):
                    r = sheet.readings(trader, at)
                votes.append(r["portero_autonomo"])
                self.assertEqual(r["portero_direccion"], 1)
                self.assertEqual(sheet.formula_action(r, None)[0], "LARGO" if master_score > 0 else "ESPERAR")
        self.assertEqual(votes[0], votes[1])

    def test_invalid_cutoffs_label_endpoints_and_nonfinite_targets_are_rejected(self):
        gate = self.module()
        for cutoff in (0, -1):
            invalid = dict(self.model(), fit_until_ms=cutoff)
            with self.subTest(cutoff=cutoff), self.assertRaises(qt.TraderError):
                gate.validate(invalid)
        invalid = dict(self.model(), last_label_end_ms=self.model()["fit_until_ms"])
        with self.assertRaises(qt.TraderError):
            gate.validate(invalid)
        row = dict.fromkeys(gate.FEATURES, 0.1)
        row.update(t_ms=qt.date_ms("2025-01-01"), long_net_bp=float("nan"), short_net_bp=-10.0)
        cutoff = qt.date_ms("2025-12-01")
        with self.assertRaises(qt.TraderError):
            gate.fit([row] * 1000, fit_until_ms=cutoff)
        huge = self.model()
        huge["heads"]["LARGO"]["coef"][0] = 1e308
        with self.assertRaises(qt.TraderError):
            gate.vote(huge, {"ret_1h": 1e308, "range24": 0.04})

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "el ajuste necesita numpy (la CI no lo instala; se prueba en el intérprete de entrenamiento)")
    def test_cold_fit_is_deterministic_and_does_not_read_maestro_predictions(self):
        gate = self.module()
        rng = random.Random(12)
        start = qt.date_ms("2025-10-16")
        rows = []
        for i in range(1200):
            row = {f: rng.uniform(-1, 1) for f in gate.FEATURES}
            target = row["ret_1h"]
            row.update(t_ms=start + i * 900000, long_net_bp=100 * target - 10, short_net_bp=-100 * target - 10)
            rows.append(row)
        cutoff = start + 1300 * 900000
        with mock.patch("balancita_engine.futures_qwen_maestro.score", side_effect=AssertionError("shared prediction")):
            first = gate.fit(rows, fit_until_ms=cutoff)
            second = gate.fit(rows, fit_until_ms=cutoff)
        self.assertEqual(first, second)
        self.assertTrue(first["cold_start"])
        self.assertLessEqual(first["last_label_end_ms"], cutoff)
        self.assertEqual(first["target"], "net_12h_after_costs_and_observed_funding")
        self.assertNotIn("maestro_hash", first)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "el ajuste necesita numpy (la CI no lo instala; se prueba en el intérprete de entrenamiento)")
    def test_both_experts_are_prepared_cold_with_the_same_purged_cutoff(self):
        gate = self.module()
        rng = random.Random(12)
        start = qt.date_ms("2025-10-16")
        rows = []
        for i in range(1200):
            row = {f: rng.uniform(-1, 1) for f in gate.FEATURES}
            target = 100 * row["ret_1h"]
            row.update(t_ms=start + i * 900000, product="PF_ETHUSD", move_720=target,
                       long_net_bp=target - 10, short_net_bp=-target - 10)
            rows.append(row)
        cutoff = start + 1300 * 900000
        future = dict(rows[0], t_ms=cutoff - 1, move_720=float("nan"), ret_1h=float("nan"))
        with mock.patch.object(sheet.maestro, "load", side_effect=AssertionError("old teacher weights")):
            with mock.patch.object(sheet.maestro, "score", side_effect=AssertionError("shared prediction")):
                first = gate.fit_candidates(rows + [future], fit_until_ms=cutoff)
                second = gate.fit_candidates(rows, fit_until_ms=cutoff)
        self.assertEqual(first, second)
        for name in ("maestro", "portero"):
            provenance = first[name].get("provenance", first[name])
            self.assertTrue(provenance["cold_start"])
            self.assertLess(provenance["last_label_end_ms"], cutoff)
            self.assertEqual(provenance["fit_until_ms"], cutoff)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "el ajuste necesita numpy (la CI no lo instala; se prueba en el intérprete de entrenamiento)")
    def test_cli_writes_both_new_candidates_without_activation_or_real_market_reads(self):
        gate = self.module()
        from balancita_engine import futures_walkforward as wf
        rng = random.Random(12)
        start = qt.date_ms("2025-10-16")
        cutoff = qt.date_ms("2025-11-01")
        folder = self.enterContext(tempfile.TemporaryDirectory())
        facts = os.path.join(folder, "synthetic-facts.jsonl")
        keeper_path = os.path.join(folder, "keeper-candidate.json")
        teacher_path = os.path.join(folder, "teacher-candidate.json")
        with open(facts, "w", encoding="utf-8") as handle:
            for i in range(1200):
                row = {f: rng.uniform(-1, 1) for f in gate.FEATURES}
                row.update(t_ms=start + i * 900000, product="PF_ETHUSD", move_720=100 * row["ret_1h"])
                handle.write(json.dumps(row) + "\n")
        rates = [(at, 0) for at in range(start, cutoff, qt.HOUR_MS)]
        history = mock.Mock()
        history.funding.return_value = rates
        history.bars.return_value = [
            {"bucket_start": start + i * qt.BAR_MS - qt.BAR_MS, "close": str(100 + math.sin(i / 20))}
            for i in range(1250 * 3 + 1)
        ]
        from balancita_engine import futures_qwen_funding as funding
        observed = funding.from_public("PF_ETHUSD", {
            "result": "success", "rates": [
                {"timestamp": qt.time.strftime("%Y-%m-%dT%H:00:00Z", qt.time.gmtime(at / 1000)),
                 "fundingRate": "0", "relativeFundingRate": "0"} for at, _ in rates],
        }, known_at_ms=cutoff)
        args = ["--facts", facts, "--until", "2025-11-01", "--out", keeper_path, "--maestro-out", teacher_path]
        output = io.StringIO()
        with mock.patch.object(qt, "History", return_value=history) as reader, \
                mock.patch.object(funding, "from_archive", return_value=observed):
            with mock.patch.object(wf, "register") as register, contextlib.redirect_stdout(output):
                self.assertEqual(gate.main(args), 0)
        self.assertTrue(reader.call_args.kwargs["offline"])
        register.assert_called_once()
        self.assertEqual(register.call_args.kwargs["medicion"], "vigente")
        result = json.loads(output.getvalue())
        self.assertFalse(result["activated"])
        self.assertEqual(result["funding_model"], funding.EXACT_MODEL)
        with open(teacher_path, encoding="utf-8") as handle:
            teacher = json.load(handle)
        self.assertEqual(result["maestro_hash"], sheet.maestro.teacher_hash(teacher))
        with open(keeper_path, "rb") as handle:
            original = handle.read()
        self.assertEqual(result["sha256"], hashlib.sha256(original).hexdigest())
        from balancita_engine import futures_qwen_live as live
        activation = copy.deepcopy(LIVE_CFG)
        activation.update(products=["PF_ETHUSD"], cuenta="entera", opinion_enabled=False, funding_model=funding.EXACT_MODEL)
        activation["noticias"]["policy"] = "priority_v2"
        activation["corta"].update(
            maestro=teacher_path, maestro_hash=result["maestro_hash"],
            portero_autonomo={"path": keeper_path, "sha256": result["sha256"]})
        live.validate_activation(activation, now_ms=qt.date_ms("2026-10-30"))
        with self.assertRaises(qt.TraderError):
            gate.main(args)
        with open(keeper_path, "rb") as handle:
            self.assertEqual(handle.read(), original)
        os.remove(keeper_path)
        with mock.patch.object(qt, "History", side_effect=AssertionError("must fail before reading")):
            with self.assertRaises(qt.TraderError):
                gate.main(args)


if __name__ == "__main__":
    unittest.main()
