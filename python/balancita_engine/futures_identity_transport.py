"""Bounded job-scoped read-only identity RPC over the worker's JSONL streams."""

import json

PROTOCOL_VERSION = 1
MAX_KEYS = 128
MAX_BYTES = 1_048_576
MAX_QUERIES = 1024
KINDS = frozenset(("order", "cancel", "trade", "book_budget", "trade_budget", "order_trade", "ledger_fill", "ledger_funding", "ledger_accrual", "signal"))


class IdentityTransportError(ValueError):
    pass


class JobIdentityClient:
    """One-job synchronous RPC client; context must come from the accepted work."""

    def __init__(self, reader, writer, binding):
        self.reader, self.writer, self.binding = reader, writer, dict(binding)
        self.sequence = 0

    def query(self, kind, keys, *, operation="lookup", from_ms=None, to_ms=None, knowledge_cutoff_ms=None):
        if kind not in KINDS or not isinstance(keys, list) or len(keys) > MAX_KEYS:
            raise IdentityTransportError("invalid identity query kind or batch")
        if self.sequence >= MAX_QUERIES:
            raise IdentityTransportError("job identity query budget exhausted")
        if operation not in ("lookup", "funding_range"):
            raise IdentityTransportError("unsupported identity query operation")
        if operation == "funding_range" and not all(isinstance(v, int) and not isinstance(v, bool) for v in (from_ms, to_ms, knowledge_cutoff_ms)):
            raise IdentityTransportError("invalid funding range")
        if any(not isinstance(key, str) or not key or len(key.encode("utf-8")) > 4096 for key in keys) or len(set(keys)) != len(keys):
            raise IdentityTransportError("invalid or duplicate identity key")
        if knowledge_cutoff_ms is None:
            knowledge_cutoff_ms = self.binding.get("knowledge_cutoff_ms")
        self.sequence += 1
        message = {"type": "identity_query", "protocol_version": PROTOCOL_VERSION, **self.binding,
                   "query_sequence": self.sequence, "operation": operation, "kind": kind, "keys": keys,
                   "from_ms": from_ms, "to_ms": to_ms, "knowledge_cutoff_ms": knowledge_cutoff_ms}
        line = json.dumps(message, separators=(",", ":"), allow_nan=False) + "\n"
        if len(line.encode("utf-8")) > MAX_BYTES:
            raise IdentityTransportError("identity query exceeds line limit")
        self.writer.write(line)
        self.writer.flush()
        raw = self.reader.readline(MAX_BYTES + 1)
        if not raw or len(raw.encode("utf-8")) > MAX_BYTES or not raw.endswith("\n"):
            raise IdentityTransportError("missing or oversized identity reply")
        try:
            reply = json.loads(raw)
        except (ValueError, TypeError) as error:
            raise IdentityTransportError("malformed identity reply") from error
        echo = ("protocol_version", "request_id", "run_id", "work_id", "expected_state_version", "checkpoint_hash", "source_frontier", "query_sequence", "knowledge_cutoff_ms", "operation", "kind", "keys", "from_ms", "to_ms")
        if not isinstance(reply, dict) or reply.get("type") != "identity_reply" or any(reply.get(k) != message.get(k) for k in echo):
            raise IdentityTransportError("foreign, replayed, or out-of-order identity reply")
        expected_fields = set(echo) | {"type", "status"}
        if reply.get("status") == "ok":
            expected_fields.add("values")
        if set(reply) != expected_fields:
            raise IdentityTransportError("identity reply contains unsupported fields")
        if reply.get("status") == "unavailable":
            raise IdentityTransportError("identity lookup unavailable")
        values = reply.get("values")
        if reply.get("status") != "ok" or not isinstance(values, list):
            raise IdentityTransportError("invalid identity reply")
        if operation == "funding_range":
            if len(values) > MAX_KEYS or any(
                not isinstance(row, list) or len(row) != 4 or
                not isinstance(row[0], str) or
                isinstance(row[1], bool) or not isinstance(row[1], int) or
                isinstance(row[2], bool) or not isinstance(row[2], int) or
                row[2] <= row[1] or not isinstance(row[3], str)
                for row in values
            ):
                raise IdentityTransportError("invalid funding range rows")
            return values
        if len(values) != len(keys):
            raise IdentityTransportError("identity reply does not match requested keys")
        return values
