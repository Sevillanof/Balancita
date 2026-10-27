"""Mide la OPINIÓN de Qwen (con o sin adaptador LoRA) sobre las miradas de la práctica y la compara con la fórmula sola, SIN llama-server
(hilo «Que Qwen aprenda junto al maestro»). Por cada mirada de ``practica.jsonl`` (que arma ``python -m
balancita_engine.futures_qwen_aprende dataset``) pregunta la pregunta REAL de la config en vivo en las dos órdenes de letras, promedia
la probabilidad de cada opción, y la opinión es la más probable. Después ``futures_qwen_aprende.score_opinions`` da: acierto contra la
etiqueta, neto por entrada de la opinión contra la fórmula, ganadoras, por mes, y qué pasaría si se cerrara cuando la opinión dice CERRAR.

También mide, en las miradas sin posición, si «lee la ficha» y no una costumbre: ``espejo_da_vuelta`` = en las miradas donde dijo
LARGO o CORTO, la fracción donde con la ficha dada vuelta dice el lado contrario; ``costumbre`` = la opción que más repite.

Dos modos:
  --mode valid     acierto de la letra sobre valid.jsonl (los últimos meses del entrenamiento, con el embargo de 48 h): acierto, acierto
                   por clase, reparto de lo que contesta y qué parte es la opción que más repite (costumbre). Es lo que se mira
                   para decidir cuándo cortar y qué checkpoint guardar: NO se usa la práctica para elegir.
  --mode practica  (por defecto) lo de arriba sobre practica.jsonl: opinión contra la fórmula, por mes, espejo.

Uso (Mac, venv de ops/qwen-lora/train.sh; PYTHONPATH=python):
  python ops/qwen-lora/aprende_eval.py --model MODEL --data CARPETA --out RESULTADO.json [--mode valid|practica] \
      [--adapter CARPETA_DEL_ADAPTADOR] [--max 600]
Con --max se mide una muestra repartida (la misma para cualquier adaptador). Sin --adapter es el Qwen de hoy (sin entrenar).
"""
import argparse
import collections
import json
import math
import os
import re
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


def valid_main(args):
    """Acierto de la letra sobre ``valid.jsonl`` (formato chat): la letra más probable contra la letra del ejemplo."""
    import mlx.core as mx
    from mlx_lm import load

    rows = [json.loads(line) for line in open(os.path.join(args.data, "valid.jsonl"), encoding="utf-8")]
    infos = [json.loads(line) for line in open(os.path.join(args.data, "valid-info.jsonl"), encoding="utf-8")]
    both = sample(list(zip(rows, infos)), args.max)
    rows = [r for r, _ in both]
    model, tok = load(args.model, adapter_path=args.adapter)
    hits, by_class, said, started = 0, collections.defaultdict(lambda: [0, 0]), collections.Counter(), time.time()
    flat_nets, position_gain = [], []
    for row, info in both:
        user = row["messages"][1]["content"]
        options = dict(re.findall(r"(?m)^([A-Z])\) (\w+)", user))
        gold = row["messages"][2]["content"]
        probs = letter_probs(mx, model, tok, row["messages"][:2], len(options))
        pick = ap.LETTERS[max(range(len(probs)), key=probs.__getitem__)]
        hits += pick == gold
        by_class[options[gold]][0] += pick == gold
        by_class[options[gold]][1] += 1
        said[options.get(pick, pick)] += 1
        answer = options.get(pick, pick)
        if info["kind"] == "flat":                           # the net of following the answer: the side it chose, or nothing
            flat_nets.append(info["largo_bp"] if answer == "LARGO" else info["corto_bp"] if answer == "CORTO" else 0.0)
        else:                                                # closing now instead of holding to the formula's end
            position_gain.append(info["net_now_bp"] - info["final_bp"] if answer == "CERRAR" else 0.0)
    n = len(rows)
    result = {"modo": "valid", "n": n, "acierto": round(hits / n, 4) if n else None,
              "acierto_por_clase": {k: round(v[0] / v[1], 3) for k, v in sorted(by_class.items())},
              "acierto_balanceado": round(sum(v[0] / v[1] for v in by_class.values()) / len(by_class), 4) if by_class else None,
              "neto_por_mirada_bp": round(sum(flat_nets) / len(flat_nets), 2) if flat_nets else None,
              "entradas": sum(1 for x in flat_nets if x != 0.0),
              "ganancia_por_cierre_bp": round(sum(position_gain) / len(position_gain), 2) if position_gain else None,
              "reparto": dict(said), "costumbre_parte": round(max(said.values()) / n, 3) if n else None,
              "adaptador": args.adapter, "segundos": round(time.time() - started)}
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
    print(json.dumps(result, ensure_ascii=False))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--adapter", default=None, help="carpeta con adapters.safetensors y adapter_config.json")
    parser.add_argument("--max", type=int, default=0)
    parser.add_argument("--mode", choices=("valid", "practica"), default="practica")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)
    if args.mode == "valid":
        return valid_main(args)
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
