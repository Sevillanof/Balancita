"""Strategy gate: an automatic, fixed test that judges a strategy with rules declared BEFORE looking at results.

``python -m balancita_engine.strategy_gate evaluate --strategy c29-momentum-perp-v1 [--from 2025-01-01]
[--products PF_XBTUSD,...] [--exam [--examen-contaminado]]``  ·  ``runs [--strategy ID]``  ·  ``cancel --run N``

What it does
    Rebuilds the trades of the strategy over Kraken's official candles with the strategy's OWN code (the same
    ``futures_spec_strategy.propose_spec`` / ``futures_simulator.Book`` the live hourly forward and the replay run, so
    live == replay), prices them with ``futures_costs`` (taker fees + modelled impact) and the funding Kraken
    publishes, and judges them with the rules of ``config/strategy-gate.json`` (printed in every report):

    PASA only if ALL of: n >= 30 trades (fewer: NO PASA "(pocas operaciones)" if any other rule fails, INCONCLUSO only if
    every other rule passes) · mean net bp > 0 with the 95 % bootstrap interval's lower
    bound > 0 · percentile >= 95 against 1000 random-entry draws (same count, side mix, product and holding time) ·
    deflated Sharpe probability >= 0.95 with the number of ATTEMPTS on the strategy family as trials · positive in
    >= 60 % of the time folds and in >= half of the products · still positive with costs x 1.5 · funding known in
    >= 95 % of the trades (only this one failing: INCONCLUSO, never PASA; Kraken's public funding starts 2025-10-15).

Data split (the point of the gate)
    ``holdout_from`` (config, 2026-04-19, about the last 6 months) separates two worlds.

    * PRACTICE (default): purged stability folds over ``[from, holdout_from)``. Candles, funding and therefore signals and
      outcomes are only ever requested BELOW ``holdout_from`` (and filtered again inside the worker). A trade still open
      at the cut is DISCARDED, never closed with later prices ("abiertas al corte" in the report). No parameter is
      fitted, so the folds measure stability over time, not training.
    * EXAM (``--exam``): evaluates ONLY ``[holdout_from, now)`` (candles before the cut only warm indicators up). It is
      allowed ONCE per ``version_key`` = ``<strategy_id>:<sha256 of the whole spec>`` (the registry's own digest: id and
      version number, rules, params, indicators). A second exam of the same version is refused; the same id with other
      content is refused too (bump the version, ``-v2``). Also ONCE per family and window: a successor version cannot
      re-take a reserve its family already examined (deleted versions included, via an anonymous tombstone) unless
      ``--examen-contaminado``, which marks the run and can never give PASA. The lock is taken right before the first outcome is
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
import gzip
import hashlib
import json
import math
import multiprocessing
import os
import random
import re
import shutil
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
from .gate_trace import TRACE_FILE, TRACE_SCHEMA, TracedBook, encode, trace_lines
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs, spec_hash, validate_spec
from .futures_strategy_reliability import TRIAL_SHARPE_SD, deflated_probability
from . import strategy_gate_models as strategy_models
from . import strategy_purge
from . import strategy_evaluation_policy as evaluation_policy
from . import strategy_gate_accounting as accounting
from . import strategy_gate_splits as temporal
from . import strategy_gate_provenance as provenance

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
FUNDING_NOTE = ("Kraken solo publica funding desde el 15-oct-2025; antes de esa fecha el resultado está incompleto")
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


def family_hash(family):
    return hashlib.sha256(family.encode("utf-8")).hexdigest()


def attempts_of(db, family):
    """Practice attempts of the family: the live rows plus those carried over from deleted strategies (anonymous)."""
    live = db.execute("SELECT COUNT(*) FROM attempts WHERE family=?", (family,)).fetchone()[0]
    carried = db.execute("SELECT n FROM attempt_counts WHERE family_hash=?", (family_hash(family),)).fetchone()
    return live + (carried[0] if carried else 0)


def family_of(strategy_id):
    """The strategy family: the id without its version suffix (``c29-momentum-perp-v1`` -> ``c29-momentum-perp``)."""
    return re.sub(r"-v\d+$", "", strategy_id)


def research_trials(family, ledger_path):
    """Distinct hypotheses (``variant_key``) the lab tried on ``family``.

    0 without a path or when the file does not exist. A file that EXISTS but cannot be read (corrupt, no ``trials``
    table, permissions) raises ``GateError``: silently returning 0 would undercount attempts. Read-only
    (``mode=ro``, stdlib only): the gate never writes into the lab's ledger.
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
    except sqlite3.Error as exc:
        raise GateError("El registro de intentos del laboratorio existe pero no se puede leer ({}): {}. La compuerta "
                        "no corre hasta arreglarlo, para no contar intentos de menos."
                        .format(ledger_path, exc)) from exc


def version_key_of(spec):
    """``(version_key, code_hash)``. The id carries the version; the hash is the registry's own spec digest."""
    digest = spec_hash(spec)
    return "{}:{}".format(spec["id"], digest), digest


def _stamp(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


def registry_specs(registry_db):
    """Latest non-deleted spec per id from the S registry DB, opened READ-ONLY (``{}`` when absent or unreadable).

    Same rows, same ``spec_json`` and therefore the same ``spec_hash`` the registry itself uses (the UI's "Nueva
    estrategia" writes there). Invalid specs are skipped, never repaired.
    """
    if not registry_db or not os.path.isfile(registry_db):
        return {}
    try:
        db = sqlite3.connect("file:{}?mode=ro".format(os.path.abspath(registry_db)), uri=True, timeout=10)
    except sqlite3.Error:
        return {}
    out = {}
    try:
        for strategy_id, version, text in db.execute(
                "SELECT v.strategy_id, v.version, v.spec_json FROM strategy_versions v WHERE v.version="
                "(SELECT MAX(version) FROM strategy_versions WHERE strategy_id=v.strategy_id) ORDER BY v.strategy_id"):
            last = db.execute("SELECT state FROM strategy_events WHERE strategy_id=? AND version=? ORDER BY seq DESC "
                              "LIMIT 1", (strategy_id, version)).fetchone()
            if last is not None and last[0] == "deleted":
                continue
            try:
                out[strategy_id] = validate_spec(json.loads(text))
            except Exception:  # noqa: BLE001 - one bad row must not hide the others
                continue
    except sqlite3.Error:
        return {}
    finally:
        db.close()
    return out


def find_spec(strategy_id, specs_dir=None, registry_db=None):
    """The spec to judge. Precedence: ``config/strategies`` first (versioned in git, what the live forward also
    loads), then the S registry. The registry seeds the shipped specs from the same files, so a shared id carries the
    same content; a registry-only id (created in the UI) is judged from the registry row."""
    specs = load_specs(specs_dir or DEFAULT_SPEC_DIR)
    if strategy_id in specs:
        return specs[strategy_id]
    extra = registry_specs(registry_db)
    if strategy_id in extra:
        return extra[strategy_id]
    raise GateError("estrategia desconocida: {} (hay: {})".format(strategy_id, ", ".join(sorted(set(specs) | set(extra)))))


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
-- Anonymous: only the digest of an exam that was taken, when and how it ended. No id, name or parameters.
-- Written by `purge` (strategy_purge.KEEP_EXAM_TOMBSTONE); a deleted-and-recreated identical version stays locked.
CREATE TABLE IF NOT EXISTS exam_tombstones(
  spec_hash TEXT PRIMARY KEY, exam_date TEXT NOT NULL, verdict TEXT NOT NULL);
-- Anonymous: practice attempts of deleted strategies, per sha256(family name). Added to the live count of the family.
CREATE TABLE IF NOT EXISTS attempt_counts(family_hash TEXT PRIMARY KEY, n INTEGER NOT NULL);
-- Anonymous: which window (holdout_from) a family already examined, per sha256(family name). Survives `purge` so that
-- deleting a version does not free the window for its successors. Written together with exam_tombstones.
CREATE TABLE IF NOT EXISTS exam_window_tombstones(
  family_hash TEXT NOT NULL, holdout_from TEXT NOT NULL, spec_hash TEXT NOT NULL, exam_date TEXT NOT NULL,
  verdict TEXT NOT NULL, PRIMARY KEY(family_hash, holdout_from, spec_hash));
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


def family_exam_on_window(db, spec, cfg):
    """An exam of ANOTHER version of the same family over the same window (``holdout_from``), or ``None``.

    Looks in ``exam_locks`` (live versions) and in the anonymous window tombstones (deleted ones). Returns
    ``{"version", "verdict", "holdout_from"}``; ``version`` is the strategy id, or ``None`` for a deleted version.
    """
    holdout = (cfg or {}).get("holdout_from")
    if not holdout:
        return None
    family = family_of(spec["id"])
    for lock in db.execute("SELECT strategy_id, verdict, status FROM exam_locks WHERE holdout_from=? ORDER BY locked_at",
                           (holdout,)).fetchall():
        if lock["strategy_id"] != spec["id"] and family_of(lock["strategy_id"]) == family:
            return {"version": lock["strategy_id"], "holdout_from": holdout,
                    "verdict": lock["verdict"] or "sin veredicto ({})".format(lock["status"])}
    tomb = db.execute("SELECT verdict FROM exam_window_tombstones WHERE family_hash=? AND holdout_from=? "
                      "AND spec_hash!=? ORDER BY exam_date LIMIT 1", (family_hash(family), holdout,
                                                                      spec_hash(spec))).fetchone()
    if tomb is not None:
        return {"version": None, "holdout_from": holdout, "verdict": tomb["verdict"]}
    return None


def check_exam_allowed(db, spec, cfg, allow_contaminated=False):
    """Raises ``GateError`` (Spanish) unless this version may still take its final exam.

    Besides the version's own lock, a family may examine a given reserve (``holdout_from``) only once: a successor
    version is not an independent exam of the same reserve (it was tuned after seeing the first verdict). With
    ``allow_contaminated`` the family check is skipped (the caller marks the run as contaminated).
    """
    key, digest = version_key_of(spec)
    tomb = db.execute("SELECT * FROM exam_tombstones WHERE spec_hash=?", (digest,)).fetchone()
    if tomb is not None:
        raise GateError("El examen final de esta versión ya se rindió el {}: {}. Para volver a rendirlo, creá una "
                        "versión nueva.".format(tomb["exam_date"], tomb["verdict"]))
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
    if not allow_contaminated:
        used = family_exam_on_window(db, spec, cfg)
        if used is not None:
            raise GateError("La familia {fam} ya rindió su examen sobre esta reserva (desde {desde}, versión {ver}, "
                            "veredicto {veredicto}). Una versión sucesora no es un examen independiente de la misma "
                            "reserva.".format(fam=family_of(spec["id"]), desde=used["holdout_from"],
                                              ver=used["version"] or "ya borrada", veredicto=used["verdict"]))
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


def book_trades(spec, product_id, tick_size, ones, fives, funding, start_ms, end_ms, chunk, trace=False,
                input_records=None):
    """The strategy's trades from ``start_ms``: one ``Book`` fed by the same ``frames`` as the live forward.

    ``trace``: feed a ``TracedBook`` (same trades, plus the signals and evidence) and return it as a third item.

    ``ones`` / ``fives`` are already gap-filled and end below ``end_ms``. Returns ``(trades, open_at_end)``; a position
    still open at the end is NOT closed (no later price exists in this window) and is reported as ``open_at_end``.
    """
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    funding_rows = input_records["funding"].consume(funding) if input_records is not None else funding
    context = FundingContext(funding_rows) if funding else None
    book = (TracedBook if trace else Book)(spec, product_id=product_id, tick_size=tick_size,
                                           funding=funding_periods(context))
    total, count = max(1, len(ones)), 0
    input_ones, input_fives = ones, fives
    if input_records is not None:
        input_ones = input_records["candles_1m"].consume(ones)
        input_fives = input_records["candles_5m"].consume(
            fives, before_ms=ones[-1]["bucket_start"] + MINUTE_MS, step_ms=5 * MINUTE_MS)
    for frame in frames(input_ones, input_fives, periods, context):
        if frame[0] >= start_ms:
            book.on_frame(*frame)
        count += 1
        if count % CHUNK_FRAMES == 0:
            chunk(count / total)
    trades = [dict(t) for t in book.trades if t["entry_time_ms"] >= start_ms and t["exit_time_ms"] <= end_ms]
    if trace:
        return trades, int(book.position is not None), book.report(start_ms, end_ms)
    return trades, int(book.position is not None)


def _compact(product, trade, cost_model_version=None):
    funding_usd = accounting.number(trade.get("funding_usd"))
    funding_bp = None if funding_usd is None else accounting.number(funding_usd / NOTIONAL_USD * 10_000)
    return {"product": product, "side": trade["side"], "entry_ms": int(trade["entry_time_ms"]),
            "exit_ms": int(trade["exit_time_ms"]), "net_bp": float(trade["net_bp"]),
            "funding_bp": funding_bp,
            # Compatibility adapter ONLY for the original observed statistics, not completeness evidence.
            "observed_funding_bp": 0.0 if funding_bp is None else funding_bp,
            "accounting": accounting.classify(trade, cost_model_version=cost_model_version),
            "funding_status": trade.get("funding_status", "unknown"), "reason": trade.get("exit_reason", "")}


FULL_TRADE_FIELDS = ("side", "entry_bucket_ms", "entry_time_ms", "entry_price", "stop_price", "target_price",
                     "exit_bucket_ms", "exit_time_ms", "exit_price", "exit_reason", "reason_code", "quantity",
                     "notional_usd", "net_bp", "pnl_usd", "funding_usd", "funding_status", "funding_covered_ms",
                     "funding_held_ms", "funding_complete")


def _full(product, trade, cost_model_version=None):
    """The closed trade as the simulator booked it (prices as text, nothing recomputed) for the run's artifact."""
    out = {"product_id": product, "accounting": accounting.classify(trade, cost_model_version=cost_model_version)}
    for key in FULL_TRADE_FIELDS:
        out[key] = trade.get(key)
    return out


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
    book = source is book_trades
    traced = bool(job.get("trace")) and book
    observed = {key: provenance.Records("funding" if key == "funding" else "candles")
                for key in ("candles_1m", "candles_5m", "funding")} if book else {}
    options = {"input_records": observed, "trace": traced} if book else {}
    produced = source(job["spec"], product, job["tick"], ones, fives, funding, start_ms, end_ms,
                      lambda fraction: _chunk(index, fraction), **options)
    trades, open_at_end = produced[0], produced[1]
    observed["observed_trades"] = provenance.Records("trades")
    compact = []
    for trade in trades:
        observed["observed_trades"].add(trade)
        compact.append(_compact(product, trade, COST_MODEL_VERSION if book else None))
    # Only this producer just ran Book with today's cost model. Old/model records gain no inferred cost identity.
    cost_version = COST_MODEL_VERSION if source is book_trades else None
    out = {"index": index, "product": product, "label": job["label"], "open_at_end": open_at_end,
           "trades": compact,
           "full_trades": [_full(product, t, cost_version) for t in trades] if job["want_closes"] else [], "candles_1m": len(ones),
           "seconds": round(time.time() - t0, 1)}
    if traced:
        out["trace"] = produced[2]
    if job["want_closes"]:
        base = bisect.bisect_left([c["bucket_start"] for c in ones], start_ms)
        def closes():
            if not book:
                observed["control_candles_1m"] = provenance.Records("candles")
            for candle in ones:
                if not book:
                    observed["control_candles_1m"].add({"bucket_start": candle["bucket_start"], "close": candle["close"]})
                yield float(candle["close"])
        out["closes"] = array.array("d", closes())
        out["first_ms"] = ones[0]["bucket_start"]
        out["start_index"] = base
    out["input_provenance"] = provenance.input_receipt(
        dict(job, spec_sha256=spec_hash(job["spec"])), {k: v.summary() for k, v in observed.items()}, book)
    if traced:
        out["trace"]["input_provenance"] = out["input_provenance"]
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
    return temporal.fold_edges(start_ms, end_ms, folds)


def split_folds(trades, start_ms, end_ms, folds):
    samples, _ = temporal.stability_samples(trades, start_ms, end_ms, folds)
    return samples, fold_edges(start_ms, end_ms, folds)


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


def judge(trades, series, cfg, *, kind, start_ms, end_ms, attempts, products, seed, progress=None, neighbors=None,
          embargo_supported=True, open_at_end=0):
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
    by_fold, temporal_evidence = temporal.stability_samples(ordered, start_ms, end_ms, nfolds,
        embargo_supported=embargo_supported, open_at_end=open_at_end)
    edges = fold_edges(start_ms, end_ms, nfolds)
    folds = [dict(summarize(f), **evidence) for f, evidence in zip(by_fold, temporal_evidence["folds"])]
    for fold in folds:
        if not fold["n"]:
            fold["mean_bp"] = None  # No measured expectancy; empty folds still count in the rule denominator.
    positive_folds = sum(1 for f in folds if f["n"] and f["mean_bp"] > 0)
    per_product = {p: summarize([t for t in ordered if t["product"] == p]) for p in products}
    positive_products = sum(1 for s in per_product.values() if s["n"] and s["mean_bp"] > 0)
    per_side = {s: summarize([t for t in ordered if t["side"] == s]) for s in ("LONG", "SHORT")}
    mult = rules["cost_stress_multiplier"]
    stressed = [t["net_bp"] - (mult - 1.0) * trade_cost_bp(t["product"], t["reason"]) for t in ordered]
    stress_mean = statistics.fmean(stressed) if stressed else None
    # All observed closed trades, including partial nets; keep the historical comparison population.
    ex_funding = [t["net_bp"] + (t.get("observed_funding_bp", t.get("funding_bp")) or 0.0) for t in ordered]
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
    funding_share = (sum(1 for t in ordered if t["funding_status"] == "complete") / n) if n else None
    funding_status = collections.Counter(t["funding_status"] for t in ordered)
    sens = None
    if neighbors:
        sens, seen = [], {}
        for item in neighbors:
            s = summarize(item["trades"])
            signature = tuple(sorted((t["product"], t["side"], t["entry_ms"], t["exit_ms"], round(t["net_bp"], 9))
                                     for t in item["trades"]))
            if signature in seen:      # exactly the same trades: the parameters are coupled in the rules; show once
                seen[signature]["also"].append({"param": item["param"], "direction": item["direction"],
                                                "value": item["value"]})
                continue
            row = {"param": item["param"], "direction": item["direction"], "value": item["value"],
                   "n": s["n"], "mean_bp": s["mean_bp"], "also": []}
            seen[signature] = row
            sens.append(row)

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
             temporal_evidence["embargo_supported"] and
             positive_folds >= rules["min_positive_fold_share"] * nfolds - 1e-9),
        rule("positive_products", "Positiva en >= {:.0f}% de los productos".format(
            rules["min_positive_product_share"] * 100), {"positive": positive_products, "total": len(products)},
             rules["min_positive_product_share"],
             len(products) > 0 and positive_products >= rules["min_positive_product_share"] * len(products) - 1e-9),
        rule("cost_stress", "Sigue positiva con costes x{}".format(mult), stress_mean, 0,
             stress_mean is not None and stress_mean > 0),
        rule("funding_complete", "Funding conocido en >= {:.0f}% de las operaciones".format(
            rules["min_funding_complete_share"] * 100), funding_share, rules["min_funding_complete_share"],
             funding_share is not None and funding_share >= rules["min_funding_complete_share"] - 1e-9),
    ]
    # Evidence rules (enough trades, known funding) can only make the verdict INCONCLUSIVE; a failed performance rule
    # is a NO PASA. Missing evidence never becomes a PASA.
    fold_rule = _rule_by_id({"rules": checks})["positive_folds"]
    temporal_available = temporal_evidence["embargo_supported"]
    fold_rule["measurement_status"] = "measured" if temporal_available else "unavailable"
    fold_rule["reasons"] = [] if temporal_available else [temporal_evidence["embargo_source"]]
    evidence = ("n_trades", "funding_complete") + (() if temporal_available else ("positive_folds",))
    few_trades = n < rules["min_trades"]
    performance_ok = all(c["ok"] for c in checks if c["id"] not in evidence)
    note, reasons = None, []
    if not temporal_available:
        reasons.append("temporal_unsupported" if temporal_evidence["state"] == "unsupported"
                       else "temporal_unavailable")
    if few_trades:
        reasons.append("few_trades")
    if not _rule_by_id({"rules": checks})["funding_complete"]["ok"]:
        reasons.append("funding")
    if not performance_ok:
        verdict = FAIL                  # a performance rule failed: it does not pass
        if few_trades:
            note = "(pocas operaciones)"
    elif reasons:
        verdict = INCONCLUSIVE          # nothing else failed but the evidence is incomplete: we cannot tell
    else:
        verdict = PASS
    return {"verdict": verdict, "verdict_note": note, "inconclusive_reasons": reasons if verdict == INCONCLUSIVE else [],
            "rules": checks, "overall": overall, "ci": ci, "folds": folds, "edges": edges,
            "accounting": accounting.summarize(ordered, minimum_complete_share=rules["min_funding_complete_share"],
                                               open_at_end=open_at_end),
            "temporal": temporal_evidence,
            "per_product": per_product, "per_side": per_side, "baseline": baseline, "percentile": percentile,
            "deflated": dsr, "attempts": attempts, "stress_mean_bp": stress_mean, "stress_multiplier": mult,
            "funding_status": dict(funding_status), "funding_share": funding_share, "sensitivity": sens, "trial_sharpe_sd": TRIAL_SHARPE_SD,
            "sharpe_per_trade": sharpe_per_trade(values)}


def apply_contamination(result):
    """A contaminated exam (the family already used this reserve) can never PASS: PASA becomes INCONCLUSO."""
    result["contaminated"] = True
    if result["verdict"] == PASS:
        result["verdict"] = INCONCLUSIVE
        result["inconclusive_reasons"] = ["contaminated"]
        result["verdict_note"] = "reutilización contaminada"
    elif result["verdict"] == INCONCLUSIVE:
        result["inconclusive_reasons"] = list(result.get("inconclusive_reasons") or []) + ["contaminated"]
    return result


# --------------------------------------------------------------------------- report (Spanish Markdown)


def _es(value, places=2, sign=False):
    """Number with a decimal comma (``-0,52``); ``n/d`` for ``None``; never ``-0,00``."""
    if value is None:
        return "n/d"
    text = "{:{s}.{p}f}".format(value, p=places, s="+" if sign else "")
    if not text.lstrip("+-").replace(".", "").strip("0"):
        text = text.lstrip("+-")
    return text.replace(".", ",")


def _pct_bp(bp, places=2, sign=False):
    """Basis points as a percentage of the 100 USD position: ``-0,52 %``."""
    return "n/d" if bp is None else "{} %".format(_es(bp / 100.0, places, sign))


def _pct_bp_full(bp):
    """``-0,52 % (-52,3 bp)``."""
    return "n/d" if bp is None else "{} ({} bp)".format(_pct_bp(bp, 2, True), _es(bp, 1, True))


def _share(value, places=0):
    return "n/d" if value is None else "{} %".format(_es(value * 100, places))


def _usd(bp, places=2):
    """Fixed 100 USD per trade: ``bp`` of one trade is ``bp / 100`` USD."""
    return "n/d" if bp is None else "{} USD".format(_es(bp / 100.0, places, True))


def _factor(value):
    return "sin pérdidas" if value is None else _es(value, 2)


def _mark(ok):
    return "⚠️" if ok is None else "✅" if ok else "❌"


def _table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return lines


def _row(label, s):
    return [label, s["n"], _pct_bp(s["mean_bp"], 2, True) if s["n"] else "n/d", _share(s["hit_rate"]),
            _factor(s["profit_factor"]) if s["n"] else "n/d", _usd(s["total_bp"]) if s["n"] else "n/d"]


ROW_HEADER = ["Operaciones", "Promedio por operación", "Acierto", "Factor de beneficio", "Resultado total"]


def _rule_by_id(result):
    return {c["id"]: c for c in result["rules"]}


def _checklist(r, cfg):
    """The rules as plain-language bullets: (ok, text)."""
    rules, c, items = cfg["rules"], _rule_by_id(r), []
    v = c["n_trades"]
    items.append((v["ok"], "**Operaciones suficientes**: {} de las {} que se piden como mínimo. _Con muy pocas operaciones "
                  "el resultado puede ser casualidad._".format(v["value"], rules["min_trades"])))
    v = c["mean_net_positive"]
    m = v["value"]
    items.append((v["ok"], "**Resultado después de costos observados**: promedio {} por operación; con un 95 % de confianza el "
                  "promedio observado está entre {} y {}. _Para pasar, todo ese rango debe quedar por encima de cero._"
                  .format(_pct_bp(m["mean"], 2, True), _pct_bp(m["ci_low"], 2, True), _pct_bp(m["ci_high"], 2, True))))
    v = c["percentile_random"]
    if v["value"] is None:
        text = "**Mejor que entrar al azar**: no hay operaciones para comparar."
    else:
        text = ("**Mejor que entrar al azar**: superó al {} % de {} sorteos de entradas al azar (se pide al menos {} %). "
                "_Compara contra operar lo mismo, pero en momentos elegidos a la suerte._").format(
            _es(v["value"], 0), cfg["random_draws"], _es(rules["min_percentile_vs_random"], 0))
    items.append((v["ok"], text))
    v = c["deflated_sharpe"]
    items.append((v["ok"], "**No es suerte por probar muchas veces**: probabilidad {} (se pide al menos {}), contando {} "
                  "prueba{} de esta familia de estrategias. _Es el Sharpe desinflado: cuantas más veces se prueba, más "
                  "exigente se vuelve._".format(_es(v["value"], 2), _es(rules["min_deflated_probability"], 2),
                                                r["attempts"], "" if r["attempts"] == 1 else "s")))
    v = c["positive_folds"]
    if v.get("measurement_status") == "unavailable":
        items.append((None, "**Estabilidad temporal no evaluable**: evidencia no disponible o no soportada "
                      "(`{}`). No es una pérdida medida ni permite aprobar.".format(
                          ", ".join(v["reasons"]))))
    else:
        items.append((v["ok"], "**Gana de forma constante en el tiempo**: ganó en {} de {} periodos (se pide al menos el {} %). "
                      "_Un buen resultado no debe venir de un solo mes afortunado._".format(
                          v["value"]["positive"], v["value"]["total"], _es(rules["min_positive_fold_share"] * 100, 0))))
    v = c["positive_products"]
    items.append((v["ok"], "**Funciona en varios productos**: ganó en {}/{} productos (se pide al menos el {} %){}."
                  .format(v["value"]["positive"], v["value"]["total"], _es(rules["min_positive_product_share"] * 100, 0),
                          " (un solo producto: no es robustez multi-activo)" if v["value"]["total"] == 1 else "")))
    v = c["cost_stress"]
    items.append((v["ok"], "**Aguanta costos más altos**: con comisiones y deslizamiento x{} el promedio sería {} por "
                  "operación. _Debe seguir siendo positivo._".format(_es(r["stress_multiplier"], 1),
                                                                      _pct_bp(v["value"], 2, True))))
    v = c["funding_complete"]
    text = ("**Funding conocido**: {} de las operaciones tienen el funding completo (se pide al menos el {} %). _Sin "
            "funding conocido el neto es provisional; puede faltar un cargo o un abono._".format(_share(v["value"]),
                                                                  _es(rules["min_funding_complete_share"] * 100, 0)))
    if not v["ok"]:
        text += " " + FUNDING_NOTE + "."
    items.append((v["ok"], text))
    return items


def _summary_points(r, cfg):
    """3-5 plain-language bullets."""
    ov, rules, c = r["overall"], cfg["rules"], _rule_by_id(r)
    points = []
    if ov["n"] == 0:
        return ["No hizo ninguna operación en el periodo evaluado, así que no hay nada que juzgar."]
    mean = ov["mean_bp"]
    points.append("{} en promedio **{} por operación** después de costos observados ({} operaciones; resultado total {} sobre "
                  "posiciones de 100 USD).".format("Ganó" if mean > 0 else "Perdió", _pct_bp(abs(mean)), ov["n"],
                                                   _usd(ov["total_bp"])))
    pc = r["percentile"]
    if pc is not None:
        if pc >= 50:
            points.append("Le fue mejor que entrar al azar (mejor que el {} % de los sorteos).".format(_es(pc, 0)))
        else:
            points.append("Le fue peor que entrar al azar (peor que el {} % de los sorteos).".format(_es(100 - pc, 0)))
    f = c["positive_folds"]["value"]
    pp = c["positive_products"]["value"]
    if c["positive_folds"].get("measurement_status") == "unavailable":
        points.append("Estabilidad temporal no evaluable: falta una política de embargo respaldada. "
                      "No se midieron periodos ganadores ni perdedores.")
    else:
        points.append("Ganó en {} de {} periodos de tiempo y en {}/{} productos{}.".format(
            f["positive"], f["total"], pp["positive"], pp["total"],
            " (un solo producto: no es robustez multi-activo)" if pp["total"] == 1 else ""))
    fc = c["funding_complete"]
    funding_point = None
    if not fc["ok"]:
        funding_point = ("Solo {} de las operaciones tienen el funding conocido: sin funding el neto es provisional. "
                         "{}.".format(_share(fc["value"]), FUNDING_NOTE))
    if r["stress_mean_bp"] is not None:
        points.append("Con costos {} % más altos el promedio sería {} por operación ({}).".format(
            _es((r["stress_multiplier"] - 1) * 100, 0), _pct_bp(r["stress_mean_bp"], 2, True),
            "sigue ganando" if r["stress_mean_bp"] > 0 else "no se salva"))
    if ov["n"] < rules["min_trades"]:
        points.append("Hizo solo {} operaciones y se piden al menos {}: es poco para sacar conclusiones firmes.".format(
            ov["n"], rules["min_trades"]))
    if funding_point:
        return points[:4] + [funding_point]
    return points[:5]


def _verdict_line(r, cfg):
    v, rules = r["verdict"], cfg["rules"]
    if v == PASS:
        return "## ✅ PASA\n\nCumplió todas las reglas que se fijaron de antemano."
    if v == INCONCLUSIVE:
        reasons = r.get("inconclusive_reasons") or []
        parts = []
        if "contaminated" in reasons:
            parts.append("La reserva ya fue usada por esta familia de estrategias: el examen no es evidencia "
                         "independiente y por eso nunca puede dar PASA.")
        if "few_trades" in reasons:
            parts.append("Hay muy pocas operaciones (menos de {}) para decidir.".format(rules["min_trades"]))
        if "temporal_unsupported" in reasons or "temporal_unavailable" in reasons:
            parts.append("Estabilidad temporal no evaluable: la evidencia de embargo no está disponible o no está "
                         "soportada. No es un resultado negativo medido y no permite aprobar.")
        if "funding" in reasons:
            parts.append("Falta el funding de muchas operaciones (se pide al menos el {} %). {}.".format(
                _es(rules["min_funding_complete_share"] * 100, 0), FUNDING_NOTE))
        if not parts:
            parts.append("Hay muy pocas operaciones (menos de {}) para decidir.".format(rules["min_trades"]))
        tail = "Ninguna otra regla falló." if "contaminated" not in reasons else "Ninguna regla de resultado falló."
        next_step = ("Hace falta evidencia temporal respaldada; más operaciones por sí solas no definen esa política."
                     if "temporal_unsupported" in reasons or "temporal_unavailable" in reasons else
                     "Hace falta más historia, más productos o un periodo con funding.")
        return "## ⚠️ INCONCLUSO\n\n{} {} {}".format(" ".join(parts), tail, next_step)
    extra = " (pocas operaciones)" if r.get("verdict_note") else ""
    failed = [c for c in r["rules"] if not c["ok"] and c.get("measurement_status") != "unavailable"]
    return "## ❌ NO PASA{}\n\nNo cumplió {} de {} reglas.{}".format(
        extra, len(failed), len(r["rules"]),
        " Además tuvo menos de {} operaciones, por eso la evidencia es escasa.".format(rules["min_trades"])
        if r.get("verdict_note") else "")


def _neighbor_label(item):
    return "{} {}".format(item["param"], item["direction"])


def build_report(meta, result, cfg, extra_notes=()):
    r, ov = result, result["overall"]
    exam = meta["kind"] == "exam"
    name = meta.get("name") or meta["strategy_id"]
    lines = ["# {}".format(name), "", "<sub>`{}` · {} · corrida #{}</sub>".format(
        meta["strategy_id"], "examen final" if exam else "práctica", meta["run_id"]), "",
        _verdict_line(r, cfg), ""]
    scope = evaluation_policy.stored(meta.get("evaluation_policy"))
    if scope["classification"] == "baseline_only":
        lines += ["> **Alcance: `baseline_only`.** Libro independiente, 100 USD fijos por operación. "
                  "No reproduce decisiones OPEN de Qwen ni valida la política completa; PASA/NO PASA "
                  "solo describe esta prueba estadística.", ""]
    else:
        lines += ["> **Alcance: `unclassified`.** Esta evidencia no certifica la política completa.", ""]
    identity = provenance.stored(r.get("provenance"))
    evidence = provenance.stored_audit(r.get("audit"), identity)
    lines += ["### Procedencia y artefactos", "",
              "- Procedencia: `{}`; identidad: `{}`. Artefactos: `{}`; evidencia: `{}`.".format(
                  identity["state"], identity["sha256"] or "n/d", evidence["artifact_state"], evidence["state"]),
              "- Motivos: `{}`. Son registros parseados consumidos (incluido calentamiento), no bytes originales "
              "del proveedor ni una auditoría independiente de los datos.".format(
                  ", ".join(identity["reasons"] + evidence["reasons"]) or "ninguno"),
              "- PASA es solo el veredicto estadístico: artefactos ausentes o procedencia parcial no autorizan "
              "validación auditable, aprobación ni replay de la política completa.", ""]
    acc = accounting.stored(r.get("accounting"))
    lines += ["### Neto observado y neto definitivo", "",
              "Las estadísticas incluyen **todas las operaciones cerradas con neto observado**, también las "
              "provisionales. El umbral agregado de funding no convierte el neto observado en definitivo.", "",
              "- Estado contable: `{}`; alcance: operaciones cerradas; abiertas al corte: {}.".format(
                  acc["state"], acc.get("open_at_end", "n/d")),
              "- Neto observado: {} bp; neto definitivo: {} bp (n/d si falta evidencia o hay abiertas al corte).".format(
                  _es(acc["observed_net_bp"]), _es(acc["definitive_net_bp"])),
              "- Funding completo por conteo declarado: {}; cobertura temporal conocida: {}. "
              "Son dimensiones distintas; desconocido no significa cero.".format(
                  _share(acc["funding_complete_share"]), _share(acc["funding_time_share"])),
              "- La completitud exige importes, flags de funding y evidencia de costes del productor. "
              "No se infieren costes actuales para registros antiguos ni se vuelve a descontar ejecución.", ""]
    warnings = [n for n in extra_notes if n.startswith("Atención")]
    for note in warnings:
        lines += ["> ⚠️ " + note, ""]
    if meta.get("contaminated"):
        lines += ["> ⚠️ **REUTILIZACIÓN CONTAMINADA: esta reserva ya fue usada por la familia; no es evidencia "
                  "independiente.**", ""]
    if exam:
        lines += ["> Este examen consumió el único intento de esta versión.", ""]
    lines += ["### En pocas palabras", ""] + ["- " + p for p in _summary_points(r, cfg)] + [""]
    lines += ["## Qué revisamos", "",
              "Reglas fijadas antes de mirar resultados. Para pasar hay que cumplir **todas**.", ""]
    lines += ["- {} {}".format(_mark(ok), text) for ok, text in _checklist(r, cfg)] + [""]
    lines += ["## Resultado general", "", "Cuánto ganó o perdió en total, con comisiones y deslizamiento incluidos "
              "(posiciones fijas de 100 USD).", ""]
    lines += _table([""] + ROW_HEADER + ["Caída máxima"], [_row("Todas", ov) + [
        _usd(-ov["max_drawdown_bp"]) if ov["n"] else "n/d"]])
    te = temporal.stored(r.get("temporal"))
    lines += ["", "## Por periodo", "", "Cómo le fue en {} tramos consecutivos de tiempo; sirve para ver si el resultado "
              "es estable. No se ajusta ningún parámetro. No es entrenamiento/prueba walk-forward ni demuestra "
              "generalización sin fugas.".format(len(r["folds"])), "",
              "- Método: `{}`; esquema: `{}`; estado: `{}`; motivos: `{}`.".format(
                  te["method"], te["schema"], te["state"], ", ".join(te["reasons"]) or "ninguno"),
              "- Embargo: {} ms; fuente: `{}`; tope heredado: 25 % del ancho del tramo. "
              "No se impone una salida nueva ni se supone un horizonte universal para modelos.".format(
                  _es(te["embargo_ms"], 0), te["embargo_source"]),
              "- Entradas en [desde, hasta); salida <= hasta. Se purgan los cruces y se omite el inicio "
              "embargado de cada tramo salvo el primero. Usadas: {}; excluidas: {}; motivos: `{}`. "
              "Abiertas al corte (censuradas): {}.".format(
                  te.get("used_trades", "n/d"), te.get("excluded_trades", "n/d"),
                  te.get("excluded_reasons", {}), te.get("open_at_end", "n/d")),
              "- Los tramos vacíos siguen en el denominador; su media es n/d, no cero medido. "
              "Un tramo con una operación no permite medir dispersión. El resultado global y el 95 % de funding "
              "conservan todas las cerradas observadas, incluso las excluidas aquí.", ""]
    lines += _table(["Periodo", "Desde", "Hasta"] + ROW_HEADER,
                    [[f["index"], _stamp(f["from_ms"]), _stamp(f["to_ms"])] + _row("", f)[1:] for f in r["folds"]])
    if te["folds"]:
        lines += [""] + _table(["Periodo", "Embargo (ms)", "Usadas", "Excluidas", "Motivos", "Muestra"],
                              [[f["index"], f["embargo_ms"], f["used"], f["excluded"],
                                f["excluded_reasons"], f["sample_state"]] for f in te["folds"]])
    lines += ["", "## Por producto", "", "El mismo resultado separado por producto.", ""]
    lines += _table(["Producto"] + ROW_HEADER, [_row(p, s) for p, s in r["per_product"].items()])
    lines += ["", "## Compra contra venta", "", "Separado entre operaciones largas (apuesta a que sube) y cortas "
              "(apuesta a que baja).", ""]
    lines += _table(["Lado"] + ROW_HEADER, [_row("Compra (largo)" if s == "LONG" else "Venta (corto)", v)
                                            for s, v in r["per_side"].items()])
    b = r["baseline"]
    lines += ["", "## Comparación con entradas al azar", ""]
    if b is None:
        lines += ["Sin operaciones: no hay con qué comparar."]
    else:
        lines += ["Se repitió {} veces la misma cantidad de operaciones, del mismo lado, producto y duración, pero "
                  "entrando en momentos al azar. Así se ve cuánto aporta la estrategia frente a la suerte.".format(b["draws"]),
                  ""]
        lines += _table(["", "Promedio por operación"], [
            ["**La estrategia** (sin funding, para comparar parejo)", _pct_bp(b["observed_ex_funding"], 2, True)],
            ["Al azar, promedio", _pct_bp(b["mean"], 2, True)],
            ["Al azar, caso malo (5 % peores)", _pct_bp(b["p05"], 2, True)],
            ["Al azar, caso típico (mediana)", _pct_bp(b["p50"], 2, True)],
            ["Al azar, caso bueno (5 % mejores)", _pct_bp(b["p95"], 2, True)]])
        pc = r["percentile"]
        lines += ["", "La estrategia quedó en el **puesto {} de 100** entre los sorteos (100 = mejor que todos).".format(
            _es(pc, 0))]
        if b["skipped"]:
            lines += ["", "{} operaciones cuya duración no cabía en las velas quedaron fuera de los sorteos.".format(b["skipped"])]
    lines += ["", "## Con costos más altos", "", "Se repite el cálculo con comisiones y deslizamiento multiplicados por "
              "{}, para ver si el resultado aguanta un mercado menos favorable.".format(_es(r["stress_multiplier"], 1)), ""]
    lines += _table(["", "Promedio por operación"], [
        ["Costos normales", _pct_bp(ov["mean_bp"], 2, True)],
        ["Costos x{}".format(_es(r["stress_multiplier"], 1)), _pct_bp(r["stress_mean_bp"], 2, True)]])
    lines += ["", "## Parámetros vecinos", "", "Se mueve cada parámetro numérico un 20 % hacia arriba y hacia abajo para ver "
              "si el resultado se sostiene o depende de un valor exacto. Es solo informativo: no decide el veredicto.", ""]
    if not r["sensitivity"]:
        lines += ["No disponible (la estrategia no tiene parámetros numéricos, o se desactivó con --sin-vecinos)."]
    else:
        rows = []
        for item in r["sensitivity"]:
            label = " y ".join([_neighbor_label(item)] + [_neighbor_label(o) for o in item.get("also", [])])
            rows.append([label, item["value"] if not item.get("also") else "ver nota", item["n"],
                         _pct_bp(item["mean_bp"], 2, True) if item["n"] else "n/d"])
        lines += _table(["Cambio", "Valor probado", "Operaciones", "Promedio por operación"], rows)
        positive = sum(1 for s in r["sensitivity"] if s["mean_bp"] is not None and s["mean_bp"] > 0)
        lines += ["", "Variantes con promedio positivo: {} de {}.".format(positive, len(r["sensitivity"]))]
        if any(item.get("also") for item in r["sensitivity"]):
            lines += ["", "> Cuando dos parámetros dan exactamente las mismas operaciones se muestran juntos: en las reglas "
                      "se combinan (por ejemplo, se multiplican en el umbral de entrada), así que moverlos por separado "
                      "es lo mismo y cuenta como una sola variante."]
    lines += ["", "## Cómo se separaron los datos", ""]
    if exam:
        lines += ["- Examen: solo cuentan entradas desde el {} (lo anterior solo sirve para calentar los indicadores). "
                  "Cada versión lo rinde una sola vez.".format(cfg["holdout_from"])]
    else:
        lines += ["- Práctica: solo se usan datos anteriores al {} (los últimos meses quedan guardados para el examen "
                  "final).".format(cfg["holdout_from"]),
                  "- Operaciones aún abiertas en esa fecha: {} (se descartan; nunca se cierran con precios posteriores)."
                  .format(meta.get("open_at_end", 0))]
    lines += ["", "## Glosario", "",
              "- **bp (punto básico)**: una centésima de punto porcentual. 100 bp = 1 %. Aquí se muestra como % y, "
              "cuando ayuda, el bp va entre paréntesis.",
              "- **Factor de beneficio**: lo que ganó en las operaciones buenas dividido por lo que perdió en las malas. "
              "Más de 1 es ganar; menos de 1 es perder.",
              "- **Caída máxima**: la mayor pérdida acumulada desde un pico hasta el punto más bajo siguiente.",
              "- **Sharpe desinflado**: el Sharpe (ganancia en relación con su irregularidad) corregido por la cantidad "
              "de variantes probadas; mide si el resultado podría ser solo suerte de tanto probar.",
              "- **Intervalo de confianza**: el rango donde, con un 95 % de seguridad, está el verdadero promedio.",
              "- **Funding**: lo que se paga o cobra por mantener una posición abierta. Si no se conoce, el neto "
              "es provisional (puede faltar un cargo o un abono); por eso se exige conocerlo en casi todas las operaciones. Kraken solo publica el historial "
              "de funding desde el 15-oct-2025.",
              "- **Entradas al azar**: operar la misma cantidad de veces, pero en momentos elegidos a la suerte; es la "
              "vara mínima que una estrategia debe superar.", ""]
    lines += ["## Detalles técnicos", ""]
    lines += ["- Tipo: {}".format("examen (solo datos desde el corte)" if exam else "práctica (solo datos anteriores al corte)"),
              "- Versión: `{}`".format(meta["version_key"]),
              "- Ventana evaluada: {} a {} (exclusivo); fecha de corte (holdout): {}".format(
                  _stamp(meta["start_ms"]), _stamp(meta["end_ms"]), cfg["holdout_from"]),
              "- Productos: {}".format(", ".join(meta["products"])),
              "- Intentos: {} (de la compuerta) + {} (variantes del laboratorio) = {} sobre la familia `{}`".format(
                  meta.get("gate_attempts", r["attempts"]), meta.get("lab_variants", 0), r["attempts"], meta["family"]),
              "- Modelo de costos: {} · configuración `{}` (sha {})".format(COST_MODEL_VERSION, SCHEMA, meta["config_hash"][:12]),
              "- Funding de las operaciones: {}.".format(
                  ", ".join("{} {}".format(k, v) for k, v in sorted(r["funding_status"].items())) or "n/d"),
              "- Sharpe por operación: {} · desviación de los intentos usada: {}".format(
                  _es(r["sharpe_per_trade"], 3), r["trial_sharpe_sd"]),
              "- Calentamiento de indicadores: {} días antes del inicio; funding solo del historial público de Kraken.".format(
                  WARMUP_MS // 86_400_000),
              "- Las señales salen del mismo código que usa la estrategia en vivo (`propose_spec` y `Book`).",
              "- Semilla: {} · tiempo de cálculo: {:.0f} s.".format(cfg["seed"], meta.get("seconds", 0))]
    for note in extra_notes:
        if note not in warnings:
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


def evaluate(strategy_id, *, kind="practice", from_date=None, to_date=None, products=None, cfg=None, data_dir=None, spec=None,
             specs_dir=None, provider=None, trade_source=None, jobs=None, neighbors=True, json_progress=False,
             on_progress=None, now_ms=None, install_signals=False, stream=None, registry_db=None,
             kronos_dir=None, qwen_exit_dir=None, qwen_live_dir=None, research_ledger=None, allow_contaminated=False,
             evaluation_mode=evaluation_policy.BASELINE_MODE):
    """Runs the gate for one strategy. Returns ``{"run_id", "verdict", "report_path", "status"}``.

    ``spec`` / ``provider`` / ``trade_source`` / ``cfg`` are for tests (a spec outside the shipped directory, synthetic
    candles, a "cheating" trade source). ``research_ledger``: the lab's trial ledger (read-only); by default the repo's
    ``data/research-vectorbt/ledger.sqlite`` when ``data_dir`` is the default one, otherwise none.
    ``allow_contaminated``: lets an exam run although the family already examined this reserve; the run is marked
    (``params.contaminated``), the report warns and the verdict can never be PASA. Raises ``GateError`` for refusals (nothing is written for an exam refusal).
    """
    try:
        evaluation_policy.require_mode(evaluation_mode)
    except ValueError as error:
        raise GateError(str(error))
    scope = evaluation_policy.metadata(recorded_model=strategy_models.is_model(strategy_id))
    cfg = cfg or load_config()
    if research_ledger is None and data_dir is None:
        research_ledger = DEFAULT_RESEARCH_LEDGER
    data_dir = data_dir or DATA_DIR
    if kind not in ("practice", "exam"):
        raise GateError("tipo desconocido: {}".format(kind))
    if spec is None and strategy_models.is_model(strategy_id):
        spec, trade_source = strategy_models.model_subject(strategy_id, kronos_dir, qwen_exit_dir, qwen_live_dir)
    if spec is None:
        spec = find_spec(strategy_id, specs_dir, registry_db)
    if spec["id"] != strategy_id:
        raise GateError("el id de la especificación ({}) no coincide con --strategy ({})".format(spec["id"], strategy_id))
    holdout_ms = _date_ms(cfg["holdout_from"])
    now_ms = (now_ms if now_ms is not None else _now_ms()) // MINUTE_MS * MINUTE_MS
    if kind == "exam":
        if from_date or to_date:
            raise GateError("El examen siempre evalúa desde la fecha de corte ({}); --from y --to solo valen en la práctica."
                            .format(cfg["holdout_from"]))
        start_ms, end_ms = holdout_ms, now_ms
        if end_ms - start_ms < MINUTE_MS:
            raise GateError("Todavía no hay datos posteriores a la fecha de corte.")
    else:
        start_ms, end_ms = _date_ms(from_date or cfg["default_from"]), holdout_ms
        if start_ms >= holdout_ms:
            raise GateError("La práctica no puede empezar en o después de la fecha de corte ({}).".format(cfg["holdout_from"]))
        if to_date:  # one market stage: the practice never goes past the holdout cut
            end_ms = _date_ms(to_date)
            if end_ms > holdout_ms:
                raise GateError("La práctica no puede terminar después de la fecha de corte ({}).".format(cfg["holdout_from"]))
            if end_ms <= start_ms:
                raise GateError("La práctica tiene que terminar después de la fecha de inicio.")
    product_list = resolve_products(",".join(products) if isinstance(products, (list, tuple)) else
                                    (products or ",".join(cfg["default_products"])))
    names = [p for p, _ in product_list]
    # Read the lab ledger BEFORE touching gate.sqlite: an unreadable ledger raises here, so it leaves no orphan
    # 'running' run, no attempt and no consumed exam lock.
    lab_variants = research_trials(family_of(strategy_id), research_ledger)
    os.makedirs(data_dir, exist_ok=True)
    provider = provider or KrakenProvider(os.path.join(data_dir, "cache"))
    db = open_db(os.path.join(data_dir, DB_NAME))
    try:
        key, digest = (check_exam_allowed(db, spec, cfg, allow_contaminated) if kind == "exam" else version_key_of(spec))
        family = family_of(strategy_id)
        contaminated = bool(kind == "exam" and allow_contaminated and family_exam_on_window(db, spec, cfg) is not None)
        gate_attempts = attempts_of(db, family) + int(kind == "practice")
        attempts = gate_attempts + lab_variants
        identity = provenance.start(cfg, digest, kind, start_ms, end_ms, product_list, family,
                                    gate_attempts, lab_variants, neighbors, trade_source in (None, book_trades))
        params = {"from": _stamp(start_ms), "to": _stamp(end_ms), "products": names, "holdout_from": cfg["holdout_from"],
                  "config_hash": config_hash(cfg), "neighbors": bool(neighbors), "cost_model": COST_MODEL_VERSION,
                  "evaluation_policy": scope, "provenance": identity, "audit": provenance.audit(identity)}
        if contaminated:
            params["contaminated"] = True
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
                "name": spec.get("name") or strategy_id,
                "gate_attempts": gate_attempts, "lab_variants": lab_variants, "contaminated": contaminated,
                "evaluation_policy": scope, "provenance": identity}
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
            return {"run_id": run_id, "status": "cancelled", "verdict": None, "report_path": None,
                    "evaluation_policy": scope, **_saved_evidence(db, run_id)}
        except BaseException as error:
            _finish(db, run_id, "failed", None, None, "{}: {}".format(type(error).__name__, error), kind)
            raise
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    finally:
        db.close()


def run_summary(result, cfg):
    """What the strategy screen shows about a finished run, copied from the judge's output (nothing recomputed)."""
    rules = {r["id"]: r for r in result["rules"]}
    folds = rules["positive_folds"]["value"]
    return {"evaluation_policy": evaluation_policy.stored(result.get("evaluation_policy")),
            "accounting": accounting.stored(result.get("accounting")),
            "temporal": temporal.stored(result.get("temporal")),
            "provenance": provenance.stored(result.get("provenance")),
            "audit": provenance.stored_audit(result.get("audit"), result.get("provenance")),
            "verdict": result["verdict"], "verdict_note": result.get("verdict_note"),
            "inconclusive_reasons": result.get("inconclusive_reasons", []),
            "trades": result["overall"]["n"], "min_trades": cfg["rules"]["min_trades"],
            "mean_bp": result["overall"]["mean_bp"], "ci": list(result["ci"]),
            "positive_folds": folds["positive"], "folds": folds["total"],
            "min_positive_fold_share": cfg["rules"]["min_positive_fold_share"],
            "percentile": result["percentile"], "min_percentile": cfg["rules"]["min_percentile_vs_random"],
            "funding_share": result["funding_share"], "funding_status": result["funding_status"],
            "open_at_end": None, "contaminated": bool(result.get("contaminated")),
            # Every rule with what it asked and what it got: the screen says which failed and why (older runs lack it).
            "rules": [{key: r[key] for key in ("id", "label", "value", "threshold", "ok",
                                               "measurement_status", "reasons") if key in r}
                      for r in result["rules"]]}


ARTIFACT_SCHEMA = "balancita.gate-run-artifact.v1"
TRADE_SCHEMA = "balancita.gate-trade.v1"
ARTIFACTS_DIR = "artifacts"
TRADES_FILE = "trades.jsonl.gz"


def write_artifact(data_dir, meta, cfg, spec, digest, trades, open_at_end, result=None, traces=None):
    """Publishes ``<data>/artifacts/<run_id>/`` (manifest + closed trades) once, atomically and never again.

    The trades are those the simulator booked for the judged run, in the order the report uses: nothing is recomputed
    here, so the files cannot disagree with the verdict. ``result`` (the judge's output) gives the manifest the four
    figures the screen shows (``summary``); they are copied, never recomputed. The folder is built under a temporary name and renamed into
    place only when complete; a run without that folder simply has no stored trades (older runs never had them).
    """
    run_id = meta["run_id"]
    root = os.path.join(data_dir, ARTIFACTS_DIR)
    final = os.path.join(root, str(run_id))
    temp = os.path.join(root, ".tmp-{}-{}".format(run_id, os.getpid()))
    os.makedirs(root, exist_ok=True)
    shutil.rmtree(temp, ignore_errors=True)
    os.makedirs(temp)
    try:
        ordered = sorted(trades, key=lambda t: (t["entry_time_ms"], t["product_id"], t["side"]))
        lines = []
        for i, trade in enumerate(ordered, 1):
            lines.append(json.dumps(dict(trade, schema=TRADE_SCHEMA, run_id=run_id,
                                         trade_id="{}-{}".format(run_id, i), signal_time_ms=None,
                                         execution_type="simulated"), sort_keys=True, ensure_ascii=False))
        body = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
        with open(os.path.join(temp, TRADES_FILE), "wb") as handle:
            # mtime=0: the same trades give the same bytes (and the same checksum) every time.
            handle.write(gzip.compress(body, mtime=0))
        manifest = {"schema": ARTIFACT_SCHEMA, "run_id": run_id, "strategy_id": meta["strategy_id"],
                    "family": meta["family"], "version_key": meta["version_key"], "code_hash": digest,
                    "spec_hash": spec_hash(spec), "spec": spec, "kind": meta["kind"], "status": "complete",
                    "holdout_from": cfg["holdout_from"], "range_start_ms": meta["start_ms"],
                    "range_end_ms_exclusive": meta["end_ms"], "products": meta["products"],
                    "source": "kraken_futures_official_candles", "resolution": "1m",
                    "cost_model_version": COST_MODEL_VERSION, "gate_config_sha256": meta["config_hash"],
                    "trades_file": TRADES_FILE, "trades_count": len(ordered),
                    "trades_sha256": hashlib.sha256(body).hexdigest(), "open_at_end": int(open_at_end),
                    "decision_evidence": "not_captured", "contaminated": bool(meta.get("contaminated")),
                    "artifact_created_at_ms": _now_ms(), "summary": (dict(run_summary(result, cfg), open_at_end=int(open_at_end)) if result else None)}
        with open(os.path.join(temp, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, sort_keys=True, ensure_ascii=False, indent=1)
        if traces:
            # Signals, discards and per-trade evidence (``gate_trace``): written once, with its own checksum.
            data, trace_digest = encode(trace_lines(run_id, manifest["spec_hash"], traces))
            with open(os.path.join(temp, TRACE_FILE), "wb") as handle:
                handle.write(data)
            manifest.update(decision_evidence="captured", trace_file=TRACE_FILE, trace_schema=TRACE_SCHEMA,
                            trace_sha256=trace_digest)
            with open(os.path.join(temp, "manifest.json"), "w", encoding="utf-8") as handle:
                json.dump(manifest, handle, sort_keys=True, ensure_ascii=False, indent=1)
        if os.path.exists(final):
            raise GateError("la corrida {} ya tiene operaciones guardadas".format(run_id))
        os.rename(temp, final)
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    return final


def _saved_evidence(db, run_id):
    params = json.loads(db.execute("SELECT params FROM runs WHERE id=?", (run_id,)).fetchone()[0])
    return {key: params.get(key) for key in ("provenance", "audit")}


def _finish(db, run_id, status, verdict, report_path, error, kind):
    if status in ("failed", "cancelled"):
        params = json.loads(db.execute("SELECT params FROM runs WHERE id=?", (run_id,)).fetchone()[0])
        identity = provenance.stored(params.get("provenance"))
        if identity["state"] == "pending":
            identity = provenance.finish(identity, [])
        params.update(provenance=identity, audit=provenance.audit(identity, "unavailable", reason="run_" + status))
        with db:
            db.execute("UPDATE runs SET params=? WHERE id=?", (json.dumps(params, sort_keys=True), run_id))
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
            check_exam_allowed(db, spec, cfg, True)
            raise GateError("El examen final de esta versión ya se rindió.")
    runner.update(DOWNLOAD_SHARE, force=True, detail="calculando operaciones")
    span = PHASE_START["simulating"] - DOWNLOAD_SHARE
    main_jobs = [{"index": i, "label": "base", "spec": spec, "product": p, "tick": t, "start_ms": start_ms,
                  "end_ms": end_ms, "provider": provider, "funding": funding[p], "trade_source": trade_source,
                  "want_closes": True, "trace": kind == "practice"} for i, (p, t) in enumerate(product_list)]
    results = _run_tasks(runner, main_jobs, workers, DOWNLOAD_SHARE, span)
    trades = sorted((t for r in results for t in r["trades"]), key=lambda t: (t["entry_ms"], t["product"], t["side"]))
    full_trades = [t for r in results for t in r["full_trades"]]
    series = {r["product"]: {"closes": r["closes"], "first_ms": r["first_ms"], "start_index": r["start_index"]}
              for r in results}
    open_at_end = sum(r["open_at_end"] for r in results)
    # --- parameter neighbors (informational)
    runner.set_phase("simulating", "vecinos de parámetros")
    sens, nres = None, []
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
                   seed=cfg["seed"], neighbors=sens, open_at_end=open_at_end,
                   embargo_supported=not strategy_models.is_model(meta["strategy_id"]),
                   progress=lambda f: runner.update(PHASE_START["random"] + (PHASE_START["report"] - PHASE_START["random"]) * f))
    if meta.get("contaminated"):
        apply_contamination(result)
    result["evaluation_policy"] = meta["evaluation_policy"]
    result["provenance"] = provenance.finish(meta["provenance"],
        [r["input_provenance"] for r in results + nres])
    result["audit"] = provenance.audit(result["provenance"])
    result["accounting"] = accounting.summarize(trades,
        minimum_complete_share=cfg["rules"]["min_funding_complete_share"], open_at_end=open_at_end)
    # Persist independently of artifact availability; the API never recalculates historical accounting.
    params = json.loads(db.execute("SELECT params FROM runs WHERE id=?", (run_id,)).fetchone()[0])
    params["accounting"] = result["accounting"]
    params["temporal"] = result["temporal"]
    params.update(provenance=result["provenance"], audit=result["audit"])
    with db:
        db.execute("UPDATE runs SET params=? WHERE id=?", (json.dumps(params, sort_keys=True), run_id))
    # --- report
    runner.set_phase("report", "escribiendo el informe")
    meta["open_at_end"] = open_at_end
    meta["seconds"] = time.time() - runner.started
    notes = []
    if getattr(trade_source, "note", None):
        notes.append(trade_source.note)
    if not any(funding.values()):
        notes.append("Atención: no se pudo leer el historial de funding de Kraken; los costos de funding no están incluidos.")
    traces = [(r["product"], meta["start_ms"], meta["end_ms"], r["trace"]) for r in results if r.get("trace")]
    # This receipt is visible in the manifest only after the whole bundle's atomic publication.
    # The DB receives it only after write_artifact returns successfully.
    result["audit"] = provenance.audit(result["provenance"], "available", trace_captured=bool(traces))
    try:
        write_artifact(data_dir, meta, cfg, spec, digest, full_trades, open_at_end, result, traces=traces)
    except (OSError, GateError, TypeError, ValueError) as error:
        # The verdict is already computed and must not depend on storing the trades: a run without the folder just
        # shows no chart (the API answers "artifact_not_ready").
        result["audit"] = provenance.audit(result["provenance"], "unavailable")
        print("aviso: no se guardaron las operaciones de la corrida {}: {}".format(run_id, error), file=sys.stderr)
    params["audit"] = result["audit"]
    with db:
        db.execute("UPDATE runs SET params=? WHERE id=?", (json.dumps(params, sort_keys=True), run_id))
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
                          "status": "done", "verdict": result["verdict"], "report_path": path,
                          "evaluation_policy": meta["evaluation_policy"], "accounting": result["accounting"],
                          "temporal": result["temporal"], "provenance": result["provenance"],
                          "audit": result["audit"]}, ensure_ascii=False),
              file=runner.stream, flush=True)
    return {"run_id": run_id, "status": "done", "verdict": result["verdict"], "report_path": path, "result": result,
            "evaluation_policy": meta["evaluation_policy"], "accounting": result["accounting"],
            "temporal": result["temporal"], "provenance": result["provenance"], "audit": result["audit"]}


# --------------------------------------------------------------------------- CLI


def purge_strategy(strategy_id, data_dir=None, keep_tombstone=None):
    """Deletes everything the gate holds about ``strategy_id`` (the gate is the single writer of ``gate.sqlite``).

    Runs, attempts, exam locks, reports, stored trades, cancel flags and launch logs that mention it. The one exception is the
    anonymous exam tombstone (``strategy_purge.KEEP_EXAM_TOMBSTONE``): ``spec_hash``, date and verdict of each
    exam taken, nothing that names the strategy. Refuses while a run of it is still alive.
    Returns the counts of what was removed.
    """
    data_dir = data_dir or DATA_DIR
    keep_tombstone = strategy_purge.KEEP_EXAM_TOMBSTONE if keep_tombstone is None else keep_tombstone
    counts = {"runs": 0, "attempts": 0, "exam_locks": 0, "reports": 0, "artifacts": 0, "logs": 0, "cancel_flags": 0,
              "tombstones": 0}
    path = os.path.join(data_dir, DB_NAME)
    if os.path.exists(path):
        db = open_db(path)
        try:
            for row in db.execute("SELECT id, pid FROM runs WHERE strategy_id=? AND status='running'", (strategy_id,)):
                try:
                    os.kill(row["pid"], 0)
                except (OSError, TypeError):
                    continue
                raise GateError("Hay una prueba en curso de esta estrategia: cancelala antes de borrarla.")
            runs = db.execute("SELECT id, report_path FROM runs WHERE strategy_id=?", (strategy_id,)).fetchall()
            locks = db.execute("SELECT code_hash, locked_at, status, verdict, holdout_from FROM exam_locks "
                               "WHERE strategy_id=?",
                               (strategy_id,)).fetchall()
            with db:
                if keep_tombstone:
                    for lock in locks:
                        label = lock["verdict"] or "sin veredicto ({})".format(lock["status"])
                        counts["tombstones"] += db.execute(
                            "INSERT OR IGNORE INTO exam_tombstones VALUES(?,?,?)",
                            (lock["code_hash"], _stamp(lock["locked_at"]), label)).rowcount
                        db.execute("INSERT OR IGNORE INTO exam_window_tombstones VALUES(?,?,?,?,?)",
                                   (family_hash(family_of(strategy_id)), lock["holdout_from"], lock["code_hash"],
                                    _stamp(lock["locked_at"]), label))
                if strategy_purge.KEEP_ATTEMPT_COUNTER:
                    for family, n in db.execute("SELECT family, COUNT(*) FROM attempts WHERE strategy_id=? GROUP BY family",
                                                (strategy_id,)).fetchall():
                        db.execute("INSERT INTO attempt_counts VALUES(?,?) ON CONFLICT(family_hash) DO UPDATE SET n=n+?",
                                   (family_hash(family), n, n))
                counts["attempts"] = db.execute("DELETE FROM attempts WHERE strategy_id=?", (strategy_id,)).rowcount
                counts["exam_locks"] = db.execute("DELETE FROM exam_locks WHERE strategy_id=?", (strategy_id,)).rowcount
                counts["runs"] = db.execute("DELETE FROM runs WHERE strategy_id=?", (strategy_id,)).rowcount
            for row in runs:
                for candidate, key in ((os.path.join(data_dir, "reports", "{}.md".format(row["id"])), "reports"),
                                       (os.path.join(data_dir, "cancel", str(row["id"])), "cancel_flags")):
                    if os.path.isfile(candidate):
                        os.remove(candidate)
                        counts[key] += 1
                stored = os.path.join(data_dir, ARTIFACTS_DIR, str(row["id"]))
                if os.path.isdir(stored):
                    shutil.rmtree(stored, ignore_errors=True)
                    counts["artifacts"] += 1
                recorded = row["report_path"]
                if recorded and os.path.isfile(recorded) and os.path.realpath(recorded).startswith(
                        os.path.realpath(os.path.join(data_dir, "reports")) + os.sep):
                    os.remove(recorded)
                    counts["reports"] += 1
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            db.close()
    logs = os.path.join(data_dir, "logs")
    if os.path.isdir(logs):
        needle = strategy_id.encode("utf-8")
        for name in os.listdir(logs):
            full = os.path.join(logs, name)
            try:
                with open(full, "rb") as handle:
                    found = needle in handle.read()
                if found:
                    os.remove(full)
                    counts["logs"] += 1
            except OSError:
                continue
    return counts


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
    e.add_argument("--to", dest="to_date", help="YYYY-MM-DD (solo práctica; por defecto la fecha de corte): una etapa del mercado")
    e.add_argument("--products", help="PF_XBTUSD,PF_ETHUSD,... (por defecto los de la configuración)")
    e.add_argument("--exam", action="store_true", help="examen final: solo datos desde la fecha de corte; una vez por versión")
    e.add_argument("--evaluation-mode", default=evaluation_policy.BASELINE_MODE,
                   help="solo baseline_only: prueba determinista, no valida la política completa")
    e.add_argument("--examen-contaminado", action="store_true", dest="allow_contaminated",
                   help="solo con --exam: rinde el examen aunque la familia ya haya usado esta reserva; queda marcado "
                        "como contaminado y nunca puede dar PASA")
    e.add_argument("--json-progress", action="store_true", help="una línea JSON por avance en la salida estándar")
    e.add_argument("--sin-vecinos", action="store_true", help="omite la sensibilidad a parámetros vecinos (más rápido)")
    e.add_argument("--jobs", type=int, help="procesos de cálculo (por defecto min(CPU, 8))")
    e.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    e.add_argument("--kronos-dir", help="carpeta con kronos.sqlite (para juzgar a Kronos por sus operaciones guardadas)")
    e.add_argument("--qwen-live-dir", help="carpeta con live.sqlite (Qwen en vivo, solo lectura)")
    e.add_argument("--qwen-exit-dir", help="carpeta con qwen-exit.sqlite (para juzgar a Qwen por sus operaciones guardadas)")
    e.add_argument("--research-ledger", help="registro de intentos del laboratorio VectorBT (solo lectura)")
    e.add_argument("--registry-db", help="futures-strategies.sqlite del registro S (solo lectura): también se juzgan "
                                         "las estrategias creadas allí")
    r = sub.add_parser("runs", help="lista las corridas anteriores (una línea JSON por corrida)")
    r.add_argument("--strategy")
    q = sub.add_parser("purge", help="borra todo lo del gate sobre una estrategia (deja solo la lápida anónima del examen)")
    q.add_argument("--strategy", required=True)
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
        if args.command == "purge":
            print(json.dumps(purge_strategy(args.strategy, args.data_dir), sort_keys=True))
            return 0
        if args.command == "cancel":
            cancel_run(args.run, args.data_dir)
            print("cancelación pedida para la corrida {}".format(args.run))
            return 0
        out = evaluate(args.strategy, kind="exam" if args.exam else "practice", from_date=args.from_date, to_date=args.to_date,
                       products=args.products, data_dir=args.data_dir, specs_dir=args.specs_dir, registry_db=args.registry_db, kronos_dir=args.kronos_dir,
                       qwen_exit_dir=args.qwen_exit_dir, qwen_live_dir=args.qwen_live_dir, jobs=args.jobs, research_ledger=args.research_ledger,
                       neighbors=not args.sin_vecinos, json_progress=args.json_progress, install_signals=True,
                       allow_contaminated=args.allow_contaminated, evaluation_mode=args.evaluation_mode)
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
