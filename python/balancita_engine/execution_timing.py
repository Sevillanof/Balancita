"""Temporally correct paper entry for the shared portfolio (offline, isolated).

The portfolio of ``portfolio.py`` opens a position at the *reference price of the intent* (the close of the candle the
signal was computed on). That price is known when the signal is generated, but nothing can be bought at it afterwards.
This module puts the missing steps between the signal and the entry, in this order:

    closed candle -> signal generated -> signal persisted -> decision -> first executable quote -> paper entry

* ``submit`` takes an entry of the durable ``SignalLog`` (``signal_continuity``). ``guard_entry`` and the ordering
  ``candle close <= generated <= persisted <= decided`` must hold, otherwise the order is rejected with a reason.
* The stop and the target are fixed once, from the signal's reference price and ATR (``multi_risk`` rules through
  ``portfolio.intent_from_signal``). They are never recomputed.
* ``on_quote`` is the only way a price reaches the entry: the first *usable* quote of the product that was observed
  at or after ``decided_ms + latency_ms`` and received no later than ``decided_ms + max_execution_delay_ms``. A quote
  is usable when it is well formed, in order, fresh, not too wide. Nothing looks ahead: a quote is seen when it is
  delivered, and the first usable one is the one used (a later, better quote is never chosen afterwards).
* The executable intent keeps the original stop and target and replaces only the price. ``Portfolio`` then sizes it
  with its own rule (risk budget / planned loss per USD), so the notional is recomputed against the original stop from
  the executable price (the planned loss stays at the risk budget; a price nearer the stop gives a larger notional,
  still bounded by every portfolio limit, and a price farther from it a smaller one). The stop is never moved.
* No usable quote in the window -> the order is rejected (``no_quote_in_window`` / ``no_valid_quote_in_window``).
  The reference price is never a fallback.
* If the executable price already consumed too much of the original stop distance (``max_stop_distance_consumed``),
  already passed the stop or the target, or consumed too much of the target distance, the order is rejected.

The price paid is the cost model's ``entry_fill`` applied to the quote's mid, except that it is never better than the
visible touch (ask for LONG, bid for SHORT): ``futures_costs`` impact already includes half the spread, so the touch is
only used when it is worse than the model. Costs, fees, funding, exits and capital remain ``futures_costs`` /
``futures_simulator.Book`` / ``Portfolio``; this module adds no trading logic and no second engine.

Entry time is the moment the quote was received. The shared ``Book`` works on 1-minute candles: the position is opened
on the bucket that makes ``opened_at`` the first minute boundary at or after the entry and never sees the candle of
the entry minute. The part of that minute after the entry is therefore not watched for the stop (at most 59.999 s,
and zero when the entry is on a boundary). That is a stated limitation, not a hidden assumption. Since stage 7 it can be
covered: ``TimedExecutor(..., watch=WatchPolicy())`` forwards every later quote to ``portfolio_watch.QuoteWatch``
(docs/contabilidad-condiciones-adversas.md); without ``watch`` nothing changes.

Conventions: ``signal.bucket_ms`` in the durable log is the *close* of the candle the signal used (``cycle_ms``);
``Portfolio`` intents use the *start* of the last 1-minute candle, so the conversion is ``bucket = close - 60 s``.

Not connected to the forward, ``capture``, Kronos, Qwen or any database; no wall clock (every time is passed in), no
network, no randomness. The policy numbers below are initial hypotheses, not optimized, and are not the approved risk
parameters (those stay in ``PortfolioPolicy``).
"""

from dataclasses import asdict, dataclass
from decimal import Decimal

from .futures_costs import COST_MODEL_VERSION, entry_fill, side_impact_bps
from .multi_signals import BUY, SELL, stable_hash
from .portfolio import LONG, SHORT, Portfolio, intent_from_signal
from .portfolio_watch import QuoteWatch, parse_quote  # noqa: F401  (parse_quote moved there; kept importable from here)
from .signal_continuity import RetroactiveEntryError, guard_entry

D = Decimal
SCHEMA = "balancita-execution-timing.v1"
ONE_MINUTE_MS = 60_000
TEN_THOUSAND = Decimal(10_000)

REJECTION_REASONS = frozenset({
    # the signal, before any price
    "reconstructed_signal", "candle_not_closed", "generated_after_evaluation", "generated_before_candle_close",
    "signal_expired", "persisted_before_generated", "decision_before_persistence", "time_went_backwards",
    "levels_unavailable",
    # the price
    "no_quote_in_window", "no_valid_quote_in_window", "executable_price_beyond_stop", "executable_price_beyond_target",
    "adverse_move_consumed_stop_distance", "favorable_move_consumed_target_distance"})


@dataclass(frozen=True)
class ExecutionPolicy:
    """Initial hypotheses about execution, not optimized values."""
    latency_ms: int = 1_000                       # earliest an order decided at D can reach the book: D + latency
    max_execution_delay_ms: int = 60_000          # no usable quote by D + this -> rejected
    max_quote_age_ms: int = 5_000                 # received_ms - time_ms above this: the quote is stale
    max_quote_spread_bps: str = "30"              # wider than this: not usable (kept waiting for a better one)
    max_stop_distance_consumed: str = "0.5"       # adverse move, as a share of the original stop distance
    max_target_distance_consumed: str = "0.5"     # favorable move, as a share of the original target distance

    def policy_hash(self):
        return stable_hash(dict(asdict(self), cost_model=COST_MODEL_VERSION, schema=SCHEMA))[:16]


def executable_reference(side, product_id, quote):
    """Reference price to hand to the shared simulator so that its entry is the model's ``entry_fill`` of the mid,
    never better than the visible touch (the ask for LONG, the bid for SHORT)."""
    mid = quote["mid"]
    adjust = side_impact_bps(product_id) / TEN_THOUSAND
    if side == LONG:
        return mid if entry_fill(mid, side, product_id) >= quote["ask"] else quote["ask"] / (1 + adjust)
    return mid if entry_fill(mid, side, product_id) <= quote["bid"] else quote["bid"] / (1 - adjust)


def adverse_bps(side, reference, price):
    """Signed move from ``reference`` to ``price`` in bp, positive when it is worse for a position on ``side``."""
    move = (price - reference) / reference * TEN_THOUSAND
    return move if side == LONG else -move


class TimedExecutor:
    """Event-driven: ``submit`` (decision), ``on_quote`` (market), ``advance`` (clock), ``on_candle`` (positions).
    Events must arrive in time order; one that does not is refused, never reordered."""

    def __init__(self, portfolio=None, policy=None, watch=None):
        """``watch``: a ``portfolio_watch.WatchPolicy`` to watch open positions with the quotes that arrive after the
        entry (stage 7). ``None`` (default) keeps the earlier behaviour exactly: positions see candles only."""
        self.portfolio = portfolio or Portfolio()
        self.policy = policy or ExecutionPolicy()
        self.watch = None if watch is None else QuoteWatch(self.portfolio, watch)
        self.pending = {}         # intent_id -> order waiting for a usable quote
        self.records = []         # one terminal record per order: opened or rejected, with the whole timeline
        self.events = []          # order_accepted / order_duplicate / quote_ignored, in arrival order
        self.seen_orders = set()
        self.last_quote_ms = {}   # product -> time of the last quote accepted in order
        self.now_ms = None

    # ---- clock -----------------------------------------------------------------------------------------------
    def _tick(self, now_ms):
        self.now_ms = now_ms if self.now_ms is None else max(self.now_ms, now_ms)

    def _log(self, kind, **data):
        self.events.append(dict(data, kind=kind))

    # ---- decision --------------------------------------------------------------------------------------------
    def submit(self, entry, *, reference_price, atr, decided_ms, risk_policy=None):
        """The decision to trade a persisted signal. Returns ``{"status": "pending" | "rejected" | "ignored" |
        "duplicate", ...}``; a rejection also leaves a terminal record."""
        data = entry["data"]
        signal = data["signal"]
        if signal["action"] not in (BUY, SELL):
            return {"status": "ignored", "reasons": ["not_actionable"]}
        side = LONG if signal["action"] == BUY else SHORT
        close_ms, generated_ms, persisted_ms = int(data["cycle_ms"]), int(data["generated_ms"]), int(entry["t_ms"])
        timeline = {"candle_close_ms": close_ms, "generated_ms": generated_ms, "persisted_ms": persisted_ms,
                    "decided_ms": int(decided_ms)}
        intent = intent_from_signal(dict(signal, bucket_ms=close_ms - ONE_MINUTE_MS), price=reference_price, atr=atr,
                                    risk_policy=risk_policy, data_close_ms=close_ms)
        order = {"signal_key": data["key"], "signal_id": signal["signal_id"], "strategy_id": signal["strategy_id"],
                 "product_id": signal["product_id"], "side": side, "timeline": timeline, "intent": intent,
                 "reference_price": str(reference_price), "atr": str(atr),
                 "discarded": {}, "quotes_seen": 0}
        if intent is not None and intent["intent_id"] in self.seen_orders:
            self._log("order_duplicate", intent_id=intent["intent_id"], decided_ms=decided_ms)
            return {"status": "duplicate", "intent_id": intent["intent_id"], "reasons": ["duplicate_order"]}
        reasons = []
        if self.now_ms is not None and decided_ms < self.now_ms:
            reasons.append("time_went_backwards")
        try:
            guard_entry(entry, decided_ms)
        except RetroactiveEntryError as error:
            reasons.append(error.reason)
        if persisted_ms < generated_ms:
            reasons.append("persisted_before_generated")
        if decided_ms < persisted_ms:
            reasons.append("decision_before_persistence")
        if intent is None:
            reasons.append("levels_unavailable")
        if reasons:
            if intent is not None:
                self.seen_orders.add(intent["intent_id"])
            return self._reject(order, reasons, decided_ms)
        self._tick(decided_ms)
        self.seen_orders.add(intent["intent_id"])
        p = self.policy
        order["timeline"].update(earliest_fill_ms=decided_ms + p.latency_ms,
                                 deadline_ms=decided_ms + p.max_execution_delay_ms)
        self.pending[intent["intent_id"]] = order
        self._log("order_accepted", intent_id=intent["intent_id"], product_id=order["product_id"], side=side,
                  timeline=order["timeline"], stop=intent["stop"], target=intent["target"])
        return {"status": "pending", "intent_id": intent["intent_id"]}

    def _reject(self, order, reasons, now_ms, **extra):
        intent = order["intent"]
        record = self._record(order, "rejected", reasons=sorted(reasons), **extra)
        record["decided_at_ms"] = int(now_ms)
        self.records.append(record)
        if intent is not None:
            self.pending.pop(intent["intent_id"], None)
        return {"status": "rejected", "intent_id": record["intent_id"], "reasons": record["reasons"], "record": record}

    # ---- market ----------------------------------------------------------------------------------------------
    def on_quote(self, quote):
        """Delivers one quote ``{product_id, time_ms, received_ms?, bid, ask}``. Returns the records it finalised."""
        try:
            q = parse_quote(quote)
        except ValueError:
            self._log("quote_ignored", reason="invalid_quote", quote_hash=stable_hash(quote))
            self._count_discard(quote.get("product_id") if isinstance(quote, dict) else None, "invalid_quote")
            return []
        product = q["product_id"]
        if self.now_ms is not None and q["received_ms"] < self.now_ms:
            self._log("quote_ignored", reason="out_of_order_quote", product_id=product, time_ms=q["time_ms"])
            self._count_discard(product, "out_of_order_quote")
            return []
        last = self.last_quote_ms.get(product)
        if last is not None and q["time_ms"] <= last:
            self._log("quote_ignored", reason="out_of_order_quote", product_id=product, time_ms=q["time_ms"])
            self._count_discard(product, "out_of_order_quote")
            return []
        self.last_quote_ms[product] = q["time_ms"]
        self._tick(q["received_ms"])
        done = self._expire(q["received_ms"], product)
        ready = []
        for order in self._orders(product):
            order["quotes_seen"] += 1
            line = order["timeline"]
            why = None
            if q["time_ms"] < line["earliest_fill_ms"]:
                why = "before_latency"
            elif q["received_ms"] - q["time_ms"] > self.policy.max_quote_age_ms:
                why = "stale_quote"
            elif q["spread_bps"] > D(self.policy.max_quote_spread_bps):
                why = "wide_spread"
            if why:
                order["discarded"][why] = order["discarded"].get(why, 0) + 1
                continue
            outcome = self._price_checks(order, q)
            if isinstance(outcome, list):
                done.append(self._reject(order, outcome, q["received_ms"], quote=self._quote_view(q))["record"])
            else:
                ready.append(outcome)
        if ready:
            done.extend(self._fill(ready, q))
        if self.watch is not None:
            self.watch.on_quote(quote)   # positions are watched with every quote that arrived after their entry
        return done

    def advance(self, now_ms):
        """Moves the clock without a quote: orders whose window is over are rejected."""
        if self.now_ms is not None and now_ms < self.now_ms:
            return []
        self._tick(now_ms)
        return self._expire(now_ms, None)

    def _orders(self, product):
        return sorted((o for o in self.pending.values() if o["product_id"] == product),
                      key=lambda o: (o["timeline"]["decided_ms"], o["intent"]["intent_id"]))

    def _count_discard(self, product, why):
        for order in self._orders(product) if product else ():
            order["discarded"][why] = order["discarded"].get(why, 0) + 1

    def _expire(self, now_ms, product):
        out = []
        for order in sorted(self.pending.values(), key=lambda o: (o["timeline"]["decided_ms"], o["intent"]["intent_id"])):
            if (product is None or order["product_id"] == product) and now_ms > order["timeline"]["deadline_ms"]:
                reason = "no_quote_in_window" if not order["quotes_seen"] else "no_valid_quote_in_window"
                out.append(self._reject(order, [reason], now_ms)["record"])
        return out

    # ---- price checks and fill -------------------------------------------------------------------------------
    @staticmethod
    def _quote_view(q):
        return {k: str(q[k]) for k in ("time_ms", "received_ms", "bid", "ask", "mid")} | {"spread_bps": str(q["spread_bps"])}

    def _price_checks(self, order, q):
        """A list of rejection reasons, or ``(order, fill_reference, geometry)`` when the price may be used."""
        intent, side = order["intent"], order["side"]
        fill_ref = executable_reference(side, order["product_id"], q)
        reference, stop, target = D(order["reference_price"]), D(intent["stop"]), D(intent["target"])
        mid = q["mid"]   # the stop is judged on the mid as well as on the price paid: a mid at the stop is already stopped
        beyond_stop = min(fill_ref, mid) <= stop if side == LONG else max(fill_ref, mid) >= stop
        beyond_target = fill_ref >= target if side == LONG else fill_ref <= target
        stop0, target0 = abs(reference - stop), abs(target - reference)
        consumed_stop = (stop0 - abs(fill_ref - stop)) / stop0
        consumed_target = (target0 - abs(target - fill_ref)) / target0
        geometry = {"fill_reference": str(fill_ref), "move_adverse_bps": str(adverse_bps(side, reference, fill_ref)),
                    "stop_distance_consumed": str(consumed_stop), "target_distance_consumed": str(consumed_target)}
        order["geometry"] = geometry
        reasons = []
        if beyond_stop:
            reasons.append("executable_price_beyond_stop")
        elif consumed_stop > D(self.policy.max_stop_distance_consumed):
            reasons.append("adverse_move_consumed_stop_distance")
        if beyond_target:
            reasons.append("executable_price_beyond_target")
        elif consumed_target > D(self.policy.max_target_distance_consumed):
            reasons.append("favorable_move_consumed_target_distance")
        return reasons if reasons else (order, fill_ref)

    def _fill(self, ready, q):
        """Decides the orders that found their price on this quote in one portfolio batch (so its tie rules apply)."""
        entry_ms = q["received_ms"]
        entry_bucket = -(-entry_ms // ONE_MINUTE_MS) * ONE_MINUTE_MS - ONE_MINUTE_MS
        by_id, intents = {}, []
        for order, fill_ref in ready:
            executable = dict(order["intent"], price=str(fill_ref), entry_bucket_ms=entry_bucket)
            if self.watch is not None:
                executable["entry_ms"] = entry_ms
            order["timeline"].update(entry_ms=entry_ms, entry_bucket_ms=entry_bucket, opened_at_ms=entry_bucket + ONE_MINUTE_MS)
            order["loss_fraction_at_reference"] = str(self.portfolio.plan(order["intent"])["loss_fraction"])
            by_id[order["intent"]["intent_id"]] = order
            intents.append(executable)
        decisions = {d["intent_id"]: d for d in self.portfolio.decide(intents, entry_ms)}
        out = []
        for intent_id in sorted(by_id):
            order, decision = by_id[intent_id], decisions[intent_id]
            self.pending.pop(intent_id, None)
            if decision["status"] == "opened":
                book = self.portfolio.positions[order["product_id"]]
                record = self._record(order, "opened", quote=self._quote_view(q), decision=decision,
                                      position_stop=str(book.position["stop"]), position_target=book.position["target_text"])
            else:
                record = self._record(order, "rejected", reasons=sorted(decision["reasons"]), quote=self._quote_view(q),
                                      decision=decision, portfolio_rejection=True)
            self.records.append(record)
            out.append(record)
        return out

    def _record(self, order, status, **extra):
        intent, line = order["intent"], order["timeline"]
        body = {"schema": SCHEMA, "status": status, "intent_id": intent["intent_id"] if intent else None,
                "signal_id": order["signal_id"], "signal_key": order["signal_key"], "strategy_id": order["strategy_id"],
                "product_id": order["product_id"], "side": order["side"], "timeline": dict(line),
                "reference_price": order["reference_price"], "atr": order["atr"],
                "stop": intent["stop"] if intent else None, "target": intent["target"] if intent else None,
                "horizon_minutes": intent["horizon_minutes"] if intent else None,
                "quotes_seen": order["quotes_seen"], "quotes_discarded": dict(sorted(order["discarded"].items())),
                "policy_hash": self.policy.policy_hash()}
        body.update(order.get("geometry") or {})
        decision = extra.pop("decision", None)
        body.update(extra)
        if decision is not None:
            body["portfolio_decision_id"] = decision["decision_id"]
            body["loss_fraction"] = decision["loss_fraction"]
            body["loss_fraction_at_reference"] = order.get("loss_fraction_at_reference")
            if status == "opened":
                budget, lf_ref = D(decision["risk_budget_used_usd"]), D(order["loss_fraction_at_reference"])
                body.update(notional_usd=decision["notional_usd"], entry_price=decision["entry_price"],
                            planned_loss_usd=decision["planned_loss_usd"], risk_budget_usd=decision["risk_budget_used_usd"],
                            notional_at_reference_usd=str((budget / lf_ref).quantize(D("0.01"))),
                            limits_applied=decision["limits_applied"],
                            stop_unchanged=D(extra["position_stop"]) == D(intent["stop"]),
                            entry_vs_reference_model_bps=str(adverse_bps(
                                order["side"], entry_fill(D(order["reference_price"]), order["side"], order["product_id"]),
                                D(decision["entry_price"]))))
        body["record_id"] = stable_hash([body["intent_id"], status, body.get("reasons"), line])[:24]
        return body

    def reasons_count(self):
        counts = {}
        for record in self.records:
            for reason in record.get("reasons", ()):
                counts[reason] = counts.get(reason, 0) + 1
        return dict(sorted(counts.items()))

    # ---- positions -------------------------------------------------------------------------------------------
    def on_candle(self, product_id, bucket_ms, candle):
        """Closed 1-minute candle for the positions, through the shared portfolio (stop/target/time stop)."""
        self._tick(bucket_ms + ONE_MINUTE_MS)
        if self.watch is not None:
            return self.watch.on_candle(product_id, bucket_ms, candle)
        return self.portfolio.on_candle(product_id, bucket_ms, candle)

    def ledger_hash(self):
        return stable_hash({"records": self.records, "portfolio": self.portfolio.ledger_hash()})
