"""Stage 10 (D-10C-4): adapter from Kraken Futures *definitive* funding rates to the runner's accrual events. Offline design.

It reads nothing and connects to nothing: it receives the text of a ``historical-funding-rates`` response, the instrument
and the arrival time of that response (all of which the caller took from somewhere it is allowed to read), and returns
the ``funding`` events ``PaperRunner.handle`` already accepts. It adds no accounting rule: the money still comes from
``portfolio_funding.ingest_funding`` / ``futures_simulator.accrue_funding``, which this module only feeds.

What it verifies, one check per name (each one a stable reason code, never free text):

* product: ``PF_<BASE>USD`` only, with the unit Kraken states for it (``USD/<BASE>/hour``; ``XBT`` is ``BTC``);
* units: the runner accrues ``relativeFundingRate`` (a fraction of notional per hour). Kraken also returns ``fundingRate``,
  an absolute rate in ``USD/<BASE>/hour``. The two are never mixed: only the relative one is emitted, and when a reference
  price is given ``absolute / relative`` must be close to it (``unit_mismatch`` otherwise), which is what a swap of the two
  would break;
* sign: a positive rate is paid by the long side and received by the short side (``futures_simulator.Book._funding``);
  nothing here flips a sign;
* period: one hour, starting on an hour boundary, in UTC, not after the server time of the response;
* publication: only a period that had ended ``settle_lag_ms`` before the server time is *definitive*. The one in progress,
  or one that just ended, is ``provisional`` and is not emitted. The event's time is the arrival time of the response,
  never earlier than the end of the period (the runner refuses a period that ends in the future);
* reconciliation: first seen stays in use. The same period and rate again is a ``duplicate``. Another rate for a period
  already known is ``revision_conflict``; two rates for one period inside a response are ``conflict_inside_response`` (none is
  accepted here). In both cases the contradicting period is also handed to the runner, whose ``ingest_funding`` quarantines it
  (``portfolio.funding_conflicts``) and flags the trades it overlaps: nothing is silently replaced, and the runner, not this
  module, decides what is disputed. A rate already in use is never swapped for the contradicting one.

``funding`` events carry accrual only. The funding that feeds C32's percentile (``LiveEvaluator.feed_funding``) is a
different channel; this module has no way to reach it, and its events cannot be mistaken for one (kind ``funding``,
stream ``funding:<product>``, source ``kraken-funding-definitive``).

All thresholds below are hypotheses to validate, not approved parameters.
"""

import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from .multi_signals import stable_hash
from .paper_runner import make_event

D = Decimal
HOUR_MS = 3_600_000
SOURCE = "kraken-funding-definitive"
MAX_BODY_BYTES = 2 * 1024 * 1024
DEFAULT_SETTLE_LAG_MS = 600_000          # hypothesis: the same 10 minutes the replay uses (FUNDING_LAG_MS)
DEFAULT_MAX_ABS_RELATIVE = D("0.01")     # hypothesis: 1 % of notional per hour is far outside anything seen; refuse, do not cap
DEFAULT_UNIT_TOLERANCE = D("0.05")       # hypothesis: absolute/relative within 5 % of the reference price
_PRODUCT = re.compile(r"^PF_([A-Z0-9]{2,20}?)USD$")


class FundingAdapterError(Exception):
    def __init__(self, reason, detail=""):
        Exception.__init__(self, reason + (": " + detail if detail else ""))
        self.reason = reason


def unit_for(product_id):
    """``USD/<BASE>/hour``, the unit Kraken states for the absolute rate of ``product_id``."""
    match = _PRODUCT.match(product_id) if isinstance(product_id, str) else None
    if not match:
        raise FundingAdapterError("unsupported_product", str(product_id))
    return "USD/{}/hour".format("BTC" if match.group(1) == "XBT" else match.group(1))


def _ms(timestamp):
    if not isinstance(timestamp, str) or not timestamp.endswith("Z"):
        raise ValueError("timestamp_not_utc")
    try:
        moment = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError:
        raise ValueError("timestamp_invalid")
    return int(moment.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, D)):
        raise ValueError("not_a_number")
    number = D(str(value))
    if not number.is_finite():
        raise ValueError("not_a_number")
    return number


def parse_response(raw, product_id, received_ms, *, settle_lag_ms=DEFAULT_SETTLE_LAG_MS,
                   max_abs_relative=DEFAULT_MAX_ABS_RELATIVE, reference_price=None, unit_tolerance=DEFAULT_UNIT_TOLERANCE,
                   strict=True, stored_product_id=None):
    """Checks one response. Returns ``{"sha256", "server_ms", "unit", "definitive", "provisional", "rejected", "conflicts"}``.

    ``definitive``: records ``{product_id, start_ms, end_ms, relative_rate, absolute_rate, unit, known_at_ms, sha256}`` (rates as
    exact decimal text) that may become accounting. ``provisional``, ``rejected`` and ``conflicts`` are evidence only, each with a
    reason code. A malformed response raises ``FundingAdapterError``. ``reference_price(start_ms)`` (optional) returns the price
    used for the unit cross-check, or ``None`` when there is none for that hour.

    ``strict`` is the default and is what real data requires; synthetic tests opt out with ``strict=False``. The product of the response is not written in its body, so the caller
    must pass the product the stored row declares (``stored_product_id``, from ``paper_futures_funding_periods`` for this response)
    and it must be ``product_id`` (``product_mismatch``); and every hour needs a reference price, since the absolute/relative
    check is what catches a mixed-up product or unit (``reference_price_required`` / ``reference_price_missing``)."""
    unit = unit_for(product_id)
    if strict:
        if reference_price is None:
            raise FundingAdapterError("reference_price_required")
        if stored_product_id != product_id:
            raise FundingAdapterError("product_mismatch", "{} != {}".format(stored_product_id, product_id))
    if not isinstance(received_ms, int) or isinstance(received_ms, bool) or received_ms < 0:
        raise FundingAdapterError("received_time_invalid")
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise FundingAdapterError("body_invalid_or_too_large")
    try:
        body = json.loads(raw, parse_float=D)        # exact decimals: a rate is never rounded through a binary float
    except ValueError:
        raise FundingAdapterError("json_invalid")
    if not isinstance(body, dict) or body.get("result") != "success" or not isinstance(body.get("rates"), list):
        raise FundingAdapterError("schema_invalid")
    try:
        server_ms = _ms(body.get("serverTime"))
    except ValueError as error:
        raise FundingAdapterError("server_time_invalid", str(error))
    sha = stable_hash(raw)
    out = {"sha256": sha, "server_ms": server_ms, "unit": unit, "definitive": [], "provisional": [], "rejected": [], "conflicts": []}
    by_start, provisional = {}, {}
    for index, item in enumerate(body["rates"]):
        def bad(reason, **extra):
            out["rejected"].append(dict({"index": index, "reason": reason}, **extra))
        if not isinstance(item, dict):
            bad("period_not_an_object")
            continue
        try:
            start = _ms(item.get("timestamp"))
        except ValueError as error:
            bad(str(error))
            continue
        if start % HOUR_MS:
            bad("period_not_hour_aligned", start_ms=start)
            continue
        if start > server_ms:
            bad("period_future_dated", start_ms=start)
            continue
        try:
            relative, absolute = _number(item.get("relativeFundingRate")), _number(item.get("fundingRate"))
        except ValueError:
            bad("rate_not_a_number", start_ms=start)
            continue
        if abs(relative) > max_abs_relative:
            bad("rate_out_of_bounds", start_ms=start)
            continue
        if reference_price is not None:
            price = reference_price(start)
            if price is None:
                if strict:
                    bad("reference_price_missing", start_ms=start)
                    continue
            elif relative == 0:
                if absolute != 0:                                        # no relative funding but money in the absolute rate
                    bad("unit_mismatch", start_ms=start, implied_price="n/a")
                    continue
            else:
                implied = absolute / relative
                if price <= 0 or abs(implied - D(str(price))) > D(str(price)) * unit_tolerance:
                    bad("unit_mismatch", start_ms=start, implied_price=str(implied.quantize(D("0.0001"))))
                    continue
        end = start + HOUR_MS
        reason = "not_settled_at_server_time" if end + settle_lag_ms > server_ms else \
            "not_settled_at_receipt" if end > received_ms else None
        if reason:                                      # decided before any conflict is looked for: provisional values never count
            if start not in provisional:
                provisional[start] = {"start_ms": start, "reason": reason}
            continue
        record = {"product_id": product_id, "start_ms": start, "end_ms": end, "relative_rate": _text(relative),
                  "absolute_rate": _text(absolute), "unit": unit, "known_at_ms": received_ms, "sha256": sha}
        prior = by_start.get(start)
        if prior is not None:
            if prior["relative_rate"] != record["relative_rate"] or prior["absolute_rate"] != record["absolute_rate"]:
                out["conflicts"].append({"start_ms": start, "reason": "conflict_inside_response",
                                         "rates": sorted({prior["relative_rate"], record["relative_rate"]}),
                                         "records": [prior, record]})
                by_start[start] = None
            continue
        by_start[start] = record
    out["definitive"] = [record for _, record in sorted(by_start.items()) if record is not None]
    out["provisional"] = [provisional[start] for start in sorted(provisional)]
    return out


def _text(number):
    text = format(number, "f")
    return text if text != "-0" else "0"


class FundingBook(object):
    """What the adapter has accepted so far: first seen wins, a different rate for the same period is quarantined.

    Deterministic, with no clock: ``add`` is called with each response in arrival order and returns the runner events to
    deliver (an event only for periods that are new). ``state``/``from_state`` make it durable as plain JSON."""

    def __init__(self):
        self.periods = {}            # (product, start_ms) -> {"relative_rate", "absolute_rate", "sha256", "known_at_ms"}
        self.quarantined = {}        # (product, start_ms) -> sorted list of rates in conflict
        self.counts = {"responses": 0, "accepted": 0, "duplicate": 0, "revision_conflict": 0, "conflict_inside_response": 0,
                       "rejected": 0, "provisional": 0}
        self.evidence = []           # rejected / provisional / conflict items, with the response they came from

    def add(self, parsed):
        """Returns the runner events to deliver. A contradiction is handed to the runner too: ``ingest_funding`` quarantines
        it there (``portfolio.funding_conflicts``) and flags the trades whose holding time it overlaps, which only the runner
        can do. The rate seen first is still the one in use; nothing here, or there, picks the other one."""
        self.counts["responses"] += 1
        fresh, contested = [], []
        for record in parsed["definitive"]:
            key = (record["product_id"], record["start_ms"])
            known = self.periods.get(key)
            if known is None and key not in self.quarantined:
                self.periods[key] = {k: record[k] for k in ("relative_rate", "absolute_rate", "sha256", "known_at_ms")}
                self.counts["accepted"] += 1
                fresh.append(record)
                continue
            rates = self.quarantined.get(key, [])
            if known is not None and known["relative_rate"] == record["relative_rate"]:
                self.counts["duplicate"] += 1
            elif record["relative_rate"] in rates:                   # a disputed rate seen again: already told to the runner
                self.counts["revision_conflict"] += 1
            else:
                self.quarantined[key] = sorted(set(rates) | {record["relative_rate"]} | ({known["relative_rate"]} if known else set()))
                self.counts["revision_conflict"] += 1
                self._note("revision_conflict", parsed, record["start_ms"], record["product_id"], rates=self.quarantined[key])
                contested.append(record)
        for item in parsed["conflicts"]:
            self.counts["conflict_inside_response"] += 1
            self._note("conflicts", parsed, item["start_ms"], item["records"][0]["product_id"],
                       **{k: v for k, v in item.items() if k not in ("start_ms", "records")})
            for record in item["records"]:
                self.quarantined[(record["product_id"], record["start_ms"])] = item["rates"]
            contested.extend(item["records"])
        for kind in ("rejected", "provisional"):
            for item in parsed[kind]:
                self.counts[kind] += 1
                self._note(kind, parsed, item.get("start_ms"), None, **{k: v for k, v in item.items() if k != "start_ms"})
        return self.events(fresh) + self.events(contested)

    def _note(self, kind, parsed, start_ms, product_id, **extra):
        self.evidence.append(dict({"kind": kind, "start_ms": start_ms, "product_id": product_id, "sha256": parsed["sha256"]}, **extra))

    @staticmethod
    def events(records):
        """One ``funding`` event per product per response, periods sorted; its time is the response's arrival time."""
        by_product = {}
        for record in records:
            by_product.setdefault(record["product_id"], []).append(record)
        events = []
        for product, items in sorted(by_product.items()):
            items.sort(key=lambda r: r["start_ms"])
            t_ms = max(max(r["known_at_ms"] for r in items), max(r["end_ms"] for r in items))
            payload = {"product_id": product, "periods": [[r["start_ms"], r["end_ms"], r["relative_rate"]] for r in items]}
            events.append(make_event("funding", payload, t_ms=t_ms, source=SOURCE, stream="funding:" + product))
        return events

    def state(self):
        return json.loads(json.dumps({
            "periods": [[p, s, v] for (p, s), v in sorted(self.periods.items())],
            "quarantined": [[p, s, v] for (p, s), v in sorted(self.quarantined.items())],
            "counts": self.counts, "evidence": self.evidence}))

    @classmethod
    def from_state(cls, state):
        book = cls()
        book.periods = {(p, s): dict(v) for p, s, v in state["periods"]}
        book.quarantined = {(p, s): list(v) for p, s, v in state["quarantined"]}
        book.counts, book.evidence = dict(state["counts"]), list(state["evidence"])
        return book


def compare_with_portfolio(book, portfolio_funding):
    """Differences between what the adapter accepted and what the runner's portfolio holds as known funding
    (``portfolio.funding[product] == [(start_ms, end_ms, Decimal rate)]``). Empty lists on every key mean they agree.

    ``missing``: accepted here, not in the portfolio. ``extra``: in the portfolio, never accepted here (another source).
    ``rate_differs``: same period, other rate."""
    mine = {(p, s): D(v["relative_rate"]) for (p, s), v in book.periods.items()}
    theirs = {(p, start): rate for p, items in portfolio_funding.items() for start, end, rate in items}
    return {"missing": sorted(k for k in mine if k not in theirs),
            "extra": sorted(k for k in theirs if k not in mine),
            "rate_differs": sorted(k for k in mine if k in theirs and mine[k] != theirs[k])}
