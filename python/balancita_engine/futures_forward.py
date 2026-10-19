"""Forward paper measurement of strategies found by searching past data.

``config/forward-strategies.json`` registers a strategy with a start time. From then on this runner replays
it over the official candles of the market DB (``futures_replay.load_range``, indicators warmed up with the
week before the start), takes only the decisions from ``start_ms`` on, and keeps its own append-only DB of the
trades that happened after registration. Nothing in it can be fitted to: every trade was decided on candles
that closed before it, by a spec whose hash is recorded. Closed trades are never rewritten; re-running only
adds the ones that have closed since.

Holes in the capture (the process was down) are filled afterwards from Kraken's public charts API by the
capture itself, with the candle's real ``known_at``. Because the replay is a pure function of the candles, a
filled hole is simply replayed in order: entries at the close of the signal candle, stop and target against each
candle's high and low (stop first when both fall in one candle), the time stop counted from the real entry. A
trade whose entry-to-exit span contains a candle learned more than ``LATE_KNOWN_MS`` after it closed, or whose entry
rested on funding the capture only learned afterwards, is labelled ``recovered`` (it could not have been seen live):
it is simulated and reported apart (``summary_recovered``) but does NOT count toward ``FORWARD_MIN_TRADES``; only
live trades do. See docs/strategy-reliability.md.

``write_summary`` turns that DB into ``futures-strategy-forward.v1`` JSON (per strategy: the reliability
figures of its forward trades, per product, and the open positions), which
``futures_strategy_reliability.effective_reliability`` uses: the backtest verdict stands until the strategy has
``FORWARD_MIN_TRADES`` forward trades, then the forward trades alone decide.

    python -m balancita_engine.futures_forward --market-db data/market.sqlite --out data/forward \\
        [--loop-seconds 3600]
"""

import argparse
import json
import os
import sqlite3
import time

from .futures_funding_context import funding_for, funding_periods, funding_since_ms, funding_state
from .futures_funding_reconcile import load_reconciled, reconcile
from .futures_products import resolve_products
from .futures_replay import load_range, replay
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_reliability import (
    FORWARD_SCHEMA,
    FORWARD_STRATEGIES_PATH,
    LATE_CANDLE_TOLERANCE_MS,
    summarize_trades,
)

ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
# One tolerance for a late candle, shared with the paper session (``late_candle_tolerance_ms`` in
# config/forward-strategies.json, 15 s; ADR 0001 amendment 2026-10-18). The live poll learns a candle ~3 s after it
# closes; a candle learned later than this never produces a live trade. It is not ``GAP_GRACE`` (when to declare a
# candle missing).
LATE_KNOWN_MS = LATE_CANDLE_TOLERANCE_MS
# Owner decision: entries on candles learned late (a backfilled off period) are simulated and labelled ``recovered``,
# not refused. The gate below stays available (``make_entry_gate``) but run_forward only applies it when this is True.
BLOCK_STALE_ENTRIES = False
# What the candles decide. ``net_bp`` is left out: it also depends on the funding known when the trade was stored,
# which is completed beside the original (futures_funding_reconcile), not by a hole in the candles.
_CORE_KEYS = ("entry_price", "exit_bucket_ms", "exit_price", "exit_reason", "side")
# Which rule decided each stored trade (written beside it, never by rewriting it). Trades already stored when the
# marks first appeared were decided under the stale-entry gate that PR #283 (18 Oct) removed: era ``ERA_OLD``.
# Every trade stored from then on is ``ERA_NOW``. The old ones the current rule does not reproduce are legacy of
# that change, not an error; a divergence of the current era is still a real warning.
ERA_OLD = "bloqueo-antiguo"
ERA_NOW = "actual"
LEGACY_NOTE = "legado del cambio del 18-oct (#283): decididas con la regla anterior"


def rebuild_hint(count):
    return ("{} trades del legado (#283) no se reproducen con la regla actual; `--rebuild` los recalcula conservando "
            "la evidencia y el inicio de cada estrategia".format(count))
_FIRST_SEEN_SCHEMA = ("CREATE TABLE IF NOT EXISTS forward_first_seen("
                      "strategy_id TEXT NOT NULL, spec_hash TEXT NOT NULL, seen_ms INTEGER NOT NULL, "
                      "PRIMARY KEY(strategy_id, spec_hash)) STRICT;")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_era(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  spec_hash TEXT NOT NULL, era TEXT NOT NULL, marked_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, spec_hash)) STRICT;
CREATE TABLE IF NOT EXISTS forward_unclassified(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL, marked_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_diverged(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_trade(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, spec_hash)) STRICT;
CREATE TABLE IF NOT EXISTS forward_open(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, payload TEXT,
  PRIMARY KEY(strategy_id, product_id)) STRICT;
CREATE TABLE IF NOT EXISTS forward_recovered(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_policy(
  name TEXT NOT NULL PRIMARY KEY, value INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS forward_blocked(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL, spec_hash TEXT NOT NULL,
  PRIMARY KEY(strategy_id, product_id, bucket_ms, spec_hash)) STRICT;
CREATE TABLE IF NOT EXISTS forward_status(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(strategy_id, product_id)) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_trade_no_update BEFORE UPDATE ON forward_trade
  BEGIN SELECT RAISE(ABORT, 'forward trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_trade_no_delete BEFORE DELETE ON forward_trade
  BEGIN SELECT RAISE(ABORT, 'forward trades are append-only'); END;
"""


def migrate_trade_key(db):
    """Puts ``spec_hash`` in the primary key of ``forward_trade`` (databases created before it was).

    With the old key a second spec stored at the same entry bucket was dropped by ``INSERT OR IGNORE`` without a
    word, and the reader (which filters by ``spec_hash``) then saw a trade missing. The rows are copied as they are;
    the migration is written in ``forward_migration`` and does nothing on a database that already has the key.
    Returns the number of rows carried over, or ``None`` when no migration was needed.
    """
    columns = db.execute("PRAGMA table_info(forward_trade)").fetchall()
    if not columns or any(name == "spec_hash" and pk for _, name, _, _, _, pk in columns):
        return None
    count = db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0]
    db.executescript("""
BEGIN;
CREATE TABLE forward_trade_new(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, spec_hash)) STRICT;
INSERT INTO forward_trade_new SELECT strategy_id, product_id, entry_bucket_ms, spec_hash, payload FROM forward_trade;
DROP TABLE forward_trade;
ALTER TABLE forward_trade_new RENAME TO forward_trade;
CREATE TABLE IF NOT EXISTS forward_migration(
  name TEXT NOT NULL PRIMARY KEY, rows_carried INTEGER NOT NULL, done_ms INTEGER NOT NULL) STRICT;
COMMIT;""")
    with db:
        db.execute("INSERT OR IGNORE INTO forward_migration VALUES(?,?,?)",
                   ("forward_trade-pk-with-spec_hash", count, int(time.time() * 1000)))
    return count


def load_registration(path=None):
    with open(path or FORWARD_STRATEGIES_PATH, encoding="utf-8") as handle:
        body = json.load(handle)
    if body.get("schema") != "futures-forward-strategies.v1":
        raise ValueError("not a forward strategies file")
    return body


def effective_registration(db_path, registration, specs, candidates, now_ms):
    """What to measure now: only strategies the registry has ACTIVE.

    Owner decision (2026-10-19): everything starts as a draft and nothing runs in the real paper until the user
    activates it. ``config/forward-strategies.json`` therefore no longer switches a strategy on: an entry there only
    supplies ``start_ms`` (never earlier than the activation) and counts if, and only if, the registry has that
    strategy active. ``candidates`` is ``futures_strategy_registry.forward_candidates``; with ``None`` (no registry
    to read) NOTHING is measured by the runner's ``main`` (it never calls this without a registry); a caller that
    really has no registry gets the file alone, as before.
    A strategy of the file measures from ``max(start_ms, activation)``; any other active strategy starts when it was
    activated (a shipped one with no activation time: the first time this runner saw it, written down once and never
    moved). A strategy that is switched off or deleted adds no more trades; its history stays.
    Returns ``(registration, specs)``; the inputs are not modified.
    """
    file_entries = dict(registration["strategies"])
    registered = {}
    specs = dict(specs)
    if candidates is None:
        return registration, specs
    db = sqlite3.connect(db_path)
    try:
        db.executescript(_FIRST_SEEN_SCHEMA)
        for strategy_id, info in candidates.items():
            if info["state"] != "active":
                continue
            spec = info["spec"]
            since = info["active_since_ms"] or 0
            if strategy_id in file_entries:
                entry = dict(file_entries[strategy_id])
                entry["start_ms"] = max(entry["start_ms"], since)
                registered[strategy_id] = entry
                specs[strategy_id] = spec
                continue
            start = since
            if start <= 0:
                digest = spec_hash(spec)
                with db:
                    db.execute("INSERT OR IGNORE INTO forward_first_seen VALUES(?,?,?)",
                               (strategy_id, digest, now_ms))
                start = db.execute("SELECT seen_ms FROM forward_first_seen WHERE strategy_id=? AND spec_hash=?",
                                   (strategy_id, digest)).fetchone()[0]
            registered[strategy_id] = {"start_ms": start, "registered": "registry",
                                       "why": "active in the strategy registry"}
            specs[strategy_id] = spec
    finally:
        db.close()
    return dict(registration, strategies=registered), specs


def registry_activations(candidates):
    """``{(strategy_id, version, active_since_ms)}`` of what the registry has active: the cheap wake-up signature."""
    if not candidates:
        return set()
    return {(sid, info["version"], info["active_since_ms"]) for sid, info in candidates.items()
            if info["state"] == "active"}


def candle_coverage(ones, fives, start_ms, end_ms):
    """Candles learned late and 1m buckets still missing between ``start_ms`` and ``end_ms``.

    Returns ``(late_ones, late_fives, missing_ones)`` where the first two are sets of bucket starts whose first
    known revision arrived more than ``LATE_KNOWN_MS`` after the bucket closed, and ``missing_ones`` counts the
    1m buckets absent from the first stored candle of the range to ``end_ms`` (holes the capture left).
    """
    late_ones = {c["bucket_start"] for c in ones if c["known_at"] - c["close_at"] > LATE_KNOWN_MS}
    late_fives = {c["bucket_start"] for c in fives if c["known_at"] - c["close_at"] > LATE_KNOWN_MS}
    inside = [c["bucket_start"] for c in ones if c["bucket_start"] >= start_ms]
    missing = 0
    if inside:
        last = min(max(inside), (end_ms // ONE_MINUTE_MS) * ONE_MINUTE_MS)
        missing = max(0, (last - inside[0]) // ONE_MINUTE_MS + 1 - len(inside))
    return late_ones, late_fives, missing


def funding_recovered(trade, late_funding_at):
    """True when the entry decision rested on funding the capture only learned afterwards (backfilled hours).

    The entry reads the trend of the last closed 5m frame, i.e. a funding instant in ``(entry - 4 min, entry + 1 min]``.
    """
    entry = trade["entry_bucket_ms"]
    return any(entry - 4 * ONE_MINUTE_MS < at <= entry + ONE_MINUTE_MS for at in late_funding_at)


def is_recovered(trade, late_ones, late_fives):
    """True when a candle between the signal candle and the exit candle was learned late (a capture hole)."""
    first, last = trade["entry_bucket_ms"], trade["exit_bucket_ms"]
    if any(first <= bucket <= last for bucket in late_ones):
        return True
    return any(first - FIVE_MINUTES_MS < bucket <= last for bucket in late_fives)


def open_is_recovered(entry_bucket_ms, late_ones, late_fives, late_funding_at):
    """True when an open position's ENTRY already relied on late-arriving data (same criteria as a closed trade's entry).

    The exit is not known yet: a live position can still become ``recovered`` when it closes on late data.
    """
    entry = {"entry_bucket_ms": entry_bucket_ms, "exit_bucket_ms": entry_bucket_ms}
    return is_recovered(entry, late_ones, late_fives) or funding_recovered(entry, late_funding_at)


def stale_gate_from(db, now_ms):
    """When the stale-data entry gate first applied (written once, never moved)."""
    with db:
        db.execute("INSERT OR IGNORE INTO forward_policy VALUES('stale_gate_from_ms', ?)", (now_ms,))
    return db.execute("SELECT value FROM forward_policy WHERE name='stale_gate_from_ms'").fetchone()[0]


def make_entry_gate(ones, fives, gate_from_ms):
    """``gate(bucket) -> True`` when the data a new entry would rest on is stale or missing.

    The 1m candle of the bucket and the latest closed 5m candle must both *exist* and each have been known within
    ``LATE_KNOWN_MS`` of closing (their first ``known_at``, not the candle's own time). A missing 5m candle blocks
    the entry even when 1m candles keep arriving: the simulator would otherwise carry the last 5m indicators
    forward. Buckets before ``gate_from_ms`` are never blocked.
    """
    fresh_ones = {c["bucket_start"] for c in ones if c["known_at"] - c["close_at"] <= LATE_KNOWN_MS}
    fresh_fives = {c["bucket_start"] for c in fives if c["known_at"] - c["close_at"] <= LATE_KNOWN_MS}

    def gate(bucket):
        if bucket < gate_from_ms:
            return False
        latest_five = ((bucket + ONE_MINUTE_MS) // FIVE_MINUTES_MS) * FIVE_MINUTES_MS - FIVE_MINUTES_MS
        return bucket not in fresh_ones or latest_five not in fresh_fives
    return gate


def mark_legacy_era(db, now_ms):
    """Once per database: marks every trade stored so far as ``ERA_OLD`` (decided before the marks existed).

    The durable marker is ``forward_policy('legacy_era_marked_ms')``; after it exists nothing is marked old again, so
    a trade written later (even by an old process still running during the deployment) is never turned into legacy.
    Append-only. Returns True when it marked.
    """
    if db.execute("SELECT 1 FROM forward_policy WHERE name='legacy_era_marked_ms'").fetchone():
        return False
    with db:
        db.execute("INSERT OR IGNORE INTO forward_policy VALUES('legacy_era_marked_ms', ?)", (now_ms,))
        db.execute("INSERT OR IGNORE INTO forward_era SELECT strategy_id, product_id, entry_bucket_ms, spec_hash, ?, ? "
                   "FROM forward_trade", (ERA_OLD, now_ms))
    return True


def start_rebuild(out_dir, now_s=None):
    """Sets ``forward.sqlite`` aside as evidence and starts a new one that keeps what is not recomputable.

    ``forward_first_seen`` (when a registry strategy was first seen: its start) and ``forward_policy`` are copied
    into the new file; without them a strategy with no ``active_since_ms`` would restart "from now". Trades, status
    and marks are recomputed from the candles. Returns the path of the kept file, or ``None`` when there was none.
    """
    current = os.path.join(out_dir, "forward.sqlite")
    if not os.path.exists(current):
        return None
    kept = "{}.before-rebuild-{}".format(current, int((time.time() if now_s is None else now_s) * 1000))
    if os.path.exists(kept):
        raise FileExistsError("the rebuild evidence {} already exists; it is never overwritten".format(kept))
    os.rename(current, kept)
    old = sqlite3.connect("file:{}?mode=ro".format(kept), uri=True)
    new = sqlite3.connect(current)
    try:
        new.executescript(_FIRST_SEEN_SCHEMA + _SCHEMA)
        present = {name for (name,) in old.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        with new:
            if "forward_first_seen" in present:
                new.executemany("INSERT OR IGNORE INTO forward_first_seen VALUES(?,?,?)",
                                old.execute("SELECT strategy_id, spec_hash, seen_ms FROM forward_first_seen"))
            if "forward_policy" in present:
                new.executemany("INSERT OR IGNORE INTO forward_policy VALUES(?,?)",
                                old.execute("SELECT name, value FROM forward_policy"))
    finally:
        old.close()
        new.close()
    return kept


def run_forward(market_db, db_path, specs, registration, products):
    """Replays every registered spec over every product and stores the trades closed since its start.

    Returns ``{(strategy_id, product_id): number of new trades}``.
    """
    db = sqlite3.connect(db_path)
    migrate_trade_key(db)
    db.executescript(_SCHEMA)
    added = {}
    try:
        now = int(time.time() * 1000)
        gate_from = stale_gate_from(db, now)
        mark_legacy_era(db, now)
        for strategy_id, info in registration["strategies"].items():
            spec = specs.get(strategy_id)
            if spec is None:
                continue
            digest = spec_hash(spec)
            for product_id, tick_size in products:
                try:
                    ones, fives = load_range(market_db, product_id, info["start_ms"], now + ONE_MINUTE_MS)
                except ValueError:
                    continue
                # Periods from 30 days before the first decision: the cost follows the hours replayed, not the capture's age.
                # ``recover_until_ms=now``: an off period is evaluated with the funding backfilled since (see FundingContext).
                context = funding_for(market_db, product_id, funding_since_ms(info["start_ms"]),
                                      recover_until_ms=now)
                (book,) = replay([spec], ones, fives, start_ms=info["start_ms"], product_id=product_id,
                                 tick_size=tick_size, funding=context, funding_periods=funding_periods(context),
                                 entry_gate=make_entry_gate(ones, fives, gate_from) if BLOCK_STALE_ENTRIES else None)
                late_ones, late_fives, missing = candle_coverage(ones, fives, info["start_ms"], now)
                late_funding = sorted(context.late_at) if context is not None else []
                recovered = {t["entry_bucket_ms"] for t in book.trades
                             if is_recovered(t, late_ones, late_fives) or funding_recovered(t, late_funding)}
                with db:
                    added[(strategy_id, product_id)] = 0
                    stored = {bucket: json.loads(payload) for bucket, payload in db.execute(
                        "SELECT entry_bucket_ms, payload FROM forward_trade WHERE strategy_id=? AND product_id=? "
                        "AND spec_hash=? AND entry_bucket_ms>=?", (strategy_id, product_id, digest, info["start_ms"]))}
                    by_entry = {t["entry_bucket_ms"]: t for t in book.trades}
                    for trade in book.trades:
                        cursor = db.execute(
                            "INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)",
                            (strategy_id, product_id, trade["entry_bucket_ms"], digest, json.dumps(trade)))
                        added[(strategy_id, product_id)] += cursor.rowcount
                        if cursor.rowcount:
                            db.execute("INSERT OR IGNORE INTO forward_era VALUES(?,?,?,?,?,?)",
                                       (strategy_id, product_id, trade["entry_bucket_ms"], digest, ERA_NOW, now))
                    # Trades stored earlier that the candles now on disk no longer reproduce (they were computed
                    # across a hole): never rewritten, only counted, so ``--rebuild`` can recompute them.
                    diverged_buckets = sorted(bucket for bucket, old in stored.items() if bucket not in by_entry or any(
                        old.get(key) != by_entry[bucket].get(key) for key in _CORE_KEYS))
                    eras = dict(db.execute(
                        "SELECT entry_bucket_ms, era FROM forward_era WHERE strategy_id=? AND product_id=? "
                        "AND spec_hash=?", (strategy_id, product_id, digest)))
                    # Once legacy, always legacy: the classification never flips because a later cycle reproduces it.
                    db.executemany("INSERT OR IGNORE INTO forward_unclassified VALUES(?,?,?,?)",
                                   [(strategy_id, product_id, bucket, now) for bucket in diverged_buckets
                                    if eras.get(bucket) == ERA_OLD])
                    legacy = db.execute("SELECT COUNT(*) FROM forward_unclassified WHERE strategy_id=? AND product_id=?",
                                        (strategy_id, product_id)).fetchone()[0]
                    diverged = sum(1 for bucket in diverged_buckets if eras.get(bucket) != ERA_OLD)
                    db.execute("DELETE FROM forward_diverged WHERE strategy_id=? AND product_id=?",
                               (strategy_id, product_id))
                    db.executemany("INSERT INTO forward_diverged VALUES(?,?,?)",
                                   [(strategy_id, product_id, bucket) for bucket in diverged_buckets])
                    db.executemany("INSERT OR IGNORE INTO forward_blocked VALUES(?,?,?,?)",
                                   [(strategy_id, product_id, bucket, digest) for bucket in book.blocked])
                    db.execute("DELETE FROM forward_recovered WHERE strategy_id=? AND product_id=?",
                               (strategy_id, product_id))
                    db.executemany("INSERT INTO forward_recovered VALUES(?,?,?)",
                                   [(strategy_id, product_id, bucket) for bucket in sorted(recovered)])
                    db.execute("INSERT OR REPLACE INTO forward_status VALUES(?,?,?)", (
                        strategy_id, product_id, json.dumps({
                            "checked_ms": now, "missing_1m": missing, "late_1m": len(late_ones),
                            "diverged_trades": diverged, "legacy_diverged_trades": legacy, "blocked_stale_entries": len(book.blocked),
                            "stale_cycles": book.stale_cycles,
                            "funding": funding_state(context, now),
                            # How far behind "now" the newest stored 1m candle closed: a capture that stopped
                            # leaves no holes inside the range, only a growing lag.
                            "candle_lag_ms": (now - (max(c["bucket_start"] for c in ones) + ONE_MINUTE_MS))
                            if ones else None})))
                    position = None if book.position is None else dict(
                        {key: str(book.position[key]) for key in ("side", "entry", "stop", "target", "opened_at")},
                        recovered=open_is_recovered(book.position["opened_bucket"], late_ones, late_fives,
                                                    late_funding))
                    db.execute("INSERT OR REPLACE INTO forward_open VALUES(?,?,?,?)",
                               (strategy_id, product_id, digest, json.dumps(position)))
                # Trades stored while the funding history did not reach them are completed beside the original.
                reconcile(db, strategy_id, product_id, digest, funding_periods(context))
    finally:
        db.close()
    return added


def write_summary(db_path, specs, registration, out_path):
    """The forward reliability JSON for every registered strategy, written atomically."""
    db = sqlite3.connect(db_path)
    try:
        now = int(time.time() * 1000)
        strategies = {}
        for strategy_id, info in registration["strategies"].items():
            spec = specs.get(strategy_id)
            if spec is None:
                continue
            digest = spec_hash(spec)
            rows = db.execute("SELECT product_id, payload FROM forward_trade WHERE strategy_id=? AND spec_hash=?",
                              (strategy_id, digest)).fetchall()
            recovered = {(product, bucket) for product, bucket in db.execute(
                "SELECT product_id, entry_bucket_ms FROM forward_recovered WHERE strategy_id=?", (strategy_id,))}
            trades = [dict(json.loads(payload), product_id=product) for product, payload in rows]
            # Legacy: stored under the old rule and not reproduced by the current one. No ``recovered`` flag can be
            # computed for them, so they are neither live nor recovered: they have a block of their own.
            legacy_keys = {(product, bucket) for product, bucket in db.execute(
                "SELECT product_id, entry_bucket_ms FROM forward_unclassified WHERE strategy_id=?", (strategy_id,))}
            reconciled = load_reconciled(db, strategy_id, digest)
            for trade in trades:
                trade["recovered"] = (trade["product_id"], trade["entry_bucket_ms"]) in recovered
                row = reconciled.get((trade["product_id"], trade["entry_bucket_ms"]))
                if row is not None and not trade.get("funding_complete"):
                    trade.update(funding_usd=row["funding_usd"], funding_complete=True, funding_status="complete",
                                 pnl_usd=row["pnl_usd"], net_bp=row["net_bp"], funding_source=row["method_version"])
            unclassified = [t for t in trades if (t["product_id"], t["entry_bucket_ms"]) in legacy_keys]
            for trade in unclassified:
                trade["recovered"] = None
            trades = [t for t in trades if t["recovered"] is not None]
            live_only = [t for t in trades if not t["recovered"]]
            recovered_only = [t for t in trades if t["recovered"]]
            last_ms = max(now, info["start_ms"] + 1)
            funding_state_by_product = {product: json.loads(payload).get("funding") for product, payload in db.execute(
                "SELECT product_id, payload FROM forward_status WHERE strategy_id=?", (strategy_id,))}
            statuses = [json.loads(payload) for (payload,) in db.execute(
                "SELECT payload FROM forward_status WHERE strategy_id=?", (strategy_id,))]
            open_positions = sum(1 for (payload,) in db.execute(
                "SELECT payload FROM forward_open WHERE strategy_id=? AND spec_hash=?", (strategy_id, digest))
                if json.loads(payload) is not None)
            by_product = {}
            for trade in trades:
                by_product.setdefault(trade["product_id"], []).append(trade)
            strategies[strategy_id] = {
                "spec_hash": digest, "start_ms": info["start_ms"], "open_positions": open_positions,
                "summary": summarize_trades(trades, first_ms=info["start_ms"], last_ms=max(now, info["start_ms"] + 1)),
                "recovered_trades": len(recovered_only),
                # Live and recovered (decided on data that arrived late: backfilled candles or funding) apart.
                # Only the live ones count toward FORWARD_MIN_TRADES and decide the verdict (effective_reliability).
                "summary_without_recovered": summarize_trades(live_only, first_ms=info["start_ms"], last_ms=last_ms),
                "summary_recovered": summarize_trades(recovered_only, first_ms=info["start_ms"], last_ms=last_ms),
                "counts_toward_min_trades": "live",
                "live_trades": len(live_only),
                # Stored under the rule PR #283 removed and not reproduced now: never live, never in the progress.
                "unclassified_trades": len(unclassified), "legacy_note": LEGACY_NOTE,
                "summary_unclassified": summarize_trades(unclassified, first_ms=info["start_ms"], last_ms=last_ms),
                "legacy_diverged_trades": sum(st.get("legacy_diverged_trades", 0) for st in statuses),
                # Per product: whether funding is usable now and, if not, the stable code and the reason in Spanish.
                "funding_state": {p: v for p, v in sorted(funding_state_by_product.items()) if v is not None},
                "missing_candles_1m": sum(st["missing_1m"] for st in statuses),
                "diverged_trades": sum(st["diverged_trades"] for st in statuses),
                "blocked_stale_entries": sum(st.get("blocked_stale_entries", 0) for st in statuses),
                "stale_cycles": sum(st.get("stale_cycles", 0) for st in statuses),
                "max_candle_lag_ms": max((st["candle_lag_ms"] for st in statuses
                                          if st.get("candle_lag_ms") is not None), default=None),
                "by_product": {p: {k: v for k, v in summarize_trades(t).items()
                                   if k in ("trades", "hit_rate", "mean_net_bp", "pnl_usd")}
                               for p, t in sorted(by_product.items())},
            }
    finally:
        db.close()
    body = {"schema": FORWARD_SCHEMA, "updated_ms": now, "min_forward_trades": registration["min_forward_trades"],
            "strategies": strategies}
    temporary = out_path + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, out_path)
    return body


def main(argv=None):
    parser = argparse.ArgumentParser(description="Measure registered strategies forward, in paper.")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for forward.sqlite and forward-reliability.json")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--registration", default=FORWARD_STRATEGIES_PATH)
    parser.add_argument("--strategies-db", help="the strategy registry (read-only): every strategy active there "
                                                "is measured too, from the moment it was switched on")
    parser.add_argument("--rebuild", action="store_true",
                        help="keep the current forward.sqlite aside and recompute every trade from the candles "
                             "now on disk (after a hole was filled)")
    parser.add_argument("--loop-seconds", type=float, default=0, help="repeat every N seconds (0: once)")
    parser.add_argument("--registry-poll-seconds", type=float, default=60,
                        help="how often to look at the registry for newly active strategies and delete requests "
                             "between full cycles (a newly active strategy gets a cycle at once)")
    parser.add_argument("--purge-dir", help="delete requests folder (default: <strategies db folder>/purge)")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    if args.rebuild:
        kept = start_rebuild(args.out)
        if kept:
            print("rebuild: the previous forward.sqlite is kept as evidence at {}".format(kept), flush=True)
    specs = load_specs(args.specs_dir)
    registration = load_registration(args.registration)
    products = resolve_products()
    purge_dir = args.purge_dir or (os.path.join(os.path.dirname(os.path.abspath(args.strategies_db)), "purge")
                                   if args.strategies_db else None)
    loop = ForwardLoop(args.market_db, args.out, specs, registration, products, strategies_db=args.strategies_db,
                       purge_dir=purge_dir, loop_seconds=args.loop_seconds, poll_seconds=args.registry_poll_seconds)
    loop.step(time.time())
    if not args.loop_seconds:
        return
    while True:
        time.sleep(min(args.registry_poll_seconds, args.loop_seconds))
        loop.step(time.time())


class ForwardLoop:
    """One forward process: a full cycle every ``loop_seconds`` and, between them, a cheap look at the registry.

    Every ``poll_seconds`` it (1) consumes delete requests for its own rows (``strategy_purge``) and (2) reads the
    registry's states. A strategy that became active (or a new active version) wakes a cycle at once instead of
    waiting for the hour. Everything stays in this one process, the single writer of ``forward.sqlite``.
    """

    def __init__(self, market_db, out_dir, specs, registration, products, *, strategies_db=None, purge_dir=None,
                 loop_seconds=0, poll_seconds=60, cycle=None):
        self.market_db, self.out_dir, self.products = market_db, out_dir, products
        self.base_specs, self.base_registration = specs, registration
        self.strategies_db, self.purge_dir = strategies_db, purge_dir
        self.loop_seconds, self.poll_seconds = loop_seconds, poll_seconds
        self.next_full = 0.0
        self.known_active = None
        self.cycle = cycle or self._cycle
        self.cycles = []

    def step(self, now_s):
        """Consumes purges, checks the registry and runs a cycle if one is due or a strategy was just activated.

        Returns the reason of the cycle it ran (``"full"``, ``"activation"``) or ``None``.
        """
        if self.purge_dir:
            consume_purges(self.out_dir, self.purge_dir)
        candidates = None
        if self.strategies_db:
            from .futures_strategy_registry import forward_candidates
            candidates = forward_candidates(self.strategies_db)
        active = registry_activations(candidates)
        woken = self.known_active is not None and bool(active - self.known_active)
        due = now_s >= self.next_full
        self.known_active = active
        if not (due or woken):
            return None
        reason = "full" if due else "activation"
        self.cycle(candidates)
        self.cycles.append(reason)
        if due:
            self.next_full = now_s + (self.loop_seconds or 0)
        return reason

    def _cycle(self, candidates):
        db_path = os.path.join(self.out_dir, "forward.sqlite")
        registration, specs = self.base_registration, self.base_specs
        if self.strategies_db:
            # With a registry nothing runs unless the registry has it active (even when it cannot be read).
            registration, specs = effective_registration(
                db_path, self.base_registration, self.base_specs, candidates if candidates is not None else {},
                int(time.time() * 1000))
        added = run_forward(self.market_db, db_path, specs, registration, self.products)
        body = write_summary(db_path, specs, registration, os.path.join(self.out_dir, "forward-reliability.json"))
        for strategy_id, entry in body["strategies"].items():
            print("{} forward trades={} (live {}, recovered {}, unclassified {}) open={} +{} missing 1m={} diverged={} legacy={}".format(
                strategy_id, entry["summary"]["trades"], entry["live_trades"], entry["recovered_trades"], entry["unclassified_trades"],
                entry["open_positions"],
                sum(n for (s, _), n in added.items() if s == strategy_id), entry["missing_candles_1m"],
                entry["diverged_trades"], entry["legacy_diverged_trades"]), flush=True)


def consume_purges(out_dir, purge_dir):
    """Deletes this process's rows of every strategy a delete request names, then acknowledges (own file only).

    Tables: every ``forward_*`` table keyed by strategy. The append-only trade ledgers (``forward_trade`` and its
    funding reconciliation) are kept unless ``strategy_purge.PURGE_PAPER_LEDGER`` (ADR 0001). The summary JSON drops
    the strategy at once. Returns the list of purge ids answered.
    """
    from . import strategy_purge
    from .futures_strategy_lifecycle import FORWARD_LEDGER, FORWARD_TARGETS

    answered = []
    for request in strategy_purge.pending_for(purge_dir, "forward"):
        strategy_id = request["strategy_id"]
        db_path = os.path.join(out_dir, "forward.sqlite")
        deleted = {}
        if os.path.exists(db_path):
            db = sqlite3.connect(db_path, timeout=30)
            try:
                deleted = strategy_purge.delete_rows(db, FORWARD_TARGETS, strategy_id, ledger_tables=FORWARD_LEDGER)
            finally:
                db.close()
        summary = os.path.join(out_dir, "forward-reliability.json")
        if os.path.exists(summary):
            with open(summary, encoding="utf-8") as handle:
                body = json.load(handle)
            if body.get("strategies", {}).pop(strategy_id, None) is not None:
                temporary = summary + ".partial"
                with open(temporary, "w", encoding="utf-8") as handle:
                    json.dump(body, handle, indent=2, sort_keys=True)
                    handle.write("\n")
                os.replace(temporary, summary)
        strategy_purge.acknowledge(purge_dir, request["purge_id"], "forward", deleted)
        answered.append(request["purge_id"])
    return answered


if __name__ == "__main__":
    main()
