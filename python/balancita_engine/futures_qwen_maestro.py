"""El maestro de operación del LoRA de Qwen (hilo «Entrenar a Qwen con LoRA», 27-oct-2026).

Fran: «lo que quiero lograr es que Qwen aprenda cuándo entrar y cuándo salir. Que busque superar las comisiones y tenga
ganancias». La etiqueta del dataset v2 (signo del movimiento a 4 h) era una moneda (52 %) y el adaptador aprendió una costumbre.
El maestro es una fórmula FIJA, guardada en el repo (``config/qwen-lora-maestro.json``), que mira los mismos números que la ficha
escribe (los que tienen dirección y cambian de signo en el espejo) y da un veredicto por foto:

    +2 entrar largo fuerte · +1 largo flojo · 0 nada · -1 corto flojo · -2 corto fuerte

Veredicto = signo de una regresión logística SIN intercepto sobre los números estandarizados (por eso el espejo da exactamente el
veredicto opuesto), y fuerza según el tamaño del puntaje: «fuerte» en el 20 % de fotos más claras del período de ajuste, «flojo» en
el 30 % siguiente, «nada» en la mitad restante. Qwen aprende a contestar el veredicto en los renglones que votan (F1 F2 F3 F4 F6 F7;
F5 y F8 en 0). La regla en paper que se midió con él (``analisis/qwen-lora/informe-maestro-operacion-27oct.md``): entrar solo
con veredicto fuerte, salir cuando el veredicto se da vuelta al menos flojo o a las 48 h, sin stop.

``fit``: ajusta el maestro con un archivo de hechos (``futures_qwen_lora facts``) y lo guarda. ``medir``: acierto y reparto de
veredictos en otro archivo. Leer el maestro y etiquetar es Python puro; solo ``fit`` necesita numpy (la CI no lo instala, por eso
se importa adentro). Nada de esto toca Qwen en vivo.
"""

import argparse
import hashlib
import json
import math
import os

from . import futures_qwen_trader as qt
from .futures_qwen_ficha import FACTORS, VOTING

DEFAULT_PATH = os.path.join(qt.ROOT, "config", "qwen-lora-maestro.json")
DEFAULT_HORIZON_MIN = 720                    # el plazo al que se ajusta la fórmula (la señal de la ficha vive entre 12 y 24 h)
STRONG_SHARE, WEAK_SHARE = 0.20, 0.50        # fuerte: 20 % de fotos más claras; flojo: hasta el 50 %; nada: el resto
L2 = 10.0                                    # penalización L2 (equivale a C = 0,1 de scikit-learn)

# Los números direccionales de la ficha: cambian de signo en el espejo (``futures_qwen_ficha.facts``).
DIRECTIONAL = ("ret_7d", "z_7d", "ret_24h", "z_24h", "ret_4h", "z_4h", "ret_1h", "z_1h", "move15_n", "pos24", "pos7",
               "since_diff", "area_signed", "area_out", "strength")
# Señales direccionales específicas para el enriquecimiento de ETH (fuerza contra BTC a 4h/24h y derivados F6).
ETH_EXTRA_DIRECTIONAL = ("strength_btc", "strength_btc_24h", "premium_bp", "long_bias", "top_long_bias", "funding_bp")
ALL_DIRECTIONAL = DIRECTIONAL + ETH_EXTRA_DIRECTIONAL
# Tamaños sin dirección (no entran en el veredicto; se guardan en los hechos para estudios y filtros).
SYMMETRIC = ("vol1h", "vol24", "realized", "range24", "range7")


def _num(val, offset=0.0, scale=1.0):
    return 0.0 if val is None else (float(val) + offset) * scale


def _extra_eth_facts(f):
    pos = f.get("pos") or {}
    return {
        "strength_btc": _num(f.get("strength_btc")),
        "strength_btc_24h": _num(f.get("strength_btc_24h")),
        "premium_bp": _num(pos.get("premium")),
        "long_bias": _num(pos.get("long"), offset=-50.0),
        "top_long_bias": _num(pos.get("top"), offset=-50.0),
        "funding_bp": _num(f.get("funding_rate"), scale=1e4),
    }


def flat_facts(f, *, extra_eth=False):
    """Los hechos de la ficha aplanados: una clave por número. ``None`` (sin área, sin otros activos) vale 0.
    Con ``extra_eth=True`` incluye además ``ETH_EXTRA_DIRECTIONAL`` (fuerza ETH/BTC 4h y 24h, prima, sesgo long/top y funding)."""
    row: dict = {}
    for k in ("1h", "4h", "24h", "7d"):
        row["ret_" + k] = float(f["ret"][k])
        row["z_" + k] = float(f["z"][k])
    row["move15_n"] = float(f["move15"]) / f["norm15"] if f["norm15"] > 0 else 0.0
    row["pos24"], row["pos7"] = float(f["pos24"]), float(f["pos7"])
    row["since_diff"] = float(f["since_lo"]) - float(f["since_hi"])      # horas desde el mínimo menos desde el máximo
    area = f.get("area")
    row["area_signed"] = 0.0 if area is None else float(area["signed"])
    row["area_out"] = 0.0 if area is None else float(area["above"] - area["below"])
    row["strength"] = _num(f.get("strength"))
    for k in SYMMETRIC:
        row[k] = float(f[k])
    if extra_eth:
        row.update(_extra_eth_facts(f))
    return row


def mirror_facts(row):
    """Los hechos del espejo: los direccionales cambian de signo, los tamaños quedan."""
    return {k: (-v if k in ALL_DIRECTIONAL else v) for k, v in row.items()}


# --------------------------------------------------------------------------- the teacher


def load(path=DEFAULT_PATH):
    with open(path, encoding="utf-8") as handle:
        teacher = json.load(handle)
    if teacher.get("schema") != "balancita-qwen-lora-maestro.v1":
        raise qt.TraderError("maestro {}: formato desconocido ({})".format(path, teacher.get("schema")))
    coef, sd = teacher.get("coeficientes") or {}, teacher.get("sd") or {}
    missing = [f for f in DIRECTIONAL if f not in coef or f not in sd] + [f for f in coef if f not in sd]
    if missing:
        raise qt.TraderError("maestro {}: faltan {}".format(path, missing))
    teacher["_path"] = path
    return teacher


def uses_extra_eth(teacher):
    """True cuando el maestro usa alguna señal de ``ETH_EXTRA_DIRECTIONAL``."""
    coef = (teacher or {}).get("coeficientes") or {}
    return any(f in coef for f in ETH_EXTRA_DIRECTIONAL)


def teacher_hash(teacher):
    body = {k: teacher[k] for k in ("coeficientes", "sd", "umbrales", "plazo_min")}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def score(teacher, row):
    """El puntaje (logit) del maestro: suma de coeficiente x número / desvío. Exactamente opuesto en el espejo."""
    coef, sd = teacher["coeficientes"], teacher["sd"]
    keys = [f for f in ALL_DIRECTIONAL if f in coef and sd.get(f, 0) > 0]
    return math.fsum(coef[f] * (row.get(f) or 0.0) / sd[f] for f in keys)


def verdict_of(teacher, s):
    """0 / ±1 / ±2 según el tamaño del puntaje contra los umbrales ``flojo`` y ``fuerte``."""
    size = abs(s)
    if size < teacher["umbrales"]["flojo"]:
        return 0
    side = 1 if s > 0 else -1
    return side * (2 if size >= teacher["umbrales"]["fuerte"] else 1)


def verdict(teacher, row):
    return verdict_of(teacher, score(teacher, row))


def label_values(teacher, row):
    """Los 8 valores que Qwen debe contestar: el veredicto en los renglones que votan, 0 en F5 y F8."""
    v = verdict(teacher, row)
    return [v if f in VOTING else 0 for f in FACTORS]


# --------------------------------------------------------------------------- fitting


def read_facts(path, from_day=None, to_day=None, products=None):
    """Filas de ``futures_qwen_lora facts`` (una por foto) dentro del período, como lista de dicts."""
    lo = qt.date_ms(from_day) if from_day else None
    hi = qt.date_ms(to_day) if to_day else None
    out = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if (lo is not None and row["t_ms"] < lo) or (hi is not None and row["t_ms"] >= hi):
                continue
            if products and row["product"] not in products:
                continue
            out.append(row)
    return out


def _matrix(rows, sd=None, features=DIRECTIONAL):
    import numpy as np

    X = np.array([[row.get(f) or 0.0 for f in features] for row in rows], dtype=float)
    if sd is None:
        sd = X.std(axis=0)
        sd[sd == 0] = 1.0
    return X / sd, sd


def logistic_no_intercept(z_mat, y, l2=L2, iters=100):
    """Regresión logística sin intercepto con penalización L2 (Newton). Minimiza sum(log(1 + exp(-t z·w))) + l2/2 |w|²
    con t = ±1: lo mismo que scikit-learn ``LogisticRegression(C=1/l2, fit_intercept=False)``."""
    import numpy as np

    w = np.zeros(z_mat.shape[1])
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-(z_mat @ w)))
        grad = z_mat.T @ (p - y) + l2 * w
        hess = (z_mat * (p * (1 - p))[:, None]).T @ z_mat + l2 * np.eye(z_mat.shape[1])
        step = np.linalg.solve(hess, grad)
        w = w - step
        if np.max(np.abs(step)) < 1e-10:
            break
    return w


def fit(rows, horizon_min=DEFAULT_HORIZON_MIN, *, strong_share=STRONG_SHARE, weak_share=WEAK_SHARE, l2=L2, note=None,
        extra_eth=False):
    """El maestro ajustado con estas filas: etiqueta = signo del movimiento a ``horizon_min``; umbrales = cuantiles del |puntaje|."""
    import numpy as np

    features = ALL_DIRECTIONAL if extra_eth else DIRECTIONAL
    key = "move_{}".format(horizon_min)
    rows = [r for r in rows if r.get(key) is not None and r[key] != 0]
    if len(rows) < 1000:
        raise qt.TraderError("maestro: hacen falta al menos 1.000 fotos con movimiento a {} min, hay {}".format(horizon_min, len(rows)))
    Z, sd = _matrix(rows, features=features)
    y = np.array([1.0 if r[key] > 0 else 0.0 for r in rows])
    w = logistic_no_intercept(Z, y, l2=l2)
    s = np.abs(Z @ w)
    teacher = {"schema": "balancita-qwen-lora-maestro.v1", "plazo_min": horizon_min,
               "ajuste": {"fotos": len(rows), "desde": qt.stamp(min(r["t_ms"] for r in rows)), "hasta": qt.stamp(max(r["t_ms"] for r in rows)),
                          "productos": sorted({r["product"] for r in rows}), "l2": l2, "acierto_signo": round(float(((Z @ w > 0) == (y > 0)).mean()), 4),
                          "fuerte_share": strong_share, "flojo_share": weak_share},
               "umbrales": {"flojo": round(float(np.quantile(s, 1 - weak_share)), 6), "fuerte": round(float(np.quantile(s, 1 - strong_share)), 6)},
               "sd": {f: round(float(v), 8) for f, v in zip(features, sd)},
               "coeficientes": {f: round(float(v), 6) for f, v in zip(features, w)},
               "regla_paper": {"entra": "veredicto fuerte (±2)", "sale": "veredicto al menos flojo del lado opuesto, o 48 h", "stop": "ninguno"},
               "nota": note or "Ajustado con `futures_qwen_maestro fit`; medición en analisis/qwen-lora/informe-maestro-operacion-27oct.md."}
    return teacher


def measure(teacher, rows):
    """Acierto del signo del veredicto contra el movimiento al plazo del maestro, reparto de veredictos y antisimetría."""
    key = "move_{}".format(teacher["plazo_min"])
    verdicts = [verdict(teacher, r) for r in rows]
    counts = {str(v): verdicts.count(v) for v in (-2, -1, 0, 1, 2)}
    judged = [(v, r[key]) for v, r in zip(verdicts, rows) if v != 0 and r.get(key)]
    strong = [(v, m) for v, m in judged if abs(v) == 2]
    hit = lambda pairs: round(sum(1 for v, m in pairs if (v > 0) == (m > 0)) / len(pairs), 4) if pairs else None
    mirror_ok = all(verdict(teacher, mirror_facts(r)) == -v for v, r in zip(verdicts, rows[:2000]))
    return {"fotos": len(rows), "reparto": counts, "acierto_signo": hit(judged), "acierto_fuerte": hit(strong),
            "share_fuerte": round(len(strong) / len(rows), 4) if rows else None, "espejo_opuesto_exacto": mirror_ok}


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("fit", help="ajusta el maestro con un archivo de hechos y lo guarda")
    p.add_argument("--facts", required=True, help="jsonl de `futures_qwen_lora facts`")
    p.add_argument("--plazo", type=int, default=DEFAULT_HORIZON_MIN, help="minutos (default %(default)s)")
    p.add_argument("--from", dest="from_day", default=None)
    p.add_argument("--to", dest="to_day", default=None, help="exclusivo")
    p.add_argument("--products", default=None, help="productos separados por coma (p. ej. PF_ETHUSD)")
    p.add_argument("--eth-features", action="store_true", help="incluye señales específicas de ETH (ETH/BTC 4h/24h y derivados F6)")
    p.add_argument("--out", default=DEFAULT_PATH)
    p.add_argument("--nota", default=None)
    m = sub.add_parser("medir", help="acierto y reparto de veredictos de un maestro sobre un archivo de hechos")
    m.add_argument("--facts", required=True)
    m.add_argument("--maestro", default=DEFAULT_PATH)
    m.add_argument("--from", dest="from_day", default=None)
    m.add_argument("--to", dest="to_day", default=None)
    m.add_argument("--products", default=None, help="productos separados por coma (p. ej. PF_ETHUSD)")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    products = [p.strip() for p in args.products.split(",") if p.strip()] if args.products else None
    rows = read_facts(args.facts, args.from_day, args.to_day, products=products)
    if args.command == "fit":
        teacher = fit(rows, args.plazo, note=args.nota, extra_eth=bool(args.eth_features))
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(teacher, handle, indent=1, ensure_ascii=False)
            handle.write("\n")
        print("maestro guardado en {} ({} fotos, acierto en ajuste {}, umbrales {})".format(
            args.out, teacher["ajuste"]["fotos"], teacher["ajuste"]["acierto_signo"], teacher["umbrales"]))
    else:
        print(json.dumps(measure(load(args.maestro), rows), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print("error: {}".format(error))
        raise SystemExit(2)
