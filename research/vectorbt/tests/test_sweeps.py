"""F5: executable C27 variants, bounded sweep + ledger, candidate card and signal study, on synthetic candles."""

import copy
import json
import os
import shutil

import numpy as np
import pytest

from research.vectorbt import data_contract as contract
from research.vectorbt import export_practice, feature_study, lab_common, optimize, parity, summarize, trial_ledger
from research.vectorbt.engine import load_spec
from research.vectorbt.tests import helpers
from research.vectorbt.variants import make_c27_variant

PRODUCT = "PF_XBTUSD"
SPEC = "config/strategies/c27-breakout-perp-v1.json"
FAMILY = "c27-breakout-perp"


def _dataset(tmp, name, days, seed):
    cache = str(tmp / ("cache-" + name))
    helpers.write_cache(cache, PRODUCT, helpers.synthetic_minutes(days * 1440, seed=seed))
    holdout = "2025-03-{:02d}".format(1 + days)
    config = tmp / ("gate-" + name + ".json")
    config.write_text(json.dumps({"holdout_from": holdout, "default_from": "2025-03-01"}))
    out = str(tmp / "practice" / name / PRODUCT)
    export_practice.export(PRODUCT, ["1m", "5m"], helpers.START_MS, contract.date_ms(holdout), out, cache_dir=cache,
                           gate_config=str(config), with_funding=False)
    return out, str(config)


def _args(dataset, config, tmp, name, ledger, experiment="exp", budget=9, seed=1, extra=()):
    return optimize.build_parser().parse_args(
        ["--dataset", dataset, "--experiment-id", experiment, "--budget", str(budget), "--seed", str(seed),
         "--gate-config", config, "--ledger", ledger, "--out-dir", str(tmp / ("out-" + name))] + list(extra))


@pytest.fixture(scope="module")
def data(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("sweeps")
    dataset, config = _dataset(tmp, "main", 4, 11)
    return tmp, dataset, config


@pytest.fixture(scope="module")
def swept(data):
    tmp, dataset, config = data
    ledger = str(tmp / "ledger.sqlite")
    first, base_a = optimize.run(_args(dataset, config, tmp, "a", ledger))
    second, base_b = optimize.run(_args(dataset, config, tmp, "b", ledger))
    return {"ledger": ledger, "first": first, "second": second, "a": base_a, "b": base_b}


# ------------------------------------------------------------------------------------------------- variants
@pytest.mark.parametrize("period,multiplier", [(15, "1.25"), (25, "1.5")])
def test_variant_signals_match_the_engine(data, period, multiplier):
    _, dataset, _ = data
    manifest, t1 = parity.load_dataset(dataset, "1m")
    _, t5 = parity.load_dataset(dataset, "5m")
    spec = make_c27_variant(load_spec(SPEC), period, float(multiplier))
    assert spec["indicators"] == {"donchian": [period]}
    assert spec["params"]["volume_multiplier"] == multiplier
    assert "donchian_high20" not in json.dumps(spec["rules"])
    o, h, l, c, v = (np.array(t1[n].to_numpy(), dtype=np.float64) for n in ("open", "high", "low", "close", "volume_btc"))
    arrays = parity.c27_arrays(spec, o, h, l, c, v, donchian_period=period)
    from_arrays = np.where(arrays["long_raw"], 1, np.where(arrays["short_raw"], -1, 0)).astype(np.int8)
    from_engine = parity.engine_signals(spec, parity.engine_candles(t1), parity.engine_candles(t5))
    assert (from_engine != 0).sum() > 3
    assert int((from_engine != from_arrays).sum()) == 0


def test_variant_does_not_touch_the_original_and_period_20_needs_no_block():
    base = load_spec(SPEC)
    snapshot = copy.deepcopy(base)
    variant = make_c27_variant(base, 20, 1.75)
    assert base == snapshot
    assert "indicators" not in variant and variant["params"]["volume_multiplier"] == "1.75"


# ------------------------------------------------------------------------------------------------- ledger
def test_nine_variants_nine_rows_and_repeating_adds_runs_not_variants(swept):
    with trial_ledger.Ledger(swept["ledger"]) as ledger:
        assert ledger.distinct_variants(FAMILY) == 9
        runs = ledger.runs(FAMILY)
    assert len(runs) == 18
    assert len({r["variant_key"] for r in runs[:9]}) == 9
    assert {r["variant_key"] for r in runs[:9]} == {r["variant_key"] for r in runs[9:]}
    assert all(r["seed"] == 1 and r["dataset_sha256"] and r["gate_config_sha256"] for r in runs)
    assert {r["status"] for r in runs} <= {"ok", "no_trades"}


def test_a_budget_below_the_grid_is_an_error_and_writes_nothing(data):
    tmp, dataset, config = data
    ledger = str(tmp / "never.sqlite")
    with pytest.raises(contract.ContractError, match="presupuesto"):
        optimize.run(_args(dataset, config, tmp, "budget", ledger, budget=8))
    assert not os.path.exists(ledger)
    assert optimize.main(["--dataset", dataset, "--experiment-id", "x", "--budget", "8", "--seed", "1",
                          "--gate-config", config, "--ledger", ledger, "--out-dir", str(tmp / "o")]) == 2
    assert not os.path.exists(ledger)


def test_same_command_gives_the_same_numbers(swept):
    assert swept["first"] == swept["second"]
    with open(swept["a"] + ".json", "rb") as a, open(swept["b"] + ".json", "rb") as b:
        assert a.read() == b.read()
    assert swept["first"]["seed"] == 1 and "HIPÓTESIS" in swept["first"]["warning"]
    text = open(swept["a"] + ".md", encoding="utf-8").read()
    assert "En pocas palabras" in text and "HIPÓTESIS" in text and "Estabilidad de vecindario" in text


def test_report_is_ordered_by_neighbourhood_not_by_pnl(swept):
    shares = [v["neighbourhood"]["positive_share"] for v in swept["first"]["variants"]]
    assert shares == sorted(shares, reverse=True)


def test_dataset_over_the_holdout_or_tampered_is_refused_without_ledger_rows(data):
    tmp, dataset, config = data
    ledger = str(tmp / "refused.sqlite")
    stricter = tmp / "gate-strict.json"
    stricter.write_text(json.dumps({"holdout_from": "2025-03-03", "default_from": "2025-03-01"}))
    with pytest.raises(contract.ContractError, match="reserva"):
        optimize.run(_args(dataset, str(stricter), tmp, "strict", ledger))
    copy_dir = tmp / "tampered"
    shutil.copytree(dataset, copy_dir)
    path = copy_dir / "{}_1m.parquet".format(PRODUCT)
    path.chmod(0o644)
    path.write_bytes(path.read_bytes()[:-8] + b"\x00" * 8)
    with pytest.raises(contract.ContractError, match="manifiesto"):
        optimize.run(_args(str(copy_dir), config, tmp, "tampered", ledger))
    assert not os.path.exists(ledger)


def test_failed_variants_are_recorded_too(data, monkeypatch):
    tmp, dataset, config = data
    real = optimize.net_trades

    def flaky(spec, directory, manifest, arrays, period):
        if period == 25:
            raise RuntimeError("boom")
        return real(spec, directory, manifest, arrays, period)

    monkeypatch.setattr(optimize, "net_trades", flaky)
    ledger = str(tmp / "flaky.sqlite")
    optimize.run(_args(dataset, config, tmp, "flaky", ledger, extra=["--grid-donchian", "20,25", "--grid-volume", "1.25"],
                       budget=2))
    with trial_ledger.Ledger(ledger) as db:
        runs = db.runs(FAMILY)
    errors = [r for r in runs if r["status"] == "error"]
    assert len(runs) == 2 and len(errors) == 1 and "boom" in errors[0]["error"]


# ------------------------------------------------------------------------------------------------- summarize
def test_card_distinguishes_variants_from_runs_and_never_says_pasa(swept):
    text, rows = summarize.summarize(swept["ledger"], "exp")
    assert "9 variantes distintas en 18 corridas" in text
    assert "strategy_gate evaluate" in text and "PASA" not in text.replace("No es un PASA", "")
    assert len(rows) == 9 and all(r["runs"] == 2 for r in rows)


def test_card_reads_the_ledger_without_writing(swept):
    before = open(swept["ledger"], "rb").read()
    summarize.summarize(swept["ledger"], "exp")
    assert open(swept["ledger"], "rb").read() == before


def test_negative_control_random_walk_has_no_significant_variant(tmp_path):
    dataset, config = _dataset(tmp_path, "walk", 10, 5)
    ledger = str(tmp_path / "walk.sqlite")
    optimize.run(_args(dataset, config, tmp_path, "walk", ledger, experiment="walk"))
    _, rows = summarize.summarize(ledger, "walk")
    assert len(rows) == 9
    for row in rows:
        if row["promising"]:
            # the property that matters: even a "promising" one is not significant once 9 trials are counted
            assert row["metrics"]["deflated_sharpe"] is None or row["metrics"]["deflated_sharpe"] < 0.95, row


# ------------------------------------------------------------------------------------------- feature study
def _study(data, horizons=(5, 15, 30, 60)):
    _, dataset, config = data
    manifest = lab_common.check_dataset(dataset, config)
    arrays = lab_common.load_1m(dataset, manifest)
    return arrays, lambda a: feature_study.study(load_spec(SPEC), *a, list(horizons), PRODUCT)


def test_feature_study_entry_is_the_next_open_and_events_do_not_overlap(data):
    arrays, run = _study(data)
    result, events = run(arrays)
    index, o = arrays[0], arrays[1]
    for side, records in events.items():
        assert records
        for r in records:
            assert r["entry_price"] == o[r["signal_i"] + 1]
        gaps = [b["signal_i"] - a["signal_i"] for a, b in zip(records, records[1:])]
        assert all(g > 60 for g in gaps)
        info = result["sides"][side]
        assert info["independent_events"] == len(records) <= info["signal_bars"]
    assert result["round_trip_cost_bp"] > 0


def test_feature_study_ignores_candles_after_the_last_event_horizon(data):
    arrays, run = _study(data)
    _, events = run(arrays)
    cut = events["LONG"][-1]["signal_i"] + 60          # keep every event whose horizon ends by here
    corrupted = [a.copy() for a in arrays]
    rng = np.random.default_rng(3)
    for k in range(1, 6):
        corrupted[k][cut + 1:] = rng.uniform(1, 1e6, size=len(corrupted[k]) - cut - 1)
    corrupted[3][cut + 1:] = 0.5          # low below everything else
    corrupted[2][cut + 1:] = 2e6
    _, events_after = run(corrupted)
    for side in events:
        kept = [r for r in events[side] if r["signal_i"] + 60 <= cut]
        again = [r for r in events_after[side] if r["signal_i"] + 60 <= cut]
        assert kept and kept == again
