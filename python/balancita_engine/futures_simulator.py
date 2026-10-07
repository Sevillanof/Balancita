"""One simulator for every strategy (SS-03).

``simulate_many(specs, candles_1m, candles_5m, ...)`` streams official candles
once: incremental indicators (O(1) per bar for the recursive ones, fixed 20/50-bar
windows for the rolling ones), the regime chain, and one independent paper book
per spec. It reads no stored verdict features. ``IncrementalFeatures`` produces
exactly ``calculate_features`` run over the whole history (the parity test
pins it), so live C, D, the backtest, E and Qwen's score can share it.

Sizing is a fixed notional per trade (default 100 USD, Fran 2026-10-07), long or
short; costs come only from ``futures_costs``. Funding: pass the product's relative funding periods; a trade pays or receives it for the time held.

Candles are dicts ``bucket_start`` (ms), ``open/high/low/close/volume_btc`` (decimal
strings). Decision at the close of each 1m bucket; fills at that close plus the
product's execution cost.
"""

from collections import deque
from decimal import Decimal, localcontext

from .canonical import normalize_decimal
from .futures_costs import DEFAULT_PRODUCT, entry_fill, exit_fill, fee_rate, round_trip_rate
from .futures_hits import direction_hit, gross_bp, trade_hit
from .futures_indicators import FEATURE_SCHEMA_VERSION, INDICATOR_PRECISION, MINIMUM_CANDLES
from .futures_spec_strategy import declared_indicators, propose_spec
from .futures_strategies import update_regime

ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
DEFAULT_NOTIONAL_USD = "100"
COST_BUFFER_RATE = Decimal("0.0002")
D = Decimal


def _n(value):
    return None if value is None else normalize_decimal(str(value))


DEFAULT_PERIODS = {
    "ema": (9, 21), "sma": (50,), "rsi": (14,), "atr": (14,), "bollinger": (20,), "donchian": (20,),
}
PERIOD_KINDS = tuple(DEFAULT_PERIODS)
# The regime chain reads these three on the 5m series whatever a spec declares.
REGIME_PERIODS = {"ema": (9, 21), "atr": (14,)}


def merge_periods(*declared):
    """Union of period declarations, each kind sorted and unique."""
    merged = {kind: set() for kind in PERIOD_KINDS}
    for periods in declared:
        for kind, values in periods.items():
            if kind not in merged:
                raise ValueError("unknown indicator kind {!r}".format(kind))
            for value in values:
                if isinstance(value, bool) or not isinstance(value, int) or not 2 <= value <= 400:
                    raise ValueError("indicator periods are integers from 2 to 400")
                merged[kind].add(value)
    return {kind: tuple(sorted(values)) for kind, values in merged.items() if values}


class IncrementalFeatures:
    """Closed-bar features one candle at a time.

    With the default periods the output equals ``calculate_features`` over the
    whole history (same keys, same strings). Other periods use the same names
    with the period as suffix (``ema12``, ``rsi7``, ``bollinger_upper10``, ``donchian_mid55``).
    """

    def __init__(self, periods=None):
        self.periods = merge_periods(DEFAULT_PERIODS if periods is None else periods)
        reach = max([p for values in self.periods.values() for p in values] + [MINIMUM_CANDLES])
        self.count = 0
        self.closes = deque(maxlen=reach)
        self.highs = deque(maxlen=reach + 1)
        self.lows = deque(maxlen=reach + 1)
        self.volumes = deque(maxlen=reach + 1)
        self._ema = {p: [None, []] for p in self.periods.get("ema", ())}
        self._atr = {p: [None, []] for p in self.periods.get("atr", ())}
        self._rsi = {p: [None, None, []] for p in self.periods.get("rsi", ())}
        self._prev_close = None

    def update(self, candle):
        with localcontext() as context:
            context.prec = INDICATOR_PRECISION
            return self._update(candle)

    def _update(self, candle):
        high, low, close = D(candle["high"]), D(candle["low"]), D(candle["close"])
        volume = D(candle["volume_btc"])
        self.count += 1
        before_highs, before_lows, before_volumes = list(self.highs), list(self.lows), list(self.volumes)
        self.closes.append(close)
        self.highs.append(high)
        self.lows.append(low)
        self.volumes.append(volume)
        for period, state in self._ema.items():
            alpha = D(2) / D(period + 1)
            if state[0] is None:
                state[1].append(close)
                if len(state[1]) == period:
                    state[0] = sum(state[1], D(0)) / D(period)
            else:
                state[0] = alpha * close + (D(1) - alpha) * state[0]
        true_range = high - low
        if self._prev_close is not None:
            true_range = max(true_range, abs(high - self._prev_close), abs(low - self._prev_close))
        for period, state in self._atr.items():
            if state[0] is None:
                state[1].append(true_range)
                if len(state[1]) == period:
                    state[0] = sum(state[1], D(0)) / D(period)
            else:
                state[0] = (state[0] * D(period - 1) + true_range) / D(period)
        if self._prev_close is not None:
            change = close - self._prev_close
            gain, loss = max(change, D(0)), max(-change, D(0))
            for period, state in self._rsi.items():
                if state[0] is None:
                    state[2].append((gain, loss))
                    if len(state[2]) == period:
                        state[0] = sum((g for g, _ in state[2]), D(0)) / D(period)
                        state[1] = sum((l for _, l in state[2]), D(0)) / D(period)
                else:
                    state[0] = (state[0] * D(period - 1) + gain) / D(period)
                    state[1] = (state[1] * D(period - 1) + loss) / D(period)
        self._prev_close = close

        out = {"schema_version": FEATURE_SCHEMA_VERSION, "ready": True, "reason_codes": [], "candidate_close": _n(close)}
        reasons = []
        for period, state in self._ema.items():
            out["ema{}".format(period)] = _n(state[0])
        for period in self.periods.get("sma", ()):
            out["sma{}".format(period)] = _n(
                sum(list(self.closes)[-period:], D(0)) / D(period) if len(self.closes) >= period else None)
        for period, state in self._rsi.items():
            rsi = None
            if state[0] is not None:
                if state[1] == 0:
                    rsi = D(50) if state[0] == 0 else D(100)
                else:
                    rsi = D(100) - D(100) / (D(1) + state[0] / state[1])
            out["rsi{}".format(period)] = _n(rsi)
        for period, state in self._atr.items():
            out["atr{}".format(period)] = _n(state[0])
            if state[0] is None or state[0] <= 0:
                reasons.append("invalid_or_zero_atr")
        for period in self.periods.get("bollinger", ()):
            window = list(self.closes)[-period:]
            mid = sum(window, D(0)) / D(len(window))
            variance = sum(((v - mid) ** 2 for v in window), D(0)) / D(period)
            stddev = variance.sqrt()
            out["bollinger_mid{}".format(period)] = _n(mid)
            out["bollinger_variance{}".format(period)] = _n(variance)
            out["bollinger_stddev{}".format(period)] = _n(stddev)
            out["bollinger_lower{}".format(period)] = _n(mid - D(2) * stddev)
            out["bollinger_upper{}".format(period)] = _n(mid + D(2) * stddev)
        for period in self.periods.get("donchian", ()):
            window = slice(-period, None) if before_highs else slice(0, 0)
            ph, pl, pv = before_highs[window], before_lows[window], before_volumes[window]
            if len(ph) == period:
                d_high, d_low, prior = max(ph), min(pl), sum(pv, D(0)) / D(period)
            else:
                d_high = d_low = prior = None
                reasons.append("insufficient_donchian_warmup")
            out["donchian_high{}".format(period)] = _n(d_high)
            out["donchian_low{}".format(period)] = _n(d_low)
            out["donchian_mid{}".format(period)] = _n(None if d_high is None else (d_high + d_low) / D(2))
            out["prior_volume_mean{}".format(period)] = _n(prior)
        if self.count < MINIMUM_CANDLES:
            reasons.append("insufficient_candle_warmup")
        out.update({
            "bollinger_ddof": 0, "candidate_volume": _n(volume), "smoothing": "wilder",
            "candidate_bucket_start_ms": candle["bucket_start"],
            "candidate_low": candle["low"], "candidate_high": candle["high"],
        })
        out["ready"], out["reason_codes"] = not reasons, reasons
        return out


def frames(candles_1m, candles_5m, periods=None):
    """Per closed 1m bucket: (bucket_start, current, previous, trend, regime) with no lookahead.

    ``periods``: indicator periods to compute on both series (default set when None);
    the regime chain's EMA 9/21 and ATR 14 on 5m are always included.
    """
    periods = merge_periods(DEFAULT_PERIODS if periods is None else periods, REGIME_PERIODS)
    one, five = IncrementalFeatures(periods), IncrementalFeatures(periods)
    fives = iter(candles_5m)
    pending = next(fives, None)
    trend, previous, regime = None, None, "unknown"
    for candle in candles_1m:
        current = one.update(candle)
        close_at = candle["bucket_start"] + ONE_MINUTE_MS
        while pending is not None and pending["bucket_start"] + FIVE_MINUTES_MS <= close_at:
            trend = five.update(pending)
            pending = next(fives, None)
        if trend is not None:
            regime = update_regime(regime, trend.get("ema9"), trend.get("ema21"), trend.get("atr14"))
        yield candle["bucket_start"], current, previous, trend, regime
        previous = current


def _frozen_level(invalidation):
    if isinstance(invalidation, str) and "@" in invalidation:
        level = invalidation.rsplit("@", 1)[1]
        try:
            return level if D(level).is_finite() else None
        except ArithmeticError:
            return None
    return None


class Book:
    """One independent paper book for one strategy: one position at a time, fixed notional."""

    def __init__(self, spec, *, product_id=DEFAULT_PRODUCT, tick_size="1", notional_usd=DEFAULT_NOTIONAL_USD,
                 funding=()):
        self.spec, self.product, self.tick_size = spec, product_id, tick_size
        # (start_ms, end_ms, relative rate per hour); a positive rate is paid by longs.
        self.funding = sorted((int(a), int(b), D(str(r))) for a, b, r in funding)
        self.notional = D(notional_usd)
        self.position = None
        self.trades, self.skipped, self.decisions = [], [], []
        self._open_decisions = []
        self.bucket = None

    def on_frame(self, bucket, current, previous, trend, regime):
        # Decision outcomes are judged on the closes `horizon` minutes later.
        close = current.get("candidate_close")
        still = []
        for decision in self._open_decisions:
            if bucket + ONE_MINUTE_MS >= decision["horizon_end_ms"] and close is not None:
                reference = decision["reference_close"]
                decision["outcome_close"] = close
                decision["gross_bp"] = float(round(gross_bp(decision["side"], reference, close), 4))
                decision["direction_hit"] = direction_hit(decision["side"], reference, close)
            else:
                still.append(decision)
        self._open_decisions = still
        common = {"previous": previous, "trend": trend, "regime": regime, "tick_size": self.tick_size}
        self.bucket = bucket
        if self.position is not None:
            self._manage(bucket, current, common)
            return
        if not current.get("ready"):
            return
        proposal = self._entry_proposal(current, common)
        if proposal is None or proposal["action"] not in ("LONG", "SHORT"):
            return
        side = proposal["action"]
        reference = D(current["candidate_close"])
        horizon_ms = proposal["horizon_minutes"] * ONE_MINUTE_MS
        decision = {
            "bucket_ms": bucket, "strategy_id": proposal["strategy_id"], "side": side,
            "reference_close": str(reference), "horizon_end_ms": bucket + ONE_MINUTE_MS + horizon_ms,
            "outcome_close": None, "gross_bp": None, "direction_hit": None, "traded": False,
            "trade_net_usd": None, "trade_hit": None,
        }
        self.decisions.append(decision)
        self._open_decisions.append(decision)
        stop, target = D(proposal["proposed_stop"]), D(proposal["proposed_target"])
        entry = entry_fill(reference, side, self.product)
        cost_per_unit = reference * (round_trip_rate(self.product) + COST_BUFFER_RATE)
        if abs(target - reference) <= cost_per_unit:
            self.skipped.append({"bucket_ms": bucket, "side": side, "reason": "target_does_not_clear_cost"})
            return
        decision["traded"] = True
        self.position = {
            "decision": decision, "strategy_id": proposal["strategy_id"], "side": side, "entry": entry,
            "stop": stop, "target": target, "target_text": proposal["proposed_target"],
            "frozen_invalidation": _frozen_level(proposal.get("invalidation")),
            "delegated": proposal.get("delegated_strategy_id"), "opened_bucket": bucket,
            "opened_at": bucket + ONE_MINUTE_MS, "horizon_ms": horizon_ms,
            "quantity": self.notional / entry, "reason_code": proposal["reason_code"],
        }

    def _entry_proposal(self, current, common):
        return propose_spec(self.spec, current, **common)

    def _rule_exit(self, position, current, common, close):
        """The strategy's own exit at the candle close: ``(price, reason)`` or ``None``."""
        proposal = propose_spec(
            self.spec, current, position_side=position["side"], delegated_strategy_id=position["delegated"],
            frozen_target=position["target_text"], frozen_invalidation=position["frozen_invalidation"], **common)
        return (D(close), "strategy_exit") if proposal["action"] == "FLAT" else None

    def _manage(self, bucket, current, common):
        position = self.position
        long = position["side"] == "LONG"
        low, high, close = current.get("candidate_low"), current.get("candidate_high"), current.get("candidate_close")
        exit_price = reason = None
        if low is not None and high is not None:
            low, high = D(low), D(high)
            if (low <= position["stop"]) if long else (high >= position["stop"]):
                exit_price, reason = position["stop"], "stop"
            elif (high >= position["target"]) if long else (low <= position["target"]):
                exit_price, reason = position["target"], "target"
        if exit_price is None and close is not None:
            rule = self._rule_exit(position, current, common, close)
            if rule is not None:
                exit_price, reason = rule
            elif bucket + ONE_MINUTE_MS - position["opened_at"] >= position["horizon_ms"]:
                exit_price, reason = D(close), "time_stop"
        if exit_price is None:
            return
        exit_price = exit_fill(exit_price, position["side"], self.product, reason)
        entry, quantity = position["entry"], position["quantity"]
        gross = (exit_price - entry) * quantity if long else (entry - exit_price) * quantity
        fees = (entry + exit_price) * quantity * fee_rate("taker")
        funding, funding_complete = self._funding(position["opened_at"], bucket + ONE_MINUTE_MS,
                                                  entry * quantity, long)
        pnl = gross - fees - funding
        decision = position["decision"]
        decision["trade_net_usd"] = float(round(pnl, 4))
        decision["trade_hit"] = trade_hit(pnl)
        self.trades.append({
            "strategy_id": position["strategy_id"], "side": position["side"],
            "entry_bucket_ms": position["opened_bucket"], "entry_time_ms": position["opened_at"],
            "entry_price": str(entry), "stop_price": str(position["stop"]), "target_price": position["target_text"],
            "exit_bucket_ms": bucket, "exit_time_ms": bucket + ONE_MINUTE_MS, "exit_price": str(exit_price),
            "exit_reason": reason, "quantity": str(quantity), "notional_usd": str(self.notional),
            "net_bp": float(round(pnl / self.notional * 10_000, 4)), "pnl_usd": float(round(pnl, 4)),
            "hit": trade_hit(pnl), "reason_code": position["reason_code"],
            "funding_usd": float(round(funding, 6)), "funding_complete": funding_complete,
        })
        self.position = None

    def _funding(self, start_ms, end_ms, notional, long):
        """Funding paid (positive) or received over the holding period, and whether history covered it."""
        total, covered = D(0), 0
        for left, right, rate in self.funding:
            a, b = max(start_ms, left), min(end_ms, right)
            if b <= a:
                continue
            covered += b - a
            total += rate * D(b - a) / D(3_600_000) * notional
        complete = bool(self.funding) and covered >= end_ms - start_ms
        return (total if long else -total), complete

    def summary(self):
        trades = self.trades
        wins = sum(1 for t in trades if t["hit"])
        judged = [d for d in self.decisions if d["direction_hit"] is not None]
        pnl = sum(t["pnl_usd"] for t in trades)
        return {
            "strategy_id": self.spec["id"], "trades": len(trades), "wins": wins,
            "trade_hit_rate": round(wins / len(trades), 4) if trades else None,
            "pnl_usd": round(pnl, 4), "return_pct_on_notional": round(pnl / float(self.notional) * 100, 4),
            "decisions": len(self.decisions), "decisions_judged": len(judged),
            "decision_hit_rate": round(sum(1 for d in judged if d["direction_hit"]) / len(judged), 4) if judged else None,
            "skipped": len(self.skipped),
        }


def simulate_many(specs, candles_1m, candles_5m, *, product_id=DEFAULT_PRODUCT, tick_size="1",
                  notional_usd=DEFAULT_NOTIONAL_USD, funding=()):
    """Run every spec on its own book over one candle stream; indicators are computed once."""
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(spec) for spec in specs))
    books = [Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd, funding=funding) for spec in specs]
    for frame in frames(candles_1m, candles_5m, periods):
        for book in books:
            book.on_frame(*frame)
    return books


def simulate(spec, candles_1m, candles_5m, **kwargs):
    return simulate_many([spec], candles_1m, candles_5m, **kwargs)[0]


class DecisionBook(Book):
    """Qwen's buy / hold / sell answers traded in the same book, fills and costs as a strategy.

    ``chosen`` maps a bucket to ``buy`` | ``hold`` | ``sell``. buy opens a long and sell a
    short; the opposite answer closes at the candle close and hold keeps the position. The
    protective levels are the shipped strategies' default plan: stop ``stop_atr`` ATR, target
    ``target_ratio`` times the stop, time stop after ``horizon_min``.
    """

    STRATEGY_ID = "qwen-trade-action"

    def __init__(self, chosen, *, horizon_min=30, stop_atr="1.5", target_ratio="2", **kwargs):
        super().__init__({"id": self.STRATEGY_ID}, **kwargs)
        self.chosen = chosen
        self.horizon_min, self.stop_atr, self.target_ratio = horizon_min, D(stop_atr), D(target_ratio)

    def _entry_proposal(self, current, common):
        answer = self.chosen.get(self.bucket)
        if answer not in ("buy", "sell"):
            return None
        side = "LONG" if answer == "buy" else "SHORT"
        close, atr = current.get("candidate_close"), current.get("atr14")
        if close is None or atr is None or D(atr) <= 0:
            self.skipped.append({"bucket_ms": self.bucket, "side": side, "reason": "protective_levels_unavailable"})
            return None
        entry, distance = D(close), D(atr) * self.stop_atr
        sign = 1 if side == "LONG" else -1
        stop, target = entry - sign * distance, entry + sign * distance * self.target_ratio
        if stop <= 0:
            self.skipped.append({"bucket_ms": self.bucket, "side": side, "reason": "protective_levels_unavailable"})
            return None
        return {"action": side, "strategy_id": self.STRATEGY_ID, "proposed_stop": str(stop),
                "proposed_target": str(target), "horizon_minutes": self.horizon_min,
                "reason_code": "qwen_" + answer, "invalidation": None, "delegated_strategy_id": None}

    def _rule_exit(self, position, current, common, close):
        opposite = "sell" if position["side"] == "LONG" else "buy"
        return (D(close), "opposite_decision") if self.chosen.get(self.bucket) == opposite else None
