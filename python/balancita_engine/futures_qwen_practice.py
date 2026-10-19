"""Qwen practice: what would local Qwen have decided for every historical signal of C25-C32, blind?

Decision (owner): Qwen's job is to FILTER the BUY/SELL signals of each strategy, independently per strategy and
triggered by a signal, not by time. This module lets it practice on our history and measures whether it works.

Three commands (``python -m balancita_engine.futures_qwen_practice <command> --help``):

``build-signals``  (no model; runs anywhere)
    Rebuilds every historical entry signal of the shipped strategy specs (C25-C30 and C32; C31 only closes what C25-C30
    open and Kronos is a model, so neither has signals of its own) from Kraken's official candles, with the strategies' OWN
    code (``futures_spec_strategy.propose_spec`` over ``futures_simulator.frames``, the same machinery as the hourly
    forward and the replay). One signal per entry EPISODE: a strategy repeating its signal on consecutive bars is one
    signal (``episode_starts``). Each signal stores

    * the STATE Qwen sees, as of the decision (the decision is at the close of the signal 1m bar): normalized numbers
      only, built with Q's STATE registry plus the ``signal`` line (strategy, side, stop/target in ATR, holding time);
      no dates, no prices, no product name;
    * outcome labels, kept in other columns and never in the STATE: the net bp of the trade under the strategy's own exit
      rules (an independent shadow ``Book`` per signal, so a signal is judged even when the real book was busy;
      ``taken_by_book`` says whether the forward book, flat only between trades, would have taken it), and the net bp
      at fixed horizons of 1 h and 4 h, with the repo's costs (``futures_costs``: taker fees and modelled impact);
    * ``period`` (``pre_cutoff`` / ``post_cutoff`` against the model's release date) and ``fold`` (``calibration``: the
      older 60 % by time, ``validation``: the newer 40 %).

``practice``  (the user's Mac, local llama-server on loopback)
    Asks the catalog question ``signal_filter`` (scope ``signal``: approve / reject) once per signal, twice with the
    options in swapped order (position-bias check), within ``--max-minutes``. Resumable; stratified when not all fit.

``report``  (no model)
    Spanish markdown: Qwen against all signals, a random filter with the same rejection rate, and a logistic
    regression on the same STATE features; calibration, position bias, pre/post cutoff, calibration/validation.

Nothing is ever downloaded: the model is whatever the user's llama-server already serves, and the provider only talks
to loopback (``futures_llm_decisions.check_loopback_url``).
"""

import argparse
import bisect
import calendar
import collections
import concurrent.futures
import hashlib
import json
import os
import random
import sqlite3
import sys
import time
import urllib.request
from decimal import Decimal

from . import futures_llm_decisions as llm
from .futures_history import (  # noqa: F401  (re-exported: the history moved out, the names stay)
    DAY_MS, HOUR_MS, KRAKEN, MINUTE_MS, WARMUP_MS, CandleCache, HistoryError, fetch_candles, fetch_funding, fill_gaps)
from .futures_costs import COST_MODEL_VERSION, entry_fill, exit_fill, fee_rate
from .futures_funding_context import FundingContext, funding_periods
from .futures_products import resolve_products
from .futures_simulator import DEFAULT_PERIODS, Book, frames, merge_periods
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs, propose_spec, spec_hash

SCHEMA = "futures-qwen-practice.v1"
QUESTION_ID = "signal_filter"
HORIZONS_MIN = (60, 240)         # fixed-horizon labels
WINDOW = 61                      # candles the STATE fields read
SIDES = ("LONG", "SHORT")
CALIBRATION_SHARE = 0.6
# Qwen3 was released on 2025-04-29 (Qwen team blog "Qwen3: Think Deeper, Act Faster"). No official knowledge cutoff is
# published that this tool could verify, so the release date is the conservative bound: a signal decided before it may
# have been seen in training. If the model on the Mac is newer (Qwen3.5 is a 2026 release), nothing here is clean
# post-cutoff for sure and the report says so; pass --cutoff to move it.
QWEN3_RELEASE_DATE = "2025-04-29"
QWEN3_RELEASE_MS = 1_745_884_800_000
DEFAULT_PRODUCTS = "PF_XBTUSD,PF_ETHUSD,PF_SOLUSD"
DEFAULT_FROM = "2024-10-01"
DEFAULT_OUT = os.path.join("data", "qwen-practice", "signals.sqlite")
DEFAULT_PRACTICE = os.path.join("data", "qwen-practice", "practice.sqlite")
# C28 delegates to C25 in a trend and C26 in a range: its signals repeat theirs bar for bar. They are stored, but the
# practice skips them by default (same STATE, wasted minutes) and the report keeps them out of the totals.
DUPLICATE_STRATEGIES = ("c28-adapter-perp-v1",)

STRATEGY_LABELS = {
    "c25-pullback-perp-v1": ("C25-pullback", "pullback in trend: enters with the 5m trend when the 1m price returns to the EMA21 and crosses back over the EMA9; exits if the close breaks the EMA21 again"),
    "c26-reversion-perp-v1": ("C26-reversion", "mean reversion in a range: fades a close outside the Bollinger band once it is back inside and the RSI crosses back from 30 or 70; exits at the band middle"),
    "c27-breakout-perp-v1": ("C27-breakout", "breakout: enters when the close breaks the prior 20-bar Donchian channel on volume 1.25 times the prior mean; exits when it crosses back through the channel middle"),
    "c28-adapter-perp-v1": ("C28-adapter", "regime adapter: pullback rules in a trend, reversion rules in a range"),
    "c29-momentum-perp-v1": ("C29-momentum6h", "slow momentum: follows a 6 hour log return beyond 2.5 daily standard deviations; stop and target in daily sigmas, 24 hour limit"),
    "c30-momentum-12h-perp-v1": ("C30-momentum12h", "momentum: follows a 12 hour log return beyond 2.5 daily standard deviations; stop and target in daily sigmas, 24 hour limit"),
    "c32-funding-contrarian-24h-perp-v1": ("C32-funding", "contrarian to extreme funding: sells when the last hourly funding is in the top 10 percent of the past 30 days, buys in the bottom 10 percent; 24 hour limit"),
}


# A clear, user-facing failure (model down, mismatched files, Kraken unreachable); the CLI prints it and exits 2.
PracticeError = HistoryError


# --------------------------------------------------------------------------- signals


def episode_starts(actions):
    """Indices where an entry signal STARTS: a side that was not the side of the bar before.

    ``[None, L, L, L, None, L, S, S]`` -> ``[1, 5, 6]``: a strategy repeating the same signal on consecutive bars is
    ONE signal; a gap, or a change of side, starts another.
    """
    return [i for i, action in enumerate(actions)
            if action in SIDES and (i == 0 or actions[i - 1] != action)]


def horizon_net_bp(side, product_id, entry_close, exit_close):
    """Net bp of entering at ``entry_close`` and leaving at ``exit_close``: the repo's fills and taker fees, no funding."""
    entry = entry_fill(Decimal(entry_close), side, product_id)
    leave = exit_fill(Decimal(exit_close), side, product_id, "time_stop")
    gross = leave - entry if side == "LONG" else entry - leave
    return float((gross - (entry + leave) * fee_rate("taker")) / entry * 10_000)


def strategy_label(spec):
    label, blurb = STRATEGY_LABELS.get(spec["id"], (spec["id"].split("-perp")[0].upper(), spec.get("name", spec["id"])))
    return label, blurb


def signal_line(spec, proposal, close, atr):
    """The ``signal`` STATE line: strategy, side and the signal's own normalized parameters. No outcome, no price."""
    label, blurb = strategy_label(spec)
    atr, close = Decimal(atr), Decimal(close)
    stop_atr = Decimal(proposal["stop_distance"]) / atr
    target_atr = Decimal(proposal["target_distance"]) / atr
    stop_bp = Decimal(proposal["stop_distance"]) / close * 10_000
    target_bp = Decimal(proposal["target_distance"]) / close * 10_000
    return "signal: strategy={} ({}) side={} stop_atr={:.2f} target_atr={:.2f} stop_bp={:.0f} target_bp={:.0f} max_hold_min={}".format(
        label, blurb, proposal["action"], stop_atr, target_atr, stop_bp, target_bp, proposal["horizon_minutes"])


def _window_slice(starts, rows, left, right):
    return rows[bisect.bisect_left(starts, left):bisect.bisect_right(starts, right)]


def build_product_signals(specs, ones, fives, *, product_id, tick_size, start_ms, funding=None, question=None):
    """Every entry signal of ``specs`` over one product's candles from ``start_ms`` (earlier candles only warm up).

    ``specs``: ``{id: spec}``. ``funding``: ``[(period_start_ms, relative_rate)]`` or ``None``; it feeds the funding
    percentile of C32 as of each decision and, for the outcome only, the funding the trade paid.
    Returns the signal dicts (no ``period``/``fold`` yet: ``assign_splits``).
    """
    spec_list = list(specs.values())
    question = question or llm.load_questions(scope="signal")[QUESTION_ID]
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(spec) for spec in spec_list))
    context = FundingContext(funding) if funding else None
    accounting = funding_periods(context)
    acc_starts = [row[0] for row in accounting]
    by_bucket = {c["bucket_start"]: c for c in ones}
    window = collections.deque(maxlen=WINDOW)
    last = {spec["id"]: None for spec in spec_list}
    shadows, signals = [], []
    # The forward book of each strategy, run beside the shadows only to know which signals it would have taken
    # (it is flat only between trades, and re-enters in the middle of a run that already started). Funding cannot
    # change an entry, so it gets none.
    real = {spec["id"]: Book(spec, product_id=product_id, tick_size=tick_size) for spec in spec_list}
    taken = set()

    def finish(signal, book):
        if book.trades:
            trade = book.trades[0]
            signal.update(
                own_net_bp=trade["net_bp"], own_exit_reason=trade["exit_reason"], own_exit_ms=trade["exit_time_ms"],
                own_hold_min=int((trade["exit_time_ms"] - trade["entry_time_ms"]) // MINUTE_MS),
                funding_status=trade["funding_status"])

    for frame in frames(ones, fives, periods, context):
        bucket, current, previous, trend, regime = frame
        window.append(by_bucket[bucket])
        if bucket >= start_ms:
            for strategy_id, book in real.items():
                book.on_frame(*frame)
                if book.position is not None and book.position["opened_bucket"] == bucket:
                    taken.add((strategy_id, bucket))
        still = []
        for signal, book in shadows:
            book.on_frame(*frame)
            if book.position is None:
                finish(signal, book)
            else:
                still.append((signal, book))
        shadows = still
        for spec in spec_list:
            proposal = propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size=tick_size)
            action = proposal["action"] if proposal["action"] in SIDES else None
            started = action is not None and last[spec["id"]] != action
            last[spec["id"]] = action
            if not started or bucket < start_ms:
                continue
            verdict = {"bucket_start_ms": bucket, "decision_known_at_ms": bucket + MINUTE_MS, "regime": regime,
                       "features": {"1m": current, "5m": trend}, "proposals": []}
            line = signal_line(spec, proposal, current["candidate_close"], current["atr14"])
            try:
                state = llm.build_state(verdict, list(window), question["state_fields"], signal=line)
            except llm.StateError:
                continue
            close, atr = Decimal(current["candidate_close"]), Decimal(current["atr14"])
            book = Book(spec, product_id=product_id, tick_size=tick_size,
                        funding=_window_slice(acc_starts, accounting, bucket - HOUR_MS, bucket + 4 * DAY_MS))
            book.on_frame(*frame)
            tradable = book.position is not None
            signal = {
                "signal_id": "{}:{}:{}:{}".format(spec["id"], action, product_id, bucket), "strategy_id": spec["id"],
                "delegated_id": proposal.get("delegated_strategy_id"), "product_id": product_id, "side": action,
                "bucket_ms": bucket, "decision_ms": bucket + MINUTE_MS, "timeframe": "1m", "state_text": state,
                "stop_atr": float(Decimal(proposal["stop_distance"]) / atr),
                "target_atr": float(Decimal(proposal["target_distance"]) / atr),
                "stop_bp": float(Decimal(proposal["stop_distance"]) / close * 10_000),
                "target_bp": float(Decimal(proposal["target_distance"]) / close * 10_000),
                "horizon_min": proposal["horizon_minutes"], "tradable": int(tradable),
                "skip_reason": None if tradable else (book.skipped[-1]["reason"] if book.skipped else "not_opened"),
                "taken_by_book": 0, "own_net_bp": None, "own_exit_reason": None, "own_hold_min": None,
                "own_exit_ms": None, "funding_status": None, "net_bp_1h": None, "net_bp_4h": None}
            signals.append(signal)
            if tradable:
                shadows.append((signal, book))
    closes = {t: c["close"] for t, c in by_bucket.items()}
    for signal in signals:
        for minutes in HORIZONS_MIN:
            later = closes.get(signal["bucket_ms"] + minutes * MINUTE_MS)
            if later is not None:
                signal["net_bp_{}h".format(minutes // 60)] = horizon_net_bp(
                    signal["side"], product_id, closes[signal["bucket_ms"]], later)
    for signal in signals:
        signal["taken_by_book"] = int((signal["strategy_id"], signal["bucket_ms"]) in taken)
    return signals


def assign_splits(rows, *, cutoff_ms, calibration_share=CALIBRATION_SHARE):
    """Adds ``period`` (before / after the model's cutoff) and ``fold`` (older share by time: calibration, rest: validation)."""
    times = sorted(row["decision_ms"] for row in rows)
    count = int(len(times) * calibration_share + 0.5)
    cut = times[count - 1] if count else -1
    return [dict(row, period="pre_cutoff" if row["decision_ms"] < cutoff_ms else "post_cutoff",
                 fold="calibration" if row["decision_ms"] <= cut else "validation") for row in rows]


# --------------------------------------------------------------------------- signals DB

SIGNAL_COLUMNS = (
    "signal_id", "strategy_id", "delegated_id", "product_id", "side", "bucket_ms", "decision_ms", "timeframe",
    "state_text", "stop_atr", "target_atr", "stop_bp", "target_bp", "horizon_min", "tradable", "skip_reason",
    "taken_by_book", "own_net_bp", "own_exit_reason", "own_hold_min", "own_exit_ms", "funding_status",
    "net_bp_1h", "net_bp_4h", "period", "fold")
_SIGNALS_SCHEMA = """
CREATE TABLE signals(
  signal_id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, delegated_id TEXT, product_id TEXT NOT NULL,
  side TEXT NOT NULL, bucket_ms INTEGER NOT NULL, decision_ms INTEGER NOT NULL, timeframe TEXT NOT NULL,
  state_text TEXT NOT NULL, stop_atr REAL, target_atr REAL, stop_bp REAL, target_bp REAL, horizon_min INTEGER,
  tradable INTEGER NOT NULL, skip_reason TEXT, taken_by_book INTEGER NOT NULL,
  own_net_bp REAL, own_exit_reason TEXT, own_hold_min INTEGER, own_exit_ms INTEGER, funding_status TEXT,
  net_bp_1h REAL, net_bp_4h REAL, period TEXT NOT NULL, fold TEXT NOT NULL);
CREATE INDEX signals_time ON signals(decision_ms);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def write_signals(path, rows, meta):
    """Writes a new signals file atomically (never visible half written). ``meta`` values are stored as JSON."""
    ordered = sorted(rows, key=lambda r: (r["decision_ms"], r["signal_id"]))
    build_id = hashlib.sha256(json.dumps([r["signal_id"] for r in ordered] + [meta], sort_keys=True,
                                         default=str).encode("utf-8")).hexdigest()[:16]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    partial = path + ".partial"
    if os.path.exists(partial):
        os.remove(partial)
    db = sqlite3.connect(partial)
    try:
        db.executescript(_SIGNALS_SCHEMA)
        db.executemany("INSERT INTO signals VALUES({})".format(",".join("?" * len(SIGNAL_COLUMNS))),
                       [tuple(r.get(c) for c in SIGNAL_COLUMNS) for r in ordered])
        full = dict(meta, build_id=build_id, schema=SCHEMA, signals=len(ordered))
        db.executemany("INSERT INTO meta VALUES(?,?)", [(k, json.dumps(v, default=str)) for k, v in full.items()])
        db.commit()
    finally:
        db.close()
    os.replace(partial, path)
    return build_id


LIGHT_COLUMNS = tuple(c for c in SIGNAL_COLUMNS if c != "state_text")


def read_signals(path, columns=SIGNAL_COLUMNS, where=""):
    """The signals as dicts ordered by time. A real build holds hundreds of thousands: ``columns=LIGHT_COLUMNS``
    leaves out the STATE text (``read_state_texts`` fetches it for the few that need it)."""
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        cursor = db.execute("SELECT {} FROM signals {} ORDER BY decision_ms, signal_id".format(",".join(columns), where))
        return [dict(zip(columns, row)) for row in cursor]
    finally:
        db.close()


def read_state_texts(path, signal_ids):
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        out, ids = {}, list(signal_ids)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            out.update(db.execute("SELECT signal_id, state_text FROM signals WHERE signal_id IN ({})".format(
                ",".join("?" * len(chunk))), chunk))
        return out
    finally:
        db.close()


def read_meta(path):
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        return {k: json.loads(v) for k, v in db.execute("SELECT key, value FROM meta")}
    finally:
        db.close()


# --------------------------------------------------------------------------- practice

PRACTICE_SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions(
  signal_id TEXT NOT NULL, variant INTEGER NOT NULL, option_order TEXT NOT NULL, p_approve REAL NOT NULL,
  probabilities TEXT NOT NULL, chosen TEXT NOT NULL, confidence REAL, source TEXT, latency_ms INTEGER,
  model_ref TEXT, model_props TEXT, question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
  prompt_version INTEGER NOT NULL, prompt_hash TEXT NOT NULL, asked_at_ms INTEGER NOT NULL, strategy_id TEXT,
  PRIMARY KEY(signal_id, variant));
CREATE TABLE IF NOT EXISTS decision_errors(
  signal_id TEXT NOT NULL, variant INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT, asked_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS practice_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS practice_runs(
  id INTEGER PRIMARY KEY, started_ms INTEGER NOT NULL, ended_ms INTEGER, args TEXT, calls INTEGER, mean_call_s REAL,
  stop_reason TEXT, model_ref TEXT);
"""


def stratified_order(pending, done_counts, *, seed):
    """``pending`` signals in an order whose every prefix is balanced across strata (strategy x side x period).

    Round robin over the strata with a seeded shuffle inside each: a stratum's k-th signal has rank ``done + k``, so
    after a resume the strata with less done come first, and a small stratum is exhausted early while the rest go on.
    Cutting the order anywhere (budget, ``--limit``) is therefore a stratified sample.
    """
    rng = random.Random(seed)
    strata = collections.defaultdict(list)
    for signal in sorted(pending, key=lambda s: s["signal_id"]):
        strata[(signal["strategy_id"], signal["side"], signal["period"])].append(signal)
    ranked = []
    for key in sorted(strata):
        items = strata[key]
        rng.shuffle(items)
        base = done_counts.get(key, 0)
        ranked += [(base + i, rng.random(), signal) for i, signal in enumerate(items)]
    ranked.sort(key=lambda row: (row[0], row[1]))
    return [signal for _, _, signal in ranked]


def _stratum(signal):
    return (signal["strategy_id"], signal["side"], signal["period"])


def _eta(seconds):
    return "{:.1f} min".format(seconds / 60.0)


def run_practice(signals_path, practice_path, provider, *, question=None, template=None, mode=None, calibration=None,
                 max_minutes=55, clock=time.monotonic, seed=20261019, progress_every=20, calibration_calls=20,
                 strategies=None, include_duplicates=False, limit=None, log=print):
    """Asks ``signal_filter`` for the signals with an outcome, twice each (options swapped), inside ``max_minutes``.

    Returns ``{stop_reason, signals_completed, calls, planned, mean_call_s}``; ``stop_reason`` is ``done`` (every
    pending signal asked), ``budget`` (time ran out or the plan was cut to what fits: a stratified sample) or
    ``model_down``. Already stored orders are never asked again.
    """
    if not provider.health():
        raise PracticeError(
            "llama-server no responde en {}: arráncalo con el modelo local y vuelve a lanzar `practice`. "
            "Este comando no descarga ningún modelo y solo habla con 127.0.0.1.".format(
                getattr(provider, "base_url", "el puerto local")))
    question = question or llm.load_questions(scope="signal")[QUESTION_ID]
    if template is None or mode is None:
        config = llm.load_prompt_config()
        template = template or config["templates"][config["default_version"]]
        mode = mode or config["probability_source"]
    calibration = calibration if calibration is not None else llm.load_calibration()
    temperature = llm.temperature_for(calibration, question["id"], question["version"])
    orders = llm.option_orders(question)
    meta = read_meta(signals_path)
    wanted = set(strategies) if strategies else None
    eligible = [s for s in read_signals(signals_path, ("signal_id", "strategy_id", "side", "period"),
                                        "WHERE tradable=1 AND own_net_bp IS NOT NULL")
                if (wanted is None or s["strategy_id"] in wanted)
                and (wanted is not None or include_duplicates or s["strategy_id"] not in DUPLICATE_STRATEGIES)]
    os.makedirs(os.path.dirname(os.path.abspath(practice_path)), exist_ok=True)
    db = sqlite3.connect(practice_path)
    db.executescript(PRACTICE_SCHEMA)
    stored_build = db.execute("SELECT value FROM practice_meta WHERE key='signals_build_id'").fetchone()
    if stored_build and json.loads(stored_build[0]) != meta["build_id"]:
        db.close()
        raise PracticeError("{} se hizo con otro fichero de señales (build {}), no con este ({}): usa un fichero nuevo "
                            "para no mezclar".format(practice_path, json.loads(stored_build[0]), meta["build_id"]))
    with db:
        db.execute("INSERT OR IGNORE INTO practice_meta VALUES('signals_build_id', ?)", (json.dumps(meta["build_id"]),))
    stored = collections.defaultdict(set)
    for signal_id, variant in db.execute("SELECT signal_id, variant FROM decisions"):
        stored[signal_id].add(variant)
    variants = list(range(len(orders)))
    complete = [s for s in eligible if len(stored[s["signal_id"]]) == len(variants)]
    done_counts = collections.Counter(_stratum(s) for s in complete)
    pending = [s for s in eligible if len(stored[s["signal_id"]]) < len(variants)]
    plan = stratified_order(pending, done_counts, seed=seed)
    if limit is not None:
        plan = plan[:max(0, limit - len(complete))]
    identity = provider.identity()
    model_ref = identity.get("model_ref") or "unknown"
    ask_served = getattr(provider, "served_model", None)
    served = ask_served() if callable(ask_served) else None  # what the server really loaded (one loopback GET)
    if served:
        with db:
            known = db.execute("SELECT value FROM practice_meta WHERE key='served_models'").fetchone()
            names = json.loads(known[0]) if known else []
            if served not in names:
                db.execute("INSERT OR REPLACE INTO practice_meta VALUES('served_models', ?)", (json.dumps(names + [served]),))
        log("practice: modelo servido por llama-server: {}".format(served))
    props = json.dumps(identity.get("props"), default=str)
    budget = max_minutes * 60.0
    started = clock()
    run_id = _open_run(db, {"max_minutes": max_minutes, "seed": seed, "strategies": sorted(wanted or []),
                            "limit": limit}, model_ref)
    log("practice: {} señales con resultado ({} ya hechas, {} pendientes), presupuesto {} min, modelo {}".format(
        len(eligible), len(complete), len(plan), max_minutes, model_ref))
    state = {"calls": 0, "spent": 0.0, "down": 0, "reason": "done", "announced": False}
    cut = {"eta": False, "limit": limit is not None and len(plan) < len(pending)}

    def eta_report(done_in_plan):
        mean = state["spent"] / state["calls"]
        rest = plan[done_in_plan:]
        remaining_calls = sum(len(variants) - len(stored[s["signal_id"]]) for s in rest)
        left = budget - (clock() - started)
        fit = int(max(0.0, left) // (mean * len(variants))) if mean > 0 else len(rest)
        log("rendimiento: {:.2f} s por llamada en las primeras {}; ETA {} para las {} llamadas pendientes; "
            "en el presupuesto caben ~{} de {} señales pendientes".format(
                mean, state["calls"], _eta(mean * remaining_calls), remaining_calls, fit, len(rest)))
        if fit < len(rest):
            log("no caben todas: se usa una muestra estratificada (estrato = estrategia x lado x periodo): "
                "las primeras {} del orden equilibrado".format(fit))
            return done_in_plan + fit
        log("caben todas las señales pendientes")
        return len(plan)

    index = 0
    while index < len(plan) and state["reason"] == "done":
        signal = plan[index]
        for variant in variants:
            if variant in stored[signal["signal_id"]]:
                continue
            elapsed = clock() - started
            estimate = state["spent"] / state["calls"] if state["calls"] else 0.0
            if elapsed + estimate > budget:
                state["reason"] = "budget"
                break
            order = orders[variant]
            asked = llm.permuted(question, order)
            if "state_text" not in signal:
                signal["state_text"] = read_state_texts(signals_path, [signal["signal_id"]])[signal["signal_id"]]
            text = llm.build_prompt(signal["state_text"], asked, template)
            t0 = clock()
            try:
                answer = llm.ask_model(provider, text, llm.question_letters(asked), asked, temperature, template, mode)
            except llm.ModelUnavailable as error:
                state["down"] += 1
                log("llama-server no contestó ({}): {}".format(state["down"], error))
                if state["down"] >= 3:
                    state["reason"] = "model_down"
                    break
                continue
            except llm.ModelResponseError as error:
                with db:
                    db.execute("INSERT INTO decision_errors VALUES(?,?,?,?,?)",
                               (signal["signal_id"], variant, error.kind, str(error), int(time.time() * 1000)))
                continue
            took = clock() - t0
            state["down"] = 0
            state["calls"] += 1
            state["spent"] += took
            result = answer["result"]
            with db:
                db.execute(
                    "INSERT OR REPLACE INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (signal["signal_id"], variant, json.dumps([o["id"] for o in asked["options"]]),
                     result["probabilities"]["approve"], json.dumps(result["probabilities"]), result["chosen"],
                     result["confidence"], answer["source"], int(took * 1000), model_ref, props, question["id"],
                     question["version"], template["version"], llm.prompt_hash(text, template),
                     int(time.time() * 1000), signal["strategy_id"]))
            stored[signal["signal_id"]].add(variant)
            complete_now = len(stored[signal["signal_id"]]) == len(variants)
            if state["calls"] == calibration_calls and not state["announced"]:
                state["announced"] = True
                keep = eta_report(index + (1 if complete_now else 0))
                if keep < len(plan):
                    plan = plan[:keep]
                    cut["eta"] = True
            if progress_every and state["calls"] % progress_every == 0:
                mean = state["spent"] / state["calls"]
                left_calls = sum(len(variants) - len(stored[s["signal_id"]]) for s in plan)
                log("progreso: {} llamadas, {}/{} señales, {} transcurridos, ETA {}".format(
                    state["calls"], index + (1 if complete_now else 0), len(plan), _eta(clock() - started),
                    _eta(mean * left_calls)))
        else:
            index += 1
            continue
        break
    if state["reason"] == "done" and cut["eta"]:
        state["reason"] = "budget"
    elif state["reason"] == "done" and cut["limit"]:
        state["reason"] = "limit"
    if state["calls"] and not state["announced"]:
        log("rendimiento: {:.2f} s por llamada ({} llamadas, menos de las {} de calibración)".format(
            state["spent"] / state["calls"], state["calls"], calibration_calls))
    total_done = sum(1 for s in eligible if len(stored[s["signal_id"]]) == len(variants))
    mean_call = state["spent"] / state["calls"] if state["calls"] else None
    _close_run(db, run_id, state, mean_call, clock() - started)
    db.close()
    log("practice terminado ({}): {} llamadas, {} de {} señales con las dos órdenes en {}".format(
        state["reason"], state["calls"], total_done, len(eligible), _eta(clock() - started)))
    return {"stop_reason": state["reason"], "signals_completed": total_done, "calls": state["calls"],
            "planned": len(plan), "mean_call_s": mean_call}


def _open_run(db, args, model_ref):
    with db:
        cursor = db.execute("INSERT INTO practice_runs(started_ms, args, model_ref) VALUES(?,?,?)",
                            (int(time.time() * 1000), json.dumps(args), model_ref))
    return cursor.lastrowid


def _close_run(db, run_id, state, mean_call, seconds):
    with db:
        db.execute("UPDATE practice_runs SET ended_ms=?, calls=?, mean_call_s=?, stop_reason=? WHERE id=?",
                   (int(time.time() * 1000), state["calls"], mean_call, state["reason"], run_id))


# --------------------------------------------------------------------------- build-signals command


def _date_ms(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%d")) * 1000


def _build_one(job):
    """Worker: one product's candles (cached), funding and signals. Returns ``(product, signals, stats)``."""
    t0 = time.time()
    specs = load_specs(job["specs_dir"])
    specs = {k: v for k, v in specs.items() if not job["strategies"] or k in job["strategies"]}
    cache = CandleCache(os.path.join(job["cache_dir"], "candles-{}.sqlite".format(job["product"])))
    try:
        lo, hi = job["start_ms"] - WARMUP_MS, job["end_ms"]
        ones = fill_gaps(cache.load(job["product"], "1m", lo, hi), MINUTE_MS)
        fives = fill_gaps(cache.load(job["product"], "5m", lo, hi), 5 * MINUTE_MS)
    finally:
        cache.close()
    if not ones:
        raise PracticeError("Kraken no devolvió velas de {}".format(job["product"]))
    funding = fetch_funding(job["product"])
    signals = build_product_signals(specs, ones, fives, product_id=job["product"], tick_size=job["tick"],
                                    start_ms=job["start_ms"], funding=funding)
    return job["product"], signals, {"candles_1m": len(ones), "candles_5m": len(fives), "funding_periods": len(funding),
                                     "seconds": round(time.time() - t0, 1)}


def build_signals(args, log=print):
    started = time.time()
    products = resolve_products(args.products)
    start_ms, end_ms = _date_ms(args.start), (_date_ms(args.end) if args.end else int(time.time() * 1000))
    cutoff_ms = _date_ms(args.cutoff)
    cache_dir = args.cache_dir or os.path.join(os.path.dirname(os.path.abspath(args.out)), "cache")
    jobs = [{"product": p, "tick": t, "start_ms": start_ms, "end_ms": end_ms, "cache_dir": cache_dir,
             "specs_dir": args.specs_dir, "strategies": args.strategies} for p, t in products]
    log("build-signals: {} productos, {} a {}, {} procesos".format(
        len(jobs), args.start, args.end or "ahora", min(args.jobs, len(jobs))))
    found, stats = [], {}
    if args.jobs > 1 and len(jobs) > 1:
        with concurrent.futures.ProcessPoolExecutor(max_workers=min(args.jobs, len(jobs))) as pool:
            results = list(pool.map(_build_one, jobs))
    else:
        results = [_build_one(job) for job in jobs]
    for product, signals, info in results:
        found += signals
        stats[product] = dict(info, signals=len(signals))
        log("  {}: {} velas 1m, {} señales, {} s".format(product, info["candles_1m"], len(signals), info["seconds"]))
    rows = assign_splits(found, cutoff_ms=cutoff_ms)
    specs = load_specs(args.specs_dir)
    cal = [r["decision_ms"] for r in rows if r["fold"] == "calibration"]
    meta = {"products": [p for p, _ in products], "from": args.start, "to": args.end, "start_ms": start_ms,
            "end_ms": end_ms, "cutoff_date": args.cutoff, "cutoff_ms": cutoff_ms,
            "cutoff_note": "Qwen3 released {} (conservative bound; no verified official knowledge cutoff)".format(
                QWEN3_RELEASE_DATE),
            "calibration_share": CALIBRATION_SHARE, "fold_cut_ms": max(cal) if cal else None,
            "question": "{}@1".format(QUESTION_ID), "cost_model": COST_MODEL_VERSION,
            "spec_hashes": {k: spec_hash(v) for k, v in sorted(specs.items())}, "per_product": stats,
            "created_ms": int(time.time() * 1000), "seconds": round(time.time() - started, 1),
            "duplicate_strategies": list(DUPLICATE_STRATEGIES)}
    build_id = write_signals(args.out, rows, meta)
    log("")
    log(summary_table(rows))
    log("\nbuild {} escrito en {} ({} señales, {} s)".format(build_id, args.out, len(rows), meta["seconds"]))
    return 0


def summary_table(rows):
    counts = collections.Counter((r["strategy_id"], r["side"], r["period"]) for r in rows)
    lines = ["{:<40} {:<6} {:>10} {:>10} {:>10}".format("estrategia", "lado", "pre_cutoff", "post_cutoff", "total")]
    for strategy in sorted({k[0] for k in counts}):
        for side in SIDES:
            pre, post = counts[(strategy, side, "pre_cutoff")], counts[(strategy, side, "post_cutoff")]
            lines.append("{:<40} {:<6} {:>10} {:>10} {:>10}".format(strategy, side, pre, post, pre + post))
    tradable = sum(1 for r in rows if r["tradable"] and r["own_net_bp"] is not None)
    lines.append("total {} señales; {} con resultado propio (las que Qwen podrá practicar)".format(len(rows), tradable))
    return "\n".join(lines)


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build-signals", help="historical signals of C25-C32 from Kraken candles (no model)")
    b.add_argument("--out", default=DEFAULT_OUT)
    b.add_argument("--products", default=DEFAULT_PRODUCTS, help="comma-separated PF_X list (default %(default)s)")
    b.add_argument("--from", dest="start", default=DEFAULT_FROM, help="first day, UTC YYYY-MM-DD (default %(default)s)")
    b.add_argument("--to", dest="end", default=None, help="last day (exclusive), default: now")
    b.add_argument("--cutoff", default=QWEN3_RELEASE_DATE, help="pre/post cutoff date (default %(default)s)")
    b.add_argument("--jobs", type=int, default=min(3, os.cpu_count() or 1), help="products in parallel")
    b.add_argument("--cache-dir", default=None, help="raw candle cache (default: next to --out)")
    b.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    b.add_argument("--strategies", nargs="*", default=None, help="restrict to these strategy ids")
    pr = sub.add_parser("practice", help="ask the local Qwen about every signal, twice (needs llama-server)")
    pr.add_argument("--signals", default=DEFAULT_OUT)
    pr.add_argument("--practice", default=DEFAULT_PRACTICE)
    pr.add_argument("--max-minutes", type=float, default=55.0)
    pr.add_argument("--llama-url", default=None, help="default http://127.0.0.1:$LLAMA_PORT (loopback only)")
    pr.add_argument("--seed", type=int, default=20261019)
    pr.add_argument("--progress-every", type=int, default=20)
    pr.add_argument("--strategies", nargs="*", default=None)
    pr.add_argument("--include-c28", action="store_true", help="also ask C28 (it repeats C25/C26 signals)")
    pr.add_argument("--limit", type=int, default=None, help="at most this many signals in total")
    rp = sub.add_parser("report", help="Spanish markdown report (no model)")
    rp.add_argument("--signals", default=DEFAULT_OUT)
    rp.add_argument("--practice", default=DEFAULT_PRACTICE)
    rp.add_argument("--out", default=None, help="write the markdown here (default: stdout)")
    rp.add_argument("--cutoff", default=None, help="override the pre/post cutoff date stored in the signals file")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.command == "build-signals":
            return build_signals(args)
        if args.command == "practice":
            env = dict(os.environ)
            url = args.llama_url or llm.llama_url(env)
            provider = llm.LlamaCppProvider(url, llm.model_ref(env), timeout=120.0)
            run_practice(args.signals, args.practice, provider, max_minutes=args.max_minutes, seed=args.seed,
                         progress_every=args.progress_every, strategies=args.strategies,
                         include_duplicates=args.include_c28, limit=args.limit)
            return 0
        from .futures_qwen_practice_report import build_report
        text = build_report(args.signals, args.practice, cutoff_date=args.cutoff)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text)
            print("informe escrito en " + args.out)
        else:
            print(text)
        return 0
    except (PracticeError, ValueError) as error:
        print("error: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
