"""Modelled execution for the historical replay (stage 9A): fills from candles, never from observed quotes.

``ModelledExecutor`` is a ``TimedExecutor`` whose orders are filled by ``on_modelled_price`` instead of ``on_quote``. The
price comes from a candle the replay driver already holds (for example the open of the minute after the decision) and is
labelled ``MODELLED_EXECUTION`` in every record. Nothing here is, or looks like, an observed bid/ask:

* the price is turned into the dict the parent's checks read with ``bid = ask = mid = price`` and zero spread; the cost
  model's own ``entry_fill`` (which already includes half the spread and the impact of the product) is applied by the
  shared ``Portfolio``/``Book`` exactly as in the forward, so no cost rule is repeated here;
* the parent's rules are reused, not copied: usable-from time (latency), expiry (``max_execution_delay_ms``), the
  stop/target distance-consumed checks, ``Portfolio.decide`` and the sizing from the executable price;
* ``QuoteWatch`` is never built, so no synthetic quote can reach it. Positions are watched with closed candles
  (``Portfolio.on_candle``, the existing stop/target/time-stop rules) and the stop evidence is OHLC, i.e. estimated;
* the portfolio never shows a position the candle of its entry minute, so this class resolves that minute itself: if the
  range of the entry minute touched the stop, the position is closed at the stop with the cost model's stop exit and the
  evidence ``assumed_stop_entry_minute`` (``estimated: True``). A touched target is ignored (conservative: no win is
  assumed from a range whose order of events is unknown).

No wall clock, no network, no randomness. This module is not part of ``paper_runner.BUILD_MODULES``: the replay manifest
carries its own hash (``replay_driver.code_identity``).
"""

from decimal import Decimal

from .execution_timing import ExecutionPolicy, TimedExecutor
from .futures_costs import exit_fill
from .multi_signals import stable_hash

D = Decimal
ONE_MINUTE_MS = 60_000
SCHEMA = "balancita-replay-execution.v1"
EXECUTION_LABEL = "MODELLED_EXECUTION"
LONG, SHORT = "LONG", "SHORT"


class ModelledExecutor(TimedExecutor):
    """Same surface as ``TimedExecutor`` (``submit``, ``advance``, ``cancel``, ``on_candle``, ``pending``, ``records``,
    ``ledger_hash``); orders are filled by ``on_modelled_price``. ``on_quote`` refuses to work."""

    def __init__(self, portfolio=None, policy=None):
        super().__init__(portfolio, policy or ExecutionPolicy(), watch=None)
        self.entry_minute = {}        # product -> (intent_id, entry_bucket_ms): entry minutes whose candle is still to come
        self.modelled_log = []        # observed facts about the modelled prices handed in (ignored ones included)

    def on_quote(self, quote):
        raise RuntimeError("a modelled replay never receives quotes")

    # ---- fills ------------------------------------------------------------------------------------------------
    def on_modelled_price(self, payload):
        """``{product_id, price, time_ms, source, scenario}``: one modelled price at ``time_ms``. Fills every order of
        the product that is past its latency and whose checks pass; rejects the ones whose window is over."""
        try:
            product, price, time_ms = payload["product_id"], D(str(payload["price"])), int(payload["time_ms"])
            source, scenario = str(payload["source"]), str(payload["scenario"])
        except (KeyError, TypeError, ValueError, ArithmeticError):
            self.modelled_log.append({"kind": "modelled_price_ignored", "reason": "invalid_price"})
            return []
        if not price.is_finite() or price <= 0:
            self.modelled_log.append({"kind": "modelled_price_ignored", "reason": "invalid_price", "product_id": product})
            return []
        if time_ms % ONE_MINUTE_MS == 0:
            # on a minute boundary the entry minute would be the one before, whose candle was already processed
            self.modelled_log.append({"kind": "modelled_price_ignored", "reason": "boundary_instant", "product_id": product,
                                      "time_ms": time_ms})
            return []
        if self.now_ms is not None and time_ms < self.now_ms:
            self.modelled_log.append({"kind": "modelled_price_ignored", "reason": "out_of_order", "product_id": product,
                                      "time_ms": time_ms})
            return []
        self._tick(time_ms)
        q = {"product_id": product, "time_ms": time_ms, "received_ms": time_ms, "bid": price, "ask": price, "mid": price,
             "spread_bps": D(0)}
        done = self._expire(time_ms, product)
        ready = []
        for order in self._orders(product):
            order["quotes_seen"] += 1
            if time_ms < order["timeline"]["earliest_fill_ms"]:
                order["discarded"]["before_latency"] = order["discarded"].get("before_latency", 0) + 1
                continue
            outcome = self._price_checks(order, q)
            if isinstance(outcome, list):
                record = self._reject(order, outcome, time_ms)["record"]
                self._relabel(record, q, source, scenario)
                done.append(record)
            else:
                ready.append(outcome)
        if ready:
            for record in self._fill(ready, q):
                self._relabel(record, q, source, scenario)
                done.append(record)
                if record["status"] == "opened":
                    book = self.portfolio.positions[record["product_id"]]
                    book.position["entry_ms"] = time_ms               # funding runs from the real (modelled) entry instant
                    self.entry_minute[record["product_id"]] = (record["intent_id"], int(record["timeline"]["entry_bucket_ms"]))
        return done

    @staticmethod
    def _relabel(record, q, source, scenario):
        """The parent records the price as a ``quote`` with bid/ask: here it is a modelled price, and says so."""
        record.pop("quote", None)
        record["execution"] = EXECUTION_LABEL
        record["modelled_fill"] = {"price": str(q["mid"]), "time_ms": q["time_ms"], "source": source, "scenario": scenario,
                                   "observed": False}

    # ---- positions --------------------------------------------------------------------------------------------
    def accepts_entry_minute_candle(self, product, bucket_ms):
        pending = self.entry_minute.get(product)
        return pending is not None and pending[1] == bucket_ms

    def on_candle(self, product_id, bucket_ms, candle):
        pending = self.entry_minute.get(product_id)
        if pending is not None and pending[1] == bucket_ms:
            del self.entry_minute[product_id]
            self._tick(bucket_ms + ONE_MINUTE_MS)
            return self._resolve_entry_minute(product_id, bucket_ms, candle, pending[0])
        return super().on_candle(product_id, bucket_ms, candle)

    def _resolve_entry_minute(self, product, bucket_ms, candle, intent_id):
        portfolio = self.portfolio
        portfolio.marks[product] = D(str(candle["close"]))
        book = portfolio.positions.get(product)
        if book is None or book.intent["intent_id"] != intent_id:
            return []
        position = book.position
        side, stop = position["side"], position["stop"]
        low, high = D(str(candle["low"])), D(str(candle["high"]))
        touched = low <= stop if side == LONG else high >= stop
        if not touched:
            self.modelled_log.append({"kind": "entry_minute_clear", "product_id": product, "bucket_ms": bucket_ms,
                                      "intent_id": intent_id})
            return []
        executable = exit_fill(stop, side, product, "stop")
        trade = portfolio.close_on_quote(
            product, bucket_ms + ONE_MINUTE_MS, stop, executable, "assumed_stop_entry_minute",
            {"estimated": True, "execution": EXECUTION_LABEL,
             "assumption": "the range of the entry minute touched the stop; the order of events inside a candle is unknown, "
                           "so the position is closed at the stop"})
        self.modelled_log.append({"kind": "entry_minute_stop", "product_id": product, "bucket_ms": bucket_ms,
                                  "trade_id": trade["trade_id"]})
        return [trade]

    def ledger_hash(self):
        return stable_hash({"records": self.records, "portfolio": self.portfolio.ledger_hash(), "modelled": self.modelled_log,
                            "schema": SCHEMA})
