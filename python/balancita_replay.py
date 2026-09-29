"""Deterministic offline replay orchestration around the established ledger."""

from balancita_simulation import DEFAULT_COSTS, simulate_long_flat


def _safe_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("{} must be a non-negative integer".format(name))
    return value


def run_replay(options):
    """Replay closed bars at an explicit cutoff; timestamps in bars denote bar close."""
    interval = _safe_int(options["sourceIntervalMs"], "sourceIntervalMs")
    cutoff = _safe_int(options["cutoffMs"], "cutoffMs")
    scan_time = _safe_int(options["scanTimeMs"], "scanTimeMs")
    max_age = _safe_int(options["maxAgeMs"], "maxAgeMs")
    if interval == 0 or max_age == 0 or scan_time < cutoff:
        raise ValueError("interval and max age must be positive and scan cannot precede cutoff")
    unit = options.get("timestampUnit", "milliseconds")
    if unit not in ("milliseconds", "seconds"):
        raise ValueError("timestampUnit must be milliseconds or seconds")
    multiplier = 1000 if unit == "seconds" else 1
    bars = []
    provenance = []
    for source in options["bars"]:
        original = _safe_int(source["time"], "bar time")
        time_ms = original * multiplier
        if time_ms <= cutoff:
            provenance.append({"value": original, "unit": unit})
            bars.append(dict(source, time=time_ms))
    bars.sort(key=lambda bar: bar["time"])
    if len({bar["time"] for bar in bars}) != len(bars):
        raise ValueError("bar timestamps must be unique after conversion")
    signals = []
    signal_provenance = []
    for source in options["signals"]:
        original = _safe_int(source["time"], "signal time")
        signal = dict(source, time=original * multiplier)
        if signal["time"] <= cutoff:
            signal_provenance.append({"value": original, "unit": unit})
            signals.append(signal)
    signals.sort(key=lambda signal: signal["time"])
    closed = [bar for bar in bars if bar["time"] <= cutoff]
    latest = closed[-1]["time"] if closed else None
    gaps = []
    for previous, current in zip(closed, closed[1:]):
        expected = previous["time"] + interval
        while expected < current["time"]:
            gaps.append(expected)
            expected += interval
    costs = options.get("costs", DEFAULT_COSTS)
    identity = {
        "commissionRate": costs.get("commissionRate", DEFAULT_COSTS["commissionRate"]),
        "slippageRate": costs.get("slippageRate", DEFAULT_COSTS["slippageRate"]),
    }
    result = {
        "strategyId": options["strategyId"],
        "configId": options["configId"],
        "costIdentity": identity,
        "parameters": {
            "startingCash": options.get("startingCash", 10000.0),
            "entryThreshold": options.get("entryThreshold", 0.55),
            "exitUpThreshold": options.get("exitUpThreshold", 0.45),
            "exitDownThreshold": options.get("exitDownThreshold", 0.55),
        },
        "sourceIntervalMs": interval,
        "cutoffMs": cutoff,
        "scanTimeMs": scan_time,
        "sourceTimestamps": provenance,
        "signalTimestampProvenance": signal_provenance,
        "inputWindow": {
            "barCount": len(closed),
            "barTimesMs": [bar["time"] for bar in closed],
            "cutoffMs": cutoff,
        },
        "gaps": gaps,
        "decisionInputs": signals,
        "comparator": {"status": "not_comparable", "reason": "No frozen FastReplay-identical 1m input and resampling contract supplied."},
        "ledger": None,
    }
    if latest is None or scan_time - latest > max_age:
        result["status"] = "stale"
        return result
    result["status"] = "no_new_closed_bar" if scan_time > latest else "replayed"
    result["ledger"] = simulate_long_flat({
        "bars": closed, "signals": signals,
        "startingCash": options.get("startingCash", 10000.0),
        "entryThreshold": options.get("entryThreshold", 0.55),
        "exitUpThreshold": options.get("exitUpThreshold", 0.45),
        "exitDownThreshold": options.get("exitDownThreshold", 0.55),
        "costs": costs,
    })
    return result
