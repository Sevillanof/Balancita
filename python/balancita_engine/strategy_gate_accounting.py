"""Evidence labels for gate results; never settle a trade or change statistical populations."""

import math
from decimal import Decimal, InvalidOperation

from .futures_costs import COST_MODEL_VERSION

SCHEMA = "balancita.strategy-gate-accounting.v1"
METRIC_POPULATION = "all_observed_closed_trades"


def number(value):
    """JSON-safe finite numeric evidence, without coercing missing values or booleans to zero."""
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(Decimal(str(value)))
        return result if math.isfinite(result) else None
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        return None


def classify(trade, *, cost_model_version=None):
    """Copy Book's signed observed amounts. Only the current Book producer supplies cost identity.

    Gross already includes adverse fills: no execution, fee or funding is debited here.
    A funding status alone (legacy records) is not evidence of complete individual accounting.
    """
    usd, bp = number(trade.get("pnl_usd")), number(trade.get("net_bp"))
    amount, notional = number(trade.get("funding_usd")), number(trade.get("notional_usd"))
    held, covered = number(trade.get("funding_held_ms")), number(trade.get("funding_covered_ms"))
    duration_ok = (held is not None and covered is not None and 0 <= covered <= held
                   and held.is_integer() and covered.is_integer())
    status, flag = trade.get("funding_status"), trade.get("funding_complete")
    funding = "unclassified"
    if status in ("complete", "partial", "unknown") and isinstance(flag, bool):
        if not duration_ok or (status != "unknown" and amount is None):
            funding = "invalid"
        elif status == "complete" and flag and covered == held:
            funding = "complete"
        elif status == "partial" and not flag and 0 < covered < held:
            funding = "partial"
        elif status == "unknown" and not flag and amount is None and covered == 0:
            funding = "unknown"
        else:
            funding = "invalid"
    funding_bp = (number(amount / notional * 10_000) if amount is not None and notional is not None
                  and notional > 0 else None)
    if amount is not None and notional is not None and notional > 0 and funding_bp is None:
        funding = "invalid"
    costs = "unclassified"
    if cost_model_version == COST_MODEL_VERSION:
        prices = [number(trade.get(k)) for k in ("entry_price", "exit_price", "quantity", "notional_usd")]
        costs = "complete" if (all(v is not None and v > 0 for v in prices)
                               and trade.get("side") in ("LONG", "SHORT")) else "invalid"
    reasons = []
    if funding != "complete":
        reasons.append("funding_" + funding)
    if costs != "complete":
        reasons.append("cost_" + costs)
    if usd is None or bp is None:
        reasons.append("missing_or_invalid_observed_net")
    complete = not reasons
    state = ("complete" if complete else "unclassified" if "unclassified" in (funding, costs)
             else "provisional")
    return {"schema": SCHEMA, "state": state, "reasons": reasons,
            "observed_net_usd": usd, "observed_net_bp": bp,
            "definitive_net_usd": usd if complete else None, "definitive_net_bp": bp if complete else None,
            "funding_evidence": funding, "cost_evidence": costs, "cost_model_version": cost_model_version,
            "funding_bp": funding_bp,
            "funding_covered_ms": int(covered) if duration_ok else None,
            "funding_held_ms": int(held) if duration_ok else None,
            "funding_time_share": covered / held if duration_ok and held > 0
                                  and funding in ("complete", "partial") else None}


def _sum_known(rows, key):
    values = [number(row.get(key)) for row in rows]
    return number(sum(values)) if values and all(v is not None for v in values) else None


def summarize(trades, *, minimum_complete_share, open_at_end=0):
    """Keep the original status-count denominator/threshold separate from definitive-net evidence.

    Eligibility uses reported complete statuses, exactly as the original gate did; it is not a
    certification of amounts, costs or time coverage. Unknown time shares never become 0% or 100%.
    Totals cover closed trades only, with bp summed at fixed per-trade notional (not a portfolio return).
    """
    rows = [t.get("accounting") or classify(t) for t in trades]
    n = len(rows)
    complete = sum(r["state"] == "complete" for r in rows)
    funding_count = sum(t.get("funding_status") == "complete" for t in trades)
    share = funding_count / n if n else None
    time_known = bool(rows) and all(r["funding_time_share"] is not None for r in rows)
    held, covered = _sum_known(rows, "funding_held_ms"), _sum_known(rows, "funding_covered_ms")
    # Legacy compact inputs still participate in all original observed-bp statistics.
    observed_bp = _sum_known([{"net": t.get("net_bp")} for t in trades], "net")
    observed_usd = _sum_known(rows, "observed_net_usd")
    definitive = (bool(n) and complete == n and not open_at_end
                  and observed_bp is not None and observed_usd is not None)
    state = ("censored" if open_at_end else "no_trades" if not n else "complete" if definitive
             else "unclassified" if all(r["state"] == "unclassified" for r in rows) else "provisional")
    return {"schema": SCHEMA, "state": state, "scope": "closed_trades_only",
            "metric_population": METRIC_POPULATION, "closed_trades": n, "open_at_end": open_at_end,
            "definitive_trades": complete, "provisional_trades": n - complete,
            "observed_net_usd": observed_usd, "observed_net_bp": observed_bp,
            "definitive_net_usd": observed_usd if definitive else None,
            "definitive_net_bp": observed_bp if definitive else None,
            "funding_complete_count": funding_count, "funding_complete_share": share,
            "minimum_complete_share": minimum_complete_share,
            "funding_eligible": share >= minimum_complete_share - 1e-9 if share is not None else None,
            "funding_evidence_complete_count": sum(r["funding_evidence"] == "complete" for r in rows),
            "cost_evidence_complete_count": sum(r["cost_evidence"] == "complete" for r in rows),
            "funding_time_known_trades": sum(r["funding_time_share"] is not None for r in rows),
            "funding_covered_ms": covered, "funding_held_ms": held,
            "funding_time_share": covered / held if time_known and held else None}


_SAVED_COUNTS = ("closed_trades", "open_at_end", "definitive_trades", "provisional_trades",
                 "funding_complete_count", "funding_evidence_complete_count",
                 "cost_evidence_complete_count", "funding_time_known_trades")
_SAVED_AMOUNTS = ("observed_net_usd", "observed_net_bp", "definitive_net_usd", "definitive_net_bp")
_SAVED_SHARES = ("funding_complete_share", "minimum_complete_share", "funding_time_share")
_SAVED_DURATIONS = ("funding_covered_ms", "funding_held_ms")


def _json_number(value):
    # Unlike Book input parsing, saved v1 metadata requires JSON numbers, not numeric strings or booleans.
    return type(value) in (int, float) and number(value) is not None


def _valid_saved_summary(value):
    """Validate recorded claims only; do not infer evidence from today's configuration or costs."""
    if (not isinstance(value, dict) or value.get("schema") != SCHEMA
            or value.get("scope") != "closed_trades_only"
            or value.get("metric_population") != METRIC_POPULATION
            or value.get("state") not in ("complete", "provisional", "unclassified", "no_trades", "censored")
            or not all(k in value for k in _SAVED_COUNTS + _SAVED_AMOUNTS + _SAVED_SHARES
                       + _SAVED_DURATIONS + ("funding_eligible",))):
        return False
    if any(type(value[k]) is not int or value[k] < 0 for k in _SAVED_COUNTS):
        return False
    if any(value[k] is not None and not _json_number(value[k])
           for k in _SAVED_AMOUNTS + _SAVED_SHARES + _SAVED_DURATIONS):
        return False
    if value["minimum_complete_share"] is None:
        return False
    if any(value[k] is not None and not 0 <= value[k] <= 1 for k in _SAVED_SHARES):
        return False
    if any(value[k] is not None and value[k] < 0 for k in _SAVED_DURATIONS):
        return False
    n, definitive, state = value["closed_trades"], value["definitive_trades"], value["state"]
    if (any(value[k] > n for k in _SAVED_COUNTS if k not in ("closed_trades", "open_at_end"))
            or definitive + value["provisional_trades"] != n
            or definitive > min(value["funding_evidence_complete_count"], value["cost_evidence_complete_count"])):
        return False
    share, eligible = value["funding_complete_share"], value["funding_eligible"]
    if n:
        if (share is None or not math.isclose(share, value["funding_complete_count"] / n,
                                                   rel_tol=1e-12, abs_tol=1e-12)
                or type(eligible) is not bool
                or eligible != (share >= value["minimum_complete_share"] - 1e-9)):
            return False
    elif share is not None or eligible is not None:
        return False
    covered, held, time_share = (value[k] for k in _SAVED_DURATIONS + ("funding_time_share",))
    if covered is not None and held is not None and covered > held:
        return False
    time_known = n > 0 and value["funding_time_known_trades"] == n
    if time_known:
        if (covered is None or held is None or held <= 0 or time_share is None
                or not math.isclose(time_share, covered / held, rel_tol=1e-12, abs_tol=1e-12)):
            return False
    elif time_share is not None:
        return False
    if (n and value["funding_evidence_complete_count"] == n
            and covered is not None and held is not None and covered != held):
        return False
    if (value["open_at_end"] > 0) != (state == "censored"):
        return False
    if not n:
        return (state in ("no_trades", "censored")
                and all(value[k] is None for k in _SAVED_AMOUNTS + _SAVED_DURATIONS))
    if state == "no_trades":
        return False
    observed = (value["observed_net_usd"], value["observed_net_bp"])
    totals = (value["definitive_net_usd"], value["definitive_net_bp"])
    if state == "complete":
        return (all(v is not None for v in observed) and observed == totals and definitive == n
                and value["funding_complete_count"] == n
                and value["funding_evidence_complete_count"] == n
                and value["cost_evidence_complete_count"] == n)
    if any(v is not None for v in totals) or (state == "unclassified" and definitive != 0):
        return False
    # All individually complete rows can still have an unknown total after numeric overflow.
    return not (state == "provisional" and definitive == n and all(v is not None for v in observed))


def stored(value):
    """Read saved summary metadata only; never retro-certify legacy artifacts from current settings."""
    if _valid_saved_summary(value):
        return value
    return {"schema": SCHEMA, "state": "unclassified", "reasons": ["missing_or_invalid_accounting"],
            "scope": "closed_trades_only", "metric_population": None,
            "observed_net_usd": None, "observed_net_bp": None,
            "definitive_net_usd": None, "definitive_net_bp": None,
            "funding_complete_share": None, "funding_time_share": None, "funding_eligible": None}
