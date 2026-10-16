"""Read contract and independent audit of the paper runner (stage 8C). Read-only: nothing here changes a runner.

``observability(runner)`` is the stable, versioned reading surface a future frontend can use (no UI here). Every datum
belongs to exactly one of four classes, so a reader never mistakes one for another:

* ``observed``: facts the runner saw and journaled: events, rejections, offsets, quotes, order states, interruptions,
  coverage gaps, the journal itself;
* ``simulated``: results of the paper account: capital, positions, trades, fills, fees, funding, sizing. They are the
  deterministic output of the shared engine, not market facts;
* ``estimated``: values that depend on a mark or an assumption: unrealised P&L, stop exits priced by a rule instead of a
  quote, gains of trades whose funding is incomplete;
* ``uncertain``: what is not known or is disputed: incomplete or disputed funding, unresolved execution, orders cancelled
  for lack of coverage, positions whose stop was not observed, offsets still missing.

``integrated_audit(runner)`` runs the stage 7 validators (``portfolio_audit.audit``) over the integrated result and adds
checks that only make sense with the runner around them (the journal, the orders and the portfolio must tell the same
story). It never repairs anything: it reports.

``summary_block(runner)`` renders the plain-text summary of a session from the same numbers.
"""

from decimal import Decimal

from .multi_signals import BUY, SELL, stable_hash
from .paper_runner import RunnerJournal
from .portfolio_audit import accounting_digest, audit

D = Decimal
CONTRACT = "balancita-paper-runner-report.v2"
CLASSES = ("observed", "simulated", "estimated", "uncertain")
STATE_LABELS = {"CREATED": "created", "PROCESSING": "processing", "RECOVERING": "recovering", "FINISHED": "stopped",
                "REFUSED": "stopped"}


def _usd(value):
    return str(D(str(value)))


def decisions(runner):
    """One row per decision the runner took, from the signal to the later result and the funding reliability."""
    portfolio = runner.portfolio
    by_intent = {d["intent_id"]: d for d in portfolio.decisions}
    trades = {t["intent_id"]: t for t in portfolio.trades}
    rows = []
    pending = [("pending", dict(o, intent_id=i)) for i, o in sorted(runner.executor.pending.items())]
    named = {o["record_id"]: o["state"] for o in runner.orders() if "record_id" in o}      # the operator's word for a closed order (expired, cancelled)
    for state, record in pending + [(named.get(r["record_id"], r["status"]), r) for r in runner.executor.records]:
        decision = by_intent.get(record["intent_id"])
        trade = trades.get(record["intent_id"])
        book = portfolio.positions.get(record["product_id"])
        open_now = book is not None and book.intent["intent_id"] == record["intent_id"]
        timeline = record.get("timeline", {})
        result = "pending" if state == "pending" else None
        if trade is not None:
            result = "closed"
        elif open_now:
            result = "open"
        elif state != "pending":
            result = state
        rows.append({
            "intent_id": record["intent_id"], "product_id": record["product_id"], "strategy_id": record["strategy_id"],
            "signal_key": record.get("signal_key"), "side": record["side"],
            "decided_ms": timeline.get("decided_ms"), "entry_ms": timeline.get("entry_ms"),
            "state": state, "reasons": list(record.get("reasons", ())),
            "reference_price": record.get("reference_price"), "executable_price": record.get("entry_price"),
            "stop": record.get("stop"), "target": record.get("target"),
            "notional_usd": record.get("notional_usd"), "planned_loss_usd": record.get("planned_loss_usd"),
            "portfolio_at_decision": None if decision is None else {
                k: decision.get(k) for k in ("capital_definitive_usd", "available_usd", "risk_budget_usd", "open_risk_usd")},
            "result": result,
            "trade_id": None if trade is None else trade["trade_id"],
            "pnl_usd": None if trade is None else trade["pnl_usd"],
            "exit_reason": None if trade is None else trade["exit_reason"],
            "funding": None if trade is None else {
                "status": trade["funding_status"], "complete": trade["funding_complete"], "usd": trade["funding_usd"],
                "net_complete": trade["net_complete"],
                "disputed": trade["trade_id"] in portfolio.funding_disputes,
                "review_flags": list(portfolio.review_flags.get(trade["trade_id"], ()))}})
    return rows


MINUTE_MS = 60_000


def classify_gap(gap, ranges):
    """Does valid candle evidence cover a silence? ``candles_cover`` (every minute touching it was processed after the
    entry minute), ``candles_partial`` or ``no_market_evidence``. Candles are evidence of their own kind: they evaluate the
    stop through high and low, but they say nothing about the quotes that were missing."""
    lo = gap["from_ms"] // MINUTE_MS * MINUTE_MS
    hi = -(-gap["to_ms"] // MINUTE_MS) * MINUTE_MS
    covered = sum(max(0, min(hi, b) - max(lo, a)) for a, b in ranges)
    if covered >= hi - lo:
        return "candles_cover"
    return "candles_partial" if covered > 0 else "no_market_evidence"


def _gaps_of(runner, intent_id, tail=None):
    ranges = runner.coverage["candles"].get(intent_id, [])
    gaps = [dict(g) for g in runner.coverage["gaps"] if g["intent_id"] == intent_id]
    if tail is not None:
        gaps.append(tail)
    for gap in gaps:
        gap["evidence"] = classify_gap(gap, ranges)
    return gaps


def protection(runner):
    """Per open position, was the stop watched? Only evidence counts: a quote that ``QuoteWatch`` accepted after the entry,
    or a processed candle. The quote that opened the position proves nothing about what came after.

    * ``observed``: at least one watched quote after the entry and no uncovered silence;
    * ``observed_by_candles``: no uncovered silence, but only because processed candles cover it;
    * ``not_yet_observed``: nothing watched it yet and the experimental silence threshold has not passed;
    * ``unobserved``: a recorded or current silence that no candle covers."""
    out = []
    clock = runner.clock if runner.clock is not None else 0
    gap_ms = runner.config.coverage_gap_ms
    for product, book in sorted(runner.portfolio.positions.items()):
        intent_id = book.intent["intent_id"]
        entry = int(book.position.get("entry_ms", book.position["opened_at"]))
        record = runner.coverage["watch"].get(intent_id, {})
        last = max(record.get("last_ms", entry), entry)
        known = [g["to_ms"] for g in runner.coverage["gaps"] if g["intent_id"] == intent_id]
        since = max([last] + known)
        tail = {"product_id": product, "from_ms": since, "to_ms": clock, "kind": "silent_now", "intent_id": intent_id} \
            if clock - since > gap_ms else None
        gaps = _gaps_of(runner, intent_id, tail)
        uncovered = [g for g in gaps if g["evidence"] != "candles_cover"]
        quotes = record.get("quotes", 0)
        if uncovered:
            state = "unobserved"
        elif gaps:
            state = "observed_by_candles"
        elif quotes > 0:
            state = "observed"
        else:
            state = "not_yet_observed"
        out.append({"product_id": product, "intent_id": intent_id, "entry_ms": entry, "quotes_watched": quotes,
                    "last_watched_ms": record.get("last_ms") if quotes else None,
                    "last_quote_ms": runner.coverage["last_quote"].get(product),
                    "stop_protection": state, "gaps": gaps, "silent_now_ms": clock - since if tail else 0,
                    "candle_ranges": [list(r) for r in runner.coverage["candles"].get(intent_id, [])]})
    return out


def trade_coverage(runner):
    """Per closed trade: the market evidence its stop had during its life. Closing never erases a gap."""
    rows = []
    for trade in runner.portfolio.trades:
        intent_id = trade["intent_id"]
        record = runner.coverage["watch"].get(intent_id, {})
        gaps = _gaps_of(runner, intent_id)
        uncovered = [g for g in gaps if g["evidence"] != "candles_cover"]
        rows.append({"trade_id": trade["trade_id"], "intent_id": intent_id, "product_id": trade["product_id"],
                     "entry_time_ms": trade["entry_time_ms"], "exit_time_ms": trade["exit_time_ms"],
                     "exit_reason": trade["exit_reason"], "quotes_watched": record.get("quotes", 0), "gaps": gaps,
                     "stop_coverage": "gaps_without_evidence" if uncovered else (
                         "gaps_covered_by_candles" if gaps else ("continuous" if record.get("quotes", 0) else "insufficient_evidence"))})
    return rows


def alerts(runner, audit_result=None):
    """What a person should look at first. ``severity``: ``error`` (the books or the recovery cannot be trusted),
    ``warning`` (a known limitation applies), ``info``."""
    p, out = runner.portfolio, []
    if audit_result is None:
        audit_result = integrated_audit(runner)
    for violation in audit_result["violations"]:
        out.append({"code": "accounting_discrepancy", "severity": "error", "detail": violation})
    if runner.open_cycles or runner.open_funding:
        out.append({"code": "recovery_incomplete", "severity": "error",
                    "detail": {"cycles": sorted(runner.open_cycles), "funding": sorted(runner.open_funding)}})
    for product, periods in sorted(p.funding_conflicts.items()):
        out.append({"code": "funding_conflict", "severity": "warning", "detail": {"product_id": product, "periods": periods}})
    holes = runner.offsets.holes_count()
    if holes:
        out.append({"code": "offset_holes", "severity": "warning", "detail": {"holes": holes}})
    watching = protection(runner)
    unobserved = [x for x in watching if x["stop_protection"] == "unobserved"]
    if unobserved:
        out.append({"code": "insufficient_market_data", "severity": "warning",
                    "detail": {"positions": [x["product_id"] for x in unobserved]}})
    waiting = [x for x in watching if x["stop_protection"] == "not_yet_observed"]
    if waiting:
        out.append({"code": "stop_not_yet_observed", "severity": "info",
                    "detail": {"positions": [x["product_id"] for x in waiting]}})
    affected = [t for t in trade_coverage(runner) if t["stop_coverage"] == "gaps_without_evidence"]
    if affected:
        out.append({"code": "closed_trade_coverage_incomplete", "severity": "warning",
                    "detail": {"trades": [t["trade_id"] for t in affected]}})
    if any(not t["funding_complete"] for t in p.trades):
        out.append({"code": "funding_incomplete", "severity": "info", "detail": {
            "trades": [t["trade_id"] for t in p.trades if not t["funding_complete"]]}})
    suspended = p.suspension_state(runner.clock or 0)
    if any(suspended.values()):
        out.append({"code": "entries_suspended", "severity": "info", "detail": suspended})
    return out


def observability(runner):
    """The versioned read contract. Nothing in it is computed by a second engine: it reads the runner's components."""
    p = runner.portfolio
    audit_result = integrated_audit(runner)
    alert_list = alerts(runner, audit_result)
    clock = runner.clock or 0
    suspended = p.suspension_state(clock)
    decision_rows = decisions(runner)
    watch = [x for x in protection(runner)]
    unrealised = _usd(p.unrealized_usd())
    provisional = [t for t in p.trades if not t["net_complete"]]
    return {
        "schema": CONTRACT, "classes": list(CLASSES),
        "state": {"runner": STATE_LABELS[runner.status], "status": runner.status, "clock_ms": runner.clock,
                  "suspended_entries": suspended, "degraded": any(a["severity"] in ("error", "warning") for a in alert_list),
                  "mode": "OFFLINE / PAPER"},
        "alerts": alert_list,
        "sections": {
            "observed": {"class": "observed", "data": {
                "events": {"accepted": runner.stats.get("events_accepted", 0), "rejected": runner.stats.get("events_rejected", 0),
                           "duplicates": runner.stats.get("rejected:duplicate_event", 0),
                           "by_reason": {k[9:]: v for k, v in sorted(runner.stats.items()) if k.startswith("rejected:")}},
                "orders": [{k: o.get(k) for k in ("intent_id", "product_id", "strategy_id", "side", "state", "reasons")}
                           for o in runner.orders()],
                "integrity": runner.integrity(),
                "coverage": {"last_quote_ms": dict(sorted(runner.coverage["last_quote"].items())),
                             "watched_quotes": {k: v["quotes"] for k, v in sorted(runner.coverage["watch"].items())},
                             "candle_ranges": {k: [list(r) for r in v] for k, v in sorted(runner.coverage["candles"].items())},
                             "gaps": list(runner.coverage["gaps"])},
                "journal": {"entries": len(runner.journal.entries), "head": runner.journal.head}}},
            "simulated": {"class": "simulated", "data": {
                "portfolio": p.snapshot(),
                "decisions": decision_rows,
                "trades": [{k: t[k] for k in ("trade_id", "intent_id", "product_id", "side", "entry_time_ms", "exit_time_ms",
                                              "exit_reason", "pnl_usd", "fees_usd", "funding_usd", "hit")} for t in p.trades],
                "adjustments": len(p.adjustments), "reclassifications": len(p.reclassifications)}},
            "estimated": {"class": "estimated", "data": {
                "unrealized_usd": unrealised,
                "provisional_trades": [{"trade_id": t["trade_id"], "partial_usd": t["partial_usd"],
                                        "funding_status": t["funding_status"]} for t in provisional],
                "provisional_gains_usd": _usd(p.provisional_gains_usd()),
                "stop_exits_by_rule": [{"trade_id": t["trade_id"], "evidence": (t.get("stop_exit") or {}).get("evidence")}
                                       for t in p.trades if (t.get("stop_exit") or {}).get("estimated")]}},
            "uncertain": {"class": "uncertain", "data": {
                "funding": {"incomplete": [t["trade_id"] for t in p.trades if not t["funding_complete"]],
                            "disputed": sorted(p.funding_disputes), "quarantined_periods": {
                                k: v for k, v in sorted(p.funding_conflicts.items())},
                            "disputed_gains_usd": _usd(p.disputed_funding_gains_usd())},
                "execution": {"unresolved_gains_usd": _usd(p.unresolved_execution_gains_usd()),
                              "cancelled_for_lack_of_coverage": [o["intent_id"] for o in runner.orders()
                                                                 if o["state"] == "cancelled"]},
                "market_coverage": watch,
                "closed_trade_coverage": trade_coverage(runner),
                "offsets": {"holes": runner.offsets.holes_count(),
                            "declared_gaps": {k: v["declared_gaps"] for k, v in runner.offsets.summary().items()
                                              if v["declared_gaps"]}},
                "review_flags": {k: list(v) for k, v in sorted(p.review_flags.items())}}}},
        "audit": audit_result,
        "labels": {"policies": "execution, watch, gap and coverage policies are experimental hypotheses, not validated values"},
        "digests": {"state": runner.state_digest(), "financial": runner.financial_digest(),
                    "accounting": accounting_digest(p), "ledger": p.ledger_hash(), "executor": runner.executor.ledger_hash()},
    }


def uncovered(before, after, gaps, threshold):
    """The stretches of ``[before, after]`` that no recorded gap covers and that last longer than the threshold. Short
    leftovers are legitimate: a silence already recorded as an interruption is not counted twice."""
    cursor, out = before, []
    for gap in sorted(gaps, key=lambda g: (g["from_ms"], g["to_ms"])):
        if gap["to_ms"] <= cursor or gap["from_ms"] >= after:
            continue
        if gap["from_ms"] - cursor > threshold:
            out.append((cursor, gap["from_ms"]))
        cursor = max(cursor, gap["to_ms"])
    if after - cursor > threshold:
        out.append((cursor, after))
    return out


def integrated_audit(runner):
    """Stage 7 validators over the integrated result plus the checks only the runner can make. Returns
    ``{"violations": [...], "checks": [...], "portfolio_audit": {...}}``; an empty ``violations`` is the pass."""
    p = runner.portfolio
    result = audit(p)
    violations = [dict(v, source="portfolio_audit") if isinstance(v, dict) else {"rule": str(v), "source": "portfolio_audit"}
                  for v in result["violations"]]
    checks = ["portfolio_audit"]

    def violate(rule, **detail):
        violations.append(dict(detail, rule=rule, source="runner"))

    checks.append("journal_chain")
    broken = RunnerJournal.verify(runner.journal.entries)
    if broken is not None:
        violate("journal_chain_broken", seq=broken)
    checks.append("one_trade_per_opened_order")
    opened = [r for r in runner.executor.records if r["status"] == "opened"]
    trade_intents = [t["intent_id"] for t in p.trades]
    open_intents = [b.intent["intent_id"] for b in p.positions.values()]
    if len(set(trade_intents)) != len(trade_intents):
        violate("trade_intent_duplicated")
    if len({t["trade_id"] for t in p.trades}) != len(p.trades):
        violate("trade_id_duplicated")
    if sorted(trade_intents + open_intents) != sorted(r["intent_id"] for r in opened):
        violate("opened_orders_do_not_match_positions", opened=len(opened), trades=len(trade_intents), open=len(open_intents))
    checks.append("capital_events_match_adjustments")
    kinds = [e["kind"] for e in p.capital_log]
    if kinds.count("funding_reconciled") != len(p.adjustments):
        violate("reconciliations_not_matched_by_capital_events", capital_events=kinds.count("funding_reconciled"),
                adjustments=len(p.adjustments))
    reclassified = kinds.count("funding_dispute_reclassified")
    if reclassified > len(p.reclassifications):
        violate("reclassification_counted_twice", capital_events=reclassified, records=len(p.reclassifications))
    checks.append("decisions_match_orders")
    journal_decisions = [e for e in runner.journal.entries if e["kind"] == "decision"]
    seen = len(runner.executor.records) + len(runner.executor.pending)
    if len(journal_decisions) != seen:
        violate("decisions_not_matched_by_orders", decisions=len(journal_decisions), orders=seen)
    checks.append("causal_order")
    for record in opened:
        t = record["timeline"]
        order = [t["candle_close_ms"], t["generated_ms"], t["persisted_ms"], t["decided_ms"], t["earliest_fill_ms"], t["entry_ms"]]
        if order != sorted(order):
            violate("timeline_not_causal", intent_id=record["intent_id"])
    checks.append("obligations_closed")
    if runner.status == "FINISHED" and (runner.open_cycles or runner.open_funding):
        violate("finished_with_open_obligations")
    checks.append("coverage_history")
    known_intents = set(trade_intents) | set(open_intents) | {r["intent_id"] for r in opened}
    for gap in runner.coverage["gaps"]:
        if gap["intent_id"] not in known_intents:
            violate("coverage_gap_of_unknown_position", intent_id=gap["intent_id"])
    for trade in p.trades:             # a silence that ended with the close must have been recorded when it closed
        record = runner.coverage["watch"].get(trade["intent_id"])
        if record is None:
            violate("closed_trade_without_coverage_record", trade_id=trade["trade_id"])
            continue
        recorded = max([record["last_ms"]] + [g["to_ms"] for g in runner.coverage["gaps"] if g["intent_id"] == trade["intent_id"]])
        if int(trade["exit_time_ms"]) - recorded > runner.config.coverage_gap_ms:
            violate("coverage_gap_missing_at_close", trade_id=trade["trade_id"])
    checks.append("coverage_history_against_journal")
    threshold = runner.config.coverage_gap_ms
    quote_times = {}
    for entry in runner.journal.entries:
        if entry["kind"] == "event_accepted" and entry["data"]["event"]["kind"] == "quote":
            payload = entry["data"]["event"]["payload"]
            quote_times.setdefault(payload["product_id"], set()).add(int(payload["time_ms"]))
    spans = []
    for trade in p.trades:
        spans.append((trade["intent_id"], trade["product_id"], int(trade["entry_time_ms"]), int(trade["exit_time_ms"])))
    for product, book in p.positions.items():
        spans.append((book.intent["intent_id"], product, int(book.position.get("entry_ms", book.position["opened_at"])), None))
    for intent_id, product, entry_ms, exit_ms in spans:
        recorded = [g for g in runner.coverage["gaps"] if g["intent_id"] == intent_id]
        record = runner.coverage["watch"].get(intent_id, {})
        if exit_ms is not None and record.get("quotes", 0) == 0 and not recorded:
            violate("closed_trade_unwatched_without_gap", intent_id=intent_id)
        # (a) Silences between moments the watch accepted (kept by the runner): the gaps must cover them. Every moment must
        #     be an accepted quote of the journal, so the list cannot invent evidence. Covering means no uncovered stretch
        #     longer than the threshold: a gap cut from ten minutes to one second leaves nine minutes bare.
        for before, after in record.get("silences", ()):
            for end in (before, after):
                if end not in (entry_ms, exit_ms) and end not in quote_times.get(product, ()):
                    violate("coverage_evidence_not_in_journal", intent_id=intent_id, moment_ms=end)
            for lo, hi in uncovered(before, after, recorded, threshold):
                violate("coverage_gap_altered", intent_id=intent_id, silent_from_ms=lo, silent_to_ms=hi)
        # (b) Lower bound from the journal alone: silences between accepted quotes (a superset of the watched ones) are
        #     silences of the watch too. Weaker than (a) because a quote the watch ignored shortens them here.
        points = [entry_ms] + sorted(t for t in quote_times.get(product, ()) if t > entry_ms and (exit_ms is None or t <= exit_ms))
        if exit_ms is not None:
            points.append(exit_ms)
        for before, after in zip(points, points[1:]):
            if after - before > threshold:
                for lo, hi in uncovered(before, after, recorded, threshold):
                    violate("coverage_gap_missing_in_history", intent_id=intent_id, silent_from_ms=lo, silent_to_ms=hi)
    checks.append("fees_and_funding_recomputed")
    reported = sum((D(str(t["fees_usd"])) for t in p.trades), D(0))
    if D(p.snapshot()["fees_usd"]) != reported:
        violate("fees_total_mismatch")
    return {"violations": violations, "checks": checks, "portfolio_audit": {"violations": result["violations"]},
            "limitations": ["the journal does not record which accepted quote the watch ignored: the audit cannot re-decide that "
                            "without duplicating the execution rules; a silence erased together with its record in the runner "
                            "state can be hidden by ignored quotes that fill it in the journal"],
            "passed": not violations}


def counts(runner):
    """The numbers of the summary, read from the engine."""
    p = runner.portfolio
    signals = [e for e in runner.log.signals() if e["data"]["origin"] == "original"
               and e["data"]["signal"]["action"] in (BUY, SELL)]
    records = runner.executor.records
    accepted = len([r for r in records if r["status"] == "opened"])
    rejected = len([r for r in records if r["status"] != "opened"])
    wins = len([t for t in p.trades if t["hit"]])
    return {
        "signals": len(signals), "accepted": accepted, "rejected": rejected, "pending": len(runner.executor.pending),
        "open": len(p.positions), "closed": len(p.trades), "wins": wins, "losses": len(p.trades) - wins,
        "fees_usd": sum((D(str(t["fees_usd"])) for t in p.trades), D(0)),
        "funding_usd": sum((D(str(t["funding_usd"])) for t in p.trades if t["funding_usd"] is not None), D(0)),
        "pnl_usd": sum((D(str(t["pnl_usd"])) for t in p.trades), D(0)),
        "events": runner.stats.get("events_accepted", 0), "duplicates": runner.stats.get("rejected:duplicate_event", 0),
        "holes": runner.offsets.holes_count(), "recoveries": runner.recoveries}


def summary_block(runner, *, recovered_digest=None):
    """The plain-text summary of a session. ``recovered_digest``: the same session after an interruption elsewhere."""
    p, c = runner.portfolio, counts(runner)
    audit_result = integrated_audit(runner)
    def money(x):
        value = D(str(x)).quantize(D("0.01"))
        return "{} USD".format(abs(value) if value == 0 else value)

    rows = [
        ("Estado", {"FINISHED": "FINALIZADO", "PROCESSING": "PROCESANDO", "RECOVERING": "RECUPERANDO",
                    "REFUSED": "RECHAZADO"}[runner.status]),
        ("Modo", "OFFLINE / PAPER"), None,
        ("Capital inicial", money(p.policy.initial_equity_usd)), ("Capital final", money(p.equity_usd())),
        ("Capital utilizable", money(p.capital_usd())), None,
        ("Señales generadas", c["signals"]), ("Señales aceptadas", c["accepted"]), ("Señales rechazadas", c["rejected"]), None,
        ("Operaciones abiertas", c["open"]), ("Operaciones cerradas", c["closed"]), None,
        ("Ganancias", c["wins"]), ("Pérdidas", c["losses"]), None,
        ("Comisiones", money(c["fees_usd"])), ("Funding", money(c["funding_usd"])), None,
        ("P&L neto", money(c["pnl_usd"])), ("Máximo drawdown", money(p.drawdown_usd())), None,
        ("Eventos procesados", c["events"]), ("Eventos duplicados", c["duplicates"]),
        ("Huecos sin resolver", c["holes"]), None,
        ("Recuperaciones", c["recoveries"]), ("Violaciones contables", len(audit_result["violations"])), None,
        ("Hash ejecución continua", runner.financial_digest()[:32]),
        ("Hash ejecución recuperada", (recovered_digest or runner.financial_digest())[:32])]
    lines = ["BALANCITA PAPER RUNNER", ""]
    for row in rows:
        lines.append("" if row is None else "{:<27}{}".format(row[0] + ":", row[1]))
    return "\n".join(lines) + "\n"
