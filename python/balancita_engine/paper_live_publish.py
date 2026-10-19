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
# Stages of the B3 chain this module fills from the runner. ``signal`` comes from the references the runner journaled
# (``signals_persisted.refs``) checked against the ``SignalLog`` (BAL-DECISION-187-04); a reference that cannot be checked is
# published as ``unverified``, never as a signal.
INTERVAL_STAGES_PRESENT = ("signal", "decision", "order", "trade")
INTERVAL_STAGES_MISSING = ()


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


def account(portfolio, pending_orders=0):
    """BAL-DECISION-185-CARTERA-SIMULADA-01: the one shared SIMULATED balance, read from the portfolio's own snapshot (nothing is
    recomputed here). Two labelled balances: ``total_simulated_usd`` (1000 plus everything realized, net of all costs) and
    ``definitive_usd`` (the same without gains still provisional; it is the one that sizes and limits). ``committed_usd`` is the
    margin held by OPEN POSITIONS only (pending orders hold no reservation, see below) and ``free_usd`` is ``definitive_usd - committed_usd``.
    Pending orders are counted apart (``pending_orders``) and hold no reservation (``pending_reservation: none``, ``pending_reserved_usd: 0``): size and admission are
    decided when the order fills, against the free capital of that instant (BAL-DECISION-185-CARTERA-SIMULADA-02)."""
    snap = portfolio.snapshot()
    return {"class": "simulated", "initial_usd": snap["initial_equity_usd"], "total_simulated_usd": snap["equity_usd"],
            "definitive_usd": snap["capital_definitive_usd"], "provisional_gains_usd": snap["provisional_gains_usd"],
            "committed_usd": snap["reserved_usd"], "committed_scope": "open_positions_only", "free_usd": snap["available_usd"],
            "pending_orders": pending_orders, "pending_reservation": "none", "pending_reserved_usd": "0"}


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
                 "account": account(runner.portfolio, len(getattr(getattr(runner, "executor", None), "pending", ()))),
                 "positions": rows})


def _ref_problem(log, ref):
    """Why a journaled signal reference cannot be trusted (None when it can): the log entry it points to must exist, carry the
    same hash and key, and hold the same action. A reference is never repaired or guessed."""
    seq = ref.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or not 1 <= seq <= len(log.entries):
        return "reference_missing"
    entry = log.entries[seq - 1]
    if entry.get("kind") != "signal":
        return "not_a_signal_entry"
    if entry.get("hash") != ref.get("entry_hash"):
        return "entry_hash_mismatch"
    data = entry.get("data", {})
    if data.get("key") != ref.get("key"):
        return "key_mismatch"
    if data.get("signal", {}).get("action") != ref.get("action"):
        return "action_mismatch"
    return None


def signal_trace(runner):
    """The signals the runner persisted, read from its journal (``signals_persisted.refs``) and contrasted with the ``SignalLog`` by
    ``seq`` and ``entry_hash``. WAIT signals are included: they have no decision and no order and none is made up for them. Read only.
    Returns ``{"verified": {key: row}, "unverified": [{key, seq, reason}]}``."""
    verified, unverified = {}, []
    for entry in runner.journal.entries:
        if entry.get("kind") != "signals_persisted":
            continue
        for ref in entry.get("data", {}).get("refs", ()):
            reason = _ref_problem(runner.log, ref)
            if reason is not None:
                unverified.append({"key": ref.get("key"), "seq": ref.get("seq"), "reason": reason})
                continue
            logged = runner.log.entries[ref["seq"] - 1]["data"]
            verified.setdefault(ref["key"], {
                "key": ref["key"], "seq": ref["seq"], "entry_hash": ref["entry_hash"], "action": ref["action"],
                "origin": logged.get("origin"), "product_id": logged.get("product_id"),
                "strategy_id": logged["signal"]["strategy_id"], "generated_ms": logged.get("generated_ms")})
    return {"verified": verified, "unverified": unverified}


def _signal_stage(trace, key):
    found = trace["verified"].get(key)
    if found is None:
        return {"state": "unverified", "signal_key": key, "reason": "no_verified_reference"}
    return {"state": "recorded", "signal_key": key, "action": found["action"], "seq": found["seq"],
            "entry_hash": found["entry_hash"], "origin": found["origin"]}


def intervals(runner, from_ms=None, to_ms=None, product=None):
    """B3: signal -> decision -> order -> trade per (product, bucket). Decision, order and trade come from the runner's own
    decision rows; the ``signal`` stage from ``signal_trace`` (a signal without a decision, a WAIT included, is a row whose later
    stages are ``none``). A stage that does not exist is ``none``, never inferred; a signal reference that does not match the
    log is ``unverified`` and the contract says so. The array is NOT chronological (decided rows first, then the signals without a
    decision): ``at_ms`` is the time of each row (the decision time, or the signal's generation time when there is no decision) and
    is what a reader orders by; a row without a time says ``null``. Qwen decisions and C verdicts come from their own databases (B3 original)."""
    trace = signal_trace(runner)
    rows = []
    decided = decisions(runner)
    for row in decided:
        bucket = (row.get("decided_ms") or 0)
        if product is not None and row["product_id"] != product:
            continue
        if from_ms is not None and bucket < from_ms:
            continue
        if to_ms is not None and bucket >= to_ms:
            continue
        rows.append({
            "key": row.get("signal_key"), "product_id": row["product_id"], "strategy_id": row["strategy_id"],
            "decided_ms": row.get("decided_ms"), "at_ms": row.get("decided_ms"), "side": row["side"],
            "stages": {
                "signal": _signal_stage(trace, row.get("signal_key")),
                "decision": {"state": "recorded" if row.get("decided_ms") is not None else "none", "decided_ms": row.get("decided_ms")},
                "order": {"state": row["state"], "reasons": row["reasons"], "entry_ms": row.get("entry_ms")},
                "trade": {"state": row["result"] if row["result"] in ("closed", "open") else "none",
                          "trade_id": row.get("trade_id"), "exit_reason": row.get("exit_reason")}}})
    decided_keys = {d.get("signal_key") for d in decided}
    for key, sig in sorted(trace["verified"].items(), key=lambda kv: (kv[1]["generated_ms"] or 0, kv[0])):
        if key in decided_keys:
            continue
        bucket = sig["generated_ms"] or 0
        if (product is not None and sig["product_id"] != product) or (from_ms is not None and bucket < from_ms) \
                or (to_ms is not None and bucket >= to_ms):
            continue
        rows.append({
            "key": key, "product_id": sig["product_id"], "strategy_id": sig["strategy_id"], "decided_ms": None, "at_ms": sig["generated_ms"], "side": "none",
            "stages": {
                "signal": _signal_stage(trace, key),
                "decision": {"state": "none", "decided_ms": None},
                "order": {"state": "none", "reasons": [], "entry_ms": None},
                "trade": {"state": "none", "trade_id": None, "exit_reason": None}}})
    complete = not trace["unverified"] and all(r["stages"]["signal"]["state"] == "recorded" for r in rows)
    return _tag({"schema": INTERVALS_SCHEMA, "clock_ms": runner.clock, "from_ms": from_ms, "to_ms": to_ms,
                 "product": product, "contract": {"complete": complete, "stages_present": list(INTERVAL_STAGES_PRESENT),
                                                  "stages_missing": list(INTERVAL_STAGES_MISSING)},
                 "signal_references": {"verified": len(trace["verified"]), "unverified": trace["unverified"]},
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
                 "halt_reason": None, "orderly_stop": None, "resources": None, "clock": None, "funding": funding_block(None)})


def _report_is_newer(report, beat):
    """A ``report.json`` outlives an operator restart (nothing rewrites it until the new run ends), so it only outranks the heartbeat when
    it is of the same session and configuration AND was written strictly after the heartbeat's observation time while that heartbeat still runs (D-223-01; a tie goes to the heartbeat: the first heartbeat of a restarted run carries the
    same observation time as the halt that preceded it, and the process writes its report at a later step than its last heartbeat). With no
    heartbeat there is nothing to compare: the report is all there is."""
    if not beat:
        return True
    ended, seen = report.get("ended_at_observed_ms"), beat.get("observed_now_ms")
    if (report.get("session_id"), report.get("config_digest")) != (beat.get("session_id"), beat.get("config_digest")):
        return False
    if not (isinstance(ended, int) and isinstance(seen, int)):
        return False
    # a run that ended writes its report and then a final heartbeat at the same observation time: for a final heartbeat a tie is the same run
    return ended >= seen if PUBLISHED_PHASE.get(beat.get("phase")) in FINAL_PHASES else ended > seen


def funding_block(funding):
    """Where the funding of the session comes from and whether its net result may be called verified (``pnl_verified``), from the
    ``funding_report()`` the session itself produces (or the copy the final report holds). It decides nothing: it restates, and it
    never trusts a ``pnl_verified: true`` that comes with a reason against it. ``source`` is ``observed`` (the funding the capture
    stored, #184) or ``unknown`` (nothing was given, or a mode that does not exist: absent is not "fine")."""
    if not isinstance(funding, dict) or "mode" not in funding:
        return {"source": "unknown", "pnl_verified": False, "reasons": ["funding_report_missing"], "incomplete_trades": None,
                "disputed_trades": None, "quarantined_periods": None, "divergence_evidence": None}
    if funding["mode"] != "observed":
        return {"source": "unknown", "pnl_verified": False,
                "reasons": ["funding_mode_unknown"], "incomplete_trades": None,
                "disputed_trades": None, "quarantined_periods": None, "divergence_evidence": None}
    reasons = list(funding.get("unverified_reasons") or [])
    incomplete, disputed = funding.get("incomplete_trades"), funding.get("disputed_trades")
    quarantined, evidence = funding.get("quarantined"), funding.get("divergence_evidence")
    divergent = any((funding.get("divergence") or {}).values()) if isinstance(funding.get("divergence"), dict) else bool(funding.get("divergence"))
    for reason, present in (("trade_funding_incomplete", incomplete), ("trade_funding_disputed", disputed), ("book_and_portfolio_diverge", divergent),
                            ("divergence_evidence_recorded", evidence)):
        if present and reason not in reasons:
            reasons.append(reason)                       # recomputed from the facts, not only from the reasons the producer listed
    if incomplete is None or disputed is None or evidence is None:
        reasons.append("funding_report_incomplete")
    return {"source": "observed", "pnl_verified": not reasons and funding.get("pnl_verified") is True, "reasons": reasons,
            "incomplete_trades": incomplete, "disputed_trades": disputed, "quarantined_periods": quarantined, "divergence_evidence": evidence}


def session_status(heartbeat, halt=None, report=None, heartbeat_age_ms=None, max_age_ms=None, threshold_approved=False, funding=None):
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
            "resources": beat.get("resources"), "clock": (report or {}).get("clock") if isinstance(report, dict) else None,
            "funding": funding_block(funding if funding is not None else (report or {}).get("funding") if isinstance(report, dict) else None)}
    return _status_tag(body)


# ---- the document of blocks a session leaves for its readers (BAL-DECISION-187-05, option A of BAL-OPCIONES-187-PRODUCCION-01) ----
BLOCKS_SCHEMA = "balancita-paper-session-blocks.v1"


def session_blocks(runner, heartbeat, halt=None, report=None, observed_now_ms=None, max_age_ms=None, source_state=None, funding=None):
    """The three blocks of a session in ONE document that the process that holds the runner writes next to its heartbeat and that the
    gateway only reads. It is derived and has no authority over the session: nothing in it is read back by the process.

    The WRITER never measures an age: ``heartbeat_age_ms`` and ``report_age_ms`` are ``None`` here on purpose, because an age taken by the
    process at the moment it writes would be 0 by construction and would prove nothing. The READER measures the age of the document
    with its own clock and may only degrade (it never promotes ``unknown`` to ``fresh`` or ``alive``). So in a document the freshness is
    ``unknown`` (``report_age_unknown``) and the liveness of a running session is ``unknown`` (``heartbeat_age_unknown``) until a reader
    says otherwise. ``max_age_ms`` is the caller's limit and has no default; no limit is approved, so the thresholds are never ``approved``.

    ``steps`` and ``observed_now_ms`` are the process's own counters, for diagnosis. ``derived`` and ``authority`` say what this is."""
    beat = heartbeat if isinstance(heartbeat, dict) else {}
    return {"schema": BLOCKS_SCHEMA, "session_id": beat.get("session_id"), "config_digest": beat.get("config_digest"),
            "run": {"pid": beat.get("pid"), "id": beat.get("run_id")},      # the mark of the process run that wrote it: the reader refuses a file whose run is not the heartbeat's
                "observed_now_ms": observed_now_ms if observed_now_ms is not None else beat.get("observed_now_ms"),
            "steps": beat.get("steps"), "derived": True, "authority": "none",
            "status": session_status(heartbeat, halt, report, heartbeat_age_ms=None, max_age_ms=max_age_ms, threshold_approved=False, funding=funding),
            "positions": positions(runner, None, max_age_ms, source_state, False),
            "intervals": intervals(runner)}
