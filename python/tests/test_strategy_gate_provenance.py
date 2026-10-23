"""Bounded producer provenance; synthetic records and disposable directories only."""
import copy
import json
import os
import tempfile
import unittest
from decimal import Decimal
from unittest.mock import patch

from balancita_engine import strategy_gate as g
from balancita_engine import strategy_gate_provenance as p
from balancita_engine import futures_costs
from balancita_engine.futures_strategy_gate_api import GateApi
from test_strategy_gate import CFG, FROM, MINUTE, ONES, FIVES, SPECS, Provider, cheating_source, run


class IdentityTests(unittest.TestCase):
    def test_canonical_key_order_numbers_and_record_order(self):
        self.assertEqual(p.digest({"b": Decimal("1.00"), "a": -0.0}),
                         p.digest({"a": 0.0, "b": Decimal("1")}))
        rows = [{"bucket_start": 1, "close": "1.00"}, {"bucket_start": 2, "close": "2"}]
        a = p.record_digest(rows, "candles")
        self.assertEqual(a, p.record_digest([dict(reversed(list(r.items()))) for r in rows], "candles"))
        self.assertNotEqual(a["sha256"], p.record_digest(list(reversed(rows)), "candles")["sha256"])
        self.assertEqual((a["count"], a["first_ms"], a["last_ms"]), (2, 1, 2))
        self.assertEqual(a["representation"], "parsed_records_in_consumption_order.v1")
        with self.assertRaises(ValueError):
            p.digest(float("nan"))

    def test_cost_content_changes_without_a_version_change(self):
        before = p.cost_identity([("PF_XBTUSD", "0.5")], True)
        with patch.object(futures_costs, "TAKER_RATE", "0.0006"):
            after = p.cost_identity([("PF_XBTUSD", "0.5")], True)
        self.assertEqual(before["value"]["version"], after["value"]["version"])
        self.assertNotEqual(before["sha256"], after["sha256"])
        self.assertNotEqual(before["value"]["model_sha256"], after["value"]["model_sha256"])

    def test_engine_bytes_not_head_and_missing_source_is_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "engine.py")
            with open(path, "w") as handle:
                handle.write("first")
            before = p.engine_identity(directory, ("engine.py",))
            with open(path, "w") as handle:
                handle.write("dirty")
            self.assertNotEqual(before["sha256"], p.engine_identity(directory, ("engine.py",))["sha256"])
            missing = p.engine_identity(directory, ("missing.py",))
            self.assertIsNone(missing["files"]["missing.py"])
            self.assertEqual(missing["state"], "partial")
            self.assertNotIn(directory, json.dumps(before))

    def job(self, **changes):
        ones = [dict(c) for c in ONES if FROM - 10 * MINUTE <= c["bucket_start"] < FROM + 10 * MINUTE]
        fives = [dict(c) for c in FIVES if FROM - 10 * MINUTE <= c["bucket_start"] < FROM + 10 * MINUTE]
        job = dict(index=0, label="base", spec=SPECS["c27-breakout-perp-v1"], product="PF_XBTUSD", tick="0.5",
                   start_ms=FROM, end_ms=FROM + 10 * MINUTE, provider=Provider(ones, fives),
                   funding=[(FROM - 3_600_000, "0.00001")], trade_source=None, want_closes=True, trace=True)
        job.update(changes)
        return job

    def test_actual_candles_warmup_funding_and_source_scope(self):
        job = self.job()
        first = g.simulate_task(job)["input_provenance"]
        self.assertEqual(first, g.simulate_task(job)["input_provenance"])
        self.assertEqual(first["scope"], "book_inputs")
        self.assertLess(first["records"]["candles_1m"]["first_ms"], FROM)
        changed = self.job(funding=[(FROM - 3_600_000, "0.00002")])
        self.assertNotEqual(first["records"]["funding"]["sha256"],
                            g.simulate_task(changed)["input_provenance"]["records"]["funding"]["sha256"])
        changed = self.job()
        changed["provider"].ones[0]["close"] = "50001"
        self.assertNotEqual(first["records"]["candles_1m"]["sha256"],
                            g.simulate_task(changed)["input_provenance"]["records"]["candles_1m"]["sha256"])
        limited = g.simulate_task(self.job(trade_source=lambda *args: ([], 0)))["input_provenance"]
        self.assertEqual(limited["scope"], "observed_trades_only")
        self.assertNotIn("candles_5m", limited["records"])
        self.assertIn("observed_trades", limited["records"])
        self.assertFalse(limited["decision_inputs_captured"])
        self.assertEqual(g.simulate_task(self.job(funding=[]))["input_provenance"]["state"], "partial")


class ProducerTests(unittest.TestCase):
    def test_initial_final_trace_artifact_api_and_report_agree(self):
        initial = []
        with tempfile.TemporaryDirectory() as directory:
            def progress(event):
                if not initial:
                    initial.append(GateApi(None, data_dir=directory).run(str(event["run_id"]))["run"])
            out = run("c27-breakout-perp-v1", directory, to_date="2025-01-10", on_progress=progress)
            api = GateApi(None, data_dir=directory)
            public = api.run(str(out["run_id"]))["run"]
            visual = api.visual_summary(str(out["run_id"]))
            provenance = out["provenance"]
            self.assertEqual(initial[0]["provenance"]["state"], "pending")
            self.assertEqual(initial[0]["audit"]["state"], "pending")
            self.assertEqual(provenance, out["result"]["provenance"])
            self.assertEqual(public["provenance"], provenance)
            self.assertEqual(visual["summary"]["provenance"], provenance)
            self.assertEqual(public["audit"], visual["summary"]["audit"])
            self.assertEqual(public["audit"]["artifact_state"], "available")
            self.assertFalse(public["audit"]["independently_verified"])
            folder = os.path.join(directory, "artifacts", str(out["run_id"]))
            from balancita_engine.gate_trace import read_trace, TRACE_FILE
            summaries = [r for r in read_trace(os.path.join(folder, TRACE_FILE)) if r["type"] == "summary"]
            self.assertEqual(summaries[0]["input_provenance"], provenance["inputs"][0])
            self.assertIn("Procedencia y artefactos", api.report(str(out["run_id"]))[1].decode())
            self.assertEqual(p.stored(provenance), provenance)

    def test_config_seed_spec_product_and_trials_bind_evaluation(self):
        base = dict(cfg=CFG, spec_sha256="a" * 64, kind="practice", start_ms=FROM,
                    end_ms=FROM + 10 * MINUTE, product_list=[("PF_XBTUSD", "0.5")],
                    family="x", gate_attempts=1, lab_variants=0, neighbors=False, book=True)
        first = p.start(**base)
        for key, value in (("kind", "exam"), ("gate_attempts", 2), ("family", "y"),
                           ("spec_sha256", "b" * 64), ("product_list", [("PF_XBTUSD", "1")])):
            with self.subTest(key=key):
                self.assertNotEqual(first["sha256"], p.start(**dict(base, **{key: value}))["sha256"])
        for key in ("seed", "random_draws"):
            cfg = dict(CFG, **{key: CFG[key] + 1})
            self.assertNotEqual(first["evaluation"]["sha256"], p.start(**dict(base, cfg=cfg))["evaluation"]["sha256"])

    def test_write_failure_keeps_pasa_and_numeric_statistics_but_no_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(g, "write_artifact", side_effect=OSError("injected write failure")):
                out = run(directory=directory, trade_source=cheating_source)
            self.assertEqual(out["verdict"], "PASA")
            self.assertGreater(out["result"]["overall"]["mean_bp"], 0)
            public = GateApi(None, data_dir=directory).run(str(out["run_id"]))["run"]
            self.assertEqual(public["audit"]["state"], "unavailable")
            self.assertEqual(public["audit"]["artifact_state"], "unavailable")
            self.assertFalse(public["audit"]["evidence_ready"])
            self.assertEqual(public["provenance"]["inputs"][0]["scope"], "observed_trades_only")
            self.assertIsNone(public["provenance"]["costs"]["value"]["evaluated_trade_costs"])
            self.assertIn("artifact_write_failed", public["audit"]["reasons"])

    def test_legacy_corrupt_and_inconsistent_saved_metadata_are_unknown(self):
        base = p.start(CFG, "a" * 64, "practice", FROM, FROM + MINUTE,
                       [("PF_XBTUSD", "0.5")], "x", 1, 0, False, True)
        for bad in (None, {}, "old", dict(base, state="complete"), dict(base, sha256="0" * 64)):
            self.assertEqual(p.stored(bad)["state"], "unknown")
        for field in ("evaluation", "costs"):
            bad = copy.deepcopy(base)
            bad[field]["sha256"] = "1" * 64
            bad["sha256"] = p.digest({k: v for k, v in bad.items() if k != "sha256"})
            self.assertEqual(p.stored(bad)["state"], "unknown")
        self.assertEqual(p.stored(base), base)

    def test_old_runs_without_audit_or_provenance_stay_valid_and_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            out = run("c27-breakout-perp-v1", directory, to_date="2025-01-10")
            api = GateApi(None, data_dir=directory)
            listed = GateApi._public(api._query("SELECT * FROM runs WHERE id=?", (out["run_id"],))[0])
            self.assertEqual(listed["audit"]["artifact_state"], "available")
            # Simulate a pre-T4 row: params without provenance/audit.
            row = {"id": 1, "status": "complete", "params": json.dumps({"evaluation_policy": None}), "pid": None}
            public = GateApi._public(row)
            self.assertEqual(public["provenance"]["state"], "unknown")
            self.assertEqual(public["audit"]["state"], "unknown")
            self.assertFalse(public["audit"]["evidence_ready"])


if __name__ == "__main__":
    unittest.main()
