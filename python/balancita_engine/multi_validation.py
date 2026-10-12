"""Historical validation of the three multi-strategy rules and the deterministic combiner (PR 105).

Question: does any of ``mx-funding-v1``, ``mx-momentum-v1`` or ``mx-meanrev-v1`` have a statistically defensible edge
after costs? Nothing here tunes anything: the rules are frozen, so there is no selection inside the sample (CPCV and
PBO are reported as diagnostics only and never decide). The protocol (constants below, written to ``protocol.json``
with its hash before any result exists) says what counts as a pass; a result that cannot be judged is
"evidencia insuficiente", never a favourable-looking number.

* **Opportunities, not re-reads.** A signal that persists across 5-minute cycles is one *episode* (onset = no candidate of
  the same strategy / product / action in the previous ``QUIET_CYCLES`` cycles). Only onsets get an outcome; the number
  of re-evaluations (and, for funding, of distinct hourly observations) is reported next to it.
* **Outcome of an episode** = the shadow book of its onset (same levels, costs and observed funding as the paper
  books, stop assumed first when stop and target share a candle). Shadow outcomes ignore exposure limits.
* **Primary statistic** = the strategy's daily net PnL (USD, 100 USD per episode, realised on the exit day, zero on days
  without episodes) of the equal-weight portfolio of the 8 products. Eight products are ~1.3-1.5 independent bets
  (correlation 0.7-0.8), so products are descriptive only. Mean, 95 % CI and one-sided p-value come from a stationary
  block bootstrap of that series; Holm over the 3 strategies (alpha 0.05).
* **Controls**: random-entry strategies with the same horizons, many seeds, same shadow machinery.
* **Final reserve**: the last ``HOLDOUT_DAYS`` are never read by ``analyze``; ``holdout`` runs them once.
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import random
import statistics
import time

from .futures_costs import cost_model_hash, round_trip_cost_bps
from .futures_purged import cscv_pbo, purged_folds, fold_summary
from .multi_experiment import (
    FIVE_MINUTES_MS, ONE_MINUTE_MS, Experiment, _load_funding, load_incremental,
)
from .futures_products import resolve_products
from .multi_risk import RiskPolicy
from .multi_signals import BUY, SELL, WAIT, Strategy, default_strategies
from .multi_store import DecisionStore

DAY_MS = 86_400_000
HISTORY_DAYS = 240
HOLDOUT_DAYS = 60
QUIET_CYCLES = 12  # one hour without the same candidate = a new episode
MIN_EPISODES = 300
MIN_ACTIVE_DAYS = 60
ALPHA = 0.05
BOOT_REPS = 2000
BOOT_BLOCK_DAYS = 7
SEED = 20261012
STRESS_ROUND_TRIP_BP = 30
THIRDS = 3
CPCV_BLOCKS = 8
CONTROL_SEEDS = 20
CONTROL_RATE = 1 / 600  # chance of a random candidate per product and 5-minute cycle
CONTROL_HORIZONS = (120, 240, 1440)  # the horizons of meanrev, momentum, funding
MAX_PRODUCT_SHARE = 0.5
TRIALS_EVER_TESTED = 60  # estimate (not recorded): C25-C32, the 2-year rule studies and this project's audits
DECLARED_TRIALS = 4  # three strategies and the combiner
CHUNK_DAYS = 7


# ------------------------------------------------------------------------------------------------ controls


class RandomControl(Strategy):
    """Coin-flip entries at a fixed rate: what the shadow machinery earns when the signal carries no information."""

    indicators = {}
    version = 1

    def __init__(self, seed, horizon_minutes, rate=CONTROL_RATE):
        self.id = "ctl-h{}-s{:02d}".format(horizon_minutes, seed)
        self.horizon_minutes, self.seed, self.rate = horizon_minutes, seed, rate

    def decide(self, ctx):
        from decimal import Decimal

        draw = random.Random("{}:{}:{}:{}".format(SEED, self.id, ctx.product_id, ctx.bucket_ms)).random()
        if draw >= self.rate:
            return WAIT, Decimal(0), {}, "control_wait"
        return (BUY if draw < self.rate / 2 else SELL), Decimal("0.5"), {"control": "random"}, "random_entry"


def control_strategies(seeds=CONTROL_SEEDS, horizons=CONTROL_HORIZONS, rate=CONTROL_RATE):
    return [RandomControl(seed, horizon, rate) for horizon in horizons for seed in range(seeds)]


# ------------------------------------------------------------------------------------------------ protocol


def span(end_ms, history_days=HISTORY_DAYS, holdout_days=HOLDOUT_DAYS):
    start = end_ms - history_days * DAY_MS
    cut = end_ms - holdout_days * DAY_MS
    return {"start_ms": start, "validation_end_ms": cut, "holdout_start_ms": cut, "end_ms": end_ms}


def protocol(end_ms, products, **overrides):
    strategies = default_strategies()
    body = {
        "schema": "balancita-validation-protocol.v1", "span": span(end_ms), "products": list(products),
        "strategies": [[s.id, s.version, s.horizon_minutes] for s in strategies], "combiner": "deterministic-combiner@1",
        "policy_hash": RiskPolicy().policy_hash(), "cost_model_hash": cost_model_hash(), "quiet_cycles": QUIET_CYCLES,
        "min_episodes": MIN_EPISODES, "min_active_days": MIN_ACTIVE_DAYS, "alpha": ALPHA, "holm_family": "3 strategies",
        "bootstrap": {"reps": BOOT_REPS, "block_days": BOOT_BLOCK_DAYS, "seed": SEED}, "stress_round_trip_bp": STRESS_ROUND_TRIP_BP,
        "thirds_required": "2 of 3", "max_product_share": MAX_PRODUCT_SHARE,
        "controls": {"seeds": CONTROL_SEEDS, "horizons": list(CONTROL_HORIZONS), "rate": CONTROL_RATE},
        "trials": {"declared": DECLARED_TRIALS, "ever_tested_estimate": TRIALS_EVER_TESTED},
        "diagnostics_only": ["cpcv", "pbo"], "pass_rule": [
            "episodes >= min_episodes and active days >= min_active_days",
            "daily net PnL: bootstrap CI95 lower bound > 0 and Holm-adjusted p < alpha",
            "same under a 30 bp round-trip cost (CI95 lower bound > 0)",
            "positive mean in at least 2 of 3 chronological thirds",
            "no product contributes more than half of the net PnL",
            "mean net bp per episode beats the random-entry controls of the same horizon (p < alpha)"],
    }
    body.update(overrides)
    body["hash"] = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    return body


def write_protocol(out, body):
    path = os.path.join(out, "protocol.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            existing = json.load(handle)
        if existing["hash"] != body["hash"]:
            raise SystemExit("the protocol on disk differs from this run's; it is frozen. Use a new --out directory.")
        return existing
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return body


# ------------------------------------------------------------------------------------------------ running


def run_history(market_db, out, kind, start_ms, end_ms, products, *, chunk_days=CHUNK_DAYS, say=print, funding_periods=None):
    """Feeds the candles of [start_ms, end_ms) to one experiment in chunks, with a checkpoint after each chunk.

    ``kind`` is ``real`` (three strategies, arms A and B), ``controls`` or the same with a ``holdout-`` prefix. Safe to
    stop and rerun: a valid checkpoint resumes, anything else rebuilds. Without observed funding an episode has no complete
    net result and is counted as not judged (``funding_periods`` replaces the market DB's funding, for tests).
    """
    controls = kind.endswith("controls")
    store = DecisionStore(os.path.join(out, kind + ".sqlite"))
    try:
        experiment = Experiment(
            store, [p for p, _ in products], strategies=control_strategies() if controls else default_strategies(),
            qwen=None, experiment_id="val-" + kind, funding_contexts={} if funding_periods else _load_funding(market_db, products),
            funding_periods_by_product=funding_periods,
            start_ms=start_ms, arms=("A",) if controls else ("A", "B"), tick_sizes=dict(products),
            shadow_quiet_cycles=QUIET_CYCLES, keep_wait_signals=False)
        reason = experiment.load_checkpoint()
        say("{}: checkpoint {}".format(kind, "resumed" if reason is None else "not used ({})".format(reason)))
        cursor = max(experiment.last.values(), default=None)
        t = start_ms if cursor is None else max(start_ms, cursor + ONE_MINUTE_MS)
        while t < end_ms:
            t = min(t + chunk_days * DAY_MS, end_ms)
            candles = load_incremental(experiment, market_db, products, t - ONE_MINUTE_MS)
            experiment.run(candles, report=False)
            experiment.save_checkpoint()
            say("{}: up to {} ({} cycles)".format(kind, _day(t), experiment.cycles))
        return {"cycles": experiment.cycles, "gaps": experiment.gaps, "warmup": experiment.report(False)["warmup"]}
    finally:
        store.close()


# ------------------------------------------------------------------------------------------------ episodes


def episodes(store, quiet_cycles=QUIET_CYCLES):
    """One record per signal onset with its shadow outcome and how many re-reads the episode had."""
    outcomes = store.candidate_outcomes()
    runs, result = {}, []
    for cand in sorted(store.candidates(), key=lambda c: c["cycle_ms"]):
        key = (cand["strategy_id"], cand["product_id"], cand["action"])
        current = runs.get(key)
        if current is not None and cand["cycle_ms"] - current["last_cycle_ms"] <= quiet_cycles * FIVE_MINUTES_MS:
            current["evaluations"] += 1
            current["last_cycle_ms"] = cand["cycle_ms"]
            current["hours"].add(cand["cycle_ms"] // 3_600_000)
            continue
        outcome = outcomes.get(cand["signal_id"]) or {}
        current = {"strategy_id": cand["strategy_id"], "product_id": cand["product_id"], "action": cand["action"],
                   "cycle_ms": cand["cycle_ms"], "last_cycle_ms": cand["cycle_ms"], "signal_id": cand["signal_id"],
                   "evaluations": 1, "hours": {cand["cycle_ms"] // 3_600_000}, "status": outcome.get("status", "open"),
                   "net_bp": outcome.get("net_bp"), "net_usd": outcome.get("net_usd"),
                   "entry_time_ms": outcome.get("entry_time_ms"), "exit_time_ms": outcome.get("exit_time_ms"),
                   "exit_reason": outcome.get("exit_reason")}
        runs[key] = current
        result.append(current)
    for record in result:
        record["hourly_observations"] = len(record.pop("hours"))
    return result


def judged(eps, until_ms=None):
    """Episodes with a complete net outcome whose trade closed by ``until_ms``."""
    return [e for e in eps if e["net_bp"] is not None and e["net_usd"] is not None
            and (until_ms is None or e["exit_time_ms"] <= until_ms)]


def as_trades(eps):
    """The shape ``futures_purged`` expects."""
    return [{"entry_time_ms": e["entry_time_ms"], "exit_time_ms": e["exit_time_ms"], "net_bp": e["net_bp"],
             "pnl_usd": e["net_usd"]} for e in eps]


# ------------------------------------------------------------------------------------------------ statistics


def _day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")


def daily_series(eps, first_ms, last_ms, stress_bp=None):
    """Net USD per UTC day (realised on the exit day) over [first_ms, last_ms); stress re-prices every episode."""
    first_day, last_day = first_ms // DAY_MS, (last_ms - 1) // DAY_MS
    days = [0.0] * (last_day - first_day + 1)
    for e in eps:
        usd = e["net_usd"]
        if stress_bp is not None:
            extra = max(0.0, stress_bp - float(round_trip_cost_bps(e["product_id"])))
            usd -= 100.0 * extra / 10_000
        index = e["exit_time_ms"] // DAY_MS - first_day
        if 0 <= index < len(days):
            days[index] += float(usd)
    return days


def stationary_bootstrap(series, name, reps=BOOT_REPS, block=BOOT_BLOCK_DAYS):
    """``(mean, ci95, p_one_sided)`` for H0: mean <= 0, resampling blocks of random (geometric) length."""
    n = len(series)
    if n < 2:
        return None
    mean = statistics.fmean(series)
    centred = [x - mean for x in series]
    rng = random.Random("{}:{}".format(SEED, name))
    plain, null = [], []
    for _ in range(reps):
        picks, i = [], rng.randrange(n)
        for _ in range(n):
            picks.append(i)
            i = rng.randrange(n) if rng.random() < 1 / block else (i + 1) % n
        plain.append(statistics.fmean(series[j] for j in picks))
        null.append(statistics.fmean(centred[j] for j in picks))
    plain.sort()
    p = (1 + sum(1 for x in null if x >= mean)) / (1 + reps)
    return {"mean_daily_usd": round(mean, 4), "ci95": [round(plain[int(0.025 * reps)], 4), round(plain[int(0.975 * reps) - 1], 4)],
            "p_one_sided": round(p, 4)}


def holm(p_values, alpha=ALPHA):
    """Holm-Bonferroni adjusted p-values for ``{name: p}``."""
    order = sorted(p_values, key=lambda k: p_values[k])
    adjusted, running = {}, 0.0
    for rank, name in enumerate(order):
        running = max(running, min(1.0, (len(order) - rank) * p_values[name]))
        adjusted[name] = round(running, 4)
    return adjusted


def deflated_sharpe(series, trials, trial_sharpe_sd):
    """Probability that the daily Sharpe is not luck among ``trials`` attempts (Bailey and Lopez de Prado, 2014)."""
    if len(series) < 3 or statistics.pstdev(series) == 0:
        return None
    normal = statistics.NormalDist()
    sharpe = statistics.fmean(series) / statistics.pstdev(series)
    gamma = 0.5772156649015329
    benchmark = 0.0 if trials < 2 else trial_sharpe_sd * (
        (1 - gamma) * normal.inv_cdf(1 - 1 / trials) + gamma * normal.inv_cdf(1 - 1 / (trials * math.e)))
    mean, sd = statistics.fmean(series), statistics.pstdev(series)
    skew = statistics.fmean([((x - mean) / sd) ** 3 for x in series])
    kurt = statistics.fmean([((x - mean) / sd) ** 4 for x in series])
    denominator = 1 - skew * sharpe + (kurt - 1) / 4 * sharpe ** 2
    if denominator <= 0:
        return None
    return round(normal.cdf((sharpe - benchmark) * math.sqrt(len(series) - 1) / math.sqrt(denominator)), 4)


def describe(eps):
    wins = [e["net_usd"] for e in eps if e["net_usd"] > 0]
    losses = [-e["net_usd"] for e in eps if e["net_usd"] < 0]
    return {
        "episodes": len(eps), "active_days": len({e["exit_time_ms"] // DAY_MS for e in eps}),
        "mean_net_bp": round(statistics.fmean(e["net_bp"] for e in eps), 2) if eps else None,
        "hit_rate": round(sum(1 for e in eps if e["net_usd"] > 0) / len(eps), 4) if eps else None,
        "profit_factor": round(sum(wins) / sum(losses), 3) if losses else None,
        "net_usd": round(sum(e["net_usd"] for e in eps), 2) if eps else 0.0}


def max_drawdown(values):
    running = peak = worst = 0.0
    for value in values:
        running += value
        peak = max(peak, running)
        worst = max(worst, peak - running)
    return round(worst, 2)


def cpcv(eps, first_ms, last_ms, blocks=CPCV_BLOCKS):
    """Mean net bp of every union of two purged blocks. Diagnostic only: with frozen rules nothing is selected."""
    folds = purged_folds(as_trades(eps), first_ms, last_ms, blocks)
    sums = [(b["mean_net_bp"] or 0.0) * b["trades"] for b in folds]
    counts = [b["trades"] for b in folds]
    paths = []
    for i in range(blocks):
        for j in range(i + 1, blocks):
            n = counts[i] + counts[j]
            if n:
                paths.append((sums[i] + sums[j]) / n)
    if not paths:
        return None
    return {"paths": len(paths), "positive_share": round(sum(1 for p in paths if p > 0) / len(paths), 3),
            "median_net_bp": round(statistics.median(paths), 2), "worst_net_bp": round(min(paths), 2)}


# ------------------------------------------------------------------------------------------------ analysis


def analyze(real, controls, proto, window, *, trials=TRIALS_EVER_TESTED):
    """The report of one window (``validation`` or ``holdout``) from the stores of the real run and the controls."""
    first, last = window
    strategies = [s.id for s in default_strategies()]
    all_eps = episodes(real)
    inside = lambda e: first <= e["cycle_ms"] < last  # noqa: E731
    candidates = [c for c in real.candidates() if first <= c["cycle_ms"] < last]
    null = _control_means(controls, first, last) if controls is not None else {}
    report = {"window": {"from": _day(first), "to": _day(last)}, "strategies": {}, "notes": [
        "shadow outcomes ignore simultaneous positions and capital limits: they measure opportunities, not an account",
        "episodes with an incomplete funding history are excluded from the net figures and counted as not_judged",
        "TRIALS: {} configurations are declared; the real count ever tried on this data is unrecorded, so the DSR is also "
        "shown for {} trials".format(DECLARED_TRIALS, trials)]}
    series, sharpes, stats = {}, {}, {}
    for sid in strategies:
        eps_all = [e for e in all_eps if e["strategy_id"] == sid and inside(e)]
        eps = judged(eps_all, last)
        stats[sid] = (eps_all, eps)
        series[sid] = daily_series(eps, first, last)
        sd = statistics.pstdev(series[sid]) if len(series[sid]) > 1 else 0
        sharpes[sid] = statistics.fmean(series[sid]) / sd if sd else 0.0
    spread = statistics.pstdev(list(sharpes.values())) if len(sharpes) > 1 else 0.0
    primary = {sid: stationary_bootstrap(series[sid], sid) for sid in strategies}
    adjusted = holm({sid: r["p_one_sided"] for sid, r in primary.items() if r}) if any(primary.values()) else {}
    thirds_edges = [first + (last - first) * i // THIRDS for i in range(THIRDS + 1)]
    for sid in strategies:
        eps_all, eps = stats[sid]
        cand = [c for c in candidates if c["strategy_id"] == sid]
        stress = stationary_bootstrap(daily_series(eps, first, last, STRESS_ROUND_TRIP_BP), sid + ":stress")
        folds = purged_folds(as_trades(eps), first, last, THIRDS)
        positive_thirds = sum(1 for b in folds if b["mean_net_bp"] is not None and b["mean_net_bp"] > 0)
        by_product = {}
        for product in proto["products"]:
            part = [e for e in eps if e["product_id"] == product]
            by_product[product] = describe(part)
        total = sum(v["net_usd"] for v in by_product.values())
        top_share = max((v["net_usd"] for v in by_product.values()), default=0) / total if total > 0 else None
        horizon = next(s.horizon_minutes for s in default_strategies() if s.id == sid)
        reference = null.get(horizon, [])
        mean_bp = describe(eps)["mean_net_bp"]
        control_p = None if not reference or mean_bp is None else round(
            (1 + sum(1 for x in reference if x >= mean_bp)) / (1 + len(reference)), 4)
        row = {
            "candidates_evaluated_every_5_min": len(cand), "independent_episodes": len(eps_all),
            "reevaluations_per_episode": round(len(cand) / len(eps_all), 2) if eps_all else None,
            "hourly_observations": sum(e["hourly_observations"] for e in eps_all),
            "not_judged": len(eps_all) - len(eps), **describe(eps),
            "max_drawdown_usd_shadow": max_drawdown(daily_series(eps, first, last)),
            "daily_net_pnl": primary[sid], "holm_adjusted_p": adjusted.get(sid), "stress_30bp": stress,
            "dsr_declared_trials": deflated_sharpe(series[sid], DECLARED_TRIALS, spread),
            "dsr_estimated_trials": deflated_sharpe(series[sid], trials, spread),
            "thirds": [b["mean_net_bp"] for b in folds], "positive_thirds": positive_thirds,
            "top_product_share": None if top_share is None else round(top_share, 3),
            "random_control": {"null_mean_net_bp": None if not reference else round(statistics.fmean(reference), 2),
                               "null_runs": len(reference), "p_control": control_p},
            "by_product_descriptive": by_product,
            "cpcv_diagnostic": cpcv(eps, first, last),
        }
        row["verdict"] = verdict(row, proto)
        report["strategies"][sid] = row
    report["pbo_diagnostic"] = cscv_pbo(
        {sid: as_trades(stats[sid][1]) for sid in strategies}, first, last, blocks=CPCV_BLOCKS)
    report["combiner_vs_strategies"] = combiner(real, first, last)
    report["unknown_risk"] = "pbo and cpcv do not decide: the rules are frozen, nothing was selected on this data"
    return report


def _control_means(controls, first, last):
    """Mean net bp of each random control, by horizon (the null the strategies have to beat)."""
    result = {}
    all_eps = [e for e in episodes(controls) if first <= e["cycle_ms"] < last]
    by_control = {}
    for e in judged(all_eps, last):
        by_control.setdefault(e["strategy_id"], []).append(e["net_bp"])
    for control_id, values in by_control.items():
        horizon = int(control_id.split("-h")[1].split("-")[0])
        result.setdefault(horizon, []).append(statistics.fmean(values))
    return result


def verdict(row, proto):
    if row["independent_episodes"] < proto["min_episodes"] or row["active_days"] < proto["min_active_days"]:
        return "evidencia insuficiente: {} episodios y {} dias activos (se piden {} y {})".format(
            row["independent_episodes"], row["active_days"], proto["min_episodes"], proto["min_active_days"])
    daily, stress = row["daily_net_pnl"], row["stress_30bp"]
    checks = {
        "ci_and_holm": bool(daily and daily["ci95"][0] > 0 and (row["holm_adjusted_p"] or 1) < proto["alpha"]),
        "stress_30bp": bool(stress and stress["ci95"][0] > 0),
        "thirds": row["positive_thirds"] >= 2,
        "concentration": row["top_product_share"] is not None and row["top_product_share"] <= proto["max_product_share"],
        "random_control": row["random_control"]["p_control"] is not None and row["random_control"]["p_control"] < proto["alpha"],
    }
    row["checks"] = checks
    if all(checks.values()):
        return "pasa validacion (pendiente de la reserva ciega y del forward; no es rentabilidad demostrada)"
    return "no pasa: " + ", ".join(k for k, ok in checks.items() if not ok)


def combiner(store, first, last):
    """Executable trades of arm B against arm A (all strategies), per-trade net bp, day-block bootstrap of the difference."""
    inside = [t for t in store.trades() if first <= t["entry_time_ms"] < last and t["net_complete"]]
    groups = {"A": [t for t in inside if t["arm"] == "A"], "B": [t for t in inside if t["arm"] == "B"]}
    out = {arm: {"trades": len(ts), "mean_net_bp": round(statistics.fmean(t["net_bp"] for t in ts), 2) if ts else None,
                 "net_usd": round(sum(float(t["net_usd"]) for t in ts), 2) if ts else 0.0} for arm, ts in groups.items()}
    out["per_strategy_A"] = {}
    for sid in {t["strategy_id"] for t in groups["A"]}:
        part = [t for t in groups["A"] if t["strategy_id"] == sid]
        out["per_strategy_A"][sid] = {"trades": len(part), "mean_net_bp": round(statistics.fmean(t["net_bp"] for t in part), 2)}
    if len(groups["A"]) < 30 or len(groups["B"]) < 30:
        out["difference"] = "evidencia insuficiente (menos de 30 operaciones en un brazo)"
        return out
    days = sorted({t["entry_time_ms"] // DAY_MS for t in inside})
    sums = {arm: {d: [0.0, 0] for d in days} for arm in groups}
    for arm, ts in groups.items():
        for t in ts:
            cell = sums[arm][t["entry_time_ms"] // DAY_MS]
            cell[0] += t["net_bp"]
            cell[1] += 1
    rng = random.Random("{}:combiner".format(SEED))
    n = len(days)
    diffs = []
    for _ in range(BOOT_REPS):
        picks, i = [], rng.randrange(n)
        for _ in range(n):
            picks.append(days[i])
            i = rng.randrange(n) if rng.random() < 1 / BOOT_BLOCK_DAYS else (i + 1) % n
        means = {}
        for arm in groups:
            total = sum(sums[arm][d][0] for d in picks)
            count = sum(sums[arm][d][1] for d in picks)
            means[arm] = total / count if count else None
        if None not in means.values():
            diffs.append(means["B"] - means["A"])
    diffs.sort()
    observed = out["B"]["mean_net_bp"] - out["A"]["mean_net_bp"]
    out["difference"] = {"b_minus_a_net_bp": round(observed, 2),
                         "ci95": [round(diffs[int(0.025 * len(diffs))], 2), round(diffs[int(0.975 * len(diffs)) - 1], 2)],
                         "reps": len(diffs), "note": "executable trades (exposure limits apply); B beats A only if the CI excludes 0"}
    return out


# ------------------------------------------------------------------------------------------------ command line


def _to_ms(text):
    return int(datetime.datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def _write(out, name, data):
    path = os.path.join(out, name)
    with open(path + ".partial", "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True, default=str)
        handle.write("\n")
    os.replace(path + ".partial", path)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Historical validation of the multi-strategy rules (frozen protocol).")
    parser.add_argument("command", choices=("run", "analyze", "holdout"))
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--end", default="2026-10-01", help="last day (UTC, exclusive); later data is left for the forward")
    parser.add_argument("--trials", type=int, default=TRIALS_EVER_TESTED)
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    products = resolve_products()
    end_ms = _to_ms(args.end)
    window = span(end_ms)
    proto = write_protocol(args.out, protocol(end_ms, [p for p, _ in products]))
    if args.command == "run":
        report = {k: run_history(args.market_db, args.out, k, window["start_ms"], window["validation_end_ms"], products)
                  for k in ("real", "controls")}
        _write(args.out, "run-report.json", report)
        return
    if args.command == "analyze":
        stores = [DecisionStore(os.path.join(args.out, k + ".sqlite")) for k in ("real", "controls")]
        try:
            result = analyze(stores[0], stores[1], proto, (window["start_ms"], window["validation_end_ms"]), trials=args.trials)
        finally:
            for s in stores:
                s.close()
        print(_write(args.out, "validation-report.json", dict(result, protocol_hash=proto["hash"])))
        return
    lock = os.path.join(args.out, "holdout.lock")
    if os.path.exists(lock):
        raise SystemExit("the final reserve was already evaluated once ({}); it is not rerun".format(lock))
    with open(lock, "w", encoding="utf-8") as handle:
        json.dump({"protocol_hash": proto["hash"], "started": int(time.time())}, handle)
    for kind in ("holdout-real", "holdout-controls"):
        run_history(args.market_db, args.out, kind, window["holdout_start_ms"], window["end_ms"], products)
    stores = [DecisionStore(os.path.join(args.out, k + ".sqlite")) for k in ("holdout-real", "holdout-controls")]
    try:
        result = analyze(stores[0], stores[1], proto, (window["holdout_start_ms"], window["end_ms"]), trials=args.trials)
    finally:
        for s in stores:
            s.close()
    print(_write(args.out, "holdout-report.json", dict(result, protocol_hash=proto["hash"])))


if __name__ == "__main__":
    main()
