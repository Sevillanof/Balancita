"""Clean delete of a strategy across processes (odd/tasks/strategy-lifecycle.md).

Each process is the single writer of its own SQLite DB, so nobody deletes another process's rows. S (the registry)
writes one small request file per delete into the purge directory; every process that owns rows about a strategy
consumes the request on its next loop, deletes ITS rows and writes its own acknowledgement file. S reads the
acknowledgements to report progress ("borrando..." / "listo") and, once every consumer answered, removes the request
and the acknowledgements so that nothing about the strategy stays on disk.

    <purge_dir>/<purge_id>.request.json        written by S only: {purge_id, strategy_id, spec_hashes, consumers, ...}
    <purge_dir>/<purge_id>.<consumer>.ack.json written by that consumer only: {consumer, done_ms, deleted: {...}}

``PURGE_PAPER_LEDGER`` is the single switch for the append-only paper ledgers (forward trades and their funding
reconciliation, D's hash-chained account). It is OFF: ADR 0001 says those rows are append-only and that deleting a
strategy "keeps its trades". See the TODO(ADR) in ``odd/tasks/strategy-lifecycle.md``.
"""

import json
import os
import re
import sqlite3
import time
import uuid

# TODO(ADR 0001): flip to True only if the user amends the ADR. Conflicting sentences:
#   "Switching a strategy off or deleting it stops new trades and keeps its trades." (Amendment 2026-10-11, Supersedes)
#   "Records are append-only guarded, while projections are reconstructible." (storage) and
#   "D, paper execution (Python): ... hash-chained append-only account DB."
PURGE_PAPER_LEDGER = False

# Single flag: keep, in gate.sqlite, an anonymous exam tombstone (spec_hash, exam date, verdict; no id, name or params)
# so a deleted-and-recreated identical version cannot take the final exam again. Set False to drop it entirely.
KEEP_EXAM_TOMBSTONE = True

PROTECTED_MESSAGE = "Qwen y Kronos solo se pueden quitar desde el código"
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def protected_ids():
    """Ids of the models that act in the real paper: never deletable from the front."""
    ids = {"kronos-small-1h-h4-v1", "c31-qwen-exit-perp-v1"}
    here = os.path.dirname(os.path.abspath(__file__))
    for relative, key in ((("..", "..", "config", "qwen-exit.json"), "strategy_id"),
                          (("..", "..", "config", "models", "kronos-small-1h-h4-v1.json"), "id")):
        try:
            with open(os.path.join(here, *relative), encoding="utf-8") as handle:
                ids.add(json.load(handle)[key])
        except (OSError, ValueError, KeyError):
            pass
    return ids


def is_protected(strategy_id):
    lowered = str(strategy_id).lower()
    return strategy_id in protected_ids() or lowered.startswith(("kronos-", "c31-qwen"))


# --------------------------------------------------------------------------- requests (S writes, consumers read)


def _atomic_json(path, body):
    temporary = path + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, ensure_ascii=False, sort_keys=True)
    os.replace(temporary, path)


def write_request(purge_dir, strategy_id, spec_hashes, consumers, now_ms=None):
    os.makedirs(purge_dir, exist_ok=True)
    purge_id = "{}-{}".format(int((time.time() if now_ms is None else now_ms / 1000) * 1000), uuid.uuid4().hex[:8])
    _atomic_json(os.path.join(purge_dir, purge_id + ".request.json"), {
        "purge_id": purge_id, "strategy_id": strategy_id, "spec_hashes": sorted(spec_hashes),
        "consumers": sorted(consumers), "requested_ms": int(time.time() * 1000 if now_ms is None else now_ms)})
    return purge_id


def _requests(purge_dir):
    try:
        names = sorted(os.listdir(purge_dir))
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".request.json"):
            continue
        try:
            with open(os.path.join(purge_dir, name), encoding="utf-8") as handle:
                out.append(json.load(handle))
        except (OSError, ValueError):
            continue
    return out


def _ack_path(purge_dir, purge_id, consumer):
    return os.path.join(purge_dir, "{}.{}.ack.json".format(purge_id, _SAFE.sub("_", consumer)))


def pending_for(purge_dir, consumer):
    """Requests this consumer has not answered yet (and that name it)."""
    return [r for r in _requests(purge_dir) if consumer in r.get("consumers", [])
            and not os.path.exists(_ack_path(purge_dir, r["purge_id"], consumer))]


def acknowledge(purge_dir, purge_id, consumer, deleted):
    _atomic_json(_ack_path(purge_dir, purge_id, consumer),
                 {"consumer": consumer, "done_ms": int(time.time() * 1000), "deleted": deleted})


def status(purge_dir, purge_id):
    """``{purge_id, state: running|done|unknown, consumers: {name: pending|done}}`` (the request may be gone: done)."""
    for request in _requests(purge_dir):
        if request["purge_id"] == purge_id:
            consumers = {c: ("done" if os.path.exists(_ack_path(purge_dir, purge_id, c)) else "pending")
                         for c in request["consumers"]}
            state = "done" if all(v == "done" for v in consumers.values()) else "running"
            return {"purge_id": purge_id, "state": state, "consumers": consumers,
                    "requested_ms": request["requested_ms"]}
    return {"purge_id": purge_id, "state": "done", "consumers": {}, "requested_ms": None}


def active(purge_dir):
    return [status(purge_dir, r["purge_id"]) for r in _requests(purge_dir)]


def collect_finished(purge_dir):
    """S only: removes the request and the acknowledgements of every request all of whose consumers answered."""
    removed = []
    for request in _requests(purge_dir):
        purge_id = request["purge_id"]
        if status(purge_dir, purge_id)["state"] != "done":
            continue
        for consumer in request["consumers"]:
            try:
                os.remove(_ack_path(purge_dir, purge_id, consumer))
            except OSError:
                pass
        try:
            os.remove(os.path.join(purge_dir, purge_id + ".request.json"))
        except OSError:
            pass
        removed.append(purge_id)
    return removed


# --------------------------------------------------------------------------- deleting rows in a consumer's own DB


def delete_rows(db, targets, strategy_id, *, ledger_tables=(), ledger=None):
    """Deletes ``strategy_id``'s rows from ``targets`` = ``[(table, column)]``; returns ``{table: rows}``.

    ``ledger_tables`` are append-only paper ledgers: they are only touched when ``PURGE_PAPER_LEDGER`` is on, and
    then the guarding triggers are dropped and re-created around the delete. Absent tables are skipped.
    """
    ledger = PURGE_PAPER_LEDGER if ledger is None else ledger
    existing = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    result = {}
    for table, column in targets:
        if table not in existing:
            continue
        if table in ledger_tables:
            count = db.execute("SELECT COUNT(*) FROM {} WHERE {}=?".format(table, column), (strategy_id,)).fetchone()[0]
            if not ledger:
                result[table] = {"kept": count}
                continue
            triggers = [sql for (sql,) in db.execute(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL", (table,))]
            names = [n for (n,) in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,))]
            with db:
                for name in names:
                    db.execute('DROP TRIGGER IF EXISTS "{}"'.format(name))
                db.execute("DELETE FROM {} WHERE {}=?".format(table, column), (strategy_id,))
                for sql in triggers:
                    db.execute(sql)
            result[table] = count
            continue
        with db:
            result[table] = db.execute("DELETE FROM {} WHERE {}=?".format(table, column), (strategy_id,)).rowcount
    return result


def delete_rows_path(path, targets, strategy_id, **kwargs):
    """Same as ``delete_rows`` on a file nobody else is writing right now (short lock, otherwise ``None``)."""
    if not os.path.exists(path):
        return {}
    db = sqlite3.connect(path, timeout=5)
    try:
        return delete_rows(db, targets, strategy_id, **kwargs)
    except sqlite3.OperationalError:
        return None
    finally:
        db.close()
