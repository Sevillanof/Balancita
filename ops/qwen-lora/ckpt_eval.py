"""Mide un adaptador LoRA (mlx) o sus checkpoints sobre pares real/espejo de valid.jsonl, SIN llama-server: reparto del valor de
F1, acuerdo con la etiqueta (el veredicto del maestro en el dataset v3), si el espejo da vuelta el lado, si contesta idéntico al
espejo y la pérdida media por token de la respuesta. Es la medición que faltó la noche del 26 al 27 de octubre (hilo «Entrenar a
Qwen con LoRA»): a los 500 pasos el adaptador ya contestaba un valor fijo y la pérdida (0,044) no bajó más en las 7 horas siguientes.

Gate antes de llevar un adaptador a llama-server: ``espejo_da_vuelta`` >= 0,9 y ``acuerdo_maestro`` >= 0,85.

Uso (en la Mac, con el venv de ops/qwen-lora/train.sh):
  python ops/qwen-lora/ckpt_eval.py --model MODEL --data DATASET --adapters ADAPTERS --out OUTDIR [--pairs 25] [--steps base,500,1000]
  python ops/qwen-lora/ckpt_eval.py ... --file RUTA.safetensors        (un archivo de adaptador suelto, p. ej. paso-1500.safetensors)
Imprime una línea JSON por adaptador medido. `base` = el modelo sin adaptador (no sigue el formato: sirve de referencia de pérdida).
"""
import argparse
import collections
import json
import os
import re
import sys
import time

VOTERS = ("F1", "F2", "F3", "F4", "F6", "F7")


def key_of(user):
    """Clave que comparten la ficha real y su espejo: los números (sin signo) de las líneas F1 y F2."""
    f1 = re.search(r"F1 Tendencia.*", user).group(0)
    f2 = re.search(r"F2 .*", user).group(0)
    return tuple(re.findall(r"\d+,\d+", f1 + f2))


def direction_pairs(valid_path, limit):
    """Pares (real, espejo) de ejemplos de dirección de valid.jsonl (en el orden del archivo)."""
    groups = collections.defaultdict(list)
    with open(valid_path, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            answer = row["messages"][-1]["content"]
            if answer.startswith("E:"):
                continue
            groups[key_of(row["messages"][1]["content"])].append(row)
    pairs = [g for g in groups.values() if len(g) == 2]          # with the v3 labels a sheet and its mirror can both be 0
    return pairs[:limit]


def values_of(text):
    return {k: int(v) for k, v in re.findall(r"(F\d):([+-]?\d)", text)}


def sign(v):
    return (v > 0) - (v < 0)


def adapter_dir(out_dir, adapters, step=None, file=None):
    """mlx_lm carga adaptadores desde una carpeta con adapters.safetensors y adapter_config.json: se arma con enlaces."""
    if step == "base":
        return None
    src = file or os.path.join(adapters, "{:07d}_adapters.safetensors".format(int(step)))
    if not os.path.exists(src):
        src = os.path.join(adapters, "adapters.safetensors")
    name = os.path.splitext(os.path.basename(file))[0] if file else str(step)
    target = os.path.join(out_dir, name)
    os.makedirs(target, exist_ok=True)
    for link, source in (("adapters.safetensors", src), ("adapter_config.json", os.path.join(adapters, "adapter_config.json"))):
        path = os.path.join(target, link)
        if os.path.islink(path) or os.path.exists(path):
            os.remove(path)
        os.symlink(os.path.abspath(source), path)
    return target


def answer_loss(mx, model, prompt_ids, answer_ids):
    ids = mx.array([prompt_ids + answer_ids])
    logits = model(ids)[0]
    lp = logits[len(prompt_ids) - 1:-1].astype(mx.float32)
    lp = lp - mx.logsumexp(lp, axis=-1, keepdims=True)
    nll = -mx.take_along_axis(lp, mx.array(answer_ids)[:, None], axis=-1)[:, 0]
    return float(mx.mean(nll))


def measure(label, pairs, model_path, adapter_path):
    import mlx.core as mx
    from mlx_lm import generate, load

    started = time.time()
    model, tok = load(model_path, adapter_path=adapter_path)
    f1 = collections.Counter()
    agree = agree_sign = zeros = n = 0
    flips = sided = same = 0
    losses = []
    for pair in pairs:
        outs, labs = [], []
        for row in pair:
            answer = row["messages"][-1]["content"]
            prompt = tok.apply_chat_template(row["messages"][:2], add_generation_prompt=True, tokenize=False, enable_thinking=False)
            text = generate(model, tok, prompt=prompt, max_tokens=40, verbose=False).strip().splitlines()
            vals = values_of(text[0] if text else "")
            lab = values_of(answer)
            v1 = vals.get("F1")
            f1[str(v1)] += 1
            n += 1
            if v1 == lab["F1"]:                                   # exactly the teacher's verdict (0, ±1 or ±2)
                agree += 1
            if v1 is not None and sign(v1) == sign(lab["F1"]):   # at least its side (0 counts as a side of its own)
                agree_sign += 1
            if any(vals.get(k) == 0 for k in VOTERS):
                zeros += 1
            prompt_ids = tok.encode(prompt, add_special_tokens=False)
            answer_ids = tok.encode(answer + "<|im_end|>", add_special_tokens=False)
            losses.append(answer_loss(mx, model, prompt_ids, answer_ids))
            outs.append(v1)
            labs.append(lab["F1"])
        if None in outs:
            continue
        if labs[0] != 0:                                          # a pair with a side: the mirror must take the other one
            sided += 1
            if outs[0] != 0 and sign(outs[0]) == -sign(outs[1]):
                flips += 1
        if outs[0] == outs[1] and outs[0] != 0:                   # the same non-zero answer to a sheet and its mirror: a habit
            same += 1
    del model
    mx.clear_cache()
    return {"paso": label, "fichas": n, "F1": dict(f1), "acuerdo_maestro": round(agree / n, 3) if n else None,
            "acuerdo_signo": round(agree_sign / n, 3) if n else None,
            "espejo_da_vuelta": round(flips / sided, 3) if sided else None, "espejo_identico": round(same / len(pairs), 3),
            "algun_0_en_votantes": zeros, "perdida_respuesta": round(sum(losses) / len(losses), 4) if losses else None,
            "segundos": round(time.time() - started)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True, help="carpeta del dataset (valid.jsonl)")
    parser.add_argument("--adapters", required=True, help="carpeta de mlx_lm.lora (checkpoints y adapter_config.json)")
    parser.add_argument("--out", required=True, help="carpeta de trabajo para los enlaces (no se escribe nada más)")
    parser.add_argument("--pairs", type=int, default=25)
    parser.add_argument("--steps", default=None, help="coma: base,500,1000,... (NNNNNNN_adapters.safetensors; si falta, adapters.safetensors)")
    parser.add_argument("--file", default=None, help="un archivo .safetensors suelto en vez de --steps")
    args = parser.parse_args(argv)
    pairs = direction_pairs(os.path.join(args.data, "valid.jsonl"), args.pairs)
    print("pares real/espejo: {}".format(len(pairs)), flush=True)
    if not pairs:
        sys.exit("valid.jsonl sin pares de dirección")
    runs = [(os.path.splitext(os.path.basename(args.file))[0], adapter_dir(args.out, args.adapters, file=args.file))] if args.file else \
        [(step, adapter_dir(args.out, args.adapters, step=step)) for step in (args.steps or "base").split(",")]
    for label, path in runs:
        print(json.dumps(measure(label, pairs, args.model, path), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
