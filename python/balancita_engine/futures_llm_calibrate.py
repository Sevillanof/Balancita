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
T_MIN, T_MAX, T_STEPS = 0.5, 5.0, 91


def grid():
    return [round(T_MIN + (T_MAX - T_MIN) * i / (T_STEPS - 1), 4) for i in range(T_STEPS)]


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
    parser.add_argument("--product", default=DEFAULT_PRODUCT)
    parser.add_argument("--question", default=QUESTION_ID)
    parser.add_argument("--version", type=int)
    parser.add_argument("--horizon-min", type=int, default=HORIZON_MIN)
    parser.add_argument("--calibration-file", default=CALIBRATION_PATH)
    parser.add_argument("--write", action="store_true", help="write T to the calibration file when accepted")
    args = parser.parse_args(argv)
    if not args.decisions_db or not args.verdicts_db:
        parser.error("--decisions-db and --verdicts-db are required")
    report = product_report(args.decisions_db, args.verdicts_db, args.product, args.question, args.version,
                            args.horizon_min)
    result = calibrate(report["rows"], round_trip_cost_bps(args.product))
    result.update(product_id=args.product, question_id=args.question, question_version=report["question_version"])
    if args.write and result["accepted"]:
        write_temperature(args.calibration_file, args.question, report["question_version"], result["temperature"])
        result["written_to"] = args.calibration_file
    out.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
