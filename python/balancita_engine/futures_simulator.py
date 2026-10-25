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
from .indicator_catalog import CATALOG, Step
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
# Log-scale features exist only when a spec declares them, so the default feature set is unchanged.
LOG_KINDS = ("logret", "logvol")
# Value area (volume profile): its "period" is the tuple (window, pct, bins, confirm), one per run, and it only exists on the 5m series.
AREA_KIND = "valuearea"
PERIOD_KINDS = tuple(DEFAULT_PERIODS) + LOG_KINDS + (AREA_KIND,)
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
                if kind == AREA_KIND:
                    value = tuple(value)
                    if len(value) != 4 or any(isinstance(v, bool) or not isinstance(v, int) for v in value):
                        raise ValueError("valuearea takes (window, pct, bins, confirm) as integers")
                    merged[kind].add(value)
                    continue
                if isinstance(value, bool) or not isinstance(value, int) or not 2 <= value <= 400:
                    raise ValueError("indicator periods are integers from 2 to 400")
                merged[kind].add(value)
    if len(merged[AREA_KIND]) > 1:
        # its features (vah, val, poc, vaside...) carry no period in their name, so one run holds one configuration
        raise ValueError("valuearea: una sola configuracion por corrida ({})".format(sorted(merged[AREA_KIND])))
    return {kind: tuple(sorted(values)) for kind, values in merged.items() if values}


class IncrementalFeatures:
    """Closed-bar features one candle at a time.

    With the default periods the output equals ``calculate_features`` over the
    whole history (same keys, same strings). Other periods use the same names
    with the period as suffix (``ema12``, ``rsi7``, ``bollinger_upper10``, ``donchian_mid55``).

    Log-scale features, on demand and in bars of the series they are computed on:
    ``logret<P>`` = ln(close / close P bars ago) and ``logvol<P>`` = the per-bar volatility,
    the square root of the exponentially weighted mean of squared one-bar log returns
    (span P, seeded with the first return, available after P returns). Dividing a
    log return by ``logvol * sqrt(bars)`` gives a z-score that is comparable across products.
    """

    def __init__(self, periods=None, series=None):
        self.periods = merge_periods(DEFAULT_PERIODS if periods is None else periods)
        # ``series`` "1m" leaves out what only exists on 5m (the value area): its profile would cost a lot for nothing.
        self.skip = (AREA_KIND,) if series == "1m" else ()
        reach = max([p for kind, values in self.periods.items() if kind != AREA_KIND for p in values] + [MINIMUM_CANDLES])
        reach = max([reach] + [p + 1 for p in self.periods.get("logret", ())])
        self.count = 0
        self.closes = deque(maxlen=reach)
        self.highs = deque(maxlen=reach + 1)
        self.lows = deque(maxlen=reach + 1)
        self.volumes = deque(maxlen=reach + 1)
        self._ema = {p: [None, []] for p in self.periods.get("ema", ())}
        self._atr = {p: [None, []] for p in self.periods.get("atr", ())}
        self._rsi = {p: [None, None, []] for p in self.periods.get("rsi", ())}
        self._prev_close = None
        self._logvol = {p: [None, 0] for p in self.periods.get("logvol", ())}  # [ewma of r^2, returns seen]
        self._valuearea = {p: CATALOG[AREA_KIND].new_state(p) for p in self.periods.get(AREA_KIND, ())}

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
        true_range = high - low
        if self._prev_close is not None:
            true_range = max(true_range, abs(high - self._prev_close), abs(low - self._prev_close))
        change = None if self._prev_close is None else close - self._prev_close
        log_return = None if self._prev_close is None else (close / self._prev_close).ln()
        step = Step(close=close, high=high, low=low, volume=volume, true_range=true_range, change=change,
                    log_return=log_return, closes=list(self.closes), before_highs=before_highs,
                    before_lows=before_lows, before_volumes=before_volumes)
        # The arithmetic of every indicator lives in indicator_catalog; this class only feeds it and keeps the windows.
        active = [(kind, definition) for kind, definition in CATALOG.items()
                  if kind in self.periods and kind not in self.skip]
        for kind, definition in active:
            states = getattr(self, "_" + kind, {})
            for period, state in states.items():
                definition.update(period, state, step)
        self._prev_close = close

        out = {"schema_version": FEATURE_SCHEMA_VERSION, "ready": True, "reason_codes": [], "candidate_close": _n(close)}
        reasons = []
        for kind, definition in active:
            states = getattr(self, "_" + kind, {})
            for period in self.periods[kind]:
                items, why = definition.emit(period, states.get(period), step)
                out.update(items)
                reasons.extend(why)
        if self.count < MINIMUM_CANDLES:
            reasons.append("insufficient_candle_warmup")
        out.update({
            "bollinger_ddof": 0, "candidate_volume": _n(volume), "smoothing": "wilder",
            "candidate_bucket_start_ms": candle["bucket_start"],
            "candidate_low": candle["low"], "candidate_high": candle["high"],
        })
        out["ready"], out["reason_codes"] = not reasons, reasons
        return out


def frames(candles_1m, candles_5m, periods=None, funding=None):
    """Per closed 1m bucket: (bucket_start, current, previous, trend, regime) with no lookahead.

    ``periods``: indicator periods to compute on both series (default set when None);
    the regime chain's EMA 9/21 and ATR 14 on 5m are always included.
    ``funding``: a ``futures_funding_context.FundingContext``; each 5m bar then also carries ``fundpct``, the
    percentile (0-100, one decimal) of the last closed funding period against the 30 days before it, as of the
    bar's close. The key is absent while there is not 30 days of funding history.
    """
    periods = merge_periods(DEFAULT_PERIODS if periods is None else periods, REGIME_PERIODS)
    one, five = IncrementalFeatures(periods, series="1m"), IncrementalFeatures(periods, series="5m")
    fives = iter(candles_5m)
    pending = next(fives, None)
    trend, previous, regime = None, None, "unknown"
    for candle in candles_1m:
        current = one.update(candle)
        close_at = candle["bucket_start"] + ONE_MINUTE_MS
        while pending is not None and pending["bucket_start"] + FIVE_MINUTES_MS <= close_at:
            trend = five.update(pending)
            if funding is not None:
                found = funding.percentile(pending["bucket_start"] + FIVE_MINUTES_MS)
                if found is not None:
                    trend["fundpct"] = "{:.1f}".format(found[1])
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



def accrue_funding(periods, start_ms, end_ms, notional):
    """``(rate x time x notional summed over the periods that overlap [start, end), milliseconds covered)``.

    ``periods`` are ``(left_ms, right_ms, relative_rate_per_hour)``; the sign is the long side's (positive: pays).
    Unknown time is *not* zero funding: callers compare the covered time with the holding time.
    """
    total, covered = D(0), 0
    for left, right, rate in periods:
        a, b = max(start_ms, left), min(end_ms, right)
        if b <= a:
            continue
        covered += b - a
        total += D(str(rate)) * D(b - a) / D(3_600_000) * notional
    return total, covered

# How a stop that the market crossed is priced. ``level`` (default, the behaviour of every earlier experiment): the
# stop executes at its own level, plus the modelled impact. ``gap_open``: when the candle *opened* beyond the stop the
# stop could not execute at its level, so the reference is the candle open (never better than the stop). ``gap_worst``:
# any touch of the stop is priced at the far end of the candle (low for a LONG, high for a SHORT), a pessimistic bound.
# Both gap policies are estimates from OHLC (``stop_exit.evidence`` says so); only a quote makes the price demonstrable.
# ``gap_open`` on a candle without an open falls back to the ``gap_worst`` bound: never an optimistic invention.
STOP_POLICIES = ("level", "gap_open", "gap_worst")


def _worse(side, a, b):
    """The price that is worse for a position on ``side`` when it is *sold* (LONG: lower) or *bought back* (SHORT: higher)."""
    return min(a, b) if side == "LONG" else max(a, b)


class Book:
    """One independent paper book for one strategy: one position at a time, fixed notional."""

    def __init__(self, spec, *, product_id=DEFAULT_PRODUCT, tick_size="1", notional_usd=DEFAULT_NOTIONAL_USD,
                 funding=(), stop_policy="level"):
        if stop_policy not in STOP_POLICIES:
            raise ValueError("stop_policy must be one of {}".format(STOP_POLICIES))
        self.stop_policy = stop_policy
        self.fills = []   # one record per closed trade, parallel to ``trades``: reference price before the exit cost, evidence
        self.spec, self.product, self.tick_size = spec, product_id, tick_size
        # (start_ms, end_ms, relative rate per hour); a positive rate is paid by longs.
        self.funding = sorted((int(a), int(b), D(str(r))) for a, b, r in funding)
        self.notional = D(notional_usd)
        self.position = None
        self.trades, self.skipped, self.decisions = [], [], []
        self._open_decisions = []
        self.bucket = None
        # ``entry_gate(bucket) -> bool``: True when new entries are not allowed on this candle (stale data).
        # Open positions are managed regardless; a blocked candle opens nothing and leaves no decision.
        self.entry_gate = None
        # Candles where the gate was shut (stale cycles), and those on which the strategy would have entered.
        self.stale_cycles = 0
        self.blocked = []

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
        if self.entry_gate is not None and self.entry_gate(bucket):
            self.stale_cycles += 1
            blocked = self._entry_proposal(current, common)
            if blocked is not None and blocked["action"] in ("LONG", "SHORT"):
                self.blocked.append(bucket)
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
                exit_price, reason = self._stop_reference(position, current, low, high), "stop"
            elif (high >= position["target"]) if long else (low <= position["target"]):
                exit_price, reason = position["target"], "target"
        if exit_price is None and close is not None:
            rule = self._rule_exit(position, current, common, close)
            if rule is not None:
                exit_price, reason = rule
            elif bucket + ONE_MINUTE_MS - position["opened_at"] >= position["horizon_ms"]:
                exit_price, reason = D(close), "time_stop"
        if exit_price is not None:
            self._finish(bucket, exit_price, reason)

    def _stop_reference(self, position, current, low, high):
        """Reference price of a stop the candle crossed, before the modelled exit cost. Never better than the stop."""
        stop, long = position["stop"], position["side"] == "LONG"
        evidence = "stop_level"
        price = stop
        if self.post_hole_stop_reference and self.stop_policy == "level":
            # #186: the first valid candle after a declared hole of observation. Where it opened beyond the stop the open is
            # the SIMULATED reference (not a fill, not verified liquidity); without a valid open nothing is invented and the
            # stop level stays, declared as a limitation; an open before the stop is the ordinary case.
            opened = current.get("candidate_open")
            self._pending_evidence = None
            if opened is None:
                self._pending_evidence = "post_hole_open_unavailable_stop_level"
            elif (D(opened) <= stop) if long else (D(opened) >= stop):
                price = D(opened)
                self._pending_evidence = "ohlc_open_gap_after_hole_simulated"
            return price
        if self.stop_policy == "gap_worst":
            price, evidence = _worse(position["side"], stop, low if long else high), "ohlc_worst_bound"
        elif self.stop_policy == "gap_open":
            opened = current.get("candidate_open")
            if opened is None:   # no open to show where the market was: assume the far end of the candle, never the stop
                price, evidence = _worse(position["side"], stop, low if long else high), "ohlc_worst_bound_open_unavailable"
            elif (D(opened) <= stop) if long else (D(opened) >= stop):
                price, evidence = D(opened), "ohlc_open_gap"
            else:
                evidence = "ohlc_stop_level"
        self._pending_evidence = evidence if self.stop_policy != "level" else None
        return price

    _pending_evidence = None
    post_hole_stop_reference = False   # set by the runner for the one candle that is the first after a declared hole (#186)

    def _entry_start_ms(self, position):
        """Funding runs from the real entry when it is known (``entry_ms``), else from the opening minute."""
        return position.get("entry_ms", position["opened_at"])

    def _settle(self, bucket, exit_price, reason, end_ms=None, executable=None):
        """What closing the open position at ``exit_price`` would net, without booking it.

        ``executable``: an exit price already demonstrated by a quote; it is used as is (no further model cost).
        ``end_ms``: the exit instant when it is not the close of ``bucket``.
        """
        position = self.position
        long = position["side"] == "LONG"
        exit_price = executable if executable is not None else exit_fill(exit_price, position["side"], self.product, reason)
        entry, quantity = position["entry"], position["quantity"]
        gross = (exit_price - entry) * quantity if long else (entry - exit_price) * quantity
        fees = (entry + exit_price) * quantity * fee_rate("taker")
        funding, funding_complete = self._funding(self._entry_start_ms(position),
                                                  bucket + ONE_MINUTE_MS if end_ms is None else end_ms,
                                                  entry * quantity, long)
        return exit_price, gross - fees - funding, funding, funding_complete

    def open_position(self, mark_price=None):
        """The open position, valued net of costs at ``mark_price`` as if closed now, or ``None`` when flat."""
        position = self.position
        if position is None:
            return None
        view = {
            "strategy_id": position["strategy_id"], "side": position["side"],
            "entry_bucket_ms": position["opened_bucket"], "entry_time_ms": position["opened_at"],
            "entry_price": str(position["entry"]), "stop_price": str(position["stop"]),
            "target_price": position["target_text"], "notional_usd": str(self.notional),
            "mark_price": None, "net_bp": None, "pnl_usd": None,
        }
        if mark_price is not None and self.bucket is not None:
            _, pnl, _, _ = self._settle(self.bucket, D(mark_price), "mark")
            view.update(mark_price=str(mark_price), net_bp=float(round(pnl / self.notional * 10_000, 4)),
                        pnl_usd=float(round(pnl, 4)))
        return view

    def _funding_fields(self, position, bucket, funding, funding_complete, end_ms=None):
        """The trade's funding, never turning an unknown amount into zero.

        ``funding_usd`` is ``None`` when no funding period covered any of the holding time; a partial sum is kept
        but flagged ``funding_complete = False``; an observed zero is ``0.0`` with ``funding_complete = True``.
        """
        start, end = self._entry_start_ms(position), bucket + ONE_MINUTE_MS if end_ms is None else end_ms
        _, covered = accrue_funding(self.funding, start, end, D(0))
        covered = min(covered, end - start)
        if funding_complete:
            status = "complete"
        elif covered > 0:
            status = "partial"
        else:
            status = "unknown"
        return {"funding_usd": float(round(funding, 6)) if status != "unknown" else None,
                "funding_complete": funding_complete, "funding_status": status,
                "funding_covered_ms": int(covered), "funding_held_ms": int(end - start)}

    def close_on_quote(self, time_ms, reference_price, reason, executable_price, evidence, details=None):
        """Closes the open position at a price a quote demonstrated (``executable_price``, used as is) at ``time_ms``.

        Used by ``portfolio_watch``: the stop crossed by a bid/ask between candles. The trade is booked exactly like
        one closed on a candle (same fees, funding and accounting), with the exit instant being ``time_ms``.
        """
        if self.position is None:
            raise ValueError("no open position")
        self._finish(time_ms // ONE_MINUTE_MS * ONE_MINUTE_MS, reference_price, reason, end_ms=time_ms,
                     executable=executable_price, evidence=evidence, details=details)

    def _finish(self, bucket, exit_price, reason, end_ms=None, executable=None, evidence=None, details=None):
        """Closes the open position at ``exit_price`` (before the exit execution cost) and books the trade."""
        position = self.position
        reference = exit_price
        evidence = evidence or (self._pending_evidence if reason == "stop" else None)
        self._pending_evidence = None
        exit_price, pnl, funding, funding_complete = self._settle(bucket, exit_price, reason, end_ms, executable)
        entry, quantity = position["entry"], position["quantity"]
        end_ms = bucket + ONE_MINUTE_MS if end_ms is None else end_ms
        decision = position["decision"]
        decision["trade_net_usd"] = float(round(pnl, 4))
        decision["trade_hit"] = trade_hit(pnl)
        trade = {
            "strategy_id": position["strategy_id"], "side": position["side"],
            "entry_bucket_ms": position["opened_bucket"], "entry_time_ms": self._entry_start_ms(position),
            "entry_price": str(entry), "stop_price": str(position["stop"]), "target_price": position["target_text"],
            "exit_bucket_ms": bucket, "exit_time_ms": end_ms, "exit_price": str(exit_price),
            "exit_reason": reason, "quantity": str(quantity), "notional_usd": str(self.notional),
            "net_bp": float(round(pnl / self.notional * 10_000, 4)), "pnl_usd": float(round(pnl, 4)),
            "hit": trade_hit(pnl), "reason_code": position["reason_code"],
            **self._funding_fields(position, bucket, funding, funding_complete, end_ms),
        }
        if reason == "stop" and evidence is not None:
            # Only in the opt-in modes: the stop level, the price the market allowed and what that cost, with its evidence.
            stop, long = position["stop"], position["side"] == "LONG"
            gap = (stop - reference) / stop * 10_000 if long else (reference - stop) / stop * 10_000
            total = (stop - exit_price) / stop * 10_000 if long else (exit_price - stop) / stop * 10_000
            trade["stop_exit"] = {
                "stop_level": str(stop), "reference_price": str(reference), "executable_price": str(exit_price),
                "gap_bps": str(round(max(gap, D(0)), 4)), "slippage_bps": str(round(total, 4)),
                "evidence": evidence, "quote_backed": evidence.startswith("quote"),
                "estimated": not evidence.startswith("quote"), **(details or {})}
        self.trades.append(trade)
        self.fills.append({"reference_price": str(reference), "executable_price": str(exit_price), "evidence": evidence,
                           "reason": reason, "exit_time_ms": end_ms})
        self.position = None

    def _funding(self, start_ms, end_ms, notional, long):
        """Funding paid (positive) or received over the holding period, and whether history covered it."""
        total, covered = accrue_funding(self.funding, start_ms, end_ms, notional)
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
                  notional_usd=DEFAULT_NOTIONAL_USD, funding=(), stop_policy="level"):
    """Run every spec on its own book over one candle stream; indicators are computed once."""
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(spec) for spec in specs))
    books = [Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd, funding=funding,
                  stop_policy=stop_policy) for spec in specs]
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
