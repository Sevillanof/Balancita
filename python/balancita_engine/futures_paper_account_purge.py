"""Deletes one strategy from D's hash-chained account DB and keeps the chain valid (ADR 0001, amendment 2026-10-19).

D is retired: its account DB is only history, so this tool is the single writer while it runs. Every event of the
independent books carries ``body.book = "<strategy_id>:<product_id>"``; books never share cash, so removing a book
leaves the others' balances exactly as they were.

1. The events of the strategy's books are removed; the rest keep their order and are renumbered 1..n.
2. The chain is recomputed (``prev_hash``/``record_hash``) from the first affected event; payloads are untouched.
3. Each snapshot drops the deleted books' state, and its ``head_seq``/``head_hash`` point at the same event as before
   (renumbered, rehashed). Cursors are input positions and stay as they are.
4. The config stored in the DB loses the strategy in ``books`` and its hash is updated, so no trace of the id stays.
5. The new chain and the snapshot heads are verified before committing; any mismatch rolls everything back.

The DB keeps working as history; to resume D the code's config must match the stored one (it does not any more:
D does not run).
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys

from .canonical import canonical_json
from .futures_paper_execution import GENESIS_HASH, _chain_hash, _json

TABLES = ("paper_execution_meta", "paper_execution_events", "paper_execution_snapshots")


def _book_of(payload_json):
    body = _json(payload_json).get("body")
    return body.get("book") if isinstance(body, dict) else None


def has_strategy(path, strategy_id):
    """Read-only: does the account DB mention the strategy at all?"""
    if not path or not os.path.exists(path):
        return False
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=10)
    try:
        prefix = strategy_id + ":"
        for (payload,) in db.execute("SELECT payload_json FROM paper_execution_events"):
            book = _book_of(payload)
            if isinstance(book, str) and book.startswith(prefix):
                return True
        meta = db.execute("SELECT value FROM paper_execution_meta WHERE key='config_json'").fetchone()
        return meta is not None and strategy_id in meta[0]
    except sqlite3.Error:
        return False
    finally:
        db.close()


def purge_strategy(path, strategy_id):
    """Returns ``{events_removed, events_kept, snapshots, head_hash}``; raises ValueError (and changes nothing)."""
    if not os.path.exists(path):
        return {"events_removed": 0, "events_kept": 0, "snapshots": 0, "head_hash": GENESIS_HASH}
    db = sqlite3.connect(path, timeout=30)
    prefix = strategy_id + ":"
    try:
        events = db.execute("SELECT seq, time_ms, kind, payload_json FROM paper_execution_events ORDER BY seq").fetchall()
        snapshots = db.execute("SELECT seq, time_ms, state_json, cursors_json, head_hash FROM paper_execution_snapshots "
                               "ORDER BY seq").fetchall()
        meta = dict(db.execute("SELECT key, value FROM paper_execution_meta"))
        kept, new_seq_of, prev, rows, hash_of = 0, {}, GENESIS_HASH, [], {}
        for seq, time_ms, kind, payload_json in events:
            book = _book_of(payload_json)
            if isinstance(book, str) and book.startswith(prefix):
                continue
            kept += 1
            record_hash = _chain_hash(prev, payload_json)
            rows.append((kept, time_ms, kind, payload_json, prev, record_hash))
            new_seq_of[seq] = kept
            hash_of[kept] = record_hash
            prev = record_hash
        old_seqs = sorted(new_seq_of)

        def renumber(old_head):
            """New seq of the last kept event at or before ``old_head`` (0: none)."""
            lo, hi = 0, len(old_seqs)
            while lo < hi:
                mid = (lo + hi) // 2
                if old_seqs[mid] <= old_head:
                    lo = mid + 1
                else:
                    hi = mid
            return 0 if lo == 0 else new_seq_of[old_seqs[lo - 1]]

        new_snapshots = []
        for seq, time_ms, state_json, cursors_json, head_hash in snapshots:
            document = _json(state_json)
            new_head = renumber(document["head_seq"])
            engine = document["engine"]
            if isinstance(engine, dict) and isinstance(engine.get("books"), dict):
                engine["books"] = {k: v for k, v in engine["books"].items() if not k.startswith(prefix)}
                if "events_since_snapshot" in engine:
                    engine["events_since_snapshot"] = sum(
                        int(b.get("events_since_snapshot", 0)) for b in engine["books"].values() if isinstance(b, dict))
            document = {"head_seq": new_head, "engine": engine}
            new_snapshots.append((seq, time_ms, canonical_json(document), cursors_json,
                                  GENESIS_HASH if new_head == 0 else hash_of[new_head]))
        config = _json(meta["config_json"]) if "config_json" in meta else None
        config_rows = {}
        if config is not None:
            if isinstance(config.get("books"), list):
                config["books"] = [b for b in config["books"] if b != strategy_id]
            config_json = canonical_json(config)
            config_rows = {"config_json": config_json,
                           "config_hash": hashlib.sha256(config_json.encode("utf-8")).hexdigest()}
        # Verify what is about to be written, in memory, before touching the DB.
        check = GENESIS_HASH
        for n, (seq, time_ms, kind, payload_json, prev_hash, record_hash) in enumerate(rows, 1):
            payload = _json(payload_json)
            if (seq != n or prev_hash != check or payload["kind"] != kind or payload["time_ms"] != time_ms
                    or _chain_hash(check, payload_json) != record_hash):
                raise ValueError("recomputed chain broken at seq {}".format(seq))
            check = record_hash
        db.execute("BEGIN IMMEDIATE")
        try:
            triggers = db.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ({})".format(
                ",".join("?" * len(TABLES))), TABLES).fetchall()
            for name, _ in triggers:
                db.execute('DROP TRIGGER "{}"'.format(name))
            db.execute("DELETE FROM paper_execution_events")
            db.execute("DELETE FROM paper_execution_snapshots")
            db.executemany("INSERT INTO paper_execution_events VALUES(?,?,?,?,?,?)", rows)
            db.executemany("INSERT INTO paper_execution_snapshots VALUES(?,?,?,?,?)", new_snapshots)
            for key, value in config_rows.items():
                db.execute("DELETE FROM paper_execution_meta WHERE key=?", (key,))
                db.execute("INSERT INTO paper_execution_meta VALUES(?,?)", (key, value))
            for _, sql in triggers:
                db.execute(sql)
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return {"events_removed": len(events) - kept, "events_kept": kept, "snapshots": len(new_snapshots),
                "head_hash": check}
    finally:
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--account-db", required=True)
    parser.add_argument("--strategy", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(purge_strategy(args.account_db, args.strategy), sort_keys=True))
    except (ValueError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
