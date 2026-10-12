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
import pickle
import time
from decimal import Decimal

from .futures_costs import cost_model_hash, is_measured, round_trip_cost_bps
from .futures_funding_context import HOUR_MS, funding_for
from .futures_products import resolve_products
from .futures_indicators import MINIMUM_CANDLES
from .futures_simulator import IncrementalFeatures
from .futures_strategies import update_regime
from .multi_executor import PaperExecutor
from .multi_risk import RiskEngine, RiskPolicy
from .multi_select import DeterministicCombiner, QwenSelector, StoredOnly, StrategyDirect
from .multi_signals import (
    SELL, FIVE_MINUTES_MS, SignalContext, default_strategies, is_candidate, merged_indicators, stable_hash,
    validate_signal,
)
from .multi_store import DecisionStore

ONE_MINUTE_MS = 60_000
ARMS = ("A", "B", "C")
D = Decimal


RECURSIVE_SPANS, MIN_WARMUP_BARS = 12, 288


def required_warmup_ms(periods):
    """History before the first decided cycle that the declared indicators need, in ms of 5-minute bars.

    Recursive indicators (EMA, RSI, ATR, the EWMA log-volatility) never forget their seed completely: an EMA keeps
    (1-2/(n+1)) of it per bar, so ``RECURSIVE_SPANS`` times the period brings the difference under about 1e-10 (the
    day-long floor does the same for Wilder's RSI/ATR at 14). Cold and continuous runs then agree on actions,
    strengths and evidence to 6+ digits; bit-identical is impossible with a different seed; windows (Bollinger, Donchian, log returns, log-volatility, SMA) need their
    length plus one. Never less than ``MIN_WARMUP_BARS`` (a day), which also lets the regime state settle.
    """
    bars = MINIMUM_CANDLES
    for kind, values in periods.items():
        for period in values:
            bars = max(bars, (RECURSIVE_SPANS * period if kind in ("ema", "rsi", "atr", "logvol") else period + 1) + 2)
    return max(bars, MIN_WARMUP_BARS) * FIVE_MINUTES_MS


def indicator_keys(periods):
    """Names of the 5-minute features the declared indicators produce (what must be non-null to be 'ready')."""
    names = {"ema": "ema{}", "sma": "sma{}", "rsi": "rsi{}", "atr": "atr{}", "bollinger": "bollinger_upper{}",
             "donchian": "donchian_high{}", "logret": "logret{}", "logvol": "logvol{}"}
    return [names[kind].format(period) for kind, values in periods.items() if kind in names for period in values]


def funding_periods(context):
    """``[(start_ms, end_ms, relative_rate_per_hour)]`` from a ``FundingContext`` for the simulator's books."""
    return [] if context is None else [(s, s + HOUR_MS, r) for s, r in zip(context.starts, context.rates)]


CHECKPOINT_VERSION = 2


class FrameFeeder:
    """``futures_simulator.frames`` with its state in plain attributes, so it can be saved and resumed.

    Fed the same candles it yields exactly what ``frames`` yields (a test pins it). Candles already consumed
    (1m at or before ``last_one``, 5m at or before ``last_five``) are skipped, so a resumed run may be given
    overlapping candles and a repeated candle changes nothing.
    """

    def __init__(self, periods):
        self.one, self.five = IncrementalFeatures(periods), IncrementalFeatures(periods)
        self.trend = self.previous = None
        self.regime = "unknown"
        self.last_one = self.last_five = -1
        self.skipped = 0

    def stream(self, candles_1m, candles_5m, funding=None):
        pending_fives = iter(c for c in candles_5m if c["bucket_start"] > self.last_five)
        pending = next(pending_fives, None)
        for candle in candles_1m:
            if candle["bucket_start"] <= self.last_one:
                self.skipped += 1
                continue
            current = self.one.update(candle)
            close_at = candle["bucket_start"] + ONE_MINUTE_MS
            while pending is not None and pending["bucket_start"] + FIVE_MINUTES_MS <= close_at:
                self.trend = self.five.update(pending)
                if funding is not None:
                    found = funding.percentile(pending["bucket_start"] + FIVE_MINUTES_MS)
                    if found is not None:
                        self.trend["fundpct"] = "{:.1f}".format(found[1])
                self.last_five = pending["bucket_start"]
                pending = next(pending_fives, None)
            if self.trend is not None:
                self.regime = update_regime(self.regime, self.trend.get("ema9"), self.trend.get("ema21"),
                                            self.trend.get("atr14"))
            self.last_one = candle["bucket_start"]
            frame = (candle["bucket_start"], current, self.previous, self.trend, self.regime)
            self.previous = current
            yield frame


class Experiment:
    def __init__(self, store, products, *, strategies=None, qwen=None, policy=None, experiment_id="exp1",
                 funding_contexts=None, funding_periods_by_product=None, start_ms=None, clock=None, arms=ARMS,
                 tick_sizes=None, warmup_ms=None):
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
        self.last, self.shadows, self.cycles = {}, {}, 0
        # already_processed: candles handed in again that an earlier pass consumed (expected after a reload);
        # duplicate_events: a closed candle delivered twice to on_frame (a real duplicate, ignored).
        self.already_processed, self.duplicate_events = 0, 0
        self.warmup_bars, self.first_cycle_ready = {}, {}
        self.gaps = []
        self.warmup_ms = required_warmup_ms(self.periods) if warmup_ms is None else int(warmup_ms)
        self.tick_sizes, self.funding_by_product = tick_sizes or {}, periods
        self.feeders = {}

    # ----------------------------------------------------------------- driving

    def run(self, candles, include_table=True):
        """``candles``: ``{product_id: (candles_1m, candles_5m)}`` official candles, oldest first."""
        feeders = {p: self.feeders.setdefault(p, FrameFeeder(self.periods)) for p in candles}
        streams = [self._stream(product, feeders[product], ones, fives)
                   for product, (ones, fives) in candles.items()]
        for product, frame in heapq.merge(*streams, key=lambda item: (item[1][0], item[0])):
            self.on_frame(product, frame)
        for feeder in feeders.values():
            self.already_processed += feeder.skipped
            feeder.skipped = 0
        return self.report(include_table)

    def _stream(self, product, feeder, ones, fives):
        """The product's frames tagged with the product. A named method, not a generator expression in a loop:
        those bind ``product`` late and would tag every frame with the last product."""
        for frame in feeder.stream(ones, fives, self.funding_contexts.get(product)):
            yield product, frame

    # ----------------------------------------------------------------- checkpoint

    def fingerprint(self):
        """What a checkpoint is only valid for: change any of it and the books must be rebuilt from scratch."""
        selectors = {arm: None if sel is None else sel.identity_key() for arm, sel in sorted(self.selectors.items())}
        return stable_hash({
            "checkpoint_version": CHECKPOINT_VERSION, "experiment_id": self.experiment_id, "start_ms": self.start_ms,
            "policy": self.policy.policy_hash(), "cost_model": cost_model_hash(), "arms": list(self.arms),
            "strategies": [[s.id, s.version] for s in self.strategies], "periods": self.periods,
            "selectors": selectors, "products": self.products})

    def _state(self):
        return {"books": self.executor.books, "issued": self.risk.issued, "consumed": self.risk.consumed,
                "shadows": self.shadows, "last": self.last, "already_processed": self.already_processed,
                "duplicate_events": self.duplicate_events, "warmup_bars": self.warmup_bars,
                "first_cycle_ready": self.first_cycle_ready, "gaps": self.gaps, "cycles": self.cycles, "feeders": self.feeders}

    def save_checkpoint(self):
        """Stores the complete state after a finished run, next to the decision log it is a cache of."""
        blob = pickle.dumps(self._state(), protocol=4)
        info = {"saved_ms": int(time.time() * 1000), "last_bucket_ms": max(self.last.values(), default=None),
                "books": len(self.executor.books), "shadows": len(self.shadows), "bytes": len(blob)}
        self.store.put_checkpoint("experiment:" + self.experiment_id, self.fingerprint(),
                                  stable_hash(blob.hex()), info, blob)
        return info

    def load_checkpoint(self):
        """Resumes from the stored checkpoint when it is intact and made for this very configuration.

        Returns ``None`` when it was resumed, else the reason it was not (nothing is changed then).
        """
        row = self.store.get_checkpoint("experiment:" + self.experiment_id)
        if row is None:
            return "no_checkpoint"
        if row["fingerprint"] != self.fingerprint():
            return "configuration_changed"
        if stable_hash(row["blob"].hex()) != row["digest"]:
            return "corrupt_checkpoint"
        try:
            state = pickle.loads(row["blob"])  # our own file, written by save_checkpoint
        except Exception:
            return "unreadable_checkpoint"
        self.executor.books = state["books"]
        self.risk.issued, self.risk.consumed = state["issued"], state["consumed"]
        self.shadows, self.last = state["shadows"], state["last"]
        self.already_processed, self.duplicate_events = state["already_processed"], state["duplicate_events"]
        self.warmup_bars, self.first_cycle_ready = state["warmup_bars"], state["first_cycle_ready"]
        self.gaps, self.cycles, self.feeders = state["gaps"], state["cycles"], state["feeders"]
        self.executor.reattach_funding(list(self.executor.books.values()) + list(self.shadows.values()))
        return None

    def on_frame(self, product_id, frame):
        bucket, current, _, trend, regime = frame
        if bucket <= self.last.get(product_id, -1):
            self.duplicate_events += 1  # the same closed candle again: nothing happens twice
            return
        self.last[product_id] = bucket
        on_cycle = ((bucket + ONE_MINUTE_MS) % FIVE_MINUTES_MS == 0 and trend is not None and trend.get("ready")
                    and current.get("ready") and (self.start_ms is None or bucket + ONE_MINUTE_MS >= self.start_ms))
        if on_cycle:
            if product_id not in self.first_cycle_ready:
                # Were the indicators warm on the very first decided cycle? (the cold-start check)
                self.first_cycle_ready[product_id] = all(
                    trend.get(key) is not None for key in indicator_keys(self.periods))
            self._cycle(product_id, bucket, current, trend, regime)
        elif (bucket + ONE_MINUTE_MS) % FIVE_MINUTES_MS == 0 and trend is not None and product_id not in self.first_cycle_ready:
            self.warmup_bars[product_id] = self.warmup_bars.get(product_id, 0) + 1  # 5m bars seen before the start
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
        identity = selector.identity_key() if selector else "none"
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
        if signal_id in self.shadows or self.store.has_candidate_outcome(signal_id):
            return
        side = "SHORT" if signal["action"] == SELL else "LONG"
        levels = self.risk.peek_levels(side, snapshot["price"], snapshot["atr"], signal["horizon_minutes"])
        if levels is None or not is_measured(product_id):
            self.store.put_candidate_outcome(signal_id, {"status": "not_evaluable"})
            return
        stop, target, horizon = levels
        book = self.executor.new_book(("S", signal_id, product_id), self.policy.notional_usd)
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

    def report(self, include_table=True):
        report = build_report(self.store, self.executor, self.already_processed, self.duplicate_events, include_table)
        report["data_gaps"] = list(self.gaps)
        report["warmup"] = {"required_ms": self.warmup_ms, "products": {p: {"bars_5m_before_start": self.warmup_bars.get(p, 0),
                                "indicators_ready_at_first_cycle": self.first_cycle_ready.get(p)}
                            for p in self.products}}
        qwen = self.selectors.get("C")
        if qwen is not None and hasattr(qwen, "model_identity"):
            report["qwen_model"] = qwen.model_identity()
        return report


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


def build_report(store, executor, already_processed=0, duplicate_events=0, include_table=True):
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
        "open_positions": len(executor.open_positions()), "already_processed_candles": already_processed,
        "duplicate_events": duplicate_events,
        "candidate_table": table if include_table else None,
        "shadow_note": "shadow outcomes ignore simultaneous positions and capital limits: not executable profitability",
        "verdict": "no edge asserted: raw comparison only; validation and forward freezing are later increments"}


def verify_against_rebuild(experiment, candles):
    """Rebuilds every book from scratch (in memory) on the stored selections and compares it with ``experiment``.

    ``candles`` must be the complete history from the experiment's start. Equal ledger hashes and equal open
    positions prove that resuming from a checkpoint gave the same result as replaying everything.
    """
    fresh = DecisionStore()
    try:
        for selection in experiment.store.selections():
            fresh.put_selection(selection)
        original = experiment.selectors["C"]
        rebuilt = Experiment(
            fresh, experiment.products, strategies=experiment.strategies,
            qwen=None if original is None else StoredOnly(original.selector_id, original.version,
                                                          getattr(original, "model_fingerprint", lambda: None)()),
            policy=experiment.policy, experiment_id=experiment.experiment_id,
            funding_contexts=experiment.funding_contexts, funding_periods_by_product=experiment.funding_by_product,
            start_ms=experiment.start_ms, clock=experiment.clock, arms=experiment.arms, tick_sizes=experiment.tick_sizes)
        rebuilt.run(candles)
        positions = lambda e: {str(k): str(v["entry"]) for k, v in sorted(e.executor.open_positions().items())}
        result = {"resumed_ledger": experiment.ledger_hash(), "rebuilt_ledger": rebuilt.ledger_hash(),
                  "trades": len(experiment.store.trades()), "rebuilt_trades": len(fresh.trades()),
                  "open_positions_equal": positions(experiment) == positions(rebuilt)}
        result["equal"] = (result["resumed_ledger"] == result["rebuilt_ledger"] and result["open_positions_equal"])
        return result
    finally:
        fresh.close()


def load_candles(market_db, product_id, lo_1m, lo_5m, end_ms):
    """Official 1m candles from ``lo_1m`` and 5m candles from ``lo_5m`` (first-known revision) up to ``end_ms``.

    Unlike ``futures_replay.load_range`` this adds no hidden warm-up: the caller says exactly where to start.
    """
    from .futures_verdicts import _OfficialCandles

    market = _OfficialCandles(market_db)
    try:
        if not market.available:
            raise ValueError("market DB has no per-product official candles")
        rows = [market._candles(market.db.execute(
            market._ROWS_SQL.format(market._WINDOW_WHERE), (product_id, interval, max(0, lo), end_ms, 2 ** 62)
        ).fetchall()) for interval, lo in ((ONE_MINUTE_MS, lo_1m), (FIVE_MINUTES_MS, lo_5m))]
        return rows[0], rows[1]
    finally:
        market.db.close()


def load_cold(market_db, products, start_ms, now_ms, warmup_ms):
    """Everything from ``start_ms - warmup_ms``: the history the indicators need before the first decided cycle."""
    candles = {}
    for product_id, _ in products:
        try:
            candles[product_id] = load_candles(market_db, product_id, start_ms - warmup_ms, start_ms - warmup_ms,
                                               now_ms + ONE_MINUTE_MS)
        except ValueError:
            continue
    return candles


def load_incremental(experiment, market_db, products, now_ms):
    """Per-product read cursor: only candles after what each product's feeder consumed (cold products: warm-up window).

    A hole between the cursor and the first new candle is not silently bridged: it is recorded in
    ``experiment.gaps`` and reported (the books keep running; ``--rebuild`` redoes them once the hole is filled).
    """
    candles = {}
    for product_id, _ in products:
        feeder = experiment.feeders.get(product_id)
        if feeder is None or feeder.last_one < 0:
            lo_1m = lo_5m = (experiment.start_ms or 0) - experiment.warmup_ms
        else:
            lo_1m, lo_5m = feeder.last_one + 1, feeder.last_five + 1
        try:
            ones, fives = load_candles(market_db, product_id, lo_1m, lo_5m, now_ms + ONE_MINUTE_MS)
        except ValueError:
            continue
        if feeder is not None and feeder.last_one >= 0 and ones and ones[0]["bucket_start"] > feeder.last_one + ONE_MINUTE_MS:
            gap = {"product_id": product_id, "from_ms": feeder.last_one + ONE_MINUTE_MS, "to_ms": ones[0]["bucket_start"]}
            if gap not in experiment.gaps:
                experiment.gaps.append(gap)
        candles[product_id] = (ones, fives)
    return candles


def _load_funding(market_db, products):
    contexts = {product_id: funding_for(market_db, product_id) for product_id, _ in products}
    return {p: c for p, c in contexts.items() if c is not None}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Three-arm multi-strategy paper experiment (A strategies, B combiner, C Qwen).")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for multi.sqlite and multi-report.json")
    parser.add_argument("--experiment-id", default="exp1", help="a new id starts a fresh set of decisions")
    parser.add_argument("--qwen", choices=("off", "llama"), default="off")
    parser.add_argument("--rebuild", action="store_true",
                        help="ignore the checkpoint and rebuild every book from the start (after a hole in the candles was filled)")
    parser.add_argument("--verify", action="store_true",
                        help="after the pass, rebuild from scratch in memory on the stored selections and require the same ledger")
    parser.add_argument("--warmup-hours", type=float, default=None,
                        help="tests only: override the warm-up computed from the indicator windows")
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
        contexts = _load_funding(args.market_db, products)
        experiment = Experiment(
            store, [p for p, _ in products], qwen=qwen, experiment_id=args.experiment_id,
            funding_contexts=contexts, start_ms=start, clock=lambda cycle_ms: int(time.time() * 1000),
            tick_sizes=dict(products), warmup_ms=None if args.warmup_hours is None else args.warmup_hours * 3_600_000)
        resumed = False
        if args.rebuild:
            store.delete_checkpoint("experiment:" + args.experiment_id)
        else:
            reason = experiment.load_checkpoint()
            resumed = reason is None
            if reason not in (None, "no_checkpoint"):
                print("multi: checkpoint not used ({}); rebuilding from the start".format(reason), flush=True)
        candles = load_incremental(experiment, args.market_db, products, now)
        report = experiment.run(candles, include_table=False)
        args.rebuild = False
        info = experiment.save_checkpoint()
        report = dict(report, checkpoint=dict(info, resumed=resumed))
        if args.verify:
            full = load_cold(args.market_db, products, start, now, experiment.warmup_ms)
            report["verification"] = verify_against_rebuild(experiment, full)
            print("multi: verification {}".format("OK" if report["verification"]["equal"] else "DIFFERENT"), flush=True)
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
