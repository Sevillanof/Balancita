"""Pure Decimal linear USD-settled BTC paper-futures ledger."""
import json
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, localcontext
from types import MappingProxyType

from .canonical import normalize_decimal, normalize_timestamp_ms

ZERO = Decimal(0)
COST_VERSION = "kraken-futures-eea-btcusd-base.v1"
FEES = {"maker": Decimal("0.0002"), "taker": Decimal("0.0005")}
LEDGER_VERSION = "linear-usd-ledger.v1"
DECIMAL_PRECISION = 50


@dataclass(frozen=True)
class LedgerConfiguration:
    version: str
    cost_version: str
    precision: int
    fee_rates: tuple


def _d(value, name):
    if not isinstance(value, str):
        raise ValueError("{} must be a decimal string".format(name))
    try:
        result = Decimal(normalize_decimal(value))
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
        version = config.get("version", LEDGER_VERSION)
        cost_version = config.get("cost_version", COST_VERSION)
        precision = config.get("precision", DECIMAL_PRECISION)
        if not isinstance(version, str) or not version or not isinstance(cost_version, str) or not cost_version or isinstance(precision, bool) or not isinstance(precision, int) or not 28 <= precision <= 100:
            raise ValueError("invalid versioned ledger precision configuration")
        fee_rates = {name: _d(config.get(name, str(rate)), name) for name, rate in FEES.items()}
        if any(rate < 0 for rate in fee_rates.values()):
            raise ValueError("fee rates must be nonnegative")
        self._config = LedgerConfiguration(version, cost_version, precision, tuple(sorted(fee_rates.items())))
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
        self._ledger_identity_port = None
        self._operative_restored = False

    def _ledger_identity(self, kind, key):
        if self._ledger_identity_port is None:
            return None
        return self._ledger_identity_port.lookup(kind, key)

    def _stage_ledger_identity(self, kind, key, value, provenance):
        if self._ledger_identity_port is not None:
            self._ledger_identity_port.stage(kind, key, value, provenance=provenance)

    def drain_operative_identity_updates(self):
        if self._ledger_identity_port is None:
            raise ValueError("operative ledger identity updates require an exact identity port")
        return self._ledger_identity_port.drain_updates()

    def operative_checkpoint(self):
        """Serialize compact current accounting state, not the audit history."""
        clock = (self.position["funding_cursor_ms"] if self.position is not None else self.last_accrual_ms)
        rates = [item for item in self.funding_rates if clock is None or item[2] > clock]
        if len(rates) > 128:
            raise ValueError("operative funding evidence exceeds the bounded catch-up limit")
        return {
            "checkpoint_version": "paper-futures-ledger-operative.v1",
            "config": {"version": self.version, "cost_version": self.cost_version,
                       "precision": self.precision,
                       **{key: normalize_decimal(str(value)) for key, value in self.fee_rates.items()}},
            "cash": normalize_decimal(str(self.cash)),
            "leverage": normalize_decimal(str(self.leverage)),
            "realized_gross": normalize_decimal(str(self.realized_gross)),
            "fees": normalize_decimal(str(self.fees)),
            "funding_paid": normalize_decimal(str(self.funding_paid)),
            "funding_complete": self.funding_complete,
            "position": None if self.position is None else {
                key: normalize_decimal(str(value)) if isinstance(value, Decimal) else value
                for key, value in self.position.items()},
            "last_accrual_ms": self.last_accrual_ms,
            "funding_rates": [[identity, start, end, normalize_decimal(str(rate))]
                              for identity, start, end, rate in rates],
        }

    @classmethod
    def restore_operative(cls, checkpoint, *, identity_port):
        from .futures_operative_state import ExactLedgerIdentityPort
        if not isinstance(identity_port, ExactLedgerIdentityPort):
            raise ValueError("operative ledger restore requires an exact ledger identity port")
        expected = {"checkpoint_version", "config", "cash", "leverage", "realized_gross",
                    "fees", "funding_paid", "funding_complete", "position",
                    "last_accrual_ms", "funding_rates"}
        if not isinstance(checkpoint, dict) or set(checkpoint) != expected or checkpoint.get("checkpoint_version") != "paper-futures-ledger-operative.v1":
            raise ValueError("unsupported operative ledger checkpoint")
        result = cls(checkpoint["cash"], checkpoint["leverage"], checkpoint["config"])
        result._ledger_identity_port = identity_port
        for field in ("realized_gross", "fees", "funding_paid"):
            value = _d(checkpoint[field], field)
            if field != "funding_paid" and value < 0:
                if field == "realized_gross":
                    pass
                else:
                    raise ValueError("operative ledger totals violate sign invariants")
            setattr(result, field, value)
        if not isinstance(checkpoint["funding_complete"], bool):
            raise ValueError("invalid operative funding completeness flag")
        result.funding_complete = checkpoint["funding_complete"]
        pos = checkpoint["position"]
        if pos is not None:
            required_pos = {"side", "qty", "entry", "entry_fee_remaining", "funding_remaining", "opened_at", "funding_cursor_ms"}
            if not isinstance(pos, dict) or set(pos) != required_pos or pos["side"] not in ("long", "short"):
                raise ValueError("invalid operative ledger position")
            restored = dict(pos)
            for key in ("qty", "entry", "entry_fee_remaining", "funding_remaining"):
                restored[key] = _d(restored[key], "position " + key)
            if restored["qty"] <= 0 or restored["entry"] <= 0 or restored["entry_fee_remaining"] < 0:
                raise ValueError("operative ledger position violates quantity or fee invariants")
            restored["opened_at"] = normalize_timestamp_ms(restored["opened_at"])
            restored["funding_cursor_ms"] = normalize_timestamp_ms(restored["funding_cursor_ms"])
            if restored["funding_cursor_ms"] < restored["opened_at"]:
                raise ValueError("operative funding cursor precedes position")
            result.position = restored
        last = checkpoint["last_accrual_ms"]
        result.last_accrual_ms = None if last is None else normalize_timestamp_ms(last)
        raw_rates = checkpoint["funding_rates"]
        if not isinstance(raw_rates, list) or len(raw_rates) > 128:
            raise ValueError("invalid or over-budget operative funding evidence")
        for item in raw_rates:
            if not isinstance(item, list) or len(item) != 4:
                raise ValueError("malformed operative funding evidence")
            start, end = normalize_timestamp_ms(item[1]), normalize_timestamp_ms(item[2])
            rate = _d(item[3], "funding rate")
            if not isinstance(item[0], str) or not item[0] or start < 0 or end <= start:
                raise ValueError("invalid operative funding interval")
            if result.funding_rates and (start < result.funding_rates[-1][2]):
                raise ValueError("overlapping operative funding intervals")
            result.funding_rates.append((item[0], start, end, rate))
        result._operative_restored = True
        return result

    def open(self, side, quantity, price, liquidity, at_ms=0, *, fill_id=None):
        at_ms = normalize_timestamp_ms(at_ms)
        with localcontext() as ctx:
            ctx.prec = self.precision
            qty, px = _d(quantity, "quantity"), _d(price, "price")
            if fill_id is not None:
                payload = {"side": side, "quantity": normalize_decimal(str(qty)), "price": normalize_decimal(str(px)), "liquidity": liquidity, "at_ms": at_ms}
                prior = self._ledger_identity("ledger_fill", fill_id)
                if prior is not None:
                    if prior != payload:
                        raise ValueError("conflicting fill identity retry")
                    return
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
            if fill_id is not None:
                self._stage_ledger_identity("ledger_fill", fill_id, payload, "fill:" + fill_id)

    def close(self, quantity, price, liquidity, at_ms=0, *, fill_id=None):
        at_ms = normalize_timestamp_ms(at_ms)
        with localcontext() as ctx:
            ctx.prec = self.precision
            if self.position is None:
                raise ValueError("no open position")
            qty, px, pos = _d(quantity, "quantity"), _d(price, "price"), self.position
            if fill_id is not None:
                payload = {"quantity": normalize_decimal(str(qty)), "price": normalize_decimal(str(px)), "liquidity": liquidity, "at_ms": at_ms}
                prior = self._ledger_identity("ledger_fill", fill_id)
                if prior is not None:
                    if prior != payload:
                        raise ValueError("conflicting fill identity retry")
                    return ZERO
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
            if fill_id is not None:
                self._stage_ledger_identity("ledger_fill", fill_id, payload, "fill:" + fill_id)
            return gross - entry_fee - exit_fee - funding

    def observe_funding(self, interval_id, start_ms, end_ms, rate, known_at_ms=None):
        start_ms, end_ms = normalize_timestamp_ms(start_ms), normalize_timestamp_ms(end_ms)
        if known_at_ms is not None:
            known_at_ms = normalize_timestamp_ms(known_at_ms)
        value = _d(rate, "funding rate")
        if start_ms < 0 or end_ms <= start_ms or (known_at_ms is not None and known_at_ms > start_ms):
            raise ValueError("invalid or look-ahead funding interval")
        record = (interval_id, start_ms, end_ms, value)
        funding_key = json.dumps([interval_id, start_ms, end_ms], ensure_ascii=False, separators=(",", ":"))
        historical = self._ledger_identity("ledger_funding", funding_key)
        if historical is not None:
            if historical != normalize_decimal(str(value)):
                raise ValueError("conflicting funding interval retry")
            return
        for existing in self.funding_rates:
            if existing[0] == interval_id:
                if existing != record:
                    raise ValueError("conflicting funding interval retry")
                return
            if start_ms < existing[2] and end_ms > existing[1]:
                raise ValueError("overlapping funding interval")
        self.funding_rates.append(record)
        self.funding_rates.sort(key=lambda item: item[1])
        self._stage_ledger_identity("ledger_funding", funding_key, normalize_decimal(str(value)), "funding:" + funding_key)

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
            amount = ZERO
            cursor = start_ms
            has_gap = False
            accrual_identities = []
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
                identity_key = json.dumps([interval_id, a, b, normalize_decimal(str(pos["qty"]))], ensure_ascii=False, separators=(",", ":"))
                historical = self._ledger_identity("ledger_accrual", identity_key)
                if key in self.accrued or historical is not None:
                    raise ValueError("funding accrual was already applied")
                accrual_identities.append((key, identity_key, part))
            if cursor < end_ms:
                has_gap = True
            self.funding_complete = self.funding_complete and not has_gap
            self.funding_paid += amount
            pos["funding_remaining"] += amount
            pos["funding_cursor_ms"] = end_ms
            self.last_accrual_ms = end_ms
            for key, identity_key, part in accrual_identities:
                self.accrued.add(key)
                self._stage_ledger_identity("ledger_accrual", identity_key, normalize_decimal(str(part)), "accrual:" + identity_key)
            return amount

    def _fee(self, liquidity):
        if liquidity not in FEES:
            raise ValueError("liquidity must be maker or taker")
        return self.fee_rates[liquidity]

    @property
    def version(self):
        return self._config.version

    @property
    def cost_version(self):
        return self._config.cost_version

    @property
    def precision(self):
        return self._config.precision

    @property
    def fee_rates(self):
        return MappingProxyType(dict(self._config.fee_rates))

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
                    "leverage": normalize_decimal(str(self.leverage)), "events": deepcopy(self.events)}
