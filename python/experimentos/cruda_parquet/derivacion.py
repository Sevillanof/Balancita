"""A SIMPLE derivation to rebuild from the preserved originals (issue #248). It is a test derivation, NOT the capture's candle builder.

Per minute of PROVIDER event time it counts valid ``trade`` messages and sums their quantity (exact decimals), keeping ``arrival order`` and
``known_at``: ``known_at`` of a value is the local ``received_at`` of the message that carried it, so trades recovered late (those of a
``trade_snapshot``) are reported in their own series and never count as known before they were received. Duplicates (same bytes) are
counted once, in arrival order; the duplicate stays in the archive.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Dict, Iterable

MINUTE_MS = 60_000


def derive_minutes(records: Iterable) -> Dict[str, dict]:
    """``records`` yields objects with ``raw``, ``endpoint``, ``received_at`` (an archive Record or a corpus Message)."""
    live: Dict[int, dict] = {}
    recovered: Dict[int, dict] = {}
    seen = set()
    for r in records:
        if r.endpoint not in ("trade", "trade_snapshot"):
            continue
        digest = hashlib.sha256(r.raw).digest()
        if (r.endpoint, digest) in seen:
            continue
        seen.add((r.endpoint, digest))
        try:
            body = json.loads(r.raw.decode("utf-8"))
            trades = [body] if r.endpoint == "trade" else list(body["trades"])
            parsed = [(int(t["time"]), Decimal(str(t["qty"]))) for t in trades]
        except Exception:
            continue
        target = live if r.endpoint == "trade" else recovered
        for event_time, qty in parsed:
            slot = target.setdefault(event_time // MINUTE_MS * MINUTE_MS, {"count": 0, "volume": Decimal(0), "known_first": r.received_at, "known_last": r.received_at})
            slot["count"] += 1
            slot["volume"] += qty
            slot["known_first"] = min(slot["known_first"], r.received_at)
            slot["known_last"] = max(slot["known_last"], r.received_at)

    def render(series: Dict[int, dict]) -> dict:
        return {str(m): {"count": v["count"], "volume": format(v["volume"], "f"), "known_first": v["known_first"], "known_last": v["known_last"]}
                for m, v in sorted(series.items())}

    return {"live": render(live), "recovered": render(recovered)}


def derivation_hash(result: dict) -> str:
    return hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
