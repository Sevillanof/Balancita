"""Vectorised (numpy / Numba, float64) evaluator of ANY ``balancita-strategy.v1`` rules spec.

``evaluate_spec(spec, market)`` returns a ``Plan``: for every 1m bar, whether the engine's ``propose_spec`` would open a
LONG or a SHORT (with no position open), the protective levels it would propose, the levels frozen for the exit rule and a
compiled version of the strategy's own exit rule. The semantics are those of the engine, bar by bar:

* features of the closed 1m bar (``1m``), of the previous 1m bar (``1m_previous``, shifted one bar) and of the last 5m bar
  that is already closed at the close of the 1m bar (``5m``, the same alignment as ``futures_simulator.frames``);
* regime ``unknown`` / ``trend`` / ``range`` from the 5m EMA 9 / 21 and ATR 14 with the engine's hysteresis;
* the ``ready`` flag (50 candles of warm-up, every ATR positive, every Donchian window full), the ``previous`` / ``trend``
  gates, the checks, ``sides.requires`` (LONG wins a tie), stop / target (tick rounding, ``risk.vol`` in log scale, a
  ``target`` operand), and the engine's minimum-cost filter (a target that does not clear the round trip cost is skipped);
* ``regime_adapter`` specs: each branch is evaluated and kept only on the bars where the regime selects it.
* the value area (``indicators.valuearea``; features ``5m.poc / vah / val / vaside / vaout / vain``): the volume profile of the
  ``window`` closed 5m bars before each bar and, ``confirm`` bars after a close outside it, how many closes stayed outside
  (``_valuearea``, same arithmetic as ``indicator_catalog._profile``). One configuration per spec, 5m series only.

Anything the closed language can express but this evaluator cannot reproduce raises ``UnsupportedSpec`` with a message in
Spanish that names what is missing. Nothing is ignored in silence.

Not supported (``UnsupportedSpec``): the funding percentile ``5m.fundpct`` (it needs the capture's funding history as it
was known at each instant), features outside the catalog (``candidate_open``, ``ready``...), ``available`` on a
``position.*`` operand, and exit rules too deep for the stack of the compiled program.

The engine computes in Decimal and this module in float64, so a bar whose two sides of a comparison are equal to the
last digit could differ; the parity tests count those (target: 0).
"""

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

import numpy as np
from numba import njit

from . import data_contract as contract
from .engine import DEFAULT_PERIODS, declared_indicators, futures_costs, merge_periods
from balancita_engine.canonical import canonical_hash
from balancita_engine.futures_spec_strategy import AREA_FEATURES, SpecError, validate_spec

MINIMUM_CANDLES = 50
COST_BUFFER_RATE = 0.0002
ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
UNKNOWN, TREND, RANGE = 0, 1, 2
REGIME_CODE = {"unknown": UNKNOWN, "trend": TREND, "range": RANGE}
NAN = float("nan")
_PRODUCTS_CONFIG = os.path.join(os.path.dirname(__file__), "..", "..", "config", "futures-products.json")

_FEATURE = re.compile(r"^(ema|sma|rsi|atr|logret|logvol|bollinger_(?:mid|variance|stddev|lower|upper)|"
                      r"donchian_(?:high|low|mid)|prior_volume_mean)(\d+)$")
_CANDIDATES = {"candidate_close": "c", "candidate_high": "h", "candidate_low": "l", "candidate_volume": "v"}
_OPS = {">": 0, ">=": 1, "<": 2, "<=": 3}


class UnsupportedSpec(ValueError):
    """The spec uses something this evaluator does not reproduce; the message (Spanish) says what."""


# ------------------------------------------------------------------------------------------------- the market
def product_tick(product):
    with open(_PRODUCTS_CONFIG, encoding="utf-8") as handle:
        for row in json.load(handle)["products"]:
            if row["product_id"] == product:
                return float(row["tick_size"])
    raise contract.ContractError("no hay tamaño de tick fijado para {} en config/futures-products.json".format(product))


@dataclass
class Market:
    """Sealed 1m and 5m candles of one product (float64) and its funding periods."""
    product: str
    tick: float
    index: np.ndarray            # 1m bucket starts (ms)
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    v: np.ndarray
    index5: np.ndarray
    o5: np.ndarray
    h5: np.ndarray
    l5: np.ndarray
    c5: np.ndarray
    v5: np.ndarray
    funding: list = field(default_factory=list)   # (start_ms, end_ms, relative rate per hour)
    dataset_sha256: str = None
    start_utc: str = None
    end_utc: str = None

    def __post_init__(self):
        if self.start_utc is None and len(self.index):
            self.start_utc = contract.iso(int(self.index[0]))
            self.end_utc = contract.iso(int(self.index[-1]) + ONE_MINUTE_MS)
        if self.dataset_sha256 is None:
            digest = hashlib.sha256()
            for array in (self.index, self.o, self.h, self.l, self.c, self.v, self.index5, self.c5):
                digest.update(np.ascontiguousarray(array).tobytes())
            self.dataset_sha256 = digest.hexdigest()

    @property
    def bars(self):
        return len(self.c)

    @property
    def days(self):
        if self.start_utc and self.end_utc:
            from . import lab_common
            return (lab_common._parse_utc(self.end_utc) - lab_common._parse_utc(self.start_utc)) / 86_400_000
        return self.bars / 1440.0

    @classmethod
    def from_candles(cls, product, rows_1m, rows_5m, tick=None, funding=()):
        """From engine-style candle dicts (``bucket_start`` and decimal strings)."""
        def arrays(rows):
            index = np.array([r["bucket_start"] for r in rows], dtype=np.int64)
            cols = [np.array([float(r[k]) for r in rows], dtype=np.float64)
                    for k in ("open", "high", "low", "close", "volume_btc")]
            return (index, *cols)
        one, five = arrays(rows_1m), arrays(rows_5m)
        return cls(product, product_tick(product) if tick is None else float(tick), *one, *five, funding=list(funding))

    @classmethod
    def from_dataset(cls, directory, gate_config=None):
        """A sealed practice dataset; refuses one that touches the holdout or does not match its manifest."""
        from . import lab_common, parity
        manifest = lab_common.check_dataset(directory, gate_config)
        product = manifest["product_id"]
        one = lab_common.load_candles(directory, manifest, "1m")
        five = lab_common.load_candles(directory, manifest, "5m")
        return cls(product, product_tick(product), *one, *five,
                   funding=parity.funding_periods(directory, product), dataset_sha256=manifest["dataset_sha256"],
                   start_utc=manifest["start_inclusive_utc"], end_utc=manifest["end_exclusive_utc"])


# ---------------------------------------------------------------------------------------------- indicators
@njit(cache=True)
def _ema(c, p):
    n = len(c)
    out = np.full(n, np.nan)
    if n < p:
        return out
    v = 0.0
    for i in range(p):
        v += c[i]
    v /= p
    out[p - 1] = v
    alpha = 2.0 / (p + 1)
    for i in range(p, n):
        v = alpha * c[i] + (1.0 - alpha) * v
        out[i] = v
    return out


@njit(cache=True)
def _atr(h, l, c, p):
    n = len(c)
    out = np.full(n, np.nan)
    total, count, v = 0.0, 0, 0.0
    for i in range(n):
        tr = h[i] - l[i]
        if i > 0:
            tr = max(tr, abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        if count < p:
            total += tr
            count += 1
            if count == p:
                v = total / p
                out[i] = v
        else:
            v = (v * (p - 1) + tr) / p
            out[i] = v
    return out


@njit(cache=True)
def _rsi(c, p):
    n = len(c)
    out = np.full(n, np.nan)
    gain_sum, loss_sum, seen = 0.0, 0.0, 0
    ag, al = 0.0, 0.0
    started = False
    for i in range(1, n):
        change = c[i] - c[i - 1]
        gain, loss = max(change, 0.0), max(-change, 0.0)
        if not started:
            gain_sum += gain
            loss_sum += loss
            seen += 1
            if seen == p:
                ag, al, started = gain_sum / p, loss_sum / p, True
        else:
            ag = (ag * (p - 1) + gain) / p
            al = (al * (p - 1) + loss) / p
        if started:
            if al == 0.0:
                out[i] = 50.0 if ag == 0.0 else 100.0
            else:
                out[i] = 100.0 - 100.0 / (1.0 + ag / al)
    return out


@njit(cache=True)
def _sma(c, p):
    n = len(c)
    out = np.full(n, np.nan)
    for i in range(p - 1, n):
        s = 0.0
        for j in range(i - p + 1, i + 1):
            s += c[j]
        out[i] = s / p
    return out


@njit(cache=True)
def _logret(c, p):
    n = len(c)
    out = np.full(n, np.nan)
    for i in range(p, n):
        out[i] = np.log(c[i] / c[i - p])
    return out


@njit(cache=True)
def _logvol(c, p):
    n = len(c)
    out = np.full(n, np.nan)
    alpha = 2.0 / (p + 1)
    v, seen = 0.0, 0
    for i in range(1, n):
        r = np.log(c[i] / c[i - 1])
        sq = r * r
        v = sq if seen == 0 else alpha * sq + (1.0 - alpha) * v
        seen += 1
        if seen >= p:
            out[i] = np.sqrt(v)
    return out


@njit(cache=True)
def _bollinger(c, p):
    """mid, variance, stddev over the last ``p`` closes (a shorter window early on, variance divided by ``p``)."""
    n = len(c)
    mid, var = np.empty(n), np.empty(n)
    for i in range(n):
        lo = max(0, i - p + 1)
        s = 0.0
        for j in range(lo, i + 1):
            s += c[j]
        m = s / (i + 1 - lo)
        q = 0.0
        for j in range(lo, i + 1):
            q += (c[j] - m) ** 2
        mid[i] = m
        var[i] = q / p
    return mid, var, np.sqrt(var)


@njit(cache=True)
def _donchian(h, l, v, p):
    """High / low / mean volume of the ``p`` bars BEFORE each bar (the current one excluded); NaN until there are p."""
    n = len(h)
    hi, lo, vm = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    for i in range(p, n):
        mx, mn, s = h[i - p], l[i - p], 0.0
        for j in range(i - p, i):
            mx = max(mx, h[j])
            mn = min(mn, l[j])
            s += v[j]
        hi[i], lo[i], vm[i] = mx, mn, s / p
    return hi, lo, vm


@njit(cache=True)
def _area(h, l, v, start, end, pct, bins):
    """(poc, vah, val) of the volume profile of bars ``start`` .. ``end - 1``; NaN when it has no range or no volume.

    The same rule and the same order of operations as ``indicator_catalog._profile`` (and ``valueArea`` of the Terminal): each
    volume is spread evenly over the bins its high-low range touches; the area grows from the POC toward the heavier
    neighbour (the upper one on a tie) until it holds ``pct`` % of the volume."""
    low = l[start]
    high = h[start]
    for j in range(start + 1, end):
        low = min(low, l[j])
        high = max(high, h[j])
    span = high - low
    if not span > 0.0:
        return np.nan, np.nan, np.nan
    volume = np.zeros(bins)
    last_bin = bins - 1
    for j in range(start, end):
        if not v[j] > 0.0:
            continue
        first = min(last_bin, max(0, int(np.floor((l[j] - low) * bins / span))))
        last = min(last_bin, max(0, int(np.floor((h[j] - low) * bins / span))))
        share = v[j] / (last - first + 1)
        for k in range(first, last + 1):
            volume[k] += share
    total = 0.0
    for k in range(bins):
        total += volume[k]
    if not total > 0.0:
        return np.nan, np.nan, np.nan
    poc = 0
    for k in range(1, bins):
        if volume[k] > volume[poc]:
            poc = k
    lo = poc
    hi = poc
    held = volume[poc]
    while held * 100.0 < total * pct and (lo > 0 or hi < last_bin):
        below = volume[lo - 1] if lo > 0 else -1.0
        above = volume[hi + 1] if hi < last_bin else -1.0
        if above >= below:
            hi += 1
            held += volume[hi]
        else:
            lo -= 1
            held += volume[lo]
    return low + span * (poc * 2 + 1) / (2.0 * bins), low + span * (hi + 1) / bins, low + span * lo / bins


@njit(cache=True)
def _valuearea(h, l, v, c, window, pct, bins, confirm):
    """The value area features of ``indicator_catalog`` (valuearea) on the 5m series: poc, vah, val of the ``window`` bars
    before each bar and, ``confirm`` bars after a fresh exit of that area, vaside / vaout / vain (NaN when there is no event)."""
    n = len(c)
    poc, vah, val = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    side, outside, inside = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    event = np.zeros(n, dtype=np.int8)
    event_vah, event_val = np.full(n, np.nan), np.full(n, np.nan)
    for t in range(n):
        if t >= window:
            poc[t], vah[t], val[t] = _area(h, l, v, t - window, t, pct, bins)
            if t >= 1 and not np.isnan(vah[t]) and val[t] <= c[t - 1] <= vah[t]:
                if c[t] > vah[t]:
                    event[t] = 1
                elif c[t] < val[t]:
                    event[t] = -1
                if event[t] != 0:
                    event_vah[t], event_val[t] = vah[t], val[t]
        if t >= confirm and event[t - confirm] != 0:
            e = t - confirm
            count = 0
            for j in range(e + 1, t + 1):
                if event[e] > 0:
                    if c[j] > event_vah[e]:
                        count += 1
                elif c[j] < event_val[e]:
                    count += 1
            side[t] = event[e]
            outside[t] = count
            inside[t] = 1.0 if event_val[e] <= c[t] <= event_vah[e] else 0.0
    return poc, vah, val, side, outside, inside


def _shift(a):
    out = np.empty_like(a)
    out[0] = np.nan
    out[1:] = a[:-1]
    return out


class FeatureStore:
    """Features of one market by scope, computed on demand and cached (several variants of a spec share one store)."""

    def __init__(self, market):
        self.m = market
        self.cache = {}
        self.va = None   # (window, pct, bins, confirm) of the spec being evaluated; evaluate_spec sets it
        self.idx5 = np.searchsorted(market.index5 + FIVE_MINUTES_MS, market.index + ONE_MINUTE_MS, side="right") - 1

    def base(self, resolution, name):
        key = (resolution, name)
        if key in self.cache:
            return self.cache[key]
        m = self.m
        o, h, l, c, v = ((m.o, m.h, m.l, m.c, m.v) if resolution == "1m" else (m.o5, m.h5, m.l5, m.c5, m.v5))
        if name in _CANDIDATES:
            result = {"c": c, "h": h, "l": l, "v": v}[_CANDIDATES[name]]
            self.cache[key] = result
            return result
        if name in AREA_FEATURES:
            if resolution != "5m" or self.va is None:
                raise UnsupportedSpec("el área de valor ({}.{}) solo existe en la serie de 5 m y hay que declararla en "
                                      "indicators.valuearea".format(resolution, name))
            return self._area_features()[name]
        match = _FEATURE.match(name)
        if match is None:
            raise UnsupportedSpec(_unsupported_feature(resolution, name))
        kind, period = match.group(1), int(match.group(2))
        if kind == "ema":
            self.cache[key] = _ema(c, period)
        elif kind == "sma":
            self.cache[key] = _sma(c, period)
        elif kind == "rsi":
            self.cache[key] = _rsi(c, period)
        elif kind == "atr":
            self.cache[key] = _atr(h, l, c, period)
        elif kind == "logret":
            self.cache[key] = _logret(c, period)
        elif kind == "logvol":
            self.cache[key] = _logvol(c, period)
        elif kind.startswith("bollinger"):
            mid, var, std = _bollinger(c, period)
            for suffix, arr in (("mid", mid), ("variance", var), ("stddev", std), ("lower", mid - 2.0 * std),
                                ("upper", mid + 2.0 * std)):
                self.cache[(resolution, "bollinger_{}{}".format(suffix, period))] = arr
        else:
            hi, lo, vm = _donchian(h, l, v, period)
            for label, arr in (("high", hi), ("low", lo), ("mid", (hi + lo) / 2.0)):
                self.cache[(resolution, "donchian_{}{}".format(label, period))] = arr
            self.cache[(resolution, "prior_volume_mean{}".format(period))] = vm
        return self.cache[key]

    def _area_features(self):
        """Value area arrays on the 5m series for the current configuration, cached per configuration."""
        key = ("valuearea", self.va)
        if key not in self.cache:
            window, pct, bins, confirm = self.va
            m = self.m
            arrays = _valuearea(m.h5, m.l5, m.v5, m.c5, window, float(pct), bins, confirm)
            self.cache[key] = dict(zip(("poc", "vah", "val", "vaside", "vaout", "vain"), arrays))
        return self.cache[key]

    def value(self, scope, name):
        """The feature as seen from each 1m bar, NaN where the engine's value would be ``None``."""
        key = ("scope", scope, name, self.va if name in AREA_FEATURES else None)
        if key in self.cache:
            return self.cache[key]
        if scope == "1m":
            out = self.base("1m", name)
        elif scope == "1m_previous":
            out = _shift(self.base("1m", name))
        elif scope == "5m":
            five = self.base("5m", name)
            out = np.where(self.idx5 >= 0, five[np.maximum(self.idx5, 0)], np.nan)
        else:
            raise UnsupportedSpec("el alcance «{}» no se puede calcular en el laboratorio".format(scope))
        self.cache[key] = out
        return out

    def ready(self, resolution, periods):
        """The engine's ``ready``: 50 candles, every ATR positive, every Donchian window full."""
        key = ("ready", resolution, tuple(sorted((k, tuple(v)) for k, v in periods.items())))
        if key in self.cache:
            return self.cache[key]
        n = len(self.base(resolution, "candidate_close"))
        ok = np.arange(1, n + 1) >= MINIMUM_CANDLES
        with np.errstate(invalid="ignore"):
            for period in periods.get("atr", ()):
                atr = self.base(resolution, "atr{}".format(period))
                ok &= ~np.isnan(atr) & (atr > 0)
        for period in periods.get("donchian", ()):
            ok &= np.arange(n) >= period
        self.cache[key] = ok
        return ok

    def regime(self):
        """The regime on every 1m bar (``UNKNOWN`` / ``TREND`` / ``RANGE``) with the engine's hysteresis."""
        if "regime" in self.cache:
            return self.cache["regime"]
        fast, slow, atr = (self.base("5m", name) for name in ("ema9", "ema21", "atr14"))
        state = UNKNOWN
        regime5 = np.zeros(len(fast), dtype=np.int8)
        for i in range(len(fast)):
            if math.isnan(fast[i]) or math.isnan(slow[i]) or math.isnan(atr[i]) or atr[i] <= 0:
                state = UNKNOWN
            else:
                ratio = abs(fast[i] - slow[i]) / atr[i]
                if ratio > 0.5:
                    state = TREND
                elif ratio < 0.2:
                    state = RANGE
            regime5[i] = state
        out = np.where(self.idx5 >= 0, regime5[np.maximum(self.idx5, 0)], UNKNOWN).astype(np.int8)
        self.cache["regime"] = out
        return out


def _unsupported_feature(scope, name):
    if name == "fundpct":
        return ("la estrategia lee la posición del funding frente a los últimos 30 días ({}.fundpct); el laboratorio no "
                "reproduce el historial de funding tal como se conocía en cada momento, así que no se puede evaluar".format(scope))
    return "la estrategia usa el dato «{}.{}», que el laboratorio no calcula".format(scope, name)


# ----------------------------------------------------------------------------------------- the compiled exit
OP_END, OP_BOOL, OP_CMP, OP_AND, OP_OR, OP_NOT = 0, 1, 2, 3, 4, 5
STACK_SIZE = 32
MAX_POWER = 3


class ExitPrograms:
    """The exit rules of every (branch, side) compiled to postfix programs over two banks of arrays.

    A subtree that does not read ``position.*`` is evaluated for all bars at once (one boolean array). A comparison that
    does read it keeps its sides as ``coefficient x frozen_target^a x frozen_invalidation^b`` and is finished bar by bar
    inside the simulation, once the levels frozen at entry are known.
    """

    def __init__(self, n):
        self.n = n
        self.bools, self.lcoef, self.rcoef, self.meta, self.programs, self.codes = [], [], [], [], [], set()

    def add_bool(self, array):
        self.bools.append(np.asarray(array, dtype=np.uint8))
        return len(self.bools) - 1

    def add_cmp(self, left, op, right):
        (lc, lt, li), (rc, rt, ri) = left, right
        if max(lt, li, rt, ri) > MAX_POWER:
            raise UnsupportedSpec("una regla de salida multiplica demasiadas veces el nivel congelado de la posición")
        self.lcoef.append(np.broadcast_to(np.asarray(lc, dtype=np.float64), (self.n,)).copy())
        self.rcoef.append(np.broadcast_to(np.asarray(rc, dtype=np.float64), (self.n,)).copy())
        self.meta.append((_OPS[op], lt, li, rt, ri))
        return len(self.meta) - 1

    def pack(self):
        n = self.n
        bools = np.stack(self.bools) if self.bools else np.zeros((1, n), dtype=np.uint8)
        lcoef = np.stack(self.lcoef) if self.lcoef else np.zeros((1, n))
        rcoef = np.stack(self.rcoef) if self.rcoef else np.zeros((1, n))
        meta = np.array(self.meta, dtype=np.int64) if self.meta else np.zeros((1, 5), dtype=np.int64)
        width = max([len(p) for p in self.programs] + [1]) + 1
        ops = np.zeros((max(len(self.programs), 1), width), dtype=np.int64)
        a1, a2 = np.zeros_like(ops), np.zeros_like(ops)
        for p, program in enumerate(self.programs):
            for k, (op, x, y) in enumerate(program):
                ops[p, k], a1[p, k], a2[p, k] = op, x, y
        return {"ops": ops, "a1": a1, "a2": a2, "bools": bools, "lcoef": lcoef, "rcoef": rcoef, "meta": meta}


@njit(cache=True)
def eval_program(p, i, ops, a1, a2, bools, lcoef, rcoef, meta, ft, fi, stack):
    """True when program ``p`` fires on bar ``i`` for a position with frozen levels ``ft`` (target) and ``fi`` (invalidation)."""
    sp = 0
    for k in range(ops.shape[1]):
        op = ops[p, k]
        if op == 0:
            break
        if op == 1:
            stack[sp] = bools[a1[p, k], i] != 0
            sp += 1
        elif op == 2:
            m = a1[p, k]
            left, right = lcoef[m, i], rcoef[m, i]
            for _ in range(meta[m, 1]):
                left *= ft
            for _ in range(meta[m, 2]):
                left *= fi
            for _ in range(meta[m, 3]):
                right *= ft
            for _ in range(meta[m, 4]):
                right *= fi
            code = meta[m, 0]
            if code == 0:
                r = left > right
            elif code == 1:
                r = left >= right
            elif code == 2:
                r = left < right
            else:
                r = left <= right
            stack[sp] = r
            sp += 1
        elif op == 3 or op == 4:
            count = a2[p, k]
            r = op == 3
            for _ in range(count):
                sp -= 1
                if op == 3:
                    r = r and stack[sp]
                else:
                    r = r or stack[sp]
            stack[sp] = r
            sp += 1
        else:
            stack[sp - 1] = not stack[sp - 1]
    return stack[0] if sp > 0 else False


# ------------------------------------------------------------------------------------------------ the plan
@dataclass
class Plan:
    spec_id: str
    spec_hash: str
    product: str
    n: int
    ready: np.ndarray
    regime: np.ndarray
    raw_side: np.ndarray          # +1 LONG, -1 SHORT, 0 none: what propose_spec returns with no position open
    side: np.ndarray              # raw_side without the signals the engine skips (target does not clear the cost)
    skipped_cost: np.ndarray      # bool: the engine would skip this signal
    stop: np.ndarray
    target: np.ndarray
    frozen_target: np.ndarray
    frozen_invalidation: np.ndarray
    horizon: np.ndarray           # minutes
    branch: np.ndarray            # index into ``branches``
    branches: list
    programs: dict
    exit_codes: list              # codes of the comparisons / regime tests of the strategy's own exit
    has_rule_exit: bool = False   # False when the exit rule is a constant "never" (stop, target and time only)
    risk: dict = field(default_factory=dict)


class _Branch:
    """One ``rules`` block evaluated over all bars."""

    def __init__(self, store, rules, params, periods, programs, tick):
        self.s, self.rules, self.params, self.programs, self.tick = store, rules, params, programs, tick
        self.n = store.m.bars
        self.regime = store.regime()
        self.ready = store.ready("1m", periods)
        self.trend_ready = store.ready("5m", periods)
        self.trend_ready_1m = np.where(store.idx5 >= 0, self.trend_ready[np.maximum(store.idx5, 0)], False)

    # ---- operands and nodes
    def operand(self, op, position=False):
        if isinstance(op, dict):
            left, right = (self.operand(x, position) for x in op["mul"])
            return left * right
        if op.startswith("$"):
            return float(Decimal(self.params[op[1:]]))
        if "." in op:
            scope, field_name = op.split(".", 1)
            if scope == "position":
                return NAN
            return self.s.value(scope, field_name)
        return float(Decimal(op))

    def full(self, value):
        return np.broadcast_to(np.asarray(value), (self.n,))

    def node(self, node):
        if "cmp" in node:
            left, right = self.operand(node["left"]), self.operand(node["right"])
            with np.errstate(invalid="ignore"):
                result = {">": np.greater, ">=": np.greater_equal, "<": np.less, "<=": np.less_equal}[node["op"]](left, right)
            return self.full(result)
        if "available" in node:
            return self.full(~np.isnan(self.operand(node["operand"])))
        if "regime_in" in node:
            return np.isin(self.regime, [REGIME_CODE[r] for r in node["regime_in"]])
        if "not" in node:
            return ~self.node(node["not"])
        if "and" in node or "all" in node:
            parts = [self.node(c) for c in node["and" if "and" in node else "all"]]
            out = parts[0]
            for p in parts[1:]:
                out = out & p
            return out
        parts = [self.node(c) for c in node["any"]]
        out = parts[0]
        for p in parts[1:]:
            out = out | p
        return out

    # ---- exit rule compiled
    @staticmethod
    def reads_position(node):
        if isinstance(node, str):
            return node.startswith("position.")
        if isinstance(node, dict):
            return any(_Branch.reads_position(v) for v in node.values())
        if isinstance(node, list):
            return any(_Branch.reads_position(v) for v in node)
        return False

    def term(self, op):
        if isinstance(op, dict):
            (a, pa, ia), (b, pb, ib) = (self.term(x) for x in op["mul"])
            return a * b, pa + pb, ia + ib
        if isinstance(op, str) and op.startswith("position."):
            return 1.0, int(op == "position.frozen_target"), int(op == "position.frozen_invalidation")
        return self.operand(op), 0, 0

    def compile(self, node, out):
        """Appends the postfix of ``node`` to ``out`` and records the codes of the rule."""
        if not self.reads_position(node):
            self._codes(node)
            out.append((OP_BOOL, self.programs.add_bool(self.node(node)), 0))
        elif "cmp" in node:
            self.programs.codes.add(node["cmp"])
            out.append((OP_CMP, self.programs.add_cmp(self.term(node["left"]), node["op"], self.term(node["right"])), 0))
        elif "available" in node:
            raise UnsupportedSpec("una regla de salida pregunta si un nivel de la posición está disponible "
                                  "(«available» sobre position.*); el laboratorio no lo evalúa")
        elif "not" in node:
            self.compile(node["not"], out)
            out.append((OP_NOT, 0, 0))
        else:
            kind = "and" if "and" in node else "all" if "all" in node else "any"
            children = node[kind]
            for child in children:
                self.compile(child, out)
            out.append((OP_OR if kind == "any" else OP_AND, 0, len(children)))

    def _codes(self, node):
        if isinstance(node, dict):
            for key in ("cmp", "available", "code"):
                if isinstance(node.get(key), str):
                    self.programs.codes.add(node[key])
            for value in node.values():
                if isinstance(value, (dict, list)):
                    self._codes(value)
        elif isinstance(node, list):
            for value in node:
                self._codes(value)

    def exit_program(self, side):
        out = []
        self.compile(self.rules["exit"][side], out)
        if len(out) > STACK_SIZE - 2:
            raise UnsupportedSpec("la regla de salida es demasiado compleja para el laboratorio")
        self.programs.programs.append(out)
        return len(self.programs.programs) - 1

    # ---- entries
    def entries(self):
        rules = self.rules
        n = self.n
        base = self.ready.copy()
        for gate in rules.get("gates", []):
            if gate["require"] == "previous":
                base &= np.arange(n) > 0
            else:
                base &= self.trend_ready_1m
        results = {}
        for check in rules["checks"]:
            value = self.node(check["node"])
            if "name" in check:
                results[check["name"]] = value
        chosen = np.zeros(n, dtype=np.int8)
        taken = np.zeros(n, dtype=bool)
        for code, side in ((1, "LONG"), (-1, "SHORT")):
            entry = rules["sides"].get(side)
            if entry is None:
                continue
            ok = np.ones(n, dtype=bool)
            for name in entry["requires"]:
                ok = ok & results[name]
            ok &= ~taken
            chosen[ok] = code
            taken |= ok
        chosen[~base] = 0
        return chosen

    def levels(self, chosen):
        """Stop / target / frozen levels of the chosen side; bars whose levels the engine would refuse (ABSTAIN) drop out."""
        rules, tick = self.rules, self.tick
        n = self.n
        c = self.s.value("1m", "candidate_close")
        risk = rules["risk"]
        horizon = rules["horizon_minutes"]
        if "vol" in risk:
            bar_vol = self.operand(risk["vol"])
            atr = bar_vol * math.sqrt(horizon / risk["vol_minutes"]) * c
        else:
            atr = self.s.value("1m", "atr14")
        stop_atr = float(Decimal(self._param(risk["stop_atr"])))
        ratio = float(Decimal(self._param(risk["target_stop_ratio"])))
        stop, target = np.full(n, np.nan), np.full(n, np.nan)
        frozen_inv = np.full(n, np.nan)
        valid = np.zeros(n, dtype=bool)
        with np.errstate(invalid="ignore", divide="ignore"):
            distance = atr * stop_atr
            good = ~np.isnan(c) & ~np.isnan(atr) & (c > 0) & (atr > 0)
            for code, side in ((1, "LONG"), (-1, "SHORT")):
                entry = rules["sides"].get(side)
                mask = chosen == code
                if entry is None or not mask.any():
                    continue
                if code == 1:
                    s = np.floor((c - distance) / tick) * tick
                else:
                    s = np.ceil((c + distance) / tick) * tick
                ok = mask & good & (s > 0)
                if "target" in entry:
                    tv = self.full(self.operand(entry["target"]))
                    ok &= ~np.isnan(tv) & ((tv > c) if code == 1 else (tv < c))
                    t = (np.floor(tv / tick) if code == 1 else np.ceil(tv / tick)) * tick
                else:
                    t = (np.ceil((c + distance * ratio) / tick) if code == 1
                         else np.floor((c - distance * ratio) / tick)) * tick
                stop[ok], target[ok], valid[ok] = s[ok], t[ok], True
                frozen_inv[ok] = self._frozen_invalidation(entry["invalidation"])[ok] if ok.any() else np.nan
        return valid, stop, target, frozen_inv

    def _param(self, value):
        return self.params[value[1:]] if isinstance(value, str) and value.startswith("$") else value

    def _frozen_invalidation(self, template):
        """The level after the last ``@`` of the rendered invalidation text, like the engine's ``_frozen_level``."""
        if "@" not in template:
            return np.full(self.n, np.nan)
        tail = template.rsplit("@", 1)[1]
        placeholder = re.fullmatch(r"\{([^{}]+)\}", tail)
        if placeholder:
            return self.full(self.operand(placeholder.group(1))).astype(np.float64)
        if "{" in tail or "}" in tail:
            raise UnsupportedSpec("el texto de invalidación mezcla un nivel con otro texto después de «@»: "
                                  "no se puede congelar el nivel ({})".format(template))
        try:
            value = Decimal(tail)
            return np.full(self.n, float(value) if value.is_finite() else np.nan)
        except InvalidOperation:
            return np.full(self.n, np.nan)


def _check_supported(spec):
    """Fails early and clearly on whatever the evaluator does not reproduce."""
    try:
        validate_spec(spec)
    except SpecError as error:
        raise UnsupportedSpec("la spec no es válida para el motor: {}".format(error)) from error
    kind = spec.get("kind", "rules")
    if kind not in ("rules", "regime_adapter"):
        raise UnsupportedSpec("el tipo de estrategia «{}» no está soportado".format(kind))


def _branch_rules(spec):
    if spec.get("kind", "rules") == "rules":
        return [(spec["id"], None, spec["rules"])]
    return [(b["id"], REGIME_CODE[regime], b["rules"]) for regime, b in spec["branches"].items()]


def _touch_features(store, node):
    """Resolves every feature of the spec once, so an unsupported one fails before any work is done."""
    if isinstance(node, str):
        if "." in node and node.split(".", 1)[0] in ("1m", "1m_previous", "5m"):
            scope, name = node.split(".", 1)
            store.value(scope, name)
    elif isinstance(node, dict):
        for value in node.values():
            _touch_features(store, value)
    elif isinstance(node, list):
        for value in node:
            _touch_features(store, value)


def evaluate_spec(spec, market, store=None):
    """The ``Plan`` of ``spec`` over ``market``. Raises ``UnsupportedSpec`` for anything it cannot reproduce."""
    _check_supported(spec)
    store = store or FeatureStore(market)
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    store.va = periods["valuearea"][0] if "valuearea" in periods else None
    params = spec.get("params", {})
    n = market.bars
    programs = ExitPrograms(n)
    for _, _, rules in _branch_rules(spec):
        _touch_features(store, {k: v for k, v in rules.items() if k != "risk"})
        risk = rules["risk"]
        if "vol" in risk:
            _touch_features(store, risk["vol"])
    chosen = np.zeros(n, dtype=np.int8)
    stop, target = np.full(n, np.nan), np.full(n, np.nan)
    frozen_inv = np.full(n, np.nan)
    horizon = np.zeros(n, dtype=np.int64)
    branch_idx = np.zeros(n, dtype=np.int8)
    branches, exit_index = [], []
    regime = store.regime()
    ready = store.ready("1m", periods)
    for k, (branch_id, regime_code, rules) in enumerate(_branch_rules(spec)):
        branch = _Branch(store, rules, params, periods, programs, market.tick)
        chosen_b = branch.entries()
        if regime_code is not None:
            chosen_b = np.where(regime == regime_code, chosen_b, 0).astype(np.int8)
        valid, stop_b, target_b, inv_b = branch.levels(chosen_b)
        keep = valid & (chosen_b != 0)
        chosen[keep] = chosen_b[keep]
        stop[keep], target[keep], frozen_inv[keep] = stop_b[keep], target_b[keep], inv_b[keep]
        horizon[keep] = rules["horizon_minutes"]
        branch_idx[keep] = k
        branches.append({"id": branch_id, "regime": regime_code})
        exit_index.append((branch.exit_program("LONG"), branch.exit_program("SHORT")))
    c = store.value("1m", "candidate_close")
    rate = float(futures_costs.round_trip_rate(market.product)) + COST_BUFFER_RATE
    with np.errstate(invalid="ignore"):
        skipped = (chosen != 0) & (np.abs(target - c) <= c * rate)
    has_rule_exit = any(not (len(p) == 1 and p[0][0] == OP_BOOL and not programs.bools[p[0][1]].any())
                        for p in programs.programs)
    packed = programs.pack()
    packed["exit_index"] = np.array(exit_index, dtype=np.int64).reshape(len(exit_index), 2)
    return Plan(
        spec_id=spec["id"], spec_hash=canonical_hash(spec), product=market.product, n=n, ready=ready, regime=regime,
        raw_side=chosen, side=np.where(skipped, 0, chosen).astype(np.int8), skipped_cost=skipped, stop=stop,
        target=target, frozen_target=target.copy(), frozen_invalidation=frozen_inv, horizon=horizon,
        branch=branch_idx, branches=branches, programs=packed,
        exit_codes=sorted(programs.codes) if has_rule_exit else [], has_rule_exit=has_rule_exit)


def supported_or_reason(spec, market):
    """``(plan, None)`` or ``(None, reason)`` — the reason is the Spanish message of ``UnsupportedSpec``."""
    try:
        return evaluate_spec(spec, market), None
    except UnsupportedSpec as error:
        return None, str(error)
