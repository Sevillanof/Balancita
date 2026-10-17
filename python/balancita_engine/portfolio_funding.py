"""Late funding for the shared paper portfolio: verified intake and reconciliation (offline, isolated).

A trade that closed while the funding history did not cover its holding time is *provisional*: ``Portfolio`` counts
its losses and leaves its gains out of the definitive capital (``net_complete = False``). This module lets it become
definitive, or at least better known, when valid funding arrives later. It adds no second engine: the funding of a
trade is ``futures_simulator.accrue_funding`` over the accepted periods, its result is the gross minus fees minus that
funding exactly as ``Book`` computes it, and every change goes through ``Portfolio`` bookkeeping.

``ingest_funding(portfolio, product, periods, received_ms)`` decides, period by period, what may be used:

* ``accepted``: well formed, already settled at ``received_ms`` (a period that ends in the future is a forecast, not a
  fact), and not in conflict with what is known;
* ``duplicate``: exactly the same period and rate as one already accepted. Receiving funding twice changes nothing;
* ``conflict``: it overlaps an accepted period with another rate or other bounds. It is **quarantined, never applied**
  (nothing here can tell which version is right), the affected trades are flagged for review and the first accepted
  data keeps being the one used. A contradiction is never resolved silently;
* ``rejected``: malformed or not settled yet.

``reconcile_funding(portfolio, now_ms)`` recomputes, for every closed trade whose funding is incomplete, the funding the
accepted periods now cover. It acts only when the covered time grew (so repeating it is a no-op) and never from a
partial recount of what was already counted: the funding of a trade is always *recomputed from the periods*, never
accumulated, so it cannot be applied twice. Each change is an append-only ``adjustments`` entry with the state before
and after, the capital, risk budget and drawdown around it, and the hash of the periods used. The trade keeps its
original closing in ``trade_details[...]["as_closed"]``; decisions already taken (positions opened, intents rejected)
are not revised, only listed.

``revise_funding(portfolio, product, revisions, received_ms=...)`` is the other way a rate can change (BAL-DECISION-184-03): the
source published another rate for a period that is already in use. The rate seen last is the one used from then on, and nothing
is overwritten without a trace: the funding log gets a ``period_revised`` entry that names the rate it replaces and the log
entry (sequence and hash) that had accepted it, and every closed trade that overlapped the period is *recomputed from the
periods* by ``reconcile_funding`` and receives an append-only ``funding_revision`` adjustment with its state before and after,
the change in capital and the periods used. Repeating a revision, or reconciling twice, changes nothing: the rate in use is
already the new one, and the recount of a trade equals what it stores. A revision that does not start from the rate in use
(``revision_base_mismatch``) or refers to a period never accepted is not applied: the portfolio and its source then disagree,
which the session reports and stops on.

Provisional rule kept: a gain of an incomplete trade never raises the definitive capital; a loss always lowers it.
Time is an argument everywhere; no wall clock, no network, no randomness.
"""

import hashlib
import json
from decimal import Decimal, InvalidOperation

from .futures_costs import fee_rate, is_measured
from .futures_hits import trade_hit
from .futures_simulator import accrue_funding
from .multi_signals import stable_hash

D = Decimal
HOUR_MS = 3_600_000
ZERO_HASH = "0" * 64


def _parse_period(period):
    try:
        start, end, rate = int(period[0]), int(period[1]), D(str(period[2]))
    except (TypeError, ValueError, IndexError, InvalidOperation):
        raise ValueError("invalid_period")
    if end <= start or not rate.is_finite():
        raise ValueError("invalid_period")
    return start, end, rate


def _log(portfolio, kind, t_ms, **data):
    log = portfolio.funding_log
    body = {"seq": len(log) + 1, "kind": kind, "t_ms": int(t_ms), "prev": log[-1]["hash"] if log else ZERO_HASH, **data}
    body["hash"] = stable_hash(body)
    log.append(body)
    return body


def ingest_funding(portfolio, product_id, periods, *, received_ms, source="feed"):
    """Takes funding periods ``(start_ms, end_ms, relative_rate_per_hour)`` into the portfolio's known funding.

    Returns the count per outcome. Open positions receive the accepted periods too (data known before their close).
    The outcome of a period never depends on the order of the batch: contradictory versions inside one batch, or
    against anything accepted or already quarantined, are all quarantined and none is used."""
    known = portfolio.funding.setdefault(product_id, [])
    quarantined = [tuple(c[:2]) + (D(c[2]),) for c in portfolio.funding_conflicts.get(product_id, ())]
    counts = {"accepted": 0, "duplicate": 0, "conflict": 0, "rejected": 0}
    parsed, seen = [], set()
    for raw in sorted(periods, key=lambda p: tuple(str(x) for x in p)):
        try:
            start, end, rate = _parse_period(raw)
        except ValueError:
            counts["rejected"] += 1
            _log(portfolio, "period_rejected", received_ms, product_id=product_id, reason="invalid_period",
                 period=stable_hash(list(map(str, raw)))[:16], source=source)
            continue
        label = [start, end, str(rate)]
        if end > received_ms:
            counts["rejected"] += 1
            _log(portfolio, "period_rejected", received_ms, product_id=product_id, reason="not_settled",
                 period=label, source=source)
            continue
        if (start, end, rate) in seen:        # the same period twice in one delivery
            counts["duplicate"] += 1
            _log(portfolio, "period_duplicate", received_ms, product_id=product_id, period=label, source=source)
            continue
        seen.add((start, end, rate))
        parsed.append((start, end, rate))
    for start, end, rate in parsed:
        label = [start, end, str(rate)]
        overlapping = [p for p in known if min(end, p[1]) > max(start, p[0])]
        if any(p == (start, end, rate) for p in overlapping):
            counts["duplicate"] += 1
            _log(portfolio, "period_duplicate", received_ms, product_id=product_id, period=label, source=source)
            continue
        against = overlapping + [q for q in quarantined if min(end, q[1]) > max(start, q[0])] \
            + [o for o in parsed if o != (start, end, rate) and min(end, o[1]) > max(start, o[0])]
        if against:
            counts["conflict"] += 1
            if label not in portfolio.funding_conflicts.setdefault(product_id, []):
                portfolio.funding_conflicts[product_id].append(label)
            _log(portfolio, "period_conflict", received_ms, product_id=product_id, period=label, source=source,
                 against=sorted([a, b, str(r)] for a, b, r in against))
            for trade in portfolio.trades:
                if trade["product_id"] == product_id and min(end, trade["exit_time_ms"]) > max(start, trade["entry_time_ms"]):
                    portfolio.dispute_funding(trade, [label], received_ms)
            # An open position is not a trade yet: it picks the dispute up when it closes (Portfolio._store_trade
            # compares its holding time with the quarantined periods), so the warning is never lost.
            continue
        known.append((start, end, rate))
        known.sort()
        for book in portfolio.positions.values():
            if book.product == product_id:
                book.funding = sorted(book.funding + [(start, end, rate)])
        counts["accepted"] += 1
        _log(portfolio, "period_accepted", received_ms, product_id=product_id, period=label, source=source)
    return counts


def _find_logged(portfolio, product_id, start):
    """The latest log entry that put a rate in use for the period starting at ``start``, or ``None``."""
    for entry in reversed(portfolio.funding_log):
        if entry["kind"] in ("period_accepted", "period_revised") and entry.get("product_id") == product_id \
                and entry["period"][0] == start:
            return entry
    return None


def revise_funding(portfolio, product_id, revisions, *, received_ms, source="feed"):
    """Another rate for periods already in use: ``revisions`` is ``(start_ms, end_ms, previous_rate, new_rate)``.

    The new rate replaces the one in use (also in the positions still open: they have not paid it yet) and the replaced rate
    stays in the funding log, linked to the entry that had accepted it. Returns the count per outcome. The trades that were
    already closed are not touched here: ``reconcile_funding`` recomputes them from the periods and records the adjustment."""
    known = portfolio.funding.setdefault(product_id, [])
    counts = {"revised": 0, "duplicate": 0, "rejected": 0}
    for raw in sorted(revisions, key=lambda r: tuple(str(x) for x in r)):
        try:
            start, end, old = _parse_period(raw[:3])
            new = D(str(raw[3]))
            if not new.is_finite():
                raise ValueError("invalid_period")
        except (ValueError, IndexError, TypeError, InvalidOperation):
            counts["rejected"] += 1
            _log(portfolio, "revision_rejected", received_ms, product_id=product_id, reason="invalid_revision",
                 period=stable_hash(list(map(str, raw)))[:16], source=source)
            continue
        label = [start, end, str(new)]
        if end > received_ms:
            counts["rejected"] += 1
            _log(portfolio, "revision_rejected", received_ms, product_id=product_id, reason="not_settled",
                 period=label, source=source)
            continue
        current = [p for p in known if (p[0], p[1]) == (start, end)]
        if not current:
            counts["rejected"] += 1
            _log(portfolio, "revision_rejected", received_ms, product_id=product_id, reason="revision_of_unknown_period",
                 period=label, source=source)
            continue
        in_use = current[0]
        if in_use[2] == new:
            counts["duplicate"] += 1
            _log(portfolio, "period_duplicate", received_ms, product_id=product_id, period=label, source=source)
            continue
        if in_use[2] != old:
            counts["rejected"] += 1
            _log(portfolio, "revision_rejected", received_ms, product_id=product_id, reason="revision_base_mismatch",
                 period=label, previous=[start, end, str(old)], in_use=[start, end, str(in_use[2])], source=source)
            continue
        prior = _find_logged(portfolio, product_id, start)
        known.remove(in_use)
        known.append((start, end, new))
        known.sort()
        for book in portfolio.positions.values():
            if book.product == product_id:
                book.funding = sorted([p for p in book.funding if (p[0], p[1]) != (start, end)] + [(start, end, new)])
        portfolio.funding_revised.setdefault(product_id, []).append((start, end))
        counts["revised"] += 1
        _log(portfolio, "period_revised", received_ms, product_id=product_id, period=label, previous=[start, end, str(old)],
             supersedes={"seq": prior["seq"], "hash": prior["hash"]} if prior else None, source=source)
    return counts


def _recount(trade, periods):
    """Funding, completeness and pnl of a closed trade from the accepted periods (nothing taken from its stored pnl)."""
    start, end = int(trade["entry_time_ms"]), int(trade["exit_time_ms"])
    entry, exit_, quantity = D(trade["entry_price"]), D(trade["exit_price"]), D(trade["quantity"])
    long = trade["side"] == "LONG"
    total, covered = accrue_funding(periods, start, end, entry * quantity)
    covered = min(covered, end - start)
    funding = total if long else -total
    gross = (exit_ - entry) * quantity if long else (entry - exit_) * quantity
    fees = (entry + exit_) * quantity * fee_rate("taker")
    complete = bool(periods) and covered >= end - start
    status = "complete" if complete else ("partial" if covered > 0 else "unknown")
    used = sorted((a, b, str(r)) for a, b, r in periods if min(end, b) > max(start, a))
    return {"funding": funding, "covered": covered, "complete": complete, "status": status, "pnl": gross - fees - funding,
            "periods_sha256": hashlib.sha256(json.dumps(used).encode()).hexdigest(), "held": end - start}


def _adjust(portfolio, trade, new, now_ms, *, kind, transition, extra=None):
    """Applies a recount to a closed trade and appends the adjustment (state before and after, capital, risk budget and
    drawdown around it, hash of the periods used). Shared by the two reasons a trade is recomputed: funding that covers more
    of its holding time, and a rate that was revised."""
    product = trade["product_id"]
    before = {k: trade[k] for k in portfolio.CLOSED_FIELDS}
    risk_before, dd_before = portfolio.risk_budget_usd(), portfolio.drawdown_usd()
    contribution_before = portfolio.contribution(trade)
    pnl = new["pnl"]
    measured = is_measured(product)
    net_complete = new["complete"] and measured
    trade.update(pnl_usd=float(round(pnl, 4)), net_bp=float(round(pnl / D(trade["notional_usd"]) * 10_000, 4)),
                 hit=trade_hit(pnl), funding_usd=float(round(new["funding"], 6)), funding_complete=new["complete"],
                 funding_status=new["status"], funding_covered_ms=int(new["covered"]), net_complete=net_complete,
                 net_usd=float(round(pnl, 4)) if net_complete else None, partial_usd=float(round(pnl, 4)))
    delta = portfolio.contribution(trade) - contribution_before
    after = {k: trade[k] for k in portfolio.CLOSED_FIELDS}
    entry = portfolio.append_capital_event("funding_reconciled", now_ms, trade["trade_id"], delta)
    later = [d["decision_id"] for d in portfolio.decisions
             if d["status"] == "opened" and d["decided_ms"] >= trade["exit_time_ms"] and d["decided_ms"] <= now_ms]
    record = {
        "seq": len(portfolio.adjustments) + 1, "trade_id": trade["trade_id"], "product_id": product,
        "at_ms": int(now_ms), "kind": kind,
        "transition": transition or ("provisional_to_definitive" if net_complete else
                                      "provisional_more_covered" if not before["funding_complete"] else "funding_complete_product_unmeasured"),
        "coverage": {"covered_ms": int(new["covered"]), "held_ms": int(new["held"]), "status": new["status"],
                     "previous_covered_ms": int(before["funding_covered_ms"])},
        "before": before, "after": after, "delta_pnl_usd": str(D(str(after["pnl_usd"])) - D(str(before["pnl_usd"]))),
        "delta_capital_usd": str(delta), "capital_before_usd": entry["capital_before_usd"],
        "capital_after_usd": entry["capital_after_usd"], "risk_budget_before_usd": str(risk_before),
        "risk_budget_after_usd": str(portfolio.risk_budget_usd()), "drawdown_before_usd": str(dd_before),
        "drawdown_after_usd": str(portfolio.drawdown_usd()), "periods_sha256": new["periods_sha256"],
        "decisions_not_revised": later,
        "prev": portfolio.adjustments[-1]["hash"] if portfolio.adjustments else ZERO_HASH}
    record.update(extra or {})
    record["hash"] = stable_hash(record)
    portfolio.adjustments.append(record)
    return record


def reconcile_funding(portfolio, now_ms):
    """Adjusts every closed trade whose funding became better known. Returns the adjustments made (empty when none).

    Idempotent. Allowed in any state of the account, a suspension included."""
    made = []
    for trade in portfolio.trades:
        if trade["funding_complete"]:
            continue
        product = trade["product_id"]
        periods = portfolio.funding.get(product, ())
        new = _recount(trade, periods)
        if new["covered"] <= int(trade["funding_covered_ms"]):
            continue                       # nothing new for this trade: never regress, never recount what is known
        if int(trade["exit_time_ms"]) > now_ms:
            continue
        before = {k: trade[k] for k in portfolio.CLOSED_FIELDS}
        stored_gross_fees = D(str(trade["pnl_usd"])) + D(str(trade["funding_usd"] or 0))
        if abs(stored_gross_fees - (new["pnl"] + new["funding"])) > D("0.0006"):
            flags = portfolio.review_flags.setdefault(trade["trade_id"], [])
            if "closed_pnl_inconsistent" not in flags:
                flags.append("closed_pnl_inconsistent")
            continue                       # the stored closing does not rebuild: do not build a correction on it
        made.append(_adjust(portfolio, trade, new, now_ms, kind="funding_reconciliation", transition=None))
    # A rate that was revised changes the funding of the trades that overlapped it even when their coverage did not grow.
    # The recount is from the periods in use, so a trade that already carries that funding is left alone (idempotent).
    for trade in portfolio.trades:
        product = trade["product_id"]
        revised = [list(p) for p in portfolio.funding_revised.get(product, ())
                   if min(int(trade["exit_time_ms"]), p[1]) > max(int(trade["entry_time_ms"]), p[0])]
        if not revised or int(trade["exit_time_ms"]) > now_ms:
            continue
        new = _recount(trade, portfolio.funding.get(product, ()))
        if new["covered"] < int(trade["funding_covered_ms"]):
            continue                       # never regress the coverage: the periods in use cannot cover less than they did
        if trade["funding_usd"] is not None and float(round(new["funding"], 6)) == trade["funding_usd"] \
                and new["covered"] == int(trade["funding_covered_ms"]):
            continue                       # already carries the funding of the periods in use
        stored_gross_fees = D(str(trade["pnl_usd"])) + D(str(trade["funding_usd"] or 0))
        if abs(stored_gross_fees - (new["pnl"] + new["funding"])) > D("0.0006"):
            flags = portfolio.review_flags.setdefault(trade["trade_id"], [])
            if "closed_pnl_inconsistent" not in flags:
                flags.append("closed_pnl_inconsistent")
            continue
        made.append(_adjust(portfolio, trade, new, now_ms, kind="funding_revision", transition="funding_rate_revised",
                            extra={"revised_periods": sorted(revised)}))
    return made
