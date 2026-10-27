"""La noche de «Enseñar a Qwen a leer la ficha»: piloto y corrida completa de la destilación, en un solo comando (ver destila-noche.sh).

Todo queda en $DATA/destila-noche/<fecha-hora>/ y en su log.txt. NO toca Qwen en vivo (carpeta de adaptadores propia, ni .env.local ni
LLAMA_LORA ni pnpm dev). Pasos:
  0. Humo: 10 pasos, una medición de 6 ejemplos y la conversión a GGUF. Si algo falla, CORTA antes de gastar la noche.
  1. Qwen sin entrenar en la validación (la referencia).
  2. Entrena de a CHUNK pasos (250) hasta TOTAL (2.000). El primer tramo ES el piloto: si el espejo no pasa de 50 %, CORTA ahí (la
     receta no lee la ficha y no se gasta la noche). Después de cada tramo mide en la validación 2025-08/09 (nunca en la práctica);
     corta cuando acuerdo y espejo ≥ 90 %, o cuando dos tramos seguidos no suben el acuerdo, o por tiempo (MAX_MIN, 150 min en total).
  3. El mejor checkpoint (ver futures_qwen_destila.best_step), UNA vez en la práctica, y su GGUF (sin cargar en ningún lado).
  4. informe.md con PASA / NO pasa.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "python"))
from balancita_engine import futures_qwen_destila as dst  # noqa: E402

DATA = os.path.join(os.environ.get("BALANCITA_DATA") or os.path.expanduser("~/balancita-data.noindex"), "qwen-lora")
VENV = os.path.join(DATA, "venv")
MODEL = os.path.join(DATA, os.environ.get("QWEN_LORA_MODEL", "Qwen3-4B-4bit"))
DATASET = os.environ.get("DESTILA_DATASET") or os.path.join(DATA, "destila")
TOTAL, CHUNK = int(os.environ.get("TOTAL", 2000)), int(os.environ.get("CHUNK", 250))
VALID_N, PRACTICA_N = int(os.environ.get("VALID_N", 200)), int(os.environ.get("PRACTICA_N", 600))
MAX_MIN = float(os.environ.get("MAX_MIN", 150))
RESERVE_MIN = 40                                     # lo que se guarda para la práctica y el GGUF
PY = os.path.join(VENV, "bin", "python")
STARTED = time.time()
OUT = os.path.join(DATA, "destila-noche", time.strftime("%Y%m%d-%H%M"))
AD = os.path.join(OUT, "adapters")
LOG = None
SIGUE = bool(os.environ.get("DESTILA_SIGUE"))          # segunda etapa: retoma la noche que ya corre y la extiende hasta MAX_MIN_TOTAL
MAX_MIN_TOTAL = float(os.environ.get("MAX_MIN_TOTAL", 420))
PATIENCE = int(os.environ.get("PATIENCE", 3))


def say(text):
    line = "[{}] {}".format(time.strftime("%Y-%m-%d %H:%M:%S"), text)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


def fail(text, code=1):
    say("CORTO: " + text)
    sys.exit(code)


def run(cmd, what, env=None):
    say("$ " + " ".join(cmd[:4]) + " ...")
    done = subprocess.run(cmd, env=dict(os.environ, PYTHONPATH=os.path.join(ROOT, "python"), **(env or {})))
    if done.returncode != 0:
        fail("{} falló (código {})".format(what, done.returncode))


def lora(*extra, adapter_path):
    return [os.path.join(VENV, "bin", "mlx_lm.lora"), "-c", os.path.join(HERE, "lora.yaml"), "--model", MODEL, "--data", DATASET,
            "--adapter-path", adapter_path, "--steps-per-report", "25",
            # la pregunta real mide ~750 tokens: 1.024 (con 768 se cortaría la letra de la respuesta); tasa 1e-5 del diseño
            "--max-seq-length", "1024", "--learning-rate", "1e-5", *extra]


def measure(adapter, out, n):
    cmd = [PY, os.path.join(HERE, "destila_eval.py"), "--model", MODEL, "--data", DATASET, "--out", out, "--max", str(n)]
    if adapter:
        cmd += ["--adapter", adapter]
    run(cmd, "la medición")
    return json.load(open(out, encoding="utf-8"))


def short(r):
    return "acuerdo {} espejo {} respuesta más repetida {} neto por entrada {} (fórmula {})".format(
        r["acuerdo"], r["espejo_da_vuelta"], r["costumbre_parte"], r["neto_por_entrada_bp"], r["formula_neto_por_entrada_bp"])


def main():
    global LOG, OUT, AD, STARTED
    if SIGUE:
        return sigue()
    os.makedirs(AD, exist_ok=True)
    LOG = open(os.path.join(OUT, "log.txt"), "a", encoding="utf-8")
    if not os.path.isfile(os.path.join(MODEL, "config.json")):
        fail("falta el modelo en {} (ops/qwen-lora/train.sh download)".format(MODEL))
    if not os.path.isfile(PY):
        fail("falta el venv en {} (ops/qwen-lora/train.sh setup)".format(VENV))
    for name in ("train.jsonl", "valid.jsonl", "valid-info.jsonl", "practica.jsonl", "meta.json"):
        path = os.path.join(DATASET, name)
        if not (os.path.exists(path) and os.path.getsize(path)):
            fail("falta {} en {} (el dataset se arma en la nube y se copia aquí)".format(name, DATASET))
    free_gb = os.statvfs(DATA).f_bavail * os.statvfs(DATA).f_frsize / 1e9
    if free_gb < 8:
        fail("menos de 8 GB libres en {}".format(DATA))
    lock = os.path.join(DATA, "destila-noche.lock")
    if os.path.exists(lock):
        try:
            os.kill(int(open(lock).read()), 0)
            fail("ya hay una noche corriendo (pid {})".format(open(lock).read()))
        except (ProcessLookupError, ValueError):
            pass
    open(lock, "w").write(str(os.getpid()))
    try:
        run_night()
    finally:
        os.remove(lock) if os.path.exists(lock) else None


def run_night():
    say("inicio. Hasta {} pasos de a {}; mide {} ejemplos de validación por tramo; tope {} min. Salida: {}".format(TOTAL, CHUNK, VALID_N, int(MAX_MIN), OUT))
    say("0. prueba de humo (10 pasos, 6 ejemplos, conversión a GGUF)")
    humo = os.path.join(OUT, "humo")
    run(lora("--iters", "10", "--steps-per-eval", "1000", "--save-every", "1000", "--val-batches", "2", adapter_path=humo), "el entrenamiento de humo")
    if not os.path.isfile(os.path.join(humo, "adapters.safetensors")):
        fail("el entrenamiento de humo no dejó adapters.safetensors")
    measure(humo, os.path.join(humo, "valid.json"), 6)
    run([PY, "-m", "balancita_engine.futures_qwen_lora_adapter", humo, os.path.join(humo, "humo.gguf")], "la conversión a GGUF")
    if not os.path.getsize(os.path.join(humo, "humo.gguf")):
        fail("la conversión no dejó el GGUF")
    subprocess.run(["rm", "-rf", humo])
    say("prueba de humo OK")

    say("1. Qwen sin entrenar")
    base = measure(None, os.path.join(OUT, "base-valid.json"), VALID_N)
    say("sin entrenar: " + short(base))

    done, history = 0, []
    open(os.path.join(OUT, "historia.jsonl"), "w").close()
    while done < TOTAL:
        elapsed = (time.time() - STARTED) / 60
        if history and elapsed > MAX_MIN - RESERVE_MIN:
            say("tope de tiempo ({} min): corto el entrenamiento en {} pasos".format(int(elapsed), done))
            break
        resume = []
        if os.path.isfile(os.path.join(AD, "adapters.safetensors")):
            resume = ["--resume-adapter-file", os.path.join(AD, "adapters.safetensors")]
        say("2. entrenando {} pasos (van {} de {}){}".format(CHUNK, done, TOTAL, " — ES EL PILOTO" if not history else ""))
        run(lora(*resume, "--iters", str(CHUNK), "--save-every", str(CHUNK), "--steps-per-eval", str(CHUNK), adapter_path=AD), "el entrenamiento")
        done += CHUNK
        step_dir = os.path.join(AD, "paso-{}".format(done))
        os.makedirs(step_dir, exist_ok=True)
        for name in ("adapters.safetensors", "adapter_config.json"):
            subprocess.run(["cp", os.path.join(AD, name), step_dir])
        r = measure(step_dir, os.path.join(step_dir, "valid.json"), VALID_N)
        r["paso"] = done
        history.append(r)
        with open(os.path.join(OUT, "historia.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(r, ensure_ascii=False) + "\n")
        say("paso {}: {}".format(done, short(r)))
        action, why = dst.decide(history)
        if action == "piloto_falla":
            fail("PILOTO NO PASA: " + why, 3)
        if action != "sigue":
            say("corto el entrenamiento ({}): {}".format(action, why))
            break

    best = dst.best_step(history)
    json.dump({"paso": best}, open(os.path.join(OUT, "best.json"), "w"))
    say("3. el mejor es el paso {}: práctica ({} miradas de cada tipo)".format(best, PRACTICA_N))
    run([PY, os.path.join(HERE, "aprende_eval.py"), "--mode", "practica", "--model", MODEL, "--data", DATASET, "--adapter", os.path.join(AD, "paso-{}".format(best)),
         "--max", str(PRACTICA_N), "--out", os.path.join(OUT, "best-practica.json")], "la práctica")
    gguf = os.path.join(DATA, "qwen-destila.gguf")
    done_gguf = subprocess.run([PY, "-m", "balancita_engine.futures_qwen_lora_adapter", os.path.join(AD, "paso-{}".format(best)), gguf],
                               env=dict(os.environ, PYTHONPATH=os.path.join(ROOT, "python")))
    say("GGUF del mejor: {} (NO está cargado en ningún lado)".format(gguf) if done_gguf.returncode == 0
        else "la conversión a GGUF falló (el adaptador sigue en {})".format(os.path.join(AD, "paso-{}".format(best))))
    run([PY, "-m", "balancita_engine.futures_qwen_destila", "informe", "--dir", OUT, "--out", os.path.join(OUT, "informe.md")], "el informe")
    say("fin. Informe: {}".format(os.path.join(OUT, "informe.md")))


if __name__ == "__main__":
    main()


def sigue():
    """Segunda etapa (Fran: «que entrene hasta 7 horas»): espera a que termine la noche que ya corre y, si paró solo por pasos o por
    tiempo (no porque ya estaba lista, dejó de mejorar o falló el piloto), retoma del último adaptador y sigue de a CHUNK pasos hasta
    MAX_MIN_TOTAL minutos desde el inicio. Mide cada tramo en la validación, y corta cuando PATIENCE mediciones seguidas no superan la
    mejor (si empeora, memoriza). Después: el mejor de TODOS los tramos, una vez en la práctica, GGUF e informe."""
    global LOG, OUT, AD, STARTED
    base = os.path.join(DATA, "destila-noche")
    OUT = os.path.join(base, sorted(d for d in os.listdir(base) if os.path.isfile(os.path.join(base, d, "log.txt")))[-1])
    AD = os.path.join(OUT, "adapters")
    LOG = open(os.path.join(OUT, "log.txt"), "a", encoding="utf-8")
    first = open(os.path.join(OUT, "log.txt"), encoding="utf-8").readline()[1:20]
    STARTED = time.mktime(time.strptime(first, "%Y-%m-%d %H:%M:%S"))
    lock = os.path.join(DATA, "destila-noche.lock")
    say("etapa 2: espero a que termine la noche que corre ({})".format(OUT))
    while os.path.exists(lock):
        try:
            os.kill(int(open(lock).read()), 0)
        except (ProcessLookupError, ValueError):
            break
        time.sleep(30)
    text = open(os.path.join(OUT, "log.txt"), encoding="utf-8").read()
    if "PILOTO NO PASA" in text or "CORTO:" in text.split("etapa 2")[0] or "corto el entrenamiento (listo" in text or "corto el entrenamiento (sin_mejora" in text:
        say("etapa 2: la primera etapa ya paró por una buena razón (lista, sin mejora o falló): no sigo")
        return
    history = [json.loads(x) for x in open(os.path.join(OUT, "historia.jsonl"), encoding="utf-8") if x.strip()]
    if not history:
        return say("etapa 2: no hay mediciones; no sigo")
    open(lock, "w").write(str(os.getpid()))
    try:
        for name in ("best-practica.json", "best.json", "informe.md"):         # lo de la etapa 1 queda aparte
            if os.path.exists(os.path.join(OUT, name)):
                os.replace(os.path.join(OUT, name), os.path.join(OUT, "etapa1-" + name))
        done = history[-1]["paso"]
        base_valid = os.path.join(OUT, "base-valid.json")
        stall_msg = ""
        while done < int(os.environ.get("TOTAL", 12000)):
            elapsed = (time.time() - STARTED) / 60
            if elapsed > MAX_MIN_TOTAL - RESERVE_MIN:
                stall_msg = "tope de tiempo ({} min)".format(int(elapsed))
                break
            say("etapa 2: entrenando {} pasos más (van {})".format(CHUNK, done))
            run(lora("--resume-adapter-file", os.path.join(AD, "adapters.safetensors"), "--iters", str(CHUNK), "--save-every", str(CHUNK),
                     "--steps-per-eval", str(CHUNK), adapter_path=AD), "el entrenamiento")
            done += CHUNK
            step_dir = os.path.join(AD, "paso-{}".format(done))
            os.makedirs(step_dir, exist_ok=True)
            for name in ("adapters.safetensors", "adapter_config.json"):
                subprocess.run(["cp", os.path.join(AD, name), step_dir])
            r = measure(step_dir, os.path.join(step_dir, "valid.json"), VALID_N)
            r["paso"] = done
            history.append(r)
            with open(os.path.join(OUT, "historia.jsonl"), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(r, ensure_ascii=False) + "\n")
            say("paso {}: {}".format(done, short(r)))
            action, why = dst.decide(history, patience_best=PATIENCE)
            if action == "sin_mejora":
                say("corto el entrenamiento (sin_mejora): " + why)
                break
            if action == "listo":
                say("corto el entrenamiento (listo): " + why)
                break
            # los checkpoints viejos que no son el mejor ni el último se borran para no llenar el disco
            keep = {dst.best_step(history), done}
            for h in history[:-1]:
                if h["paso"] not in keep:
                    subprocess.run(["rm", "-rf", os.path.join(AD, "paso-{}".format(h["paso"]))])
        if stall_msg:
            say("etapa 2: " + stall_msg)
        finish(history)
    finally:
        os.remove(lock) if os.path.exists(lock) else None


def finish(history):
    best = dst.best_step(history)
    json.dump({"paso": best}, open(os.path.join(OUT, "best.json"), "w"))
    say("3. el mejor es el paso {}: práctica ({} miradas de cada tipo)".format(best, PRACTICA_N))
    run([PY, os.path.join(HERE, "aprende_eval.py"), "--mode", "practica", "--model", MODEL, "--data", DATASET, "--adapter", os.path.join(AD, "paso-{}".format(best)),
         "--max", str(PRACTICA_N), "--out", os.path.join(OUT, "best-practica.json")], "la práctica")
    gguf = os.path.join(DATA, "qwen-destila.gguf")
    ok = subprocess.run([PY, "-m", "balancita_engine.futures_qwen_lora_adapter", os.path.join(AD, "paso-{}".format(best)), gguf],
                        env=dict(os.environ, PYTHONPATH=os.path.join(ROOT, "python"))).returncode == 0
    say("GGUF del mejor: {} (NO está cargado en ningún lado)".format(gguf) if ok else "la conversión a GGUF falló")
    run([PY, "-m", "balancita_engine.futures_qwen_destila", "informe", "--dir", OUT, "--out", os.path.join(OUT, "informe.md")], "el informe")
    say("fin. Informe: {}".format(os.path.join(OUT, "informe.md")))
