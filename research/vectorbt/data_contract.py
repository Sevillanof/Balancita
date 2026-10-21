"""The data contract between Balancita and the lab: time, holdout and candle checks (doc section 6)."""

import json
import os
from datetime import datetime, timezone

MINUTE_MS = 60_000
INTERVAL_MS = {"1m": MINUTE_MS, "5m": 5 * MINUTE_MS}
DEFAULT_GATE_CONFIG = os.path.join(os.path.dirname(__file__), "..", "..", "config", "strategy-gate.json")


class ContractError(ValueError):
    """The data or the request breaks the contract; the lab stops instead of guessing."""


def date_ms(text):
    """``YYYY-MM-DD`` (UTC midnight) in milliseconds."""
    return int(datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_gate_config(path=None):
    with open(path or DEFAULT_GATE_CONFIG, encoding="utf-8") as handle:
        return json.load(handle)


def holdout_ms(config):
    return date_ms(config["holdout_from"])


def check_window(from_ms, to_ms, holdout):
    """The practice window must end at or before the holdout: a request that touches it is refused, not trimmed."""
    if from_ms >= to_ms:
        raise ContractError("la ventana está vacía: desde {} hasta {}".format(iso(from_ms), iso(to_ms)))
    if to_ms > holdout:
        raise ContractError("la ventana pedida llega a {} y pisa la reserva (desde {}): no se exporta".format(
            iso(to_ms), iso(holdout)))


def check_candles(rows, resolution, holdout):
    """Order, duplicates, OHLC coherence and, above all, ``bucket_start + interval <= holdout`` for every row."""
    step = INTERVAL_MS[resolution]
    previous = None
    for row in rows:
        start = row["bucket_start"]
        if start + step > holdout:
            raise ContractError("una vela de {} ({}) cierra después de la reserva".format(resolution, iso(start)))
        if previous is not None and start <= previous:
            raise ContractError("velas desordenadas o repetidas en {}".format(iso(start)))
        o, h, l, c = (float(row[k]) for k in ("open", "high", "low", "close"))
        if not (l <= min(o, c) and h >= max(o, c) and l <= h):
            raise ContractError("OHLC incoherente en {}".format(iso(start)))
        if float(row["volume_btc"]) < 0:
            raise ContractError("volumen negativo en {}".format(iso(start)))
        previous = start
