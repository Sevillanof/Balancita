"""Laboratorio de estrategias: compara la Terminal oficial (snapshot) contra una variante sobre la MISMA ventana y los MISMOS datos.

Las dos configuraciones corren con ``futures_qwen_trader_exam.replay_formula`` (el ``Trader`` real del paper vivo), cada una con su
config completa explícita (sin variables de entorno). Los dos replays reciben el mismo lector de datos, limitado a ``hasta`` (nada
de ``hasta`` en adelante se lee), así que no hay look-ahead. No escribe nada: ni bases, ni el registro de intentos, ni archivos.

Uso::

    python -m balancita_engine.futures_estrategias_backtest --estrategia <id> [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]

La ventana por defecto es la honesta (2026-02-01 → 2026-04-19: del ajuste de los expertos fríos a la reserva). Una ventana que
entra en la reserva (desde 2026-04-19) se rechaza salvo ``--incluir-reserva``, y el informe la marca.
"""

import argparse
import json
import os
import sys
from decimal import Decimal

from . import futures_estrategias as est
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as exam

SCHEMA = "balancita-estrategias-comparacion.v1"
DESDE_HONESTA, HASTA_HONESTA = "2026-02-01", "2026-04-19"
CAPITAL_USD = "1000"
# métricas numéricas que se restan (variante − oficial)
NUMERICAS = ("operaciones", "neto_usd", "neto_bp_cuenta", "neto_bp_por_operacion", "acierto", "max_drawdown_usd",
             "max_drawdown_bp", "horas_promedio")


class ComparacionError(est.EstrategiaError):
    pass


# --------------------------------------------------------------------------- métricas


def metricas(curvas, capital_usd=CAPITAL_USD):
    """Métricas de una corrida a partir de sus operaciones (``replay_formula()["curvas"]["formula"]``), todas después de costos.

    - ``neto_usd``: suma del neto de cada operación; ``neto_bp_cuenta``: ese neto sobre el capital inicial (puntos básicos de la
      cuenta); ``neto_bp_por_operacion``: promedio del ``neto_bp`` de cada operación (sobre lo que arriesgó cada una).
    - ``acierto``: parte de las operaciones con neto > 0 (``None`` sin operaciones).
    - ``max_drawdown_usd`` / ``_bp``: la mayor caída del saldo realizado desde su máximo (el saldo cambia cuando cierra cada
      operación, en orden de salida); ``_bp`` es esa caída sobre el máximo previo (el mayor de los cocientes).
    - ``horas_promedio``: tiempo abierta de cada operación."""
    capital = Decimal(str(capital_usd))
    ordenadas = sorted(curvas, key=lambda c: (c["salida_ms"], c["entrada_ms"]))
    saldo = pico = capital
    caida, caida_rel = Decimal(0), Decimal(0)
    neto = Decimal(0)
    ganadoras = 0
    for curva in ordenadas:
        pnl = Decimal(str(curva["pnl_usd"]))
        neto += pnl
        ganadoras += pnl > 0
        saldo += pnl
        pico = max(pico, saldo)
        caida = max(caida, pico - saldo)
        caida_rel = max(caida_rel, (pico - saldo) / pico)
    n = len(ordenadas)
    por_motivo = {}
    for curva in ordenadas:
        por_motivo[curva["motivo"]] = por_motivo.get(curva["motivo"], 0) + 1
    return {
        "operaciones": n,
        "neto_usd": float(neto),
        "neto_bp_cuenta": float(neto / capital * 10000),
        "neto_bp_por_operacion": sum(c["neto_bp"] for c in ordenadas) / n if n else None,
        "acierto": ganadoras / n if n else None,
        "max_drawdown_usd": float(caida),
        "max_drawdown_bp": float(caida_rel * 10000),
        "horas_promedio": sum(c["salida_ms"] - c["entrada_ms"] for c in ordenadas) / n / qt.HOUR_MS if n else None,
        "por_motivo": por_motivo,
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


# --------------------------------------------------------------------------- comparación


def _operaciones(curvas):
    return [{"entrada_ms": c["entrada_ms"], "salida_ms": c["salida_ms"], "lado": "LONG" if c["lado"] > 0 else "SHORT",
             "neto_usd": float(Decimal(str(c["pnl_usd"]))), "neto_bp": c["neto_bp"], "motivo": c["motivo"]} for c in curvas]


def _correr(config, ventana, desde_ms, hasta_ms, funding_archivo):
    cfg = json.loads(json.dumps(config))             # copia propia: el replay no toca la del llamador ni su hash
    if funding_archivo:
        cfg["funding_archive"] = funding_archivo      # solo lectura (``mode=ro``); no entra al hash del informe
    return exam.replay_formula(ventana, cfg, hasta_ms, desde_ms=desde_ms)


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
                    "no fills reales)", "sin posicionamiento", "salida maker por velas, no por libro"],
    }
    for nombre, config in (("oficial", base["config"]), ("variante", config_variante)):
        curvas = corridas[nombre]["curvas"]["formula"]
        informe[nombre] = {"config_hash": est.hash_config(config), "metricas": metricas(curvas, corridas[nombre]["capital_inicial_usd"]),
                           "operaciones": _operaciones(curvas), "funding_completo": corridas[nombre]["funding_complete"]}
    informe["diferencia"] = diferencia(informe["oficial"]["metricas"], informe["variante"]["metricas"])
    return informe


# --------------------------------------------------------------------------- salida


def _num(valor, decimales=2, suf=""):
    return "n/d" if valor is None else "{:.{}f}{}".format(valor, decimales, suf)


def _signo(valor, decimales=2):
    return "n/d" if valor is None else "{:+.{}f}".format(valor, decimales)


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
             ("Neto bp por operación", "neto_bp_por_operacion", lambda v: _num(v, 1), lambda v: _signo(v, 1)),
             ("Acierto", "acierto", lambda v: "n/d" if v is None else "{:.0f} %".format(v * 100),
              lambda v: "n/d" if v is None else "{:+.0f} pp".format(v * 100)),
             ("Máx. drawdown USD", "max_drawdown_usd", lambda v: _num(v, 2), _signo),
             ("Máx. drawdown bp", "max_drawdown_bp", lambda v: _num(v, 0), lambda v: _signo(v, 0)),
             ("Horas promedio", "horas_promedio", lambda v: _num(v, 1), lambda v: _signo(v, 1))]
    lineas += ["", "{:<24}{:>14}{:>14}{:>14}".format("", "Oficial", "Variante", "Diferencia")]
    for etiqueta, clave, fmt, fmt_dif in filas:
        lineas.append("{:<24}{:>14}{:>14}{:>14}".format(etiqueta, fmt(informe["oficial"]["metricas"][clave]),
                                                       fmt(informe["variante"]["metricas"][clave]), fmt_dif(informe["diferencia"][clave])))
    lineas += ["", "Config oficial {}".format(informe["oficial"]["config_hash"]), "Config variante {}".format(informe["variante"]["config_hash"]),
               "Salidas oficial {}; variante {}".format(informe["oficial"]["metricas"]["por_motivo"], informe["variante"]["metricas"]["por_motivo"]),
               "Límites: " + "; ".join(informe["limites"])]
    return "\n".join(lineas)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m balancita_engine.futures_estrategias_backtest", description=__doc__.split("\n")[0])
    parser.add_argument("--estrategia", required=True, help="id de config/estrategias/<id>.json")
    parser.add_argument("--desde", default=DESDE_HONESTA, help="AAAA-MM-DD (por defecto %(default)s)")
    parser.add_argument("--hasta", default=HASTA_HONESTA, help="AAAA-MM-DD, exclusivo (por defecto %(default)s)")
    parser.add_argument("--json", action="store_true", help="el informe completo en JSON")
    parser.add_argument("--incluir-reserva", action="store_true", help="permite una ventana que entra en la reserva (queda marcada)")
    parser.add_argument("--cache-dir", default=None, help="caché de velas y funding (por defecto la del trader)")
    parser.add_argument("--funding-archivo", default=None, help="base con el funding observado (solo lectura)")
    args = parser.parse_args(argv)
    try:
        informe = comparar(args.estrategia, args.desde, args.hasta, incluir_reserva=args.incluir_reserva,
                           cache_dir=args.cache_dir, funding_archivo=args.funding_archivo)
    except (est.EstrategiaError, qt.TraderError) as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 2
    print(json.dumps(informe, ensure_ascii=False, indent=1, sort_keys=True) if args.json else texto(informe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
