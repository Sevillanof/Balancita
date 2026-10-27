"""¿llama-server tiene el adaptador cargado y lo aplica solo cuando se le pide? (hilo «Entrenar a Qwen con LoRA»)

Lee GET /lora-adapters y manda la MISMA ficha (un ejemplo de valid.jsonl) dos veces a /v1/chat/completions: sin el campo ``lora``
(como Qwen en vivo) y con ``lora=[{id, scale 1}]`` (como ``exam --lora 0``). Muestra la línea y la probabilidad de «+» en F1 de
cada una. Si son iguales en varias fichas, el adaptador no se está aplicando. Solo habla con 127.0.0.1; no guarda nada.

Uso: PYTHONPATH=python python3 ops/qwen-lora/check_adapter.py [--url http://127.0.0.1:8088] [--data ~/balancita-data.noindex/qwen-lora/dataset] [-n 3]
"""
import argparse
import json
import math
import os
import urllib.request

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_factors as fq


def post(url, path, body):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url + path, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def get(url, path):
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url + path, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def ask(url, messages, lora):
    body = {"messages": messages, "max_tokens": fq.MAX_TOKENS, "temperature": 0, "grammar": fq.GRAMMAR, "logprobs": True,
            "top_logprobs": llm.TOP_LOGPROBS, "chat_template_kwargs": {"enable_thinking": False}, "cache_prompt": False}
    if lora is not None:
        body["lora"] = lora
    answer = post(url, "/v1/chat/completions", body)
    result = fq.read_completion(answer)
    return result["text"], result["grads"][0], result["detail"][0]["p"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8088")
    parser.add_argument("--data", default=os.path.expanduser("~/balancita-data.noindex/qwen-lora/dataset"))
    parser.add_argument("-n", type=int, default=3)
    args = parser.parse_args()
    llm.check_loopback_url(args.url)
    adapters = get(args.url, "/lora-adapters")
    print("adaptadores en el servidor:", adapters)
    if any(float(a.get("scale", 0)) != 0 for a in adapters):
        print("ATENCION: hay un adaptador con escala distinta de 0 al arrancar: TODOS los pedidos sin campo `lora` (Qwen en vivo) lo usan. "
              "pnpm dev debe arrancar llama-server con `--lora-scaled <gguf>:0` (LLAMA_LORA, scripts/dev-provider-env.mjs).")
    with open(os.path.join(args.data, "valid.jsonl"), encoding="utf-8") as handle:
        rows = [json.loads(line) for _, line in zip(range(args.n), handle)]
    same = 0
    for row in rows:
        messages, wanted = row["messages"][:2], row["messages"][2]["content"]
        base = ask(args.url, messages, None)
        tuned = ask(args.url, messages, [{"id": 0, "scale": 1.0}])
        same += base[0] == tuned[0] and math.isclose(base[1], tuned[1], abs_tol=1e-6)
        print("etiqueta  {}\nsin lora  {}  F1 grad {:+.3f} p+ {:.3f}\ncon lora  {}  F1 grad {:+.3f} p+ {:.3f}\n".format(
            wanted, base[0], base[1], base[2]["plus"], tuned[0], tuned[1], tuned[2]["plus"]))
    print("iguales con y sin adaptador: {} de {}{}".format(same, len(rows), " -> el adaptador NO se aplica" if same == len(rows) else ""))


if __name__ == "__main__":
    main()
