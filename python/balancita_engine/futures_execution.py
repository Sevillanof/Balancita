"""Deterministic, offline-only paper execution model for linear BTC/USD."""

import json
from copy import deepcopy
from decimal import Decimal, InvalidOperation, localcontext

from .canonical import normalize_decimal, normalize_timestamp_ms
from .futures_ledger import DECIMAL_PRECISION, FEES
from .futures_operative_state import ExactIdentityPort

EXECUTION_MODEL_VERSION = "paper-execution.v1"
LEGACY_CHECKPOINT_VERSION = "paper-execution-checkpoint.v1"
CHECKPOINT_VERSION = "paper-execution-checkpoint.v2"
ZERO = Decimal("0")


def _decimal(value, name):
    if not isinstance(value, str):
        raise ValueError(name + " must be a decimal string")
    try:
        value = Decimal(normalize_decimal(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(name + " must be a finite decimal string") from error
    if not value.is_finite():
        raise ValueError(name + " must be finite")
    return value


def _plain(value):
    return normalize_decimal(str(value))


class PaperExecutionAdapter:
    """Pure deterministic matcher. It neither owns a position ledger nor I/O."""

    def __init__(self, binding, config=None, *, identity_port=None):
        config = {} if config is None else deepcopy(config)
        if not isinstance(binding, dict) or not isinstance(config, dict):
            raise ValueError("binding and config must be mappings")
        self.run_id = binding.get("run_id")
        self.instrument_id = binding.get("instrument_id")
        if not all(isinstance(v, str) and v for v in (self.run_id, self.instrument_id)):
            raise ValueError("run and instrument binding are required")
        if self.instrument_id != "kraken-futures:PF_XBTUSD":
            raise ValueError("execution is isolated to kraken-futures:PF_XBTUSD")
        self._config = {
            "version": config.get("version", EXECUTION_MODEL_VERSION),
            "latency_ms": config.get("latency_ms", 100),
            "tick_size": config.get("tick_size", "1"),
            "lot_size": config.get("lot_size", "0.0001"),
            "max_book_age_ms": config.get("max_book_age_ms", 3000),
            "precision": config.get("precision", DECIMAL_PRECISION),
            "queue_model": "conservative.v1",
        }
        if self._config["version"] != EXECUTION_MODEL_VERSION:
            raise ValueError("unsupported execution model version")
        for key in ("latency_ms", "max_book_age_ms"):
            if isinstance(self._config[key], bool) or not isinstance(self._config[key], int) or self._config[key] < 0:
                raise ValueError("invalid execution timing configuration")
        if isinstance(self._config["precision"], bool) or not isinstance(self._config["precision"], int) or not 28 <= self._config["precision"] <= 100:
            raise ValueError("invalid decimal precision")
        self.tick = _decimal(self._config["tick_size"], "tick_size")
        self.lot = _decimal(self._config["lot_size"], "lot_size")
        if self.tick <= ZERO or self.lot <= ZERO:
            raise ValueError("tick and lot must be positive")
        self._config["tick_size"] = _plain(self.tick)
        self._config["lot_size"] = _plain(self.lot)
        self.orders = {}
        self._events = []
        self.command_receipts = {}
        self._position = {"side": None, "quantity_btc": "0"}
        self._position_reduced = ZERO
        self.book_budgets = {}
        self.trade_budgets = {}
        self.trade_ids = {}
        self._sequence = 0
        self._last_cutoff_ms = None
        if identity_port is not None and not isinstance(identity_port, ExactIdentityPort):
            raise ValueError("identity_port must provide exact operative identity semantics")
        self._identity_port = identity_port
        self._operative_restored = False

    def _identity_lookup(self, kind, key):
        if self._identity_port is None:
            return None
        return self._identity_port.lookup(kind, key)

    def _identity_stage(self, kind, key, value, *, provenance=None):
        if self._identity_port is None:
            return
        self._identity_port.stage(kind, key, value, provenance=provenance or kind + ":" + key)

    def drain_identity_updates(self):
        """Drain provisional exact-identity changes for the owning job dispatcher."""
        if self._identity_port is None:
            raise ValueError("identity updates require an exact identity port")
        return self._identity_port.drain_updates()

    def _emit(self, kind, **fields):
        self._sequence += 1
        event = {"event_id": "{}:{}".format(self.run_id, self._sequence), "type": kind,
                 "run_id": self.run_id, "instrument_id": self.instrument_id, **fields}
        self._events.append(event)
        return deepcopy(event)

    @property
    def events(self):
        return deepcopy(self._events)

    @property
    def config(self):
        return deepcopy(self._config)

    @property
    def position(self):
        return deepcopy(self._position)

    @property
    def state(self):
        return deepcopy({key: {**order, "state": order["state"]} for key, order in self.orders.items()})

    def set_position(self, position):
        if not isinstance(position, dict) or position.get("side") not in ("long", "short", None):
            raise ValueError("invalid external position context")
        qty = _decimal(position.get("quantity_btc"), "position quantity")
        if qty < ZERO or (qty == ZERO) != (position["side"] is None):
            raise ValueError("position side and quantity disagree")
        self._position = {"side": position["side"], "quantity_btc": _plain(qty)}
        self._position_reduced = ZERO

    def submit(self, intent):
        try:
            return self._submit(intent)
        except (TypeError, ValueError) as error:
            order_id = intent.get("order_id") if isinstance(intent, dict) else None
            return self._emit("rejected", order_id=order_id, reason=str(error))

    def _submit(self, intent):
        if not isinstance(intent, dict):
            raise ValueError("order intent must be a mapping")
        order_id = intent.get("order_id")
        if not isinstance(order_id, str) or not order_id:
            raise ValueError("order_id is required")
        previous = self.orders.get(order_id)
        payload = deepcopy(intent)
        if previous is None:
            historical = self._identity_lookup("order", order_id)
            if historical is not None:
                if historical.get("intent") == payload:
                    return deepcopy(historical["receipt"])
                raise ValueError("conflicting order ID reuse")
        if previous:
            if previous["intent"] == payload:
                return deepcopy(previous["receipt"])
            raise ValueError("conflicting order ID reuse")
        if intent.get("run_id") != self.run_id or intent.get("instrument_id") != self.instrument_id:
            raise ValueError("order binding mismatch")
        side, kind = intent.get("side"), intent.get("order_type")
        if side not in ("buy", "sell") or kind not in ("market_ioc", "limit", "post_only", "stop_market", "reduce_only"):
            raise ValueError("invalid side or order type")
        decision = normalize_timestamp_ms(intent.get("decision_at_ms"))
        if decision < 0:
            raise ValueError("decision time cannot be negative")
        qty = _decimal(intent.get("quantity_btc"), "quantity")
        if qty <= ZERO or qty % self.lot:
            raise ValueError("quantity violates lot size")
        price_field = "stop_price_usd" if kind == "stop_market" else "limit_price_usd"
        price = None
        if kind in ("limit", "post_only"):
            price = _decimal(intent.get(price_field), price_field)
            if price <= ZERO or price % self.tick:
                raise ValueError("price violates tick size")
        if kind == "stop_market":
            price = _decimal(intent.get(price_field), price_field)
            if price <= ZERO or price % self.tick:
                raise ValueError("stop price violates tick size")
        expiry = intent.get("expire_at_ms")
        if expiry is not None:
            expiry = normalize_timestamp_ms(expiry)
            if expiry <= decision:
                raise ValueError("expiry must follow decision time")
        eligible = decision + self._config["latency_ms"]
        self._emit("order_created", order_id=order_id, order_type=kind, side=side,
                   quantity_btc=_plain(qty), decision_at_ms=decision)
        receipt = self._emit("order_accepted", order_id=order_id, order_type=kind,
                             side=side, quantity_btc=_plain(qty), decision_at_ms=decision,
                              eligible_at_ms=eligible, model_version=self._config["version"])
        self.orders[order_id] = {"intent": payload, "remaining": _plain(qty), "filled": "0",
            "state": "accepted", "eligible_at_ms": eligible, "expiry_ms": expiry,
            "triggered": kind != "stop_market", "queue_ahead": None, "resting": False, "trade_seen": []}
        self.orders[order_id]["receipt"] = receipt
        self._identity_stage("order", order_id, {"intent": payload, "receipt": receipt}, provenance=receipt["event_id"])
        return deepcopy(receipt)

    @staticmethod
    def _levels(book, key):
        levels = []
        for row in book.get(key, []):
            if not isinstance(row, (list, tuple)) or len(row) != 2:
                raise ValueError("malformed book level")
            price, qty = _decimal(row[0], "book price"), _decimal(row[1], "book quantity")
            if price <= ZERO or qty <= ZERO:
                raise ValueError("book levels must be positive")
            levels.append((price, qty))
        levels.sort(key=lambda item: item[0], reverse=key == "bids")
        if any(levels[i][0] == levels[i-1][0] for i in range(1, len(levels))):
            raise ValueError("duplicate book price")
        return levels

    def _valid_book(self, book, cutoff):
        try:
            event_at = normalize_timestamp_ms(book["event_time_ms"])
            known_at = normalize_timestamp_ms(book["known_at_ms"])
            if known_at > cutoff or event_at > known_at or event_at < 0 or known_at < 0:
                raise ValueError("market clock skew or lookahead")
            if known_at - event_at > self._config["max_book_age_ms"] or cutoff - event_at > self._config["max_book_age_ms"]:
                raise ValueError("stale book")
            if book.get("valid") is not True or book.get("gap") or book.get("crossed"):
                raise ValueError("book quality is not executable")
            if book.get("provider") != "kraken-futures" or book.get("product_id") != "PF_XBTUSD":
                raise ValueError("book is outside the authorized instrument")
            if not all(isinstance(book.get(k), str) and book[k] for k in ("provider", "product_id", "epoch", "snapshot_id", "revision")):
                raise ValueError("book identity is incomplete")
            asks, bids = self._levels(book, "asks"), self._levels(book, "bids")
            if asks and bids and bids[0][0] >= asks[0][0]:
                raise ValueError("crossed book")
            mark = None if book.get("mark_price_usd") is None else _decimal(book["mark_price_usd"], "mark")
            if mark is not None and mark <= ZERO:
                raise ValueError("invalid mark")
            return event_at, known_at, asks, bids, mark
        except (KeyError, TypeError, ValueError) as error:
            return None, None, None, None, str(error)

    def advance(self, cutoff_ms, book, trades=(), *, execution_clock_ms=None):
        cutoff = normalize_timestamp_ms(cutoff_ms)
        if cutoff < 0:
            raise ValueError("cutoff cannot be negative")
        execution_clock = None
        if execution_clock_ms is not None:
            execution_clock = normalize_timestamp_ms(execution_clock_ms)
            if execution_clock < 0 or execution_clock > cutoff:
                raise ValueError("execution clock must be within the verified cutoff")
        if self._last_cutoff_ms is not None and cutoff < self._last_cutoff_ms:
            raise ValueError("execution clock cannot move backwards")
        self._last_cutoff_ms = cutoff
        expired = []
        for order_id, order in self.orders.items():
            if order["state"] in ("accepted", "partially_filled") and order["expiry_ms"] is not None and cutoff >= order["expiry_ms"]:
                order["state"] = "expired"
                expired.append(self._emit("expired", order_id=order_id, effective_at_ms=order["expiry_ms"], filled_quantity_btc=order["filled"]))
        event_at, known_at, asks, bids, mark_or_error = self._valid_book(book, cutoff)
        if event_at is None:
            return deepcopy(expired + [self._emit("market_uncertainty", cutoff_ms=cutoff, reason=mark_or_error)])
        mark = mark_or_error
        identity = (book["provider"], book["product_id"], book["epoch"], book["snapshot_id"], book["revision"])
        if identity not in self.book_budgets:
            historical_budget = self._identity_lookup("book_budget", self._book_key(identity))
            if historical_budget is not None:
                self.book_budgets[identity] = deepcopy(historical_budget)
            elif execution_clock is not None:
                return deepcopy(expired + [self._emit(
                    "market_uncertainty",
                    cutoff_ms=cutoff,
                    reason="due execution has no previously verified liquidity budget",
                )])
            else:
                self.book_budgets[identity] = {"asks": {_plain(p): _plain(q) for p, q in asks}, "bids": {_plain(p): _plain(q) for p, q in bids}}
                self._identity_stage("book_budget", self._book_key(identity), self.book_budgets[identity])
        budget = self.book_budgets[identity]
        emitted = []
        verified_trades = []
        for trade in trades:
            try:
                uid = trade["uid"]
                t, known = normalize_timestamp_ms(trade["event_time_ms"]), normalize_timestamp_ms(trade["known_at_ms"])
                price, qty = _decimal(trade["price_usd"], "trade price"), _decimal(trade["quantity_btc"], "trade quantity")
                if (trade.get("provider"), trade.get("product_id"), trade.get("epoch")) != (book["provider"], book["product_id"], book["epoch"]):
                    continue
                if not isinstance(uid, str) or not uid or known > cutoff or t > known or t < 0 or qty <= ZERO or price <= ZERO or trade.get("aggressor_side") not in ("buy", "sell"):
                    continue
                previous = self.trade_ids.get(uid)
                if previous is None:
                    previous = self._identity_lookup("trade", uid)
                    if previous is not None:
                        previous = (_decimal(previous[0], "trade price"), _decimal(previous[1], "trade quantity"), previous[2])
                if previous is not None and previous != (price, qty, trade["aggressor_side"]):
                    continue
                self.trade_ids[uid] = (price, qty, trade["aggressor_side"])
                self._identity_stage("trade", uid, [_plain(price), _plain(qty), trade["aggressor_side"]])
                if uid not in self.trade_budgets:
                    remaining_budget = self._identity_lookup("trade_budget", uid)
                    self.trade_budgets[uid] = qty if remaining_budget is None else _decimal(remaining_budget, "trade budget")
                remaining = self.trade_budgets[uid]
                verified_trades.append((uid, t, price, remaining, trade["aggressor_side"]))
            except (KeyError, TypeError, ValueError):
                continue
        for order_id, order in self.orders.items():
            if order["state"] not in ("accepted", "partially_filled"):
                continue
            intent = order["intent"]
            match_time = event_at if execution_clock is None else max(event_at, execution_clock)
            if match_time < order["eligible_at_ms"] or known_at > cutoff:
                continue
            kind, side = intent["order_type"], intent["side"]
            if kind == "stop_market" and not order["triggered"]:
                if execution_clock is not None:
                    continue
                if mark is None:
                    emitted.append(self._emit("market_uncertainty", order_id=order_id, cutoff_ms=cutoff, reason="stop mark unavailable"))
                    continue
                stop = _decimal(intent["stop_price_usd"], "stop price")
                if (side == "sell" and mark > stop) or (side == "buy" and mark < stop):
                    continue
                order["triggered"] = True
                emitted.append(self._emit("stop_triggered", order_id=order_id, mark_price_usd=_plain(mark), stop_price_usd=_plain(stop), event_time_ms=event_at))
            contra = asks if side == "buy" else bids
            own_side = bids if side == "buy" else asks
            limit = _decimal(intent["limit_price_usd"], "limit price") if kind in ("limit", "post_only") else None
            crosses = bool(contra and (contra[0][0] <= limit if side == "buy" else contra[0][0] >= limit)) if limit is not None else True
            if kind in ("limit", "post_only") and order["queue_ahead"] is None:
                if crosses:
                    if kind == "post_only":
                        order["state"] = "rejected"
                        emitted.append(self._emit("rejected", order_id=order_id, reason="post_only_would_take", effective_at_ms=event_at))
                        continue
                else:
                    order["queue_ahead"] = next((q for p, q in own_side if p == limit), ZERO)
                    order["resting"] = True
                    emitted.append(self._emit("queue_established", order_id=order_id, queue_ahead_btc=_plain(order["queue_ahead"]), assumption="conservative.v1"))
            if kind in ("limit", "post_only") and order["resting"]:
                for uid, t, price, qty, aggressor in verified_trades:
                    if t < order["eligible_at_ms"] or price != limit or aggressor != ("sell" if side == "buy" else "buy"):
                        continue
                    if uid in order["trade_seen"]:
                        continue
                    order["trade_seen"].append(uid)
                    seen_key = json.dumps([order_id, uid], ensure_ascii=False, separators=(",", ":"))
                    if self._identity_lookup("order_trade", seen_key) is not None:
                        continue
                    self._identity_stage("order_trade", seen_key, True)
                    consumed = min(qty, self.trade_budgets.get(uid, ZERO))
                    ahead = min(order["queue_ahead"], consumed)
                    order["queue_ahead"] -= ahead
                    consumed -= ahead
                    self.trade_budgets[uid] -= ahead
                    if consumed > ZERO and order["queue_ahead"] == ZERO:
                        fill_qty = min(_decimal(order["remaining"], "remaining"), consumed)
                        emitted.extend(self._fill(order_id, order, fill_qty, limit, "maker", match_time, t))
                        self.trade_budgets[uid] -= fill_qty
                    self._identity_stage("trade_budget", uid, _plain(self.trade_budgets[uid]))
                continue
            if kind in ("limit", "post_only"):
                contra = [(p, q) for p, q in contra if (p <= limit if side == "buy" else p >= limit)]
            if kind == "reduce_only":
                position_qty = _decimal(self.position["quantity_btc"], "position quantity")
                expected = "long" if side == "sell" else "short"
                if self.position["side"] != expected or position_qty <= ZERO:
                    order["state"] = "rejected"
                    emitted.append(self._emit("rejected", order_id=order_id, reason="reduce_only_without_opposing_position"))
                    continue
                available = max(ZERO, position_qty - self._position_reduced)
                if available <= ZERO:
                    order["state"] = "cancelled"
                    emitted.append(self._emit("cancelled", order_id=order_id, reason="reduce_only_quantity_exhausted", effective_at_ms=event_at, filled_quantity_btc=order["filled"]))
                    continue
                order["remaining"] = _plain(min(_decimal(order["remaining"], "remaining"), available))
            to_take = _decimal(order["remaining"], "remaining")
            for level_price, _ in contra:
                level_key = _plain(level_price)
                available = _decimal(budget["asks" if side == "buy" else "bids"].get(level_key, "0"), "book budget")
                take = min(to_take, available)
                if take <= ZERO:
                    continue
                emitted.extend(self._fill(order_id, order, take, level_price, "taker", match_time, event_at))
                budget["asks" if side == "buy" else "bids"][level_key] = _plain(available - take)
                self._identity_stage("book_budget", self._book_key(identity), budget)
                to_take -= take
                if to_take == ZERO:
                    break
            if kind == "limit" and order["state"] == "partially_filled" and not order["resting"]:
                order["queue_ahead"] = next((q for p, q in own_side if p == limit), ZERO)
                order["resting"] = True
                emitted.append(self._emit("queue_established", order_id=order_id,
                    queue_ahead_btc=_plain(order["queue_ahead"]), assumption="conservative.v1"))
            if order["state"] not in ("filled", "rejected", "cancelled", "expired") and kind in ("market_ioc", "reduce_only", "stop_market"):
                order["state"] = "cancelled"
                emitted.append(self._emit("cancelled", order_id=order_id, reason="ioc_remainder", effective_at_ms=match_time, filled_quantity_btc=order["filled"]))
        for order_id, order in self.orders.items():
            self._identity_stage("order", order_id, {
                "intent": order["intent"], "receipt": order["receipt"],
                "state": order["state"], "filled": order["filled"],
            }, provenance=next((event["event_id"] for event in reversed(self._events) if event.get("order_id") == order_id), order["receipt"]["event_id"]))
        return deepcopy(emitted)

    def _fill(self, order_id, order, quantity, price, liquidity, event_time, source_time):
        with localcontext() as context:
            context.prec = self._config["precision"]
            rate = FEES[liquidity]
            fee = quantity * price * rate
            remaining = _decimal(order["remaining"], "remaining") - quantity
            filled = _decimal(order["filled"], "filled") + quantity
            order["remaining"], order["filled"] = _plain(remaining), _plain(filled)
            order["state"] = "filled" if remaining == ZERO else "partially_filled"
            if order["intent"]["order_type"] == "reduce_only":
                self._position_reduced += quantity
            fill = self._emit("fill", order_id=order_id, fill_id="{}:{}".format(self.run_id, self._sequence + 1),
                quantity_btc=_plain(quantity), price_usd=_plain(price), fee_usd=_plain(fee), liquidity=liquidity,
                event_time_ms=event_time, source_event_time_ms=source_time, fee_rate=_plain(rate),
                notional_usd=_plain(quantity * price))
            if order["state"] == "filled":
                self._emit("order_filled", order_id=order_id, filled_quantity_btc=order["filled"], effective_at_ms=event_time)
            return [fill]

    def cancel(self, order_id, command_id, effective_at_ms):
        effective = normalize_timestamp_ms(effective_at_ms)
        if not isinstance(command_id, str) or not command_id:
            raise ValueError("command_id is required")
        payload = (order_id, effective)
        if command_id in self.command_receipts:
            prior, result = self.command_receipts[command_id]
            if prior != payload:
                raise ValueError("conflicting cancellation command ID")
            return deepcopy(result)
        historical = self._identity_lookup("cancel", command_id)
        if historical is not None:
            prior, result = historical
            if tuple(prior) != payload:
                raise ValueError("conflicting cancellation command ID")
            return deepcopy(result)
        order = self.orders.get(order_id)
        if order is None:
            historical_order = self._identity_lookup("order", order_id)
            if historical_order is None:
                raise ValueError("unknown order")
            order = historical_order
        if effective < order["intent"]["decision_at_ms"]:
            raise ValueError("cancellation cannot precede order creation")
        if self._last_cutoff_ms is not None and effective < self._last_cutoff_ms:
            raise ValueError("cancellation cannot be retroactive to the execution clock")
        if order.get("state") in ("accepted", "partially_filled"):
            order["state"] = "cancelled"
            events = [self._emit("cancelled", order_id=order_id, command_id=command_id,
                effective_at_ms=effective, filled_quantity_btc=order["filled"])]
        else:
            events = []
        self.command_receipts[command_id] = (payload, events)
        self._identity_stage("cancel", command_id, [list(payload), events], provenance=events[-1]["event_id"] if events else command_id)
        return deepcopy(events)

    @staticmethod
    def _book_key(identity):
        return json.dumps(list(identity), ensure_ascii=False, separators=(",", ":"))

    def operative_checkpoint(self, *, live_book_identities=(), live_trade_ids=()):
        """Return compact operative state; history remains in legacy checkpoint/events."""
        if self._identity_port is None:
            raise ValueError("operative checkpoint requires an exact identity port")
        books = {tuple(identity) for identity in live_book_identities}
        trades = set(live_trade_ids)
        active_orders = {
            order_id: deepcopy(order)
            for order_id, order in self.orders.items()
            if order["state"] in ("accepted", "partially_filled")
        }
        for order in active_orders.values():
            order["trade_seen"] = []
            if order["queue_ahead"] is not None:
                order["queue_ahead"] = _plain(order["queue_ahead"])
        for identity in books:
            if identity not in self.book_budgets:
                raise ValueError("live book identity has no verified operative budget")
        if any(not isinstance(uid, str) or not uid for uid in trades):
            raise ValueError("live trade identities must be non-empty strings")
        return deepcopy({
            "checkpoint_version": "paper-execution-operative-checkpoint.v1",
            "model_version": self._config["version"], "run_id": self.run_id,
            "instrument_id": self.instrument_id, "config": self._config,
            "orders": active_orders, "position": self._position,
            "position_reduced": _plain(self._position_reduced),
            "book_budgets": [(list(key), self.book_budgets[key]) for key in sorted(books)],
            "trade_budgets": [(key, _plain(self.trade_budgets[key])) for key in sorted(trades) if key in self.trade_budgets],
            "sequence": self._sequence, "last_cutoff_ms": self._last_cutoff_ms,
        })

    @classmethod
    def restore_operative(cls, checkpoint, *, identity_port):
        if not isinstance(identity_port, ExactIdentityPort):
            raise ValueError("operative restore requires an exact identity port")
        required = {"checkpoint_version", "model_version", "run_id", "instrument_id", "config", "orders", "position", "position_reduced", "book_budgets", "trade_budgets", "sequence", "last_cutoff_ms"}
        if not isinstance(checkpoint, dict) or set(checkpoint) != required or checkpoint.get("checkpoint_version") != "paper-execution-operative-checkpoint.v1":
            raise ValueError("unsupported operative execution checkpoint")
        result = cls({"run_id": checkpoint["run_id"], "instrument_id": checkpoint["instrument_id"]}, checkpoint["config"], identity_port=identity_port)
        if checkpoint["model_version"] != result._config["version"]:
            raise ValueError("operative checkpoint model version mismatch")
        if (
            not isinstance(checkpoint["orders"], dict)
            or not isinstance(checkpoint["book_budgets"], list)
            or not isinstance(checkpoint["trade_budgets"], list)
            or not isinstance(checkpoint["position"], dict)
            or set(checkpoint["position"]) != {"side", "quantity_btc"}
        ):
            raise ValueError("operative checkpoint collections are invalid")
        result.orders = deepcopy(checkpoint["orders"])
        for order in result.orders.values():
            if (
                not isinstance(order, dict)
                or order.get("state") not in ("accepted", "partially_filled")
                or not isinstance(order.get("trade_seen"), list)
                or order["trade_seen"]
            ):
                raise ValueError("operative checkpoint contains invalid active order")
            if order["queue_ahead"] is not None:
                order["queue_ahead"] = _decimal(order["queue_ahead"], "queue ahead")
        result._position = deepcopy(checkpoint["position"])
        result._position_reduced = _decimal(checkpoint["position_reduced"], "position reduced")
        result.book_budgets = {tuple(key): deepcopy(value) for key, value in checkpoint["book_budgets"]}
        result.trade_budgets = {key: _decimal(value, "trade budget") for key, value in checkpoint["trade_budgets"]}
        result._sequence = checkpoint["sequence"]
        if isinstance(result._sequence, bool) or not isinstance(result._sequence, int) or result._sequence < 0:
            raise ValueError("invalid operative checkpoint sequence")
        result._last_cutoff_ms = checkpoint["last_cutoff_ms"]
        if result._last_cutoff_ms is not None:
            result._last_cutoff_ms = normalize_timestamp_ms(result._last_cutoff_ms)
        result._operative_restored = True
        return result

    def checkpoint(self):
        if self._operative_restored:
            raise ValueError("legacy full-history checkpoint is unavailable after operative restore")
        orders = deepcopy(self.orders)
        for order in orders.values():
            if order["queue_ahead"] is not None:
                order["queue_ahead"] = _plain(order["queue_ahead"])
        return deepcopy({"checkpoint_version": CHECKPOINT_VERSION, "model_version": self._config["version"],
            "run_id": self.run_id, "instrument_id": self.instrument_id, "config": self._config,
            "orders": orders, "events": self._events, "command_receipts": self.command_receipts,
            "position": self._position, "position_reduced": _plain(self._position_reduced),
            "book_budgets": [
                (
                    list(key),
                    {
                        side: [[price, quantity] for price, quantity in levels.items()]
                        for side, levels in budget.items()
                    },
                )
                for key, budget in self.book_budgets.items()
            ],
            "trade_budgets": [(key, _plain(value)) for key, value in self.trade_budgets.items()],
            "trade_ids": [(key, [_plain(value[0]), _plain(value[1]), value[2]]) for key, value in self.trade_ids.items()],
            "sequence": self._sequence, "last_cutoff_ms": self._last_cutoff_ms})

    @classmethod
    def restore(cls, checkpoint):
        if not isinstance(checkpoint, dict) or checkpoint.get("checkpoint_version") not in (
            LEGACY_CHECKPOINT_VERSION,
            CHECKPOINT_VERSION,
        ):
            raise ValueError("unsupported execution checkpoint")
        result = cls({"run_id": checkpoint["run_id"], "instrument_id": checkpoint["instrument_id"]}, checkpoint["config"])
        if checkpoint.get("model_version") != result._config["version"]:
            raise ValueError("checkpoint model version mismatch")
        result.orders = deepcopy(checkpoint["orders"])
        for order in result.orders.values():
            if order["queue_ahead"] is not None:
                order["queue_ahead"] = Decimal(order["queue_ahead"])
        result._events = deepcopy(checkpoint["events"])
        result.command_receipts = {key: (tuple(value[0]), deepcopy(value[1])) for key, value in checkpoint["command_receipts"].items()}
        result._position = deepcopy(checkpoint["position"])
        result._position_reduced = Decimal(checkpoint["position_reduced"])
        result.book_budgets = {}
        for key, budget in checkpoint["book_budgets"]:
            if checkpoint["checkpoint_version"] == LEGACY_CHECKPOINT_VERSION:
                restored_budget = deepcopy(budget)
            else:
                restored_budget = {
                    side: {price: quantity for price, quantity in levels}
                    for side, levels in budget.items()
                }
            result.book_budgets[tuple(key)] = restored_budget
        result.trade_budgets = {key: Decimal(value) for key, value in checkpoint["trade_budgets"]}
        result.trade_ids = {key: (Decimal(value[0]), Decimal(value[1]), value[2]) for key, value in checkpoint["trade_ids"]}
        result._sequence = checkpoint["sequence"]
        if isinstance(result._sequence, bool) or not isinstance(result._sequence, int) or result._sequence < 0:
            raise ValueError("invalid execution checkpoint sequence")
        result._last_cutoff_ms = checkpoint.get("last_cutoff_ms")
        if result._last_cutoff_ms is not None:
            result._last_cutoff_ms = normalize_timestamp_ms(result._last_cutoff_ms)
        return result


__all__ = ["PaperExecutionAdapter", "EXECUTION_MODEL_VERSION", "CHECKPOINT_VERSION"]
