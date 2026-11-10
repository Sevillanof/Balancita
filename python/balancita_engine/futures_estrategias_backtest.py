"""Laboratorio de estrategias: compara la Terminal oficial (snapshot) contra una variante sobre la MISMA ventana y los MISMOS datos.

Las dos configuraciones corren con ``futures_qwen_trader_exam.replay_formula`` (el ``Trader`` real del paper vivo), cada una con su
config completa explícita (sin variables de entorno). Los dos replays reciben el mismo lector de datos, limitado a ``hasta`` (nada
de ``hasta`` en adelante se lee), así que no hay look-ahead. No escribe nada: ni bases, ni el registro de intentos, ni archivos.

Uso::

    python -m balancita_engine.futures_estrategias_backtest --estrategia <id> [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]

La ventana por defecto es la honesta (2026-02-01 → 2026-04-19: del ajuste de los expertos fríos a la reserva). Una ventana que
entra en la reserva (desde 2026-04-19) se rechaza salvo ``--incluir-reserva``, y el informe la marca.

Equivalencia con el vivo (S4): ``comparar_con_vivo`` repite la Terminal oficial con el mismo replay sobre el período en que corrió el
trader en vivo y lista dónde sus decisiones y operaciones coinciden o difieren (``decisions`` y ``trades`` de la copia de
``live.sqlite``, solo lectura, con las velas de la copia del respaldo). Es un chequeo de equivalencia de CÓDIGO, no una evaluación de
estrategia: el período vivo es posterior a la reserva, no se registran intentos y el resultado no sirve para elegir nada::

    python -m balancita_engine.futures_estrategias_backtest --vs-vivo --live-db RUTA/qwen-live__live-<sello>.sqlite [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
from decimal import Decimal

from . import futures_estrategias as est
from . import futures_qwen_analista as analista
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as exam

SCHEMA = "balancita-estrategias-comparacion.v1"
DESDE_HONESTA, HASTA_HONESTA = "2026-02-01", "2026-04-19"
CAPITAL_USD = "1000"
# motivo (``closed_by``) del cierre forzado de lo que sigue abierto al terminar la ventana (``exam._collect_replay_trades``)
MOTIVO_FIN_VENTANA = "fin_examen"
# métricas numéricas que se restan (variante − oficial)
NUMERICAS = ("operaciones", "neto_usd", "neto_bp_cuenta", "neto_bp_por_operacion", "acierto", "max_drawdown_usd",
             "max_drawdown_bp", "horas_promedio", "horas_max", "nocional_promedio_usd")


class ComparacionError(est.EstrategiaError):
    pass


# --------------------------------------------------------------------------- métricas


def metricas(curvas, capital_usd=CAPITAL_USD):
    """Métricas de una corrida a partir de sus operaciones (``replay_formula()["curvas"]["formula"]``), todas después de costos.

    - ``neto_usd``: suma del neto de cada operación; ``neto_bp_cuenta``: ese neto sobre el capital inicial (puntos básicos de la
      cuenta).
    - ``neto_bp_por_operacion``: PONDERADO por tamaño, Σ neto USD / Σ nocional USD × 10000: lo que ganó cada dólar puesto. Cada posición
      tiene su tamaño (la Terminal reparte el saldo en hasta 3 cupos, uno puede ser un resto de ~10 US$), así que el promedio simple de
      los bp de cada operación no se parece al neto en US$ (llegó a dar −0,6 bp con +97,70 US$). ``neto_bp_promedio_simple`` es ese
      promedio sin ponderar, solo como referencia.
    - ``nocional_promedio_usd`` / ``_min_`` / ``_max_``: tamaño de las posiciones (``notional_usd`` de cada una).
    - ``acierto``: parte de las operaciones con neto > 0, cada una cuenta igual sin importar su tamaño (``None`` sin operaciones).
    - ``max_drawdown_usd`` / ``_bp``: la mayor caída del saldo realizado desde su máximo (el saldo cambia cuando cierra cada
      operación, en orden de salida; no marca las abiertas); ``_bp`` es esa caída sobre el máximo previo (el mayor de los cocientes).
    - ``horas_promedio`` / ``horas_max``: tiempo abierta de cada operación (el máximo muestra que un tope, p. ej. 30 h, se cumple).
    - ``por_motivo``: cuántas cerraron por cada razón de salida (``razon`` de la operación, p. ej. maestro_vuelta; si no hay, el motivo).

    Las operaciones que el replay cierra a la fuerza al terminar la ventana (motivo ``fin_examen``) NO son una decisión de la estrategia:
    no cuentan en ninguna de las métricas de arriba (ni operaciones, acierto, neto, drawdown, horas, nocional ni ``por_motivo``). Se
    informan aparte en ``cerradas_fin_ventana`` ``{operaciones, neto_usd}`` (``{0, 0.0}`` si no hay)."""
    capital = Decimal(str(capital_usd))
    ordenadas = sorted((c for c in curvas if c["motivo"] != MOTIVO_FIN_VENTANA), key=lambda c: (c["salida_ms"], c["entrada_ms"]))
    cerradas = [c for c in curvas if c["motivo"] == MOTIVO_FIN_VENTANA]
    saldo = pico = capital
    caida, caida_rel = Decimal(0), Decimal(0)
    neto = nocional = Decimal(0)
    ganadoras = 0
    for curva in ordenadas:
        pnl = Decimal(str(curva["pnl_usd"]))
        neto += pnl
        nocional += Decimal(str(curva["notional_usd"]))
        ganadoras += pnl > 0
        saldo += pnl
        pico = max(pico, saldo)
        caida = max(caida, pico - saldo)
        caida_rel = max(caida_rel, (pico - saldo) / pico)
    n = len(ordenadas)
    por_motivo = {}
    for curva in ordenadas:
        razon = curva.get("razon") or curva["motivo"]
        por_motivo[razon] = por_motivo.get(razon, 0) + 1
    tamanos = [float(Decimal(str(c["notional_usd"]))) for c in ordenadas]
    horas = [(c["salida_ms"] - c["entrada_ms"]) / qt.HOUR_MS for c in ordenadas]
    return {
        "operaciones": n,
        "neto_usd": float(neto),
        "neto_bp_cuenta": float(neto / capital * 10000),
        "neto_bp_por_operacion": float(neto / nocional * 10000) if n and nocional else None,
        "neto_bp_promedio_simple": sum(c["neto_bp"] for c in ordenadas) / n if n else None,
        "nocional_promedio_usd": float(nocional / n) if n else None,
        "nocional_min_usd": min(tamanos) if n else None,
        "nocional_max_usd": max(tamanos) if n else None,
        "acierto": ganadoras / n if n else None,
        "max_drawdown_usd": float(caida),
        "max_drawdown_bp": float(caida_rel * 10000),
        "horas_promedio": sum(horas) / n if n else None,
        "horas_max": max(horas) if n else None,
        "por_motivo": por_motivo,
        "cerradas_fin_ventana": {"operaciones": len(cerradas),
                                 "neto_usd": float(sum((Decimal(str(c["pnl_usd"])) for c in cerradas), Decimal(0)))},
    }


def diferencia(oficial, variante):
    """``variante − oficial`` de cada métrica numérica; ``None`` cuando una de las dos no existe (p. ej. sin operaciones)."""
    return {clave: None if oficial[clave] is None or variante[clave] is None else variante[clave] - oficial[clave]
            for clave in NUMERICAS}


# --------------------------------------------------------------------------- ventana y datos


def _fecha_ms(texto, nombre):
    try:
        ms = qt.date_ms(texto) if isinstance(texto, str) and len(texto) == 10 else None
    except ValueError:
        ms = None
    if ms is None or qt.stamp(ms) != texto:
        raise ComparacionError("{}: {!r} no es una fecha AAAA-MM-DD.".format(nombre, texto))
    return ms


class _Ventana:
    """El lector de datos de una comparación: lo que ``replay_formula`` pide, sin pasar de ``hasta_ms``. Los dos replays comparten
    esta misma ventana. Pedir velas más allá del final es un error (look-ahead); el funding se recorta a los periodos ya cerrados."""

    def __init__(self, datos, hasta_ms):
        self._datos, self.hasta_ms, self.max_pedido_ms = datos, hasta_ms, 0

    def bars(self, product, from_ms, to_ms, **kw):
        if to_ms > self.hasta_ms:
            raise qt.HoldoutError("se pidieron velas hasta {} y la ventana termina el {}: no se leen".format(
                qt.stamp(to_ms), qt.stamp(self.hasta_ms)))
        self.max_pedido_ms = max(self.max_pedido_ms, to_ms)
        return self._datos.bars(product, from_ms, to_ms, **kw)

    def funding(self, product):
        return [(int(s), float(r)) for s, r in self._datos.funding(product) if int(s) + qt.HOUR_MS <= self.hasta_ms]


def _validar_ventana(desde, hasta, incluir_reserva, reserva_ms):
    desde_ms, hasta_ms = _fecha_ms(desde, "desde"), _fecha_ms(hasta, "hasta")
    if desde_ms >= hasta_ms:
        raise ComparacionError("La ventana está vacía: desde ({}) tiene que ser anterior a hasta ({}).".format(desde, hasta))
    toca = hasta_ms > reserva_ms
    if toca and not incluir_reserva:
        raise ComparacionError(
            "La ventana {} → {} entra en la reserva (desde {}): no se mide ahí, solo el examen final de cada versión. "
            "Terminá en {} o antes; si de verdad querés tocarla, usá --incluir-reserva (el informe la marca).".format(
                desde, hasta, qt.stamp(reserva_ms), qt.stamp(reserva_ms)))
    reserva = {"incluida": bool(toca), "desde": qt.stamp(reserva_ms)}
    if toca:
        reserva["aviso"] = ("Esta ventana incluye datos de la reserva ({} en adelante): el resultado NO sirve para elegir ni "
                            "decidir; la reserva se mira una sola vez por versión (ADR 0001, enmienda 2026-10-23).".format(
                                qt.stamp(reserva_ms)))
    return desde_ms, hasta_ms, reserva


def validar_ventana(desde, hasta, reserva_desde_ms=None):
    """Para quien NO puede tocar la reserva (la página Estrategias): ``(desde_ms, hasta_ms)`` de una ventana AAAA-MM-DD que no pasa
    de la reserva; si no, ``ComparacionError`` sin ofrecer ninguna bandera para saltarla."""
    reserva_ms = qt.load_holdout_ms() if reserva_desde_ms is None else reserva_desde_ms
    desde_ms, hasta_ms = _fecha_ms(desde, "desde"), _fecha_ms(hasta, "hasta")
    if desde_ms >= hasta_ms:
        raise ComparacionError("La ventana está vacía: desde ({}) tiene que ser anterior a hasta ({}).".format(desde, hasta))
    if hasta_ms > reserva_ms:
        raise ComparacionError(
            "La ventana {} → {} entra en la reserva (desde {}): la reserva se mira una sola vez por versión y no se puede usar desde "
            "la página. Terminá el {} o antes.".format(desde, hasta, qt.stamp(reserva_ms), qt.stamp(reserva_ms)))
    return desde_ms, hasta_ms


# --------------------------------------------------------------------------- comparación


def _limite_posicionamiento(config):
    """El replay no alimenta posicionamiento ni prima: lo dice el informe, y dice si importa. Los expertos activos solo leen velas; si
    el maestro o el portero usaran las señales extra de ETH (prima, sesgo long/short, funding), esas valdrían 0 en el replay y sus
    decisiones NO serían las del vivo."""
    from . import futures_qwen_corta as corta
    from . import futures_qwen_independent_gate as independent
    from . import futures_qwen_maestro as maestro
    from . import futures_qwen_portero as portero
    teacher, keeper = corta.formulas(config)
    usa = maestro.uses_extra_eth(teacher) or (keeper is not None and portero.uses_extra_eth(keeper))
    autonomo = (config.get("corta") or {}).get("portero_autonomo")
    if autonomo is not None:
        usa = usa or bool(set(independent.load(autonomo)["features"]) & set(maestro.ETH_EXTRA_DIRECTIONAL))
    if usa:
        return ("sin posicionamiento: el maestro/portero de ETH usa prima, sesgo long/short y funding; el replay no los alimenta (valen 0): "
                "sus decisiones NO son las del vivo y el resultado no vale hasta que el replay lea el historial (positioning.sqlite: "
                "posicionamiento desde 2024-01, prima desde 2022-03)")
    return "sin posicionamiento (no afecta: el maestro y el portero activos solo leen velas)"


def _operaciones(curvas):
    return [{"entrada_ms": c["entrada_ms"], "salida_ms": c["salida_ms"], "lado": "LONG" if c["lado"] > 0 else "SHORT",
             "neto_usd": float(Decimal(str(c["pnl_usd"]))), "neto_bp": c["neto_bp"], "motivo": c["motivo"], "razon": c.get("razon"),
             "nocional_usd": float(Decimal(str(c["notional_usd"])))} for c in curvas]


def _correr(config, ventana, desde_ms, hasta_ms, funding_archivo, on_event=None, capital_usd=CAPITAL_USD):
    cfg = json.loads(json.dumps(config))             # copia propia: el replay no toca la del llamador ni su hash
    if funding_archivo:
        cfg["funding_archive"] = funding_archivo      # solo lectura (``mode=ro``); no entra al hash del informe
    return exam.replay_formula(ventana, cfg, hasta_ms, desde_ms=desde_ms, on_event=on_event, capital_usd=capital_usd)


def comparar(estrategia_id, desde=DESDE_HONESTA, hasta=HASTA_HONESTA, datos=None, *, incluir_reserva=False, carpeta=None,
             snapshot=None, funding_archivo=None, cache_dir=None, reserva_desde_ms=None):
    """Informe de la Terminal oficial (snapshot) y de la estrategia ``estrategia_id`` sobre ``[desde, hasta)`` (fechas AAAA-MM-DD).

    ``datos``: lector con ``bars(product, from_ms, to_ms, **kw)`` y ``funding(product)`` (la historia de velas/funding en caché);
    sin él se usa la caché local sin red (``cache_dir`` o la del trader). Mismos datos y misma ventana para las dos corridas."""
    reserva_ms = qt.load_holdout_ms() if reserva_desde_ms is None else reserva_desde_ms
    desde_ms, hasta_ms, reserva = _validar_ventana(desde, hasta, incluir_reserva, reserva_ms)
    base = snapshot or est.cargar_snapshot()
    config_variante = est.cargar_estrategia(estrategia_id, carpeta, base)
    ruta = est.ruta_overlay(estrategia_id, carpeta)
    with open(ruta, encoding="utf-8") as handle:
        overlay = json.load(handle)
    if datos is None:
        cache = cache_dir or qt.DEFAULT_CACHE
        datos = qt.History(cache, hasta_ms, offline=True)
        fuente = "caché local de velas y funding {} (sin red)".format(os.path.abspath(cache))
    else:
        fuente = getattr(datos, "fuente", None) or "lector de datos {}".format(type(datos).__name__)
    ventana = _Ventana(datos, hasta_ms)
    corridas = {}
    for nombre, config in (("oficial", base["config"]), ("variante", config_variante)):
        corridas[nombre] = _correr(config, ventana, desde_ms, hasta_ms, funding_archivo)
    efectivo = {corrida["desde_ms"] for corrida in corridas.values()}
    if len(efectivo) != 1:
        raise ComparacionError("Las dos corridas no empezaron el mismo día ({}): no son comparables.".format(sorted(efectivo)))
    desde_efectivo = efectivo.pop()
    if desde_efectivo >= hasta_ms:
        raise ComparacionError("La config no deja medir nada en {} → {}: empieza el {}.".format(desde, hasta, qt.stamp(desde_efectivo)))
    informe = {
        "schema": SCHEMA,
        "estrategia": {"id": estrategia_id, "nombre": overlay["nombre"], "descripcion": overlay["descripcion"],
                       "overlay_ruta": os.path.abspath(ruta), "overlay_sha256": est.sha256_overlay(estrategia_id, carpeta),
                       "cambios": overlay["cambios"]},
        "snapshot": {"config_hash": base["config_hash"], "origen": base.get("origen")},
        "ventana": {"desde": desde, "hasta": hasta, "desde_ms": desde_ms, "hasta_ms": hasta_ms,
                    "desde_efectivo": qt.stamp(desde_efectivo), "desde_efectivo_ms": desde_efectivo,
                    "dias": (hasta_ms - desde_efectivo) / qt.DAY_MS, "reserva": reserva},
        "datos": {"fuente": fuente, "hasta_pedido_max": qt.stamp(ventana.max_pedido_ms) if ventana.max_pedido_ms else None,
                  "funding_modelo": base["config"].get("funding_model"), "funding_archivo": funding_archivo,
                  "productos": corridas["oficial"]["productos"]},
        "limites": ["sin noticias (no se evalúan históricas: no hay evidencia limpia)", "sin libro de órdenes (costos del modelo, "
                    "no fills reales)", _limite_posicionamiento(base["config"]), "salida maker por velas, no por libro"],
    }
    for nombre, config in (("oficial", base["config"]), ("variante", config_variante)):
        curvas = corridas[nombre]["curvas"]["formula"]
        informe[nombre] = {"config_hash": est.hash_config(config), "metricas": metricas(curvas, corridas[nombre]["capital_inicial_usd"]),
                           "operaciones": _operaciones(curvas), "funding_completo": corridas[nombre]["funding_complete"],
                           # el booleano de arriba se apaga con UNA hora sin dato; esto dice cuántas operaciones tocaron un hueco
                           "funding_operaciones_incompletas": sum(1 for c in curvas if c["funding_status"] != "complete")}
    informe["diferencia"] = diferencia(informe["oficial"]["metricas"], informe["variante"]["metricas"])
    return informe


# --------------------------------------------------------------------------- S4: replay contra el vivo

SCHEMA_VIVO = "balancita-estrategias-vs-vivo.v1"
TOLERANCIA_OPERACION_MS = qt.BAR_MS            # una vela: el vivo llena segundos después de la señal; el replay, al cierre de la vela
# Tolerancias por operación emparejada (S4). El replay entra al cierre de la vela con el modelo de costos y el vivo llena contra el libro
# unos segundos después, y el saldo del replay es el del vivo solo al empezar (después cada uno compone sus propios netos):
#  - nocional / cantidad: 1 % del vivo o 1 US$ (el tercer cupo es un resto de saldo de ~10 US$: 1 US$ de saldo de diferencia lo mueve 1 US$);
#  - neto, comisiones y funding: se comparan A IGUAL TAMAÑO (el importe del replay escalado al nocional del vivo; el tamaño ya tiene su
#    propia comparación) y se aceptan hasta los bp del nocional vivo de abajo: el neto 2 bp (libro vs. vela, el mismo margen que ya se
#    aceptaba), comisiones y funding 0,5 bp (mismo modelo de costos: solo cambia el precio del fill y la hora de entrada);
#  - horas abierta: una vela (la salida del vivo cae segundos después de la vela del replay).
TOLERANCIAS_IMPORTES = {"nocional_rel": 0.01, "nocional_abs_usd": 1.0, "neto_bp": 2.0, "comisiones_bp": 0.5, "funding_bp": 0.5,
                        "horas_ms": TOLERANCIA_OPERACION_MS}
CAMPOS_IMPORTES = ("nocional_usd", "qty", "neto_usd", "comisiones_usd", "funding_usd", "horas")
NOTA_VIVO = ("Chequeo de equivalencia de código: ¿el replay de la Terminal oficial toma las mismas decisiones que tomó el vivo en el "
             "mismo período? Esto no es una evaluación de estrategia (el período vivo es posterior a la reserva), no registra intentos y su "
             "resultado no se usa para elegir ni promover nada.")
LIMITES_VIVO = [
    "libro público: el vivo llena contra el libro (precio, tamaño y hora del fill); el replay entra al cierre de la vela con el modelo de costos, "
    "así que el neto por operación difiere unos puntos básicos aunque la decisión sea la misma",
    "noticias: el replay no las evalúa; una entrada o un cierre por noticia del vivo aparece como diferencia",
    "esperas: el vivo omite las miradas con el proceso detenido o la vela tarde; esas miradas salen como «solo replay» (hasta 2026-11-09 el "
    "vivo además contaba el enfriamiento de 15 min desde la hora real del fill del cierre y el replay desde la vela; ahora los dos desde la mirada)",
    "las decisiones se comparan una a una: una diferencia cambia las posiciones abiertas y arrastra las siguientes; por eso también se "
    "compara la señal (maestro y portero), que no depende de las posiciones",
]


class LectorCopiaVivo:
    """Las velas de la copia del respaldo del proceso en vivo (``qwen-live_cache__candles-<producto>-<sello>.sqlite``, o
    ``candles-<producto>.sqlite`` en la carpeta de caché del vivo), abiertas SOLO LECTURA. Ofrece lo que ``replay_formula`` pide a la
    historia (``bars`` y ``funding``); el funding lo lee el modelo exacto del archivo del mercado (``funding_archive``)."""

    def __init__(self, carpeta, sello, productos):
        self.carpeta, self.sello = carpeta, sello
        self._rutas = {}
        faltan = []
        for producto in productos:
            candidatas = ([os.path.join(carpeta, "qwen-live_cache__candles-{}-{}.sqlite".format(producto, sello))] if sello else []) + [
                os.path.join(carpeta, "candles-{}.sqlite".format(producto))]
            ruta = next((c for c in candidatas if os.path.isfile(c)), None)
            if ruta is None:
                faltan.append((producto, candidatas[0]))
            else:
                self._rutas[producto] = ruta
        if faltan:
            raise ComparacionError("Faltan las velas de {} en {}: se esperaba {}. Sin velas del período vivo el replay no puede decidir "
                                   "(brecha de datos).".format(", ".join(p for p, _ in faltan), carpeta, "; ".join(r for _, r in faltan)))
        self.fuente = "velas de la copia del vivo en {} (solo lectura)".format(os.path.abspath(carpeta))

    def _abrir(self, producto):
        return sqlite3.connect("file:{}?mode=ro".format(os.path.abspath(self._rutas[producto])), uri=True)

    def bars(self, product, from_ms, to_ms, *, fill=True, annotate=False):
        db = self._abrir(product)
        try:
            filas = db.execute("SELECT t,o,h,l,c,v FROM candles WHERE res='5m' AND t>=? AND t<? ORDER BY t", (from_ms, to_ms)).fetchall()
        finally:
            db.close()
        barras = [{"bucket_start": t, "open": o, "high": h, "low": l, "close": c, "volume_btc": v} for t, o, h, l, c, v in filas]
        return qt.fill_gaps(barras, qt.BAR_MS, annotate=annotate) if fill else barras

    def funding(self, product):
        return []

    def cobertura(self, producto):
        """``(primera vela, última vela)`` de la copia, o ``(None, None)`` vacía."""
        db = self._abrir(producto)
        try:
            return db.execute("SELECT MIN(t), MAX(t) FROM candles WHERE res='5m'").fetchone()
        finally:
            db.close()


def _resumen_decision(d):
    return {"action": d["action"], "kind": d["kind"], "motivo": d["motivo"], "maestro": d["maestro"], "puntaje": d["puntaje"],
            "portero": d["portero"]}


def _hora(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def inicios_de_enfriamiento(operaciones):
    """El instante desde el que el vivo cuenta el enfriamiento de cada operación cerrada. Desde operacion-mejoras T2 la entrada se fecha con la
    mirada (``entry_ms`` es la hora de una vela, múltiplo de 5 min) y el enfriamiento corre desde la mirada que decidió el cierre: la vela en
    que se llenó la salida (segundos después). Las operaciones anteriores fechaban la entrada con el llenado (milisegundos sueltos) y el
    enfriamiento corría desde el llenado de la salida."""
    return [o["exit_ms"] // qt.BAR_MS * qt.BAR_MS if o["entry_ms"] % qt.BAR_MS == 0 else o["exit_ms"]
            for o in operaciones if o["exit_ms"] is not None]


def comparar_decisiones(vivas, replay, *, cooldown_ms=0, omitidos_vivos=None, salidas_vivas=()):
    """Decisión por decisión (una por mirada de 15 min, clave ``t_ms``) entre el vivo y el replay.

    Cada decisión es ``{t_ms, kind, action, maestro, puntaje, portero, motivo}``. ``coinciden``: misma acción; ``difieren``: otra acción
    (se listan con las dos); ``solo_vivo`` / ``solo_replay``: la mirada existe en un solo lado. Una mirada «solo replay» se explica,
    cuando se puede, por una omisión del vivo (``omitidos_vivos`` ``{t_ms: motivo}``) o por el enfriamiento contado desde el instante en
    que el vivo empieza a contarlo tras un cierre (``salidas_vivas``, ``cooldown_ms``: ver ``inicios_de_enfriamiento``). ``senal_coincide``: en cuántas miradas comunes el maestro y el
    portero dicen lo mismo, sin importar las posiciones; ``puntaje_dif_max``: la mayor diferencia del puntaje del maestro."""
    omitidos_vivos = omitidos_vivos or {}
    por_vivo = {d["t_ms"]: d for d in vivas}
    por_replay = {d["t_ms"]: d for d in replay}
    comunes = sorted(set(por_vivo) & set(por_replay))
    diferencias, coinciden, senal, puntaje_max = [], 0, 0, 0.0
    for t in comunes:
        v, r = por_vivo[t], por_replay[t]
        misma_senal = (v["maestro"], v["portero"]) == (r["maestro"], r["portero"])
        senal += misma_senal
        puntaje_max = max(puntaje_max, abs(v["puntaje"] - r["puntaje"]))
        if v["action"] == r["action"]:
            coinciden += 1
        else:
            diferencias.append({"t_ms": t, "hora": _hora(t), "vivo": _resumen_decision(v), "replay": _resumen_decision(r),
                                "misma_senal": misma_senal})
    solo_vivo = [dict(_resumen_decision(por_vivo[t]), t_ms=t, hora=_hora(t)) for t in sorted(set(por_vivo) - set(por_replay))]
    solo_replay = []
    for t in sorted(set(por_replay) - set(por_vivo)):
        explicacion = None
        if t in omitidos_vivos:
            explicacion = "el vivo omitió esa mirada: {}".format(omitidos_vivos[t])
        else:
            cierre = next((c for c in sorted(salidas_vivas) if 0 <= t - c < cooldown_ms), None)
            if cierre is not None:
                explicacion = "enfriamiento: el vivo cerró a las {} y cuenta los {} min desde ahí".format(_hora(cierre), cooldown_ms // qt.MINUTE_MS)
        solo_replay.append(dict(_resumen_decision(por_replay[t]), t_ms=t, hora=_hora(t), explicacion=explicacion))
    return {"vivas": len(por_vivo), "replay": len(por_replay), "comunes": len(comunes), "coinciden": coinciden,
            "difieren": len(diferencias), "solo_vivo": len(solo_vivo), "solo_replay": len(solo_replay),
            "solo_replay_sin_explicar": sum(1 for x in solo_replay if x["explicacion"] is None),
            "senal_coincide": senal, "puntaje_dif_max": puntaje_max,
            "diferencias": diferencias, "lista_solo_vivo": solo_vivo, "lista_solo_replay": solo_replay}


def _resumen_operacion(o):
    return {"side": o["side"], "entry_ms": o["entry_ms"], "entrada": _hora(o["entry_ms"]), "exit_ms": o["exit_ms"],
            "salida": None if o["exit_ms"] is None else _hora(o["exit_ms"]), "neto_bp": o["net_bp"], "estado": o["status"],
            "motivo": o["exit_reason"] or o["closed_by"], "nocional_usd": o.get("notional_usd"), "qty": o.get("qty"),
            "neto_usd": o.get("net_usd"), "comisiones_usd": o.get("fees_usd"), "funding_usd": o.get("funding_usd")}


def _importe(vivo, replay, tolerancia):
    return {"vivo": vivo, "replay": replay, "diferencia": None if vivo is None or replay is None else replay - vivo,
            "dentro": None if vivo is None or replay is None else abs(replay - vivo) <= tolerancia}


def _importes(v, r, cerrada):
    """Tamaño, importes en US$ y horas de un par vivo/replay, cada uno con ``{vivo, replay, diferencia, dentro}`` (``dentro`` es ``None``
    cuando no se puede juzgar: sin dato o la operación vivo sigue abierta). Ver ``TOLERANCIAS_IMPORTES``."""
    tol = TOLERANCIAS_IMPORTES
    nocional_v, nocional_r = v.get("notional_usd"), r.get("notional_usd")
    sin_tamano = not nocional_v or not nocional_r
    out = {"nocional_usd": _importe(nocional_v, nocional_r, max(tol["nocional_rel"] * (nocional_v or 0), tol["nocional_abs_usd"])),
           "qty": _importe(v.get("qty"), r.get("qty"), max(tol["nocional_rel"] * (v.get("qty") or 0),
                                                           tol["nocional_abs_usd"] / (v.get("entry_px") or float("inf"))))}
    for campo, clave, bp in (("neto_usd", "net_usd", tol["neto_bp"]), ("comisiones_usd", "fees_usd", tol["comisiones_bp"]),
                             ("funding_usd", "funding_usd", tol["funding_bp"])):
        vivo, replay = (v.get(clave), r.get(clave)) if cerrada else (None, None)
        item = _importe(vivo, replay, bp / 1e4 * (nocional_v or 0))
        if item["dentro"] is not None and not sin_tamano:
            escalado = replay * nocional_v / nocional_r                      # a igual tamaño: el tamaño se juzga aparte
            item["dentro"] = abs(escalado - vivo) <= bp / 1e4 * nocional_v
        out[campo] = item
    horas = (None, None) if not cerrada else ((v["exit_ms"] - v["entry_ms"]) / qt.HOUR_MS, (r["exit_ms"] - r["entry_ms"]) / qt.HOUR_MS)
    out["horas"] = _importe(horas[0], horas[1], tol["horas_ms"] / qt.HOUR_MS)
    return out


def comparar_operaciones(vivas, replay, tolerancia_ms=TOLERANCIA_OPERACION_MS):
    """Empareja operaciones del vivo con las del replay: mismo lado y entrada a menos de ``tolerancia_ms`` (la más cercana). Cada
    operación es ``{side, entry_ms, exit_ms, net_bp, status, closed_by, exit_reason}`` más, cuando se conocen, ``notional_usd``, ``qty``,
    ``entry_px``, ``net_usd``, ``fees_usd`` y ``funding_usd``. De cada par: si la salida cae en la misma vela, la diferencia de neto
    (replay − vivo) en puntos básicos y, en ``importes``, el tamaño, el neto, las comisiones, el funding y las horas de cada lado con su
    diferencia y si cae dentro de la tolerancia (``TOLERANCIAS_IMPORTES``). Una operación todavía abierta en la copia del vivo no se juzga
    por su salida ni por lo que necesita un cierre. ``importes`` resume por campo cuántos pares se compararon y cuántos quedaron fuera;
    ``fuera_de_tolerancia`` los lista uno por uno."""
    libres = sorted(replay, key=lambda o: o["entry_ms"])
    pares, solo_vivo = [], []
    for v in sorted(vivas, key=lambda o: o["entry_ms"]):
        cerca = [r for r in libres if r["side"] == v["side"] and abs(r["entry_ms"] - v["entry_ms"]) <= tolerancia_ms]
        if not cerca:
            solo_vivo.append(_resumen_operacion(v))
            continue
        r = min(cerca, key=lambda o: abs(o["entry_ms"] - v["entry_ms"]))
        libres.remove(r)
        cerrada = v["status"] == "closed" and v["exit_ms"] is not None
        pares.append({"side": v["side"], "vivo": _resumen_operacion(v), "replay": _resumen_operacion(r),
                      "salida_igual": abs(r["exit_ms"] - v["exit_ms"]) <= tolerancia_ms if cerrada else None,
                      "neto_bp_diferencia": r["net_bp"] - v["net_bp"] if cerrada else None,
                      "importes": _importes(v, r, cerrada)})
    resumen = {campo: {"comparadas": sum(1 for p in pares if p["importes"][campo]["dentro"] is not None),
                       "fuera": sum(1 for p in pares if p["importes"][campo]["dentro"] is False),
                       "dif_max": max((abs(p["importes"][campo]["diferencia"]) for p in pares
                                       if p["importes"][campo]["diferencia"] is not None), default=0.0)} for campo in CAMPOS_IMPORTES}
    fuera = [{"entrada": p["vivo"]["entrada"], "side": p["side"], "campo": campo, "vivo": p["importes"][campo]["vivo"],
              "replay": p["importes"][campo]["replay"], "diferencia": p["importes"][campo]["diferencia"]}
             for p in pares for campo in CAMPOS_IMPORTES if p["importes"][campo]["dentro"] is False]
    return {"vivo": len(vivas), "replay": len(replay), "emparejadas": len(pares), "solo_vivo": len(solo_vivo),
            "solo_replay": len(libres), "abiertas_en_vivo": sum(1 for v in vivas if v["status"] != "closed"),
            "salidas_iguales": sum(1 for p in pares if p["salida_igual"]),
            "tolerancias": dict(TOLERANCIAS_IMPORTES), "importes": resumen, "fuera_de_tolerancia": fuera,
            "pares": pares, "lista_solo_vivo": solo_vivo, "lista_solo_replay": [_resumen_operacion(r) for r in libres]}


def _leer_vivo(ruta, hash_config, productos):
    """Lo que el vivo registró con la config ``hash_config`` (solo lectura): cuándo se activó, sus decisiones, operaciones y las
    miradas que omitió."""
    if not os.path.isfile(ruta):
        raise ComparacionError("La base viva no existe: {}.".format(ruta))
    marcas = ",".join("?" * len(productos))
    try:
        db = sqlite3.connect("file:{}?mode=ro".format(os.path.abspath(ruta)), uri=True)
        try:
            activada, saldo = db.execute("SELECT activated_ms, cash_usd FROM config_versions WHERE config_hash=? ORDER BY activated_ms LIMIT 1",
                                         (hash_config,)).fetchone() or (None, None)
            filas = db.execute("SELECT t_ms, kind, action, formula_json FROM decisions WHERE config_hash=? AND product IN ({}) "
                               "ORDER BY t_ms".format(marcas), (hash_config, *productos)).fetchall()
            trades = db.execute("SELECT side, entry_ms, exit_ms, net_bp, status, closed_by, exit_reason, notional_usd, qty, entry_px, "
                                "fees_usd, funding_usd, net_usd FROM trades WHERE config_hash=? AND product IN ({}) ORDER BY entry_ms".format(marcas),
                                (hash_config, *productos)).fetchall()
            omitidos = db.execute("SELECT t_ms, reason FROM skipped WHERE product IN ({})".format(marcas), tuple(productos)).fetchall()
        finally:
            db.close()
    except sqlite3.Error as error:
        raise ComparacionError("La base viva {} no se pudo leer (solo lectura): {}.".format(ruta, error)) from error
    if not filas:
        raise ComparacionError("La base viva {} no tiene decisiones de la config {}…: no corrió esta versión de la Terminal "
                               "(hay que dar la copia de la base que la operó).".format(ruta, hash_config[:12]))
    decisiones = []
    for t_ms, kind, action, formula_json in filas:
        formula = json.loads(formula_json) if formula_json else {}
        decisiones.append({"t_ms": t_ms, "kind": kind, "action": action, "maestro": formula.get("maestro"),
                           "puntaje": float(formula.get("puntaje") or 0.0),
                           "portero": (formula.get("portero_autonomo") or {}).get("side"), "motivo": formula.get("motivo")})
    numero = lambda texto: None if texto in (None, "") else float(texto)
    return {"activada_ms": activada, "saldo_inicial_usd": numero(saldo), "saldo_inicial_texto": saldo,
            "decisiones": decisiones, "omitidos": dict(omitidos),
            "operaciones": [{"side": side, "entry_ms": entrada, "exit_ms": salida, "net_bp": neto, "status": estado, "closed_by": cerrada,
                             "exit_reason": razon, "notional_usd": numero(nocional), "qty": numero(qty), "entry_px": numero(precio),
                             "fees_usd": numero(comisiones), "funding_usd": numero(funding), "net_usd": numero(neto_usd)}
                            for side, entrada, salida, neto, estado, cerrada, razon, nocional, qty, precio, comisiones, funding, neto_usd
                            in trades]}


def _fecha_de(ms):
    return qt.stamp(ms)[:10]


def comparar_con_vivo(desde=None, hasta=None, *, live_db, datos=None, snapshot=None, funding_archivo=None, velas_dir=None,
                      reserva_desde_ms=None):
    """Repite la Terminal oficial (snapshot) con el replay real sobre el período en que corrió el vivo y lo compara con sus
    ``decisions`` y ``trades`` (``live_db``: copia de ``qwen-live__live-<sello>.sqlite``, solo lectura).

    ``desde`` / ``hasta`` (AAAA-MM-DD, ``hasta`` exclusivo): sin ellos, del día en que se activó esa config al día siguiente de su
    última decisión. La ventana efectiva empieza en la vela siguiente a la activación (el vivo empieza plano ahí) y no mira nada
    anterior. ``datos``: lector con ``bars``/``funding``; sin él, las velas de la copia del respaldo (``velas_dir``, por defecto la
    carpeta de ``live_db``; ``qwen-live_cache__candles-<producto>-<sello>.sqlite``) y, para el funding exacto, el
    ``futures-market-<sello>.sqlite`` de esa carpeta si existe. Es un chequeo de equivalencia de código, NO una evaluación de estrategia:
    no se registran intentos ni se rechaza la reserva (el período vivo es posterior a ella), y el informe lo marca."""
    reserva_ms = qt.load_holdout_ms() if reserva_desde_ms is None else reserva_desde_ms
    base = snapshot or est.cargar_snapshot()
    config = base["config"]
    productos = list(config["exam"]["products"])
    vivo = _leer_vivo(live_db, base["config_hash"], productos)
    primera, ultima = vivo["decisiones"][0]["t_ms"], vivo["decisiones"][-1]["t_ms"]
    activada = vivo["activada_ms"] if vivo["activada_ms"] is not None else primera - qt.BAR_MS
    desde = _fecha_de(activada) if desde is None else desde
    hasta = _fecha_de(ultima + qt.DAY_MS) if hasta is None else hasta
    desde_ms, hasta_ms = _fecha_ms(desde, "desde"), _fecha_ms(hasta, "hasta")
    if desde_ms >= hasta_ms:
        raise ComparacionError("La ventana está vacía: desde ({}) tiene que ser anterior a hasta ({}).".format(desde, hasta))
    desde_efectivo = -(-max(desde_ms, activada) // qt.BAR_MS) * qt.BAR_MS
    nombre = os.path.basename(live_db)
    sello = (re.match(r"^qwen-live__live-(.+)\.sqlite$", nombre) or [None, None])[1]
    carpeta = velas_dir or os.path.dirname(os.path.abspath(live_db))
    if datos is None:
        datos = LectorCopiaVivo(carpeta, sello, sorted(set(productos) | set(config.get("state_context") or ())))
    if funding_archivo is None and sello and os.path.isfile(os.path.join(carpeta, "futures-market-{}.sqlite".format(sello))):
        funding_archivo = os.path.join(carpeta, "futures-market-{}.sqlite".format(sello))
    ventana = _Ventana(datos, hasta_ms)
    decisiones_replay, operaciones_replay, omitidos_replay = [], [], {}

    def al_evento(evento):
        if evento["type"] == "decision":
            f = evento["formula"]
            decisiones_replay.append({"t_ms": evento["t_ms"], "kind": evento["kind"], "action": evento["action"], "maestro": f["maestro"],
                                      "puntaje": float(f["puntaje"]), "portero": (f.get("portero_autonomo") or {}).get("side"),
                                      "motivo": f["motivo"]})
        elif evento["type"] == "trade":
            t = evento["trade"]
            operaciones_replay.append({"side": t["side"], "entry_ms": t["entry_ms"], "exit_ms": t["exit_ms"], "net_bp": t["net_bp"],
                                       "status": "closed", "closed_by": t["closed_by"], "exit_reason": t.get("exit_reason"),
                                       "notional_usd": float(t["notional_usd"]), "qty": float(t["qty"]), "entry_px": float(t["entry_px"]),
                                       "fees_usd": float(t["fees_usd"]), "funding_usd": float(t["funding_usd"]), "net_usd": float(t["net_usd"])})
        elif evento["type"] == "skipped":
            omitidos_replay[evento["kind"]] = omitidos_replay.get(evento["kind"], 0) + 1

    # el replay empieza con el saldo que tenía la Terminal al activarse esa config: cada posición toma su fracción del saldo del momento
    con_saldo = bool(vivo["saldo_inicial_usd"] and vivo["saldo_inicial_usd"] > 0)
    saldo_inicial = vivo["saldo_inicial_usd"] if con_saldo else float(CAPITAL_USD)
    corrida = _correr(config, ventana, desde_efectivo, hasta_ms, funding_archivo, al_evento,
                      capital_usd=vivo["saldo_inicial_texto"] if con_saldo else CAPITAL_USD)
    inicio = corrida["desde_ms"]
    vivas = [d for d in vivo["decisiones"] if inicio <= d["t_ms"] <= hasta_ms]
    operaciones_vivas = [o for o in vivo["operaciones"] if inicio <= o["entry_ms"] <= hasta_ms]
    if not vivas:
        raise ComparacionError("La ventana {} → {} no contiene decisiones del vivo de esta config (hay de {} a {}).".format(
            desde, hasta, _hora(primera), _hora(ultima)))
    cooldown_ms = int(config["guardrails"].get("cooldown_min") or 0) * qt.MINUTE_MS
    salidas = inicios_de_enfriamiento(vivo["operaciones"])
    decisiones = comparar_decisiones(vivas, decisiones_replay, cooldown_ms=cooldown_ms, omitidos_vivos=vivo["omitidos"], salidas_vivas=salidas)
    operaciones = comparar_operaciones(operaciones_vivas, operaciones_replay)
    cobertura, avisos = {}, []
    for producto in sorted(set(productos) | set(config.get("state_context") or ())):
        if not hasattr(datos, "cobertura"):
            break
        primera_vela, ultima_vela = datos.cobertura(producto)
        necesita = inicio - config["practice"]["warmup_days"] * qt.DAY_MS - (analista.extra_days(config) * qt.DAY_MS if producto in productos else 0)
        completa = primera_vela is not None and primera_vela <= necesita
        cobertura[producto] = {"desde_ms": primera_vela, "hasta_ms": ultima_vela, "necesita_desde_ms": necesita, "completa": completa}
        if not completa:
            avisos.append("velas de {}: la copia empieza el {} y el replay necesita desde el {} (calentamiento): las decisiones del "
                          "principio no son comparables".format(producto, "nunca" if primera_vela is None else _hora(primera_vela), _hora(necesita)))
    reserva = {"incluida": hasta_ms > reserva_ms, "desde": qt.stamp(reserva_ms),
               "aviso": "El período vivo es posterior a la reserva ({} en adelante): esto es una verificación de código, no una medición; "
                        "el resultado no sirve para elegir ni decidir y no se registran intentos.".format(qt.stamp(reserva_ms))}
    return {
        "schema": SCHEMA_VIVO, "nota": NOTA_VIVO,
        "snapshot": {"config_hash": base["config_hash"], "origen": base.get("origen")},
        "vivo": {"base": os.path.abspath(live_db), "activada_ms": vivo["activada_ms"], "saldo_inicial_usd": saldo_inicial,
                 "activada": None if vivo["activada_ms"] is None else _hora(vivo["activada_ms"]),
                 "primera_decision": _hora(primera), "ultima_decision": _hora(ultima), "decisiones_totales": len(vivo["decisiones"])},
        "ventana": {"desde": desde, "hasta": hasta, "desde_ms": desde_ms, "hasta_ms": hasta_ms, "desde_efectivo_ms": inicio,
                    "desde_efectivo": _hora(inicio), "reserva": reserva},
        "datos": {"fuente": getattr(datos, "fuente", None) or "lector de datos {}".format(type(datos).__name__),
                  "funding_modelo": config.get("funding_model"), "funding_archivo": funding_archivo,
                  "hasta_pedido_max": qt.stamp(ventana.max_pedido_ms) if ventana.max_pedido_ms else None,
                  "cobertura": cobertura, "avisos": avisos, "replay_omitidos": omitidos_replay},
        "decisiones": decisiones, "operaciones": operaciones, "limites": list(LIMITES_VIVO),
    }


# --------------------------------------------------------------------------- salida


def _num(valor, decimales=2, suf=""):
    return "n/d" if valor is None else "{:.{}f}{}".format(valor, decimales, suf)


def _signo(valor, decimales=2):
    return "n/d" if valor is None else "{:+.{}f}".format(valor, decimales)


def _fin_ventana(metricas_):
    cerradas = metricas_["cerradas_fin_ventana"]
    return "{} ({:+.2f} US$)".format(cerradas["operaciones"], cerradas["neto_usd"])


def texto(informe):
    est_, ven, dat = informe["estrategia"], informe["ventana"], informe["datos"]
    lineas = ["Estrategia {} — {}".format(est_["id"], est_["nombre"]), "  overlay sha256 {}".format(est_["overlay_sha256"]),
              "  cambios {}".format(json.dumps(est_["cambios"], ensure_ascii=False, sort_keys=True)),
              "Snapshot de la Terminal {}".format(informe["snapshot"]["config_hash"]),
              "Ventana {} → {} ({:.1f} días; empieza efectivamente el {})".format(
                  ven["desde"], ven["hasta"], ven["dias"], ven["desde_efectivo"]),
              "Datos: {}".format(dat["fuente"])]
    if ven["reserva"]["incluida"]:
        lineas.append("*** RESERVA TOCADA *** " + ven["reserva"]["aviso"])
    filas = [("Operaciones", "operaciones", lambda v: "n/d" if v is None else "{:d}".format(int(v)), lambda v: _signo(v, 0)),
             ("Neto USD", "neto_usd", lambda v: _num(v, 2), _signo),
             ("Neto bp (cuenta)", "neto_bp_cuenta", lambda v: _num(v, 1), lambda v: _signo(v, 1)),
             ("Neto bp/op (ponderado)", "neto_bp_por_operacion", lambda v: _num(v, 1), lambda v: _signo(v, 1)),
             ("Nocional promedio USD", "nocional_promedio_usd", lambda v: _num(v, 0), lambda v: _signo(v, 0)),
             ("Acierto", "acierto", lambda v: "n/d" if v is None else "{:.0f} %".format(v * 100),
              lambda v: "n/d" if v is None else "{:+.0f} pp".format(v * 100)),
             ("Máx. drawdown USD", "max_drawdown_usd", lambda v: _num(v, 2), _signo),
             ("Máx. drawdown bp", "max_drawdown_bp", lambda v: _num(v, 0), lambda v: _signo(v, 0)),
             ("Horas promedio", "horas_promedio", lambda v: _num(v, 1), lambda v: _signo(v, 1)),
             ("Horas máximo", "horas_max", lambda v: _num(v, 1), lambda v: _signo(v, 1))]
    lineas += ["", "{:<26}{:>14}{:>14}{:>14}".format("", "Oficial", "Variante", "Diferencia")]
    for etiqueta, clave, fmt, fmt_dif in filas:
        lineas.append("{:<26}{:>14}{:>14}{:>14}".format(etiqueta, fmt(informe["oficial"]["metricas"][clave]),
                                                       fmt(informe["variante"]["metricas"][clave]), fmt_dif(informe["diferencia"][clave])))
    lineas += ["", "Config oficial {}".format(informe["oficial"]["config_hash"]), "Config variante {}".format(informe["variante"]["config_hash"]),
               "Salidas oficial {}; variante {}".format(informe["oficial"]["metricas"]["por_motivo"], informe["variante"]["metricas"]["por_motivo"]),
               "Cerradas al final de la ventana (fuera de las métricas): oficial {}; variante {}".format(
                   _fin_ventana(informe["oficial"]["metricas"]), _fin_ventana(informe["variante"]["metricas"])),
               "Límites: " + "; ".join(informe["limites"])]
    return "\n".join(lineas)


def texto_vivo(informe):
    ven, dat, dec, ope, viv = informe["ventana"], informe["datos"], informe["decisiones"], informe["operaciones"], informe["vivo"]
    lineas = ["Replay contra el vivo — Terminal oficial {}".format(informe["snapshot"]["config_hash"]),
              "  " + informe["nota"],
              "Vivo: {} (activada {}; decisiones {} → {}, {} en total)".format(
                  viv["base"], viv["activada"] or "n/d", viv["primera_decision"], viv["ultima_decision"], viv["decisiones_totales"]),
              "Ventana {} → {} (empieza efectivamente el {} UTC)".format(ven["desde"], ven["hasta"], ven["desde_efectivo"]),
              "Datos: {}".format(dat["fuente"]),
              "Funding: {} ({})".format(dat["funding_modelo"], dat["funding_archivo"] or "sin archivo")]
    if ven["reserva"]["incluida"]:
        lineas.append("*** PERÍODO POSTERIOR A LA RESERVA *** " + ven["reserva"]["aviso"])
    lineas += ["  aviso de datos: " + aviso for aviso in dat["avisos"]]
    lineas += ["", "Decisiones (una por mirada de 15 min): vivo {}, replay {}".format(dec["vivas"], dec["replay"]),
               "  coinciden {} · difieren {} · solo vivo {} · solo replay {} (sin explicar {})".format(
                   dec["coinciden"], dec["difieren"], dec["solo_vivo"], dec["solo_replay"], dec["solo_replay_sin_explicar"]),
               "  misma señal (maestro y portero) en {} de {} miradas comunes; diferencia máxima del puntaje {:.6f}".format(
                   dec["senal_coincide"], dec["comunes"], dec["puntaje_dif_max"])]
    for d in dec["diferencias"][:20]:
        lineas.append("  ≠ {} vivo {} ({}) / replay {} ({})".format(d["hora"], d["vivo"]["action"], d["vivo"]["motivo"], d["replay"]["action"], d["replay"]["motivo"]))
    for d in dec["lista_solo_vivo"][:20]:
        lineas.append("  solo vivo {} {} ({})".format(d["hora"], d["action"], d["motivo"]))
    explicadas = {}
    for d in dec["lista_solo_replay"]:
        clave = (d["explicacion"] or "sin explicación").split(":")[0]
        explicadas[clave] = explicadas.get(clave, 0) + 1
    if explicadas:
        lineas.append("  solo replay por causa: " + "; ".join("{} × {}".format(n, c) for c, n in sorted(explicadas.items())))
    lineas += ["", "Operaciones: vivo {}, replay {} · emparejadas {} (salida en la misma vela: {}) · solo vivo {} · solo replay {} · abiertas en vivo {}".format(
        ope["vivo"], ope["replay"], ope["emparejadas"], ope["salidas_iguales"], ope["solo_vivo"], ope["solo_replay"], ope["abiertas_en_vivo"])]
    for p in ope["pares"]:
        dif = "n/d" if p["neto_bp_diferencia"] is None else "{:+.1f} bp".format(p["neto_bp_diferencia"])
        lineas.append("  {} entrada {} / {} · salida {} / {} · neto replay − vivo {}".format(
            p["side"], p["vivo"]["entrada"], p["replay"]["entrada"], p["vivo"]["salida"] or "abierta", p["replay"]["salida"], dif))
    lineas += ["", "Tamaño e importes por operación emparejada (replay − vivo; tolerancia: nocional y cantidad {:.0f} % o {:.0f} US$, "
               "neto {} bp, comisiones {} bp, funding {} bp del nocional vivo a igual tamaño, horas {:.0f} min); saldo inicial {:.2f} US$".format(
                   ope["tolerancias"]["nocional_rel"] * 100, ope["tolerancias"]["nocional_abs_usd"], ope["tolerancias"]["neto_bp"],
                   ope["tolerancias"]["comisiones_bp"], ope["tolerancias"]["funding_bp"], ope["tolerancias"]["horas_ms"] / qt.MINUTE_MS,
                   viv["saldo_inicial_usd"])]
    for campo in CAMPOS_IMPORTES:
        r = ope["importes"][campo]
        lineas.append("  {:<15} comparadas {:>2} · fuera de tolerancia {:>2} · diferencia máxima {:.4f}".format(
            campo, r["comparadas"], r["fuera"], r["dif_max"]))
    for x in ope["fuera_de_tolerancia"][:30]:
        lineas.append("  ≠ {} {} {}: vivo {:.4f} / replay {:.4f} ({:+.4f})".format(x["entrada"], x["side"], x["campo"], x["vivo"], x["replay"], x["diferencia"]))
    for p in ope["pares"]:
        imp = p["importes"]
        lineas.append("  {} {} nocional {:.2f}/{:.2f} · neto US$ {} · comisiones {} · funding {} · horas {}".format(
            p["side"], p["vivo"]["entrada"], imp["nocional_usd"]["vivo"] or 0, imp["nocional_usd"]["replay"] or 0,
            *("n/d" if imp[c]["diferencia"] is None else "{:+.4f}".format(imp[c]["diferencia"])
              for c in ("neto_usd", "comisiones_usd", "funding_usd", "horas"))))
    lineas.append("")
    for o in ope["lista_solo_vivo"]:
        lineas.append("  solo vivo {} {}".format(o["side"], o["entrada"]))
    for o in ope["lista_solo_replay"]:
        lineas.append("  solo replay {} {}".format(o["side"], o["entrada"]))
    lineas += ["", "Límites: " + "; ".join(informe["limites"])]
    return "\n".join(lineas)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m balancita_engine.futures_estrategias_backtest", description=__doc__.split("\n")[0])
    parser.add_argument("--estrategia", default=None, help="id de config/estrategias/<id>.json (obligatorio salvo con --vs-vivo)")
    parser.add_argument("--desde", default=None, help="AAAA-MM-DD (por defecto {}; con --vs-vivo, el día en que se activó la config en vivo)".format(DESDE_HONESTA))
    parser.add_argument("--hasta", default=None, help="AAAA-MM-DD, exclusivo (por defecto {}; con --vs-vivo, el día siguiente a la última decisión en vivo)".format(HASTA_HONESTA))
    parser.add_argument("--json", action="store_true", help="el informe completo en JSON")
    parser.add_argument("--incluir-reserva", action="store_true", help="permite una ventana que entra en la reserva (queda marcada)")
    parser.add_argument("--cache-dir", default=None, help="caché de velas y funding (por defecto la del trader; con --vs-vivo, la carpeta con las velas del vivo)")
    parser.add_argument("--funding-archivo", default=None, help="base con el funding observado (solo lectura)")
    parser.add_argument("--vs-vivo", action="store_true", help="compara el replay de la Terminal oficial con las decisiones y operaciones del vivo "
                        "(equivalencia de código, no una evaluación; no registra intentos)")
    parser.add_argument("--live-db", default=None, help="con --vs-vivo: copia de qwen-live__live-<sello>.sqlite (solo lectura); las velas y el "
                        "funding se buscan en su carpeta")
    args = parser.parse_args(argv)
    if not args.vs_vivo and not args.estrategia:
        parser.error("the following arguments are required: --estrategia")
    if args.vs_vivo and not args.live_db:
        parser.error("--vs-vivo necesita --live-db RUTA (la copia de qwen-live__live-<sello>.sqlite, solo lectura)")
    try:
        if args.vs_vivo:
            informe = comparar_con_vivo(args.desde, args.hasta, live_db=args.live_db, funding_archivo=args.funding_archivo,
                                        velas_dir=args.cache_dir)
        else:
            informe = comparar(args.estrategia, args.desde or DESDE_HONESTA, args.hasta or HASTA_HONESTA, incluir_reserva=args.incluir_reserva,
                               cache_dir=args.cache_dir, funding_archivo=args.funding_archivo)
    except (est.EstrategiaError, qt.TraderError) as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(informe, ensure_ascii=False, indent=1, sort_keys=True))
    else:
        print(texto_vivo(informe) if args.vs_vivo else texto(informe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
