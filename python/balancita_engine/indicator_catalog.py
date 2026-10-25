"""Catalogo unico de indicadores (PR 1 de docs/diseno-indicadores-y-qwen.md).

Cada definicion registrada declara su nombre, entradas, timeframes, calentamiento y las funciones que actualizan y
emiten el indicador. ``futures_simulator.IncrementalFeatures`` solo orquesta: la aritmetica vive aqui. El estado
recursivo conserva exactamente la forma historica (lo serializa ``futures_forward_incremental``), y la salida es
identica bit a bit a la implementacion anterior. Este modulo no importa nada del simulador.

``calculate_features`` (verdicts C/Q/E) todavia NO usa el catalogo: ver ``KNOWN_DIVERGENCES``.
"""

from collections import deque, namedtuple
from decimal import Decimal, ROUND_FLOOR

from .canonical import normalize_decimal

D = Decimal


def _n(value):
    return None if value is None else normalize_decimal(str(value))


class Step:
    """Datos de la vela ya procesados que comparten las definiciones (calculados una sola vez por vela)."""

    __slots__ = ("close", "high", "low", "volume", "true_range", "change", "log_return",
                 "closes", "before_highs", "before_lows", "before_volumes")

    def __init__(self, **values):
        for name in self.__slots__:
            setattr(self, name, values[name])


Definition = namedtuple("Definition", "kind inputs timeframes status warmup_bars new_state update emit")
# new_state(period) -> estado inicial o None si no tiene; update(period, state, step) lo avanza;
# emit(period, state, step) -> ([(clave_de_salida, valor)], [codigos_de_razon]).

CATALOG = {}


def _register(definition):
    CATALOG[definition.kind] = definition


def _no_state(period):
    return None


def _no_update(period, state, step):
    return None


# ---- calentamiento declarado (docs/diseno-indicadores-y-qwen.md, "Convergencia") -----------------------------------
def _exact_window(period):
    return period + 1          # SMA/Bollinger/Donchian/logret: ventana + 1 barra, resultado exacto


def _ema_like(period):
    return 12 * period         # peso de la semilla (1 - 2/(n+1))^m ~ e^-24 con m = 12 n


def _wilder(period):
    return 24 * period         # (1 - 1/n)^m ~ e^-24 con m = 24 n


# ---- recursivos ----------------------------------------------------------------------------------------------------
def _ema_update(period, state, step):
    alpha = D(2) / D(period + 1)
    if state[0] is None:
        state[1].append(step.close)
        if len(state[1]) == period:
            state[0] = sum(state[1], D(0)) / D(period)
    else:
        state[0] = alpha * step.close + (D(1) - alpha) * state[0]


def _ema_emit(period, state, step):
    return [("ema{}".format(period), _n(state[0]))], []


def _atr_update(period, state, step):
    if state[0] is None:
        state[1].append(step.true_range)
        if len(state[1]) == period:
            state[0] = sum(state[1], D(0)) / D(period)
    else:
        state[0] = (state[0] * D(period - 1) + step.true_range) / D(period)


def _atr_emit(period, state, step):
    reasons = ["invalid_or_zero_atr"] if state[0] is None or state[0] <= 0 else []
    return [("atr{}".format(period), _n(state[0]))], reasons


def _rsi_update(period, state, step):
    if step.change is None:
        return
    gain, loss = max(step.change, D(0)), max(-step.change, D(0))
    if state[0] is None:
        state[2].append((gain, loss))
        if len(state[2]) == period:
            state[0] = sum((g for g, _ in state[2]), D(0)) / D(period)
            state[1] = sum((l for _, l in state[2]), D(0)) / D(period)
    else:
        state[0] = (state[0] * D(period - 1) + gain) / D(period)
        state[1] = (state[1] * D(period - 1) + loss) / D(period)


def _rsi_emit(period, state, step):
    rsi = None
    if state[0] is not None:
        if state[1] == 0:
            rsi = D(50) if state[0] == 0 else D(100)
        else:
            rsi = D(100) - D(100) / (D(1) + state[0] / state[1])
    return [("rsi{}".format(period), _n(rsi))], []


def _logvol_update(period, state, step):
    if step.log_return is None:
        return
    square = step.log_return * step.log_return
    alpha = D(2) / D(period + 1)
    state[0] = square if state[0] is None else alpha * square + (D(1) - alpha) * state[0]
    state[1] += 1


def _logvol_emit(period, state, step):
    return [("logvol{}".format(period), _n(state[0].sqrt() if state[1] >= period else None))], []


# ---- de ventana (sin estado propio: leen las ventanas que mantiene IncrementalFeatures) -----------------------------
def _sma_emit(period, state, step):
    value = sum(step.closes[-period:], D(0)) / D(period) if len(step.closes) >= period else None
    return [("sma{}".format(period), _n(value))], []


def _logret_emit(period, state, step):
    closes = step.closes
    value = (step.close / closes[-1 - period]).ln() if len(closes) > period else None
    return [("logret{}".format(period), _n(value))], []


def _bollinger_emit(period, state, step):
    window = step.closes[-period:]
    mid = sum(window, D(0)) / D(len(window))
    variance = sum(((v - mid) ** 2 for v in window), D(0)) / D(period)
    stddev = variance.sqrt()
    return [("bollinger_mid{}".format(period), _n(mid)), ("bollinger_variance{}".format(period), _n(variance)),
            ("bollinger_stddev{}".format(period), _n(stddev)),
            ("bollinger_lower{}".format(period), _n(mid - D(2) * stddev)),
            ("bollinger_upper{}".format(period), _n(mid + D(2) * stddev))], []


def _donchian_emit(period, state, step):
    window = slice(-period, None) if step.before_highs else slice(0, 0)
    ph, pl, pv = step.before_highs[window], step.before_lows[window], step.before_volumes[window]
    reasons = []
    if len(ph) == period:
        d_high, d_low, prior = max(ph), min(pl), sum(pv, D(0)) / D(period)
    else:
        d_high = d_low = prior = None
        reasons.append("insufficient_donchian_warmup")
    return [("donchian_high{}".format(period), _n(d_high)), ("donchian_low{}".format(period), _n(d_low)),
            ("donchian_mid{}".format(period), _n(None if d_high is None else (d_high + d_low) / D(2))),
            ("prior_volume_mean{}".format(period), _n(prior))], reasons


# ---- area de valor (perfil de volumen por precio, aceptacion / rechazo) ---------------------------------------------
# periodo = (ventana, pct, bins, confirmacion): ventana del perfil en barras, % de volumen del area (entero), niveles de
# precio y barras de confirmacion. Solo se calcula en la serie de 5 m (``IncrementalFeatures(series="5m")``).
VALUEAREA_FEATURES = ("poc", "vah", "val", "vaside", "vaout", "vain")


def _profile(bars, pct, bins):
    """(poc, vah, val) del perfil de ``bars`` = [(alto, bajo, volumen)]: cada volumen se reparte parejo entre los bins que
    toca su rango; el area crece desde el POC hacia el vecino mas pesado (el de arriba si empatan) hasta ``pct`` % del volumen.
    ``None`` si el rango es cero o no hay volumen. Es la misma regla de ``valueArea`` de la Terminal (chart-indicators.ts)."""
    low = min(bar[1] for bar in bars)
    high = max(bar[0] for bar in bars)
    span = high - low
    if not span > 0:
        return None
    volume = [D(0)] * bins
    last_bin = bins - 1
    for bar_high, bar_low, bar_volume in bars:
        if not bar_volume > 0:
            continue
        first = min(last_bin, max(0, int(((bar_low - low) * bins / span).to_integral_value(rounding=ROUND_FLOOR))))
        last = min(last_bin, max(0, int(((bar_high - low) * bins / span).to_integral_value(rounding=ROUND_FLOOR))))
        share = bar_volume / D(last - first + 1)
        for index in range(first, last + 1):
            volume[index] += share
    total = sum(volume, D(0))
    if not total > 0:
        return None
    poc = 0
    for index in range(1, bins):
        if volume[index] > volume[poc]:
            poc = index
    lo = hi = poc
    held = volume[poc]
    while held * 100 < total * pct and (lo > 0 or hi < last_bin):
        below = volume[lo - 1] if lo > 0 else D(-1)
        above = volume[hi + 1] if hi < last_bin else D(-1)
        if above >= below:
            hi += 1
            held += volume[hi]
        else:
            lo -= 1
            held += volume[lo]
    return (low + span * (poc * 2 + 1) / (D(2) * bins), low + span * (hi + 1) / D(bins), low + span * lo / D(bins))


def _valuearea_state(period):
    window, _, _, confirm = period
    # barras previas (alto, bajo, volumen); evento de salida de cada barra reciente; ultimos cierres; cierre anterior; salida
    return [deque(maxlen=window), deque(maxlen=confirm + 1), deque(maxlen=confirm), None, None]


def _inside(price, area):
    return area[1] <= price <= area[0]          # (vah, val): VAL <= precio <= VAH


def _valuearea_update(period, state, step):
    window, pct, bins, confirm = period
    bars, events, closes, previous_close, _ = state
    area = _profile(list(bars), pct, bins) if len(bars) == window else None
    # Salida nueva en esta barra: cierra fuera del area del perfil previo y la barra anterior cerro dentro.
    event = None
    if area is not None and previous_close is not None and _inside(previous_close, (area[1], area[2])):
        if step.close > area[1]:
            event = (1, area[1], area[2])
        elif step.close < area[2]:
            event = (-1, area[1], area[2])
    events.append(event)
    closes.append(step.close)
    out = [area, None, None, None]
    if len(events) == confirm + 1 and events[0] is not None:
        side, vah, val = events[0]
        outside = sum(1 for close in closes if (close > vah if side > 0 else close < val))
        out[1:] = [D(side), D(outside), D(1) if val <= step.close <= vah else D(0)]
    state[3], state[4] = step.close, out
    bars.append((step.high, step.low, step.volume))


def _valuearea_emit(period, state, step):
    area, side, outside, inside = state[4]
    poc, vah, val = area if area is not None else (None, None, None)
    return [("poc", _n(poc)), ("vah", _n(vah)), ("val", _n(val)), ("vaside", _n(side)), ("vaout", _n(outside)),
            ("vain", _n(inside))], []


def _valuearea_warmup(period):
    return period[0] + period[3] + 1


_OHLCV, _TF = ("ohlcv",), ("1m", "5m")
# El orden de registro es el orden de emision de claves (igual que la implementacion anterior).
_register(Definition("ema", _OHLCV, _TF, "active", _ema_like, lambda p: [None, []], _ema_update, _ema_emit))
_register(Definition("sma", _OHLCV, _TF, "active", _exact_window, _no_state, _no_update, _sma_emit))
_register(Definition("logret", _OHLCV, _TF, "active", _exact_window, _no_state, _no_update, _logret_emit))
_register(Definition("logvol", _OHLCV, _TF, "active", _ema_like, lambda p: [None, 0], _logvol_update, _logvol_emit))
_register(Definition("rsi", _OHLCV, _TF, "active", _wilder, lambda p: [None, None, []], _rsi_update, _rsi_emit))
_register(Definition("atr", _OHLCV, _TF, "active", _wilder, lambda p: [None, []], _atr_update, _atr_emit))
_register(Definition("bollinger", _OHLCV, _TF, "active", _exact_window, _no_state, _no_update, _bollinger_emit))
_register(Definition("donchian", _OHLCV, _TF, "active", _exact_window, _no_state, _no_update, _donchian_emit))
_register(Definition("valuearea", _OHLCV, ("5m",), "active", _valuearea_warmup, _valuearea_state, _valuearea_update,
                     _valuearea_emit))

# Reservado (diseno 2.E): `validate_spec` lo rechazara en el PR 2; aun no tiene implementacion.
RESERVED = {"funding.vs24h": Definition("funding.vs24h", ("funding",), ("funding",), "reserved",
                                        lambda p: 0, _no_state, _no_update, None)}


def warmup_bars(kind, period):
    """Barras de su timeframe que un indicador necesita para converger (formula declarada, no medida)."""
    return CATALOG[kind].warmup_bars(period)


def consumer_warmup_bars(needs, minimum=288):
    """Calentamiento de un consumidor: max de sus ``needs`` (kind, periodo) + 2, con minimo 288 (histeresis del regimen)."""
    return max([warmup_bars(kind, period) + 2 for kind, period in needs] + [minimum])
