"""Shared paper portfolio with dynamic position sizing (isolated prototype, not connected to the forward).

One account of 1 000 USD shared by every strategy. An *intent* (what a strategy, a combiner or Qwen proposes, with its
protective levels) becomes a position only if it passes validation and the capital and risk limits. Each position is a
``Book`` of the shared simulator (``futures_simulator``): entry with per-product impact, taker fees, funding, stop,
target and time stop. Costs come only from ``futures_costs``. This module adds capital management; there is no second
accounting engine.

Sizing (nothing fixed, nothing derived from signal strength, which is not a calibrated probability):

    risk_budget   = risk_per_trade x definitive_capital                    (1 % by default)
    loss_fraction = planned loss per USD of notional if the stop executes:
                    (entry - stop_exit) / entry + taker_fee x (entry + stop_exit) / entry         (LONG; mirrored for SHORT)
                    with ``entry`` and ``stop_exit`` priced by ``futures_costs.entry_fill`` / ``exit_fill`` (stop reason)
                    and an optional extra ``slippage_buffer_bps`` on the stop execution
    notional      = risk_budget / loss_fraction

then reduced (never raised) by every other limit: gross exposure, exposure per product, net exposure, available margin
and the remaining aggregate open-risk budget. Rounded down to cents, so the planned loss never exceeds the budget.
If ``loss_fraction`` exceeds ``max_loss_fraction_of_notional`` (30 %) the intent is rejected: the stop is never moved
away to make a position fit. The 30 % is a ceiling on the planned loss relative to the notional, not a stop distance and
not the capital at risk. The planned loss is a model figure: it excludes funding (unknown in advance) and any slippage
beyond the model, so it is not a guarantee of the maximum real loss.

Capital: ``definitive`` = initial + net P&L of trades whose funding is fully verified + losses of trades whose funding
is incomplete. Gains of incomplete trades are *provisional*: reported, never spendable, never raise the risk budget.
``reserved`` = open notional / leverage; ``available`` = definitive - reserved.

Resolution of simultaneous intents (deterministic, independent of input order):
  0. Repeated ``intent_id`` that already opened a position never opens another one (idempotent, also after it closed).
  1. Validation first, one intent at a time: invalid, stale, out of range, retroactive, unmeasured product, levels,
     target not clearing costs, 30 % rule, position already open, suspension. Failures are rejected with every reason
     and play no part in what follows, so a stale signal never blocks a valid one.
  2. Among the valid ones, same product and same side: the strongest wins (strength only breaks the tie, it does not
     size); the rest are ``duplicate_same_side``. Opposite sides in one product: all ``contradictory_signals``.
  3. Survivors are allocated one by one by (strength desc, product, intent id) against the capital the previous ones left.
An intent may carry ``entry_bucket_ms`` (default: ``bucket_ms``): the 1-minute bucket the position is opened on when the
entry happens later than the signal's candle (``execution_timing``). The position never sees that bucket's candle.
Time only moves forward: a decision older than the last one, an intent from a candle before the product's last
processed candle, a candle that is not newer than the last one, or data closing after ``now`` are refused.
"""

from dataclasses import asdict, dataclass
from decimal import ROUND_DOWN, Decimal, InvalidOperation

from .futures_costs import COST_MODEL_VERSION, entry_fill, exit_fill, fee_rate, is_measured, round_trip_rate
from .futures_simulator import COST_BUFFER_RATE, ONE_MINUTE_MS, Book
from .multi_risk import DAY_MS, RiskPolicy
from .multi_signals import BUY, SELL, stable_hash

D = Decimal
PORTFOLIO_SCHEMA = "balancita-portfolio.v2"
LONG, SHORT = "LONG", "SHORT"
TEN_THOUSAND = Decimal(10_000)
CENT = Decimal("0.01")
SIGNAL_FIELDS = ("product_id", "side", "bucket_ms", "price", "stop", "target", "horizon_minutes")


class PortfolioError(Exception):
    pass


@dataclass(frozen=True)
class PortfolioPolicy:
    """Initial hypotheses, not optimized values (see docs/cartera-compartida.md for the reason behind each one)."""
    initial_equity_usd: str = "1000"
    leverage: str = "1"
    risk_per_trade: str = "0.01"                    # planned loss at the stop, fraction of definitive capital
    max_loss_fraction_of_notional: str = "0.30"     # reject when the planned loss exceeds this share of the notional
    max_gross_exposure_pct: str = "1.0"             # of definitive capital (1x leverage: all of it)
    max_net_exposure_pct: str = "1.0"               # |long - short|
    max_product_exposure_pct: str = "0.5"
    max_open_risk_pct: str = "0.02"                 # sum of planned losses of the open positions
    min_notional_usd: str = "10"
    max_open_positions: int = 8
    slippage_buffer_bps: str = "0"                  # extra adverse move assumed on the stop execution
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
    """Turns a ``balancita-signal.v1`` BUY/SELL into an intent with the stop/target rules of ``multi_risk``
    (stop at ``stop_atr_mult`` x ATR, target at ``target_stop_ratio`` x the stop distance).

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
        self.intent, self.recorded, self.planned_loss_usd = intent, 0, D(0)
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
    return {"ready": True, "candidate_close": str(candle["close"]), "candidate_high": str(candle["high"]),
            "candidate_low": str(candle["low"])}


class Portfolio:
    def __init__(self, policy=None, *, funding=None, tick_sizes=None):
        """``funding``: product -> iterable of ``(start_ms, end_ms, relative_rate_per_hour)`` (positive: longs pay)."""
        self.policy = policy or PortfolioPolicy()
        self.funding = {p: sorted((int(a), int(b), D(str(r))) for a, b, r in rows) for p, rows in (funding or {}).items()}
        self.tick_sizes = tick_sizes or {}
        self.positions = {}     # product -> PositionBook (at most one open position per product)
        self.trades = []        # closed trades, in close order
        self.decisions = []     # one record per processed intent: opened or rejected (with reasons)
        self.marks = {}         # product -> last close seen, for unrealized P&L
        self.opened_intents = set()
        self.opened_signals = set()   # signal ids that already opened a position, whatever intent carried them
        self.last_decision_ms = None
        self.last_bucket = {}   # product -> last candle bucket consumed (entry or on_candle)

    # ---- capital -------------------------------------------------------------------------------------------
    @staticmethod
    def _pnl(trade):
        return D(str(trade["pnl_usd"]))

    def _conservative_pnl(self, trade):
        """Result used for loss limits: verified results as they are, unverified ones only when they lose."""
        pnl = self._pnl(trade)
        return pnl if trade["net_complete"] else min(D(0), pnl)

    def realized_usd(self):
        return sum((self._pnl(t) for t in self.trades), D(0))

    def capital_usd(self):
        """Definitive capital: verified results plus losses of incomplete ones. Provisional gains are excluded."""
        total = D(self.policy.initial_equity_usd)
        for trade in self.trades:
            total += D(str(trade["net_usd"])) if trade["net_complete"] else min(D(0), self._pnl(trade))
        return total

    def provisional_gains_usd(self):
        return sum((max(D(0), self._pnl(t)) for t in self.trades if not t["net_complete"]), D(0))

    def equity_usd(self):
        """Everything realized, provisional gains included. Reporting only: nothing is sized from it."""
        return D(self.policy.initial_equity_usd) + self.realized_usd()

    def reserved_usd(self):
        return sum((b.notional for b in self.positions.values()), D(0)) / D(self.policy.leverage)

    def available_usd(self):
        return self.capital_usd() - self.reserved_usd()

    def risk_budget_usd(self):
        return max(D(0), self.capital_usd()) * D(self.policy.risk_per_trade)

    def open_risk_usd(self):
        return sum((b.planned_loss_usd for b in self.positions.values()), D(0))

    def exposure(self):
        long = sum((b.notional for b in self.positions.values() if b.position["side"] == LONG), D(0))
        short = sum((b.notional for b in self.positions.values() if b.position["side"] == SHORT), D(0))
        return long, short

    def drawdown_usd(self):
        peak = running = drawdown = D(0)
        for trade in self.trades:
            running += self._conservative_pnl(trade)
            peak = max(peak, running)
            drawdown = max(drawdown, peak - running)
        return drawdown

    def realized_today_usd(self, now_ms):
        return sum((self._conservative_pnl(t) for t in self.trades if t["exit_time_ms"] // DAY_MS == now_ms // DAY_MS), D(0))

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
            "capital_definitive_usd": str(self.capital_usd()), "provisional_gains_usd": str(self.provisional_gains_usd()),
            "equity_usd": str(self.equity_usd()), "reserved_usd": str(self.reserved_usd()),
            "available_usd": str(self.available_usd()), "unrealized_usd": str(self.unrealized_usd()),
            "risk_budget_usd": str(self.risk_budget_usd()), "open_risk_usd": str(self.open_risk_usd()),
            "long_exposure_usd": str(long), "short_exposure_usd": str(short), "gross_exposure_usd": str(long + short),
            "net_exposure_usd": str(long - short), "open_positions": len(self.positions),
            "closed_trades": len(self.trades), "complete_trades": len(complete),
            "realized_complete_usd": str(sum((D(str(t["net_usd"])) for t in complete), D(0))),
            "realized_partial_usd": str(sum((self._pnl(t) for t in self.trades if not t["net_complete"]), D(0))),
            "fees_usd": str(sum((D(str(t["fees_usd"])) for t in self.trades), D(0))),
            "funding_usd": str(sum((D(str(t["funding_usd"])) for t in self.trades if t["funding_usd"] is not None), D(0))),
            "drawdown_usd": str(self.drawdown_usd()),
            "rejected": len([d for d in self.decisions if d["status"] == "rejected"]),
        }

    # ---- planned loss and sizing ---------------------------------------------------------------------------
    def plan(self, intent):
        """Planned loss per USD of notional if the stop executes, priced by the shared cost model."""
        product, side = intent["product_id"], intent["side"]
        entry = entry_fill(D(intent["price"]), side, product)
        stop_exit = exit_fill(D(intent["stop"]), side, product, "stop")
        buffer = D(self.policy.slippage_buffer_bps) / TEN_THOUSAND
        stop_exit = stop_exit * (1 - buffer) if side == LONG else stop_exit * (1 + buffer)
        move = (entry - stop_exit) if side == LONG else (stop_exit - entry)
        loss_fraction = move / entry + fee_rate("taker") * (entry + stop_exit) / entry
        return {"entry": entry, "stop_exit": stop_exit, "loss_fraction": loss_fraction}

    def daily_risk_room_usd(self, now_ms):
        """What the daily loss limit still leaves for planned losses: limit - losses realized today - open planned risk."""
        lost_today = max(D(0), -self.realized_today_usd(now_ms))
        return D(self.policy.daily_loss_limit_usd) - lost_today - self.open_risk_usd()

    def _size(self, intent, plan, now_ms):
        """``(notional, limits_applied, reasons)`` against the capital and risk left right now."""
        p = self.policy
        capital = max(self.capital_usd(), D(0))
        long, short = self.exposure()
        directional = long - short if intent["side"] == LONG else short - long
        loss = plan["loss_fraction"]
        wanted = self.risk_budget_usd() / loss
        caps = {
            "gross_limit": D(p.max_gross_exposure_pct) * capital - (long + short),
            "product_limit": D(p.max_product_exposure_pct) * capital,
            "net_limit": D(p.max_net_exposure_pct) * capital - directional,
            "margin": self.available_usd() * D(p.leverage),
            "open_risk_limit": (D(p.max_open_risk_pct) * capital - self.open_risk_usd()) / loss,
            "daily_loss_budget": self.daily_risk_room_usd(now_ms) / loss,
        }
        notional = min([wanted] + list(caps.values()))
        applied = sorted(name for name, cap in caps.items() if cap < wanted and cap <= notional)
        notional = max(notional, D(0)).quantize(CENT, rounding=ROUND_DOWN)
        reasons = []
        if len(self.positions) >= p.max_open_positions:
            reasons.append("max_open_positions")
        if notional < D(p.min_notional_usd):
            reasons.append(self._shortfall_reason(applied))
        return notional, applied, reasons

    @staticmethod
    def _shortfall_reason(applied):
        for name, reason in (("margin", "insufficient_margin"), ("open_risk_limit", "open_risk_limit"),
                             ("daily_loss_budget", "daily_loss_budget"), ("gross_limit", "global_exposure_limit"), ("net_limit", "net_exposure_limit"),
                             ("product_limit", "product_exposure_limit")):
            if name in applied:
                return reason
        return "size_below_minimum"

    # ---- validation ----------------------------------------------------------------------------------------
    def _validate(self, intent, now_ms):
        """Everything that can be said about one intent alone. Returns ``(reasons, plan_or_None)``."""
        try:
            side, product = intent["side"], intent["product_id"]
            price, stop, target = D(intent["price"]), D(intent["stop"]), D(intent["target"])
            strength, bucket, close_ms = D(intent["strength"]), int(intent["bucket_ms"]), int(intent["data_close_ms"])
            horizon = int(intent["horizon_minutes"])
            entry_bucket = int(intent.get("entry_bucket_ms", bucket))
            finite = all(v.is_finite() for v in (price, stop, target, strength))
        except (KeyError, TypeError, ValueError, InvalidOperation):
            return ["invalid_intent"], None
        if side not in (LONG, SHORT) or not finite or price <= 0 or horizon <= 0 or not D(0) < strength <= D(1):
            return ["invalid_intent"], None
        reasons = []
        if self.last_decision_ms is not None and now_ms < self.last_decision_ms:
            reasons.append("retroactive_decision")
        # The minute the position would be opened on is the one that must not lie behind what was processed. Without
        # ``entry_bucket_ms`` that is the signal's own minute (unchanged); with it, the signal's minute may already be
        # behind (candles processed while the order waited) and only the real entry minute counts. Age and causality of
        # the signal are checked below by ``future_data`` / ``stale_data`` and, upstream, by ``guard_entry``.
        if entry_bucket < self.last_bucket.get(product, entry_bucket):
            reasons.append("retroactive_intent")
        if close_ms > now_ms or bucket + ONE_MINUTE_MS > now_ms:
            reasons.append("future_data")
        elif now_ms - close_ms > self.policy.max_data_age_ms:
            reasons.append("stale_data")
        if not is_measured(product):
            reasons.append("cost_data_missing")
        levels_ok = stop > 0 and (stop < price < target if side == LONG else target < price < stop)
        plan = None
        if not levels_ok:
            reasons.append("levels_unavailable")
        else:
            plan = self.plan(intent)
            if abs(target - price) <= price * (round_trip_rate(product) + COST_BUFFER_RATE):
                reasons.append("target_does_not_clear_cost")
            if plan["loss_fraction"] > D(self.policy.max_loss_fraction_of_notional):
                reasons.append("stop_loss_exceeds_notional_limit")
        if intent["intent_id"] in self.opened_intents:
            reasons.append("duplicate_intent")
        elif intent.get("signal_id") is not None and intent["signal_id"] in self.opened_signals:
            reasons.append("duplicate_signal")
        elif product in self.positions:
            reasons.append("position_already_open" if self.positions[product].position["side"] == side
                           else "opposite_position_open")
        if self.realized_today_usd(now_ms) <= -D(self.policy.daily_loss_limit_usd):
            reasons.append("suspended_daily_loss")
        if self.drawdown_usd() >= D(self.policy.max_drawdown_usd):
            reasons.append("suspended_drawdown")
        return reasons, plan

    # ---- decisions -----------------------------------------------------------------------------------------
    def decide(self, intents, now_ms):
        """Resolves the intents of one decision moment. Returns the decision records (also kept in ``decisions``)."""
        records, rejected, plans, valid = [], {}, {}, []
        seen_in_batch = set()
        for intent in sorted(intents, key=lambda i: (i["product_id"], i["intent_id"])):
            if intent["intent_id"] in seen_in_batch:
                records.append(self._record(intent, now_ms, "rejected", reasons=["duplicate_intent"]))
                continue
            seen_in_batch.add(intent["intent_id"])
            reasons, plan = self._validate(intent, now_ms)
            plans[intent["intent_id"]] = plan
            if reasons:
                rejected[intent["intent_id"]] = reasons
            else:
                valid.append(intent)
        if self.last_decision_ms is None or now_ms > self.last_decision_ms:
            self.last_decision_ms = now_ms
        # One signal, one chance. Valid copies of the same ``signal_id`` that disagree on direction, price, levels or
        # horizon are inconsistent: all are rejected, because nothing here says which version is the right one (and
        # a hash must not decide). Copies that agree on those fields are one proposal seen twice: the earliest
        # observation is kept.
        by_signal, unique = {}, []
        for intent in valid:
            if intent.get("signal_id") is None:
                unique.append(intent)
            else:
                by_signal.setdefault(intent["signal_id"], []).append(intent)
        for sid in sorted(by_signal):
            copies = sorted(by_signal[sid], key=lambda i: (i["data_close_ms"], i["intent_id"]))
            if len({tuple(i[k] for k in SIGNAL_FIELDS) for i in copies}) > 1:
                for intent in copies:
                    rejected[intent["intent_id"]] = ["inconsistent_signal"]
                continue
            unique.append(copies[0])
            for intent in copies[1:]:
                rejected[intent["intent_id"]] = ["duplicate_signal"]
        valid = unique
        by_product = {}
        for intent in valid:
            by_product.setdefault(intent["product_id"], []).append(intent)
        survivors = []
        for product in sorted(by_product):
            group = sorted(by_product[product], key=lambda i: (-D(i["strength"]), i["intent_id"]))
            if len({i["side"] for i in group}) > 1:
                for intent in group:
                    rejected[intent["intent_id"]] = ["contradictory_signals"]
                continue
            survivors.append(group[0])
            for intent in group[1:]:
                rejected[intent["intent_id"]] = ["duplicate_same_side"]
        for intent in sorted(survivors, key=lambda i: (-D(i["strength"]), i["product_id"], i["intent_id"])):
            plan = plans[intent["intent_id"]]
            notional, applied, reasons = self._size(intent, plan, now_ms)
            if reasons:
                rejected[intent["intent_id"]] = reasons
                continue
            records.append(self._open(intent, plan, notional, applied, now_ms))
        for intent in sorted(intents, key=lambda i: (i["product_id"], i["intent_id"])):
            if intent["intent_id"] in rejected:
                records.append(self._record(intent, now_ms, "rejected", reasons=rejected[intent["intent_id"]],
                                            plan=plans.get(intent["intent_id"])))
        self.decisions.extend(records)
        return records

    def _record(self, intent, now_ms, status, plan=None, **extra):
        body = dict({
            "status": status, "intent_id": intent["intent_id"], "strategy_id": intent["strategy_id"],
            "product_id": intent["product_id"], "side": intent["side"], "strength": intent["strength"],
            "bucket_ms": intent["bucket_ms"], "decided_ms": now_ms,
            "capital_definitive_usd": str(self.capital_usd()), "available_usd": str(self.available_usd()),
            "risk_budget_usd": str(self.risk_budget_usd()), "open_risk_usd": str(self.open_risk_usd()),
            "loss_fraction": str(plan["loss_fraction"]) if plan else None}, **extra)
        body["decision_id"] = stable_hash([body["intent_id"], status, now_ms, extra.get("reasons")])[:24]
        return body

    def _open(self, intent, plan, notional, applied, now_ms):
        product = intent["product_id"]
        budget = self.risk_budget_usd()
        book = PositionBook(intent, str(notional), self.tick_sizes.get(product, "1"), self.funding.get(product, ()))
        entry_bucket = int(intent.get("entry_bucket_ms", intent["bucket_ms"]))
        book.on_frame(entry_bucket, _frame({"close": intent["price"], "high": intent["price"],
                                                   "low": intent["price"]}), None, None, None)
        if book.position is None:  # the shared simulator refused the entry
            return self._record(intent, now_ms, "rejected", plan, reasons=["target_does_not_clear_cost"])
        planned = notional * plan["loss_fraction"]
        book.planned_loss_usd = planned
        open_before = self.open_risk_usd()
        self.positions[product] = book
        self.opened_intents.add(intent["intent_id"])
        if intent.get("signal_id") is not None:
            self.opened_signals.add(intent["signal_id"])
        self.last_bucket[product] = max(self.last_bucket.get(product, 0), entry_bucket)
        self.marks[product] = D(intent["price"])
        return self._record(
            intent, now_ms, "opened", plan, notional_usd=str(notional), entry_price=str(book.position["entry"]),
            planned_loss_usd=str(planned), planned_loss_pct_of_capital=str(planned / self.capital_usd() * 100),
            open_risk_before_usd=str(open_before), open_risk_after_usd=str(self.open_risk_usd()),
            risk_budget_used_usd=str(budget), risk_notional_usd=str(budget / plan["loss_fraction"]),
            limits_applied=applied)

    # ---- candles -------------------------------------------------------------------------------------------
    def on_candle(self, product_id, bucket_ms, candle):
        """Feeds one closed 1-minute candle (``open/high/low/close``), strictly newer than the last one used for the
        product (a position never sees the candle it entered on, nor one twice). Returns the trades it closed."""
        last = self.last_bucket.get(product_id)
        if last is not None and bucket_ms <= last:
            raise PortfolioError("candle_not_newer: {} <= {}".format(bucket_ms, last))
        self.last_bucket[product_id] = bucket_ms
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
                      planned_loss_usd=float(round(book.planned_loss_usd, 6)),
                      trade_id=stable_hash([product_id, trade["entry_bucket_ms"], book.intent["intent_id"]])[:24])
        self.trades.append(stored)
        return stored

    def ledger_hash(self):
        """Same candles and intents give the same hash: decisions and trades, nothing time-of-day dependent."""
        return stable_hash({"decisions": self.decisions, "trades": self.trades})
