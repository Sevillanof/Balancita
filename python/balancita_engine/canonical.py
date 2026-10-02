"""Cross-language canonical JSON and decimal helpers for futures records."""
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation

MAX_DECIMAL_INPUT_CHARS = 4096
MAX_DECIMAL_EXPONENT = 10_000


def _normalized_unicode(value):
    output = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if index + 1 >= len(value) or not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                raise ValueError("unpaired Unicode surrogate")
            low = ord(value[index + 1])
            output.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + low - 0xDC00))
            index += 2
            continue
        if 0xDC00 <= codepoint <= 0xDFFF:
            raise ValueError("unpaired Unicode surrogate")
        output.append(value[index])
        index += 1
    return "".join(output)


def normalize_decimal(value):
    if not isinstance(value, str) or len(value) > MAX_DECIMAL_INPUT_CHARS:
        raise ValueError("decimal values must be supplied as strings")
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("invalid decimal string") from error
    if not number.is_finite():
        raise ValueError("decimal must be finite")
    if abs(number.as_tuple().exponent) > MAX_DECIMAL_EXPONENT:
        raise ValueError("decimal exponent is outside the supported range")
    if number == 0:
        return "0"
    normalized = format(number, "f")
    return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized


def canonical_json(value):
    def normalize(item):
        if isinstance(item, str):
            return _normalized_unicode(item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                normalized_key = _normalized_unicode(key) if isinstance(key, str) else key
                if normalized_key in result:
                    raise ValueError("object keys collide after Unicode normalization")
                result[normalized_key] = normalize(child)
            return result
        return item

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
    normalized = normalize(value)
    validate(normalized)
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_hash(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalize_timestamp_ms(value):
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 2**53 - 1:
        raise ValueError("timestamp must be safe UTC integer milliseconds")
    return value
