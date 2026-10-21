"""Strategy gate: an automatic, fixed test that judges a strategy with rules declared BEFORE looking at results.

``python -m balancita_engine.strategy_gate evaluate --strategy c29-momentum-perp-v1 [--from 2025-01-01]
[--products PF_XBTUSD,...] [--exam]``  ·  ``runs [--strategy ID]``  ·  ``cancel --run N``

What it does
    Rebuilds the trades of the strategy over Kraken's official candles with the strategy's OWN code (the same
    ``futures_spec_strategy.propose_spec`` / ``futures_simulator.Book`` the live hourly forward and the replay run, so
    live == replay), prices them with ``futures_costs`` (taker fees + modelled impact) and the funding Kraken
    publishes, and judges them with the rules of ``config/strategy-gate.json`` (printed in every report):

    PASA only if ALL of: n >= 100 trades (else INCONCLUSO) · mean net bp > 0 with the 95 % bootstrap interval's lower
    bound > 0 · percentile >= 95 against 1000 random-entry draws (same count, side mix, product and holding time) ·
    deflated Sharpe probability >= 0.95 with the number of ATTEMPTS on the strategy family as trials · positive in
    >= 60 % of the time folds and in >= half of the products · still positive with costs x 1.5.

Data split (the point of the gate)
    ``holdout_from`` (config, 2026-04-19, about the last 6 months) separates two worlds.

    * PRACTICE (default): walk-forward folds over ``[from, holdout_from)``. Candles, funding and therefore signals and
      outcomes are only ever requested BELOW ``holdout_from`` (and filtered again inside the worker). A trade still open
      at the cut is DISCARDED, never closed with later prices ("abiertas al corte" in the report). No parameter is
      fitted, so the folds measure stability over time, not training.
    * EXAM (``--exam``): evaluates ONLY ``[holdout_from, now)`` (candles before the cut only warm indicators up). It is
      allowed ONCE per ``version_key`` = ``<strategy_id>:<sha256 of the whole spec>`` (the registry's own digest: id and
      version number, rules, params, indicators). A second exam of the same version is refused; the same id with other
      content is refused too (bump the version, ``-v2``). The lock is taken right before the first outcome is
      computed, after every download: a cancelled or failed exam consumes it only from that point on.

Single writer: each ``evaluate`` process is the only writer of ``gate.sqlite`` while it runs; workers (processes)
never touch the DB. A UI reads ``runs`` (progress, phase, eta_s, ...) read-only; it cancels by creating the file
``<data>/cancel/<run_id>`` or by sending SIGTERM to ``runs.pid`` (``cancel`` does both). Nothing here trades, calls a
private endpoint or needs a credential.
"""

import argparse
import array
import bisect
import collections
import concurrent.futures
import hashlib
import json
import math
import multiprocessing
import os
import random
import re
import signal
import sqlite3
import statistics
import sys
import time
import urllib.parse
from decimal import Decimal

from .futures_costs import COST_MODEL_VERSION, fee_rate, side_impact_bps, stop_exit_bps
from .futures_funding_context import FundingContext, funding_periods
from .futures_history import MINUTE_MS, WARMUP_MS, CandleCache, HistoryError, fetch_funding, fill_gaps
from .futures_products import resolve_products
from .futures_qwen_practice import _date_ms, horizon_net_bp
from .futures_qwen_practice_report import bootstrap_ci, metrics
from .futures_simulator import DEFAULT_PERIODS, Book, frames, merge_periods
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs, spec_hash
from .futures_strategy_reliability import TRIAL_SHARPE_SD, deflated_probability

SCHEMA = "balancita-strategy-gate.v1"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONFIG_PATH = os.path.join(ROOT, "config", "strategy-gate.json")
DATA_DIR = os.path.join(ROOT, "data", "strategy-gate")
DB_NAME = "gate.sqlite"
# Trial ledger of the VectorBT lab (research/vectorbt/trial_ledger.py). The gate only READS it: one writer, the lab.
DEFAULT_RESEARCH_LEDGER = os.path.join(ROOT, "data", "research-vectorbt", "ledger.sqlite")
CHUNK_FRAMES = 4000          # candles between two progress / cancellation checks inside a worker
NOTIONAL_USD = 100.0
PASS, FAIL, INCONCLUSIVE = "PASA", "NO PASA", "INCONCLUSO"
PHASES = {"signals": "generando señales", "simulating": "simulando", "random": "sorteos al azar", "report": "informe"}
# Overall percent at the start of each phase (the last one ends at 100).
PHASE_START = {"signals": 0.0, "simulating": 60.0, "random": 80.0, "report": 96.0}
DOWNLOAD_SHARE = 10.0        # percent of the "generando señales" phase spent downloading candles


class GateError(Exception):
    """A user-facing refusal or failure; the CLI prints the (Spanish) message and exits 2."""


class Cancelled(Exception):
    """The run was cancelled (file flag, signal or the progress callback)."""


# --------------------------------------------------------------------------- config and identity


def load_config(path=None):
    with open(path or CONFIG_PATH, encoding="utf-8") as handle:
        cfg = json.load(handle)
    if cfg.get("schema") != SCHEMA:
        raise GateError("config/strategy-gate.json: esquema desconocido {!r}".format(cfg.get("schema")))
    return cfg


def config_hash(cfg):
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode("utf-8")).hexdigest()


def family_of(strategy_id):
    """The strategy family: the id without its version suffix (``c29-momentum-perp-v1`` -> ``c29-momentum-perp``)."""
    return re.sub(r"-v\d+$", "", strategy_id)


def research_trials(family, ledger_path):
    """Distinct hypotheses (``variant_key``) the lab tried on ``family``; 0 without ledger, file or table.

    Read-only (``mode=ro``, stdlib only): the gate never writes into the lab's ledger.
    """
    if not ledger_path or not os.path.isfile(ledger_path):
        return 0
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(urllib.parse.quote(os.path.abspath(ledger_path))), uri=True,
                               timeout=5)
        try:
            return int(conn.execute("SELECT COUNT(DISTINCT variant_key) FROM trials WHERE family=?",
                                    (family,)).fetchone()[0])
        finally:
            conn.close()
    except sqlite3.Error:
        return 0


def version_key_of(spec):
    """``(version_key, code_hash)``. The id carries the version; the hash is the registry's own spec digest."""
    digest = spec_hash(spec)
    return "{}:{}".format(spec["id"], digest), digest


def _stamp(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


# --------------------------------------------------------------------------- the gate's own DB (single writer)

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT NOT NULL, family TEXT NOT NULL, version_key TEXT NOT NULL,
  code_hash TEXT NOT NULL, params TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('practice','exam')),
  status TEXT NOT NULL CHECK(status IN ('running','done','failed','cancelled')), verdict TEXT,
  progress REAL NOT NULL DEFAULT 0, phase TEXT, detail TEXT, eta_s REAL, started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, finished_at INTEGER, report_path TEXT, pid INTEGER, error TEXT,
  holdout_read INTEGER NOT NULL DEFAULT 0, attempts INTEGER);
CREATE INDEX IF NOT EXISTS runs_strategy ON runs(strategy_id, id);
CREATE TABLE IF NOT EXISTS exam_locks(
  strategy_id TEXT PRIMARY KEY, version_key TEXT NOT NULL, code_hash TEXT NOT NULL, holdout_from TEXT NOT NULL,
  run_id INTEGER NOT NULL, locked_at INTEGER NOT NULL, status TEXT NOT NULL, verdict TEXT);
CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT NOT NULL, strategy_id TEXT NOT NULL, version_key TEXT NOT NULL,
  run_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_family ON attempts(family);
"""


def _now_ms():
    return int(time.time() * 1000)


def open_db(path, readonly=False):
    if readonly:
        db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=30)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        db = sqlite3.connect(path, timeout=30)
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(_SCHEMA_SQL)
    db.row_factory = sqlite3.Row
    return db


def list_runs(db_path, strategy_id=None):
    if not os.path.exists(db_path):
        return []
    db = open_db(db_path, readonly=True)
    try:
        sql, args = "SELECT * FROM runs", ()
        if strategy_id:
            sql, args = sql + " WHERE strategy_id=?", (strategy_id,)
        return [dict(row) for row in db.execute(sql + " ORDER BY id", args)]
    finally:
        db.close()


def check_exam_allowed(db, spec, cfg):
    """Raises ``GateError`` (Spanish) unless this version may still take its final exam."""
    key, digest = version_key_of(spec)
    lock = db.execute("SELECT * FROM exam_locks WHERE strategy_id=?", (spec["id"],)).fetchone()
    if lock is not None:
        if lock["code_hash"] == digest:
            verdict = lock["verdict"] or "sin veredicto ({})".format(lock["status"])
            raise GateError("El examen final de esta versión ya se rindió el {}: {}. Para volver a rendirlo, creá una "
                            "versión nueva.".format(_stamp(lock["locked_at"]), verdict))
        raise GateError("La estrategia {id} ya rindió su examen final el {fecha} con otro contenido (hash {old}; ahora "
                        "{new}). Cambiaste la estrategia sin cambiar su versión: creá una versión nueva (por ejemplo "
                        "-v2) antes de rendir otro examen.".format(
                            id=spec["id"], fecha=_stamp(lock["locked_at"]), old=lock["code_hash"][:12], new=digest[:12]))
    other = db.execute("SELECT code_hash FROM runs WHERE strategy_id=? AND code_hash!=? ORDER BY id LIMIT 1",
                       (spec["id"], digest)).fetchone()
    if other is not None:
        raise GateError("El contenido de {id} cambió desde que se evaluó antes (hash {old}; ahora {new}) pero la versión "
                        "es la misma. Las versiones son inmutables: subí la versión (por ejemplo -v2) y rendí el examen "
                        "de la nueva.".format(id=spec["id"], old=other["code_hash"][:12], new=digest[:12]))
    return key, digest


# --------------------------------------------------------------------------- data providers (injectable in tests)


class KrakenProvider:
    """Kraken's public candles through the local cache. ``prefetch`` is the only call that uses the network."""

    def __init__(self, cache_dir):
        self.cache_dir = cache_dir

    def _cache(self, product):
        return CandleCache(os.path.join(self.cache_dir, "candles-{}.sqlite".format(product)))

    def prefetch(self, product, from_ms, to_ms):
        cache = self._cache(product)
        try:
            for resolution in ("1m", "5m"):
                cache.ensure(product, resolution, from_ms, to_ms)
        finally:
            cache.close()

    def candles(self, product, from_ms, to_ms):
        cache = self._cache(product)
        try:
            return cache.read(product, "1m", from_ms, to_ms), cache.read(product, "5m", from_ms, to_ms)
        finally:
            cache.close()

    def funding(self, product):
        return fetch_funding(product)


# --------------------------------------------------------------------------- simulation worker

_SHARED = {"progress": None, "cancel": None, "hook": None}


def _init_worker(progress, cancel):
    _SHARED["progress"], _SHARED["cancel"] = progress, cancel


def _chunk(index, fraction):
    """Called by a worker between chunks: reports its fraction and stops when the run was cancelled."""
    hook = _SHARED["hook"]
    if hook is not None:                       # in-process (jobs == 1): the runner ticks itself
        hook(index, fraction)
        return
    if _SHARED["progress"] is not None:
        _SHARED["progress"][index] = fraction
    if _SHARED["cancel"] is not None and _SHARED["cancel"].is_set():
        raise Cancelled()


def book_trades(spec, product_id, tick_size, ones, fives, funding, start_ms, end_ms, chunk):
    """The strategy's trades from ``start_ms``: one ``Book`` fed by the same ``frames`` as the live forward.

    ``ones`` / ``fives`` are already gap-filled and end below ``end_ms``. Returns ``(trades, open_at_end)``; a position
    still open at the end is NOT closed (no later price exists in this window) and is reported as ``open_at_end``.
    """
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    context = FundingContext(funding) if funding else None
    book = Book(spec, product_id=product_id, tick_size=tick_size, funding=funding_periods(context))
    total, count = max(1, len(ones)), 0
    for frame in frames(ones, fives, periods, context):
        if frame[0] >= start_ms:
            book.on_frame(*frame)
        count += 1
        if count % CHUNK_FRAMES == 0:
            chunk(count / total)
    trades = [dict(t) for t in book.trades if t["entry_time_ms"] >= start_ms and t["exit_time_ms"] <= end_ms]
    return trades, int(book.position is not None)


def _compact(product, trade):
    funding_usd = trade.get("funding_usd")
    return {"product": product, "side": trade["side"], "entry_ms": int(trade["entry_time_ms"]),
            "exit_ms": int(trade["exit_time_ms"]), "net_bp": float(trade["net_bp"]),
            "funding_bp": 0.0 if funding_usd is None else float(funding_usd) / NOTIONAL_USD * 10_000,
            "funding_status": trade.get("funding_status", "unknown"), "reason": trade.get("exit_reason", "")}


def simulate_task(job):
    """Worker: one (spec, product). Returns the trades, the 1m closes (for the random draws) and some stats."""
    t0 = time.time()
    index, product, start_ms, end_ms = job["index"], job["product"], job["start_ms"], job["end_ms"]
    raw1, raw5 = job["provider"].candles(product, start_ms - WARMUP_MS, end_ms)
    # Defence in depth: nothing at or after ``end_ms`` (the holdout in practice) enters the simulation.
    ones = fill_gaps([c for c in raw1 if c["bucket_start"] < end_ms], MINUTE_MS)
    fives = fill_gaps([c for c in raw5 if c["bucket_start"] < end_ms], 5 * MINUTE_MS)
    if not ones:
        raise GateError("no hay velas de {} en la ventana pedida".format(product))
    funding = [(s, r) for s, r in (job["funding"] or []) if s < end_ms]
    source = job["trade_source"] or book_trades
    trades, open_at_end = source(job["spec"], product, job["tick"], ones, fives, funding, start_ms, end_ms,
                                 lambda fraction: _chunk(index, fraction))
    out = {"index": index, "product": product, "label": job["label"], "open_at_end": open_at_end,
           "trades": [_compact(product, t) for t in trades], "candles_1m": len(ones),
           "seconds": round(time.time() - t0, 1)}
    if job["want_closes"]:
        base = bisect.bisect_left([c["bucket_start"] for c in ones], start_ms)
        out["closes"] = array.array("d", (float(c["close"]) for c in ones))
        out["first_ms"] = ones[0]["bucket_start"]
        out["start_index"] = base
    _chunk(index, 1.0)
    return out


# --------------------------------------------------------------------------- statistics


def trade_cost_bp(product, reason):
    """Fees and modelled execution of one round trip in bp of notional, by exit reason (``futures_costs``)."""
    fees = 2 * float(fee_rate("taker")) * 10_000
    entry = float(side_impact_bps(product))
    leave = 0.0 if reason == "target" else float(stop_exit_bps(product) if reason == "stop" else side_impact_bps(product))
    return fees + entry + leave


def max_drawdown(values):
    """Largest peak-to-trough fall of the cumulative net bp (trades in exit order, fixed 100 USD each)."""
    peak = cum = worst = 0.0
    for value in values:
        cum += value
        peak = max(peak, cum)
        worst = max(worst, peak - cum)
    return worst


def summarize(trades, key="net_bp"):
    ordered = sorted(trades, key=lambda t: (t["exit_ms"], t["entry_ms"]))
    values = [t[key] for t in ordered]
    out = metrics(values)
    out["max_drawdown_bp"] = max_drawdown(values)
    out["total_bp"] = sum(values)
    return out


def _stable_seed(*parts):
    return int(hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:12], 16)


def fold_edges(start_ms, end_ms, folds):
    return [start_ms + (end_ms - start_ms) * i // folds for i in range(folds + 1)]


def split_folds(trades, start_ms, end_ms, folds):
    edges = fold_edges(start_ms, end_ms, folds)
    out = [[] for _ in range(folds)]
    for trade in trades:
        slot = min(folds - 1, max(0, bisect.bisect_right(edges, trade["entry_ms"]) - 1))
        out[slot].append(trade)
    return out, edges


def random_entries_means(trades, series, *, draws, seed, tick=None):
    """Mean net bp (before funding) of ``draws`` random-entry books against the strategy's trades.

    Every draw replaces each trade by a random entry bar of the SAME product, the same side and the same holding time
    (so the same count and side mix), priced with the same cost model (fees + impact of a time exit). ``series`` maps a
    product to ``{"closes", "first_ms", "start_index"}``. Returns ``(means, skipped)``: ``skipped`` counts trades whose
    holding time did not fit in the candles (they are left out of every draw).
    """
    prepared, skipped = collections.defaultdict(list), 0
    for t in trades:
        info = series.get(t["product"])
        hold = max(1, int((t["exit_ms"] - t["entry_ms"]) // MINUTE_MS))
        if info is None or len(info["closes"]) - 1 - hold < info["start_index"]:
            skipped += 1
            continue
        sign = 1.0 if t["side"] == "LONG" else -1.0
        prepared[t["product"]].append((sign, hold, trade_cost_bp(t["product"], "time_stop")))
    count = sum(len(v) for v in prepared.values())
    if count == 0:
        return [], skipped
    sums = [0.0] * draws
    for product in sorted(prepared):
        info, closes = series[product], series[product]["closes"]
        lo = info["start_index"]
        rng = random.Random(_stable_seed(seed, product))
        items = prepared[product]
        for d in range(draws):
            acc = 0.0
            for sign, hold, cost in items:
                t0 = lo + int(rng.random() * (len(closes) - hold - lo))
                acc += sign * (closes[t0 + hold] / closes[t0] - 1.0) * 10_000 - cost
            sums[d] += acc
    return [s / count for s in sums], skipped


def percentile_in(means, observed):
    """Percentile of ``observed`` among ``means`` (100: better than every draw); ties count half."""
    if not means:
        return None
    below = sum(1 for m in means if m < observed - 1e-12)
    equal = sum(1 for m in means if abs(m - observed) <= 1e-12)
    return 100.0 * (below + 0.5 * equal) / len(means)


def _quantile(sorted_values, q):
    position = q * (len(sorted_values) - 1)
    low, high = int(math.floor(position)), int(math.ceil(position))
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (position - low)


def sharpe_per_trade(values):
    if len(values) < 2:
        return None
    sd = statistics.pstdev(values)
    return None if sd == 0 else statistics.fmean(values) / sd


# --------------------------------------------------------------------------- the judgement


def judge(trades, series, cfg, *, kind, start_ms, end_ms, attempts, products, seed, progress=None, neighbors=None):
    """Applies the predeclared rules. Pure: same trades, same series, same seed -> same verdict.

    ``trades``: compact trade dicts (see ``_compact``). ``series``: per product the 1m closes for the random draws.
    ``attempts``: practice runs on the strategy family so far (this one included), the trials of the deflated Sharpe.
    ``neighbors``: ``[{param, direction, value, trades}]`` or ``None`` (n/d).
    """
    rules = cfg["rules"]
    progress = progress or (lambda fraction: None)
    ordered = sorted(trades, key=lambda t: (t["exit_ms"], t["entry_ms"], t["product"]))
    values = [t["net_bp"] for t in ordered]
    overall = summarize(ordered)
    n = overall["n"]
    ci = bootstrap_ci(values, seed=_stable_seed(seed, "ci"), draws=cfg["bootstrap_draws"],
                      level=rules["ci_level"]) if n >= 2 else (None, None)
    nfolds = cfg["practice_folds"] if kind == "practice" else cfg["exam_folds"]
    by_fold, edges = split_folds(ordered, start_ms, end_ms, nfolds)
    folds = [dict(summarize(f), index=i + 1, from_ms=edges[i], to_ms=edges[i + 1]) for i, f in enumerate(by_fold)]
    positive_folds = sum(1 for f in folds if f["n"] and f["mean_bp"] > 0)
    per_product = {p: summarize([t for t in ordered if t["product"] == p]) for p in products}
    positive_products = sum(1 for s in per_product.values() if s["n"] and s["mean_bp"] > 0)
    per_side = {s: summarize([t for t in ordered if t["side"] == s]) for s in ("LONG", "SHORT")}
    mult = rules["cost_stress_multiplier"]
    stressed = [t["net_bp"] - (mult - 1.0) * trade_cost_bp(t["product"], t["reason"]) for t in ordered]
    stress_mean = statistics.fmean(stressed) if stressed else None
    ex_funding = [t["net_bp"] + t["funding_bp"] for t in ordered]
    observed_ex = statistics.fmean(ex_funding) if ex_funding else None
    means, skipped = random_entries_means(ordered, series, draws=cfg["random_draws"], seed=seed)
    progress(0.9)
    percentile = percentile_in(means, observed_ex) if means and observed_ex is not None else None
    baseline = None
    if means:
        srt = sorted(means)
        baseline = {"draws": len(means), "p05": _quantile(srt, 0.05), "p50": _quantile(srt, 0.5),
                    "p95": _quantile(srt, 0.95), "mean": statistics.fmean(means), "skipped": skipped,
                    "observed_ex_funding": observed_ex}
    dsr = deflated_probability(values, attempts) if n >= 3 else None
    funding_status = collections.Counter(t["funding_status"] for t in ordered)
    sens = None
    if neighbors:
        sens = []
        for item in neighbors:
            s = summarize(item["trades"])
            sens.append({"param": item["param"], "direction": item["direction"], "value": item["value"],
                         "n": s["n"], "mean_bp": s["mean_bp"]})

    def rule(rid, label, value, threshold, ok):
        return {"id": rid, "label": label, "value": value, "threshold": threshold, "ok": bool(ok)}

    checks = [
        rule("n_trades", "Al menos {} operaciones".format(rules["min_trades"]), n, rules["min_trades"],
             n >= rules["min_trades"]),
        rule("mean_net_positive", "Media neta > 0 bp con el límite inferior del IC {:.0f}% > 0".format(
            rules["ci_level"] * 100), {"mean": overall["mean_bp"], "ci_low": ci[0], "ci_high": ci[1]}, 0,
             overall["mean_bp"] is not None and overall["mean_bp"] > 0 and ci[0] is not None and ci[0] > 0),
        rule("percentile_random", "Percentil frente a entradas al azar >= {}".format(rules["min_percentile_vs_random"]),
             percentile, rules["min_percentile_vs_random"],
             percentile is not None and percentile >= rules["min_percentile_vs_random"]),
        rule("deflated_sharpe", "Sharpe desinflado (probabilidad) >= {}, intentos = {}".format(
            rules["min_deflated_probability"], attempts), dsr, rules["min_deflated_probability"],
             dsr is not None and dsr >= rules["min_deflated_probability"]),
        rule("positive_folds", "Positiva en >= {:.0f}% de los tramos".format(rules["min_positive_fold_share"] * 100),
             {"positive": positive_folds, "total": nfolds}, rules["min_positive_fold_share"],
             positive_folds >= rules["min_positive_fold_share"] * nfolds - 1e-9),
        rule("positive_products", "Positiva en >= {:.0f}% de los productos".format(
            rules["min_positive_product_share"] * 100), {"positive": positive_products, "total": len(products)},
             rules["min_positive_product_share"],
             len(products) > 0 and positive_products >= rules["min_positive_product_share"] * len(products) - 1e-9),
        rule("cost_stress", "Sigue positiva con costes x{}".format(mult), stress_mean, 0,
             stress_mean is not None and stress_mean > 0),
    ]
    if n < rules["min_trades"]:
        verdict = INCONCLUSIVE
    else:
        verdict = PASS if all(c["ok"] for c in checks) else FAIL
    return {"verdict": verdict, "rules": checks, "overall": overall, "ci": ci, "folds": folds, "edges": edges,
            "per_product": per_product, "per_side": per_side, "baseline": baseline, "percentile": percentile,
            "deflated": dsr, "attempts": attempts, "stress_mean_bp": stress_mean, "stress_multiplier": mult,
            "funding_status": dict(funding_status), "sensitivity": sens, "trial_sharpe_sd": TRIAL_SHARPE_SD,
            "sharpe_per_trade": sharpe_per_trade(values)}


# --------------------------------------------------------------------------- report (Spanish)


def _num(value, places=2):
    return "n/d" if value is None else "{:.{p}f}".format(value, p=places)


def _pct(value, places=1):
    return "n/d" if value is None else "{:.{p}f}%".format(value * 100, p=places)


def _pf(value):
    return "∞" if value is None else "{:.2f}".format(value)


def _mark(ok):
    return "✓" if ok else "✕"


def _table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return lines


def _summary_row(label, s):
    return [label, s["n"], _num(s["mean_bp"]), _pct(s["hit_rate"]), _pf(s["profit_factor"]),
            _num(s["max_drawdown_bp"], 1), _num(s["total_bp"], 1)]


SUMMARY_HEADER = ["", "operaciones", "media neta (bp)", "aciertos", "factor de beneficio", "máx. caída (bp)", "total (bp)"]


def _rule_value(rule_):
    v = rule_["value"]
    if rule_["id"] == "mean_net_positive":
        return "media {} bp, IC [{}, {}]".format(_num(v["mean"]), _num(v["ci_low"]), _num(v["ci_high"]))
    if rule_["id"] in ("positive_folds", "positive_products"):
        return "{} de {}".format(v["positive"], v["total"])
    if rule_["id"] == "deflated_sharpe":
        return _num(v, 3)
    return _num(v, 1) if isinstance(v, float) else str(v)


def build_report(meta, result, cfg, extra_notes=()):
    r, ov = result, result["overall"]
    verdict = r["verdict"]
    exam = meta["kind"] == "exam"
    lines = ["# {} de la estrategia {}".format("EXAMEN FINAL" if exam else "Práctica", meta["strategy_id"]), "",
             "## Veredicto: **{}**".format(verdict), ""]
    if exam:
        lines += ["Este examen consumió el único intento de esta versión (`{}`).".format(meta["version_key"]), ""]
    lines += ["- Tipo: {} · corrida #{}".format("examen (solo datos desde el corte)" if exam else
                                                 "práctica (solo datos anteriores al corte)", meta["run_id"]),
              "- Versión: `{}`".format(meta["version_key"]),
              "- Ventana evaluada: {} a {} (exclusivo); fecha de corte (holdout): {}".format(
                  _stamp(meta["start_ms"]), _stamp(meta["end_ms"]), cfg["holdout_from"]),
              "- Productos: {}".format(", ".join(meta["products"])),
              "- intentos: {} (de la compuerta) + {} (variantes del laboratorio) = {} sobre la familia `{}`; más intentos, "
              "Sharpe desinflado más exigente".format(
                  meta.get("gate_attempts", r["attempts"]), meta.get("lab_variants", 0), r["attempts"], meta["family"]),
              "- Modelo de costes: {} · configuración `{}` (sha {})".format(
                  COST_MODEL_VERSION, SCHEMA, meta["config_hash"][:12]), ""]
    lines += ["## Reglas (declaradas de antemano en config/strategy-gate.json)", ""]
    lines += _table(["", "regla", "valor", "umbral"],
                    [[_mark(c["ok"]), c["label"], _rule_value(c), c["threshold"] if c["id"] != "mean_net_positive" else "> 0"]
                     for c in r["rules"]])
    lines += ["", "PASA solo si cumple TODAS las reglas. Con menos de {} operaciones el resultado es INCONCLUSO "
              "(se muestran igual las demás reglas).".format(cfg["rules"]["min_trades"]), ""]
    lines += ["## Resultado global (bp netos por operación, 100 USD fijos)", ""]
    lines += _table(SUMMARY_HEADER, [_summary_row("todas", ov)])
    lines += ["", "- Costes: comisiones taker más impacto modelado (`futures_costs`) y funding donde Kraken lo publica "
              "(estado del funding de las operaciones: {}).".format(
                  ", ".join("{} {}".format(k, v) for k, v in sorted(r["funding_status"].items())) or "n/d"),
              "- Sharpe por operación: {} · desviación de los intentos usada: {}".format(
                  _num(r["sharpe_per_trade"], 3), r["trial_sharpe_sd"]), ""]
    lines += ["## Por tramo de tiempo (walk-forward)", ""]
    lines += _table(["tramo", "desde", "hasta"] + SUMMARY_HEADER[1:],
                    [[f["index"], _stamp(f["from_ms"]), _stamp(f["to_ms"])] + _summary_row("", f)[1:] for f in r["folds"]])
    lines += ["", "No se ajusta ningún parámetro: los tramos miden la estabilidad en el tiempo. Cada operación va al "
              "tramo de su entrada.", ""]
    lines += ["## Por producto", ""]
    lines += _table(SUMMARY_HEADER, [_summary_row(p, s) for p, s in r["per_product"].items()])
    lines += ["", "## Por lado", ""]
    lines += _table(SUMMARY_HEADER, [_summary_row(s, v) for s, v in r["per_side"].items()])
    b = r["baseline"]
    lines += ["", "## Entradas al azar (misma cantidad, mismo lado, mismo producto, misma duración)", ""]
    if b is None:
        lines += ["Sin operaciones: no hay línea base."]
    else:
        lines += ["- {} sorteos; media al azar {} bp (p05 {}, mediana {}, p95 {}).".format(
            b["draws"], _num(b["mean"]), _num(b["p05"]), _num(b["p50"]), _num(b["p95"])),
            "- Estrategia sin funding: {} bp → percentil {} (la comparación excluye el funding porque el azar no lo "
            "modela).".format(_num(b["observed_ex_funding"]), _num(r["percentile"], 1))]
        if b["skipped"]:
            lines += ["- {} operaciones cuya duración no cabía en las velas quedaron fuera de los sorteos.".format(b["skipped"])]
    lines += ["", "## Costes x{}".format(r["stress_multiplier"]), "",
              "Media neta con comisiones e impacto multiplicados por {}: **{} bp** ({}).".format(
                  r["stress_multiplier"], _num(r["stress_mean_bp"]),
                  "sigue positiva" if r["stress_mean_bp"] is not None and r["stress_mean_bp"] > 0 else "deja de ser positiva"), ""]
    lines += ["## Sensibilidad a parámetros vecinos (informativa, no decide el veredicto)", ""]
    if not r["sensitivity"]:
        lines += ["n/d (la estrategia no expone parámetros numéricos, o se desactivó con --sin-vecinos)."]
    else:
        lines += _table(["parámetro", "cambio", "valor", "operaciones", "media neta (bp)"],
                        [[s["param"], s["direction"], s["value"], s["n"], _num(s["mean_bp"])] for s in r["sensitivity"]])
        positive = sum(1 for s in r["sensitivity"] if s["mean_bp"] is not None and s["mean_bp"] > 0)
        lines += ["", "Vecinos con media positiva: {} de {}.".format(positive, len(r["sensitivity"]))]
    lines += ["", "## Cómo se separaron los datos", ""]
    if exam:
        lines += ["- Examen: solo entradas desde {} (velas anteriores solo calientan los indicadores). Se rinde una vez "
                  "por versión.".format(cfg["holdout_from"])]
    else:
        lines += ["- Práctica: las velas, el funding y los resultados se piden solo por debajo de {} y se filtran otra "
                  "vez dentro del simulador.".format(cfg["holdout_from"]),
                  "- Operaciones aún abiertas en el corte: {} (descartadas, nunca se cierran con precios posteriores).".format(
                      meta.get("open_at_end", 0))]
    lines += ["- Calentamiento de indicadores: {} días antes del inicio.".format(WARMUP_MS // 86_400_000)]
    lines += ["- Funding: solo el historial público de Kraken (aprox. un año); donde no hay, la operación queda con "
              "estado `unknown`/`partial` y no se inventa."]
    lines += ["- Las señales salen del mismo código que usa la estrategia en vivo (`propose_spec` y `Book`); live == replay."]
    lines += ["- Tiempo de cálculo: {:.0f} s.".format(meta.get("seconds", 0))]
    for note in extra_notes:
        lines += ["- " + note]
    lines += ["", "```json", json.dumps({"rules": cfg["rules"], "holdout_from": cfg["holdout_from"],
                                         "practice_folds": cfg["practice_folds"], "exam_folds": cfg["exam_folds"],
                                         "random_draws": cfg["random_draws"], "seed": cfg["seed"]},
                                        indent=2, sort_keys=True), "```", ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------- the run


def neighbor_specs(spec, cfg):
    """``[(param, direction, value, spec)]``: each numeric ``params`` entry moved by ±pct, one at a time."""
    block = cfg.get("neighbors", {})
    if not block.get("enabled"):
        return []
    out = []
    for name in sorted(spec.get("params", {}))[:block.get("max_params", 6)]:
        try:
            base = Decimal(str(spec["params"][name]))
        except Exception:
            continue
        if base == 0:
            continue
        for direction, factor in (("-{:.0f}%".format(block["pct"] * 100), 1 - block["pct"]),
                                  ("+{:.0f}%".format(block["pct"] * 100), 1 + block["pct"])):
            value = format(round(base * Decimal(str(factor)), 6).normalize(), "f")
            variant = json.loads(json.dumps(spec))
            variant["params"][name] = value
            out.append((name, direction, value, variant))
    return out


class Runner:
    """One evaluation: owns the DB connection (single writer), the progress and the cancellation."""

    def __init__(self, db, run_id, data_dir, *, json_progress=False, on_progress=None, stream=None):
        self.db, self.run_id, self.data_dir = db, run_id, data_dir
        self.json_progress, self.on_progress = json_progress, on_progress
        self.stream = stream or sys.stdout
        self.started = time.time()
        self.cancel_requested = False
        self.phase, self.percent, self.detail = None, 0.0, None
        self._last_write = 0.0
        self.cancel_file = os.path.join(data_dir, "cancel", str(run_id))

    def check_cancel(self):
        if self.cancel_requested or os.path.exists(self.cancel_file):
            raise Cancelled()

    def set_phase(self, key, detail=None):
        self.phase, self.detail = PHASES[key], detail
        self.update(PHASE_START[key], force=True)

    def update(self, percent, *, force=False, detail=None):
        """Records progress (0-100) and an ETA, at most twice a second; checks the cancellation every time."""
        self.percent = max(self.percent, min(100.0, percent))
        if detail is not None:
            self.detail = detail
        self.check_cancel()
        now = time.time()
        if not force and now - self._last_write < 0.5:
            return
        self._last_write = now
        elapsed = now - self.started
        eta = round(elapsed * (100.0 - self.percent) / self.percent, 1) if self.percent >= 1.0 else None
        with self.db:
            self.db.execute("UPDATE runs SET progress=?, phase=?, detail=?, eta_s=?, updated_at=? WHERE id=?",
                            (round(self.percent, 1), self.phase, self.detail, eta, _now_ms(), self.run_id))
        event = {"run_id": self.run_id, "phase": self.phase, "detail": self.detail, "percent": round(self.percent, 1),
                 "eta_seconds": eta, "started_at": int(self.started * 1000), "status": "running"}
        if self.json_progress:
            print(json.dumps(event, ensure_ascii=False), file=self.stream, flush=True)
        if self.on_progress is not None:
            self.on_progress(event)


def _run_tasks(runner, jobs_list, workers, base, span):
    """Runs the simulation tasks (in a pool when ``workers`` > 1), ticking progress ``base``..``base+span``."""
    results = [None] * len(jobs_list)
    count = len(jobs_list)
    fractions = [0.0] * count
    if workers <= 1 or count <= 1:
        def hook(index, fraction):
            fractions[index] = fraction
            runner.update(base + span * sum(fractions) / count)
        _SHARED["hook"] = hook
        try:
            for job in jobs_list:
                results[job["index"]] = simulate_task(job)
        finally:
            _SHARED["hook"] = None
        return results
    progress = multiprocessing.Array("d", count, lock=False)
    cancel = multiprocessing.Event()
    pool = concurrent.futures.ProcessPoolExecutor(max_workers=min(workers, count), initializer=_init_worker,
                                                  initargs=(progress, cancel))
    try:
        pending = {pool.submit(simulate_task, job): job["index"] for job in jobs_list}
        while pending:
            done, _ = concurrent.futures.wait(pending, timeout=0.5, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                results[pending.pop(future)] = future.result()
            try:
                runner.update(base + span * sum(min(1.0, progress[i]) for i in range(count)) / count)
            except Cancelled:
                cancel.set()
                raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    return results


def evaluate(strategy_id, *, kind="practice", from_date=None, products=None, cfg=None, data_dir=None, spec=None,
             specs_dir=None, provider=None, trade_source=None, jobs=None, neighbors=True, json_progress=False,
             on_progress=None, now_ms=None, install_signals=False, stream=None, research_ledger=None):
    """Runs the gate for one strategy. Returns ``{"run_id", "verdict", "report_path", "status"}``.

    ``spec`` / ``provider`` / ``trade_source`` / ``cfg`` are for tests (a spec outside the shipped directory, synthetic
    candles, a "cheating" trade source). ``research_ledger``: path of the lab's trial ledger (read-only); by default the
    repo's ``data/research-vectorbt/ledger.sqlite`` when ``data_dir`` is the default one, otherwise none. Raises ``GateError`` for refusals (nothing is written for an exam refusal).
    """
    cfg = cfg or load_config()
    if research_ledger is None and data_dir is None:
        research_ledger = DEFAULT_RESEARCH_LEDGER
    data_dir = data_dir or DATA_DIR
    if kind not in ("practice", "exam"):
        raise GateError("tipo desconocido: {}".format(kind))
    if spec is None:
        specs = load_specs(specs_dir or DEFAULT_SPEC_DIR)
        if strategy_id not in specs:
            raise GateError("estrategia desconocida: {} (hay: {})".format(strategy_id, ", ".join(sorted(specs))))
        spec = specs[strategy_id]
    if spec["id"] != strategy_id:
        raise GateError("el id de la especificación ({}) no coincide con --strategy ({})".format(spec["id"], strategy_id))
    holdout_ms = _date_ms(cfg["holdout_from"])
    now_ms = (now_ms if now_ms is not None else _now_ms()) // MINUTE_MS * MINUTE_MS
    if kind == "exam":
        if from_date:
            raise GateError("El examen siempre evalúa desde la fecha de corte ({}); --from solo vale en la práctica."
                            .format(cfg["holdout_from"]))
        start_ms, end_ms = holdout_ms, now_ms
        if end_ms - start_ms < MINUTE_MS:
            raise GateError("Todavía no hay datos posteriores a la fecha de corte.")
    else:
        start_ms, end_ms = _date_ms(from_date or cfg["default_from"]), holdout_ms
        if start_ms >= holdout_ms:
            raise GateError("La práctica no puede empezar en o después de la fecha de corte ({}).".format(cfg["holdout_from"]))
    product_list = resolve_products(",".join(products) if isinstance(products, (list, tuple)) else
                                    (products or ",".join(cfg["default_products"])))
    names = [p for p, _ in product_list]
    os.makedirs(data_dir, exist_ok=True)
    provider = provider or KrakenProvider(os.path.join(data_dir, "cache"))
    db = open_db(os.path.join(data_dir, DB_NAME))
    try:
        key, digest = (check_exam_allowed(db, spec, cfg) if kind == "exam" else version_key_of(spec))
        family = family_of(strategy_id)
        params = {"from": _stamp(start_ms), "to": _stamp(end_ms), "products": names, "holdout_from": cfg["holdout_from"],
                  "config_hash": config_hash(cfg), "neighbors": bool(neighbors), "cost_model": COST_MODEL_VERSION}
        with db:
            cur = db.execute(
                "INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,progress,phase,started_at,"
                "updated_at,pid) VALUES(?,?,?,?,?,?,'running',0,?,?,?,?)",
                (strategy_id, family, key, digest, json.dumps(params, sort_keys=True), kind, PHASES["signals"],
                 _now_ms(), _now_ms(), os.getpid()))
            run_id = cur.lastrowid
            if kind == "practice":
                db.execute("INSERT INTO attempts(family,strategy_id,version_key,run_id,at) VALUES(?,?,?,?,?)",
                           (family, strategy_id, key, run_id, _now_ms()))
        gate_attempts = db.execute("SELECT COUNT(*) FROM attempts WHERE family=?", (family,)).fetchone()[0]
        lab_variants = research_trials(family, research_ledger)
        attempts = gate_attempts + lab_variants
        with db:
            db.execute("UPDATE runs SET attempts=? WHERE id=?", (attempts, run_id))
        runner = Runner(db, run_id, data_dir, json_progress=json_progress, on_progress=on_progress, stream=stream)
        previous = {}
        if install_signals:
            def stop(signum, frame):
                runner.cancel_requested = True
            for sig in (signal.SIGTERM, signal.SIGINT):
                previous[sig] = signal.signal(sig, stop)
        meta = {"run_id": run_id, "strategy_id": strategy_id, "family": family, "version_key": key, "kind": kind,
                "start_ms": start_ms, "end_ms": end_ms, "products": names, "config_hash": config_hash(cfg),
                "gate_attempts": gate_attempts, "lab_variants": lab_variants}
        started = time.time()
        try:
            outcome = _execute(runner, db, spec, cfg, meta, product_list, provider, trade_source, jobs, neighbors,
                               attempts, data_dir, digest, holdout_ms)
            meta["seconds"] = time.time() - started
            return outcome
        except Cancelled:
            _finish(db, run_id, "cancelled", None, None, "cancelada por el usuario", kind)
            if json_progress:
                print(json.dumps({"run_id": run_id, "phase": "cancelada", "percent": runner.percent, "eta_seconds": 0,
                                  "started_at": int(runner.started * 1000), "status": "cancelled"},
                                 ensure_ascii=False), file=runner.stream, flush=True)
            return {"run_id": run_id, "status": "cancelled", "verdict": None, "report_path": None}
        except BaseException as error:
            _finish(db, run_id, "failed", None, None, "{}: {}".format(type(error).__name__, error), kind)
            raise
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    finally:
        db.close()


def _finish(db, run_id, status, verdict, report_path, error, kind):
    with db:
        db.execute("UPDATE runs SET status=?, verdict=?, report_path=?, error=?, finished_at=?, updated_at=?, "
                   "phase=CASE WHEN ?='cancelled' THEN 'cancelada' WHEN ?='failed' THEN 'falló' ELSE 'terminada' END, "
                   "eta_s=0, progress=CASE WHEN ?='done' THEN 100 ELSE progress END WHERE id=?",
                   (status, verdict, report_path, error, _now_ms(), _now_ms(), status, status, status, run_id))
        if kind == "exam":
            label = verdict if status == "done" else ("cancelada después de leer el corte" if status == "cancelled"
                                                      else "falló después de leer el corte")
            db.execute("UPDATE exam_locks SET status=?, verdict=? WHERE run_id=?", (status, verdict or label, run_id))


def _execute(runner, db, spec, cfg, meta, product_list, provider, trade_source, jobs, neighbors, attempts, data_dir,
             digest, holdout_ms):
    kind, start_ms, end_ms, run_id = meta["kind"], meta["start_ms"], meta["end_ms"], meta["run_id"]
    names = [p for p, _ in product_list]
    workers = jobs or max(1, min(os.cpu_count() or 1, 8))
    # --- download (the only network use). A failure here has read no outcome: an exam keeps its lock free.
    runner.set_phase("signals", "descargando velas")
    funding = {}
    for i, (product, _) in enumerate(product_list):
        runner.update(DOWNLOAD_SHARE * i / len(product_list), detail="descargando velas de {}".format(product))
        if hasattr(provider, "prefetch"):
            provider.prefetch(product, start_ms - WARMUP_MS, end_ms)
        try:
            funding[product] = [(s, r) for s, r in provider.funding(product) if s < end_ms]
        except HistoryError:
            funding[product] = []
    # --- the exam's lock: taken right before the first outcome is computed.
    if kind == "exam":
        try:
            with db:
                db.execute("INSERT INTO exam_locks(strategy_id,version_key,code_hash,holdout_from,run_id,locked_at,status)"
                           " VALUES(?,?,?,?,?,?,'running')", (spec["id"], meta["version_key"], digest,
                                                              cfg["holdout_from"], run_id, _now_ms()))
                db.execute("UPDATE runs SET holdout_read=1 WHERE id=?", (run_id,))
        except sqlite3.IntegrityError:
            check_exam_allowed(db, spec, cfg)
            raise GateError("El examen final de esta versión ya se rindió.")
    runner.update(DOWNLOAD_SHARE, force=True, detail="calculando operaciones")
    span = PHASE_START["simulating"] - DOWNLOAD_SHARE
    main_jobs = [{"index": i, "label": "base", "spec": spec, "product": p, "tick": t, "start_ms": start_ms,
                  "end_ms": end_ms, "provider": provider, "funding": funding[p], "trade_source": trade_source,
                  "want_closes": True} for i, (p, t) in enumerate(product_list)]
    results = _run_tasks(runner, main_jobs, workers, DOWNLOAD_SHARE, span)
    trades = sorted((t for r in results for t in r["trades"]), key=lambda t: (t["entry_ms"], t["product"], t["side"]))
    series = {r["product"]: {"closes": r["closes"], "first_ms": r["first_ms"], "start_index": r["start_index"]}
              for r in results}
    open_at_end = sum(r["open_at_end"] for r in results)
    # --- parameter neighbors (informational)
    runner.set_phase("simulating", "vecinos de parámetros")
    sens = None
    variants = neighbor_specs(spec, cfg) if neighbors and trade_source is None else []
    if variants:
        njobs, tags = [], []
        for name, direction, value, variant in variants:
            for product, tick in product_list:
                njobs.append({"index": len(njobs), "label": "{} {}".format(name, direction), "spec": variant,
                              "product": product, "tick": tick, "start_ms": start_ms, "end_ms": end_ms,
                              "provider": provider, "funding": funding[product], "trade_source": None,
                              "want_closes": False})
            tags.append((name, direction, value))
        nres = _run_tasks(runner, njobs, workers, PHASE_START["simulating"], PHASE_START["random"] - PHASE_START["simulating"] - 4)
        sens = []
        per = len(product_list)
        for k, (name, direction, value) in enumerate(tags):
            group = [t for r in nres[k * per:(k + 1) * per] for t in r["trades"]]
            sens.append({"param": name, "direction": direction, "value": value, "trades": group})
    runner.update(PHASE_START["random"] - 2, force=True, detail="métricas")
    # --- random-entry draws and the judgement
    runner.set_phase("random", "{} sorteos".format(cfg["random_draws"]))
    result = judge(trades, series, cfg, kind=kind, start_ms=start_ms, end_ms=end_ms, attempts=attempts, products=names,
                   seed=cfg["seed"], neighbors=sens,
                   progress=lambda f: runner.update(PHASE_START["random"] + (PHASE_START["report"] - PHASE_START["random"]) * f))
    # --- report
    runner.set_phase("report", "escribiendo el informe")
    meta["open_at_end"] = open_at_end
    meta["seconds"] = time.time() - runner.started
    notes = []
    if not any(funding.values()):
        notes.append("Atención: no se pudo leer el historial de funding de Kraken; los costes de funding no están incluidos.")
    report = build_report(meta, result, cfg, notes)
    reports = os.path.join(data_dir, "reports")
    os.makedirs(reports, exist_ok=True)
    path = os.path.join(reports, "{}.md".format(run_id))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(report)
    runner.update(100.0, force=True)
    _finish(db, run_id, "done", result["verdict"], path, None, kind)
    if runner.json_progress:
        print(json.dumps({"run_id": run_id, "phase": "terminada", "percent": 100.0, "eta_seconds": 0, "started_at": int(runner.started * 1000),
                          "status": "done", "verdict": result["verdict"], "report_path": path}, ensure_ascii=False),
              file=runner.stream, flush=True)
    return {"run_id": run_id, "status": "done", "verdict": result["verdict"], "report_path": path, "result": result}


# --------------------------------------------------------------------------- CLI


def cancel_run(run_id, data_dir=None):
    """Asks a running evaluation to stop: creates its cancel file and signals its process. Never writes the DB."""
    data_dir = data_dir or DATA_DIR
    db = open_db(os.path.join(data_dir, DB_NAME), readonly=True)
    try:
        row = db.execute("SELECT status, pid FROM runs WHERE id=?", (run_id,)).fetchone()
    finally:
        db.close()
    if row is None:
        raise GateError("no existe la corrida {}".format(run_id))
    if row["status"] != "running":
        raise GateError("la corrida {} no está en curso ({})".format(run_id, row["status"]))
    os.makedirs(os.path.join(data_dir, "cancel"), exist_ok=True)
    open(os.path.join(data_dir, "cancel", str(run_id)), "w").close()
    try:
        os.kill(row["pid"], signal.SIGTERM)
    except (OSError, TypeError):
        pass


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default=DATA_DIR)
    sub = parser.add_subparsers(dest="command", required=True)
    e = sub.add_parser("evaluate", help="corre la prueba fija sobre una estrategia")
    e.add_argument("--strategy", required=True)
    e.add_argument("--from", dest="from_date", help="YYYY-MM-DD (solo práctica; por defecto el de la configuración)")
    e.add_argument("--products", help="PF_XBTUSD,PF_ETHUSD,... (por defecto los de la configuración)")
    e.add_argument("--exam", action="store_true", help="examen final: solo datos desde la fecha de corte; una vez por versión")
    e.add_argument("--json-progress", action="store_true", help="una línea JSON por avance en la salida estándar")
    e.add_argument("--sin-vecinos", action="store_true", help="omite la sensibilidad a parámetros vecinos (más rápido)")
    e.add_argument("--jobs", type=int, help="procesos de cálculo (por defecto min(CPU, 8))")
    e.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    e.add_argument("--research-ledger", help="registro de intentos del laboratorio VectorBT (solo lectura)")
    r = sub.add_parser("runs", help="lista las corridas anteriores (una línea JSON por corrida)")
    r.add_argument("--strategy")
    c = sub.add_parser("cancel", help="pide cancelar una corrida en curso")
    c.add_argument("--run", type=int, required=True)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.command == "runs":
            for row in list_runs(os.path.join(args.data_dir, DB_NAME), args.strategy):
                print(json.dumps(row, ensure_ascii=False, sort_keys=True))
            return 0
        if args.command == "cancel":
            cancel_run(args.run, args.data_dir)
            print("cancelación pedida para la corrida {}".format(args.run))
            return 0
        out = evaluate(args.strategy, kind="exam" if args.exam else "practice", from_date=args.from_date,
                       products=args.products, data_dir=args.data_dir, specs_dir=args.specs_dir, jobs=args.jobs,
                       neighbors=not args.sin_vecinos, json_progress=args.json_progress, install_signals=True,
                       research_ledger=args.research_ledger)
    except (GateError, HistoryError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if out["status"] == "cancelled":
        print("Corrida {} cancelada.".format(out["run_id"]))
        return 130
    print("Corrida {}: {} · informe en {}".format(out["run_id"], out["verdict"], out["report_path"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
