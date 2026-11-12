"""Flujo de mercado por mirada del auditor (SOLO ESCRITURA / AUDITORÍA): para cada mirada de 15 min, el resumen de compras y ventas
agresoras (CVD), liquidaciones e interés abierto en ventanas de 30 min, 1 h y 4 h que terminan en el minuto de la mirada. Sirve
para juzgar entradas y salidas después; NINGUNA decisión lo lee.

Fuente preferida: lo que la captura ya guarda en ``futures-market.sqlite`` (``paper_futures_analytics_points``, métricas ``cvd``,
``liquidation-volume`` y ``open-interest``, intervalo de 1 min), abierta solo para leer y con plazo. Respaldo: la API pública de
analytics de Kraken (sin credenciales, plazo corto), solo si la captura no alcanza para alguna ventana; se anota en ``fuente``.

Sin trampa: solo cuentan buckets de 1 min ya cerrados (``bucket_start + 1 min <= t_ms``) y, en la captura, ya conocidos
(``known_at <= t_ms``; de cada bucket vale la última revisión conocida a esa hora, nunca una posterior). Como la captura baja cada
minuto unos segundos después de cerrar, el último minuto antes de ``t_ms`` suele no estar aún: la ventana termina entonces en el último
minuto conocido (``fin_ms``) y no se inventa el que falta. Lo que falte queda en ``NULL`` con ``hueco = 1`` y ``motivo_hueco``;
nunca se reemplaza por 0. Ninguna función de acá propaga una excepción a la mirada: el que llama la protege con ``_safe``.
"""

import contextlib
import json
import math
import os
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path

FLUJO_VERSION = "flujo.v1"
MINUTE_MS = 60_000
WINDOWS = (("30m", 30), ("1h", 60), ("4h", 240))          # (sufijo de columna, minutos)
MAX_MINUTES = 240
STALE_MS = 3 * MINUTE_MS                                  # el último minuto conocido no puede quedar más atrás que esto
CAPTURE_BUDGET_S = 2.0                                    # tiempo total de lectura de la captura
API_TIMEOUT_S = 2.0                                       # espera máxima por petición a Kraken
API_BUDGET_S = 5.0                                        # tiempo total del respaldo: pasado esto no se piden más series
API_LIVE_WINDOW_MS = 30 * MINUTE_MS                       # el respaldo solo corre para miradas en vivo (la API no tiene "known_at")
API_SETTLE_MS = 5_000                                     # margen para que Kraken asiente el bucket (igual que la captura)
API_URL = "https://futures.kraken.com/api/charts/v1/analytics"
API_ENV = "FUTURES_AUDITOR_FLUJO_API"                     # ``0`` apaga el respaldo
METRICS = ("cvd", "liquidation-volume", "open-interest")

COLUMNS = (["product", "bucket_ms", "t_ms", "fin_ms", "oi"]
           + ["{}_{}".format(name, suffix) for suffix, _ in WINDOWS
              for name in ("comprador", "vendedor", "delta", "liquidaciones", "oi_cambio", "oi_pct")]
           + ["fuente", "hueco", "motivo_hueco", "cobertura_json", "version"])


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# --------------------------------------------------------------------------- reading the points


def leer_captura(path, product, metric, from_ms, t_ms, budget_s=CAPTURE_BUDGET_S):
    """``{bucket_start: valores}`` de la captura (solo lectura) para un balde de 1 min cerrado y conocido a ``t_ms``. De cada balde, la
    última revisión con ``known_at <= t_ms``. Levanta si la base no existe o no tiene la tabla (el que llama prueba el respaldo)."""
    deadline = time.monotonic() + budget_s
    db = sqlite3.connect(Path(os.path.abspath(path)).as_uri() + "?mode=ro", uri=True, timeout=1.0)
    try:
        db.execute("PRAGMA query_only=1")
        db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5_000)
        rows = db.execute(
            "SELECT bucket_start, values_json FROM paper_futures_analytics_points "
            "WHERE product_id=? AND metric=? AND interval_ms=? AND bucket_start>=? AND bucket_start+?<=? AND known_at<=? "
            "ORDER BY bucket_start, known_at, rowid", (product, metric, MINUTE_MS, from_ms, MINUTE_MS, t_ms, t_ms)).fetchall()
    finally:
        db.close()
    out = {}
    for bucket, text in rows:
        try:
            values = json.loads(text)
        except ValueError:
            continue
        if isinstance(values, dict):
            out[int(bucket)] = values                       # la última revisión conocida pisa a las anteriores
    return out


def _flatten(data, index, prefix, out):
    """Como ``flatten`` de ``market-analytics.ts``: serie escalar -> ``value``, tupla OHLC -> ``open/high/low/close``, objeto anidado -> ``a.b``."""
    if isinstance(data, list):
        item = data[index] if index < len(data) else None
        if isinstance(item, list) and len(item) == 4:
            for name, value in zip(("open", "high", "low", "close"), item):
                out[prefix + "." + name if prefix else name] = value
        elif item is not None and not isinstance(item, (list, dict)):
            out[prefix or "value"] = item
    elif isinstance(data, dict):
        for key, value in data.items():
            _flatten(value, index, prefix + "." + key if prefix else key, out)


def leer_api(product, metric, from_ms, t_ms, now_ms, opener=urllib.request.urlopen, timeout=API_TIMEOUT_S):
    """``{bucket_start: valores}`` de la API pública de analytics de Kraken, con los mismos filtros de cierre: solo baldes de 1 min con
    ``bucket_start + 1 min <= t_ms`` y asentados (``+ 5 s <= now_ms``). Levanta ante cualquier fallo de red o de formato."""
    url = "{}/{}/{}?since={}&interval=60".format(API_URL, urllib.parse.quote(product), metric, int(from_ms // 1000))
    request = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "balancita-auditor/1"})
    with contextlib.closing(opener(request, timeout=timeout)) as response:
        body = json.loads(response.read(4 * 1024 * 1024).decode("utf-8"))
    result = body["result"]
    stamps, data = result["timestamp"], result["data"]
    out = {}
    for index, seconds in enumerate(stamps):
        bucket = int(seconds) * 1000
        if bucket < from_ms or bucket + MINUTE_MS > t_ms or bucket + MINUTE_MS + API_SETTLE_MS > now_ms:
            continue
        values = {}
        _flatten(data, index, "", values)
        if values:
            out[bucket] = values
    return out


# --------------------------------------------------------------------------- the summary


def _window_sum(points, key, end, minutes):
    """``(suma, minutos presentes)`` de ``key`` en los baldes ``[end - minutos, end)``; ``None`` si no hay ningún valor."""
    total, found = 0.0, 0
    for bucket in range(end - minutes * MINUTE_MS, end, MINUTE_MS):
        value = _number((points.get(bucket) or {}).get(key))
        if value is not None:
            total, found = total + value, found + 1
    return (total if found else None), found


def _oi_at(points, moment):
    """Cierre del interés abierto del último balde cerrado a ``moment`` (hasta ``STALE_MS`` antes), o ``None``."""
    for bucket in range((moment // MINUTE_MS) * MINUTE_MS - MINUTE_MS, moment - STALE_MS - MINUTE_MS, -MINUTE_MS):
        value = _number((points.get(bucket) or {}).get("close"))
        if value is not None and value > 0:
            return value
    return None


def resumen(product, t_ms, series):
    """Calcula la fila (sin ``bucket_ms`` ni ``version``) con ``series = {métrica: {bucket_start: valores}}`` y su ``fuente``.
    Devuelve ``(fila, motivos)``: lo que no se pudo calcular queda ``None`` y explicado en ``motivos``."""
    row = {name: None for name in COLUMNS}
    row.update(product=product, t_ms=t_ms)
    why, cover = [], {}
    cvd, liq, oi = (series.get(m) or {} for m in METRICS)
    ends = [bucket + MINUTE_MS for bucket in cvd]
    end = max(ends) if ends else None
    if end is None or t_ms - end > STALE_MS:
        why.append("cvd_sin_datos" if end is None else "cvd_viejo")
        end = None
    row["fin_ms"] = end
    for suffix, minutes in WINDOWS:
        if end is None:
            continue
        buy, n_buy = _window_sum(cvd, "buy_volume", end, minutes)
        sell, n_sell = _window_sum(cvd, "sell_volume", end, minutes)
        cover["cvd_" + suffix] = min(n_buy, n_sell)
        if min(n_buy, n_sell) == minutes:
            row["comprador_" + suffix], row["vendedor_" + suffix] = buy, sell
            row["delta_" + suffix] = buy - sell
            # las liquidaciones sin ningún balde en el rango largo = la captura no las guarda, no "cero liquidaciones"
            if any(end - MAX_MINUTES * MINUTE_MS <= b < end for b in liq):
                row["liquidaciones_" + suffix] = _window_sum(liq, "value", end, minutes)[0] or 0.0
            else:
                why.append("liquidaciones_sin_datos")
        else:
            why.append("cvd_{}:{}/{}".format(suffix, min(n_buy, n_sell), minutes))
    moment = end if end is not None else t_ms                # el interés abierto se mide hasta el mismo minuto que el flujo
    now = _oi_at(oi, moment)
    row["oi"] = now
    if now is None:
        why.append("oi_sin_datos")
    for suffix, minutes in WINDOWS:
        old = None if now is None else _oi_at(oi, moment - minutes * MINUTE_MS)
        if now is not None and old is not None:
            row["oi_cambio_" + suffix] = now - old
            row["oi_pct_" + suffix] = (now / old - 1.0) * 100.0
        elif now is not None:
            why.append("oi_{}_sin_base".format(suffix))
    return row, sorted(set(why)), cover


def _api_enabled(env):
    return (env.get(API_ENV) or "").strip() != "0"


def calcular(product, t_ms, market_db=None, now_ms=None, env=None, api=leer_api, clock=time.time):
    """La fila ``flujo_mirada`` de la mirada ``t_ms`` (sin ``bucket_ms`` ni ``version``). Primero la captura; si alguna ventana queda
    incompleta y la mirada es en vivo, completa SOLO las métricas incompletas con la API pública. Nunca levanta: un fallo queda en
    ``motivo_hueco``."""
    env = os.environ if env is None else env
    real_ms = int(clock() * 1000)
    now_ms = real_ms if now_ms is None else now_ms
    from_ms = t_ms - (MAX_MINUTES + 1) * MINUTE_MS - MINUTE_MS
    series, sources, errors = {}, {}, []
    for metric in METRICS:
        if market_db and os.path.exists(market_db):
            try:
                series[metric] = leer_captura(market_db, product, metric, from_ms, t_ms)
                sources[metric] = "captura"
            except Exception as error:                      # noqa: BLE001 - la captura ausente o sin tabla no rompe la mirada
                errors.append("captura_{}:{}".format(metric, type(error).__name__))
        else:
            errors.append("captura_ausente")
    row, why, cover = resumen(product, t_ms, {m: series.get(m) for m in METRICS})
    # el respaldo de red solo corre en vivo: la mirada y ``now_ms`` cerca del reloj real (una reconstrucción o una prueba con horas viejas no sale a la red)
    live = abs(now_ms - t_ms) <= API_LIVE_WINDOW_MS and abs(real_ms - now_ms) <= API_LIVE_WINDOW_MS
    missing = [m for m in METRICS if not _metric_complete(m, series.get(m) or {}, t_ms)]
    if missing and live and _api_enabled(env):
        began = time.monotonic()
        patched = dict(series)
        for metric in missing:
            if time.monotonic() - began > API_BUDGET_S:
                errors.append("api_sin_tiempo")
                break
            try:
                patched[metric] = api(product, metric, from_ms, t_ms, now_ms)
                sources[metric] = "api"
            except Exception as error:                      # noqa: BLE001
                errors.append("api_{}:{}".format(metric, type(error).__name__))
        row, why, cover = resumen(product, t_ms, patched)
    used = sorted(set(sources.values()))
    row["fuente"] = "+".join(used) if used else None
    row["motivo_hueco"] = ";".join(sorted(set(why)) + sorted(set(errors))) or None
    row["hueco"] = 1 if why else 0
    row["cobertura_json"] = json.dumps(cover, sort_keys=True)
    return row


def _metric_complete(metric, points, t_ms):
    """¿Esta métrica sola alcanza para sus ventanas? (para no pedir a la API lo que la captura ya dio entera)."""
    if metric == "liquidation-volume":                      # basta con que la serie exista en el rango (los minutos sin liquidación pueden no venir)
        return any(t_ms - (MAX_MINUTES + 2) * MINUTE_MS <= b < t_ms for b in points)
    ends = [b + MINUTE_MS for b in points]
    if not ends or t_ms - max(ends) > STALE_MS:
        return False
    end = max(ends)
    if metric == "open-interest":
        return all(_oi_at(points, end - m * MINUTE_MS) is not None for m in (0,) + tuple(m for _, m in WINDOWS))
    return all(_window_sum(points, "buy_volume", end, m)[1] == m and _window_sum(points, "sell_volume", end, m)[1] == m
               for _, m in WINDOWS)
