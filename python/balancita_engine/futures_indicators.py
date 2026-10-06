"""Deterministic Decimal indicators over closed, complete, as-of candles."""

from decimal import Decimal, InvalidOperation, localcontext

from .canonical import normalize_decimal


FEATURE_SCHEMA_VERSION = "c27-features.v2"
INDICATOR_PRECISION = 50
MINIMUM_CANDLES = 50


def _decimal(value, name):
    if not isinstance(value, str):
        raise ValueError(name + " must be a decimal string")
    try:
        result = Decimal(normalize_decimal(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(name + " must be a finite decimal string") from error
    if not result.is_finite():
        raise ValueError(name + " must be finite")
    return result


def _mean(values):
    return sum(values, Decimal(0)) / Decimal(len(values)) if values else None


def _ema(values, period):
    if len(values) < period:
        return None
    current = _mean(values[:period])
    alpha = Decimal(2) / Decimal(period + 1)
    for value in values[period:]:
        current = alpha * value + (Decimal(1) - alpha) * current
    return current


def _wilder(values, period):
    if len(values) < period:
        return None
    current = _mean(values[:period])
    for value in values[period:]:
        current = (current * Decimal(period - 1) + value) / Decimal(period)
    return current


def _rsi(closes, period=14):
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    if len(changes) < period:
        return None
    gains = [max(change, Decimal(0)) for change in changes]
    losses = [max(-change, Decimal(0)) for change in changes]
    average_gain = _mean(gains[:period])
    average_loss = _mean(losses[:period])
    for gain, loss in zip(gains[period:], losses[period:]):
        average_gain = (average_gain * Decimal(period - 1) + gain) / Decimal(period)
        average_loss = (average_loss * Decimal(period - 1) + loss) / Decimal(period)
    if average_loss == 0:
        return Decimal(50) if average_gain == 0 else Decimal(100)
    relative_strength = average_gain / average_loss
    return Decimal(100) - Decimal(100) / (Decimal(1) + relative_strength)


def _true_ranges(candles, highs, lows, closes):
    ranges = []
    previous_close = None
    for candle, high, low, close in zip(candles, highs, lows, closes):
        true_range = high - low
        if previous_close is not None:
            true_range = max(
                true_range,
                abs(high - previous_close),
                abs(low - previous_close),
            )
        ranges.append(true_range)
        previous_close = close
    return ranges


def _unavailable(reasons, candidate_close=None):
    return {
        "schema_version": FEATURE_SCHEMA_VERSION,
        "ready": False,
        "reason_codes": list(dict.fromkeys(reasons)),
        "candidate_close": candidate_close,
        "candidate_low": None,
        "candidate_high": None,
        "ema9": None,
        "ema21": None,
        "sma50": None,
        "rsi14": None,
        "atr14": None,
        "bollinger_mid20": None,
        "bollinger_variance20": None,
        "bollinger_stddev20": None,
        "bollinger_lower20": None,
        "bollinger_upper20": None,
        "bollinger_ddof": 0,
        "donchian_high20": None,
        "donchian_low20": None,
        "donchian_mid20": None,
        "prior_volume_mean20": None,
        "candidate_volume": None,
        "smoothing": "wilder",
        "candidate_bucket_start_ms": None,
    }


LEGACY_FEATURE_SCHEMA_VERSION = "c27-features.v1"


def calculate_features(
    candles,
    *,
    interval_ms,
    decision_time_ms,
    candidate_index=None,
    legacy_v1=False,
):
    """Calculate indicators (c27-features.v2); ``legacy_v1`` reproduces the v1 shape.

    The legacy lab runtime checkpoints (and the TS validator) pin the v1 key set,
    so it asks for v1: no ``donchian_mid20`` and the v1 schema label.
    """
    features = _calculate_features(
        candles, interval_ms=interval_ms, decision_time_ms=decision_time_ms,
        candidate_index=candidate_index,
    )
    if legacy_v1:
        features.pop("donchian_mid20", None)
        features["schema_version"] = LEGACY_FEATURE_SCHEMA_VERSION
    return features


def _calculate_features(
    candles,
    *,
    interval_ms,
    decision_time_ms,
    candidate_index=None,
):
    """Calculate v2 indicators; never use open, incomplete, or future-known bars."""
    if not isinstance(candles, list):
        raise ValueError("candles must be a list")
    if (
        isinstance(interval_ms, bool)
        or not isinstance(interval_ms, int)
        or interval_ms <= 0
        or isinstance(decision_time_ms, bool)
        or not isinstance(decision_time_ms, int)
        or decision_time_ms < 0
    ):
        raise ValueError("invalid indicator clock or interval")
    if candidate_index is None:
        candidate_index = len(candles) - 1
    if (
        isinstance(candidate_index, bool)
        or not isinstance(candidate_index, int)
        or candidate_index < 0
        or candidate_index >= len(candles)
    ):
        return _unavailable(["candidate_candle_unavailable"])

    candidate = candles[candidate_index]
    candidate_closed = isinstance(candidate, dict) and candidate.get("closed") is True
    candidate_known = (
        isinstance(candidate, dict)
        and isinstance(candidate.get("known_at_ms"), int)
        and candidate["known_at_ms"] <= decision_time_ms
        and isinstance(candidate.get("received_at_ms"), int)
        and candidate["received_at_ms"] <= decision_time_ms
    )
    candidate_close = None
    if candidate_closed and candidate_known and isinstance(candidate, dict):
        try:
            candidate_close = normalize_decimal(
                str(_decimal(candidate.get("close"), "candidate close"))
            )
        except ValueError:
            candidate_close = None

    reasons = []
    if not candidate_closed:
        reasons.append("candle_not_closed")
    if not candidate_known:
        reasons.append("candle_not_known_at_cutoff")
    if not isinstance(candidate, dict) or candidate.get("interval_ms") != interval_ms:
        reasons.append("candidate_interval_mismatch")

    selected = candles[: candidate_index + 1]
    if len(selected) < MINIMUM_CANDLES:
        reasons.append("insufficient_candle_warmup")
    if len(selected) > 1:
        for index in range(1, len(selected)):
            previous = selected[index - 1]
            current = selected[index]
            if (
                not isinstance(previous, dict)
                or not isinstance(current, dict)
                or current.get("bucket_start_ms")
                != previous.get("bucket_start_ms", -interval_ms) + interval_ms
            ):
                reasons.append("candle_sequence_gap")
                break

    validated = []
    for candle in selected:
        if not isinstance(candle, dict):
            reasons.append("invalid_candle_record")
            continue
        if candle.get("closed") is not True:
            reasons.append("candle_not_closed")
        if candle.get("interval_ms") != interval_ms:
            reasons.append("candle_interval_mismatch")
        if candle.get("coverage") != "complete":
            reasons.append("incomplete_candle_coverage")
        known_at = candle.get("known_at_ms")
        received_at = candle.get("received_at_ms")
        event_at = candle.get("close_at_ms", candle.get("event_time_ms"))
        if (
            isinstance(known_at, bool)
            or not isinstance(known_at, int)
            or known_at > decision_time_ms
            or isinstance(received_at, bool)
            or not isinstance(received_at, int)
            or received_at > decision_time_ms
        ):
            reasons.append("candle_not_known_at_cutoff")
        if (
            isinstance(event_at, bool)
            or not isinstance(event_at, int)
            or event_at > decision_time_ms
        ):
            reasons.append("candle_event_time_after_cutoff")
        validated.append(candle)

    if reasons:
        return _unavailable(reasons, candidate_close if candidate_closed and candidate_known else None)
    if len(validated) < MINIMUM_CANDLES:
        return _unavailable(["insufficient_candle_warmup"])

    with localcontext() as context:
        context.prec = INDICATOR_PRECISION
        opens = [_decimal(candle.get("open"), "open") for candle in validated]
        highs = [_decimal(candle.get("high"), "high") for candle in validated]
        lows = [_decimal(candle.get("low"), "low") for candle in validated]
        closes = [_decimal(candle.get("close"), "close") for candle in validated]
        volumes = [_decimal(candle.get("volume_btc"), "volume") for candle in validated]
        if any(value <= 0 for value in highs + lows + closes):
            return _unavailable(["invalid_or_nonpositive_ohlc"], candidate_close)
        if any(high < max(open_, close) or low > min(open_, close) or high < low
               for open_, high, low, close in zip(opens, highs, lows, closes)):
            return _unavailable(["invalid_ohlc_relationship"], candidate_close)

        bollinger_values = closes[-20:]
        bollinger_mid = _mean(bollinger_values)
        bollinger_variance = sum(
            ((value - bollinger_mid) ** 2 for value in bollinger_values), Decimal(0)
        ) / Decimal(20)
        bollinger_stddev = bollinger_variance.sqrt()
        ranges = _true_ranges(validated, highs, lows, closes)
        atr = _wilder(ranges, 14)
        reasons = []
        if atr is None or atr <= 0:
            reasons.append("invalid_or_zero_atr")

        previous = validated[-21:-1]
        if len(previous) != 20:
            reasons.append("insufficient_donchian_warmup")
            donchian_high = donchian_low = prior_volume_mean = None
        else:
            previous_highs = [_decimal(item["high"], "prior high") for item in previous]
            previous_lows = [_decimal(item["low"], "prior low") for item in previous]
            previous_volumes = [_decimal(item["volume_btc"], "prior volume") for item in previous]
            donchian_high = max(previous_highs)
            donchian_low = min(previous_lows)
            prior_volume_mean = _mean(previous_volumes)
        if len(closes) < 50:
            reasons.append("insufficient_candle_warmup")
        candidate_volume = volumes[-1]
        features = {
            "schema_version": FEATURE_SCHEMA_VERSION,
            "ready": not reasons,
            "reason_codes": reasons,
            "candidate_close": normalize_decimal(str(closes[-1])),
            "ema9": _optional_decimal(_ema(closes, 9)),
            "ema21": _optional_decimal(_ema(closes, 21)),
            "sma50": _optional_decimal(_mean(closes[-50:])),
            "rsi14": _optional_decimal(_rsi(closes, 14)),
            "atr14": _optional_decimal(atr),
            "bollinger_mid20": normalize_decimal(str(bollinger_mid)),
            "bollinger_variance20": normalize_decimal(str(bollinger_variance)),
            "bollinger_stddev20": normalize_decimal(str(bollinger_stddev)),
            "bollinger_lower20": normalize_decimal(str(bollinger_mid - Decimal(2) * bollinger_stddev)),
            "bollinger_upper20": normalize_decimal(str(bollinger_mid + Decimal(2) * bollinger_stddev)),
            "bollinger_ddof": 0,
            "donchian_high20": _optional_decimal(donchian_high),
            "donchian_low20": _optional_decimal(donchian_low),
            "donchian_mid20": _optional_decimal(
                None if donchian_high is None or donchian_low is None
                else (donchian_high + donchian_low) / Decimal(2)
            ),
            "prior_volume_mean20": _optional_decimal(prior_volume_mean),
            "candidate_volume": normalize_decimal(str(candidate_volume)),
            "smoothing": "wilder",
        }
        return features


def classify_regime(features, previous_regime="unknown"):
    """Apply the guide's 5m regime hysteresis without assuming an initial state."""
    atr = features.get("atr14") if isinstance(features, dict) else None
    ema9 = features.get("ema9") if isinstance(features, dict) else None
    ema21 = features.get("ema21") if isinstance(features, dict) else None
    if atr is None or ema9 is None or ema21 is None:
        return "unknown", None
    atr_value = _decimal(atr, "atr14")
    if atr_value <= 0:
        return "unknown", None
    ratio = abs(_decimal(ema9, "ema9") - _decimal(ema21, "ema21")) / atr_value
    if ratio > Decimal("0.5"):
        return "trend", normalize_decimal(str(ratio))
    if ratio < Decimal("0.2"):
        return "range", normalize_decimal(str(ratio))
    if previous_regime in ("trend", "range"):
        return previous_regime, normalize_decimal(str(ratio))
    return "unknown", normalize_decimal(str(ratio))


def _optional_decimal(value):
    return None if value is None else normalize_decimal(str(value))
