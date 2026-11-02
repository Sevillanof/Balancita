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


# ---- fase 2: puntajes de pronostico, posicionamiento y noticias (DDL copiado de futures_forecast_scores.py, positioning-collector/store.ts
# y futures_news.py, sin triggers ni indices) ----
DDL.update({
    "forecasts": """CREATE TABLE paper_futures_forecasts(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
        side TEXT NOT NULL, regime TEXT NOT NULL, utc_hour INTEGER NOT NULL,
        knowledge_lag_ms INTEGER, backfill INTEGER NOT NULL, entry_price TEXT NOT NULL,
        proposed_stop TEXT, proposed_target TEXT, signal_key TEXT,
        verdict_hash TEXT NOT NULL, written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start, source, strategy_id)) STRICT""",
    "forecast_returns": """CREATE TABLE paper_futures_forecast_returns(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
        horizon_min INTEGER NOT NULL, gross_bp TEXT NOT NULL, net_bp TEXT NOT NULL,
        exit_bucket_start INTEGER NOT NULL, written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start, source, strategy_id, horizon_min)) STRICT""",
    "forecast_barriers": """CREATE TABLE paper_futures_forecast_barriers(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
        outcome TEXT NOT NULL, ambiguous INTEGER NOT NULL, hit_after_ms INTEGER, written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start, source, strategy_id)) STRICT""",
    "forecast_excursions": """CREATE TABLE paper_futures_forecast_excursions(
        product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
        window_min INTEGER NOT NULL, mfe_bp TEXT NOT NULL, mae_bp TEXT NOT NULL, written_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, bucket_start, source, strategy_id)) STRICT""",
    "positioning": """CREATE TABLE positioning(
        product_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
        long_percent REAL, long_count INTEGER, short_count INTEGER,
        top_long_percent REAL, top_long_count INTEGER, top_short_count INTEGER, top_open_interest REAL,
        PRIMARY KEY(product_id, bucket_ms)) WITHOUT ROWID, STRICT""",
    "premium": """CREATE TABLE premium(
        product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_ms INTEGER NOT NULL,
        mark REAL NOT NULL, spot REAL NOT NULL, premium_bp REAL NOT NULL,
        PRIMARY KEY(product_id, interval_ms, bucket_ms)) WITHOUT ROWID, STRICT""",
    "news_items": """CREATE TABLE paper_futures_news_items(
        item_id INTEGER PRIMARY KEY, item_hash TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL,
        published_at INTEGER, received_at INTEGER NOT NULL, content_hash TEXT NOT NULL) STRICT""",
    "news_analysis": """CREATE TABLE paper_futures_news_analysis(
        analysis_id INTEGER PRIMARY KEY,
        item_hash TEXT NOT NULL, question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
        status TEXT NOT NULL, analyzed_at INTEGER NOT NULL,
        question_type TEXT, model_ref TEXT, model_info_json TEXT, prompt_hash TEXT, prompt_version INTEGER,
        probability_source TEXT, top_logprobs_json TEXT, probabilities_json TEXT, temperature REAL,
        chosen TEXT, value REAL, confidence REAL, latency_ms INTEGER, timings_json TEXT,
        UNIQUE(item_hash, question_id, question_version)) STRICT""",
})
TABLAS_FASE2 = ("forecasts", "forecast_returns", "forecast_barriers", "forecast_excursions", "positioning", "premium", "news_items",
                "news_analysis")


def crear_copia_fase2(ruta: str, dia0_ms: int, dias: int, productos: Sequence[str] = ("PF_XBTUSD", "PF_ETHUSD"), paso_ms: int = 10 * MINUTO,
                      tablas: Sequence[str] = TABLAS_FASE2, semilla: int = 11) -> dict:
    """SQLite sintetica con las tablas de la fase 2 durante ``dias`` dias desde ``dia0_ms``. Devuelve filas por tabla."""
    rng = random.Random(semilla)
    con = sqlite3.connect(ruta)
    n = {t: 0 for t in tablas}
    try:
        for t in tablas:
            con.execute(DDL[t])
        item_id = 0
        for b in range(dia0_ms, dia0_ms + dias * DAY_MS, paso_ms):
            for p in productos:
                for estr in ("trend", "carry"):
                    h = "h-%s-%d" % (p, b)
                    if "forecasts" in tablas:
                        con.execute("INSERT INTO paper_futures_forecasts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (p, b, "live", estr, rng.choice(("LONG", "SHORT")), "range", (b // 3_600_000) % 24, None if b % 3 else 1500, 0,
                                     "%.2f" % rng.uniform(100, 200), None if b % 2 else "99.5", None, None, h, b + 4000))
                        n["forecasts"] += 1
                    if "forecast_returns" in tablas:
                        for hz in (5, 60):
                            con.execute("INSERT INTO paper_futures_forecast_returns VALUES(?,?,?,?,?,?,?,?,?)",
                                        (p, b, "live", estr, hz, "%.3f" % rng.uniform(-9, 9), "%.3f" % rng.uniform(-9, 9), b + hz * MINUTO,
                                         b + hz * MINUTO + 5000))
                            n["forecast_returns"] += 1
                    if "forecast_barriers" in tablas:
                        con.execute("INSERT INTO paper_futures_forecast_barriers VALUES(?,?,?,?,?,?,?,?)",
                                    (p, b, "live", estr, rng.choice(("target", "stop", "none")), 0, None if b % 2 else 90_000, b + 7_200_000))
                        n["forecast_barriers"] += 1
                    if "forecast_excursions" in tablas:
                        con.execute("INSERT INTO paper_futures_forecast_excursions VALUES(?,?,?,?,?,?,?,?)",
                                    (p, b, "live", estr, 60, "%.3f" % rng.uniform(0, 20), "%.3f" % rng.uniform(-20, 0), b + 3_700_000))
                        n["forecast_excursions"] += 1
                if "positioning" in tablas:
                    con.execute("INSERT INTO positioning VALUES(?,?,?,?,?,?,?,?,?)",
                                (p, b, None if b % 7 == 0 else rng.uniform(30, 70), 10, 8, rng.uniform(30, 70), 3, 2, rng.uniform(1e5, 1e6)))
                    n["positioning"] += 1
                if "premium" in tablas:
                    con.execute("INSERT INTO premium VALUES(?,?,?,?,?,?)", (p, paso_ms, b, 100.5, 100.0, rng.uniform(-5, 5)))
                    n["premium"] += 1
            if "news_items" in tablas or "news_analysis" in tablas:
                item_id += 1
                ih = "news-%d" % item_id
                if "news_items" in tablas:
                    con.execute("INSERT INTO paper_futures_news_items VALUES(?,?,?,?,?,?,?,?,?,?)",
                                (item_id, ih, "coindesk", "CoinDesk", "https://example.test/%d" % item_id, "titular %d" % item_id,
                                 "resumen " * 30, None if item_id % 4 == 0 else b - 60_000, b, "c-%s" % ih))
                    n["news_items"] += 1
                if "news_analysis" in tablas:
                    hecho = item_id % 5 != 0
                    con.execute("INSERT INTO paper_futures_news_analysis VALUES(%s)" % ",".join("?" * 20),
                                (item_id, ih, "q-news", 1, "done" if hecho else "skipped_stale", b + 30_000,
                                 "direction" if hecho else None, "synthetic-model" if hecho else None, "{}" if hecho else None, "ph" if hecho else None,
                                 1 if hecho else None, "logprobs" if hecho else None, "[]" if hecho else None, "{}" if hecho else None,
                                 0.0 if hecho else None, "UP" if hecho else None, None, 0.7 if hecho else None, 100 if hecho else None, None))
                    n["news_analysis"] += 1
        con.commit()
    finally:
        con.close()
    return n
