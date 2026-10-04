"""Inert LONG/FLAT ledger plus a synthetic, non-futures 1x SHORT model."""

import math


DEFAULT_COSTS = {"commissionRate": 0.001, "slippageRate": 0.0005}
MAX_SAFE_INTEGER = 2**53 - 1
DEFAULTS = {
    "startingCash": 10000.0,
    "entryThreshold": 0.55,
    "exitUpThreshold": 0.45,
    "exitDownThreshold": 0.55,
}


def _finite_number(value, name, minimum=None, strict_minimum=False, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("{} must be a finite number".format(name))
    try:
        number = float(value)
    except OverflowError as error:
        raise ValueError("{} must be a finite number".format(name)) from error
    if not math.isfinite(number):
        raise ValueError("{} must be a finite number".format(name))
    if minimum is not None and (number <= minimum if strict_minimum else number < minimum):
        raise ValueError("{} is below its permitted range".format(name))
    if maximum is not None and number >= maximum:
        raise ValueError("{} is above its permitted range".format(name))
    return number


def _timestamp_ms(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError("{} must be a non-negative safe UTC epoch millisecond integer".format(name))
    return value


def _target(signal, current, thresholds):
    if signal is None:
        return current
    direct_target = signal.get("directTarget")
    if direct_target is not None:
        return direct_target
    probability_up = signal["probabilityUp"]
    probability_down = signal["probabilityDown"]
    if signal["abstained"]:
        return "flat"

    if current == "short":
        if (
            probability_down < thresholds["exitUpThreshold"]
            or probability_up >= thresholds["exitDownThreshold"]
        ):
            return "flat"
        return "short"

    if current == "flat":
        up_entry = probability_up >= thresholds["entryThreshold"]
        down_entry = probability_down >= thresholds["entryThreshold"]
        if up_entry and down_entry:
            return "flat"
        if down_entry:
            return "short"

    if (
        probability_up < thresholds["exitUpThreshold"]
        or probability_down >= thresholds["exitDownThreshold"]
    ):
        return "flat"
    if probability_up >= thresholds["entryThreshold"]:
        return "long"
    return current


def simulate_long_flat(options):
    """Replay closed-bar LONG/FLAT signals, filling decisions at the next open."""
    starting_cash = _finite_number(
        options.get("startingCash", DEFAULTS["startingCash"]),
        "startingCash",
        minimum=0,
        strict_minimum=True,
    )
    thresholds = {
        name: _finite_number(
            options.get(name, default), name, minimum=0, strict_minimum=True, maximum=1
        )
        for name, default in DEFAULTS.items()
        if name != "startingCash"
    }
    if thresholds["exitUpThreshold"] >= thresholds["entryThreshold"]:
        raise ValueError("exitUpThreshold must be below entryThreshold")

    costs = options.get("costs", DEFAULT_COSTS)
    commission_rate = _finite_number(
        costs.get("commissionRate", DEFAULT_COSTS["commissionRate"]),
        "commissionRate",
        minimum=0,
    )
    slippage_rate = _finite_number(
        costs.get("slippageRate", DEFAULT_COSTS["slippageRate"]),
        "slippageRate",
        minimum=0,
    )
    bars = options["bars"]
    signals = options["signals"]
    signal_by_time = {}
    for signal in signals:
        signal_time = _timestamp_ms(signal["time"], "signal time")
        normalized_signal = dict(signal)
        for key in ("probabilityUp", "probabilityDown"):
            normalized_signal[key] = _finite_number(signal[key], key)
        if signal.get("directTarget") not in (None, "flat", "long", "short"):
            raise ValueError("directTarget must be flat, long, or short")
        if not isinstance(signal.get("abstained"), bool):
            raise ValueError("abstained must be a boolean")
        signal_by_time[signal_time] = normalized_signal
    for bar in bars:
        _timestamp_ms(bar["time"], "bar time")
        _finite_number(bar["open"], "open", minimum=0, strict_minimum=True)
        _finite_number(bar["close"], "close", minimum=0, strict_minimum=True)

    fills = []
    equity_curve = []
    position = "flat"
    quantity = 0.0
    cost_basis = 0.0
    closed_count = 0
    profitable_closes = 0
    gross_gains = 0.0
    gross_losses = 0.0
    long_bars = 0
    short_bars = 0
    free_cash = starting_cash
    locked_collateral = 0.0
    restricted_proceeds = 0.0
    short_quantity = 0.0
    short_entry_commission = 0.0
    peak = starting_cash
    max_drawdown = 0.0
    pending = None

    for bar in bars:
        if pending is not None and pending != position:
            # Direct opposite-side targets close and reverse at this same next open.
            if position == "long":
                price = bar["open"] * (1 - slippage_rate)
                proceeds = quantity * price * (1 - commission_rate)
                commission = quantity * price * commission_rate
                fills.append({"time": bar["time"], "side": "sell", "price": price,
                              "qty": quantity, "commission": commission})
                closed_count += 1
                pnl = proceeds - cost_basis
                if pnl > 0:
                    profitable_closes += 1
                    gross_gains += pnl
                else:
                    gross_losses -= pnl
                free_cash = proceeds
                quantity = cost_basis = 0.0
                position = "flat"
            elif position == "short":
                price = bar["open"] * (1 + slippage_rate)
                cover_cost = short_quantity * price
                commission = cover_cost * commission_rate
                balance = restricted_proceeds + locked_collateral + free_cash - cover_cost - commission
                if balance < -1e-12:
                    raise ValueError("insufficient collateral: short case cannot be valued")
                fills.append({"time": bar["time"], "side": "buy_to_cover", "price": price,
                              "qty": short_quantity, "commission": commission})
                pnl = restricted_proceeds - cover_cost - short_entry_commission - commission
                closed_count += 1
                if pnl > 0:
                    profitable_closes += 1
                    gross_gains += pnl
                else:
                    gross_losses -= pnl
                free_cash = balance
                short_quantity = locked_collateral = restricted_proceeds = 0.0
                short_entry_commission = 0.0
                position = "flat"

            if pending == "long":
                price = bar["open"] * (1 + slippage_rate)
                quantity = free_cash / (price * (1 + commission_rate))
                commission = quantity * price * commission_rate
                free_cash = 0.0
                cost_basis = quantity * price + commission
                fills.append({
                    "time": bar["time"], "side": "buy", "price": price,
                    "qty": quantity, "commission": commission,
                })
                position = "long"
            elif pending == "short":
                price = bar["open"] * (1 - slippage_rate)
                short_quantity = free_cash / (price * (1 + commission_rate))
                locked_collateral = short_quantity * price
                restricted_proceeds = short_quantity * price
                commission = locked_collateral * commission_rate
                short_entry_commission = commission
                free_cash -= locked_collateral + commission
                fills.append({"time": bar["time"], "side": "sell_short", "price": price,
                              "qty": short_quantity, "commission": commission})
                position = "short"
        if position == "long":
            long_bars += 1
        if position == "short":
            short_bars += 1
            liability = short_quantity * bar["close"]
            if liability > free_cash + locked_collateral + restricted_proceeds + 1e-12:
                raise ValueError("insufficient collateral: short case cannot be valued")
            equity = free_cash + locked_collateral + restricted_proceeds - liability
            point = {"time": bar["time"], "equity": equity, "position": "short",
                     "freeCash": free_cash, "lockedCollateral": locked_collateral,
                     "restrictedProceeds": restricted_proceeds, "liability": liability}
        else:
            equity = free_cash + quantity * bar["close"]
            point = {"time": bar["time"], "equity": equity}
        equity_curve.append(point)
        if equity is not None and equity > peak:
            peak = equity
        if equity is not None and peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)
        pending = _target(signal_by_time.get(bar["time"]), position, thresholds)

    final_equity = equity_curve[-1]["equity"] if equity_curve else starting_cash
    metrics = {
        "netReturnPct": (final_equity - starting_cash) / starting_cash * 100,
        "tradeCount": closed_count,
        "fillCount": len(fills),
        "winRate": None if closed_count == 0 else profitable_closes / closed_count,
        "profitFactor": None if gross_losses == 0 else gross_gains / gross_losses,
        "maxDrawdownPct": max_drawdown * 100,
        "exposurePct": None if not bars else (long_bars + short_bars) / len(bars) * 100,
        "finalEquity": final_equity,
    }
    return {"fills": fills, "equityCurve": equity_curve, "metrics": metrics}
