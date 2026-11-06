"""Estrategias del laboratorio: snapshot de la Terminal activa + overlays inmutables de perillas. Sin red ni bases."""
import copy
import json
import os
import tempfile
import unittest

from balancita_engine import futures_estrategias as est
from balancita_engine import futures_qwen_trader as qt

ACTIVE_HASH = "37f572a8"


def write(folder, name, doc):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(doc, handle)
    return path


class EstrategiasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = self.tmp.name
        self.snapshot = est.cargar_snapshot()
        self.base_hash = self.snapshot["config_hash"]

    def overlay(self, cambios, id="prueba", **extra):
        doc = {"id": id, "nombre": "Prueba", "descripcion": "Variante de prueba.",
               "base_config_hash": self.base_hash, "cambios": cambios}
        doc.update(extra)
        write(self.folder, id + ".json", doc)
        return id

    def load(self, id):
        return est.cargar_estrategia(id, carpeta=self.folder)

    # ---- S1: snapshot

    def test_snapshot_verifies_with_the_trader_hash_and_comes_from_the_last_activated_version(self):
        snap = est.cargar_snapshot()
        self.assertEqual(qt.config_hash(snap["config"]), snap["config_hash"])
        self.assertTrue(snap["config_hash"].startswith(ACTIVE_HASH))
        self.assertEqual(snap["origen"]["version_id"], 3)
        self.assertEqual(snap["origen"]["activada_utc"], "2026-11-02T14:15:54.811Z")
        self.assertEqual(est.hash_config(snap["config"]), snap["config_hash"])

    def test_snapshot_returned_is_a_copy(self):
        snap = est.cargar_snapshot()
        snap["config"]["guardrails"]["max_hold_min"] = 1
        self.assertEqual(est.cargar_snapshot()["config"]["guardrails"]["max_hold_min"], 2160)

    def test_tampered_snapshot_fails_loudly(self):
        doc = copy.deepcopy(self.snapshot)
        doc["config"]["guardrails"]["max_hold_min"] = 1
        path = write(self.folder, "terminal-activa.json", doc)
        with self.assertRaises(est.EstrategiaError) as caught:
            est.cargar_snapshot(path)
        self.assertIn("no coincide con su hash", str(caught.exception))

    def test_snapshot_with_unknown_schema_is_rejected(self):
        doc = copy.deepcopy(self.snapshot)
        doc["schema"] = "otro"
        with self.assertRaises(est.EstrategiaError) as caught:
            est.cargar_snapshot(write(self.folder, "terminal-activa.json", doc))
        self.assertIn("esquema", str(caught.exception))

    # ---- S2: overlays

    def test_allowed_knobs_apply_change_the_hash_and_leave_the_rest_untouched(self):
        cambios = {"guardrails": {"max_hold_min": 1800, "cooldown_min": 30, "stop_sigma_24h": 2.0},
                   "wake": {"position_every_min": 5}, "posiciones": {"max": 2, "fraccion": 0.5},
                   "rebotes": {"caida_pct": 4.0, "salida_min": 120}, "analista": {"modo": "suave"}}
        cfg = self.load(self.overlay(cambios))
        base = self.snapshot["config"]
        self.assertEqual(cfg["guardrails"], dict(base["guardrails"], max_hold_min=1800, cooldown_min=30, stop_sigma_24h=2.0))
        self.assertEqual(cfg["wake"], dict(base["wake"], position_every_min=5))
        self.assertEqual(cfg["posiciones"], {"espera_entre_entradas_min": 0, "fraccion": 0.5, "max": 2})
        self.assertEqual(cfg["rebotes"], dict(base["rebotes"], caida_pct=4.0, salida_min=120))
        self.assertEqual(cfg["analista"], {"modo": "suave"})
        for untouched in ("corta", "products", "notional_usd", "cuenta", "execution", "funding_model", "noticias"):
            self.assertEqual(cfg[untouched], base[untouched])
        self.assertNotEqual(est.hash_config(cfg), self.base_hash)
        self.assertEqual(est.hash_config(cfg), qt.config_hash(cfg))
        self.assertEqual(self.snapshot, est.cargar_snapshot())            # the base file is never modified

    def test_each_single_knob_change_produces_a_different_hash(self):
        seen = {self.base_hash}
        for cambios in ({"guardrails": {"exhaust_hold_min": 720}}, {"guardrails": {"max_hold_min": 1440}},
                        {"wake": {"flat_every_min": 60}}, {"rebotes": {"enfriamiento_min": 60}},
                        {"posiciones": {"espera_entre_entradas_min": 30}}):
            digest = est.hash_config(self.load(self.overlay(cambios)))
            self.assertNotIn(digest, seen)
            seen.add(digest)

    def test_overlay_that_changes_nothing_keeps_the_base_hash(self):
        cfg = self.load(self.overlay({"guardrails": {"max_hold_min": 2160}}))
        self.assertEqual(est.hash_config(cfg), self.base_hash)

    def test_forbidden_keys_are_rejected_naming_the_key(self):
        for cambios, key in (({"corta": {"maestro": "x.json"}}, "corta.maestro"), ({"products": ["PF_XBTUSD"]}, "products"),
                             ({"notional_usd": "5000"}, "notional_usd"), ({"funding_model": "x"}, "funding_model"),
                             ({"execution": {"model": "x"}}, "execution.model"), ({"cuenta": "x"}, "cuenta"),
                             ({"guardrails": {"inventada": 1}}, "guardrails.inventada"),
                             ({"guardrails": 5}, "guardrails"), ({"exigencia": {"maestro": 7}}, "exigencia.maestro")):
            with self.subTest(key=key):
                with self.assertRaises(est.EstrategiaError) as caught:
                    self.load(self.overlay(cambios))
                self.assertIn("'{}' no se puede cambiar".format(key), str(caught.exception))
                self.assertIn("perillas permitidas", str(caught.exception))

    def test_wrong_base_hash_is_rejected(self):
        id = self.overlay({"guardrails": {"max_hold_min": 1800}}, base_config_hash="0" * 64)
        with self.assertRaises(est.EstrategiaError) as caught:
            self.load(id)
        self.assertIn("base_config_hash", str(caught.exception))
        self.assertIn(self.base_hash, str(caught.exception))

    def test_invalid_values_are_rejected_naming_the_knob(self):
        for cambios, key in (({"guardrails": {"max_hold_min": True}}, "guardrails.max_hold_min"),
                             ({"guardrails": {"max_hold_min": "1800"}}, "guardrails.max_hold_min"),
                             ({"guardrails": {"max_hold_min": 1.5}}, "guardrails.max_hold_min"),
                             ({"guardrails": {"max_hold_min": 0}}, "guardrails.max_hold_min"),
                             ({"guardrails": {"max_hold_min": 600}}, "guardrails.exhaust_hold_min"),
                             ({"guardrails": {"min_stop_pct": 0.5}}, "guardrails.min_stop_pct"),
                             ({"wake": {"flat_every_min": 7}}, "wake.flat_every_min"),
                             ({"analista": {"modo": "loco"}}, "analista.modo"),
                             ({"posiciones": {"max": 4}}, "posiciones"),
                             ({"posiciones": {"max": 3, "fraccion": 0.5}}, "posiciones.fraccion"),
                             ({"rebotes": {"caida_pct": 150}}, "rebotes.caida_pct"),
                             ({"rebotes": {"ventana_min": 62}}, "rebotes.ventana_min")):
            with self.subTest(cambios=cambios):
                with self.assertRaises(est.EstrategiaError) as caught:
                    self.load(self.overlay(cambios))
                self.assertIn(key, str(caught.exception))

    def test_malformed_overlays_are_rejected(self):
        write(self.folder, "sin-base.json", {"id": "sin-base", "nombre": "x", "descripcion": "x", "cambios": {"wake": {"flat_every_min": 30}}})
        write(self.folder, "otro-id.json", {"id": "distinto", "nombre": "x", "descripcion": "x",
                                             "base_config_hash": self.base_hash, "cambios": {"wake": {"flat_every_min": 30}}})
        write(self.folder, "vacia.json", {"id": "vacia", "nombre": "x", "descripcion": "x",
                                           "base_config_hash": self.base_hash, "cambios": {}})
        extra = self.overlay({"wake": {"flat_every_min": 30}}, id="extra", otra="x")
        for id in ("sin-base", "otro-id", "vacia", extra, "no-existe", "../fuera", "Mayusculas"):
            with self.subTest(id=id):
                with self.assertRaises(est.EstrategiaError):
                    self.load(id)

    # ---- ejemplo real del repo

    def test_example_overlay_caps_the_hold_at_30_hours(self):
        cfg = est.cargar_estrategia("ejemplo-salida-30h")
        base = self.snapshot["config"]
        self.assertEqual(cfg["guardrails"]["max_hold_min"], 1800)
        self.assertEqual(cfg["guardrails"]["exhaust_hold_min"], 1440)
        self.assertEqual({k: v for k, v in cfg.items() if k != "guardrails"}, {k: v for k, v in base.items() if k != "guardrails"})
        self.assertNotEqual(est.hash_config(cfg), self.base_hash)

    def test_every_overlay_in_the_repo_loads(self):
        for name in sorted(os.listdir(est.ESTRATEGIAS_DIR)):
            if name.endswith(".json"):
                est.cargar_estrategia(name[:-5])


if __name__ == "__main__":
    unittest.main()
