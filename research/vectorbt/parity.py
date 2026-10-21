"""Parity test: C27 run by VectorBT and by Balancita's own backtest over the SAME sealed candles.

``python -m research.vectorbt.parity --dataset data/research-vectorbt/practice/PF_XBTUSD``

Level 1, signals. A hand-written vectorised version of the C27 rules (numpy, float64) is compared bar by bar with
``futures_spec_strategy.propose_spec`` fed by ``futures_simulator.frames`` (Decimal, the code the forward runs). The
criterion is ZERO differences; any difference is listed.

Level 2, trades. The same entries go through ``vectorbt.Portfolio.from_signals`` (stops and targets per entry, the
strategy's own exit and its time stop through a Numba signal function) and through ``futures_simulator.Book``. Trades are
matched by entry bar; every difference in exit or net result is classified by cause. VectorBT does not know funding, so
it is charged afterwards with Kraken's real hourly rates, per trade, from the same periods the engine uses.

Nothing here writes to a Balancita database; the dataset is only read.
"""

import argparse
import hashlib
import json
import math
import os
import sys
from decimal import Decimal

import numpy as np
import pyarrow.parquet as pq
from numba import njit

from . import data_contract as contract
from .engine import Book, DEFAULT_PERIODS, declared_indicators, frames, futures_costs, load_spec, merge_periods, propose_spec

ONE_MINUTE_MS = 60_000
MINIMUM_CANDLES = 50
NOTIONAL = 100.0
COST_BUFFER_RATE = 0.0002


# ----------------------------------------------------------------------------------------------------- dataset
def load_dataset(directory, resolution):
    """The sealed table of one resolution; the file hash is checked against the manifest first."""
    with open(os.path.join(directory, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    name = "{}_{}.parquet".format(manifest["product_id"], resolution)
    path = os.path.join(directory, name)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != manifest["files"][name]["sha256"]:
        raise contract.ContractError("{} no coincide con el manifiesto (¿se modificó?)".format(name))
    return manifest, pq.read_table(path)


def engine_candles(table):
    """The candles as the engine reads them: the original text, no float in between."""
    cols = {name: table[name].to_pylist() for name in ("bucket_start_ms", "open_text", "high_text", "low_text",
                                                      "close_text", "volume_btc_text")}
    return [{"bucket_start": cols["bucket_start_ms"][i], "open": cols["open_text"][i], "high": cols["high_text"][i],
             "low": cols["low_text"][i], "close": cols["close_text"][i], "volume_btc": cols["volume_btc_text"][i]}
            for i in range(table.num_rows)]


def funding_periods(directory, product):
    path = os.path.join(directory, "{}_funding.parquet".format(product))
    if not os.path.exists(path):
        return []
    table = pq.read_table(path)
    return [(s, s + 3_600_000, r) for s, r in zip(table["period_start_ms"].to_pylist(),
                                                   table["relative_rate_per_hour"].to_pylist())]


# ----------------------------------------------------------------------------------------------- C27 by arrays
@njit(cache=False)
def _wilder_atr(high, low, close, period):
    n = len(close)
    atr = np.full(n, np.nan)
    tr_sum, count, value = 0.0, 0, np.nan
    for i in range(n):
        tr = high[i] - low[i]
        if i > 0:
            tr = max(tr, abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        if count < period:
            tr_sum += tr
            count += 1
            if count == period:
                value = tr_sum / period
                atr[i] = value
        else:
            value = (value * (period - 1) + tr) / period
            atr[i] = value
    return atr


def _prior_window(values, period, func):
    """``func`` over the ``period`` values BEFORE each bar (the current one excluded), NaN until there are enough."""
    out = np.full(len(values), np.nan)
    if len(values) > period:
        windows = np.lib.stride_tricks.sliding_window_view(values, period)
        out[period:] = func(windows[:-1], axis=1)
    return out


def c27_arrays(spec, o, h, l, c, v, tick=1.0, donchian_period=20):
    """Everything C27 needs per bar, as float64 arrays: raw signals, protective levels and the frozen exit level."""
    params, risk = spec["params"], spec["rules"]["risk"]
    if risk["stop_atr"] != "$stop_atr" or risk["target_stop_ratio"] != "$target_stop_ratio":
        raise contract.ContractError("C27 espera stop y objetivo parametrizados")
    multiplier = float(params["volume_multiplier"])
    stop_atr, ratio = float(params["stop_atr"]), float(params["target_stop_ratio"])
    period = int(donchian_period)
    dh, dl = _prior_window(h, period, np.max), _prior_window(l, period, np.min)
    pvm = _prior_window(v, period, np.mean)
    atr = _wilder_atr(h, l, c, 14)
    count = np.arange(1, len(c) + 1)
    ready = (count >= MINIMUM_CANDLES) & ~np.isnan(dh) & ~np.isnan(atr) & (atr > 0)
    with np.errstate(invalid="ignore"):
        volume_ok = v > pvm * multiplier
        long_raw = ready & (c > dh) & volume_ok
        short_raw = ready & ~long_raw & (c < dl) & volume_ok
    distance = atr * stop_atr
    long_stop = np.floor((c - distance) / tick) * tick
    short_stop = np.ceil((c + distance) / tick) * tick
    long_target = np.ceil((c + distance * ratio) / tick) * tick
    short_target = np.floor((c - distance * ratio) / tick) * tick
    return {
        "long_raw": long_raw, "short_raw": short_raw, "mid": (dh + dl) / 2, "atr": atr,
        "long_stop": long_stop, "short_stop": short_stop, "long_target": long_target, "short_target": short_target,
        "horizon_bars": int(spec["rules"]["horizon_minutes"]),
    }


def tradable_mask(arrays, c, product):
    """The engine skips a signal whose target does not clear the round-trip cost plus its buffer."""
    cost = float(futures_costs.round_trip_rate(product)) + COST_BUFFER_RATE
    long_ok = np.abs(arrays["long_target"] - c) > c * cost
    short_ok = np.abs(arrays["short_target"] - c) > c * cost
    return arrays["long_raw"] & long_ok, arrays["short_raw"] & short_ok


# ------------------------------------------------------------------------------------------------ the engine
def engine_signals(spec, candles_1m, candles_5m):
    """Raw per-bar proposals of ``propose_spec`` with no position open: +1 LONG, -1 SHORT, 0 otherwise."""
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    out = np.zeros(len(candles_1m), dtype=np.int8)
    for index, (bucket, current, previous, trend, regime) in enumerate(frames(candles_1m, candles_5m, periods)):
        proposal = propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size="1")
        out[index] = {"LONG": 1, "SHORT": -1}.get(proposal["action"], 0)
    return out


def engine_trades(spec, candles_1m, candles_5m, product, funding):
    book = Book(spec, product_id=product, tick_size="1", funding=funding)
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    for frame in frames(candles_1m, candles_5m, periods):
        book.on_frame(*frame)
    return book.trades, book.skipped, book.position is not None


# ---------------------------------------------------------------------------------------------- VectorBT
@njit
def _signals(c, long_sig, short_sig, close, mid, hold_bars, state):
    """Entry on a tradable signal; exit on the strategy's own rule (close beyond the frozen Donchian middle) or on the
    time stop. Stops and targets are VectorBT's own (per-bar ``sl_stop`` / ``tp_stop``, read at the entry bar)."""
    i = c.i
    if c.position_now == 0:
        if long_sig[i]:
            state[0], state[1], state[2] = i, 1.0, mid[i]
            return True, False, False, False
        if short_sig[i]:
            state[0], state[1], state[2] = i, -1.0, mid[i]
            return False, False, True, False
        return False, False, False, False
    held = i - state[0]
    if c.position_now > 0:
        if close[i] < state[2] or held >= hold_bars:
            return False, True, False, False
    else:
        if close[i] > state[2] or held >= hold_bars:
            return False, False, False, True
    return False, False, False, False


def vectorbt_trades(spec, product, index_ms, o, h, l, c, v, arrays):
    """Runs the strategy in ``Portfolio.from_signals``; returns one dict per closed trade (before funding)."""
    import pandas as pd
    import vectorbt as vbt
    from vectorbt.portfolio.enums import StopEntryPrice, StopExitPrice

    long_sig, short_sig = tradable_mask(arrays, c, product)
    impact = float(futures_costs.side_impact_bps(product)) / 10_000
    taker = float(futures_costs.fee_rate("taker"))
    with np.errstate(invalid="ignore", divide="ignore"):
        sl = np.where(long_sig, (c - arrays["long_stop"]) / c, np.where(short_sig, (arrays["short_stop"] - c) / c, np.nan))
        tp = np.where(long_sig, (arrays["long_target"] - c) / c, np.where(short_sig, (c - arrays["short_target"]) / c, np.nan))
    index = pd.to_datetime(index_ms, unit="ms", utc=True)
    series = lambda a: pd.Series(a, index=index)  # noqa: E731
    state = np.zeros(3)
    pf = vbt.Portfolio.from_signals(
        close=series(c), open=series(o), high=series(h), low=series(l),
        signal_func_nb=_signals, signal_args=(long_sig, short_sig, c, arrays["mid"], arrays["horizon_bars"], state),
        size=NOTIONAL, size_type="value", direction="both", fees=taker, slippage=impact,
        sl_stop=series(sl), tp_stop=series(tp), stop_entry_price=StopEntryPrice.Close,
        stop_exit_price=StopExitPrice.StopLimit, init_cash=1_000_000.0, freq="1T")
    records = pf.trades.records_readable
    trades = []
    for _, row in records.iterrows():
        trades.append({
            "entry_i": int(index.get_loc(row["Entry Timestamp"])), "exit_i": int(index.get_loc(row["Exit Timestamp"])),
            "side": "LONG" if row["Direction"] == "Long" else "SHORT",
            "entry_price": float(row["Avg Entry Price"]), "exit_price": float(row["Avg Exit Price"]),
            "net_bp_before_funding": float(row["PnL"]) / NOTIONAL * 10_000,
            "status": row["Status"],
        })
    return trades, pf


def funding_bp(periods, side, start_ms, end_ms, entry_price):
    """Funding in bp of the notional: relative hourly rate x hours held; a long pays a positive rate, a short receives it."""
    total, covered = 0.0, 0
    for left, right, rate in periods:
        a, b = max(start_ms, left), min(end_ms, right)
        if b > a:
            covered += b - a
            total += rate * (b - a) / 3_600_000
    bp = total * 10_000
    return (bp if side == "LONG" else -bp), covered >= end_ms - start_ms


# ------------------------------------------------------------------------------------------------- compare
def compare(spec, directory, start=None, end=None, product=None):
    manifest, t1 = load_dataset(directory, "1m")
    _, t5 = load_dataset(directory, "5m")
    product = product or manifest["product_id"]
    candles_1m, candles_5m = engine_candles(t1), engine_candles(t5)
    index_ms = np.array(t1["bucket_start_ms"].to_pylist(), dtype=np.int64)
    o, h, l, c, v = (np.array(t1[name].to_numpy(), dtype=np.float64) for name in ("open", "high", "low", "close", "volume_btc"))
    arrays = c27_arrays(spec, o, h, l, c, v)
    periods = funding_periods(directory, product)
    funding_pairs = [(left, right, rate) for left, right, rate in periods]

    # ---- level 1: signals
    from_engine = engine_signals(spec, candles_1m, candles_5m)
    from_arrays = np.where(arrays["long_raw"], 1, np.where(arrays["short_raw"], -1, 0)).astype(np.int8)
    differing = np.nonzero(from_engine != from_arrays)[0]
    signal_report = {
        "bars": int(len(c)), "engine_long": int((from_engine == 1).sum()), "engine_short": int((from_engine == -1).sum()),
        "vectorised_long": int((from_arrays == 1).sum()), "vectorised_short": int((from_arrays == -1).sum()),
        "differences": int(len(differing)),
        "first_differences": [{"bucket": contract.iso(int(index_ms[i])), "engine": int(from_engine[i]),
                               "vectorised": int(from_arrays[i])} for i in differing[:20]],
    }

    # ---- level 2: trades
    trades_engine, skipped, open_at_end = engine_trades(spec, candles_1m, candles_5m, product, funding_pairs)
    trades_vbt, _ = vectorbt_trades(spec, product, index_ms, o, h, l, c, v, arrays)
    by_entry_engine = {t["entry_bucket_ms"]: t for t in trades_engine}
    pairs, only_engine, only_vbt = [], [], []
    vbt_by_entry = {int(index_ms[t["entry_i"]]): t for t in trades_vbt}
    for bucket, trade in by_entry_engine.items():
        if bucket in vbt_by_entry:
            pairs.append((trade, vbt_by_entry[bucket]))
        else:
            only_engine.append(trade)
    only_vbt = [t for bucket, t in vbt_by_entry.items() if bucket not in by_entry_engine]
    exit_diffs, result_diffs, residuals, causes = [], [], [], {}
    stop_cost_bp = float(futures_costs.stop_exit_bps(product))
    high_by_bucket = {int(index_ms[i]): (h[i], l[i]) for i in range(len(index_ms))}
    for engine_trade, vbt_trade in pairs:
        exit_engine = engine_trade["exit_bucket_ms"]
        exit_vbt = int(index_ms[vbt_trade["exit_i"]])
        same_exit = exit_engine == exit_vbt
        fund, complete = funding_bp(funding_pairs, vbt_trade["side"], engine_trade["entry_time_ms"],
                                    exit_vbt + ONE_MINUTE_MS, vbt_trade["entry_price"])
        net_vbt = vbt_trade["net_bp_before_funding"] - fund
        delta = net_vbt - engine_trade["net_bp"]
        reason = engine_trade["exit_reason"]
        # Known cause of the result gap: the engine's stop pays one side's impact plus a full spread, VectorBT's does not.
        residual = delta - (stop_cost_bp if reason == "stop" else 0.0)
        if not same_exit:
            level = float(engine_trade["stop_price"] if reason == "stop" else engine_trade["target_price"])
            high, low = high_by_bucket[exit_engine]
            touched = (low if (reason == "stop") == (engine_trade["side"] == "LONG") else high) == level
            exit_diffs.append({"entry": contract.iso(engine_trade["entry_bucket_ms"]), "engine_exit": contract.iso(exit_engine),
                               "engine_reason": reason, "vectorbt_exit": contract.iso(exit_vbt), "level": level,
                               "engine_exit_candle_only_touches_level": bool(touched)})
        else:
            result_diffs.append(delta)
            residuals.append(residual)
        key = "{}|{}".format(reason, "misma salida" if same_exit else "salida distinta")
        entry = causes.setdefault(key, {"trades": 0, "max_abs_delta_bp": 0.0, "mean_delta_bp": 0.0,
                                        "max_abs_residual_bp": 0.0})
        entry["trades"] += 1
        entry["max_abs_delta_bp"] = max(entry["max_abs_delta_bp"], abs(delta))
        entry["mean_delta_bp"] += (delta - entry["mean_delta_bp"]) / entry["trades"]
        if same_exit:
            entry["max_abs_residual_bp"] = max(entry["max_abs_residual_bp"], abs(residual))
    return {
        "dataset_sha256": manifest["dataset_sha256"], "product": product, "strategy": spec["id"],
        "window": [manifest["start_inclusive_utc"], manifest["end_exclusive_utc"]],
        "signals": signal_report,
        "trades": {
            "engine": len(trades_engine), "vectorbt": len(trades_vbt), "matched_by_entry": len(pairs),
            "only_engine": len(only_engine), "only_vectorbt": len(only_vbt),
            "different_exit": len(exit_diffs), "engine_skipped_signals": len(skipped), "engine_open_at_end": open_at_end,
            "same_exit_trades": len(result_diffs),
            "same_exit_mean_delta_bp": float(np.mean(result_diffs)) if result_diffs else None,
            "same_exit_max_abs_delta_bp": float(np.max(np.abs(result_diffs))) if result_diffs else None,
            "stop_cost_bp_not_in_vectorbt": stop_cost_bp,
            "same_exit_max_abs_residual_bp": float(np.max(np.abs(residuals))) if residuals else None,
            "by_exit_reason": causes, "first_exit_differences": exit_diffs[:20],
            "first_only_engine": [contract.iso(t["entry_bucket_ms"]) for t in only_engine[:20]],
            "first_only_vectorbt": [contract.iso(int(index_ms[t["entry_i"]])) for t in only_vbt[:20]],
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", required=True, help="folder with manifest.json and the Parquet files")
    parser.add_argument("--spec", default="config/strategies/c27-breakout-perp-v1.json")
    parser.add_argument("--json", default=None, help="write the result here")
    args = parser.parse_args(argv)
    result = compare(load_spec(args.spec), args.dataset)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)
    return 0 if result["signals"]["differences"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
