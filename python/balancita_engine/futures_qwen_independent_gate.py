"""Autonomous keeper: raw facts in, LONG/SHORT/WAIT vote out. Never reads Maestro predictions."""

import argparse
import hashlib
import json
import math
import os

from . import futures_qwen_trader as qt
from . import futures_qwen_funding as funding_models

SCHEMA = "balancita-portero-autonomo.v1"
FEATURES = (
    "ret_1h", "ret_4h", "ret_24h", "ret_7d", "z_1h", "z_4h", "z_24h", "z_7d",
    "move15_n", "pos24", "pos7", "since_diff", "area_signed", "area_out", "strength",
    "vol1h", "vol24", "realized", "range24", "range7",
)
ACTIONS = ("LARGO", "CORTO", "ESPERAR")
_MODELS = {}


def _validate_fit_time(model):
    if type(model.get("fit_until_ms")) is not int or model["fit_until_ms"] <= 0:
        raise qt.TraderError("Portero autónomo: fecha de ajuste inválida.")
    if model["fit_until_ms"] > qt.load_holdout_ms():
        raise qt.HoldoutError("Portero autónomo: el ajuste no puede alcanzar la reserva.")
    last_label = model.get("last_label_end_ms")
    if last_label is not None and (type(last_label) is not int or not 0 < last_label < model["fit_until_ms"]):
        raise qt.TraderError("Portero autónomo: una etiqueta alcanza o supera el corte.")


def _validate_coefficients(model, n):
    sequences = [model.get("mean") or [], model.get("sd") or []]
    for action in ACTIONS:
        head = model["heads"][action]
        sequences.append(head.get("coef") or [])
        if type(head.get("intercept")) not in (int, float) or not math.isfinite(head["intercept"]):
            raise qt.TraderError("Portero autónomo: intercepto inválido.")
    if any(len(x) != n or any(type(v) not in (int, float) or not math.isfinite(v) for v in x) for x in sequences):
        raise qt.TraderError("Portero autónomo: dimensiones o coeficientes inválidos.")
    if any(v <= 0 for v in model["sd"]):
        raise qt.TraderError("Portero autónomo: escala no positiva.")


def validate(model):
    features = model.get("features") or []
    if model.get("schema") != SCHEMA or not features or len(set(features)) != len(features):
        raise qt.TraderError("Portero autónomo: modelo o variables inválidos.")
    if any(f not in FEATURES for f in features):
        raise qt.TraderError("Portero autónomo: solo se aceptan hechos de mercado, no predicciones ajenas.")
    _validate_fit_time(model)
    if model.get("horizon_min") != 720 or set(model.get("heads") or {}) != set(ACTIONS):
        raise qt.TraderError("Portero autónomo: horizonte o clases inválidos.")
    _validate_coefficients(model, len(features))
    return model


def vote(model, facts):
    values = []
    for key, mean, sd in zip(model["features"], model["mean"], model["sd"]):
        value = facts.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise qt.TraderError("Portero autónomo: falta un hecho válido ({})".format(key))
        values.append((value - mean) / sd)
    scores = {
        action: model["heads"][action]["intercept"] + math.fsum(
            c * x for c, x in zip(model["heads"][action]["coef"], values))
        for action in ACTIONS
    }
    if any(not math.isfinite(value) for value in scores.values()):
        raise qt.TraderError("Portero autónomo: el cálculo de la decisión no es finito.")
    peak = max(scores.values())
    weights = {k: math.exp(v - peak) for k, v in scores.items()}
    total = math.fsum(weights.values())
    support = {k: v / total for k, v in weights.items()}
    winners = [k for k, v in scores.items() if abs(v - peak) <= 1e-12]
    chosen = winners[0] if len(winners) == 1 and support[winners[0]] >= 0.5 else "ESPERAR"
    return {"side": {"LARGO": 1, "CORTO": -1, "ESPERAR": 0}[chosen],
            "chosen": chosen, "support": support, "horizon_min": model["horizon_min"]}


def load(spec):
    path = spec.get("path")
    expected = spec.get("sha256")
    if not isinstance(path, str) or not isinstance(expected, str) or len(expected) != 64:
        raise qt.TraderError("Portero autónomo: hacen falta path y sha256.")
    path = path if os.path.isabs(path) else os.path.join(qt.ROOT, "config", path)
    key = (os.path.abspath(path), expected)
    if key not in _MODELS:
        with open(path, "rb") as handle:
            body = handle.read()
        if hashlib.sha256(body).hexdigest() != expected:
            raise qt.TraderError("Portero autónomo: el modelo no coincide con su identidad.")
        _MODELS[key] = validate(json.loads(body))
    return _MODELS[key]


def read(spec, facts, *, at_ms=None):
    model = load(spec)
    if at_ms is not None and (type(at_ms) is not int or at_ms < model["fit_until_ms"]):
        raise qt.TraderError("Portero autónomo: no se puede usar un ajuste posterior a la decisión.")
    result = vote(model, facts)
    return dict(result, model_sha256=spec["sha256"], fit_until_ms=model["fit_until_ms"])


def _training_rows(rows, fit_until_ms):
    if type(fit_until_ms) is not int or fit_until_ms <= 0:
        raise qt.TraderError("Portero autónomo: fecha de ajuste inválida.")
    if fit_until_ms > qt.load_holdout_ms():
        raise qt.HoldoutError("No se entrena con la reserva.")
    kept = []
    for row in rows:
        start = row.get("t_ms")
        if type(start) is not int or start <= 0:
            raise qt.TraderError("Portero autónomo: fecha de ejemplo inválida.")
        if start + 720 * qt.MINUTE_MS >= fit_until_ms:
            continue
        if any(type(row.get(key)) not in (int, float) or not math.isfinite(row[key])
               for key in ("long_net_bp", "short_net_bp")):
            raise qt.TraderError("Portero autónomo: resultado de entrenamiento inválido.")
        kept.append(row)
    if len(kept) < 1000:
        raise qt.TraderError("Portero autónomo: hacen falta 1000 etiquetas anteriores al corte.")
    return kept


def _target_action(row):
    if max(row["long_net_bp"], row["short_net_bp"]) <= 0:
        return "ESPERAR"
    return "LARGO" if row["long_net_bp"] > row["short_net_bp"] else "CORTO"


def fit(rows, *, fit_until_ms):
    """Cold fit with fully funded fixed-12h labels, purged at the requested historical cutoff."""
    kept = _training_rows(rows, fit_until_ms)
    try:
        import numpy as np
    except ImportError as error:
        raise qt.TraderError("El ajuste del portero autónomo requiere NumPy en el intérprete de entrenamiento.") from error
    x = np.asarray([[r[f] for f in FEATURES] for r in kept], dtype=float)
    if not np.isfinite(x).all():
        raise qt.TraderError("Portero autónomo: hay datos no finitos.")
    labels = [_target_action(row) for row in kept]
    if set(labels) != set(ACTIONS):
        raise qt.TraderError("Portero autónomo: faltan clases en el ajuste.")
    mean, sd = x.mean(axis=0), x.std(axis=0)
    sd[sd == 0] = 1
    z = np.column_stack((np.ones(len(x)), (x - mean) / sd))
    penalty = np.full(z.shape[1], 10.0)
    penalty[0] = 0
    heads = {}
    for action in ACTIONS:
        y = np.asarray([float(label == action) for label in labels])
        weights = np.zeros(z.shape[1])
        for _ in range(100):
            scores = z @ weights
            p = np.exp(-np.logaddexp(0, -scores))
            gradient = z.T @ (p - y) + penalty * weights
            hessian = (z * (p * (1 - p))[:, None]).T @ z + np.diag(penalty)
            step = np.linalg.solve(hessian, gradient)
            weights -= step
            if not np.isfinite(weights).all():
                raise qt.TraderError("Portero autónomo: el ajuste no es finito.")
            if float(np.max(np.abs(step))) < 1e-8:
                break
        else:
            raise qt.TraderError("Portero autónomo: el ajuste no convergió.")
        heads[action] = {"coef": weights[1:].tolist(), "intercept": float(weights[0])}
    return validate({
        "schema": SCHEMA, "features": list(FEATURES), "mean": mean.tolist(), "sd": sd.tolist(),
        "heads": heads, "horizon_min": 720, "fit_until_ms": int(fit_until_ms),
        "last_label_end_ms": max(r["t_ms"] + 720 * qt.MINUTE_MS for r in kept),
        "cold_start": True, "target": "net_12h_after_costs_and_observed_funding",
        "training_rows": len(kept), "historical_exploration": True,
        "support_is_calibrated_profit_probability": False,
    })


def fit_candidates(rows, *, fit_until_ms):
    """Two cold experts on the same purged raw data, without loading or sharing predictions."""
    from . import futures_qwen_maestro as maestro
    kept = _training_rows(rows, fit_until_ms)
    if any(row.get("product") != "PF_ETHUSD" or type(row.get("move_720")) not in (int, float)
           or not math.isfinite(row["move_720"]) for row in kept):
        raise qt.TraderError("Candidatos: hacen falta hechos de ETH y resultados válidos a 12 h.")
    keeper = fit(kept, fit_until_ms=fit_until_ms)
    basis = {row.get("funding_model", funding_models.LEGACY_MODEL) for row in kept}
    if len(basis) != 1:
        raise qt.TraderError("No se mezclan etiquetas con modelos de funding distintos.")
    model = next(iter(basis))
    keeper["funding_model"] = model
    teacher = maestro.fit(kept, horizon_min=720, note="Candidato en frío; historial explorado, no validación a ciegas.")
    teacher["provenance"] = {
        "cold_start": True, "fit_until_ms": fit_until_ms,
        "last_label_end_ms": max(row["t_ms"] + 720 * qt.MINUTE_MS for row in kept if row["move_720"] != 0),
        "historical_exploration": True, "target": "direction_12h", "independent_raw_features": True,
        "funding_model": model,
    }
    teacher["regla_paper"] = {
        "rol": "solo predicción de dirección a 12 h",
        "ejecucion": "el coordinador aplica las reglas de entrada y salida; este archivo no las fija",
    }
    return {"maestro": teacher, "portero": keeper}


def funded_examples(facts, history, funding, cutoff):
    """Fixed-horizon labels use the same fills, fees and exact funding settlement as paper execution."""
    skipped = {"missing_price": 0, "missing_funding": 0}
    facts = [row for row in facts if row["product"] == "PF_ETHUSD" and row["t_ms"] + 720 * qt.MINUTE_MS < cutoff]
    if not facts:
        return [], skipped
    prices = {int(bar["bucket_start"]) + qt.BAR_MS: qt.D(str(bar["close"]))
              for bar in history.bars("PF_ETHUSD", min(row["t_ms"] for row in facts) - qt.BAR_MS, cutoff, fill=False)}
    line = qt.FundingLine(funding)
    rows = []
    for row in facts:
        start, end = row["t_ms"], row["t_ms"] + 720 * qt.MINUTE_MS
        first, last = prices.get(start), prices.get(end)
        if first is None or last is None:
            skipped["missing_price"] += 1
            continue
        if not first.is_finite() or not last.is_finite() or min(first, last) <= 0:
            raise qt.TraderError("Etiquetas: precio observado inválido.")
        sides = {}
        for side in ("LONG", "SHORT"):
            entry = qt.entry_fill(first, side, "PF_ETHUSD")
            position = qt.Position(
                side=side, entry_ms=start, entry_px=entry, qty=qt.D(100) / entry,
                notional_usd=qt.D(100), funding_model=funding_models.EXACT_MODEL)
            sides[side] = qt.settle("PF_ETHUSD", position, last, "strategy_exit", end, line, qt.D(100))
        if any(value["funding_status"] != "complete" for value in sides.values()):
            skipped["missing_funding"] += 1
            continue
        rows.append(dict(
            row, long_net_bp=sides["LONG"]["net_bp"], short_net_bp=sides["SHORT"]["net_bp"],
            move_720=float((last / first - 1) * 10000), funding_model=funding_models.EXACT_MODEL))
    return rows, skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facts", required=True)
    parser.add_argument("--cache-dir", default=qt.DEFAULT_CACHE)
    parser.add_argument("--market-db", default=os.path.join(qt.ROOT, "server", "data", "dev-live", "futures-market.sqlite"),
                        help="Read-only archive of observed Kraken absolute funding")
    parser.add_argument("--until", required=True, help="Exclusive YYYY-MM-DD cutoff before the reserve")
    parser.add_argument("--out", required=True, help="New candidate file; never overwritten")
    parser.add_argument("--maestro-out", required=True, help="New cold Maestro candidate; never overwritten")
    args = parser.parse_args(argv)
    cutoff = qt.date_ms(args.until)
    holdout = qt.load_holdout_ms()
    if cutoff > holdout:
        raise qt.HoldoutError("El corte alcanza la reserva.")
    if os.path.abspath(args.out) == os.path.abspath(args.maestro_out):
        raise qt.TraderError("Los dos expertos necesitan archivos de salida diferentes.")
    if os.path.lexists(args.out) or os.path.lexists(args.maestro_out):
        raise qt.TraderError("El modelo de salida ya existe; elegí una versión nueva.")
    history = qt.History(args.cache_dir, holdout, offline=True)
    funding = funding_models.from_archive(args.market_db, "PF_ETHUSD", until_ms=cutoff)
    facts = []
    with open(args.facts, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            start = row["t_ms"]
            end = start + 720 * qt.MINUTE_MS
            if row["product"] != "PF_ETHUSD" or end >= cutoff:
                continue
            facts.append(row)
    rows, skipped = funded_examples(facts, history, funding, cutoff)
    candidates = fit_candidates(rows, fit_until_ms=cutoff)
    body = (json.dumps(candidates["portero"], sort_keys=True, indent=1) + "\n").encode()
    teacher_body = (json.dumps(candidates["maestro"], sort_keys=True, indent=1) + "\n").encode()
    from . import futures_qwen_maestro as maestro
    teacher_hash = maestro.teacher_hash(candidates["maestro"])
    from . import futures_walkforward as wf
    wf.register({"expert": SCHEMA, "sha256": hashlib.sha256(body).hexdigest(),
                 "maestro_hash": teacher_hash,
                 "fit_until_ms": cutoff, "funding_model": funding_models.EXACT_MODEL,
                 "historical_exploration": True}, medicion="vigente")
    for path, content in ((args.out, body), (args.maestro_out, teacher_body)):
        with open(path, "xb") as handle:
            handle.write(content)
    print(json.dumps({"path": args.out, "sha256": hashlib.sha256(body).hexdigest(),
                      "maestro_path": args.maestro_out, "maestro_hash": teacher_hash,
                      "training_rows": candidates["portero"]["training_rows"], "funding_model": funding_models.EXACT_MODEL,
                      "skipped": skipped, "activated": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
