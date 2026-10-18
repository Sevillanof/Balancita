"""Catalogo unico de indicadores (PR 1 de docs/diseno-indicadores-y-qwen.md).

Cada definicion registrada declara su nombre, entradas, timeframes, calentamiento y las funciones que actualizan y
emiten el indicador. ``futures_simulator.IncrementalFeatures`` solo orquesta: la aritmetica vive aqui. El estado
recursivo conserva exactamente la forma historica (lo serializa ``futures_forward_incremental``), y la salida es
identica bit a bit a la implementacion anterior. Este modulo no importa nada del simulador.

``calculate_features`` (verdicts C/Q/E) todavia NO usa el catalogo: ver ``KNOWN_DIVERGENCES``.
"""

from collections import namedtuple
from decimal import Decimal

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

# Reservado (diseno 2.E): `validate_spec` lo rechazara en el PR 2; aun no tiene implementacion.
RESERVED = {"funding.vs24h": Definition("funding.vs24h", ("funding",), ("funding",), "reserved",
                                        lambda p: 0, _no_state, _no_update, None)}


def warmup_bars(kind, period):
    """Barras de su timeframe que un indicador necesita para converger (formula declarada, no medida)."""
    return CATALOG[kind].warmup_bars(period)


def consumer_warmup_bars(needs, minimum=288):
    """Calentamiento de un consumidor: max de sus ``needs`` (kind, periodo) + 2, con minimo 288 (histeresis del regimen)."""
    return max([warmup_bars(kind, period) + 2 for kind, period in needs] + [minimum])
