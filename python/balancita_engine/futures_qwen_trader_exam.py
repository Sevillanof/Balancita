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
import random
import time

from . import futures_qwen_trader as qt
from .futures_costs import round_trip_cost_bps

DAY_MS, MINUTE_MS, BAR_MS = qt.DAY_MS, qt.MINUTE_MS, qt.BAR_MS
PASS, FAIL, INCONCLUSIVE = "PASA", "NO PASA", "INCONCLUSO"

_EXAM_SQL = """
CREATE TABLE IF NOT EXISTS exam_snapshots(
  snap_id TEXT PRIMARY KEY, product TEXT NOT NULL, t_ms INTEGER NOT NULL, ord INTEGER NOT NULL, wake_json TEXT,
  state_text TEXT NOT NULL, mirror_text TEXT NOT NULL, moves_json TEXT NOT NULL, cost_bp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS exam_answers(
  snap_id TEXT PRIMARY KEY, real_action TEXT, real_p REAL, mirror_action TEXT, mirror_p REAL, answered_ms INTEGER);
"""


# --------------------------------------------------------------------------- the photos


def make_photos(history, cfg, product, holdout_ms):
    """Every moment the trader would have asked Qwen while flat, with its STATE, the mirrored STATE and the price moves (bp)
    over each horizon. Only candles before the holdout are read, and a moment whose horizon would reach it is dropped."""
    practice, exam = cfg["practice"], cfg["exam"]
    start = qt.date_ms(practice["from"])
    horizons = [m * MINUTE_MS for m in exam["horizons_min"]]
    bars = history.bars(product, start - practice["warmup_days"] * DAY_MS, holdout_ms)
    if len(bars) < (holdout_ms - (start - practice["warmup_days"] * DAY_MS)) // BAR_MS * 0.98:
        raise qt.TraderError("{}: faltan velas para el examen; ejecutá `prefetch`".format(product))
    trader = qt.Trader(cfg, product, None, history.funding(product), key="exam", entry_threshold=cfg["practice_entry_threshold"])
    closes, found = {}, []
    for bar in bars:
        trader.feed(bar, trade=False)
        t_ms = int(bar["bucket_start"]) + BAR_MS
        closes[t_ms] = float(bar["close"])
        if t_ms < start or len(trader.c) < qt.MIN_BARS:
            continue
        reasons = trader.wake_reasons(t_ms)
        if reasons:
            trader.last_call_ms = t_ms               # the same spacing of extra wakes as the live trader
            found.append((t_ms, reasons, trader.state_text(t_ms, reasons), trader.state_text(t_ms, reasons, mirror=True)))
    cost = float(round_trip_cost_bps(product))
    out = []
    for t_ms, reasons, state, mirror in found:
        later = [closes.get(t_ms + h) for h in horizons]
        if None in later:
            continue
        out.append({"product": product, "t_ms": t_ms, "wake": reasons, "state_text": state, "mirror_text": mirror,
                    "moves": {str(m): (price / closes[t_ms] - 1) * 1e4 for m, price in zip(exam["horizons_min"], later)},
                    "cost_bp": cost})
    return out


def choose_photos(photos, cfg, holdout_ms):
    """Seeded sample, stratified by product and time bin, ordered so that any prefix is balanced."""
    exam, products = cfg["exam"], cfg["exam"]["products"]
    start = qt.date_ms(cfg["practice"]["from"])
    span = holdout_ms - start
    strata = {}
    for photo in photos:
        time_bin = min(exam["time_bins"] - 1, (photo["t_ms"] - start) * exam["time_bins"] // span)
        strata.setdefault((photo["product"], time_bin), []).append(photo)
    per_stratum = exam["snapshots"] // (len(products) * exam["time_bins"])
    ranked = []
    for (product, time_bin), items in sorted(strata.items()):
        rng = random.Random("{}:{}:{}".format(exam["seed"], product, time_bin))
        for rank, photo in enumerate(rng.sample(items, min(per_stratum, len(items)))):
            ranked.append((rank, rng.random(), product, photo))
    ranked.sort(key=lambda row: row[:3])
    return [row[3] for row in ranked]


def snap_id(product, t_ms):
    return "exam:{}:{}".format(product, t_ms)


def exam_identity(cfg, holdout_ms):
    return {"config_hash": qt.config_hash(cfg), "exam": cfg["exam"], "holdout_ms": holdout_ms,
            "practice_entry_threshold": cfg["practice_entry_threshold"]}


def _store_photos(pdb, photos):
    with pdb.db:
        for order, p in enumerate(photos):
            pdb.db.execute("INSERT OR IGNORE INTO exam_snapshots VALUES(?,?,?,?,?,?,?,?,?)", (
                snap_id(p["product"], p["t_ms"]), p["product"], p["t_ms"], order, json.dumps(p["wake"]), p["state_text"],
                p["mirror_text"], json.dumps(p["moves"]), p["cost_bp"]))


# --------------------------------------------------------------------------- asking


def run_exam(history, db_path, provider, cfg, holdout_ms, *, max_minutes=55.0, clock=time.monotonic, log=print):
    """Asks Qwen about the photos not answered yet, inside ``max_minutes``. Returns
    ``{stop_reason, answered, total, calls}``; ``stop_reason``: ``done``, ``budget``, ``model_down``."""
    if not provider.health():
        raise qt.TraderError("llama-server no responde en {}: arrancalo con el modelo local y volvé a lanzar `exam`. Este "
                             "comando no descarga ningún modelo y solo habla con 127.0.0.1.".format(
                                 getattr(provider, "base_url", "el puerto local")))
    pdb = qt.PracticeDB(db_path)
    try:
        pdb.db.executescript(_EXAM_SQL)
        qt.check_identity(pdb, cfg, exam_identity(cfg, holdout_ms))
        if not pdb.db.execute("SELECT 1 FROM exam_snapshots LIMIT 1").fetchone():
            photos = []
            for product in cfg["exam"]["products"]:
                log("examen: armando las fotos de {} (lee velas guardadas, sin modelo)…".format(product))
                photos += make_photos(history, cfg, product, holdout_ms)
            chosen = choose_photos(photos, cfg, holdout_ms)
            _store_photos(pdb, chosen)
            log("examen: {} fotos posibles, {} elegidas al azar repartidas en el tiempo".format(len(photos), len(chosen)))
        total = pdb.db.execute("SELECT COUNT(*) FROM exam_snapshots").fetchone()[0]
        pending = pdb.db.execute("SELECT * FROM exam_snapshots WHERE snap_id NOT IN (SELECT snap_id FROM exam_answers) "
                                 "ORDER BY ord").fetchall()
        identity = provider.identity()
        served_fn = getattr(provider, "served_model", None)
        served = served_fn() if callable(served_fn) else None
        if served and served not in pdb.meta().get("served_models", []):
            pdb.set_meta("served_models", pdb.meta().get("served_models", []) + [served])
        decider = qt.LlmDecider(provider, cfg, store=pdb, clock=clock, deadline=clock() + max_minutes * 60.0,
                                model=served or identity.get("model_ref") or "unknown")
        questions = {}
        started, reason, answered = clock(), "done", total - len(pending)
        log("examen: {} fotos, {} ya contestadas, presupuesto {} min, modelo {}".format(total, answered, max_minutes,
                                                                                         served or identity.get("model_ref")))
        for row in pending:
            question = questions.setdefault(row["product"], qt.questions_for(cfg, row["product"])["flat"])
            real_action = real_p = mirror_action = mirror_p = None
            try:
                real = decider.ask(row["snap_id"], row["t_ms"], "action", question, row["state_text"])
                real_action, real_p = real["chosen"], real["probabilities"][real["chosen"]]
                if real_action in ("LARGO", "CORTO"):
                    mirror = decider.ask(row["snap_id"], row["t_ms"], "mirror", question, row["mirror_text"])
                    mirror_action, mirror_p = mirror["chosen"], mirror["probabilities"][mirror["chosen"]]
            except qt.DecisionError:
                pass                                   # stored as unanswered (None): counted in the report, never retried
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
            answered += 1
            if answered % 50 == 0:
                log("progreso: {} de {} fotos, {} llamadas nuevas, {:.2f} s por llamada, {} transcurridos".format(
                    answered, total, decider.calls, decider.mean_call(), qt._eta(clock() - started)))
        log("examen terminado ({}): {} de {} fotos contestadas, {} llamadas nuevas en {}".format(
            reason, answered, total, decider.calls, qt._eta(clock() - started)))
        return {"stop_reason": reason, "answered": answered, "total": total, "calls": decider.calls}
    finally:
        pdb.close()


# --------------------------------------------------------------------------- the numbers


def load_answers(db_path):
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        sums = {}
        for r in pdb.db.execute("SELECT block_id, probs_json FROM calls WHERE step='action' AND block_id LIKE 'exam:%'"):
            probs = json.loads(r["probs_json"])
            acc = sums.setdefault(r["block_id"], [0.0, 0.0, 0])
            acc[0], acc[1], acc[2] = acc[0] + probs.get("LARGO", 0.0), acc[1] + probs.get("CORTO", 0.0), acc[2] + 1
        leans = {k: (v[0] / v[2], v[1] / v[2]) for k, v in sums.items()}     # mean over the option orders, as _merge does
        rows = pdb.db.execute("SELECT s.*, a.real_action, a.real_p, a.mirror_action, a.mirror_p FROM exam_snapshots s "
                              "JOIN exam_answers a USING(snap_id) ORDER BY s.ord").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["moves"] = json.loads(d.pop("moves_json"))
            d["p_largo"], d["p_corto"] = leans.get(d["snap_id"], (None, None))
            out.append(d)
        return out, pdb.meta()
    finally:
        pdb.close()


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
    rng = random.Random(seed)
    means = []
    for _ in range(draws):
        picked = [v for g in (rng.choice(groups) for _ in groups) for v in g]
        means.append(math.fsum(picked) / len(picked))
    means.sort()
    return means[int(0.025 * draws)], means[min(draws - 1, int(0.975 * draws))]


def random_percentile(rows, horizon, draws, seed, observed):
    """Share (0-100) of random draws that Qwen's mean beat. A draw keeps Qwen's sides but flips ALL of a day's sides or none
    (one coin per day): a model that repeats the same side all day is then compared with luck at the same granularity, not with
    a fresh coin per photo (which would be too easy to beat)."""
    if not rows:
        return None
    rng = random.Random(seed)
    days = sorted({r["t_ms"] // DAY_MS for r in rows})
    below = 0
    for _ in range(draws):
        flip = {d: rng.choice((1, -1)) for d in days}
        if mean([net(r, flip[r["t_ms"] // DAY_MS] * side_of(r), horizon) for r in rows]) < observed:
            below += 1
    return 100.0 * below / draws


def analyse(rows, meta, cfg):
    exam, rules = cfg["exam"], cfg["exam_rules"]
    threshold, horizons = cfg["practice_entry_threshold"], exam["horizons_min"]
    groups = {k: [] for k in ("pasa", "espejo", "umbral", "espera", "sin_respuesta")}
    for row in rows:
        groups[classify(row, threshold)].append(row)
    out = {"n": len(rows), "groups": {k: len(v) for k, v in groups.items()}, "horizons": {}, "threshold": threshold}
    for h in horizons:
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
        out["horizons"][h] = info
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
    # no entry at all: nothing was measured, so nothing failed (INCONCLUSO, not NO PASA)
    inconclusive = not groups["pasa"] or (others_ok and not checks[0]["ok"])
    out["verdict"] = PASS if all(c["ok"] for c in checks) else (INCONCLUSIVE if inconclusive else FAIL)
    return out


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


def build_exam_report(db_path, cfg):
    rows, meta = load_answers(db_path)
    if not rows:
        return "# Qwen operador v3: examen con fotos del pasado\n\nTodavía no hay fotos contestadas (ejecutá `exam`).\n"
    r, rules, horizons = analyse(rows, meta, cfg), cfg["exam_rules"], cfg["exam"]["horizons_min"]
    g, total = r["groups"], r["n"]
    short = {"PASA": "## ✅ PASA", "NO PASA": "## ❌ NO PASA", "INCONCLUSO": "## ⚠️ INCONCLUSO"}
    meaning = {
        PASS: "Qwen acertó más que el azar después de costos con las entradas que dejó pasar el espejo. Puede pasar a "
              "operar en bloques.",
        FAIL: "Con las entradas que dejó pasar el espejo, Qwen no acierta más que el azar después de costos. No pasa a "
              "operar en bloques: si no acierta acá, no va a acertar operando.",
        INCONCLUSIVE: "Pasaron muy pocas entradas el espejo (menos de {}) para decidir. Si no hubo ninguna, no se midió "
                      "nada: no es que haya fallado, es que falta evidencia.".format(rules["min_operations"])}
    lines = ["# Qwen operador v3: examen con fotos del pasado", "", short[r["verdict"]], "", meaning[r["verdict"]], "",
             "## En pocas palabras", ""]
    first = r["horizons"][horizons[0]]
    last = r["horizons"][horizons[-1]]
    lines.append("- Se le mostraron **{}** fotos del mercado del pasado (sin posición abierta) y se comparó cada respuesta con lo "
                 "que pasó el precio después.".format(total))
    lines.append("- Dijo LARGO o CORTO con seguridad suficiente en {} fotos; **el espejo dejó pasar {}** y bloqueó {}. "
                 "Esa diferencia mide cuánto de lo que decía venía de los números y cuánto de un hábito.".format(
                     g["pasa"] + g["espejo"], g["pasa"], g["espejo"]))
    lines.append("- Las entradas que pasaron el espejo ganaron en promedio **{}** a {} y **{}** a {} después de costos "
                 "(siempre largo en esas mismas fotos: {} y {}).".format(
                     _bp(first["pasa"]["mean"]), _h(horizons[0]), _bp(last["pasa"]["mean"]), _h(horizons[-1]),
                     _bp(first["always_long"]), _bp(last["always_long"])))
    if not g["pasa"] + g["espejo"] + g["umbral"]:
        lines.append("- Qwen dijo ESPERAR en todas las fotos, así que no hubo ninguna entrada que medir. Mirá más abajo qué tan "
                     "cerca estuvo de entrar.")
    lines += ["", "## Qué revisamos", "",
              "Cada foto es un momento en que el operador habría preguntado de verdad (cada hora cerrada, movimiento fuerte o "
              "funding raro), tomado de velas guardadas anteriores al corte de prueba final (el holdout, que no se toca). "
              "Se le preguntó a Qwen con los números reales y, si dijo LARGO o CORTO, otra vez con los signos dados vuelta. "
              "Solo cuenta como entrada si dijo una cosa con los números reales y la contraria con el espejo. Después se miró "
              "qué hizo el precio a las {} y se descontó el costo de entrar y salir.".format(
                  " y a las ".join(_h(h) for h in horizons)), "", "### Reglas fijadas de antemano", ""]
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
    lines += ["", "## Resultados", "", "Resultado neto promedio por entrada, en puntos básicos (1 pb = 0,01 %), después de costos.",
              "", "| Qué | Fotos | " + " | ".join("Neto a {} | Acierto a {}".format(_h(h), _h(h)) for h in horizons) + " |",
              "|---|---|" + "---|---|" * len(horizons)]

    def row(label, key, count):
        cells = []
        for h in horizons:
            i = r["horizons"][h][key]
            cells += [_bp(i["mean"]), _pct(i["hit"])]
        return "| {} | {} | {} |".format(label, count, " | ".join(cells))

    lines.append(row("Entradas que pasaron el espejo", "pasa", g["pasa"]))
    lines.append(row("Entradas bloqueadas por el espejo", "espejo", g["espejo"]))
    lines.append(row("Dijo LARGO (todas)", "LARGO", r["horizons"][horizons[0]]["LARGO"]["n"]))
    lines.append(row("Dijo CORTO (todas)", "CORTO", r["horizons"][horizons[0]]["CORTO"]["n"]))
    lines.append("| Dijo ESPERAR (acierto = ningún lado ganaba) | {} | {} |".format(
        r["horizons"][horizons[0]]["ESPERAR"]["n"],
        " | ".join("n/d | " + _pct(r["horizons"][h]["ESPERAR"]["hit"]) for h in horizons)))
    lines += ["", "### Qué tan cerca estuvo de entrar", "",
              "Probabilidad que Qwen le dio a cada lado en cada foto (promedio de las dos órdenes de opciones). Para entrar "
              "hace falta {} o más y ser la opción más probable.".format(qt.es(r["threshold"], 2)), "",
              "| Lado | Menos de 0,20 | 0,20 a 0,35 | 0,35 a 0,50 | 0,50 o más | Máximo |", "|---|---|---|---|---|---|"]
    for label, key in (("LARGO", "p_largo"), ("CORTO", "p_corto")):
        counts, top, known = lean_bands(rows, key)
        lines.append("| {} | {} | {} |".format(label, " | ".join(str(c) for c in counts), "n/d" if top is None else qt.es(top, 2)))
    lines += ["", "| Comparación (entradas que pasaron el espejo) | " + " | ".join("A {}".format(_h(h)) for h in horizons) + " |",
              "|---|" + "---|" * len(horizons)]
    lines.append("| Rango de confianza del 95 % (por día) | " + " | ".join(
        "{} a {}".format(_bp(r["horizons"][h]["ci"][0]), _bp(r["horizons"][h]["ci"][1])) for h in horizons) + " |")
    lines.append("| Mejor que el % de sorteos al azar | " + " | ".join(
        "n/d" if r["horizons"][h]["percentile"] is None else qt.es(r["horizons"][h]["percentile"], 0) + " %"
        for h in horizons) + " |")
    lines.append("| Siempre largo en esas fotos | " + " | ".join(_bp(r["horizons"][h]["always_long"]) for h in horizons) + " |")
    lines.append("| Siempre corto en esas fotos | " + " | ".join(_bp(r["horizons"][h]["always_short"]) for h in horizons) + " |")
    lines += ["", "Fotos por resultado de la pregunta: pasó el espejo {}, bloqueada por el espejo {}, bajo el umbral {}, esperar {}, "
              "sin respuesta {}.".format(g["pasa"], g["espejo"], g["umbral"], g["espera"], g["sin_respuesta"]), "",
              "## Glosario", "",
              "- **Foto**: un momento del pasado con el estado del mercado tal como lo vería el operador.",
              "- **Espejo**: la misma foto con los signos dados vuelta (lo que subió, bajó; máximos y mínimos cambiados; funding "
              "con signo opuesto). Si Qwen dice LARGO en las dos versiones, no está leyendo los números.",
              "- **pb (punto básico)**: 0,01 %. El costo de entrar y salir es de unos 10 pb.",
              "- **Acierto**: la entrada ganó algo después de costos.",
              "- **Holdout**: tramo final de datos que se guarda sin tocar para una prueba final.", "",
              "## Detalle técnico", "",
              "- Base: `exam-v3.sqlite`; configuración `config/qwen-trader-v3.json` (hash {}...); modelo(s): {}.".format(
                  str(meta.get("config_hash"))[:12], ", ".join(meta.get("served_models", [])) or "n/d"),
              "- Período de las fotos: {} a {}; horizontes {} min; umbral de entrada {}; semilla {}.".format(
                  qt.stamp(min(x["t_ms"] for x in rows)), qt.stamp(max(x["t_ms"] for x in rows)),
                  horizons, qt.es(r["threshold"], 2), cfg["exam"]["seed"]),
              "- Neto = lado × movimiento − costo de ida y vuelta del producto. No incluye funding (pocos pb en 24 h).",
              "- Las fotos del mismo día se solapan: el intervalo se calcula remuestreando días completos ({} sorteos). "
              "El azar conserva los lados de Qwen y los da vuelta o no, un sorteo por día ({} sorteos).".format(rules["random_draws"], rules["random_draws"]),
              "- Veredicto: PASA si se cumplen todas las reglas; INCONCLUSO si no hubo ninguna entrada o si solo faltan entradas; NO PASA en otro caso.", ""]
    return "\n".join(lines)
