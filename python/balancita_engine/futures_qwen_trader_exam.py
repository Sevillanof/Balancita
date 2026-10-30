"""Qwen operador v3: el examen con fotos del pasado (idea 6) y su informe.

Instead of waiting for a handful of trades, Qwen is shown thousands of "photos": the STATE it would really have been asked
about while flat (same wake rules as the trader: every closed hour, strong moves, funding), taken from stored candles before the
holdout. It answers as the v3 trader would (real numbers, then the mirrored numbers when it says LARGO / CORTO) and each answer
is compared with what the price did in the next 4 h and 24 h, after the round-trip cost. No position, no sequence, no tuning:
the entry threshold is the fixed ``practice_entry_threshold``.

Everything is stored in one SQLite file (``exam-v3.sqlite``): the photos (state, mirrored state, price moves) are made once,
every model call goes through the same ``calls`` table the practice uses, so the exam is resumable (``--max-minutes``) and a
cut question is never asked twice. Commands: ``python -m balancita_engine.futures_qwen_trader exam | exam-report``.

Not included, on purpose: funding (a few bp over 24 h) and the interaction with open positions. Photos of the same day
overlap in time, so the intervals are bootstrapped by day, not by photo.
"""

import json
import math
import os
import random
import time

from . import futures_qwen_analista as analista
from . import futures_qwen_corta as corta
from . import futures_qwen_exigencia as exigencia
from . import futures_qwen_factors as fq
from . import futures_qwen_ficha as fficha
from . import futures_qwen_maestro as maestro
from . import futures_qwen_noticias as noticias
from . import futures_qwen_trader as qt
from . import positioning_data
from .futures_costs import round_trip_cost_bps

DAY_MS, MINUTE_MS, BAR_MS = qt.DAY_MS, qt.MINUTE_MS, qt.BAR_MS
PASS, FAIL, INCONCLUSIVE = "PASA", "NO PASA", "INCONCLUSO"

ORDERS_PER_QUESTION = 2        # config prompt.orders for a 3-option question

_EXAM_SQL = """
CREATE TABLE IF NOT EXISTS exam_snapshots(
  snap_id TEXT PRIMARY KEY, product TEXT NOT NULL, t_ms INTEGER NOT NULL, ord INTEGER NOT NULL, wake_json TEXT,
  state_text TEXT NOT NULL, mirror_text TEXT NOT NULL, moves_json TEXT NOT NULL, cost_bp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS exam_answers(
  snap_id TEXT PRIMARY KEY, real_action TEXT, real_p REAL, mirror_action TEXT, mirror_p REAL, answered_ms INTEGER);
CREATE TABLE IF NOT EXISTS exam_operacion(snap_id TEXT PRIMARY KEY, op_json TEXT NOT NULL);
"""

# the operation of version 8 (the short sheet), measured on each photo: enter at the photo, leave at the first later wake where
# the maestro says at least "flojo" against the position, or at the time limit (``guardrails.max_hold_min``); every 15 min
OP_WHY_FLIP, OP_WHY_TIME = "vuelta", "tiempo"


# --------------------------------------------------------------------------- the photos


def exam_start_ms(cfg):
    """First moment of the photos: ``exam.from`` when the config has it (the short sheet: after the day its formulas were fitted
    with), never before ``practice.from`` (``--exam-from``)."""
    practice, exam = cfg["practice"], cfg["exam"]
    return max(qt.date_ms(practice["from"]), qt.date_ms(exam["from"]) if exam.get("from") else 0)


def _setup_photo_trader(history, cfg, product, start, holdout_ms, texts, bars):
    practice = cfg["practice"]
    trader = qt.Trader(cfg, product, None, history.funding(product), key="exam", entry_threshold=cfg["practice_entry_threshold"])
    ficha, short = bool(cfg.get("state_ficha")) and texts, bool(cfg.get("state_corta"))
    if ficha or short:
        trader.positioning = positioning_data.PositioningFeed(positioning_path(cfg), product)
    if short:
        trader.news = noticias.NewsFeed(news_path(cfg))
    warm_from = start - practice["warmup_days"] * DAY_MS
    for other in cfg.get("state_context") or ():
        if other != product:
            trader.context[other] = {int(b["bucket_start"]) + BAR_MS: float(b["close"]) for b in history.bars(
                other, warm_from, holdout_ms)}
    movement = None
    if analista.sizes_of(cfg):
        movement = analista.Movement(history.bars(product, warm_from - analista.extra_days(cfg) * DAY_MS, warm_from) + bars)
    return trader, ficha, short, movement


def _wake_entry_tuple(trader, t_ms, reasons, texts, ficha):
    state = trader.state_text(t_ms, reasons) if texts else ""
    mirror = trader.state_text(t_ms, reasons, mirror=True) if texts else ""
    numbers = fficha.numbers(trader, t_ms) if ficha else None
    facts = maestro.flat_facts(fficha.facts(trader, t_ms)) if ficha else None
    return (t_ms, reasons, state, mirror, numbers, facts)


def _record_short_reading(trader, t_ms, readings):
    facts = fficha.facts(trader, t_ms)
    if corta.missing(facts):
        return False
    readings[t_ms] = corta.readings(trader, t_ms, facts)
    return True


def _collect_photo_wakes(trader, bars, start, market, texts, ficha, short):
    closes, found, readings = {}, [], {}
    for bar in bars:
        trader.feed(bar, trade=False)
        t_ms = int(bar["bucket_start"]) + BAR_MS
        closes[t_ms] = float(bar["close"])
        if market is not None and t_ms >= start and t_ms % qt.HOUR_MS == 0:
            market.append([t_ms, closes[t_ms]])
        reasons = trader.wake_reasons(t_ms) if len(trader.c) >= qt.MIN_BARS else []
        if not reasons:
            continue
        if short and not _record_short_reading(trader, t_ms, readings):
            continue
        if t_ms >= start:
            trader.last_call_ms = t_ms
            found.append(_wake_entry_tuple(trader, t_ms, reasons, texts, ficha))
    return closes, found, readings


def make_photos(history, cfg, product, holdout_ms, texts=True, market=None, start_ms=None, moves=True):
    """Every moment the trader would have asked Qwen while flat, with its STATE, the mirrored STATE and the price moves (bp)
    over each horizon. Only candles before the holdout are read, and a moment whose horizon would reach it is dropped.

    With the short sheet (``state_corta``) a moment with incomplete data is no photo (the live operator skips that wake), and
    every photo carries ``operacion``: the maestro and the portero at that moment and, for each side, the result of the
    version 8 operation (``_operation``).

    ``texts=False`` (the formula-only test, no Qwen): the photos carry no STATE text nor sheet numbers, only the operation.
    ``start_ms`` replaces the start of the exam range (the replay of the live scheme over any old period) and ``moves=False``
    keeps the photos whose later horizons are not known (only the operation matters there).
    ``market`` (a list): receives the hourly closes ``[t_ms, close]`` of the exam range, to compare with what really happened."""
    practice, exam = cfg["practice"], cfg["exam"]
    start = exam_start_ms(cfg) if start_ms is None else start_ms
    horizons = [m * MINUTE_MS for m in exam["horizons_min"]]
    bars = history.bars(product, start - practice["warmup_days"] * DAY_MS, holdout_ms)
    if len(bars) < (holdout_ms - (start - practice["warmup_days"] * DAY_MS)) // BAR_MS * 0.98:
        raise qt.TraderError("{}: faltan velas para el examen; ejecutá `prefetch`".format(product))
    trader, ficha, short, movement = _setup_photo_trader(history, cfg, product, start, holdout_ms, texts, bars)
    closes, found, readings = _collect_photo_wakes(trader, bars, start, market, texts, ficha, short)
    cost = float(round_trip_cost_bps(product))
    weak = corta.formulas(cfg)[0]["umbrales"]["flojo"] if short else None
    out = []
    for t_ms, reasons, state, mirror, numbers, facts in found:
        later = [closes.get(t_ms + h) for h in horizons]
        if None in later and moves:
            continue
        photo = {"product": product, "t_ms": t_ms, "wake": reasons, "state_text": state, "mirror_text": mirror,
                 "moves": {str(m): (price / closes[t_ms] - 1) * 1e4 for m, price in zip(exam["horizons_min"], later)
                           if price is not None},
                 "cost_bp": cost}
        if numbers is not None:
            photo["ficha"] = numbers
            photo["hechos"] = facts
        if short:
            operation = _operation(cfg, t_ms, readings, closes, cost, weak, trader.funding if moves else None)
            if operation is None:
                continue
            photo["operacion"] = analista.sized(cfg, operation, movement, t_ms)
        out.append(photo)
    return out


def _v8_exit(cfg, t_ms, side, readings, closes, cost, weak, funding=None):
    """The version 8 / 9 operation opened at ``t_ms`` on ``side`` (+1 long, -1 short): out at the first later wake where the
    maestro says at least flojo against it, or at ``guardrails.max_hold_min`` when there is a time limit. Without one
    (``max_hold_min`` null, version 9) the operation lasts as long as the maestro does not turn: ``None`` when it never turns
    within the data (nothing to measure yet). ``None`` also without a candle at the exit."""
    hold, step = cfg["guardrails"]["max_hold_min"], cfg["wake"]["position_every_min"]
    step_ms = step * MINUTE_MS
    last = max(readings) if readings else t_ms
    limit = t_ms + hold * MINUTE_MS if hold else last
    exit_ms, why = (t_ms + hold * MINUTE_MS, OP_WHY_TIME) if hold else (None, OP_WHY_FLIP)
    at = t_ms + step_ms
    while at <= limit:
        r = readings.get(at)
        if r is not None and side * r["puntaje"] <= -r.get("flojo", weak):      # a skipped wake (incomplete data): the position goes on
            exit_ms, why = at, OP_WHY_FLIP
            break
        at += step_ms
    if exit_ms is None:
        return None
    c0, c1 = closes.get(t_ms), closes.get(exit_ms)
    if c0 is None or c1 is None:
        return None
    paid, _ = (funding.accrue(t_ms, exit_ms, qt.D(100), side > 0)
               if funding is not None and cfg.get("entrada") == "formula_eth" else (0.0, 0))
    funding_bp = float(paid) / 100.0 * 1e4
    return {"salida_ms": exit_ms, "motivo": why, "horas": (exit_ms - t_ms) / qt.HOUR_MS,
            "neto_bp": side * (c1 / c0 - 1) * 1e4 - cost - funding_bp,
            "entrada_px": c0, "salida_px": c1}


def _operation(cfg, t_ms, readings, closes, cost, weak, funding=None):
    """What the formulas said at the photo and the result of the version 8 operation on each side."""
    r = readings.get(t_ms)
    if r is None:
        return None
    sides = {name: _v8_exit(cfg, t_ms, side, readings, closes, cost, weak, funding) for name, side in (("largo", 1), ("corto", -1))}
    if None in sides.values():
        return None
    return {"maestro": r["veredicto"], "puntaje": r["puntaje"], "portero_si": bool(r["portero_si"]), "portero_p": r["portero_p"],
            "noticias_si": bool(r.get("noticias_si")), "volatilidad": r["volatilidad"], **sides}


def positioning_path(cfg):
    """The collector's database: ``cfg["positioning_db"]`` (``--positioning-db``), else the one ``pnpm dev`` writes."""
    return cfg.get("positioning_db") or positioning_data.default_path()


def news_path(cfg):
    """The news collector's database: ``cfg["news_db"]`` when given, else the default path."""
    return cfg.get("news_db") if "news_db" in cfg else noticias.default_path()


def choose_photos(photos, cfg, holdout_ms):
    """Seeded sample, stratified by product and time bin, ordered so that any prefix is balanced."""
    exam, products = cfg["exam"], cfg["exam"]["products"]
    start = exam_start_ms(cfg)
    span = holdout_ms - start
    strata = {}
    for photo in photos:
        time_bin = min(exam["time_bins"] - 1, (photo["t_ms"] - start) * exam["time_bins"] // span)
        strata.setdefault((photo["product"], time_bin), []).append(photo)
    per_stratum = exam["snapshots"] // (len(products) * exam["time_bins"])
    ranked = []
    for (product, time_bin), items in sorted(strata.items()):
        rng = random.Random("{}:{}:{}".format(exam["seed"], product, time_bin))  # NOSONAR - deterministic stratified sampling
        for rank, photo in enumerate(rng.sample(items, min(per_stratum, len(items)))):  # NOSONAR
            ranked.append((rank, rng.random(), product, photo))  # NOSONAR
    ranked.sort(key=lambda row: row[:3])
    return [row[3] for row in ranked]


def snap_id(product, t_ms):
    return "exam:{}:{}".format(product, t_ms)


def exam_identity(cfg, holdout_ms):
    out = {"config_hash": qt.config_hash(cfg), "exam": cfg["exam"], "holdout_ms": holdout_ms,
           "practice_entry_threshold": cfg["practice_entry_threshold"]}
    if qt.lora_of(cfg):
        out["lora"] = qt.lora_of(cfg)            # an exam with a LoRA adapter never shares a database with the plain model
    return out


def _store_photos(pdb, photos):
    with pdb.db:
        for order, p in enumerate(photos):
            pdb.db.execute("INSERT OR IGNORE INTO exam_snapshots VALUES(?,?,?,?,?,?,?,?,?)", (
                snap_id(p["product"], p["t_ms"]), p["product"], p["t_ms"], order, json.dumps(p["wake"]), p["state_text"],
                p["mirror_text"], json.dumps(p["moves"]), p["cost_bp"]))
            if p.get("ficha") is not None:
                pdb.db.execute("INSERT OR IGNORE INTO exam_ficha VALUES(?,?)", (snap_id(p["product"], p["t_ms"]),
                                                                                 json.dumps(p["ficha"])))
            if p.get("operacion") is not None:
                pdb.db.execute("INSERT OR IGNORE INTO exam_operacion VALUES(?,?)", (snap_id(p["product"], p["t_ms"]),
                                                                                     json.dumps(p["operacion"])))


# --------------------------------------------------------------------------- asking


def _ensure_exam_snapshots(pdb, history, cfg, holdout_ms, factors, log):
    if pdb.db.execute("SELECT 1 FROM exam_snapshots LIMIT 1").fetchone():
        return
    photos = []
    for product in cfg["exam"]["products"]:
        log("examen: armando las fotos de {} (lee velas guardadas, sin modelo)…".format(product))
        photos += make_photos(history, cfg, product, holdout_ms)
    chosen = choose_photos(photos, cfg, holdout_ms)
    if cfg.get("memory"):
        from . import futures_qwen_memory as memory
        enough = memory.attach(chosen, photos, cfg)
        log("memoria: {} de {} fotos tienen casos parecidos suficientes".format(enough, len(chosen)))
    _store_photos(pdb, chosen)
    log("examen: {} fotos posibles, {} elegidas al azar repartidas en el tiempo".format(len(photos), len(chosen)))
    if factors:
        with_f6 = sum(1 for p in chosen if (p.get("ficha") or {}).get("F6") is not None)
        suffix = "" if with_f6 else ": no se encontró la base del colector, F6 dice n/d en todas"
        log("ficha: el renglón F6 (posicionamiento y prima) tiene datos en {} de {} fotos (base {}){}".format(
            with_f6, len(chosen), positioning_path(cfg), suffix))


def _resolve_exam_model(pdb, provider):
    identity = provider.identity()
    served_fn = getattr(provider, "served_model", None)
    served = served_fn() if callable(served_fn) else None
    if served and served not in pdb.meta().get("served_models", []):
        pdb.set_meta("served_models", pdb.meta().get("served_models", []) + [served])
    model = served or identity.get("model_ref") or "unknown"
    return model, served or identity.get("model_ref")


def _ask_factors_exam_row(decider, row, mirror_every):
    real_action, real_p = row["real_action"], row["real_p"]
    with_mirror = row["ord"] % mirror_every == 0
    if real_action is None and with_mirror:
        real, mirror = decider.ask_pair(row["snap_id"], row["t_ms"], row["state_text"], row["mirror_text"])
        return real["chosen"], real["probabilities"][real["chosen"]], mirror
    if real_action is None:
        real = decider.ask(row["snap_id"], row["t_ms"], "action", row["state_text"])
        return real["chosen"], real["probabilities"][real["chosen"]], None
    mirror = decider.ask(row["snap_id"], row["t_ms"], "mirror", row["mirror_text"]) if with_mirror else None
    return real_action, real_p, mirror


def _ask_exam_row(decider, row, factors, mirror_every, question):
    real_action, real_p, mirror_action, mirror_p = row["real_action"], row["real_p"], None, None
    try:
        if factors:
            real_action, real_p, mirror = _ask_factors_exam_row(decider, row, mirror_every)
        else:
            if real_action is None:
                real = decider.ask(row["snap_id"], row["t_ms"], "action", question, row["state_text"])
                real_action, real_p = real["chosen"], real["probabilities"][real["chosen"]]
            mirror = decider.ask(row["snap_id"], row["t_ms"], "mirror", question, row["mirror_text"])
        if mirror is not None:
            mirror_action, mirror_p = mirror["chosen"], mirror["probabilities"][mirror["chosen"]]
    except qt.DecisionError as error:
        done = getattr(error, "answers", None) or {}
        if real_action is None and "action" in done:
            real_action, real_p = done["action"]["chosen"], done["action"]["probabilities"][done["action"]["chosen"]]
    return real_action, real_p, mirror_action, mirror_p


def _run_exam_loop(pdb, decider, pending, cfg, factors, mirror_every, clock, started, on_progress, log):
    questions, reason, handled = {}, "done", 0
    if on_progress:
        on_progress(0, len(pending))
    for row in pending:
        question = None if factors else questions.setdefault(row["product"], qt.questions_for(cfg, row["product"])["flat"])
        try:
            real_action, real_p, mirror_action, mirror_p = _ask_exam_row(decider, row, factors, mirror_every, question)
        except qt.BudgetExhausted:
            reason = "budget"
            break
        except qt.ModelDown:
            reason = "model_down"
            log("llama-server no contestó tres veces seguidas: se corta; lo hecho queda guardado")
            break
        with pdb.db:
            pdb.db.execute("INSERT OR REPLACE INTO exam_answers VALUES(?,?,?,?,?,?)", (
                row["snap_id"], real_action, real_p, mirror_action, mirror_p, int(time.time() * 1000)))
        handled += 1
        if on_progress:
            on_progress(handled, len(pending))
        if handled % 50 == 0:
            log("progreso: {} de {} fotos pendientes, {} llamadas nuevas, {:.2f} s de pared por llamada, {} transcurridos".format(
                handled, len(pending), decider.calls, decider.mean_call(), qt._eta(clock() - started)))
    return reason, handled


def run_exam(history, db_path, provider, cfg, holdout_ms, *, max_minutes=55.0, clock=time.monotonic, log=print,
             on_progress=None, concurrent=True, reference_db=None, mirror_every=1):
    """Asks Qwen about the photos not answered yet, inside ``max_minutes``. Returns
    ``{stop_reason, answered, total, calls}``; ``stop_reason``: ``done``, ``budget``, ``model_down``."""
    if not provider.health():
        raise qt.TraderError("llama-server no responde en {}: arrancalo con el modelo local y volvé a lanzar `exam`. Este "
                             "comando no descarga ningún modelo y solo habla con 127.0.0.1.".format(
                                 getattr(provider, "base_url", "el puerto local")))
    pdb = qt.PracticeDB(db_path)
    decider = None
    try:
        factors = bool(cfg.get("state_ficha"))
        pdb.db.executescript(_EXAM_SQL + (fq.FICHA_SQL if factors else ""))
        qt.check_identity(pdb, cfg, exam_identity(cfg, holdout_ms))
        _ensure_exam_snapshots(pdb, history, cfg, holdout_ms, factors, log)
        total = pdb.db.execute("SELECT COUNT(*) FROM exam_snapshots").fetchone()[0]
        pending = pdb.db.execute(
            "SELECT s.*, a.real_action, a.real_p FROM exam_snapshots s LEFT JOIN exam_answers a USING(snap_id) "
            "WHERE a.snap_id IS NULL OR (a.real_action IS NOT NULL AND a.mirror_action IS NULL AND NOT EXISTS ("
            "SELECT 1 FROM call_errors e WHERE e.block_id = s.snap_id AND e.step = 'mirror')) ORDER BY s.ord").fetchall()
        model, shown_model = _resolve_exam_model(pdb, provider)
        options = {"store": pdb, "clock": clock, "deadline": clock() + max_minutes * 60.0, "model": model}
        decider = fq.FactorsDecider(provider, cfg, concurrent=concurrent, reference=reference_db, **options) if factors \
            else qt.LlmDecider(provider, cfg, **options)
        started = clock()
        log("examen: {} fotos, {} por preguntar, presupuesto {} min, modelo {}".format(
            total, len(pending), max_minutes, shown_model))
        reason, handled = _run_exam_loop(pdb, decider, pending, cfg, factors, mirror_every, clock, started, on_progress, log)
        answered = pdb.db.execute("SELECT COUNT(*) FROM exam_answers").fetchone()[0]
        log("examen terminado ({}): {} de {} fotos contestadas, {} llamadas nuevas en {}".format(
            reason, answered, total, decider.calls, qt._eta(clock() - started)))
        reused = getattr(decider, "reused", 0)
        if factors and decider.reference:
            log("{} de {} respuestas reutilizadas del examen".format(reused, reused + decider.calls))
        return {"stop_reason": reason, "answered": answered, "total": total, "calls": decider.calls,
                "remaining": len(pending) - handled, "reused": reused}
    finally:
        if hasattr(decider, "close"):
            decider.close()
        pdb.close()


# --------------------------------------------------------------------------- the quick test

QUICK_SNAPSHOTS = 150
QUICK_MIRROR_EVERY = 2      # the quick test asks the mirror for 1 photo in every 2 (the exam asks it for all)
QUICK_STATE = "rapida-v3.json"
REFERENCE_DB = "exam-live.sqlite"      # the full exam of the live version: its answers are reused by the quick test
FORMULA_NOTE = ("Solo la fórmula, sin Qwen: todas las miradas de 15 minutos desde la fecha del examen, con una posición por producto, "
                "como opera en vivo. Mide lo que decide la fórmula; no mide a Qwen.")
QUICK_NOTE = ("Prueba rápida: solo una muestra de fotos del pasado, para filtrar cambios de prompt o modelo. Es orientativa: "
              "no es el Examen ni sirve para dar una estrategia por ganadora.")


def quick_cfg(cfg, snapshots=QUICK_SNAPSHOTS):
    """The exam config with a small sample: the same photos choice (stratified by product and time bin), fewer of them."""
    exam = dict(cfg["exam"])
    cells = len(exam["products"]) * exam["time_bins"]
    exam["snapshots"] = max(1, snapshots // cells) * cells
    return dict(cfg, exam=exam)


def fail_quick(state_path, variant, error):
    """A quick test that could not even start (e.g. its model is not on this Mac): the reason reaches the screen."""
    now = int(time.time() * 1000)
    state = {"state": "failed", "pid": os.getpid(), "started_ms": now, "finished_ms": now, "updated_ms": now, "answered": 0,
             "total": QUICK_SNAPSHOTS, "summary": None, "error": error, "variant": variant["id"]}
    _write_state(state_path, state)
    return state


def quick_summary(db_path, cfg):
    """The lean on the decision horizon, read off the sample: no verdict, only whether each signal points the right way."""
    rows, _ = load_answers(db_path)
    result = analyse_lean(rows, cfg)
    h = cfg["exam_lean"]["decide_horizon_min"]
    block = result["horizons"].get(h, {}).get("lean_num")
    if not block:
        return None
    ok = {c["id"]: c["ok"] for c in result["checks"]}
    summary = {"photos": result["n"], "horizon_min": h, "spearman": block["spearman"], "spearman_ci": list(block["sp_ci"]),
               "extremes_net_bp": block["ext_net"], "extremes_ci": list(block["ext_ci"]), "vs_random_pct": block["ext_pct"],
               "signals": {"extremes": ok.get("extremes"), "random": ok.get("random"), "spearman": ok.get("spearman")},
               "note": QUICK_NOTE}
    ficha = fq.ficha_summary(rows, cfg["exam"]["horizons_min"])        # only the factors variants have photos with gradients
    if ficha:
        summary["ficha"] = ficha
    operation = analyse_operation(rows, cfg)                           # only the short sheet (version 8) has operations
    if operation:
        summary["operacion"] = operation
    return summary


def _write_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False)
    os.replace(tmp, path)


def run_quick(history, db_path, provider, cfg, holdout_ms, *, snapshots=QUICK_SNAPSHOTS, max_minutes=55.0,
              clock=time.monotonic, log=print, state_path=None, variant=None, concurrent=True, **options):
    """Asks Qwen about a small stratified sample of the photos, in its own database (the full exam's is never touched),
    and leaves ``{state, answered, total, summary}`` in ``state_path`` for the screen. Every run starts from scratch: a
    changed prompt or model is exactly what it is for, and an old sample would be refused by the config identity.

    ``reference_db``: the full exam of the same version whose answers are reused when the question is exactly the same;
    by default ``exam-live.sqlite`` next to ``db_path`` if it exists."""
    reference_db = options.get("reference_db")
    mirror_every = options.get("mirror_every", QUICK_MIRROR_EVERY)
    state_path = state_path or os.path.join(os.path.dirname(os.path.abspath(db_path)), QUICK_STATE)
    started = int(time.time() * 1000)
    state = {"state": "running", "pid": os.getpid(), "started_ms": started, "answered": 0, "total": snapshots,
             "phase": "fotos", "updated_ms": started, "summary": None, "error": None,
             "variant": (variant or {}).get("id", "actual")}
    _write_state(state_path, state)
    try:
        if os.path.exists(db_path):
            os.replace(db_path, db_path + ".anterior")
        quick = quick_cfg(cfg, snapshots)

        last = [0.0]

        def progress(handled, total):
            # the screen polls every few seconds: no need to rewrite the file for every photo
            now = time.time()
            if handled in (0, total) or now - last[0] >= 2.0:
                last[0] = now
                state.update(answered=handled, total=total, phase="preguntando", updated_ms=int(now * 1000))
                if handled == 0:
                    state["asking_ms"] = int(now * 1000)       # when the questions began: the rate is measured from here
                _write_state(state_path, state)

        if reference_db is None:
            reference_db = os.path.join(os.path.dirname(os.path.abspath(db_path)), REFERENCE_DB)
        outcome = run_exam(history, db_path, provider, quick, holdout_ms, max_minutes=max_minutes, clock=clock, log=log,
                           on_progress=progress, concurrent=concurrent, reference_db=reference_db, mirror_every=mirror_every)
        state.update(answered=outcome["answered"], total=outcome["total"])
        if outcome["stop_reason"] == "done":
            state.update(state="done", summary=quick_summary(db_path, quick))
        else:
            state.update(state="failed", error="La prueba se cortó ({}): lo hecho quedó guardado, pero no alcanza para "
                                               "una lectura.".format(outcome["stop_reason"]))
    except Exception as error:  # noqa: BLE001 - whatever went wrong must reach the screen
        state.update(state="failed", error=str(error))
    state["finished_ms"] = int(time.time() * 1000)
    _write_state(state_path, state)
    return state


# --------------------------------------------------------------------------- the numbers


def load_answers(db_path):
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        sums = {}
        for r in pdb.db.execute("SELECT block_id, step, probs_json FROM calls WHERE step IN ('action', 'mirror') "
                                "AND block_id LIKE 'exam:%'"):
            probs = json.loads(r["probs_json"])
            acc = sums.setdefault((r["block_id"], r["step"]), [0.0, 0.0, 0])
            acc[0], acc[1], acc[2] = acc[0] + probs.get("LARGO", 0.0), acc[1] + probs.get("CORTO", 0.0), acc[2] + 1
        # mean over the option orders, as _merge does; a question with fewer than both orders stored (cut or failed halfway)
        # has no lean at all
        leans = {k: (v[0] / v[2], v[1] / v[2]) for k, v in sums.items() if v[2] == ORDERS_PER_QUESTION}
        rows = pdb.db.execute("SELECT s.*, a.real_action, a.real_p, a.mirror_action, a.mirror_p FROM exam_snapshots s "
                              "JOIN exam_answers a USING(snap_id) ORDER BY s.ord").fetchall()
        factors = fq.load_photo_factors(pdb)                  # photos asked with the factors question (``ficha`` variants)
        operations = {}                                       # photos of the short sheet (version 8): the operation per side
        if pdb.db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exam_operacion'").fetchone():
            operations = {r[0]: json.loads(r[1]) for r in pdb.db.execute("SELECT snap_id, op_json FROM exam_operacion")}
        out = []
        for r in rows:
            d = dict(r)
            d["moves"] = json.loads(d.pop("moves_json"))
            d["operacion"] = operations.get(d["snap_id"])
            d["p_largo"], d["p_corto"] = leans.get((d["snap_id"], "action"), (None, None))
            d["p_largo_m"], d["p_corto_m"] = leans.get((d["snap_id"], "mirror"), (None, None)) \
                if d["mirror_action"] is not None else (None, None)
            if d["snap_id"] in factors:
                # the lean of a factors photo is the sum of its voting gradients over 12; it reaches ``split_lean`` as the pair of
                # probabilities whose difference is that lean, so lean / lean_m / lean_num / habit come out unchanged
                f = d["factors"] = factors[d["snap_id"]]
                d["p_largo"], d["p_corto"] = fq.probabilities_for(fq.lean_of(f["real"]))
                if f["mirror"] is not None:
                    d["p_largo_m"], d["p_corto_m"] = fq.probabilities_for(fq.lean_of(f["mirror"]))
            d.update(split_lean(d))
            out.append(d)
        return out, pdb.meta()
    finally:
        pdb.close()


def split_lean(row):
    """``lean`` = p(LARGO) - p(CORTO) on the real numbers, ``lean_m`` the same on the mirrored ones. The part that flips sign
    in the mirror is what comes from the numbers (``lean_num``); the part that does not is the model's habit (``habit``)."""
    keys = ("lean", "lean_m", "lean_num", "habit")
    if None in (row["p_largo"], row["p_corto"]):
        return dict.fromkeys(keys)
    lean = row["p_largo"] - row["p_corto"]
    if None in (row["p_largo_m"], row["p_corto_m"]):
        return dict(dict.fromkeys(keys), lean=lean)
    lean_m = row["p_largo_m"] - row["p_corto_m"]
    return {"lean": lean, "lean_m": lean_m, "lean_num": (lean - lean_m) / 2, "habit": (lean + lean_m) / 2}


def net(row, side, horizon):
    """Net bp of holding ``side`` (+1 long, -1 short) for the horizon, round-trip cost taken off."""
    return side * row["moves"][str(horizon)] - row["cost_bp"]


def side_of(row):
    return 1 if row["real_action"] == "LARGO" else -1


def classify(row, threshold):
    """``pasa`` (would trade), ``espejo`` (blocked by the mirror), ``umbral`` (below the threshold), ``espera``, ``sin_respuesta``."""
    action = row["real_action"]
    if action is None:
        return "sin_respuesta"
    if action == "ESPERAR":
        return "espera"
    if row["real_p"] < threshold:
        return "umbral"
    return "pasa" if qt.mirror_passes(action, row["mirror_action"]) else "espejo"


def mean(values):
    return math.fsum(values) / len(values) if values else None


def day_bootstrap(rows, values, draws, seed):
    """95 % interval of the mean of ``values`` resampling whole days (photos of one day are not independent)."""
    if not values:
        return None, None
    days = {}
    for row, value in zip(rows, values):
        days.setdefault(row["t_ms"] // DAY_MS, []).append(value)
    groups = list(days.values())
    rng = random.Random(seed)  # NOSONAR - deterministic bootstrap seed
    means = []
    for _ in range(draws):
        picked = [v for g in (rng.choice(groups) for _ in groups) for v in g]  # NOSONAR
        means.append(math.fsum(picked) / len(picked))
    means.sort()
    return means[int(0.025 * draws)], means[min(draws - 1, int(0.975 * draws))]


def random_percentile(rows, horizon, draws, seed, observed, side=None):
    """Share (0-100) of random draws that Qwen's mean beat. A draw keeps Qwen's sides but flips ALL of a day's sides or none
    (one coin per day): a model that repeats the same side all day is then compared with luck at the same granularity, not with
    a fresh coin per photo (which would be too easy to beat)."""
    if not rows:
        return None
    side = side or side_of
    rng = random.Random(seed)  # NOSONAR - deterministic permutation seed
    days = sorted({r["t_ms"] // DAY_MS for r in rows})
    below = 0
    for _ in range(draws):
        flip = {d: rng.choice((1, -1)) for d in days}  # NOSONAR
        if mean([net(r, flip[r["t_ms"] // DAY_MS] * side(r), horizon) for r in rows]) < observed:
            below += 1
    return 100.0 * below / draws


def _horizon_entry_info(rows, groups, h, rules, exam):
    info = {}
    for name in ("pasa", "espejo"):
        nets = [net(r, side_of(r), h) for r in groups[name]]
        info[name] = {"n": len(nets), "mean": mean(nets), "hit": mean([1.0 if v > 0 else 0.0 for v in nets])}
    for name in ("LARGO", "CORTO"):
        side = 1 if name == "LARGO" else -1
        mine = [r for r in rows if r["real_action"] == name]
        nets = [net(r, side, h) for r in mine]
        info[name] = {"n": len(nets), "mean": mean(nets), "hit": mean([1.0 if v > 0 else 0.0 for v in nets])}
    waits = [r for r in rows if r["real_action"] == "ESPERAR"]
    info["ESPERAR"] = {"n": len(waits), "mean": None,
                       "hit": mean([1.0 if net(r, 1, h) <= 0 and net(r, -1, h) <= 0 else 0.0 for r in waits])}
    ops = groups["pasa"]
    nets = [net(r, side_of(r), h) for r in ops]
    lo, hi = day_bootstrap(ops, nets, rules["random_draws"], exam["seed"])
    info["ci"] = (lo, hi)
    info["always_long"] = mean([net(r, 1, h) for r in ops])
    info["always_short"] = mean([net(r, -1, h) for r in ops])
    info["all_long"] = mean([net(r, 1, h) for r in rows])
    info["percentile"] = random_percentile(ops, h, rules["random_draws"], exam["seed"], info["pasa"]["mean"]) if ops else None
    return info


def _verdict_from_checks(checks, inconclusive):
    if all(c["ok"] for c in checks):
        return PASS
    return INCONCLUSIVE if inconclusive else FAIL


def analyse(rows, meta, cfg):
    exam, rules = cfg["exam"], cfg["exam_rules"]
    threshold, horizons = cfg["practice_entry_threshold"], exam["horizons_min"]
    groups = {k: [] for k in ("pasa", "espejo", "umbral", "espera", "sin_respuesta")}
    for row in rows:
        groups[classify(row, threshold)].append(row)
    out = {"n": len(rows), "groups": {k: len(v) for k, v in groups.items()}, "horizons": {}, "threshold": threshold}
    if meta:
        out["meta"] = meta
    for h in horizons:
        out["horizons"][h] = _horizon_entry_info(rows, groups, h, rules, exam)
    checks = [{"id": "n_operations", "ok": len(groups["pasa"]) >= rules["min_operations"], "value": len(groups["pasa"])}]
    for h in horizons:
        i = out["horizons"][h]
        positive = i["ci"][0] is not None and i["ci"][0] > 0
        beats = i["percentile"] is not None and i["percentile"] >= rules["min_percentile_vs_random"]
        better = i["pasa"]["mean"] is not None and i["pasa"]["mean"] > i["always_long"]
        checks += [{"id": "positive", "h": h, "ok": positive, "value": i["ci"]},
                   {"id": "random", "h": h, "ok": beats, "value": i["percentile"]},
                   {"id": "always_long", "h": h, "ok": better, "value": (i["pasa"]["mean"], i["always_long"])}]
    others_ok = all(c["ok"] for c in checks if c["id"] != "n_operations")
    out["checks"] = checks
    inconclusive = not groups["pasa"] or (others_ok and not checks[0]["ok"])
    out["verdict"] = _verdict_from_checks(checks, inconclusive)
    return out


# --------------------------------------------------------------------------- the operation (version 8)


def _op_side(row, side):
    return row["operacion"]["largo" if side > 0 else "corto"]


def _op_stats(items, draws, seed):
    """``items``: ``(row, side)``. Mean net bp per operation, winners, 95 % interval by day, exits and hours."""
    nets = [_op_side(r, s)["neto_bp"] for r, s in items]
    rows = [r for r, _ in items]
    lo, hi = day_bootstrap(rows, nets, draws, seed)
    return {"n": len(nets), "neto_bp": mean(nets), "ganadoras": mean([1.0 if v > 0 else 0.0 for v in nets]), "ic": [lo, hi],
            "total_bp": math.fsum(nets) if nets else None,
            "por_vuelta": sum(1 for r, s in items if _op_side(r, s)["motivo"] == OP_WHY_FLIP),
            "por_tiempo": sum(1 for r, s in items if _op_side(r, s)["motivo"] == OP_WHY_TIME),
            "horas": mean([_op_side(r, s)["horas"] for r, s in items])}


def _per_week(stats, rows):
    """Adds ``por_semana`` (operations per week over the span of the photos) to the stats of one way of operating."""
    ms = [r["t_ms"] for r in rows]
    weeks = (max(ms) - min(ms)) / (7 * DAY_MS) if ms else 0
    stats["por_semana"] = stats["n"] / weeks if weeks >= 1 else None
    return stats


def exigencia_used(cfg):
    """The levels this test ran with, the thresholds they mean and the paper mark (always shown with the result)."""
    teacher, keeper = corta.formulas(dict(cfg, exigencia=None))
    return exigencia.describe(teacher, keeper, exigencia.levels(**(cfg.get("exigencia") or {})))


def _op_random_percentile(items, draws, seed, observed):
    """As ``random_percentile``, with the result of the version 8 operation: one coin per day flips all its sides or none."""
    if not items or observed is None:
        return None
    rng = random.Random(seed)  # NOSONAR - deterministic permutation seed
    days = sorted({r["t_ms"] // DAY_MS for r, _ in items})
    below = 0
    for _ in range(draws):
        flip = {d: rng.choice((1, -1)) for d in days}  # NOSONAR
        if mean([_op_side(r, flip[r["t_ms"] // DAY_MS] * s)["neto_bp"] for r, s in items]) < observed:
            below += 1
    return 100.0 * below / draws


def _formula_says_yes(op):
    return bool(op.get("portero_si") or op.get("noticias_si"))


def analyse_operation(rows, cfg):
    """How the version 8 operator would have done on the photos: every entry Qwen makes (LARGO / CORTO over the threshold and
    confirmed by the mirror, as the live operator requires), closed when the maestro turns at least flojo against it or at the
    time limit. The same for the formulas alone on the same photos. ``None`` when the photos carry no operation."""
    rows = [r for r in rows if r.get("operacion")]
    if not rows:
        return None
    exam, rules, threshold = cfg["exam"], cfg["exam_rules"], cfg["practice_entry_threshold"]
    draws, seed = rules["random_draws"], exam["seed"]
    entries = [(r, side_of(r)) for r in rows if classify(r, threshold) == "pasa"]
    said = [(r, side_of(r)) for r in rows if r["real_action"] in ("LARGO", "CORTO")]
    maestro_side = lambda r: 1 if r["operacion"]["maestro"] > 0 else -1
    strong = [(r, maestro_side(r)) for r in rows if abs(r["operacion"]["maestro"]) == 2]
    formula = [(r, s) for r, s in strong if _formula_says_yes(r["operacion"])]
    qwen = _per_week(_op_stats(entries, draws, seed), rows)
    qwen["con_maestro"] = mean([1.0 if r["operacion"]["maestro"] * s > 0 else 0.0 for r, s in entries])
    qwen["con_portero"] = mean([1.0 if r["operacion"]["portero_si"] else 0.0 for r, _ in entries])
    qwen["vs_azar_pct"] = _op_random_percentile(entries, draws, seed, qwen["neto_bp"])
    out = {"fotos": len(rows), "max_horas": (cfg["guardrails"]["max_hold_min"] or 0) / 60.0,
           "salida": ("cuando el maestro se da vuelta (al menos flojo en contra) o a las {} h, sin stop".format(
               qt.es(cfg["guardrails"]["max_hold_min"] / 60.0, 0)) if cfg["guardrails"]["max_hold_min"] else
               "cuando el maestro se da vuelta (al menos flojo en contra), sin stop y sin límite de tiempo"),
           "exigencia": exigencia_used(cfg), "analista": analista.describe(cfg),
           "qwen": qwen, "qwen_todas": _per_week(_op_stats(said, draws, seed), rows),
           "formula": _per_week(_op_stats(formula, draws, seed), rows),
           "maestro_fuerte": _per_week(_op_stats(strong, draws, seed), rows),
           "siempre_largo": _per_week(_op_stats([(r, 1) for r, _ in entries], draws, seed), rows),
           "siempre_corto": _per_week(_op_stats([(r, -1) for r, _ in entries], draws, seed), rows),
           "espejo_bloqueo": sum(1 for r in rows if classify(r, threshold) == "espejo"),
           "espera": sum(1 for r in rows if r["real_action"] == "ESPERAR"),
           "nocional_usd": float(cfg.get("notional_usd") or 0),
           "curvas": {"qwen": _trade_list(entries), "formula": _trade_list(formula), "maestro_fuerte": _trade_list(strong)}}
    gains = qwen["neto_bp"] is not None and qwen["neto_bp"] > 0
    out["signals"] = {"gana": gains if qwen["n"] else None,
                      "ic_positivo": (qwen["ic"][0] is not None and qwen["ic"][0] > 0) if qwen["n"] else None,
                      "azar": (qwen["vs_azar_pct"] is not None and qwen["vs_azar_pct"] >= rules["min_percentile_vs_random"])
                      if qwen["n"] else None,
                      "mejor_que_formula": (qwen["neto_bp"] > out["formula"]["neto_bp"])
                      if qwen["n"] and out["formula"]["n"] else None}
    return out


def _trade_list(items):
    """The operations for the screen, by time: product, side, entry and exit, net bp after costs and why it closed."""
    out = []
    for r, s in sorted(items, key=lambda it: it[0]["t_ms"]):
        o = _op_side(r, s)
        out.append({"producto": r["product"], "lado": s, "entrada_ms": r["t_ms"], "salida_ms": o["salida_ms"],
                    "neto_bp": round(o["neto_bp"], 2), "motivo": o["motivo"], "maestro": r["operacion"]["maestro"],
                    "portero": bool(r["operacion"]["portero_si"]), "noticias": bool(r["operacion"].get("noticias_si")),
                    "tamano": r["operacion"].get("tamano", 1.0), "movimiento": r["operacion"].get("movimiento")})
    return out


def _one_at_a_time(items):
    """As the live operator: one position per product. A photo while one is open is not an entry."""
    free, out = {}, []
    for r, s in sorted(items, key=lambda it: it[0]["t_ms"]):
        if r["t_ms"] < free.get(r["product"], 0):
            continue
        free[r["product"]] = _op_side(r, s)["salida_ms"]
        out.append((r, s))
    return out


def analyse_formula(photos, cfg):
    """The formulas alone (no Qwen) over EVERY wake of the exam range, operating as the live operator does: enters when the
    maestro is strong and the portero agrees, one position per product, out when the maestro turns (or at the time limit).
    ``always long`` / ``always short`` open at the same moments. ``None`` when there is nothing to measure."""
    rows = [r for r in photos if r.get("operacion")]
    if not rows:
        return None
    draws, seed = cfg["exam_rules"]["random_draws"], cfg["exam"]["seed"]
    side = lambda r: 1 if r["operacion"]["maestro"] > 0 else -1
    strong = [(r, side(r)) for r in rows if abs(r["operacion"]["maestro"]) == 2]
    formula = _one_at_a_time([(r, s) for r, s in strong if _formula_says_yes(r["operacion"])])
    maestro = _one_at_a_time(strong)
    hold = cfg["guardrails"]["max_hold_min"]
    return {"entrada": cfg.get("entrada", "formula"), "fotos": len(rows), "desde_ms": min(r["t_ms"] for r in rows),
            "hasta_ms": max(r["t_ms"] for r in rows), "max_horas": (hold or 0) / 60.0,
            "nocional_usd": float(cfg.get("notional_usd") or 0),
            "productos": sorted({r["product"] for r in rows}), "exigencia": exigencia_used(cfg),
            "analista": analista.describe(cfg), "por_movimiento": analista.split(formula, _op_side) if analista.sizes_of(cfg) else None,
            "formula": _per_week(_op_stats(formula, draws, seed), rows),
            "maestro_fuerte": _per_week(_op_stats(maestro, draws, seed), rows),
            "siempre_largo": _per_week(_op_stats([(r, 1) for r, _ in formula], draws, seed), rows),
            "siempre_corto": _per_week(_op_stats([(r, -1) for r, _ in formula], draws, seed), rows),
            "curvas": {"formula": _trade_list(formula), "maestro_fuerte": _trade_list(maestro),
                       "siempre_largo": _trade_list([(r, 1) for r, _ in formula]),
                       "siempre_corto": _trade_list([(r, -1) for r, _ in formula])}}


def formula_entries(photos):
    """The entries of the live scheme among these photos: strong maestro and the portero in favour, one position per product.
    ``(photo, side)`` by time. The honest measurement engine (``futures_walkforward``) picks its entries with this same function."""
    side = lambda r: 1 if r["operacion"]["maestro"] > 0 else -1
    return _one_at_a_time([(r, side(r)) for r in photos if r.get("operacion") and abs(r["operacion"]["maestro"]) == 2
                           and _formula_says_yes(r["operacion"])])


def _funding_coverage_status(covered, held):
    if covered >= held:
        return "complete"
    return "partial" if covered > 0 else "unknown"


def scheme_trades(history, cfg, product, start_ms, end_ms, holdout_ms, funding=None):
    """The live scheme replayed over old candles, without Qwen: every entry of the formulas (strong maestro and the portero in
    favour, one position per product), closed when the maestro turns or at the safety limit, as the live operator does. Trades as
    the strategy gate reads them; only those that opened at or after ``start_ms`` and closed by ``end_ms``. Nothing at or after
    the holdout is read."""
    end_ms = min(end_ms, holdout_ms)
    start_ms = max(start_ms, qt.date_ms(cfg["practice"]["from"]))
    if start_ms >= end_ms or product not in cfg["products"]:
        return []
    hold = cfg["guardrails"]["max_hold_min"]
    extra_ms = hold * MINUTE_MS if hold else 10 * DAY_MS
    reach = min(holdout_ms, end_ms + extra_ms + DAY_MS)
    photos = [p for p in make_photos(history, cfg, product, reach, texts=False, start_ms=start_ms, moves=False)
              if p["t_ms"] < end_ms]
    chosen = formula_entries(photos)
    line = qt.FundingLine([(r[0], r[1]) for r in funding]) if funding else None
    out = []
    for r, s in chosen:
        o = _op_side(r, s)
        if o["salida_ms"] > end_ms:
            continue
        paid, covered = line.accrue(r["t_ms"], o["salida_ms"], qt.D(100), s > 0) if line is not None else (0.0, 0)
        held = o["salida_ms"] - r["t_ms"]
        size = r["operacion"].get("tamano", 1.0)
        out.append({"side": "LONG" if s > 0 else "SHORT", "entry_time_ms": r["t_ms"], "exit_time_ms": o["salida_ms"],
                    "net_bp": o["neto_bp"] - size * float(paid) / 100.0 * 1e4,
                    "size_mult": size, "with_movement": r["operacion"].get("movimiento"), "entry_price": str(o["entrada_px"]),
                    "exit_price": str(o["salida_px"]), "funding_usd": float(paid) * size,
                    "funding_status": _funding_coverage_status(covered, held),
                    "exit_reason": o["motivo"], "source": "formula"})
    return out


def _honesty(cfg, op):
    """The honesty meter of this test (``futures_walkforward.meter``): registers the attempt and judges the formula's operations."""
    from . import futures_walkforward as walkforward
    medicion = "honesta" if (cfg.get("corta") or {}).get("pares") else "vigente"
    walkforward.register(walkforward.test_spec(cfg), medicion=medicion)
    trades = [{"t_in": t["entrada_ms"], "t_out": t["salida_ms"], "net": t["neto_bp"]} for t in op["curvas"]["formula"]]
    return walkforward.meter(trades, medicion=medicion, trial_count=walkforward.trials())


def run_formula(history, cfg, holdout_ms, state_path, variant, *, log=print):
    """The formula-only test: no Qwen, no llama-server, only stored candles. Leaves ``{state, summary}`` in ``state_path``."""
    started = int(time.time() * 1000)
    products = cfg["exam"]["products"]
    state = {"state": "running", "pid": os.getpid(), "started_ms": started, "answered": 0, "total": len(products),
             "phase": "fotos", "updated_ms": started, "summary": None, "error": None, "variant": variant["id"]}
    _write_state(state_path, state)
    try:
        from . import futures_qwen_rebote as rebote
        from . import futures_walkforward as walkforward
        if rebote.from_env() == "formula_eth" or cfg.get("entrada") == "formula_eth":
            def on_eth_progress(done, total):
                now = int(time.time() * 1000)
                state.update(phase="preguntando", asking_ms=state.get("asking_ms") or started,
                             answered=done, total=total, updated_ms=now)
                _write_state(state_path, state)
            pares = walkforward.ensure_eth_pairs(history.cache_dir, log=log, on_progress=on_eth_progress)
            cfg = walkforward.with_eth_formulas(cfg, walkforward.medicion_from_env(), pares=pares)
            state.update(phase="fotos", answered=0, total=len(products), updated_ms=int(time.time() * 1000))
            _write_state(state_path, state)
        photos, market = [], {}
        for product in products:
            log("fórmula: leyendo las velas de {} (sin modelo)…".format(product))
            market[product] = []
            photos += make_photos(history, cfg, product, holdout_ms, texts=False, market=market[product])
            state.update(answered=state["answered"] + 1, updated_ms=int(time.time() * 1000))
            _write_state(state_path, state)
        op = analyse_formula(photos, cfg)
        if op is not None:
            op["mercado"] = market                       # what the price really did: hourly closes by product
            op["honestidad"] = _honesty(cfg, op)
        h = cfg["exam_lean"]["decide_horizon_min"]
        state.update(state="done", summary=None if op is None else {
            "photos": op["fotos"], "horizon_min": h, "spearman": None, "spearman_ci": [None, None], "extremes_net_bp": None,
            "extremes_ci": [None, None], "vs_random_pct": None,
            "signals": {"extremes": None, "random": None, "spearman": None}, "note": FORMULA_NOTE, "formula": op})
    except Exception as error:  # noqa: BLE001 - whatever went wrong must reach the screen
        state.update(state="failed", error=str(error))
    state["finished_ms"] = int(time.time() * 1000)
    _write_state(state_path, state)
    return state


def operation_lines(rows, cfg):
    """The operation section of the report (version 8 only)."""
    op = analyse_operation(rows, cfg)
    if op is None:
        return []
    q = op["qwen"]
    lines = ["## Por operación (como opera la versión 8)", "",
             "Cada entrada de Qwen (LARGO o CORTO con seguridad suficiente y confirmada por el espejo, como exige el operador "
             "en vivo) se cierra {}. Neto en puntos básicos después de costos. La salida es la regla fija, no lo que Qwen "
             "habría contestado con la posición abierta.".format(op["salida"]), ""]
    if not q["n"]:
        lines += ["Qwen no hizo ninguna entrada en las {} fotos (esperar {}, bloqueadas por el espejo {}).".format(
            op["fotos"], op["espera"], op["espejo_bloqueo"]), ""]
    else:
        lines.extend([
            "- **Qwen entró en {} de {} fotos**: {} por operación en promedio (rango del 95 % por día {} a {}), {} de "
            "las operaciones ganadoras, {} en total.".format(
                q["n"], op["fotos"], _bp(q["neto_bp"]), _bp(q["ic"][0]), _bp(q["ic"][1]), _pct(q["ganadoras"]),
                _bp(q["total_bp"])),
            "- Salidas: {} porque el maestro se dio vuelta, {} por tiempo; {} h abiertas en promedio.".format(
                q["por_vuelta"], q["por_tiempo"], "n/d" if q["horas"] is None else qt.es(q["horas"], 1)),
            "- Entró del lado del maestro en el {} de sus entradas y con el portero a favor en el {}. Mejor que el {} de "
            "los sorteos con el lado al azar.".format(_pct(q["con_maestro"]), _pct(q["con_portero"]),
                                                      "n/d" if q["vs_azar_pct"] is None else
                                                      qt.es(q["vs_azar_pct"], 0) + " %"),
        ])
    lines += ["", "| Qué | Operaciones | Neto por operación | Ganadoras | Por vuelta / por tiempo |", "|---|---|---|---|---|"]
    for label, key in (("Qwen (entradas que haría en vivo)", "qwen"), ("Qwen (todo lo que dijo LARGO o CORTO)", "qwen_todas"),
                       ("La fórmula sola: maestro fuerte con portero a favor", "formula"),
                       ("Maestro fuerte, sin portero", "maestro_fuerte"),
                       ("Siempre largo en las fotos donde Qwen entró", "siempre_largo"),
                       ("Siempre corto en las fotos donde Qwen entró", "siempre_corto")):
        b = op[key]
        lines.append("| {} | {} | {} | {} | {} / {} |".format(label, b["n"], _bp(b["neto_bp"]), _pct(b["ganadoras"]),
                                                              b["por_vuelta"], b["por_tiempo"]))
    lines.append("")
    return lines


# --------------------------------------------------------------------------- the text


def _bp(value, places=1, sign=True):
    return "n/d" if value is None else "{} pb".format(qt.es(value, places, sign))


def _pct(value):
    return "n/d" if value is None else "{} %".format(qt.es(value * 100, 0))


def _h(minutes):
    return "{} h".format(minutes // 60)


BANDS = ((0.0, 0.2), (0.2, 0.35), (0.35, 0.5), (0.5, 1.01))


def lean_bands(rows, key):
    """``([photos per band of p], max p, photos with a stored p)`` of ``key`` (``p_largo`` / ``p_corto``)."""
    values = [r[key] for r in rows if r.get(key) is not None]
    return [sum(1 for v in values if lo <= v < hi) for lo, hi in BANDS], max(values, default=None), len(values)


ICONS = {PASS: "✅ PASA", FAIL: "❌ NO PASA", INCONCLUSIVE: "⚠️ INCONCLUSO"}


# --------------------------------------------------------------------------- the lean exam


def sign(value):
    return (value > 0) - (value < 0)


def _ranks(values):
    order = sorted(range(len(values)), key=values.__getitem__)
    out, i = [0.0] * len(values), 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(xs, ys):
    """Rank correlation (ties share the mean rank); ``None`` when it is not defined."""
    if len(xs) < 3:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = mean(rx), mean(ry)
    sxx, syy = math.fsum((a - mx) ** 2 for a in rx), math.fsum((b - my) ** 2 for b in ry)
    if sxx == 0 or syy == 0:
        return None
    return math.fsum((a - mx) * (b - my) for a, b in zip(rx, ry)) / math.sqrt(sxx * syy)


_SPAN_FMT = "{} a {}"
_HORIZON_JOIN = " y a las "
_ROW3_FMT = "| {} | {} | {} |"


def day_bootstrap_stat(rows, stat, draws, seed):
    """95 % interval of ``stat(rows)`` resampling whole days."""
    days = {}
    for row in rows:
        days.setdefault(row["t_ms"] // DAY_MS, []).append(row)
    groups = list(days.values())
    if not groups:
        return None, None
    rng = random.Random(seed)  # NOSONAR - deterministic bootstrap seed
    values = []
    for _ in range(draws):
        value = stat([r for g in (rng.choice(groups) for _ in groups) for r in g])  # NOSONAR
        if value is not None:
            values.append(value)
    values.sort()
    if not values:
        return None, None
    return values[int(0.025 * len(values))], values[min(len(values) - 1, int(0.975 * len(values)))]


def lean_block(rows, key, h, cfg):
    """What the lean ``key`` (``lean_num`` or ``lean``) says about the move over ``h`` minutes, after costs."""
    rules = cfg["exam_rules"]
    lr, draws, seed = cfg["exam_lean"], rules["random_draws"], cfg["exam"]["seed"]
    move = lambda r: r["moves"][str(h)]
    out = {"n": len(rows), "spearman": spearman([r[key] for r in rows], [move(r) for r in rows])}
    out["sp_ci"] = day_bootstrap_stat(rows, lambda p: spearman([r[key] for r in p], [move(r) for r in p]), draws, seed)
    pool = [r for r in rows if r[key] != 0]                          # a lean of exactly 0 leans nowhere: not an extreme
    k = max(1, int(len(pool) * lr["extreme_share"]))
    ordered = sorted(pool, key=lambda r: r[key])
    bottom, top = ordered[:k], ordered[-k:]
    top_ids = {r["snap_id"] for r in top}
    side = lambda r: 1 if r["snap_id"] in top_ids else -1           # long on the top fifth, short on the bottom fifth
    extremes = bottom + top
    out["top_move"], out["bottom_move"] = mean([move(r) for r in top]), mean([move(r) for r in bottom])
    out["ext_net"] = mean([net(r, side(r), h) for r in extremes])
    out["ext_ci"] = day_bootstrap_stat(extremes, lambda p: mean([net(r, side(r), h) for r in p]), draws, seed)
    out["ext_pct"] = random_percentile(extremes, h, draws, seed, out["ext_net"], side)
    strong = [r for r in rows if abs(r[key]) >= lr["sign_min_abs"] and move(r) != 0]
    out["hit"], out["hit_n"] = mean([1.0 if sign(r[key]) == sign(move(r)) else 0.0 for r in strong]), len(strong)
    traded = [r for r in rows if r[key] != 0]
    sg = lambda r: sign(r[key])
    out["all_net"] = mean([net(r, sg(r), h) for r in traded])
    out["all_ci"] = day_bootstrap_stat(traded, lambda p: mean([net(r, sg(r), h) for r in p]), draws, seed)
    out["all_pct"] = random_percentile(traded, h, draws, seed, out["all_net"], sg) if traded else None
    out["always_long"], out["always_short"] = mean([net(r, 1, h) for r in traded]), mean([net(r, -1, h) for r in traded])
    return out


def _lean_verdict(checks):
    if not checks[0]["ok"]:
        return INCONCLUSIVE
    return PASS if all(c["ok"] for c in checks) else FAIL


def analyse_lean(rows, cfg):
    """The main verdict: does the lean that comes from the numbers anticipate the move? Decided on one horizon only."""
    exam, lr = cfg["exam"], cfg["exam_lean"]
    mirrored = [r for r in rows if r.get("lean_num") is not None]
    out = {"n": len(mirrored), "horizons": {}}
    if not mirrored:
        out.update(verdict=INCONCLUSIVE, checks=[], habit=None)
        return out
    for h in exam["horizons_min"]:
        out["horizons"][h] = {key: lean_block(mirrored, key, h, cfg) for key in ("lean_num", "lean")}
    habit = [r["habit"] for r in mirrored]
    ordered = sorted(habit)
    both = [r for r in mirrored if r["lean"] != 0 and r["lean_m"] != 0]
    out["habit"] = {"mean": mean(habit), "median": ordered[len(ordered) // 2],
                    "coherent": mean([1.0 if sign(r["lean_m"]) == -sign(r["lean"]) else 0.0 for r in both]), "n": len(both)}
    d = out["horizons"][lr["decide_horizon_min"]]["lean_num"]
    pct = cfg["exam_lean"]["min_percentile_vs_random"]
    out["checks"] = [
        {"id": "photos", "ok": len(mirrored) >= lr["min_photos"], "value": len(mirrored)},
        {"id": "extremes", "ok": d["ext_ci"][0] is not None and d["ext_ci"][0] > 0, "value": (d["ext_net"], d["ext_ci"])},
        {"id": "random", "ok": d["ext_pct"] is not None and d["ext_pct"] >= pct, "value": d["ext_pct"]},
        {"id": "spearman", "ok": d["sp_ci"][0] is not None and d["sp_ci"][0] > 0, "value": (d["spearman"], d["sp_ci"])}]
    out["verdict"] = _lean_verdict(out["checks"])
    return out


def _ci(pair):
    return _SPAN_FMT.format(_bp(pair[0]), _bp(pair[1]))


def _rho(value):
    return "n/d" if value is None else qt.es(value, 2, True)


def _rho_ci(pair):
    return "n/d" if pair[0] is None else _SPAN_FMT.format(qt.es(pair[0], 2, True), qt.es(pair[1], 2, True))


def _pctile(value):
    return "n/d" if value is None else "{} %".format(qt.es(value, 0))


def _habit_lean_label(mean_habit):
    if mean_habit > 0.005:
        return "tiende a largo"
    return "tiende a corto" if mean_habit < -0.005 else "no tiende a ningún lado"


def _lean_horizon_rows(h, a, lr):
    out = ["", "## Resultados a {}".format(_h(h)), "", "Puntos básicos (1 pb = 0,01 %), después de costos.", "",
           "| Medida | Solo lo que viene de los números | Cruda (sin espejo) |", "|---|---|---|"]
    n, c = a["horizons"][h]["lean_num"], a["horizons"][h]["lean"]
    for label, fn in (
            ("Correlación con el movimiento", lambda x: _rho(x["spearman"])),
            ("Rango de confianza del 95 % (por día)", lambda x: _rho_ci(x["sp_ci"])),
            ("Movimiento del quinto más inclinado a largo", lambda x: _bp(x["top_move"])),
            ("Movimiento del quinto más inclinado a corto", lambda x: _bp(x["bottom_move"])),
            ("Neto operando esos extremos", lambda x: _bp(x["ext_net"])),
            ("Rango de confianza del 95 %", lambda x: _ci(x["ext_ci"])),
            ("Mejor que el % de sorteos al azar", lambda x: _pctile(x["ext_pct"])),
            ("Acierto de signo (inclinación ≥ {})".format(qt.es(lr["sign_min_abs"], 2)),
             lambda x: "{} ({} fotos)".format(_pct(x["hit"]), x["hit_n"])),
            ("Neto operando el lado de la inclinación en todas las fotos con inclinación distinta de cero", lambda x: _bp(x["all_net"])),
            ("Rango de confianza del 95 %", lambda x: _ci(x["all_ci"])),
            ("Mejor que el % de sorteos al azar", lambda x: _pctile(x["all_pct"])),
            ("Siempre largo en esas mismas fotos", lambda x: _bp(x["always_long"])),
            ("Siempre corto en esas mismas fotos", lambda x: _bp(x["always_short"]))):
        out.append(_ROW3_FMT.format(label, fn(n), fn(c)))
    return out


def lean_lines(rows, cfg):
    a = analyse_lean(rows, cfg)
    lr, horizons = cfg["exam_lean"], cfg["exam"]["horizons_min"]
    h0 = lr["decide_horizon_min"]
    meaning = {
        PASS: "Las fotos hacia las que Qwen más se inclina, mirando solo lo que viene de los números, ganaron después de "
              "costos y le ganaron al azar. Vale la pena seguir con Qwen operador.",
        FAIL: "La inclinación de Qwen no anticipa el movimiento del precio lo suficiente. Con estos datos y este modelo no "
              "se justifica seguir afinándolo como operador.",
        INCONCLUSIVE: "Hay menos de {} fotos con la respuesta del espejo, no alcanza para decidir. Hace falta contestar "
                      "más fotos.".format(lr["min_photos"])}
    lines = ["## {}".format(ICONS[a["verdict"]]), "", meaning[a["verdict"]], "", "## En pocas palabras", ""]
    if not a["horizons"]:
        return lines + ["- Todavía no hay fotos con la respuesta del espejo. Corré `exam` para completarlas.", ""], a
    d = a["horizons"][h0]["lean_num"]
    lines.extend([
        "- Se usaron **{}** fotos del pasado con la respuesta real y la del espejo. En cada una, la **inclinación** es "
        "cuánto más probable le pareció largo que corto.".format(a["n"]),
        "- A {} la inclinación que viene de los números se parece al movimiento del precio con una correlación de "
        "**{}** (rango {}). Cero es «no se parecen»; mucho más de cero sería señal.".format(
            _h(h0), _rho(d["spearman"]), _rho_ci(d["sp_ci"])),
        "- En el quinto de fotos más inclinado a largo el precio se movió {} y en el más inclinado a corto {}. "
        "Operar a favor de la inclinación en esos extremos rindió **{}** por operación después de costos "
        "(rango {}).".format(_bp(d["top_move"]), _bp(d["bottom_move"]), _bp(d["ext_net"]), _ci(d["ext_ci"])),
    ])
    if a["habit"]:
        mean_habit = a["habit"]["mean"]
        lean_to = _habit_lean_label(mean_habit)
        lines.append("- El **hábito** promedio fue {} ({} aunque cambien los números). El espejo cambió de lado en el {} de "
                     "las fotos.".format(_rho(mean_habit), lean_to, _pct(a["habit"]["coherent"])))
    lines += ["", "## Qué revisamos", "",
              "Cada foto es un momento en que el operador habría preguntado de verdad, tomado de velas guardadas anteriores "
              "al corte de prueba final (el holdout, que no se toca). A Qwen se le preguntó con los números reales y otra vez "
              "con los signos dados vuelta (el espejo). De sus probabilidades sale la inclinación (largo menos corto). Lo que "
              "cambia de signo en el espejo viene de los números; lo que no cambia es su hábito. Después se miró si esa "
              "inclinación anticipa lo que hizo el precio a las {}, sin esperar a que Qwen «decida entrar», y se descontó el "
              "costo de entrar y salir.".format(_HORIZON_JOIN.join(_h(x) for x in horizons)), "",
              "### Reglas fijadas de antemano (deciden a las {})".format(_h(h0)), ""]
    texts = {
        "photos": "**Fotos suficientes**: {} de las {} mínimas con la respuesta del espejo.",
        "extremes": "**Los extremos ganan después de costos**: operar a favor de la inclinación en el quinto más inclinado "
                    "de cada lado rinde más que cero, con todo el rango de confianza del 95 % por encima de cero.",
        "random": "**Mejor que el azar**: esos extremos superan al {} % de los sorteos que dan vuelta al azar los lados de "
                  "cada día entero.",
        "spearman": "**La inclinación acompaña al precio**: la correlación es mayor que cero con todo el rango de confianza "
                    "por encima de cero."}
    for c in a["checks"]:
        text = texts[c["id"]].format(c["value"], lr["min_photos"]) if c["id"] == "photos" else \
            texts[c["id"]].format(qt.es(lr["min_percentile_vs_random"], 0))
        lines.append("- {} {}".format("✅" if c["ok"] else "❌", text))
    lines.append("- A {} se informa, pero no decide.".format(_HORIZON_JOIN.join(_h(x) for x in horizons if x != h0)))
    for h in horizons:
        lines.extend(_lean_horizon_rows(h, a, lr))
    if a["habit"]:
        hb = a["habit"]
        lines += ["", "Hábito (lo que no cambia con el espejo): promedio {}, mediana {}. En el {} de las fotos ({} con ambas "
                  "respuestas) el espejo invirtió el lado.".format(_rho(hb["mean"]), _rho(hb["median"]), _pct(hb["coherent"]),
                                                                    hb["n"])]
    lines.append("")
    ficha = fq.ficha_summary(rows, horizons)
    if ficha:
        lines += fq.ficha_lines(ficha)
    return lines, a


def entries_lines(rows, cfg):
    """First version of the exam (the entries Qwen would have made), as a section of the report."""
    r, rules, horizons = analyse(rows, {}, cfg), cfg["exam_rules"], cfg["exam"]["horizons_min"]
    g, total = r["groups"], r["n"]
    short = ICONS
    meaning = {
        PASS: "Qwen acertó más que el azar después de costos con las entradas que dejó pasar el espejo. Puede pasar a "
              "operar en bloques.",
        FAIL: "Con las entradas que dejó pasar el espejo, Qwen no acierta más que el azar después de costos. No pasa a "
              "operar en bloques: si no acierta acá, no va a acertar operando.",
        INCONCLUSIVE: "Pasaron muy pocas entradas el espejo (menos de {}) para decidir. Si no hubo ninguna, no se midió "
                      "nada: no es que haya fallado, es que falta evidencia.".format(rules["min_operations"])}
    lines = ["## Por entradas (primera versión del examen)", "",
             "**Veredicto por entradas: {}.** {}".format(short[r["verdict"]], meaning[r["verdict"]]), ""]
    first = r["horizons"][horizons[0]]
    last = r["horizons"][horizons[-1]]
    lines.extend([
        "- Se le mostraron **{}** fotos del mercado del pasado (sin posición abierta) y se comparó cada respuesta con lo "
        "que pasó el precio después.".format(total),
        "- Dijo LARGO o CORTO con seguridad suficiente en {} fotos; **el espejo dejó pasar {}** y bloqueó {}. "
        "Esa diferencia mide cuánto de lo que decía venía de los números y cuánto de un hábito.".format(
            g["pasa"] + g["espejo"], g["pasa"], g["espejo"]),
        "- Las entradas que pasaron el espejo ganaron en promedio **{}** a {} y **{}** a {} después de costos "
        "(siempre largo en esas mismas fotos: {} y {}).".format(
            _bp(first["pasa"]["mean"]), _h(horizons[0]), _bp(last["pasa"]["mean"]), _h(horizons[-1]),
            _bp(first["always_long"]), _bp(last["always_long"])),
    ])
    if not g["pasa"] + g["espejo"] + g["umbral"]:
        lines.append("- Qwen dijo ESPERAR en todas las fotos, así que no hubo ninguna entrada que medir. Mirá más abajo qué tan "
                     "cerca estuvo de entrar.")
    lines += ["", "### Qué se miró por entradas", "",
              "Cada foto es un momento en que el operador habría preguntado de verdad (cada hora cerrada, movimiento fuerte o "
              "funding raro), tomado de velas guardadas anteriores al corte de prueba final (el holdout, que no se toca). "
              "Se le preguntó a Qwen con los números reales y, si dijo LARGO o CORTO, otra vez con los signos dados vuelta. "
              "Solo cuenta como entrada si dijo una cosa con los números reales y la contraria con el espejo. Después se miró "
              "qué hizo el precio a las {} y se descontó el costo de entrar y salir.".format(
                  _HORIZON_JOIN.join(_h(h) for h in horizons)), "", "#### Reglas por entradas, fijadas de antemano", ""]
    names = {"positive": "**Gana después de costos**: todo el rango de confianza del 95 % por encima de cero",
             "random": "**Mejor que el azar**: supera al {} % de los sorteos con el lado al azar en las mismas fotos".format(
                 qt.es(rules["min_percentile_vs_random"], 0)),
             "always_long": "**Mejor que «siempre largo»** en las mismas fotos"}
    for c in r["checks"]:
        mark = "✅" if c["ok"] else "❌"
        if c["id"] == "n_operations":
            lines.append("- {} **Entradas suficientes**: {} de las {} mínimas.".format(mark, c["value"], rules["min_operations"]))
        else:
            lines.append("- {} {} (a {}).".format(mark, names[c["id"]], _h(c["h"])))
    lines += ["", "### Resultados por entradas", "", "Resultado neto promedio por entrada, en puntos básicos (1 pb = 0,01 %), después de costos.",
              "", "| Qué | Fotos | " + " | ".join("Neto a {} | Acierto a {}".format(_h(h), _h(h)) for h in horizons) + " |",
              "|---|---|" + "---|---|" * len(horizons)]

    def row(label, key, count):
        cells = []
        for h in horizons:
            i = r["horizons"][h][key]
            cells += [_bp(i["mean"]), _pct(i["hit"])]
        return _ROW3_FMT.format(label, count, " | ".join(cells))

    lines.extend([
        row("Entradas que pasaron el espejo", "pasa", g["pasa"]),
        row("Entradas bloqueadas por el espejo", "espejo", g["espejo"]),
        row("Dijo LARGO (todas)", "LARGO", r["horizons"][horizons[0]]["LARGO"]["n"]),
        row("Dijo CORTO (todas)", "CORTO", r["horizons"][horizons[0]]["CORTO"]["n"]),
        _ROW3_FMT.format(
            "Dijo ESPERAR (acierto = ningún lado ganaba)",
            r["horizons"][horizons[0]]["ESPERAR"]["n"],
            " | ".join("n/d | " + _pct(r["horizons"][h]["ESPERAR"]["hit"]) for h in horizons),
        ),
    ])
    lines += ["", "#### Qué tan cerca estuvo de entrar", "",
              "Probabilidad que Qwen le dio a cada lado en cada foto (promedio de las dos órdenes de opciones). Para entrar "
              "hace falta {} o más y ser la opción más probable.".format(qt.es(r["threshold"], 2)), "",
              "| Lado | Menos de 0,20 | 0,20 a 0,35 | 0,35 a 0,50 | 0,50 o más | Máximo |", "|---|---|---|---|---|---|"]
    for label, key in (("LARGO", "p_largo"), ("CORTO", "p_corto")):
        counts, top, _ = lean_bands(rows, key)
        lines.append(_ROW3_FMT.format(label, " | ".join(str(c) for c in counts), "n/d" if top is None else qt.es(top, 2)))
    lines += ["", "| Comparación (entradas que pasaron el espejo) | " + " | ".join("A {}".format(_h(h)) for h in horizons) + " |",
              "|---|" + "---|" * len(horizons)]
    lines.extend([
        "| Rango de confianza del 95 % (por día) | " + " | ".join(
            _SPAN_FMT.format(_bp(r["horizons"][h]["ci"][0]), _bp(r["horizons"][h]["ci"][1])) for h in horizons) + " |",
        "| Mejor que el % de sorteos al azar | " + " | ".join(
            "n/d" if r["horizons"][h]["percentile"] is None else qt.es(r["horizons"][h]["percentile"], 0) + " %"
            for h in horizons) + " |",
        "| Siempre largo en esas fotos | " + " | ".join(_bp(r["horizons"][h]["always_long"]) for h in horizons) + " |",
        "| Siempre corto en esas fotos | " + " | ".join(_bp(r["horizons"][h]["always_short"]) for h in horizons) + " |",
    ])
    lines += ["", "Fotos por resultado de la pregunta: pasó el espejo {}, bloqueada por el espejo {}, bajo el umbral {}, esperar {}, "
              "sin respuesta {}.".format(g["pasa"], g["espejo"], g["umbral"], g["espera"], g["sin_respuesta"]), ""]
    return lines


def build_exam_report(db_path, cfg):
    rows, meta = load_answers(db_path)
    if not rows:
        return "# Qwen operador v3: examen con fotos del pasado\n\nTodavía no hay fotos contestadas (ejecutá `exam`).\n"
    rules, horizons = cfg["exam_rules"], cfg["exam"]["horizons_min"]
    lean, _ = lean_lines(rows, cfg)
    lines = ["# Qwen operador v3: examen con fotos del pasado", ""] + lean + operation_lines(rows, cfg) + entries_lines(rows, cfg)
    lines += ["## Glosario", "",
              "- **Foto**: un momento del pasado con el estado del mercado tal como lo vería el operador.",
              "- **Espejo**: la misma foto con los signos dados vuelta (lo que subió, bajó; máximos y mínimos cambiados; funding "
              "con signo opuesto).",
              "- **Inclinación**: probabilidad de largo menos probabilidad de corto. Positiva: se inclina a largo.",
              "- **Hábito**: la parte de la inclinación que no cambia con el espejo, es decir, lo que Qwen diría aunque los "
              "números estuvieran al revés. Lo que sí cambia viene de los números.",
              "- **Correlación (Spearman)**: de -1 a 1; mide si las fotos con más inclinación a largo son también las que "
              "más subieron. Cero: no se parecen.",
              "- **Quinto más inclinado**: el 20 % de las fotos con la inclinación más alta (o más baja).",
              "- **pb (punto básico)**: 0,01 %. El costo de entrar y salir es de unos 10 pb.",
              "- **Holdout**: tramo final de datos que se guarda sin tocar para una prueba final.", "",
              "## Detalle técnico", "",
              "- Base: `{}`; configuración `{}` (hash {}...); modelo(s): {}.".format(
                  "exam-live.sqlite" if cfg.get("version") == "live" else "exam-v3.sqlite",
                  "config/qwen-live.json" if cfg.get("version") == "live" else "config/qwen-trader-v3.json",
                  str(meta.get("config_hash"))[:12], ", ".join(meta.get("served_models", [])) or "n/d"),
              "- Período de las fotos: {} a {}; horizontes {} min; umbral de entrada {}; semilla {}.".format(
                  qt.stamp(min(x["t_ms"] for x in rows)), qt.stamp(max(x["t_ms"] for x in rows)),
                  horizons, qt.es(cfg["practice_entry_threshold"], 2), cfg["exam"]["seed"]),
              "- Neto = lado × movimiento − costo de ida y vuelta del producto. No incluye funding (pocos pb en 24 h).",
              "- Las fotos del mismo día se solapan: los intervalos se calculan remuestreando días completos ({} sorteos). "
              "El azar conserva los lados y los da vuelta o no, un sorteo por día ({} sorteos).".format(
                  rules["random_draws"], rules["random_draws"]),
              "- Veredicto principal: PASA si se cumplen todas las reglas de inclinación; INCONCLUSO si hay menos de {} fotos "
              "con espejo; NO PASA en otro caso. El de entradas: PASA si se cumplen todas; INCONCLUSO si no hubo entradas o "
              "solo faltan entradas; NO PASA en otro caso.".format(cfg["exam_lean"]["min_photos"]), ""]
    return "\n".join(lines)
