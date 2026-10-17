"""Stage 7 scenarios: accounting and risk under adverse conditions (synthetic, deterministic, offline, isolated).

Every scenario builds its own ``Portfolio`` (approved ``PortfolioPolicy``, nothing changed) and feeds it invented
candles and quotes. The scenarios exercise what stage 7 adds to the shared engine:

* stops the market gapped through (``Book(stop_policy=...)``), LONG and SHORT, with the price evidence;
* positions watched with quotes during the minute of entry (``portfolio_watch.QuoteWatch``);
* losses larger than planned, the sizing of the next trade, the daily-loss and drawdown suspensions;
* late funding (``portfolio_funding``): partial and complete coverage, duplicates, contradictions, restarts;
* duplicated and out-of-order events.

The results are byte-identical on every run (no clock, no randomness, no environment). Not connected to the
forward, ``capture``, Kronos, Qwen or any database; no holdout data.
"""

import pickle
from decimal import Decimal

from .portfolio import LONG, SHORT, Portfolio, PortfolioPolicy, make_intent
from .portfolio_audit import accounting_digest, audit, intake_digest, planned_vs_realized, trade_reconstruction
from .portfolio_funding import ingest_funding, reconcile_funding
from .portfolio_watch import QuoteWatch, WatchPolicy

D = Decimal
SEC, MIN, HOUR, DAY = 1_000, 60_000, 3_600_000, 86_400_000
DAY0 = 1_700_006_400_000          # 2023-11-15 00:00:00 UTC, a day boundary
BTC, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
PRICES = {BTC: "100000", ETH: "3500", SOL: "180"}
SCHEMA = "balancita-stage7.v1"


def approved_policy():
    """The approved parameters, untouched: no scenario changes a limit."""
    return PortfolioPolicy()


def full_funding(rate="0"):
    return {p: [(DAY0 - 6 * HOUR, DAY0 + 30 * DAY, rate)] for p in PRICES}


def new_portfolio(stop_policy="gap_open", funding="full"):
    return Portfolio(approved_policy(), funding=full_funding() if funding == "full" else funding, stop_policy=stop_policy)


def intent(product, side, decided_ms, *, stop_pct="0.02", target_pct="0.03", strategy="s7", strength="0.8",
           horizon=720, price=None):
    """An intent for a decision at ``decided_ms`` (a minute boundary): the signal candle is the minute before it."""
    price = D(price or PRICES[product])
    sign = 1 if side == LONG else -1
    return make_intent(strategy_id=strategy, product_id=product, side=side, strength=strength,
                       bucket_ms=decided_ms - MIN, price=price, stop=price * (1 - sign * D(stop_pct)),
                       target=price * (1 + sign * D(target_pct)), horizon_minutes=horizon)


def candle(o, h, l, c):   # noqa: E741
    return {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}


def quote(product, t, mid, *, half_bps="0.5", received=None):
    mid, half = D(str(mid)), D(half_bps) / D(10_000)
    return {"product_id": product, "time_ms": t, "received_ms": t if received is None else received,
            "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}


def open_timed(pf, product, side, entry_ms, *, stop_pct="0.02", target_pct="0.03", strategy="s7", price=None):
    """Opens a position at ``entry_ms`` exactly as ``execution_timing`` does after the first usable quote: the entry
    instant is kept, the position opens on the next minute boundary and never sees the candle of the entry minute."""
    entry_bucket = -(-entry_ms // MIN) * MIN - MIN
    base = intent(product, side, entry_bucket, stop_pct=stop_pct, target_pct=target_pct, strategy=strategy, price=price)
    executable = dict(base, entry_bucket_ms=entry_bucket, entry_ms=entry_ms)
    [record] = pf.decide([executable], entry_ms)
    return record


def short_trade(t):
    keys = ("trade_id", "product_id", "side", "exit_reason", "entry_time_ms", "exit_time_ms", "entry_price", "exit_price",
            "stop_price", "planned_loss_usd", "pnl_usd", "fees_usd", "funding_usd", "funding_status", "net_complete")
    return {k: t[k] for k in keys}


def summary(pf, now_ms):
    result = audit(pf)
    return {"capital_usd": str(pf.capital_usd()), "equity_usd": str(pf.equity_usd()),
            "provisional_gains_usd": str(pf.provisional_gains_usd()), "risk_budget_usd": str(pf.risk_budget_usd()),
            "drawdown_usd": str(pf.drawdown_usd()), "realized_today_usd": str(pf.realized_today_usd(now_ms)),
            "suspension": pf.suspension_state(now_ms), "open_positions": len(pf.positions),
            "closed_trades": len(pf.trades), "adjustments": len(pf.adjustments),
            "audit": {"checks": result["checks"], "violations": result["violations"], "warnings": result["warnings"]},
            "accounting_digest": accounting_digest(pf)}


def result(sid, title, pf, now_ms, **facts):
    return {"id": sid, "title": title, "summary": summary(pf, now_ms), "facts": facts,
            "trades": [short_trade(t) for t in pf.trades], "planned_vs_realized": planned_vs_realized(pf),
            "ledger_hash": pf.ledger_hash()}


# ------------------------------------------------------------------------------------------------ gaps (OHLC)
T10 = DAY0 + 10 * HOUR     # decision time of most scenarios: 10:00 UTC


def _gap_run(side, policy, *, last_close, gap_open, gap_low, gap_high):
    """One position, one quiet candle (last observed price still on the right side of the stop), one gapping candle."""
    pf = new_portfolio(stop_policy=policy)
    [record] = pf.decide([intent(BTC, side, T10)], T10)
    assert record["status"] == "opened", record
    pf.on_candle(BTC, T10, candle(100000, last_close[1], last_close[2], last_close[0]))
    closed = pf.on_candle(BTC, T10 + MIN, candle(gap_open, gap_high, gap_low, gap_open))
    assert len(closed) == 1, closed
    return pf, record, closed[0]


def gap_long():
    """LONG 100 000, stop 98 000, last observed 98 200, next candle opens at 97 000 (it never traded at the stop)."""
    rows, kept = {}, None
    for policy in ("level", "gap_open", "gap_worst"):
        pf, record, trade = _gap_run(LONG, policy, last_close=("98200", "100100", "98200"), gap_open="96950",
                                     gap_low="96800", gap_high="97200")
        rows[policy] = {"exit_price": trade["exit_price"], "pnl_usd": str(trade["pnl_usd"]),
                        "stop_exit": trade.get("stop_exit")}
        if policy == "gap_open":
            kept = pf
    trade = kept.trades[0]
    return result("s01_gap_long", "LONG que atraviesa su stop con un gap", kept, T10 + 2 * MIN,
                  by_policy=rows, planned_loss_usd=trade["planned_loss_usd"], realized_loss_usd=str(-D(str(trade["pnl_usd"]))),
                  reconstruction=trade_reconstruction(kept, trade))


def gap_short():
    rows, kept = {}, None
    for policy in ("level", "gap_open", "gap_worst"):
        pf, record, trade = _gap_run(SHORT, policy, last_close=("101800", "101800", "99900"), gap_open="103050",
                                     gap_low="102800", gap_high="103200")
        rows[policy] = {"exit_price": trade["exit_price"], "pnl_usd": str(trade["pnl_usd"]),
                        "stop_exit": trade.get("stop_exit")}
        if policy == "gap_open":
            kept = pf
    trade = kept.trades[0]
    return result("s02_gap_short", "SHORT que atraviesa su stop con un gap", kept, T10 + 2 * MIN,
                  by_policy=rows, planned_loss_usd=trade["planned_loss_usd"], realized_loss_usd=str(-D(str(trade["pnl_usd"]))),
                  reconstruction=trade_reconstruction(kept, trade))


def stop_without_gap():
    """The candle opens above the stop and trades down through it: no gap, the stop executes at its level plus cost."""
    rows, kept = {}, None
    for policy in ("level", "gap_open", "gap_worst"):
        pf = new_portfolio(stop_policy=policy)
        pf.decide([intent(BTC, LONG, T10)], T10)
        trade = pf.on_candle(BTC, T10, candle(100000, 100200, 99800, 100000))
        [trade] = pf.on_candle(BTC, T10 + MIN, candle(99500, 99600, 97900, 98100))
        rows[policy] = {"exit_price": trade["exit_price"], "pnl_usd": str(trade["pnl_usd"]),
                        "stop_exit": trade.get("stop_exit")}
        if policy == "gap_open":
            kept = pf
    trade = kept.trades[0]
    return result("s03_stop_sin_gap", "Stop alcanzado sin gap", kept, T10 + 2 * MIN, by_policy=rows,
                  planned_loss_usd=trade["planned_loss_usd"], realized_loss_usd=str(-D(str(trade["pnl_usd"]))))


# ------------------------------------------------------------------------------------------------ entry minute
NOON = DAY0 + 12 * HOUR
ENTRY = NOON + 10 * SEC          # 12:00:10, mid-minute


def entry_minute_spike():
    """LONG entered at 12:00:10; at 12:00:25 the market goes through the stop; the candle closes at 12:01:00."""
    pf = new_portfolio()
    watch = QuoteWatch(pf, WatchPolicy())
    record = open_timed(pf, BTC, LONG, ENTRY)
    assert record["status"] == "opened", record
    log = []
    log.append(("quote_12:00:15", [t["trade_id"] for t in watch.on_quote(quote(BTC, NOON + 15 * SEC, 99800))]))
    closed = watch.on_quote(quote(BTC, NOON + 25 * SEC, 97800))
    log.append(("quote_12:00:25_breach", [t["trade_id"] for t in closed]))
    # the candle of the entry minute arrives at 12:01:00 and the next ones keep coming: nothing may close again
    log.append(("candle_12:00", len(watch.on_candle(BTC, NOON, candle(100000, 100050, 97700, 97900)))))
    log.append(("candle_12:01", len(watch.on_candle(BTC, NOON + MIN, candle(97900, 98000, 97600, 97700)))))
    trade = pf.trades[0]
    # control: the same market without quote watching (the stage 6 behaviour): the stop waits for the 12:01 candle
    ctl = new_portfolio()
    open_timed(ctl, BTC, LONG, ENTRY)
    ctl_watch = QuoteWatch(ctl, WatchPolicy())
    ctl_watch.on_candle(BTC, NOON, candle(100000, 100050, 97700, 97900))
    [ctl_trade] = ctl_watch.on_candle(BTC, NOON + MIN, candle(97500, 97900, 97400, 97600))
    return result("s04_minuto_de_entrada", "Movimiento brusco durante el minuto de entrada", pf, NOON + 2 * MIN,
                  events=log, watch_events=watch.events,
                  entry_to_exit_seconds=(trade["exit_time_ms"] - ENTRY) // SEC,
                  quote_backed=trade["stop_exit"]["quote_backed"], exit_time_ms=trade["exit_time_ms"],
                  exit_price=trade["exit_price"], loss_usd=str(-D(str(trade["pnl_usd"]))),
                  control_without_quotes={"exit_time_ms": ctl_trade["exit_time_ms"], "exit_price": ctl_trade["exit_price"],
                                          "evidence": ctl_trade["stop_exit"]["evidence"],
                                          "loss_usd": str(-D(str(ctl_trade["pnl_usd"])))},
                  reconstruction=trade_reconstruction(pf, trade))


def quotes_missing():
    """The entry window cannot be resolved: no quotes, too few, and candles without an open."""
    out = {}

    def run(label, policy, quotes, *, entry_candle, next_candle, stop_policy="gap_open"):
        pf = new_portfolio(stop_policy=stop_policy)
        watch = QuoteWatch(pf, WatchPolicy(unresolved_entry_minute=policy))
        open_timed(pf, BTC, LONG, ENTRY)
        for q in quotes:
            watch.on_quote(q)
        watch.on_candle(BTC, NOON, entry_candle)
        watch.on_candle(BTC, NOON + MIN, next_candle)
        trade = pf.trades[0] if pf.trades else None
        notes = None
        details = None
        if pf.trade_details:
            details = next(iter(pf.trade_details.values()))
            notes = details["notes"]
        out[label] = {
            "policy": policy, "closed": trade is not None,
            "exit_reason": trade["exit_reason"] if trade else None,
            "exit_time_ms": trade["exit_time_ms"] if trade else None,
            "exit_price": trade["exit_price"] if trade else None,
            "evidence": (trade.get("stop_exit") or {}).get("evidence") if trade else None,
            "estimated": (trade.get("stop_exit") or {}).get("estimated") if trade else None,
            "entry_window": notes.get("entry_window") if notes else None,
            "review_flags": sorted(pf.review_flags.get(trade["trade_id"], [])) if trade else [],
            "loss_usd": str(-D(str(trade["pnl_usd"]))) if trade else None,
            "open_position_notes": {k: v for k, v in sorted(pf.position_notes.items())},
            "audit_violations": len(audit(pf)["violations"]),
            "reconstruction": trade_reconstruction(pf, trade) if trade else None}
        return pf

    touched = candle(100000, 100050, 97500, 97950)      # the entry-minute range touched the stop (98 000)
    after = candle(97900, 98050, 97800, 98000)          # the next candle opens beyond the stop
    run("sin_cotizaciones_flag", "flag", [], entry_candle=touched, next_candle=after)
    run("sin_cotizaciones_stop", "stop", [], entry_candle=touched, next_candle=after)
    run("una_cotizacion_flag", "flag", [quote(BTC, NOON + 12 * SEC, 99900)], entry_candle=touched, next_candle=after)
    dense = [quote(BTC, ENTRY + k * 5 * SEC, 99900) for k in range(1, 10)]
    run("cobertura_completa_sin_ruptura", "flag", dense, entry_candle=touched, next_candle=candle(99900, 99950, 99800, 99900))
    no_open = {"high": "98050", "low": "97800", "close": "98000"}
    pf = run("vela_sin_apertura", "flag", [], entry_candle=candle(100000, 100050, 99800, 99900),
             next_candle=no_open)
    return result("s05_cotizaciones_insuficientes", "Cotizaciones ausentes o insuficientes", pf, NOON + 2 * MIN, cases=out)


# ------------------------------------------------------------------------------------------------ losses beyond plan
def loss_beyond_plan():
    """Plans to lose 10, a gap loses 15; the capital, the next budget and the drawdown follow the real loss."""
    pf = new_portfolio()
    [a] = pf.decide([intent(BTC, LONG, T10)], T10)
    before = {"capital": str(pf.capital_usd()), "risk_budget": str(pf.risk_budget_usd())}
    pf.on_candle(BTC, T10, candle(100000, 100100, 98200, 98200))
    [trade] = pf.on_candle(BTC, T10 + MIN, candle(96950, 97200, 96800, 97100))
    after = {"capital": str(pf.capital_usd()), "risk_budget": str(pf.risk_budget_usd()), "drawdown": str(pf.drawdown_usd())}
    [b] = pf.decide([intent(ETH, LONG, T10 + 2 * MIN, strategy="s7b")], T10 + 2 * MIN)
    return result("s06_perdida_superior_a_la_planificada", "Pérdida superior a la planificada", pf, T10 + 2 * MIN,
                  planned_loss_usd=trade["planned_loss_usd"], realized_loss_usd=str(-D(str(trade["pnl_usd"]))),
                  excess_usd=str(-D(str(trade["pnl_usd"])) - D(str(trade["planned_loss_usd"]))),
                  before_loss=before, after_loss=after, next_trade={
                      "status": b["status"], "risk_budget_used_usd": b["risk_budget_used_usd"],
                      "capital_definitive_usd": b["capital_definitive_usd"], "planned_loss_usd": b["planned_loss_usd"],
                      "limits_applied": b["limits_applied"]},
                  capital_log=pf.capital_log)


def daily_loss_suspension():
    """A gap loses 21 against a plan of 10 and the daily limit is 20: new entries stop, a close still goes through."""
    pf = new_portfolio()
    pf.decide([intent(BTC, LONG, T10), intent(ETH, LONG, T10, strategy="s7e")], T10)
    assert len(pf.positions) == 2
    pf.on_candle(BTC, T10, candle(100000, 100100, 98200, 98200))
    pf.on_candle(ETH, T10, candle(3500, 3510, 3440, 3450))
    [btc] = pf.on_candle(BTC, T10 + MIN, candle(95700, 95900, 95500, 95800))
    after_gap = pf.suspension_state(T10 + 2 * MIN)
    rejected_while_suspended = pf.decide([intent(SOL, LONG, T10 + 2 * MIN, strategy="s7x")], T10 + 2 * MIN)[0]
    # the other position, opened before the suspension, is still managed and closes through its own stop
    [eth] = pf.on_candle(ETH, T10 + 3 * MIN, candle(3440, 3445, 3380, 3400))
    after_second = pf.suspension_state(T10 + 4 * MIN)
    rejected_again = pf.decide([intent(SOL, LONG, T10 + 4 * MIN, strategy="s7x2")], T10 + 4 * MIN)[0]
    next_day = DAY0 + DAY + 10 * HOUR
    allowed = pf.decide([intent(SOL, LONG, next_day, strategy="s7x3")], next_day)[0]
    return result("s07_suspension_por_perdida_diaria", "Suspensión por pérdida diaria", pf, next_day,
                  first_loss={"planned": btc["planned_loss_usd"], "realized": str(-D(str(btc["pnl_usd"])))},
                  second_loss={"planned": eth["planned_loss_usd"], "realized": str(-D(str(eth["pnl_usd"])))},
                  suspension_after_gap=after_gap, suspension_after_second=after_second,
                  rejected_while_suspended=rejected_while_suspended["reasons"], rejected_again=rejected_again["reasons"],
                  close_while_suspended=eth["exit_reason"], next_utc_day=allowed["status"],
                  realized_today_usd_at_suspension=str(pf.realized_today_usd(T10 + 2 * MIN)))


def drawdown_suspension():
    """Four gap losses on four days, each below the daily limit, add up to a drawdown above the limit of 60."""
    pf = new_portfolio()
    states = []
    for day in range(4):
        t = DAY0 + day * DAY + 10 * HOUR
        pf.decide([intent(BTC, LONG, t)], t)
        pf.on_candle(BTC, t, candle(100000, 100100, 98200, 98200))
        [trade] = pf.on_candle(BTC, t + MIN, candle(96600, 96800, 96400, 96700))
        states.append({"day": day + 1, "planned": trade["planned_loss_usd"], "realized": str(-D(str(trade["pnl_usd"]))),
                       "drawdown": str(pf.drawdown_usd()), "suspension": pf.suspension_state(t + 2 * MIN)})
    t = DAY0 + 4 * DAY + 10 * HOUR
    rejected = pf.decide([intent(BTC, LONG, t)], t)[0]
    return result("s08_suspension_por_drawdown", "Suspensión por drawdown", pf, t, days=states,
                  rejected=rejected["reasons"], suspension=pf.suspension_state(t))


# ------------------------------------------------------------------------------------------------ late funding
FR = "0.002"                      # relative funding per hour, longs pay: about 1 USD per hour on 500 USD
T8 = DAY0 + 8 * HOUR


def hourly(first_hour_start, hours, rate=FR):
    return [(first_hour_start + k * HOUR, first_hour_start + (k + 1) * HOUR, rate) for k in range(hours)]


def _funding_portfolio():
    """BTC funding known only up to T8 + 1 h and ETH funding not known at all: every trade closes provisional."""
    return new_portfolio(funding={BTC: hourly(T8 - HOUR, 2), ETH: []})


def _brief(adjustments):
    return [{"trade_id": a["trade_id"], "seq": a["seq"], "transition": a["transition"], "coverage": a["coverage"],
             "delta_pnl_usd": a["delta_pnl_usd"], "delta_capital_usd": a["delta_capital_usd"],
             "capital_before_usd": a["capital_before_usd"], "capital_after_usd": a["capital_after_usd"],
             "risk_budget_before_usd": a["risk_budget_before_usd"], "risk_budget_after_usd": a["risk_budget_after_usd"],
             "drawdown_before_usd": a["drawdown_before_usd"], "drawdown_after_usd": a["drawdown_after_usd"],
             "decisions_not_revised": a["decisions_not_revised"]} for a in adjustments]


def _provisional_trades(pf):
    """A winning BTC LONG held three hours (target) and a losing ETH LONG (stop), both closed with incomplete funding."""
    pf.decide([intent(BTC, LONG, T8, target_pct="0.01"), intent(ETH, LONG, T8, strategy="s7e")], T8)
    pf.on_candle(BTC, T8, candle(100000, 100100, 99900, 100050))
    pf.on_candle(ETH, T8, candle(3500, 3510, 3490, 3500))
    [loss] = pf.on_candle(ETH, T8 + 30 * MIN, candle(3450, 3460, 3400, 3420))
    [gain] = pf.on_candle(BTC, T8 + 3 * HOUR, candle(100500, 101500, 100400, 101200))
    return gain, loss


def _open_after_close(pf):
    """A decision taken on the provisional capital, before any reconciliation: it must never be revised by one."""
    t = T8 + 3 * HOUR + 2 * MIN
    [record] = pf.decide([intent(SOL, LONG, t, strategy="s7s")], t)
    return record


def funding_late_complete():
    pf = _funding_portfolio()
    gain, loss = _provisional_trades(pf)
    later = _open_after_close(pf)
    stages = [("cerradas_con_funding_incompleto", summary(pf, T8 + 4 * HOUR))]
    stages[0][1].pop("audit")
    log = {"gain_status": gain["funding_status"], "loss_status": loss["funding_status"],
           "gain_net_complete": gain["net_complete"], "loss_net_complete": loss["net_complete"],
           "decision_taken_before_reconciliation": {"decision_id": later["decision_id"],
                                                    "capital_used_usd": later["capital_definitive_usd"],
                                                    "planned_loss_usd": later["planned_loss_usd"]}}

    def stage(name, now):
        short = summary(pf, now)
        short.pop("audit")
        stages.append((name, short))

    ingest_funding(pf, BTC, hourly(T8 + HOUR, 1), received_ms=T8 + 3 * HOUR + 5 * MIN)
    first = reconcile_funding(pf, T8 + 3 * HOUR + 5 * MIN)
    stage("btc_cobertura_parcial", T8 + 4 * HOUR)
    ingest_funding(pf, BTC, hourly(T8 + 2 * HOUR, 2), received_ms=T8 + 4 * HOUR + 5 * MIN)
    ingest_funding(pf, ETH, hourly(T8 - HOUR, 3), received_ms=T8 + 4 * HOUR + 5 * MIN)
    second = reconcile_funding(pf, T8 + 4 * HOUR + 5 * MIN)
    stage("btc_y_eth_completos", T8 + 4 * HOUR + 10 * MIN)
    digest, intake = accounting_digest(pf), intake_digest(pf)
    again = reconcile_funding(pf, T8 + 5 * HOUR)
    repeated = ingest_funding(pf, BTC, hourly(T8 - HOUR, 5), received_ms=T8 + 5 * HOUR)
    repeated_eth = ingest_funding(pf, ETH, hourly(T8 - HOUR, 3), received_ms=T8 + 5 * HOUR)
    again2 = reconcile_funding(pf, T8 + 5 * HOUR + MIN)
    return result("s09_funding_tardio", "Funding incompleto que se completa después", pf, T8 + 5 * HOUR, **log,
                  stages=[{"stage": n, **s} for n, s in stages], first_reconciliation=_brief(first),
                  second_reconciliation=_brief(second), repeat_reconciliation=len(again) + len(again2),
                  repeated_delivery={"btc": repeated, "eth": repeated_eth},
                  digest_unchanged_by_repetition=digest == accounting_digest(pf),
                  intake_log_records_the_repetition=intake != intake_digest(pf),
                  reconstruction_gain=trade_reconstruction(pf, gain), reconstruction_loss=trade_reconstruction(pf, loss))


def funding_received_twice():
    """The same periods delivered twice, before and after reconciling, are one funding."""
    pf = _funding_portfolio()
    gain, _ = _provisional_trades(pf)
    package = hourly(T8 + HOUR, 3)
    first = ingest_funding(pf, BTC, package, received_ms=T8 + 4 * HOUR + 5 * MIN)
    second = ingest_funding(pf, BTC, package, received_ms=T8 + 4 * HOUR + 6 * MIN)
    inside_batch = ingest_funding(pf, BTC, package + package, received_ms=T8 + 4 * HOUR + 7 * MIN)
    made = reconcile_funding(pf, T8 + 4 * HOUR + 8 * MIN)
    funding_once = D(str(pf.trades[1]["funding_usd"]))
    digest = accounting_digest(pf)
    ingest_funding(pf, BTC, package, received_ms=T8 + 4 * HOUR + 9 * MIN)
    made_again = reconcile_funding(pf, T8 + 4 * HOUR + 10 * MIN)
    return result("s10_funding_recibido_dos_veces", "Funding recibido dos veces", pf, T8 + 5 * HOUR,
                  first=first, second=second, duplicated_inside_one_batch=inside_batch,
                  adjustments_made=len(made), adjustments_on_repetition=len(made_again),
                  funding_applied_usd=str(funding_once),
                  expected_single_funding_usd=str(round(D(str(pf.trades[1]["quantity"])) * D(pf.trades[1]["entry_price"])
                                                        * D(FR) * D(pf.trades[1]["funding_covered_ms"]) / D(HOUR), 6)),
                  digest_unchanged_by_repetition=digest == accounting_digest(pf))


def funding_contradictory():
    """A correction that contradicts accepted funding, and two contradictory versions of an unknown hour."""
    pf = _funding_portfolio()
    gain, loss = _provisional_trades(pf)
    # the ETH loss is provisional: its first hour of funding is delivered twice with two different rates
    clean = hourly(T8 - HOUR, 3)
    versions = ingest_funding(pf, ETH, [(T8, T8 + HOUR, "0.002"), (T8, T8 + HOUR, "0.004")], received_ms=T8 + 4 * HOUR)
    made = reconcile_funding(pf, T8 + 4 * HOUR)
    # a later delivery for the same hour still conflicts with what was quarantined
    later = ingest_funding(pf, ETH, [(T8, T8 + HOUR, "0.002")], received_ms=T8 + 5 * HOUR)
    made_later = reconcile_funding(pf, T8 + 5 * HOUR)
    # BTC first hour was accepted: a correction with another rate is quarantined, the trade is flagged, nothing moves
    before = (pf.capital_usd(), accounting_digest(pf))
    correction = ingest_funding(pf, BTC, [(T8, T8 + HOUR, "0.01")], received_ms=T8 + 5 * HOUR)
    made_correction = reconcile_funding(pf, T8 + 5 * HOUR + MIN)
    return result("s11_funding_contradictorio", "Funding corregido con datos contradictorios", pf, T8 + 6 * HOUR,
                  two_versions_same_hour=versions, adjustments_after_versions=len(made), later_delivery=later,
                  adjustments_after_later=len(made_later), correction_of_accepted=correction,
                  adjustments_after_correction=len(made_correction), capital_before_correction=str(before[0]),
                  capital_after_correction=str(pf.capital_usd()),
                  trades_unchanged_by_correction=[t["funding_usd"] for t in pf.trades],
                  review_flags={k: v for k, v in sorted(pf.review_flags.items())},
                  quarantine=pf.funding_conflicts, clean_package_unused=len(clean))


def restart_around_reconciliation():
    """A checkpoint (pickle, the practice of ``portfolio_offline``) before and after a reconciliation."""
    def build():
        pf = _funding_portfolio()
        _provisional_trades(pf)
        return pf

    def finish(pf, base):
        ingest_funding(pf, BTC, hourly(base + HOUR, 3), received_ms=base + 4 * HOUR + 5 * MIN)
        ingest_funding(pf, ETH, hourly(base - HOUR, 3), received_ms=base + 4 * HOUR + 5 * MIN)
        return reconcile_funding(pf, base + 4 * HOUR + 5 * MIN)

    straight = build()
    finish(straight, T8)
    reference = accounting_digest(straight)
    # restart BEFORE the reconciliation: the new process loads the checkpoint and does the whole thing
    blob = pickle.dumps(build(), protocol=4)
    restored = pickle.loads(blob)
    finish(restored, T8)
    before_digest = accounting_digest(restored)
    # restart AFTER the reconciliation: the new process repeats it and nothing changes
    blob_after = pickle.dumps(restored, protocol=4)
    restored_after = pickle.loads(blob_after)
    repeat = finish(restored_after, T8)
    after_digest = accounting_digest(restored_after)
    # the checkpoint taken before is never changed by what happened after it
    untouched = pickle.loads(blob)
    return result("s12_reinicio_y_conciliacion", "Reinicio antes y después de una conciliación", restored_after,
                  T8 + 6 * HOUR, uninterrupted_digest=reference, restart_before_digest=before_digest,
                  restart_after_digest=after_digest, equal_before=reference == before_digest,
                  equal_after=reference == after_digest, adjustments_on_repetition=len(repeat),
                  checkpoint_before_reconciliation_still_provisional=sum(1 for t in untouched.trades if not t["net_complete"]),
                  checkpoint_before_is_a_new_object=untouched is not restored)


# ------------------------------------------------------------------------------------------------ dirty event streams
def duplicates_and_disorder():
    """The same market delivered cleanly and with duplicated, stale, early and out-of-order events: same accounting."""
    touched = candle(100000, 100050, 97700, 97950)
    plan = [("quote", quote(BTC, NOON + 15 * SEC, 99900)), ("candle", (NOON, touched)),
            ("quote", quote(BTC, NOON + MIN + 20 * SEC, 97800)), ("candle", (NOON + MIN, candle(97900, 98050, 97600, 97700)))]
    dirty = [
        ("quote", quote(BTC, NOON + 15 * SEC, 99900)),
        ("quote", quote(BTC, NOON + 15 * SEC, 99900)),                         # duplicate delivery
        ("quote", quote(BTC, NOON + 12 * SEC, 97000)),                         # older than the last one: out of order
        ("quote", quote(BTC, ENTRY, 97000)),                                   # the entry instant itself is not "after"
        ("quote", {"product_id": BTC, "time_ms": NOON + 16 * SEC, "bid": "100", "ask": "99"}),   # crossed: invalid
        ("candle", (NOON, touched)),
        ("candle", (NOON, touched)),                                           # entry-minute candle delivered twice
        ("quote", quote(BTC, NOON + 50 * SEC, 97000)),                         # belongs to a minute the candle already covered
        ("quote", quote(BTC, NOON + MIN + 20 * SEC, 97800)),                   # the real breach
        ("quote", quote(BTC, NOON + MIN + 20 * SEC, 97800)),                   # delivered twice
        ("quote", quote(BTC, NOON + MIN + 10 * SEC, 97000)),                   # stale, out of order
        ("candle", (NOON + MIN, candle(97900, 98050, 97600, 97700))),          # the candle of the breach minute arrives later
    ]

    def run(events):
        pf = new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        open_timed(pf, BTC, LONG, ENTRY)
        for kind, payload in events:
            if kind == "quote":
                watch.on_quote(payload)
            else:
                watch.on_candle(BTC, *payload)
        return pf, watch

    clean_pf, clean_watch = run(plan)
    dirty_pf, dirty_watch = run(dirty)
    same_ledger, same_accounting = clean_pf.ledger_hash() == dirty_pf.ledger_hash(), accounting_digest(clean_pf) == accounting_digest(dirty_pf)
    duplicate_intent = dirty_pf.decide([intent(BTC, LONG, NOON)], NOON + 2 * MIN)[0]   # recorded as a rejected decision
    return result("s13_eventos_duplicados_y_desordenados", "Eventos duplicados o fuera de orden", dirty_pf, NOON + 3 * MIN,
                  same_ledger_as_clean_run=same_ledger, same_accounting_as_clean_run=same_accounting,
                  trades_clean=len(clean_pf.trades), trades_dirty=len(dirty_pf.trades),
                  watch_events=dirty_watch.events, ignored=sorted({e.get("reason", e["kind"]) for e in dirty_watch.events}),
                  closed_once=len(dirty_watch.closed) == 1 and len(dirty_pf.trades) == 1,
                  duplicate_intent=duplicate_intent["reasons"],
                  exit_time_ms=dirty_pf.trades[0]["exit_time_ms"], exit_evidence=dirty_pf.trades[0]["stop_exit"]["evidence"],
                  review_flags=dirty_pf.review_flags)


def unresolved_execution_gain():
    """A LONG opened mid-minute, no quote covering the entry window, the range of that minute below the stop, a later
    target hit. The simulated gain is booked as is; it is not counted as capital the portfolio may size from."""
    pf = new_portfolio()
    watch = QuoteWatch(pf, WatchPolicy())
    open_timed(pf, BTC, LONG, ENTRY)
    watch.on_candle(BTC, NOON, candle(100000, 100050, 97700, 97900))            # the range touched the stop (98 000)
    [trade] = watch.on_candle(BTC, NOON + MIN, candle(100500, 103500, 100400, 103200))   # the target (103 000) is hit
    old_rule = D(str(trade["net_usd"])) if trade["net_complete"] else min(D(0), D(str(trade["pnl_usd"])))
    return result("s14_ganancia_con_ejecucion_incierta", "Ganancia con ejecución incierta", pf, NOON + 3 * MIN,
                  funding_complete=trade["funding_complete"], net_complete=trade["net_complete"],
                  execution_unresolved=trade["execution_unresolved"], simulated_pnl_usd=str(trade["pnl_usd"]),
                  counted_in_capital_usd=str(pf.contribution(trade)),
                  rule_before_this_fix_usd=str(old_rule), capital_usd=str(pf.capital_usd()),
                  held_back_usd=str(pf.unresolved_execution_gains_usd()),
                  review_flags=pf.review_flags[trade["trade_id"]],
                  warnings=[w["rule"] for w in audit(pf)["warnings"]])


def funding_dispute_on_open_position():
    """A position stays open while one funding period is accepted and a contradictory one is quarantined, then closes."""
    pf = new_portfolio(funding={BTC: hourly(T8 - HOUR, 3)})
    pf.decide([intent(BTC, LONG, T8, target_pct="0.01")], T8)
    pf.on_candle(BTC, T8, candle(100000, 100100, 99900, 100050))
    conflict = ingest_funding(pf, BTC, [(T8, T8 + HOUR, "0.01")], received_ms=T8 + 2 * HOUR)
    flags_while_open = dict(pf.review_flags)
    [trade] = pf.on_candle(BTC, T8 + 3 * HOUR, candle(100500, 101500, 100400, 101200))
    return result("s15_disputa_de_funding_con_posicion_abierta", "Disputa de funding con la posición abierta", pf,
                  T8 + 4 * HOUR, conflict=conflict, flags_while_open=flags_while_open,
                  review_flags=pf.review_flags[trade["trade_id"]],
                  disputed_periods=pf.trade_details[trade["trade_id"]]["notes"]["funding_conflict"],
                  quarantine=pf.funding_conflicts, funding_status=trade["funding_status"],
                  funding_used_usd=str(trade["funding_usd"]))


def _complete_gain_portfolio(received_conflict_after_close):
    """A BTC LONG whose accepted funding covers its whole holding time, closed at the target with a gain."""
    pf = new_portfolio(funding={BTC: hourly(T8 - HOUR, 5)})
    pf.decide([intent(BTC, LONG, T8, target_pct="0.01")], T8)
    pf.on_candle(BTC, T8, candle(100000, 100100, 99900, 100050))
    return pf


def dispute_before_close():
    """Case A: complete accepted funding, a contradictory period arrives while the position is open, the trade closes
    with a gain. Simulated result intact; the gain never raises the usable capital while the dispute is unresolved."""
    pf = _complete_gain_portfolio(False)
    counts = ingest_funding(pf, BTC, [(T8 + HOUR, T8 + 2 * HOUR, "0.01")], received_ms=T8 + 2 * HOUR)
    [trade] = pf.on_candle(BTC, T8 + 3 * HOUR, candle(100500, 101500, 100400, 101200))
    return result("s16_disputa_antes_del_cierre", "Disputa de funding antes del cierre", pf, T8 + 4 * HOUR,
                  intake=counts, net_complete=trade["net_complete"], funding_status=trade["funding_status"],
                  simulated_pnl_usd=str(trade["pnl_usd"]), counted_in_capital_usd=str(pf.contribution(trade)),
                  capital_usd=str(pf.capital_usd()), held_back_usd=str(pf.disputed_funding_gains_usd()),
                  disputes=pf.funding_disputes, review_flags=pf.review_flags[trade["trade_id"]],
                  reclassifications=len(pf.reclassifications))


def dispute_after_close():
    """Case B: the gain closes with apparently complete funding and enters the capital; contradictory information
    arrives afterwards. An explicit reclassification takes the gain out of the usable capital at that moment."""
    pf = _complete_gain_portfolio(True)
    [trade] = pf.on_candle(BTC, T8 + 3 * HOUR, candle(100500, 101500, 100400, 101200))
    capital_at_close = pf.capital_usd()
    pf.decide([intent(SOL, LONG, T8 + 3 * HOUR + 2 * MIN)], T8 + 3 * HOUR + 2 * MIN)    # sized on the capital with the gain
    original = dict(trade)
    closed_state = dict(pf.trade_details[trade["trade_id"]]["as_closed"])
    counts = ingest_funding(pf, BTC, [(T8 + HOUR, T8 + 2 * HOUR, "0.01")], received_ms=T8 + 4 * HOUR)
    digest = accounting_digest(pf)
    again = ingest_funding(pf, BTC, [(T8 + HOUR, T8 + 2 * HOUR, "0.01")], received_ms=T8 + 4 * HOUR + MIN)
    made = reconcile_funding(pf, T8 + 5 * HOUR)
    [record] = pf.reclassifications
    return result("s17_disputa_despues_del_cierre", "Disputa de funding después del cierre", pf, T8 + 5 * HOUR,
                  intake=counts, repeated_intake=again, capital_at_close=str(capital_at_close),
                  capital_after_dispute=str(pf.capital_usd()), reclassification={k: record[k] for k in (
                      "at_ms", "counted_before_usd", "counted_after_usd", "delta_capital_usd", "capital_before_usd",
                      "capital_after_usd", "risk_budget_before_usd", "risk_budget_after_usd", "drawdown_before_usd",
                      "drawdown_after_usd", "decisions_not_revised")},
                  closing_untouched=all(trade[k] == original[k] for k in original),
                  as_closed_untouched=pf.trade_details[trade["trade_id"]]["as_closed"] == closed_state,
                  repeated_digest_unchanged=digest == accounting_digest(pf), reconcile_adjustments=len(made),
                  reclassifications=len(pf.reclassifications), capital_log_kinds=[e["kind"] for e in pf.capital_log],
                  disputes=pf.funding_disputes)


SCENARIOS = (gap_long, gap_short, stop_without_gap, entry_minute_spike, quotes_missing, loss_beyond_plan,
             daily_loss_suspension, drawdown_suspension, funding_late_complete, funding_received_twice,
             funding_contradictory, restart_around_reconciliation, duplicates_and_disorder,
             unresolved_execution_gain, funding_dispute_on_open_position, dispute_before_close,
             dispute_after_close)


# ------------------------------------------------------------------------------------------------ report
def run_all():
    return [scenario() for scenario in SCENARIOS]


def build_results(results):
    return {"schema": SCHEMA, "scenarios": results,
            "hashes": {r["id"]: {"ledger_hash": r["ledger_hash"], "accounting_digest": r["summary"]["accounting_digest"]}
                       for r in results}}
