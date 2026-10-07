"""Paper execution D: deterministic taker paper fills driven by verdicts.

D is the single writer of its own account DB. It reads the verdicts DB and the
market DB read-only and merges their rows into one total order:

* a ticker at its ``received_at``,
* a verdict at its ``written_at``,
* a funding period at ``max(end_ms, known_at)``.

Ties break by kind (funding, verdict, ticker) and then by the source id (funding
``start_ms``, verdict ``bucket_start``, ticker ``rowid``). Within one source the
time is clamped to be non-decreasing in cursor order, so the merge is a merge of
sorted streams and the result does not depend on how polls slice the input.

Live, D only processes events up to ``now - horizon_margin_ms``. ASSUMPTION: every
source commits a row within that margin of the row's own time (capture commits
per event; the verdict service writes ``written_at`` at the commit; funding rows
carry ``known_at`` = response receive time). A row that commits later than the
margin and sorts before already processed events would be missed live but seen by
a replay; the margin is the knob that bounds that risk.

Entry gates are a pure function of independent causes recomputed on every
verdict. There is deliberately no stored "entry paused" flag, which is how the
legacy runtime overwrote a funding pause with a later value.

Funding sign: ``FuturesLedger`` counts funding as *paid* (positive = paid, a long
pays a positive rate); ``futures_funding.accrue_interval`` returns the opposite
cashflow sign (positive = received). D uses the ledger and reports
``funding_paid`` / ``funding`` as paid.
"""

import hashlib
import json
import os
import sqlite3
import time
from collections import deque
from decimal import ROUND_FLOOR, Decimal, InvalidOperation, localcontext

from .canonical import canonical_json, normalize_decimal
from .futures_costs import MAKER_RATE, TAKER_RATE
from .futures_ledger import FuturesLedger
from .futures_strategies import C25_ID, C26_ID, C27_ID, C28_ID, propose

PAPER_EXECUTION_CONFIG = {
    "version": "futures-paper-execution-config.v2",
    "initial_cash_usd": "10000",
    "max_notional_usd": "1000",
    "max_exposure_multiple": "1",
    "risk_fraction": "0.001",
    "execution_latency_ms": 100,
    "max_entry_wait_ms": 5000,
    "max_spread_bps": "5",
    "maker_rate": MAKER_RATE,
    "taker_rate": TAKER_RATE,
    "daily_loss_fraction": "0.01",
    "time_stop_ms": 1_800_000,
    "max_verdict_lag_ms": 15_000,
    "tick_size": "1",
    "lot_size": "0.0001",
    "min_qty": "0.0001",
    "max_funding_staleness_ms": 7_200_000,
}

GENESIS_HASH = "0" * 64
DAY_MS = 86_400_000
FUNDING_UNIT = "USD/BTC/hour"
# Same constant `_risk_plan` uses for the round-trip slippage allowance and buffer.
COST_BUFFER_RATE = Decimal("0.0002")
INVALIDATION_PREFIX = "opposite_donchian_mid_cross@"
INVALIDATION_UNAVAILABLE = "invalidation_level_unavailable"
C27_STRATEGY_ID = "c27-breakout-perp-v1"
STATE_VERSION = "futures-paper-execution-state.v1"
FUNDING_PERIODS_KEPT = 200
CONSUMED_SIGNALS_KEPT = 5000
READ_BATCH = 1000
DRAIN_CHUNK = 5000
ZERO = Decimal(0)


class ReplayDivergence(RuntimeError):
    """Re-derived events after a restart differ from the stored ones."""


def _dec(value):
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        return None
    return result if result.is_finite() else None


def _frozen_level(invalidation):
    """The numeric Donchian-mid level frozen in a C27 invalidation string, else None."""
    if not isinstance(invalidation, str) or not invalidation.startswith(INVALIDATION_PREFIX):
        return None
    level = invalidation[len(INVALIDATION_PREFIX):]
    return level if _dec(level) is not None else None


def _s(value):
    return normalize_decimal(str(value))


def _json(text):
    # Floats stay as their literal text: money values are never binary floats.
    return json.loads(text, parse_float=str)


def _chain_hash(prev_hash, payload_json):
    digest = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    return hashlib.sha256((prev_hash + digest).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- account DB


class AccountStore:
    """Single writer of the account DB: hash-chained events plus snapshots."""

    def __init__(self, path, config):
        self.config = dict(config)
        self.config_json = canonical_json(self.config)
        self.config_hash = hashlib.sha256(self.config_json.encode("utf-8")).hexdigest()
        self.db = sqlite3.connect(path)
        script = [
            "PRAGMA journal_mode=WAL;",
            "PRAGMA synchronous=NORMAL;",
            "CREATE TABLE IF NOT EXISTS paper_execution_meta("
            "key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
            "CREATE TABLE IF NOT EXISTS paper_execution_events("
            "seq INTEGER PRIMARY KEY, time_ms INTEGER NOT NULL, kind TEXT NOT NULL, "
            "payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, record_hash TEXT NOT NULL) STRICT;",
            "CREATE TABLE IF NOT EXISTS paper_execution_snapshots("
            "seq INTEGER PRIMARY KEY, time_ms INTEGER NOT NULL, state_json TEXT NOT NULL, "
            "cursors_json TEXT NOT NULL, head_hash TEXT NOT NULL) STRICT;",
        ]
        for table in ("meta", "events", "snapshots"):
            name = "paper_execution_" + table
            for action in ("update", "delete"):
                script.append(
                    "CREATE TRIGGER IF NOT EXISTS {n}_no_{a} BEFORE {a} ON {n} "
                    "BEGIN SELECT RAISE(ABORT, 'paper execution records are immutable'); END;".format(
                        n=name, a=action.upper()
                    )
                )
        self.db.executescript("\n".join(script))
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_execution_meta VALUES('config_json', ?)", (self.config_json,)
            )
            self.db.execute(
                "INSERT OR IGNORE INTO paper_execution_meta VALUES('config_hash', ?)", (self.config_hash,)
            )
        stored = self.db.execute(
            "SELECT value FROM paper_execution_meta WHERE key='config_hash'"
        ).fetchone()[0]
        if stored != self.config_hash:
            self.db.close()
            raise ValueError("account DB was written with a different config; use a new DB")
        self.head_seq = 0
        self.head_hash = GENESIS_HASH
        self.snapshot_seq = 0
        self.restored = None
        self.expected = deque()
        self._rows = []
        self.new_events = []
        self._restore()

    def _restore(self):
        row = self.db.execute(
            "SELECT seq, state_json, cursors_json, head_hash FROM paper_execution_snapshots "
            "ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        after = 0
        if row is not None:
            self.snapshot_seq = row[0]
            document = _json(row[1])
            head_seq = document["head_seq"]
            if head_seq == 0:
                head_ok = row[3] == GENESIS_HASH
            else:
                found = self.db.execute(
                    "SELECT record_hash FROM paper_execution_events WHERE seq=?", (head_seq,)
                ).fetchone()
                head_ok = found is not None and found[0] == row[3]
            if not head_ok:
                self.db.close()
                raise ValueError("snapshot head hash does not match the event chain; refusing to run")
            self.restored = (document["engine"], _json(row[2]))
            self.head_seq, self.head_hash = head_seq, row[3]
            after = head_seq
        # Events past the snapshot are re-derived and compared, not rewritten.
        for stored in self.db.execute(
            "SELECT seq, time_ms, kind, payload_json, prev_hash, record_hash "
            "FROM paper_execution_events WHERE seq>? ORDER BY seq", (after,)
        ):
            self.expected.append(stored)

    def emit(self, kind, time_ms, body):
        payload_json = canonical_json({"kind": kind, "time_ms": time_ms, "body": body})
        record_hash = _chain_hash(self.head_hash, payload_json)
        row = (self.head_seq + 1, time_ms, kind, payload_json, self.head_hash, record_hash)
        if self.expected:
            stored = self.expected.popleft()
            if tuple(stored) != row:
                raise ReplayDivergence(
                    "re-derived event {} differs from the stored one; refusing to continue".format(row[0])
                )
        else:
            self._rows.append(("e", row))
            self.new_events.append((row[0], kind, time_ms, body))
        self.head_seq, self.head_hash = row[0], record_hash

    def snapshot(self, time_ms, engine_state, cursors):
        document = canonical_json({"head_seq": self.head_seq, "engine": engine_state})
        self.snapshot_seq += 1
        self._rows.append(
            ("s", (self.snapshot_seq, time_ms, document, canonical_json(cursors), self.head_hash))
        )

    def flush(self):
        if not self._rows:
            return
        with self.db:
            for kind, row in self._rows:
                if kind == "e":
                    self.db.execute("INSERT INTO paper_execution_events VALUES(?,?,?,?,?,?)", row)
                else:
                    self.db.execute("INSERT INTO paper_execution_snapshots VALUES(?,?,?,?,?)", row)
        self._rows = []

    def take_new_events(self):
        events, self.new_events = self.new_events, []
        return events

    def close(self):
        self.db.close()


def verify_chain(path):
    """Recomputes the whole event chain; returns the head hash or raises ValueError."""
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        prev = GENESIS_HASH
        expected_seq = 1
        for seq, kind, time_ms, payload_json, prev_hash, record_hash in db.execute(
            "SELECT seq, kind, time_ms, payload_json, prev_hash, record_hash "
            "FROM paper_execution_events ORDER BY seq"
        ):
            payload = _json(payload_json)
            if (seq != expected_seq or prev_hash != prev or payload["kind"] != kind
                    or payload["time_ms"] != time_ms
                    or _chain_hash(prev, payload_json) != record_hash):
                raise ValueError("event chain broken at seq {}".format(seq))
            prev = record_hash
            expected_seq += 1
        return prev
    finally:
        db.close()


# --------------------------------------------------------------------------- engine


class PaperExecutionEngine:
    """Pure deterministic state machine over merged input items.

    It performs no I/O: records go to ``sink`` (an ``AccountStore``).
    """

    def __init__(self, config, sink, state=None, snapshot_every_events=50, snapshot_interval_ms=300_000):
        self.sink = sink
        self.snapshot_every_events = snapshot_every_events
        self.snapshot_interval_ms = snapshot_interval_ms
        self.config = dict(config)
        c = self.config
        self.initial_cash = c["initial_cash_usd"]
        self.max_notional = Decimal(c["max_notional_usd"])
        self.max_exposure = Decimal(c["max_exposure_multiple"])
        self.risk_fraction = Decimal(c["risk_fraction"])
        self.latency = c["execution_latency_ms"]
        self.max_wait = c["max_entry_wait_ms"]
        self.max_spread_bps = Decimal(c["max_spread_bps"])
        self.taker = Decimal(c["taker_rate"])
        self.daily_loss_fraction = Decimal(c["daily_loss_fraction"])
        self.time_stop_ms = c["time_stop_ms"]
        self.max_lag = c["max_verdict_lag_ms"]
        self.lot = Decimal(c["lot_size"])
        self.min_qty = Decimal(c["min_qty"])
        self.max_staleness = c["max_funding_staleness_ms"]
        self.ledger = self._new_ledger()
        self.trade = None
        self.pending = None
        self.day = None
        self.opening_equity = None
        self.latch_day = None
        self.consumed = []
        self._consumed_set = set()
        self.last_mark = None
        self.latest_funding_end = None
        self.funding_periods = []
        self.next_order = 1
        self.events_since_snapshot = 0
        self.last_snapshot_time = None
        if state is not None:
            self._load(state)

    # -- ledger and state ----------------------------------------------------

    def _new_ledger(self):
        return FuturesLedger(
            self.initial_cash, "1", {"maker": self.config["maker_rate"], "taker": self.config["taker_rate"]}
        )

    def to_state(self):
        ledger = self.ledger
        position = None
        if ledger.position is not None:
            position = {
                key: _s(value) if isinstance(value, Decimal) else value
                for key, value in ledger.position.items()
            }
        return {
            "version": STATE_VERSION,
            "ledger": {
                "realized_gross": _s(ledger.realized_gross), "fees": _s(ledger.fees),
                "funding_paid": _s(ledger.funding_paid), "funding_complete": ledger.funding_complete,
                "last_accrual_ms": ledger.last_accrual_ms, "position": position,
            },
            "trade": self.trade, "pending": self.pending, "day": self.day,
            "opening_equity": None if self.opening_equity is None else _s(self.opening_equity),
            "latch_day": self.latch_day, "consumed": list(self.consumed),
            "last_mark": None if self.last_mark is None else _s(self.last_mark),
            "latest_funding_end": self.latest_funding_end,
            "funding_periods": [list(period) for period in self.funding_periods],
            "next_order": self.next_order,
            "events_since_snapshot": self.events_since_snapshot,
            "last_snapshot_time": self.last_snapshot_time,
        }

    def _load(self, state):
        if state.get("version") != STATE_VERSION:
            raise ValueError("unsupported paper execution state version")
        saved = state["ledger"]
        ledger = self.ledger
        ledger.realized_gross = Decimal(saved["realized_gross"])
        ledger.fees = Decimal(saved["fees"])
        ledger.funding_paid = Decimal(saved["funding_paid"])
        ledger.funding_complete = saved["funding_complete"]
        ledger.last_accrual_ms = saved["last_accrual_ms"]
        if saved["position"] is not None:
            position = dict(saved["position"])
            for key in ("qty", "entry", "entry_fee_remaining", "funding_remaining"):
                position[key] = Decimal(position[key])
            ledger.position = position
        self.trade = state["trade"]
        self.pending = state["pending"]
        self.day = state["day"]
        self.opening_equity = None if state["opening_equity"] is None else Decimal(state["opening_equity"])
        self.latch_day = state["latch_day"]
        self.consumed = list(state["consumed"])
        self._consumed_set = set(self.consumed)
        self.last_mark = None if state["last_mark"] is None else Decimal(state["last_mark"])
        self.latest_funding_end = state["latest_funding_end"]
        self.funding_periods = [list(period) for period in state["funding_periods"]]
        self.next_order = state["next_order"]
        self.events_since_snapshot = state["events_since_snapshot"]
        self.last_snapshot_time = state["last_snapshot_time"]

    def _emit(self, kind, time_ms, body):
        self.sink.emit(kind, time_ms, body)
        self.events_since_snapshot += 1

    def after_item(self, time_ms, cursors):
        """Writes a snapshot every N events or every interval of event time."""
        if self.last_snapshot_time is None:
            self.last_snapshot_time = time_ms
            return
        if (self.events_since_snapshot >= self.snapshot_every_events
                or time_ms - self.last_snapshot_time >= self.snapshot_interval_ms):
            self.events_since_snapshot = 0
            self.last_snapshot_time = time_ms
            self.sink.snapshot(time_ms, self.to_state(), cursors())

    # -- helpers ---------------------------------------------------------------

    def _equity(self, mark):
        ledger = self.ledger
        equity = ledger.cash + ledger.realized_gross - ledger.fees - ledger.funding_paid
        position = ledger.position
        if position is not None:
            reference = mark if mark is not None else position["entry"]
            sign = 1 if position["side"] == "long" else -1
            equity += position["qty"] * (reference - position["entry"]) * sign
        return equity

    def _account_block(self):
        """Running totals after the event being emitted, for read-only consumers.

        ``cash_usd`` is the balance after realized PnL, fees and funding (the
        ledger's own ``cash`` is the constant seed). Equity needs a mark, which
        the consumer holds, so it is not stored. ``net_usd`` is None while the
        funding total is incomplete: it is never inferred.
        """
        ledger = self.ledger
        balance = ledger.cash + ledger.realized_gross - ledger.fees - ledger.funding_paid
        position = None
        if ledger.position is not None:
            trade = self.trade
            position = {
                "side": ledger.position["side"], "quantity_btc": _s(ledger.position["qty"]),
                "entry_price_usd_per_btc": _s(ledger.position["entry"]),
                "opened_at_ms": trade["opened_at_ms"], "stop": trade["stop"],
                "target": trade["target"], "strategy_id": trade["strategy_id"],
            }
        net = ledger.realized_gross - ledger.fees - ledger.funding_paid
        return {
            "cash_usd": _s(balance), "realized_gross_usd": _s(ledger.realized_gross),
            "fees_usd": _s(ledger.fees), "funding_paid_usd": _s(ledger.funding_paid),
            "funding_complete": ledger.funding_complete,
            "net_usd": _s(net) if ledger.funding_complete else None,
            "position": position,
        }

    def _floor_lot(self, quantity):
        return (quantity / self.lot).to_integral_value(rounding=ROUND_FLOOR) * self.lot

    def _order_id(self):
        order_id = "o{}".format(self.next_order)
        self.next_order += 1
        return order_id

    def _latched(self, time_ms):
        return self.latch_day is not None and self.latch_day == time_ms // DAY_MS

    def gate_causes(self, time_ms):
        """Independent entry-gate causes, recomputed from scratch every time."""
        causes = []
        if self._latched(time_ms):
            causes.append("daily_loss_latched")
        if (self.latest_funding_end is None
                or time_ms - self.latest_funding_end > self.max_staleness):
            causes.append("funding_unresolved")
        if self.pending is not None:
            causes.append("order_pending")
        return causes

    # -- main entry ------------------------------------------------------------

    def process(self, item):
        time_ms = item["time"]
        with localcontext() as context:
            context.prec = 50
            self._roll_day(time_ms)
            self._expire_pending(time_ms)
            kind = item["kind"]
            if kind == "ticker":
                self._on_ticker(time_ms, item)
            elif kind == "verdict":
                self._on_verdict(time_ms, item)
            else:
                self._on_funding(time_ms, item)

    def _roll_day(self, time_ms):
        day = time_ms // DAY_MS
        if self.day is None:
            self.day = day
            self.opening_equity = self._equity(self.last_mark)
        elif day != self.day:
            self.day = day
            self.opening_equity = self._equity(self.last_mark)
            if self.latch_day is not None:
                self._emit("latch_cleared", time_ms, {"day": day, "opening_equity": _s(self.opening_equity)})
                self.latch_day = None

    def _expire_pending(self, time_ms):
        pending = self.pending
        if pending is not None and pending["type"] == "entry" and time_ms > pending["expires_at_ms"]:
            self._emit("order_expired", time_ms, {
                "order_id": pending["order_id"], "expires_at_ms": pending["expires_at_ms"],
                "signal_key": pending["signal_key"], "reason": "no_valid_ticker_in_wait",
            })
            self.pending = None

    # -- tickers ---------------------------------------------------------------

    def _on_ticker(self, time_ms, item):
        data = item["data"]
        mark = _dec(data["mark"])
        mark_ok = mark is not None and mark > 0
        if mark_ok:
            self.last_mark = mark
        bid, ask = _dec(data["bid"]), _dec(data["ask"])
        quote_ok = bid is not None and ask is not None and 0 < bid < ask
        spread_ok = (quote_ok and mark_ok
                     and (ask - bid) * 20_000 <= self.max_spread_bps * (ask + bid))
        pending = self.pending
        if pending is not None and time_ms >= pending["eligible_at_ms"]:
            if pending["type"] == "entry":
                if spread_ok:
                    self._fill_entry(time_ms, item, bid, ask)
            elif quote_ok and mark_ok:
                self._fill_exit(time_ms, item, bid, ask)
        if mark_ok:
            self._risk(time_ms, mark)

    def _fill_entry(self, time_ms, item, bid, ask):
        order = self.pending
        data = item["data"]
        side = order["side"]
        entry = ask if side == "long" else bid
        displayed = _dec(data["ask_size"] if side == "long" else data["bid_size"])
        reason = None
        stop, target = _dec(order["stop"]), _dec(order["target"])
        quantity = ZERO
        if stop is None or stop <= 0 or (side == "long" and stop >= entry) or (side == "short" and stop <= entry):
            reason = "invalid_stop"
        elif target is None or (side == "long" and target <= entry) or (side == "short" and target >= entry):
            reason = "target_on_wrong_side"
        else:
            cost_per_btc = entry * (2 * self.taker + COST_BUFFER_RATE)
            if abs(target - entry) <= cost_per_btc + entry * COST_BUFFER_RATE:
                reason = "target_does_not_clear_cost_buffer"
            elif displayed is None or displayed <= 0:
                reason = "displayed_size_unavailable"
            else:
                equity = self._equity(entry)
                by_risk = equity * self.risk_fraction / (abs(entry - stop) + cost_per_btc)
                by_exposure = min(self.max_notional, equity * self.max_exposure) / entry
                quantity = self._floor_lot(min(by_risk, by_exposure, displayed))
                if quantity < self.min_qty:
                    reason = "quantity_below_minimum"
        if reason is None:
            try:
                self.ledger.open(side, _s(quantity), _s(entry), "taker", at_ms=time_ms)
            except ValueError:
                reason = "insufficient_margin"
        if reason is not None:
            self._emit("order_rejected", time_ms, {
                "order_id": order["order_id"], "reason": reason, "signal_key": order["signal_key"],
                "entry_price": _s(entry),
            })
            self.pending = None
            return
        self.ledger.funding_complete = True
        self.ledger.events.clear()
        fee = self.ledger.position["entry_fee_remaining"]
        self.trade = {
            "order_id": order["order_id"], "side": side, "quantity": _s(quantity), "entry_price": _s(entry),
            "stop": order["stop"], "target": order["target"], "strategy_id": order["strategy_id"],
            "delegated_strategy_id": order["delegated_strategy_id"], "signal_key": order["signal_key"],
            "invalidation": order["invalidation"], "opened_at_ms": time_ms,
        }
        self.pending = None
        account = self._account_block()
        self._emit("order_filled", time_ms, {
            "order_id": order["order_id"], "side": "buy" if side == "long" else "sell",
            "quantity": _s(quantity), "price": _s(entry), "liquidity": "taker", "fee": _s(fee),
            "bid": _s(bid), "ask": _s(ask), "displayed_size": _s(displayed),
            "ticker_rowid": item["id"], "eligible_at_ms": order["eligible_at_ms"],
            "account": account,
        })
        self._emit("position_opened", time_ms, dict(self.trade, fee=_s(fee), account=account))

    def _fill_exit(self, time_ms, item, bid, ask):
        order = self.pending
        trade = self.trade
        side = trade["side"]
        price = bid if side == "long" else ask
        data = item["data"]
        displayed = _dec(data["bid_size"] if side == "long" else data["ask_size"])
        quantity = self.ledger.position["qty"]
        self._accrue(time_ms, force_event=False)
        net = self.ledger.close(_s(quantity), _s(price), "taker", at_ms=time_ms)
        closed = self.ledger.events[-1]
        complete = self.ledger.funding_complete
        self.ledger.events.clear()
        fees = Decimal(closed["allocated_entry_fee"]) + Decimal(closed["exit_fee"])
        self.pending = None
        self.trade = None
        account = self._account_block()
        self._emit("order_filled", time_ms, {
            "order_id": order["order_id"], "side": "sell" if side == "long" else "buy",
            "quantity": _s(quantity), "price": _s(price), "liquidity": "taker",
            "fee": closed["exit_fee"], "bid": _s(bid), "ask": _s(ask),
            "displayed_size": None if displayed is None else _s(displayed),
            "reduce_only": True, "ticker_rowid": item["id"], "eligible_at_ms": order["eligible_at_ms"],
            "account": account,
        })
        self._emit("position_closed", time_ms, {
            "order_id": trade["order_id"], "reason": order["reason"], "side": side,
            "quantity": _s(quantity), "entry_price": trade["entry_price"], "exit_price": _s(price),
            "gross": closed["gross"], "fees": _s(fees), "funding": closed["allocated_funding"],
            "net": _s(net), "funding_complete": complete, "opened_at_ms": trade["opened_at_ms"],
            "held_ms": time_ms - trade["opened_at_ms"], "strategy_id": trade["strategy_id"],
            "signal_key": trade["signal_key"], "account": account,
        })

    def _risk(self, time_ms, mark):
        equity = self._equity(mark)
        opening = self.opening_equity
        latched = self._latched(time_ms)
        if not latched and opening > 0 and opening - equity >= opening * self.daily_loss_fraction:
            self.latch_day = self.day
            latched = True
            self._emit("latch_set", time_ms, {
                "day": self.day, "equity": _s(equity), "opening_equity": _s(opening), "mark": _s(mark),
            })
            if self.pending is not None and self.pending["type"] == "entry":
                self._emit("order_rejected", time_ms, {
                    "order_id": self.pending["order_id"], "reason": "daily_loss_latched",
                    "signal_key": self.pending["signal_key"], "entry_price": None,
                })
                self.pending = None
        trade = self.trade
        if trade is None or self.pending is not None:
            return
        if latched:
            return self._trigger_exit(time_ms, "daily_loss_limit", None, mark)
        stop, target = Decimal(trade["stop"]), Decimal(trade["target"])
        if trade["side"] == "long":
            hit = "protective_stop" if mark <= stop else "profit_target" if mark >= target else None
        else:
            hit = "protective_stop" if mark >= stop else "profit_target" if mark <= target else None
        if hit is not None:
            return self._trigger_exit(time_ms, hit, None, mark)
        if time_ms - trade["opened_at_ms"] >= self.time_stop_ms:
            self._trigger_exit(time_ms, "time_stop", None, mark)

    def _trigger_exit(self, time_ms, reason, detail, mark):
        side = self.trade["side"]
        order_id = self._order_id()
        eligible = time_ms + self.latency
        self.pending = {
            "type": "exit", "order_id": order_id, "reason": reason, "side": side,
            "eligible_at_ms": eligible,
        }
        self._emit("exit_triggered", time_ms, {
            "order_id": order_id, "reason": reason, "detail": detail,
            "mark": None if mark is None else _s(mark),
        })
        self._emit("order_created", time_ms, {
            "order_id": order_id, "type": "exit", "side": "sell" if side == "long" else "buy",
            "reduce_only": True, "quantity": self.trade["quantity"], "eligible_at_ms": eligible,
        })

    # -- verdicts --------------------------------------------------------------

    def _on_verdict(self, time_ms, item):
        verdict = item["data"]
        if self.trade is not None and self.pending is None:
            self._strategy_exit(time_ms, verdict)
        if verdict.get("action") in ("LONG", "SHORT"):
            self._consider_entry(time_ms, verdict)

    def _strategy_exit(self, time_ms, verdict):
        trade = self.trade
        lag = verdict.get("knowledge_lag_ms")
        known_at = verdict.get("decision_known_at_ms")
        if (not isinstance(lag, int) or lag > self.max_lag or not isinstance(known_at, int)
                or known_at < trade["opened_at_ms"]):
            return
        features = verdict.get("features") or {}
        invalidation = trade["invalidation"]
        frozen_invalidation = _frozen_level(invalidation)
        if trade["strategy_id"] == C27_STRATEGY_ID and frozen_invalidation is None:
            # Never silent: the position stays managed by stop, target and time stop.
            self._emit("verdict_considered", time_ms, {
                "phase": "exit", "outcome": "skipped", "reason": INVALIDATION_UNAVAILABLE,
                "bucket_start_ms": verdict.get("bucket_start_ms"), "action": verdict.get("action"),
                "strategy_id": trade["strategy_id"], "order_id": trade["order_id"],
                "invalidation": invalidation, "knowledge_lag_ms": lag, "causes": [],
            })
            return
        try:
            proposal = propose(
                trade["strategy_id"], features.get("1m"), previous=features.get("1m_previous"),
                trend=features.get("5m"), regime=verdict.get("regime", "unknown"),
                delegated_strategy_id=trade["delegated_strategy_id"],
                position_side="LONG" if trade["side"] == "long" else "SHORT",
                frozen_target=trade["target"], frozen_invalidation=frozen_invalidation,
            )
        except ValueError as error:
            # Malformed features are recorded, not swallowed; other exits keep managing the trade.
            self._emit("verdict_considered", time_ms, {
                "phase": "exit", "outcome": "skipped", "reason": "exit_evaluation_failed",
                "detail": str(error), "bucket_start_ms": verdict.get("bucket_start_ms"),
                "action": verdict.get("action"), "strategy_id": trade["strategy_id"],
                "order_id": trade["order_id"], "knowledge_lag_ms": lag, "causes": [],
            })
            return
        if proposal["action"] == "FLAT":
            self._trigger_exit(time_ms, "strategy_exit", proposal["reason_code"], None)

    def _consider_entry(self, time_ms, verdict):
        selected = verdict.get("selected") or {}
        signal_key = selected.get("signal_key")
        report = {
            "bucket_start_ms": verdict.get("bucket_start_ms"), "action": verdict["action"],
            "strategy_id": selected.get("strategy_id"),
            "delegated_strategy_id": selected.get("delegated_strategy_id"),
            "signal_key": signal_key, "knowledge_lag_ms": verdict.get("knowledge_lag_ms"),
            "delivery_lag_ms": (time_ms - verdict["decision_known_at_ms"]
                                if isinstance(verdict.get("decision_known_at_ms"), int) else None),
            "causes": [],
        }
        lag = verdict.get("knowledge_lag_ms")
        known_at = verdict.get("decision_known_at_ms")
        if (not isinstance(signal_key, str) or not isinstance(selected.get("strategy_id"), str)
                or selected.get("proposed_stop") is None or selected.get("proposed_target") is None):
            reason = "verdict_malformed"
        elif not isinstance(lag, int) or lag > self.max_lag:
            reason = "verdict_stale"
        elif not isinstance(known_at, int) or time_ms - known_at > self.max_lag:
            # Fresh candles but written late (C catching up after a start): the
            # entry would fill at a ticker long after the signal's close.
            reason = "verdict_late"
        elif selected["strategy_id"] == C27_STRATEGY_ID and _frozen_level(selected.get("invalidation")) is None:
            reason = INVALIDATION_UNAVAILABLE
        elif signal_key in self._consumed_set:
            reason = "signal_already_consumed"
        elif self.trade is not None:
            reason = "position_open"
        else:
            report["causes"] = self.gate_causes(time_ms)
            reason = report["causes"][0] if report["causes"] else None
        if reason is not None:
            self._emit("verdict_considered", time_ms, dict(report, outcome="skipped", reason=reason))
            return
        side = "long" if verdict["action"] == "LONG" else "short"
        order_id = self._order_id()
        eligible = time_ms + self.latency
        self.pending = {
            "type": "entry", "order_id": order_id, "side": side, "eligible_at_ms": eligible,
            "expires_at_ms": eligible + self.max_wait, "signal_key": signal_key,
            "strategy_id": selected["strategy_id"],
            "delegated_strategy_id": selected.get("delegated_strategy_id"),
            "stop": selected["proposed_stop"], "target": selected["proposed_target"],
            "invalidation": selected.get("invalidation"),
        }
        self.consumed.append(signal_key)
        self._consumed_set.add(signal_key)
        if len(self.consumed) > CONSUMED_SIGNALS_KEPT:
            self._consumed_set.discard(self.consumed.pop(0))
        self._emit("verdict_considered", time_ms, dict(report, outcome="entered", reason=None))
        self._emit("order_created", time_ms, {
            "order_id": order_id, "type": "entry", "side": "buy" if side == "long" else "sell",
            "order_type": "market_ioc", "eligible_at_ms": eligible,
            "expires_at_ms": eligible + self.max_wait, "signal_key": signal_key,
            "strategy_id": selected["strategy_id"], "stop": selected["proposed_stop"],
            "target": selected["proposed_target"],
        })

    # -- funding ---------------------------------------------------------------

    def _on_funding(self, time_ms, item):
        data = item["data"]
        if data["unit"] != FUNDING_UNIT or _dec(data["rate"]) is None or data["end_ms"] <= data["start_ms"]:
            return
        self.funding_periods.append([data["start_ms"], data["end_ms"], _s(data["rate"]), time_ms])
        del self.funding_periods[:-FUNDING_PERIODS_KEPT]
        if self.latest_funding_end is None or data["end_ms"] > self.latest_funding_end:
            self.latest_funding_end = data["end_ms"]
        position = self.ledger.position
        if position is not None and data["end_ms"] > position["funding_cursor_ms"]:
            self._accrue(data["end_ms"], force_event=True, time_ms=time_ms)

    def _accrue(self, until_ms, force_event, time_ms=None):
        """Accrues funding known by now on the open position up to ``until_ms``."""
        ledger = self.ledger
        position = ledger.position
        if position is None:
            return ZERO
        cursor = position["funding_cursor_ms"]
        if until_ms <= cursor:
            return ZERO
        ledger.funding_rates = []
        ledger.accrued = set()
        for start, end, rate, _ in self.funding_periods:
            if end > cursor and start < until_ms:
                try:
                    ledger.observe_funding(str(start), start, end, rate)
                except ValueError:
                    ledger.funding_complete = False
        amount = ledger.accrue_funding(cursor, until_ms)
        if force_event or amount != 0:
            self._emit("funding_accrued", until_ms if time_ms is None else time_ms, {
                "from_ms": cursor, "to_ms": until_ms, "funding_paid": _s(amount),
                "funding_complete": ledger.funding_complete, "account": self._account_block(),
            })
        return amount


# --------------------------------------------------------------------------- input DBs


def _file_identity(path):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


class _Reader:
    """A persistent read-only connection to one input DB."""

    tables = ()

    def __init__(self, path, timeout_s):
        self.path = path
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=timeout_s)
        self.identity = _file_identity(path)
        self._available = False

    @property
    def available(self):
        if not self._available:
            marks = ",".join("?" * len(self.tables))
            found = self.db.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ({})".format(marks),
                self.tables,
            ).fetchone()[0]
            self._available = found == len(self.tables)
        return self._available

    def replaced(self):
        return _file_identity(self.path) != self.identity

    def close(self):
        try:
            self.db.close()
        except sqlite3.Error:
            pass


class _MarketReader(_Reader):
    tables = ("paper_futures_market_events", "paper_futures_funding_periods")

    def probe_ticker(self):
        return self.db.execute("SELECT MAX(rowid) FROM paper_futures_market_events").fetchone()[0]

    def fetch_tickers(self, after, upto, limit):
        return self.db.execute(
            "SELECT rowid, received_at, normalized_json FROM paper_futures_market_events "
            "WHERE rowid>? AND rowid<=? AND feed='ticker' ORDER BY rowid LIMIT ?",
            (after, upto, limit),
        ).fetchall()

    def probe_funding(self):
        return self.db.execute("SELECT MAX(rowid) FROM paper_futures_funding_periods").fetchone()[0]

    def fetch_funding(self, after_rowid, upto_rowid, after_start):
        return self.db.execute(
            "SELECT start_ms, end_ms, funding_rate, known_at, unit FROM paper_futures_funding_periods "
            "WHERE rowid>? AND rowid<=? AND start_ms>? ORDER BY start_ms, known_at, rowid",
            (after_rowid, upto_rowid, after_start),
        ).fetchall()


# Paper execution trades the BTC perpetual only; the verdicts DB also holds the
# other PF_* products' verdict streams (research/forecasting), which D ignores.
VERDICT_PRODUCT = "PF_XBTUSD"


class _VerdictReader(_Reader):
    tables = ("paper_futures_verdicts",)

    def probe(self):
        return self.db.execute(
            "SELECT MAX(bucket_start) FROM paper_futures_verdicts WHERE product_id=?", (VERDICT_PRODUCT,)
        ).fetchone()[0]

    def fetch(self, after, upto, limit):
        return self.db.execute(
            "SELECT bucket_start, written_at, payload_json FROM paper_futures_verdicts "
            "WHERE product_id=? AND bucket_start>? AND bucket_start<=? ORDER BY bucket_start LIMIT ?",
            (VERDICT_PRODUCT, after, upto, limit),
        ).fetchall()


class _Source:
    """Cursor plus read-ahead buffer of one input stream.

    The persisted cursor only covers popped items; buffered but unprocessed
    items are re-read after a restart.
    """

    kind = None

    def __init__(self, cursor):
        self.buffer = deque()
        self.cursor = cursor.get("cursor", -1)
        self.time = cursor.get("time", 0)
        self.scan = self.cursor
        self._read_time = self.time

    def _clamp(self, time_ms):
        self._read_time = max(self._read_time, time_ms)
        return self._read_time

    def peek(self, reader, horizon):
        if not self.buffer:
            self.refill(reader)
        if not self.buffer:
            return None
        item = self.buffer[0]
        if horizon is not None and item["time"] > horizon:
            return None
        return item

    def pop(self):
        item = self.buffer.popleft()
        self.cursor = item["id"]
        self.time = item["time"]
        return item

    def state(self):
        return {"cursor": self.cursor, "time": self.time}


class _TickerSource(_Source):
    kind = "ticker"

    def refill(self, reader):
        upto = reader.probe_ticker()
        if upto is None or upto <= self.scan:
            return
        rows = reader.fetch_tickers(self.scan, upto, READ_BATCH)
        self.scan = rows[-1][0] if len(rows) == READ_BATCH else upto
        for rowid, received_at, normalized in rows:
            try:
                parsed = _json(normalized)
                raw = parsed.get("raw") or {}
                data = {
                    "bid": parsed.get("bid"), "ask": parsed.get("ask"), "mark": parsed.get("mark"),
                    "bid_size": raw.get("bid_size"), "ask_size": raw.get("ask_size"),
                }
            except (ValueError, AttributeError):
                data = {"bid": None, "ask": None, "mark": None, "bid_size": None, "ask_size": None}
            self.buffer.append({"kind": "ticker", "time": self._clamp(received_at), "id": rowid, "data": data})


class _VerdictSource(_Source):
    kind = "verdict"

    def refill(self, reader):
        upto = reader.probe()
        if upto is None or upto <= self.scan:
            return
        rows = reader.fetch(self.scan, upto, 200)
        self.scan = rows[-1][0] if len(rows) == 200 else upto
        for bucket_start, written_at, payload in rows:
            try:
                data = _json(payload)
            except ValueError:
                data = {"action": "WAIT"}
            self.buffer.append({
                "kind": "verdict", "time": self._clamp(written_at), "id": bucket_start, "data": data,
            })


class _FundingSource(_Source):
    kind = "funding"

    def __init__(self, cursor):
        super().__init__(cursor)
        self.rowid = cursor.get("rowid", 0)
        self.scan_rowid = self.rowid

    def refill(self, reader):
        upto = reader.probe_funding()
        if upto is None or upto <= self.scan_rowid:
            return
        rows = reader.fetch_funding(self.rowid, upto, self.cursor)
        self.scan_rowid = upto
        seen = set()
        for start, end, rate, known_at, unit in rows:
            if start in seen:
                continue  # the same period repeats across responses: first-known row wins
            seen.add(start)
            data = {"start_ms": start, "end_ms": end, "rate": rate, "known_at": known_at, "unit": unit}
            self.buffer.append({
                "kind": "funding", "time": self._clamp(max(end, known_at)), "id": start, "data": data,
            })
        if not self.buffer:
            self.rowid = upto

    def pop(self):
        item = super().pop()
        if not self.buffer:
            self.rowid = self.scan_rowid
        return item

    def state(self):
        return {"cursor": self.cursor, "time": self.time, "rowid": self.rowid}


# --------------------------------------------------------------------------- service


class PaperExecutionService:
    """Poll loop: merges the three inputs in event-time order into the engine.

    Survives a missing, locked or recreated input DB without raising; while an
    input is unavailable nothing is processed, so the total order is preserved.
    """

    def __init__(self, market_db_path, verdicts_db_path, store, log=print, horizon_margin_ms=2000,
                 snapshot_every_events=50, snapshot_interval_ms=300_000, busy_timeout_s=1.0):
        self.market_db_path = market_db_path
        self.verdicts_db_path = verdicts_db_path
        self.store = store
        self.log = log
        self.horizon_margin_ms = horizon_margin_ms
        self.busy_timeout_s = busy_timeout_s
        self.market = None
        self.verdict_reader = None
        self._trace = None
        self._unavailable = None
        self.processed_total = 0
        engine_state, cursors = store.restored if store.restored is not None else (None, {})
        self.engine = PaperExecutionEngine(
            store.config, store, state=engine_state, snapshot_every_events=snapshot_every_events,
            snapshot_interval_ms=snapshot_interval_ms,
        )
        self.funding = _FundingSource(cursors.get("funding", {}))
        self.verdicts = _VerdictSource(cursors.get("verdicts", {}))
        self.tickers = _TickerSource(cursors.get("tickers", {}))

    @property
    def on_trace(self):
        return self._trace

    @on_trace.setter
    def on_trace(self, callback):
        self._trace = callback
        for reader in (self.market, self.verdict_reader):
            if reader is not None:
                reader.db.set_trace_callback(callback)

    def _cursors(self):
        return {
            "funding": self.funding.state(), "verdicts": self.verdicts.state(),
            "tickers": self.tickers.state(),
        }

    def _drop(self):
        for reader in (self.market, self.verdict_reader):
            if reader is not None:
                reader.close()
        self.market = None
        self.verdict_reader = None

    def _note_unavailable(self, message):
        if message != self._unavailable:
            self.log("input DB unavailable: {}".format(message))
            self._unavailable = message

    def _ensure_readers(self):
        if self.market is not None and self.market.replaced():
            self._drop()
        if self.verdict_reader is not None and self.verdict_reader.replaced():
            self._drop()
        if self.market is None:
            self.market = _MarketReader(self.market_db_path, self.busy_timeout_s)
            self.market.db.set_trace_callback(self._trace)
        if self.verdict_reader is None:
            self.verdict_reader = _VerdictReader(self.verdicts_db_path, self.busy_timeout_s)
            self.verdict_reader.db.set_trace_callback(self._trace)
        for name, reader in (("market", self.market), ("verdicts", self.verdict_reader)):
            if not reader.available:
                raise sqlite3.OperationalError("{} DB has no tables yet".format(name))

    def _drain(self, horizon, limit):
        sources = (self.funding, self.verdicts, self.tickers)
        readers = (self.market, self.verdict_reader, self.market)
        engine = self.engine
        done = 0
        while done < limit:
            best = None
            for index in range(3):
                item = sources[index].peek(readers[index], horizon)
                if item is None:
                    continue
                key = (item["time"], index, item["id"])
                if best is None or key < best[0]:
                    best = (key, index, item)
            if best is None:
                break
            sources[best[1]].pop()
            engine.process(best[2])
            engine.after_item(best[2]["time"], self._cursors)
            done += 1
            self.processed_total += 1
        return done

    def poll(self, now_ms=None):
        """Processes every input item inside the horizon; returns how many.

        ``now_ms=None`` is a replay: everything available is processed.
        """
        horizon = None if now_ms is None else now_ms - self.horizon_margin_ms
        before = self.processed_total
        try:
            self._ensure_readers()
            while self._drain(horizon, DRAIN_CHUNK) == DRAIN_CHUNK:
                self.store.flush()
            self._unavailable = None
        except sqlite3.Error as error:
            self._drop()
            self._note_unavailable(str(error))
        self.store.flush()
        for seq, kind, time_ms, body in self.store.take_new_events():
            self.log("paper #{} {} t={} {}".format(seq, kind, time_ms, canonical_json(body)))
        return self.processed_total - before

    def close(self):
        self._drop()


def process_available(market_db_path, verdicts_db_path, store, **service_kwargs):
    """Replay: processes every available input item; returns the item count."""
    service_kwargs.setdefault("log", lambda line: None)
    service = PaperExecutionService(market_db_path, verdicts_db_path, store, **service_kwargs)
    try:
        return service.poll()
    finally:
        service.close()


def run(market_db_path, verdicts_db_path, account_db_path, poll_seconds=1.0, log=print):
    """Long-running service loop."""
    store = AccountStore(account_db_path, PAPER_EXECUTION_CONFIG)
    log("paper execution writing to {} (config {}, head seq {})".format(
        account_db_path, store.config_hash[:12], store.head_seq))
    service = PaperExecutionService(market_db_path, verdicts_db_path, store, log=log)
    try:
        while True:
            # Keep draining a large backlog; otherwise poll once per interval.
            if service.poll(now_ms=int(time.time() * 1000)) < DRAIN_CHUNK:
                time.sleep(poll_seconds)
    finally:
        service.close()
        store.close()


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Balancita futures paper execution (D)")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--verdicts-db", required=True)
    parser.add_argument("--account-db", required=True)
    parser.add_argument("--once", action="store_true", help="process everything available and exit (replay)")
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    args = parser.parse_args(argv)
    if args.once:
        store = AccountStore(args.account_db, PAPER_EXECUTION_CONFIG)
        try:
            count = process_available(args.market_db, args.verdicts_db, store)
            print("paper execution processed {} inputs, head seq {}".format(count, store.head_seq))
        finally:
            store.close()
        return 0
    try:
        run(args.market_db, args.verdicts_db, args.account_db, args.poll_seconds,
            log=lambda line: print(line, flush=True))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
