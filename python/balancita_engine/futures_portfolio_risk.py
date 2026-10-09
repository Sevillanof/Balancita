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

``exposure`` looks at the same trades over *time*: how many positions are open at once and how lopsided
they are (longs minus shorts, 100 USD each). The books stay independent; ``caps`` only answers "what would
the account have done if it refused any entry that pushes the net same-side count past N", so a limit can be
judged before it is ever applied.

Nothing here predicts anything: it only describes what the trades did.
"""

import math
import statistics

DAY_MS = 86_400_000
DAYS_PER_YEAR = 365
MIN_DAYS = 10
DEFAULT_CAPS = (2, 3, 4, 6)


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
    timed = [t for rows in trades_by_strategy.values() for t in rows if "side" in t and "entry_time_ms" in t]
    result["exposure"] = exposure(timed, first_ms, last_ms, notional=notional)
    return result


def _book_stats(trades, first_ms, last_ms, notional):
    values = daily_returns(trades, first_ms, last_ms, notional)
    stats = series_stats(values)
    stats["trades"] = len(trades)
    stats["pnl_usd"] = _round(sum(float(t["pnl_usd"]) for t in trades))
    return stats


def exposure(trades, first_ms, last_ms, *, caps=DEFAULT_CAPS, notional=100.0):
    """Open positions over time and what a net same-side cap would have done.

    ``trades`` are every strategy's trades (``side``, ``entry_time_ms``, ``exit_time_ms``, ``pnl_usd``), all
    products together. Net = open longs - open shorts. A capped run walks the entries in time order (ties by
    strategy and product) and skips one that would make the net count exceed the cap in its own direction;
    a skipped trade never opens, so it frees nothing and costs nothing.
    """
    if not trades or first_ms is None or last_ms is None:
        return None
    # Exits sort before entries at the same instant: a position closed at t is not open for one opened at t.
    events = []
    for trade in trades:
        sign = 1 if trade["side"] == "LONG" else -1
        events.append((int(trade["entry_time_ms"]), 1, sign))
        events.append((int(trade["exit_time_ms"]), 0, -sign))
    events.sort()
    net = open_count = max_net = max_open = 0
    last_t, span, abs_net_time, open_time = events[0][0], 0, 0, 0
    for when, kind, delta in events:
        dt = when - last_t
        span += dt
        abs_net_time += abs(net) * dt
        open_time += open_count * dt
        last_t = when
        net += delta
        open_count += 1 if kind else -1
        max_net, max_open = max(max_net, abs(net)), max(max_open, open_count)
    result = {
        "max_open_positions": max_open,
        "mean_open_positions": _round(open_time / span, 2) if span else None,
        "max_abs_net_positions": max_net,
        "mean_abs_net_positions": _round(abs_net_time / span, 2) if span else None,
        "uncapped": _book_stats(trades, first_ms, last_ms, notional),
        "caps": {},
    }
    for cap in caps:
        kept, open_trades = [], []
        for trade in sorted(trades, key=lambda t: (int(t["entry_time_ms"]), str(t.get("strategy_id")),
                                                   str(t.get("product_id")))):
            now = int(trade["entry_time_ms"])
            open_trades = [t for t in open_trades if int(t["exit_time_ms"]) > now]
            sign = 1 if trade["side"] == "LONG" else -1
            current = sum(1 if t["side"] == "LONG" else -1 for t in open_trades)
            if abs(current + sign) > cap and abs(current + sign) > abs(current):
                continue
            kept.append(trade)
            open_trades.append(trade)
        stats = _book_stats(kept, first_ms, last_ms, notional)
        stats["skipped"] = len(trades) - len(kept)
        result["caps"][str(cap)] = stats
    return result


def build_from_market(market_db, specs, products, *, days, end_ms=None):
    """Replay every spec over each product's official candles and describe the account's risk.

    ``products`` is ``[(product_id, tick_size)]``. Needs only the market DB (no chart JSON): the last ``days``
    days before ``end_ms`` (default: the newest candle) are traded, the week before only warms indicators up.
    """
    from .futures_replay import load_range, replay

    trades = {spec["id"]: [] for spec in specs}
    fives_by_product, first, last = {}, None, None
    for product_id, tick_size in products:
        probe_end = end_ms if end_ms is not None else 2 ** 62
        ones, fives = load_range(market_db, product_id, probe_end - days * DAY_MS if end_ms else 0, probe_end)
        if not ones:
            continue
        stop = ones[-1]["bucket_start"]
        start = max(ones[0]["bucket_start"], stop - days * DAY_MS)
        books = replay(specs, ones, fives, start_ms=start, product_id=product_id, tick_size=tick_size)
        for book in books:
            trades[book.spec["id"]].extend(dict(t, product_id=product_id) for t in book.trades)
        fives_by_product[product_id] = [c for c in fives if c["bucket_start"] >= start]
        first = start if first is None else min(first, start)
        last = stop if last is None else max(last, stop)
    risk = portfolio_risk(trades, first, last, candles_by_product=fives_by_product)
    return {"schema": "futures-portfolio-risk.v1", "days": days, "first_bucket_ms": first, "last_bucket_ms": last,
            "products": sorted(fives_by_product), "risk": risk}


def main(argv=None):
    import argparse
    import json
    import os

    from .futures_products import resolve_products
    from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs

    parser = argparse.ArgumentParser(description="Risk of the whole account from the market DB's candles.")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    body = build_from_market(args.market_db, list(load_specs(args.specs_dir).values()), resolve_products(),
                             days=args.days)
    temporary = args.out + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, args.out)
    risk = body["risk"] or {}
    portfolio = risk.get("portfolio_equal_weight")
    if portfolio:
        print("portfolio: sharpe={sharpe_annual} vol={vol_annual_pct}% maxdd={max_drawdown_pct}% "
              "effective_bets={effective_bets} diversification={diversification_ratio}".format(**portfolio))
    exp = risk.get("exposure")
    if exp:
        print("exposure: max open={} max |net|={} mean |net|={}".format(
            exp["max_open_positions"], exp["max_abs_net_positions"], exp["mean_abs_net_positions"]))
        for cap, stats in exp["caps"].items():
            print("  cap {}: trades={} skipped={} pnl={} sharpe={} maxdd={}%".format(
                cap, stats["trades"], stats["skipped"], stats["pnl_usd"], stats["sharpe_annual"],
                stats["max_drawdown_pct"]))


if __name__ == "__main__":
    main()
