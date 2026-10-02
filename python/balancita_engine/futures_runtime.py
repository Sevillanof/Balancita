"""Offline, deterministic C27 perpetual-paper runtime.

The runtime consumes only versioned mock/recorded evidence already available at
the decision cutoff. It never connects to a provider or submits a real order.
"""

from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR, localcontext

from .canonical import normalize_decimal, normalize_timestamp_ms
from .futures_indicators import calculate_features
from .futures_ledger import FuturesLedger


RUNTIME_VERSION = "c27-breakout-perp-v1"
CHECKPOINT_VERSION = 1
FEATURE_INTERVAL_MS = 60_000
ZERO = Decimal(0)
ONE = Decimal(1)


def _d(value, name):
    if not isinstance(value, str):
        raise ValueError(name + " must be a decimal string")
    try:
        result = Decimal(normalize_decimal(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(name + " must be a finite decimal string") from error
    if not result.is_finite():
        raise ValueError(name + " must be finite")
    return result


def _text(value):
    return normalize_decimal(str(value))


def _floor_step(value, step):
    if step <= 0:
        raise ValueError("instrument step must be positive")
    return (value / step).to_integral_value(rounding=ROUND_FLOOR) * step


def _floor_tick(value, tick):
    return _floor_step(value, tick)


def _ceil_tick(value, tick):
    if tick <= 0:
        raise ValueError("instrument tick must be positive")
    return (value / tick).to_integral_value(rounding=ROUND_CEILING) * tick


class FuturesRuntime:
    """Single-position Decimal strategy/risk/book simulator for C27 v1."""

    def __init__(self, *, run_id, config, instrument, checkpoint=None):
        if not isinstance(run_id, str) or not run_id or len(run_id) > 128:
            raise ValueError("run_id must be a non-empty bounded string")
        if not isinstance(config, dict):
            raise ValueError("runtime config must be a mapping")
        self.run_id = run_id
        self.config = deepcopy(config)
        self.instrument = deepcopy(instrument) if isinstance(instrument, dict) else None
        self._validate_config()
        self._ledger_config = {
            "version": "linear-usd-ledger.v1",
            "cost_version": self.config["cost_version"],
            "precision": 50,
            "maker": self.config["maker_rate"],
            "taker": self.config["taker_rate"],
        }
        self.ledger = FuturesLedger(
            self.config["initial_cash_usd"], "1", self._ledger_config
        )
        self.owner_strategy_id = None
        self.position_protection = None
        self.signal_keys = set()
        self.consumed_depth = {}
        self.funding_cursor_ms = None
        if checkpoint is not None:
            self._restore(checkpoint)

    def _validate_config(self):
        required_strings = (
            "version",
            "initial_cash_usd",
            "max_notional_usd",
            "max_exposure_multiple",
            "risk_fraction",
            "max_spread_bps",
            "cost_version",
            "maker_rate",
            "taker_rate",
        )
        if any(not isinstance(self.config.get(key), str) for key in required_strings):
            raise ValueError("runtime configuration is missing decimal/string fields")
        for key in ("max_book_age_ms", "execution_latency_ms"):
            value = self.config.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError("invalid runtime timing: " + key)
        values = {
            key: _d(self.config[key], key)
            for key in required_strings
            if key not in ("version", "cost_version")
        }
        if (
            values["initial_cash_usd"] < 0
            or values["max_notional_usd"] <= 0
            or values["max_exposure_multiple"] <= 0
            or values["max_exposure_multiple"] > ONE
            or values["risk_fraction"] <= 0
            or values["risk_fraction"] > ONE
            or values["max_spread_bps"] <= 0
            or values["maker_rate"] < 0
            or values["taker_rate"] < 0
            or self.config["cost_version"] != "kraken-futures-eea-btcusd-base.v1"
        ):
            raise ValueError("unsupported or unsafe runtime configuration")

    def process(self, market, *, control=None):
        """Evaluate one as-of snapshot and return analysis, risk, fills and ledger."""
        if not isinstance(market, dict):
            raise ValueError("market snapshot must be a mapping")
        now = normalize_timestamp_ms(market.get("decision_time_ms"))
        cutoff = normalize_timestamp_ms(market.get("cutoff_received_at_ms", now))
        if cutoff > now:
            raise ValueError("received-time cutoff cannot follow decision time")
        evidence = self._available_events(market.get("events"), now, cutoff)
        book = self._select(evidence, "book_snapshot")
        ticker = self._select(evidence, "ticker")
        mark = self._mark(ticker, book)
        fills = []
        orders = []
        features = self._features(evidence, now)
        guard = self._market_guard(market, book, ticker, now, cutoff)

        if self.ledger.position is not None:
            self._observe_funding(evidence, now, cutoff)
            if guard is None:
                should_close, close_reason = self._should_close(
                    control, features, mark, now
                )
            else:
                should_close, close_reason = False, guard
            if should_close and guard is None:
                closed, order = self._close_position(book, now, close_reason)
                fills.extend(closed)
                if order is not None:
                    orders.append(order)
            elif self.ledger.position is not None:
                self._accrue_until(now)
            analysis = self._analysis(
                "WAIT" if self.ledger.position is not None else "FLAT",
                "position_owned" if self.ledger.position is not None else close_reason,
                features,
                self.owner_strategy_id,
            )
            risk = {"status": "not_applicable", "reason_codes": []}
        elif guard is not None:
            analysis = self._analysis("WAIT", guard, features)
            risk = {"status": "not_evaluated", "reason_codes": [guard]}
        elif not features.get("ready"):
            reason = (features.get("reason_codes") or ["features_unavailable"])[0]
            analysis = self._analysis("WAIT", reason, features)
            risk = {"status": "not_evaluated", "reason_codes": [reason]}
        else:
            proposal = self._proposal(features)
            if proposal is None:
                analysis = self._analysis("WAIT", "no_c27_breakout", features)
                risk = {"status": "not_evaluated", "reason_codes": ["no_c27_breakout"]}
            else:
                side, signal_key = proposal
                strategy_id = RUNTIME_VERSION
                if signal_key in self.signal_keys:
                    analysis = self._analysis("WAIT", "signal_already_evaluated", features)
                    risk = {"status": "not_evaluated", "reason_codes": ["signal_already_evaluated"]}
                else:
                    self.signal_keys.add(signal_key)
                    levels = book.get("asks" if side == "long" else "bids", [])
                    best_price = self._best_price(levels)
                    if best_price is None:
                        analysis = self._analysis("WAIT", "missing_executable_depth", features)
                        risk = {"status": "rejected", "reason_codes": ["missing_executable_depth"]}
                    else:
                        plan = self._risk_plan(side, best_price, features)
                        if plan["quantity"] <= 0:
                            analysis = self._analysis("WAIT", plan["reason"], features)
                            risk = {"status": "rejected", "reason_codes": [plan["reason"]]}
                        else:
                            analysis = self._analysis(side, "c27_volume_breakout", features, strategy_id)
                            risk = {
                                "status": "accepted",
                                "quantity_btc": _text(plan["quantity"]),
                                "risk_budget_usd": _text(plan["risk_budget"]),
                                "estimated_round_trip_cost_usd": _text(plan["cost_per_btc"] * plan["quantity"]),
                                "stop_price_usd_per_btc": _text(plan["stop"]),
                                "target_price_usd_per_btc": _text(plan["target"]),
                                "reason_codes": [],
                            }
                            order_id = "{}:{}".format(strategy_id, signal_key)
                            entry_fills, order = self._execute(
                                book, side, plan["quantity"], now, order_id, "entry"
                            )
                            fills.extend(entry_fills)
                            if order is not None:
                                orders.append(order)
                            filled_quantity = sum(
                                (_d(fill["quantity_btc"], "fill quantity") for fill in entry_fills), ZERO
                            )
                            if filled_quantity > 0:
                                average = sum(
                                    (
                                        _d(fill["quantity_btc"], "fill quantity")
                                        * _d(fill["price_usd_per_btc"], "fill price")
                                        for fill in entry_fills
                                    ), ZERO
                                ) / filled_quantity
                                with localcontext() as ctx:
                                    ctx.prec = self.ledger.precision
                                    self.ledger.open(side, _text(filled_quantity), _text(average), "taker", at_ms=now)
                                self.owner_strategy_id = strategy_id
                                self.position_protection = {
                                    "stop": _text(plan["stop"]),
                                    "target": _text(plan["target"]),
                                    "donchian_mid": _text(plan["donchian_mid"]),
                                    "opened_at_ms": now,
                                    "signal_key": signal_key,
                                }
                                self.funding_cursor_ms = now
                                self._observe_funding(evidence, now, cutoff)
                            else:
                                analysis = self._analysis("WAIT", "ioc_unfilled", features)

        position = self._position(mark)
        account = None if mark is None else self.ledger.snapshot(_text(mark))
        return {
            "schema_version": "futures-runtime-result.v1",
            "run_id": self.run_id,
            "runtime_version": RUNTIME_VERSION,
            "analysis": analysis,
            "risk": risk,
            "orders": orders,
            "fills": fills,
            "position": position,
            "ledger": account,
            "valuation_source": "ticker_mark" if isinstance(ticker, dict) and ticker.get("mark_usd") is not None else "observed_book_midpoint",
        }

    def checkpoint(self):
        """Return a normalized, versioned checkpoint sufficient to resume open risk."""
        ledger = self.ledger
        position = None
        if ledger.position is not None:
            raw = ledger.position
            position = {
                key: _text(value) if isinstance(value, Decimal) else value
                for key, value in raw.items()
            }
        return {
            "schema_version": CHECKPOINT_VERSION,
            "runtime_version": RUNTIME_VERSION,
            "run_id": self.run_id,
            "instrument_id": None if self.instrument is None else self.instrument.get("instrument_id"),
            "runtime_config": deepcopy(self.config),
            "instrument_spec": deepcopy(self.instrument),
            "cash_usd": _text(ledger.cash),
            "leverage": _text(ledger.leverage),
            "realized_gross_usd": _text(ledger.realized_gross),
            "fees_usd": _text(ledger.fees),
            "funding_paid": _text(ledger.funding_paid),
            "funding_complete": ledger.funding_complete,
            "funding_cursor_ms": self.funding_cursor_ms,
            "ledger_last_accrual_ms": ledger.last_accrual_ms,
            "ledger_position": position,
            "funding_rates": [
                [identifier, start, end, _text(rate)]
                for identifier, start, end, rate in ledger.funding_rates
            ],
            "accrued": [
                [identifier, start, end, _text(quantity)]
                for identifier, start, end, quantity in sorted(ledger.accrued)
            ],
            "ledger_events": deepcopy(ledger.events),
            "owner_strategy_id": self.owner_strategy_id,
            "position_protection": deepcopy(self.position_protection),
            "signal_keys": sorted(self.signal_keys),
            "consumed_depth": {
                snapshot: {
                    level: _text(quantity)
                    for level, quantity in sorted(levels.items())
                }
                for snapshot, levels in sorted(self.consumed_depth.items())
            },
        }

    def _restore(self, checkpoint):
        if (
            not isinstance(checkpoint, dict)
            or checkpoint.get("schema_version") != CHECKPOINT_VERSION
            or checkpoint.get("runtime_version") != RUNTIME_VERSION
            or checkpoint.get("run_id") != self.run_id
        ):
            raise ValueError("unsupported or mismatched futures runtime checkpoint")
        if checkpoint.get("instrument_id") != (
            None if self.instrument is None else self.instrument.get("instrument_id")
        ):
            raise ValueError("checkpoint instrument does not match runtime")
        if checkpoint.get("runtime_config") != self.config:
            raise ValueError("checkpoint configuration does not match runtime")
        if checkpoint.get("instrument_spec") != self.instrument:
            raise ValueError("checkpoint instrument specification does not match runtime")
        ledger = self.ledger
        ledger.cash = _d(checkpoint["cash_usd"], "checkpoint cash")
        ledger.leverage = _d(checkpoint["leverage"], "checkpoint leverage")
        ledger.realized_gross = _d(checkpoint["realized_gross_usd"], "checkpoint realized gross")
        ledger.fees = _d(checkpoint["fees_usd"], "checkpoint fees")
        ledger.funding_paid = _d(checkpoint["funding_paid"], "checkpoint funding")
        if not isinstance(checkpoint.get("funding_complete"), bool):
            raise ValueError("checkpoint funding completeness must be explicit")
        ledger.funding_complete = checkpoint["funding_complete"]
        ledger.last_accrual_ms = checkpoint.get("ledger_last_accrual_ms")
        raw_position = checkpoint.get("ledger_position")
        if raw_position is not None:
            if not isinstance(raw_position, dict) or raw_position.get("side") not in ("long", "short"):
                raise ValueError("invalid checkpoint position")
            ledger.position = {
                key: _d(value, "checkpoint position " + key)
                if key in ("qty", "entry", "entry_fee_remaining", "funding_remaining")
                else value
                for key, value in raw_position.items()
            }
        ledger.funding_rates = [
            (str(identifier), int(start), int(end), _d(rate, "checkpoint funding rate"))
            for identifier, start, end, rate in checkpoint.get("funding_rates", [])
        ]
        ledger.accrued = {
            (str(identifier), int(start), int(end), _d(quantity, "checkpoint accrued quantity"))
            for identifier, start, end, quantity in checkpoint.get("accrued", [])
        }
        ledger.events = deepcopy(checkpoint.get("ledger_events", []))
        self.owner_strategy_id = checkpoint.get("owner_strategy_id")
        self.position_protection = deepcopy(checkpoint.get("position_protection"))
        self.signal_keys = set(checkpoint.get("signal_keys", []))
        raw_depth = checkpoint.get("consumed_depth", {})
        if not isinstance(raw_depth, dict):
            raise ValueError("checkpoint consumed depth must be a mapping")
        self.consumed_depth = {
            snapshot: {
                level: _d(quantity, "checkpoint consumed depth")
                for level, quantity in levels.items()
            }
            for snapshot, levels in raw_depth.items()
            if isinstance(snapshot, str) and isinstance(levels, dict)
        }
        self.funding_cursor_ms = checkpoint.get("funding_cursor_ms")
        if (ledger.position is None) != (self.owner_strategy_id is None):
            raise ValueError("checkpoint position ownership is inconsistent")

    def _available_events(self, events, now, cutoff):
        if not isinstance(events, list):
            raise ValueError("market events must be a list")
        available = []
        for event in events:
            if not isinstance(event, dict):
                continue
            received = event.get("received_at_ms")
            known = event.get("known_at_ms")
            if (
                isinstance(received, bool)
                or not isinstance(received, int)
                or isinstance(known, bool)
                or not isinstance(known, int)
            ):
                continue
            if received <= cutoff and known <= now:
                available.append(event)
        return available

    @staticmethod
    def _select(events, event_type):
        candidates = [event for event in events if event.get("type") == event_type]
        if not candidates:
            return None
        return max(
            candidates,
            key=lambda event: (
                event.get("received_at_ms", -1),
                event.get("reception_order", -1),
            ),
        )

    @staticmethod
    def _mark(ticker, book):
        value = ticker.get("mark_usd") if isinstance(ticker, dict) else None
        try:
            mark = _d(value, "ticker mark")
            if mark > 0:
                return mark
        except ValueError:
            pass
        if isinstance(book, dict):
            try:
                bid = _d(book["bids"][0]["price_usd"], "best bid")
                ask = _d(book["asks"][0]["price_usd"], "best ask")
                if 0 < bid < ask:
                    return (bid + ask) / Decimal(2)
            except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError):
                pass
        return None

    def _features(self, events, now):
        result = {}
        for interval in (FEATURE_INTERVAL_MS, 300_000):
            bars = [event for event in events if event.get("type") == "candle" and event.get("interval_ms") == interval]
            bars.sort(key=lambda event: (event.get("bucket_start_ms", -1), event.get("reception_order", -1)))
            features = calculate_features(
                bars,
                interval_ms=interval,
                decision_time_ms=now,
            )
            if bars:
                features["candidate_bucket_start_ms"] = bars[-1].get("bucket_start_ms")
            result[str(interval)] = features
        return result["60000"]

    def _market_guard(self, market, book, ticker, now, cutoff):
        if self.instrument is None or not self._valid_instrument(self.instrument):
            return "invalid_instrument_metadata"
        actual = market.get("instrument")
        if not isinstance(actual, dict) or not self._valid_instrument(actual):
            return "invalid_instrument_metadata"
        if actual["instrument_id"] != self.instrument["instrument_id"]:
            return "instrument_mismatch"
        if book is None or ticker is None:
            return "market_snapshot_unavailable"
        try:
            if _d(ticker.get("mark_usd"), "ticker mark") <= 0:
                return "ticker_mark_unavailable"
        except (AttributeError, ValueError):
            return "ticker_mark_unavailable"
        if book.get("valid") is not True or book.get("contiguous") is not True:
            return "invalid_or_gapped_book"
        if ticker.get("suspended") is True or ticker.get("market_status", "open") != "open":
            return "market_suspended_or_unavailable"
        for item in (book, ticker):
            event_time = item.get("event_time_ms")
            received = item.get("received_at_ms")
            if (
                not isinstance(event_time, int)
                or not isinstance(received, int)
                or event_time > now
                or now - event_time > self.config["max_book_age_ms"]
                or cutoff - received > self.config["max_book_age_ms"]
            ):
                return "stale_book_or_ticker"
        if book["event_time_ms"] < now + self.config["execution_latency_ms"]:
            return "book_precedes_execution_eligibility"
        bids = book.get("bids")
        asks = book.get("asks")
        if not isinstance(bids, list) or not isinstance(asks, list) or not bids or not asks:
            return "missing_executable_depth"
        try:
            bid = _d(bids[0]["price_usd"], "best bid")
            ask = _d(asks[0]["price_usd"], "best ask")
            if bid <= 0 or ask <= bid:
                return "invalid_or_crossed_book"
            spread_bps = (ask - bid) / ((ask + bid) / Decimal(2)) * Decimal(10_000)
            if spread_bps > _d(self.config["max_spread_bps"], "max spread"):
                return "spread_exceeds_limit"
        except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError):
            return "invalid_or_crossed_book"
        return None

    def _valid_instrument(self, instrument):
        try:
            if instrument.get("instrument_id") != "kraken-futures:PF_XBTUSD":
                return False
            if instrument.get("provider_symbol") != "PF_XBTUSD":
                return False
            for key in ("quantity_step_btc", "minimum_quantity_btc", "price_tick_usd"):
                if _d(instrument[key], key) <= 0:
                    return False
            return True
        except (KeyError, TypeError, ValueError):
            return False

    def _proposal(self, features):
        close = _d(features["candidate_close"], "candidate close")
        high = _d(features["donchian_high20"], "Donchian high")
        low = _d(features["donchian_low20"], "Donchian low")
        volume = _d(features["candidate_volume"], "candidate volume")
        mean_volume = _d(features["prior_volume_mean20"], "prior volume mean")
        threshold = mean_volume * Decimal("1.25")
        if volume <= threshold:
            return None
        candidate_ms = features.get("candidate_bucket_start_ms")
        # The caller derives the bucket identity from the last available closed bar.
        if close > high:
            return "long", "long:{}".format(candidate_ms)
        if close < low:
            return "short", "short:{}".format(candidate_ms)
        return None

    def _risk_plan(self, side, entry, features):
        with localcontext() as ctx:
            ctx.prec = self.ledger.precision
            atr = _d(features["atr14"], "ATR14")
            tick = _d(self.instrument["price_tick_usd"], "price tick")
            step = _d(self.instrument["quantity_step_btc"], "quantity step")
            minimum = _d(self.instrument["minimum_quantity_btc"], "minimum quantity")
            stop_distance = atr * Decimal("1.5")
            target_distance = stop_distance * Decimal(2)
            if side == "long":
                stop = _floor_tick(entry - stop_distance, tick)
                target = _ceil_tick(entry + target_distance, tick)
            else:
                stop = _ceil_tick(entry + stop_distance, tick)
                target = _floor_tick(entry - target_distance, tick)
            if stop <= 0 or (side == "long" and stop >= entry) or (side == "short" and stop <= entry):
                return {"quantity": ZERO, "reason": "invalid_tick_adjusted_stop"}
            taker = _d(self.config["taker_rate"], "taker rate")
            cost_per_btc = entry * (Decimal(2) * taker + Decimal("0.0002"))
            buffer_per_btc = entry * Decimal("0.0002")
            if target_distance <= cost_per_btc + buffer_per_btc:
                return {"quantity": ZERO, "reason": "target_does_not_clear_cost_buffer"}
            mark = entry
            equity = _d(self.ledger.snapshot(_text(mark))["equity_usd"], "equity")
            risk_budget = equity * _d(self.config["risk_fraction"], "risk fraction")
            risk_per_btc = abs(entry - stop) + cost_per_btc
            by_risk = risk_budget / risk_per_btc
            exposure_limit = min(
                _d(self.config["max_notional_usd"], "max notional"),
                equity * _d(self.config["max_exposure_multiple"], "max exposure"),
            )
            by_exposure = exposure_limit / entry
            quantity = _floor_step(min(by_risk, by_exposure), step)
            if quantity < minimum:
                return {"quantity": ZERO, "reason": "quantity_below_instrument_minimum"}
            midline = (_d(features["donchian_high20"], "Donchian high") + _d(features["donchian_low20"], "Donchian low")) / Decimal(2)
            return {
                "quantity": quantity,
                "reason": None,
                "stop": stop,
                "target": target,
                "risk_budget": risk_budget,
                "cost_per_btc": cost_per_btc,
                "donchian_mid": midline,
            }

    def _best_price(self, levels):
        if not isinstance(levels, list) or not levels:
            return None
        try:
            return _d(levels[0]["price_usd"], "book price")
        except (KeyError, TypeError, ValueError):
            return None

    def _depth_key(self, book):
        return "{}:{}:{}:{}".format(
            book.get("epoch"), book.get("sequence"), book.get("received_at_ms"), book.get("event_time_ms")
        )

    def _execute(self, book, position_side, quantity, now, order_id, purpose):
        if not isinstance(book, dict):
            return [], None
        action = "buy" if (position_side == "long") == (purpose == "entry") else "sell"
        key = self._depth_key(book)
        consumed = self.consumed_depth.setdefault(key, {})
        levels = book.get("asks" if action == "buy" else "bids", [])
        remaining = quantity
        fills = []
        taker = _d(self.config["taker_rate"], "taker rate")
        step = _d(self.instrument["quantity_step_btc"], "quantity step")
        tick = _d(self.instrument["price_tick_usd"], "price tick")
        for index, level in enumerate(levels):
            if remaining <= 0:
                break
            try:
                price = _d(level["price_usd"], "book level price")
                visible = _d(level["quantity_btc"], "book level quantity")
            except (KeyError, TypeError, ValueError):
                continue
            if price <= 0 or visible <= 0 or price % tick != 0:
                continue
            level_key = "{}:{}".format(action, _text(price))
            available = max(ZERO, visible - consumed.get(level_key, ZERO))
            amount = _floor_step(min(available, remaining), step)
            if amount <= 0:
                continue
            fee = amount * price * taker
            fills.append({
                "fill_id": "{}:{}".format(order_id, len(fills) + 1),
                "side": position_side,
                "action": action,
                "quantity_btc": _text(amount),
                "price_usd_per_btc": _text(price),
                "fee_usd": _text(fee),
                "liquidity": "taker",
                "event_time_ms": now,
            })
            consumed[level_key] = consumed.get(level_key, ZERO) + amount
            remaining -= amount
        filled = quantity - remaining
        if filled <= 0:
            return [], {"order_id": order_id, "status": "cancelled", "time_in_force": "IOC", "reason": "no_available_depth"}
        return fills, {
            "order_id": order_id,
            "status": "filled" if remaining == 0 else "partially_filled",
            "time_in_force": "IOC",
            "purpose": purpose,
            "requested_quantity_btc": _text(quantity),
            "filled_quantity_btc": _text(filled),
            "cancelled_quantity_btc": _text(remaining),
            "eligible_at_ms": now + self.config["execution_latency_ms"],
        }

    def _observe_funding(self, events, now, cutoff):
        for event in events:
            if event.get("type") != "funding":
                continue
            start = event.get("start_time_ms")
            end = event.get("end_time_ms")
            known = event.get("known_at_ms")
            received = event.get("received_at_ms")
            if not all(isinstance(value, int) and not isinstance(value, bool) for value in (start, end, known, received)):
                continue
            if received > cutoff or known > now or known > start:
                continue
            try:
                self.ledger.observe_funding(
                    str(event["interval_id"]), start, end,
                    event["rate_usd_per_btc_hour"], known_at_ms=known,
                )
            except (KeyError, TypeError, ValueError):
                # Malformed or conflicting funding cannot be treated as a zero rate.
                self.ledger.funding_complete = False

    def _accrue_until(self, now):
        position = self.ledger.position
        if position is None:
            return
        cursor = position["funding_cursor_ms"]
        if now > cursor:
            self.ledger.accrue_funding(cursor, now)
            self.funding_cursor_ms = now

    def _should_close(self, control, features, mark, now):
        if isinstance(control, dict) and control.get("type") == "paper.close":
            if not isinstance(control.get("command_id"), str) or not control["command_id"]:
                return False, "invalid_close_command"
            return True, "paper_close"
        if self.ledger.position is None or self.position_protection is None:
            return False, "position_state_unavailable"
        pos = self.ledger.position
        stop = _d(self.position_protection["stop"], "protective stop")
        target = _d(self.position_protection["target"], "target")
        midline = _d(self.position_protection["donchian_mid"], "Donchian midline")
        opened = self.position_protection["opened_at_ms"]
        if pos["side"] == "long":
            if mark <= stop:
                return True, "protective_stop"
            if mark >= target:
                return True, "profit_target"
            if features.get("candidate_close") is not None and _d(features["candidate_close"], "candidate close") < midline:
                return True, "donchian_midline_cross"
        else:
            if mark >= stop:
                return True, "protective_stop"
            if mark <= target:
                return True, "profit_target"
            if features.get("candidate_close") is not None and _d(features["candidate_close"], "candidate close") > midline:
                return True, "donchian_midline_cross"
        if now - opened >= 30 * 60_000:
            return True, "time_stop"
        return False, "position_owned"

    def _close_position(self, book, now, reason):
        pos = self.ledger.position
        if pos is None:
            return [], None
        self._accrue_until(now)
        side = pos["side"]
        quantity = pos["qty"]
        fills, order = self._execute(
            book, side, quantity, now,
            "{}:close:{}".format(self.run_id, now), "close",
        )
        for fill in fills:
            self.ledger.close(
                fill["quantity_btc"], fill["price_usd_per_btc"], "taker", at_ms=now
            )
        if self.ledger.position is None:
            self.owner_strategy_id = None
            self.position_protection = None
        if order is not None:
            order["reason"] = reason
        return fills, order

    def _position(self, mark):
        pos = self.ledger.position
        if pos is None:
            return {"side": None, "quantity_btc": "0", "owner_strategy_id": None}
        protection = self.position_protection or {}
        return {
            "side": pos["side"],
            "quantity_btc": _text(pos["qty"]),
            "entry_price_usd_per_btc": _text(pos["entry"]),
            "owner_strategy_id": self.owner_strategy_id,
            "stop_price_usd_per_btc": protection.get("stop"),
            "target_price_usd_per_btc": protection.get("target"),
            "mark_usd_per_btc": None if mark is None else _text(mark),
        }

    def _analysis(self, action, reason, features, selected=None):
        result = {
            "strategy_id": RUNTIME_VERSION,
            "selected_strategy_id": selected,
            "action": action,
            "reason_codes": [reason],
            "features": deepcopy(features),
            "strategy_status": "ready" if features.get("ready") else "warming_up",
        }
        return result
