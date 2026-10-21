"""Tools that ask llama-server again about decisions that are already stored (all loopback, never a candle, never the holdout):

* ``practice --check-determinism N``: replays N stored calls and reports how far the new probabilities are from the stored
  ones (one by one and with the two option orders at the same time).
* ``compare-prompts``: replays stored decisions of one version under another version's prompt layout (v2 against v2.1) on the
  very same state texts, and says how many decisions changed.
* ``probe``: perturbation probes. A seeded, stratified sample of stored decisions is asked again with the exact same prompt but
  ONE number of the state changed at a time (to its 10th or 90th percentile among the stored decisions of the same product and
  kind, so the value is a realistic one). A decision that flips, or a probability that moves, shows that Qwen looks at that
  number. Results go to their own table (``probe_calls``), so the practice's calls and latency statistics are not touched.
"""

import collections
import json
import math
import random
import sqlite3
import statistics
import time
from concurrent.futures import ThreadPoolExecutor

from . import futures_llm_decisions as llm
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_state as st

PROBE_SQL = """
CREATE TABLE IF NOT EXISTS probe_calls(
  block_id TEXT NOT NULL, t_ms INTEGER NOT NULL, step TEXT NOT NULL, variant INTEGER NOT NULL, order_json TEXT NOT NULL,
  probs_json TEXT NOT NULL, chosen TEXT NOT NULL, confidence REAL, source TEXT, latency_ms INTEGER, prompt_hash TEXT,
  prompt_version REAL, state_hash TEXT, model TEXT, asked_at_ms INTEGER, old_value REAL, new_value REAL,
  PRIMARY KEY(block_id, t_ms, step, variant));
"""


# --------------------------------------------------------------------------- reading stored decisions


def _question(cfg, product, kind):
    return qt.questions_for(cfg, product)["flat" if kind == "flat" else "position"]


def _reorder(question, option_ids):
    """The question with its options in the order of ``option_ids`` (the order a stored call used)."""
    by_id = {o["id"]: o for o in question["options"]}
    return dict(question, options=[by_id[i] for i in option_ids])


def stored_decisions(db_path, kinds=("flat", "position")):
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        marks = ",".join("?" for _ in kinds)
        return [dict(r) for r in pdb.db.execute(
            "SELECT block_id, seq, t_ms, kind, product, fold, state_text, model_action, probs_json, p_action, action "
            "FROM decisions WHERE kind IN ({}) AND state_text IS NOT NULL AND model_action IS NOT NULL "
            "ORDER BY block_id, seq".format(marks), kinds)]
    finally:
        pdb.close()


def evenly(items, n):
    """``n`` items spread evenly over an ordered list (all of them when there are fewer)."""
    if n >= len(items):
        return list(items)
    return [items[(2 * i + 1) * len(items) // (2 * n)] for i in range(n)]


def _merged(question, probs_list):
    options = [o["id"] for o in question["options"]]
    return {o: math.fsum(p[o] for p in probs_list) / len(probs_list) for o in options}


def _pick(probs):
    best = max(probs.values())
    tied = [k for k in probs if abs(probs[k] - best) <= 1e-12]
    return next((k for k in qt.SAFE_FIRST if k in tied), tied[0])


# --------------------------------------------------------------------------- determinism of batching


def _ask_text(provider, cfg, template, text, asked):
    answer = llm.ask_model(provider, text, llm.question_letters(asked), asked, float(cfg["prompt"]["temperature"]), template,
                           cfg["prompt"]["probability_source"])
    return answer["result"]["probabilities"]


class Ticker:
    """Throttles a progress line: the first call always reports, then at most one every ``every`` clock seconds
    (``force`` reports regardless). ``log`` must flush."""

    def __init__(self, log, clock=time.monotonic, every=20.0):
        self.log, self.clock, self.every, self.last = log, clock, every, None

    def __call__(self, text, force=False):
        now = self.clock()
        if force or self.last is None or now - self.last >= self.every:
            self.last = now
            self.log(text)


def _say(*args):
    print(*args, flush=True)


def _left(elapsed, done, total):
    return elapsed / done * (total - done) / 60.0 if done else 0.0


def check_determinism(db_path, cfg, provider, n, *, concurrency=2, log=_say, clock=time.monotonic):
    """Replays the option-order calls of ``n`` stored decisions (evenly spread) twice: one call after the other and with the
    orders of a question at the same time. Reports the largest probability difference to the stored call, between the two
    ways of asking, and how many decisions would change their final choice. The stored prompt hash is re-computed too: a
    mismatch means the text sent now is not the text that was stored (wrong version or config)."""
    template = qt.template_of(cfg)
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        decisions = {(r["block_id"], r["t_ms"]): dict(r) for r in pdb.db.execute(
            "SELECT block_id, t_ms, kind, product, state_text FROM decisions WHERE state_text IS NOT NULL")}
        keys = sorted({(r["block_id"], r["t_ms"]) for r in pdb.db.execute("SELECT block_id, t_ms FROM calls WHERE step='action'")})
        picked = [k for k in evenly([k for k in keys if k in decisions], n)]
        stored = {k: pdb.calls(k[0], k[1], "action") for k in picked}
    finally:
        pdb.close()
    out = {"decisions": len(picked), "calls": 0, "hash_mismatch": 0, "max_seq": 0.0, "max_conc": 0.0, "max_seq_vs_conc": 0.0,
           "mean_seq": 0.0, "flips_seq": 0, "flips_conc": 0}
    diffs_seq = []
    tick, t0 = Ticker(log, clock), clock()
    log("determinismo: {} decisiones; preguntando a Qwen… (Ctrl+C para cortar; esto no guarda nada)".format(len(picked)))
    for i, key in enumerate(picked):
        tick("determinismo: {} de {} decisiones, {} llamadas, {:.1f} min, faltan ~{:.1f} min".format(
            i, len(picked), out["calls"], (clock() - t0) / 60.0, _left(clock() - t0, i, len(picked))))
        d, rows = decisions[key], stored[key]
        if len(rows) < 2:
            continue
        question = _question(cfg, d["product"], d["kind"])
        prepared = []
        for variant in sorted(rows):
            asked = _reorder(question, rows[variant]["order"])
            text = qt.build_prompt(d["state_text"], asked, template)
            out["hash_mismatch"] += int(llm.prompt_hash(text, template) != rows[variant]["prompt_hash"])
            prepared.append((variant, asked, text))
        seq = {v: _ask_text(provider, cfg, template, t, a) for v, a, t in prepared}
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures = [(v, pool.submit(_ask_text, provider, cfg, template, t, a)) for v, a, t in prepared]
            conc = {v: f.result() for v, f in futures}
        out["calls"] += 2 * len(prepared)
        for v in seq:
            old = rows[v]["probabilities"]
            for label, new in (("seq", seq[v]), ("conc", conc[v])):
                out["max_" + label] = max(out["max_" + label], max(abs(new[o] - old[o]) for o in old))
            diffs_seq.append(max(abs(seq[v][o] - old[o]) for o in old))
            out["max_seq_vs_conc"] = max(out["max_seq_vs_conc"], max(abs(seq[v][o] - conc[v][o]) for o in old))
        old_pick = _pick(_merged(question, [rows[v]["probabilities"] for v in sorted(rows)]))
        out["flips_seq"] += int(_pick(_merged(question, [seq[v] for v in sorted(seq)])) != old_pick)
        out["flips_conc"] += int(_pick(_merged(question, [conc[v] for v in sorted(conc)])) != old_pick)
    out["mean_seq"] = statistics.fmean(diffs_seq) if diffs_seq else 0.0
    return out


def determinism_text(r):
    return "\n".join([
        "Determinismo de llama-server: {} decisiones guardadas, {} llamadas repetidas.".format(r["decisions"], r["calls"]),
        "- Diferencia máxima de probabilidad contra lo guardado: {:.6f} una por una, {:.6f} con los dos órdenes a la vez.".format(
            r["max_seq"], r["max_conc"]),
        "- Diferencia máxima entre pedirlas una por una y a la vez: {:.6f}.".format(r["max_seq_vs_conc"]),
        "- Diferencia media (una por una contra lo guardado): {:.6f}.".format(r["mean_seq"]),
        "- Decisiones que cambiarían su elección final: {} una por una, {} a la vez.".format(r["flips_seq"], r["flips_conc"]),
        "- Texto distinto del guardado (hash del prompt): {} llamadas{}.".format(
            r["hash_mismatch"], "" if not r["hash_mismatch"] else " (¿versión o configuración equivocada?)")])


# --------------------------------------------------------------------------- prompt A against prompt B


def compare_prompts(old_db, new_cfg, provider, n, *, concurrency=2, log=_say, clock=time.monotonic):
    """Asks ``n`` stored decisions of ``old_db`` again under ``new_cfg``'s prompt (same state text, other layout) and compares.
    Flat and in-position decisions are sampled separately, evenly spread."""
    decisions = stored_decisions(old_db)
    chosen = []
    for kind in ("flat", "position"):
        chosen += evenly([d for d in decisions if d["kind"] == kind], n // 2 + (n % 2 if kind == "flat" else 0))
    decider = qt.LlmDecider(provider, new_cfg, concurrency=concurrency)
    stats = {k: {"n": 0, "same": 0, "dp": [], "old": collections.Counter(), "new": collections.Counter(), "flips": collections.Counter()}
             for k in ("flat", "position")}
    tick, t0 = Ticker(log, clock), clock()
    log("comparar: {} decisiones; preguntando a Qwen… (Ctrl+C para cortar; esto no guarda nada)".format(len(chosen)))
    for i, d in enumerate(chosen):
        tick("comparar: {} de {} decisiones, {} llamadas, {:.1f} min, faltan ~{:.1f} min".format(
            i, len(chosen), decider.calls, (clock() - t0) / 60.0, _left(clock() - t0, i, len(chosen))))
        question = _question(new_cfg, d["product"], d["kind"])
        answer = decider.ask(d["block_id"], d["t_ms"], "action", question, d["state_text"])
        old_probs = json.loads(d["probs_json"])
        s = stats[d["kind"]]
        s["n"] += 1
        s["same"] += int(answer["chosen"] == d["model_action"])
        s["dp"].append(max(abs(answer["probabilities"][o] - old_probs[o]) for o in old_probs))
        s["old"][d["model_action"]] += 1
        s["new"][answer["chosen"]] += 1
        if answer["chosen"] != d["model_action"]:
            s["flips"]["{} → {}".format(d["model_action"], answer["chosen"])] += 1
    return {"stats": stats, "calls": decider.calls, "wall_s": decider.spent}


def compare_lines(result, old_label="v2", new_label="v2.1"):
    lines = ["# {} contra {}: ¿cambió lo que decide Qwen?".format(old_label, new_label), "",
             "Las mismas decisiones guardadas de {} (mismo texto de estado), preguntadas de nuevo con el texto de {} (lo fijo "
             "primero, el estado al final). Si el acuerdo es casi total, el cambio fue solo de orden y rendimiento.".format(old_label, new_label), ""]
    rows = []
    total_n = total_same = 0
    for kind, label in (("flat", "Sin posición"), ("position", "Con posición")):
        s = result["stats"][kind]
        if not s["n"]:
            continue
        total_n += s["n"]
        total_same += s["same"]
        rows.append("| {} | {} | {:.1f} % | {:.4f} | {:.4f} | {} | {} |".format(
            label, s["n"], 100.0 * s["same"] / s["n"], statistics.fmean(s["dp"]), max(s["dp"]),
            ", ".join("{} {}".format(k, v) for k, v in s["old"].most_common()),
            ", ".join("{} {}".format(k, v) for k, v in s["new"].most_common())))
    lines += ["| Momento | Decisiones | Misma elección | Diferencia media de probabilidad | Diferencia máxima | Eligió con {} | Eligió con {} |".format(old_label, new_label),
              "| --- | --- | --- | --- | --- | --- | --- |"] + rows + [""]
    flips = collections.Counter()
    for s in result["stats"].values():
        flips.update(s["flips"])
    if total_n:
        lines += ["Coincidieron en el **{:.1f} %** de las {} decisiones.{}".format(
            100.0 * total_same / total_n, total_n, "" if not flips else " Cambios: " + ", ".join("{} ({})".format(k, v) for k, v in flips.most_common()) + ".")]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- perturbation probes

LEVELS = (("bajo", 0.10), ("alto", 0.90))
RETURN_FIELDS = (("retorno_1h", "ret_1h", "z_1h", "1h"), ("retorno_4h", "ret_4h", "z_4h", "4h"),
                 ("retorno_24h", "ret_24h", "z_24h", "24h"), ("retorno_7d", "ret_7d", "z_7d", "7d"))
# name -> (label, kinds, source field). How each one is rewritten is in ``perturb`` (and documented in odd/tasks).
FEATURES = collections.OrderedDict(
    [(name, (name.replace("_", " ").replace("retorno", "retorno de"), ("flat", "position"), ret)) for name, ret, _, _ in RETURN_FIELDS] +
    [("volatilidad", ("volatilidad diaria (24 h)", ("flat", "position"), "vol24")),
     ("movimiento_15min", ("movimiento de los últimos 15 min", ("flat", "position"), "mov15")),
     ("distancia_maximo_24h", ("distancia al máximo de 24 h", ("flat", "position"), "dist_max24")),
     ("distancia_minimo_24h", ("distancia al mínimo de 24 h", ("flat", "position"), "dist_min24")),
     ("volumen_1h", ("volumen de la última hora", ("flat", "position"), "vol_1h_rel")),
     ("funding", ("funding por hora", ("flat", "position"), "funding_rate")),
     ("resultado_actual", ("resultado si cierra ahora", ("position",), "pnl_pct")),
     ("tiempo_abierto", ("tiempo que lleva abierta", ("position",), "open_min"))])
CONTROL = "control"


def perturb(text, feats, name, value):
    """``text`` with feature ``name`` set to ``value`` and every other character unchanged. A return also rewrites its
    «tendencia» (the return in normal-noise units, from the 15 min normal band shown in the same text); the result of the
    position is written both in % and in USD (100 USD positions, so the same number). ``None`` if the text lacks the number."""
    for fname, ret, z, window in RETURN_FIELDS:
        if name == fname:
            new = st.substitute(text, ret, value)
            if new is None:
                return None
            if feats.get("norm15"):
                sigma5 = feats["norm15"] / math.sqrt(3.0)
                new = st.substitute(new, z, value / (sigma5 * math.sqrt(st.BARS[window]))) or new
            return new
    if name == "resultado_actual":
        new = st.substitute(text, "pnl_pct", value)
        return None if new is None else (st.substitute(new, "pnl_usd", value) or new)
    return st.substitute(text, FEATURES[name][2], value)


def percentiles(decisions):
    """``{(product, kind, field): (p10, p90)}`` over the stored state texts."""
    values = collections.defaultdict(list)
    for d in decisions:
        feats = d.setdefault("_feats", st.extract(d["state_text"]))
        for name, (_, kinds, field) in FEATURES.items():
            if d["kind"] in kinds and field in feats:
                values[(d["product"], d["kind"], field)].append(feats[field])
    out = {}
    for key, vals in values.items():
        vals.sort()
        if len(vals) >= 20:
            out[key] = tuple(vals[min(len(vals) - 1, int(q * (len(vals) - 1) + 0.5))] for _, q in LEVELS)
    return out


def variants_for(d, pct):
    """The prompts to ask for one stored decision: the unchanged one (control: how much a repeated call moves by itself)
    and, for each feature present, the text with the value at the product's 10th and 90th percentile. A level that would be
    printed exactly as it is now is skipped."""
    feats = d.setdefault("_feats", st.extract(d["state_text"]))
    out = [(CONTROL, "repetir", d["state_text"], None, None)]
    for name, (_, kinds, field) in FEATURES.items():
        if d["kind"] not in kinds or field not in feats or (d["product"], d["kind"], field) not in pct:
            continue
        for (level, _), target in zip(LEVELS, pct[(d["product"], d["kind"], field)]):
            if st.displayed(field, target) == st.displayed(field, feats[field]):
                continue
            text = perturb(d["state_text"], feats, name, target)
            if text is not None and text != d["state_text"]:
                out.append((name, level, text, feats[field], target))
    return out


def probe_sample(decisions, n, seed):
    """Seeded sample, stratified by (kind, product, chosen action) and interleaved so that any prefix is balanced (so a run cut
    by the budget, or extended later with a larger ``--sample``, stays balanced)."""
    strata = collections.defaultdict(list)
    for d in decisions:
        strata[(d["kind"], d["product"], d["model_action"])].append(d)
    ranked = []
    for key in sorted(strata):
        items = strata[key]
        rng = random.Random("{}:{}".format(seed, key))
        rng.shuffle(items)
        ranked += [(rank, rng.random(), key, d) for rank, d in enumerate(items)]
    ranked.sort(key=lambda r: (r[0], r[1], r[2]))
    return [r[3] for r in ranked[:n]]


class ProbeStore:
    """The decider's store, on its own table: ``step`` carries ``probe:<feature>:<level>``."""

    def __init__(self, pdb, model_info=None):
        self.pdb = pdb
        self.extra = {}
        pdb.db.executescript(PROBE_SQL)

    def calls(self, key, t_ms, step):
        out = {}
        for r in self.pdb.db.execute("SELECT * FROM probe_calls WHERE block_id=? AND t_ms=? AND step=?", (key, t_ms, step)):
            out[r["variant"]] = {"key": key, "t_ms": t_ms, "step": step, "variant": r["variant"], "order": json.loads(r["order_json"]),
                                 "probabilities": json.loads(r["probs_json"]), "chosen": r["chosen"], "confidence": r["confidence"],
                                 "source": r["source"], "latency_ms": r["latency_ms"], "prompt_hash": r["prompt_hash"]}
        return out

    def put_call(self, row):
        old, new = self.extra.get((row["key"], row["t_ms"], row["step"]), (None, None))
        with self.pdb.db:
            self.pdb.db.execute("INSERT OR REPLACE INTO probe_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                row["key"], row["t_ms"], row["step"], row["variant"], json.dumps(row["order"]), json.dumps(row["probabilities"]),
                row["chosen"], row["confidence"], row["source"], row["latency_ms"], row["prompt_hash"], row["prompt_version"],
                row["state_hash"], row["model"], row["asked_at_ms"], old, new))

    def error(self, *args):
        pass


def estimate(decisions_variants, latency_s, concurrent):
    calls = decisions_variants * 2
    seconds = decisions_variants * latency_s * (1 if concurrent else 2)
    return calls, seconds / 60.0


def run_probe(db_path, cfg, provider, *, sample=200, seed=None, max_minutes=55.0, clock=time.monotonic, log=_say,
              concurrency=None, progress_every_s=20.0):
    """Asks the sampled decisions again with one number changed at a time. Resumable (what is in ``probe_calls`` is not asked
    again) and budgeted. Returns ``{decisions, variants, calls, stop_reason}``."""
    if not provider.health():
        raise qt.TraderError("llama-server no responde: arrancalo con el modelo local y volvé a lanzar `probe`. Solo habla con 127.0.0.1.")
    seed = cfg["practice"]["seed"] if seed is None else seed
    all_decisions = stored_decisions(db_path)
    if not all_decisions:
        raise qt.TraderError("la base no tiene decisiones guardadas: ejecutá `practice` primero")
    pct = percentiles(all_decisions)
    chosen = probe_sample(all_decisions, sample, seed)
    pdb = qt.PracticeDB(db_path)
    try:
        qt.check_identity(pdb, cfg, {"probe_seed": seed})
        store = ProbeStore(pdb)
        started = clock()
        decider = qt.LlmDecider(provider, cfg, store=store, clock=clock, deadline=started + max_minutes * 60.0, model=None,
                                concurrency=concurrency)
        plan = [(d, variants_for(d, pct)) for d in chosen]
        total = sum(len(v) for _, v in plan)
        row = pdb.db.execute("SELECT AVG(latency_ms) FROM calls").fetchone()
        latency = (row[0] or 1100.0) / 1000.0
        calls, minutes = estimate(total, latency, decider.concurrency > 1)
        log("sondas: {} decisiones, {} preguntas ({} llamadas); a {:.2f} s por llamada y {} unas {:.0f} min en total (presupuesto de esta "
            "tanda {} min)".format(len(chosen), total, calls, latency, "con los órdenes a la vez" if decider.concurrency > 1 else "una tras otra",
                                   minutes, max_minutes))
        reason, done, fresh = "done", 0, 0
        tick = Ticker(log, clock, progress_every_s)

        def report(force=False):
            elapsed = clock() - started
            left = elapsed / fresh * (len(chosen) - done) / 60.0 if fresh else minutes
            tick("sondas: {} de {} decisiones, {} llamadas, {:.1f} min, faltan ~{:.1f} min".format(
                done, len(chosen), decider.calls, elapsed / 60.0, left), force)

        decider.progress, decider.progress_every_s = lambda _d: report(True), progress_every_s
        log("preguntando a Qwen… (Ctrl+C para cortar; se retoma donde quedó)")
        for d, variants in plan:
            calls0 = decider.calls
            try:
                for name, level, text, old, new in variants:
                    step = "probe:{}:{}".format(name, level)
                    store.extra[(d["block_id"], d["t_ms"], step)] = (old, new)
                    question = _question(cfg, d["product"], d["kind"])
                    decider.ask(d["block_id"], d["t_ms"], step, question, text)
            except qt.BudgetExhausted:
                reason = "budget"
                break
            except qt.ModelDown:
                reason = "model_down"
                break
            except qt.DecisionError:
                continue
            done += 1
            fresh += int(decider.calls > calls0)
            report()
        log(qt.throughput_line(decider, provider, clock() - started, 0, 0))
        log("sondas terminadas ({}): {} de {} decisiones completas, {} llamadas nuevas".format(reason, done, len(chosen), decider.calls))
        return {"decisions": done, "total": len(chosen), "variants": total, "calls": decider.calls, "stop_reason": reason}
    finally:
        pdb.close()


# --------------------------------------------------------------------------- reading the results


def probe_results(db_path):
    """Per feature: decisions tested, flip share and mean probability shift at each level. ``None`` when there are no probes."""
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        try:
            rows = pdb.db.execute("SELECT block_id, t_ms, step, variant, probs_json, order_json FROM probe_calls "
                                  "ORDER BY block_id, t_ms, step, variant").fetchall()
        except sqlite3.OperationalError:
            return None
        kinds = {(r["block_id"], r["t_ms"]): (r["kind"], json.loads(r["probs_json"]) if r["probs_json"] else None)
                 for r in pdb.db.execute("SELECT block_id, t_ms, kind, probs_json FROM decisions")}
    finally:
        pdb.close()
    if not rows:
        return None
    grouped = collections.defaultdict(list)
    for r in rows:
        grouped[(r["block_id"], r["t_ms"], r["step"])].append(json.loads(r["probs_json"]))
    merged = {}
    for key, plist in grouped.items():
        options = list(plist[0])
        probs = {o: statistics.fmean(p[o] for p in plist) for o in options}
        merged[key] = probs
    by_feature = collections.defaultdict(lambda: collections.defaultdict(list))
    for (block, t_ms, step), probs in merged.items():
        _, name, level = step.split(":", 2)
        # the reference of a perturbed question is the same question asked again unchanged; the reference of that repeat is
        # the answer stored by the practice (so its «flips» are the noise floor of asking twice)
        control = kinds.get((block, t_ms), (None, None))[1] if name == CONTROL else \
            merged.get((block, t_ms, "probe:{}:{}".format(CONTROL, "repetir")))
        if control is None or set(control) != set(probs):
            continue
        base = _pick(control)
        by_feature[name][level].append({"flip": _pick(probs) != base, "shift": abs(probs[base] - control[base]),
                                        "delta": {o: probs[o] - control[o] for o in probs}, "kind": kinds.get((block, t_ms), (None,))[0],
                                        "key": (block, t_ms)})
    out = {}
    for name, levels in by_feature.items():
        entry = {"decisions": len({x["key"] for items in levels.values() for x in items}), "levels": {}}
        for level, items in levels.items():
            deltas = collections.defaultdict(list)
            for x in items:
                for o, v in x["delta"].items():
                    deltas[o].append(v)
            entry["levels"][level] = {"n": len(items), "flip": sum(1 for x in items if x["flip"]) / len(items),
                                      "shift": statistics.fmean(x["shift"] for x in items),
                                      "delta": {o: statistics.fmean(v) for o, v in deltas.items()}}
        out[name] = entry
    return out
