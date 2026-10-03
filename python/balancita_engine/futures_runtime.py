"""Offline, deterministic C27 perpetual-paper runtime.

The runtime consumes only versioned mock/recorded evidence already available at
the decision cutoff. It never connects to a provider or submits a real order.
"""

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR, localcontext

from .canonical import normalize_decimal, normalize_timestamp_ms
from .futures_indicators import calculate_features
from .futures_ledger import FuturesLedger
from .futures_funding import normalize_observation
from .futures_execution import PaperExecutionAdapter
from .futures_strategies import (
    C25_ID,
    C26_ID,
    C27_ID,
    C28_ID,
    STRATEGY_IDS,
    propose as propose_strategy,
    select_proposal,
    update_regime,
)


RUNTIME_VERSION = "c27-breakout-perp-v1"
CHECKPOINT_VERSION = 1
STRATEGY_CHECKPOINT_VERSION = 2
EXECUTION_RUNTIME_VERSION = "futures-runtime-execution.v1"
EXECUTION_CHECKPOINT_VERSION = 3
RISK_RUNTIME_VERSION = "futures-runtime-risk.v1"
RISK_CHECKPOINT_VERSION = 4
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
        self.runtime_version = (
            "futures-strategy-baseline-perp-v1"
            if self.config.get("version") == "futures-runtime-strategies.v1"
            else EXECUTION_RUNTIME_VERSION
            if self.config.get("version") == EXECUTION_RUNTIME_VERSION
            else RISK_RUNTIME_VERSION
            if self.config.get("version") == RISK_RUNTIME_VERSION
            else RUNTIME_VERSION
        )
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
        self.regime = "unknown"
        self.execution_adapter = None
        self.execution_metadata = {}
        self.risk_state = {
            "utc_day": None,
            "opening_equity_usd": None,
            "daily_loss_latched": False,
            "entry_paused": False,
            "user_paused": False,
            "system_paused": False,
            "mark_quality": "unknown",
            "reduction_intent_id": None,
        }
        if self.runtime_version in (EXECUTION_RUNTIME_VERSION, RISK_RUNTIME_VERSION):
            if self.instrument is None:
                raise ValueError("execution runtime requires instrument metadata")
            self.execution_adapter = PaperExecutionAdapter(
                {
                    "run_id": self.run_id,
                    "instrument_id": self.instrument.get("instrument_id"),
                },
                {
                    "latency_ms": self.config["execution_latency_ms"],
                    "tick_size": self.instrument["price_tick_usd"],
                    "lot_size": self.instrument["quantity_step_btc"],
                    "max_book_age_ms": self.config["max_book_age_ms"],
                },
            )
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
            self.config["version"] not in ("futures-runtime-lab.v1", "futures-runtime-strategies.v1", EXECUTION_RUNTIME_VERSION, RISK_RUNTIME_VERSION)
            or
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
            or (self.config["version"] == RISK_RUNTIME_VERSION and self.config.get("daily_loss_fraction") != "0.01")
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
        if self.ledger.position is not None:
            self._observe_funding(evidence, now, cutoff)
            self._accrue_until(now)
        fills = []
        orders = []
        risk_reasons = []
        if self.runtime_version == RISK_RUNTIME_VERSION:
            risk_reasons = self._update_risk_day(now, mark, book, ticker, control)
        closed_this_cycle = False
        if self.execution_adapter is not None:
            adapter_events = self._advance_execution(evidence, cutoff)
            for event in adapter_events:
                if event.get("type") not in (
                    "order_created", "order_accepted", "order_filled",
                    "cancelled", "rejected", "expired",
                ):
                    continue
                intent = self.execution_adapter.orders[event["order_id"]]["intent"]
                order_event = deepcopy(event)
                order_event.update({
                    "order_type": intent["order_type"],
                    "side": intent["side"],
                    "quantity_btc": intent["quantity_btc"],
                    "decision_at_ms": intent["decision_at_ms"],
                })
                orders.append(order_event)
            close_fill_seen = any(
                event.get("type") == "fill"
                and self.execution_metadata.get(event.get("order_id"), {}).get("purpose") == "close"
                for event in adapter_events
            )
            fills.extend(self._apply_execution_fills(adapter_events))
            closed_this_cycle = close_fill_seen and self.ledger.position is None
        if (
            self.runtime_version == RISK_RUNTIME_VERSION
            and self.risk_state["daily_loss_latched"]
        ):
            self._cancel_pending_entries(now, orders)
        features = self._features(evidence, now)
        strategy_context = None
        if self.config["version"] in ("futures-runtime-strategies.v1", RISK_RUNTIME_VERSION):
            strategy_context = self._strategy_context(evidence, now, cutoff, features)
        guard = self._market_guard(market, book, ticker, now, cutoff)
        if closed_this_cycle:
            guard = "position_closed_this_cycle"
        if self.execution_adapter is not None and self._has_pending_entry():
            guard = "incompatible_order_pending"
        self._risk_close_estimate = (
            self._estimate_close_net(book)
            if self.runtime_version == RISK_RUNTIME_VERSION and guard is None
            else None
        )

        if self.ledger.position is not None:
            if guard is None or self.runtime_version == RISK_RUNTIME_VERSION:
                protection_mark = (
                    mark
                    if self.runtime_version != RISK_RUNTIME_VERSION
                    or self._valid_risk_mark(ticker, now)
                    else None
                )
                should_close, close_reason = self._should_close(
                    control, features, protection_mark, now
                )
                if (
                    not should_close
                    and strategy_context is not None
                    and strategy_context["selector"].get("action") == "FLAT"
                ):
                    should_close = True
                    close_reason = strategy_context["selector"].get(
                        "reason_code", "owner_exit_condition_met"
                    )
            else:
                should_close, close_reason = False, guard
            if should_close and (guard is None or self.runtime_version == RISK_RUNTIME_VERSION):
                if self.execution_adapter is not None:
                    order = self._submit_execution_close(now, close_reason)
                    if order is not None:
                        orders.append(order)
                        if self.runtime_version == RISK_RUNTIME_VERSION:
                            self.risk_state["reduction_intent_id"] = order.get("order_id")
                else:
                    closed, order = self._close_position(book, now, close_reason)
                    fills.extend(closed)
                    if order is not None:
                        orders.append(order)
            elif (
                self.execution_adapter is not None
                and isinstance(control, dict)
                and control.get("type") == "paper.close"
                and self.ledger.position is not None
            ):
                order = self._submit_execution_close(now, close_reason)
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
            if strategy_context is not None:
                analysis.update(strategy_context)
            risk = {"status": "not_applicable", "reason_codes": []}
            if self.runtime_version == RISK_RUNTIME_VERSION:
                risk.update(self._risk_result(risk_reasons, guard))
        elif guard is not None:
            analysis = self._analysis("WAIT", guard, features)
            if strategy_context is not None:
                analysis.update(strategy_context)
            risk = {"status": "not_evaluated", "reason_codes": [guard]}
            if self.runtime_version == RISK_RUNTIME_VERSION:
                risk.update(self._risk_result(risk_reasons, guard))
        elif self.runtime_version == RISK_RUNTIME_VERSION and (
            self.risk_state["entry_paused"] or self.risk_state["user_paused"] or self.risk_state["system_paused"]
        ):
            reason = risk_reasons[0] if risk_reasons else (
                "daily_loss_limit" if self.risk_state["daily_loss_latched"] else "entries_paused"
            )
            analysis = self._analysis("WAIT", reason, features)
            if strategy_context is not None:
                analysis.update(strategy_context)
            risk = {"status": "rejected", "reason_codes": [reason]}
            risk.update(self._risk_result(risk_reasons, guard))
        elif not features.get("ready"):
            reason = (features.get("reason_codes") or ["features_unavailable"])[0]
            analysis = self._analysis("WAIT", reason, features)
            if strategy_context is not None:
                analysis.update(strategy_context)
            risk = {"status": "not_evaluated", "reason_codes": [reason]}
        else:
            selected = strategy_context["selector"] if strategy_context is not None else None
            if strategy_context is not None:
                proposal = None
                if selected.get("action") in ("LONG", "SHORT"):
                    proposal = (
                        selected["action"].lower(),
                        selected.get("signal_key"),
                    )
            else:
                proposal = self._proposal(features)
            if proposal is None:
                reason = selected.get("reason_code", "no_c27_breakout") if strategy_context is not None else "no_c27_breakout"
                analysis = self._analysis("WAIT", reason, features)
                risk = {"status": "not_evaluated", "reason_codes": [reason]}
                if strategy_context is not None:
                    analysis.update(strategy_context)
            else:
                side, signal_key = proposal
                strategy_id = selected["strategy_id"] if strategy_context is not None else RUNTIME_VERSION
                if signal_key in self.signal_keys:
                    analysis = self._analysis("WAIT", "signal_already_evaluated", features)
                    risk = {"status": "not_evaluated", "reason_codes": ["signal_already_evaluated"]}
                    if strategy_context is not None:
                        analysis.update(strategy_context)
                else:
                    self.signal_keys.add(signal_key)
                    levels = book.get("asks" if side == "long" else "bids", [])
                    best_price = self._best_price(levels)
                    if best_price is None:
                        analysis = self._analysis("WAIT", "missing_executable_depth", features)
                        risk = {"status": "rejected", "reason_codes": ["missing_executable_depth"]}
                    else:
                        plan = self._risk_plan(
                            side,
                            best_price,
                            features,
                            selected if strategy_context is not None else None,
                        )
                        if plan["quantity"] <= 0:
                            analysis = self._analysis("WAIT", plan["reason"], features)
                            risk = {"status": "rejected", "reason_codes": [plan["reason"]]}
                        else:
                            reason = selected["reason_code"] if strategy_context is not None else "c27_volume_breakout"
                            analysis = self._analysis(side, reason, features, strategy_id)
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
                            if self.execution_adapter is not None:
                                receipt = self.execution_adapter.submit({
                                    "run_id": self.run_id,
                                    "instrument_id": self.instrument["instrument_id"],
                                    "order_id": order_id,
                                    "side": "buy" if side == "long" else "sell",
                                    "order_type": "market_ioc",
                                    "quantity_btc": _text(plan["quantity"]),
                                    "decision_at_ms": now,
                                })
                                order = receipt
                                self.execution_metadata[order_id] = {
                                    "purpose": "entry",
                                    "side": side,
                                    "strategy_id": strategy_id,
                                    "signal_key": signal_key,
                                    "stop": _text(plan["stop"]),
                                    "target": _text(plan["target"]),
                                    "donchian_mid": _text(plan["donchian_mid"]),
                                    "selected": deepcopy(selected),
                                }
                                entry_fills = []
                            else:
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
                                if strategy_context is not None:
                                    self.position_protection["strategy_target"] = selected.get("proposed_target")
                                    self.position_protection["strategy_invalidation"] = selected.get("invalidation")
                                self.funding_cursor_ms = now
                                self._observe_funding(evidence, now, cutoff)
                            elif self.execution_adapter is None:
                                analysis = self._analysis("WAIT", "ioc_unfilled", features)
                            if strategy_context is not None:
                                analysis.update(strategy_context)

        if strategy_context is not None:
            analysis.update(strategy_context)
        position = self._position(mark)
        account = None if mark is None else self.ledger.snapshot(_text(mark))
        if self.runtime_version == RISK_RUNTIME_VERSION:
            risk.update(self._risk_result(risk_reasons, guard))
        return {
            "schema_version": "futures-runtime-result.v1",
            "run_id": self.run_id,
            "runtime_version": self.runtime_version,
            "analysis": analysis,
            "risk": risk,
            "orders": orders,
            "fills": fills,
            "position": position,
            "ledger": account,
            "valuation_source": "ticker_mark" if isinstance(ticker, dict) and ticker.get("mark_usd") is not None else "observed_book_midpoint",
            **({"execution_events": self.execution_adapter.events} if self.execution_adapter is not None else {}),
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
            "schema_version": self._checkpoint_version,
            "runtime_version": self.runtime_version,
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
            **({"regime": self.regime} if self.runtime_version != RUNTIME_VERSION else {}),
            **({"execution_checkpoint": self.execution_adapter.checkpoint()} if self.execution_adapter is not None else {}),
            **({"execution_metadata": deepcopy(self.execution_metadata)} if self.execution_adapter is not None else {}),
            **({"risk_checkpoint": deepcopy(self.risk_state)} if self.runtime_version == RISK_RUNTIME_VERSION else {}),
        }

    @property
    def _checkpoint_version(self):
        if self.runtime_version == RISK_RUNTIME_VERSION:
            return RISK_CHECKPOINT_VERSION
        if self.runtime_version == EXECUTION_RUNTIME_VERSION:
            return EXECUTION_CHECKPOINT_VERSION
        return STRATEGY_CHECKPOINT_VERSION if self.runtime_version != RUNTIME_VERSION else CHECKPOINT_VERSION

    def _restore(self, checkpoint):
        if (
            not isinstance(checkpoint, dict)
            or checkpoint.get("schema_version") != self._checkpoint_version
            or checkpoint.get("runtime_version") != self.runtime_version
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
        if self.execution_adapter is not None:
            execution_checkpoint = checkpoint.get("execution_checkpoint")
            restored_execution = PaperExecutionAdapter.restore(execution_checkpoint)
            if (
                restored_execution.run_id != self.run_id
                or restored_execution.instrument_id != self.instrument.get("instrument_id")
                or restored_execution.config["latency_ms"] != self.config["execution_latency_ms"]
                or restored_execution.config["tick_size"] != self.instrument["price_tick_usd"]
                or restored_execution.config["lot_size"] != self.instrument["quantity_step_btc"]
            ):
                raise ValueError("execution checkpoint binding does not match runtime")
            self.execution_adapter = restored_execution
            metadata = checkpoint.get("execution_metadata")
            if not isinstance(metadata, dict) or any(not isinstance(key, str) or not isinstance(value, dict) for key, value in metadata.items()):
                raise ValueError("execution checkpoint metadata is invalid")
            self.execution_metadata = deepcopy(metadata)
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
        self.regime = checkpoint.get("regime", "unknown")
        if self.regime not in ("unknown", "trend", "range"):
            raise ValueError("checkpoint regime is invalid")
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
        if self.runtime_version == RISK_RUNTIME_VERSION:
            state = checkpoint.get("risk_checkpoint")
            expected = {
                "utc_day", "opening_equity_usd", "daily_loss_latched", "entry_paused",
                "user_paused", "system_paused", "mark_quality", "reduction_intent_id",
            }
            if not isinstance(state, dict) or set(state) != expected:
                raise ValueError("risk checkpoint schema is invalid")
            if any(not isinstance(state[key], bool) for key in (
                "daily_loss_latched", "entry_paused", "user_paused", "system_paused"
            )):
                raise ValueError("risk checkpoint flags must be boolean")
            if state["opening_equity_usd"] is not None:
                _d(state["opening_equity_usd"], "risk opening equity")
            if state["mark_quality"] not in ("unknown", "valid", "stale", "gapped"):
                raise ValueError("risk checkpoint mark quality is invalid")
            self.risk_state = deepcopy(state)
        if (ledger.position is None) != (self.owner_strategy_id is None):
            raise ValueError("checkpoint position ownership is inconsistent")
        if self.execution_adapter is not None:
            expected_side = None if ledger.position is None else ledger.position["side"]
            expected_qty = ZERO if ledger.position is None else ledger.position["qty"]
            adapter_position = self.execution_adapter.position
            if adapter_position["side"] != expected_side or _d(adapter_position["quantity_btc"], "execution position") != expected_qty:
                raise ValueError("execution checkpoint position disagrees with ledger")

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

    def _strategy_context(self, events, now, cutoff, features):
        bars_by_interval = {}
        for interval in (FEATURE_INTERVAL_MS, 300_000):
            bars = sorted(
                [event for event in events if event.get("type") == "candle" and event.get("interval_ms") == interval],
                key=lambda event: (event.get("bucket_start_ms", -1), event.get("reception_order", -1)),
            )
            bars_by_interval[interval] = bars
        five = calculate_features(
            bars_by_interval[300_000], interval_ms=300_000, decision_time_ms=now
        )
        self.regime = update_regime(
            self.regime, five.get("ema9"), five.get("ema21"), five.get("atr14")
        )
        one_bars = bars_by_interval[FEATURE_INTERVAL_MS]
        previous = calculate_features(
            one_bars,
            interval_ms=FEATURE_INTERVAL_MS,
            decision_time_ms=now,
            candidate_index=len(one_bars) - 2,
        ) if len(one_bars) > 1 else None
        previous_features = None if previous is None else {
            **previous,
            "candidate_bucket_start_ms": one_bars[-2].get("bucket_start_ms"),
            "candidate_low": one_bars[-2].get("low"),
            "candidate_high": one_bars[-2].get("high"),
        }
        if one_bars:
            features["candidate_low"] = one_bars[-1].get("low")
            features["candidate_high"] = one_bars[-1].get("high")
        age_ms = None
        if one_bars:
            age_ms = max(0, cutoff - one_bars[-1].get("received_at_ms", cutoff))
        trend = five
        proposals = [
            propose_strategy(
                strategy_id,
                features,
                previous=previous_features,
                trend=trend,
                regime=self.regime,
                age_ms=age_ms,
                tick_size=self.instrument["price_tick_usd"],
                cost_config=self.config,
                position_side=None if self.ledger.position is None else self.ledger.position["side"].upper(),
                frozen_target=None if self.position_protection is None else self.position_protection.get("strategy_target"),
                frozen_invalidation=None if self.position_protection is None else self.position_protection.get("donchian_mid"),
                delegated_strategy_id=(self.owner_strategy_id if strategy_id == C28_ID and self.owner_strategy_id in (C25_ID, C26_ID) else None),
            )
            for strategy_id in STRATEGY_IDS
        ]
        selector = select_proposal(
            proposals,
            owner_strategy_id=self.owner_strategy_id,
            consumed_signal_keys=self.signal_keys,
        )
        return {"proposals": proposals, "selector": selector, "regime": self.regime}

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
        if (
            self.execution_adapter is None
            and book["event_time_ms"] < now + self.config["execution_latency_ms"]
        ):
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

    def _execution_book(self, event, cutoff):
        if not isinstance(event, dict):
            return {"invalid": True}
        return {
            "provider": "kraken-futures",
            "product_id": "PF_XBTUSD",
            "epoch": str(event.get("epoch", "unknown")),
            "snapshot_id": str(event.get("snapshot_id", "{}:{}".format(event.get("epoch"), event.get("sequence")))),
            "revision": str(event.get("revision", event.get("sequence", "unknown"))),
            "event_time_ms": event.get("event_time_ms"),
            "known_at_ms": event.get("known_at_ms", event.get("received_at_ms")),
            "valid": event.get("valid") is True and event.get("contiguous") is True,
            "gap": event.get("contiguous") is False,
            "crossed": event.get("crossed", False),
            "mark_price_usd": self._ticker_mark_for(event, cutoff),
            "bids": [[level.get("price_usd"), level.get("quantity_btc")] for level in event.get("bids", []) if isinstance(level, dict)],
            "asks": [[level.get("price_usd"), level.get("quantity_btc")] for level in event.get("asks", []) if isinstance(level, dict)],
        }

    @staticmethod
    def _ticker_mark_for(book, cutoff):
        # Runtime book snapshots are the only execution input here; a mark must
        # be carried on that same observation rather than borrowed from a later ticker.
        return book.get("mark_price_usd")

    def _advance_execution(self, evidence, cutoff):
        book_event = self._select(evidence, "book_snapshot")
        book = self._execution_book(book_event, cutoff)
        ticker = self._select(evidence, "ticker")
        if isinstance(ticker, dict) and isinstance(book, dict):
            book["mark_price_usd"] = ticker.get("mark_usd")
        trades = []
        for event in evidence:
            if event.get("type") != "trade":
                continue
            trades.append({
                "provider": "kraken-futures",
                "product_id": "PF_XBTUSD",
                "epoch": str(event.get("epoch", "unknown")),
                "uid": event.get("uid"),
                "event_time_ms": event.get("event_time_ms"),
                "known_at_ms": event.get("known_at_ms"),
                "price_usd": event.get("price_usd"),
                "quantity_btc": event.get("quantity_btc"),
                "aggressor_side": event.get("aggressor_side"),
            })
        self.execution_adapter.set_position({
            "side": None if self.ledger.position is None else self.ledger.position["side"],
            "quantity_btc": "0" if self.ledger.position is None else _text(self.ledger.position["qty"]),
        })
        return self.execution_adapter.advance(cutoff, book, trades)

    def _apply_execution_fills(self, events):
        fills = [event for event in events if event.get("type") == "fill"]
        by_order = {}
        for fill in fills:
            by_order.setdefault(fill["order_id"], []).append(fill)
        output = []
        for order_id, order_fills in by_order.items():
            metadata = self.execution_metadata.get(order_id)
            if not isinstance(metadata, dict):
                raise ValueError("execution fill has no immutable runtime intent")
            side = metadata["side"]
            if metadata["purpose"] == "entry":
                quantity = sum((_d(item["quantity_btc"], "fill quantity") for item in order_fills), ZERO)
                notional = sum((_d(item["quantity_btc"], "fill quantity") * _d(item["price_usd"], "fill price") for item in order_fills), ZERO)
                average = notional / quantity
                with localcontext() as context:
                    context.prec = self.ledger.precision
                    self.ledger.open(side, _text(quantity), _text(average), order_fills[0]["liquidity"], at_ms=order_fills[0]["event_time_ms"])
                self.owner_strategy_id = metadata["strategy_id"]
                self.position_protection = {
                    "stop": metadata["stop"], "target": metadata["target"],
                    "donchian_mid": metadata["donchian_mid"],
                    "opened_at_ms": order_fills[0]["event_time_ms"],
                    "signal_key": metadata["signal_key"],
                }
                selected = metadata.get("selected")
                if isinstance(selected, dict):
                    self.position_protection["strategy_target"] = selected.get("proposed_target")
                    self.position_protection["strategy_invalidation"] = selected.get("invalidation")
                self.funding_cursor_ms = order_fills[0]["event_time_ms"]
            else:
                for item in order_fills:
                    self._accrue_until(item["event_time_ms"])
                    self.ledger.close(item["quantity_btc"], item["price_usd"], item["liquidity"], at_ms=item["event_time_ms"])
                if self.ledger.position is None:
                    self.owner_strategy_id = None
                    self.position_protection = None
                    self.funding_cursor_ms = None
                    if self.runtime_version == RISK_RUNTIME_VERSION:
                        self.risk_state["reduction_intent_id"] = None
            for item in order_fills:
                output.append({
                    "fill_id": item["fill_id"], "order_id": order_id,
                    "side": side,
                    "action": ("sell" if side == "long" else "buy") if metadata["purpose"] == "close" else ("buy" if side == "long" else "sell"),
                    "quantity_btc": item["quantity_btc"],
                    "price_usd_per_btc": item["price_usd"],
                    "fee_usd": item["fee_usd"], "liquidity": item["liquidity"],
                    "event_time_ms": item["event_time_ms"],
                })
        if self.execution_adapter is not None:
            self.execution_adapter.set_position({
                "side": None if self.ledger.position is None else self.ledger.position["side"],
                "quantity_btc": "0" if self.ledger.position is None else _text(self.ledger.position["qty"]),
            })
        return output

    def _has_pending_entry(self):
        if self.execution_adapter is None:
            return False
        return any(
            self.execution_metadata.get(order_id, {}).get("purpose") == "entry"
            and order["state"] in ("accepted", "partially_filled")
            for order_id, order in self.execution_adapter.orders.items()
        )

    def _has_pending_exit(self):
        if self.execution_adapter is None:
            return False
        return any(
            self.execution_metadata.get(order_id, {}).get("purpose") == "close"
            and order["state"] in ("accepted", "partially_filled")
            for order_id, order in self.execution_adapter.orders.items()
        )

    def _submit_execution_close(self, now, reason):
        if self._has_pending_exit() or self.ledger.position is None:
            return None
        pos = self.ledger.position
        side = pos["side"]
        command = "close"
        order_id = "{}:{}:{}".format(self.run_id, command, now)
        self.execution_adapter.set_position({"side": side, "quantity_btc": _text(pos["qty"])})
        receipt = self.execution_adapter.submit({
            "run_id": self.run_id,
            "instrument_id": self.instrument["instrument_id"],
            "order_id": order_id,
            "side": "sell" if side == "long" else "buy",
            "order_type": "reduce_only",
            "quantity_btc": _text(pos["qty"]),
            "decision_at_ms": now,
        })
        self.execution_metadata[order_id] = {
            "purpose": "close", "side": side, "reason": reason,
        }
        return receipt

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

    def _risk_plan(self, side, entry, features, proposal=None):
        with localcontext() as ctx:
            ctx.prec = self.ledger.precision
            atr = _d(features["atr14"], "ATR14")
            tick = _d(self.instrument["price_tick_usd"], "price tick")
            step = _d(self.instrument["quantity_step_btc"], "quantity step")
            minimum = _d(self.instrument["minimum_quantity_btc"], "minimum quantity")
            if proposal is None:
                stop_distance = atr * Decimal("1.5")
                target_distance = stop_distance * Decimal(2)
                if side == "long":
                    stop = _floor_tick(entry - stop_distance, tick)
                    target = _ceil_tick(entry + target_distance, tick)
                else:
                    stop = _ceil_tick(entry + stop_distance, tick)
                    target = _floor_tick(entry - target_distance, tick)
            else:
                try:
                    stop = _d(proposal["proposed_stop"], "proposed strategy stop")
                    target = _d(proposal["proposed_target"], "proposed strategy target")
                except (KeyError, ValueError):
                    return {"quantity": ZERO, "reason": "strategy_protective_levels_unavailable"}
                stop_distance = abs(entry - stop)
                target_distance = abs(target - entry)
            if stop <= 0 or (side == "long" and stop >= entry) or (side == "short" and stop <= entry):
                return {"quantity": ZERO, "reason": "invalid_tick_adjusted_stop"}
            if (side == "long" and target <= entry) or (side == "short" and target >= entry):
                return {"quantity": ZERO, "reason": "strategy_target_on_wrong_side"}
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
            if event.get("type") == "funding_observation":
                try:
                    observation = normalize_observation(
                        event["observation"], cutoff
                    )
                    if observation["status"] != "known":
                        self.ledger.funding_complete = False
                        continue
                    cursor = self.ledger.position["funding_cursor_ms"]
                    if (
                        observation["effective_start_ms"] < cursor
                        and observation["known_at_ms"] > cursor
                    ):
                        # A rate learned after the position boundary cannot repair
                        # an interval that was unknown at that decision/fill time.
                        self.ledger.funding_complete = False
                        continue
                    same_interval = [
                        rate
                        for _, start, end, rate in self.ledger.funding_rates
                        if start == observation["effective_start_ms"]
                        and end == observation["effective_end_ms"]
                    ]
                    if same_interval:
                        if any(
                            rate != _d(
                                observation["rate_usd_per_btc_hour"],
                                "normalized funding rate",
                            )
                            for rate in same_interval
                        ):
                            self.ledger.funding_complete = False
                        continue
                    self.ledger.observe_funding(
                        observation["observation_id"] + ":" + observation["sha256"],
                        observation["effective_start_ms"],
                        observation["effective_end_ms"],
                        observation["rate_usd_per_btc_hour"],
                        known_at_ms=observation["known_at_ms"],
                    )
                except (KeyError, TypeError, ValueError):
                    self.ledger.funding_complete = False
                continue
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
        if self.runtime_version == RISK_RUNTIME_VERSION and self.risk_state["daily_loss_latched"]:
            return True, "daily_loss_limit"
        stop = _d(self.position_protection["stop"], "protective stop")
        target = _d(self.position_protection["target"], "target")
        midline = _d(self.position_protection["donchian_mid"], "Donchian midline")
        opened = self.position_protection["opened_at_ms"]
        invalidation = self.position_protection.get("strategy_invalidation")
        c25_owner = self.owner_strategy_id == C25_ID or invalidation in (
            "close_below_ema21", "close_above_ema21"
        )
        c26_owner = self.owner_strategy_id == C26_ID or invalidation == "regime_invalid"
        c27_owner = self.owner_strategy_id == C27_ID or (
            isinstance(invalidation, str)
            and invalidation.startswith("opposite_donchian_mid_cross@")
        )
        if mark is not None:
            if pos["side"] == "long":
                if mark <= stop:
                    return True, "protective_stop"
                if mark >= target:
                    return True, "profit_target"
            else:
                if mark >= stop:
                    return True, "protective_stop"
                if mark <= target:
                    return True, "profit_target"
        candidate = features.get("candidate_close")
        if candidate is not None:
            candidate = _d(candidate, "candidate close")
            ema21 = features.get("ema21")
            frozen_target = self.position_protection.get("strategy_target")
            if pos["side"] == "long":
                if (
                    c25_owner
                    and ema21 is not None
                    and candidate < _d(ema21, "EMA21")
                ):
                    return True, "owner_invalidation"
                if c26_owner and (
                    self.regime != "range"
                    or (
                        frozen_target is not None
                        and candidate >= _d(frozen_target, "frozen middle target")
                    )
                ):
                    return True, "owner_invalidation"
                if (
                    (self.runtime_version == RUNTIME_VERSION or c27_owner)
                    and candidate < midline
                ):
                    return True, "donchian_midline_cross"
            else:
                if (
                    c25_owner
                    and ema21 is not None
                    and candidate > _d(ema21, "EMA21")
                ):
                    return True, "owner_invalidation"
                if c26_owner and (
                    self.regime != "range"
                    or (
                        frozen_target is not None
                        and candidate <= _d(frozen_target, "frozen middle target")
                    )
                ):
                    return True, "owner_invalidation"
                if (
                    (self.runtime_version == RUNTIME_VERSION or c27_owner)
                    and candidate > midline
                ):
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
            "strategy_id": self.runtime_version,
            "selected_strategy_id": selected,
            "action": action,
            "reason_codes": [reason],
            "features": deepcopy(features),
            "strategy_status": "ready" if features.get("ready") else "warming_up",
        }
        return result

    def _risk_result(self, reasons, guard):
        result = {
            "daily_loss_latched": self.risk_state["daily_loss_latched"],
            "entry_paused": self.risk_state["entry_paused"],
            "user_paused": self.risk_state["user_paused"],
            "system_paused": self.risk_state["system_paused"],
            "utc_day": self.risk_state["utc_day"],
            "opening_equity_usd": self.risk_state["opening_equity_usd"],
            "mark_quality": self.risk_state["mark_quality"],
            "reduction_intent_id": self.risk_state["reduction_intent_id"],
            "estimated_close_net_usd": getattr(self, "_risk_close_estimate", None),
            "estimated_close_complete": getattr(self, "_risk_close_estimate", None) is not None,
        }
        codes = list(dict.fromkeys(reasons + ([guard] if guard else [])))
        result["reason_codes"] = codes
        return result

    def _estimate_close_net(self, book):
        position = self.ledger.position
        if (
            position is None
            or not self.ledger.funding_complete
            or not isinstance(book, dict)
        ):
            return None
        levels = book.get("bids" if position["side"] == "long" else "asks")
        if not isinstance(levels, list):
            return None
        try:
            quantity = position["qty"]
            remaining = quantity
            gross = ZERO
            exit_fee = ZERO
            snapshot = (
                "kraken-futures",
                "PF_XBTUSD",
                str(book.get("epoch", "unknown")),
                str(book.get("snapshot_id", "{}:{}".format(book.get("epoch"), book.get("sequence")))),
                str(book.get("revision", book.get("sequence", "unknown"))),
            )
            side = "bids" if position["side"] == "long" else "asks"
            budget = self.execution_adapter.book_budgets.get(snapshot)
            for level in levels:
                price = _d(level["price_usd"], "close estimate price")
                visible = _d(level["quantity_btc"], "close estimate quantity")
                if budget is not None:
                    visible = min(visible, _d(budget[side].get(_text(price), "0"), "remaining close depth"))
                take = min(remaining, visible)
                if take <= 0:
                    continue
                gross += take * (price - position["entry"]) * (1 if position["side"] == "long" else -1)
                exit_fee += take * price * _d(self.config["taker_rate"], "taker rate")
                remaining -= take
                if remaining == 0:
                    net = self.ledger.realized_gross + gross - self.ledger.fees - self.ledger.funding_paid - exit_fee
                    return _text(net)
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            return None
        return None

    def _update_risk_day(self, now, mark, book, ticker, control):
        state = self.risk_state
        reasons = []
        if isinstance(control, dict):
            if control.get("type") == "paper.pause":
                state["user_paused"] = True
            elif control.get("type") == "paper.resume":
                if not state["daily_loss_latched"]:
                    state["user_paused"] = False
        book_gap = isinstance(book, dict) and book.get("contiguous") is False
        mark_valid = mark is not None and self._valid_risk_mark(ticker, now)
        missing_mark = not isinstance(ticker, dict) or ticker.get("mark_usd") is None
        state["mark_quality"] = "gapped" if book_gap else (
            "valid" if mark_valid else "unknown" if missing_mark else "stale"
        )
        if not mark_valid and self.ledger.position is not None:
            state["entry_paused"] = True
            reasons.append("risk_mark_unavailable")
        if not self.ledger.funding_complete:
            state["entry_paused"] = True
            state["system_paused"] = True
            reasons.append("funding_incomplete")
        day = datetime.fromtimestamp(now / 1000, timezone.utc).date().isoformat()
        equity = self.ledger.cash + self.ledger.realized_gross - self.ledger.fees - self.ledger.funding_paid
        if mark_valid:
            with localcontext() as ctx:
                ctx.prec = self.ledger.precision
                if self.ledger.position is not None:
                    pos = self.ledger.position
                    equity += pos["qty"] * (mark - pos["entry"]) * (1 if pos["side"] == "long" else -1)
        if state["utc_day"] is None:
            state["utc_day"] = day
            state["opening_equity_usd"] = _text(equity)
        elif day != state["utc_day"] and (mark_valid or self.ledger.position is None):
            state["utc_day"] = day
            state["opening_equity_usd"] = _text(equity)
            state["daily_loss_latched"] = False
            state["entry_paused"] = state["user_paused"] or state["system_paused"]
            if self.ledger.position is None and not self._has_pending_exit():
                state["reduction_intent_id"] = None
        opening = _d(state["opening_equity_usd"], "daily opening equity")
        if mark_valid and opening > 0 and opening - equity >= opening * _d(self.config["daily_loss_fraction"], "daily loss fraction"):
            state["daily_loss_latched"] = True
            state["entry_paused"] = True
            reasons.append("daily_loss_limit")
        elif state["daily_loss_latched"]:
            state["entry_paused"] = True
            reasons.append("daily_loss_limit")
        elif mark_valid and self.ledger.funding_complete:
            state["entry_paused"] = state["user_paused"] or state["system_paused"]
        if state["user_paused"]:
            reasons.append("entries_paused")
        return list(dict.fromkeys(reasons))

    def _valid_risk_mark(self, ticker, now):
        if not isinstance(ticker, dict):
            return False
        event_time = ticker.get("event_time_ms")
        received = ticker.get("received_at_ms")
        known = ticker.get("known_at_ms", received)
        try:
            mark = _d(ticker.get("mark_usd"), "ticker mark")
        except ValueError:
            return False
        return (
            mark > 0
            and all(
                isinstance(value, int) and not isinstance(value, bool)
                for value in (event_time, received, known)
            )
            and 0 <= event_time <= received <= known <= now
            and now - event_time <= self.config["max_book_age_ms"]
            and now - received <= self.config["max_book_age_ms"]
        )

    def _cancel_pending_entries(self, now, orders):
        for order_id, order in self.execution_adapter.orders.items():
            if (
                self.execution_metadata.get(order_id, {}).get("purpose") == "entry"
                and order["state"] in ("accepted", "partially_filled")
            ):
                cancelled = self.execution_adapter.cancel(
                    order_id, "risk-cancel:" + order_id, now
                )
                for event in cancelled:
                    orders.append({
                        **event,
                        "order_type": order["intent"]["order_type"],
                        "side": order["intent"]["side"],
                        "quantity_btc": order["intent"]["quantity_btc"],
                        "decision_at_ms": order["intent"]["decision_at_ms"],
                    })
