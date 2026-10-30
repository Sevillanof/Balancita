"""MEDICIÓN HONESTA de la fórmula (hilo «Medir la fórmula de forma honesta», 28-oct-2026).

La auditoría del 28-oct (``analisis/auditoria-pruebas/informe.md``) encontró que el «+14.146 pb en 4 años» se midió en el mismo
período con el que se ajustaron el maestro y el portero, y que las reglas (tope, producto, tamaño, exigencia) se eligieron entre
más de 1.600 variantes mirando el mismo período. Este motor mide de otra forma, y es EL MISMO para la nube y para «Testear»:

* **Cada trimestre se reajusta con el pasado** (``fit_pairs``): el maestro y el portero de 2024T3 se ajustan con las fotos de BTC+ETH
  hasta 48 h antes de que empiece 2024T3, y operan ese trimestre sin haberlo visto. La tabla de pares se guarda en
  ``config/walkforward/pares.json`` y la lee ``futures_qwen_corta.formulas`` (``corta.pares``): el motor en vivo, la prueba de la app y
  esta medición cargan las mismas fórmulas con los mismos hashes.
* **Misma simulación**: las fotos salen de ``futures_qwen_trader_exam.make_photos`` y las entradas de ``formula_entries`` (la función que usa
  «Testear»); lo único nuevo es que la fórmula depende del trimestre de cada foto.
* **Las elecciones también se deciden con el pasado** (``choose_walk_forward``): tope de horas, producto, regulador de tamaño y
  exigencia se escogen al empezar cada trimestre mirando solo las operaciones de cada variante ya CERRADAS antes de ese día.
* **Registro de intentos** (``register``, ``trials``): cada variante medida queda anotada; el resultado dice cuántas se probaron
  (las ~1.643 de antes de la auditoría más las registradas) y corrige con el Sharpe desinflado del repo.
* **Medidor de honestidad** (``meter``): semáforo con cuántos intentos hay, qué parte del resultado está fuera del ajuste, si la práctica
  ya se usó y el resultado corregido.

Es determinista (sin azar salvo semillas fijas) y se repite con un comando:

    python -m balancita_engine.futures_walkforward run --cache-dir CACHE --work-dir TRABAJO --out SALIDA

Nada de esto lee el holdout (``History`` lo rechaza) ni llama a ningún modelo, ni toca el paper, el riesgo o los colectores.
"""

import argparse
import collections
import copy
import gzip
import hashlib
import json
import math
import os
import random
import statistics

from . import futures_qwen_analista as analista
from . import futures_qwen_corta as corta
from . import futures_qwen_destila as destila
from . import futures_qwen_exigencia as exigencia
from . import futures_qwen_maestro as maestro
from . import futures_qwen_portero as portero
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as exam
from .futures_strategy_reliability import deflated_probability

VERSION = 1
RUN_SCHEMA = "balancita-walkforward-run.v1"
CONFIG_DIR = os.path.join(qt.ROOT, "config", "walkforward")
PARES_PATH = os.path.join(CONFIG_DIR, "pares.json")
ETH_CONFIG_DIR = os.path.join(qt.DATA_DIR, "walkforward-eth", "pares")
ETH_PARES_PATH = os.path.join(ETH_CONFIG_DIR, "pares.json")
ETH_WORK_DIR = os.path.join(qt.DATA_DIR, "walkforward-eth")
BASE_REGISTRY_PATH = os.path.join(CONFIG_DIR, "intentos.json")
FACTS_FROM = destila.FACTS_FROM                  # primer día con velas para ajustar (2022-04-01)
FIRST_DAY = "2023-01-01"                         # primer día que se opera con fórmulas reajustadas
FIT_LAG_MS = 48 * qt.HOUR_MS                     # cada trimestre se ajusta hasta 48 h antes de empezar
FIT_PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
PRODUCTS = ("PF_ETHUSD", "PF_XBTUSD")
CONTEXT = ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")
PRACTICE_FROM, PRACTICE_TO = "2025-10-16", "2026-04-19"   # ya se usó para elegir reglas: no cuenta como dato fresco
LEGACY_FIT_END = "2025-09-30"                    # hasta aquí se ajustaron las fórmulas en vigor (config/qwen-lora-*.json)
PRIOR_TRIALS = 1643                              # variantes con neto contadas por la auditoría del 28-oct, antes de este registro
CAPS = (2160, None)                              # minutos: 36 h o sin tope
SIZES = ("apagado", "suave", "fuerte")
LEVELS = ((3, 3), (5, 5), (7, 7))                # exigencia (maestro, portero); 5/5 es la de paper
MIN_PAST_TRADES = 30                             # operaciones cerradas que hacen falta para elegir una variante
BOOT_DRAWS, BOOT_SEED = 500, 20261028
DAY_MS, WEEK_MS = qt.DAY_MS, 7 * qt.DAY_MS
PUBLISHED_ETH_4Y = {"neto_pb": 14146, "operaciones": 393, "nota": "analista-movimientos: fórmulas en vigor, 2022-04 → 2026-04"}


# --------------------------------------------------------------------------- how a test measures (Testear)

ENV = "QWEN_MEDICION"
MEDICIONES = ("honesta", "vigente")
DEFAULT_MEDICION = "honesta"        # «Testear» mide así si nadie pide otra cosa; «vigente» = la fórmula de paper, ajustada hasta sep-2025


def medicion(value, name="medicion"):
    if value in (None, ""):
        return DEFAULT_MEDICION
    if value not in MEDICIONES:
        raise ValueError("{}: tiene que ser {}".format(name, " o ".join(MEDICIONES)))
    return value


def medicion_from_env(env=None):
    env = os.environ if env is None else env
    return medicion(env.get(ENV))


def env_for(value=None):
    """La variable de entorno que le pasa el modo de medición al proceso de la prueba."""
    return {ENV: medicion(value)}


def test_spec(cfg, env=None):
    """La hipótesis que prueba un «Testear»: producto(s), tope, tamaño y exigencia de esa config y de las variables de la prueba (sin
    fechas ni resultados: el mismo ajuste en otra etapa no es una variante nueva)."""
    got = exigencia.from_env(env)
    spec = variant(cfg["products"], cfg["guardrails"]["max_hold_min"], analista.from_env(env), (got["maestro"], got["portero"]))
    entrada = cfg.get("entrada") or (os.environ if env is None else env).get("QWEN_ENTRADA")
    if entrada == "formula_eth":
        spec["entrada"] = "formula_eth"
    return spec


def with_pairs(cfg, pares=None):
    """La misma config pero con las fórmulas de cada trimestre (``corta.pares``); fechas, productos y tope no cambian."""
    out = copy.deepcopy(cfg)
    out["corta"] = dict(out["corta"], pares=os.path.abspath(pares or PARES_PATH))
    return out


def with_eth_formulas(cfg, medicion_mode=None, pares=None):
    """La config con las fórmulas de ETH enriquecido (``extra_eth=True``): por trimestre en modo ``honesta``, o el par 2025Q4 (ajustado hasta 2025-09-29) en ``vigente``."""
    mode = medicion(medicion_mode)
    pares_path = os.path.abspath(pares or ETH_PARES_PATH)
    out = copy.deepcopy(cfg)
    out["entrada"] = "formula_eth"
    if mode == "honesta":
        out["corta"] = dict(out["corta"], pares=pares_path)
        return out
    table = load_pairs(pares_path)
    folder = os.path.dirname(pares_path)
    pair = table["trimestres"].get("2025Q4") or table["trimestres"][sorted(table["trimestres"])[-1]]
    corta_cfg = dict(out["corta"], maestro=os.path.join(folder, pair["maestro"]), maestro_hash=pair["maestro_hash"],
                     portero=os.path.join(folder, pair["portero"]), portero_hash=pair["portero_hash"])
    corta_cfg.pop("pares", None)
    out["corta"] = corta_cfg
    return out


# --------------------------------------------------------------------------- the quarters


def quarters(holdout_ms):
    """Los trimestres que se operan: de 2023T1 hasta el último que empieza antes del holdout (el último queda corto)."""
    out = []
    for year in range(2023, 2031):
        for q in (1, 2, 3, 4):
            if destila.qstart_ms(year, q) < holdout_ms:
                out.append((year, q))
    return out


def quarter_of(t_ms):
    return corta._quarter_name(t_ms)


def year_of(t_ms):
    return int(qt.stamp(t_ms)[:4])


# --------------------------------------------------------------------------- 1. the formulas of each quarter


def facts_path(work_dir, product, *, extra_eth=False):
    return os.path.join(work_dir, "hechos{}-{}.jsonl".format("-eth" if extra_eth else "", product))


def ensure_facts(cache_dir, work_dir, log=print, *, fit_products=FIT_PRODUCTS, extra_eth=False, on_progress=None):
    """Las fotos con los números de la ficha de los productos de ajuste (solo caché). Se arman una vez por carpeta de trabajo."""
    os.makedirs(work_dir, exist_ok=True)
    paths = []
    for product in fit_products:
        path = facts_path(work_dir, product, extra_eth=extra_eth)
        if not os.path.exists(path):
            log("hechos de {}…".format(product))
            n = destila.facts_file(cache_dir, product, FACTS_FROM, PRACTICE_TO, path + ".tmp",
                                   extra_eth=extra_eth, on_progress=on_progress)
            os.replace(path + ".tmp", path)
            log("{}: {} fotos".format(product, n))
        paths.append(path)
    return paths


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, indent=1, ensure_ascii=False, sort_keys=True)
        handle.write("\n")


def fit_pairs(cache_dir, work_dir, out_dir, log=print, *, fit_products=FIT_PRODUCTS, extra_eth=False, on_progress=None):
    """El par (maestro, portero) de cada trimestre, ajustado con ``fit_products`` solo hasta 48 h antes de que empiece. Escribe los archivos y
    ``pares.json`` en ``out_dir`` (nombres relativos: la tabla se puede mover) y devuelve la tabla."""
    paths = ensure_facts(cache_dir, work_dir, log, fit_products=fit_products, extra_eth=extra_eth, on_progress=on_progress)
    holdout = qt.load_holdout_ms()
    rows = []
    for path in paths:
        rows += maestro.read_facts(path, FACTS_FROM, None, products=fit_products)
    history = qt.History(cache_dir, holdout, offline=True)
    os.makedirs(out_dir, exist_ok=True)
    table = {"schema": corta.PARES_SCHEMA, "motor": VERSION, "ajuste_desde": FACTS_FROM, "retardo_h": FIT_LAG_MS // qt.HOUR_MS,
             "productos_de_ajuste": list(fit_products), "extra_eth": bool(extra_eth), "trimestres": {}}
    label = "+".join({"PF_XBTUSD": "BTC", "PF_ETHUSD": "ETH"}.get(p, p) for p in fit_products)
    for y, q in quarters(holdout):
        name = destila.qname(y, q)
        cutoff = destila.qstart_ms(y, q) - FIT_LAG_MS
        part = [r for r in rows if r["t_ms"] < cutoff]
        note = "Reajuste trimestral: solo fotos de {} hasta {} (48 h antes de {}).".format(label, qt.stamp(cutoff), name)
        teacher = maestro.fit(part, note=note, extra_eth=extra_eth)
        m_file, p_file = "maestro-{}.json".format(name), "portero-{}.json".format(name)
        _dump(os.path.join(out_dir, m_file), teacher)
        teacher = maestro.load(os.path.join(out_dir, m_file))
        keeper = portero.fit(portero.labelled(part, teacher, history), teacher, note=note, extra_eth=extra_eth)
        _dump(os.path.join(out_dir, p_file), keeper)
        table["trimestres"][name] = {"maestro": m_file, "maestro_hash": maestro.teacher_hash(teacher),
                                     "portero": p_file, "portero_hash": portero.portero_hash(keeper)[:12],
                                     "ajustado_hasta": qt.stamp(cutoff), "fotos": len(part),
                                     "acierto_signo_ajuste": teacher["ajuste"]["acierto_signo"], "umbral_portero": keeper["umbral"]}
        log("{}: ajustado hasta {} con {} fotos (maestro {}, portero {})".format(
            name, qt.stamp(cutoff), len(part), table["trimestres"][name]["maestro_hash"], table["trimestres"][name]["portero_hash"]))
    _dump(os.path.join(out_dir, "pares.json"), table)
    return table


def ensure_eth_pairs(cache_dir=None, work_dir=None, out_dir=None, log=print, on_progress=None):
    """Asegura los pares trimestrales de ETH enriquecido (``extra_eth=True``) y devuelve la ruta de ``pares.json``."""
    out_dir = out_dir or ETH_CONFIG_DIR
    pares = os.path.join(out_dir, "pares.json")
    if not os.path.exists(pares):
        fit_pairs(cache_dir or qt.DEFAULT_CACHE, work_dir or ETH_WORK_DIR, out_dir, log=log,
                  fit_products=("PF_ETHUSD",), extra_eth=True, on_progress=on_progress)
    return pares


def load_pairs(path=PARES_PATH):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def pairs_hash(path=PARES_PATH):
    """Identidad de la tabla de pares: la tabla y los hashes de cada fórmula (no los nombres de archivo ni las notas)."""
    table = load_pairs(path)
    body = {k: {x: v[x] for x in ("maestro_hash", "portero_hash", "ajustado_hasta", "fotos")} for k, v in table["trimestres"].items()}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------- 2. the photos (the same make_photos «Testear» uses)


def honest_cfg(cfg=None, pares=PARES_PATH, products=("PF_ETHUSD",), cap_min=2160):
    """La config de la prueba en modo honesto: las fórmulas de cada trimestre (``corta.pares``), operando desde ``FIRST_DAY``."""
    from . import futures_qwen_live as live

    out = copy.deepcopy(cfg) if cfg is not None else live.apply_overrides(qt.load_config(qt.CONFIG_PATH_LIVE))
    out["corta"] = dict(out["corta"], pares=os.path.abspath(pares))
    out["practice"] = dict(out["practice"], **{"from": FIRST_DAY})
    out["exam"] = dict(out["exam"], **{"from": FIRST_DAY, "products": list(products)})
    out["products"] = list(products)
    out["guardrails"] = dict(out["guardrails"], max_hold_min=cap_min)
    return out


def candle_signature(history, product):
    bars = history.bars(product, qt.date_ms(FACTS_FROM), history.holdout_ms)
    closes = math.fsum(float(b["close"]) for b in bars)
    return "{}:{}:{}:{:.4f}".format(len(bars), bars[0]["bucket_start"] if bars else 0, bars[-1]["bucket_start"] if bars else 0, closes)


def _photo_key(pares, product, cap_min, signature):
    return hashlib.sha256(json.dumps([VERSION, pairs_hash(pares), product, cap_min, signature]).encode("utf-8")).hexdigest()[:16]


def base_photos(cache_dir, work_dir, product, cap_min, pares=PARES_PATH, log=print):
    """Las fotos de ``product`` de todo el período con las fórmulas de cada trimestre y la operación de cada lado (tope ``cap_min``).
    Quedan en caché en ``work_dir``; el movimiento (volatilidad de 24 h contra su mediana de 90 días) viaja en cada foto, así el regulador
    de tamaño y la exigencia se aplican después sin repetir las fotos."""
    holdout = qt.load_holdout_ms()
    history = qt.History(cache_dir, holdout, offline=True)
    key = _photo_key(pares, product, cap_min, candle_signature(history, product))
    path = os.path.join(work_dir, "fotos-{}-{}.json.gz".format(product, cap_min or "sin-tope"))
    if os.path.exists(path):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            head = json.loads(handle.readline())
            if head.get("clave") == key:
                return [json.loads(line) for line in handle]
    cfg = honest_cfg(pares=pares, products=(product,), cap_min=cap_min)
    log("fotos de {} (tope {} min)…".format(product, cap_min))
    photos = exam.make_photos(history, cfg, product, holdout, texts=False, start_ms=qt.date_ms(FIRST_DAY), moves=False)
    warm = qt.date_ms(FIRST_DAY) - cfg["practice"]["warmup_days"] * qt.DAY_MS
    movement = analista.Movement(history.bars(product, warm - analista.EXTRA_DAYS * qt.DAY_MS, holdout))
    slim = []
    for p in photos:
        op = p.get("operacion")
        if not op:
            continue
        slim.append({"product": product, "t_ms": p["t_ms"], "mov": movement.active(p["t_ms"]),
                     "operacion": {**{k: op[k] for k in ("maestro", "puntaje", "portero_si", "portero_p", "largo", "corto")},
                                   "noticias_si": bool(op.get("noticias_si"))}})
    with gzip.open(path + ".tmp", "wt", encoding="utf-8") as handle:
        handle.write(json.dumps({"clave": key}) + "\n")
        for p in slim:
            handle.write(json.dumps(p, sort_keys=True) + "\n")
    os.replace(path + ".tmp", path)
    log("{}: {} fotos".format(product, len(slim)))
    return slim


def _build_job(job):
    cache_dir, work_dir, product, cap_min, pares = job
    base_photos(cache_dir, work_dir, product, cap_min, pares, log=lambda *a: None)
    return job[2:4]


def build_all_photos(cache_dir, work_dir, pares=PARES_PATH, jobs=1, log=print):
    """Las fotos de cada (producto, tope). Con ``jobs`` > 1 se arman en procesos aparte (cada una tarda minutos)."""
    todo = [(cache_dir, work_dir, product, cap, pares) for product in PRODUCTS for cap in CAPS]
    if jobs > 1:
        import concurrent.futures
        with concurrent.futures.ProcessPoolExecutor(max_workers=jobs) as pool:
            for done in pool.map(_build_job, todo):
                log("fotos listas: {}".format(done))
    else:
        for job in todo:
            _build_job(job)
            log("fotos listas: {}".format(job[2:4]))
    return {(job[2], job[3]): base_photos(cache_dir, work_dir, job[2], job[3], pares, log=lambda *a: None) for job in todo}


# --------------------------------------------------------------------------- 3. a variant over the photos


def variant(products=("PF_ETHUSD",), cap_min=2160, size="apagado", levels=(5, 5)):
    return {"productos": sorted(products), "tope_min": cap_min, "tamano": size, "exigencia": list(levels)}


BASELINE = variant()                              # el esquema congelado (v9): ETH, tope 36 h, tamaño 1, exigencia 5/5


def variant_id(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def variant_text(v):
    names = {"PF_ETHUSD": "ETH", "PF_XBTUSD": "BTC"}
    return "{} · {} · tamaño {} · exigencia {}/{}".format(
        "+".join(names.get(p, p) for p in v["productos"]), "tope {} h".format(v["tope_min"] // 60) if v["tope_min"] else "sin tope",
        v["tamano"], *v["exigencia"])


class _Stored:
    """El «movimiento» ya medido de una foto, con la forma que pide ``analista.sized``."""

    def __init__(self, value):
        self.value = value

    def active(self, *_args):
        return self.value


_THRESHOLDS = {}


def _formulas_at(pares, name, levels):
    """(maestro, portero) del trimestre ``name`` con esos niveles de exigencia: las funciones de siempre (``corta.formulas``)."""
    key = (os.path.abspath(pares), name, tuple(levels))
    if key not in _THRESHOLDS:
        cfg = {"corta": {"pares": os.path.abspath(pares)}}
        if tuple(levels) != (exigencia.DEFAULT, exigencia.DEFAULT):
            cfg["exigencia"] = {"maestro": levels[0], "portero": levels[1]}
        year, q = int(name[:4]), int(name[5])
        _THRESHOLDS[key] = corta.formulas(cfg, destila.qstart_ms(year, q))
    return _THRESHOLDS[key]


def trades_for(photos, product, v, pares=PARES_PATH):
    """Las operaciones de ``product`` con la variante ``v`` (tope y producto ya elegidos al traer las fotos): entradas con la misma
    función que «Testear» (``exam.formula_entries``) tras aplicar la exigencia y el tamaño. Lista de dicts, por tiempo."""
    levels = tuple(v["exigencia"])
    mode = v["tamano"]
    size_cfg = {"analista": {"modo": mode}}
    flagged = []
    for p in photos:
        t_ms = p["t_ms"]
        teacher, keeper = _formulas_at(pares, quarter_of(t_ms), levels)
        op = p["operacion"]
        verdict = maestro.verdict_of(teacher, op["puntaje"])
        portero_ok = bool(op["portero_p"] >= keeper["umbral"])
        noticias_ok = bool(op.get("noticias_si"))
        op = dict(op, maestro=verdict, portero_si=portero_ok, noticias_si=noticias_ok)
        if abs(verdict) == 2 and (portero_ok or noticias_ok):
            op = analista.sized(size_cfg, op, _Stored(p.get("mov")), t_ms)
        flagged.append({"product": product, "t_ms": t_ms, "operacion": op})
    out = []
    for row, side in exam.formula_entries(flagged):
        o = exam._op_side(row, side)
        out.append({"product": product, "t_in": row["t_ms"], "t_out": o["salida_ms"], "side": side, "net": o["neto_bp"],
                    "motivo": o["motivo"], "tamano": row["operacion"].get("tamano", 1.0)})
    return out


def variant_trades(photo_sets, v, pares=PARES_PATH, cache=None):
    """Las operaciones de la variante en todos sus productos. ``cache`` evita repetir producto+tope+tamaño+exigencia."""
    out = []
    for product in v["productos"]:
        key = (product, v["tope_min"], v["tamano"], tuple(v["exigencia"]))
        if cache is not None and key in cache:
            part = cache[key]
        else:
            part = trades_for(photo_sets[(product, v["tope_min"])], product, v, pares)
            if cache is not None:
                cache[key] = part
        out += part
    return sorted(out, key=lambda t: (t["t_in"], t["product"]))


# --------------------------------------------------------------------------- 4. the choices, decided with the past only


def grid():
    out = []
    for products in (("PF_ETHUSD",), ("PF_ETHUSD", "PF_XBTUSD")):
        for cap in CAPS:
            for size in SIZES:
                for levels in LEVELS:
                    out.append(variant(products, cap, size, levels))
    return out


def choose_walk_forward(by_variant, quarter_list, default_id, min_trades=MIN_PAST_TRADES):
    """Al empezar cada trimestre se elige la variante con más neto sumando SOLO las operaciones que ya cerraron antes de ese día (y con
    al menos ``min_trades``); sin pasado suficiente vale la de ``default_id``. Devuelve ``(operaciones, elecciones)``: las operaciones
    de la variante elegida que entran en ese trimestre. Límite conocido: si la elección cambia con una posición abierta, esa posición
    no se traslada (cada trimestre cuenta sus propias entradas)."""
    chosen, picks = [], []
    for y, q in quarter_list:
        q0, q1 = destila.qstart_ms(y, q), destila.qend_ms(y, q)
        best, best_score, scores = default_id, None, {}
        for vid, trades in by_variant.items():
            past = [t["net"] for t in trades if t["t_out"] < q0]
            if len(past) >= min_trades:
                scores[vid] = math.fsum(past)
        if scores:
            top = max(scores, key=lambda k, sc=scores: (sc[k], k == default_id))
            if scores[top] > scores.get(default_id, -math.inf):
                best, best_score = top, scores[top]
        picks.append({"trimestre": destila.qname(y, q), "variante": best, "con_pasado": bool(scores),
                      "neto_pasado_pb": None if best_score is None else round(best_score, 1)})
        chosen += [t for t in by_variant[best] if q0 <= t["t_in"] < q1]
    return chosen, picks


# --------------------------------------------------------------------------- 5. the numbers


def bootstrap_ic(trades, draws=BOOT_DRAWS, seed=BOOT_SEED):
    """IC 90 % del neto medio por operación, remuestreando semanas enteras (semilla fija)."""
    weeks = collections.defaultdict(list)
    for t in trades:
        weeks[t["t_in"] // WEEK_MS].append(t["net"])
    keys = sorted(weeks)
    if len(keys) < 5:
        return [None, None]
    rng = random.Random(seed)
    means = []
    for _ in range(draws):
        pool = []
        for _ in keys:
            pool += weeks[keys[rng.randrange(len(keys))]]  # NOSONAR
        means.append(math.fsum(pool) / len(pool) if pool else 0.0)
    means.sort()
    return [round(means[int(draws * 0.05)], 1), round(means[int(draws * 0.95) - 1], 1)]


def summarize(trades, *, since_ms=None, trials=1):
    """Operaciones, neto total (pb sobre 100 USD, ya ponderado por el tamaño), por año, por trimestre, práctica, IC y Sharpe desinflado."""
    rows = [t for t in trades if since_ms is None or t["t_in"] >= since_ms]
    if not rows:
        return {"operaciones": 0, "neto_pb": 0, "por_anio": {}, "por_trimestre": {}}
    nets = [t["net"] for t in rows]
    by_year, by_quarter = collections.defaultdict(list), collections.defaultdict(list)
    for t in rows:
        by_year[str(year_of(t["t_in"]))].append(t["net"])
        by_quarter[quarter_of(t["t_in"])].append(t["net"])
    practice = [t["net"] for t in rows if t["t_in"] >= qt.date_ms(PRACTICE_FROM)]
    reasons = collections.defaultdict(list)
    for t in rows:
        reasons[t["motivo"]].append(t["net"])
    dsr = deflated_probability(nets, max(1, trials))
    raw = deflated_probability(nets, 1)
    return {"operaciones": len(rows), "neto_pb": round(math.fsum(nets)), "por_operacion_pb": round(statistics.fmean(nets), 1),
            "ganadoras": round(sum(1 for n in nets if n > 0) / len(nets), 3),
            "por_anio": {k: {"operaciones": len(v), "neto_pb": round(math.fsum(v))} for k, v in sorted(by_year.items())},
            "por_trimestre": {k: round(math.fsum(v)) for k, v in sorted(by_quarter.items())},
            "trimestres_positivos": "{}/{}".format(sum(1 for v in by_quarter.values() if math.fsum(v) > 0), len(by_quarter)),
            "practica": {"operaciones": len(practice), "neto_pb": round(math.fsum(practice))},
            "por_motivo": {k: {"operaciones": len(v), "neto_pb": round(math.fsum(v))} for k, v in sorted(reasons.items())},
            "ic90_por_operacion_pb": bootstrap_ic(rows),
            "prob_no_es_suerte": None if dsr is None else round(dsr, 3),
            "prob_sin_descontar_intentos": None if raw is None else round(raw, 3), "intentos_considerados": max(1, trials)}


# --------------------------------------------------------------------------- 6. the log of attempts


REGISTRY_ENV = "BALANCITA_WF_INTENTOS"


def local_registry_path(env=None):
    """El registro de esta máquina: ``data/qwen-trader/walkforward/intentos.jsonl`` (``BALANCITA_WF_INTENTOS`` lo cambia, p. ej. en pruebas)."""
    env = os.environ if env is None else env
    return env.get(REGISTRY_ENV) or os.path.join(qt.DATA_DIR, "walkforward", "intentos.jsonl")


def _base_registry(path=BASE_REGISTRY_PATH):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"previos": PRIOR_TRIALS, "ids": {}}


def _local_registry(path):
    out = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    row = json.loads(line)
                    out[row["id"]] = row
    except FileNotFoundError:
        pass
    return out


def trials(local_path=None, base_path=BASE_REGISTRY_PATH):
    """Cuántas variantes se probaron: las de antes del registro (auditoría) más las distintas anotadas (repo + esta máquina)."""
    base = _base_registry(base_path)
    ids = set(base.get("ids", {})) | set(_local_registry(local_path or local_registry_path()))
    return int(base.get("previos", PRIOR_TRIALS)) + len(ids)


def register(spec, *, medicion, resumen=None, local_path=None, base=False, base_path=BASE_REGISTRY_PATH):
    """Anota una variante (idempotente: la misma variante se cuenta una vez). ``spec`` identifica la hipótesis: variante + modo de
    medición, sin fechas ni resultados. ``base=True`` la anota en el archivo del repo (corridas de la nube); si no, en esta máquina."""
    ident = hashlib.sha256(json.dumps([medicion, spec], sort_keys=True).encode("utf-8")).hexdigest()[:12]
    row = {"id": ident, "medicion": medicion, "variante": spec, "motor": VERSION}
    if resumen:
        row["resumen"] = resumen
    if base:
        data = _base_registry(base_path)
        data.setdefault("ids", {})[ident] = {k: row[k] for k in ("medicion", "variante", "motor")}
        os.makedirs(os.path.dirname(base_path), exist_ok=True)
        _dump(base_path, data)
    else:
        path = local_path or local_registry_path()
        if ident not in _local_registry(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
    return ident


# --------------------------------------------------------------------------- 7. the honesty meter


def _thousands(n):
    return "{:,}".format(int(n)).replace(",", ".")


def _outside_share(trades, medicion, fit_end_ms):
    if not trades:
        return None
    if medicion == "honesta":
        return 1.0
    end = fit_end_ms if fit_end_ms is not None else qt.date_ms(LEGACY_FIT_END) + DAY_MS
    return sum(1 for t in trades if t["t_in"] >= end) / len(trades)


def _meter_verdict(touched, outside, dsr, uses_practice, n_trades, attempts):
    if touched:
        return "rojo", ["se leyó el holdout"]
    if outside is None or dsr is None:
        return "amarillo", ["todavía no hay operaciones suficientes para juzgar"]
    if outside < 0.5:
        return "rojo", ["solo el {} % del resultado está fuera del ajuste de la fórmula".format(round(outside * 100))]
    luck_msg = "en estas {} operaciones y con {} intentos, la probabilidad de que no sea suerte es de {} %".format(
        n_trades, attempts, round(dsr * 100)
    )
    if dsr < 0.5:
        return "rojo", [luck_msg]
    if dsr >= 0.95 and not uses_practice and outside >= 0.95:
        return "verde", ["todo está fuera del ajuste y supera el descuento por intentos"]
    reasons = [luck_msg] if dsr < 0.95 else []
    if uses_practice:
        reasons.append("incluye la práctica, que ya se usó para elegir reglas")
    if outside < 0.95:
        reasons.append("el {} % está fuera del ajuste".format(round(outside * 100)))
    return "amarillo", reasons


def meter(trades, *, medicion, trial_count, fit_end_ms=None):
    """El MEDIDOR DE HONESTIDAD de un resultado: semáforo (verde / amarillo / rojo) y una línea con la razón."""
    nets = [t["net"] for t in trades]
    holdout = qt.load_holdout_ms()
    touched = any(t["t_out"] >= holdout for t in trades)
    outside = _outside_share(trades, medicion, fit_end_ms)
    uses_practice = any(t["t_in"] >= qt.date_ms(PRACTICE_FROM) for t in trades)
    dsr = deflated_probability(nets, max(1, trial_count)) if len(nets) >= 3 else None
    raw = deflated_probability(nets, 1) if len(nets) >= 3 else None
    color, reasons = _meter_verdict(touched, outside, dsr, uses_practice, len(nets), _thousands(trial_count))
    text = "; ".join(reasons)
    return {"semaforo": color, "motivo": text[:1].upper() + text[1:] + ".",
            "intentos": trial_count, "operaciones": len(nets), "fuera_del_ajuste_pct": None if outside is None else round(outside * 100, 1),
            "practica_usada": True, "incluye_practica": uses_practice, "practica": {"desde": PRACTICE_FROM, "hasta": PRACTICE_TO},
            "holdout_intacto": not touched, "holdout_desde": PRACTICE_TO,
            "prob_no_es_suerte": None if dsr is None else round(dsr, 3),
            "prob_sin_descontar_intentos": None if raw is None else round(raw, 3), "medicion": medicion}


# --------------------------------------------------------------------------- 8. the run


KEY_MEASUREMENTS = (
    ("tope", "Tope de 36 h contra sin tope (solo ETH)", (variant(cap_min=2160), variant(cap_min=None))),
    ("producto", "Solo ETH contra BTC + ETH (tope 36 h)", (variant(), variant(("PF_ETHUSD", "PF_XBTUSD")))),
    ("tamano", "Regulador de tamaño: apagado, 1,25/0,75 y 1,5/0,5 (ETH, tope 36 h)",
     (variant(size="apagado"), variant(size="suave"), variant(size="fuerte"))),
    ("exigencia", "Exigencia 3, 5 y 7 (ETH, tope 36 h)", (variant(levels=(3, 3)), variant(levels=(5, 5)), variant(levels=(7, 7)))),
)


def run(cache_dir, work_dir, out_dir, *, pares=None, jobs=1, register_base=False, local_registry=None, log=print):
    """La medición completa: fórmulas por trimestre, fotos, variantes, medidas clave año por año y elección con el pasado."""
    holdout = qt.load_holdout_ms()
    pares = pares or PARES_PATH
    if not os.path.exists(pares):
        fit_pairs(cache_dir, work_dir, os.path.dirname(pares), log)
    photos = build_all_photos(cache_dir, work_dir, pares, jobs, log)
    table = load_pairs(pares)
    quarter_list = quarters(holdout)
    cache = {}
    by_id, specs = {}, {}
    for v in grid():
        vid = variant_id(v)
        specs[vid] = v
        by_id[vid] = variant_trades(photos, v, pares, cache)
    for v in (variant(("PF_XBTUSD",)),):                      # BTC sola, solo para decir cuánto pierde
        by_id[variant_id(v)] = variant_trades(photos, v, pares, cache)
        specs[variant_id(v)] = v
    selected, picks = choose_walk_forward({k: by_id[k] for k in by_id if specs[k]["productos"] != ["PF_XBTUSD"]}, quarter_list, variant_id(BASELINE))
    selection_spec = {"elige": "con el pasado", "rejilla": len(grid()), "minimo_operaciones": MIN_PAST_TRADES}
    for vid, v in specs.items():
        register(v, medicion="honesta", base=register_base, local_path=local_registry)
    register(selection_spec, medicion="honesta", base=register_base, local_path=local_registry)
    n_trials = trials(local_registry)
    first_q3 = destila.qstart_ms(2023, 3)
    summary = lambda trades, since=None: summarize(trades, since_ms=since, trials=n_trials)
    result = {"schema": RUN_SCHEMA, "motor": VERSION, "pares": pairs_hash(pares), "trimestres": len(table["trimestres"]),
              "periodo": {"desde": FIRST_DAY, "hasta": qt.stamp(holdout - 1)}, "intentos": n_trials,
              "previos_a_la_auditoria": PRIOR_TRIALS, "publicado_antes": PUBLISHED_ETH_4Y,
              "congelado": {"variante": BASELINE, "texto": variant_text(BASELINE),
                            "desde_2023T1": summary(by_id[variant_id(BASELINE)]), "desde_2023T3": summary(by_id[variant_id(BASELINE)], first_q3)},
              "elegido_con_el_pasado": {"desde_2023T1": summary(selected), "desde_2023T3": summary(selected, first_q3), "elecciones": picks},
              "btc_sola": summary(by_id[variant_id(variant(("PF_XBTUSD",)))]), "medidas": {}}
    for key, title, variants_ in KEY_MEASUREMENTS:
        result["medidas"][key] = {"titulo": title, "variantes": [
            {"variante": v, "texto": variant_text(v), "desde_2023T1": summary(by_id[variant_id(v)]),
             "desde_2023T3": summary(by_id[variant_id(v)], first_q3)} for v in variants_]}
    result["medidor"] = meter(by_id[variant_id(BASELINE)], medicion="honesta", trial_count=n_trials)
    result["medidor_elegido"] = meter(selected, medicion="honesta", trial_count=n_trials)
    os.makedirs(out_dir, exist_ok=True)
    _dump(os.path.join(out_dir, "resultado.json"), result)
    with open(os.path.join(out_dir, "operaciones-congelado.csv"), "w", encoding="utf-8") as handle:
        handle.write("producto,entrada_ms,salida_ms,lado,neto_pb,motivo,tamano\n")
        for t in by_id[variant_id(BASELINE)]:
            handle.write("{},{},{},{},{:.4f},{},{}\n".format(t["product"], t["t_in"], t["t_out"], t["side"], t["net"], t["motivo"], t["tamano"]))
    with open(os.path.join(out_dir, "informe.md"), "w", encoding="utf-8") as handle:
        handle.write(report(result))
    return result


def _pb(value):
    return "—" if value is None else "{:+,}".format(int(round(value))).replace(",", ".")


def _years(summary_):
    return dict((summary_.get("por_anio") or {}).items())


def _pct(value):
    return "—" if value is None else "{} %".format(round(value * 100))


def _year_table(rows, years):
    head = ("| Variante | " + " | ".join(years) + " | Total | Operaciones | No es suerte: sin descontar / descontando intentos |\n|---|"
            + "---|" * (len(years) + 3) + "\n")
    body = ""
    for text, s in rows:
        by = _years(s)
        cells = [_pb(by[y]["neto_pb"]) if y in by else "—" for y in years]
        body += "| {} | {} | **{}** | {} | {} / {} |\n".format(
            text, " | ".join(cells), _pb(s.get("neto_pb")), s.get("operaciones"),
            _pct(s.get("prob_sin_descontar_intentos")), _pct(s.get("prob_no_es_suerte")))
    return head + body


def report(result):
    years = [str(y) for y in range(2023, 2027)]
    frozen, picked = result["congelado"], result["elegido_con_el_pasado"]
    lines = ["# Medición honesta de la fórmula (reajuste trimestral)", "",
             "Cada trimestre el maestro y el portero se reajustan SOLO con lo anterior (hasta 48 h antes) y operan el trimestre siguiente sin verlo, "
             "de {} a {}. Pares: {}. Netos en puntos base sobre 100 USD, con costos y con el tamaño de cada operación. "
             "Mismo motor que «Testear» (fotos de ``make_photos``, entradas de ``formula_entries``).".format(
                 result["periodo"]["desde"], result["periodo"]["hasta"], result["pares"]), "",
             "Variantes probadas en total: **{}** ({} anteriores a la auditoría + {} anotadas en el registro).".format(
                 _thousands(result["intentos"]), _thousands(result["previos_a_la_auditoria"]),
                 _thousands(result["intentos"] - result["previos_a_la_auditoria"])), "",
             "## Esquema congelado (ETH, tope 36 h, tamaño 1, exigencia 5/5): honesto contra lo publicado", "",
             "| | Operaciones | Neto |", "|---|---|---|",
             "| Publicado antes (fórmula ajustada en el mismo período que se midió) | {} | {} |".format(
                 result["publicado_antes"]["operaciones"], _pb(result["publicado_antes"]["neto_pb"])),
             "| Honesto desde 2023T1 | {} | {} |".format(frozen["desde_2023T1"]["operaciones"], _pb(frozen["desde_2023T1"]["neto_pb"])),
             "| Honesto desde 2023T3 (con historia suficiente para ajustar) | {} | {} |".format(
                 frozen["desde_2023T3"]["operaciones"], _pb(frozen["desde_2023T3"]["neto_pb"])), "",
             _year_table([("Congelado (ETH, 36 h, tamaño 1, exigencia 5/5)", frozen["desde_2023T1"])], years), ""]
    f1 = frozen["desde_2023T1"]
    lines += ["Por operación: {} pb de media, intervalo del 90 % (semanas remuestreadas) de {} a {}; positivos {} trimestres; salidas: {}. "
              "La práctica (16-oct-2025 → 18-abr-2026) aporta {} pb en {} operaciones.".format(
                  f1["por_operacion_pb"], f1["ic90_por_operacion_pb"][0], f1["ic90_por_operacion_pb"][1], f1["trimestres_positivos"],
                  ", ".join("{} {} op. ({} pb)".format(k, v["operaciones"], _pb(v["neto_pb"])) for k, v in f1["por_motivo"].items()),
                  _pb(f1["practica"]["neto_pb"]), f1["practica"]["operaciones"]), ""]
    lines += ["## Las reglas elegidas con el pasado", "",
              "Al empezar cada trimestre se elige, entre {} combinaciones de tope, producto, tamaño y exigencia, la que más sumó con las operaciones "
              "ya cerradas; sin pasado suficiente vale el esquema congelado.".format(len(grid())), "",
              _year_table([("Congelado", frozen["desde_2023T1"]), ("Reglas elegidas cada trimestre con el pasado", picked["desde_2023T1"])], years), ""]
    for key, block in result["medidas"].items():
        lines += ["## " + block["titulo"], "", _year_table([(x["texto"], x["desde_2023T1"]) for x in block["variantes"]], years), ""]
    lines += ["## BTC sola (tope 36 h)", "", _year_table([("BTC · tope 36 h · tamaño apagado · exigencia 5/5", result["btc_sola"])], years), ""]
    meter_ = result["medidor"]
    lines += ["## Medidor de honestidad (esquema congelado)", "",
              "**{}**. {} Fuera del ajuste: {} %. Holdout intacto: {}. La corrección por intentos es la del repo (Sharpe desinflado con {} intentos): "
              "es severa porque trata cada variante como un intento independiente.".format(
                  meter_["semaforo"].upper(), meter_["motivo"], meter_["fuera_del_ajuste_pct"], "sí" if meter_["holdout_intacto"] else "NO",
                  _thousands(meter_["intentos"])), ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--cache-dir", default=qt.DEFAULT_CACHE)
    common.add_argument("--work-dir", required=True, help="carpeta de trabajo (hechos y fotos en caché)")
    common.add_argument("--fit-products", default=None, help="productos para ajustar los pares (p. ej. PF_ETHUSD; default PF_XBTUSD,PF_ETHUSD)")
    pairs = sub.add_parser("pares", parents=[common], help="ajusta las fórmulas de cada trimestre")
    pairs.add_argument("--out", default=CONFIG_DIR)
    r = sub.add_parser("run", parents=[common], help="la medición completa")
    r.add_argument("--out", required=True)
    r.add_argument("--pares", default=None, help="tabla de pares (default config/walkforward/pares.json; si no existe se ajusta)")
    r.add_argument("--jobs", type=int, default=1)
    r.add_argument("--registrar-base", action="store_true", help="anota las variantes en config/walkforward/intentos.json (nube)")
    sub.add_parser("intentos", help="cuántas variantes se probaron")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    fit_products = tuple(p.strip() for p in args.fit_products.split(",") if p.strip()) if getattr(args, "fit_products", None) else FIT_PRODUCTS
    if args.command == "pares":
        fit_pairs(args.cache_dir, args.work_dir, args.out, fit_products=fit_products)
    elif args.command == "run":
        result = run(args.cache_dir, args.work_dir, args.out, pares=args.pares, jobs=args.jobs, register_base=args.registrar_base)
        print(json.dumps({k: result[k] for k in ("pares", "intentos", "congelado", "medidor")}, ensure_ascii=False, indent=1))
    else:
        print(trials())


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print("error: {}".format(error))
        raise SystemExit(2)
