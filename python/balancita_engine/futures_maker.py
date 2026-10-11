"""Maker simulator: what a patient (post-only limit) entry would have saved, judged against the trade tape.

The paper books enter as takers: they pay the 0.05 % fee and the product's one-side impact. A resting limit
order pays the 0.02 % maker fee and no impact, but it is filled only when the market comes to it, and the
fills it gets are the unlucky ones (adverse selection). This module measures both sides on the same signals
and with no look-ahead, so the saving is not a mirage.

Rules, deliberately conservative (the tape is the only evidence, there is no book history):

* The order is posted ``latency_ms`` after the signal at the passive touch: a long rests at the last price a
  *seller* traded at, a short at the last price a *buyer* traded at (never inside the spread).
* It is filled only by a trade that goes strictly *through* the limit (``touch=False``, the default: a sell below a long's
  limit, a buy above a short's); queue position at the limit price itself is unknown, so a trade exactly at the
  limit counts only with ``touch=True`` (optimistic, reported separately).
* It is cancelled unfilled when ``ttl_ms`` passes, when price trades through the signal's stop first, or when the
  original trade had already exited. No chasing: an unfilled signal is a skipped trade.
* The exit is unchanged (taker, with its recorded exit price), so a filled trade is re-priced from the actual
  limit: gross from the limit price, maker fee on entry, taker fee on exit, the trade's own funding.

The headline is not "fills are cheaper" but ``skip_total_usd`` against ``taker_total_usd``: if the trades the
limit misses are the winners, the saving disappears. ``selection_bp`` shows that effect directly.

    python -m balancita_engine.futures_maker --market-db market.sqlite --forward-db forward.sqlite [--ttl-s 60]
"""

import argparse
import bisect
import json
import sqlite3
import statistics
import sys
from decimal import Decimal

from .futures_costs import fee_rate

TEN_THOUSAND = Decimal(10_000)
DEFAULT_LATENCY_MS = 100
DEFAULT_TTL_MS = 60_000
MARKOUT_MS = 60_000
MIN_FILLED_FOR_VERDICT = 30


class Tape:
    """Trades of one product in time order: parallel arrays so lookups are bisections."""

    def __init__(self, rows):
        rows = sorted(rows, key=lambda r: r[0])
        self.times = [r[0] for r in rows]
        self.prices = [Decimal(str(r[1])) for r in rows]
        self.sides = [r[2] for r in rows]  # taker side: "buy" lifts the ask, "sell" hits the bid

    def __len__(self):
        return len(self.times)

    def covers(self, time_ms):
        return bool(self.times) and self.times[0] <= time_ms <= self.times[-1]

    def passive_touch(self, side, time_ms):
        """Last price a seller (for a long) or buyer (for a short) traded at, at or before ``time_ms``."""
        wanted = "sell" if side == "LONG" else "buy"
        i = bisect.bisect_right(self.times, time_ms) - 1
        while i >= 0:
            if self.sides[i] == wanted:
                return self.prices[i]
            i -= 1
        return None

    def last_price(self, time_ms):
        i = bisect.bisect_right(self.times, time_ms) - 1
        return self.prices[i] if i >= 0 else None


def load_tape(market_db_path, product_id, start_ms, end_ms):
    """Fill trades of one product in ``[start_ms, end_ms]`` from the capture DB (read only)."""
    db = sqlite3.connect("file:{}?mode=ro".format(market_db_path), uri=True)
    try:
        rows = []
        cursor = db.execute(
            "SELECT event_time, normalized_json FROM paper_futures_market_events "
            "WHERE feed='trade' AND product_id=? AND event_time BETWEEN ? AND ? ORDER BY event_time",
            (product_id, start_ms, end_ms))
        for event_time, normalized in cursor:
            event = json.loads(normalized)
            if event.get("tradeType", "fill") not in ("fill",):
                continue
            rows.append((event_time, event["priceUsd"], event["side"]))
        return Tape(rows)
    finally:
        db.close()


def simulate_entry(side, signal_ms, stop_price, tape, *, exit_ms=None, ttl_ms=DEFAULT_TTL_MS,
                   latency_ms=DEFAULT_LATENCY_MS, touch=False):
    """One post-only entry: ``{"filled", "limit", "fill_ms", "reason"}``."""
    posted = signal_ms + latency_ms
    limit = tape.passive_touch(side, posted)
    if limit is None:
        return {"filled": False, "limit": None, "fill_ms": None, "reason": "no_reference"}
    stop = Decimal(str(stop_price)) if stop_price is not None else None
    long = side == "LONG"
    deadline = posted + ttl_ms
    if exit_ms is not None:
        deadline = min(deadline, exit_ms)
    i = bisect.bisect_right(tape.times, posted)
    while i < len(tape.times) and tape.times[i] <= deadline:
        price, taker = tape.prices[i], tape.sides[i]
        if stop is not None and ((long and price <= stop) or (not long and price >= stop)):
            return {"filled": False, "limit": limit, "fill_ms": None, "reason": "stop_first"}
        if long and taker == "sell" and (price < limit or (touch and price == limit)):
            return {"filled": True, "limit": limit, "fill_ms": tape.times[i], "reason": "filled"}
        if not long and taker == "buy" and (price > limit or (touch and price == limit)):
            return {"filled": True, "limit": limit, "fill_ms": tape.times[i], "reason": "filled"}
        i += 1
    if tape.times and tape.times[-1] < deadline:
        return {"filled": False, "limit": limit, "fill_ms": None, "reason": "tape_ended"}
    return {"filled": False, "limit": limit, "fill_ms": None, "reason": "expired"}


def maker_trade_net_bp(trade, limit, *, entry_kind="maker"):
    """Net bp of ``trade`` had it entered at ``limit`` instead: same recorded exit, funding and exit fee.

    With ``limit == entry_price`` and ``entry_kind="taker"`` this reproduces the recorded ``net_bp``.
    """
    limit = Decimal(str(limit))
    exit_price = Decimal(str(trade["exit_price"]))
    notional = Decimal(str(trade["notional_usd"]))
    quantity = notional / limit
    long = trade["side"] == "LONG"
    gross = (exit_price - limit) * quantity if long else (limit - exit_price) * quantity
    fees = limit * quantity * fee_rate(entry_kind) + exit_price * quantity * fee_rate("taker")
    funding = Decimal(str(trade.get("funding_usd", 0)))
    return (gross - fees - funding) / notional * TEN_THOUSAND


def markout_bp(side, fill_price, tape, fill_ms, horizon_ms=MARKOUT_MS):
    """Signed move after the fill in the trade's direction (negative = the market ran away against us)."""
    later = tape.last_price(fill_ms + horizon_ms)
    if later is None or not tape.covers(fill_ms + horizon_ms):
        return None
    move = (later - fill_price) / fill_price * TEN_THOUSAND
    return move if side == "LONG" else -move


def _mean(values):
    return statistics.fmean(values) if values else None


def _se(values):
    return statistics.stdev(values) / len(values) ** 0.5 if len(values) > 1 else None


def study(trades, tapes, *, ttl_ms=DEFAULT_TTL_MS, latency_ms=DEFAULT_LATENCY_MS, touch=False):
    """Taker against maker-or-skip on the same signals.

    ``trades`` are forward/replay trade dicts with ``product_id``; ``tapes`` maps product -> ``Tape``.
    Trades whose signal time the tape does not cover are counted as ``no_tape`` and left out of every figure.
    """
    rows, no_tape = [], 0
    for trade in trades:
        tape = tapes.get(trade["product_id"])
        signal_ms = trade["entry_time_ms"]
        if tape is None or not tape.covers(signal_ms) or not tape.covers(trade["exit_time_ms"]):
            no_tape += 1
            continue
        result = simulate_entry(trade["side"], signal_ms, trade.get("stop_price"), tape,
                                exit_ms=trade["exit_time_ms"], ttl_ms=ttl_ms, latency_ms=latency_ms, touch=touch)
        row = {"trade": trade, "result": result, "taker_bp": float(trade["net_bp"]),
               "taker_usd": float(trade["pnl_usd"])}
        if result["filled"]:
            maker_bp = float(maker_trade_net_bp(trade, result["limit"]))
            row["maker_bp"] = maker_bp
            row["maker_usd"] = maker_bp * float(trade["notional_usd"]) / 10_000
            row["markout_bp"] = markout_bp(trade["side"], result["limit"], tape, result["fill_ms"])
        rows.append(row)
    filled = [r for r in rows if r["result"]["filled"]]
    missed = [r for r in rows if not r["result"]["filled"]]
    reasons = {}
    for r in missed:
        reasons[r["result"]["reason"]] = reasons.get(r["result"]["reason"], 0) + 1
    saving = [r["maker_bp"] - r["taker_bp"] for r in filled]
    out = {
        "signals": len(rows), "no_tape": no_tape, "filled": len(filled),
        "fill_rate": len(filled) / len(rows) if rows else None, "missed_reasons": reasons,
        "taker_all_mean_bp": _mean([r["taker_bp"] for r in rows]),
        "taker_filled_mean_bp": _mean([r["taker_bp"] for r in filled]),
        "taker_missed_mean_bp": _mean([r["taker_bp"] for r in missed]),
        "maker_filled_mean_bp": _mean([r["maker_bp"] for r in filled]),
        "saving_bp": _mean(saving), "saving_se_bp": _se(saving),
        "selection_bp": (None if not filled or not missed else
                         _mean([r["taker_bp"] for r in filled]) - _mean([r["taker_bp"] for r in missed])),
        "markout_60s_bp": _mean([r["markout_bp"] for r in filled if r["markout_bp"] is not None]),
        "taker_total_usd": sum(r["taker_usd"] for r in rows),
        "skip_total_usd": sum(r["maker_usd"] for r in filled),
        "touch_assumed": touch, "ttl_ms": ttl_ms, "latency_ms": latency_ms,
    }
    out["verdict"] = verdict(out)
    return out


def verdict(summary):
    """Plain words, never stronger than the sample allows."""
    n = summary["filled"]
    if n < MIN_FILLED_FOR_VERDICT:
        return "insufficient_data ({} fills, {} needed)".format(n, MIN_FILLED_FOR_VERDICT)
    if summary["skip_total_usd"] > summary["taker_total_usd"] and summary["saving_bp"] and summary["saving_se_bp"] \
            and summary["saving_bp"] > 2 * summary["saving_se_bp"]:
        return "maker_helps"
    if summary["saving_bp"] is not None and summary["saving_bp"] > 0 and summary["skip_total_usd"] <= summary["taker_total_usd"]:
        return "saving_eaten_by_missed_fills"
    return "no_gain"


def _forward_trades(forward_db_path):
    db = sqlite3.connect("file:{}?mode=ro".format(forward_db_path), uri=True)
    try:
        return [dict(json.loads(payload), product_id=product, strategy_id=strategy)
                for strategy, product, payload in db.execute(
                    "SELECT strategy_id, product_id, payload FROM forward_trade")]
    finally:
        db.close()


def run(market_db, forward_db, *, ttl_ms, latency_ms, touch):
    trades = _forward_trades(forward_db)
    by_product = {}
    for t in trades:
        by_product.setdefault(t["product_id"], []).append(t)
    tapes = {p: load_tape(market_db, p, min(t["entry_time_ms"] for t in ts) - 60_000,
                          max(t["exit_time_ms"] for t in ts) + 2 * MARKOUT_MS) for p, ts in by_product.items()}
    result = {"all": study(trades, tapes, ttl_ms=ttl_ms, latency_ms=latency_ms, touch=touch), "by_strategy": {}}
    for strategy in sorted({t["strategy_id"] for t in trades}):
        result["by_strategy"][strategy] = study([t for t in trades if t["strategy_id"] == strategy], tapes,
                                                ttl_ms=ttl_ms, latency_ms=latency_ms, touch=touch)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--market-db", required=True, help="capture DB with the trade tape (read only)")
    parser.add_argument("--forward-db", required=True, help="forward DB (forward_trade table) with the signals")
    parser.add_argument("--ttl-s", type=float, default=DEFAULT_TTL_MS / 1000)
    parser.add_argument("--latency-ms", type=int, default=DEFAULT_LATENCY_MS)
    parser.add_argument("--touch", action="store_true", help="count trades exactly at the limit as fills (optimistic)")
    args = parser.parse_args(argv)
    result = run(args.market_db, args.forward_db, ttl_ms=int(args.ttl_s * 1000), latency_ms=args.latency_ms,
                 touch=args.touch)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
