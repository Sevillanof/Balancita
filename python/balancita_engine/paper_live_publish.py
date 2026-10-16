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
# ``verified`` needs evidence that the stop was watched after the entry: ``not_yet_observed`` and ``unobserved`` are not.
PROTECTED = ("observed", "observed_by_candles")
# Stages of the B3 chain this module can fill from the runner. ``signal`` is not among them: the runner keeps the
# ``signal_key`` of a decision but not the strategy output that produced it (that lives in the evaluator, stage 9A).
INTERVAL_STAGES_PRESENT = ("decision", "order", "trade")
INTERVAL_STAGES_MISSING = ("signal",)


def _tag(extra):
    return dict(extra, mode=SESSION_MODE, evidence_class=EVIDENCE_CLASS, execution_class=EXECUTION_CLASS)


def verification(runner, report_age_ms, max_age_ms=None, source_state=None, threshold_approved=False):
    """Is it fair to call the positions "verified"? Only when the journal chain holds, the integrated audit has no
    violation, no obligation is open, the runner is processing, the report is fresh AND the data is fresh: the report's
    age says when the report was written, not whether the capture was still delivering, so the ingestor's own
    ``state()`` is required (``source == "live"``). Without it the answer is "not verified" (``source_state_unknown``).
    Returns ``{"verified": bool, "reasons": [...], "freshness": ..., "thresholds": ...}``; a reason is a stable code.

    The age limit is the caller's and has NO default here (decision BAL-DECISION-187-01, P2). No limit is approved yet, so
    ``threshold_approved`` is false for every real caller and the block says so (``thresholds.status``: ``not_approved``
    without a limit, ``hypothesis`` with an unapproved one, ``approved`` only when the caller says it is). A limit that is
    not approved can degrade (older than it = ``stale``) but never promote: the report is then ``unknown``, never ``fresh``,
    and ``verified`` is false (``freshness_threshold_not_approved``). A missing report age is ``report_age_unknown``. The
    gateway only degrades this, it never promotes it."""
    reasons = []
    if source_state is None:
        reasons.append("source_state_unknown")
    elif source_state.get("source") != "live":
        reasons.append("source_stale")
    if runner.status != PROCESSING:
        reasons.append("runner_not_processing")
    approved = threshold_approved and max_age_ms is not None
    if report_age_ms is None:
        reasons.append("report_age_unknown")
        freshness = "unknown"
    elif max_age_ms is not None and report_age_ms > max_age_ms:
        reasons.append("report_stale")
        freshness = "stale"
    else:
        freshness = "fresh" if approved else "unknown"
    if not approved:
        reasons.append("freshness_threshold_not_approved")
    if runner.open_cycles or runner.open_funding:
        reasons.append("open_obligations")
    if integrated_audit(runner)["violations"]:
        reasons.append("audit_violations")
    status = "not_approved" if max_age_ms is None else ("approved" if approved else "hypothesis")
    return {"verified": not reasons, "reasons": reasons, "freshness": freshness,
            "thresholds": {"report_max_age_ms": max_age_ms, "status": status}}


def positions(runner, report_age_ms, max_age_ms=None, source_state=None, threshold_approved=False):
    """B5: the open paper positions of the session. Each one says how well its stop was watched; none is ever called
    "open at Kraken": they are positions of the simulator over observed quotes. P&L is ``estimated``.

    ``accounting_verified`` is the session-level check (journal chain, audit, fresh report); ``protection_evidence`` is
    the stop's own evidence; ``verified`` needs both: a stop nobody has watched since the entry is never "verified"."""
    check = verification(runner, report_age_ms, max_age_ms, source_state, threshold_approved)
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
            "accounting_verified": check["verified"],
            "protection_evidence": cover.get("stop_protection"),
            "verified": check["verified"] and cover.get("stop_protection") in PROTECTED,
            "classes": {"position": "simulated", "price": "observed", "pnl": "estimated"}})
    return _tag({"schema": POSITIONS_SCHEMA, "clock_ms": runner.clock, "verification": check,
                 "unrealized_usd": str(runner.portfolio.unrealized_usd()), "unrealized_class": "estimated",
                 "positions": rows})


def intervals(runner, from_ms=None, to_ms=None, product=None):
    """B3, partial: decision -> order -> trade per (product, bucket), from the runner's own decision rows. The ``signal``
    stage is NOT filled by this module (``contract.complete`` is false and says which stage is missing); a stage that
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
                "signal": {"state": "not_available", "signal_key": row.get("signal_key")},
                "decision": {"state": "recorded" if row.get("decided_ms") is not None else "none", "decided_ms": row.get("decided_ms")},
                "order": {"state": row["state"], "reasons": row["reasons"], "entry_ms": row.get("entry_ms")},
                "trade": {"state": row["result"] if row["result"] in ("closed", "open") else "none",
                          "trade_id": row.get("trade_id"), "exit_reason": row.get("exit_reason")}}})
    return _tag({"schema": INTERVALS_SCHEMA, "clock_ms": runner.clock, "from_ms": from_ms, "to_ms": to_ms,
                 "product": product, "contract": {"complete": False, "stages_present": list(INTERVAL_STAGES_PRESENT),
                                                  "stages_missing": list(INTERVAL_STAGES_MISSING)},
                 "intervals": rows})


# ---- the operating block (Issue #187, contract BAL-CONTRATO-187-01): what the process says about itself ----------------------
STATUS_SCHEMA = "balancita-paper-session-status.v1"
HEARTBEAT_SCHEMA = "balancita-paper-live-heartbeat.v1"        # kept equal to paper_live_process.HEARTBEAT_SCHEMA by a test
# The phases the process writes -> the names the gateway shows. Anything else is not guessed: the block says why it cannot tell.
PUBLISHED_PHASE = {"INIT": "INIT", "WARMUP": "WARMING_UP", "LIVE": "LIVE", "STOPPING": "STOPPING", "STOPPED": "STOPPED",
                   "HALTED": "HALTED", "REFUSED": "REFUSED"}
FINAL_PHASES = ("STOPPED", "HALTED", "REFUSED")


def _status_tag(extra):
    return dict(extra, mode=SESSION_MODE, evidence_class=EVIDENCE_CLASS)          # no ``execution_class``: this block holds no trade


def _status_unavailable(reason):
    return _status_tag({"schema": STATUS_SCHEMA, "phase": "unavailable", "liveness": "unknown", "reasons": [reason],
                 "halt_reason": None, "orderly_stop": None, "resources": None, "clock": None})


def _report_is_newer(report, beat):
    """A ``report.json`` outlives an operator restart (nothing rewrites it until the new run ends), so it only outranks the heartbeat when
    it is of the same session and configuration AND was written strictly after the heartbeat's observation time (D-223-01; a tie goes to the heartbeat: the first heartbeat of a restarted run carries the
    same observation time as the halt that preceded it, and the process writes its report at a later step than its last heartbeat). With no
    heartbeat there is nothing to compare: the report is all there is."""
    if not beat:
        return True
    ended, seen = report.get("ended_at_observed_ms"), beat.get("observed_now_ms")
    if (report.get("session_id"), report.get("config_digest")) != (beat.get("session_id"), beat.get("config_digest")):
        return False
    return isinstance(ended, int) and isinstance(seen, int) and ended > seen


def session_status(heartbeat, halt=None, report=None, heartbeat_age_ms=None, max_age_ms=None, threshold_approved=False):
    """The operating block of a session, read from the files the process leaves (``heartbeat.json``, ``halt.json``, ``report.json``
    already parsed; a missing file is ``None``). It computes nothing about money and reads no database.

    The phase is the process's own word, never promoted: a heartbeat that says LIVE does not make the session live. ``liveness`` is
    ``final`` for a phase that ended, and for a running one ``unknown`` (no approved age limit, or no age: BAL-DECISION-187-01, no
    default here), ``stale`` (older than the caller's limit; the phase is then ``unverified``) or ``alive`` (only with an APPROVED
    limit). A ``halt.json`` outranks a heartbeat that never got to say HALTED (the process died between the two writes). A missing or
    unknown heartbeat is ``unavailable``, never an empty LIVE."""
    if not any(isinstance(part, dict) for part in (heartbeat, halt, report)):
        return _status_unavailable("heartbeat_missing")
    beat = heartbeat if isinstance(heartbeat, dict) else {}
    if beat and beat.get("schema") != HEARTBEAT_SCHEMA:
        return _status_unavailable("heartbeat_schema_unknown")
    reasons = []
    if isinstance(report, dict) and not _report_is_newer(report, beat):
        report = None                   # a report of an earlier run (kept across an operator restart) says nothing about this one
    reported = beat.get("phase")
    if reported is not None and reported not in PUBLISHED_PHASE:
        return _status_unavailable("heartbeat_phase_unknown")
    phase = PUBLISHED_PHASE.get(reported)
    halt_reason = None
    if isinstance(halt, dict):
        halt_reason = halt.get("reason")
        if phase != "HALTED":
            reasons.append("halt_file_outranks_heartbeat")
        phase = "HALTED"
    elif isinstance(report, dict) and report.get("ended_as") in FINAL_PHASES and phase not in FINAL_PHASES:
        reasons.append("report_ended_after_heartbeat")
        phase = PUBLISHED_PHASE[report["ended_as"]]
        halt_reason = report.get("halted")
    if phase is None:
        return _status_unavailable("heartbeat_phase_missing")
    if phase in FINAL_PHASES:
        liveness = "final"
    elif heartbeat_age_ms is None:
        liveness = "unknown"
        reasons.append("heartbeat_age_unknown")
    elif max_age_ms is not None and heartbeat_age_ms > max_age_ms:
        liveness, phase = "stale", "unverified"
        reasons.append("heartbeat_stale")
    elif threshold_approved and max_age_ms is not None:
        liveness = "alive"
    else:
        liveness = "unknown"
    if phase not in FINAL_PHASES and liveness == "unknown" and "heartbeat_age_unknown" not in reasons:
        reasons.append("liveness_threshold_not_approved")
    status = "not_approved" if max_age_ms is None else ("approved" if threshold_approved else "hypothesis")
    body = {"schema": STATUS_SCHEMA, "phase": phase, "reported_phase": reported, "liveness": liveness, "reasons": reasons,
            "thresholds": {"heartbeat_max_age_ms": max_age_ms, "status": status},
            "halt_reason": halt_reason,
            "orderly_stop": (report or {}).get("stop") if isinstance(report, dict) else None,
            "steps": beat.get("steps"), "observed_now_ms": beat.get("observed_now_ms"),
            "pending_orders": beat.get("pending_orders"), "open_positions": beat.get("open_positions"),
            "resources": beat.get("resources"), "clock": (report or {}).get("clock") if isinstance(report, dict) else None}
    return _status_tag(body)
