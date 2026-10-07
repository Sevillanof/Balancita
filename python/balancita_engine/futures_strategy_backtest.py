"""Walk-forward backtest of one strategy spec over stored verdicts.

The input is C's verdicts DB, read-only: every row already holds the closed-bar
features (1m, previous 1m, 5m), the chained regime and the candle's close, high
and low. Replaying a spec over those rows gives what the strategy would have
proposed live, with no lookahead, and needs no market data of its own.

The simulation is one independent paper book per strategy and product, sized
like paper execution D (risk fraction of equity over the stop distance plus
costs, capped by the max notional) and with D's cost-buffer rejection. One
position at a time: entry at the decision close as taker; exit by stop or
target (the stop wins when one candle touches both), by the strategy's own
exit rule at the candle close, or by its horizon as a time stop. Fees are the
taker rate on both sides. ASSUMPTION: no slippage, no funding and no
displayed-size cap, so results are optimistic against D.
"""

import json
import math
import sqlite3
import statistics
from decimal import Decimal

from .futures_paper_execution import COST_BUFFER_RATE, PAPER_EXECUTION_CONFIG
from .futures_spec_strategy import propose_spec

ONE_MINUTE_MS = 60_000
IN_SAMPLE_SHARE = Decimal("0.7")
MAX_ROWS = 200_000
# D's own cost and sizing constants, imported so the backtest cannot drift from paper execution.
BOOK_CONFIG = {
    key: PAPER_EXECUTION_CONFIG[key]
    for key in ("initial_cash_usd", "max_notional_usd", "max_exposure_multiple", "risk_fraction", "taker_rate")
}
BOOK_CONFIG["cost_buffer_rate"] = str(COST_BUFFER_RATE)
MIN_TRADES = 30


def load_verdict_rows(verdicts_db_path, product_id, start_ms=None, end_ms=None, limit=MAX_ROWS):
    """Verdict payloads of one product, oldest first, from a read-only connection."""
    db = sqlite3.connect("file:{}?mode=ro".format(verdicts_db_path), uri=True)
    try:
        clauses, params = ["product_id=?"], [product_id]
        if start_ms is not None:
            clauses.append("bucket_start>=?")
            params.append(int(start_ms))
        if end_ms is not None:
            clauses.append("bucket_start<?")
            params.append(int(end_ms))
        rows = db.execute(
            "SELECT payload_json FROM (SELECT payload_json, bucket_start FROM paper_futures_verdicts WHERE {} "
            "ORDER BY bucket_start DESC LIMIT ?) ORDER BY bucket_start".format(" AND ".join(clauses)),
            (*params, int(limit)),
        ).fetchall()
    finally:
        db.close()
    return [json.loads(row[0]) for row in rows]


def _frozen_level(invalidation):
    if isinstance(invalidation, str) and "@" in invalidation:
        level = invalidation.rsplit("@", 1)[1]
        try:
            return level if Decimal(level).is_finite() else None
        except ArithmeticError:
            return None
    return None


def _scope(verdict, tick_size):
    features = verdict.get("features") or {}
    return features.get("1m") or {}, {
        "previous": features.get("1m_previous"), "trend": features.get("5m"),
        "regime": verdict.get("regime", "unknown"), "tick_size": tick_size,
    }


def simulate(spec, verdicts, *, tick_size="1", book=BOOK_CONFIG):
    """Closed trades and skipped signals of ``spec`` over ``verdicts`` (oldest first)."""
    taker = Decimal(book["taker_rate"])
    buffer_rate = Decimal(book["cost_buffer_rate"])
    risk_fraction = Decimal(book["risk_fraction"])
    max_notional = Decimal(book["max_notional_usd"])
    exposure = Decimal(book["max_exposure_multiple"])
    equity = Decimal(book["initial_cash_usd"])
    trades, skipped = [], []
    position = None
    for verdict in verdicts:
        current, common = _scope(verdict, tick_size)
        bucket = verdict["bucket_start_ms"]
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
                proposal = propose_spec(
                    spec, current, position_side=position["side"],
                    delegated_strategy_id=position["delegated"], frozen_target=position["target_text"],
                    frozen_invalidation=position["frozen_invalidation"], **common)
                if proposal["action"] == "FLAT":
                    exit_price, reason = Decimal(close), "strategy_exit"
                elif bucket + ONE_MINUTE_MS - position["opened_at"] >= position["horizon_ms"]:
                    exit_price, reason = Decimal(close), "time_stop"
            if exit_price is not None:
                entry, quantity = position["entry"], position["quantity"]
                gross = (exit_price - entry) * quantity if long else (entry - exit_price) * quantity
                fees = (entry + exit_price) * quantity * taker
                pnl = gross - fees
                equity += pnl
                trades.append({
                    "strategy_id": position["strategy_id"], "side": position["side"],
                    "entry_bucket_ms": position["opened_bucket"], "entry_time_ms": position["opened_at"],
                    "entry_price": str(entry), "stop_price": str(position["stop"]),
                    "target_price": position["target_text"], "exit_bucket_ms": bucket,
                    "exit_time_ms": bucket + ONE_MINUTE_MS, "exit_price": str(exit_price),
                    "exit_reason": reason, "quantity": str(quantity),
                    "net_bp": float(round(pnl / (entry * quantity) * 10_000, 4)),
                    "pnl_usd": float(round(pnl, 4)), "equity_usd": float(round(equity, 4)),
                    "reason_code": position["reason_code"],
                })
                position = None
            continue
        if not current.get("ready"):
            continue
        proposal = propose_spec(spec, current, **common)
        if proposal["action"] not in ("LONG", "SHORT"):
            continue
        entry = Decimal(current["candidate_close"])
        stop, target = Decimal(proposal["proposed_stop"]), Decimal(proposal["proposed_target"])
        cost_per_unit = entry * (2 * taker + buffer_rate)
        if abs(target - entry) <= cost_per_unit + entry * buffer_rate:
            skipped.append({"bucket_ms": bucket, "side": proposal["action"],
                            "reason": "target_does_not_clear_cost_buffer"})
            continue
        by_risk = equity * risk_fraction / (abs(entry - stop) + cost_per_unit)
        by_exposure = min(max_notional, equity * exposure) / entry
        quantity = min(by_risk, by_exposure)
        if quantity <= 0:
            skipped.append({"bucket_ms": bucket, "side": proposal["action"], "reason": "no_equity"})
            continue
        position = {
            "strategy_id": proposal["strategy_id"], "side": proposal["action"], "entry": entry,
            "stop": stop, "target": target, "target_text": proposal["proposed_target"],
            "frozen_invalidation": _frozen_level(proposal.get("invalidation")),
            "delegated": proposal.get("delegated_strategy_id"), "opened_bucket": bucket,
            "opened_at": bucket + ONE_MINUTE_MS, "horizon_ms": proposal["horizon_minutes"] * ONE_MINUTE_MS,
            "reason_code": proposal["reason_code"], "quantity": quantity,
        }
    return trades, skipped


def _sharpe(values):
    if len(values) < 2:
        return None
    deviation = statistics.pstdev(values)
    return None if deviation == 0 else statistics.fmean(values) / deviation


def deflated_sharpe(values, trial_sharpes):
    """Probability that the per-trade Sharpe of ``values`` is not luck among ``trial_sharpes``.

    Bailey and Lopez de Prado (2014). ``trial_sharpes`` are the Sharpe ratios of
    every variant tried, this one included; with fewer than two the benchmark is
    zero, which is the probabilistic Sharpe ratio.
    """
    sharpe = _sharpe(values)
    if sharpe is None or len(values) < 3:
        return None
    normal = statistics.NormalDist()
    trials = [s for s in trial_sharpes if s is not None]
    benchmark = 0.0
    if len(trials) >= 2:
        gamma = 0.5772156649015329
        count = len(trials)
        benchmark = math.sqrt(statistics.pvariance(trials)) * (
            (1 - gamma) * normal.inv_cdf(1 - 1 / count) + gamma * normal.inv_cdf(1 - 1 / (count * math.e)))
    mean, deviation = statistics.fmean(values), statistics.pstdev(values)
    skew = statistics.fmean([((v - mean) / deviation) ** 3 for v in values])
    kurtosis = statistics.fmean([((v - mean) / deviation) ** 4 for v in values])
    denominator = 1 - skew * sharpe + (kurtosis - 1) / 4 * sharpe ** 2
    if denominator <= 0:
        return None
    return normal.cdf((sharpe - benchmark) * math.sqrt(len(values) - 1) / math.sqrt(denominator))


def _round(value, places=4):
    return None if value is None else round(value, places)


def _summary(trades, initial_cash):
    values = [t["net_bp"] for t in trades]
    if not values:
        return {"trades": 0, "wins": 0, "hit_rate": None, "mean_net_bp": None, "pnl_usd": 0.0,
                "return_pct": 0.0, "sharpe_per_trade": None, "avg_win_usd": None, "avg_loss_usd": None}
    wins = [t["pnl_usd"] for t in trades if t["pnl_usd"] > 0]
    losses = [t["pnl_usd"] for t in trades if t["pnl_usd"] <= 0]
    pnl = sum(t["pnl_usd"] for t in trades)
    return {
        "trades": len(values),
        "wins": len(wins),
        "hit_rate": _round(len(wins) / len(values)),
        "mean_net_bp": _round(statistics.fmean(values)),
        "pnl_usd": _round(pnl),
        "return_pct": _round(pnl / initial_cash * 100),
        "sharpe_per_trade": _round(_sharpe(values)),
        "avg_win_usd": _round(statistics.fmean(wins)) if wins else None,
        "avg_loss_usd": _round(statistics.fmean(losses)) if losses else None,
    }


def _max_drawdown(trades, initial_cash):
    peak, worst, at = initial_cash, 0.0, None
    for trade in trades:
        equity = trade["equity_usd"]
        peak = max(peak, equity)
        drawdown = (equity - peak) / peak * 100
        if drawdown < worst:
            worst, at = drawdown, trade["exit_time_ms"]
    return {"pct": _round(worst), "at_ms": at}


def _buy_and_hold_pct(verdicts):
    closes = [((v.get("features") or {}).get("1m") or {}).get("candidate_close") for v in verdicts]
    closes = [Decimal(c) for c in closes if c is not None]
    if len(closes) < 2:
        return None
    return float(round((closes[-1] - closes[0]) / closes[0] * 100, 4))


def run_backtest(spec, verdicts, *, tick_size="1", book=BOOK_CONFIG, trial_sharpes=()):
    """Trades, the equity summary and the in-sample / out-of-sample split for one spec."""
    initial_cash = float(book["initial_cash_usd"])
    trades, skipped = simulate(spec, verdicts, tick_size=tick_size, book=book)
    if verdicts:
        first, last = verdicts[0]["bucket_start_ms"], verdicts[-1]["bucket_start_ms"]
        split = first + int((Decimal(last - first) * IN_SAMPLE_SHARE).to_integral_value())
    else:
        first = last = split = None
    in_sample = [t for t in trades if split is not None and t["entry_bucket_ms"] < split]
    out_sample = [t for t in trades if split is not None and t["entry_bucket_ms"] >= split]
    oos_values = [t["net_bp"] for t in out_sample]
    oos_sharpe = _sharpe(oos_values)
    # The same trades on the other side: the gross flips and the round trip is paid again.
    round_trip_bp = float(Decimal(book["taker_rate"]) * 20_000)
    inverse = [-t["net_bp"] - 2 * round_trip_bp for t in trades]
    buy_and_hold = _buy_and_hold_pct(verdicts)
    total = _summary(trades, initial_cash)
    return {
        "period": {"first_bucket_ms": first, "last_bucket_ms": last, "split_bucket_ms": split,
                   "verdicts": len(verdicts)},
        "book": dict(book),
        "all": total,
        "in_sample": _summary(in_sample, initial_cash),
        "out_of_sample": _summary(out_sample, initial_cash),
        "max_drawdown": _max_drawdown(trades, initial_cash),
        "buy_and_hold_pct": buy_and_hold,
        "vs_buy_and_hold_pts": None if buy_and_hold is None else _round(total["return_pct"] - buy_and_hold),
        "inverse_control_mean_net_bp": _round(statistics.fmean(inverse)) if inverse else None,
        "oos_sharpe_per_trade": _round(oos_sharpe),
        "deflated_sharpe_probability": _round(deflated_sharpe(oos_values, [*trial_sharpes, oos_sharpe])),
        "trials": len([s for s in trial_sharpes if s is not None]) + 1,
        "min_trades": MIN_TRADES,
        "skipped": {"count": len(skipped), "first": skipped[:20]},
        "trades": trades,
    }
