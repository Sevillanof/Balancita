"""Walk-forward backtest of one strategy spec over official candles.

The input is the product's official 1m and 5m candles. The run is the shared
simulator (``futures_simulator``, SS-03): indicators are computed incrementally
with the periods the spec declares, ``propose_spec`` decides entries and exits
on closed bars only (no lookahead), and one independent book trades a fixed
notional (100 USD) long or short, one position at a time, exactly like paper
execution D. Every fill pays the shared cost model (``futures_costs``: taker
fee, spread and impact; stops also a full spread). Candles before ``start_ms``
only warm the indicators up.

Funding is charged only when ``funding`` periods are given; otherwise a trade
reports ``funding_complete = false`` and the result is slightly optimistic.
"""

import json
import math
import sqlite3
import statistics
from decimal import Decimal

from .futures_costs import COST_MODEL_VERSION, DEFAULT_PRODUCT, round_trip_cost_bps
from .futures_simulator import DEFAULT_NOTIONAL_USD, Book, frames, merge_periods, DEFAULT_PERIODS
from .futures_spec_strategy import declared_indicators

ONE_MINUTE_MS = 60_000
IN_SAMPLE_SHARE = Decimal("0.7")
MAX_ROWS = 200_000
MIN_TRADES = 30
# The book every scorer shares: a fixed notional per trade, the initial cash being that notional.
BOOK_CONFIG = {
    "notional_usd": str(DEFAULT_NOTIONAL_USD),
    "initial_cash_usd": str(DEFAULT_NOTIONAL_USD),
    "product_id": DEFAULT_PRODUCT,
    "cost_model": COST_MODEL_VERSION,
}


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


def add_equity(trades, initial_cash):
    """Running equity after each closed trade (``equity_usd``), in place."""
    equity = float(initial_cash)
    for trade in trades:
        equity += trade["pnl_usd"]
        trade["equity_usd"] = round(equity, 4)
    return trades


def simulate(spec, candles_1m, candles_5m, *, start_ms=None, product_id=DEFAULT_PRODUCT, tick_size="1",
             notional_usd=DEFAULT_NOTIONAL_USD, funding=()):
    """The spec's book over the candles: ``(trades, skipped)``; frames before ``start_ms`` only warm up."""
    book = Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd, funding=funding)
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    for frame in frames(candles_1m, candles_5m, periods):
        if start_ms is None or frame[0] >= start_ms:
            book.on_frame(*frame)
    return book.trades, book.skipped


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


def _buy_and_hold_pct(candles, start_ms):
    closes = [Decimal(str(c["close"])) for c in candles if start_ms is None or c["bucket_start"] >= start_ms]
    if len(closes) < 2:
        return None
    return float(round((closes[-1] - closes[0]) / closes[0] * 100, 4))


def run_backtest(spec, candles_1m, candles_5m, *, start_ms=None, product_id=DEFAULT_PRODUCT, tick_size="1",
                 notional_usd=DEFAULT_NOTIONAL_USD, funding=(), trial_sharpes=()):
    """Trades, the equity summary and the in-sample / out-of-sample split for one spec."""
    initial_cash = float(notional_usd)
    trades, skipped = simulate(spec, candles_1m, candles_5m, start_ms=start_ms, product_id=product_id,
                               tick_size=tick_size, notional_usd=notional_usd, funding=funding)
    add_equity(trades, initial_cash)
    inside = [c["bucket_start"] for c in candles_1m if start_ms is None or c["bucket_start"] >= start_ms]
    if inside:
        first, last = inside[0], inside[-1]
        split = first + int((Decimal(last - first) * IN_SAMPLE_SHARE).to_integral_value())
    else:
        first = last = split = None
    in_sample = [t for t in trades if split is not None and t["entry_bucket_ms"] < split]
    out_sample = [t for t in trades if split is not None and t["entry_bucket_ms"] >= split]
    oos_values = [t["net_bp"] for t in out_sample]
    oos_sharpe = _sharpe(oos_values)
    # The same trades on the other side: the gross flips and the round trip is paid again.
    round_trip_bp = float(round_trip_cost_bps(product_id))
    inverse = [-t["net_bp"] - 2 * round_trip_bp for t in trades]
    buy_and_hold = _buy_and_hold_pct(candles_1m, start_ms)
    total = _summary(trades, initial_cash)
    return {
        "period": {"first_bucket_ms": first, "last_bucket_ms": last, "split_bucket_ms": split,
                   "candles": len(inside)},
        "book": dict(BOOK_CONFIG, product_id=product_id, notional_usd=str(notional_usd),
                     initial_cash_usd=str(notional_usd)),
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
