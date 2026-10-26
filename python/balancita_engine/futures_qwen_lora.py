"""Entrenar a Qwen con LoRA: el dataset (hilo «Entrenar a Qwen con LoRA»).

Qwen en vivo (config ``live``, ficha de 8 factores) contesta una línea ``F1:v … F8:v``. Aquí se arman ejemplos para un ajuste
fino LoRA del MISMO modelo (Qwen3-4B) con fotos del pasado: la misma pregunta y el mismo STATE que ve en vivo (``make_photos``
del examen, sin modelo), y como respuesta la línea que «debió» dar: los renglones que votan (F1 F2 F3 F4 F6 F7) llevan el signo
de lo que hizo el precio en las 4 h siguientes (+2 / -2 si el movimiento fue grande, +1 / -1 si fue chico; F5 y F8 en 0). El
espejo también se enseña: la ficha dada vuelta con la línea dada vuelta.

Períodos: se entrena con fotos ANTERIORES a la ventana práctica (``TRAIN_FROM`` a ``TRAIN_TO``, velas públicas de Kraken) y se
valida con el examen en la ventana práctica (2025-10-16 a 2026-04-18, config ``qwen-lora-exam.json``). El holdout no se lee
nunca (``History`` lo rechaza).

Salida (``dataset``): ``train.jsonl`` y ``valid.jsonl`` en el formato «chat» de mlx-lm (``{"messages": [system, user,
assistant]}``) más ``meta.json`` (períodos, muestra, umbral de movimiento grande por producto, hash de la config).
``numbers``: una línea JSON por foto con los números de la ficha (F1..F7) y los movimientos, para estudios sin modelo.

Comandos: ``python -m balancita_engine.futures_qwen_lora dataset|numbers``. Nada de esto toca Qwen en vivo ni descarga modelos.
"""

import argparse
import copy
import json
import os
import random
import time

from . import futures_qwen_factors as fq
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as ex
from .futures_qwen_ficha import FACTORS, VOTING

LABEL_HORIZON_MIN = 240                      # la etiqueta: el movimiento a 4 h (el plazo al que opera y cierra Qwen en vivo)
TRAIN_FROM, TRAIN_TO = "2022-04-01", "2025-10-01"   # fotos anteriores a la ventana práctica (2025-10-16)
VALID_MONTHS = 2                             # los últimos meses del período van a valid.jsonl (solo para mirar la pérdida)
DEFAULT_PER_PRODUCT = 3000
DEFAULT_PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
DEFAULT_OUT = os.path.join(qt.DATA_DIR, "lora")
DATASET_SCHEMA = "balancita-qwen-lora-dataset.v1"


# --------------------------------------------------------------------------- photos and labels


def photos_between(history, cfg, product, from_day, to_day, log=print):
    """The exam's photos of ``[from_day, to_day)``: STATE, mirrored STATE, the numbers of the sheet and the moves. ``to_day``
    bounds the candles read (it must not pass the holdout: ``History`` refuses)."""
    cfg2 = copy.deepcopy(cfg)
    cfg2["practice"] = dict(cfg["practice"], **{"from": from_day})
    started = time.monotonic()
    photos = ex.make_photos(history, cfg2, product, qt.date_ms(to_day))
    log("fotos de {} de {} a {}: {} en {:.0f} s".format(product, from_day, to_day, len(photos), time.monotonic() - started))
    return photos


def label_values(move_bp, big_bp):
    """The 8 values Qwen should have written: the sign of the move on every voting line, 2 when the move is big."""
    if move_bp == 0:
        return [0] * len(FACTORS)
    value = (1 if move_bp > 0 else -1) * (2 if abs(move_bp) >= big_bp else 1)
    return [value if f in VOTING else 0 for f in FACTORS]


def line_of(values):
    return " ".join("{}:{}".format(f, "0" if v == 0 else "{:+d}".format(v)) for f, v in zip(FACTORS, values))


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    return ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0


def big_threshold(photos):
    """The median |move| at the label horizon of these photos: a move at or above it is «big» (+2 / -2)."""
    return median([abs(p["moves"][str(LABEL_HORIZON_MIN)]) for p in photos]) if photos else 0.0


def example(cfg, state_text, values):
    """One mlx-lm «chat» example: the system text and the user prompt exactly as llama-server gets them in the exam / live
    (``futures_qwen_factors.build_prompt``), the answer line as the assistant turn (the chat template adds the empty
    ``<think>`` block, as llama-server does with ``enable_thinking`` off)."""
    question = fq.settings(cfg)["question"]
    return {"messages": [{"role": "system", "content": cfg["prompt"]["system"]},
                         {"role": "user", "content": fq.build_prompt(state_text, question)},
                         {"role": "assistant", "content": line_of(values)}]}


def examples_of(cfg, photo, big_bp):
    """The two examples of one photo: the real sheet with the real line and the mirrored sheet with the line turned over."""
    values = label_values(photo["moves"][str(LABEL_HORIZON_MIN)], big_bp)
    return [example(cfg, photo["state_text"], values), example(cfg, photo["mirror_text"], [-v for v in values])]


# --------------------------------------------------------------------------- sampling


def month_of(t_ms):
    return qt.stamp(t_ms)[:7]


def sample_photos(photos, per_product, seed):
    """Seeded sample of ``per_product`` photos per product, spread evenly over the months (the months with fewer photos give
    what they have and the rest is filled from the others, in a seeded order)."""
    out = []
    by_product = {}
    for photo in photos:
        by_product.setdefault(photo["product"], {}).setdefault(month_of(photo["t_ms"]), []).append(photo)
    for product in sorted(by_product):
        months = by_product[product]
        rng = random.Random("{}:{}".format(seed, product))
        pools = {m: rng.sample(items, len(items)) for m, items in sorted(months.items())}
        chosen, quota = [], max(1, per_product // len(pools))
        for m in sorted(pools):
            chosen += pools[m][:quota]
            del pools[m][:quota]
        rest = [p for m in sorted(pools) for p in pools[m]]
        rng.shuffle(rest)
        chosen += rest[:max(0, per_product - len(chosen))]
        out += sorted(chosen, key=lambda p: p["t_ms"])
    return out


def split_valid(photos, valid_months):
    """Train / valid by time: the photos of the last ``valid_months`` months of the period are the validation ones."""
    months = sorted({month_of(p["t_ms"]) for p in photos})
    valid = set(months[-valid_months:]) if valid_months > 0 else set()
    return [p for p in photos if month_of(p["t_ms"]) not in valid], [p for p in photos if month_of(p["t_ms"]) in valid]


# --------------------------------------------------------------------------- writing


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    count = 0
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def build_dataset(history, cfg, out_dir, *, products=DEFAULT_PRODUCTS, from_day=TRAIN_FROM, to_day=TRAIN_TO,
                  per_product=DEFAULT_PER_PRODUCT, valid_months=VALID_MONTHS, seed=20261026, log=print):
    """``train.jsonl``, ``valid.jsonl`` and ``meta.json`` in ``out_dir``. Returns the meta."""
    rng_seed = "{}:{}:{}".format(seed, from_day, to_day)
    photos = []
    for product in products:
        photos += photos_between(history, cfg, product, from_day, to_day, log=log)
    chosen = sample_photos(photos, per_product, rng_seed)
    big = {product: big_threshold([p for p in chosen if p["product"] == product]) for product in products}
    train, valid = split_valid(chosen, valid_months)
    rows = {"train": [e for p in train for e in examples_of(cfg, p, big[p["product"]])],
            "valid": [e for p in valid for e in examples_of(cfg, p, big[p["product"]])]}
    for name in ("train", "valid"):
        random.Random(rng_seed + name).shuffle(rows[name])     # mlx-lm reads the file in order: mixed products and months
        write_jsonl(os.path.join(out_dir, name + ".jsonl"), rows[name])
    meta = {"schema": DATASET_SCHEMA, "config_hash": qt.config_hash(cfg), "prompt_version": cfg["prompt"]["version"],
            "label_horizon_min": LABEL_HORIZON_MIN, "from": from_day, "to": to_day, "products": list(products),
            "photos_available": len(photos), "photos_sampled": len(chosen), "per_product": per_product, "seed": seed,
            "valid_months": valid_months, "big_move_bp": big, "examples": {k: len(v) for k, v in rows.items()},
            "label_share": _label_share(chosen),
            "note": "Cada foto da dos ejemplos (ficha real y espejo). Etiqueta: signo del movimiento a 4 h en F1 F2 F3 F4 F6 F7, "
                    "+-2 si |movimiento| >= big_move_bp del producto, +-1 si no; F5 y F8 en 0."}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=1, ensure_ascii=False)
    log("dataset: {} fotos de {} ({} ejemplos de entrenamiento, {} de validación) en {}".format(
        len(chosen), len(photos), len(rows["train"]), len(rows["valid"]), out_dir))
    return meta


def _label_share(photos):
    moves = [p["moves"][str(LABEL_HORIZON_MIN)] for p in photos]
    n = len(moves) or 1
    return {"up": sum(1 for m in moves if m > 0) / n, "down": sum(1 for m in moves if m < 0) / n}


def numbers_rows(photos):
    """One flat row per photo: product, time, the numbers of the sheet and the moves (bp) at every horizon."""
    for p in photos:
        row = {"product": p["product"], "t_ms": p["t_ms"], "cost_bp": p["cost_bp"]}
        row.update({k: v for k, v in (p.get("ficha") or {}).items()})
        row.update({"move_{}".format(h): v for h, v in p["moves"].items()})
        yield row


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in (("dataset", "train.jsonl / valid.jsonl (formato chat de mlx-lm) con fotos del pasado"),
                       ("numbers", "una línea JSON por foto con los números de la ficha y los movimientos (sin modelo)")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--config", default=qt.CONFIG_PATH_LIVE, help="config del operador (default: la de Qwen en vivo)")
        p.add_argument("--cache-dir", default=qt.DEFAULT_CACHE, help="caché de velas (default %(default)s)")
        p.add_argument("--products", default=",".join(DEFAULT_PRODUCTS))
        p.add_argument("--from", dest="from_day", default=TRAIN_FROM)
        p.add_argument("--to", dest="to_day", default=TRAIN_TO, help="exclusivo; nunca pasa el holdout")
        p.add_argument("--offline", action="store_true", help="no descarga velas: usa solo la caché")
        if name == "dataset":
            p.add_argument("--out", default=DEFAULT_OUT)
            p.add_argument("--per-product", type=int, default=DEFAULT_PER_PRODUCT)
            p.add_argument("--valid-months", type=int, default=VALID_MONTHS)
            p.add_argument("--seed", type=int, default=20261026)
        else:
            p.add_argument("--out", required=True, help="archivo .jsonl")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    cfg = qt.load_config(args.config)
    from .futures_qwen_live import apply_overrides
    cfg = apply_overrides(cfg)
    holdout_ms = qt.load_holdout_ms()
    to_ms = qt.date_ms(args.to_day)
    if to_ms > holdout_ms:
        raise qt.TraderError("--to {} pasa el holdout ({}): no se leen esas velas".format(args.to_day, qt.stamp(holdout_ms)))
    products = [p.strip() for p in args.products.split(",") if p.strip()]
    history = qt.History(args.cache_dir, holdout_ms, offline=args.offline)
    if not history.offline:
        for product in dict.fromkeys(products + list(cfg.get("state_context") or ())):
            history.prefetch(product, qt.date_ms(args.from_day) - cfg["practice"]["warmup_days"] * qt.DAY_MS, to_ms)
    if args.command == "dataset":
        build_dataset(history, cfg, args.out, products=products, from_day=args.from_day, to_day=args.to_day,
                      per_product=args.per_product, valid_months=args.valid_months, seed=args.seed)
    else:
        photos = []
        for product in products:
            photos += photos_between(history, cfg, product, args.from_day, args.to_day)
        print("{} fotos escritas en {}".format(write_jsonl(args.out, numbers_rows(photos)), args.out))


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print("error: {}".format(error))
        raise SystemExit(2)
