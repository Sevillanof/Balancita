"""Deterministic SYNTHETIC corpus of Kraken-like WebSocket messages and complete REST responses (issue #248).

No real data, no credentials. The generator uses its own SplitMix64 generator (not ``random``), so the same seed and configuration give
the same bytes on every Python version. Message kinds: valid, invalid (broken JSON, non-UTF-8, empty, oversized), duplicates,
out-of-order sequence numbers, recovered trades (``trade_snapshot``), REST responses and several timestamp forms.

Size policy (fixed in advance, declared in the report): the "sized" kinds (REST responses, trade snapshots, oversized and a small share
of the others) draw a target size log-uniformly in [min_size, max_size]; the other messages keep their natural size (~150-450 B). A
corpus stops at ``max_corpus_bytes`` so a step is bounded in bytes, not only in record count.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Iterator, List, NamedTuple, Optional, Tuple

MASK = (1 << 64) - 1
BASE_TIME_MS = 1_791_000_000_000
DEFAULT_MIN_SIZE = 100
DEFAULT_MAX_SIZE = 64 * 1024


class Rng:
    """SplitMix64: tiny, explicit and identical on every interpreter."""

    def __init__(self, seed: int):
        self.state = seed & MASK

    def u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        return z ^ (z >> 31)

    def below(self, n: int) -> int:
        return self.u64() % n

    def unit(self) -> float:
        return (self.u64() >> 11) / float(1 << 53)

    def hex(self, n: int) -> str:
        out = []
        while len(out) * 16 < n:
            out.append("%016x" % self.u64())
        return "".join(out)[:n]


class CorpusConfig(NamedTuple):
    seed: int = 248
    max_records: int = 1000
    max_corpus_bytes: int = 64 * 1024 * 1024
    min_size: int = DEFAULT_MIN_SIZE
    max_size: int = DEFAULT_MAX_SIZE


class Message(NamedTuple):
    """One message as the receiver saw it. ``raw`` is the original bytes, never re-serialised."""
    source: str  # "ws" | "rest"
    endpoint: str
    product: str  # "" when the envelope has none
    raw: bytes
    provider_time: str  # provider time copied as TEXT ("" when absent or unreadable)
    provider_seq: str  # provider sequence copied as TEXT
    received_at: int  # local clock, ms


def extract_meta(raw: bytes) -> Tuple[str, str, str]:
    """Tolerant, extract-only parser: (product, provider_time, provider_seq) as text. NEVER raises."""
    try:
        value = json.loads(raw.decode("utf-8"))
    except Exception:
        return "", "", ""
    if not isinstance(value, dict):
        return "", "", ""
    out = []
    for key in ("product_id", "time", "seq"):
        item = value.get(key)
        out.append(item if isinstance(item, str) else (str(item) if isinstance(item, int) and not isinstance(item, bool) else ""))
    return out[0], out[1], out[2]


def log_uniform(rng: Rng, low: int, high: int) -> int:
    return int(math.exp(math.log(low) + rng.unit() * (math.log(high) - math.log(low))))


def _dump(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _pad(rng: Rng, body: dict, target: int) -> bytes:
    raw = _dump(body)
    if len(raw) >= target:
        return raw
    body = dict(body)
    body["pad"] = ""
    base = len(_dump(body))
    body["pad"] = rng.hex(max(0, target - base))
    return _dump(body)


def iso_text(ms: int, form: int, rng: Rng) -> str:
    """Hand-built UTC timestamp text (no ``datetime``: identical everywhere) in one of several shapes."""
    days, rest = divmod(ms // 1000, 86400)
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    year = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + 3 if mp < 10 else mp - 9
    if month <= 2:
        year += 1
    text = "%04d-%02d-%02dT%02d:%02d:%02d" % (year, month, day, rest // 3600, rest % 3600 // 60, rest % 60)
    digits = [0, 2, 3, 6, 9][form % 5] if form < 5 else 3
    frac = "" if digits == 0 else "." + "".join(str(rng.below(10)) for _ in range(digits))
    return text + frac + ("+00:00" if form == 5 else "Z")


def generate(config: CorpusConfig) -> Iterator[Message]:
    """Yield the corpus in ARRIVAL order. Same ``config`` -> same bytes."""
    rng = Rng(config.seed)
    received = BASE_TIME_MS + 5_000
    seq = 1000
    trades: List[Message] = []
    total = 0
    for _ in range(config.max_records):
        received += 1 + rng.below(900)
        roll = rng.below(1000)
        event_time = received - rng.below(400)
        sized = rng.below(100) == 0
        target = log_uniform(rng, config.min_size, config.max_size)
        if roll < 480:  # valid trade
            seq += 1
            body = {"feed": "trade", "product_id": "PF_XBTUSD", "uid": rng.hex(32), "side": "buy" if rng.below(2) else "sell",
                    "type": "fill", "seq": seq, "time": event_time, "qty": rng.below(5000) / 1000.0 + 0.001,
                    "price": 60000 + rng.below(300000) / 100.0}
            raw = _pad(rng, body, target) if sized else _dump(body)
            msg = _message("ws", "trade", raw, received)
            trades.append(msg)
        elif roll < 560:  # ticker
            seq += 1
            body = {"feed": "ticker", "product_id": "PF_XBTUSD", "bid": 60000 + rng.below(1000), "ask": 61000 + rng.below(1000),
                    "markPrice": 60500.5, "funding_rate": rng.below(100000) / 1e9, "seq": seq, "time": event_time, "suspended": False}
            raw = _pad(rng, body, target) if sized else _dump(body)
            msg = _message("ws", "ticker", raw, received)
        elif roll < 590:  # recovered trades (snapshot after a reconnection): older events, received now
            snapshot = [{"uid": rng.hex(32), "side": "buy", "type": "fill", "seq": seq - 1 - i, "time": event_time - 70_000 - i * 50,
                         "qty": 0.01 + i / 1000.0, "price": 60000 + i} for i in range(1 + rng.below(40))]
            raw = _pad(rng, {"feed": "trade_snapshot", "product_id": "PF_XBTUSD", "trades": snapshot}, target)
            msg = _message("ws", "trade_snapshot", raw, received)
        elif roll < 660:  # complete REST ticker list
            tickers = [{"symbol": "PF_%s%d" % ("XBT" if i == 0 else "ALT", i), "bid": 100 + i, "ask": 101 + i, "markPrice": 100.5 + i,
                        "fundingRate": rng.below(1000) / 1e10, "last": 100.25 + i} for i in range(1 + rng.below(60))]
            raw = _pad(rng, {"result": "success", "serverTime": iso_text(received, rng.below(6), rng), "tickers": tickers}, target)
            msg = _message("rest", "tickers", raw, received, rest_time=True)
        elif roll < 700:  # REST funding with several timestamp shapes
            rates = [{"timestamp": iso_text(received - (i + 1) * 3_600_000, rng.below(6), rng), "fundingRate": rng.below(100000) / 1e9,
                      "relativeFundingRate": rng.below(100000) / 1e11} for i in range(1 + rng.below(30))]
            raw = _pad(rng, {"result": "success", "serverTime": iso_text(received, rng.below(6), rng), "rates": rates}, target)
            msg = _message("rest", "historical-funding-rates", raw, received, rest_time=True)
        elif roll < 760:  # invalid: broken JSON, non-UTF-8, empty, oversized
            kind = rng.below(4)
            if kind == 0:
                raw = _dump({"feed": "trade", "product_id": "PF_XBTUSD", "seq": seq + 1, "time": event_time})[:-1 - rng.below(10)]
            elif kind == 1:
                raw = b"\xff\xfe" + _dump({"feed": "trade"})[1:] + bytes([0x80 + rng.below(64)])
            elif kind == 2:
                raw = b""
            else:
                raw = _pad(rng, {"feed": "trade", "product_id": "PF_XBTUSD", "seq": seq + 1}, config.max_size + 1 + rng.below(1024))  # ABOVE max_size on purpose: kept whole, never truncated
            msg = _message("ws", "invalid", raw, received)
        elif roll < 840 and trades:  # exact duplicate (same bytes, new arrival)
            first = trades[rng.below(len(trades))]
            msg = first._replace(received_at=received)
        elif roll < 880 and trades:  # out-of-order sequence number
            seq += 1
            body = {"feed": "trade", "product_id": "PF_XBTUSD", "uid": rng.hex(32), "side": "sell", "type": "fill",
                    "seq": max(1, seq - 5 - rng.below(20)), "time": event_time, "qty": 0.5, "price": 60001.5}
            msg = _message("ws", "trade", _dump(body), received)
        else:  # heartbeat / control frames kept as they came
            raw = _dump({"feed": "heartbeat", "time": event_time})
            msg = _message("ws", "heartbeat", raw, received)
        if total + len(msg.raw) > config.max_corpus_bytes:
            return
        total += len(msg.raw)
        yield msg


def _message(source: str, endpoint: str, raw: bytes, received: int, rest_time: bool = False) -> Message:
    product, ptime, pseq = extract_meta(raw)
    if rest_time:
        try:
            ptime = str(json.loads(raw.decode("utf-8")).get("serverTime", ""))
        except Exception:
            ptime = ""
    return Message(source, endpoint, product, raw, ptime, pseq, received)


def corpus_hash(messages) -> Tuple[str, int, int]:
    """(sha256 over every field with length prefixes, record count, byte total). Order matters."""
    digest = hashlib.sha256()
    count = total = 0
    for m in messages:
        for part in (m.source.encode(), m.endpoint.encode(), m.product.encode(), m.provider_time.encode(), m.provider_seq.encode(),
                     str(m.received_at).encode(), m.raw):
            digest.update(len(part).to_bytes(8, "big"))
            digest.update(part)
        count += 1
        total += len(m.raw)
    return digest.hexdigest(), count, total


def size_summary(messages) -> dict:
    sizes = sorted(len(m.raw) for m in messages)
    if not sizes:
        return {"n": 0}
    return {"n": len(sizes), "min": sizes[0], "mean": round(sum(sizes) / len(sizes), 1), "p50": sizes[len(sizes) // 2],
            "p99": sizes[min(len(sizes) - 1, int(len(sizes) * 0.99))], "max": sizes[-1], "total": sum(sizes)}
