"""¿Qué hace el adaptador con la ENTRADA? (hilo «Entrenar a Qwen con LoRA», Fran: «hagamos las 3 igual»)

Para fotos de la ventana práctica (2025-10-16 en adelante, nunca el holdout) le pregunta a llama-server, con el adaptador
(``--lora 0``) o sin él (``--no-lora``), primero la línea de factores (el lado, como en el examen pero solo con la ficha real) y
después la pregunta de entrada de ``futures_qwen_lora`` (``E:v``: orden límite 30 pb / 10 pb, a mercado, confirmación 15 min,
esperar 1 h). Con las velas que siguieron calcula el neto a 4 h de la opción que eligió Qwen, de entrar a mercado (lo de hoy) y
de la mejor opción (oráculo). Solo habla con 127.0.0.1; escribe un JSON con el resumen. No toca Qwen en vivo ni su base.

Uso: PYTHONPATH=python python3 ops/qwen-lora/entry_eval.py --lora 0 [-n 300] [--from 2025-10-16] [--out entry-eval.json]
"""
import argparse
import json
import os
import random
import urllib.request

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_lora as lora
from balancita_engine import futures_qwen_trader as qt
from balancita_engine.futures_qwen_live import apply_overrides


def post(url, body):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url + "/v1/chat/completions", data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def ask(url, system, prompt, grammar, lora_field, logprobs):
    body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "max_tokens": fq.MAX_TOKENS,
            "temperature": 0, "grammar": grammar, "chat_template_kwargs": {"enable_thinking": False}, "cache_prompt": True}
    if logprobs:
        body.update(logprobs=True, top_logprobs=llm.TOP_LOGPROBS)
    if lora_field is not None:
        body["lora"] = lora_field
    return post(url, body)


def side_of(url, cfg, state_text, lora_field):
    answer = ask(url, cfg["prompt"]["system"], fq.build_prompt(state_text, fq.settings(cfg)["question"]), fq.GRAMMAR, lora_field, True)
    lean = fq.lean_of(fq.read_completion(answer)["grads"])
    return (1 if lean > 0 else -1 if lean < 0 else 0), lean


def entry_of(url, cfg, state_text, side, lora_field):
    answer = ask(url, cfg["prompt"]["system"], fq.build_prompt(state_text, lora.entry_question(side)), lora.ENTRY_GRAMMAR, lora_field, False)
    return lora.parse_entry_line(answer["choices"][0]["message"]["content"])


def mean(values):
    return sum(values) / len(values) if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8088")
    parser.add_argument("--config", default=qt.CONFIG_PATH_LIVE)
    parser.add_argument("--cache-dir", default=qt.DEFAULT_CACHE)
    parser.add_argument("--products", default="PF_XBTUSD,PF_ETHUSD")
    parser.add_argument("--from", dest="from_day", default="2025-10-16", help="ventana práctica; nunca el holdout")
    parser.add_argument("-n", type=int, default=300, help="fotos en total, repartidas por producto y mes")
    parser.add_argument("--seed", type=int, default=20261026)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--lora", help="ID[:SCALE] del adaptador cargado en llama-server")
    group.add_argument("--no-lora", action="store_true", help="el modelo base, para comparar")
    parser.add_argument("--out", default=os.path.join(qt.DATA_DIR, "entry-eval.json"))
    args = parser.parse_args()
    llm.check_loopback_url(args.url)
    cfg = apply_overrides(qt.load_config(args.config))
    holdout_ms = qt.load_holdout_ms()
    history = qt.History(args.cache_dir, holdout_ms, offline=True)
    products = [p.strip() for p in args.products.split(",") if p.strip()]
    lora_field = None if args.no_lora else qt.parse_lora(args.lora)
    to_day = qt.stamp(holdout_ms)[:10]
    photos = []
    for product in products:
        photos += lora.photos_between(history, cfg, product, args.from_day, to_day)
    chosen = lora.sample_photos(photos, max(1, args.n // len(products)), "{}:{}".format(args.seed, args.from_day))
    warm = qt.date_ms(args.from_day) - cfg["practice"]["warmup_days"] * qt.DAY_MS
    bars = {p: lora.Bars(history.bars(p, warm, holdout_ms)) for p in products}
    rows = []
    for i, photo in enumerate(chosen, 1):
        found = bars[photo["product"]].after(photo["t_ms"])
        if found is None:
            continue
        side, lean = side_of(args.url, cfg, photo["state_text"], lora_field)
        if side == 0:
            continue
        value = entry_of(args.url, cfg, photo["state_text"], side, lora_field)
        if value is None:
            continue
        c0, nxt = found
        nets = lora.entry_nets(side, c0, nxt, photo["product"])
        rows.append({"product": photo["product"], "t_ms": photo["t_ms"], "side": side, "lean": lean, "entry": value,
                     "net_chosen": nets[value], "net_market": nets[0], "net_best": max(nets.values()), "best": lora.entry_label(nets),
                     "right_side": side * photo["moves"][str(lora.LABEL_HORIZON_MIN)] > 0})
        if i % 25 == 0:
            print("{} de {} fotos".format(i, len(chosen)), flush=True)
    summary = {"lora": lora_field, "from": args.from_day, "n": len(rows), "products": {}}
    for product in ["todos"] + products:
        part = [r for r in rows if product == "todos" or r["product"] == product]
        if not part:
            continue
        summary["products"][product] = {
            "n": len(part), "acierto_lado": mean([1.0 if r["right_side"] else 0.0 for r in part]),
            "neto_elegida_bp": mean([r["net_chosen"] for r in part]), "neto_mercado_bp": mean([r["net_market"] for r in part]),
            "neto_oraculo_bp": mean([r["net_best"] for r in part]),
            "acierto_entrada": mean([1.0 if r["entry"] == r["best"] else 0.0 for r in part]),
            "eligio": {lora.ENTRY_OPTIONS[v]: sum(1 for r in part if r["entry"] == v) for v in sorted(lora.ENTRY_OPTIONS)}}
        s = summary["products"][product]
        print("{:10s} n {:4d} | lado {:.1%} | neto elegida {:+.1f} bp | a mercado {:+.1f} | oráculo {:+.1f} | eligió bien {:.1%} | {}".format(
            product, s["n"], s["acierto_lado"], s["neto_elegida_bp"], s["neto_mercado_bp"], s["neto_oraculo_bp"], s["acierto_entrada"], s["eligio"]))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"summary": summary, "rows": rows}, handle, indent=1, ensure_ascii=False)
    print("guardado en", args.out)


if __name__ == "__main__":
    main()
