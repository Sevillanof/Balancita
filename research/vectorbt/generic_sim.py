"""Per-trade simulation of a ``Plan`` (see ``generic_signals``) with ``vectorbt.Portfolio.from_signals``.

The same mechanics as ``parity.vectorbt_trades`` (C27), generalised: an entry on a tradable signal; stop and target per
entry (VectorBT's own ``sl_stop`` / ``tp_stop``, read at the entry bar and checked on each bar's high and low); the
strategy's own exit rule evaluated at the close with the levels FROZEN at entry (``position.frozen_*``); and the time stop
after ``horizon_minutes`` bars. The order inside a candle is the engine's: stop, then target, then the exit rule, then the
time stop.

Each trade comes out with its exit reason (``stop`` / ``target`` / ``rule`` / ``time``), gross bp (price move from the
signal close to the exit reference, before any cost) and net bp = VectorBT's result (fees and execution impact of both
legs) minus Kraken's real funding minus the execution cost of the stop, which VectorBT does not model. Net is comparable
with the engine's ``net_bp``; the result is a HYPOTHESIS, the engine's Book is the official simulator.
"""

import numpy as np
from numba import njit

from . import parity
from .engine import futures_costs
from .generic_signals import STACK_SIZE, eval_program

NOTIONAL = parity.NOTIONAL
ONE_MINUTE_MS = parity.ONE_MINUTE_MS
REASON_RULE, REASON_TIME = 1, 2
TOUCH = 1e-8


@njit(cache=True)
def _signals(c, side, horizon, branch, exit_index, ops, a1, a2, bools, lcoef, rcoef, meta, frozen_t, frozen_i, ready,
             stop, target, high, low, state, reasons, stack):
    """state: 0 entry bar, 1 side, 2 frozen target, 3 frozen invalidation, 4 horizon (bars), 5 exit program, 6 stop,
    7 target."""
    i = c.i
    if c.position_now == 0:
        if side[i] > 0:
            state[0], state[1], state[2], state[3], state[4] = i, 1.0, frozen_t[i], frozen_i[i], horizon[i]
            state[5], state[6], state[7] = exit_index[branch[i], 0], stop[i], target[i]
            return True, False, False, False
        if side[i] < 0:
            state[0], state[1], state[2], state[3], state[4] = i, -1.0, frozen_t[i], frozen_i[i], horizon[i]
            state[5], state[6], state[7] = exit_index[branch[i], 1], stop[i], target[i]
            return False, False, True, False
        return False, False, False, False
    # The engine looks at the candle's stop and target BEFORE the exit rule and the time stop. VectorBT lets a signal exit
    # win over its own stops on the same bar, so when the candle reached a level the signal stays quiet and the stops act.
    if state[1] > 0:
        reached = low[i] <= state[6] or high[i] >= state[7]
    else:
        reached = high[i] >= state[6] or low[i] <= state[7]
    if reached:
        return False, False, False, False
    fire = False
    if ready[i] and eval_program(int(state[5]), i, ops, a1, a2, bools, lcoef, rcoef, meta, state[2], state[3], stack):
        reasons[i] = 1
        fire = True
    elif i - state[0] >= state[4]:
        reasons[i] = 2
        fire = True
    if fire:
        if c.position_now > 0:
            return False, True, False, False
        return False, False, False, True
    return False, False, False, False


def simulate_plan(plan, market):
    """Closed trades of ``plan`` on ``market`` (a list of dicts) plus the count of positions still open at the end."""
    import pandas as pd
    import vectorbt as vbt
    from vectorbt.portfolio.enums import StopEntryPrice, StopExitPrice

    product = market.product
    c, h, l = market.c, market.h, market.l
    side = plan.side
    impact = float(futures_costs.side_impact_bps(product)) / 10_000
    taker = float(futures_costs.fee_rate("taker"))
    with np.errstate(invalid="ignore", divide="ignore"):
        sl = np.where(side > 0, (c - plan.stop) / c, np.where(side < 0, (plan.stop - c) / c, np.nan))
        tp = np.where(side > 0, (plan.target - c) / c, np.where(side < 0, (c - plan.target) / c, np.nan))
    # The engine exits when a candle TOUCHES the level; VectorBT only when it crosses it. Pulling each level 1e-8 of its
    # distance closer to the entry (far below a tick) makes a touch a crossing, without moving the exit price.
    sl, tp = sl * (1.0 - TOUCH), tp * (1.0 - TOUCH)
    index = pd.to_datetime(market.index, unit="ms", utc=True)
    series = lambda a: pd.Series(a, index=index)  # noqa: E731
    state = np.zeros(8)
    reasons = np.zeros(plan.n, dtype=np.int8)
    stack = np.zeros(STACK_SIZE, dtype=np.bool_)
    p = plan.programs
    pf = vbt.Portfolio.from_signals(
        close=series(c), open=series(market.o), high=series(h), low=series(l),
        signal_func_nb=_signals,
        signal_args=(side, plan.horizon, plan.branch.astype(np.int64), p["exit_index"], p["ops"], p["a1"], p["a2"],
                     p["bools"], p["lcoef"], p["rcoef"], p["meta"], plan.frozen_target, plan.frozen_invalidation,
                     plan.ready, plan.stop, plan.target, h, l, state, reasons, stack),
        size=NOTIONAL, size_type="value", direction="both", fees=taker, slippage=impact,
        sl_stop=series(sl), tp_stop=series(tp), stop_entry_price=StopEntryPrice.Close,
        stop_exit_price=StopExitPrice.StopLimit, init_cash=1_000_000.0, freq="1T")
    records = pf.trades.records_readable
    stop_cost = float(futures_costs.stop_exit_bps(product))
    trades, open_at_end = [], 0
    if len(records) == 0:
        return trades, open_at_end
    entry_i = index.get_indexer(records["Entry Timestamp"])
    exit_i = index.get_indexer(records["Exit Timestamp"])
    for k, (_, row) in enumerate(records.iterrows()):
        if row["Status"] != "Closed":
            open_at_end += 1
            continue
        i, j = int(entry_i[k]), int(exit_i[k])
        long = row["Direction"] == "Long"
        stop, target = float(plan.stop[i]), float(plan.target[i])
        exit_price = float(row["Avg Exit Price"])
        tolerance = 1e-6 * abs(exit_price)   # the levels sit 1e-8 of their distance off, see TOUCH
        stop_touched = (l[j] <= stop) if long else (h[j] >= stop)
        target_touched = (h[j] >= target) if long else (l[j] <= target)
        if stop_touched and abs(exit_price - stop) <= tolerance:
            reason, reference = "stop", stop
        elif target_touched and abs(exit_price - target) <= tolerance:
            reason, reference = "target", target
        elif reasons[j] == REASON_RULE:
            reason, reference = "rule", float(c[j])
        elif reasons[j] == REASON_TIME:
            reason, reference = "time", float(c[j])
        else:
            reason, reference = "unknown", exit_price
        sign = 1.0 if long else -1.0
        gross = sign * (reference / float(c[i]) - 1.0) * 10_000
        net = float(row["PnL"]) / NOTIONAL * 10_000
        start_ms, end_ms = int(market.index[i]) + ONE_MINUTE_MS, int(market.index[j]) + ONE_MINUTE_MS
        fund, complete = parity.funding_bp(market.funding, "LONG" if long else "SHORT", start_ms, end_ms, exit_price)
        trades.append({
            "product": product, "side": "LONG" if long else "SHORT", "entry_i": i, "exit_i": j,
            "entry_time_ms": start_ms, "exit_time_ms": end_ms, "exit_reason": reason,
            "branch": plan.branches[int(plan.branch[i])]["id"],
            "entry_price": float(c[i]), "stop_price": stop, "target_price": target,
            "gross_bp": gross, "funding_bp": fund, "funding_complete": bool(complete),
            "net_bp": net - fund - (stop_cost if reason == "stop" else 0.0),
        })
    return trades, open_at_end
