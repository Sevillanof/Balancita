"""How did Qwen's buy / hold / sell decisions fare against what really happened.

Reads Q's decisions DB and C's verdicts DB, both read-only, and writes nothing:
the report is recomputed from stored data, so it is deterministic and the same
on every run over the same inputs.

Two views, both with the cost model and the book of the strategy backtest
(``futures_strategy_backtest.BOOK_CONFIG``), so Qwen compares with every
strategy:

* Every decision gets a point. It is entered at the close of its decision
  bucket and judged at the close of the bucket ``HORIZON_MIN`` later (the same
  bucket the backtest's time stop exits on), with the taker fee on both sides:
  buy is right (+1) when the long net return is positive, sell when the short
  one is, and hold when neither would have been (the move did not clear the
  round trip). Otherwise it is a miss (-1). Hits and misses are counted
  separately. A decision whose horizon has not closed yet is ``pending``.
* The trading book: buy opens a long and sell a short, one position at a time,
  sized like the backtest and D (risk fraction over the stop distance plus
  costs, capped by the max notional) and with the same cost-buffer rejection.
  The protective levels are the shipped strategies' default plan (stop
  ``STOP_ATR`` ATR, target ``TARGET_STOP_RATIO`` times the stop, time stop
  ``HORIZON_MIN``); an opposite decision closes the position at the candle
  close, and hold keeps it. Its summary is the backtest's (trades, wins,
  hit rate, net bp, P&L, return, drawdown).

ASSUMPTION, as in the backtest: entry at the decision close with no latency or
slippage and no funding, so results are optimistic against D.
"""

import json
import sqlite3
import sys
from decimal import Decimal

from .futures_strategy_backtest import (
    BOOK_CONFIG,
    ONE_MINUTE_MS,
    _max_drawdown,
    _round,
    _summary,
    load_verdict_rows,
)

QUESTION_ID = "trade_action"
ACTIONS = ("buy", "hold", "sell")
HORIZON_MIN = 30
STOP_ATR = Decimal("1.5")
TARGET_STOP_RATIO = Decimal("2")
TEN_THOUSAND = Decimal(10_000)


def load_decisions(decisions_db_path, product_id, question_id=QUESTION_ID, version=None):
    """``[{bucket_start, chosen, probabilities, confidence, written_at}]`` oldest first.

    ``version`` defaults to the newest version of the question stored for the product.
    """
    db = sqlite3.connect("file:{}?mode=ro".format(decisions_db_path), uri=True)
    try:
        if version is None:
            version = db.execute(
                "SELECT MAX(question_version) FROM paper_futures_llm_decisions WHERE product_id=? AND question_id=?",
                (product_id, question_id),
            ).fetchone()[0]
        rows = db.execute(
            "SELECT bucket_start, chosen, probabilities_json, confidence, written_at "
            "FROM paper_futures_llm_decisions WHERE product_id=? AND question_id=? AND question_version=? "
            "ORDER BY bucket_start",
            (product_id, question_id, version),
        ).fetchall() if version is not None else []
    finally:
        db.close()
    return [{"bucket_start": r[0], "chosen": r[1], "probabilities": json.loads(r[2]),
             "confidence": r[3], "written_at": r[4]} for r in rows], version


def _close(verdict):
    value = ((verdict.get("features") or {}).get("1m") or {}).get("candidate_close")
    return None if value is None else Decimal(value)


def score_decisions(decisions, verdicts, *, book=BOOK_CONFIG, horizon_min=HORIZON_MIN):
    """One row per decision: ``point`` +1 / -1 (``None`` while pending) and the net bp it earned."""
    by_bucket = {v["bucket_start_ms"]: v for v in verdicts}
    round_trip_bp = Decimal(book["taker_rate"]) * 2 * TEN_THOUSAND
    rows = []
    for decision in decisions:
        bucket, chosen = decision["bucket_start"], decision["chosen"]
        row = {"bucket_start": bucket, "chosen": chosen, "confidence": decision["confidence"],
               "probabilities": decision["probabilities"], "point": None, "net_bp": None,
               "gross_bp": None, "status": "pending"}
        entry_verdict = by_bucket.get(bucket)
        exit_verdict = by_bucket.get(bucket + horizon_min * ONE_MINUTE_MS)
        entry = None if entry_verdict is None else _close(entry_verdict)
        exit_price = None if exit_verdict is None else _close(exit_verdict)
        if chosen not in ACTIONS:
            row["status"] = "unknown_option"
        elif entry is not None and entry > 0 and exit_price is not None:
            gross = (exit_price - entry) / entry * TEN_THOUSAND
            long_net, short_net = gross - round_trip_bp, -gross - round_trip_bp
            if chosen == "buy":
                net, hit = long_net, long_net > 0
            elif chosen == "sell":
                net, hit = short_net, short_net > 0
            else:
                net, hit = Decimal(0), long_net <= 0 and short_net <= 0
            row.update(status="scored", point=1 if hit else -1,
                       gross_bp=float(round(gross, 4)), net_bp=float(round(net, 4)))
        rows.append(row)
    return rows


def simulate_book(decisions, verdicts, *, book=BOOK_CONFIG, horizon_min=HORIZON_MIN):
    """Closed trades of Qwen's decisions in the backtest's book (same fields as the backtest trades)."""
    taker = Decimal(book["taker_rate"])
    buffer_rate = Decimal(book["cost_buffer_rate"])
    risk_fraction = Decimal(book["risk_fraction"])
    max_notional = Decimal(book["max_notional_usd"])
    exposure = Decimal(book["max_exposure_multiple"])
    equity = Decimal(book["initial_cash_usd"])
    chosen_at = {d["bucket_start"]: d["chosen"] for d in decisions}
    trades, skipped = [], []
    position = None
    for verdict in verdicts:
        current = (verdict.get("features") or {}).get("1m") or {}
        bucket = verdict["bucket_start_ms"]
        chosen = chosen_at.get(bucket)
        if position is not None:
            low, high, close = (current.get(k) for k in ("candidate_low", "candidate_high", "candidate_close"))
            exit_price, reason = None, None
            long = position["side"] == "LONG"
            if low is not None and high is not None:
                low, high = Decimal(low), Decimal(high)
                if (low <= position["stop"]) if long else (high >= position["stop"]):
                    exit_price, reason = position["stop"], "stop"
                elif (high >= position["target"]) if long else (low <= position["target"]):
                    exit_price, reason = position["target"], "target"
            if exit_price is None and close is not None:
                if chosen == ("sell" if long else "buy"):
                    exit_price, reason = Decimal(close), "opposite_decision"
                elif bucket + ONE_MINUTE_MS - position["opened_at"] >= horizon_min * ONE_MINUTE_MS:
                    exit_price, reason = Decimal(close), "time_stop"
            if exit_price is not None:
                entry, quantity = position["entry"], position["quantity"]
                gross = (exit_price - entry) * quantity if long else (entry - exit_price) * quantity
                pnl = gross - (entry + exit_price) * quantity * taker
                equity += pnl
                trades.append({
                    "side": position["side"], "entry_bucket_ms": position["opened_bucket"],
                    "entry_time_ms": position["opened_at"], "entry_price": str(entry),
                    "stop_price": str(position["stop"]), "target_price": str(position["target"]),
                    "exit_bucket_ms": bucket, "exit_time_ms": bucket + ONE_MINUTE_MS,
                    "exit_price": str(exit_price), "exit_reason": reason, "quantity": str(quantity),
                    "net_bp": float(round(pnl / (entry * quantity) * 10_000, 4)),
                    "pnl_usd": float(round(pnl, 4)), "equity_usd": float(round(equity, 4)),
                })
                position = None
            continue
        if chosen not in ("buy", "sell") or not current.get("ready"):
            continue
        side = "LONG" if chosen == "buy" else "SHORT"
        close, atr = current.get("candidate_close"), current.get("atr14")
        if close is None or atr is None or Decimal(atr) <= 0:
            skipped.append({"bucket_ms": bucket, "side": side, "reason": "protective_levels_unavailable"})
            continue
        entry = Decimal(close)
        distance = Decimal(atr) * STOP_ATR
        stop = entry - distance if side == "LONG" else entry + distance
        target = entry + distance * TARGET_STOP_RATIO if side == "LONG" else entry - distance * TARGET_STOP_RATIO
        cost_per_unit = entry * (2 * taker + buffer_rate)
        if stop <= 0 or abs(target - entry) <= cost_per_unit + entry * buffer_rate:
            skipped.append({"bucket_ms": bucket, "side": side, "reason": "target_does_not_clear_cost_buffer"})
            continue
        by_risk = equity * risk_fraction / (abs(entry - stop) + cost_per_unit)
        by_exposure = min(max_notional, equity * exposure) / entry
        quantity = min(by_risk, by_exposure)
        if quantity <= 0:
            skipped.append({"bucket_ms": bucket, "side": side, "reason": "no_equity"})
            continue
        position = {"side": side, "entry": entry, "stop": stop, "target": target, "quantity": quantity,
                    "opened_bucket": bucket, "opened_at": bucket + ONE_MINUTE_MS}
    return trades, skipped


def _points(rows):
    scored = [r for r in rows if r["status"] == "scored"]
    hits = sum(1 for r in scored if r["point"] == 1)
    misses = len(scored) - hits
    nets = [r["net_bp"] for r in scored]
    return {
        "decisions": len(rows), "scored": len(scored), "pending": sum(1 for r in rows if r["status"] == "pending"),
        "hits": hits, "misses": misses, "points": hits - misses,
        "hit_rate": _round(hits / len(scored)) if scored else None,
        "mean_net_bp": _round(sum(nets) / len(nets)) if nets else None,
        "total_net_bp": _round(sum(nets)) if nets else 0.0,
    }


def report(decisions, verdicts, *, book=BOOK_CONFIG, horizon_min=HORIZON_MIN):
    """Points per decision (overall and per option) and the trading book summary."""
    rows = score_decisions(decisions, verdicts, book=book, horizon_min=horizon_min)
    trades, skipped = simulate_book(decisions, verdicts, book=book, horizon_min=horizon_min)
    initial_cash = float(book["initial_cash_usd"])
    return {
        "horizon_min": horizon_min,
        "book": dict(book),
        "decisions": _points(rows),
        "by_option": {action: _points([r for r in rows if r["chosen"] == action]) for action in ACTIONS},
        "trading": dict(_summary(trades, initial_cash), max_drawdown=_max_drawdown(trades, initial_cash)),
        "skipped": {"count": len(skipped), "first": skipped[:20]},
        "rows": rows,
        "trades": trades,
    }


def product_report(decisions_db_path, verdicts_db_path, product_id, question_id=QUESTION_ID, version=None,
                   horizon_min=HORIZON_MIN):
    decisions, version = load_decisions(decisions_db_path, product_id, question_id, version)
    if decisions:
        start = decisions[0]["bucket_start"]
        end = decisions[-1]["bucket_start"] + (horizon_min + 1) * ONE_MINUTE_MS
        verdicts = load_verdict_rows(verdicts_db_path, product_id, start, end)
    else:
        verdicts = []
    result = report(decisions, verdicts, horizon_min=horizon_min)
    result.update(product_id=product_id, question_id=question_id, question_version=version)
    return result


def _pct(value):
    return "n/a" if value is None else "{:.1f}%".format(value * 100)


def format_report(result):
    d, t = result["decisions"], result["trading"]
    lines = [
        "Qwen {}@{} en {} (horizonte {} min)".format(
            result["question_id"], result["question_version"], result["product_id"], result["horizon_min"]),
        "Decisiones: {} evaluadas, {} pendientes".format(d["scored"], d["pending"]),
        "Aciertos (+1): {}   Fallos (-1): {}   Puntaje: {:+d}   Acierto: {}".format(
            d["hits"], d["misses"], d["points"], _pct(d["hit_rate"])),
    ]
    for action in ACTIONS:
        o = result["by_option"][action]
        lines.append("  {:<5} {:>4} evaluadas  +{} / -{}  acierto {}  neto medio {} bp".format(
            action, o["scored"], o["hits"], o["misses"], _pct(o["hit_rate"]),
            "n/a" if o["mean_net_bp"] is None else o["mean_net_bp"]))
    lines.append("Operando (mismo libro y costes que el backtest): {} operaciones, {} ganadoras, acierto {}".format(
        t["trades"], t["wins"], _pct(t["hit_rate"])))
    lines.append("  Resultado: {} USD ({}% sobre {} USD)   Neto medio: {} bp   Peor caída: {}%".format(
        t["pnl_usd"], t["return_pct"], result["book"]["initial_cash_usd"],
        "n/a" if t["mean_net_bp"] is None else t["mean_net_bp"],
        "n/a" if t["max_drawdown"]["pct"] is None else t["max_drawdown"]["pct"]))
    return "\n".join(lines)


def main(argv=None, out=None):
    import argparse
    import os

    from .futures_products import resolve_products

    out = out or sys.stdout
    parser = argparse.ArgumentParser(description="Hits, misses and returns of Qwen's decisions (read-only)")
    parser.add_argument("--decisions-db", default=os.environ.get("FUTURES_DECISIONS_DB_PATH"))
    parser.add_argument("--verdicts-db", default=os.environ.get("FUTURES_VERDICTS_DB_PATH"))
    parser.add_argument("--products", help="comma-separated PF_X list (default: the pinned products)")
    parser.add_argument("--question", default=QUESTION_ID)
    parser.add_argument("--version", type=int, help="question version (default: the newest stored)")
    parser.add_argument("--horizon-min", type=int, default=HORIZON_MIN)
    parser.add_argument("--json", action="store_true", help="the full report, with every decision and trade")
    parser.add_argument("--max-rows", type=int, help="with --json: keep only the newest N decisions and trades")
    args = parser.parse_args(argv)
    if not args.decisions_db or not args.verdicts_db:
        parser.error("--decisions-db and --verdicts-db are required")
    products = [product for product, _ in resolve_products(args.products)]
    results = [product_report(args.decisions_db, args.verdicts_db, product, args.question, args.version,
                              args.horizon_min) for product in products]
    if args.max_rows is not None:
        keep = max(0, args.max_rows)
        for result in results:
            result["rows"] = result["rows"][-keep:] if keep else []
            result["trades"] = result["trades"][-keep:] if keep else []
    if args.json:
        out.write(json.dumps(results, indent=2, sort_keys=True) + "\n")
    else:
        out.write("\n\n".join(format_report(r) for r in results) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
