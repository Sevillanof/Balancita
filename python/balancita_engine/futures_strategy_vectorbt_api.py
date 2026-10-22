"""VectorBT explorations over HTTP (inside the registry process S): launch, follow, cancel, confirm a variant, compare.

The lab (``research/vectorbt/explore.py``) needs numpy, pandas and VectorBT, which this stdlib-only engine never imports:
every exploration is a detached child (``futures_strategy_vectorbt_runner``) run with the interpreter of
``.venv-vectorbt`` (``BALANCITA_VECTORBT_PYTHON``). The child downloads the practice datasets that are missing, runs the lab
and reports progress in ``progress.json``. Everything lives in ``<data>/explorations/<id>/``:

* ``job.json``: written by THIS module (request, pid, cancel mark, variant -> strategy links);
* ``spec.json``: the spec explored (the registry may change later; this is what the report is about);
* ``progress.json``: written by the runner; ``report.json`` / ``report.md``: written by the lab (the contract is
  ``docs/vectorbt-exploration-api.md``).

Nothing here writes ``gate.sqlite``; the gate is only READ (is a test running, the stored trades of a finished run).
Everything an exploration says is a HYPOTHESIS: the gate decides.
"""

import datetime
import json
import os
import re
import signal
import statistics
import threading
import time

from .futures_costs import COST_MODEL_VERSION, fee_rate, side_impact_bps, stop_exit_bps
from .futures_strategy_gate_api import GateApiError, ROOT, _alive, popen_detached
from .spec_variation import MAX_VALUES, VariationError, apply_value, describe_variation, normalize_value
from .strategy_gate import GateError, family_of, research_trials

JOB_SCHEMA = "balancita.vectorbt-job.v1"
DEFAULT_DATA_DIR = os.path.join(ROOT, "data", "research-vectorbt")
GATE_CONFIG = os.path.join(ROOT, "config", "strategy-gate.json")
RUNNER = "balancita_engine.futures_strategy_vectorbt_runner"
RULE_KINDS = ("rules", "regime_adapter")
LIST_LIMIT = 30
FUNDING_OK = 0.95          # the gate's min_funding_complete_share
COUNT_TOLERANCE = 0.10     # share of difference in trades from which it is called out
SAME_BP = 0.5              # below this many pb two figures are called equal
SETUP_HELP = ("Falta instalar el entorno de VectorBT: ejecutá «uv venv --python 3.12 .venv-vectorbt» y después "
              "«uv pip install --python .venv-vectorbt/bin/python -r research/vectorbt/requirements.lock».")


def default_python():
    return (os.environ.get("BALANCITA_VECTORBT_PYTHON") or "").strip() or os.path.join(
        ROOT, ".venv-vectorbt", "bin", "python")


def kill_group(pid):
    """SIGTERM to the runner's whole process group (it was started in its own session): the lab goes with it."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def _mean(values):
    values = [v for v in values if v is not None]
    return statistics.fmean(values) if values else None


def _num(value, digits=1):
    return ("{:.%df}" % digits).format(value).replace(".", ",")


def _bp(value):
    value = 0.0 if abs(value) < 0.05 else value
    return _num(value, 0 if abs(value) >= 10 else 1)


def _sbp(value):
    return ("+" if value >= 0.05 else "") + _bp(value)


def _pct(share):
    return "{:.0f} %".format(share * 100)


class VectorbtApi:
    def __init__(self, registry, gate, data_dir=None, python=None, spawn=None, kill=None, alive=None, clock=time.time,
                 gate_config=None, root=None):
        self.registry, self.gate = registry, gate
        self.data_dir = os.path.abspath(data_dir or os.environ.get("BALANCITA_VECTORBT_DIR") or DEFAULT_DATA_DIR)
        self.python = python or default_python()
        self.spawn = spawn or popen_detached
        self.kill = kill or kill_group
        self.alive = alive or _alive
        self.clock = clock
        self.gate_config = gate_config or GATE_CONFIG
        self.root = root or ROOT
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ places

    @property
    def explorations_dir(self):
        return os.path.join(self.data_dir, "explorations")

    @property
    def paths(self):
        return {"explorations": self.explorations_dir, "datasets": os.path.join(self.data_dir, "practice"),
                "cache": os.path.join(self.data_dir, "cache"), "ledger": os.path.join(self.data_dir, "ledger.sqlite")}

    def _folder(self, exploration_id):
        if not isinstance(exploration_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", exploration_id):
            raise GateApiError("not_found", "No existe esa exploración.", 404)
        return os.path.join(self.explorations_dir, exploration_id)

    def _job(self, strategy_id, exploration_id):
        folder = self._folder(exploration_id)
        job = _read_json(os.path.join(folder, "job.json"))
        if job is None or job.get("strategy_id") != strategy_id:
            raise GateApiError("not_found", "No existe esa exploración para esta estrategia.", 404)
        return folder, job

    def _now_ms(self):
        return int(self.clock() * 1000)

    # ------------------------------------------------------------------ environment

    def availability(self):
        """``(available, reason)``: the interpreter of the VectorBT environment exists and has VectorBT installed."""
        python = self.python
        if not (os.path.isfile(python) and os.access(python, os.X_OK)):
            return False, SETUP_HELP
        env_dir = os.path.dirname(os.path.dirname(python))
        if os.path.isfile(os.path.join(env_dir, "pyvenv.cfg")):
            lib = os.path.join(env_dir, "lib")
            found = False
            try:
                for name in os.listdir(lib):
                    if os.path.isdir(os.path.join(lib, name, "site-packages", "vectorbt")):
                        found = True
            except OSError:
                pass
            if not found:
                return False, SETUP_HELP
        return True, None

    # ------------------------------------------------------------------ one exploration's state

    def _report(self, folder):
        return _read_json(os.path.join(folder, "report.json"))

    def _state(self, folder, job):
        """Public view of one exploration, derived from the files (a dead process is noticed here, like the gate does)."""
        progress = _read_json(os.path.join(folder, "progress.json")) or {}
        report = self._report(folder)
        created = job.get("created_at")
        out = {"id": job["exploration_id"], "strategy_id": job["strategy_id"], "mode": job["mode"],
               "vary": job.get("vary"), "values": job.get("values"), "created_at": created, "finished_at": None,
               "eta": None, "report": None, "confirmed": {v: c["strategy_id"] for v, c in
                                                          (job.get("confirmations") or {}).items()}}
        percent = float(progress.get("progress") or 0.0)
        phase, detail = progress.get("phase") or "Preparando", progress.get("detail") or ""
        if report is not None:
            status = "unsupported" if report.get("status") == "unsupported" else "done"
            percent, phase = 100.0, "Listo"
            detail = (report.get("unsupported") or {}).get("reason", "") if status == "unsupported" else (
                "Exploración terminada")
            try:
                out["finished_at"] = int(os.path.getmtime(os.path.join(folder, "report.json")) * 1000)
            except OSError:
                out["finished_at"] = progress.get("updated_at")
            out["report"] = report
        elif job.get("status") == "cancelled":
            status, phase, detail = "cancelled", "Cancelada", "La exploración se canceló."
            out["finished_at"] = job.get("cancelled_at")
        elif job.get("status") == "failed" or progress.get("state") == "failed":
            status, phase = "failed", "Falló"
            detail = progress.get("error") or job.get("error") or detail or "La exploración falló."
            out["finished_at"] = progress.get("updated_at") or job.get("failed_at")
        elif self.alive(job.get("pid")):
            status = "running"
            elapsed = (self._now_ms() - created) / 1000 if created else 0
            if 0 < percent < 100 and elapsed > 5:
                out["eta"] = int(elapsed * (100 - percent) / percent)
        else:
            status, phase = "failed", "Falló"
            detail = "El proceso terminó sin cerrar la exploración."
            out["finished_at"] = progress.get("updated_at")
        out.update(status=status, progress=percent, phase=phase, detail=detail)
        return out

    def _scan(self):
        """``[(folder, job)]`` of every exploration launched through this API, newest first."""
        try:
            names = os.listdir(self.explorations_dir)
        except OSError:
            return []
        found = []
        for name in names:
            job = _read_json(os.path.join(self.explorations_dir, name, "job.json"))
            if job is not None and job.get("schema") == JOB_SCHEMA:
                found.append((os.path.join(self.explorations_dir, name), job))
        found.sort(key=lambda item: (item[1].get("created_at") or 0, item[1]["exploration_id"]), reverse=True)
        return found

    def _running(self):
        for folder, job in self._scan():
            if job.get("status") == "running":
                state = self._state(folder, job)
                if state["status"] == "running":
                    return state
        return None

    def busy_message(self):
        """Spanish reason the gate must not start now, or ``None``: both use the same CPU, one at a time."""
        running = self._running()
        if running is None:
            return None
        return ("Hay una exploración de VectorBT en curso ({}). Esperá a que termine o cancelala.".format(
            running["strategy_id"]))

    # ------------------------------------------------------------------ strategy

    def _spec(self, strategy_id):
        if (not isinstance(strategy_id, str) or self.registry._version_row(strategy_id, None) is None
                or self.registry._deleted(strategy_id)):
            raise GateApiError("not_found", "No existe la estrategia indicada.", 404)
        return self.registry.version(strategy_id)["spec"]

    def _attempts(self, family):
        try:
            return research_trials(family, self.paths["ledger"])
        except GateError:
            return None

    # ------------------------------------------------------------------ GET state

    def status(self, strategy_id):
        self._spec(strategy_id)
        available, reason = self.availability()
        states = [self._state(folder, job) for folder, job in self._scan() if job["strategy_id"] == strategy_id]
        running = next((s for s in states if s["status"] == "running"), None)
        elsewhere = None if running else self._running()
        return {"strategy_id": strategy_id, "available": available, "reason": reason,
                "running": running, "busy_with": None if elsewhere is None else {
                    "exploration_id": elsewhere["id"], "strategy_id": elsewhere["strategy_id"]},
                "explorations": states[:LIST_LIMIT],
                "attempts_in_family": self._attempts(family_of(strategy_id))}

    # ------------------------------------------------------------------ POST launch

    def _validate(self, spec, body):
        if not isinstance(body, dict):
            raise GateApiError("invalid_body", "El pedido debe ser un objeto.")
        extra = set(body) - {"mode", "vary", "values"}
        if extra:
            raise GateApiError("invalid_body", "Campos no admitidos: {}.".format(", ".join(sorted(extra))))
        mode = body.get("mode")
        if mode not in ("diagnostic", "variants"):
            raise GateApiError("invalid_mode", "El modo debe ser «diagnostic» o «variants».")
        if mode == "diagnostic":
            if body.get("vary") is not None or body.get("values") is not None:
                raise GateApiError("invalid_body", "El diagnóstico no lleva qué variar ni valores.")
            return mode, None, None
        vary, values = body.get("vary"), body.get("values")
        if not isinstance(vary, str) or not vary.strip() or len(vary) > 200:
            raise GateApiError("invalid_vary", "Indicá qué variar: un parámetro o la ruta de una constante.")
        if not isinstance(values, list) or not values:
            raise GateApiError("invalid_values", "Indicá entre 1 y {} valores para probar.".format(MAX_VALUES))
        if any(isinstance(v, bool) or not isinstance(v, (int, float, str)) for v in values):
            raise GateApiError("invalid_values", "Los valores deben ser números.")
        normalized = []
        for value in values:
            try:
                text = normalize_value(value)
            except VariationError as error:
                raise GateApiError("invalid_values", str(error).capitalize() + ".")
            if text not in normalized:
                normalized.append(text)
        if len(normalized) > MAX_VALUES:
            raise GateApiError("invalid_values", "Se pidieron {} valores y el máximo es {}.".format(
                len(normalized), MAX_VALUES))
        try:
            describe_variation(spec, vary.strip())
        except VariationError as error:
            raise GateApiError("invalid_vary", str(error).capitalize() + ".")
        return mode, vary.strip(), normalized

    def launch(self, strategy_id, body):
        spec = self._spec(strategy_id)
        if spec.get("kind", "rules") not in RULE_KINDS:
            raise GateApiError("unsupported_kind", "VectorBT solo explora estrategias de reglas.", 422)
        mode, vary, values = self._validate(spec, body)
        available, reason = self.availability()
        if not available:
            raise GateApiError("vectorbt_unavailable", reason, 503)
        with self._lock:
            running = self._running()
            if running is not None:
                raise GateApiError("busy", "Ya hay una exploración de VectorBT en curso ({}). Esperá a que termine "
                                           "o cancelala.".format(running["strategy_id"]), 409)
            gate_running = self.gate._running()
            if gate_running is not None:
                raise GateApiError("busy", "Hay una prueba de la compuerta en curso ({}). Comparte el procesador con "
                                           "VectorBT: esperá a que termine.".format(gate_running["strategy_id"]), 409)
            created = self._now_ms()
            stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(created / 1000))
            exploration_id = "{}-{}".format(strategy_id[:55], stamp)
            n = 1
            while os.path.exists(os.path.join(self.explorations_dir, exploration_id)):
                n += 1
                exploration_id = "{}-{}-{}".format(strategy_id[:55], stamp, n)
            folder = os.path.join(self.explorations_dir, exploration_id)
            os.makedirs(folder)
            _write_json(os.path.join(folder, "spec.json"), spec)
            job = {"schema": JOB_SCHEMA, "exploration_id": exploration_id, "strategy_id": strategy_id,
                   "strategy_version": self.registry.version(strategy_id)["version"], "mode": mode, "vary": vary,
                   "values": values, "products": None, "created_at": created, "status": "running", "pid": None,
                   "root": self.root, "gate_config": self.gate_config, "paths": self.paths, "confirmations": {}}
            _write_json(os.path.join(folder, "job.json"), job)
            args = [self.python, "-m", RUNNER, "--job-dir", folder]
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join(
                p for p in (os.path.join(self.root, "python"), self.root, env.get("PYTHONPATH")) if p)
            child = self.spawn(args, env, self.root, os.path.join(folder, "runner.log"))
            job["pid"] = child.pid
            code = child.poll()
            if code not in (None, 0):
                job.update(status="failed", failed_at=self._now_ms(), error=self._log_tail(folder))
                _write_json(os.path.join(folder, "job.json"), job)
                raise GateApiError("vectorbt_failed", job["error"], 422)
            _write_json(os.path.join(folder, "job.json"), job)
        return {"exploration_id": exploration_id, "pid": child.pid}

    @staticmethod
    def _log_tail(folder):
        try:
            with open(os.path.join(folder, "runner.log"), "rb") as handle:
                text = handle.read()[-2000:].decode("utf-8", "replace")
        except OSError:
            text = ""
        lines = [line for line in text.splitlines() if line.strip()]
        return lines[-1][:600] if lines else "La exploración no pudo empezar."

    # ------------------------------------------------------------------ POST cancel

    def cancel(self, strategy_id, exploration_id):
        folder, job = self._job(strategy_id, exploration_id)
        with self._lock:
            state = self._state(folder, job)
            if state["status"] != "running":
                raise GateApiError("not_running", "Esa exploración ya no está en curso.", 409)
            job.update(status="cancelled", cancelled_at=self._now_ms())
            _write_json(os.path.join(folder, "job.json"), job)
            self.kill(job["pid"])
        return {"exploration_id": exploration_id, "cancel_requested": True}

    # ------------------------------------------------------------------ POST confirm

    def _next_variant_id(self, family):
        pattern = re.compile(r"^{}-v(\d+)$".format(re.escape(family)))
        highest = 1
        for (taken,) in self.registry.db.execute("SELECT DISTINCT strategy_id FROM strategy_versions"):
            match = pattern.match(taken)
            if match:
                highest = max(highest, int(match.group(1)))
        return "{}-v{}".format(family, highest + 1)

    def confirm(self, strategy_id, exploration_id, body):
        folder, job = self._job(strategy_id, exploration_id)
        if not isinstance(body, dict) or "value" not in body or isinstance(body["value"], bool):
            raise GateApiError("invalid_value", "Indicá el valor de la variante a crear.")
        try:
            value = normalize_value(body["value"])
        except VariationError as error:
            raise GateApiError("invalid_value", str(error).capitalize() + ".")
        with self._lock:
            state = self._state(folder, job)
            report = state["report"]
            if state["status"] != "done" or not report or report.get("mode") != "variants":
                raise GateApiError("not_ready", "La exploración todavía no terminó o no probó variantes.", 409)
            row = next((v for v in report["variants"] if v["value"] == value), None)
            if row is None:
                raise GateApiError("unknown_value", "Ese valor no estaba entre las variantes probadas.", 404)
            if row["status"] == "error":
                raise GateApiError("variant_failed", "Esa variante falló en VectorBT: no se puede crear.", 409)
            if row["is_base"]:
                raise GateApiError("is_base", "Ese valor es el que ya tiene la estrategia: no hay variante que crear.",
                                   409)
            known = (job.get("confirmations") or {}).get(value)
            if known and self.registry._version_row(known["strategy_id"], None) is not None \
                    and not self.registry._deleted(known["strategy_id"]):
                return {"strategy_id": known["strategy_id"], "version": 1, "title": known["title"], "state": "draft",
                        "already": True}
            spec = _read_json(os.path.join(folder, "spec.json"))
            if spec is None:
                raise GateApiError("not_ready", "No se encuentra la spec de esa exploración.", 409)
            try:
                variation = describe_variation(spec, report["vary"]["name"])
                changed = apply_value(spec, variation, value)
            except VariationError as error:
                raise GateApiError("invalid_vary", str(error).capitalize() + ".")
            base_title = self.registry._title(strategy_id, spec)
            what = variation["name"] if variation["kind"] == "param" else variation["label"]
            title = " ".join("{} · {}={}".format(base_title, what, value).split())[:120]
            from .futures_strategy_registry import RegistryError

            try:
                entry = self.registry.save(changed, "new", origin="vectorbt",
                                           new_id=self._next_variant_id(family_of(strategy_id)), new_name=title)
            except RegistryError as error:
                if error.code == "duplicate_spec":
                    raise GateApiError("duplicate_spec", "Ya existe una estrategia con las mismas reglas y parámetros "
                                                         "({}).".format(error.extra.get("id", "otra")), 409)
                raise
            job.setdefault("confirmations", {})[value] = {"strategy_id": entry["id"], "title": entry["name"],
                                                          "created_at": self._now_ms()}
            _write_json(os.path.join(folder, "job.json"), job)
        return {"strategy_id": entry["id"], "version": entry["version"], "title": entry["name"],
                "state": entry["state"], "already": False}

    # ------------------------------------------------------------------ GET compare

    def compare(self, strategy_id, exploration_id, value, run_id):
        folder, job = self._job(strategy_id, exploration_id)
        state = self._state(folder, job)
        report = state["report"]
        if state["status"] != "done" or not report or report.get("mode") != "variants":
            raise GateApiError("not_ready", "La exploración todavía no terminó o no probó variantes.", 409)
        try:
            value = normalize_value(value)
        except VariationError:
            raise GateApiError("invalid_value", "Indicá el valor de la variante a comparar.")
        row = next((v for v in report["variants"] if v["value"] == value), None)
        if row is None or row["status"] == "error":
            raise GateApiError("unknown_value", "Esa variante no tiene resultado de VectorBT para comparar.", 404)
        if row["is_base"]:
            target = strategy_id
        else:
            link = (job.get("confirmations") or {}).get(value)
            if not link:
                raise GateApiError("not_confirmed", "Primero hay que crear la variante (confirmarla) y probarla con "
                                                    "la compuerta.", 409)
            target = link["strategy_id"]
        if run_id in (None, ""):
            rows = self.gate._query("SELECT id FROM runs WHERE strategy_id=? AND kind='practice' AND status='done' "
                                    "ORDER BY id DESC LIMIT 1", (target,))
            if not rows:
                raise GateApiError("run_not_found", "Todavía no hay una prueba terminada de esa variante: lanzá "
                                                    "«Testear» sobre ella.", 404)
            run_id = str(rows[0]["id"])
        run_row, manifest, artifacts = self.gate._artifact(run_id)
        if manifest.get("kind") != "practice" or run_row["kind"] != "practice":
            raise GateApiError("invalid_run", "Solo se compara con pruebas de práctica, no con el examen.", 409)
        if manifest.get("strategy_id") != target:
            raise GateApiError("invalid_run", "Esa corrida es de otra estrategia ({}), no de {}.".format(
                manifest.get("strategy_id"), target), 409)
        trades = self.gate._stored_trades(artifacts, manifest)
        return build_comparison(report, row, manifest, trades, target, run_row["id"], exploration_id)


# ---------------------------------------------------------------------------------------------- the comparison
def _iso_ms(text):
    return int(datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
               .timestamp() * 1000)


def _fmt_day(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


def _sim_cost_bp(trade):
    """Costs the engine's model puts on one trade, in pb: taker fee both ways plus the execution of each leg."""
    product, side = trade["product_id"], trade["side"]
    reason = trade.get("exit_reason")
    exit_cost = 0.0 if reason == "target" else float(stop_exit_bps(product) if reason == "stop"
                                                     else side_impact_bps(product))
    return float(fee_rate("taker")) * 2 * 10_000 + float(side_impact_bps(product)) + exit_cost


def simulator_side(trades, products, range_ms):
    """Figures of the gate run's stored trades (only the products of the exploration), all measured the lab's way."""
    mine = [t for t in trades if t["product_id"] in products]
    days = {p: (range_ms[1] - range_ms[0]) / 86_400_000 for p in products}
    per_day = sum(sum(1 for t in mine if t["product_id"] == p) / d for p, d in days.items() if d)
    nets = [float(t["net_bp"]) for t in mine]
    costs = [_sim_cost_bp(t) for t in mine]
    funding = [None if t.get("funding_usd") is None else float(t["funding_usd"]) / float(t["notional_usd"]) * 10_000
               for t in mine]
    gross = [n + (f or 0.0) + c for n, f, c in zip(nets, funding, costs)]
    n = len(mine)
    return {"trades": n, "entries_per_day": per_day, "gross_bp_mean": _mean(gross), "net_bp_mean": _mean(nets),
            "cost_bp_mean": _mean(costs), "hit_rate": (sum(1 for x in nets if x > 0) / n) if n else None,
            "funding_bp_mean": _mean(funding),
            "funding_complete_share": (sum(1 for t in mine if t.get("funding_status") == "complete") / n) if n else None,
            "stop_share": (sum(1 for t in mine if t.get("exit_reason") == "stop") / n) if n else None}


def vectorbt_side(report, row):
    """Figures of the variant on the VectorBT side. Older reports lack some: those stay ``None`` (never invented)."""
    if row["is_base"]:
        totals = report["diagnostic"]["totals"]
        stop = next((x["share"] for x in report["diagnostic"]["by_exit"] if x["reason"] == "stop"), 0.0)
        source = dict(totals, stop_share=stop, signals=report["diagnostic"].get("signals"))
    else:
        source = row
    out = {key: source.get(key) for key in ("trades", "entries_per_day", "gross_bp_mean", "net_bp_mean", "hit_rate",
                                            "funding_bp_mean", "funding_complete_share", "stop_share")}
    signals = source.get("signals") or {}
    out["raw_signals"], out["skipped_by_cost"] = signals.get("raw"), signals.get("skipped_by_cost")
    gross, net, fund = out["gross_bp_mean"], out["net_bp_mean"], out["funding_bp_mean"]
    out["cost_bp_mean"] = None if None in (gross, net, fund) else gross - net - fund
    return out


def build_comparison(report, row, manifest, trades, strategy_id, run_id, exploration_id):
    products = list(report["products"])
    sim_products = [p for p in products if p in manifest["products"]]
    range_ms = (manifest["range_start_ms"], manifest["range_end_ms_exclusive"])
    sim = simulator_side(trades, sim_products, range_ms)
    vbt = vectorbt_side(report, row)
    keys = ("trades", "entries_per_day", "gross_bp_mean", "net_bp_mean", "cost_bp_mean", "funding_bp_mean", "hit_rate")
    diff = {k: (None if vbt[k] is None or sim[k] is None else vbt[k] - sim[k]) for k in keys}
    window = {"vectorbt": report["window"], "simulator": {"from": _fmt_day(range_ms[0]), "to": _fmt_day(range_ms[1])}}
    out = {"exploration_id": exploration_id, "strategy_id": strategy_id, "run_id": run_id, "value": row["value"],
           "label": row["label"], "is_base": row["is_base"], "products": sim_products, "window": window,
           "vectorbt": vbt, "simulator": sim, "difference": diff, "cost_model_version": COST_MODEL_VERSION}
    out["explanation"] = explain(report, vbt, sim, diff, products, manifest, range_ms)
    out["warning"] = report.get("warning")
    return out


def explain(report, vbt, sim, diff, products, manifest, range_ms):
    """Plain Spanish sentences about why the two sides differ, from the numbers in front of them.

    The split is exact: net = gross - costs - funding on both sides (the simulator's gross is rebuilt as net + funding +
    the costs its model charges), so the difference of nets is the sum of three differences. What the gross difference is
    made of cannot be separated further: the lab does not keep its trades one by one.
    """
    lines = []
    missing = [p for p in products if p not in manifest["products"]]
    if missing:
        lines.append("La prueba del simulador no incluye {}: se comparan solo los productos que tienen los dos.".format(
            ", ".join(missing)))
    start, end = _iso_ms(report["window"]["from"]), _iso_ms(report["window"]["to"])
    if abs(start - range_ms[0]) > 86_400_000 or abs(end - range_ms[1]) > 86_400_000:
        lines.append("Las ventanas no coinciden (VectorBT: {} a {}; simulador: {} a {}): parte de la diferencia puede "
                     "venir de ahí.".format(_fmt_day(start), _fmt_day(end), _fmt_day(range_ms[0]), _fmt_day(range_ms[1])))
    if sim["trades"] == 0 or vbt["trades"] in (0, None) or diff["net_bp_mean"] is None:
        lines.append("Uno de los dos lados no tiene operaciones o le faltan datos: no hay diferencia que explicar.")
        return lines
    net_v, net_s, d_net = vbt["net_bp_mean"], sim["net_bp_mean"], diff["net_bp_mean"]
    if abs(d_net) < SAME_BP:
        lines.append("Los dos lados coinciden: VectorBT da {} pb netos por operación y el simulador {} pb.".format(
            _sbp(net_v), _sbp(net_s)))
    else:
        lines.append("VectorBT da {} pb netos por operación y el simulador {} pb: VectorBT queda {} pb {}.".format(
            _sbp(net_v), _sbp(net_s), _bp(abs(d_net)), "por encima" if d_net > 0 else "por debajo"))
    # Number of trades and the cost filter.
    if vbt["trades"] and sim["trades"]:
        gap = abs(vbt["trades"] - sim["trades"]) / max(vbt["trades"], sim["trades"])
        lines.append("Operaciones: VectorBT {} ({} por día) y simulador {} ({} por día).".format(
            vbt["trades"], _num(vbt["entries_per_day"], 2), sim["trades"], _num(sim["entries_per_day"], 2)))
        raw, skipped = vbt.get("raw_signals"), vbt.get("skipped_by_cost")
        if raw and skipped is not None:
            lines.append("De {} entradas que detecta la estrategia, {} ({}) se descartan por costo mínimo (el objetivo "
                         "no cubre el costo de ida y vuelta más un colchón). El simulador aplica la misma regla, así "
                         "que esto explica por qué ambos operan menos que las señales, no por qué difieren entre sí."
                         .format(raw, skipped, _pct(skipped / raw)))
        if gap >= COUNT_TOLERANCE:
            lines.append("La cantidad de operaciones difiere en {} ({}). No puedo atribuirla con estos datos: VectorBT "
                         "no guarda sus operaciones una por una. La causa conocida es el cruce de niveles: cuando una "
                         "vela solo toca el stop o el objetivo el simulador cierra, VectorBT necesita cruzarlo, y eso "
                         "cambia cuándo queda libre para la próxima entrada.".format(
                             abs(vbt["trades"] - sim["trades"]), _pct(gap)))
    # Exact split of the net difference.
    d_gross, d_cost, d_fund = diff["gross_bp_mean"], diff["cost_bp_mean"], diff["funding_bp_mean"]
    if None in (d_gross, d_cost):
        lines.append("A este informe de VectorBT le faltan datos (costos o funding por operación): no puedo repartir la "
                     "diferencia. Repetí la exploración para tenerlos.")
        return lines
    fund_effect = -(d_fund or 0.0)
    cost_effect = -d_cost
    lines.append("De la diferencia de neto, el movimiento del precio aporta {} pb, los costos {} pb y el funding {} pb "
                 "(neto = movimiento del precio - costos - funding en los dos lados).".format(
                     _sbp(d_gross), _sbp(cost_effect), _sbp(fund_effect)))
    if sim["funding_bp_mean"] is not None and vbt["funding_bp_mean"] is not None:
        lines.append("Funding real: VectorBT descuenta {} pb por operación y el simulador {} pb. Funding completo en {} "
                     "de las operaciones de VectorBT y {} de las del simulador.".format(
                         _bp(vbt["funding_bp_mean"]), _bp(sim["funding_bp_mean"]),
                         _pct(vbt["funding_complete_share"] or 0.0), _pct(sim["funding_complete_share"] or 0.0)))
        low = [n for n, share in (("VectorBT", vbt["funding_complete_share"]), ("el simulador",
                                                                                  sim["funding_complete_share"]))
               if share is not None and share < FUNDING_OK]
        if low:
            lines.append("Con funding incompleto en {} el efecto del funding no es del todo comparable.".format(
                " y ".join(low)))
    if abs(d_cost) < SAME_BP:
        lines.append("Comisiones y costo de ejecución: {} pb por operación en VectorBT y {} pb en el simulador. "
                     "Coinciden, no explican la diferencia.".format(_bp(vbt["cost_bp_mean"]), _bp(sim["cost_bp_mean"])))
    else:
        stop_note = ""
        if vbt.get("stop_share") is not None and sim.get("stop_share") is not None:
            stop_note = (" El stop pesa distinto: cierra el {} de las operaciones de VectorBT y el {} de las del "
                         "simulador.".format(_pct(vbt["stop_share"]), _pct(sim["stop_share"])))
        lines.append("Comisiones y costo de ejecución: VectorBT resta {} pb por operación y el simulador {} pb. VectorBT "
                     "no modela el costo de ejecución del stop, pero el laboratorio ya lo resta aparte, así que no es "
                     "una omisión: la brecha de {} pb sale de las comisiones y del costo de ejecución que cada lado "
                     "carga según cómo cierra sus operaciones.{}".format(_bp(vbt["cost_bp_mean"]), _bp(sim["cost_bp_mean"]), _bp(abs(d_cost)),
                                         stop_note))
    if abs(d_gross) >= SAME_BP:
        lines.append("Movimiento del precio: {} pb por operación en VectorBT y {} pb en el simulador. Esta parte viene "
                     "de cómo se cruzan los niveles y del orden de ejecución dentro de la vela, y de que no son "
                     "exactamente las mismas operaciones; no puedo separarla más con los datos que guarda VectorBT."
                     .format(_sbp(vbt["gross_bp_mean"]), _sbp(sim["gross_bp_mean"])))
    else:
        lines.append("El movimiento del precio coincide ({} pb contra {} pb): la diferencia no viene del cruce de "
                     "niveles.".format(_sbp(vbt["gross_bp_mean"]), _sbp(sim["gross_bp_mean"])))
    lines.append("VectorBT es una hipótesis sobre datos de práctica; el simulador y la compuerta son los que valen.")
    return lines
