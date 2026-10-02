"""Cross-language canonical JSON and decimal helpers for futures records."""
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation


def normalize_decimal(value):
    if not isinstance(value, str):
        raise ValueError("decimal values must be supplied as strings")
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("invalid decimal string") from error
    if not number.is_finite():
        raise ValueError("decimal must be finite")
    if number == 0:
        return "0"
    normalized = format(number, "f")
    return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized


def canonical_json(value):
    def validate(item):
        if item is None or isinstance(item, (str, bool)):
            return
        if isinstance(item, int) and not isinstance(item, bool):
            if abs(item) > 2**53 - 1:
                raise ValueError("unsafe integer")
            return
        if isinstance(item, float):
            raise ValueError("floating point values are unsupported")
        if isinstance(item, list):
            for child in item:
                validate(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise ValueError("object keys must be strings")
                validate(child)
            return
        raise ValueError("unsupported canonical value")
    validate(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_hash(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalize_timestamp_ms(value):
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 2**53 - 1:
        raise ValueError("timestamp must be safe UTC integer milliseconds")
    return value
