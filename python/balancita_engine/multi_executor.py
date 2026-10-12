"""Paper executor and position manager (PR 100, P0).

The executor is the only component that opens simulated positions, and it opens one only when it redeems an
``Authorization`` the risk engine issued (single use). Accounting is the shared simulator's ``Book`` (fills, taker
fees, per-product impact, funding, gross and net P&L); this module adds no second engine. Open positions are
managed on every closed 1-minute candle by the book itself: stop, target and time stop, plus nothing else. No
selector (Qwen included) takes part, so protections keep working when Qwen is down.

When funding history does not cover a trade, or the product has no measured cost row, the trade is stored with
``net_complete: false`` and a ``net_usd`` of ``null``: the partial figure is kept apart as ``partial_usd`` and is
never summed into a complete net P&L.
"""

from datetime import datetime, timezone
from decimal import Decimal

from .futures_costs import is_measured
from .futures_simulator import Book
from .multi_risk import DAY_MS, RiskError
from .multi_signals import stable_hash

D = Decimal


class AuthorizedBook(Book):
    """A shared-simulator book whose entries come from authorizations and whose exits are only stop/target/time."""

    def __init__(self, key, **kwargs):
        super().__init__({"id": "/".join(str(part) for part in key)}, **kwargs)
        self.key, self.pending, self.entry_meta, self.recorded = key, None, {}, 0

    def arm(self, bucket, authorization):
        self.pending = (bucket, authorization)

    def __getstate__(self):
        # The funding table is shared and rebuilt from the market data on restore, never copied into a checkpoint.
        return dict(self.__dict__, funding=None)

    def _entry_proposal(self, current, common):
        pending, self.pending = self.pending, None
        if pending is None or pending[0] != self.bucket:
            return None
        auth = pending[1]
        self.entry_meta[self.bucket] = {k: auth[k] for k in (
            "auth_id", "decision_id", "signal_id", "strategy_id", "strategy_version", "arm", "scope")}
        return {"action": auth["side"], "strategy_id": auth["strategy_id"], "proposed_stop": auth["stop"],
                "proposed_target": auth["target"], "horizon_minutes": auth["horizon_minutes"],
                "reason_code": "authorized:" + auth["auth_id"], "invalidation": None, "delegated_strategy_id": None}

    def _rule_exit(self, position, current, common, close):
        return None


def _day(ms):
    return ms // DAY_MS


class PaperExecutor:
    def __init__(self, risk, store, *, notional_usd="100", tick_sizes=None, funding=None):
        self.risk, self.store = risk, store
        self.notional, self.tick_sizes, self.funding = notional_usd, tick_sizes or {}, funding or {}
        self.books = {}
        self._sorted_funding = {}

    def shared_funding(self, product_id):
        """One sorted funding table per product, shared by every book (and shadow) of that product."""
        if product_id not in self._sorted_funding:
            self._sorted_funding[product_id] = sorted(
                (int(a), int(b), D(str(r))) for a, b, r in self.funding.get(product_id, ()))
        return self._sorted_funding[product_id]

    def new_book(self, key, notional_usd=None):
        book = AuthorizedBook(key, product_id=key[2], tick_size=self.tick_sizes.get(key[2], "1"),
                              notional_usd=notional_usd or self.notional)
        book.funding = self.shared_funding(key[2])
        return book

    def reattach_funding(self, books):
        for book in books:
            book.funding = self.shared_funding(book.key[2])

    def book(self, key):
        if key not in self.books:
            self.books[key] = self.new_book(key)
        return self.books[key]

    def _scope_books(self, arm, scope):
        return [b for k, b in self.books.items() if k[0] == arm and k[1] == scope]

    def account(self, arm, scope, product_id, now_ms):
        """What the risk engine may know about one account (arm + scope): exposure, realized P&L, drawdown."""
        books = self._scope_books(arm, scope)
        open_notional = sum((D(self.notional) for b in books if b.position is not None), D(0))
        product_book = self.books.get((arm, scope, product_id))
        trades = sorted((t for b in books for t in b.trades), key=lambda t: (t["exit_time_ms"], t["entry_time_ms"]))
        realized = sum((D(str(t["pnl_usd"])) for t in trades), D(0))
        today = sum((D(str(t["pnl_usd"])) for t in trades if _day(t["exit_time_ms"]) == _day(now_ms)), D(0))
        peak = running = D(0)
        drawdown = D(0)
        for trade in trades:
            running += D(str(trade["pnl_usd"]))
            peak = max(peak, running)
            drawdown = max(drawdown, peak - running)
        return {"open_notional_usd": str(open_notional),
                "product_open": product_book is not None and product_book.position is not None,
                "realized_usd": str(realized), "realized_today_usd": str(today), "drawdown_usd": str(drawdown)}

    def submit(self, authorization, bucket, now_ms):
        """Redeems the authorization and arms the entry for the frame ``bucket``. Returns a status dict."""
        try:
            auth = self.risk.redeem(authorization, now_ms)
        except RiskError as error:
            return {"status": "refused", "reason": str(error)}
        book = self.book((auth["arm"], auth["scope"], auth["product_id"]))
        if book.position is not None:
            return {"status": "refused", "reason": "position_already_open"}
        book.arm(bucket, auth)
        return {"status": "armed", "auth_id": auth["auth_id"]}

    def on_frame(self, product_id, frame):
        """Feeds one closed 1m frame to every book of the product; records fills and closes. Returns new trades."""
        bucket = frame[0]
        closed = []
        for key in sorted(k for k in self.books if k[2] == product_id):
            book = self.books[key]
            book.on_frame(*frame)
            position = book.position
            if position is not None and position["opened_bucket"] == bucket and bucket in book.entry_meta:
                meta = book.entry_meta[bucket]
                self.store.put_execution(dict(meta, execution_id=stable_hash([key, bucket, "entry"])[:24], kind="entry",
                                              key=list(key), bucket_ms=bucket, side=position["side"],
                                              price=str(position["entry"]), stop=str(position["stop"]),
                                              target=position["target_text"]))
            while book.recorded < len(book.trades):
                trade = book.trades[book.recorded]
                book.recorded += 1
                closed.append(self._store_trade(key, book, trade))
        return closed

    def _store_trade(self, key, book, trade):
        complete = bool(trade["funding_complete"]) and is_measured(key[2])
        meta = book.entry_meta.get(trade["entry_bucket_ms"], {})
        stored = dict(trade, arm=key[0], scope=key[1], product_id=key[2], meta=meta, net_complete=complete,
                      net_usd=trade["pnl_usd"] if complete else None, partial_usd=trade["pnl_usd"],
                      trade_id=stable_hash([key, trade["entry_bucket_ms"]])[:24])
        stored.pop("pnl_usd")
        self.store.put_trade(stored)
        self.store.put_execution(dict(meta, execution_id=stable_hash([key, trade["entry_bucket_ms"], "exit"])[:24],
                                      kind="exit", key=list(key), bucket_ms=trade["exit_bucket_ms"],
                                      reason=trade["exit_reason"], price=trade["exit_price"],
                                      net_complete=complete))
        return stored

    def open_positions(self):
        return {k: b.position for k, b in self.books.items() if b.position is not None}
