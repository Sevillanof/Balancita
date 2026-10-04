"""Versioned deterministic proposals and selection for isolated paper futures."""

from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR, localcontext


C25_ID = "c25-pullback-perp-v1"
C26_ID = "c26-reversion-perp-v1"
C27_ID = "c27-breakout-perp-v1"
C28_ID = "c28-adapter-perp-v1"
STRATEGY_IDS = (C25_ID, C26_ID, C27_ID, C28_ID)
CONFIG_VERSION = "futures-strategies-config.v1"
INDICATOR_VERSION = "futures-closed-indicators.v1"


def _decimal(value, label):
    if not isinstance(value, str):
        raise ValueError(label + " must be a decimal string")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(label + " must be a decimal string") from error
    if not result.is_finite():
        raise ValueError(label + " must be finite")
    return result


def _text(value):
    value = value.normalize()
    result = format(value, "f")
    return "0" if result in ("-0", "") else result


def update_regime(previous, ema9, ema21, atr14):
    """Classify abs(EMA9-EMA21)/ATR with unknown-start hysteresis."""
    if previous not in ("unknown", "trend", "range"):
        raise ValueError("invalid prior regime")
    try:
        fast, slow, atr = (_decimal(v, "regime feature") for v in (ema9, ema21, atr14))
    except ValueError:
        return "unknown"
    if atr <= 0:
        return "unknown"
    ratio = abs(fast - slow) / atr
    if ratio > Decimal("0.5"):
        return "trend"
    if ratio < Decimal("0.2"):
        return "range"
    return previous


def _condition(code, value, operator, threshold, passed):
    return {"code": code, "value": value, "operator": operator,
            "threshold": threshold, "passed": passed}


def _compare(conditions, code, value, operator, threshold):
    if value is None or threshold is None:
        conditions.append(_condition(code, value, operator, threshold, False))
        return False
    actual = _decimal(value, code)
    expected = _decimal(threshold, code + " threshold")
    passed = actual > expected if operator == ">" else actual >= expected if operator == ">=" else actual < expected if operator == "<" else actual <= expected
    conditions.append(_condition(code, value, operator, threshold, passed))
    return passed


def _availability(conditions, code, value):
    conditions.append(_condition(code, value is not None, "is", True, value is not None))
    return value is not None


def propose(strategy_id, current, *, previous=None, trend=None, regime="unknown",
            delegated_strategy_id=None, age_ms=None, tick_size="1",
            cost_config=None, position_side=None, frozen_target=None,
            frozen_invalidation=None):
    """Evaluate one strategy from already-calculated, closed-bar Decimal features.

    ``current`` is 1m features; ``trend`` is latest 5m features. For C25/C26,
    ``previous`` is the immediately preceding 1m feature set.
    """
    if strategy_id not in STRATEGY_IDS:
        raise ValueError("unknown futures strategy")
    delegated = None
    if strategy_id == C28_ID:
        if delegated_strategy_id in (C25_ID, C26_ID):
            delegated = delegated_strategy_id
        elif regime == "trend":
            delegated = C25_ID
        elif regime == "range":
            delegated = C26_ID
        else:
            return _proposal(C28_ID, "ABSTAIN", "regime_unavailable", [], age_ms)
        strategy_id = delegated
    if not isinstance(current, dict) or current.get("ready") is not True:
        missing = current.get("reason_codes", []) if isinstance(current, dict) else []
        return _proposal(strategy_id, "WAIT", "warming_up", [
            _condition("features_ready", bool(isinstance(current, dict) and current.get("ready")), "is", True, False),
            *[_condition("unavailable:" + str(reason), None, "available", True, False) for reason in missing],
        ], age_ms, delegated)

    if position_side in ("LONG", "SHORT"):
        close = current.get("candidate_close")
        if strategy_id == C25_ID:
            threshold = current.get("ema21")
            conditions = []
            exits = _compare(conditions, "owner_close_invalidates_ema21", close,
                             "<" if position_side == "LONG" else ">", threshold)
        elif strategy_id == C26_ID:
            threshold = frozen_target
            conditions = [_condition("owner_regime_is_range", regime == "range", "is", True, regime == "range")]
            target_exit = _compare(
                conditions, "owner_close_reaches_frozen_middle", close,
                ">=" if position_side == "LONG" else "<=", threshold,
            )
            exits = regime != "range" or target_exit
        else:
            threshold = frozen_invalidation
            conditions = []
            exits = _compare(
                conditions, "owner_close_crosses_frozen_donchian_mid", close,
                "<" if position_side == "LONG" else ">", threshold,
            )
        return _proposal(strategy_id, "FLAT" if exits else "WAIT",
                         "owner_exit_condition_met" if exits else "owner_exit_condition_not_met",
                         conditions, age_ms, delegated,
                         invalidation="strategy_exit")

    conditions = []
    side = None
    invalidation = None
    target = None
    reason = "entry_conditions_not_met"
    if strategy_id == C25_ID:
        if not isinstance(previous, dict):
            return _proposal(strategy_id, "WAIT", "previous_bar_unavailable", [
                _condition("previous_bar_available", False, "is", True, False)
            ], age_ms, delegated)
        if not isinstance(trend, dict) or trend.get("ready") is not True:
            return _proposal(strategy_id, "WAIT", "trend_features_unavailable", [
                _condition("trend_features_ready", False, "is", True, False)
            ], age_ms, delegated)
        long_checks = [
            _compare(conditions, "trend_ema9_above_ema21", trend.get("ema9"), ">", trend.get("ema21")),
            _compare(conditions, "trend_close_above_sma50", trend.get("candidate_close"), ">", trend.get("sma50")),
            _compare(conditions, "previous_low_touches_ema21", previous.get("candidate_low"), "<=", previous.get("ema21")),
            _compare(conditions, "previous_close_at_or_below_ema9", previous.get("candidate_close"), "<=", previous.get("ema9")),
            _compare(conditions, "current_close_crosses_above_ema9", current.get("candidate_close"), ">", current.get("ema9")),
            _compare(conditions, "rsi_in_long_band", current.get("rsi14"), ">=", "45") and _compare(conditions, "rsi_at_most_65", current.get("rsi14"), "<=", "65"),
        ]
        short_checks = [
            _compare(conditions, "trend_ema9_below_ema21", trend.get("ema9"), "<", trend.get("ema21")),
            _compare(conditions, "trend_close_below_sma50", trend.get("candidate_close"), "<", trend.get("sma50")),
            _compare(conditions, "previous_high_touches_ema21", previous.get("candidate_high"), ">=", previous.get("ema21")),
            _compare(conditions, "previous_close_at_or_above_ema9", previous.get("candidate_close"), ">=", previous.get("ema9")),
            _compare(conditions, "current_close_crosses_below_ema9", current.get("candidate_close"), "<", current.get("ema9")),
            _compare(conditions, "rsi_in_short_band", current.get("rsi14"), ">=", "35") and _compare(conditions, "rsi_at_most_55", current.get("rsi14"), "<=", "55"),
        ]
        if all(long_checks): side, invalidation, reason = "LONG", "close_below_ema21", "c25_long_pullback"
        elif all(short_checks): side, invalidation, reason = "SHORT", "close_above_ema21", "c25_short_pullback"
    elif strategy_id == C26_ID:
        if not isinstance(previous, dict):
            return _proposal(strategy_id, "WAIT", "previous_bar_unavailable", [], age_ms, delegated)
        long_checks = [
            regime == "range",
            _compare(conditions, "previous_close_below_lower_band", previous.get("candidate_close"), "<", previous.get("bollinger_lower20")),
            _compare(conditions, "current_close_back_inside_lower_band", current.get("candidate_close"), ">=", current.get("bollinger_lower20")),
            _compare(conditions, "rsi_crosses_above_30", current.get("rsi14"), ">=", "30") and _compare(conditions, "previous_rsi_below_30", previous.get("rsi14"), "<", "30"),
        ]
        short_checks = [
            regime == "range",
            _compare(conditions, "previous_close_above_upper_band", previous.get("candidate_close"), ">", previous.get("bollinger_upper20")),
            _compare(conditions, "current_close_back_inside_upper_band", current.get("candidate_close"), "<=", current.get("bollinger_upper20")),
            _compare(conditions, "rsi_crosses_below_70", current.get("rsi14"), "<=", "70") and _compare(conditions, "previous_rsi_above_70", previous.get("rsi14"), ">", "70"),
        ]
        if all(long_checks): side, invalidation, target, reason = "LONG", "regime_invalid", current.get("bollinger_mid20"), "c26_long_reversion"
        elif all(short_checks): side, invalidation, target, reason = "SHORT", "regime_invalid", current.get("bollinger_mid20"), "c26_short_reversion"
    else:
        for key, value in (("donchian_high_available", current.get("donchian_high20")), ("donchian_low_available", current.get("donchian_low20")), ("prior_volume_mean_available", current.get("prior_volume_mean20"))):
            _availability(conditions, key, value)
        volume_limit = None
        if current.get("prior_volume_mean20") is not None:
            with localcontext() as ctx:
                ctx.prec = 50
                volume_limit = _text(_decimal(current["prior_volume_mean20"], "volume mean") * Decimal("1.25"))
        long_break = _compare(conditions, "close_breaks_prior_high", current.get("candidate_close"), ">", current.get("donchian_high20"))
        short_break = _compare(conditions, "close_breaks_prior_low", current.get("candidate_close"), "<", current.get("donchian_low20"))
        volume_ok = _compare(conditions, "volume_above_1_25_prior_mean", current.get("candidate_volume"), ">", volume_limit)
        if long_break and volume_ok:
            side, invalidation, reason = "LONG", "opposite_donchian_mid_cross@" + str(current.get("donchian_mid20")), "c27_long_breakout"
        elif short_break and volume_ok:
            side, invalidation, reason = "SHORT", "opposite_donchian_mid_cross@" + str(current.get("donchian_mid20")), "c27_short_breakout"

    if side is None:
        return _proposal(strategy_id, "WAIT", reason, conditions, age_ms, delegated)
    if strategy_id == C26_ID and target is None:
        _availability(conditions, "frozen_bollinger_mid_available", target)
        return _proposal(strategy_id, "ABSTAIN", "frozen_target_unavailable", conditions, age_ms, delegated)
    close = current.get("candidate_close")
    atr = current.get("atr14")
    if close is None or atr is None:
        conditions.append(_condition("atr_and_close_available", False, "is", True, False))
        return _proposal(strategy_id, "ABSTAIN", "protective_levels_unavailable", conditions, age_ms, delegated)
    price, volatility, tick = (_decimal(v, "protective level") for v in (close, atr, tick_size))
    if price <= 0 or volatility <= 0 or tick <= 0:
        return _proposal(strategy_id, "ABSTAIN", "invalid_protective_level_input", conditions, age_ms, delegated)
    with localcontext() as ctx:
        ctx.prec = 50
        distance = volatility * Decimal("1.5")
        raw_stop = price - distance if side == "LONG" else price + distance
        stop_rounding = ROUND_FLOOR if side == "LONG" else ROUND_CEILING
        stop = (raw_stop / tick).to_integral_value(rounding=stop_rounding) * tick
        if stop <= 0:
            return _proposal(strategy_id, "ABSTAIN", "invalid_stop_after_tick_rounding", conditions, age_ms, delegated)
        if target is None:
            raw_target = price + distance * 2 if side == "LONG" else price - distance * 2
            target_rounding = ROUND_CEILING if side == "LONG" else ROUND_FLOOR
            target = _text((raw_target / tick).to_integral_value(rounding=target_rounding) * tick)
        else:
            target_value = _decimal(target, "frozen target")
            if (side == "LONG" and target_value <= price) or (side == "SHORT" and target_value >= price):
                return _proposal(strategy_id, "ABSTAIN", "target_on_wrong_side", conditions, age_ms, delegated)
            target_rounding = ROUND_FLOOR if side == "LONG" else ROUND_CEILING
            target = _text((target_value / tick).to_integral_value(rounding=target_rounding) * tick)
    result = _proposal(strategy_id, side, reason, conditions, age_ms, delegated,
                       invalidation=invalidation, proposed_target=target,
                       signal_key="{}:{}:{}".format(strategy_id, side, current.get("candidate_bucket_start_ms")))
    result["proposed_stop"] = _text(stop)
    result["stop_distance"] = _text(abs(price - stop))
    result["target_distance"] = _text(abs(_decimal(target, "proposed target") - price))
    result["invalidation"] = invalidation
    if cost_config is not None:
        maker = _decimal(cost_config.get("maker_rate"), "maker rate")
        taker = _decimal(cost_config.get("taker_rate"), "taker rate")
        result["estimated_round_trip_cost_bps"] = _text((maker + taker) * Decimal("10000"))
    return result


def _proposal(strategy_id, action, reason, conditions, age_ms, delegated=None,
              invalidation=None, proposed_target=None, signal_key=None):
    return {
        "strategy_id": C28_ID if delegated else strategy_id,
        "strategy_version": strategy_id,
        "action": action,
        "reason_code": reason,
        "conditions": conditions,
        "feature_age_ms": age_ms,
        "supported_direction": ["LONG", "SHORT"],
        "invalidation": invalidation,
        "proposed_stop": None,
        "proposed_target": proposed_target,
        "horizon_minutes": 30,
        "estimated_round_trip_cost_bps": None,
        "status": "warming_up" if reason == "warming_up" else "invalid" if action == "ABSTAIN" else "ready",
        "delegated_strategy_id": delegated,
        "signal_key": signal_key,
    }


def select_proposal(proposals, *, owner_strategy_id, consumed_signal_keys=()):
    """Choose a proposal deterministically; never change an open position owner."""
    if not isinstance(proposals, list):
        raise ValueError("proposals must be a list")
    if owner_strategy_id is not None:
        owned = [p for p in proposals if p.get("strategy_id") == owner_strategy_id]
        if not owned:
            return {"action": "WAIT", "reason_code": "owner_proposal_unavailable", "strategy_id": owner_strategy_id}
        return dict(owned[0])
    consumed = set(consumed_signal_keys)
    candidates = [p for p in proposals if p.get("action") in ("LONG", "SHORT")]
    unique = {}
    for proposal in candidates:
        effective = proposal.get("delegated_strategy_id") or proposal.get("strategy_id")
        unique.setdefault((effective, proposal["action"], proposal.get("signal_key")), proposal)
    candidates = list(unique.values())
    candidates = [p for p in candidates if p.get("signal_key") not in consumed]
    directions = {proposal["action"] for proposal in candidates}
    if len(directions) > 1:
        return {"action": "ABSTAIN", "reason_code": "conflicting_signals"}
    if not candidates:
        if any(p.get("action") in ("LONG", "SHORT") and p.get("signal_key") in consumed for p in proposals):
            return {"action": "WAIT", "reason_code": "signal_already_evaluated"}
        return {"action": "WAIT", "reason_code": "no_directional_proposal"}

    def rank(proposal):
        stop = _decimal(proposal["stop_distance"], "stop distance")
        target = _decimal(proposal["target_distance"], "target distance")
        if stop <= 0 or target < 0:
            raise ValueError("proposal distances are invalid")
        with localcontext() as ctx:
            ctx.prec = 50
            return target / stop

    return dict(sorted(candidates, key=lambda p: (-rank(p), p.get("strategy_id", "")))[0])
