"""Funding carry counter: long spot (Kraken index) + short perpetual, same notional.

It does not trade: the forward engine is futures-only and has no spot leg, so this
measures the carry forward from ``start_ms`` in a separate counter (study and frozen
criterion: ``analisis/funding-carry``; variant C). Inputs are Kraken's public funding
and 1 h ``mark``/``spot`` candles. A missing hour is UNKNOWN: it is counted and left out,
never taken as zero. Floats are enough here: this is a measurement, not an account.

    PYTHONPATH=python python3 -m balancita_engine.futures_carry --state PATH --out PATH
"""

import argparse
import datetime as dt
import json
import os
import time
import urllib.request

HOUR_MS = 3_600_000
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config", "carry-strategies.json")
BASE = "https://futures.kraken.com"


def load_config(path=CONFIG_PATH):
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("schema") != "balancita-carry.v1":
        raise ValueError("unsupported carry config")
    return config


def cycle_cost_fraction(config, product):
    """Entry + exit of both legs, as a fraction of the notional."""
    extra = config["extra_bp_per_side"][product]
    return (2 * (config["perp_taker_bp_per_side"] + extra) + 2 * (config["spot_fee_bp_per_side"] + extra)) / 1e4


def _is_monday_open(t):
    d = dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc)
    return d.hour == 0 and d.weekday() == 0


def simulate(config, product, funding, mark, spot, start_ms, end_ms):
    """funding/mark/spot: dict hour_start_ms -> value (funding is USD per unit per hour, mark/spot close).
    Returns cycles, hourly pnl as a fraction of the notional, unknown hours."""
    window = config["window_hours"]

    def trailing(t):
        rel = [funding[x] / spot[x - HOUR_MS] for x in range(t - window * HOUR_MS, t, HOUR_MS)
               if x in funding and (x - HOUR_MS) in spot]
        return sum(rel) / len(rel) if len(rel) >= window * 0.9 else None

    cycles, pnl, unknown, on, qty, open_at = [], [], 0, False, None, None
    for t in range(start_ms, end_ms, HOUR_MS):
        if _is_monday_open(t):
            avg = trailing(t)
            want = avg is not None and avg > 0
        else:
            want = on
        if want and not on and (t - HOUR_MS) in spot:
            on, qty, open_at = True, 1.0 / spot[t - HOUR_MS], t
            cycles.append({"entry_ms": t, "exit_ms": None})
        elif not want and on:
            on = False
            cycles[-1]["exit_ms"] = t
        known = t in funding and t in mark and t in spot and (t - HOUR_MS) in mark and (t - HOUR_MS) in spot
        if on and not known:
            unknown += 1
        if on and known:
            pnl.append((t, qty * (funding[t] + (spot[t] - spot[t - HOUR_MS]) - (mark[t] - mark[t - HOUR_MS])),
                        qty * funding[t]))
    return cycles, pnl, unknown


def summarize(config, product, funding, mark, spot, start_ms, end_ms):
    cycles, pnl, unknown, = simulate(config, product, funding, mark, spot, start_ms, end_ms)
    notional = float(config["notional_usd"])
    capital = notional * (1 + config["margin"][product])
    cost = len(cycles) * cycle_cost_fraction(config, product) * notional
    gross = sum(p for _, p, _ in pnl) * notional
    fund = sum(f for _, _, f in pnl) * notional
    cum = peak = dd = 0.0
    for _, p, _ in pnl:
        cum += p * notional
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return {
        "product_id": product, "cycles": len(cycles),
        "open": bool(cycles) and cycles[-1]["exit_ms"] is None,
        "active_hours": len(pnl), "unknown_hours": unknown,
        "funding_usd": round(fund, 4), "basis_usd": round(gross - fund, 4),
        "costs_usd": round(cost, 4), "net_usd": round(gross - cost, 4),
        "net_pct_of_capital": round((gross - cost) / capital * 100, 4),
        "max_drawdown_usd": round(dd, 4), "capital_usd": round(capital, 2),
        "trades": cycles,
    }


def _get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "balancita-carry"})
    return json.loads(urllib.request.urlopen(request, timeout=60).read())


def fetch_product(product, since_ms):
    funding = {}
    for row in _get(BASE + "/derivatives/api/v3/historical-funding-rates?symbol=" + product)["rates"]:
        t = int(dt.datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
        funding[t] = row["fundingRate"]
    series = {}
    for tick in ("mark", "spot"):
        out, start = {}, since_ms // 1000
        while True:
            data = _get("{}/api/charts/v1/{}/{}/1h?from={}&to=1999999999".format(BASE, tick, product, start))
            for candle in data["candles"]:
                out[candle["time"]] = float(candle["close"])
            if not data.get("more_candles") or not data["candles"]:
                break
            start = data["candles"][-1]["time"] // 1000 + 1
        series[tick] = out
    return funding, series["mark"], series["spot"]


def load_state(path, now_ms):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    state = {"id": load_config()["id"], "enabled": True, "start_ms": (now_ms // HOUR_MS + 1) * HOUR_MS,
             "disabled_ms": None}
    save_json(path, state)
    return state


def save_json(path, value):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1)
    os.replace(tmp, path)


def set_enabled(state_path, enabled, now_ms):
    """Activate / deactivate. Deactivating freezes the counter at that hour; reactivating
    starts a new counter from the next hour (the old result stays in history)."""
    state = load_state(state_path, now_ms)
    if enabled and not state["enabled"]:
        state = dict(state, enabled=True, start_ms=(now_ms // HOUR_MS + 1) * HOUR_MS, disabled_ms=None,
                     previous=(state.get("previous") or []) + [{"start_ms": state["start_ms"],
                                                                 "end_ms": state["disabled_ms"]}])
    elif not enabled and state["enabled"]:
        state = dict(state, enabled=False, disabled_ms=now_ms // HOUR_MS * HOUR_MS)
    save_json(state_path, state)
    return state


def read_summary(out_path, state_path, config=None):
    config = config or load_config()
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as handle:
            state = json.load(handle)
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as handle:
            summary = json.load(handle)
        return dict(summary, enabled=state.get("enabled", summary["enabled"]))
    return {"schema": "balancita-carry-summary.v1", "id": config["id"], "name": config["name"],
            "label": config["label"], "note": config["note"], "enabled": state.get("enabled", True),
            "start_ms": state.get("start_ms"), "end_ms": None, "updated_ms": None, "totals": None,
            "closed_or_open_cycles": 0, "products": []}


def run(state_path, out_path, now_ms, fetch=fetch_product, config=None):
    config = config or load_config()
    state = load_state(state_path, now_ms)
    if not state["enabled"] and state.get("disabled_ms") is None:
        state["disabled_ms"] = now_ms // HOUR_MS * HOUR_MS
        save_json(state_path, state)
    end_ms = (state["disabled_ms"] if not state["enabled"] else now_ms // HOUR_MS * HOUR_MS)
    products = []
    if end_ms > state["start_ms"]:
        for product in config["products"]:
            funding, mark, spot = fetch(product, state["start_ms"] - config["window_hours"] * HOUR_MS)
            products.append(summarize(config, product, funding, mark, spot, state["start_ms"], end_ms))
    totals = {key: round(sum(p[key] for p in products), 4) for key in
              ("funding_usd", "basis_usd", "costs_usd", "net_usd", "max_drawdown_usd")}
    summary = {"schema": "balancita-carry-summary.v1", "id": config["id"], "name": config["name"],
               "label": config["label"], "note": config["note"], "enabled": state["enabled"],
               "start_ms": state["start_ms"], "end_ms": end_ms, "updated_ms": now_ms,
               "notional_usd_per_product": config["notional_usd"], "totals": totals,
               "closed_or_open_cycles": sum(p["cycles"] for p in products), "products": products}
    save_json(out_path, summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description="Update the funding carry counter.")
    parser.add_argument("--state", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--loop-seconds", type=int, default=0)
    args = parser.parse_args()
    while True:
        now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
        try:
            print(json.dumps(run(args.state, args.out, now)["totals"]), flush=True)
        except OSError as error:  # network down: keep the last summary, try again
            print("carry: {}".format(error), flush=True)
        if not args.loop_seconds:
            break
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()
