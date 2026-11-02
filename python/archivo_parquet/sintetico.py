"""Datos SINTETICOS con el esquema real (copiado de la captura) para pruebas y para ``medir``. No lee ninguna base real."""
from __future__ import annotations

import json
import random
import sqlite3
from typing import Sequence

from .config import DAY_MS

DDL = {
    "verdicts": """CREATE TABLE paper_futures_verdicts(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
        decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
        action TEXT NOT NULL, reason_code TEXT NOT NULL,
        verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start)) STRICT""",
    "llm_decisions": """CREATE TABLE paper_futures_llm_decisions(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL,
        question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
        verdict_hash TEXT NOT NULL, question_type TEXT NOT NULL,
        model_ref TEXT NOT NULL, model_info_json TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, prompt_version INTEGER NOT NULL,
        probability_source TEXT NOT NULL, state_text TEXT NOT NULL,
        top_logprobs_json TEXT NOT NULL, probabilities_json TEXT NOT NULL,
        temperature REAL NOT NULL, chosen TEXT NOT NULL, value REAL,
        confidence REAL NOT NULL, latency_ms INTEGER NOT NULL, timings_json TEXT NOT NULL,
        written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start, question_id, question_version)) STRICT""",
    "market_events": """CREATE TABLE paper_futures_market_events (
        event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
        epoch INTEGER NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL,
        received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
        raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL
      ) STRICT""",
}
ACCIONES = ("HOLD", "LONG", "SHORT", "EXIT")
RAZONES = ("no_edge", "trend_up", "trend_down", "funding_block", "risk_cap")
MINUTO = 60_000


def _payload(rng: random.Random, producto: str, bucket: int) -> str:
    return json.dumps({"product": producto, "bucket": bucket, "features": [round(rng.uniform(-3, 3), 6) for _ in range(24)],
                       "scores": {k: round(rng.random(), 5) for k in ("trend", "carry", "flow", "risk")}, "note": "synthetic"})


def crear_copia(ruta: str, dia0_ms: int, dias: int, productos: Sequence[str] = ("PF_XBTUSD", "PF_ETHUSD"), paso_ms: int = MINUTO,
                tablas: Sequence[str] = ("verdicts",), semilla: int = 7) -> int:
    """Crea una SQLite sintetica con ``dias`` dias desde ``dia0_ms`` (inicio de un dia UTC). Devuelve el total de filas."""
    rng = random.Random(semilla)
    con = sqlite3.connect(ruta)
    total = 0
    try:
        for t in tablas:
            con.execute(DDL[t])
        for d in range(dias):
            for p in productos:
                v, q, m = [], [], []
                for b in range(dia0_ms + d * DAY_MS, dia0_ms + (d + 1) * DAY_MS, paso_ms):
                    h = "h-%s-%d" % (p, b)
                    a = rng.choice(ACCIONES)
                    v.append((p, b, MINUTO, b + MINUTO + 3000, "range", a, rng.choice(RAZONES), h, _payload(rng, p, b), b + MINUTO + 4000))
                    q.append((p, b, "q-entry", 1, h, "direction", "synthetic-model", "{}", "ph", 1, "logprobs", "state " * 20, "[]", "{}", 0.0,
                              rng.choice(("LONG", "SHORT")), None if b % 3 else 0.5, rng.random(), 120, "{}", b + MINUTO + 5000))
                    m.append(("ev-%s-%d" % (p, b), "ticker", p, 1, b, b, b + 1, b + 2, None, "{}", _payload(rng, p, b), h))
                if "verdicts" in tablas:
                    con.executemany("INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)", v)
                    total += len(v)
                if "llm_decisions" in tablas:
                    con.executemany("INSERT INTO paper_futures_llm_decisions VALUES(%s)" % ",".join("?" * 21), q)
                    total += len(q)
                if "market_events" in tablas:
                    con.executemany("INSERT INTO paper_futures_market_events VALUES(%s)" % ",".join("?" * 12), m)
                    total += len(m)
        con.commit()
    finally:
        con.close()
    return total
