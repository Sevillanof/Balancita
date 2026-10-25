"""La «ficha de 8 factores» que se le muestra a Qwen en la Prueba rápida (variantes ``ficha`` y ``ficha-pista``).

El estado de siempre (retornos, tendencia, volatilidad, distancias, volumen, funding) se reordena en renglones numerados F1 a F8,
en orden fijo. Cada renglón trae el número y una lectura corta en palabras (lo que el número ES, nunca qué votar). Todo lo que
tiene dirección se da vuelta en el espejo (``sg`` = -1); tamaños, horas y costos no. ``Trader.state_text`` llama a ``lines``
cuando ``cfg["state_ficha"]`` es verdadero; lo demás del estado (costo, reglas fijas) lo pone el trader como siempre.

Los hechos se calculan UNA vez por foto (``facts``, con las velas cerradas hasta ``t_ms``: nada del futuro) y de ahí salen el
texto real, el texto del espejo y los números que la prueba usa para medir qué renglones lee Qwen (``numbers``).

F4 (área de valor): perfil de volumen de las 288 velas de 5 min previas a las últimas 6 (48 niveles, 70 % del volumen: la misma
definición que ``indicator_catalog._profile``, la del indicador ``valuearea`` y la de la Terminal). Las últimas 6 velas cerradas
se miran contra esa área: dónde cerró la última y cuántos de los 6 cierres quedaron afuera (≥ 4: salida aceptada).

F6 (posicionamiento y prima): base del colector ``positioning`` abierta SOLO lectura (``positioning_data.PositioningFeed``). Para
la foto de ``t_ms`` se usa el último balde ya cerrado (nunca uno que termina después) y el de 24 h antes para el cambio. Sin
base o sin balde reciente, cada dato dice «n/d» y la foto sigue.
"""

import math
from decimal import Decimal

from . import futures_qwen_trader as qt
from .indicator_catalog import _profile

FACTORS = ("F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8")
VOTING = ("F1", "F2", "F3", "F4", "F6", "F7")   # F5 (volumen y volatilidad, un tamaño sin signo) y F8 (el momento) no votan
VOTING_INDEX = tuple(FACTORS.index(f) for f in VOTING)   # posición de cada votante en la ficha: no son los primeros N
LABELS = {"F1": "Tendencia larga", "F2": "Impulso corto", "F3": "Lugar en el rango", "F4": "Área de valor del día previo",
          "F5": "Volumen y volatilidad", "F6": "Posicionamiento y prima", "F7": "Otros activos", "F8": "Momento"}
AREA_BARS, AREA_PCT, AREA_BINS, AREA_WINDOW, AREA_ACCEPT = 288, 70, 48, 6, 4
VOL_WINDOW = qt.H4                         # barras de la volatilidad realizada de «las últimas 4 h»
VOL_STEP = qt.H1                           # las ventanas de la semana se corren de a 1 h
DAY_MS = qt.DAY_MS


# --------------------------------------------------------------------------- facts (real orientation)


def _area(trader):
    """``(vah, val)`` del perfil de volumen previo, o ``None`` si no hay rango o volumen."""
    need = AREA_BARS + AREA_WINDOW
    if len(trader.c) < need:
        return None
    lo, hi = len(trader.c) - need, len(trader.c) - AREA_WINDOW
    bars = [(Decimal(repr(h)), Decimal(repr(l)), Decimal(repr(v))) for h, l, v in
            zip(trader.h[lo:hi], trader.l[lo:hi], trader.v[lo:hi])]
    profile = _profile(bars, AREA_PCT, AREA_BINS)
    return None if profile is None else (float(profile[1]), float(profile[2]))


def _area_facts(trader):
    area = _area(trader)
    if area is None:
        return None
    vah, val = area
    width = vah - val
    last = trader.c[-1]
    closes = trader.c[-AREA_WINDOW:]
    above, below = sum(1 for x in closes if x > vah), sum(1 for x in closes if x < val)
    if last > vah:
        place, distance = "arriba", (last - vah) / width
    elif last < val:
        place, distance = "abajo", (val - last) / width
    else:
        place, distance = "dentro", 0.0
    return {"place": place, "distance": distance, "above": above, "below": below,
            "signed": distance if place == "arriba" else -distance if place == "abajo" else 0.0}


def _realized(trader):
    """Volatilidad realizada de las últimas 4 h dividida por la mediana de esa misma medida en 7 d (ventanas de 4 h corridas
    de a 1 h). ``None`` si no hay semana de velas."""
    lc = trader.lc[-(qt.D7 + 1):]
    if len(lc) < qt.D7 + 1:
        return None
    squares = [(b - a) ** 2 for a, b in zip(lc, lc[1:])]
    prefix = [0.0]
    for x in squares:
        prefix.append(prefix[-1] + x)
    sizes = [math.sqrt(prefix[end] - prefix[end - VOL_WINDOW]) for end in range(len(squares), VOL_WINDOW - 1, -VOL_STEP)]
    ordered = sorted(sizes)
    median = ordered[len(ordered) // 2] if len(ordered) % 2 else (ordered[len(ordered) // 2 - 1] + ordered[len(ordered) // 2]) / 2
    return sizes[0] / median if median > 0 else None


def _positioning(trader, t_ms):
    feed = trader.positioning
    now = feed.at(t_ms) if feed is not None else None
    before = feed.at(t_ms - DAY_MS) if feed is not None else None
    if now is None:
        return {"long": None, "long_d": None, "top": None, "top_d": None, "premium": None}
    delta = lambda key: None if now[key] is None or before is None or before[key] is None else now[key] - before[key]
    return {"long": now["long"], "long_d": delta("long"), "top": now["top_long"], "top_d": delta("top_long"),
            "premium": now["premium_bp"]}


def _relative_strength(trader, t_ms):
    """Promedio, entre los otros activos, de (retorno 4 h del producto − retorno 4 h del otro), en puntos; ``None`` sin datos."""
    gaps = []
    for closes in trader.context.values():
        now, before = closes.get(t_ms), closes.get(t_ms - qt.H4 * qt.BAR_MS)
        if now and before:
            gaps.append((trader.c[-1] / trader.c[-1 - qt.H4] - 1 - (now / before - 1)) * 100)
    return math.fsum(gaps) / len(gaps) if gaps else None


def facts(trader, t_ms):
    """Todo lo que la ficha necesita, en la orientación real (el espejo da vuelta lo que tiene dirección al escribir).
    Se guarda en el trader por foto: el texto real y el del espejo comparten el cálculo."""
    key = (t_ms, trader.t[-1], len(trader.c))
    cached = getattr(trader, "_ficha_cache", None)
    if cached and cached[0] == key:
        return cached[1]
    c, last = trader.c, trader.c[-1]
    sigma5 = trader._sigma5()
    out = {"ret": {}, "z": {}}
    for name, bars in (("1h", qt.H1), ("4h", qt.H4), ("24h", qt.H24), ("7d", qt.D7)):
        out["ret"][name] = last / c[-1 - bars] - 1
        out["z"][name] = trader._logret(bars) / (sigma5 * math.sqrt(bars)) if sigma5 > 0 else 0.0
    out["move15"], out["norm15"] = trader._logret(3), sigma5 * math.sqrt(3)
    h24, l24, h7, l7 = trader.h[-qt.H24:], trader.l[-qt.H24:], trader.h[-qt.D7:], trader.l[-qt.D7:]
    hi24, lo24, hi7, lo7 = max(h24), min(l24), max(h7), min(l7)
    place = lambda lo, hi: 2 * (last - lo) / (hi - lo) - 1 if hi > lo else 0.0
    out["pos24"], out["pos7"] = place(lo24, hi24), place(lo7, hi7)
    out["since_hi"] = (qt.H24 - 1 - h24.index(hi24)) * 5 / 60.0
    out["since_lo"] = (qt.H24 - 1 - l24.index(lo24)) * 5 / 60.0
    v1h, v24, v7 = math.fsum(trader.v[-qt.H1:]), math.fsum(trader.v[-qt.H24:]), math.fsum(trader.v[-qt.D7:])
    out["vol1h"] = v1h / (v24 / 24) if v24 > 0 else 0.0
    out["vol24"] = v24 / (v7 / 7) if v7 > 0 else 0.0
    out["realized"] = _realized(trader)
    ranges = [(max(trader.h[-(d + 1) * qt.H24:len(trader.h) - d * qt.H24]) - min(trader.l[-(d + 1) * qt.H24:len(trader.l) - d * qt.H24]))
              / last for d in range(7)]
    out["range24"], out["range7"] = (hi24 - lo24) / last, math.fsum(ranges) / 7
    out["area"] = _area_facts(trader)
    out["pos"] = _positioning(trader, t_ms)
    out["strength"] = _relative_strength(trader, t_ms)
    trader._ficha_cache = (key, out)
    return out


def numbers(trader, t_ms):
    """El número de cada renglón F1 a F7 (orientación real; F5 es un tamaño sin signo y no vota) contra el que se mide si Qwen lo lee; ``None`` si no hay."""
    f = facts(trader, t_ms)
    pos = f["pos"]
    return {"F1": f["z"]["24h"], "F2": f["z"]["4h"], "F3": f["pos7"],
            "F4": None if f["area"] is None else f["area"]["signed"], "F5": f["realized"],
            "F6": None if pos["long"] is None else pos["long"] - 50.0, "F7": f["strength"]}


# --------------------------------------------------------------------------- words


def _z_word(z):
    size = abs(z)
    if size < 0.5:
        return "lateral"
    level = "suave" if size < 1 else "marcada" if size < 2 else "fuerte"
    return "{} {}".format("subida" if z > 0 else "caída", level)


def _move_word(move, normal):
    ratio = abs(move) / normal if normal > 0 else 0.0
    if ratio < 1:
        return "dentro de lo normal"
    return "{} {}".format("subida" if move > 0 else "caída", "fuera de lo normal" if ratio < 2 else "muy fuera de lo normal")


def _place_word(pos):
    return ("pegado al máximo" if pos >= 0.8 else "en la mitad de arriba" if pos >= 0.3 else "en el medio" if pos > -0.3 else
            "en la mitad de abajo" if pos > -0.8 else "pegado al mínimo")


def _volume_word(ratio):
    return "muy alto" if ratio >= 2 else "alto" if ratio >= 1.3 else "bajo" if ratio < 0.7 else "normal"


def _vol_word(ratio):
    return "movido" if ratio >= 1.5 else "tranquilo" if ratio <= 0.67 else "normal"


def _long_word(percent):
    return "mayoría larga" if percent >= 55 else "mayoría corta" if percent <= 45 else "parejo"


def _premium_word(bp):
    return "perpetuo sobre el contado" if bp >= 1 else "perpetuo bajo el contado" if bp <= -1 else "parejo"


# --------------------------------------------------------------------------- the lines


def _f4(area, sg):
    if area is None:
        return "F4 Área de valor del día previo: n/d."
    place, above, below = area["place"], area["above"], area["below"]
    if sg < 0:
        place = {"arriba": "abajo", "abajo": "arriba", "dentro": "dentro"}[place]
        above, below = below, above
    head = "F4 Área de valor del día previo (perfil de volumen de las {} velas de 5 min anteriores, {} % del volumen): ".format(
        AREA_BARS, AREA_PCT)
    if place == "dentro":
        out = max(above, below)
        if out == 0:
            return head + "el precio está dentro del área."
        side = "por encima del VAH" if above >= below else "por debajo del VAL"
        return head + "el precio está dentro del área; hace poco salió {} y volvió ({} de los últimos {} cierres afuera): " \
                      "salida rechazada.".format(side, out, AREA_WINDOW)
    count = above if place == "arriba" else below
    verdict = "salida aceptada" if count >= AREA_ACCEPT else "salida todavía sin aceptar"
    return head + "el precio está {} a {} anchos de área; {} de los últimos {} cierres quedaron afuera: {}.".format(
        "por encima del VAH" if place == "arriba" else "por debajo del VAL", qt.es(area["distance"], 2), count,
        AREA_WINDOW, verdict)


def _f6(trader, f, t_ms, sg):
    pos = f["pos"]

    def share(value, delta, label):
        if value is None:
            return "{} n/d".format(label)
        value = 50.0 + sg * (value - 50.0)
        text = "{} {} % ({})".format(label, qt.es(value, 1), _long_word(value))
        return text + ("" if delta is None else ", cambio en 24h {} puntos".format(qt.es(sg * delta, 1, True)))

    parts = [share(pos["long"], pos["long_d"], "cuentas largas"),
             share(pos["top"], pos["top_d"], "grandes operadores (20 % de mayor tamaño) largos")]
    parts.append("prima perpetuo menos contado n/d" if pos["premium"] is None else "prima perpetuo menos contado {} pb ({})".format(
        qt.es(sg * pos["premium"], 1, True), _premium_word(sg * pos["premium"])))
    latest = trader.funding.latest(t_ms)
    if latest is None:
        parts.append("funding n/d")
    else:
        percent = trader.funding.percentile(t_ms)
        rate = sg * latest[1]
        if sg < 0 and percent is not None:
            percent = 100.0 - percent
        parts.append("funding por hora {} % ({}){}".format(
            qt.es(rate * 100, 4, True), "los largos pagan" if rate > 0 else "los cortos pagan" if rate < 0 else "nadie paga",
            "" if percent is None else ", percentil {} de los últimos 30 días".format(int(round(percent)))))
    return "F6 Posicionamiento y prima: " + " | ".join(parts) + "."


def lines(trader, t_ms, sg):
    """Los renglones de la ficha (sin el costo ni las reglas fijas, que agrega el trader). ``sg`` = -1 en el espejo."""
    f = facts(trader, t_ms)
    out = ["Ficha de 8 factores, en orden fijo (cada renglón trae el número y su lectura en palabras):"]
    z = lambda name: sg * f["z"][name]
    out.append("F1 Tendencia larga: retorno de 7d {} % (z {}: {}) | de 24h {} % (z {}: {}).".format(
        qt.es(sg * f["ret"]["7d"] * 100, 2, True), qt.es(z("7d"), 1, True), _z_word(z("7d")),
        qt.es(sg * f["ret"]["24h"] * 100, 2, True), qt.es(z("24h"), 1, True), _z_word(z("24h"))))
    move15 = sg * f["move15"]
    out.append("F2 Impulso corto: retorno de 4h {} % (z {}: {}) | de 1h {} % (z {}: {}) | últimos 15 min {} % (lo normal es "
               "+-{} %: {}).".format(
                   qt.es(sg * f["ret"]["4h"] * 100, 2, True), qt.es(z("4h"), 1, True), _z_word(z("4h")),
                   qt.es(sg * f["ret"]["1h"] * 100, 2, True), qt.es(z("1h"), 1, True), _z_word(z("1h")),
                   qt.es(move15 * 100, 2, True), qt.es(f["norm15"] * 100, 2), _move_word(move15, f["norm15"])))
    pos24, pos7 = sg * f["pos24"], sg * f["pos7"]
    since_hi, since_lo = (f["since_lo"], f["since_hi"]) if sg < 0 else (f["since_hi"], f["since_lo"])
    out.append("F3 Lugar en el rango (-1 es el mínimo, +1 el máximo): en las últimas 24h {} ({}) | en los últimos 7d {} ({}). "
               "Horas desde el máximo de 24h: {} | desde el mínimo de 24h: {}.".format(
                   qt.es(pos24, 2, True), _place_word(pos24), qt.es(pos7, 2, True), _place_word(pos7),
                   qt.es(since_hi, 1), qt.es(since_lo, 1)))
    out.append(_f4(f["area"], sg))
    realized = f["realized"]
    vol4 = "Volatilidad de las últimas 4h contra la mediana de 7d: n/d." if realized is None else \
        "Volatilidad de las últimas 4h: x{} la mediana de 7d ({}).".format(qt.es(realized, 1), _vol_word(realized))
    out.append("F5 Volumen y volatilidad: volumen de la última hora x{} del promedio por hora de 24h ({}) | de 24h x{} del "
               "promedio diario de 7d ({}). {} Rango de las últimas 24h {} % (promedio de los últimos 7 días: {} %).".format(
                   qt.es(f["vol1h"], 1), _volume_word(f["vol1h"]), qt.es(f["vol24"], 1), _volume_word(f["vol24"]), vol4,
                   qt.es(f["range24"] * 100, 2), qt.es(f["range7"] * 100, 2)))
    out.append(_f6(trader, f, t_ms, sg))
    others = trader._x_otros_activos(t_ms, sg)
    out.append("F7 Otros activos (retornos): " + others + "." if others else "F7 Otros activos: n/d.")
    out.append("F8 Momento (no vota): " + trader._x_hora(t_ms))
    return out
