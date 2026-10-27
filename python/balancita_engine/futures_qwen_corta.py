"""La FICHA CORTA de Qwen en vivo (versión 8): cuatro renglones y las reglas, nada más.

Qwen ya no lee los ocho renglones de números de la ficha (``futures_qwen_ficha``): dos fórmulas fijas en CPU los leen por él y
le dicen el resultado en una línea cada una, y él supervisa y decide entrar y salir.

    1. El MAESTRO (``futures_qwen_maestro``): dirección y claridad a 12 h (sube/baja, fuerte/flojo/nada), con su puntaje.
    2. El PORTERO (``futures_qwen_portero``): si conviene tomar esa señal ahora (probabilidad de ganar tras costos).
    3. La VOLATILIDAD: alta / normal / baja (rango de 24 h contra el promedio de 7 días) y el movimiento esperable en 24 h.
    4. La POSICIÓN abierta: lado, horas, resultado si cierra ahora con todos los costos, qué dice el maestro ahora respecto de
       ella y cuánto falta para el cierre obligatorio (48 h). Sin posición: «ninguna».

Los datos viejos o incompletos NO se le muestran: ``check`` levanta ``WakeSkipped(datos_incompletos)`` cuando faltan los otros
activos (fuerza relativa), el área de valor o la volatilidad de la semana, y ese despertar queda anotado como omitido sin
preguntar nada (``futures_qwen_live`` ya omite los despertares tarde). En el espejo (``sg`` = -1) se da vuelta SOLO el maestro
(dirección y signo del puntaje); el portero, la volatilidad y los costos son los mismos, y la posición no existe (el espejo solo
se pregunta sin posición). Las dos fórmulas se cargan de los archivos que nombra ``cfg["corta"]`` y sus hashes tienen que ser
los que la config declara: cambiar una fórmula es cambiar de versión.
"""

import math
import os

from . import futures_qwen_ficha as ficha
from . import futures_qwen_maestro as maestro
from . import futures_qwen_portero as portero
from . import futures_qwen_trader as qt

VOL_HIGH, VOL_LOW = 1.25, 0.8                   # rango de 24 h contra el promedio de 7 días
WORDS = {2: "SUBE FUERTE", 1: "SUBE FLOJO", 0: "NADA CLARO", -1: "BAJA FLOJO", -2: "BAJA FUERTE"}
_LOADED = {}


def formulas(cfg):
    """``(maestro, portero)`` de la config, cargados una vez por archivo y verificados contra los hashes declarados."""
    spec = cfg.get("corta") or {}
    for key in ("maestro", "maestro_hash", "portero", "portero_hash"):
        if not spec.get(key):
            raise qt.TraderError("la ficha corta necesita corta.{} en la config".format(key))
    out = []
    for name, loader, hasher in (("maestro", maestro.load, maestro.teacher_hash), ("portero", portero.load, portero.portero_hash)):
        path = spec[name] if os.path.isabs(spec[name]) else os.path.join(qt.ROOT, "config", spec[name])
        cached = _LOADED.get(path)
        if cached is None:
            cached = _LOADED[path] = loader(path)
        got = hasher(cached)
        if not got.startswith(spec[name + "_hash"]):
            raise qt.TraderError("{}: el archivo {} tiene hash {}, la config declara {}: es otra fórmula, hace falta otra versión".format(
                name, path, got[:12], spec[name + "_hash"]))
        out.append(cached)
    return tuple(out)


def missing(f):
    """Qué le falta a la foto para que la ficha corta sea completa (lista vacía: nada)."""
    gaps = []
    if f.get("strength") is None:
        gaps.append("otros activos")
    if f.get("area") is None:
        gaps.append("área de valor")
    if f.get("realized") is None:
        gaps.append("volatilidad de la semana")
    return gaps


def check(trader, t_ms):
    """Antes de preguntar: con datos incompletos no se pregunta (``WakeSkipped`` -> despertar omitido, nunca una decisión)."""
    gaps = missing(ficha.facts(trader, t_ms))
    if gaps:
        raise qt.WakeSkipped("datos_incompletos", "faltan " + " y ".join(gaps))


def readings(trader, t_ms, f=None):
    """Los números de la foto: hechos aplanados, puntaje y veredicto del maestro, probabilidad y veredicto del portero, régimen.
    ``f``: los hechos de la ficha ya calculados (``ficha.facts``), para no repetirlos."""
    teacher, keeper = formulas(trader.cfg)
    f = ficha.facts(trader, t_ms) if f is None else f
    row = maestro.flat_facts(f)
    s = maestro.score(teacher, row)
    v = maestro.verdict_of(teacher, s)
    yes, p = portero.verdict(keeper, row, s)
    ratio = f["range24"] / f["range7"] if f["range7"] > 0 else 1.0
    regime = "ALTA" if ratio >= VOL_HIGH else "BAJA" if ratio <= VOL_LOW else "NORMAL"
    return {"hechos": row, "puntaje": s, "veredicto": v, "portero_p": p, "portero_si": yes, "vol_ratio": ratio, "volatilidad": regime,
            "sigma24": trader._sigma5() * math.sqrt(qt.H24), "range24": f["range24"], "range7": f["range7"]}


def lines(trader, t_ms, sg, reasons):
    """Los renglones de la ficha corta (orientación real con ``sg`` = 1, espejo con -1), sin la cola de reglas y posición."""
    teacher, keeper = formulas(trader.cfg)
    r = readings(trader, t_ms)
    v, s = int(sg) * r["veredicto"], sg * r["puntaje"]
    hit = teacher["ajuste"].get("acierto_signo")
    out = ["Ficha corta (velas cerradas; sin fechas ni precios absolutos). Despertaste por: {}.".format(", ".join(reasons))]
    out.append("1. Maestro de dirección (fórmula fija sobre las velas de los últimos 7 días; a 12 h acierta el signo el {} % de las "
               "veces, más cuando dice fuerte): {} (puntaje {}; flojo desde {}, fuerte desde {}).".format(
                   "n/d" if hit is None else qt.es(hit * 100, 0), WORDS[v], qt.es(s, 2, True),
                   qt.es(teacher["umbrales"]["flojo"], 2), qt.es(teacher["umbrales"]["fuerte"], 2)))
    in_position = trader.position is not None
    out.append("2. Portero{} (fórmula fija que dice si conviene tomar la señal del maestro ahora, mirando tendencia, lugar en el "
               "rango y volatilidad): {} (probabilidad de ganar tras costos {}; conviene desde {}).".format(
                   " (solo cuenta para entrar)" if in_position else "", "CONVIENE ENTRAR" if r["portero_si"] else "NO CONVIENE ENTRAR",
                   qt.es(r["portero_p"], 2), qt.es(keeper["umbral"], 2)))
    out.append("3. Volatilidad: {} (rango de las últimas 24 h {} % contra {} % de promedio de los últimos 7 días; movimiento "
               "esperable en 24 h +-{} %).".format(r["volatilidad"], qt.es(r["range24"] * 100, 2), qt.es(r["range7"] * 100, 2),
                                                 qt.es(r["sigma24"] * 100, 2)))
    out.append(_position_line(trader, t_ms, r["veredicto"]))
    out.append("Costo de entrar y salir: ~{} % del tamaño.".format(qt.es(float(qt.round_trip_cost_bps(trader.product)) / 100.0, 2)))
    return out


def _position_line(trader, t_ms, verdict_now):
    position = trader.position
    if position is None:
        return "4. Posición: ninguna."
    last = trader.c[-1]
    now = qt.settle(trader.product, position, last, "strategy_exit", t_ms, trader.funding, trader.notional)
    side = 1 if position.side == "LONG" else -1
    aligned = side * verdict_now
    says = ("no dice nada claro" if aligned == 0 else "va a favor de la posición" if aligned > 0 else
            "va EN CONTRA de la posición ({})".format("flojo" if aligned == -1 else "fuerte"))
    left = position.entry_ms + position.max_hold_ms - t_ms if position.max_hold_ms else None
    return ("4. Posición: {} abierta hace {}. Resultado si cerrás ahora, ya con todos los costos: {} % ({} USD). El maestro ahora "
            "{}.{}").format("LARGO" if side > 0 else "CORTO", qt._hm((t_ms - position.entry_ms) / qt.MINUTE_MS),
                           qt.es(now["net_bp"] / 100.0, 2, True), qt.es(now["net_bp"] / 100.0 * float(trader.notional) / 100.0, 2, True),
                           says, "" if left is None else " Cierre obligatorio dentro de {}.".format(qt._hm(left / qt.MINUTE_MS)))


def rules_line(trader):
    guard, wake = trader.cfg["guardrails"], trader.cfg["wake"]
    stop = ("sin stop automático" if guard.get("stop_sigma_24h") is None else
            "stop automático a {} x la volatilidad diaria".format(qt.es(guard["stop_sigma_24h"], 1)))
    return ("Reglas fijas que no podés cambiar: {}; cierre obligatorio a las {} h; espera de {} min después de cerrar; tamaño fijo "
            "de {} USD; una sola posición; sin límite de operaciones por día. Solo te consultamos cada {} min.".format(
                stop, guard["max_hold_min"] // 60, guard["cooldown_min"], format(trader.notional.normalize(), "f"),
                wake["position_every_min"]))


def state(trader, t_ms, sg, reasons):
    """El STATE completo de la versión 8: la ficha corta, el costo y las reglas."""
    return "\n".join(lines(trader, t_ms, sg, reasons) + [rules_line(trader)])
