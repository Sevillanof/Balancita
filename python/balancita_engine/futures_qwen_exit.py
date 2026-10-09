"""C31: Qwen decides when an open position closes, and owns the result (paper).

Entries come from the shipped deterministic specs (``config/qwen-exit.json``). From then on the position has
no stop loss, no take profit and no time stop: every few minutes Qwen is asked the ``exit_decision`` question
(``hold`` or ``close``, scope ``exit`` so the live process Q never asks it) and, when it answers ``close``,
the position closes at that candle's close with the shared costs. Whatever it is worth then is the realized
gain or loss, and it is never rewritten.

Qwen itself is not changed: same local model, same prompt template, same probabilities read from the logprobs,
and ``trade_action`` (buy / hold / sell) stays exactly as it was. What this adds is one more question and a
memory of its own judged answers (``ExitLessons``), the same idea as ``futures_llm_lessons``.

Honest limits, on purpose:

* No stop means the loss of a position that never recovers is not bounded by the strategy. Paper trades are
  fully collateralised 100 USD (a long cannot lose more than that); only a short can be liquidated, when the
  price has doubled. That backstop is bookkeeping, not risk management.
* Funding is charged to both sides at the product's mean absolute hourly rate (a conservative flat figure
  from ``analisis/costes-reales-kraken.md``), never received.
* Answers are cached by prompt, so replaying the history asks nothing new, but a different model or question
  is a different strategy: the runner refuses to continue a DB written with another one.

    python -m balancita_engine.futures_qwen_exit --market-db data/market.sqlite --out data/qwen-exit \\
        [--loop-seconds 1800]
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
from decimal import Decimal

from .futures_costs import fee_rate, side_impact_bps
from .futures_hits import gross_bp
from .futures_llm_calibration import calibration_from_pairs, format_lines as calibration_lines
from .futures_llm_decisions import (
    ModelResponseError,
    ModelUnavailable,
    StateError,
    ask_model,
    build_prompt,
    build_state,
    question_letters,
    temperature_for,
)
from .futures_products import resolve_products
from .futures_replay import load_range
from .futures_replay_qwen import AnswerCache
from .futures_simulator import DEFAULT_PERIODS, ONE_MINUTE_MS, Book, frames, merge_periods
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs, propose_spec, spec_hash

D = Decimal
STRATEGY_ID = "c31-qwen-exit-perp-v1"
QUESTION_ID = "exit_decision"
CONFIG_SCHEMA = "futures-qwen-exit.v1"
SUMMARY_SCHEMA = "futures-qwen-exit-summary.v1"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                           "config", "qwen-exit.json")
FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS
DEFAULT_MAX_ASKS = 30  # new model questions per pass: history is caught up a little at a time, the GPU stays cool
DEFAULT_ASK_PAUSE_SECONDS = 1.0
BACKLOG_LOOP_SECONDS = 300  # next pass while questions are still waiting
JUDGE_MS = 30 * ONE_MINUTE_MS  # an exit decision is judged by the price this much later
LIQUIDATION = D(1)  # adverse move, as a fraction of the entry fill, that wipes the 100 USD out
# Mean |funding| per hour in bp (30 days, analisis/costes-reales-kraken.md), charged to either side.
FUNDING_ABS_BP_PER_HOUR = {
    "PF_XBTUSD": "0.084", "PF_ETHUSD": "0.107", "PF_SOLUSD": "0.194", "PF_ZECUSD": "0.274",
    "PF_XRPUSD": "0.159", "PF_NEARUSD": "0.338", "PF_HYPEUSD": "0.235", "PF_ADAUSD": "0.178",
}
_SCHEMA = """
CREATE TABLE IF NOT EXISTS qwen_exit_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS qwen_exit_trade(
  product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS qwen_exit_decision(
  product_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(product_id, bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS qwen_exit_open(product_id TEXT PRIMARY KEY, payload TEXT) STRICT;
CREATE TRIGGER IF NOT EXISTS qwen_exit_trade_no_update BEFORE UPDATE ON qwen_exit_trade
  BEGIN SELECT RAISE(ABORT, 'qwen exit trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS qwen_exit_trade_no_delete BEFORE DELETE ON qwen_exit_trade
  BEGIN SELECT RAISE(ABORT, 'qwen exit trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS qwen_exit_decision_no_update BEFORE UPDATE ON qwen_exit_decision
  BEGIN SELECT RAISE(ABORT, 'qwen exit decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS qwen_exit_decision_no_delete BEFORE DELETE ON qwen_exit_decision
  BEGIN SELECT RAISE(ABORT, 'qwen exit decisions are append-only'); END;
"""


def check_interval_ms(held_ms):
    """How often Qwen is asked: every 5 minutes in the first hour, every 15 until 6 hours, hourly after."""
    if held_ms < 60 * ONE_MINUTE_MS:
        return FIVE_MINUTES_MS
    if held_ms < 360 * ONE_MINUTE_MS:
        return 15 * ONE_MINUTE_MS
    return 60 * ONE_MINUTE_MS


def _bp(value):
    return "{:+.1f}".format(float(value))


def _pct(part, whole):
    return "n/a" if not whole else "{}%".format(round(100 * part / whole))


class ExitLessons:
    """Qwen's judged exit answers and closed trades, as input for its next exit decision.

    A decision at bucket ``b`` is judged by the price at ``b + 30 min``: ``hold`` was right if the position
    stood higher (side-adjusted, gross from the entry fill) then than at ``b``, otherwise ``close`` was.
    It only shows up in decisions at ``n >= b + 30 min``, when that close exists, so nothing from the future
    reaches a decision. Closed trades are known the moment they close.
    """

    def __init__(self, window=40, examples=5, trades=5):
        self.window, self.examples, self.trades_shown = window, examples, trades
        self.decisions = []  # (bucket, chosen, side, entry, gross_bp, held_min)
        self.trades = []  # (exit_bucket, net_bp, held_min, worst_bp)

    def record_decision(self, bucket, chosen, side, entry, gross, held_min):
        self.decisions.append((bucket, chosen, side, entry, gross, held_min))

    def record_trade(self, exit_bucket, net_bp, held_min, worst_bp):
        self.trades.append((exit_bucket, net_bp, held_min, worst_bp))

    def judged(self, now_bucket, close_at):
        rows = []
        for bucket, chosen, side, entry, gross, held_min in self.decisions:
            later = bucket + JUDGE_MS
            if later > now_bucket:
                continue
            close = close_at(later)
            if close is None:
                continue
            after = gross_bp(side, entry, close)
            right = "hold" if after > gross else "close"
            rows.append({"chosen": chosen, "right": right, "gross": gross, "after": after, "held_min": held_min,
                         "point": 1 if chosen == right else -1})
        return rows[-self.window:]

    def text(self, now_bucket, close_at):
        rows = self.judged(now_bucket, close_at)
        shown = [t for t in self.trades if t[0] <= now_bucket][-self.trades_shown:]
        if not rows and not shown:
            return "exit_lessons: none yet"
        lines = []
        if rows:
            hits = sum(1 for r in rows if r["point"] == 1)
            mine = "; ".join("{} {}".format(a, _pct(sum(1 for r in rows if r["chosen"] == a and r["point"] == 1),
                                                    sum(1 for r in rows if r["chosen"] == a)))
                             for a in ("hold", "close") if any(r["chosen"] == a for r in rows))
            lines.append("exit_lessons: your last {} exit decisions, judged {} minutes later (+1 when the price "
                         "then favoured your choice): {} right of {} ({}); correct when you chose: {}".format(
                             len(rows), JUDGE_MS // ONE_MINUTE_MS, hits, len(rows), _pct(hits, len(rows)), mine))
            for r in rows[-self.examples:]:
                lines.append("exit_example: at {}bp after {}min you chose {}, 30min later it stood at {}bp, right was {} ({:+d})".format(
                    _bp(r["gross"]), r["held_min"], r["chosen"], _bp(r["after"]), r["right"], r["point"]))
        else:
            lines.append("exit_lessons: no exit decision is judged yet")
        if shown:
            lines.append("exit_trades: your last {} closed trades (net bp, minutes held, worst point): {}".format(
                len(shown), "; ".join("{} after {}min (worst {})".format(_bp(n), m, _bp(w)) for _, n, m, w in shown)))
        return "\n".join(lines)


class AskBudget:
    """New model questions allowed per pass, so catching up on history never pins the GPU.

    Answers already cached cost nothing. When the budget runs out ``spend`` raises ``ModelUnavailable``: the
    pass keeps what it has and the next one (soon, see ``BACKLOG_LOOP_SECONDS``) continues from the cache.
    ``pause_seconds`` leaves the GPU idle between two questions.
    """

    def __init__(self, limit, pause_seconds=0.0):
        self.limit, self.pause_seconds, self.used = limit, pause_seconds, 0

    def reset(self):
        self.used = 0

    @property
    def exhausted(self):
        return self.limit is not None and self.used >= self.limit

    def spend(self):
        if self.exhausted:
            raise ModelUnavailable("question budget of this pass used ({}); the rest waits for the next one".format(self.limit))
        if self.used and self.pause_seconds:
            time.sleep(self.pause_seconds)
        self.used += 1


class QwenExitDecider:
    """Asks Qwen ``hold`` or ``close`` for one product; keeps its answers and its memory.

    ``decide`` returns ``hold`` | ``close``, or ``None`` when the answer could not be read (the position
    simply stays open and is asked again at the next check). A model that is down raises ``ModelUnavailable``.
    """

    def __init__(self, provider, question, calibration, template, *, mode="auto", cache=None, budget=None):
        self.provider, self.question, self.calibration = provider, question, calibration
        self.budget = budget  # AskBudget shared by every product: caps the new model questions of one pass
        self.template, self.mode, self.cache = template, mode, cache or AnswerCache()
        self.letters = question_letters(question)
        self.model_ref = provider.identity().get("model_ref") or "unknown"
        self.lessons = ExitLessons()
        self.records, self.errors = [], []
        self._candles = {}

    def feed_candles(self, candles_1m):
        self._candles = {c["bucket_start"]: c for c in candles_1m}

    def close_at(self, bucket):
        candle = self._candles.get(bucket)
        return None if candle is None else candle["close"]

    def _window(self, bucket):
        found = (self._candles.get(b) for b in range(bucket - 60 * ONE_MINUTE_MS, bucket + 1, ONE_MINUTE_MS))
        return [c for c in found if c is not None]

    def decide(self, bucket, current, trend, regime, info):
        verdict = {"bucket_start_ms": bucket, "decision_known_at_ms": bucket + ONE_MINUTE_MS, "regime": regime,
                   "features": {"1m": current, "5m": trend}, "proposals": []}
        position = ("position: side={side} held_min={held_min} net_bp={net} best_bp={best} worst_bp={worst} "
                    "cost_to_close_bp={cost:.1f}").format(
                        side=info["side"].lower(), held_min=info["held_min"], net=_bp(info["net_bp"]),
                        best=_bp(info["best_bp"]), worst=_bp(info["worst_bp"]), cost=float(info["exit_cost_bp"]))
        try:
            state = build_state(verdict, self._window(bucket), self.question["state_fields"], position=position,
                                exit_lessons=self.lessons.text(bucket, self.close_at))
        except StateError:
            return None
        prompt = build_prompt(state, self.question, self.template)
        key = hashlib.sha256("\n".join((self.model_ref, self.mode, str(self.question["version"]), prompt)).encode()).hexdigest()
        answer = self.cache.get(key)
        if answer is None:
            if self.budget is not None:
                self.budget.spend()
            temperature = temperature_for(self.calibration, self.question["id"], self.question["version"])
            try:
                done = ask_model(self.provider, prompt, self.letters, self.question, temperature, self.template, self.mode)
            except ModelResponseError as error:
                self.errors.append({"bucket_start": bucket, "kind": error.kind})
                return None
            result = done["result"]
            answer = {"chosen": result["chosen"], "probabilities": result["probabilities"],
                      "confidence": result["confidence"], "source": done["source"]}
            self.cache.put(key, answer)
        self.lessons.record_decision(bucket, answer["chosen"], info["side"], info["entry"], info["gross_bp"],
                                     info["held_min"])
        self.records.append(dict(answer, bucket_start=bucket, held_min=info["held_min"], net_bp=info["net_bp"],
                                 side=info["side"], state_text=state))
        return answer["chosen"]


class QwenExitBook(Book):
    """The shared paper book with Qwen deciding the exit; entries come from ``entry_specs``."""

    def __init__(self, entry_specs, decider, **kwargs):
        super().__init__({"id": STRATEGY_ID}, **kwargs)
        self.entry_specs, self.decider = list(entry_specs), decider
        self.funding_bp_per_hour = D(FUNDING_ABS_BP_PER_HOUR.get(self.product, "0.34"))

    def _entry_proposal(self, current, common):
        found = [propose_spec(spec, current, **common) for spec in self.entry_specs]
        found = [p for p in found if p["action"] in ("LONG", "SHORT")]
        if not found or len({p["action"] for p in found}) > 1:  # nothing, or the specs disagree
            return None
        origin = found[0]
        return dict(origin, strategy_id=STRATEGY_ID, delegated_strategy_id=None,
                    reason_code="{}@{}".format(origin["reason_code"], origin["strategy_id"]))

    def _funding(self, start_ms, end_ms, notional, long):
        hours = D(max(0, end_ms - start_ms)) / D(3_600_000)
        return self.funding_bp_per_hour / D(10_000) * hours * notional, True

    def _info(self, bucket, close):
        position = self.position
        _, net, _, _ = self._settle(bucket, close, "qwen_close")
        entry, side = position["entry"], position["side"]
        gross = gross_bp(side, entry, close)
        position["best_bp"] = max(position.get("best_bp", gross), gross)
        position["worst_bp"] = min(position.get("worst_bp", gross), gross)
        net_bp = net / self.notional * D(10_000)
        return {"side": side, "entry": entry, "gross_bp": gross, "net_bp": net_bp,
                "held_min": int((bucket + ONE_MINUTE_MS - position["opened_at"]) // ONE_MINUTE_MS),
                "best_bp": position["best_bp"], "worst_bp": position["worst_bp"],
                "exit_cost_bp": fee_rate("taker") * D(10_000) + side_impact_bps(self.product)}

    def _manage(self, bucket, current, common):
        position = self.position
        long = position["side"] == "LONG"
        low, high, close = current.get("candidate_low"), current.get("candidate_high"), current.get("candidate_close")
        if close is None:
            return
        close = D(close)
        if low is not None and high is not None:
            wiped = position["entry"] * (1 - LIQUIDATION if long else 1 + LIQUIDATION)
            if (D(low) <= wiped) if long else (D(high) >= wiped):
                self._finish_qwen(bucket, wiped, "liquidation", None)
                return
        info = self._info(bucket, close)
        decision_time = bucket + ONE_MINUTE_MS
        last = position.setdefault("last_check", position["opened_at"])
        if decision_time % FIVE_MINUTES_MS or decision_time - last < check_interval_ms(decision_time - position["opened_at"]):
            return
        position["last_check"] = decision_time
        answer = self.decider.decide(bucket, current, common["trend"], common["regime"], info)
        if answer == "close":
            self._finish_qwen(bucket, close, "qwen_close", info)

    def _finish_qwen(self, bucket, price, reason, info):
        position = self.position
        best, worst = position.get("best_bp"), position.get("worst_bp")
        self._finish(bucket, price, reason)
        trade = self.trades[-1]
        held_min = int((trade["exit_time_ms"] - trade["entry_time_ms"]) // ONE_MINUTE_MS)
        trade.update(stop_price=None, target_price=None, held_min=held_min,
                     best_bp=None if best is None else float(round(best, 2)),
                     worst_bp=None if worst is None else float(round(worst, 2)))
        self.decider.lessons.record_trade(bucket, trade["net_bp"], held_min, trade["worst_bp"] or 0)

    def open_snapshot(self, bucket, close):
        """The open position valued at the last close, or ``None``."""
        if self.position is None:
            return None
        info = self._info(bucket, D(close))
        return {"side": info["side"], "held_min": info["held_min"], "net_bp": float(round(info["net_bp"], 2)),
                "best_bp": float(round(info["best_bp"], 2)), "worst_bp": float(round(info["worst_bp"], 2)),
                "entry_bucket_ms": self.position["opened_bucket"]}


# --------------------------------------------------------------------------- runner

def load_config(path=None):
    with open(path or CONFIG_PATH, encoding="utf-8") as handle:
        body = json.load(handle)
    if body.get("schema") != CONFIG_SCHEMA:
        raise ValueError("not a qwen exit config")
    return body


def _config_hash(config, specs):
    return hashlib.sha256(json.dumps({"start_ms": config["start_ms"], "notional": config["notional_usd"],
                                      "specs": sorted(config["entry_specs"]),
                                      "spec_hashes": {k: specs[k] for k in sorted(specs)}},
                                     sort_keys=True).encode()).hexdigest()


def _check_meta(db, values):
    for key, value in values.items():
        row = db.execute("SELECT value FROM qwen_exit_meta WHERE key=?", (key,)).fetchone()
        if row is None:
            db.execute("INSERT INTO qwen_exit_meta VALUES(?,?)", (key, value))
        elif row[0] != value:
            raise ValueError("this DB was written with another {} ({} -> {}); use a new --out".format(
                key, row[0], value))
    db.commit()


def run_once(market_db, db_path, config, specs, products, decider_factory, now_ms=None, log=print):
    """Replays every product from ``start_ms`` and stores what closed since; returns the run report."""
    entry_specs = [specs[i] for i in config["entry_specs"] if i in specs]
    if not entry_specs:
        raise ValueError("none of the entry specs exists")
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(s) for s in entry_specs))
    now = int(time.time() * 1000) if now_ms is None else now_ms
    db = sqlite3.connect(db_path)
    db.executescript(_SCHEMA)
    report = {"products": {}, "halted": []}
    try:
        for product_id, tick_size in products:
            try:
                ones, fives = load_range(market_db, product_id, config["start_ms"], now + ONE_MINUTE_MS)
            except ValueError:
                continue
            decider = decider_factory(product_id)
            _check_meta(db, {"model_ref": decider.model_ref,
                             "question": "{}@{}".format(decider.question["id"], decider.question["version"]),
                             "config": _config_hash(config, {s["id"]: spec_hash(s) for s in entry_specs})})
            decider.feed_candles(ones)
            book = QwenExitBook(entry_specs, decider, product_id=product_id, tick_size=tick_size,
                                notional_usd=config["notional_usd"])
            last_bucket = last_close = None
            halted = None
            for frame in frames(ones, fives, periods):
                if frame[0] < config["start_ms"]:
                    continue
                try:
                    book.on_frame(*frame)
                except ModelUnavailable as error:
                    halted = str(error)
                    break
                last_bucket, last_close = frame[0], frame[1].get("candidate_close")
            if halted:
                report["halted"].append(product_id)
                log("{}: Qwen is not available ({}); keeping what closed before".format(product_id, halted))
            with db:
                added = 0
                for trade in book.trades:
                    added += db.execute("INSERT OR IGNORE INTO qwen_exit_trade VALUES(?,?,?)",
                                        (product_id, trade["entry_bucket_ms"], json.dumps(trade))).rowcount
                for record in decider.records:
                    db.execute("INSERT OR IGNORE INTO qwen_exit_decision VALUES(?,?,?)",
                               (product_id, record["bucket_start"], json.dumps(record, default=str)))
                snapshot = None
                if last_close is not None and book.position is not None and not halted:
                    snapshot = book.open_snapshot(last_bucket, last_close)
                db.execute("INSERT OR REPLACE INTO qwen_exit_open VALUES(?,?)", (product_id, json.dumps(snapshot)))
            report["products"][product_id] = {"new_trades": added, "decisions": len(decider.records),
                                              "unreadable": len(decider.errors)}
    finally:
        db.close()
    return report


def _stats(trades):
    nets = sorted(t["net_bp"] for t in trades)
    holds = sorted(t["held_min"] for t in trades)
    wins = sum(1 for t in trades if t["hit"])
    return {
        "trades": len(trades), "wins": wins, "hit_rate": round(wins / len(trades), 4) if trades else None,
        "mean_net_bp": round(sum(nets) / len(nets), 2) if nets else None,
        "median_net_bp": nets[len(nets) // 2] if nets else None,
        "worst_net_bp": nets[0] if nets else None, "best_net_bp": nets[-1] if nets else None,
        "pnl_usd": round(sum(t["pnl_usd"] for t in trades), 4),
        "median_held_min": holds[len(holds) // 2] if holds else None,
        "longest_held_min": holds[-1] if holds else None,
    }


EXIT_ACTIONS = ("hold", "close")
_SIDE_IN_TEXT = re.compile(r"position: side=(long|short)")


def exit_calibration(db_path, market_db, config, now_ms=None):
    """Is Qwen's stated probability for hold / close honest? Same measures as ``trade_action``.

    Read-only. Each stored answer is judged like ``ExitLessons`` does: ``hold`` was right when the position
    (side-adjusted) stood higher ``JUDGE_MS`` later than at the decision, otherwise ``close`` was; the exit
    cost is paid whichever moment it closes, so it does not tilt the judgement. Decisions whose later close
    is not known yet are left out. Changes nothing about the question or the rule that closes positions.
    """
    now = int(time.time() * 1000) if now_ms is None else now_ms
    db = sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)
    try:
        stored = [(pid, json.loads(p)) for pid, p in db.execute(
            "SELECT product_id, payload FROM qwen_exit_decision ORDER BY bucket_ms, product_id")]
    finally:
        db.close()
    closes = {}
    for pid in {pid for pid, _ in stored}:
        try:
            ones, _ = load_range(market_db, pid, config["start_ms"], now + ONE_MINUTE_MS)
        except ValueError:
            ones = []
        closes[pid] = {c["bucket_start"]: c["close"] for c in ones}
    pairs = []
    for pid, record in stored:
        probs = record.get("probabilities") or {}
        side = record.get("side")
        if side is None:
            found = _SIDE_IN_TEXT.search(record.get("state_text") or "")
            side = found and found.group(1).upper()
        bucket = record["bucket_start"]
        now_close, later_close = closes[pid].get(bucket), closes[pid].get(bucket + JUDGE_MS)
        if not side or now_close is None or later_close is None or any(a not in probs for a in EXIT_ACTIONS):
            continue
        right = "hold" if gross_bp(side, now_close, later_close) > 0 else "close"
        pairs.append((dict(record, probabilities=probs), right))
    return calibration_from_pairs(pairs, EXIT_ACTIONS)


def write_summary(db_path, config, out_path, now_ms=None, market_db=None):
    """``futures-qwen-exit-summary.v1`` JSON, written atomically."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    db = sqlite3.connect(db_path)
    try:
        trades = [dict(json.loads(p), product_id=pid) for pid, p in db.execute(
            "SELECT product_id, payload FROM qwen_exit_trade ORDER BY product_id, entry_bucket_ms")]
        opened = {pid: json.loads(p) for pid, p in db.execute("SELECT product_id, payload FROM qwen_exit_open")
                  if p is not None and json.loads(p) is not None}
        decisions = {"hold": 0, "close": 0}
        for (payload,) in db.execute("SELECT payload FROM qwen_exit_decision"):
            decisions[json.loads(payload)["chosen"]] = decisions.get(json.loads(payload)["chosen"], 0) + 1
        meta = dict(db.execute("SELECT key, value FROM qwen_exit_meta"))
    finally:
        db.close()
    by_product = {}
    for trade in trades:
        by_product.setdefault(trade["product_id"], []).append(trade)
    body = {
        "schema": SUMMARY_SCHEMA, "strategy_id": STRATEGY_ID, "updated_ms": now, "start_ms": config["start_ms"],
        "model_ref": meta.get("model_ref"), "question": meta.get("question"), "closed": _stats(trades),
        "by_product": {p: _stats(t) for p, t in sorted(by_product.items())},
        "open_positions": opened, "open_net_bp": round(sum(o["net_bp"] for o in opened.values()), 2),
        "exit_decisions": decisions,
        "calibration": None if market_db is None else exit_calibration(db_path, market_db, config, now),
        "note": "Qwen decides every exit; no stop, target or time stop. Open positions are valued at the last close.",
    }
    temporary = out_path + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, out_path)
    return body


def default_decider_factory(cache_path, env=None, budget=None):
    """``product_id -> QwenExitDecider`` over the local llama.cpp server of the live process Q."""
    env = os.environ if env is None else env
    from . import futures_llm_decisions as llm

    questions = llm.load_questions(scope="exit")
    question = questions[QUESTION_ID]
    prompts = llm.load_prompt_config()
    provider = llm.LlamaCppProvider(llm.llama_url(env), llm.model_ref(env))
    calibration = llm.load_calibration()
    template = prompts["templates"][prompts["default_version"]]
    cache = AnswerCache(cache_path)

    def make(product_id):
        return QwenExitDecider(provider, question, calibration, template, mode=prompts["probability_source"],
                               cache=cache, budget=budget)

    return make


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for qwen-exit.sqlite and the summary JSON")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--loop-seconds", type=float, default=0, help="repeat every N seconds (0: once)")
    parser.add_argument("--llama-url", help="default: http://127.0.0.1:$LLAMA_PORT")
    parser.add_argument("--calibration", action="store_true",
                        help="print the calibration of the stored hold / close answers and exit (no model needed)")
    args = parser.parse_args(argv)
    if args.calibration:
        cal = exit_calibration(os.path.join(args.out, "qwen-exit.sqlite"), args.market_db, load_config(args.config))
        print("\n".join(calibration_lines(cal, lambda v: "n/a" if v is None else "{:.1f}%".format(100 * v))))
        return
    os.makedirs(args.out, exist_ok=True)
    env = dict(os.environ, **({"LLAMA_PORT": args.llama_url.rsplit(":", 1)[1]} if args.llama_url else {}))
    config, specs = load_config(args.config), load_specs(args.specs_dir)
    budget = AskBudget(int(env.get("QWENEXIT_MAX_ASKS_PER_PASS") or DEFAULT_MAX_ASKS),
                       float(env.get("QWENEXIT_ASK_PAUSE_SECONDS") or DEFAULT_ASK_PAUSE_SECONDS))
    factory = default_decider_factory(os.path.join(args.out, "answers.sqlite"), env, budget)
    products = resolve_products()
    db_path, summary_path = os.path.join(args.out, "qwen-exit.sqlite"), os.path.join(args.out, "qwen-exit-summary.json")
    while True:
        budget.reset()
        try:
            report = run_once(args.market_db, db_path, config, specs, products, factory)
            body = write_summary(db_path, config, summary_path, market_db=args.market_db)
            closed = body["closed"]
            print("{} closed={} mean_net_bp={} open={} asked={}".format(
                STRATEGY_ID, closed["trades"], closed["mean_net_bp"], len(body["open_positions"]),
                sum(p["decisions"] for p in report["products"].values())), flush=True)
        except ModelUnavailable as error:
            print("Qwen is not available, trying again later: {}".format(error), flush=True)
        if not args.loop_seconds:
            return
        # With questions still waiting (budget used up) come back soon, otherwise at the normal pace.
        time.sleep(min(args.loop_seconds, BACKLOG_LOOP_SECONDS) if budget.exhausted else args.loop_seconds)


if __name__ == "__main__":
    main()
