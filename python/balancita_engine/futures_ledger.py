"""Pure Decimal linear USD-settled BTC paper-futures ledger."""
from decimal import Decimal, InvalidOperation, localcontext

from .canonical import normalize_decimal, normalize_timestamp_ms

ZERO = Decimal(0)
COST_VERSION = "kraken-futures-eea-btcusd-base.v1"
FEES = {"maker": Decimal("0.0002"), "taker": Decimal("0.0005")}
LEDGER_VERSION = "linear-usd-ledger.v1"
DECIMAL_PRECISION = 50


def _d(value, name):
    if not isinstance(value, str):
        raise ValueError("{} must be a decimal string".format(name))
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("{} must be a decimal string".format(name)) from error
    if not result.is_finite():
        raise ValueError("{} must be finite".format(name))
    return result


class FuturesLedger:
    def __init__(self, cash, leverage="1", config=None):
        if config is None:
            config = {}
        if not isinstance(config, dict):
            raise ValueError("ledger config must be a mapping")
        self.version = config.get("version", LEDGER_VERSION)
        self.cost_version = config.get("cost_version", COST_VERSION)
        self.precision = config.get("precision", DECIMAL_PRECISION)
        if not isinstance(self.version, str) or not self.version or not isinstance(self.cost_version, str) or not self.cost_version or isinstance(self.precision, bool) or not isinstance(self.precision, int) or not 28 <= self.precision <= 100:
            raise ValueError("invalid versioned ledger precision configuration")
        self.fee_rates = {name: _d(config.get(name, str(rate)), name) for name, rate in FEES.items()}
        if any(rate < 0 for rate in self.fee_rates.values()):
            raise ValueError("fee rates must be nonnegative")
        with localcontext() as ctx:
            ctx.prec = self.precision
            self.cash = _d(cash, "cash")
            self.leverage = _d(leverage, "leverage")
        if self.cash < 0 or self.leverage <= 0 or self.leverage > 1:
            raise ValueError("cash must be nonnegative and leverage within 1x")
        self.position = None
        self.realized_gross = ZERO
        self.fees = ZERO
        self.funding_paid = ZERO
        self.funding_complete = True
        self.funding_rates = []
        self.accrued = set()
        self.last_accrual_ms = None
        self.events = []

    def open(self, side, quantity, price, liquidity, at_ms=0):
        at_ms = normalize_timestamp_ms(at_ms)
        with localcontext() as ctx:
            ctx.prec = self.precision
            qty, px = _d(quantity, "quantity"), _d(price, "price")
            if self.position is not None or side not in ("long", "short") or qty <= 0 or px <= 0:
                raise ValueError("invalid position opening")
            fee = qty * px * self._fee(liquidity)
            equity = self.cash + self.realized_gross - self.fees - self.funding_paid
            if qty * px / self.leverage + fee > equity:
                raise ValueError("insufficient available margin")
            self.fees += fee
            self.position = {"side": side, "qty": qty, "entry": px,
                             "entry_fee_remaining": fee, "funding_remaining": ZERO,
                             "opened_at": at_ms, "funding_cursor_ms": at_ms}
            self.events.append({"type": "open", "side": side, "qty": normalize_decimal(str(qty)),
                                "price": normalize_decimal(str(px)), "fee": normalize_decimal(str(fee))})

    def close(self, quantity, price, liquidity, at_ms=0):
        at_ms = normalize_timestamp_ms(at_ms)
        with localcontext() as ctx:
            ctx.prec = self.precision
            if self.position is None:
                raise ValueError("no open position")
            qty, px, pos = _d(quantity, "quantity"), _d(price, "price"), self.position
            if qty <= 0 or px <= 0 or qty > pos["qty"]:
                raise ValueError("impossible position reduction")
            if at_ms != pos["funding_cursor_ms"]:
                raise ValueError("funding must be accrued through the position-change time")
            final = qty == pos["qty"]
            fraction = qty / pos["qty"]
            entry_fee = pos["entry_fee_remaining"] if final else pos["entry_fee_remaining"] * fraction
            funding = pos["funding_remaining"] if final else pos["funding_remaining"] * fraction
            exit_fee = qty * px * self._fee(liquidity)
            gross = qty * (px - pos["entry"]) * (1 if pos["side"] == "long" else -1)
            self.realized_gross += gross
            self.fees += exit_fee
            pos["entry_fee_remaining"] -= entry_fee
            pos["funding_remaining"] -= funding
            pos["qty"] -= qty
            if final:
                self.position = None
            self.events.append({"type": "close", "qty": normalize_decimal(str(qty)),
                                "gross": normalize_decimal(str(gross)),
                                "allocated_entry_fee": normalize_decimal(str(entry_fee)),
                                "exit_fee": normalize_decimal(str(exit_fee)),
                                "allocated_funding": normalize_decimal(str(funding))})
            return gross - entry_fee - exit_fee - funding

    def observe_funding(self, interval_id, start_ms, end_ms, rate, known_at_ms=None):
        start_ms, end_ms = normalize_timestamp_ms(start_ms), normalize_timestamp_ms(end_ms)
        if known_at_ms is not None:
            known_at_ms = normalize_timestamp_ms(known_at_ms)
        value = _d(rate, "funding rate")
        if start_ms < 0 or end_ms <= start_ms or (known_at_ms is not None and known_at_ms > start_ms):
            raise ValueError("invalid or look-ahead funding interval")
        record = (interval_id, start_ms, end_ms, value)
        for existing in self.funding_rates:
            if existing[0] == interval_id:
                if existing != record:
                    raise ValueError("conflicting funding interval retry")
                return
            if start_ms < existing[2] and end_ms > existing[1]:
                raise ValueError("overlapping funding interval")
        self.funding_rates.append(record)
        self.funding_rates.sort(key=lambda item: item[1])

    def accrue_funding(self, start_ms, end_ms):
        start_ms, end_ms = normalize_timestamp_ms(start_ms), normalize_timestamp_ms(end_ms)
        with localcontext() as ctx:
            ctx.prec = self.precision
            if end_ms <= start_ms:
                raise ValueError("invalid accrual interval")
            if self.last_accrual_ms is not None and start_ms < self.last_accrual_ms:
                raise ValueError("funding accrual cannot overlap or retry")
            pos = self.position
            if pos is None:
                self.last_accrual_ms = end_ms
                return ZERO
            if start_ms != pos["funding_cursor_ms"]:
                raise ValueError("funding accrual must continue at the prior position boundary")
            self.last_accrual_ms = end_ms
            amount = ZERO
            cursor = start_ms
            has_gap = False
            for interval_id, left, right, rate in self.funding_rates:
                a, b = max(start_ms, left), min(end_ms, right)
                if b <= a:
                    continue
                if a > cursor:
                    has_gap = True
                hours = Decimal(b - a) / Decimal(3_600_000)
                side_sign = 1 if pos["side"] == "long" else -1
                part = rate * hours * pos["qty"] * side_sign
                amount += part
                cursor = max(cursor, b)
                key = (interval_id, a, b, pos["qty"])
                if key in self.accrued:
                    raise ValueError("funding accrual was already applied")
                self.accrued.add(key)
            if cursor < end_ms:
                has_gap = True
            self.funding_complete = self.funding_complete and not has_gap
            self.funding_paid += amount
            pos["funding_remaining"] += amount
            pos["funding_cursor_ms"] = end_ms
            return amount

    def _fee(self, liquidity):
        if liquidity not in FEES:
            raise ValueError("liquidity must be maker or taker")
        return self.fee_rates[liquidity]

    def snapshot(self, mark_price):
        with localcontext() as ctx:
            ctx.prec = self.precision
            mark = _d(mark_price, "mark price")
            if mark <= 0:
                raise ValueError("mark price must be positive")
            pos = self.position
            upnl = ZERO if pos is None else pos["qty"] * (mark - pos["entry"]) * (1 if pos["side"] == "long" else -1)
            reserved = ZERO if pos is None else pos["qty"] * mark / self.leverage
            equity = self.cash + self.realized_gross + upnl - self.fees - self.funding_paid
            net = self.realized_gross - self.fees - self.funding_paid if self.funding_complete and pos is None else None
            realized_net = self.realized_gross - self.fees - self.funding_paid if self.funding_complete and pos is None else None
            return {"ledger_version": self.version, "decimal_precision": self.precision,
                    "fee_rates": {key: normalize_decimal(str(value)) for key, value in self.fee_rates.items()},
                    "cash_usd": normalize_decimal(str(self.cash)), "side": None if pos is None else pos["side"],
                    "quantity_btc": "0" if pos is None else normalize_decimal(str(pos["qty"])),
                    "mark_usd_per_btc": normalize_decimal(str(mark)), "unrealized_gross_usd": normalize_decimal(str(upnl)),
                    "reserved_margin_usd": normalize_decimal(str(reserved)),
                    "available_margin_usd": normalize_decimal(str(equity - reserved)),
                    "equity_usd": normalize_decimal(str(equity)), "realized_gross_usd": normalize_decimal(str(self.realized_gross)),
                    "fees_usd": normalize_decimal(str(self.fees)), "funding_paid": normalize_decimal(str(self.funding_paid)),
                    "net_complete": None if net is None else normalize_decimal(str(net)),
                    "realized_net_complete": None if realized_net is None else normalize_decimal(str(realized_net)),
                    "funding_complete": self.funding_complete, "cost_version": self.cost_version,
                    "leverage": normalize_decimal(str(self.leverage)), "events": list(self.events)}
