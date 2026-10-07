"""One simulator for every strategy (SS-03).

``simulate_many(specs, candles_1m, candles_5m, ...)`` streams official candles
once: incremental indicators (O(1) per bar for the recursive ones, fixed 20/50-bar
windows for the rolling ones), the regime chain, and one independent paper book
per spec. It reads no stored verdict features. ``IncrementalFeatures`` produces
exactly ``calculate_features`` run over the whole history (the parity test
pins it), so live C, D, the backtest, E and Qwen's score can share it.

Sizing is a fixed notional per trade (default 100 USD, Fran 2026-10-07), long or
short; costs come only from ``futures_costs``. Not modelled yet: funding.

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
from .futures_spec_strategy import propose_spec
from .futures_strategies import update_regime

ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
DEFAULT_NOTIONAL_USD = "100"
COST_BUFFER_RATE = Decimal("0.0002")
D = Decimal


def _n(value):
    return None if value is None else normalize_decimal(str(value))


class IncrementalFeatures:
    """Closed-bar features one candle at a time; same keys and values as ``calculate_features``."""

    def __init__(self):
        self.count = 0
        self.closes = deque(maxlen=50)
        self.highs = deque(maxlen=21)
        self.lows = deque(maxlen=21)
        self.volumes = deque(maxlen=21)
        self._ema = {9: None, 21: None}
        self._ema_seed = {9: [], 21: []}
        self._atr = None
        self._tr_seed = []
        self._prev_close = None
        self._gain = self._loss = None
        self._change_seed = []

    def update(self, candle):
        with localcontext() as context:
            context.prec = INDICATOR_PRECISION
            return self._update(candle)

    def _update(self, candle):
        high, low, close = D(candle["high"]), D(candle["low"]), D(candle["close"])
        volume = D(candle["volume_btc"])
        self.count += 1
        # Donchian and prior volume read the 20 bars before the candidate.
        previous_highs, previous_lows, previous_volumes = list(self.highs)[-20:], list(self.lows)[-20:], list(self.volumes)[-20:]
        self.closes.append(close)
        self.highs.append(high)
        self.lows.append(low)
        self.volumes.append(volume)
        for period in (9, 21):
            alpha = D(2) / D(period + 1)
            if self._ema[period] is None:
                self._ema_seed[period].append(close)
                if len(self._ema_seed[period]) == period:
                    self._ema[period] = sum(self._ema_seed[period], D(0)) / D(period)
            else:
                self._ema[period] = alpha * close + (D(1) - alpha) * self._ema[period]
        true_range = high - low
        if self._prev_close is not None:
            true_range = max(true_range, abs(high - self._prev_close), abs(low - self._prev_close))
        if self._atr is None:
            self._tr_seed.append(true_range)
            if len(self._tr_seed) == 14:
                self._atr = sum(self._tr_seed, D(0)) / D(14)
        else:
            self._atr = (self._atr * D(13) + true_range) / D(14)
        if self._prev_close is not None:
            change = close - self._prev_close
            gain, loss = max(change, D(0)), max(-change, D(0))
            if self._gain is None:
                self._change_seed.append((gain, loss))
                if len(self._change_seed) == 14:
                    self._gain = sum((g for g, _ in self._change_seed), D(0)) / D(14)
                    self._loss = sum((l for _, l in self._change_seed), D(0)) / D(14)
            else:
                self._gain = (self._gain * D(13) + gain) / D(14)
                self._loss = (self._loss * D(13) + loss) / D(14)
        self._prev_close = close

        rsi = None
        if self._gain is not None:
            if self._loss == 0:
                rsi = D(50) if self._gain == 0 else D(100)
            else:
                rsi = D(100) - D(100) / (D(1) + self._gain / self._loss)
        window = list(self.closes)[-20:]
        mid = sum(window, D(0)) / D(len(window))
        variance = sum(((v - mid) ** 2 for v in window), D(0)) / D(20)
        stddev = variance.sqrt()
        reasons = []
        atr = self._atr
        if atr is None or atr <= 0:
            reasons.append("invalid_or_zero_atr")
        if len(previous_highs) == 20:
            d_high, d_low = max(previous_highs), min(previous_lows)
            prior_volume = sum(previous_volumes, D(0)) / D(20)
        else:
            d_high = d_low = prior_volume = None
            reasons.append("insufficient_donchian_warmup")
        if self.count < MINIMUM_CANDLES:
            reasons.append("insufficient_candle_warmup")
        sma50 = None
        if len(self.closes) == 50:
            sma50 = sum(self.closes, D(0)) / D(50)
        return {
            "schema_version": FEATURE_SCHEMA_VERSION,
            "ready": not reasons,
            "reason_codes": reasons,
            "candidate_close": _n(close),
            "ema9": _n(self._ema[9]),
            "ema21": _n(self._ema[21]),
            "sma50": _n(sma50),
            "rsi14": _n(rsi),
            "atr14": _n(atr),
            "bollinger_mid20": _n(mid),
            "bollinger_variance20": _n(variance),
            "bollinger_stddev20": _n(stddev),
            "bollinger_lower20": _n(mid - D(2) * stddev),
            "bollinger_upper20": _n(mid + D(2) * stddev),
            "bollinger_ddof": 0,
            "donchian_high20": _n(d_high),
            "donchian_low20": _n(d_low),
            "donchian_mid20": _n(None if d_high is None else (d_high + d_low) / D(2)),
            "prior_volume_mean20": _n(prior_volume),
            "candidate_volume": _n(volume),
            "smoothing": "wilder",
            "candidate_bucket_start_ms": candle["bucket_start"],
            "candidate_low": candle["low"],
            "candidate_high": candle["high"],
        }


def frames(candles_1m, candles_5m):
    """Per closed 1m bucket: (bucket_start, current, previous, trend, regime) with no lookahead."""
    one, five = IncrementalFeatures(), IncrementalFeatures()
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

    def __init__(self, spec, *, product_id=DEFAULT_PRODUCT, tick_size="1", notional_usd=DEFAULT_NOTIONAL_USD):
        self.spec, self.product, self.tick_size = spec, product_id, tick_size
        self.notional = D(notional_usd)
        self.position = None
        self.trades, self.skipped, self.decisions = [], [], []
        self._open_decisions = []

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
        if self.position is not None:
            self._manage(bucket, current, common)
            return
        if not current.get("ready"):
            return
        proposal = propose_spec(self.spec, current, **common)
        if proposal["action"] not in ("LONG", "SHORT"):
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
            proposal = propose_spec(
                self.spec, current, position_side=position["side"], delegated_strategy_id=position["delegated"],
                frozen_target=position["target_text"], frozen_invalidation=position["frozen_invalidation"], **common)
            if proposal["action"] == "FLAT":
                exit_price, reason = D(close), "strategy_exit"
            elif bucket + ONE_MINUTE_MS - position["opened_at"] >= position["horizon_ms"]:
                exit_price, reason = D(close), "time_stop"
        if exit_price is None:
            return
        exit_price = exit_fill(exit_price, position["side"], self.product, reason)
        entry, quantity = position["entry"], position["quantity"]
        gross = (exit_price - entry) * quantity if long else (entry - exit_price) * quantity
        fees = (entry + exit_price) * quantity * fee_rate("taker")
        pnl = gross - fees
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
        })
        self.position = None

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
                  notional_usd=DEFAULT_NOTIONAL_USD):
    """Run every spec on its own book over one candle stream; indicators are computed once."""
    books = [Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd) for spec in specs]
    for frame in frames(candles_1m, candles_5m):
        for book in books:
            book.on_frame(*frame)
    return books


def simulate(spec, candles_1m, candles_5m, **kwargs):
    return simulate_many([spec], candles_1m, candles_5m, **kwargs)[0]
