"""Reading (and rewriting) the numbers of the state text that Qwen was shown.

The surrogate model of the report and the perturbation probes both need the exact numbers of the prompt, not the market
data behind them: whatever Qwen saw is what explains what Qwen did. ``extract`` reads them back from the stored state
text; ``substitute`` rewrites ONE of them, leaving every other character of the text as it was.
"""

import re

from . import futures_qwen_trader as qt

NUM = r"[+-]?\d+(?:,\d+)?"
BARS = {"1h": qt.H1, "4h": qt.H4, "24h": qt.H24, "7d": qt.D7}


def _num(text):
    return float(text.replace(",", "."))


def _minutes(text):
    match = re.fullmatch(r"(?:(\d+) h (\d{2}) min|(\d+) min)", text.strip())
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2)) if match.group(1) else int(match.group(3))


# name -> (patterns, places, sign, parse, format). The patterns capture the displayed number as group ``v``; the first one
# that matches the text is the one used (v1 and v2 write the position lines differently).
def _f(name, patterns, places=2, sign=False, parse=_num, fmt=None):
    return {"name": name, "patterns": [re.compile(p, re.M) for p in patterns], "places": places, "sign": sign,
            "parse": parse, "fmt": fmt or (lambda value: qt.es(value, places, sign))}


FIELDS = {}
for _w in ("1h", "4h", "24h", "7d"):
    FIELDS["ret_" + _w] = _f("ret_" + _w, [r"^Retornos: .*?\b{} (?P<v>{}) %".format(_w, NUM)], 2, True)
    FIELDS["z_" + _w] = _f("z_" + _w, [r"^Tendencia .*?\b{} (?P<v>{})(?: \||$)".format(_w, NUM)], 1, True)
for _field in (
        _f("vol24", [r"ultimas 24h (?P<v>{}) %".format(NUM)]),
        _f("vol7", [r"ultimos 7d (?P<v>{}) %".format(NUM)]),
        _f("mov15", [r"ultimos 15 min (?P<v>{}) %".format(NUM)], 2, True),
        _f("norm15", [r"lo normal es \+-(?P<v>{}) %".format(NUM)]),
        _f("dist_max24", [r"^Distancia al maximo / minimo de 24h: (?P<v>{}) % /".format(NUM)], 1, True),
        _f("dist_min24", [r"^Distancia al maximo / minimo de 24h: {} % / (?P<v>{}) %".format(NUM, NUM)], 1, True),
        _f("dist_max7", [r"\| de 7d: (?P<v>{}) % /".format(NUM)], 1, True),
        _f("dist_min7", [r"\| de 7d: {} % / (?P<v>{}) %".format(NUM, NUM)], 1, True),
        _f("vol_1h_rel", [r"ultima hora x(?P<v>{}) del".format(NUM)], 1),
        _f("vol_24h_rel", [r"24h x(?P<v>{}) del promedio diario".format(NUM)], 1),
        _f("funding_rate", [r"ultima tasa por hora (?P<v>{}) %".format(NUM)], 4, True),
        _f("funding_pct", [r"percentil (?P<v>\d+) de"], 0),
        _f("open_min", [r"abierta hace (?P<v>\d+ h \d{2} min|\d+ min)"], 0, False, _minutes,
           lambda value: qt._hm(value)),
        _f("pnl_pct", [r"cerras ahora, ya con todos los costos: (?P<v>{}) %".format(NUM),
                       r"cerras ahora \(ya con costos\): (?P<v>{}) %".format(NUM)], 2, True),
        _f("pnl_usd", [r"\((?P<v>{}) USD\)".format(NUM)], 2, True),
        _f("sig1h", [r"proxima 1h \+-(?P<v>{}) %".format(NUM)]),
        _f("sig4h", [r"proximas 4h \+-(?P<v>{}) %".format(NUM)]),
        _f("favor", [r"sin costos: (?P<v>{}) %".format(NUM)], 2, True)):
    FIELDS[_field["name"]] = _field


def _find(field, text):
    for pattern in field["patterns"]:
        match = pattern.search(text)
        if match:
            return match
    return None


def extract(text):
    """``{field: number}`` for every number found in ``text``, plus ``side`` (+1 long, -1 short, absent when flat) and
    ``wake`` (the reasons the state says it woke for)."""
    out = {}
    for name, field in FIELDS.items():
        match = _find(field, text)
        if match:
            value = field["parse"](match.group("v"))
            if value is not None:
                out[name] = value
    match = re.search(r"Posicion: (LARGO|CORTO) abierta", text)
    if match:
        out["side"] = 1.0 if match.group(1) == "LARGO" else -1.0
    match = re.search(r"Despertaste por: ([^.]+)\.", text)
    out["wake"] = [w.strip() for w in match.group(1).split(",")] if match else []
    return out


def substitute(text, name, value):
    """``text`` with the displayed number of field ``name`` replaced by ``value`` (formatted like the engine does).
    Everything else stays byte for byte. Returns ``None`` when the field is not in the text."""
    field = FIELDS[name]
    match = _find(field, text)
    if not match:
        return None
    start, end = match.span("v")
    return text[:start] + field["fmt"](value) + text[end:]


def displayed(name, value):
    """What the engine would print for ``value`` (rounded as in the prompt), parsed back: the value the model reads."""
    return FIELDS[name]["parse"](FIELDS[name]["fmt"](value))
