"""Datos SINTETICOS con el esquema real (copiado de la captura) para pruebas y para ``medir``. No lee ninguna base real."""
from __future__ import annotations

import hashlib
import json
import random
import sqlite3
from typing import Optional, Sequence

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
                    # El ticker de 1 s siempre cae a menos de un minuto del fin del dia: una copia que llega al fin lo tiene.
                    fin = dia0_ms + (d + 1) * DAY_MS - 1
                    m.append(("ev-%s-fin-%d" % (p, fin), "ticker", p, 1, fin, fin - 1, fin, fin + 1, None, "{}", _payload(rng, p, fin), "h-fin-%s-%d" % (p, fin)))
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


def crear_copia_funding(ruta: str, dia0_ms: int, dias: int, por_dia: int = 24, periodos: int = 8760, semilla: int = 5,
                        delgadas_desde: Optional[int] = None) -> int:
    """Una respuesta por hora de ~1 MB (el ano de funding): cada una es la anterior con un periodo nuevo al final y el mas viejo fuera.

    ``delgadas_desde=N``: desde la respuesta N (0 = todas) la fila lleva el cuerpo corto que guarda hoy la captura
    (``fundingSlimBody`` de ``historical-funding.ts``: ``balancitaSlim``, hash y tamano del cuerpo entero, ``serverTime`` y solo el
    periodo nuevo). La clave ``sha256`` sigue siendo la del cuerpo entero. Las anteriores quedan enteras, como las filas viejas reales."""
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
            literales = [json.dumps({"timestamp": dt_iso(t), "fundingRate": a, "relativeFundingRate": b}) for t, a, b in cola]
            cuerpo = json.dumps({"result": "success", "serverTime": "synthetic", "rates": [json.loads(x) for x in literales]})
            sha = hashlib.sha256(cuerpo.encode()).hexdigest()
            if delgadas_desde is not None and k >= delgadas_desde:
                cuerpo_fila = '{"balancitaSlim":true,"fullSha256":"%s","fullBytes":%d,"serverTime":"synthetic","rates":[%s]}' % (
                    sha, len(cuerpo.encode()), literales[-1])
            else:
                cuerpo_fila = cuerpo
            con.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, recibido, dt_iso(recibido), cuerpo_fila))
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


# ---- datos-utiles: la base del trader en vivo (qwen-live), su auditor y tres tablas mas de futures-market. DDL copiado de
# futures_qwen_live.py (``_SCHEMA_SQL`` + ``_ADDED_COLUMNS``), futures_auditor.py y futures-market-store.ts, sin triggers salvo los de los recibos. ----
BUCKET_15M = 15 * MINUTO
DDL.update({
    "qwen_decisions": """CREATE TABLE decisions(
        product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, decided_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL, action TEXT NOT NULL, model_action TEXT, p_action REAL, confidence REAL, probs_json TEXT,
        orders_json TEXT, override TEXT, reason TEXT, reason_json TEXT, mirror_action TEXT, mirror_p REAL, wake_json TEXT,
        state_text TEXT, state_hash TEXT, latency_ms INTEGER, threshold REAL, prompt_version TEXT, prompt_hash TEXT, model TEXT,
        config_hash TEXT, position_json TEXT, net_bp_now REAL, trade_no INTEGER,
        lean REAL, lean_m REAL, lean_num REAL, score REAL, best_score REAL, look_n INTEGER, mirror_ok INTEGER, factors_json TEXT,
        formula_action TEXT, formula_json TEXT, opinion_agrees INTEGER, opinion_error TEXT,
        PRIMARY KEY(product, bucket_ms))""",
    "qwen_trades": """CREATE TABLE trades(
        product TEXT NOT NULL, trade_no INTEGER NOT NULL, status TEXT NOT NULL, side TEXT NOT NULL, entry_ms INTEGER NOT NULL,
        exit_ms INTEGER, entry_px TEXT, exit_px TEXT, qty TEXT, notional_usd TEXT, gross_usd TEXT, fees_usd TEXT,
        funding_usd TEXT, net_usd TEXT, net_bp REAL, funding_status TEXT, closed_by TEXT, exit_reason TEXT, entry_reason TEXT,
        entry_p REAL, hold_min INTEGER, mfe_bp REAL, mae_bp REAL, stop_px REAL, max_hold_ms INTEGER, mark_px REAL,
        mark_ms INTEGER, net_now_usd TEXT, opened_at_ms INTEGER, closed_at_ms INTEGER, leverage TEXT, margin_usd TEXT,
        funding_model TEXT, net_complete_usd TEXT, config_hash TEXT, execution_model TEXT, entry_receipt_id TEXT,
        exit_receipt_id TEXT, mark_receipt_id TEXT, funding_receipt_id TEXT, execution_error TEXT, exit_plan_json TEXT,
        PRIMARY KEY(product, trade_no))""",
    "qwen_execution_receipts": """CREATE TABLE execution_receipts(
        receipt_id TEXT PRIMARY KEY, product TEXT NOT NULL, trade_no INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('entry','exit','mark','funding')),
        signal_ms INTEGER NOT NULL, recorded_at_ms INTEGER NOT NULL,
        evidence_hash TEXT NOT NULL, evidence_json TEXT NOT NULL
      ) STRICT""",
    "qwen_news_actions": """CREATE TABLE news_actions(
        product TEXT NOT NULL, event_id TEXT NOT NULL, consumed_ms INTEGER NOT NULL,
        action TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(product,event_id))""",
    "qwen_config_versions": """CREATE TABLE config_versions(
        id INTEGER PRIMARY KEY AUTOINCREMENT, previous_hash TEXT, config_hash TEXT NOT NULL,
        activated_ms INTEGER NOT NULL, config_json TEXT NOT NULL, cash_usd TEXT NOT NULL)""",
    "auditor_miradas": """CREATE TABLE miradas(
        product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
        estado TEXT NOT NULL, accion TEXT NOT NULL,
        maestro INTEGER, puntaje REAL, umbral_flojo REAL, umbral_fuerte REAL,
        portero_si INTEGER, portero_p REAL, portero_umbral REAL,
        noticias_si INTEGER, noticias_lado INTEGER,
        qwen TEXT, qwen_coincide INTEGER,
        lado_posicion INTEGER NOT NULL DEFAULT 0,
        horas_en_posicion REAL, neto_ahora_pb REAL, trade_no INTEGER,
        condiciones_json TEXT NOT NULL, despues_json TEXT,
        veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT,
        resuelto_ms INTEGER, version TEXT NOT NULL, direccion_json TEXT, direccion_ms INTEGER,
        PRIMARY KEY(product, bucket_ms))""",
    "auditor_sombra": """CREATE TABLE sombra_maker(
        product TEXT NOT NULL, trade_no INTEGER NOT NULL, leg TEXT NOT NULL, motivo_salida TEXT,
        lado INTEGER NOT NULL, orden TEXT NOT NULL, t_oficial_ms INTEGER NOT NULL,
        precio_oficial REAL, comision_oficial_usd REAL, comision_oficial_tipo TEXT, cantidad REAL, notional_oficial_usd REAL,
        libro_ms INTEGER, limite_px REAL,
        estado TEXT NOT NULL, motivo_sin_datos TEXT,
        llenado_ms INTEGER, llenado_px REAL, cinta_px REAL, espera_ms INTEGER,
        comision_sombra_usd REAL, comision_sombra_tipo TEXT, delta_usd REAL, delta_pb REAL,
        modelo TEXT NOT NULL, costos_id TEXT, resuelto_ms INTEGER, version TEXT NOT NULL,
        PRIMARY KEY(product, trade_no, leg))""",
    "auditor_perdidas": """CREATE TABLE miradas_perdidas(
        product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
        motivo TEXT NOT NULL, detalle TEXT, despertar_json TEXT, estado TEXT NOT NULL,
        maestro INTEGER, puntaje REAL, entrada_dice TEXT, salida_dice TEXT, formula_json TEXT,
        registrada_ms INTEGER NOT NULL, version TEXT NOT NULL,
        PRIMARY KEY(product, bucket_ms))""",
    "official_candles": """CREATE TABLE paper_futures_official_candles(
        product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
        high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
        volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL,
        PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash)) STRICT""",
    "funding_periods": """CREATE TABLE paper_futures_funding_periods(
        response_sha256 TEXT NOT NULL,
        start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL,
        known_at INTEGER NOT NULL, unit TEXT NOT NULL, product_id TEXT NOT NULL DEFAULT 'PF_XBTUSD',
        PRIMARY KEY(response_sha256,start_ms)) STRICT""",
    "analytics_points": """CREATE TABLE paper_futures_analytics_points(
        product_id TEXT NOT NULL, metric TEXT NOT NULL, interval_ms INTEGER NOT NULL,
        bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL,
        values_json TEXT NOT NULL, response_sha256 TEXT NOT NULL,
        PRIMARY KEY(product_id, metric, interval_ms, bucket_start, revision_hash)) STRICT""",
})
# La tabla del auditor que NO se archiva (diagnostico de duraciones, ver ``nocturno.TABLAS_EXCLUIDAS``); solo la lleva ``crear_copia_auditor``.
DDL_AUDITOR_DURACIONES = """CREATE TABLE duraciones_auditor(id INTEGER PRIMARY KEY, product TEXT NOT NULL, t_ms INTEGER, origen TEXT NOT NULL,
    total_ms REAL NOT NULL, pasos_json TEXT NOT NULL, registrada_ms INTEGER NOT NULL, version TEXT NOT NULL)"""
# Tablas de qwen-live y del auditor que NO se archivan (estado vivo, o fuera de lo util); se crean en la copia sintetica para probar la exclusion.
DDL_QWEN_EXCLUIDAS = {
    "meta": "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "account": "CREATE TABLE account(id INTEGER PRIMARY KEY CHECK(id=1), initial_usd TEXT NOT NULL, created_ms INTEGER NOT NULL)",
    "examples": """CREATE TABLE examples(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, label_json TEXT NOT NULL, resolved_ms INTEGER NOT NULL, PRIMARY KEY(product, bucket_ms))""",
    "skipped": """CREATE TABLE skipped(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL,
        reason TEXT NOT NULL, detail TEXT, wake_json TEXT, PRIMARY KEY(product, bucket_ms))""",
    "rebotes": """CREATE TABLE rebotes(product TEXT NOT NULL, t_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL, episodio_ms INTEGER NOT NULL,
        caida_pct REAL NOT NULL, umbral_pct REAL NOT NULL, action TEXT NOT NULL, motivo TEXT, detalle TEXT, trade_no INTEGER,
        PRIMARY KEY(product, t_ms))""",
    "errors": """CREATE TABLE errors(id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, place TEXT NOT NULL, product TEXT,
        kind TEXT NOT NULL, detail TEXT)""",
    "trader_state": """CREATE TABLE trader_state(product TEXT PRIMARY KEY, last_fed_ms INTEGER, trade_seq INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL, last_call_ms INTEGER, position_json TEXT, updated_ms INTEGER NOT NULL, window_json TEXT,
        positions_json TEXT, memo_json TEXT)""",
}
MIRADA_JSON = '{"condiciones": "sinteticas"}'
EVIDENCIA = '{"evidence": "sintetica", "price": "2500.10"}'


def _insertar(con, tabla: str, fila: dict) -> None:
    con.execute("INSERT INTO %s(%s) VALUES(%s)" % (tabla, ", ".join(fila), ",".join("?" * len(fila))), tuple(fila.values()))


def crear_copia_qwen_live(ruta: str, dia0_ms: int, con_excluidas: bool = True) -> dict:
    """Base viva del trader (``live``) de 3 dias desde ``dia0_ms``, con lo que SQLite todavia puede cambiar y lo que ya no.

    - decisions: 4 por dia (producto PF_ETHUSD), insertadas una vez y nunca modificadas.
    - trades: dia 0 dos cerradas con funding completo; dia 1 una cerrada con funding completo y otra cerrada con funding pendiente
      (``partial``: el motor todavia la reconcilia); dia 2 una abierta (sin salida). Numero de operacion = 10 * dia + orden.
    - execution_receipts: por dia entry/exit/mark; ademas un recibo de funding con ``signal_ms`` del dia 0 grabado (``recorded_at_ms``) el dia 2.
    - news_actions: una por dia. config_versions: dos filas el dia 0.
    Devuelve las filas por tabla del archivo."""
    con = sqlite3.connect(ruta)
    n = {k: 0 for k in ("qwen_decisions", "qwen_trades", "qwen_execution_receipts", "qwen_news_actions", "qwen_config_versions")}
    try:
        for k in n:
            con.execute(DDL[k])
        if con_excluidas:
            for sql in DDL_QWEN_EXCLUIDAS.values():
                con.execute(sql)
            con.execute("INSERT INTO meta VALUES('schema_version', '1')")
            con.execute("INSERT INTO account VALUES(1, '1000', ?)", (dia0_ms,))
            con.execute("INSERT INTO trader_state(product, trade_seq, cooldown_until, updated_ms) VALUES('PF_ETHUSD', 12, 0, ?)", (dia0_ms,))
        for d in range(3):
            base = dia0_ms + d * DAY_MS
            for h in range(4):
                t = base + h * 6 * 3_600_000 + BUCKET_15M
                _insertar(con, "decisions", {
                    "product": "PF_ETHUSD", "bucket_ms": t - BUCKET_15M, "t_ms": t, "decided_at_ms": t + 4000, "kind": "flat",
                    "action": "ESPERAR" if h else "LARGO", "model_action": "ESPERAR", "p_action": 0.5 + h / 10, "confidence": 0.6,
                    "probs_json": "[0.5, 0.5]", "orders_json": "[{}]", "reason": "sintetica", "wake_json": "{}",
                    "state_text": "estado " * 40, "state_hash": "s-%d-%d" % (d, h), "latency_ms": 120, "threshold": 0.6,
                    "prompt_version": "8", "model": "synthetic", "config_hash": "c" * 64, "lean": 0.1 * h, "lean_m": 1, "score": -0.5,
                    "look_n": 3, "mirror_ok": 1, "factors_json": '{"maestro": 1}', "formula_action": "ESPERAR", "formula_json": '{"puntaje": 0.1}',
                    "opinion_agrees": 1})
                n["qwen_decisions"] += 1
            for k in range(2):
                no = 10 * d + k + 1
                if d == 2 and k == 1:
                    continue
                abierta = d == 2
                completo = not (d == 1 and k == 1)
                _insertar(con, "trades", {
                    "product": "PF_ETHUSD", "trade_no": no, "status": "open" if abierta else "closed", "side": "LONG",
                    "entry_ms": base + (k + 1) * 3_600_000, "exit_ms": None if abierta else base + (k + 5) * 3_600_000,
                    "entry_px": "2500.5", "exit_px": None if abierta else "2510.5", "qty": "0.04", "notional_usd": "100",
                    "gross_usd": None if abierta else "0.4", "fees_usd": None if abierta else "0.08", "funding_usd": "0",
                    "net_usd": None if abierta else "0.32", "net_bp": None if abierta else 32.0,
                    "funding_status": "complete" if completo else "partial", "closed_by": None if abierta else "strategy_exit",
                    "exit_reason": None if abierta else "salir", "entry_reason": "entrar", "entry_p": 0.7, "hold_min": 240,
                    "mfe_bp": 40.0, "mae_bp": -5.0, "stop_px": None, "max_hold_ms": 129_600_000,
                    "opened_at_ms": base + (k + 1) * 3_600_000 + 20, "closed_at_ms": None if abierta else base + (k + 5) * 3_600_000 + 20,
                    "leverage": "1", "margin_usd": "100", "funding_model": "exact", "net_complete_usd": "0.32" if completo and not abierta else None,
                    "config_hash": "c" * 64, "execution_model": "book", "entry_receipt_id": "e-%d" % no,
                    "exit_receipt_id": None if abierta else "x-%d" % no})
                n["qwen_trades"] += 1
            for i, proposito in enumerate(("entry", "exit", "mark")):
                _insertar(con, "execution_receipts", {
                    "receipt_id": "r-%d-%s" % (d, proposito), "product": "PF_ETHUSD", "trade_no": 10 * d + 1, "purpose": proposito,
                    "signal_ms": base + i * 3_600_000, "recorded_at_ms": base + i * 3_600_000 + 5000, "evidence_hash": "h" * 64,
                    "evidence_json": EVIDENCIA})
                n["qwen_execution_receipts"] += 1
            _insertar(con, "news_actions", {"product": "PF_ETHUSD", "event_id": "n-%d" % d, "consumed_ms": base + 7_200_000, "action": "SALIR",
                                            "evidence_json": EVIDENCIA})
            n["qwen_news_actions"] += 1
        # recibo de funding de una operacion del dia 0, grabado el dia 2 (la conciliacion llega tarde): cae en el dia en que se GRABO
        _insertar(con, "execution_receipts", {
            "receipt_id": "r-funding-tarde", "product": "PF_ETHUSD", "trade_no": 1, "purpose": "funding", "signal_ms": dia0_ms + 5 * 3_600_000,
            "recorded_at_ms": dia0_ms + 2 * DAY_MS + 3_600_000, "evidence_hash": "g" * 64, "evidence_json": EVIDENCIA})
        n["qwen_execution_receipts"] += 1
        for i in range(2):
            _insertar(con, "config_versions", {"previous_hash": None if i == 0 else "c" * 64, "config_hash": "c" * 64 if i == 0 else "d" * 64,
                                               "activated_ms": dia0_ms + i * 3_600_000, "config_json": '{"v": %d}' % i, "cash_usd": "1000"})
            n["qwen_config_versions"] += 1
        con.commit()
    finally:
        con.close()
    return n


def crear_copia_auditor(ruta: str, dia0_ms: int, con_excluidas: bool = True, con_sombra: bool = False) -> dict:
    """``auditor.sqlite`` de 3 dias: 4 miradas por dia. Dia 0 todas resueltas (``resuelto_ms`` puesto, ya no cambian); dia 1 con UNA sin resolver
    (el auditor todavia la actualiza); dia 2 ninguna resuelta. Con ``con_sombra`` suma ``sombra_maker`` (la sombra maker del auditor): por dia una
    entrada que lleno como maker y una salida sin datos, ambas ya finales (se escriben una vez). Devuelve las filas del archivo."""
    con = sqlite3.connect(ruta)
    total = 0
    try:
        con.execute(DDL["auditor_miradas"])
        if con_excluidas:
            con.execute(DDL_QWEN_EXCLUIDAS["meta"])
            con.execute("INSERT INTO meta VALUES('schema', 'balancita-auditor.v1')")
            con.execute(DDL_AUDITOR_DURACIONES)
        if con_sombra:
            con.execute(DDL["auditor_sombra"])
        for d in range(3):
            base = dia0_ms + d * DAY_MS
            for h in range(4):
                t = base + h * 6 * 3_600_000 + BUCKET_15M
                resuelta = d == 0 or (d == 1 and h != 3)
                _insertar(con, "miradas", {
                    "product": "PF_ETHUSD", "bucket_ms": t - BUCKET_15M, "t_ms": t, "estado": "plana", "accion": "NO_ENTRAR_portero",
                    "maestro": 1, "puntaje": 0.4, "umbral_flojo": 0.3, "umbral_fuerte": 0.6, "portero_si": 0, "portero_p": 0.2,
                    "portero_umbral": 0.5, "noticias_si": 0, "qwen": "ESPERAR", "qwen_coincide": 1, "lado_posicion": 0,
                    "condiciones_json": MIRADA_JSON, "despues_json": '{"mov": 1}' if resuelta else None,
                    "veredicto_36h_json": '{"acerto": true}' if resuelta else None, "resuelto_ms": t + 36 * 3_600_000 if resuelta else None,
                    "version": "auditor.v1"})
                total += 1
            if con_sombra:
                t = base + 5 * 3_600_000
                _insertar(con, "sombra_maker", {
                    "product": "PF_ETHUSD", "trade_no": d + 1, "leg": "entry", "lado": 1, "orden": "compra", "t_oficial_ms": t,
                    "precio_oficial": 2250.1, "comision_oficial_usd": 0.225, "comision_oficial_tipo": "taker", "cantidad": 0.2,
                    "notional_oficial_usd": 450.02, "libro_ms": t - 5000, "limite_px": 2250.0, "estado": "maker", "llenado_ms": t + 30_000,
                    "llenado_px": 2250.0, "espera_ms": 30_000, "comision_sombra_usd": 0.09, "comision_sombra_tipo": "maker", "delta_usd": 0.15,
                    "delta_pb": 3.4, "modelo": "sombra-maker.v1", "costos_id": "kraken-futures-costs.v2", "resuelto_ms": t + 16 * 60_000,
                    "version": "auditor.v1"})
                _insertar(con, "sombra_maker", {
                    "product": "PF_ETHUSD", "trade_no": d + 1, "leg": "exit", "motivo_salida": "vuelta", "lado": 1, "orden": "venta",
                    "t_oficial_ms": t + 2 * 3_600_000, "precio_oficial": 2300.0, "comision_oficial_usd": 0.23, "comision_oficial_tipo": "taker",
                    "cantidad": 0.2, "notional_oficial_usd": 460.0, "estado": "sin_datos", "motivo_sin_datos": "sin_libro",
                    "modelo": "sombra-maker.v1", "costos_id": "kraken-futures-costs.v2", "resuelto_ms": t + 2 * 3_600_000 + 16 * 60_000,
                    "version": "auditor.v1"})
        con.commit()
    finally:
        con.close()
    return {"auditor_miradas": total, **({"auditor_sombra": 6} if con_sombra else {})}


def crear_copia_mercado_util(ruta: str, dia0_ms: int) -> dict:
    """Las tres tablas de futures-market que se suman al archivo (``official_candles``, ``funding_periods``, ``analytics_points``), 3 dias.
    Cada dia hay ``known_at`` propio; ademas una REVISION tardia de una vela del dia 0 aprendida el dia 2 (la tabla es solo-agregar: ese dato
    cae en el dia 2, no en el 0, y por eso el periodo no se cierra mal)."""
    con = sqlite3.connect(ruta)
    n = {"official_candles": 0, "funding_periods": 0, "analytics_points": 0}
    try:
        for k in n:
            con.execute(DDL[k])
        for d in range(3):
            base = dia0_ms + d * DAY_MS
            for p in ("PF_ETHUSD", "PF_XBTUSD"):
                for i in range(3):
                    b = base + i * MINUTO
                    _insertar(con, "paper_futures_official_candles", {
                        "product_id": p, "interval_ms": MINUTO, "bucket_start": b, "revision_hash": "r%d" % i, "known_at": b + 70_000,
                        "open_price": "100.5", "high_price": "101", "low_price": "99.5", "close_price": "100.75", "volume_btc": "12.5",
                        "response_sha256": "s" * 64})
                    n["official_candles"] += 1
                    _insertar(con, "paper_futures_analytics_points", {
                        "product_id": p, "metric": "open-interest", "interval_ms": MINUTO, "bucket_start": b, "revision_hash": "r%d" % i,
                        "known_at": b + 70_000, "values_json": '{"open": 1}', "response_sha256": "s" * 64})
                    n["analytics_points"] += 1
                _insertar(con, "paper_futures_funding_periods", {
                    "response_sha256": "f%d%s" % (d, p), "start_ms": base, "end_ms": base + 3_600_000, "funding_rate": "0.000012",
                    "known_at": base + 3_700_000, "unit": "USD/XBT/hour", "product_id": p})
                n["funding_periods"] += 1
        _insertar(con, "paper_futures_official_candles", {
            "product_id": "PF_ETHUSD", "interval_ms": MINUTO, "bucket_start": dia0_ms, "revision_hash": "tarde", "known_at": dia0_ms + 2 * DAY_MS + 5000,
            "open_price": "100.5", "high_price": "101", "low_price": "99.5", "close_price": "100.9", "volume_btc": "13", "response_sha256": "t" * 64})
        n["official_candles"] += 1
        con.commit()
    finally:
        con.close()
    return n
