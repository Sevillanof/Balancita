"""Persistent JSONL worker for isolated paper-futures ledger fixtures."""

import json
import sys
from copy import deepcopy
from decimal import Decimal, localcontext

from .futures_ledger import FuturesLedger, normalize_decimal
from .futures_runtime import FuturesRuntime

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 1_048_576


def _emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def _validate_identity(message):
    if message.get("protocol_version") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol_version")
    for key in ("request_id", "run_id", "work_id"):
        if not isinstance(message.get(key), str) or not message[key] or len(message[key]) > 128:
            raise ValueError("invalid " + key)


def _work(message):
    _validate_identity(message)
    allowed = {"type", "protocol_version", "request_id", "run_id", "work_id",
               "expected_state_version", "payload", "checkpoint"}
    if set(message) - allowed or not {"type", "protocol_version", "request_id", "run_id",
                                      "work_id", "expected_state_version", "payload"} <= set(message):
        raise ValueError("work message contains unsupported fields")
    version = message.get("expected_state_version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 0 or version >= 2**53:
        raise ValueError("invalid expected_state_version")
    payload = message.get("payload")
    if isinstance(payload, dict) and payload.get("operation") == "futures_runtime.v1":
        if set(payload) - {"operation", "runtime_config", "instrument", "market_snapshot", "control"}:
            raise ValueError("runtime payload contains unsupported fields")
        if (
            not isinstance(payload.get("runtime_config"), dict)
            or not isinstance(payload.get("instrument"), dict)
            or not isinstance(payload.get("market_snapshot"), dict)
            or ("control" in payload and not isinstance(payload["control"], dict))
        ):
            raise ValueError("invalid runtime payload")
        checkpoint = message.get("checkpoint")
        if checkpoint is not None and not isinstance(checkpoint, dict):
            raise ValueError("runtime checkpoint must be an object or null")
        runtime = FuturesRuntime(
            run_id=message["run_id"],
            config=payload["runtime_config"],
            instrument=payload["instrument"],
            checkpoint=checkpoint,
        )
        output = runtime.process(
            payload["market_snapshot"], control=payload.get("control")
        )
        next_checkpoint = runtime.checkpoint()
        previous_accrued = {
            tuple(item) for item in (checkpoint or {}).get("accrued", [])
        }
        prior_position = (checkpoint or {}).get("ledger_position")
        position_side = (
            prior_position.get("side") if isinstance(prior_position, dict)
            else next_checkpoint.get("ledger_position", {}).get("side")
            if isinstance(next_checkpoint.get("ledger_position"), dict) else None
        )
        rates = {item[0]: item for item in next_checkpoint["funding_rates"]}
        funding_events = []
        for item in next_checkpoint["accrued"]:
            if tuple(item) in previous_accrued:
                continue
            identifier, start, end, quantity = item
            rate_item = rates.get(identifier)
            if rate_item is None or position_side not in ("long", "short"):
                raise ValueError("accrued funding is missing its source rate or position side")
            rate = Decimal(rate_item[3])
            with localcontext() as context:
                context.prec = 50
                amount = rate * Decimal(end - start) / Decimal(3_600_000) * Decimal(quantity)
                if position_side == "short":
                    amount = -amount
            funding_events.append({
                "interval_id": identifier, "start_time_ms": start,
                "end_time_ms": end, "rate_usd_per_btc_hour": rate_item[3],
                "amount_usd": normalize_decimal(str(amount)),
                "position_side": position_side, "quantity_btc": quantity,
            })
        with localcontext() as context:
            context.prec = 50
            previous_paid = Decimal((checkpoint or {}).get("funding_paid", "0"))
            funding_delta = Decimal(next_checkpoint["funding_paid"]) - previous_paid
            event_total = sum(
                (Decimal(item["amount_usd"]) for item in funding_events), Decimal("0")
            )
        if event_total != funding_delta:
            raise ValueError("funding audit delta does not reconcile to the runtime ledger")
        return {
            "type": "result",
            "protocol_version": PROTOCOL_VERSION,
            "request_id": message["request_id"],
            "run_id": message["run_id"],
            "work_id": message["work_id"],
            "expected_state_version": version,
            "applied_state_version": version + 1,
            "operation": "futures_runtime.v1",
            "result": output["ledger"],
            "events": [],
            "runtime_output": output,
            "runtime_checkpoint": next_checkpoint,
            "runtime_event_time_ms": payload["market_snapshot"]["decision_time_ms"],
            "runtime_funding_events": funding_events,
        }
    if not isinstance(payload, dict) or set(payload) - {
            "operation", "cash_usd", "leverage", "side", "quantity_btc", "entry_price",
            "exit_price", "opened_at_ms", "closed_at_ms"} or payload.get("operation") != "round_trip":
        raise ValueError("unsupported work payload")
    for key in ("cash_usd", "quantity_btc", "entry_price", "exit_price"):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) > 128:
            raise ValueError("invalid decimal field: " + key)
    for key in ("opened_at_ms", "closed_at_ms"):
        value = payload.get(key, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value >= 2**53:
            raise ValueError("invalid timestamp: " + key)
    ledger = _restore_ledger(payload, message.get("checkpoint"))
    event_start = len(ledger.events)
    opened_at = payload.get("opened_at_ms", 0)
    closed_at = payload.get("closed_at_ms", opened_at)
    side = payload.get("side")
    qty, entry, exit_price = (payload.get(key) for key in ("quantity_btc", "entry_price", "exit_price"))
    ledger.open(side, qty, entry, "taker", at_ms=opened_at)
    if closed_at > opened_at:
        ledger.accrue_funding(opened_at, closed_at)
    ledger.close(qty, exit_price, "taker", at_ms=closed_at)
    return {
        "type": "result",
        "protocol_version": PROTOCOL_VERSION,
        "request_id": message["request_id"],
        "run_id": message["run_id"],
        "work_id": message["work_id"],
        "expected_state_version": message.get("expected_state_version"),
        "applied_state_version": message.get("expected_state_version", 0) + 1,
        "event_times_ms": {"opened_at_ms": opened_at, "closed_at_ms": closed_at},
        "result": ledger.snapshot(exit_price),
        "events": ledger.events[event_start:],
    }


def _restore_ledger(payload, checkpoint):
    if checkpoint is None:
        return FuturesLedger(payload.get("cash_usd"), payload.get("leverage", "1"))
    if not isinstance(checkpoint, dict) or checkpoint.get("side") is not None or checkpoint.get("quantity_btc") != "0":
        raise ValueError("worker checkpoint must describe a flat futures ledger")
    rates = checkpoint.get("fee_rates")
    if not isinstance(rates, dict) or set(rates) != {"maker", "taker"}:
        raise ValueError("invalid worker checkpoint fee rates")
    config = {
        "version": checkpoint.get("ledger_version"),
        "cost_version": checkpoint.get("cost_version"),
        "precision": checkpoint.get("decimal_precision"),
        "maker": rates["maker"],
        "taker": rates["taker"],
    }
    ledger = FuturesLedger(checkpoint.get("cash_usd"), checkpoint.get("leverage"), config)
    for attribute, key in (("realized_gross", "realized_gross_usd"),
                           ("fees", "fees_usd"), ("funding_paid", "funding_paid")):
        value = checkpoint.get(key)
        if not isinstance(value, str):
            raise ValueError("invalid worker checkpoint amount: " + key)
        setattr(ledger, attribute, Decimal(value))
    if not isinstance(checkpoint.get("funding_complete"), bool) or not isinstance(checkpoint.get("events"), list):
        raise ValueError("invalid worker checkpoint history")
    ledger.funding_complete = checkpoint["funding_complete"]
    ledger.events = deepcopy(checkpoint["events"])
    return ledger


def main():
    _emit({"type": "ready", "protocol_version": PROTOCOL_VERSION, "worker": "futures-ledger.v1"})
    while True:
        message = None
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            return 0
        if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
            _emit({"type": "error", "protocol_version": PROTOCOL_VERSION, "error": "oversized_or_unterminated_line"})
            return 2
        try:
            message = json.loads(raw.decode("utf-8"))
            if not isinstance(message, dict) or not isinstance(message.get("type"), str):
                raise ValueError("message must be an object with type")
            if message["type"] == "shutdown":
                _validate_identity(message)
                if set(message) != {"type", "protocol_version", "request_id", "run_id", "work_id"}:
                    raise ValueError("shutdown message contains unsupported fields")
                _emit({"type": "shutdown", "protocol_version": PROTOCOL_VERSION, "request_id": message["request_id"]})
                return 0
            if message["type"] != "work":
                raise ValueError("unsupported message type")
            result = _work(message)
            _emit(result)
            ack_line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not ack_line or len(ack_line) > MAX_LINE_BYTES or not ack_line.endswith(b"\n"):
                return 3
            ack = json.loads(ack_line.decode("utf-8"))
            if (not isinstance(ack, dict) or ack.get("type") != "ack" or
                    ack.get("status") not in ("committed", "superseded") or
                    ack.get("protocol_version") != PROTOCOL_VERSION or
                    ack.get("request_id") != result["request_id"] or
                    ack.get("run_id") != result["run_id"] or
                    ack.get("work_id") != result["work_id"] or
                    not isinstance(ack.get("applied_state_version"), int) or
                    not isinstance(ack.get("result_hash"), str) or len(ack["result_hash"]) != 64):
                return 4
            _emit({"type": "ack", "status": ack["status"], "protocol_version": PROTOCOL_VERSION,
                   "request_id": result["request_id"], "run_id": result["run_id"],
                   "work_id": result["work_id"], "applied_state_version": ack["applied_state_version"],
                   "result_hash": ack["result_hash"]})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError, ArithmeticError) as error:
            _emit({"type": "error", "protocol_version": PROTOCOL_VERSION,
                   "request_id": message.get("request_id") if isinstance(message, dict) else None,
                   "error": str(error)[:512]})


if __name__ == "__main__":
    raise SystemExit(main())
