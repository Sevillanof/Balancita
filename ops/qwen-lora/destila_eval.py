"""Mide si Qwen (con o sin adaptador LoRA) LEE la ficha como la fórmula, sobre una muestra fija de ``valid.jsonl`` del dataset de la
destilación (``python -m balancita_engine.futures_qwen_destila armar``): acuerdo con la fórmula, espejo (la ficha dada vuelta tiene que dar
la respuesta opuesta), costumbre (parte de la respuesta más repetida) y neto por entrada de seguir su opinión contra la fórmula sola.

Uso (Mac, venv de ops/qwen-lora/train.sh):
  python ops/qwen-lora/destila_eval.py --model MODEL --data CARPETA --out RESULTADO.json [--adapter CARPETA] [--max 200]
La muestra son grupos completos (una ficha con su espejo y sus dos órdenes de letras), siempre la misma para cualquier adaptador.
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "python"))
from aprende_eval import letter_probs  # noqa: E402
from balancita_engine import futures_qwen_aprende as ap  # noqa: E402
from balancita_engine import futures_qwen_destila as dst  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--adapter", default=None)
    parser.add_argument("--max", type=int, default=200)
    args = parser.parse_args(argv)
    import mlx.core as mx
    from mlx_lm import load

    rows = [json.loads(x) for x in open(os.path.join(args.data, "valid.jsonl"), encoding="utf-8")]
    infos = [json.loads(x) for x in open(os.path.join(args.data, "valid-info.jsonl"), encoding="utf-8")]
    picked = dst.sample_groups(infos, args.max)
    started = time.time()
    model, tok = load(args.model, adapter_path=args.adapter)
    records = []
    for i in picked:
        row, info = rows[i], infos[i]
        options = dict(re.findall(r"(?m)^([A-Z])\) (\w+)", row["messages"][1]["content"]))
        probs = letter_probs(mx, model, tok, row["messages"][:2], len(options))
        pick = ap.LETTERS[max(range(len(probs)), key=probs.__getitem__)]
        records.append({"info": info, "options": options, "answer": options.get(pick, pick), "gold": options[row["messages"][2]["content"]]})
    result = dst.valid_report(records)
    result.update(adaptador=args.adapter, segundos=round(time.time() - started), muestra=len(picked))
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
