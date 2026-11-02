"""Datos SINTETICOS con el esquema real (copiado de la captura) para pruebas y para ``medir``. No lee ninguna base real."""
from __future__ import annotations

import hashlib
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


# ---- formato 2: veredictos con la forma real del payload, funding_responses y candle_revisions (DDL copiado de futures-market-store.ts) ----
ESTRATEGIAS = ("trend_follow", "mean_revert", "breakout", "carry", "flow", "range_fade")
MARCOS = ("1m", "1m_previous", "5m")
NOMBRES_FEATURES = tuple("%s_%s" % (a, b) for a in ("ema", "rsi", "atr", "adx", "vwap", "obv", "macd", "boll", "stoch", "cci", "roc", "mfi",
                                                       "willr", "keltner", "donchian", "trix", "cmf", "ppo")
                         for b in ("5", "9", "14", "21", "50"))  # 90 por marco, como los features reales


class _EstadoVeredictos:
    """Series suaves por producto (como los indicadores reales: minuto a minuto casi iguales) para que el payload se parezca al de verdad."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.nivel = {}
        self.previa = {}

    def payload(self, producto: str, bucket: int, accion: str, razon: str) -> str:
        r = self.rng
        n = self.nivel.setdefault(producto, [r.uniform(-2, 2) for _ in NOMBRES_FEATURES])
        for i in range(len(n)):
            n[i] += r.gauss(0, 0.01)
        uno = {k: round(v, 6) for k, v in zip(NOMBRES_FEATURES, n)}
        uno["candidate_bucket_start_ms"] = bucket
        cinco = {k: round(v * 1.1, 6) for k, v in zip(NOMBRES_FEATURES, n)}
        previa = self.previa.get(producto, uno)
        self.previa[producto] = uno
        propuestas = [{"strategy_id": e, "action": r.choice(ACCIONES), "reason_code": r.choice(RAZONES), "entry": "%.2f" % (100 + n[0]),
                       "stop": "%.2f" % (99 + n[1]), "target": "%.2f" % (101 + n[2]), "expected_net_bp": round(r.uniform(-5, 9), 4),
                       "notes": ["risk_cap ok", "funding ok"]} for e in ESTRATEGIAS]
        elegida = {"strategy_id": r.choice(ESTRATEGIAS), "action": accion, "reason_code": razon}
        return json.dumps({
            "schema_version": "futures-verdict.v1", "config_hash": "c" * 64, "product_id": producto, "interval_ms": MINUTO,
            "bucket_start_ms": bucket, "close_at_ms": bucket + MINUTO, "decision_known_at_ms": bucket + MINUTO + 3000,
            "knowledge_lag_ms": 3000, "previous_regime": r.choice(("range", "trend_up")), "regime": "range", "action": accion, "reason_code": razon,
            "selected": elegida, "proposals": propuestas, "features": {"1m": uno, "1m_previous": previa, "5m": cinco},
            "inputs": {"1m": hashlib.sha256(("1m%d" % bucket).encode()).hexdigest(), "5m": hashlib.sha256(("5m%d" % bucket).encode()).hexdigest()},
            "verdict_hash": hashlib.sha256(("%s%d" % (producto, bucket)).encode()).hexdigest()})


def crear_copia_veredictos(ruta: str, dia0_ms: int, dias: int, productos: Sequence[str] = ("PF_XBTUSD", "PF_ETHUSD"), paso_ms: int = MINUTO,
                           semilla: int = 7) -> int:
    """Veredictos con payload de ~8-11 KB y la forma real (selected, proposals, features por marco). Devuelve las filas."""
    rng = random.Random(semilla)
    est = _EstadoVeredictos(rng)
    con = sqlite3.connect(ruta)
    total = 0
    try:
        con.execute(DDL["verdicts"])
        for d in range(dias):
            filas = []
            for p in productos:
                for b in range(dia0_ms + d * DAY_MS, dia0_ms + (d + 1) * DAY_MS, paso_ms):
                    a, z = rng.choice(ACCIONES), rng.choice(RAZONES)
                    pl = est.payload(p, b, a, z)
                    filas.append((p, b, MINUTO, b + MINUTO + 3000, "range", a, z, hashlib.sha256(pl.encode()).hexdigest(), pl, b + MINUTO + 4000))
            con.executemany("INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)", filas)
            total += len(filas)
        con.commit()
    finally:
        con.close()
    return total


DDL.update({
    "funding_responses": """CREATE TABLE paper_futures_funding_responses(
        sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL, raw_response TEXT NOT NULL
      ) STRICT""",
    "candle_revisions": """CREATE TABLE paper_futures_candle_revisions (
        candle_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        revision INTEGER NOT NULL, known_at INTEGER NOT NULL, close_at INTEGER,
        is_closed INTEGER NOT NULL, coverage TEXT NOT NULL, open_price TEXT NOT NULL,
        high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
        volume_btc TEXT NOT NULL, trade_count INTEGER NOT NULL, source_hash TEXT NOT NULL,
        PRIMARY KEY(candle_id, revision)
      ) STRICT""",
})
TRIGGERS_FUNDING = ("""CREATE TRIGGER paper_futures_funding_responses_no_update BEFORE UPDATE ON paper_futures_funding_responses
        BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END""",
                    """CREATE TRIGGER paper_futures_funding_responses_no_delete BEFORE DELETE ON paper_futures_funding_responses
        BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END""")


def crear_copia_funding(ruta: str, dia0_ms: int, dias: int, por_dia: int = 24, periodos: int = 8760, semilla: int = 5) -> int:
    """Una respuesta por hora de ~1 MB (el ano de funding): cada una es la anterior con un periodo nuevo al final y el mas viejo fuera."""
    rng = random.Random(semilla)
    con = sqlite3.connect(ruta)
    paso = 3_600_000
    ts0 = dia0_ms - periodos * paso
    cola = [(ts0 + i * paso, "%.12f" % rng.gauss(0, 3e-5), "%.12f" % rng.gauss(0, 1e-4)) for i in range(periodos)]
    total = 0
    try:
        con.execute(DDL["funding_responses"])
        for t in TRIGGERS_FUNDING:
            con.execute(t)
        for k in range(dias * por_dia):
            recibido = dia0_ms + k * (DAY_MS // por_dia) + 2_000
            cola.append((cola[-1][0] + paso, "%.12f" % rng.gauss(0, 3e-5), "%.12f" % rng.gauss(0, 1e-4)))
            cola.pop(0)
            cuerpo = json.dumps({"result": "success", "serverTime": "synthetic", "rates": [
                {"timestamp": dt_iso(t), "fundingRate": a, "relativeFundingRate": b} for t, a, b in cola]})
            con.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)",
                        (hashlib.sha256(cuerpo.encode()).hexdigest(), recibido, dt_iso(recibido), cuerpo))
            total += 1
        con.commit()
    finally:
        con.close()
    return total


def dt_iso(ms: int) -> str:
    import datetime as _dt
    return _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def crear_copia_velas(ruta: str, dia0_ms: int, dias: int, productos: Sequence[str] = ("PF_XBTUSD",), revisiones: int = 30, semilla: int = 9) -> int:
    """Revisiones de velas de 1 minuto (una por trade): ``revisiones`` por vela (en produccion ~175 en velas activas)."""
    rng = random.Random(semilla)
    con = sqlite3.connect(ruta)
    total = 0
    try:
        con.execute(DDL["candle_revisions"])
        con.execute("""CREATE TRIGGER paper_futures_candle_revisions_no_update BEFORE UPDATE ON paper_futures_candle_revisions
            BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END""")
        precio = {p: 60_000.0 + 100 * i for i, p in enumerate(productos)}
        for d in range(dias):
            filas = []
            for p in productos:
                for b in range(dia0_ms + d * DAY_MS, dia0_ms + (d + 1) * DAY_MS, MINUTO):
                    abre = precio[p]
                    alto = bajo = cierre = abre
                    vol = 0.0
                    for rev in range(1, revisiones + 1):
                        cierre = round(cierre + rng.gauss(0, 0.8), 1)
                        alto, bajo = max(alto, cierre), min(bajo, cierre)
                        vol += rng.uniform(0.001, 0.2)
                        cerrada = rev == revisiones
                        filas.append(("%s:%d:%d" % (p, MINUTO, b), MINUTO, b, rev, b + 1000 + rev * (50_000 // revisiones), b + MINUTO if cerrada else None,
                                      1 if cerrada else 0, "trades", "%.1f" % abre, "%.1f" % alto, "%.1f" % bajo, "%.1f" % cierre, "%.4f" % vol, rev,
                                      hashlib.sha256(("%s%d%d" % (p, b, rev)).encode()).hexdigest()))
                    precio[p] = cierre
            con.executemany("INSERT INTO paper_futures_candle_revisions VALUES(%s)" % ",".join("?" * 15), filas)
            total += len(filas)
        con.commit()
    finally:
        con.close()
    return total
