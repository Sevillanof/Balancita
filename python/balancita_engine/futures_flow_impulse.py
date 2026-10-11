"""Study of "impulso de 5 min confirmado por flujo agresor" (proposal A) on public Kraken data only.

Flow per 5-minute bin comes from the public execution history (aggressor side = ``takerOrder.direction``,
quantity in contracts), aggregated while streaming and cached in SQLite, so nothing but bins is stored.
Candles come from the public charts API. No quotes, no credentials, no orders (ADR 0001).

    python -m balancita_engine.futures_flow_impulse fetch --db flow.sqlite --start 2026-08-13 --end 2026-10-11
    python -m balancita_engine.futures_flow_impulse study --db flow.sqlite --eval-start 2026-09-20 --out report.json
"""

import argparse
import datetime
import json
import sqlite3
import statistics
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

from .futures_costs import (TEN_THOUSAND, entry_fill, exit_fill, fee_rate, spread_bps)
from .futures_tape import BASE_URL, PAGE, _get_json

BIN_MS = 300_000
PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")
CHARTS = "https://futures.kraken.com/api/charts/v1/trade/{}/5m?from={}&to={}"
NOTIONAL = 100.0
IMPULSE_MIN, IMBALANCE_MIN = 0.5, 0.25
STOP_ATR, TARGET_ATR, MAX_BARS = 1.0, 1.5, 6
COOLDOWN_BINS, MAX_OPEN, DAILY_STOP_USD = 2, 2, -10.0
SLIPPAGE_BUFFER_BP, FEASIBILITY = 2.0, 2.0
ACTIVITY_BINS = 288

_SCHEMA = """
CREATE TABLE IF NOT EXISTS flow(product_id TEXT NOT NULL, bin_ms INTEGER NOT NULL, buy_q REAL NOT NULL,
  sell_q REAL NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(product_id, bin_ms)) STRICT;
CREATE TABLE IF NOT EXISTS flow_day(product_id TEXT NOT NULL, day_ms INTEGER NOT NULL, fills INTEGER NOT NULL,
  PRIMARY KEY(product_id, day_ms)) STRICT;
CREATE TABLE IF NOT EXISTS candle(product_id TEXT NOT NULL, t_ms INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL,
  v REAL, PRIMARY KEY(product_id, t_ms)) STRICT;
"""
DAY_MS = 86_400_000


def day_ms(text):
    return int(datetime.datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def aggregate_day(product_id, lo_ms, hi_ms, *, fetch=_get_json, gap_s=0.05, sleep=time.sleep):
    """``({bin_ms: [buy_q, sell_q, n]}, fills)`` for ``[lo_ms, hi_ms)``; uids deduplicated."""
    url = BASE_URL.format(urllib.parse.quote(product_id)) + "?" + urllib.parse.urlencode(
        {"since": lo_ms, "sort": "asc", "count": PAGE})
    bins, seen = {}, set()
    for _ in range(2000):
        body = fetch(url)
        elements = body.get("elements") or []
        done = False
        for element in elements:
            try:
                ex = element["event"]["Execution"]["execution"]
                ts, qty, side = int(ex["timestamp"]), float(ex["quantity"]), ex["takerOrder"]["direction"]
                uid = ex["uid"]
            except (KeyError, TypeError, ValueError):
                continue
            if ts >= hi_ms:
                done = True
                break
            if ts < lo_ms or uid in seen or side not in ("Buy", "Sell"):
                continue
            seen.add(uid)
            row = bins.setdefault(ts - ts % BIN_MS, [0.0, 0.0, 0])
            row[0 if side == "Buy" else 1] += qty
            row[2] += 1
        token = body.get("continuationToken")
        if done or len(elements) < PAGE or not token:
            return bins, len(seen)
        url = BASE_URL.format(urllib.parse.quote(product_id)) + "?" + urllib.parse.urlencode(
            {"sort": "asc", "count": PAGE, "continuationToken": token})
        sleep(gap_s)
    raise RuntimeError("too many pages")


def fetch_candles(product_id, lo_ms, hi_ms, *, fetch=_get_json):
    out, cursor = [], lo_ms
    while cursor < hi_ms:
        chunk_hi = min(hi_ms, cursor + 1500 * BIN_MS)
        body = fetch(CHARTS.format(product_id, cursor // 1000, chunk_hi // 1000))
        for c in body.get("candles") or []:
            if lo_ms <= int(c["time"]) < hi_ms:
                out.append((int(c["time"]), float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"]), float(c["volume"])))
        cursor = chunk_hi
    return sorted(set(out))


def fetch_product(db_path, product_id, start_ms, end_ms):
    db = sqlite3.connect(db_path, timeout=60)
    db.executescript(_SCHEMA)
    rows = fetch_candles(product_id, start_ms, end_ms)
    with db:
        db.executemany("INSERT OR REPLACE INTO candle VALUES(?,?,?,?,?,?,?)", [(product_id,) + r for r in rows])
    day = start_ms
    while day < end_ms:
        if db.execute("SELECT 1 FROM flow_day WHERE product_id=? AND day_ms=?", (product_id, day)).fetchone() is None:
            bins, fills = aggregate_day(product_id, day, day + DAY_MS)
            with db:
                db.executemany("INSERT OR REPLACE INTO flow VALUES(?,?,?,?,?)",
                               [(product_id, b, v[0], v[1], v[2]) for b, v in bins.items()])
                db.execute("INSERT OR REPLACE INTO flow_day VALUES(?,?,?)", (product_id, day, fills))
            print(product_id, datetime.datetime.fromtimestamp(day / 1000, datetime.timezone.utc).date(), fills, flush=True)
        day += DAY_MS
    db.close()


# ---------------------------------------------------------------- study

def atr14(candles, i):
    """Mean true range of the 14 complete candles strictly before ``i``."""
    trs = []
    for j in range(i - 14, i):
        prev_close = candles[j - 1]["c"]
        trs.append(max(candles[j]["h"] - candles[j]["l"], abs(candles[j]["h"] - prev_close), abs(candles[j]["l"] - prev_close)))
    return sum(trs) / 14


def build_series(db, product_id, start_ms, end_ms):
    flow = {r[0]: r[1:] for r in db.execute("SELECT bin_ms,buy_q,sell_q,n FROM flow WHERE product_id=?", (product_id,))}
    days = {r[0] for r in db.execute("SELECT day_ms FROM flow_day WHERE product_id=?", (product_id,))}
    series = []
    for t, o, h, l, c, v in db.execute(
            "SELECT t_ms,o,h,l,c,v FROM candle WHERE product_id=? AND t_ms>=? AND t_ms<? ORDER BY t_ms", (product_id, start_ms, end_ms)):
        buy, sell, n = flow.get(t, (0.0, 0.0, 0))
        series.append({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v, "buy": buy, "sell": sell, "n": n,
                       "covered": (t - t % DAY_MS) in days})
    return series


def signals(series, product_id, use_flow):
    """Yield ``(index, side, atr)`` for each closed candle that passes the (frozen) rules."""
    fee_bp = float((fee_rate("taker") * 2) * TEN_THOUSAND)
    spread = float(spread_bps(product_id))
    stats = {"evaluated": 0, "impulse": 0, "flow": 0, "activity": 0, "feasible": 0}
    out = []
    for i in range(ACTIVITY_BINS + 15, len(series) - 1):
        window = series[i - ACTIVITY_BINS:i + 1]
        if any(not s["covered"] or s["t"] != series[i]["t"] - (i - k) * BIN_MS for k, s in zip(range(i - ACTIVITY_BINS, i + 1), window)):
            continue
        s = series[i]
        stats["evaluated"] += 1
        atr = atr14(series, i)
        if atr <= 0:
            continue
        impulse = (s["c"] - s["o"]) / atr
        if abs(impulse) < IMPULSE_MIN:
            continue
        side = "LONG" if impulse > 0 else "SHORT"
        stats["impulse"] += 1
        total = s["buy"] + s["sell"]
        if use_flow:
            if total <= 0:
                continue
            imbalance = (s["buy"] - s["sell"]) / total
            if (imbalance < IMBALANCE_MIN) if side == "LONG" else (imbalance > -IMBALANCE_MIN):
                continue
            stats["flow"] += 1
            median = statistics.median(w["buy"] + w["sell"] for w in series[i - ACTIVITY_BINS:i])
        else:
            median = statistics.median(w["v"] for w in series[i - ACTIVITY_BINS:i])
            total = s["v"]
        if total < median:
            continue
        stats["activity"] += 1
        target_bp = (TARGET_ATR * atr / s["c"] * 10_000)
        if target_bp < FEASIBILITY * (fee_bp + spread + SLIPPAGE_BUFFER_BP):
            continue
        stats["feasible"] += 1
        out.append((i, side, atr))
    return out, stats


def simulate_trade(series, product_id, i, side, atr):
    """Enter at the next candle's open, exit by stop / target / early invalidation / 30 min. Returns a trade dict."""
    entry_raw = series[i + 1]["o"]
    entry = float(entry_fill(Decimal(repr(entry_raw)), side, product_id))
    sign = 1 if side == "LONG" else -1
    stop, target = entry_raw - sign * STOP_ATR * atr, entry_raw + sign * TARGET_ATR * atr
    mid_range = (series[i]["h"] + series[i]["l"]) / 2
    last = min(i + MAX_BARS, len(series) - 1)
    reason, price, j = "time", None, last
    for j in range(i + 1, last + 1):
        c = series[j]
        hit_stop = c["l"] <= stop if side == "LONG" else c["h"] >= stop
        hit_target = c["h"] >= target if side == "LONG" else c["l"] <= target
        if hit_stop:
            reason, price = "stop", stop
            break
        if hit_target:
            reason, price = "target", target
            break
        if j > i + 1 and ((c["c"] < mid_range) if side == "LONG" else (c["c"] > mid_range)):
            reason, price = "invalidation", c["c"]
            break
    else:
        j = last
        price = series[last]["c"]
    exit_price = float(exit_fill(Decimal(repr(price)), side, product_id, reason))
    gross = sign * (exit_price - entry) / entry
    fees = float(fee_rate("taker") * 2)
    net = gross - fees
    return {"product": product_id, "entry_ms": series[i + 1]["t"], "exit_ms": series[j]["t"] + BIN_MS, "side": side,
            "reason": reason, "net_bp": net * 10_000, "net_usd": net * NOTIONAL}


def run_variant(series_by_product, use_flow):
    """Per-product sequential trades (one open, cooldown), then the portfolio filter (2 open, daily stop)."""
    raw, stats = [], {}
    for product_id, series in series_by_product.items():
        sigs, stats[product_id] = signals(series, product_id, use_flow)
        free_from = 0
        for i, side, atr in sigs:
            if i + 1 < free_from:
                continue
            trade = simulate_trade(series, product_id, i, side, atr)
            raw.append(trade)
            free_from = (trade["exit_ms"] - series[0]["t"]) // BIN_MS + COOLDOWN_BINS
    raw.sort(key=lambda t: t["entry_ms"])
    kept, open_exits, realized = [], [], {}
    for t in raw:
        open_exits = [e for e in open_exits if e > t["entry_ms"]]
        day = t["entry_ms"] // DAY_MS
        closed_today = sum(k["net_usd"] for k in kept if k["exit_ms"] <= t["entry_ms"] and k["exit_ms"] // DAY_MS == day)
        if len(open_exits) >= MAX_OPEN or closed_today <= DAILY_STOP_USD:
            continue
        kept.append(t)
        open_exits.append(t["exit_ms"])
    return kept, raw, stats


def summarize(trades, lo_ms, hi_ms):
    sel = [t for t in trades if lo_ms <= t["entry_ms"] < hi_ms]
    days = (hi_ms - lo_ms) // DAY_MS
    active_days = len({t["entry_ms"] // DAY_MS for t in sel})
    out = {"trades": len(sel), "days": days, "days_with_trades": active_days, "zero_trade_days": days - active_days,
           "trades_per_day": len(sel) / days if days else None}
    if sel:
        nets = [t["net_bp"] for t in sel]
        mean = statistics.fmean(nets)
        sd = statistics.stdev(nets) if len(nets) > 1 else None
        out.update({"mean_net_bp": mean, "sd_bp": sd, "t_stat": mean / (sd / len(nets) ** 0.5) if sd else None,
                    "net_usd": sum(t["net_usd"] for t in sel), "hit_rate": sum(1 for n in nets if n > 0) / len(nets),
                    "by_reason": {r: sum(1 for t in sel if t["reason"] == r) for r in {t["reason"] for t in sel}},
                    "by_product": {p: {"n": sum(1 for t in sel if t["product"] == p),
                                       "mean_bp": statistics.fmean([t["net_bp"] for t in sel if t["product"] == p]) if any(t["product"] == p for t in sel) else None}
                                   for p in PRODUCTS}})
    return out


def study(db_path, start, end, eval_start, out_path):
    db = sqlite3.connect(db_path)
    start_ms, end_ms, eval_ms = day_ms(start), day_ms(end), day_ms(eval_start)
    series = {p: build_series(db, p, start_ms, end_ms) for p in PRODUCTS}
    report = {"period": [start, end], "eval_start": eval_start, "coverage": {
        p: {"candles": len(s), "expected": (end_ms - start_ms) // BIN_MS, "with_flow": sum(1 for x in s if x["n"] > 0)} for p, s in series.items()}}
    for name, use_flow in (("A_flujo", True), ("B_sin_flujo", False)):
        kept, raw, stats = run_variant(series, use_flow)
        report[name] = {"signal_funnel": stats, "raw_trades": len(raw),
                        "dev": summarize(kept, start_ms + DAY_MS, eval_ms), "eval": summarize(kept, eval_ms, end_ms),
                        "all": summarize(kept, start_ms + DAY_MS, end_ms)}
        report[name]["trades_list"] = kept
    with open(out_path, "w") as f:
        json.dump(report, f, indent=1)
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    s = sub.add_parser("study")
    for p in (f, s):
        p.add_argument("--db", required=True)
        p.add_argument("--start", default="2026-08-13")
        p.add_argument("--end", default="2026-10-11")
    s.add_argument("--eval-start", default="2026-09-20")
    s.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "fetch":
        sqlite3.connect(args.db).executescript(_SCHEMA)
        with ThreadPoolExecutor(len(PRODUCTS)) as pool:
            list(pool.map(lambda p: fetch_product(args.db, p, day_ms(args.start), day_ms(args.end)), PRODUCTS))
    else:
        report = study(args.db, args.start, args.end, args.eval_start, args.out)
        for name in ("A_flujo", "B_sin_flujo"):
            print(name, json.dumps({k: report[name][k] for k in ("signal_funnel", "raw_trades", "dev", "eval")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
