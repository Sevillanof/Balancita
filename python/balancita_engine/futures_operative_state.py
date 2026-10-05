"""Exact job-scoped identity port for operative paper-execution checkpoints.

The owner supplies committed lookups and a provisional update sink. The sink
must not publish updates until its owning durable transaction commits.
"""
import json
from copy import deepcopy


class OperativeIdentityUnavailableError(RuntimeError):
    """Exact identity storage could not answer; callers must fail closed.

    Deliberately not a ValueError: execution and ledger code treat malformed
    evidence (ValueError) as skippable, but an unreachable identity store must
    never be mistaken for "no historical identity".
    """


def _guarded(call, *args):
    try:
        return call(*args)
    except OperativeIdentityUnavailableError:
        raise
    except Exception as error:
        raise OperativeIdentityUnavailableError("operative identity store is unavailable") from error


class ExactIdentityPort:
    """Exact-key identity lookup with isolated pending updates."""

    KINDS = frozenset({"order", "cancel", "trade", "book_budget", "trade_budget", "order_trade", "signal"})

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
        value = _guarded(self._committed, kind, key)
        return deepcopy(value)

    def stage(self, kind, key, value, *, provenance):
        key = self.canonical_key(kind, key)
        if value is None:
            raise ValueError("operative identity updates cannot erase exact history")
        if not isinstance(provenance, str) or not provenance:
            raise ValueError("operative identity update provenance is required")
        copied = deepcopy(value)
        _guarded(self._pending, kind, key, deepcopy(copied))
        self._updates.append({"kind": kind, "key": key, "value": copied, "provenance": provenance})

    def drain_updates(self):
        updates, self._updates = self._updates, []
        return deepcopy(updates)


class ExactLedgerIdentityPort:
    """Separate exact-key namespace for Python ledger identities (not Node v1 kinds)."""

    KINDS = frozenset({"ledger_fill", "ledger_funding", "ledger_accrual"})

    def __init__(self, committed, pending):
        if not callable(committed) or not callable(pending):
            raise ValueError("ledger identity port requires lookup and provisional update callbacks")
        self._committed, self._pending, self._updates = committed, pending, []

    def lookup(self, kind, key):
        if kind not in self.KINDS or not isinstance(key, str) or not key:
            raise ValueError("unsupported ledger identity kind or key")
        return deepcopy(_guarded(self._committed, kind, key))

    def stage(self, kind, key, value, *, provenance):
        if kind not in self.KINDS or not isinstance(key, str) or not key or value is None:
            raise ValueError("invalid ledger identity update")
        if not isinstance(provenance, str) or not provenance:
            raise ValueError("ledger identity provenance is required")
        record = {"kind": kind, "key": key, "value": deepcopy(value), "provenance": provenance}
        _guarded(self._pending, kind, key, deepcopy(value))
        self._updates.append(record)

    def drain_updates(self):
        updates, self._updates = self._updates, []
        return deepcopy(updates)
