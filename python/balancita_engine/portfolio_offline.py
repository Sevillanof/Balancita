"""Offline deterministic executor for the shared paper portfolio (integration validation, isolated).

Replays synthetic 1-minute candles and ``balancita-signal.v1`` signals through the existing pieces and nothing else:
``multi_signals`` (signal contract), ``multi_risk.RiskPolicy.levels`` (stop/target, through ``portfolio.intent_from_signal``),
``portfolio.Portfolio`` (capital, sizing, limits, idempotency), the shared simulator ``Book`` (fills, fees, funding, exits)
and ``futures_costs`` (the only cost model). This module adds no trading logic and no second accounting engine; it adds
what an integration needs around them:

* event ordering and idempotency of the *events* (duplicate deliveries, conflicting or late candles);
* an append-only, hash-chained journal that lets every decision be reconstructed (signal, intent, validations, reasons,
  sizing, entry, stop, exit, costs and the effect on capital);
* independent invariant checks recomputed from raw trades and positions (not from the portfolio's own limit code);
* a checkpoint that a *new* executor can restore (digest, fingerprint, state digest, journal link) and a harness that
  simulates a crash and a restart.

No wall clock, no network, no database, no credentials and no randomness: the same scenario gives the same hashes.
It is not connected to the forward, ``capture``, Kronos, Qwen or any active database.
"""

import json
import os
import pickle
import tempfile
from decimal import Decimal

from .futures_costs import cost_model_hash, fee_rate
from .multi_signals import SELL, WAIT, stable_hash, validate_signal
from .portfolio import PORTFOLIO_SCHEMA, Portfolio, PortfolioError, PortfolioPolicy, intent_from_signal

D = Decimal
OFFLINE_SCHEMA = "balancita-portfolio-offline.v1"
CHECKPOINT_VERSION = 1
ONE_MINUTE_MS = 60_000
GENESIS = "0" * 64
SLACK = D("0.000001")        # Decimal rounding slack for exact-arithmetic identities
USD_TOLERANCE = D("0.0006")  # trades store pnl_usd rounded to 4 decimals and fees to 6

# Every rejection reason the portfolio can emit; anything else in a record is flagged by the checker.
KNOWN_REASONS = frozenset({
    "invalid_intent", "retroactive_decision", "retroactive_intent", "future_data", "stale_data", "cost_data_missing",
    "levels_unavailable", "target_does_not_clear_cost", "stop_loss_exceeds_notional_limit", "duplicate_intent",
    "duplicate_signal", "position_already_open", "opposite_position_open", "suspended_daily_loss",
    "suspended_drawdown", "inconsistent_signal", "contradictory_signals", "duplicate_same_side", "max_open_positions",
    "insufficient_margin", "open_risk_limit", "daily_loss_budget", "global_exposure_limit", "net_exposure_limit",
    "product_exposure_limit", "size_below_minimum"})


class RecoveryError(Exception):
    """A restart could not restore a persisted state. Re-running from the beginning is *not* a recovery."""

    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


def approved_policy():
    """The approved risk parameters. A scenario cannot change them."""
    return PortfolioPolicy()


# ------------------------------------------------------------------------------------------------ journal
class Journal:
    """Append-only chronological log; every entry carries the hash of the previous one.

    With ``path`` every entry is appended to a JSON-lines file and fsynced, so the journal survives the process that
    wrote it; ``Journal.load`` reads it back and refuses (``RecoveryError``) a missing, corrupt or foreign file.
    Without ``path`` it is in memory only. ``epoch`` grows by one on every restore, so the entries written after a
    checkpoint and before a crash (whose effects the restore discards) stay readable but are distinguishable from the
    ones that count.
    """

    def __init__(self, path=None):
        self.entries, self.head, self.epoch, self.path = [], GENESIS, 0, path
        if path:
            with open(path, "w", encoding="utf-8"):  # a new journal starts an empty file
                pass

    def add(self, t_ms, kind, data):
        body = {"seq": len(self.entries) + 1, "epoch": self.epoch, "t_ms": int(t_ms), "kind": kind,
                "data": _plain(data), "prev": self.head}
        body["hash"] = stable_hash(body)
        self.entries.append(body)
        self.head = body["hash"]
        if self.path:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        return body

    def verify(self):
        """Recomputes the chain. Returns ``None`` when intact, else the first broken sequence number."""
        prev = GENESIS
        for entry in self.entries:
            body = {k: v for k, v in entry.items() if k != "hash"}
            if body["prev"] != prev or stable_hash(body) != entry["hash"]:
                return entry["seq"]
            prev = entry["hash"]
        return None

    @classmethod
    def load(cls, path, scenario=None):
        """The journal persisted at ``path``, ready to be appended to. Nothing is repaired or skipped."""
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise RecoveryError("journal_missing", path)
        journal = cls.__new__(cls)
        journal.entries, journal.path = [], path
        try:
            with open(path, encoding="utf-8") as handle:
                for number, line in enumerate(handle, start=1):
                    entry = json.loads(line)
                    if not isinstance(entry, dict) or entry.get("seq") != number or "hash" not in entry:
                        raise ValueError("line {} is not journal entry {}".format(number, number))
                    journal.entries.append(entry)
        except (ValueError, UnicodeDecodeError) as error:
            raise RecoveryError("journal_corrupt", str(error)) from error
        broken = journal.verify()
        if broken is not None:
            raise RecoveryError("journal_corrupt", "hash chain broken at entry {}".format(broken))
        journal.head = journal.entries[-1]["hash"]
        journal.epoch = journal.entries[-1]["epoch"]
        first = journal.entries[0]
        if first["kind"] != "scenario_start":
            raise RecoveryError("journal_incompatible", "does not start with scenario_start")
        if scenario is not None and first["data"].get("scenario_hash") != scenario["scenario_hash"]:
            raise RecoveryError("journal_incompatible", "written for another scenario")
        return journal


def _plain(value):
    """Freezes a value into plain JSON types (Decimals as strings) so hashes never depend on object identity."""
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _candle_digest(candle):
    return stable_hash({k: str(candle[k]) for k in ("open", "high", "low", "close")})


# ------------------------------------------------------------------------------------------------ executor
class OfflineExecutor:
    def __init__(self, scenario, journal):
        self.scenario, self.journal = scenario, journal
        self.policy = approved_policy()
        self.portfolio = Portfolio(self.policy, funding=scenario.get("funding") or {})
        self.seen_events = set()
        self.candle_seen = {}       # (product, bucket) -> digest of the first candle accepted for it
        self.last_arrival_ms = None
        self.feed_hash = GENESIS    # rolling hash of the candles applied, in order
        self.stats = {}
        self.violations = []
        self.checks = 0
        self.intents = {}           # intent_id -> intent, for tracing (not needed to decide)
        self.catching_up = False    # True while events older than the restart point are replayed
        self.replay = False
        self._duplicates = []

    # ---- bookkeeping --------------------------------------------------------------------------------------
    def _count(self, name, n=1):
        self.stats[name] = self.stats.get(name, 0) + n

    def _log(self, t_ms, kind, **data):
        if self.replay:
            data["replay"] = True
        if self.catching_up:
            data["catch_up"] = True
        return self.journal.add(t_ms, kind, data)

    def _capital_view(self):
        s = self.portfolio.snapshot()
        return {k: s[k] for k in ("capital_definitive_usd", "provisional_gains_usd", "equity_usd", "reserved_usd",
                                  "available_usd", "risk_budget_usd", "open_risk_usd", "gross_exposure_usd",
                                  "long_exposure_usd", "short_exposure_usd", "net_exposure_usd", "open_positions",
                                  "closed_trades", "drawdown_usd")}

    # ---- processing ---------------------------------------------------------------------------------------
    def process(self, arrival_ms, events):
        """One arrival minute: candles first (they release capital), then the signals that arrived with them."""
        self._duplicates = []
        candles = sorted((e for e in events if e["kind"] == "candle"), key=lambda e: (e["product_id"], e["event_id"]))
        signals = [e for e in events if e["kind"] == "signal"]
        for event in candles:
            self._candle(arrival_ms, event)
        self._signals(arrival_ms, signals)
        self._flush_duplicates(arrival_ms)
        self.last_arrival_ms = arrival_ms if self.last_arrival_ms is None else max(self.last_arrival_ms, arrival_ms)

    def _fresh(self, arrival_ms, event):
        if event["event_id"] in self.seen_events:
            self._count("duplicate_events_ignored")
            self._duplicates.append(event["event_id"])
            return False
        self.seen_events.add(event["event_id"])
        return True

    def _flush_duplicates(self, arrival_ms):
        """One entry per batch for events already seen (an at-least-once redelivery can repeat dozens)."""
        ids = sorted(self._duplicates)
        if ids:
            self._log(arrival_ms, "duplicate_events_ignored", count=len(ids), ids_hash=stable_hash(ids),
                      event_ids=ids if len(ids) <= 10 else ids[:3] + ["..."] + ids[-3:])

    def _candle(self, arrival_ms, event):
        if not self._fresh(arrival_ms, event):
            return
        product, bucket, candle = event["product_id"], int(event["bucket_ms"]), event["candle"]
        key, digest = (product, bucket), _candle_digest(candle)
        if key in self.candle_seen:
            same = self.candle_seen[key] == digest
            self._count("duplicate_candles_ignored" if same else "conflicting_candles_rejected")
            self._log(arrival_ms, "duplicate_candle_ignored" if same else "conflicting_candle_rejected",
                      event_id=event["event_id"], product_id=product, bucket_ms=bucket,
                      kept_digest=self.candle_seen[key], received_digest=digest)
            return
        last = self.portfolio.last_bucket.get(product)
        if last is not None and bucket <= last:
            self._count("late_candles_refused")
            self._log(arrival_ms, "late_candle_refused", event_id=event["event_id"], product_id=product,
                      bucket_ms=bucket, last_bucket_ms=last)
            return
        if last is not None and bucket - last > ONE_MINUTE_MS and product in self.portfolio.positions:
            self._log(arrival_ms, "candle_gap", product_id=product, missing_minutes=(bucket - last) // ONE_MINUTE_MS - 1,
                      after_bucket_ms=last, note="stops are evaluated only on the candles received")
        self.candle_seen[key] = digest
        self.feed_hash = stable_hash([self.feed_hash, product, bucket, digest])
        self._count("candles_applied")
        book = self.portfolio.positions.get(product)
        intent = book.intent if book is not None else None
        before = self._capital_view()
        try:
            closed = self.portfolio.on_candle(product, bucket, candle)
        except PortfolioError as error:  # defensive: the checks above should have caught it
            self._count("candles_refused_by_portfolio")
            self._log(arrival_ms, "candle_refused_by_portfolio", event_id=event["event_id"], error=str(error))
            return
        for trade in closed:
            self._closed(arrival_ms, trade, intent, before)
            before = self._capital_view()
        if closed:
            self._check_state(arrival_ms)

    def _closed(self, t_ms, trade, intent, before):
        entry, exit_, qty = D(trade["entry_price"]), D(trade["exit_price"]), D(trade["quantity"])
        gross = (exit_ - entry) * qty if trade["side"] == "LONG" else (entry - exit_) * qty
        reference = D(intent["price"])
        entry_impact = abs(entry - reference) * qty
        after = self._capital_view()
        self._count("positions_closed")
        data = dict(
            trade_id=trade["trade_id"], intent_id=trade["intent_id"], product_id=trade["product_id"],
            strategy_id=trade["strategy_id"], side=trade["side"], notional_usd=trade["notional_usd"],
            reference_price=intent["price"], entry_price=trade["entry_price"], stop_price=trade["stop_price"],
            target_price=trade["target_price"], exit_price=trade["exit_price"], exit_reason=trade["exit_reason"],
            entry_time_ms=trade["entry_time_ms"], exit_time_ms=trade["exit_time_ms"],
            held_minutes=(trade["exit_time_ms"] - trade["entry_time_ms"]) // ONE_MINUTE_MS,
            gross_usd=str(gross), fees_usd=trade["fees_usd"], entry_impact_usd=str(entry_impact),
            funding_usd=trade["funding_usd"], funding_status=trade["funding_status"],
            funding_covered_ms=trade["funding_covered_ms"], funding_held_ms=trade["funding_held_ms"],
            pnl_usd=trade["pnl_usd"], net_complete=trade["net_complete"], planned_loss_usd=trade["planned_loss_usd"],
            accounting="verified" if trade["net_complete"] else "provisional",
            capital_before_usd=before["capital_definitive_usd"], capital_after_usd=after["capital_definitive_usd"],
            state_after=after)
        self._check_trade(t_ms, trade, gross)
        self._log(t_ms, "position_closed", **data)

    def _signals(self, arrival_ms, events):
        intents = []
        for event in sorted(events, key=lambda e: (e["signal"]["product_id"], e["event_id"])):
            if not self._fresh(arrival_ms, event):
                continue
            signal = event["signal"]
            self._count("signals_received")
            try:
                validate_signal(signal)
            except ValueError as error:
                self._count("signals_invalid")
                self._log(arrival_ms, "signal_invalid", event_id=event["event_id"], error=str(error),
                          signal_id=signal.get("signal_id"))
                continue
            self._log(arrival_ms, "signal_received", event_id=event["event_id"], signal_id=signal["signal_id"],
                      strategy_id=signal["strategy_id"], product_id=signal["product_id"], action=signal["action"],
                      strength=signal["strength"], bucket_ms=signal["bucket_ms"], horizon_minutes=signal["horizon_minutes"],
                      price=event["price"], atr=event["atr"], delay_ms=arrival_ms - (signal["bucket_ms"] + ONE_MINUTE_MS))
            if signal["action"] == WAIT:
                continue
            intent = intent_from_signal(signal, price=event["price"], atr=event["atr"],
                                        data_close_ms=signal["bucket_ms"] + ONE_MINUTE_MS)
            if intent is None:
                self._count("intents_not_built")
                self._log(arrival_ms, "intent_not_built", event_id=event["event_id"], signal_id=signal["signal_id"],
                          reason="no valid protective levels from price/ATR")
                continue
            self.intents[intent["intent_id"]] = dict(intent, event_id=event["event_id"])
            self._count("intents_built")
            self._log(arrival_ms, "intent_built", event_id=event["event_id"], intent_id=intent["intent_id"],
                      signal_id=signal["signal_id"], product_id=intent["product_id"], side=intent["side"],
                      reference_price=intent["price"], stop=intent["stop"], target=intent["target"],
                      horizon_minutes=intent["horizon_minutes"], strength=intent["strength"])
            intents.append(intent)
        if not intents:
            return
        pre = self._risk_view(arrival_ms)
        records = self.portfolio.decide(intents, arrival_ms)
        self._check_decisions(arrival_ms, records, pre)
        for record in records:
            intent = self.intents[record["intent_id"]]
            self._count("decisions_" + record["status"])
            if record["status"] == "rejected":
                for reason in record["reasons"]:
                    self._count("rejected:" + reason)
            body = dict(record, signal_id=intent.get("signal_id"), event_id=intent["event_id"],
                        reference_price=intent["price"], stop=intent["stop"], target=intent["target"],
                        horizon_minutes=intent["horizon_minutes"])
            body["state_after_batch"] = self._capital_view()
            self._log(arrival_ms, "decision", **body)

    # ---- independent checks -------------------------------------------------------------------------------
    def _violate(self, t_ms, rule, **detail):
        self.violations.append({"t_ms": t_ms, "rule": rule, **_plain(detail)})
        self._log(t_ms, "invariant_violation", rule=rule, **detail)

    def _risk_view(self, now_ms):
        """What the admission checks need, recomputed from raw trades and positions before a decision batch."""
        p = self.portfolio
        capital = D(p.policy.initial_equity_usd)
        today = now_ms // 86_400_000
        lost_today, running, peak, drawdown = D(0), D(0), D(0), D(0)
        for trade in p.trades:
            pnl = D(str(trade["pnl_usd"]))
            conservative = pnl if trade["net_complete"] else min(D(0), pnl)
            capital += D(str(trade["net_usd"])) if trade["net_complete"] else min(D(0), pnl)
            if trade["exit_time_ms"] // 86_400_000 == today:
                lost_today += conservative
            running += conservative
            peak = max(peak, running)
            drawdown = max(drawdown, peak - running)
        books = list(p.positions.values())
        return {"capital": capital, "realized_today": lost_today, "drawdown": drawdown,
                "gross": sum((b.notional for b in books), D(0)),
                "long": sum((b.notional for b in books if b.position["side"] == "LONG"), D(0)),
                "short": sum((b.notional for b in books if b.position["side"] == "SHORT"), D(0)),
                "open_risk": sum((b.planned_loss_usd for b in books), D(0)), "positions": len(books)}

    def _check_decisions(self, t_ms, records, pre):
        """Admission limits, recomputed from the policy and the raw state, for every position opened in the batch."""
        p, run = self.policy, dict(pre)
        for record in records:
            self.checks += 1
            if record["status"] == "rejected":
                unknown = sorted(set(record["reasons"]) - KNOWN_REASONS)
                if not record["reasons"] or unknown:
                    self._violate(t_ms, "rejection_without_known_reason", intent_id=record["intent_id"], unknown=unknown)
                continue
            capital = pre["capital"]
            notional, planned = D(record["notional_usd"]), D(record["planned_loss_usd"])
            side, loss_fraction = record["side"], D(record["loss_fraction"])
            run["gross"] += notional
            run["long" if side == "LONG" else "short"] += notional
            run["open_risk"] += planned
            run["positions"] += 1
            directional = run["long"] - run["short"] if side == "LONG" else run["short"] - run["long"]
            rules = {
                "risk_per_trade": planned <= D(p.risk_per_trade) * capital + SLACK,
                "aggregate_open_risk": run["open_risk"] <= D(p.max_open_risk_pct) * capital + SLACK,
                "gross_exposure": run["gross"] <= D(p.max_gross_exposure_pct) * capital + SLACK,
                "product_exposure": notional <= D(p.max_product_exposure_pct) * capital + SLACK,
                "net_exposure": directional <= D(p.max_net_exposure_pct) * capital + SLACK,
                "margin": run["gross"] / D(p.leverage) <= capital + SLACK,
                "loss_fraction_30pct": loss_fraction <= D(p.max_loss_fraction_of_notional),
                "min_notional": notional >= D(p.min_notional_usd),
                "max_open_positions": run["positions"] <= p.max_open_positions,
                "daily_loss_room": max(D(0), -pre["realized_today"]) + run["open_risk"] <= D(p.daily_loss_limit_usd) + SLACK,
                "not_suspended_daily": pre["realized_today"] > -D(p.daily_loss_limit_usd),
                "not_suspended_drawdown": pre["drawdown"] < D(p.max_drawdown_usd),
                "capital_matches_record": D(record["capital_definitive_usd"]) == capital,
            }
            for rule, ok in rules.items():
                if not ok:
                    self._violate(t_ms, rule, intent_id=record["intent_id"], product_id=record["product_id"],
                                  notional=str(notional), planned=str(planned), capital=str(capital))

    def _check_trade(self, t_ms, trade, gross):
        """Accounting identity of one closed trade and, for a stop, agreement with the planned loss."""
        self.checks += 1
        funding = D(str(trade["funding_usd"])) if trade["funding_usd"] is not None else D(0)
        fees = (D(trade["entry_price"]) + D(trade["exit_price"])) * D(trade["quantity"]) * fee_rate("taker")
        if abs(gross - fees - funding - D(str(trade["pnl_usd"]))) > USD_TOLERANCE:
            self._violate(t_ms, "trade_identity", trade_id=trade["trade_id"], gross=str(gross), fees=str(fees),
                          funding=str(funding), pnl=trade["pnl_usd"])
        if abs(fees - D(str(trade["fees_usd"]))) > USD_TOLERANCE:
            self._violate(t_ms, "fees_recomputed", trade_id=trade["trade_id"])
        if trade["exit_reason"] == "stop":
            # The shared simulator exits a stop at the modelled stop price, so apart from funding the loss must equal
            # the planned one. A difference means sizing and execution disagree about costs.
            realized_loss = -(gross - fees)
            if abs(realized_loss - D(str(trade["planned_loss_usd"]))) > USD_TOLERANCE:
                self._violate(t_ms, "stop_loss_matches_plan", trade_id=trade["trade_id"],
                              realized=str(realized_loss), planned=str(trade["planned_loss_usd"]))

    def _check_state(self, t_ms):
        """Capital and exposure identities recomputed from raw trades and open books."""
        self.checks += 1
        p = self.portfolio
        view = self._risk_view(t_ms)
        snap = p.snapshot()
        equity = D(p.policy.initial_equity_usd) + sum((D(str(t["pnl_usd"])) for t in p.trades), D(0))
        checks = {
            "capital_recomputed": view["capital"] == D(snap["capital_definitive_usd"]),
            "equity_recomputed": equity == D(snap["equity_usd"]),
            "gross_recomputed": view["gross"] == D(snap["gross_exposure_usd"]),
            "net_recomputed": view["long"] - view["short"] == D(snap["net_exposure_usd"]),
            "reserved_is_gross_over_leverage": D(snap["reserved_usd"]) == view["gross"] / D(p.policy.leverage),
            "available_is_capital_minus_reserved": D(snap["available_usd"]) == D(snap["capital_definitive_usd"]) - D(snap["reserved_usd"]),
            "open_risk_recomputed": view["open_risk"] == D(snap["open_risk_usd"]),
            "provisional_gains_never_spendable": D(snap["capital_definitive_usd"]) <= equity - D(snap["provisional_gains_usd"]) + SLACK,
            "one_position_per_product": len(p.positions) == len({k for k in p.positions}),
        }
        for rule, ok in checks.items():
            if not ok:
                self._violate(t_ms, rule, snapshot=snap)

    def check_time_order(self):
        """Journal time never goes backwards within an epoch, counting live entries and replayed ones separately
        (a replay re-processes old events at their original times, after the restart entry)."""
        for replayed in (False, True):
            times = [e["t_ms"] for e in self.journal.entries
                     if e["epoch"] == self.journal.epoch and bool(e["data"].get("replay")) == replayed]
            if any(a > b for a, b in zip(times, times[1:])):
                return False
        return True

    # ---- state and checkpoint ---------------------------------------------------------------------------------
    def state_digest(self):
        """Canonical digest of everything that decides the future (not of the pickle bytes)."""
        p = self.portfolio
        positions = {product: {
            "intent_id": book.intent["intent_id"], "side": book.position["side"], "notional": str(book.notional),
            "entry": str(book.position["entry"]), "stop": str(book.position["stop"]),
            "target": book.position["target_text"], "opened_at": book.position["opened_at"],
            "horizon_ms": book.position["horizon_ms"], "planned_loss": str(book.planned_loss_usd)}
            for product, book in sorted(p.positions.items())}
        return stable_hash({
            "snapshot": p.snapshot(), "ledger": p.ledger_hash(), "positions": positions,
            "last_bucket": dict(sorted(p.last_bucket.items())), "marks": {k: str(v) for k, v in sorted(p.marks.items())},
            "opened_intents": sorted(p.opened_intents), "opened_signals": sorted(p.opened_signals),
            "last_decision_ms": p.last_decision_ms, "seen_events": stable_hash(sorted(self.seen_events)),
            "candle_seen": stable_hash(sorted([list(k), v] for k, v in self.candle_seen.items())),
            "feed_hash": self.feed_hash, "last_arrival_ms": self.last_arrival_ms})

    def fingerprint(self):
        return stable_hash({
            "checkpoint_version": CHECKPOINT_VERSION, "offline_schema": OFFLINE_SCHEMA, "portfolio_schema": PORTFOLIO_SCHEMA,
            "scenario": self.scenario["scenario_hash"], "policy": self.policy.policy_hash(), "cost_model": cost_model_hash()})

    def checkpoint(self):
        """A restorable image of the state, tied to the journal position it was taken at."""
        state = {"portfolio": self.portfolio, "seen_events": self.seen_events, "candle_seen": self.candle_seen,
                 "last_arrival_ms": self.last_arrival_ms, "feed_hash": self.feed_hash, "stats": self.stats,
                 "checks": self.checks, "violations": self.violations, "intents": self.intents}
        blob = pickle.dumps(state, protocol=4)
        return {"version": CHECKPOINT_VERSION, "fingerprint": self.fingerprint(), "digest": stable_hash(blob.hex()),
                "state_digest": self.state_digest(), "arrival_ms": self.last_arrival_ms,
                "journal_seq": len(self.journal.entries), "journal_hash": self.journal.head, "blob": blob}

    @classmethod
    def restore(cls, scenario, journal, checkpoint, *, restart_ms=None):
        """A new executor from a persisted checkpoint. Raises ``RecoveryError`` when it cannot be trusted.

        There is no fallback to starting over: a silent re-run would hide that the persisted state was unusable.
        """
        if checkpoint is None:
            raise RecoveryError("no_checkpoint", "nothing persisted; replaying from the start is not a recovery")
        if journal is None:
            raise RecoveryError("journal_missing", "a checkpoint without its journal cannot be audited or continued")
        executor = cls(scenario, journal)
        if checkpoint.get("fingerprint") != executor.fingerprint():
            raise RecoveryError("configuration_changed")
        if stable_hash(checkpoint["blob"].hex()) != checkpoint["digest"]:
            raise RecoveryError("corrupt_checkpoint")
        seq = checkpoint["journal_seq"]
        if len(journal.entries) < seq or (seq and journal.entries[seq - 1]["hash"] != checkpoint["journal_hash"]):
            raise RecoveryError("journal_mismatch", "the journal does not contain the checkpoint's position")
        if journal.verify() is not None:
            raise RecoveryError("journal_chain_broken")
        try:
            state = pickle.loads(checkpoint["blob"])  # our own file, written by checkpoint(); same practice as multi_experiment
        except Exception as error:
            raise RecoveryError("unreadable_checkpoint", str(error)) from error
        executor.portfolio, executor.seen_events, executor.candle_seen = state["portfolio"], state["seen_events"], state["candle_seen"]
        executor.last_arrival_ms, executor.feed_hash, executor.stats = state["last_arrival_ms"], state["feed_hash"], state["stats"]
        executor.checks, executor.violations, executor.intents = state["checks"], state["violations"], state["intents"]
        if executor.state_digest() != checkpoint["state_digest"]:
            raise RecoveryError("state_mismatch", "the restored state does not hash to the saved one")
        tail = journal.entries[seq:]
        journal.epoch += 1
        executor._log(restart_ms if restart_ms is not None else (executor.last_arrival_ms or 0), "restart",
                      checkpoint_arrival_ms=checkpoint["arrival_ms"], checkpoint_journal_seq=seq,
                      state_digest=checkpoint["state_digest"], uncommitted_tail_entries=len(tail),
                      uncommitted_tail_first_seq=tail[0]["seq"] if tail else None,
                      uncommitted_tail_hash=tail[-1]["hash"] if tail else None,
                      note="entries after the checkpoint stay in the journal but their effects are discarded")
        return executor


def write_checkpoint(path, checkpoint):
    """Atomic write: temp file in the same directory, fsync, rename."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".ckpt-")
    try:
        with os.fdopen(fd, "wb") as handle:
            pickle.dump(checkpoint, handle, protocol=4)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_checkpoint(path):
    try:
        with open(path, "rb") as handle:
            return pickle.load(handle)  # our own file
    except FileNotFoundError:
        return None
    except Exception as error:
        raise RecoveryError("unreadable_checkpoint", str(error)) from error


# ------------------------------------------------------------------------------------------------ harness
def _groups(events):
    """Events by arrival minute, in processing order."""
    order = {"candle": 0, "signal": 1}
    ordered = sorted(events, key=lambda e: (e["arrival_ms"], order[e["kind"]], e.get("product_id") or e["signal"]["product_id"], e["event_id"]))
    out, current, key = [], [], None
    for event in ordered:
        if event["arrival_ms"] != key:
            if current:
                out.append((key, current))
            current, key = [], event["arrival_ms"]
        current.append(event)
    if current:
        out.append((key, current))
    return out


def begin(scenario, journal):
    """A fresh executor whose journal opens with the scenario it belongs to."""
    executor = OfflineExecutor(scenario, journal)
    executor._log(scenario["start_ms"], "scenario_start", name=scenario["name"], scenario_hash=scenario["scenario_hash"],
                  policy_hash=executor.policy.policy_hash(), cost_model=cost_model_hash(), events=len(scenario["events"]),
                  products=sorted(scenario["products"]))
    return executor


def _crash_minute(scenario):
    return scenario["start_ms"] + scenario["restart"]["crash_after_min"] * ONE_MINUTE_MS


def first_process(scenario, executor, groups, save_checkpoint):
    """Everything the process that dies does: it runs until the crash minute, saving a checkpoint every so often
    through ``save_checkpoint(checkpoint)`` (memory or file), then writes the last note and is gone."""
    restart = scenario["restart"]
    every, crash_ms, last_saved = restart["checkpoint_every_min"] * ONE_MINUTE_MS, _crash_minute(scenario), scenario["start_ms"]
    for arrival, batch in groups:
        if arrival > crash_ms:
            break
        executor.process(arrival, batch)
        if arrival - last_saved >= every:
            ckpt = executor.checkpoint()
            # the image is taken first, so its journal_seq does not include the note below
            executor._log(arrival, "checkpoint_saved", arrival_ms=ckpt["arrival_ms"], state_digest=ckpt["state_digest"],
                          journal_seq=ckpt["journal_seq"])
            save_checkpoint(ckpt)
            last_saved = arrival
    executor._log(crash_ms, "simulation_note", note="process killed here; memory is lost, journal and checkpoint file survive")
    return len(executor.journal.entries)


def second_process(scenario, journal, stored, groups):
    """Everything the new process does: restore from what survived (or fail), catch up, and finish the scenario.
    Returns ``(executor, info)``."""
    restart = scenario["restart"]
    crash_ms = _crash_minute(scenario)
    restart_ms = scenario["start_ms"] + restart["restart_at_min"] * ONE_MINUTE_MS
    executor = OfflineExecutor.restore(scenario, journal, stored, restart_ms=restart_ms)  # no silent fallback
    mode, lost = restart["mode"], []
    before = [g for g in groups if g[0] <= crash_ms]
    pending = [g for g in groups if g[0] > crash_ms]
    # events processed after the checkpoint but before the crash are not in the restored state
    redo = [g for g in before if g[0] > stored["arrival_ms"]]
    overlap_from = stored["arrival_ms"] - restart.get("overlap_min", 0) * ONE_MINUTE_MS
    redelivered = [g for g in before if overlap_from < g[0] <= stored["arrival_ms"]]
    executor.replay = True
    executor.catching_up = True
    if mode == "replay_log":
        # the input log is durable: redeliver from a little before the checkpoint (at-least-once) up to the restart
        for arrival, batch in redelivered + redo + [g for g in pending if g[0] <= restart_ms]:
            executor.process(arrival, batch)
    elif mode == "live_gap":
        # candles are backfilled from storage; signals produced after the checkpoint and before the restart are gone
        for arrival, batch in redelivered + redo + [g for g in pending if g[0] <= restart_ms]:
            kept = [e for e in batch if e["kind"] == "candle" or arrival <= stored["arrival_ms"]]
            lost.extend(e["event_id"] for e in batch if e not in kept)
            executor.process(arrival, kept)
        executor._log(restart_ms, "simulation_note", note="signals never delivered to the restarted process",
                      lost_signal_events=sorted(lost), detectable_by_the_system=False)
    else:
        raise ValueError("unknown restart mode {!r}".format(mode))
    executor.catching_up = False
    executor.replay = False
    for arrival, batch in [g for g in pending if g[0] > restart_ms]:
        executor.process(arrival, batch)
    info = {"mode": mode, "checkpoint_arrival_ms": stored["arrival_ms"], "crash_after_min": restart["crash_after_min"],
            "restart_at_min": restart["restart_at_min"], "lost_signal_events": sorted(lost)}
    return executor, info


def compare_with_uninterrupted(scenario, done):
    """Fills ``done["restart"]`` with the comparison against a run that never crashed."""
    reference = run_scenario(dict(scenario, restart=None))
    done["restart"].update(
        equivalent_ledger=done["ledger_hash"] == reference["ledger_hash"],
        equivalent_state=done["state_digest"] == reference["state_digest"],
        equivalent_feed=done["feed_hash"] == reference["feed_hash"],
        reference_ledger_hash=reference["ledger_hash"], reference_state_digest=reference["state_digest"],
        reference_capital_usd=reference["snapshot"]["capital_definitive_usd"],
        reference_closed_trades=reference["snapshot"]["closed_trades"])
    done["reference"] = reference
    return done


def run_scenario(scenario, *, checkpoint_dir=None, tamper=None):
    """Runs a scenario end to end inside ONE Python process. With ``scenario["restart"]`` it crashes (the executor is
    discarded), builds a *new* executor from the persisted checkpoint and continues. For a restart across two real
    processes, with the journal on disk too, see ``portfolio_two_process``.

    ``tamper(checkpoint)`` lets a test damage the persisted checkpoint before the restart.
    """
    restart = scenario.get("restart")
    journal = Journal()
    executor = begin(scenario, journal)
    groups = _groups(scenario["events"])
    result = {"name": scenario["name"], "scenario_hash": scenario["scenario_hash"], "restart": None}
    if not restart:
        for arrival, batch in groups:
            executor.process(arrival, batch)
        return _finish(executor, result, groups)
    disk = os.path.join(checkpoint_dir, "{}.ckpt".format(scenario["name"])) if checkpoint_dir else None
    memory_disk = {}
    save = (lambda ckpt: write_checkpoint(disk, ckpt)) if disk else (lambda ckpt: memory_disk.update(ckpt=ckpt))
    crash_entry_seq = first_process(scenario, executor, groups, save)
    del executor
    stored = read_checkpoint(disk) if disk else memory_disk.get("ckpt")
    if tamper is not None and stored is not None:
        stored = tamper(stored)
    executor, info = second_process(scenario, journal, stored, groups)
    result["restart"] = dict(info, journal_entries_before_crash=crash_entry_seq, restored_from="file" if disk else "memory")
    return compare_with_uninterrupted(scenario, _finish(executor, result, groups))


def _finish(executor, result, groups):
    p = executor.portfolio
    executor._check_state(groups[-1][0] if groups else 0)
    executor._log(groups[-1][0] if groups else 0, "scenario_end", state=executor._capital_view(), ledger_hash=p.ledger_hash(),
                  state_digest=executor.state_digest())
    result.update(
        snapshot=p.snapshot(), ledger_hash=p.ledger_hash(), state_digest=executor.state_digest(),
        journal_hash=executor.journal.head, journal_entries=len(executor.journal.entries),
        journal_chain_intact=executor.journal.verify() is None, feed_hash=executor.feed_hash,
        checks=executor.checks, violations=executor.violations, stats=dict(sorted(executor.stats.items())),
        time_order_ok=executor.check_time_order(), journal=executor.journal, executor=executor)
    return result
