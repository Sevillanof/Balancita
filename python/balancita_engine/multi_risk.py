"""Deterministic risk engine (PR 100, P0). It authorizes; it never trades.

A selection (what the combiner, a strategy or Qwen chose) is only a proposal. ``RiskEngine.evaluate`` checks it
against the policy and either issues an ``Authorization`` or returns every reason it refuses. The paper executor
opens a position only by redeeming an authorization this engine issued, once. The notional is the fixed
100 USD of Balancita: the engine authorizes it or rejects the entry, it never resizes.

The stop, target and maximum holding time come from one declared policy (ATR multiple, target-to-stop ratio, the
signal horizon capped), so every arm exits by the same rules.
"""

from dataclasses import asdict, dataclass
from decimal import Decimal

from .futures_costs import COST_MODEL_VERSION, is_measured, round_trip_rate
from .multi_signals import BUY, SELL, WAIT, stable_hash

D = Decimal
COST_BUFFER_RATE = Decimal("0.0002")  # the same margin the shared simulator keeps over the round-trip cost
DAY_MS = 86_400_000
AUTHORIZATION_SCHEMA = "balancita-risk-authorization.v1"


@dataclass(frozen=True)
class RiskPolicy:
    notional_usd: str = "100"
    leverage: str = "1"
    equity_usd: str = "1000"
    max_notional_per_product_usd: str = "100"
    max_notional_global_usd: str = "400"
    stop_atr_mult: str = "2"
    target_stop_ratio: str = "1.5"
    max_horizon_minutes: int = 1440
    max_data_age_ms: int = 600_000
    daily_loss_limit_usd: str = "20"
    max_drawdown_usd: str = "60"
    authorization_ttl_ms: int = 120_000

    def policy_hash(self):
        return stable_hash(dict(asdict(self), cost_model=COST_MODEL_VERSION))[:16]

    def levels(self, side, price, atr, signal_horizon):
        """``(stop, target, horizon_minutes)`` or ``None`` when the inputs cannot give valid protective levels."""
        if price is None or atr is None or D(price) <= 0 or D(atr) <= 0:
            return None
        price, distance = D(price), D(atr) * D(self.stop_atr_mult)
        sign = 1 if side == "LONG" else -1
        stop, target = price - sign * distance, price + sign * distance * D(self.target_stop_ratio)
        if stop <= 0:
            return None
        return stop, target, min(int(signal_horizon), self.max_horizon_minutes)


def _side(action):
    return "LONG" if action == BUY else "SHORT" if action == SELL else None


class RiskError(Exception):
    pass


class RiskEngine:
    def __init__(self, policy=None):
        self.policy = policy or RiskPolicy()
        self.issued = {}
        self.consumed = set()

    def evaluate(self, *, decision, signals, snapshot, account, now_ms):
        """Authorize or reject a selection.

        ``decision``: ``{decision_id, arm, scope, product_id, action, signal_id}`` (action BUY/SELL/WAIT).
        ``signals``: the cycle's signals of that product. ``snapshot``: ``{price, atr, ready, data_close_ms}``.
        ``account``: ``{open_notional_usd, product_open, realized_usd, realized_today_usd, drawdown_usd}``.
        Returns ``{authorized, reasons, authorization}``; ``reasons`` lists every failed check.
        """
        policy, reasons = self.policy, []
        side = _side(decision["action"])
        if side is None:
            return {"authorized": False, "reasons": ["no_trade_selected"], "authorization": None}
        backing = next((s for s in signals if s["signal_id"] == decision.get("signal_id")), None)
        if backing is None or backing["action"] != decision["action"] or backing["product_id"] != decision["product_id"]:
            reasons.append("no_backing_signal")
        price, atr = snapshot.get("price"), snapshot.get("atr")
        if not snapshot.get("ready") or price is None or atr is None or D(price) <= 0 or D(atr) <= 0:
            reasons.append("data_integrity")
        close_ms = snapshot.get("data_close_ms")
        if close_ms is None or now_ms - close_ms > policy.max_data_age_ms or close_ms > now_ms:
            reasons.append("stale_data")
        if not is_measured(decision["product_id"]):
            reasons.append("cost_data_missing")
        notional = D(policy.notional_usd)
        if account["product_open"]:
            reasons.append("position_already_open")
        if D(account["open_notional_usd"]) + notional > D(policy.max_notional_global_usd):
            reasons.append("global_exposure_limit")
        if notional > D(policy.max_notional_per_product_usd):
            reasons.append("product_exposure_limit")
        reserved = D(account["open_notional_usd"]) / D(policy.leverage)
        if D(policy.equity_usd) + D(account["realized_usd"]) - reserved < notional / D(policy.leverage):
            reasons.append("insufficient_margin")
        if D(account["realized_today_usd"]) <= -D(policy.daily_loss_limit_usd):
            reasons.append("suspended_daily_loss")
        if D(account["drawdown_usd"]) >= D(policy.max_drawdown_usd):
            reasons.append("suspended_drawdown")
        levels = None
        if "data_integrity" not in reasons and backing is not None:
            levels = policy.levels(side, price, atr, backing["horizon_minutes"])
            if levels is None:
                reasons.append("levels_unavailable")
            elif abs(levels[1] - D(price)) <= D(price) * (round_trip_rate(decision["product_id"]) + COST_BUFFER_RATE):
                reasons.append("target_does_not_clear_cost")
        if reasons:
            return {"authorized": False, "reasons": reasons, "authorization": None}
        stop, target, horizon = levels
        body = {
            "schema": AUTHORIZATION_SCHEMA, "decision_id": decision["decision_id"], "arm": decision["arm"],
            "scope": decision["scope"], "product_id": decision["product_id"], "side": side,
            "notional_usd": policy.notional_usd, "stop": str(stop), "target": str(target),
            "horizon_minutes": horizon, "signal_id": backing["signal_id"], "strategy_id": backing["strategy_id"],
            "strategy_version": backing["strategy_version"], "issued_ms": now_ms,
            "expires_ms": now_ms + policy.authorization_ttl_ms, "policy_hash": policy.policy_hash(),
        }
        body["auth_id"] = stable_hash(body)[:24]
        self.issued[body["auth_id"]] = body
        return {"authorized": True, "reasons": [], "authorization": body}

    def redeem(self, authorization, now_ms):
        """Single use. Only an authorization this engine issued, unchanged and unexpired, is accepted."""
        known = self.issued.get(authorization.get("auth_id") if isinstance(authorization, dict) else None)
        if known is None or known != authorization:
            raise RiskError("unknown_authorization")
        if known["auth_id"] in self.consumed:
            raise RiskError("duplicate_authorization")
        if now_ms > known["expires_ms"]:
            raise RiskError("expired_authorization")
        self.consumed.add(known["auth_id"])
        return known

    def peek_levels(self, side, price, atr, horizon):
        """Protective levels for shadow evaluation of rejected candidates (no authorization is issued)."""
        return self.policy.levels(side, price, atr, horizon)
