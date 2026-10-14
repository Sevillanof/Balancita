"""Stage 10B contract helpers: the ``positions`` (B5) and ``intervals`` (B3) blocks of the published session report.

Pure read functions over a ``PaperRunner``: they reuse ``paper_runner_report`` (``protection``, ``decisions``,
``integrated_audit``) and compute nothing financial of their own. They write no file, open no connection and do not touch
the frontend; the gateway side is a later stage (docs/etapa-10b-ingestor-offline.md, section 5).

Every row carries ``execution_class``: ``observed_quotes`` here (the runner executed against quotes the capture stored),
never ``MODELLED_EXECUTION`` (stage 9A's replay). The session is an integration session: ``mode = integration`` and
``evidence_class = not_forward_evidence`` on every block.
"""

from .paper_runner import PROCESSING
from .paper_runner_report import decisions, integrated_audit, protection

SESSION_MODE = "integration"
EVIDENCE_CLASS = "not_forward_evidence"
EXECUTION_CLASS = "observed_quotes"
POSITIONS_SCHEMA = "balancita-paper-session-positions.v1"
INTERVALS_SCHEMA = "balancita-paper-session-intervals.v1"


def _tag(extra):
    return dict(extra, mode=SESSION_MODE, evidence_class=EVIDENCE_CLASS, execution_class=EXECUTION_CLASS)


def verification(runner, report_age_ms, max_age_ms):
    """Is it fair to call the positions "verified"? Only when the journal chain holds, the integrated audit has no
    violation, no obligation is open, the runner is processing and the report is fresh. Returns
    ``{"verified": bool, "reasons": [...]}``; a reason is a stable code."""
    reasons = []
    if runner.status != PROCESSING:
        reasons.append("runner_not_processing")
    if report_age_ms is None or report_age_ms > max_age_ms:
        reasons.append("report_stale")
    if runner.open_cycles or runner.open_funding:
        reasons.append("open_obligations")
    if integrated_audit(runner)["violations"]:
        reasons.append("audit_violations")
    return {"verified": not reasons, "reasons": reasons}


def positions(runner, report_age_ms, max_age_ms):
    """B5: the open paper positions of the session. Each one says how well its stop was watched; none is ever called
    "open at Kraken": they are positions of the simulator over observed quotes. P&L is ``estimated``."""
    check = verification(runner, report_age_ms, max_age_ms)
    watch = {row["intent_id"]: row for row in protection(runner)}
    rows = []
    for product, book in sorted(runner.portfolio.positions.items()):
        intent, pos = book.intent, book.position
        cover = watch.get(intent["intent_id"], {})
        rows.append({
            "intent_id": intent["intent_id"], "product_id": product, "side": pos["side"],
            "strategy_id": intent["strategy_id"], "strategy_version": intent["strategy_version"],
            "entry_ms": int(pos["entry_ms"]), "entry_price": str(pos["entry"]), "stop": str(pos["stop"]),
            "target": str(pos["target"]), "quantity": str(pos["quantity"]),
            "stop_protection": cover.get("stop_protection"),
            "coverage": {"quotes_watched": cover.get("quotes_watched"), "last_watched_ms": cover.get("last_watched_ms"),
                         "last_quote_ms": cover.get("last_quote_ms"), "silent_now_ms": cover.get("silent_now_ms"),
                         "gaps": cover.get("gaps", [])},
            "verified": check["verified"] and cover.get("stop_protection") != "unobserved",
            "classes": {"position": "simulated", "price": "observed", "pnl": "estimated"}})
    return _tag({"schema": POSITIONS_SCHEMA, "clock_ms": runner.clock, "verification": check,
                 "unrealized_usd": str(runner.portfolio.unrealized_usd()), "unrealized_class": "estimated",
                 "positions": rows})


def intervals(runner, from_ms=None, to_ms=None, product=None):
    """B3: signal -> decision -> order -> trade per (product, bucket), from the runner's own decision rows. A stage that
    does not exist is ``none``, never inferred. Qwen decisions and C verdicts come from their own databases (B3 original)."""
    rows = []
    for row in decisions(runner):
        bucket = (row.get("decided_ms") or 0)
        if product is not None and row["product_id"] != product:
            continue
        if from_ms is not None and bucket < from_ms:
            continue
        if to_ms is not None and bucket >= to_ms:
            continue
        rows.append({
            "key": row.get("signal_key"), "product_id": row["product_id"], "strategy_id": row["strategy_id"],
            "decided_ms": row.get("decided_ms"), "side": row["side"],
            "stages": {
                "decision": {"state": "ok", "decided_ms": row.get("decided_ms")},
                "order": {"state": row["state"], "reasons": row["reasons"], "entry_ms": row.get("entry_ms")},
                "trade": {"state": row["result"] if row["result"] in ("closed", "open") else "none",
                          "trade_id": row.get("trade_id"), "exit_reason": row.get("exit_reason")}}})
    return _tag({"schema": INTERVALS_SCHEMA, "clock_ms": runner.clock, "from_ms": from_ms, "to_ms": to_ms,
                 "product": product, "intervals": rows})
