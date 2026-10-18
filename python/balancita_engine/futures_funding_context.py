"""Funding as one line of Qwen's STATE (FC-02): where the last closed funding period sits against the month before it.

Causal by construction: a funding period counts only once the capture had seen it (its stored ``known_at``, the real
moment, no floor), only while it is at most ``MAX_PERIOD_AGE_MS`` old, and its percentile is taken against the 30 days
of time before it (``WINDOW_MS``), never against the whole history (which, in a replay, contains the future). The
window must be complete (every hour known); an hour the capture learned late, from the Kraken history backfill, counts
as soon as its ``known_at`` is <= the instant judged. Anything else is unknown, and always with a stable code and a
human-readable reason (``FundingContext.assess``). The rate is Kraken's relative hourly rate, so products are comparable.
"""

import bisect
import json
import sqlite3

from .futures_llm_decisions import sanitize_text

HOUR_MS = 3_600_000
WINDOW = 720  # hourly periods, 30 days
PUBLICATION_LAG_MS = 600_000  # FundingContext has no floor; this is the wait modelled by with_publication_wait (9A replay, live evaluator)
WINDOW_MS = WINDOW * HOUR_MS
# PROVISIONAL (owner decision), pending the WebSocket funding work. Measured from the END of the newest known period:
# funding is hourly and the just-closed period is normally known 30 s-11 min after its end (the capture's REST retries and
# settle poll, live-capture.ts), so in normal operation the newest known period ended at most ~60 min ago; beyond 71 min the
# just-closed hour did not arrive. With funding from the WebSocket this drops to ~61 min.
MAX_PERIOD_AGE_MS = 71 * 60_000
HIGH, LOW = 90.0, 10.0  # percentile bands that read "high" / "low"
PLACEBO_SHIFT_MS = 7 * 24 * HOUR_MS
FUNDING_QUESTION_VERSION = 6  # v6: the funding line comes from the causal loader; v5 rows are never mixed with it
BTC_PRODUCT = "PF_XBTUSD"


def _start_ms(rate):
    from datetime import datetime

    return int(datetime.fromisoformat(rate["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)


def periods_from_responses(raw_responses):
    """First-seen rate per period start across Kraken ``historical-funding-rates`` bodies; bad bodies are skipped.

    Pure parsing, no notion of when each body arrived: ``load_periods`` is what dates the periods.
    """
    found = {}
    for raw in raw_responses:
        try:
            for rate in json.loads(raw)["rates"]:
                found.setdefault(_start_ms(rate), float(rate["relativeFundingRate"]))
        except (ValueError, KeyError, TypeError):
            continue
    return sorted(found.items())


_RATE_CACHE = {}  # (market DB path, response sha256, period start) -> relative rate or None; a stored body never changes


def _tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _extract_rates(text):
    """``{start: relative_rate}`` from a poll's literal extract (``serverTime=...`` then one JSON period per line)."""
    found = {}
    for line in (text or "").splitlines()[1:]:
        try:
            rate = json.loads(line)
            found[_start_ms(rate)] = float(rate["relativeFundingRate"])
        except (TypeError, ValueError, KeyError):
            continue
    return found


def _relative_rates(db, path, product_id, sha, starts, tables):
    """``{start: relative_rate}`` of ``starts`` in response ``sha``: from the poll's literal extract (what the sightings
    keep) or, if the full body was stored, from it. Hours neither states are absent: never guessed."""
    missing = {s for s in starts if (path, sha, s) not in _RATE_CACHE}
    if missing:
        found = {}
        if "paper_futures_funding_polls" in tables:
            for (text,) in db.execute("SELECT extract_text FROM paper_futures_funding_polls WHERE response_sha256=? "
                                      "AND product_id=?", (sha, product_id)):
                found.update({k: v for k, v in _extract_rates(text).items() if k in missing})
        rest = missing - set(found)
        row = db.execute("SELECT raw_response FROM paper_futures_funding_responses WHERE sha256=?", (sha,)).fetchone() \
            if rest else None
        if row is not None:
            try:
                for rate in json.loads(row[0])["rates"]:
                    start = _start_ms(rate)
                    if start in rest:
                        found[start] = float(rate["relativeFundingRate"])
            except (TypeError, ValueError, KeyError):
                pass
        for start in missing:
            _RATE_CACHE[(path, sha, start)] = found.get(start)
    return {s: _RATE_CACHE[(path, sha, s)] for s in starts if _RATE_CACHE[(path, sha, s)] is not None}


def load_periods_detailed(market_db_path, product_id, since_ms=None):
    """``(periods, info)``: ``periods`` is sorted ``[(start_ms, relative_rate, known_at_ms)]``; ``info`` is
    ``{"approximate": {start, ...}, "conflicts": {start: other rates seen}}``. Read-only.

    Sightings era (``paper_futures_funding_sightings``, one row per closed period at every poll): ``known_at`` is the first
    sighting after the period closed and the rate is that sighting's (first seen, for causality). If later sightings show a
    different rate the period is listed in ``conflicts`` (how many other rates), never silently resolved.
    Before that table existed (or in a DB without it) only ``paper_futures_funding_periods`` is left, which writes a row only
    when ``(start, rate)`` is new: the first row from after the close is used as it was; an hour whose only row was seen
    while it was still open gets ``known_at = end + 1 h`` (the next hourly poll, conservative) and is ``approximate``.
    Relative rates come from the poll extracts or stored bodies, parsed once per process (``_RATE_CACHE``); ``since_ms`` leaves
    out periods that start earlier, so the cost follows the hours replayed. Unreadable hours are left out.
    """
    db = sqlite3.connect("file:{}?mode=ro".format(market_db_path), uri=True)
    info = {"approximate": set(), "conflicts": {}}
    try:
        tables = _tables(db)
        if "paper_futures_funding_periods" not in tables:
            return [], info
        columns = [row[1] for row in db.execute("PRAGMA table_info(paper_futures_funding_periods)")]
        if "product_id" in columns:
            where, args = "product_id=?", [product_id]
        elif product_id == BTC_PRODUCT:  # a market DB written before schema 7 holds the BTC perpetual only
            where, args = "1", []
        else:
            return [], info
        since = "" if since_ms is None else " AND start_ms>=?"
        extra = [] if since_ms is None else [since_ms]
        first, rates_seen, era_start = {}, {}, None
        if "paper_futures_funding_sightings" in tables:
            era = db.execute("SELECT MIN(received_at) FROM paper_futures_funding_sightings WHERE product_id=?",
                             (product_id,)).fetchone()[0]
            era_start = era
            for start, end, received, rate, sha in db.execute(
                    "SELECT start_ms, end_ms, received_at, funding_rate, response_sha256 FROM paper_futures_funding_sightings "
                    "WHERE product_id=?" + since + " ORDER BY received_at, rowid", [product_id] + extra):
                if received < end:
                    continue
                if start not in first:
                    first[start] = (sha, received, rate)
                elif rate != first[start][2]:
                    rates_seen.setdefault(start, set()).add(rate)
        info["conflicts"] = {start: len(rates) for start, rates in rates_seen.items()}
        # Hours with no sighting after their close: only before the sightings existed (or without the table).
        only_open = {}
        for sha, start, end, known_at in db.execute(
                "SELECT response_sha256, start_ms, end_ms, known_at FROM paper_futures_funding_periods WHERE " + where + since
                + " ORDER BY known_at, rowid", args + extra):
            if start in first or (era_start is not None and end > era_start):
                continue
            if known_at >= end:
                first[start] = (sha, known_at, None)
                only_open.pop(start, None)
            elif start not in only_open:
                only_open[start] = (sha, end + HOUR_MS)
        for start, (sha, known_at) in only_open.items():
            if start not in first:
                first[start] = (sha, known_at, None)
                info["approximate"].add(start)
        by_sha = {}
        for start, (sha, _, _) in first.items():
            by_sha.setdefault(sha, []).append(start)
        rates = {}
        for sha, starts in by_sha.items():
            rates.update(_relative_rates(db, market_db_path, product_id, sha, starts, tables))
    finally:
        db.close()
    info["approximate"] &= set(rates)
    info["conflicts"] = {k: v for k, v in info["conflicts"].items() if k in rates}
    return sorted((start, rates[start], first[start][1]) for start in rates), info


def load_periods(market_db_path, product_id, since_ms=None):
    """Sorted ``[(start_ms, relative_rate, known_at_ms)]``; see ``load_periods_detailed`` for the rules and the flags."""
    return load_periods_detailed(market_db_path, product_id, since_ms)[0]


def with_publication_wait(pairs):
    """``(start, rate)`` pairs as ``(start, rate, end + PUBLICATION_LAG_MS)``: for the callers that model their own
    publication wait (the 9A replay, its parity check, the live evaluator). The context itself applies no floor."""
    return [(start, rate, start + HOUR_MS + PUBLICATION_LAG_MS) for start, rate in pairs]


def _hours_text(ms):
    return "{:g} h".format(round(ms / HOUR_MS, 1))


def _utc(ms):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


class FundingContext:
    """The funding line as of any instant. ``shift_ms`` > 0 is the placebo: same format, data from that long before.

    ``periods`` are ``(start, rate, known_at)``; a pair ``(start, rate)`` is known when the period closed (callers that
    feed funding as it is published). A period is usable at ``t`` only when ``known_at`` <= ``t`` (the real moment the
    capture saw it, no floor); the judged one must also be at most ``MAX_PERIOD_AGE_MS`` old and each of the 720 hours
    before it must be known (100%, no tolerance), else the result is unknown with a code and a reason.

    ``recover_until_ms`` (the forward only): when an instant is unusable on what was known then, it is judged again on
    what the capture knows by that moment (a backfilled off period). Such a result carries ``quality["recovered"]`` and
    the instant is kept in ``late_at``: any decision resting on it must be labelled recovered, never live.
    """

    def __init__(self, periods, shift_ms=0, approximate=(), conflicts=None, recover_until_ms=None):
        """``approximate``: starts whose ``known_at`` is an estimate; ``conflicts``: ``{start: other rates seen}``."""
        self.approximate, self.conflicts = set(approximate), dict(conflicts or {})
        rows = sorted(periods)
        self.starts = [row[0] for row in rows]
        self.rates = [row[1] for row in rows]
        self.known = [(row[0] + HOUR_MS) if len(row) < 3 else row[2] for row in rows]
        self.shift_ms = shift_ms
        self.recover_until_ms = recover_until_ms
        self.late_at = set()

    def assess(self, at_ms):
        """``((rate, percentile), "ok", "")`` or ``(None, code, reason)``. Codes: ``no_history`` (nothing known yet),
        ``stale`` (newest known rate older than ``MAX_PERIOD_AGE_MS``), ``insufficient_history`` (fewer than 30 days
        known), ``window_gaps`` (hours missing inside the 30 days). ``reason`` is Spanish text with the specifics."""
        return self.assess_detail(at_ms)[:3]

    def assess_detail(self, at_ms):
        """``(result, code, reason, quality)``; ``quality`` counts, for the judged period and its window, the hours whose
        ``known_at`` is approximate and those with conflicting sightings (empty before a period is judged)."""
        found = self._judge(at_ms, at_ms - self.shift_ms)
        if found[0] is None and self.recover_until_ms is not None:
            again = self._judge(at_ms, self.recover_until_ms)
            if again[0] is not None:
                self.late_at.add(at_ms)
                return again[0], "ok", "", dict(again[3], recovered=True)
        return found

    def assess_live(self, at_ms):
        """Like ``assess`` but never judging again on later knowledge: what a live reader had at ``at_ms``."""
        return self._judge(at_ms, at_ms - self.shift_ms)[:3]

    def _judge(self, at_ms, cutoff):
        """Judges ``at_ms`` (less the placebo shift) on the periods the capture knew by ``cutoff``."""
        at_ms -= self.shift_ms
        top = bisect.bisect_right(self.starts, at_ms - HOUR_MS)  # periods that have ended
        judged = next((i for i in range(top - 1, -1, -1) if self.known[i] <= cutoff), None)
        if judged is None:
            return None, "no_history", "sin ninguna tasa de funding conocida todavía", {}
        age = at_ms - (self.starts[judged] + HOUR_MS)
        if age > MAX_PERIOD_AGE_MS:
            return None, "stale", "la hora {} no llegó: {} min por encima del límite de {} min (última tasa conocida de hace {})".format(
                _utc(self.starts[judged] + HOUR_MS)[11:], round((age - MAX_PERIOD_AGE_MS) / 60_000), MAX_PERIOD_AGE_MS // 60_000,
                _hours_text(age)), {}
        first = self.starts[judged] - WINDOW_MS
        low = bisect.bisect_left(self.starts, first)
        used = [i for i in range(low, judged) if self.known[i] <= cutoff]  # excludes the judged period
        present = {self.starts[i] for i in used}
        missing = [s for s in range(first, self.starts[judged], HOUR_MS) if s not in present]
        quality = {"approximate_hours": sum(1 for i in used + [judged] if self.starts[i] in self.approximate),
                   "conflicting_hours": sum(1 for i in used + [judged] if self.starts[i] in self.conflicts),
                   "window_hours": len(used)}
        if missing:
            if missing == list(range(first, first + len(missing) * HOUR_MS, HOUR_MS)):  # only the oldest end is bare
                return None, "insufficient_history", "sin historia suficiente: {} de {} días".format(
                    len(used) // 24, WINDOW // 24), quality
            runs = 1 + sum(1 for a, b in zip(missing, missing[1:]) if b - a > HOUR_MS)
            return None, "window_gaps", "faltan {} horas de funding entre {} y {}{} (captura apagada o sin relleno)".format(
                len(missing), _utc(missing[0]), _utc(missing[-1] + HOUR_MS),
                "" if runs == 1 else ", en {} tramos".format(runs)), quality
        window = [self.rates[i] for i in used]
        rate = self.rates[judged]
        below = sum(1 for x in window if x < rate)
        equal = sum(1 for x in window if x == rate)
        return (rate, 100.0 * (below + 0.5 * equal) / len(window)), "ok", "", quality

    def percentile(self, at_ms):
        """``(rate, percentile)`` of the newest period usable at ``at_ms``, or ``None`` (see ``assess`` for why)."""
        return self.assess(at_ms)[0]

    def level(self, at_ms):
        """``high`` / ``normal`` / ``low`` / ``None`` (unknown)."""
        found = self.percentile(at_ms)
        if found is None:
            return None
        return "high" if found[1] >= HIGH else "low" if found[1] <= LOW else "normal"

    def line(self, at_ms):
        found = self.percentile(at_ms)
        if found is None:
            return "funding: unknown"
        rate, pct = found
        payer = "longs pay" if rate > 0 else "shorts pay" if rate < 0 else "no payment"
        return sanitize_text("funding: {} (pctl30d={}, {})".format(self.level(at_ms), int(round(pct)), payer))


def funding_question(question):
    """The shipped ``trade_action`` as version 6: the same question with the ``funding`` line added (v4 untouched)."""
    fields = list(question["state_fields"])
    fields.insert(fields.index("lessons") if "lessons" in fields else len(fields), "funding")
    return dict(question, version=FUNDING_QUESTION_VERSION, state_fields=fields)


def funding_periods(context):
    """``[(start_ms, end_ms, relative_rate_per_hour)]`` from a ``FundingContext`` for the simulator's books (accounting).

    ``None`` (no history) gives ``[]``: the books then report ``funding_complete = false`` and an unknown funding.
    """
    return [] if context is None else [(s, s + HOUR_MS, r) for s, r in zip(context.starts, context.rates)]


def funding_known_periods(context):
    """``[(start_ms, end_ms, rate, known_at_ms)]``: the same periods with the moment the capture had them."""
    return [] if context is None else [(s, s + HOUR_MS, r, k) for s, r, k in zip(context.starts, context.rates, context.known)]


def funding_state(context, at_ms):
    """``{"usable", "code", "reason", "checked_ms"}``: why the product's funding is (not) usable now, for the forward summary."""
    if context is None:
        code, reason = "no_history", "sin historia de funding en la base de mercado"
    else:
        _, code, reason = context.assess_live(at_ms)
    return {"usable": code == "ok", "code": code, "reason": reason, "checked_ms": at_ms}


def funding_for(market_db_path, product_id, since_ms=None, recover_until_ms=None):
    """The product's ``FundingContext`` from the market DB, or ``None`` when it holds no funding history.

    ``since_ms``: skip periods starting earlier (callers pass their first decision time minus ``WINDOW_MS`` and a
    margin); the default reads everything stored. ``recover_until_ms``: see ``FundingContext``.
    """
    try:
        periods, info = load_periods_detailed(market_db_path, product_id, since_ms)
    except sqlite3.Error:
        return None
    return FundingContext(periods, approximate=info["approximate"], conflicts=info["conflicts"],
                          recover_until_ms=recover_until_ms) if periods else None
