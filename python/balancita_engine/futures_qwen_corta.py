"""La FICHA CORTA de Qwen en vivo (versión 8): cuatro renglones y las reglas, nada más.

Qwen ya no lee los ocho renglones de números de la ficha (``futures_qwen_ficha``): dos fórmulas fijas en CPU los leen por él y
le dicen el resultado en una línea cada una (más el producto y la hora UTC como contexto), y él supervisa y decide entrar y salir.

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

from . import futures_qwen_exigencia as exigencia
from . import futures_qwen_ficha as ficha
from . import futures_qwen_maestro as maestro
from . import futures_qwen_noticias as noticias
from . import futures_qwen_portero as portero
from . import futures_qwen_trader as qt

VOL_HIGH, VOL_LOW = 1.25, 0.8                   # rango de 24 h contra el promedio de 7 días
WORDS = {2: "SUBE FUERTE", 1: "SUBE FLOJO", 0: "NADA CLARO", -1: "BAJA FLOJO", -2: "BAJA FUERTE"}
_LOADED = {}


PARES_SCHEMA = "balancita-walkforward-pares.v1"
_PARES = {}


def _quarter_name(t_ms):
    month = int(qt.stamp(t_ms)[5:7])
    return "{}Q{}".format(qt.stamp(t_ms)[:4], (month - 1) // 3 + 1)


def _pairs_table(path):
    path = path if os.path.isabs(path) else os.path.join(qt.ROOT, "config", path)
    cached = _PARES.get(path)
    if cached is None:
        import json
        with open(path, encoding="utf-8") as handle:
            table = json.load(handle)
        if table.get("schema") != PARES_SCHEMA or not table.get("trimestres"):
            raise qt.TraderError("{}: no es una tabla de fórmulas trimestrales".format(path))
        cached = _PARES[path] = (os.path.dirname(path), table["trimestres"])
    return cached


def quarter_spec(spec, t_ms=None):
    """``cfg["corta"]`` con las fórmulas del trimestre de ``t_ms`` cuando declara ``pares`` (modo honesto: cada trimestre usa el
    par ajustado SOLO con lo anterior). Antes del primer trimestre vale el primero y después del último el último; sin ``t_ms``, el último."""
    if not spec.get("pares"):
        return spec
    folder, table = _pairs_table(spec["pares"])
    names = sorted(table)
    name = names[-1] if t_ms is None else _quarter_name(t_ms)
    if name not in table:
        name = names[0] if t_ms is not None and name < names[0] else names[-1]
    pair = table[name]
    return dict(spec, maestro=os.path.join(folder, pair["maestro"]), maestro_hash=pair["maestro_hash"],
                portero=os.path.join(folder, pair["portero"]), portero_hash=pair["portero_hash"])


def formulas(cfg, t_ms=None):
    """``(maestro, portero)`` de la config, cargados una vez por archivo y verificados contra los hashes declarados. Con
    ``corta.pares`` (tabla de fórmulas trimestrales) elige el par del trimestre de ``t_ms``."""
    spec = quarter_spec(cfg.get("corta") or {}, t_ms)
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
    if cfg.get("exigencia"):                            # solo en las pruebas de /Estrategias: otros umbrales, la fórmula es la misma
        return exigencia.apply(out[0], out[1], exigencia.levels(**cfg["exigencia"]))
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
    teacher, keeper = formulas(trader.cfg, t_ms)
    f = ficha.facts(trader, t_ms) if f is None else f
    extra = maestro.uses_extra_eth(teacher) or portero.uses_extra_eth(keeper)
    row = maestro.flat_facts(f, extra_eth=extra)
    s = maestro.score(teacher, row)
    v = maestro.verdict_of(teacher, s)
    yes, p = portero.verdict(keeper, row, s)
    news_yes, news_info = noticias.verdict(getattr(trader, "news", None), t_ms, -1 if s < 0 else 1)
    r24, r7 = float(f["range24"]), float(f["range7"])
    ratio = r24 / r7 if r7 > 0 else 1.0
    if ratio >= VOL_HIGH:
        regime = "ALTA"
    elif ratio <= VOL_LOW:
        regime = "BAJA"
    else:
        regime = "NORMAL"
    return {"hechos": row, "puntaje": s, "flojo": teacher["umbrales"]["flojo"], "veredicto": v, "portero_p": p, "portero_si": yes,
            "noticias_si": news_yes, "noticias": news_info, "vol_ratio": ratio, "volatilidad": regime,
            "sigma24": trader._sigma5() * math.sqrt(qt.H24), "range24": r24, "range7": r7}


def _flat_action(r):
    v = r["veredicto"]
    if abs(v) < 2:
        return "ESPERAR", "el maestro no está fuerte"
    direction = "LARGO" if v > 0 else "CORTO"
    if r.get("portero_si"):
        return direction, "maestro fuerte y portero a favor"
    if r.get("noticias_si"):
        return direction, "maestro fuerte y noticias a favor"
    return "ESPERAR", "el portero dice que no conviene"


def formula_action(r, side):
    """Lo que deciden las fórmulas (versión 9). ``r``: ``readings``. ``side``: 1 / -1 si hay posición abierta (largo / corto),
    ``None`` si no. Sin posición: ``LARGO`` / ``CORTO`` cuando el maestro dice FUERTE y el portero o el analista de noticias dicen
    que conviene entrar (del lado del maestro); si no, ``ESPERAR``. Con posición: ``CERRAR`` cuando el maestro se da vuelta en contra,
    al menos flojo; si no, ``MANTENER``. Sin límite de tiempo: una operación dura lo que dure el maestro. Devuelve ``(acción, motivo)``."""
    if side is None:
        return _flat_action(r)
    if side * r["veredicto"] <= -1:
        return "CERRAR", "el maestro se dio vuelta en contra"
    return "MANTENER", "el maestro no se dio vuelta"


def formula_json(r, why):
    """Lo que las fórmulas vieron y por qué decidieron, para guardarlo junto a la decisión (y al ejemplo de entrenamiento)."""
    return {"maestro": r["veredicto"], "puntaje": round(r["puntaje"], 6), "portero_si": bool(r["portero_si"]),
            "portero_p": round(r["portero_p"], 6), "noticias_si": bool(r.get("noticias_si")),
            "noticias": r.get("noticias"), "volatilidad": r["volatilidad"], "motivo": why}


def lines(trader, t_ms, sg, reasons):
    """Los renglones de la ficha corta (orientación real con ``sg`` = 1, espejo con -1), sin la cola de reglas y posición."""
    teacher, keeper = formulas(trader.cfg, t_ms)
    r = readings(trader, t_ms)
    v, s = int(sg) * r["veredicto"], sg * r["puntaje"]
    hit = teacher["ajuste"].get("acierto_signo")
    out = ["Ficha corta (velas cerradas; sin fechas ni precios absolutos). Despertaste por: {}.".format(", ".join(reasons))]
    out.append("1. Maestro de dirección (fórmula fija sobre las velas de los últimos 7 días; a 12 h acierta el signo el {} % de las "
               "veces, más cuando dice fuerte): {} (puntaje {}; flojo desde {}, fuerte desde {}).".format(
                   "n/d" if hit is None else qt.es(hit * 100, 0), WORDS[v], qt.es(s, 2, True),
                   qt.es(teacher["umbrales"]["flojo"], 2), qt.es(teacher["umbrales"]["fuerte"], 2)))
    in_position = trader.position is not None
    out.extend([
        "2. Portero{} (fórmula fija que dice si conviene tomar la señal del maestro ahora, mirando tendencia, lugar en el "
        "rango y volatilidad): {} (probabilidad de ganar tras costos {}; conviene desde {}).".format(
            " (solo cuenta para entrar)" if in_position else "", "CONVIENE ENTRAR" if r["portero_si"] else "NO CONVIENE ENTRAR",
            qt.es(r["portero_p"], 2), qt.es(keeper["umbral"], 2)),
        _news_line(r, in_position, sg),
        "3. Volatilidad: {} (rango de las últimas 24 h {} % contra {} % de promedio de los últimos 7 días; movimiento "
        "esperable en 24 h +-{} %).".format(r["volatilidad"], qt.es(r["range24"] * 100, 2), qt.es(r["range7"] * 100, 2),
                                          qt.es(r["sigma24"] * 100, 2)),
        _position_line(trader, t_ms, r["veredicto"]),
        _context_line(trader, t_ms),
        "Costo de entrar y salir: ~{} % del tamaño.".format(qt.es(float(qt.round_trip_cost_bps(trader.product)) / 100.0, 2)),
    ])
    return out


def _news_line(r, in_position, sg=1):
    info = r.get("noticias") or {}
    note = " (solo cuenta para entrar)" if in_position else ""
    if not info.get("disponible"):
        return "Noticias (últimas 4 h){}: sin dato.".format(note)
    n = int(info.get("n") or 0)
    if n == 0:
        return "Noticias (últimas 4 h){}: sin noticias relevantes frescas.".format(note)
    status = "A FAVOR del maestro" if r.get("noticias_si") else "SIN AVAL para el maestro"
    sentiment = int(sg) * float(info.get("sentimiento") or 0.0)
    return "Noticias (últimas 4 h){}: {} ({} relevante{}, sentimiento {}).".format(
        note, status, n, "" if n == 1 else "s", qt.es(sentiment, 2, True)
    )


SESSIONS = ((6, "madrugada"), (13, "mañana de Europa"), (21, "sesión de EE. UU."), (24, "noche"))


def _context_line(trader, t_ms):
    """Producto y hora UTC (hechos, sin decir qué conviene): cuándo y en qué activo se mira."""
    hour = (t_ms // qt.HOUR_MS) % 24
    minute = (t_ms // qt.MINUTE_MS) % 60
    session = next(name for end, name in SESSIONS if hour < end)
    asset = {"PF_XBTUSD": "BTC", "PF_ETHUSD": "ETH"}.get(trader.product, trader.product)
    return "Contexto: {}, {:02d}:{:02d} UTC ({}).".format(asset, hour, minute, session)


def _position_line(trader, t_ms, verdict_now):
    position = trader.position
    if position is None:
        return "4. Posición: ninguna."
    last = trader.c[-1]
    pos_notional = position.notional_usd or trader.notional
    now = qt.settle(trader.product, position, last, "strategy_exit", t_ms, trader.funding, pos_notional)
    side = 1 if position.side == "LONG" else -1
    aligned = side * verdict_now
    if aligned == 0:
        says = "no dice nada claro"
    elif aligned > 0:
        says = "va a favor de la posición"
    else:
        strength_label = "flojo" if aligned == -1 else "fuerte"
        says = "va EN CONTRA de la posición ({})".format(strength_label)
    left = position.entry_ms + position.max_hold_ms - t_ms if position.max_hold_ms else None
    return ("4. Posición: {} abierta hace {}. Resultado si cerrás ahora, ya con todos los costos: {} % ({} USD). El maestro ahora "
            "{}.{}").format("LARGO" if side > 0 else "CORTO", qt._hm((t_ms - position.entry_ms) / qt.MINUTE_MS),
                           qt.es(now["net_bp"] / 100.0, 2, True), qt.es(now["net_bp"] / 100.0 * float(pos_notional) / 100.0, 2, True),
                           says, "" if left is None else " Cierre obligatorio dentro de {}.".format(qt._hm(left / qt.MINUTE_MS)))


def rules_line(trader):
    guard, wake = trader.cfg["guardrails"], trader.cfg["wake"]
    stop = ("sin stop automático" if guard.get("stop_sigma_24h") is None else
            "stop automático a {} x la volatilidad diaria".format(qt.es(guard["stop_sigma_24h"], 1)))
    limit = "cierre obligatorio a las {} h".format(guard["max_hold_min"] // 60) if guard.get("max_hold_min") else "sin límite de tiempo"
    return ("Reglas fijas que no podés cambiar: {}; {}; espera de {} min después de cerrar; tamaño fijo "
            "de {} USD; una sola posición; sin límite de operaciones por día. Solo te consultamos cada {} min.".format(
                stop, limit, guard["cooldown_min"], format(trader.notional.normalize(), "f"),
                wake["position_every_min"]))


def state(trader, t_ms, sg, reasons):
    """El STATE completo de la versión 8: la ficha corta, el costo y las reglas."""
    return "\n".join(lines(trader, t_ms, sg, reasons) + [rules_line(trader)])
