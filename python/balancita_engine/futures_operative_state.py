"""Exact job-scoped identity port for operative paper-execution checkpoints.

The owner supplies committed lookups and a provisional update sink. The sink
must not publish updates until its owning durable transaction commits.
"""
import json
from copy import deepcopy


class ExactIdentityPort:
    """Exact-key identity lookup with isolated pending updates."""

    KINDS = frozenset({"order", "cancel", "trade", "book_budget", "trade_budget", "order_trade"})

    def __init__(self, committed, pending=None):
        if not callable(committed) or not callable(pending):
            raise ValueError("identity port requires committed lookup and provisional update callbacks")
        self._committed = committed
        self._pending = pending
        self._updates = []

    @staticmethod
    def canonical_key(kind, key):
        if kind not in ExactIdentityPort.KINDS or not isinstance(key, str) or not key:
            raise ValueError("unsupported operative identity kind or key")
        if kind in ("book_budget", "order_trade"):
            try:
                decoded = json.loads(key)
            except (TypeError, ValueError) as error:
                raise ValueError("operative composite identity key is malformed") from error
            expected_length = 5 if kind == "book_budget" else 2
            if (
                not isinstance(decoded, list)
                or len(decoded) != expected_length
                or any(not isinstance(part, str) or not part for part in decoded)
                or json.dumps(decoded, ensure_ascii=False, separators=(",", ":")) != key
            ):
                raise ValueError("operative composite identity key has invalid shape")
        return key

    def lookup(self, kind, key):
        key = self.canonical_key(kind, key)
        value = self._committed(kind, key)
        return deepcopy(value)

    def stage(self, kind, key, value, *, provenance):
        key = self.canonical_key(kind, key)
        if value is None:
            raise ValueError("operative identity updates cannot erase exact history")
        if not isinstance(provenance, str) or not provenance:
            raise ValueError("operative identity update provenance is required")
        copied = deepcopy(value)
        self._pending(kind, key, deepcopy(copied))
        self._updates.append({"kind": kind, "key": key, "value": copied, "provenance": provenance})

    def drain_updates(self):
        updates, self._updates = self._updates, []
        return deepcopy(updates)
