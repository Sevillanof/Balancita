"""Three-arm multi-strategy experiment (PR 100, P1).

Every 5 minutes, for each product, the strategies produce signals (``multi_signals``). Three arms trade on
independent books of the shared simulator, with the same data, cost model, fixed 100 USD notional, risk engine,
protective-level policy and executor:

* A — each strategy trades its own signals (one book per strategy and product);
* B — the deterministic combiner chooses (the reference);
* C — Qwen chooses among the actions the signals back (WAIT on any failure).

Every candidate (a BUY/SELL signal) is stored whether or not an arm took it, and a *shadow* book (same levels and
costs, no exposure limits, never part of an arm's account) records what it would have earned, so the rejections of
Qwen and the combiner can be judged (``false rejections``). The accounting is a pure function of the candles and
the stored selections: re-running the same candles on the same store reproduces the ledger without asking Qwen.

    python -m balancita_engine.multi_experiment --market-db data/market.sqlite --out data/multi \\
        [--qwen llama] [--loop-seconds 300]

Historical validation (walk-forward, CPCV, Holm, DSR/PBO) and forward freezing are later increments; this module
reports the raw comparison only and asserts no edge.
"""

import argparse
import heapq
import json
import os
import time
from decimal import Decimal

from .futures_costs import is_measured, round_trip_cost_bps
from .futures_funding_context import HOUR_MS, funding_for
from .futures_products import resolve_products
from .futures_simulator import frames
from .multi_executor import AuthorizedBook, PaperExecutor
from .multi_risk import RiskEngine, RiskPolicy
from .multi_select import DeterministicCombiner, QwenSelector, StrategyDirect
from .multi_signals import (
    SELL, FIVE_MINUTES_MS, SignalContext, default_strategies, is_candidate, merged_indicators, stable_hash,
    validate_signal,
)
from .multi_store import DecisionStore

ONE_MINUTE_MS = 60_000
ARMS = ("A", "B", "C")
D = Decimal


def funding_periods(context):
    """``[(start_ms, end_ms, relative_rate_per_hour)]`` from a ``FundingContext`` for the simulator's books."""
    return [] if context is None else [(s, s + HOUR_MS, r) for s, r in zip(context.starts, context.rates)]


class Experiment:
    def __init__(self, store, products, *, strategies=None, qwen=None, policy=None, experiment_id="exp1",
                 funding_contexts=None, funding_periods_by_product=None, start_ms=None, clock=None, arms=ARMS,
                 tick_sizes=None):
        self.store, self.products = store, list(products)
        self.strategies = strategies or default_strategies()
        self.policy = policy or RiskPolicy()
        self.risk = RiskEngine(self.policy)
        self.funding_contexts = funding_contexts or {}
        periods = funding_periods_by_product if funding_periods_by_product is not None else {
            p: funding_periods(c) for p, c in self.funding_contexts.items()}
        self.executor = PaperExecutor(self.risk, store, notional_usd=self.policy.notional_usd,
                                      tick_sizes=tick_sizes, funding=periods)
        self.selectors = {"A": StrategyDirect(), "B": DeterministicCombiner(), "C": qwen}
        self.arms, self.experiment_id, self.start_ms = tuple(arms), experiment_id, start_ms
        self.clock = clock or (lambda cycle_ms: cycle_ms)
        self.periods = merged_indicators(self.strategies)
        self.last, self.shadows, self.duplicates_ignored, self.cycles = {}, {}, 0, 0
        self.tick_sizes, self.funding_by_product = tick_sizes or {}, periods

    # ----------------------------------------------------------------- driving

    def run(self, candles):
        """``candles``: ``{product_id: (candles_1m, candles_5m)}`` official candles, oldest first."""
        streams = [((product, frame) for frame in frames(ones, fives, self.periods, self.funding_contexts.get(product)))
                   for product, (ones, fives) in candles.items()]
        for product, frame in heapq.merge(*streams, key=lambda item: (item[1][0], item[0])):
            self.on_frame(product, frame)
        return self.report()

    def on_frame(self, product_id, frame):
        bucket, current, _, trend, regime = frame
        if bucket <= self.last.get(product_id, -1):
            self.duplicates_ignored += 1  # the same closed candle again: nothing happens twice
            return
        self.last[product_id] = bucket
        on_cycle = ((bucket + ONE_MINUTE_MS) % FIVE_MINUTES_MS == 0 and trend is not None and trend.get("ready")
                    and current.get("ready") and (self.start_ms is None or bucket >= self.start_ms))
        if on_cycle:
            self._cycle(product_id, bucket, current, trend, regime)
        self.executor.on_frame(product_id, frame)
        self._manage_shadows(product_id, frame)

    # ----------------------------------------------------------------- one cycle

    def _reliability(self, strategy_id):
        trades = [t for key, book in self.executor.books.items() if key[:2] == ("A", strategy_id) for t in book.trades]
        wins = sum(1 for t in trades if t["hit"])
        return {"sample_size": len(trades), "hit_rate": None if not trades else "{:.2f}".format(wins / len(trades))}

    def _cycle(self, product_id, bucket, current, trend, regime):
        self.cycles += 1
        cycle_ms = bucket + ONE_MINUTE_MS
        price = trend.get("candidate_close")
        data_close_ms = int(trend["candidate_bucket_start_ms"]) + FIVE_MINUTES_MS
        signals = []
        for strategy in self.strategies:
            context = SignalContext(product_id, cycle_ms, price, current, trend, regime, self._reliability(strategy.id))
            signal = validate_signal(strategy.evaluate(context))
            self.store.put_signal(signal)
            signals.append(signal)
        candidates = [s for s in signals if is_candidate(s)]
        if not candidates:
            return
        snapshot = {"price": price, "atr": trend.get("atr14"), "ready": True, "data_close_ms": data_close_ms}
        market = {"regime": regime, "cost_round_trip_bp": "{:.1f}".format(round_trip_cost_bps(product_id)),
                  "trend": "ema9>ema21" if D(trend["ema9"]) > D(trend["ema21"]) else "ema9<=ema21"}
        for signal in candidates:
            self.store.put_candidate({
                "signal_id": signal["signal_id"], "product_id": product_id, "cycle_ms": cycle_ms,
                "strategy_id": signal["strategy_id"], "strategy_version": signal["strategy_version"],
                "action": signal["action"], "strength": signal["strength"], "reason": signal["reason"]})
            self._open_shadow(signal, snapshot, bucket)
        for arm in self.arms:
            units = ([(s["strategy_id"], [s]) for s in candidates] if arm == "A"
                     else [("combined" if arm == "B" else "qwen", signals)])
            for scope, scope_signals in units:
                self._decide(arm, scope, product_id, cycle_ms, bucket, scope_signals, snapshot, market, data_close_ms)

    def _decide(self, arm, scope, product_id, cycle_ms, bucket, signals, snapshot, market, data_close_ms):
        selector = self.selectors[arm]
        identity = "{}@{}".format(selector.selector_id, selector.version) if selector else "none"
        ids = sorted(s["signal_id"] for s in signals)
        decision_id = stable_hash([self.experiment_id, arm, scope, product_id, cycle_ms, ids, identity])[:24]
        selection = self.store.get_selection(decision_id)
        if selection is None:
            decided_ms = self.clock(cycle_ms)
            if decided_ms - data_close_ms > self.policy.max_data_age_ms:
                chosen = {"action": "WAIT", "signal_id": None, "reason": "stale_data", "detail": {}}
            elif selector is None:
                chosen = {"action": "WAIT", "signal_id": None, "reason": "selector_not_configured", "detail": {}}
            else:
                account = self.executor.account(arm, scope, product_id, decided_ms)
                context = dict(market, open_exposure_usd=account["open_notional_usd"])
                chosen = selector.select(product_id, cycle_ms, signals, context)
            selection = dict(chosen, decision_id=decision_id, arm=arm, scope=scope, product_id=product_id,
                             cycle_ms=cycle_ms, signal_ids=ids, selector=identity, decided_ms=decided_ms,
                             experiment_id=self.experiment_id)
            self.store.put_selection(selection)
        if selection["action"] == "WAIT":
            return
        now_ms = selection["decided_ms"]
        verdict = self.risk.evaluate(
            decision=selection, signals=signals, snapshot=snapshot, now_ms=now_ms,
            account=self.executor.account(arm, scope, product_id, now_ms))
        outcome = {"decision_id": decision_id, "authorized": verdict["authorized"], "reasons": verdict["reasons"],
                   "auth_id": verdict["authorization"] and verdict["authorization"]["auth_id"],
                   "policy_hash": self.policy.policy_hash()}
        if verdict["authorized"]:
            status = self.executor.submit(verdict["authorization"], bucket, now_ms)
            outcome["execution"] = status["status"] if status["status"] == "armed" else status["reason"]
        self.store.put_risk_outcome(decision_id, outcome)

    # ----------------------------------------------------------------- shadow books

    def _open_shadow(self, signal, snapshot, bucket):
        signal_id, product_id = signal["signal_id"], signal["product_id"]
        if signal_id in self.shadows or self.store.candidate_outcomes().get(signal_id):
            return
        side = "SHORT" if signal["action"] == SELL else "LONG"
        levels = self.risk.peek_levels(side, snapshot["price"], snapshot["atr"], signal["horizon_minutes"])
        if levels is None or not is_measured(product_id):
            self.store.put_candidate_outcome(signal_id, {"status": "not_evaluable"})
            return
        stop, target, horizon = levels
        book = AuthorizedBook(("S", signal_id, product_id), product_id=product_id,
                              tick_size=self.tick_sizes.get(product_id, "1"), notional_usd=self.policy.notional_usd,
                              funding=self.funding_by_product.get(product_id, ()))
        book.arm(bucket, {"auth_id": "shadow:" + signal_id, "decision_id": "shadow", "signal_id": signal_id,
                          "strategy_id": signal["strategy_id"], "strategy_version": signal["strategy_version"],
                          "arm": "S", "scope": signal_id, "side": side, "stop": str(stop), "target": str(target),
                          "horizon_minutes": horizon})
        self.shadows[signal_id] = book

    def _manage_shadows(self, product_id, frame):
        for signal_id in [s for s, b in self.shadows.items() if b.key[2] == product_id]:
            book = self.shadows[signal_id]
            book.on_frame(*frame)
            if book.trades:
                trade = book.trades[0]
                complete = bool(trade["funding_complete"])
                self.store.put_candidate_outcome(signal_id, {
                    "status": "closed", "net_complete": complete, "net_bp": trade["net_bp"] if complete else None,
                    "partial_bp": trade["net_bp"], "exit_reason": trade["exit_reason"]})
                del self.shadows[signal_id]

    # ----------------------------------------------------------------- results

    def ledger_hash(self):
        trades = sorted(self.store.trades(), key=lambda t: t["trade_id"])
        return stable_hash(trades)

    def explain(self, decision_id):
        """Why a position was opened, rejected or closed: selection, risk verdict, fill and close."""
        selection = self.store.get_selection(decision_id)
        if selection is None:
            return None
        verdict = self.store.get_risk_outcome(decision_id)
        auth_id = verdict and verdict.get("auth_id")
        return {
            "selection": selection, "risk": verdict,
            "signals": [s for s in self.store.signals() if s["signal_id"] in selection["signal_ids"]],
            "executions": [e for e in self.store.executions() if auth_id and e.get("auth_id") == auth_id],
            "trades": [t for t in self.store.trades() if auth_id and t["meta"].get("auth_id") == auth_id]}

    def report(self):
        return build_report(self.store, self.executor, self.duplicates_ignored)


def _arm_stats(trades, span_days):
    complete = [t for t in trades if t["net_complete"]]
    partial = sum((D(str(t["partial_usd"])) for t in trades), D(0))
    wins = [D(str(t["partial_usd"])) for t in trades if D(str(t["partial_usd"])) > 0]
    losses = [-D(str(t["partial_usd"])) for t in trades if D(str(t["partial_usd"])) < 0]
    running = peak = drawdown = D(0)
    for trade in sorted(trades, key=lambda t: t["exit_time_ms"]):
        running += D(str(trade["partial_usd"]))
        peak = max(peak, running)
        drawdown = max(drawdown, peak - running)
    net = None if not complete or len(complete) != len(trades) else sum((D(str(t["net_usd"])) for t in trades), D(0))
    return {
        "trades": len(trades), "net_complete_trades": len(complete), "incomplete_trades": len(trades) - len(complete),
        "net_pnl_usd": None if net is None else float(net),
        "partial_pnl_usd": float(partial),
        "mean_net_bp": None if not complete else round(sum(t["net_bp"] for t in complete) / len(complete), 4),
        "hit_rate": None if not trades else round(sum(1 for t in trades if t["hit"]) / len(trades), 4),
        "profit_factor": None if not losses else round(float(sum(wins, D(0)) / sum(losses, D(0))), 4),
        "max_drawdown_usd": float(drawdown),
        "trades_per_day": None if not span_days else round(len(trades) / span_days, 4),
    }


def build_report(store, executor, duplicates_ignored=0):
    trades = store.trades()
    candidates = store.candidates()
    outcomes = store.candidate_outcomes()
    selections = store.selections()
    risk = store.risk_outcomes()
    times = [t["entry_time_ms"] for t in trades] + [c["cycle_ms"] for c in candidates]
    span_days = (max(times) - min(times)) / 86_400_000 if len(times) > 1 else 0
    arms = {}
    for arm in ARMS:
        arm_trades = [t for t in trades if t["arm"] == arm]
        arm_selections = [s for s in selections if s["arm"] == arm]
        rejected = {}
        for selection in arm_selections:
            for reason in (risk.get(selection["decision_id"]) or {}).get("reasons", []):
                rejected[reason] = rejected.get(reason, 0) + 1
        waits = {}
        for selection in arm_selections:
            if selection["action"] == "WAIT":
                waits[selection["reason"]] = waits.get(selection["reason"], 0) + 1
        arms[arm] = dict(_arm_stats(arm_trades, span_days), decisions=len(arm_selections), waits=waits,
                         risk_rejections=rejected)
    # candidate table: what each arm did with each opportunity, rejected ones included
    by_cycle = {(s["arm"], s["product_id"], s["cycle_ms"]): s for s in selections if s["arm"] in ("B", "C")}
    by_signal_a = {sid: s for s in selections if s["arm"] == "A" for sid in s["signal_ids"]}
    table, rejected_by = [], {"B": [], "C": []}
    for cand in candidates:
        row = dict(cand, shadow=outcomes.get(cand["signal_id"]), arms={})
        for arm in ARMS:
            selection = (by_signal_a.get(cand["signal_id"]) if arm == "A"
                         else by_cycle.get((arm, cand["product_id"], cand["cycle_ms"])))
            if selection is None:
                row["arms"][arm] = "not_decided"
            elif selection["action"] == "WAIT" or selection["signal_id"] != cand["signal_id"]:
                row["arms"][arm] = "rejected_by_selector:" + selection["reason"]
                if arm in rejected_by:
                    rejected_by[arm].append(row["shadow"])
            else:
                verdict = risk.get(selection["decision_id"]) or {}
                row["arms"][arm] = ("taken" if verdict.get("authorized") else
                                    "rejected_by_risk:" + ",".join(verdict.get("reasons", [])))
        table.append(row)
    filters = {}
    for arm, shadows in rejected_by.items():
        judged = [s for s in shadows if s and s.get("net_bp") is not None]
        filters[arm] = {
            "rejected_candidates": len(shadows), "judged": len(judged),
            "false_rejections": sum(1 for s in judged if s["net_bp"] > 0),
            "avoided_losers": sum(1 for s in judged if s["net_bp"] <= 0),
            "mean_shadow_net_bp": None if not judged else round(sum(s["net_bp"] for s in judged) / len(judged), 4)}
    b_bp, c_bp = arms["B"]["mean_net_bp"], arms["C"]["mean_net_bp"]
    return {
        "schema": "balancita-multi-report.v1", "arms": arms, "candidates": len(candidates),
        "selector_filters": filters,
        "qwen_vs_combiner_mean_net_bp": None if b_bp is None or c_bp is None else round(c_bp - b_bp, 4),
        "open_positions": len(executor.open_positions()), "duplicates_ignored": duplicates_ignored,
        "candidate_table": table,
        "verdict": "no edge asserted: raw comparison only; validation and forward freezing are later increments"}


def _load(market_db, products, start_ms, now_ms):
    from .futures_replay import load_range

    candles, contexts = {}, {}
    for product_id, _ in products:
        try:
            candles[product_id] = load_range(market_db, product_id, start_ms, now_ms + ONE_MINUTE_MS)
        except ValueError:
            continue
        contexts[product_id] = funding_for(market_db, product_id)
    return candles, {p: c for p, c in contexts.items() if c is not None}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Three-arm multi-strategy paper experiment (A strategies, B combiner, C Qwen).")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for multi.sqlite and multi-report.json")
    parser.add_argument("--experiment-id", default="exp1", help="a new id starts a fresh set of decisions")
    parser.add_argument("--qwen", choices=("off", "llama"), default="off")
    parser.add_argument("--loop-seconds", type=float, default=0, help="repeat every N seconds (0: once); 300 is the cycle")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    products = resolve_products()
    store = DecisionStore(os.path.join(args.out, "multi.sqlite"))
    qwen = None
    if args.qwen == "llama":
        from . import futures_llm_decisions as llm

        qwen = QwenSelector(llm.LlamaCppProvider(llm.llama_url(os.environ), llm.model_ref(os.environ)))
    while True:
        now = int(time.time() * 1000)
        start = store.get_meta("start_ms:" + args.experiment_id)
        if start is None:
            start = now - now % FIVE_MINUTES_MS
            store.set_meta("start_ms:" + args.experiment_id, start)
        candles, contexts = _load(args.market_db, products, start, now)
        experiment = Experiment(
            store, [p for p, _ in products if p in candles], qwen=qwen, experiment_id=args.experiment_id,
            funding_contexts=contexts, start_ms=start, clock=lambda cycle_ms: int(time.time() * 1000),
            tick_sizes=dict(products))
        report = experiment.run(candles)
        path = os.path.join(args.out, "multi-report.json")
        with open(path + ".partial", "w", encoding="utf-8") as handle:
            json.dump({k: v for k, v in report.items() if k != "candidate_table"}, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(path + ".partial", path)
        print("multi: " + " ".join("{} trades={} net={}".format(a, s["trades"], s["net_pnl_usd"])
                                   for a, s in report["arms"].items()), flush=True)
        if not args.loop_seconds:
            return
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()
