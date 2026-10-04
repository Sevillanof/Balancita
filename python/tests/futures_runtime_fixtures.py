"""Deterministic mock evidence for futures-runtime tests; not production logic."""

from decimal import Decimal


INSTRUMENT = {
    "instrument_id": "kraken-futures:PF_XBTUSD",
    "provider_symbol": "PF_XBTUSD",
    "quantity_step_btc": "0.0001",
    "minimum_quantity_btc": "0.0001",
    "price_tick_usd": "1",
}

CONFIG = {
    "version": "futures-runtime-lab.v1",
    "initial_cash_usd": "10000",
    "max_notional_usd": "1000",
    "max_exposure_multiple": "1",
    "risk_fraction": "0.001",
    "execution_latency_ms": 0,
    "max_book_age_ms": 3000,
    "max_spread_bps": "5",
    "cost_version": "kraken-futures-eea-btcusd-base.v1",
    "maker_rate": "0.0002",
    "taker_rate": "0.0005",
}


def warmed_market(
    cutoff_ms,
    *,
    breakout=None,
    book_size="1",
    spread="1",
    base_price="100000",
):
    """Return warmed mock 1m/5m bars, current book, ticker, and instrument."""
    events = []
    order = 0
    for interval_ms, count in ((60_000, 60), (300_000, 60)):
        for index in range(count):
            order += 1
            close = Decimal(base_price)
            high = close + Decimal("50")
            low = close - Decimal("50")
            volume = Decimal("1")
            if interval_ms == 60_000 and index == count - 1 and breakout:
                close = close + Decimal("100") if breakout == "long" else close - Decimal("100")
                high = close + Decimal("1") if breakout == "long" else Decimal(base_price) + Decimal("1")
                low = Decimal(base_price) - Decimal("1") if breakout == "long" else close - Decimal("1")
                volume = Decimal("2")
            bucket_start = cutoff_ms - (count - index) * interval_ms
            known_at = bucket_start + interval_ms
            events.append(
                {
                    "type": "candle",
                    "interval_ms": interval_ms,
                    "bucket_start_ms": bucket_start,
                    "event_time_ms": known_at,
                    "received_at_ms": known_at,
                    "known_at_ms": known_at,
                    "reception_order": order,
                    "closed": True,
                    "coverage": "complete",
                    "open": base_price,
                    "high": str(high),
                    "low": str(low),
                    "close": str(close),
                    "volume_btc": str(volume),
                }
            )
    mid = Decimal("100000")
    bid = mid
    ask = mid + Decimal(spread)
    events.extend(
        [
            {
                "type": "book_snapshot",
                "event_time_ms": cutoff_ms,
                "received_at_ms": cutoff_ms,
                "known_at_ms": cutoff_ms,
                "reception_order": order + 1,
                "epoch": 1,
                "sequence": 1,
                "contiguous": True,
                "valid": True,
                "bids": [{"price_usd": str(bid), "quantity_btc": book_size}],
                "asks": [{"price_usd": str(ask), "quantity_btc": book_size}],
            },
            {
                "type": "ticker",
                "event_time_ms": cutoff_ms,
                "received_at_ms": cutoff_ms,
                "known_at_ms": cutoff_ms,
                "reception_order": order + 2,
                "mark_usd": str((bid + ask) / 2),
                "market_status": "open",
            },
        ]
    )
    events.sort(key=lambda event: (event["received_at_ms"], event["reception_order"]))
    for reception_order, event in enumerate(events, start=1):
        event["reception_order"] = reception_order
    return {
        "mode": "mock",
        "instrument": dict(INSTRUMENT),
        "decision_time_ms": cutoff_ms,
        "cutoff_received_at_ms": cutoff_ms,
        "events": events,
    }


def valid_flat_market(cutoff_ms):
    """Complete flat OHLC mock: no fabricated volatility or breakout signal."""
    market = warmed_market(cutoff_ms)
    for event in market["events"]:
        if event["type"] == "candle":
            event.update(open="100000", high="100000", low="100000", close="100000")
    return market


def add_known_funding(market, *, interval_id="utc-hour-0", start_ms=None, rate="0"):
    if start_ms is None:
        start_ms = market["decision_time_ms"] // 3_600_000 * 3_600_000
    market["events"].append(
        {
            "type": "funding",
            "interval_id": interval_id,
            "start_time_ms": start_ms,
            "end_time_ms": start_ms + 3_600_000,
            "rate_usd_per_btc_hour": rate,
            "event_time_ms": start_ms,
            "received_at_ms": start_ms,
            "known_at_ms": start_ms,
            "reception_order": len(market["events"]) + 1,
        }
    )
    market["events"].sort(
        key=lambda event: (event["received_at_ms"], event["reception_order"])
    )
    for reception_order, event in enumerate(market["events"], start=1):
        event["reception_order"] = reception_order
    return market


def assert_fixture_invariants():
    market = warmed_market(21_600_000, breakout="long")
    book = next(event for event in market["events"] if event["type"] == "book_snapshot")
    bid = Decimal(book["bids"][0]["price_usd"])
    ask = Decimal(book["asks"][0]["price_usd"])
    spread_bps = (ask - bid) / ((ask + bid) / 2) * Decimal("10000")
    assert spread_bps < Decimal(CONFIG["max_spread_bps"])
    assert Decimal(INSTRUMENT["minimum_quantity_btc"]) % Decimal(INSTRUMENT["quantity_step_btc"]) == 0
    assert Decimal(book["bids"][0]["quantity_btc"]) >= Decimal(INSTRUMENT["minimum_quantity_btc"])
    assert Decimal(bid) % Decimal(INSTRUMENT["price_tick_usd"]) == 0
    bars = [event for event in market["events"] if event["type"] == "candle" and event["interval_ms"] == 60_000]
    five_minute_bars = [
        event for event in market["events"]
        if event["type"] == "candle" and event["interval_ms"] == 300_000
    ]
    assert len(bars) == len(five_minute_bars) == 60
    assert bars[-1]["known_at_ms"] <= market["decision_time_ms"]
    assert five_minute_bars[-1]["known_at_ms"] <= market["decision_time_ms"]
    assert all(
        event["received_at_ms"] <= event["known_at_ms"] <= market["decision_time_ms"]
        for event in market["events"]
    )
    assert bars[-1]["volume_btc"] == "2" and bars[-1]["close"] == "100100"
    assert Decimal(bars[-1]["close"]) - Decimal(bars[-2]["high"]) >= Decimal("50")
    estimated_round_trip_cost = Decimal("100000") * (
        Decimal("2") * Decimal("0.0005") + Decimal("0.0002")
    )
    conservative_target_distance = Decimal("3") * Decimal("100")
    assert conservative_target_distance > estimated_round_trip_cost
    flat = valid_flat_market(3_600_000)
    assert all(
        event["high"] == event["low"] == event["close"]
        for event in flat["events"]
        if event["type"] == "candle"
    )
    wide = warmed_market(21_600_000, spread="51")
    wide_book = next(event for event in wide["events"] if event["type"] == "book_snapshot")
    wide_bid = Decimal(wide_book["bids"][0]["price_usd"])
    wide_ask = Decimal(wide_book["asks"][0]["price_usd"])
    wide_spread_bps = (wide_ask - wide_bid) / ((wide_ask + wide_bid) / 2) * Decimal("10000")
    assert wide_spread_bps > Decimal(CONFIG["max_spread_bps"])
    stale_age_ms = CONFIG["max_book_age_ms"] + 1
    assert stale_age_ms > CONFIG["max_book_age_ms"]
    assert not any(event["type"] == "funding" for event in market["events"])
    observed_zero = add_known_funding(warmed_market(21_600_000), rate="0")
    observed = next(event for event in observed_zero["events"] if event["type"] == "funding")
    assert observed["known_at_ms"] <= observed_zero["decision_time_ms"]
    assert observed["rate_usd_per_btc_hour"] == "0"
