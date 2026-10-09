"""Risk of the whole account: daily returns, annualised volatility and Sharpe, drawdown and correlation.

``futures_strategy_reliability`` judges each strategy by its trades. This module looks at the same
trades as a *daily* series, which is what lets strategies that trade at different frequencies, on
different products, be compared and combined:

* a trade's net P&L (``pnl_usd``: already after fees, execution cost and funding) is booked on the UTC
  day it closes, as a fraction of the book's notional; days without a close are 0 (the book was flat);
* volatility and Sharpe are annualised with sqrt(365) (crypto trades every day), risk-free rate 0;
* drawdown is on the additive equity ``notional + cumulative P&L`` (fixed notional, no reinvestment);
* ``strategy_correlation`` is Pearson over those daily series, ``product_correlation`` over the
  products' daily close-to-close returns (how much of the basket is the same bet);
* the equal-weight portfolio of the strategies that traded gives the diversification numbers:
  ``effective_bets`` = n^2 / sum of all pairwise correlations (n identical strategies count as 1)
  and ``diversification_ratio`` = mean strategy volatility / portfolio volatility.

Nothing here predicts anything: it only describes what the trades did.
"""

import math
import statistics

DAY_MS = 86_400_000
DAYS_PER_YEAR = 365
MIN_DAYS = 10


def _day(ms):
    return int(ms) // DAY_MS


def _round(value, places=4):
    return None if value is None else round(value, places)


def daily_returns(trades, first_ms, last_ms, notional=100.0):
    """Net P&L per UTC day as a fraction of ``notional`` over every day from ``first_ms`` to ``last_ms``."""
    first, last = _day(first_ms), _day(last_ms)
    days = [0.0] * (last - first + 1)
    for trade in trades:
        index = _day(trade["exit_time_ms"]) - first
        if 0 <= index < len(days):
            days[index] += float(trade["pnl_usd"]) / notional
    return days


def pearson(a, b):
    """Correlation of two equal-length series; ``None`` when one is constant or there are under ``MIN_DAYS`` pairs."""
    if len(a) != len(b) or len(a) < MIN_DAYS:
        return None
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def series_stats(returns):
    """Annualised volatility and Sharpe, total return and maximum drawdown of a daily return series (fractions)."""
    if len(returns) < MIN_DAYS:
        return {"days": len(returns), "total_return_pct": None, "vol_annual_pct": None,
                "sharpe_annual": None, "max_drawdown_pct": None, "worst_day_pct": None}
    mean, deviation = statistics.fmean(returns), statistics.stdev(returns)
    peak, equity, worst = 1.0, 1.0, 0.0
    for value in returns:
        equity += value
        peak = max(peak, equity)
        worst = min(worst, (equity - peak) / peak)
    scale = math.sqrt(DAYS_PER_YEAR)
    return {
        "days": len(returns),
        "total_return_pct": _round(sum(returns) * 100),
        "vol_annual_pct": _round(deviation * scale * 100),
        "sharpe_annual": None if deviation == 0 else _round(mean / deviation * scale),
        "max_drawdown_pct": _round(worst * 100),
        "worst_day_pct": _round(min(returns) * 100),
    }


def _matrix(names, series):
    return {a: {b: 1.0 if a == b else _round(pearson(series[a], series[b])) for b in names} for a in names}


def daily_close_returns(candles):
    """Close-to-close daily returns from candle dicts (``bucket_start``, ``close``), keyed by UTC day."""
    last_close = {}
    for candle in sorted(candles, key=lambda c: c["bucket_start"]):
        last_close[_day(candle["bucket_start"])] = float(candle["close"])
    days = sorted(last_close)
    return {day: last_close[day] / last_close[prev] - 1 for prev, day in zip(days, days[1:])
            if day == prev + 1 and last_close[prev] > 0}


def product_correlation(candles_by_product):
    """Correlation of the products' daily returns over the days they share: ``{a: {b: rho}}``."""
    returns = {p: daily_close_returns(c) for p, c in candles_by_product.items() if c}
    names = sorted(returns)
    out = {}
    for a in names:
        out[a] = {}
        for b in names:
            shared = sorted(set(returns[a]) & set(returns[b]))
            out[a][b] = _round(pearson([returns[a][d] for d in shared], [returns[b][d] for d in shared]))
    return out


def portfolio_risk(trades_by_strategy, first_ms, last_ms, *, notional=100.0, candles_by_product=None):
    """Account-level risk from ``{strategy_id: [trades]}`` (all products pooled per strategy)."""
    if first_ms is None or last_ms is None or last_ms < first_ms:
        return None
    series = {sid: daily_returns(rows, first_ms, last_ms, notional) for sid, rows in trades_by_strategy.items() if rows}
    result = {"method": {"returns": "net pnl_usd on the UTC day a trade closes, over notional; flat days are 0",
                         "annualisation": "sqrt(365), risk-free rate 0", "drawdown": "additive equity, fixed notional"},
              "strategies": {sid: series_stats(values) for sid, values in sorted(series.items())}}
    live = sorted(sid for sid, values in series.items() if statistics.pstdev(values) > 0)
    result["strategy_correlation"] = _matrix(live, series)
    if len(live) >= 2:
        count = len(live)
        total = sum((result["strategy_correlation"][a][b] or 0.0) for a in live for b in live)
        portfolio = [statistics.fmean(series[s][i] for s in live) for i in range(len(series[live[0]]))]
        stats = series_stats(portfolio)
        mean_vol = statistics.fmean(statistics.stdev(series[s]) for s in live)
        portfolio_vol = statistics.stdev(portfolio) if len(portfolio) > 1 else 0
        stats.update(strategies=live, effective_bets=_round(count * count / total, 2) if total > 0 else None,
                     diversification_ratio=_round(mean_vol / portfolio_vol, 2) if portfolio_vol > 0 else None)
        result["portfolio_equal_weight"] = stats
    else:
        result["portfolio_equal_weight"] = None
    if candles_by_product:
        result["product_correlation"] = product_correlation(candles_by_product)
    return result
