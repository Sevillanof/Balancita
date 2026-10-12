"""Is Qwen's stated probability honest? Brier, log-loss and reliability of ``trade_action``.

Read-only and deterministic: it takes the scored rows of ``futures_llm_scores.score_decisions``
(each decision with the probabilities Qwen gave to buy / hold / sell) and compares them with the
action that turned out to be right (``right_action``: the one that would have scored +1 after
costs). Nothing here changes the question, the prompt or the decision rule.

* ``brier``: mean over decisions of the sum over the three options of ``(p - outcome)^2``
  (0 perfect, 2/3 = 0.667 for always saying 1/3 each).
* ``log_loss``: mean of ``-ln p(right option)`` (``ln 3 = 1.0986`` for 1/3 each).
* Baselines on the same decisions: ``uniform`` (1/3 each) and ``base_rate`` (how often each action
  was right, measured on the same set, so it is slightly optimistic). The skill score
  ``1 - brier / brier_base_rate`` is positive only when the stated probabilities beat knowing the
  base rate.
* ``reliability``: decisions grouped by the probability of the chosen option; per band, what Qwen
  claimed (mean) against how often the chosen option was right. ``ece`` is the weighted gap.
* ``high_confidence``: how often it was wrong when it claimed at least ``HIGH_P``.
* ``halves``: the same numbers on the older and newer half, to see whether the picture is stable
  (time order, never random).
"""

import math
import random

from .futures_strategy_backtest import _round

ACTIONS = ("buy", "hold", "sell")
BANDS = ((0.0, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.0001))
HIGH_P = 0.9
MIN_SCORED = 30  # below this the numbers are noise; the report says so
EPS = 1e-6


def right_actions(rows, round_trip_bp):
    """``[(row, right)]`` for the scored rows that carry a full probability triple."""
    pairs = []
    for row in rows:
        probs = row.get("probabilities") or {}
        if row.get("status") != "scored" or any(a not in probs for a in ACTIONS):
            continue
        gross = row["gross_bp"]
        right = "buy" if gross - round_trip_bp > 0 else "sell" if -gross - round_trip_bp > 0 else "hold"
        pairs.append((row, right))
    return pairs


def _scores(pairs, actions=ACTIONS):
    brier = loss = 0.0
    counts = {a: 0 for a in actions}
    for row, right in pairs:
        probs = row["probabilities"]
        counts[right] += 1
        brier += sum((float(probs[a]) - (1.0 if a == right else 0.0)) ** 2 for a in actions)
        loss -= math.log(max(float(probs[right]), EPS))
    n = len(pairs)
    base = {a: counts[a] / n for a in actions}
    brier_base = sum((base[a] - (1.0 if a == right else 0.0)) ** 2 for _, right in pairs for a in actions) / n
    loss_base = -sum(math.log(max(base[right], EPS)) for _, right in pairs) / n
    return {
        "brier": _round(brier / n), "log_loss": _round(loss / n),
        "brier_uniform": _round(1 - 1 / len(actions)), "log_loss_uniform": _round(math.log(len(actions))),
        "brier_base_rate": _round(brier_base), "log_loss_base_rate": _round(loss_base),
        "brier_skill": _round(1 - (brier / n) / brier_base) if brier_base > 0 else None,
        "right_action_rates": {a: _round(base[a]) for a in actions},
    }


def _top(row, actions):
    return max(float(row["probabilities"][a]) for a in actions)


def _reliability(pairs, actions=ACTIONS):
    bands = []
    ece = 0.0
    for low, high in BANDS:
        members = [(_top(r, actions), r["chosen"] == right)
                   for r, right in pairs if low <= _top(r, actions) < high]
        if not members:
            bands.append({"from": low, "to": min(high, 1.0), "decisions": 0, "claimed": None, "observed": None})
            continue
        claimed = sum(p for p, _ in members) / len(members)
        observed = sum(1 for _, ok in members if ok) / len(members)
        ece += len(members) / len(pairs) * abs(claimed - observed)
        bands.append({"from": low, "to": min(high, 1.0), "decisions": len(members),
                      "claimed": _round(claimed), "observed": _round(observed)})
    return bands, _round(ece)


def _high_confidence(pairs, actions=ACTIONS):
    members = [r["chosen"] == right for r, right in pairs if _top(r, actions) >= HIGH_P]
    wrong = sum(1 for ok in members if not ok)
    return {"threshold": HIGH_P, "decisions": len(members), "wrong": wrong,
            "wrong_rate": _round(wrong / len(members)) if members else None}


def _block(pairs, actions=ACTIONS):
    if not pairs:
        return {"decisions": 0}
    bands, ece = _reliability(pairs, actions)
    block = {"decisions": len(pairs), "reliable_sample": len(pairs) >= MIN_SCORED,
             "accuracy": _round(sum(1 for r, right in pairs if r["chosen"] == right) / len(pairs))}
    block.update(_scores(pairs, actions))
    block.update(reliability=bands, ece=ece, high_confidence=_high_confidence(pairs, actions))
    return block


def calibration_from_pairs(pairs, actions=ACTIONS):
    """Whole-range numbers plus the older and newer half of ``[(row, right)]`` (oldest first).

    Any question with a probability per option fits: ``actions`` names them (``buy/hold/sell`` for
    ``trade_action``, ``hold/close`` for C31's ``exit_decision``) and each row carries ``chosen`` and
    ``probabilities``; ``right`` is the option that turned out to be right.
    """
    half = len(pairs) // 2
    result = _block(pairs, actions)
    result["halves"] = {"older": _block(pairs[:half], actions), "newer": _block(pairs[half:], actions)}
    return result


def _pearson(x, y):
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxx, syy = sum((a - mx) ** 2 for a in x), sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return 0.0
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(sxx * syy)


def _ranks(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks, i = [0.0] * len(values), 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2
        i = j + 1
    return ranks


def information_coefficient(rows, block=60, boots=1000):
    """IC: correlation of ``p(buy) - p(sell)`` with the gross return that followed (rows oldest first).

    0 means no predictive information whatever the stated confidence. The 95 % interval resamples
    contiguous blocks of ``block`` decisions (neighbours are alike) with a fixed seed.
    """
    pts = [(float(r["probabilities"]["buy"]) - float(r["probabilities"]["sell"]), float(r["gross_bp"]))
           for r in rows if r.get("status") == "scored" and r.get("gross_bp") is not None
           and all(a in (r.get("probabilities") or {}) for a in ("buy", "sell"))]
    n = len(pts)
    if n < MIN_SCORED:
        return {"decisions": n, "reliable_sample": False}

    def both(sample):
        x, y = [p[0] for p in sample], [p[1] for p in sample]
        return _pearson(x, y), _pearson(_ranks(x), _ranks(y))

    pearson, spearman = both(pts)
    rnd = random.Random(1)
    starts = list(range(0, n, block))
    draws = []
    for _ in range(boots):
        sample = []
        for _ in starts:
            s = rnd.choice(starts)
            sample.extend(pts[s:s + block])
        draws.append(both(sample))
    out = {"decisions": n, "reliable_sample": True}
    for name, value, idx in (("pearson", pearson, 0), ("spearman", spearman, 1)):
        vals = sorted(d[idx] for d in draws)
        out[name] = {"ic": _round(value), "low": _round(vals[int(0.025 * boots)]), "high": _round(vals[int(0.975 * boots)])}
    return out


def calibration_report(rows, round_trip_bp):
    """``trade_action``: the right action is the one that cleared the round trip (rows oldest first)."""
    result = calibration_from_pairs(right_actions(rows, float(round_trip_bp)))
    result["ic"] = information_coefficient(rows)
    return result


def format_lines(cal, pct):
    """Spanish lines for the text report."""
    if not cal.get("decisions"):
        return ["Calibración: sin decisiones evaluadas con probabilidades"]
    lines = ["Calibración ({} decisiones{}):".format(
        cal["decisions"], "" if cal["reliable_sample"] else ", muestra chica: ruido")]
    lines.append("  Brier {} (azar {}, tasa base {}; habilidad {})   Log-loss {} (azar {}, tasa base {})".format(
        cal["brier"], cal["brier_uniform"], cal["brier_base_rate"],
        "n/a" if cal["brier_skill"] is None else cal["brier_skill"],
        cal["log_loss"], cal["log_loss_uniform"], cal["log_loss_base_rate"]))
    lines.append("  Fiabilidad (probabilidad de la elegida: dice / acierta):")
    for band in cal["reliability"]:
        if band["decisions"]:
            lines.append("    {:.1f}-{:.1f}: {:>5} decisiones  dice {}  acierta {}".format(
                band["from"], band["to"], band["decisions"], pct(band["claimed"]), pct(band["observed"])))
    hc = cal["high_confidence"]
    lines.append("  Con p >= {}: {} decisiones, {} erradas ({}); ECE {}".format(
        hc["threshold"], hc["decisions"], hc["wrong"], pct(hc["wrong_rate"]), cal["ece"]))
    ic = cal.get("ic")
    if ic and ic.get("reliable_sample"):
        sp = ic["spearman"]
        lines.append("  IC (p compra - p venta contra retorno bruto): Spearman {} [IC95 {} a {}], Pearson {}; "
                     "0 = sin información{}".format(
                         sp["ic"], sp["low"], sp["high"], ic["pearson"]["ic"],
                         "" if sp["low"] > 0 or sp["high"] < 0 else " (el intervalo incluye 0)"))
    return lines
