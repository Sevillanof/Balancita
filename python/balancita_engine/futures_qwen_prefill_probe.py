"""Short probe of how much of the prompt llama-server reuses between the option orders of one question.

Asks ``--decisions`` real-shaped ``trade_action`` decisions (every option order, like ``order_debias``) against a
running llama-server and prints, per order, the tokens processed (``prompt_n``), reused (``cache_n``) and the
prompt time. Run it once per set of server flags (``LLAMA_UBATCH``, ``LLAMA_CTX_CHECKPOINTS``) to pick the one
that reuses the shared prefix; the answers are also compared with the first pass to show the numerical drift.
About 3 queries per decision: ``--decisions 8`` takes seconds.
"""

import argparse
import json
import os
import random
import statistics

from . import futures_llm_decisions as llm


def sample_state(rng):
    """A STATE shaped like the replay's (same fields and lengths), with random numbers."""
    names = ("c25-pullback-perp-v1", "c26-reversion-perp-v1", "c27-breakout-perp-v1", "c28-adapter-perp-v1")
    parts = []
    for name in names:
        p = [rng.random() for _ in range(3)]
        total = sum(p)
        p = [x / total for x in p]
        best = ("buy", "hold", "sell")[p.index(max(p))]
        parts.append("{} buy={:.2f} hold={:.2f} sell={:.2f} ({})".format(name, p[0], p[1], p[2], best))
    return "\n".join((
        "regime: range",
        "returns_bp: 1m={:+.1f} 5m={:+.1f} 15m={:+.1f} 60m={:+.1f}".format(*[rng.uniform(-20, 20) for _ in range(4)]),
        "dist_atr: ema9={:.2f} ema21={:.2f} sma50={:.2f}".format(*[rng.uniform(-3, 3) for _ in range(3)]),
        "rsi14: {:.1f}".format(rng.uniform(20, 80)),
        "atr_bp: {:.1f}".format(rng.uniform(2, 10)),
        "volume_rel: {:.2f}".format(rng.uniform(0.3, 2)),
        "strategy_signals: " + "; ".join(parts),
        "strategy_consensus: buy=0.20 hold=0.60 sell=0.20",
        "strategy_reliability: " + "; ".join("{} unmeasured".format(n) for n in names),
        "lessons: none yet",
    ))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--decisions", type=int, default=8)
    parser.add_argument("--question", default="trade_action")
    parser.add_argument("--llama-url")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    env = dict(os.environ)
    provider = llm.LlamaCppProvider(args.llama_url or llm.llama_url(env), llm.model_ref(env), timeout=120.0)
    if not provider.health():
        raise SystemExit("llama-server is not ready")
    question = llm.load_questions()[args.question]
    prompts = llm.load_prompt_config()
    template = prompts["templates"][prompts["default_version"]]
    calibration = llm.load_calibration()
    temperature = llm.temperature_for(calibration, question["id"], question["version"])
    rng = random.Random(args.seed)
    rows = []
    for index in range(args.decisions):
        state = sample_state(rng)
        for position, order in enumerate(llm.option_orders(question)):
            variant = llm.permuted(question, order)
            before = dict(provider.perf)
            answer = llm.ask_model(provider, llm.build_prompt(state, variant, template), llm.question_letters(variant),
                                   variant, temperature, template, prompts["probability_source"])
            now = provider.perf
            rows.append({"decision": index, "order": position, "probabilities": answer["result"]["probabilities"],
                         "prompt_n": now["prompt_n"] - before.get("prompt_n", 0),
                         "cache_n": now["cache_n"] - before.get("cache_n", 0),
                         "prompt_ms": now["prompt_ms"] - before.get("prompt_ms", 0),
                         "latency_ms": now["latency_ms"] - before.get("latency_ms", 0)})
    for position in sorted({r["order"] for r in rows}):
        sub = [r for r in rows if r["order"] == position]
        print("order {}: prompt_n {:.0f}  cache_n {:.0f}  prompt_ms {:.0f}  latency_ms {:.0f} (medians)".format(
            position, *[statistics.median(r[k] for r in sub) for k in ("prompt_n", "cache_n", "prompt_ms", "latency_ms")]))
    print(json.dumps(provider.perf_summary(), sort_keys=True))
    for row in rows[:3]:
        print(json.dumps(row["probabilities"], sort_keys=True))


if __name__ == "__main__":
    main()
