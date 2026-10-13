"""Shared paper portfolio (isolated prototype, not connected to the forward).

One account of 1 000 USD shared by every strategy. Intents (what a strategy, a combiner or Qwen proposes) are
resolved against capital and exposure limits, sized by risk, and opened in the *shared simulator*: each position is a
``Book`` of ``futures_simulator`` (fills, taker fees, per-product impact, funding, stop/target/time stop), so this
module adds capital management and no second accounting engine. Costs come only from ``futures_costs``.

Capital (all in USD, leverage default 1):
  equity     = initial + realized net P&L of closed trades (unrealized is reported, never spendable)
  reserved   = sum(notional / leverage) of the open positions
  available  = equity - reserved

Sizing: ``notional = risk_usd / loss_fraction`` where ``risk_usd = equity * risk_per_trade`` and ``loss_fraction`` is
the price distance to the stop plus the full round-trip cost if the stop is hit. The result is then capped by the
per-position cap (default 100 USD, the fixed notional of ADR 0001: risk sizing can only make a trade smaller, never
larger), the per-product and total gross limits, the net directional limit and the available margin. A trade that
ends up under ``min_notional_usd`` is rejected, not rounded up.

Resolution of simultaneous intents (deterministic, independent of input order):
  1. Same product, same side: the strongest wins; the rest are rejected ``duplicate_same_side``.
  2. Same product, opposite sides: all rejected ``contradictory_signals`` (no trade is not a loss; guessing is).
  3. Survivors are ranked by strength (desc), then product id, then intent id, and allocated one by one against
     the capital left by the previous ones, so an exposure limit rejects the weakest, not an arbitrary one.
Every intent leaves a decision record: ``opened`` with its size, or ``rejected`` with *every* reason that failed.

Missing funding history never becomes zero: the trade is stored ``net_complete: false`` and the partial figure is
kept apart, as in ``multi_executor``. The partial figure still moves capital (conservative); the complete net does not
include it.
"""

from dataclasses import asdict, dataclass
from decimal import Decimal

from .futures_costs import COST_MODEL_VERSION, fee_rate, is_measured, round_trip_rate, side_impact_bps, stop_exit_bps
from .futures_simulator import COST_BUFFER_RATE, ONE_MINUTE_MS, Book
from .multi_risk import DAY_MS, RiskPolicy
from .multi_signals import BUY, SELL, stable_hash

D = Decimal
PORTFOLIO_SCHEMA = "balancita-portfolio.v1"
LONG, SHORT = "LONG", "SHORT"
TEN_THOUSAND = Decimal(10_000)


@dataclass(frozen=True)
class PortfolioPolicy:
    initial_equity_usd: str = "1000"
    leverage: str = "1"
    risk_per_trade: str = "0.01"            # fraction of equity lost if the stop is hit
    max_notional_per_position_usd: str = "100"
    min_notional_usd: str = "10"
    max_notional_per_product_usd: str = "100"
    max_gross_exposure_usd: str = "400"
    max_net_exposure_usd: str = "300"       # |long - short|
    max_open_positions: int = 8
    max_data_age_ms: int = 600_000
    daily_loss_limit_usd: str = "20"
    max_drawdown_usd: str = "60"

    def policy_hash(self):
        return stable_hash(dict(asdict(self), cost_model=COST_MODEL_VERSION, schema=PORTFOLIO_SCHEMA))[:16]


def make_intent(*, strategy_id, product_id, side, strength, bucket_ms, price, stop, target, horizon_minutes,
                data_close_ms=None, strategy_version=1, signal_id=None):
    """A proposal to open one position. ``side`` LONG/SHORT; ``strength`` in (0, 1]; levels are absolute prices."""
    body = {
        "strategy_id": strategy_id, "strategy_version": int(strategy_version), "product_id": product_id,
        "side": side, "strength": str(strength), "bucket_ms": int(bucket_ms), "price": str(price),
        "stop": str(stop), "target": str(target), "horizon_minutes": int(horizon_minutes),
        "data_close_ms": int(bucket_ms + ONE_MINUTE_MS if data_close_ms is None else data_close_ms),
        "signal_id": signal_id,
    }
    body["intent_id"] = stable_hash(body)[:24]
    return body


def intent_from_signal(signal, *, price, atr, risk_policy=None, data_close_ms=None):
    """Turns a ``balancita-signal.v1`` BUY/SELL into an intent with the same stop/target rules as ``multi_risk``.

    Returns ``None`` for WAIT or when the inputs give no valid protective levels."""
    if signal["action"] not in (BUY, SELL):
        return None
    side = LONG if signal["action"] == BUY else SHORT
    levels = (risk_policy or RiskPolicy()).levels(side, price, atr, signal["horizon_minutes"])
    if levels is None:
        return None
    stop, target, horizon = levels
    return make_intent(
        strategy_id=signal["strategy_id"], strategy_version=signal["strategy_version"], product_id=signal["product_id"],
        side=side, strength=signal["strength"], bucket_ms=signal["bucket_ms"], price=price, stop=stop, target=target,
        horizon_minutes=horizon, data_close_ms=data_close_ms, signal_id=signal["signal_id"])


class PositionBook(Book):
    """A shared-simulator book for one portfolio position: enters on an armed proposal, exits only by stop,
    target or time stop (the exits every arm uses)."""

    def __init__(self, intent, notional_usd, tick_size, funding):
        super().__init__({"id": intent["strategy_id"]}, product_id=intent["product_id"], tick_size=tick_size,
                         notional_usd=notional_usd, funding=funding)
        self.intent, self.recorded = intent, 0
        self._armed = True

    def _entry_proposal(self, current, common):
        if not self._armed:
            return None
        self._armed = False
        i = self.intent
        return {"action": i["side"], "strategy_id": i["strategy_id"], "proposed_stop": i["stop"],
                "proposed_target": i["target"], "horizon_minutes": i["horizon_minutes"],
                "reason_code": "portfolio:" + i["intent_id"], "invalidation": None, "delegated_strategy_id": None}

    def _rule_exit(self, position, current, common, close):
        return None


def _frame(candle):
    close = str(candle["close"])
    return {"ready": True, "candidate_close": close, "candidate_high": str(candle["high"]),
            "candidate_low": str(candle["low"])}


class Portfolio:
    def __init__(self, policy=None, *, funding=None, tick_sizes=None):
        """``funding``: product -> iterable of ``(start_ms, end_ms, relative_rate_per_hour)`` (positive: longs pay)."""
        self.policy = policy or PortfolioPolicy()
        self.funding = {p: sorted((int(a), int(b), D(str(r))) for a, b, r in rows) for p, rows in (funding or {}).items()}
        self.tick_sizes = tick_sizes or {}
        self.positions = {}     # product -> PositionBook (at most one open position per product)
        self.trades = []        # closed trades, in close order
        self.decisions = []     # one record per intent: opened or rejected (with reasons)
        self.marks = {}         # product -> last close seen, for unrealized P&L
        self.now_ms = None

    # ---- capital -------------------------------------------------------------------------------------------
    def realized_usd(self):
        return sum((D(str(t["pnl_usd"])) for t in self.trades), D(0))

    def equity_usd(self):
        return D(self.policy.initial_equity_usd) + self.realized_usd()

    def reserved_usd(self):
        return sum((b.notional for b in self.positions.values()), D(0)) / D(self.policy.leverage)

    def available_usd(self):
        return self.equity_usd() - self.reserved_usd()

    def exposure(self):
        long = sum((b.notional for b in self.positions.values() if b.position["side"] == LONG), D(0))
        short = sum((b.notional for b in self.positions.values() if b.position["side"] == SHORT), D(0))
        return long, short

    def drawdown_usd(self):
        peak = running = drawdown = D(0)
        for trade in self.trades:
            running += D(str(trade["pnl_usd"]))
            peak = max(peak, running)
            drawdown = max(drawdown, peak - running)
        return drawdown

    def realized_today_usd(self, now_ms):
        return sum((D(str(t["pnl_usd"])) for t in self.trades if t["exit_time_ms"] // DAY_MS == now_ms // DAY_MS), D(0))

    def unrealized_usd(self):
        total = D(0)
        for product, book in self.positions.items():
            mark = self.marks.get(product)
            view = book.open_position(mark) if mark is not None else None
            if view is not None and view["pnl_usd"] is not None:
                total += D(str(view["pnl_usd"]))
        return total

    def snapshot(self):
        long, short = self.exposure()
        complete = [t for t in self.trades if t["net_complete"]]
        return {
            "schema": PORTFOLIO_SCHEMA, "policy_hash": self.policy.policy_hash(),
            "initial_equity_usd": self.policy.initial_equity_usd,
            "equity_usd": str(self.equity_usd()), "reserved_usd": str(self.reserved_usd()),
            "available_usd": str(self.available_usd()), "unrealized_usd": str(self.unrealized_usd()),
            "long_exposure_usd": str(long), "short_exposure_usd": str(short), "gross_exposure_usd": str(long + short),
            "net_exposure_usd": str(long - short), "open_positions": len(self.positions),
            "closed_trades": len(self.trades), "complete_trades": len(complete),
            "realized_complete_usd": str(sum((D(str(t["net_usd"])) for t in complete), D(0))),
            "realized_partial_usd": str(sum((D(str(t["partial_usd"])) for t in self.trades if not t["net_complete"]), D(0))),
            "fees_usd": str(sum((D(str(t["fees_usd"])) for t in self.trades), D(0))),
            "funding_usd": str(sum((D(str(t["funding_usd"])) for t in self.trades if t["funding_usd"] is not None), D(0))),
            "drawdown_usd": str(self.drawdown_usd()),
            "rejected": len([d for d in self.decisions if d["status"] == "rejected"]),
        }

    # ---- sizing and checks ---------------------------------------------------------------------------------
    def _loss_fraction(self, intent):
        """Fraction of notional lost if the stop is hit: stop distance, stop execution cost, entry impact and fees."""
        price, stop, product = D(intent["price"]), D(intent["stop"]), intent["product_id"]
        distance = abs(price - stop) / price
        return distance + (stop_exit_bps(product) + side_impact_bps(product)) / TEN_THOUSAND + 2 * fee_rate("taker")

    def risk_notional(self, intent):
        risk_usd = self.equity_usd() * D(self.policy.risk_per_trade)
        loss = self._loss_fraction(intent)
        return risk_usd / loss if loss > 0 else D(0)

    def _intent_problems(self, intent, now_ms):
        """Checks that depend only on the intent and the market, not on what else competes for capital."""
        reasons, side, product = [], intent["side"], intent["product_id"]
        price, stop, target = D(intent["price"]), D(intent["stop"]), D(intent["target"])
        if side not in (LONG, SHORT) or price <= 0:
            return ["invalid_intent"]
        valid_levels = stop > 0 and (stop < price < target if side == LONG else target < price < stop)
        if not valid_levels:
            reasons.append("levels_unavailable")
        close_ms = intent["data_close_ms"]
        if close_ms > now_ms or now_ms - close_ms > self.policy.max_data_age_ms:
            reasons.append("stale_data")
        if not is_measured(product):
            reasons.append("cost_data_missing")
        if valid_levels and abs(target - price) <= price * (round_trip_rate(product) + COST_BUFFER_RATE):
            reasons.append("target_does_not_clear_cost")
        if product in self.positions:
            held = self.positions[product].position["side"]
            reasons.append("position_already_open" if held == side else "opposite_position_open")
        return reasons

    def _suspended(self, now_ms):
        reasons = []
        if self.realized_today_usd(now_ms) <= -D(self.policy.daily_loss_limit_usd):
            reasons.append("suspended_daily_loss")
        if self.drawdown_usd() >= D(self.policy.max_drawdown_usd):
            reasons.append("suspended_drawdown")
        return reasons

    def _size(self, intent):
        """``(notional, limits_applied, reasons)`` against the capital left right now."""
        p, product, side = self.policy, intent["product_id"], intent["side"]
        long, short = self.exposure()
        gross = long + short
        wanted = self.risk_notional(intent)
        caps = {
            "position_cap": D(p.max_notional_per_position_usd),
            "product_limit": D(p.max_notional_per_product_usd),
            "gross_limit": D(p.max_gross_exposure_usd) - gross,
            "net_limit": D(p.max_net_exposure_usd) - (long - short if side == LONG else short - long),
            "margin": self.available_usd() * D(p.leverage),
        }
        notional = min([wanted] + list(caps.values()))
        applied = sorted(name for name, cap in caps.items() if cap < wanted and cap <= notional)
        reasons = []
        if len(self.positions) >= p.max_open_positions:
            reasons.append("max_open_positions")
        if notional < D(p.min_notional_usd):
            reasons.append(self._shortfall_reason(applied, notional))
        return max(notional, D(0)), applied, reasons

    @staticmethod
    def _shortfall_reason(applied, notional):
        for name, reason in (("margin", "insufficient_margin"), ("gross_limit", "global_exposure_limit"),
                             ("net_limit", "net_exposure_limit"), ("product_limit", "product_exposure_limit")):
            if name in applied:
                return reason
        return "size_below_minimum"

    # ---- decisions -----------------------------------------------------------------------------------------
    def decide(self, intents, now_ms):
        """Resolves the intents of one decision moment. Returns the decision records (also kept in ``decisions``)."""
        self.now_ms = now_ms
        decisions, rejected_ids = [], {}
        by_product = {}
        for intent in intents:
            by_product.setdefault(intent["product_id"], []).append(intent)
        survivors = []
        for product in sorted(by_product):
            group = sorted(by_product[product], key=lambda i: (-D(i["strength"]), i["intent_id"]))
            sides = {i["side"] for i in group}
            if len(sides) > 1:
                for intent in group:
                    rejected_ids[intent["intent_id"]] = ["contradictory_signals"]
                continue
            survivors.append(group[0])
            for intent in group[1:]:
                rejected_ids[intent["intent_id"]] = ["duplicate_same_side"]
        suspended = self._suspended(now_ms)
        for intent in sorted(survivors, key=lambda i: (-D(i["strength"]), i["product_id"], i["intent_id"])):
            reasons = self._intent_problems(intent, now_ms) + suspended
            notional, applied = D(0), []
            if not reasons:
                notional, applied, size_reasons = self._size(intent)
                reasons += size_reasons
            if reasons:
                rejected_ids[intent["intent_id"]] = reasons
                continue
            decisions.append(self._open(intent, notional, applied, now_ms))
        for intent in sorted(intents, key=lambda i: (i["product_id"], i["intent_id"])):
            if intent["intent_id"] in rejected_ids:
                decisions.append(self._record(intent, "rejected", reasons=rejected_ids[intent["intent_id"]]))
        self.decisions.extend(decisions)
        return decisions

    def _record(self, intent, status, **extra):
        body = dict({"status": status, "intent_id": intent["intent_id"], "strategy_id": intent["strategy_id"],
                     "product_id": intent["product_id"], "side": intent["side"], "strength": intent["strength"],
                     "bucket_ms": intent["bucket_ms"], "decided_ms": self.now_ms,
                     "equity_usd": str(self.equity_usd()), "available_usd": str(self.available_usd())}, **extra)
        body["decision_id"] = stable_hash([body["intent_id"], status, self.now_ms])[:24]
        return body

    def _open(self, intent, notional, applied, now_ms):
        product = intent["product_id"]
        book = PositionBook(intent, str(notional), self.tick_sizes.get(product, "1"), self.funding.get(product, ()))
        entry_frame = {"close": intent["price"], "high": intent["price"], "low": intent["price"]}
        book.on_frame(intent["bucket_ms"], _frame(entry_frame), None, None, None)
        if book.position is None:  # the shared simulator refused the entry (target does not clear cost)
            return self._record(intent, "rejected", reasons=["target_does_not_clear_cost"])
        self.positions[product] = book
        self.marks[product] = D(intent["price"])
        return self._record(intent, "opened", notional_usd=str(notional), entry_price=str(book.position["entry"]),
                            limits_applied=applied, risk_usd=str(self.equity_usd() * D(self.policy.risk_per_trade)),
                            risk_notional_usd=str(self.risk_notional(intent)))

    # ---- candles -------------------------------------------------------------------------------------------
    def on_candle(self, product_id, bucket_ms, candle):
        """Feeds one closed 1-minute candle (``open/high/low/close``). Returns the trades it closed."""
        self.marks[product_id] = D(str(candle["close"]))
        book = self.positions.get(product_id)
        closed = []
        if book is None:
            return closed
        book.on_frame(bucket_ms, _frame(candle), None, None, None)
        while book.recorded < len(book.trades):
            trade = book.trades[book.recorded]
            book.recorded += 1
            closed.append(self._store_trade(product_id, book, trade))
        if book.position is None:
            del self.positions[product_id]
        return closed

    def _store_trade(self, product_id, book, trade):
        complete = bool(trade["funding_complete"]) and is_measured(product_id)
        fees = (D(trade["entry_price"]) + D(trade["exit_price"])) * D(trade["quantity"]) * fee_rate("taker")
        stored = dict(trade, product_id=product_id, intent_id=book.intent["intent_id"],
                      net_complete=complete, net_usd=trade["pnl_usd"] if complete else None,
                      partial_usd=trade["pnl_usd"], fees_usd=float(round(fees, 6)),
                      trade_id=stable_hash([product_id, trade["entry_bucket_ms"], book.intent["intent_id"]])[:24])
        self.trades.append(stored)
        return stored

    def ledger_hash(self):
        """Same candles and intents give the same hash: decisions and trades, nothing time-of-day dependent."""
        return stable_hash({"decisions": self.decisions, "trades": self.trades})
