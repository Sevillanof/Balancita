"""One cost model per product, shared by paper execution, the backtest and both scorers (SS-01).

Fees are Kraken Futures "MTF Linear Rebate Fees" level 1 (maker 0.02 %, taker 0.05 %
of notional; every pinned PF_* product uses that schedule). Execution cost is the
average price paid above/below the mid to trade ~1 000 USD at market, per side, in
basis points (``side_impact_bps``): it already includes half the spread. The table
is a measured snapshot (2026-10-07, public order books, ``analisis/costes-reales-kraken.md``);
``measured_spread_bps`` recomputes the spread from the ``orderbook`` analytics points
the capture stores, so the table can be refreshed from our own data.
"""

from decimal import Decimal

from .canonical import canonical_hash

COST_MODEL_VERSION = "kraken-futures-costs.v2"
MAKER_RATE = "0.0002"
TAKER_RATE = "0.0005"
TEN_THOUSAND = Decimal(10_000)
DEFAULT_PRODUCT = "PF_XBTUSD"

# product -> (median spread bp, one-side impact of a 1 000 USD market order bp)
_EXECUTION = {
    "PF_XBTUSD": ("0.12", "0.06"),
    "PF_ETHUSD": ("0.38", "0.19"),
    "PF_SOLUSD": ("0.84", "0.42"),
    "PF_XRPUSD": ("0.68", "1.54"),
    "PF_HYPEUSD": ("1.49", "1.48"),
    "PF_ZECUSD": ("3.28", "2.29"),
    "PF_ADAUSD": ("3.10", "2.77"),
    "PF_NEARUSD": ("5.41", "3.55"),
}
# Unmeasured products are priced like the worst measured one.
_FALLBACK = _EXECUTION["PF_NEARUSD"]


def _row(product_id):
    return _EXECUTION.get(product_id or DEFAULT_PRODUCT, _FALLBACK)


def spread_bps(product_id):
    return Decimal(_row(product_id)[0])


def side_impact_bps(product_id):
    """Market-order slippage against the mid, one side, 1 000 USD."""
    return Decimal(_row(product_id)[1])


def stop_exit_bps(product_id):
    """A stop executes at market after it is touched: one side's impact plus a full spread."""
    return side_impact_bps(product_id) + spread_bps(product_id)


def fee_rate(kind="taker"):
    return Decimal(MAKER_RATE if kind == "maker" else TAKER_RATE)


def round_trip_rate(product_id, *, exit_kind="taker"):
    """Fraction of notional one entry plus one exit costs (fees and execution)."""
    fees = fee_rate("taker") + fee_rate(exit_kind)
    return fees + 2 * side_impact_bps(product_id) / TEN_THOUSAND


def round_trip_cost_bps(product_id, *, exit_kind="taker"):
    return round_trip_rate(product_id, exit_kind=exit_kind) * TEN_THOUSAND


def cost_model_hash():
    return canonical_hash({
        "version": COST_MODEL_VERSION, "maker": MAKER_RATE, "taker": TAKER_RATE, "execution": {k: list(v) for k, v in _EXECUTION.items()},
    })


def measured_spread_bps(points):
    """Median spread (bp) over ``orderbook`` analytics values (``bid.bestPrice``/``ask.bestPrice``)."""
    spreads = []
    for values in points:
        try:
            bid, ask = Decimal(values["bid.bestPrice"]), Decimal(values["ask.bestPrice"])
        except (KeyError, ArithmeticError, TypeError):
            continue
        if bid > 0 and ask >= bid:
            spreads.append((ask - bid) / ((ask + bid) / 2) * TEN_THOUSAND)
    if not spreads:
        return None
    spreads.sort()
    mid = len(spreads) // 2
    return spreads[mid] if len(spreads) % 2 else (spreads[mid - 1] + spreads[mid]) / 2


def entry_fill(price, side, product_id):
    """Price a market entry pays: worse than ``price`` by one side's impact."""
    adjust = side_impact_bps(product_id) / TEN_THOUSAND
    return price * (1 + adjust) if side == "LONG" else price * (1 - adjust)


def exit_fill(price, side, product_id, reason="strategy_exit"):
    """Price a market exit gets: stops also pay a full spread; limit targets fill at the level."""
    if reason == "target":
        return price
    adjust = (stop_exit_bps(product_id) if reason == "stop" else side_impact_bps(product_id)) / TEN_THOUSAND
    return price * (1 - adjust) if side == "LONG" else price * (1 + adjust)
