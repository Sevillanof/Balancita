"""Stop watching with market quotes (offline, isolated): the minute of entry and the gaps between candles.

``Book`` works on closed 1-minute candles. A position opened at 12:00:10 therefore does not see the candle of 12:00
(it contains prices from before the entry) and would not look at its stop until the candle of 12:01 closes at 12:02.
``QuoteWatch`` covers that window, and the time between candles, with the quotes that arrive after the entry:

* only quotes observed *after* the entry instant are used (``time_ms`` strictly greater than the entry instant; the
  quote that filled the order is therefore never used for the stop);
* a quote is processed once: ``time_ms`` must grow strictly per product (a duplicate or a quote that goes back is
  ignored and logged), and a quote that belongs to a minute whose candle was already processed is ignored
  (``covered_by_candle``): the candle owns that minute, so one movement is never counted twice;
* when the executable side of a quote crosses the stop (the bid for a LONG, the ask for a SHORT) the position is closed
  once, through ``Book``/``Portfolio`` (same fees, funding and accounting). The price is the *worst* of three: the
  cost model applied to the mid (``futures_costs.exit_fill``, impact plus a full spread), the visible touch, and the
  planned stop exit. It is never better than the plan and the loss is booked whole, whatever the risk budget said;
* the candle of the entry minute is not used to evaluate the stop (it holds pre-entry prices). It is used only to say
  whether the range touched the stop: if it did and the quotes did not cover the window, the result is flagged
  ``entry_minute_unresolved`` (policy ``flag``, the default) or the position is conservatively closed at the stop
  (policy ``stop``, evidence ``assumed_stop_entry_minute``, an estimate, never presented as a quote-backed price);
* candles keep closing positions as before (stop first, then target, then time stop); a position already closed by a
  quote is gone, so a candle cannot close it again.

Events must arrive in time order, as everywhere else in this prototype. The module is not connected to the forward,
``capture``, Kronos, Qwen or any database. No wall clock, no network, no randomness.
"""

from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation

from .futures_costs import COST_MODEL_VERSION, exit_fill
from .multi_signals import stable_hash

D = Decimal
SCHEMA = "balancita-quote-watch.v1"
ONE_MINUTE_MS = 60_000
TEN_THOUSAND = Decimal(10_000)
UNRESOLVED_POLICIES = ("flag", "stop")
# Kraken stamps ``time_ms`` with its own clock, ours stamps ``received_ms``: in the real BTC sample 9 % of the quotes (11,269 of 125,589)
# were received up to 149 ms BEFORE their Kraken time. 500 ms is more than 3 times that, and far below any gap that matters (the entry
# window is seconds). It is a parameter to review, not a measured limit. Beyond it the quote is invalid (a clock that far off is a fault).
CLOCK_SKEW_TOLERANCE_MS = 500


def parse_quote(quote):
    """Validated quote with Decimals, or ``ValueError(reason)``. ``received_ms`` defaults to ``time_ms``. A quote received up to
    ``CLOCK_SKEW_TOLERANCE_MS`` before its Kraken time is kept with ``received_ms`` raised to ``time_ms`` (the later, never the earlier
    instant, so no decision uses a quote before it can have existed); further back it is invalid."""
    try:
        bid, ask = D(str(quote["bid"])), D(str(quote["ask"]))
        time_ms = int(quote["time_ms"])
        received_ms = int(quote.get("received_ms", time_ms))
        product = quote["product_id"]
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise ValueError("invalid_quote")
    if not (bid.is_finite() and ask.is_finite()) or bid <= 0 or ask <= 0 or ask < bid or received_ms < time_ms - CLOCK_SKEW_TOLERANCE_MS:
        raise ValueError("invalid_quote")
    received_ms = max(received_ms, time_ms)
    mid = (bid + ask) / 2
    return {"product_id": product, "time_ms": time_ms, "received_ms": received_ms, "bid": bid, "ask": ask, "mid": mid,
            "spread_bps": (ask - bid) / mid * TEN_THOUSAND}


@dataclass(frozen=True)
class WatchPolicy:
    """Initial hypotheses, not measured values and not approved risk parameters."""
    max_watch_gap_ms: int = 10_000          # longer without a quote inside the entry window: coverage is only partial
    unresolved_entry_minute: str = "flag"   # "flag" | "stop": what to do if the window was not covered and the range touched the stop

    def __post_init__(self):
        if self.unresolved_entry_minute not in UNRESOLVED_POLICIES:
            raise ValueError("unresolved_entry_minute must be one of {}".format(UNRESOLVED_POLICIES))

    def policy_hash(self):
        return stable_hash(dict(asdict(self), cost_model=COST_MODEL_VERSION, schema=SCHEMA))[:16]


class QuoteWatch:
    def __init__(self, portfolio, policy=None):
        self.portfolio = portfolio
        self.policy = policy or WatchPolicy()
        self.last_quote_ms = {}     # product -> time of the last quote accepted in order
        self.covered_until = {}     # product -> end of the last candle processed: quotes before it belong to the candle
        self.state = {}             # product -> watch state of the open position
        self.entry_minute = {}      # product -> entry bucket of the last position seen (to recognise its candle later)
        self.events = []            # ignored / closed / unresolved, in arrival order
        self.closed = []            # trades closed by this watcher (also in portfolio.trades)

    def _log(self, kind, **data):
        self.events.append(dict(data, kind=kind))

    # ---- state of the open position ---------------------------------------------------------------------------
    def _state(self, product, book):
        position = book.position
        if position is None or "entry_ms" not in position:
            return None
        key = book.intent["intent_id"]
        state = self.state.get(product)
        if state is None or state["intent_id"] != key:
            entry_ms = int(position["entry_ms"])
            state = {"intent_id": key, "entry_ms": entry_ms, "opened_at_ms": int(position["opened_at"]),
                     "entry_bucket_ms": int(position["opened_bucket"]), "quotes": 0, "last_ms": entry_ms,
                     "max_gap_ms": 0, "window_quotes": 0, "window_last_ms": entry_ms, "window_max_gap_ms": 0,
                     "finalized": False}
            self.state[product] = state
            self.entry_minute[product] = state["entry_bucket_ms"]
        return state

    def _window(self, state, candle=None, stop=None, long=True):
        """The entry-window report: how much of [entry, opened_at) the quotes covered."""
        window = max(0, state["opened_at_ms"] - state["entry_ms"])
        tail = max(0, state["opened_at_ms"] - state["window_last_ms"]) if window else 0
        max_gap = max(state["window_max_gap_ms"], tail)
        if window == 0:
            coverage = "not_needed"
        elif state["window_quotes"] == 0:
            coverage = "unwatched"
        elif max_gap <= self.policy.max_watch_gap_ms:
            coverage = "watched"
        else:
            coverage = "partially_watched"
        touched = None
        if candle is not None and stop is not None:
            touched = (D(str(candle["low"])) <= stop) if long else (D(str(candle["high"])) >= stop)
        unresolved = bool(touched) and coverage in ("unwatched", "partially_watched")
        return {"entry_ms": state["entry_ms"], "opened_at_ms": state["opened_at_ms"], "window_ms": window,
                "quotes_watched": state["window_quotes"], "max_gap_ms": max_gap, "coverage": coverage,
                "candle_range_touched_stop": touched, "unresolved": unresolved}

    def _note(self, state, report):
        self.portfolio.position_notes.setdefault(state["intent_id"], {})["entry_window"] = report
        state["finalized"] = True

    # ---- quotes -----------------------------------------------------------------------------------------------
    def on_quote(self, quote):
        """Delivers one quote ``{product_id, time_ms, received_ms?, bid, ask}``. Returns the trades it closed."""
        try:
            q = parse_quote(quote)
        except ValueError:
            self._log("quote_ignored", reason="invalid_quote", quote_hash=stable_hash(quote))
            return []
        product = q["product_id"]
        last = self.last_quote_ms.get(product)
        if last is not None and q["time_ms"] <= last:
            self._log("quote_ignored", reason="duplicate_or_out_of_order_quote", product_id=product, time_ms=q["time_ms"])
            return []
        self.last_quote_ms[product] = q["time_ms"]
        if q["time_ms"] < self.covered_until.get(product, 0):
            self._log("quote_ignored", reason="covered_by_candle", product_id=product, time_ms=q["time_ms"])
            return []
        book = self.portfolio.positions.get(product)
        state = self._state(product, book) if book is not None else None
        if state is None:
            return []
        if q["time_ms"] <= state["entry_ms"]:
            self._log("quote_ignored", reason="not_after_entry", product_id=product, time_ms=q["time_ms"])
            return []
        in_window = q["time_ms"] < state["opened_at_ms"]
        state["max_gap_ms"] = max(state["max_gap_ms"], q["time_ms"] - state["last_ms"])
        state["last_ms"] = q["time_ms"]
        state["quotes"] += 1
        if in_window:
            state["window_max_gap_ms"] = max(state["window_max_gap_ms"], q["time_ms"] - state["window_last_ms"])
            state["window_last_ms"] = q["time_ms"]
            state["window_quotes"] += 1
        position = book.position
        side, long, stop = position["side"], position["side"] == "LONG", position["stop"]
        touch = q["bid"] if long else q["ask"]
        if not ((touch <= stop) if long else (touch >= stop)):
            return []
        planned = exit_fill(stop, side, product, "stop")
        modelled = exit_fill(q["mid"], side, product, "stop")
        executable = min(planned, modelled, touch) if long else max(planned, modelled, touch)
        report = self._window(state)
        report["closed_in_window"] = in_window
        self._note(state, report)
        trade = self.portfolio.close_on_quote(
            product, q["received_ms"], q["mid"], executable, "quote_breach",
            {"quote_time_ms": q["time_ms"], "quote_received_ms": q["received_ms"], "bid": str(q["bid"]),
             "ask": str(q["ask"]), "spread_bps": str(round(q["spread_bps"], 6)), "trigger": "bid<=stop" if long else "ask>=stop",
             "estimated": False})
        self._log("stop_closed_on_quote", product_id=product, trade_id=trade["trade_id"], time_ms=q["time_ms"])
        self.closed.append(trade)
        return [trade]

    # ---- candles ----------------------------------------------------------------------------------------------
    def on_candle(self, product, bucket_ms, candle):
        """The only way candles reach the portfolio when watching. Returns the trades the candle closed."""
        bucket_ms = int(bucket_ms)
        book = self.portfolio.positions.get(product)
        state = self._state(product, book) if book is not None else None
        if state is not None and bucket_ms == state["entry_bucket_ms"]:
            # The entry minute: its candle includes prices from before the entry, so it never evaluates the stop.
            if state.get("entry_candle_done"):
                self._log("duplicate_entry_minute_candle_ignored", product_id=product, bucket_ms=bucket_ms)
                return []
            state["entry_candle_done"] = True
            position = book.position
            report = self._window(state, candle, position["stop"], position["side"] == "LONG")
            self._note(state, report)
            self.covered_until[product] = max(self.covered_until.get(product, 0), bucket_ms + ONE_MINUTE_MS)
            if report["unresolved"]:
                self.portfolio.position_notes[state["intent_id"]]["entry_minute_unresolved"] = True
                self._log("entry_minute_unresolved", product_id=product, intent_id=state["intent_id"],
                          policy=self.policy.unresolved_entry_minute)
                if self.policy.unresolved_entry_minute == "stop":
                    side, stop = position["side"], position["stop"]
                    executable = exit_fill(stop, side, product, "stop")
                    trade = self.portfolio.close_on_quote(
                        product, state["opened_at_ms"], stop, executable, "assumed_stop_entry_minute",
                        {"estimated": True, "assumption": "the range of the entry minute touched the stop and no quote "
                                                          "covered the window: closed at the stop"})
                    self.closed.append(trade)
                    return [trade]
            return []
        if book is None and self.entry_minute.get(product) == bucket_ms:
            # The position of this minute was already closed by a quote: the candle must not close it again.
            self.covered_until[product] = max(self.covered_until.get(product, 0), bucket_ms + ONE_MINUTE_MS)
            self._log("entry_minute_candle_after_close", product_id=product, bucket_ms=bucket_ms)
            return []
        if state is not None and not state["finalized"]:
            self._note(state, self._window(state))
        self.covered_until[product] = max(self.covered_until.get(product, 0), bucket_ms + ONE_MINUTE_MS)
        return self.portfolio.on_candle(product, bucket_ms, candle)

    def events_hash(self):
        return stable_hash({"events": self.events, "closed": [t["trade_id"] for t in self.closed]})
