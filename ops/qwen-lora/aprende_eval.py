"""Mide la OPINIÓN de Qwen (con o sin adaptador LoRA) sobre las miradas de la práctica y la compara con la fórmula sola, SIN llama-server
(hilo «Que Qwen aprenda junto al maestro»). Por cada mirada de ``practica.jsonl`` (que arma ``python -m
balancita_engine.futures_qwen_aprende dataset``) pregunta la pregunta REAL de la config en vivo en las dos órdenes de letras, promedia
la probabilidad de cada opción, y la opinión es la más probable. Después ``futures_qwen_aprende.score_opinions`` da: acierto contra la
etiqueta, neto por entrada de la opinión contra la fórmula, ganadoras, por mes, y qué pasaría si se cerrara cuando la opinión dice CERRAR.

También mide, en las miradas sin posición, si «lee la ficha» y no una costumbre: ``espejo_da_vuelta`` = en las miradas donde dijo
LARGO o CORTO, la fracción donde con la ficha dada vuelta dice el lado contrario; ``costumbre`` = la opción que más repite.

Uso (Mac, venv de ops/qwen-lora/train.sh; PYTHONPATH=python):
  python ops/qwen-lora/aprende_eval.py --model MODEL --data CARPETA_CON_practica.jsonl --out RESULTADO.json \
      [--adapter CARPETA_DEL_ADAPTADOR | --adapters CARPETA --step 1500] [--max 600]
Con --max se mide una muestra repartida (la misma para cualquier adaptador). Sin --adapter es el Qwen de hoy (sin entrenar).
"""
import argparse
import collections
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python"))
from balancita_engine import futures_qwen_aprende as ap  # noqa: E402
from balancita_engine import futures_qwen_trader as qt  # noqa: E402


def letter_probs(mx, model, tok, messages, n_letters):
    prompt = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
    ids = mx.array([tok.encode(prompt, add_special_tokens=False)])
    logits = model(ids)[0, -1].astype(mx.float32)
    letter_ids = [tok.encode(ap.LETTERS[i], add_special_tokens=False)[0] for i in range(n_letters)]
    picked = [float(logits[i]) for i in letter_ids]
    top = max(picked)
    exps = [math.exp(x - top) for x in picked]
    total = sum(exps)
    return [e / total for e in exps]


def opinion_of(mx, model, tok, cfg, row, mirror=False):
    """``{opción: probabilidad media sobre las órdenes}`` y la opción elegida."""
    mean = collections.defaultdict(float)
    prompts = ap.prompts_for(cfg, row, mirror)
    for messages, ids in prompts:
        for option, p in zip(ids, letter_probs(mx, model, tok, messages, len(ids))):
            mean[option] += p / len(prompts)
    return max(mean, key=mean.get), dict(mean)


def sample(rows, limit):
    if not limit or len(rows) <= limit:
        return rows
    step = len(rows) / limit
    return [rows[int(i * step)] for i in range(limit)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--adapter", default=None, help="carpeta con adapters.safetensors y adapter_config.json")
    parser.add_argument("--max", type=int, default=0)
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)
    import mlx.core as mx
    from mlx_lm import load

    cfg = qt.load_config(args.config or qt.CONFIG_PATH_LIVE)
    rows = [json.loads(line) for line in open(os.path.join(args.data, "practica.jsonl"), encoding="utf-8")]
    flat = sample(sorted((r for r in rows if r["kind"] == "flat"), key=lambda r: r["t_ms"]), args.max)
    position = sample(sorted((r for r in rows if r["kind"] == "position"), key=lambda r: r["t_ms"]), args.max)
    started = time.time()
    model, tok = load(args.model, adapter_path=args.adapter)
    said, flips, sided = {}, 0, 0
    for i, row in enumerate(flat + position):
        choice, probs = opinion_of(mx, model, tok, cfg, row)
        said[(row["kind"], row["product"], row["t_ms"])] = choice
        if row["kind"] == "flat" and choice in ("LARGO", "CORTO"):
            sided += 1
            mirrored, _ = opinion_of(mx, model, tok, cfg, row, mirror=True)
            flips += mirrored == ap.MIRROR_LABEL[choice]
        if (i + 1) % 50 == 0:
            print("{} / {} ({} s)".format(i + 1, len(flat) + len(position), round(time.time() - started)), flush=True)
    result = ap.score_opinions(flat, position, lambda r: said[(r["kind"], r["product"], r["t_ms"])])
    result["reparto"] = dict(collections.Counter(said.values()))
    result["costumbre"] = max(result["reparto"], key=result["reparto"].get)
    result["espejo_da_vuelta"] = round(flips / sided, 3) if sided else None
    result["miradas"] = {"sin_posicion": len(flat), "con_posicion": len(position)}
    result["adaptador"] = args.adapter
    result["segundos"] = round(time.time() - started)
    result["formula"] = ap.score_opinions(flat, position, lambda r: r["formula"])
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
    print(json.dumps({k: result[k] for k in ("acierto_sin_posicion", "acierto_con_posicion", "entradas", "formula_entradas",
                                             "cierres", "formula_cierres", "reparto", "espejo_da_vuelta")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
