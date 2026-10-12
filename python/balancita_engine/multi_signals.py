"""Common signal contract of the multi-strategy architecture (PR 100, P0).

Every strategy answers, per product and per 5-minute cycle, one ``balancita-signal.v1`` dict: BUY / SELL / WAIT
scores, a strength, a horizon, the evidence behind it, the strategy's identity and version and its historical
reliability with the sample size. The scores are NOT calibrated probabilities (``calibrated`` is always false)
until a calibration study says otherwise. Strategies are interchangeable: the selectors (combiner, Qwen), the
risk engine and the executor only read this contract, so adding a strategy needs no change anywhere else.

The three strategies shipped here (funding, momentum, mean reversion) have NEW ids with the prefix ``mx-``. They
exist to exercise the whole path end to end; nothing says they earn money. They do not touch C25-C32.
"""

import hashlib
import json
from decimal import Decimal, InvalidOperation

SIGNAL_SCHEMA = "balancita-signal.v1"
BUY, SELL, WAIT = "BUY", "SELL", "WAIT"
ACTIONS = (BUY, SELL, WAIT)
FIVE_MINUTES_MS = 300_000
D = Decimal


def stable_hash(value):
    """SHA-256 of a JSON-serialisable value with sorted keys (floats allowed: used for ledgers and ids)."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()


def _two(value):
    return "{:.2f}".format(value)


def make_signal(*, strategy_id, strategy_version, product_id, bucket_ms, action, strength, horizon_minutes,
                evidence, reliability=None, reason=""):
    """Builds and validates one signal. ``strength`` is a Decimal in [0, 1]; a WAIT carries strength 0."""
    if action not in ACTIONS:
        raise ValueError("unknown signal action {!r}".format(action))
    strength = D(strength)
    if not D(0) <= strength <= D(1):
        raise ValueError("signal strength must be within 0..1")
    if action == WAIT:
        strength = D(0)
    elif strength <= 0:
        raise ValueError("a BUY/SELL signal needs a strength above 0")
    if isinstance(horizon_minutes, bool) or not isinstance(horizon_minutes, int) or horizon_minutes <= 0:
        raise ValueError("signal horizon must be positive whole minutes")
    chosen = D("0.5") + strength / 2 if action != WAIT else D(1)
    scores = {BUY: D(0), SELL: D(0), WAIT: D(1) - chosen if action != WAIT else D(1)}
    if action != WAIT:
        scores[action] = chosen
    reliability = reliability or {"sample_size": 0, "hit_rate": None}
    body = {
        "schema": SIGNAL_SCHEMA, "strategy_id": strategy_id, "strategy_version": int(strategy_version),
        "product_id": product_id, "bucket_ms": int(bucket_ms), "action": action,
        "scores": {key: _two(value) for key, value in scores.items()}, "calibrated": False,
        "strength": _two(strength), "horizon_minutes": horizon_minutes,
        "evidence": {str(k): str(v) for k, v in evidence.items()},
        "reliability": {"sample_size": int(reliability["sample_size"]),
                        "hit_rate": None if reliability["hit_rate"] is None else str(reliability["hit_rate"])},
        "reason": reason,
    }
    body["signal_id"] = stable_hash(body)[:24]
    return body


def validate_signal(signal):
    """Raises ``ValueError`` unless ``signal`` is a well-formed, untampered ``balancita-signal.v1``."""
    if not isinstance(signal, dict) or signal.get("schema") != SIGNAL_SCHEMA:
        raise ValueError("not a balancita-signal.v1")
    for key in ("strategy_id", "strategy_version", "product_id", "bucket_ms", "action", "scores", "strength",
                "horizon_minutes", "evidence", "reliability", "calibrated", "signal_id"):
        if key not in signal:
            raise ValueError("signal misses " + key)
    if signal["action"] not in ACTIONS or signal["calibrated"] is not False:
        raise ValueError("invalid signal action or calibration flag")
    try:
        scores = {k: D(v) for k, v in signal["scores"].items()}
        total = sum(scores.values(), D(0))
        strength = D(signal["strength"])
    except (InvalidOperation, AttributeError, TypeError) as error:
        raise ValueError("invalid signal scores") from error
    if set(scores) != set(ACTIONS) or abs(total - 1) > D("0.011") or not D(0) <= strength <= D(1):
        raise ValueError("signal scores must cover BUY/SELL/WAIT and sum to 1")
    body = {k: v for k, v in signal.items() if k != "signal_id"}
    if stable_hash(body)[:24] != signal["signal_id"]:
        raise ValueError("signal_id does not match its content")
    return signal


def is_candidate(signal):
    return signal["action"] in (BUY, SELL)


class SignalContext:
    """What a strategy may look at: only features of candles that closed at or before ``bucket_ms``."""

    def __init__(self, product_id, bucket_ms, price, one, five, regime, reliability=None):
        self.product_id, self.bucket_ms, self.price = product_id, bucket_ms, price
        self.one, self.five, self.regime = one, five, regime
        self.reliability = reliability or {"sample_size": 0, "hit_rate": None}


class Strategy:
    """Base class: subclasses set ``id``, ``version``, ``horizon_minutes``, ``indicators`` and ``decide``."""

    id = "base"
    version = 1
    horizon_minutes = 60
    indicators = {}

    def decide(self, ctx):
        """``(action, strength, evidence, reason)`` for the context."""
        raise NotImplementedError

    def evaluate(self, ctx):
        action, strength, evidence, reason = self.decide(ctx)
        return make_signal(
            strategy_id=self.id, strategy_version=self.version, product_id=ctx.product_id, bucket_ms=ctx.bucket_ms,
            action=action, strength=strength, horizon_minutes=self.horizon_minutes, evidence=evidence,
            reliability=ctx.reliability, reason=reason)


def _dec(value):
    try:
        return None if value is None else D(str(value))
    except InvalidOperation:
        return None


def _clip(value):
    return max(D(0), min(D(1), value))


class FundingStrategy(Strategy):
    """Contrarian funding: the last closed hourly funding in the extreme 10 % of the previous 30 days.

    Funding is published hourly, so this signal changes at most once an hour; the 5-minute cycle re-reads the same
    value in between (no twelve independent funding observations are invented).
    """

    id, version, horizon_minutes = "mx-funding-v1", 1, 1440
    indicators = {}
    HIGH, LOW = D(90), D(10)

    def decide(self, ctx):
        pct = _dec(ctx.five.get("fundpct"))
        if pct is None:
            return WAIT, D(0), {"funding_percentile": "unavailable"}, "funding_history_insufficient"
        evidence = {"funding_percentile": str(pct), "cadence": "hourly, as published by Kraken"}
        if pct >= self.HIGH:
            return SELL, _clip((pct - 50) / 50), evidence, "funding_extreme_high_longs_pay"
        if pct <= self.LOW:
            return BUY, _clip((50 - pct) / 50), evidence, "funding_extreme_low_shorts_pay"
        return WAIT, D(0), evidence, "funding_not_extreme"


class MomentumStrategy(Strategy):
    """Continuation: the 1 h log return is large against the product's own log volatility."""

    id, version, horizon_minutes = "mx-momentum-v1", 1, 240
    indicators = {"logret": [12], "logvol": [96]}
    Z_MIN = D("1.5")
    SQRT_BARS = D(12).sqrt()

    def decide(self, ctx):
        ret, vol = _dec(ctx.five.get("logret12")), _dec(ctx.five.get("logvol96"))
        if ret is None or vol is None or vol <= 0:
            return WAIT, D(0), {"z_1h": "unavailable"}, "log_features_unavailable"
        z = ret / (vol * self.SQRT_BARS)
        evidence = {"z_1h": "{:.2f}".format(z), "logret_1h": str(ret), "logvol_5m": str(vol)}
        if abs(z) < self.Z_MIN:
            return WAIT, D(0), evidence, "momentum_not_extreme"
        strength = _clip(abs(z) / (2 * self.Z_MIN))
        return (BUY if z > 0 else SELL), strength, evidence, "momentum_continuation"


class MeanReversionStrategy(Strategy):
    """Fade a close outside the Bollinger band when RSI agrees."""

    id, version, horizon_minutes = "mx-meanrev-v1", 1, 120
    indicators = {"bollinger": [20], "rsi": [14]}

    def decide(self, ctx):
        close = _dec(ctx.five.get("candidate_close"))
        upper, lower = _dec(ctx.five.get("bollinger_upper20")), _dec(ctx.five.get("bollinger_lower20"))
        rsi = _dec(ctx.five.get("rsi14"))
        if None in (close, upper, lower, rsi):
            return WAIT, D(0), {"bollinger": "unavailable"}, "band_features_unavailable"
        evidence = {"close": str(close), "bollinger_upper": str(upper), "bollinger_lower": str(lower), "rsi14": str(rsi)}
        strength = _clip(abs(rsi - 50) / 40)
        if close > upper and rsi >= 70:
            return SELL, strength, evidence, "above_band_overbought"
        if close < lower and rsi <= 30:
            return BUY, strength, evidence, "below_band_oversold"
        return WAIT, D(0), evidence, "inside_band"


def default_strategies():
    return [FundingStrategy(), MomentumStrategy(), MeanReversionStrategy()]


def merged_indicators(strategies):
    from .futures_simulator import DEFAULT_PERIODS, merge_periods

    return merge_periods(DEFAULT_PERIODS, *(s.indicators for s in strategies))
