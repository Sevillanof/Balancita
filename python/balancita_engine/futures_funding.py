"""Causal normalization and accrual for isolated linear BTC/USD paper funding."""

from decimal import Decimal, InvalidOperation, localcontext
import re

from .canonical import normalize_decimal, normalize_timestamp_ms

FUNDING_SEMANTIC_VERSION = "kraken-funding-normalization.v1"
HOUR_MS = 3_600_000


def _decimal(value, name):
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError("{} must be a decimal string".format(name))
    try:
        result = Decimal(normalize_decimal(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("{} must be a decimal string".format(name)) from error
    if not result.is_finite():
        raise ValueError("{} must be finite".format(name))
    return result


def normalize_observation(raw, decision_cutoff_ms):
    """Normalize only explicit, observed unit and effective-interval contracts.

    This deliberately does not infer an interval from provider next-period fields.
    """
    if not isinstance(raw, dict):
        raise ValueError("funding observation must be an object")
    required = {
        "source", "provider", "product", "field", "raw_rate", "unit",
        "effective_start_ms", "effective_end_ms", "known_at_ms",
        "received_seq", "observation_id", "sha256", "semantic_version",
        "predicted",
    }
    optional = {"reference_price_usd_per_btc", "reference_price_at_ms"}
    if not required.issubset(raw) or not set(raw).issubset(required | optional):
        raise ValueError("funding observation fields do not match contract")
    if ("reference_price_usd_per_btc" in raw) != ("reference_price_at_ms" in raw):
        raise ValueError("relative funding reference price and time must be paired")
    if (raw["provider"] != "kraken" or raw["product"] != "PF_XBTUSD"
            or raw["field"] not in ("funding_rate", "relative_funding_rate")
            or not all(isinstance(raw[k], str) and raw[k] for k in
                       ("source", "observation_id", "semantic_version"))
            or not isinstance(raw["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", raw["sha256"])
            or isinstance(raw["received_seq"], bool)
            or not isinstance(raw["received_seq"], int) or raw["received_seq"] < 0
            or not isinstance(raw["predicted"], bool)):
        raise ValueError("invalid funding observation provenance")
    if raw["semantic_version"] != FUNDING_SEMANTIC_VERSION:
        raise ValueError("unsupported funding semantic version")
    cutoff = normalize_timestamp_ms(decision_cutoff_ms)
    known_at = normalize_timestamp_ms(raw["known_at_ms"])
    rate = _decimal(raw["raw_rate"], "funding rate")
    interval_known = raw["effective_start_ms"] is not None and raw["effective_end_ms"] is not None
    start = end = None
    if interval_known:
        start = normalize_timestamp_ms(raw["effective_start_ms"])
        end = normalize_timestamp_ms(raw["effective_end_ms"])
        if start < 0 or end <= start:
            raise ValueError("invalid effective funding interval")
    if raw["predicted"] or known_at > cutoff or not interval_known:
        status, normalized = "unknown", None
    elif raw["field"] == "funding_rate" and raw["unit"] == "usd_per_btc_per_hour":
        status, normalized = "known", rate
    elif raw["field"] == "relative_funding_rate" and raw["unit"] == "relative_per_hour":
        # Caller must explicitly bind the verified provider reference price and its time.
        ref_price = raw.get("reference_price_usd_per_btc")
        ref_time = raw.get("reference_price_at_ms")
        if ref_price is None or ref_time is None:
            status, normalized = "unknown", None
        else:
            price = _decimal(ref_price, "reference price")
            if price <= 0 or normalize_timestamp_ms(ref_time) > cutoff:
                status, normalized = "unknown", None
            else:
                status, normalized = "known", rate * price
    else:
        status, normalized = "unknown", None
    return {
        "status": status, "source": raw["source"], "provider": raw["provider"],
        "product": raw["product"], "field": raw["field"], "unit": raw["unit"],
        "effective_start_ms": start, "effective_end_ms": end,
        "known_at_ms": known_at, "received_seq": raw["received_seq"],
        "observation_id": raw["observation_id"], "sha256": raw["sha256"],
        "raw_rate": normalize_decimal(str(rate)),
        "rate_usd_per_btc_hour": None if normalized is None else normalize_decimal(str(normalized)),
        "semantic_version": raw["semantic_version"], "predicted": raw["predicted"],
    }


def accrue_interval(side, quantity_btc, rate_usd_per_btc_hour, start_ms, end_ms):
    """Return funding cashflow: positive is received, negative is paid."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    quantity = _decimal(quantity_btc, "quantity")
    rate = _decimal(rate_usd_per_btc_hour, "funding rate")
    start, end = normalize_timestamp_ms(start_ms), normalize_timestamp_ms(end_ms)
    if quantity <= 0 or end <= start:
        raise ValueError("invalid funding accrual interval")
    with localcontext() as ctx:
        ctx.prec = 50
        direction_sign = Decimal(1) if side == "long" else Decimal(-1)
        amount = -direction_sign * quantity * rate * Decimal(end - start) / Decimal(HOUR_MS)
        return normalize_decimal(str(amount))


__all__ = ["FUNDING_SEMANTIC_VERSION", "HOUR_MS", "normalize_observation", "accrue_interval"]
