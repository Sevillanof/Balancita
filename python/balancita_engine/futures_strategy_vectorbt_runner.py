"""Child process of one VectorBT exploration (stdlib only; it runs with the interpreter of ``.venv-vectorbt``).

``python -m balancita_engine.futures_strategy_vectorbt_runner --job-dir <data>/explorations/<id>``

Reads ``job.json`` (the request) and ``spec.json`` (the spec to explore) from the job folder and:

1. exports (``research.vectorbt.export_practice --fetch``) the practice dataset of every gate product that has none yet;
2. runs ``research.vectorbt.explore`` and forwards its JSON progress lines.

Progress goes to ``progress.json`` in the job folder (atomic, never goes down). The runner never writes ``job.json`` (that is
the API's) and never touches a database: the lab only writes the exploration folder, the dataset folder and its own ledger.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

DOWNLOAD_SHARE = 45.0      # part of the bar spent downloading when datasets are missing


def label(product):
    """``PF_ETHUSD`` -> ``ETH``."""
    return re.sub(r"USD$", "", re.sub(r"^PF_", "", product))


class Reporter:
    def __init__(self, folder, clock=time.time):
        self.path, self.clock, self.last = os.path.join(folder, "progress.json"), clock, 0.0

    def write(self, percent, phase, detail="", state="running", error=None):
        self.last = max(self.last, min(100.0, round(float(percent), 1)))
        body = {"state": state, "progress": self.last, "phase": phase, "detail": detail, "error": error,
                "updated_at": int(self.clock() * 1000)}
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(body, handle, ensure_ascii=False)
        os.replace(tmp, self.path)


def missing_products(products, datasets_dir):
    return [p for p in products if not os.path.isfile(os.path.join(datasets_dir, p, "manifest.json"))]


def _last_line(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1][:600] if lines else ""


def run(job_dir, *, python=None, root=None, popen=subprocess.Popen, clock=time.time):
    reporter = Reporter(job_dir, clock)
    python = python or sys.executable
    with open(os.path.join(job_dir, "job.json"), encoding="utf-8") as handle:
        job = json.load(handle)
    root = root or job["root"]
    paths = job["paths"]
    with open(job["gate_config"], encoding="utf-8") as handle:
        gate = json.load(handle)
    products = job.get("products") or gate["default_products"]
    reporter.write(0, "Preparando", "Estrategia {}".format(job["strategy_id"]))
    todo = missing_products(products, paths["datasets"])
    base = DOWNLOAD_SHARE if todo else 0.0
    for k, product in enumerate(todo, 1):
        detail = "Descargando velas de Kraken ({} {}/{})".format(label(product), k, len(todo))
        reporter.write(base * (k - 1) / len(todo), "Descargando datos", detail)
        args = [python, "-m", "research.vectorbt.export_practice", "--product", product, "--fetch",
                "--gate-config", job["gate_config"], "--cache-dir", paths["cache"], "--out", paths["datasets"]]
        child = popen(args, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                      text=True)
        output = child.communicate()[0] or ""
        if child.returncode != 0:
            message = "No se pudieron descargar las velas de {}: {}".format(label(product), _last_line(output))
            reporter.write(reporter.last, "Error", message, state="failed", error=message)
            return 2
        reporter.write(base * k / len(todo), "Descargando datos", detail)
    args = [python, "-m", "research.vectorbt.explore", "--strategy", os.path.join(job_dir, "spec.json"),
            "--mode", job["mode"], "--exploration-id", job["exploration_id"], "--out-dir", paths["explorations"],
            "--datasets-dir", paths["datasets"], "--ledger", paths["ledger"], "--gate-config", job["gate_config"]]
    if job["mode"] == "variants":
        args += ["--vary", job["vary"], "--values", ",".join(job["values"])]
    if job.get("products"):
        args += ["--products", ",".join(job["products"])]
    child = popen(args, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                  text=True)
    last_error, noise = None, []
    for line in child.stdout:
        try:
            event = json.loads(line)
            percent = base + float(event["progress"]) * (100.0 - base) / 100.0
        except (ValueError, KeyError, TypeError):
            noise.append(line)          # a traceback or the lab's ``ERROR:`` line
            continue
        if event.get("phase") == "Error":
            last_error = str(event.get("detail"))
            continue
        reporter.write(percent, str(event.get("phase", "")), str(event.get("detail", "")))
    code = child.wait()
    if code != 0:
        message = last_error or _last_line("".join(noise)) or "El laboratorio terminó con un error (código {}).".format(code)
        reporter.write(reporter.last, "Error", message, state="failed", error=message)
        return code or 1
    reporter.write(100, "Listo", "Exploración terminada", state="done")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--job-dir", required=True)
    args = parser.parse_args(argv)
    try:
        return run(os.path.abspath(args.job_dir))
    except Exception as error:  # noqa: BLE001 - whatever happens, the API must be able to say why
        try:
            Reporter(args.job_dir).write(0, "Error", str(error)[:600], state="failed", error=str(error)[:600])
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
