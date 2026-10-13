"""Reproducible demonstration of ``signal_continuity``: every scenario runs in brand-new Python processes that share
only the files in a temporary directory. Invented data, no network, no wall clock; the output is deterministic.

    PYTHONPATH=python python3 -m balancita_engine.signal_continuity_demo --out analisis/continuidad-senales-offline
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

from .signal_continuity import CHECKPOINT_FILE, EFFECTS_FILE, LOG_FILE

PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRASH_AT = 40  # the n-th signal handled after the process starts, at which it is killed


def run(role, directory, *extra):
    """A brand-new interpreter for one role. Returns ``(exit code, RECOVERY_REFUSED reason or None, stderr)``."""
    env = dict(os.environ, PYTHONPATH=PARENT + os.pathsep + os.environ.get("PYTHONPATH", ""))
    done = subprocess.run([sys.executable, "-m", "balancita_engine.signal_continuity", role, "--dir", directory, *extra],
                          env=env, capture_output=True, text=True)
    reason = next((line.split(" ", 1)[1] for line in done.stderr.splitlines() if line.startswith("RECOVERY_REFUSED ")), None)
    return done.returncode, reason, done.stderr


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def read_jsonl(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def effects(directory):
    return read_jsonl(os.path.join(directory, EFFECTS_FILE))


def decisions(directory):
    """key -> (origin, decision_hash) of the entries that count."""
    entries = read_jsonl(os.path.join(directory, LOG_FILE))
    counted = {}
    for entry in entries:
        if entry["kind"] == "signal":
            data = entry["data"]
            if data["key"] not in counted or data["origin"] == "original":
                counted[data["key"]] = (data["origin"], data["decision_hash"])
    return counted


def would_open(directory):
    return sorted(e["key"] for e in effects(directory) if e["kind"] == "would_open")


def report(directory):
    with open(os.path.join(directory, "report.json"), encoding="utf-8") as handle:
        return json.load(handle)


def scenarios(base):
    """Runs every scenario under ``base`` and returns a plain, deterministic summary."""
    out = {}

    def fresh(name):
        path = os.path.join(base, name)
        os.makedirs(path)
        return path

    ref = fresh("referencia")
    assert run("produce", ref)[0] == 0 and run("recover", ref)[0] == 0
    ref_decisions, ref_open = decisions(ref), would_open(ref)
    ref_report = report(ref)
    out["referencia_sin_caidas"] = {
        "senales": len(ref_decisions), "podian_abrir_posicion": len(ref_open), "huecos": len(ref_report["gaps"]),
        "verificacion_ok": ref_report["verify"]["ok"], "cabeza_del_registro": ref_report["log_head"]}

    def compare(name, directory, *, same_openings):
        now = decisions(directory)
        reconstructed = [k for k, (origin, _) in now.items() if origin == "reconstructed"]
        return {
            "senales_originales": sum(1 for o, _ in now.values() if o == "original"),
            "senales_reconstruidas": len(reconstructed),
            "decisiones_distintas_de_la_referencia": sum(1 for k, (_, h) in now.items() if ref_decisions.get(k, (None, None))[1] != h),
            "posiciones_abribles": len(would_open(directory)),
            "mismas_posiciones_abribles_que_la_referencia": would_open(directory) == ref_open if same_openings else None,
            "reconstruidas_que_abririan_posicion": sum(1 for e in effects(directory) if e["kind"] == "would_open" and e["origin"] == "reconstructed"),
            "efectos_duplicados": len(effects(directory)) - len({e["key"] for e in effects(directory)}),
            "verificacion_ok": report(directory)["verify"]["ok"]}

    # 1. a crash before anything was persisted: that signal and everything after it never existed in the log
    d = fresh("antes_de_persistir")
    code = run("produce", d, "--crash", "before_persist:{}".format(CRASH_AT))[0]
    assert code == 137 and run("recover", d)[0] == 0
    out["caida_antes_de_persistir_sin_reenvio"] = dict(compare("a", d, same_openings=False), codigo_de_salida_primer_proceso=code)

    # 2. torn write in the middle of persisting, the upstream redelivers
    d = fresh("a_mitad_de_persistir")
    code = run("produce", d, "--crash", "mid_persist:{}".format(CRASH_AT))[0]
    assert code == 137 and run("produce", d)[0] == 0 and run("recover", d)[0] == 0
    out["caida_a_mitad_de_persistir_con_reenvio"] = dict(compare("b", d, same_openings=True), codigo_de_salida_primer_proceso=code,
                                                         bytes_de_cola_descartados=sum(e["data"]["bytes"] for e in read_jsonl(os.path.join(d, LOG_FILE)) if e["kind"] == "tail_discarded"))
    # 3. crash right after persisting
    d = fresh("despues_de_persistir")
    code = run("produce", d, "--crash", "after_persist:{}".format(CRASH_AT))[0]
    assert code == 137 and run("produce", d)[0] == 0 and run("recover", d)[0] == 0
    out["caida_despues_de_persistir_con_reenvio"] = dict(compare("c", d, same_openings=True), codigo_de_salida_primer_proceso=code)
    # 3b. same crash, nobody redelivers, the restart happens much later: the signal is durable but too old to open anything
    d = fresh("despues_de_persistir_tarde")
    first_candidate = next(n for n, e in enumerate((x for x in read_jsonl(os.path.join(ref, LOG_FILE)) if x["kind"] == "signal"), start=1)
                           if n > CRASH_AT and e["data"]["signal"]["action"] != "WAIT")
    assert run("produce", d, "--crash", "after_persist:{}".format(first_candidate))[0] == 137 and run("recover", d)[0] == 0
    late = [e for e in effects(d) if e["kind"] == "counterfactual" and e["origin"] == "original"]
    out["caida_despues_de_persistir_reinicio_tardio"] = dict(compare("c2", d, same_openings=False),
                                                               originales_vencidas_sin_posicion=len(late),
                                                               motivos=sorted({e["reason"] for e in late}))
    # 4. crash after the handler acted and before the offset moved
    d = fresh("antes_de_confirmar")
    code = run("produce", d, "--crash", "before_ack:{}".format(CRASH_AT))[0]
    assert code == 137 and run("produce", d)[0] == 0 and run("recover", d)[0] == 0
    out["caida_antes_de_confirmar_con_reenvio"] = dict(compare("d", d, same_openings=True), codigo_de_salida_primer_proceso=code)
    # 5. lost events and duplicated deliveries
    d = fresh("perdidas_y_duplicados")
    assert run("produce", d, "--stop", "120", "--drop", "7,8,9,60", "--duplicate")[0] == 0 and run("recover", d)[0] == 0
    rep = report(d)
    out["eventos_perdidos_y_duplicados"] = dict(compare("e", d, same_openings=False), huecos_en_la_numeracion_de_origen=rep["source_offset_holes"],
                                                huecos_de_ciclos=len(rep["gaps"]))
    # 6. incompatible strategy builds must be refused and leave no trace
    refusals = {}
    for label, variant in (("version_nueva_sin_congelar", "bumped"), ("mismo_numero_de_version_con_codigo_distinto", "edited")):
        d = fresh("variante_" + variant)
        run("produce", d, "--stop", "60")
        before = read_bytes(os.path.join(d, LOG_FILE))
        code, reason, _ = run("recover", d, "--variant", variant)
        refusals[label] = {"codigo": code, "motivo": reason, "registro_intacto": read_bytes(os.path.join(d, LOG_FILE)) == before,
                           "escribio_informe": os.path.exists(os.path.join(d, "report.json"))}
    out["reconstruccion_con_versiones_incompatibles"] = refusals
    # 7. damaged files
    base_dir = fresh("base_danada")
    run("produce", base_dir, "--stop", "60")

    def sabotage(label, change):
        d = os.path.join(base, "danio_" + label)
        shutil.copytree(base_dir, d)
        change(d)
        code, reason, _ = run("recover", d)
        return {"codigo": code, "motivo": reason, "escribio_informe": os.path.exists(os.path.join(d, "report.json"))}

    def rewrite(path, fn):
        with open(path, "rb") as handle:
            data = handle.read()
        with open(path, "wb") as handle:
            handle.write(fn(data))

    def flip(path):
        rewrite(path, lambda b: b[:len(b) // 2] + bytes([b[len(b) // 2] ^ 0xFF]) + b[len(b) // 2 + 1:])

    def lines(path, fn):
        rewrite(path, lambda b: "".join(fn(b.decode().splitlines(keepends=True))).encode())

    other = fresh("registro_ajeno")
    run("produce", other, "--stop", "62", "--drop", "1")
    damage = {
        "checkpoint_alterado": lambda d: flip(os.path.join(d, CHECKPOINT_FILE)),
        "checkpoint_vacio": lambda d: rewrite(os.path.join(d, CHECKPOINT_FILE), lambda b: b""),
        "checkpoint_ausente": lambda d: os.remove(os.path.join(d, CHECKPOINT_FILE)),
        "registro_ausente": lambda d: os.remove(os.path.join(d, LOG_FILE)),
        "registro_con_entrada_alterada": lambda d: lines(os.path.join(d, LOG_FILE), lambda ls: ls[:20] + [ls[20].replace('"kind"', '"kinD"', 1)] + ls[21:]),
        "registro_reordenado": lambda d: lines(os.path.join(d, LOG_FILE), lambda ls: ls[:5] + [ls[6], ls[5]] + ls[7:]),
        "registro_truncado_antes_del_checkpoint": lambda d: lines(os.path.join(d, LOG_FILE), lambda ls: ls[:30]),
        "registro_de_otra_corrida": lambda d: shutil.copy(os.path.join(other, LOG_FILE), os.path.join(d, LOG_FILE)),
    }
    out["archivos_danados"] = {label: sabotage(label, change) for label, change in damage.items()}
    return out


def render(results):
    lines = ["# Demostración: continuidad durable de señales (offline)", "",
             "Generada por `python -m balancita_engine.signal_continuity_demo`. Cada escenario usa procesos Python nuevos que "
             "solo comparten archivos. Datos sintéticos; sin red, sin reloj de pared, sin holdout.", ""]
    ref = results["referencia_sin_caidas"]
    lines += ["## Referencia (sin caídas)", "",
              "- {senales} señales registradas, {podian_abrir_posicion} podían abrir posición, {huecos} huecos, verificación ok: {verificacion_ok}.".format(**ref),
              "- Cabeza de la cadena: `{cabeza_del_registro}`.".format(**ref), ""]
    for name, value in results.items():
        if name in ("referencia_sin_caidas", "reconstruccion_con_versiones_incompatibles", "archivos_danados"):
            continue
        lines += ["## " + name.replace("_", " "), ""] + ["- {}: {}".format(k.replace("_", " "), v) for k, v in value.items()] + [""]
    lines += ["## reconstrucción con versiones incompatibles", "", "| caso | código | motivo | registro intacto | escribió informe |", "|---|---|---|---|---|"]
    for k, v in results["reconstruccion_con_versiones_incompatibles"].items():
        lines.append("| {} | {} | {} | {} | {} |".format(k, v["codigo"], v["motivo"], v["registro_intacto"], v["escribio_informe"]))
    lines += ["", "## archivos dañados (el segundo proceso debe negarse)", "", "| daño | código | motivo | escribió informe |", "|---|---|---|---|"]
    for k, v in results["archivos_danados"].items():
        lines.append("| {} | {} | {} | {} |".format(k, v["codigo"], v["motivo"], v["escribio_informe"]))
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as base:
        results = scenarios(base)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "resultados.json"), "w", encoding="utf-8") as handle:
        json.dump(results, handle, sort_keys=True, indent=1, ensure_ascii=False)
        handle.write("\n")
    with open(os.path.join(args.out, "informe.md"), "w", encoding="utf-8") as handle:
        handle.write(render(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
