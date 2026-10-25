"""Read-only access to the positioning collector's database for strategies.

Two public Kraken Futures series, one row per closed bucket:
- positioning (hourly, from 2024-01): % of accounts long, and the same for the top 20 % by size.
- premium (perpetual mark over spot index, basis points; hourly from 2022-03, minute for the last days).

Nothing here looks ahead: a bucket is usable only from its END (bucket start + interval).
"""
import bisect
import json
import os
import sqlite3

HOUR_MS = 3600000
MINUTE_MS = 60000


def _connect(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)


def load_positioning(db_path, product_id, from_ms=0, to_ms=None):
    """Rows (bucket_ms, long_percent, top_long_percent, top_open_interest), oldest first."""
    to_ms = 2 ** 62 if to_ms is None else to_ms
    db = _connect(db_path)
    try:
        return db.execute(
            "SELECT bucket_ms, long_percent, top_long_percent, top_open_interest FROM positioning "
            "WHERE product_id=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms",
            (product_id, from_ms, to_ms),
        ).fetchall()
    finally:
        db.close()


def load_premium(db_path, product_id, interval_ms=HOUR_MS, from_ms=0, to_ms=None):
    """Rows (bucket_ms, premium_bp), oldest first, for the hourly or the minute series."""
    if interval_ms not in (HOUR_MS, MINUTE_MS):
        raise ValueError("interval_ms must be 3600000 or 60000")
    to_ms = 2 ** 62 if to_ms is None else to_ms
    db = _connect(db_path)
    try:
        return db.execute(
            "SELECT bucket_ms, premium_bp FROM premium "
            "WHERE product_id=? AND interval_ms=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms",
            (product_id, interval_ms, from_ms, to_ms),
        ).fetchall()
    finally:
        db.close()


def as_of(rows, at_ms, interval_ms=HOUR_MS):
    """Latest row known at `at_ms` (its bucket already closed), or None. `rows` sorted by bucket."""
    found = None
    for row in rows:
        if row[0] + interval_ms > at_ms:
            break
        found = row
    return found


def active_indicators(catalog_path):
    """Cards of config/indicators.json that are active, as dicts (id, series, resolution, products)."""
    with open(catalog_path) as handle:
        body = json.load(handle)
    return [card for card in body["indicators"] if card.get("state") == "active"]


def is_available(catalog_path, series, resolution, product_id):
    """True when an active card keeps this series for this product ("pinned" covers every product)."""
    return any(
        card["series"] == series
        and card["resolution"] == resolution
        and (card["products"] == "pinned" or product_id in card["products"])
        for card in active_indicators(catalog_path)
    )


DEFAULT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "server", "data", "dev-live", "positioning.sqlite")
MAX_STALE_MS = 3 * HOUR_MS      # a bucket older than this at the moment of the photo is not "the last one": it is a gap


def default_path(env=None):
    """Where the collector keeps its database on this Mac: ``$POSITIONING_DB_PATH`` or the one ``pnpm dev`` writes
    (``server/data/dev-live/positioning.sqlite``, see ``scripts/dev-provider-env.mjs``)."""
    env = os.environ if env is None else env
    return (env.get("POSITIONING_DB_PATH") or "").strip() or os.path.normpath(DEFAULT_PATH)


class PositioningFeed:
    """The collector's hourly series of ONE product, read once (read-only, ``mode=ro``) and queried by the moment of a photo.

    A bucket is known only from its END, so ``at(t_ms)`` never sees the future. When the file does not exist (or has no rows
    for the product) ``available`` is False and every query answers ``None``: the caller writes ``n/d`` and goes on."""

    def __init__(self, db_path, product_id):
        self.path, self.product_id = db_path, product_id
        self.positioning, self.premium = [], []
        self._ends_p, self._ends_q = [], []
        self.available = False
        if not db_path or not os.path.isfile(db_path):
            return
        try:
            self.positioning = load_positioning(db_path, product_id)
            self.premium = load_premium(db_path, product_id, HOUR_MS)
        except sqlite3.Error:
            self.positioning, self.premium = [], []
        self.available = bool(self.positioning or self.premium)
        self._ends_p = [row[0] + HOUR_MS for row in self.positioning]
        self._ends_q = [row[0] + HOUR_MS for row in self.premium]

    @staticmethod
    def _last(rows, ends, at_ms):
        index = bisect.bisect_right(ends, at_ms) - 1
        if index < 0 or at_ms - ends[index] > MAX_STALE_MS:
            return None
        return rows[index]

    def at(self, at_ms):
        """``{long, top_long, premium_bp}`` known at ``at_ms`` (each ``None`` when that series has no recent bucket)."""
        if not self.available:
            return None
        row = self._last(self.positioning, self._ends_p, at_ms)
        premium = self._last(self.premium, self._ends_q, at_ms)
        return {"long": None if row is None else row[1], "top_long": None if row is None else row[2],
                "premium_bp": None if premium is None else premium[1]}
