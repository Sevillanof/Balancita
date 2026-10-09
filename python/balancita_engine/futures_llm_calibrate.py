"""Fit the calibration temperature T of ``trade_action`` by time (QC-03). Offline, never run by process Q.

The stored probabilities are ``softmax(logprob / T_stored)`` over buy / hold / sell, so for any other
temperature ``p' ∝ p ** (T_stored / T')`` renormalized: no model call is needed. T' is searched on a
grid (``T_MIN`` to ``T_MAX``) for the lowest log-loss against the action that turned out right
(``futures_llm_calibration.right_actions``, after costs).

Honest by construction: the older ``FIT_SHARE`` of the scored decisions fits T, the newer rest only
validates it (time order, never random). A temperature is written to ``config/decision-calibration.json``
(``--write``) only when it beats T=1 on the validation part by ``MIN_GAIN`` log-loss and both parts have
``MIN_PER_PART`` decisions; otherwise the file is left alone and the report says why. Process Q reads
that file when it starts, so a changed T only affects new decisions and the question version stays.
"""

import json
import math
import os
import sys

from .futures_costs import DEFAULT_PRODUCT, round_trip_cost_bps
from .futures_llm_calibration import ACTIONS, EPS, right_actions
from .futures_llm_scores import QUESTION_ID, HORIZON_MIN, product_report

FIT_SHARE = 0.7
MIN_PER_PART = 100
MIN_GAIN = 0.002  # log-loss nats
T_MIN, T_MAX, T_STEPS = 0.5, 50.0, 121  # log-spaced: a model saying 99.8 % needs a T well above 5


def grid():
    ratio = (T_MAX / T_MIN) ** (1 / (T_STEPS - 1))
    return sorted({round(T_MIN * ratio ** i, 4) for i in range(T_STEPS)} | {1.0})


def rescale(probs, stored_t, new_t):
    """Probabilities of the same logprobs under ``new_t`` instead of ``stored_t``."""
    weights = [max(float(probs[a]), EPS) ** (stored_t / new_t) for a in ACTIONS]
    total = sum(weights)
    return [w / total for w in weights]


def log_loss(pairs, new_t):
    loss = 0.0
    for row, right in pairs:
        p = rescale(row["probabilities"], float(row.get("temperature") or 1.0), new_t)
        loss -= math.log(max(p[ACTIONS.index(right)], EPS))
    return loss / len(pairs)


def fit(pairs):
    """``(best_t, log_loss at best_t)`` on ``pairs``."""
    return min(((t, log_loss(pairs, t)) for t in grid()), key=lambda item: (item[1], abs(item[0] - 1.0)))


def rows_from_run(run_path, market_db_path):
    """Scored rows of one replay run DB (``futures_replay``): the same shape as ``futures_llm_scores`` rows.

    Replay answers were asked with the temperature of the calibration file at that time (1.0 unless
    ``--stored-temperature`` says otherwise).
    """
    import sqlite3

    from .futures_replay import load_range
    from .futures_replay_compare import HORIZON_MIN as COMPARE_HORIZON, read_run
    from .futures_verdicts import ONE_MINUTE_MS

    meta, _ = read_run(run_path)
    db = sqlite3.connect("file:{}?mode=ro".format(run_path), uri=True)
    try:
        decisions = [json.loads(payload) for (payload,) in db.execute(
            "SELECT payload FROM replay_qwen_decision ORDER BY id")]
    finally:
        db.close()
    ones, _ = load_range(market_db_path, meta["product_id"], meta["start_ms"],
                         meta["end_ms"] + COMPARE_HORIZON * ONE_MINUTE_MS)
    closes = {c["bucket_start"]: float(c["close"]) for c in ones}
    rows = []
    for d in sorted(decisions, key=lambda item: item["bucket_start"]):
        entry, later = closes.get(d["bucket_start"]), closes.get(d["bucket_start"] + COMPARE_HORIZON * ONE_MINUTE_MS)
        if entry and later and d.get("probabilities"):
            rows.append({"status": "scored", "chosen": d["chosen"], "probabilities": d["probabilities"],
                         "gross_bp": (later - entry) / entry * 10_000, "temperature": 1.0})
    return rows, meta["product_id"]


def calibrate(rows, round_trip_bp):
    pairs = right_actions(rows, float(round_trip_bp))
    cut = int(len(pairs) * FIT_SHARE)
    older, newer = pairs[:cut], pairs[cut:]
    result = {"decisions": len(pairs), "fit_decisions": len(older), "validation_decisions": len(newer),
              "temperature": 1.0, "accepted": False}
    if len(older) < MIN_PER_PART or len(newer) < MIN_PER_PART:
        result["reason"] = "muestra insuficiente: hacen falta {} decisiones evaluadas en cada parte".format(MIN_PER_PART)
        return result
    best_t, fit_loss = fit(older)
    base_valid, new_valid = log_loss(newer, 1.0), log_loss(newer, best_t)
    result.update(candidate=best_t, fit_log_loss=round(fit_loss, 5),
                  validation_log_loss_t1=round(base_valid, 5), validation_log_loss=round(new_valid, 5),
                  validation_gain=round(base_valid - new_valid, 5))
    if base_valid - new_valid >= MIN_GAIN:
        result.update(temperature=best_t, accepted=True)
    else:
        result["reason"] = "la temperatura candidata no mejora T=1 en validación"
    return result


def write_temperature(path, question_id, version, temperature):
    with open(path) as handle:
        data = json.load(handle)
    data.setdefault("temperatures", {})["{}@{}".format(question_id, version)] = temperature
    with open(path, "w") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def main(argv=None, out=None):
    import argparse

    from .futures_llm_decisions import CALIBRATION_PATH

    out = out or sys.stdout
    parser = argparse.ArgumentParser(description="Fit the trade_action calibration temperature by time")
    parser.add_argument("--decisions-db", default=os.environ.get("FUTURES_DECISIONS_DB_PATH"))
    parser.add_argument("--verdicts-db", default=os.environ.get("FUTURES_VERDICTS_DB_PATH"))
    parser.add_argument("--run", help="fit on one replay run DB instead (needs --market-db)")
    parser.add_argument("--market-db")
    parser.add_argument("--product", default=DEFAULT_PRODUCT)
    parser.add_argument("--question", default=QUESTION_ID)
    parser.add_argument("--version", type=int)
    parser.add_argument("--horizon-min", type=int, default=HORIZON_MIN)
    parser.add_argument("--calibration-file", default=CALIBRATION_PATH)
    parser.add_argument("--write", action="store_true", help="write T to the calibration file when accepted")
    args = parser.parse_args(argv)
    if args.run:
        if not args.market_db:
            parser.error("--run needs --market-db")
        rows, product = rows_from_run(args.run, args.market_db)
        version = args.version
        if version is None:
            from .futures_llm_decisions import load_questions
            version = load_questions()[args.question]["version"]
    else:
        if not args.decisions_db or not args.verdicts_db:
            parser.error("--decisions-db and --verdicts-db are required (or --run and --market-db)")
        report = product_report(args.decisions_db, args.verdicts_db, args.product, args.question, args.version,
                                args.horizon_min)
        rows, product, version = report["rows"], args.product, report["question_version"]
    result = calibrate(rows, round_trip_cost_bps(product))
    result.update(product_id=product, question_id=args.question, question_version=version)
    if args.write and result["accepted"]:
        write_temperature(args.calibration_file, args.question, version, result["temperature"])
        result["written_to"] = args.calibration_file
    out.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
