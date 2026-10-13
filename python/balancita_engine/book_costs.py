"""Execution costs measured on the archived order-book snapshots (``futures-book.sqlite``), read only.

Three kinds of numbers, never mixed (``docs/metodologia-costes-ejecucion.md``):

* **observed**: quoted spread, depth, by hour of the day;
* **simulated, deterministic**: what a taker order of N USD pays walking the stored levels (spread + impact + fee);
* **estimated, with a band**: what a resting limit order would have got. A hypothetical fill is *executable in
  principle*, never a real fill; the optimistic and the conservative reading are always reported together.

Honest by construction: limit orders are not assumed to fill. An unfilled order is either a skipped trade or a
trade chased as a taker after the time-to-live, and the chase pays the drift it waited through. The headline is
the *paired* difference "limit, then chase" minus "market at once" on the same signals, with standard errors
clustered by hour (consecutive orders overlap in time, so treating them as independent would overstate certainty).

Snapshots are one row per ~5 s with the top levels and cumulative depth bands, not the feed: what happens between
two snapshots is unknown, queue position is unknown, and the 1 s horizon cannot be resolved. The module reports
no strategy returns and never touches a database for writing.

    python -m balancita_engine.book_costs --book-db futures-book.sqlite --product PF_XBTUSD --out report/
"""

import argparse
import bisect
import json
import math
import os
import sqlite3
import statistics
import sys
from dataclasses import dataclass

BOOK_COSTS_VERSION = "book-costs.v1"
MAKER_FEE_BP = 2.0  # Kraken Futures level 1, same parameters as futures_costs
TAKER_FEE_BP = 5.0
DEFAULT_SIZES_USD = (100.0, 1000.0, 10000.0)
DEFAULT_TTL_MS = 60_000
DEFAULT_LATENCY_MS = 100
DEFAULT_HOLD_MS = 15 * 60_000
DEFAULT_MARKOUTS_MS = (5_000, 10_000, 60_000)
DEFAULT_MAX_GAP_MS = 15_000  # more silence than this between snapshots breaks continuity
DEFAULT_CLUSTER_MS = 3_600_000
MIN_CLUSTERS_FOR_VERDICT = 30
# Both are *hypothetical execution scenarios*, not demonstrated fills nor calibrated fill probabilities.
SCENARIOS = ("optimistic", "conservative")
SCENARIO_NOTE = ("optimistic and conservative are hypothetical execution scenarios built from 5 s snapshots: neither is a "
                 "demonstrated fill, a lower bound on real fills, or a calibrated fill probability")
HOUR_MS = 3_600_000


@dataclass(frozen=True)
class Snapshot:
    t: int
    bid: float
    ask: float
    bids: tuple  # ((price, qty), ...) best first
    asks: tuple
    bid_depth: dict  # band bp -> base quantity resting within that many bp of the mid
    ask_depth: dict

    @property
    def mid(self):
        return (self.bid + self.ask) / 2

    @property
    def spread_bp(self):
        return (self.ask - self.bid) / self.mid * 1e4


def _sign(side):
    return 1.0 if side == "LONG" else -1.0


# --------------------------------------------------------------------------------------------- loading

def load_snapshots(book_db_path, product_id, lo_ms=None, hi_ms=None):
    """Snapshots of one product in time order, plus how many rows were unusable. Opens the database read only."""
    db = sqlite3.connect("file:{}?mode=ro".format(book_db_path), uri=True)
    try:
        rows = db.execute(
            "SELECT received_at, best_bid, best_ask, top_bids_json, top_asks_json, bid_depth_json, ask_depth_json "
            "FROM book_depth WHERE product_id=? AND received_at BETWEEN ? AND ? ORDER BY received_at",
            (product_id, lo_ms if lo_ms is not None else 0, hi_ms if hi_ms is not None else 2 ** 62)).fetchall()
    finally:
        db.close()
    snaps, bad = [], 0
    for t, bid, ask, tb, ta, bd, ad in rows:
        try:
            snap = Snapshot(int(t), float(bid), float(ask),
                            tuple((float(p), float(q)) for p, q in json.loads(tb)),
                            tuple((float(p), float(q)) for p, q in json.loads(ta)),
                            {int(k): float(v) for k, v in json.loads(bd).items()},
                            {int(k): float(v) for k, v in json.loads(ad).items()})
        except (ValueError, TypeError, KeyError):
            bad += 1
            continue
        if not (0 < snap.bid < snap.ask):
            bad += 1
            continue
        snaps.append(snap)
    return snaps, bad


def load_gaps(book_db_path, product_id, lo_ms=None, hi_ms=None):
    """Logged collector gaps overlapping the range (``[(from_ms, to_ms, reason)]``), for the coverage section."""
    db = sqlite3.connect("file:{}?mode=ro".format(book_db_path), uri=True)
    try:
        return db.execute(
            "SELECT from_ms, to_ms, reason FROM book_gap WHERE (product_id=? OR product_id IS NULL) "
            "AND to_ms>=? AND from_ms<=? ORDER BY from_ms",
            (product_id, lo_ms if lo_ms is not None else 0, hi_ms if hi_ms is not None else 2 ** 62)).fetchall()
    finally:
        db.close()


# --------------------------------------------------------------------------------------------- taker model

def walk_levels(levels, notional_usd):
    """Average price of consuming ``notional_usd`` from ``levels`` (best first), or ``None`` if they hold less."""
    remaining, spent_qty = notional_usd, 0.0
    for price, qty in levels:
        take = min(qty * price, remaining)
        spent_qty += take / price
        remaining -= take
        if remaining <= 1e-9:
            return notional_usd / spent_qty
    return None


def execution_price(snap, side, notional_usd):
    """``(price, kind)`` of a market order: ``exact`` (walked the stored levels), ``bound`` (levels too shallow:
    the price of the narrowest depth band that holds the size, a worst case) or ``none`` (not even that)."""
    levels = snap.asks if side == "LONG" else snap.bids
    price = walk_levels(levels, notional_usd)
    if price is not None:
        return price, "exact"
    depth = snap.ask_depth if side == "LONG" else snap.bid_depth
    for band in sorted(depth):
        if depth[band] * snap.mid >= notional_usd:
            return snap.mid * (1 + _sign(side) * band / 1e4), "bound"
    return None, "none"


def price_cost_bp(side, price, ref_mid):
    """Signed cost of trading at ``price`` against ``ref_mid`` (positive = worse than the mid), in bp."""
    return _sign(side) * (price - ref_mid) / ref_mid * 1e4


def taker_cost(snap, side, notional_usd, fee_bp=TAKER_FEE_BP):
    """Breakdown of one market order at one snapshot, or ``None`` when the book cannot absorb the size."""
    price, kind = execution_price(snap, side, notional_usd)
    if price is None:
        return None
    best = snap.ask if side == "LONG" else snap.bid
    half_spread = price_cost_bp(side, best, snap.mid)
    total_price_cost = price_cost_bp(side, price, snap.mid)
    return {"price": price, "kind": kind, "half_spread_bp": half_spread, "impact_bp": total_price_cost - half_spread,
            "fee_bp": fee_bp, "total_bp": total_price_cost + fee_bp}


def _quantiles(values):
    if not values:
        return None
    ordered = sorted(values)
    pick = lambda q: ordered[min(len(ordered) - 1, int(q * len(ordered)))]
    return {"n": len(ordered), "mean": statistics.fmean(ordered), "p10": pick(0.10), "p50": pick(0.50),
            "p90": pick(0.90)}


def taker_report(snaps, sizes_usd=DEFAULT_SIZES_USD):
    """Per size and side: spread, impact and total one-side cost (fee included) over all snapshots."""
    out = {}
    for size in sizes_usd:
        for side in ("LONG", "SHORT"):
            rows = [taker_cost(s, side, size) for s in snaps]
            ok = [r for r in rows if r is not None]
            out["{:g}_{}".format(size, side)] = {
                "size_usd": size, "side": side, "snapshots": len(rows),
                "exact_share": sum(r["kind"] == "exact" for r in ok) / len(rows) if rows else None,
                "bound_share": sum(r["kind"] == "bound" for r in ok) / len(rows) if rows else None,
                "uncovered_share": (len(rows) - len(ok)) / len(rows) if rows else None,
                "half_spread_bp": _quantiles([r["half_spread_bp"] for r in ok]),
                "impact_bp": _quantiles([r["impact_bp"] for r in ok]),
                "total_bp": _quantiles([r["total_bp"] for r in ok]),
            }
    return out


def taker_curve(snaps, sizes_usd):
    """Median one-side total cost (bp, fee included) for any list of notionals, per side: the lookup a sizing
    module needs (e.g. 175, 340 or 620 USD). ``None`` where the book cannot absorb the size."""
    out = {}
    for size in sizes_usd:
        out[size] = {}
        for side in ("LONG", "SHORT"):
            costs = [c["total_bp"] for c in (taker_cost(s, side, size) for s in snaps) if c is not None]
            out[size][side] = statistics.median(costs) if costs else None
    return out


def spread_by_hour(snaps):
    """Quoted spread (bp) per UTC hour of the day: count, median, p90."""
    buckets = {}
    for s in snaps:
        buckets.setdefault(int(s.t // HOUR_MS % 24), []).append(s.spread_bp)
    return {h: _quantiles(v) for h, v in sorted(buckets.items())}


def liquidity_report(snaps, bands=(5, 10, 25, 50, 100)):
    """USD resting within each band of the mid, per side (median and the thin 10th percentile)."""
    out = {}
    for band in bands:
        for name, attr in (("bid", "bid_depth"), ("ask", "ask_depth")):
            vals = [getattr(s, attr)[band] * s.mid for s in snaps if band in getattr(s, attr)]
            q = _quantiles(vals)
            out["{}_{}bp".format(name, band)] = None if q is None else {"n": q["n"], "p10_usd": q["p10"], "p50_usd": q["p50"]}
    return out


# --------------------------------------------------------------------------------------------- maker model

class TradeTape:
    """Public trades in time order: ``(time_ms, price, taker_side, qty_or_None)``. ``qty`` is optional because the
    on-demand history tape (``futures_tape``) does not keep sizes; without it the queue cannot be accounted for."""

    def __init__(self, rows, lo=None, hi=None):
        rows = sorted(rows, key=lambda r: r[0])
        self.times = [r[0] for r in rows]
        self.rows = rows
        self.lo = lo if lo is not None else (self.times[0] if rows else None)
        self.hi = hi if hi is not None else (self.times[-1] if rows else None)

    @classmethod
    def from_maker_tape(cls, tape):
        return cls([(t, float(p), s, None) for t, p, s in zip(tape.times, tape.prices, tape.sides)], tape.lo, tape.hi)

    def covers(self, lo_ms, hi_ms):
        return self.lo is not None and self.lo <= lo_ms and hi_ms <= self.hi

    def between(self, lo_ms, hi_ms):
        return self.rows[bisect.bisect_right(self.times, lo_ms):bisect.bisect_right(self.times, hi_ms)]


def _limit_and_queue(snap, side):
    levels = snap.bids if side == "LONG" else snap.asks
    return levels[0]


def simulate_limit(snaps, times, index, side, size_usd, *, tape=None, ttl_ms=DEFAULT_TTL_MS,
                   latency_ms=DEFAULT_LATENCY_MS, max_gap_ms=DEFAULT_MAX_GAP_MS):
    """One post-only entry placed at ``snaps[index]`` at the passive touch (bid for a long, ask for a short).

    Returns ``{"status", "limit", "optimistic": fill_ms|None, "conservative": fill_ms|None}``; ``status`` is ``ok``
    or ``no_data`` (a collector gap inside the order window: the order is excluded, not counted as unfilled).

    * With a tape: optimistic = any opposite-side trade at or through the limit; conservative = strictly through the
      limit, or at the limit once the traded quantity there exceeds the queue ahead plus our own size (needs
      quantities; without them touches never count).
    * Without a tape (book only): optimistic = a later snapshot whose opposite best reached our price, or whose own
      best moved away from it (the level was eaten *or cancelled*: indistinguishable); conservative = only the
      opposite best reaching our price. Fill time is the snapshot time, up to one interval late.
    """
    s0 = snaps[index]
    start, deadline = s0.t + latency_ms, s0.t + latency_ms + ttl_ms
    j = index
    while j + 1 < len(snaps) and snaps[j].t < deadline:
        if snaps[j + 1].t - snaps[j].t > max_gap_ms:
            return {"status": "no_data", "limit": None, "optimistic": None, "conservative": None}
        j += 1
    if snaps[j].t < deadline - max_gap_ms:
        return {"status": "no_data", "limit": None, "optimistic": None, "conservative": None}
    long = side == "LONG"
    limit, queue_ahead = _limit_and_queue(s0, side)
    own_qty = size_usd / limit
    optimistic = conservative = None
    if tape is not None:
        if not tape.covers(start, deadline):
            return {"status": "no_data", "limit": None, "optimistic": None, "conservative": None}
        wanted = "sell" if long else "buy"
        at_limit_qty, qty_known = 0.0, True
        for t, price, taker_side, qty in tape.between(start, deadline):
            if taker_side != wanted:
                continue
            through = price < limit if long else price > limit
            touch = price == limit
            if optimistic is None and (through or touch):
                optimistic = t
            if through and conservative is None:
                conservative = t
            if touch and conservative is None:
                if qty is None:
                    qty_known = False
                else:
                    at_limit_qty += qty
                    if qty_known and at_limit_qty >= queue_ahead + own_qty:
                        conservative = t
            if optimistic is not None and conservative is not None:
                break
    else:
        for s in snaps[index + 1:j + 1]:
            if s.t < start:
                continue
            crossed = s.ask <= limit if long else s.bid >= limit
            moved = s.bid < limit if long else s.ask > limit
            if conservative is None and crossed:
                conservative = s.t
            if optimistic is None and (crossed or moved):
                optimistic = s.t
            if optimistic is not None and conservative is not None:
                break
    if conservative is not None and (optimistic is None or conservative < optimistic):
        optimistic = conservative  # the conservative fill is also an optimistic one
    return {"status": "ok", "limit": limit, "optimistic": optimistic, "conservative": conservative}


def _mid_at(snaps, times, target_ms, tol_ms):
    """Mid of the first snapshot at or after ``target_ms`` within ``tol_ms``, else ``None``."""
    i = bisect.bisect_left(times, target_ms)
    if i < len(snaps) and snaps[i].t - target_ms <= tol_ms:
        return snaps[i].mid
    return None


def _snap_at(snaps, times, target_ms, tol_ms):
    i = bisect.bisect_left(times, target_ms)
    if i < len(snaps) and snaps[i].t - target_ms <= tol_ms:
        return snaps[i]
    return None


class Order:
    """One intended entry. ``signal_ms``: when the decision was taken. ``ref``: index of the last snapshot at or
    before the signal, the only price known at that moment (every cost is measured against its mid). ``exec``: index
    of the first snapshot at or after ``signal_ms + latency``, where a market order walks the book or a limit is
    posted. Between ``ref`` and ``exec`` the market may have moved: that wait is a cost, not hidden."""

    __slots__ = ("signal_ms", "ref", "exec", "side")

    def __init__(self, signal_ms, ref, exec_, side):
        self.signal_ms, self.ref, self.exec, self.side = signal_ms, ref, exec_, side


def as_order(snaps, order):
    """``Order`` as is; a legacy ``(snapshot_index, side)`` decides and executes on that same snapshot."""
    if isinstance(order, Order):
        return order
    index, side = order
    return Order(snaps[index].t, index, index, side)


def gap_overlaps(gaps, lo_ms, hi_ms):
    """True when a logged collector gap (``(from_ms, to_ms, ...)``) touches ``[lo_ms, hi_ms]``."""
    return any(g[1] >= lo_ms and g[0] <= hi_ms for g in gaps)


def window_clean(snaps, times, gaps, lo_ms, hi_ms, max_gap_ms):
    """Why ``[lo_ms, hi_ms]`` cannot be trusted, or ``None`` when it can: a logged gap, snapshots further apart than
    ``max_gap_ms`` anywhere inside, or data that ends before ``hi_ms``."""
    if gap_overlaps(gaps, lo_ms, hi_ms):
        return "logged_gap"
    i = max(0, bisect.bisect_right(times, lo_ms) - 1)
    j = bisect.bisect_left(times, hi_ms)
    if j >= len(snaps) or snaps[j].t - hi_ms > max_gap_ms:
        return "data_ends"
    return "snapshot_gap" if any(snaps[k + 1].t - snaps[k].t > max_gap_ms for k in range(i, j)) else None


def evaluate_orders(snaps, orders, size_usd, *, tape=None, gaps=(), ttl_ms=DEFAULT_TTL_MS, latency_ms=DEFAULT_LATENCY_MS,
                    hold_ms=DEFAULT_HOLD_MS, markouts_ms=DEFAULT_MARKOUTS_MS, max_gap_ms=DEFAULT_MAX_GAP_MS,
                    maker_fee_bp=MAKER_FEE_BP, taker_fee_bp=TAKER_FEE_BP):
    """Per-order economics of a limit entry against going to market at once, for each hypothetical fill scenario.

    ``orders``: ``Order`` (or legacy ``(snapshot_index, side)``). Every figure is in bp of the mid known at the
    signal and is *entry to ``signal + hold_ms``, before the exit* (the exit is the same taker exit in every policy,
    so it cancels in every comparison). Policies: ``taker`` (market at once), ``skip`` (limit; unfilled = no trade,
    zero), ``chase`` (limit; unfilled = market at the end of the TTL, paying the drift it waited through).

    An order is excluded, with the reason in ``excluded_reason``, when anything in its whole window (reference
    snapshot to the later of the hold, the chase and the last markout) crosses a logged ``book_gap`` or a
    stretch of snapshots further apart than ``max_gap_ms``, or when a needed price is missing.
    """
    times = [s.t for s in snaps]
    rows = []
    for raw in orders:
        o = as_order(snaps, raw)
        ref_snap, s0, sign = snaps[o.ref], snaps[o.exec], _sign(o.side)
        base = {"t": ref_snap.t, "signal_ms": o.signal_ms, "side": o.side, "excluded": True}
        end = max(o.signal_ms + hold_ms, s0.t + latency_ms + ttl_ms + max(markouts_ms, default=0))
        reason = window_clean(snaps, times, gaps, ref_snap.t, end, max_gap_ms)
        if reason is not None:
            rows.append(dict(base, excluded_reason=reason))
            continue
        mid_hold = _mid_at(snaps, times, o.signal_ms + hold_ms, max_gap_ms)
        taker = taker_cost(s0, o.side, size_usd, taker_fee_bp)
        sim = simulate_limit(snaps, times, o.exec, o.side, size_usd, tape=tape, ttl_ms=ttl_ms, latency_ms=latency_ms,
                             max_gap_ms=max_gap_ms)
        chase_snap = _snap_at(snaps, times, s0.t + latency_ms + ttl_ms, max_gap_ms)
        chase = taker_cost(chase_snap, o.side, size_usd, taker_fee_bp) if chase_snap is not None else None
        if mid_hold is None or taker is None or chase is None or sim["status"] != "ok":
            rows.append(dict(base, excluded_reason="missing_price"))
            continue
        ref_mid = ref_snap.mid
        move = lambda price: sign * (mid_hold - price) / ref_mid * 1e4  # known-at-signal mid to hold, gross
        taker_pnl = move(taker["price"]) - taker_fee_bp
        row = dict(base, excluded=False, taker_bp=taker_pnl,
                   taker_entry_cost_bp=price_cost_bp(o.side, taker["price"], ref_mid) + taker_fee_bp,
                   wait_bp=sign * (s0.mid - ref_mid) / ref_mid * 1e4)
        chase_pnl = move(chase["price"]) - taker_fee_bp
        for reading in SCENARIOS:
            fill_ms = sim[reading]
            filled = fill_ms is not None
            maker_pnl = move(sim["limit"]) - maker_fee_bp if filled else None
            row[reading] = {
                "filled": filled, "maker_bp": maker_pnl,
                "entry_cost_bp": price_cost_bp(o.side, sim["limit"], ref_mid) + maker_fee_bp if filled else None,
                "skip_bp": maker_pnl if filled else 0.0,
                "chase_bp": maker_pnl if filled else chase_pnl,
                "markout_bp": {},
            }
            if filled:
                for h in markouts_ms:
                    later = _mid_at(snaps, times, fill_ms + h, max_gap_ms)
                    row[reading]["markout_bp"][h] = None if later is None else sign * (later - sim["limit"]) / sim["limit"] * 1e4
        rows.append(row)
    return rows


def clustered_mean(values, clusters):
    """``(mean, standard_error, n, n_clusters)`` with the error clustered (sum of cluster deviations)."""
    n = len(values)
    if n == 0:
        return None, None, 0, 0
    mean = statistics.fmean(values)
    by = {}
    for v, c in zip(values, clusters):
        by[c] = by.get(c, 0.0) + (v - mean)
    se = math.sqrt(sum(d * d for d in by.values())) / n if len(by) > 1 else None
    return mean, se, n, len(by)


def summarize_orders(rows, *, cluster_ms=DEFAULT_CLUSTER_MS, markouts_ms=DEFAULT_MARKOUTS_MS):
    """Aggregate ``evaluate_orders`` rows per fill reading, with clustered standard errors."""
    ok = [r for r in rows if not r["excluded"]]
    reasons = {}
    for r in rows:
        if r["excluded"]:
            reasons[r.get("excluded_reason", "other")] = reasons.get(r.get("excluded_reason", "other"), 0) + 1
    out = {"orders": len(rows), "excluded": len(rows) - len(ok), "excluded_reasons": reasons, "taker_all_bp": None,
           "scenario_note": SCENARIO_NOTE}
    if not ok:
        return out
    cl = lambda rs: [r["t"] // cluster_ms for r in rs]
    all_taker = [r["taker_bp"] for r in ok]
    out["taker_all_bp"] = dict(zip(("mean", "se", "n", "clusters"), clustered_mean(all_taker, cl(ok))))
    out["taker_entry_cost_bp"] = statistics.fmean(r["taker_entry_cost_bp"] for r in ok)
    out["wait_signal_to_execution_bp"] = statistics.fmean(r["wait_bp"] for r in ok)
    for reading in SCENARIOS:
        filled = [r for r in ok if r[reading]["filled"]]
        res = {"hypothetical_fill_rate": len(filled) / len(ok), "hypothetical_fills": len(filled)}
        mean_all = statistics.fmean(all_taker)
        if filled:
            saving = [r[reading]["maker_bp"] - r["taker_bp"] for r in filled]
            res["saving_filled_bp"] = dict(zip(("mean", "se", "n", "clusters"), clustered_mean(saving, cl(filled))))
            res["selection_bp"] = statistics.fmean(r["taker_bp"] for r in filled) - mean_all
            net = [r[reading]["maker_bp"] - mean_all for r in filled]
            res["net_vs_random_bp"] = dict(zip(("mean", "se", "n", "clusters"), clustered_mean(net, cl(filled))))
            res["entry_cost_filled_bp"] = statistics.fmean(r[reading]["entry_cost_bp"] for r in filled)
            res["markout_bp"] = {}
            for h in markouts_ms:
                vals = [(r[reading]["markout_bp"].get(h), r) for r in filled]
                vals = [(v, r) for v, r in vals if v is not None]
                res["markout_bp"][h] = (dict(zip(("mean", "se", "n", "clusters"), clustered_mean([v for v, _ in vals], cl([r for _, r in vals]))))
                                        if vals else None)
        chase = [r[reading]["chase_bp"] - r["taker_bp"] for r in ok]
        res["chase_minus_taker_bp"] = dict(zip(("mean", "se", "n", "clusters"), clustered_mean(chase, cl(ok))))
        res["skip_minus_taker_bp"] = statistics.fmean(r[reading]["skip_bp"] - r["taker_bp"] for r in ok)
        res["verdict"] = verdict(res["chase_minus_taker_bp"])
        out[reading] = res
    return out


def verdict(paired):
    """Words that never outrun the sample: the paired chase-minus-taker difference against two clustered errors."""
    mean, se, n, clusters = paired["mean"], paired["se"], paired["n"], paired["clusters"]
    if se is None or clusters < MIN_CLUSTERS_FOR_VERDICT:
        return "insufficient_data"
    if mean - 2 * se > 0:
        return "maker_helps"
    if mean + 2 * se < 0:
        return "maker_hurts"
    return "inconclusive"


# --------------------------------------------------------------------------------------------- total cost

def funding_cost_bp(side, rate_bp_per_hour, hours):
    """Funding paid over the hold (positive = paid): a long pays a positive rate, a short receives it."""
    return _sign(side) * rate_bp_per_hour * hours


def round_trip_cost_bp(side, size_usd, entry_snap, exit_snap, *, entry="taker", limit=None, rate_bp_per_hour=None,
                       hours=0.0):
    """Entry + exit + funding for one concrete trade, split by component.

    ``entry="maker"`` needs the ``limit`` price actually obtained; the exit is always a taker walk of ``exit_snap``
    (against that snapshot's mid, the stop-style spread payment included in the walk). ``rate_bp_per_hour=None``
    leaves funding out and says so (``funding_bp`` is ``None``): unknown funding is not turned into zero.
    """
    ref = entry_snap.mid
    if entry == "maker":
        entry_price_cost, entry_fee, entry_kind = price_cost_bp(side, limit, ref), MAKER_FEE_BP, "limit"
    else:
        t = taker_cost(entry_snap, side, size_usd)
        entry_price_cost, entry_fee, entry_kind = t["half_spread_bp"] + t["impact_bp"], TAKER_FEE_BP, t["kind"]
    leaving = "SHORT" if side == "LONG" else "LONG"  # closing a long sells, so it walks the bids
    x = taker_cost(exit_snap, leaving, size_usd)
    exit_cost = x["half_spread_bp"] + x["impact_bp"]
    funding = None if rate_bp_per_hour is None else funding_cost_bp(side, rate_bp_per_hour, hours)
    total = entry_price_cost + entry_fee + exit_cost + TAKER_FEE_BP + (funding or 0.0)
    return {"entry_price_bp": entry_price_cost, "entry_fee_bp": entry_fee, "entry_kind": entry_kind,
            "exit_price_bp": exit_cost, "exit_fee_bp": TAKER_FEE_BP, "funding_bp": funding, "total_bp": total}


# --------------------------------------------------------------------------------------------- report

def grid_orders(snaps, step_ms, sides=("LONG", "SHORT")):
    """Unconditional placement times: one order per side every ``step_ms``. Real signals are conditional (they
    tend to come when the market moves, which is when fills are most adverse): rerun with the strategies' own
    signal times (``--signals``) before trusting the unconditional numbers for a strategy."""
    out, next_t = [], None
    for i, s in enumerate(snaps):
        if next_t is None or s.t >= next_t:
            out.extend(Order(s.t, i, i, side) for side in sides)
            next_t = s.t + step_ms
    return out


def signal_orders(snaps, signals, *, latency_ms=DEFAULT_LATENCY_MS, max_ref_age_ms=DEFAULT_MAX_GAP_MS,
                  max_gap_ms=DEFAULT_MAX_GAP_MS):
    """``(orders, unevaluable)`` from ``[{"time_ms", "side"}]``.

    The reference is the last snapshot *at or before* the signal (what was known when it was emitted, at most
    ``max_ref_age_ms`` old); execution is the first snapshot at or after ``signal + latency``. A signal without a
    recent reference, or without an execution snapshot within ``max_gap_ms``, is not evaluable and is counted, not
    guessed."""
    times = [s.t for s in snaps]
    orders, unevaluable = [], {"no_reference": 0, "no_execution_snapshot": 0}
    for sig in signals:
        t = sig["time_ms"]
        r = bisect.bisect_right(times, t) - 1
        if r < 0 or t - times[r] > max_ref_age_ms:
            unevaluable["no_reference"] += 1
            continue
        e = bisect.bisect_left(times, t + latency_ms)
        if e >= len(snaps) or snaps[e].t - (t + latency_ms) > max_gap_ms:
            unevaluable["no_execution_snapshot"] += 1
            continue
        orders.append(Order(t, r, e, sig["side"]))
    return orders, unevaluable


def compare_with_cost_table(product_id, snaps, size_usd=1000.0):
    """Measured one-side price cost (half spread + impact, no fee) at ``size_usd`` against the static table that
    drives every paper book (``futures_costs``). Positive ``gap_bp`` = the table is optimistic."""
    from . import futures_costs

    costs = [taker_cost(s, side, size_usd) for s in snaps for side in ("LONG", "SHORT")]
    costs = [c for c in costs if c is not None]
    if not costs:
        return None
    measured = statistics.median(c["half_spread_bp"] + c["impact_bp"] for c in costs)
    table = float(futures_costs.side_impact_bps(product_id))
    return {"table_side_impact_bp": table, "measured_median_bp": measured, "gap_bp": measured - table,
            "product_measured_in_table": futures_costs.is_measured(product_id)}


def coverage_report(snaps, gaps, bad_rows, lo_ms, hi_ms, interval_ms=5_000):
    expected = max(1, (hi_ms - lo_ms) // interval_ms) if hi_ms > lo_ms else 1
    breaks = [(a.t, b.t) for a, b in zip(snaps, snaps[1:]) if b.t - a.t > DEFAULT_MAX_GAP_MS]
    return {"snapshots": len(snaps), "expected_at_5s": expected, "coverage": len(snaps) / expected,
            "unusable_rows": bad_rows, "breaks_over_15s": len(breaks),
            "longest_break_s": max([(b - a) / 1000 for a, b in breaks], default=0),
            "logged_gaps": len(gaps)}


def build_report(book_db_path, product_id, *, lo_ms=None, hi_ms=None, sizes_usd=DEFAULT_SIZES_USD,
                 order_size_usd=100.0, ttl_ms=DEFAULT_TTL_MS, hold_ms=DEFAULT_HOLD_MS, step_ms=300_000,
                 signals=None, tape=None):
    snaps, bad = load_snapshots(book_db_path, product_id, lo_ms, hi_ms)
    gaps = load_gaps(book_db_path, product_id, lo_ms, hi_ms)
    if not snaps:
        return {"version": BOOK_COSTS_VERSION, "product_id": product_id, "snapshots": 0}
    if signals is not None:
        orders, unevaluable = signal_orders(snaps, signals)
    else:
        orders, unevaluable = grid_orders(snaps, step_ms), {}
    rows = evaluate_orders(snaps, orders, order_size_usd, tape=tape, gaps=gaps, ttl_ms=ttl_ms, hold_ms=hold_ms)
    maker = summarize_orders(rows)
    maker["unevaluable_signals"] = unevaluable
    return {
        "version": BOOK_COSTS_VERSION, "product_id": product_id, "range_ms": [snaps[0].t, snaps[-1].t],
        "parameters": {"order_size_usd": order_size_usd, "ttl_ms": ttl_ms, "hold_ms": hold_ms, "step_ms": step_ms,
                       "maker_fee_bp": MAKER_FEE_BP, "taker_fee_bp": TAKER_FEE_BP,
                       "placement": "signals" if signals is not None else "grid_unconditional",
                       "fills": "tape" if tape is not None else "book_only_snapshots"},
        "coverage": coverage_report(snaps, gaps, bad, snaps[0].t, snaps[-1].t),
        "observed": {"spread_by_hour_utc": spread_by_hour(snaps), "liquidity": liquidity_report(snaps)},
        "simulated_taker": taker_report(snaps, sizes_usd),
        "taker_curve_bp": taker_curve(snaps, sizes_usd),
        "cost_table_check": compare_with_cost_table(product_id, snaps),
        "estimated_maker": maker,
    }


def _fmt(x, nd=2):
    return "n/d" if x is None else "{:.{}f}".format(x, nd)


def render_markdown(report):
    if not report.get("snapshots", 1):
        return "# Costes de ejecución {}\n\nSin snapshots en el rango.\n".format(report["product_id"])
    p, c, m = report["parameters"], report["coverage"], report["estimated_maker"]
    lines = ["# Costes de ejecución {} ({})".format(report["product_id"], report["version"]), "",
             "Cobertura: {} snapshots ({} % de lo esperado a 5 s), {} cortes > 15 s, corte máximo {} s.".format(
                 c["snapshots"], _fmt(c["coverage"] * 100, 1), c["breaks_over_15s"], _fmt(c["longest_break_s"], 0)),
             "Colocación: {}; fills: {}. Las ejecuciones maker son **escenarios hipotéticos**, no fills reales.".format(
                 p["placement"], p["fills"]), "", "## Taker simulado (observado + determinista)",
             "| Tamaño | Lado | Medio spread | Impacto | Total con comisión (p50) | p90 | Sin cubrir |", "|---|---|---|---|---|---|---|"]
    for row in report["simulated_taker"].values():
        if row["total_bp"]:
            lines.append("| {:g} USD | {} | {} | {} | {} | {} | {} % |".format(
                row["size_usd"], row["side"], _fmt(row["half_spread_bp"]["p50"]), _fmt(row["impact_bp"]["p50"]),
                _fmt(row["total_bp"]["p50"]), _fmt(row["total_bp"]["p90"]), _fmt(row["uncovered_share"] * 100, 1)))
    chk = report["cost_table_check"]
    if chk:
        lines += ["", "Tabla estática de costes frente a lo medido (1.000 USD, un lado): tabla {} pb, medido {} pb, "
                  "diferencia {} pb (positivo = la tabla es optimista).".format(
                      _fmt(chk["table_side_impact_bp"]), _fmt(chk["measured_median_bp"]), _fmt(chk["gap_bp"]))]
    lines += ["", "## Escenarios maker hipotéticos (optimista / conservador)",
              "Ninguno es un fill demostrado, ni una cota inferior de fills reales, ni una probabilidad calibrada.",
              "Órdenes: {} ({} excluidas: {}). Taker inmediato, media señal→{} min: {} pb; espera señal→ejecución: {} pb.".format(
                  m["orders"], m["excluded"], m.get("excluded_reasons") or "ninguna", p["hold_ms"] // 60_000,
                  _fmt((m.get("taker_all_bp") or {}).get("mean")), _fmt(m.get("wait_signal_to_execution_bp"))),
              "Señales no evaluables: {}.".format(m.get("unevaluable_signals") or "n/a"),
              "", "| Escenario | Relleno hipotético | Ahorro si se rellena | Selección | Neto vs azar | Límite y perseguir − taker | Grupos horarios | Veredicto |",
              "|---|---|---|---|---|---|---|---|"]
    for reading in SCENARIOS:
        r = m.get(reading)
        if r:
            sav = r.get("saving_filled_bp") or {}
            net = r.get("net_vs_random_bp") or {}
            ch = r["chase_minus_taker_bp"]
            lines.append("| {} | {} % | {} | {} | {} ± {} | {} ± {} | {} | {} |".format(
                reading, _fmt(r["hypothetical_fill_rate"] * 100, 1), _fmt(sav.get("mean")), _fmt(r.get("selection_bp")),
                _fmt(net.get("mean")), _fmt(net.get("se")), _fmt(ch["mean"]), _fmt(ch["se"]), ch["clusters"],
                r["verdict"]))
    lines.append("Veredicto: exige al menos {} grupos horarios independientes.".format(MIN_CLUSTERS_FOR_VERDICT))
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--book-db", required=True)
    ap.add_argument("--product", default="PF_XBTUSD")
    ap.add_argument("--from-ms", type=int)
    ap.add_argument("--to-ms", type=int)
    ap.add_argument("--order-usd", type=float, default=100.0)
    ap.add_argument("--sizes", default=",".join("{:g}".format(x) for x in DEFAULT_SIZES_USD), help="notionals in USD for the taker table, e.g. 100,175,340,620,1000")
    ap.add_argument("--ttl-s", type=float, default=DEFAULT_TTL_MS / 1000)
    ap.add_argument("--hold-min", type=float, default=DEFAULT_HOLD_MS / 60_000)
    ap.add_argument("--step-s", type=float, default=300)
    ap.add_argument("--signals", help="JSON [{time_ms, side}] with the strategy's own signal times")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    signals = None
    if args.signals:
        with open(args.signals) as handle:
            signals = json.load(handle)
    report = build_report(args.book_db, args.product, lo_ms=args.from_ms, hi_ms=args.to_ms, order_size_usd=args.order_usd,
                          sizes_usd=tuple(float(x) for x in args.sizes.split(",")),
                          ttl_ms=int(args.ttl_s * 1000), hold_ms=int(args.hold_min * 60_000), step_ms=int(args.step_s * 1000),
                          signals=signals)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "report.json"), "w") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
    with open(os.path.join(args.out, "report.md"), "w") as handle:
        handle.write(render_markdown(report))
    print(render_markdown(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
