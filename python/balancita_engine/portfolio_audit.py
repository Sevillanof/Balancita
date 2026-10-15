"""Independent accounting checks and per-trade reconstruction for the shared paper portfolio (offline, isolated).

Same idea as the checks of ``portfolio_offline`` (PR #122): nothing here trusts the portfolio's own sums. Every figure is
recomputed from the raw fields of the closed trades, the cost model and the append-only logs, and compared with what the
portfolio holds. ``audit`` returns violations (something is wrong) and warnings (something is pending, nothing is wrong).

Rules checked (``audit``):

* ``trade_identity``: gross - fees - funding = pnl, and fees are charged once (``fees_usd`` is the recomputed taker fee);
* ``entry_price_model``: the entry price is the cost model's ``entry_fill`` of the reference price;
* ``exit_not_better_than_plan``: a stop never exits at a price better than the planned stop exit (a loss is never reduced
  to fit the risk budget); ``loss_vs_plan_decomposition``: realized - planned = price effect + fee effect + funding;
* ``stop_exit_fields``: the recorded stop level / reference / executable price / slippage agree with each other, and a
  quote-backed exit used a quote observed strictly after the entry;
* ``capital_*``: the definitive capital equals initial + verified results + provisional losses, equals initial + the sum
  of the capital log, and the log is a contiguous, hash-chained sequence in which every trade's events add up to its
  contribution; provisional gains are never counted;
* ``adjustment_*``: every reconciliation chains from the state the trade had when it closed, the last one equals the
  current state, completeness only changes through a recorded ``provisional_to_definitive`` transition, and the funding
  of a trade is the recount over the accepted periods (never accumulated, so never applied twice);
* ``no_entry_while_suspended`` and ``risk_budget_recomputed``: a position opened only if no suspension was active at its
  decision, with a budget equal to the risk fraction of the capital at that moment, and a planned loss within it;
* ``funding_log_chain`` and duplicate trade / capital events.

``trade_reconstruction`` and ``planned_vs_realized`` rebuild, per trade, entry, stop, exit, planned and realized loss,
costs, funding with its coverage, gross and net P&L, capital before and after and every later reconciliation.
"""

from decimal import Decimal

from .futures_costs import entry_fill, exit_fill, fee_rate, side_impact_bps, spread_bps
from .multi_risk import DAY_MS
from .multi_signals import stable_hash
from .portfolio_funding import ZERO_HASH, _recount

D = Decimal
USD_TOLERANCE = D("0.0006")      # pnl is stored rounded to 4 decimals, fees to 6
PRICE_TOLERANCE = D("0.000001")


def _gross(trade):
    entry, exit_, q = D(trade["entry_price"]), D(trade["exit_price"]), D(trade["quantity"])
    return (exit_ - entry) * q if trade["side"] == "LONG" else (entry - exit_) * q


def _fees(trade):
    return (D(trade["entry_price"]) + D(trade["exit_price"])) * D(trade["quantity"]) * fee_rate("taker")


def _planned_stop_exit(portfolio, trade):
    """The stop exit price the sizing assumed (cost model plus the policy's extra buffer)."""
    side = trade["side"]
    price = exit_fill(D(trade["stop_price"]), side, trade["product_id"], "stop")
    buffer = D(portfolio.policy.slippage_buffer_bps) / D(10_000)
    return price * (1 - buffer) if side == "LONG" else price * (1 + buffer)


def exit_basis(trade):
    """How the exit price of a stop is justified: a quote, an estimate from candles, or the model at the stop level."""
    if trade["exit_reason"] != "stop":
        return "not_a_stop"
    stop_exit = trade.get("stop_exit")
    if stop_exit is None:
        return "modelled_at_stop_level"
    if stop_exit["quote_backed"]:
        return "quote_backed"
    if stop_exit["evidence"] in ("stop_level", "ohlc_stop_level", "post_hole_open_unavailable_stop_level"):
        return "modelled_at_stop_level"
    return "estimated_assumed_stop" if stop_exit["evidence"] == "assumed_stop_entry_minute" else "estimated_from_candles"


def _chain_ok(entries):
    prev = ZERO_HASH
    for number, entry in enumerate(entries, start=1):
        body = {k: v for k, v in entry.items() if k != "hash"}
        if entry["seq"] != number or entry["prev"] != prev or stable_hash(body) != entry["hash"]:
            return number
        prev = entry["hash"]
    return None


def audit(portfolio):
    """``{"violations": [...], "warnings": [...], "checks": n}``; empty ``violations`` means every identity holds."""
    violations, warnings = [], []
    checks = 0

    def violate(rule, **detail):
        violations.append({"rule": rule, **{k: str(v) for k, v in detail.items()}})

    p = portfolio
    policy = p.policy
    initial = D(policy.initial_equity_usd)
    seen_ids = set()
    for trade in p.trades:
        tid = trade["trade_id"]
        checks += 1
        if tid in seen_ids:
            violate("duplicate_trade", trade_id=tid)
        seen_ids.add(tid)
        gross, fees = _gross(trade), _fees(trade)
        funding = D(str(trade["funding_usd"])) if trade["funding_usd"] is not None else D(0)
        if abs(gross - fees - funding - D(str(trade["pnl_usd"]))) > USD_TOLERANCE:
            violate("trade_identity", trade_id=tid, gross=gross, fees=fees, funding=funding, pnl=trade["pnl_usd"])
        if abs(fees - D(str(trade["fees_usd"]))) > USD_TOLERANCE:
            violate("trade_identity", trade_id=tid, part="fees_charged_once", fees=fees, stored=trade["fees_usd"])
        details = p.trade_details.get(tid)
        if details is None:
            violate("trade_details_missing", trade_id=tid)
            continue
        reference = D(details["entry_reference_price"])
        if abs(D(trade["entry_price"]) - entry_fill(reference, trade["side"], trade["product_id"])) > PRICE_TOLERANCE * reference:
            violate("entry_price_model", trade_id=tid, entry=trade["entry_price"], reference=reference)
        if int(trade["exit_time_ms"]) < int(trade["entry_time_ms"]):
            violate("exit_before_entry", trade_id=tid)
        if trade["exit_reason"] == "stop":
            side, q = trade["side"], D(trade["quantity"])
            planned_exit = _planned_stop_exit(p, trade)
            exit_ = D(trade["exit_price"])
            worse_or_equal = exit_ <= planned_exit + PRICE_TOLERANCE * planned_exit if side == "LONG" \
                else exit_ >= planned_exit - PRICE_TOLERANCE * planned_exit
            if not worse_or_equal:
                violate("exit_not_better_than_plan", trade_id=tid, exit=exit_, planned_exit=planned_exit)
            realized_loss = -(gross - fees)
            planned_loss = D(str(trade["planned_loss_usd"]))
            if realized_loss < planned_loss - USD_TOLERANCE:
                violate("exit_not_better_than_plan", trade_id=tid, part="loss_smaller_than_plan",
                        realized=realized_loss, planned=planned_loss)
            # realized net loss - planned = price effect + fee effect + funding (exact up to the stored rounding)
            price_effect = (planned_exit - exit_) * q if side == "LONG" else (exit_ - planned_exit) * q
            planned_fees = (D(trade["entry_price"]) + planned_exit) * q * fee_rate("taker")
            fee_effect = fees - planned_fees
            net_loss_without_funding = realized_loss
            expected = planned_loss + price_effect + fee_effect
            if abs(net_loss_without_funding - expected) > D("0.002"):
                violate("loss_vs_plan_decomposition", trade_id=tid, realized=net_loss_without_funding, expected=expected)
            stop_exit = trade.get("stop_exit")
            if stop_exit is not None:
                stop = D(stop_exit["stop_level"])
                if stop != D(trade["stop_price"]) or D(stop_exit["executable_price"]) != exit_:
                    violate("stop_exit_fields", trade_id=tid)
                adverse = (stop - exit_) / stop * 10_000 if side == "LONG" else (exit_ - stop) / stop * 10_000
                if abs(D(stop_exit["slippage_bps"]) - adverse) > D("0.001"):
                    violate("stop_exit_fields", trade_id=tid, part="slippage_bps", recorded=stop_exit["slippage_bps"], recomputed=adverse)
                if stop_exit["quote_backed"] and stop_exit.get("quote_time_ms") is not None \
                        and int(stop_exit["quote_time_ms"]) <= int(trade["entry_time_ms"]):
                    violate("quote_before_entry", trade_id=tid)
                if not stop_exit["quote_backed"] and not stop_exit["estimated"]:
                    violate("stop_exit_fields", trade_id=tid, part="estimate_not_labelled")

    # ---- capital ---------------------------------------------------------------------------------------------
    checks += 1
    contributions = sum((p.contribution(t) for t in p.trades), D(0))
    if p.capital_usd() != initial + contributions:
        violate("capital_recomputed", capital=p.capital_usd(), recomputed=initial + contributions)
    logged = sum((D(e["delta_usd"]) for e in p.capital_log), D(0))
    if initial + logged != p.capital_usd():
        violate("capital_log_sum", capital=p.capital_usd(), log=initial + logged)
    broken = _chain_ok(p.capital_log)
    if broken is not None:
        violate("capital_log_chain", seq=broken)
    running = initial
    per_trade, closes = {}, {}
    for event in p.capital_log:
        if D(event["capital_before_usd"]) != running:
            violate("capital_log_continuity", seq=event["seq"], expected=running, before=event["capital_before_usd"])
        running = D(event["capital_after_usd"])
        if running - D(event["capital_before_usd"]) != D(event["delta_usd"]):
            violate("capital_log_delta", seq=event["seq"])
        per_trade[event["trade_id"]] = per_trade.get(event["trade_id"], D(0)) + D(event["delta_usd"])
        if event["kind"] == "trade_closed":
            if event["trade_id"] in closes:
                violate("duplicate_capital_event", trade_id=event["trade_id"])
            closes[event["trade_id"]] = event
    if running != p.capital_usd():
        violate("capital_log_end", expected=p.capital_usd(), last_after=running)
    for trade in p.trades:
        checks += 1
        if per_trade.get(trade["trade_id"], D(0)) != p.contribution(trade):
            violate("capital_events_per_trade", trade_id=trade["trade_id"], events=per_trade.get(trade["trade_id"]),
                    contribution=p.contribution(trade))
        if not p.reliable(trade) and D(str(trade["pnl_usd"])) > 0 and p.contribution(trade) != 0:
            violate("provisional_gain_counted", trade_id=trade["trade_id"])
        notes = p.trade_details[trade["trade_id"]]["notes"]
        flags = p.review_flags.get(trade["trade_id"], ())
        if bool(notes.get("entry_minute_unresolved")) != bool(trade.get("execution_unresolved")) \
                or (trade.get("execution_unresolved") and "entry_minute_unresolved" not in flags):
            violate("unresolved_execution_not_marked", trade_id=trade["trade_id"])
        if notes.get("funding_conflict") and "funding_conflict" not in flags:
            violate("funding_dispute_lost", trade_id=trade["trade_id"])
        # the dispute is checked against the quarantined periods themselves, not against the marks it left behind
        overlapping = sorted([list(c) for c in p.funding_conflicts.get(trade["product_id"], ())
                              if min(int(c[1]), int(trade["exit_time_ms"])) > max(int(c[0]), int(trade["entry_time_ms"]))])
        recorded = sorted(p.funding_disputes.get(trade["trade_id"], ()))
        if overlapping and trade["trade_id"] not in p.funding_disputes:
            violate("funding_dispute_omitted", trade_id=trade["trade_id"], quarantined=overlapping)
        elif overlapping != recorded:
            violate("funding_dispute_mismatch", trade_id=trade["trade_id"], quarantined=overlapping, recorded=recorded)
        if overlapping and (p.contribution(trade) > min(D(0), D(str(trade["pnl_usd"])))):
            violate("disputed_gain_counted", trade_id=trade["trade_id"])
        if trade.get("execution_unresolved"):
            warnings.append({"rule": "economically_unresolved_execution", "trade_id": trade["trade_id"],
                             "simulated_pnl_usd": str(trade["pnl_usd"]), "counted_in_capital_usd": str(p.contribution(trade))})
        if notes.get("funding_conflict"):
            warnings.append({"rule": "funding_disputed", "trade_id": trade["trade_id"], "periods": notes["funding_conflict"],
                             "simulated_pnl_usd": str(trade["pnl_usd"]), "counted_in_capital_usd": str(p.contribution(trade))})
    snapshot = p.snapshot()
    if D(snapshot["capital_definitive_usd"]) > D(snapshot["equity_usd"]) - D(snapshot["provisional_gains_usd"]) + D("0.000001"):
        violate("provisional_gains_never_spendable")

    # ---- adjustments and funding ------------------------------------------------------------------------------
    broken = _chain_ok(p.reclassifications)
    if broken is not None:
        violate("reclassification_chain", seq=broken)
    for record in p.reclassifications:
        checks += 1
        events = [e for e in p.capital_log if e["trade_id"] == record["trade_id"] and e["kind"] == "funding_dispute_reclassified"]
        delta = D(record["delta_capital_usd"])
        if (len(events) != 1 or D(events[0]["delta_usd"]) != delta or events[0]["t_ms"] != record["at_ms"]) if delta != 0 else bool(events):
            violate("reclassification_without_capital_event", trade_id=record["trade_id"], seq=record["seq"])
        if D(record["capital_after_usd"]) - D(record["capital_before_usd"]) != delta:
            violate("reclassification_delta", trade_id=record["trade_id"], seq=record["seq"])
    broken = _chain_ok(p.adjustments)
    if broken is not None:
        violate("adjustment_chain", seq=broken)
    broken = _chain_ok(p.funding_log)
    if broken is not None:
        violate("funding_log_chain", seq=broken)
    by_trade = {}
    for record in p.adjustments:
        by_trade.setdefault(record["trade_id"], []).append(record)
    trades_by_id = {t["trade_id"]: t for t in p.trades}
    for tid, records in by_trade.items():
        checks += 1
        trade = trades_by_id.get(tid)
        if trade is None:
            violate("adjustment_unknown_trade", trade_id=tid)
            continue
        state = p.trade_details[tid]["as_closed"]
        for record in records:
            if record["before"] != state:
                violate("adjustment_chain_state", trade_id=tid, seq=record["seq"])
            if record["after"]["funding_covered_ms"] <= record["before"]["funding_covered_ms"]:
                violate("adjustment_without_new_coverage", trade_id=tid, seq=record["seq"])
            became_definitive = record["after"]["net_complete"] and not record["before"]["net_complete"]
            if became_definitive != (record["transition"] == "provisional_to_definitive"):
                violate("transition_not_explicit", trade_id=tid, seq=record["seq"], transition=record["transition"])
            state = record["after"]
        if state != {k: trade[k] for k in p.CLOSED_FIELDS}:
            violate("adjustment_end_state", trade_id=tid)
    for trade in p.trades:
        checks += 1
        original = p.trade_details[trade["trade_id"]]["as_closed"]
        if trade["trade_id"] not in by_trade and original != {k: trade[k] for k in p.CLOSED_FIELDS}:
            violate("trade_changed_without_adjustment", trade_id=trade["trade_id"])
        if trade["net_complete"] and not original["net_complete"] and trade["trade_id"] not in by_trade:
            violate("transition_not_explicit", trade_id=trade["trade_id"])
        recount = _recount(trade, p.funding.get(trade["product_id"], ()))
        funding = D(str(trade["funding_usd"])) if trade["funding_usd"] is not None else D(0)
        if recount["covered"] == int(trade["funding_covered_ms"]):
            if abs(recount["funding"] - funding) > D("0.000002"):
                violate("funding_recount", trade_id=trade["trade_id"], recounted=recount["funding"], stored=funding)
        elif recount["covered"] > int(trade["funding_covered_ms"]):
            warnings.append({"rule": "reconciliation_pending", "trade_id": trade["trade_id"],
                             "covered_ms": int(trade["funding_covered_ms"]), "available_ms": int(recount["covered"])})
        else:
            violate("funding_covers_more_than_accepted", trade_id=trade["trade_id"])
        if trade["funding_complete"] and int(trade["funding_covered_ms"]) < int(trade["funding_held_ms"]) \
                and int(trade["exit_time_ms"]) > int(trade["entry_time_ms"]):
            violate("complete_without_full_coverage", trade_id=trade["trade_id"])

    # ---- decisions ---------------------------------------------------------------------------------------------
    for decision in p.decisions:
        if decision["status"] != "opened":
            continue
        checks += 1
        capital = D(decision["capital_definitive_usd"])
        if D(decision["risk_budget_used_usd"]) != capital * D(policy.risk_per_trade):
            violate("risk_budget_recomputed", decision_id=decision["decision_id"])
        if D(decision["planned_loss_usd"]) > D(decision["risk_budget_used_usd"]) + D("0.000001"):
            violate("planned_loss_within_budget", decision_id=decision["decision_id"])
        at = int(decision["decided_ms"])
        day, lost, run, peak, drawdown = at // DAY_MS, D(0), D(0), D(0), D(0)
        for event in p.capital_log:
            if event["t_ms"] > at:
                continue
            delta = D(event["delta_usd"])
            if event["t_ms"] // DAY_MS == day:
                lost += delta
            run += delta
            peak = max(peak, run)
            drawdown = max(drawdown, peak - run)
        if lost <= -D(policy.daily_loss_limit_usd) or drawdown >= D(policy.max_drawdown_usd):
            violate("no_entry_while_suspended", decision_id=decision["decision_id"], lost_today=lost, drawdown=drawdown)
    return {"violations": violations, "warnings": warnings, "checks": checks}


# ------------------------------------------------------------------------------------------------ reconstruction
def trade_reconstruction(portfolio, trade):
    """Everything needed to rebuild one closed trade, from the trade, its details and the logs."""
    p = portfolio
    tid = trade["trade_id"]
    details = p.trade_details[tid]
    fill = details["fill"] or {}
    side, q, product = trade["side"], D(trade["quantity"]), trade["product_id"]
    entry, exit_ = D(trade["entry_price"]), D(trade["exit_price"])
    ref_entry = D(details["entry_reference_price"])
    ref_exit = D(fill["reference_price"]) if fill.get("reference_price") is not None else exit_
    sign = 1 if side == "LONG" else -1
    gross, fees = _gross(trade), _fees(trade)
    planned_exit = _planned_stop_exit(p, trade)
    funding = D(str(trade["funding_usd"])) if trade["funding_usd"] is not None else None
    events = [e for e in p.capital_log if e["trade_id"] == tid]
    close_event = next(e for e in events if e["kind"] == "trade_closed")
    stop_exit = trade.get("stop_exit")
    evidence = fill.get("evidence")
    basis = exit_basis(trade)
    flags = list(p.review_flags.get(tid, ()))
    return {
        "trade_id": tid, "intent_id": trade["intent_id"], "product_id": product, "strategy_id": trade["strategy_id"],
        "side": side,
        "entry": {"time_ms": trade["entry_time_ms"], "price": trade["entry_price"], "reference_price": str(ref_entry),
                  "cost_usd": str((entry - ref_entry) * q * sign)},
        "levels": {"stop": trade["stop_price"], "target": trade["target_price"]},
        "exit": {"time_ms": trade["exit_time_ms"], "price": trade["exit_price"], "reason": trade["exit_reason"],
                 "reference_price": str(ref_exit), "evidence": evidence, "basis": basis,
                 "cost_usd": str((ref_exit - exit_) * q * sign)},
        "stop_exit": stop_exit,
        "plan": {"planned_loss_usd": str(trade["planned_loss_usd"]), "planned_stop_exit_price": str(planned_exit)},
        "result": {
            "realized_loss_usd": str(max(D(0), -D(str(trade["pnl_usd"])))), "pnl_gross_usd": str(gross),
            "fees_usd": str(fees), "funding_usd": None if funding is None else str(funding),
            "funding_status": trade["funding_status"], "funding_covered_ms": trade["funding_covered_ms"],
            "funding_held_ms": trade["funding_held_ms"], "pnl_net_usd": str(trade["pnl_usd"]),
            "net_complete": trade["net_complete"],
            "modelled_spread_bps": str(spread_bps(product)), "modelled_impact_bps": str(side_impact_bps(product))},
        "capital": {"before_usd": close_event["capital_before_usd"], "after_usd": close_event["capital_after_usd"],
                    "events": [{"kind": e["kind"], "t_ms": e["t_ms"], "delta_usd": e["delta_usd"],
                                "before_usd": e["capital_before_usd"], "after_usd": e["capital_after_usd"]} for e in events]},
        "as_closed": details["as_closed"],
        "adjustments": [{"seq": a["seq"], "at_ms": a["at_ms"], "transition": a["transition"],
                         "delta_pnl_usd": a["delta_pnl_usd"], "periods_sha256": a["periods_sha256"]}
                        for a in p.adjustments if a["trade_id"] == tid],
        "entry_window": details["notes"].get("entry_window"), "review_flags": flags,
    }


def planned_vs_realized(portfolio):
    """One row per closed trade: the planned loss against what was booked, with the reason for the difference."""
    p, rows = portfolio, []
    for trade in p.trades:
        tid = trade["trade_id"]
        side, q = trade["side"], D(trade["quantity"])
        planned = D(str(trade["planned_loss_usd"]))
        planned_exit = _planned_stop_exit(p, trade)
        exit_ = D(trade["exit_price"])
        pnl = D(str(trade["pnl_usd"]))
        funding = D(str(trade["funding_usd"])) if trade["funding_usd"] is not None else D(0)
        row = {"trade_id": tid, "product_id": trade["product_id"], "side": side, "exit_reason": trade["exit_reason"],
               "planned_loss_usd": str(round(planned, 4)), "pnl_net_usd": str(round(pnl, 4)),
               "net_complete": trade["net_complete"]}
        if trade["exit_reason"] == "stop":
            price_effect = (planned_exit - exit_) * q if side == "LONG" else (exit_ - planned_exit) * q
            planned_fees = (D(trade["entry_price"]) + planned_exit) * q * fee_rate("taker")
            realized = -pnl
            row.update(realized_loss_usd=str(round(realized, 4)), excess_usd=str(round(realized - planned, 4)),
                       price_effect_usd=str(round(price_effect, 4)), fee_effect_usd=str(round(_fees(trade) - planned_fees, 4)),
                       funding_usd=str(round(funding, 4)),
                       basis=exit_basis(trade))
        rows.append(row)
    return rows


def accounting_digest(portfolio):
    """Canonical digest of the financial state: trades, capital log, adjustments, accepted funding periods, quarantine,
    review flags, trade details and decisions. The funding intake log is *not* in it (it records every delivery, so it
    grows when the same funding is delivered again); ``intake_digest`` covers it. A repeated delivery or reconciliation
    must leave ``accounting_digest`` unchanged."""
    p = portfolio
    return stable_hash({
        "trades": p.trades, "capital_log": p.capital_log, "adjustments": p.adjustments,
        "funding": {k: [[a, b, str(r)] for a, b, r in v] for k, v in sorted(p.funding.items())},
        "conflicts": p.funding_conflicts, "flags": p.review_flags, "disputes": p.funding_disputes,
        "reclassifications": p.reclassifications,
        "details": {k: p.trade_details[k] for k in sorted(p.trade_details)}, "decisions": p.decisions})


def intake_digest(portfolio):
    """Digest of the funding intake log: every period accepted, duplicated, conflicting or rejected, in order."""
    return stable_hash(portfolio.funding_log)
