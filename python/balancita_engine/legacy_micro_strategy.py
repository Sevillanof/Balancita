"""Compatibility port of the historical TypeScript micro-strategy rules.

This module intentionally preserves the legacy number-based behavior. New
paper-futures rules belong in ``futures_strategies`` and use Decimal instead.
"""

from __future__ import annotations


def _condition(code, value, operator, threshold, passed):
    return {
        "code": code,
        "value": value,
        "operator": operator,
        "threshold": threshold,
        "passed": passed,
    }


def _js_number(value):
    """Match JavaScript relational/arithmetic coercion for legacy null inputs."""
    return 0 if value is None else value


def _compare(conditions, code, value, operator, threshold):
    comparable_value = _js_number(value)
    comparable_threshold = _js_number(threshold)
    if operator == ">":
        passed = comparable_value > comparable_threshold
    elif operator == ">=":
        passed = comparable_value >= comparable_threshold
    elif operator == "<":
        passed = comparable_value < comparable_threshold
    else:
        passed = comparable_value <= comparable_threshold
    conditions.append(_condition(code, value, operator, threshold, passed))
    return passed


def _availability(conditions, code, available):
    conditions.append(_condition(code, available, "is", True, available))
    return available


def _evaluate_direct(strategy, features, exposure, macro_donchian_high):
    conditions = []
    compare = lambda code, value, operator, threshold: _compare(  # noqa: E731
        conditions, code, value, operator, threshold
    )
    available = lambda code, value: _availability(  # noqa: E731
        conditions, code, value is not None
    )

    if strategy == "trend-pullback":
        enter = (
            compare("entry_ema9_above_ema21", features["ema9"], ">", features["ema21"])
            and compare("entry_close_above_sma50", features["close"], ">", features["sma50"])
            and compare("entry_rsi_below_45", features["rsi14"], "<", 45)
        )
        exit_conditions = compare(
            "exit_close_below_ema21", features["close"], "<", features["ema21"]
        ) or compare("exit_rsi_above_68", features["rsi14"], ">", 68)
    elif strategy == "bollinger-reversion":
        enter = (
            compare(
                "entry_close_below_bollinger_lower",
                features["close"],
                "<",
                features["bollingerLower"],
            )
            and compare("entry_rsi_below_30", features["rsi14"], "<", 30)
            and compare(
                "entry_bollinger_width_ratio_at_least_0_01",
                (features.get("bollingerWidth") or 0) / features["close"],
                ">=",
                0.01,
            )
        )
        exit_conditions = compare(
            "exit_close_at_or_above_bollinger_mid",
            features["close"],
            ">=",
            features["bollingerMid"],
        ) or compare("exit_rsi_above_55", features["rsi14"], ">", 55)
    else:
        enter = (
            available("entry_donchian_high_available", macro_donchian_high)
            and compare(
                "entry_close_above_donchian_high",
                features["close"],
                ">",
                macro_donchian_high,
            )
            and compare(
                "entry_volume_above_1_25_prior_average",
                features["volume"],
                ">",
                1.25 * _js_number(features["priorVolumeSma20"]),
            )
        )
        exit_conditions = compare(
            "exit_close_below_donchian_mid",
            features["close"],
            "<",
            features["donchianMid20"],
        )

    target = (
        "flat" if exit_conditions else "long"
    ) if exposure == "long" else ("long" if enter else "flat")
    if exposure == "long":
        reason_code = "exit_conditions_met" if exit_conditions else "exit_conditions_not_met"
    else:
        reason_code = "entry_conditions_met" if enter else "entry_conditions_not_met"
    return target, reason_code, conditions


def _evaluate_target(payload):
    strategy = payload["strategy"]
    features = payload["features"]
    prior = payload["prior"]
    if not features["ready"]:
        diagnostic = {
            "reasonCode": "features_not_ready",
            "conditions": [_condition("features_ready", False, "is", True, False)],
        }
        return {
            "target": "flat",
            "state": {"exposure": "flat", "regime": prior["regime"]},
            "abstained": True,
            "diagnostic": diagnostic,
        }

    macro_present = "macroContext" in payload
    macro = payload.get("macroContext")
    donchian_high = (
        features["donchianHigh20"]
        if not macro_present
        else (macro.get("donchianHigh20") if macro is not None else None)
    )
    if strategy == "regime-adapter":
        percentile = (
            features["atrPercentile50"]
            if not macro_present
            else (macro.get("atrPercentile50") if macro is not None else None)
        )
        regime_conditions = [
            _condition("atr_percentile_available", percentile is not None, "is", True, percentile is not None)
        ]
        regime = prior["regime"]
        if percentile is not None and _compare(
            regime_conditions, "atr_percentile_above_trend_threshold", percentile, ">", 60
        ):
            regime = "trend"
        elif percentile is not None and _compare(
            regime_conditions, "atr_percentile_below_range_threshold", percentile, "<", 40
        ):
            regime = "range"
        if regime is None:
            return {
                "target": "flat",
                "state": {"exposure": "flat", "regime": None},
                "abstained": True,
                "diagnostic": {
                    "reasonCode": "regime_unavailable",
                    "conditions": regime_conditions,
                },
            }
        selected = "trend-pullback" if regime == "trend" else "bollinger-reversion"
        target, reason_code, direct_conditions = _evaluate_direct(
            selected, features, prior["exposure"], donchian_high
        )
        return {
            "target": target,
            "state": {"exposure": target, "regime": regime},
            "abstained": False,
            "diagnostic": {
                "reasonCode": reason_code,
                "conditions": regime_conditions + direct_conditions,
            },
        }

    target, reason_code, conditions = _evaluate_direct(
        strategy, features, prior["exposure"], donchian_high
    )
    return {
        "target": target,
        "state": {"exposure": target, "regime": prior["regime"]},
        "abstained": False,
        "diagnostic": {"reasonCode": reason_code, "conditions": conditions},
    }


def _evaluate_c27_exit(payload):
    conditions = []
    entry = payload["entryPrice"]
    close = payload["close"]
    mid = payload["donchianMid"]
    bars = payload["barsHeld"]

    if _compare(conditions, "c27_close_at_take_profit", close, ">=", entry * 1.018):
        reason, code = "take-profit", "c27_take_profit"
    elif _compare(conditions, "c27_close_at_stop_loss", close, "<=", entry * 0.991) or (
        _availability(conditions, "c27_donchian_mid_available", mid is not None)
        and _compare(conditions, "c27_close_below_donchian_mid", close, "<", mid)
    ):
        reason, code = "stop-loss", "c27_stop_loss"
    elif _compare(conditions, "c27_bars_held_reached_time_stop", bars, ">=", 8) and _compare(
        conditions, "c27_close_below_time_stop_threshold", close, "<", entry * 1.005
    ):
        reason, code = "time-stop", "c27_time_stop"
    else:
        reason, code = "hold", "c27_hold"
    return {"reason": reason, "diagnostic": {"reasonCode": code, "conditions": conditions}}


def evaluate_payload(payload):
    """Evaluate one serialized case using the historical TypeScript contract."""
    kind = payload["kind"]
    if kind == "initial-state":
        return {"exposure": "flat", "regime": None}
    if kind == "target":
        return _evaluate_target(payload)
    if kind == "c27-exit":
        return _evaluate_c27_exit(payload)
    if kind == "c27-exit-macro":
        macro = payload["macroContext"]
        return _evaluate_c27_exit(
            {
                "entryPrice": payload["entryPrice"],
                "close": payload["close"],
                "donchianMid": macro.get("donchianMid20") if macro is not None else None,
                "barsHeld": payload["barsHeld"],
            }
        )
    features = payload["features"]
    if features is None or features["ready"] is not True:
        return None
    return {
        "atrPercentile50": features["atrPercentile50"],
        "donchianHigh20": features["donchianHigh20"],
        "donchianMid20": features["donchianMid20"],
    }
