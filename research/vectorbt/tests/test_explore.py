"""The exploration runner on synthetic candles (no network): reports, ledger, progress, refusals."""

import io
import json
import os
import shutil

import pytest

from research.vectorbt import data_contract as contract
from research.vectorbt import exploration_report as rep
from research.vectorbt import explore, export_practice, trial_ledger
from research.vectorbt import generic_signals as gs
from research.vectorbt.engine import load_spec
from research.vectorbt.tests import helpers
from research.vectorbt.tests.test_generic_parity import CUSTOM_A

PRODUCT = "PF_XBTUSD"
C27 = "config/strategies/c27-breakout-perp-v1.json"
C32 = "config/strategies/c32-funding-contrarian-24h-perp-v1.json"
JARGON = ("sharpe", "percentil", "propose", "evaluate", "_spec", "decimal", "numba", "float", "drawdown", "dataframe")


@pytest.fixture(scope="module")
def market():
    rows = helpers.synthetic_regimes(8 * 1440, seed=9, scale=4.0)
    return gs.Market.from_candles(PRODUCT, rows, helpers.five_minutes(rows))


@pytest.fixture()
def env(tmp_path):
    return {"out_dir": str(tmp_path / "out"), "ledger_path": str(tmp_path / "ledger.sqlite")}


def _run(market, env, strategy=C27, **kwargs):
    stream = io.StringIO()
    report = explore.run_exploration(strategy, markets={PRODUCT: market}, stream=stream, **env, **kwargs)
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    return report, events


def _runs(env, family):
    with trial_ledger.Ledger(env["ledger_path"]) as ledger:
        return ledger.runs(family)


# ------------------------------------------------------------------------------------------------ diagnostic
def test_diagnostic_report_has_the_documented_shape(market, env):
    report, _ = _run(market, env, exploration_id="diag-1")
    assert report["schema"] == "balancita.vectorbt-exploration.v1" and report["mode"] == "diagnostic"
    for key in ("strategy_id", "spec_hash", "window", "dataset_sha256", "generated_at", "warning", "products"):
        assert report[key]
    assert set(report["window"]) == {"from", "to"} and report["unsupported"] is None and report["variants"] is None
    diag = report["diagnostic"]
    assert set(diag["totals"]) >= {"trades", "entries_per_day", "gross_bp_mean", "net_bp_mean", "hit_rate",
                                   "funding_complete_share"}
    assert diag["totals"]["trades"] > 10
    assert {x["reason"] for x in diag["by_exit"]} <= {"stop", "target", "rule", "time"}
    assert abs(sum(x["share"] for x in diag["by_exit"]) - 1.0) < 1e-9
    assert all(set(x) >= {"reason", "label", "trades", "share", "gross_bp_mean", "net_bp_mean"} for x in diag["by_exit"])
    assert all(x["label"] for x in diag["by_exit"]) and diag["by_product"][0]["product"] == PRODUCT
    assert {x["side"] for x in diag["by_side"]} == {"LONG", "SHORT"}
    assert diag["works"] or diag["fails"]
    assert "HIPÓTESIS" in report["warning"]
    written = os.path.join(env["out_dir"], "diag-1")
    assert json.load(open(os.path.join(written, "report.json"), encoding="utf-8")) == json.loads(json.dumps(report))
    assert "## Qué" in open(os.path.join(written, "report.md"), encoding="utf-8").read()


def test_diagnostic_does_not_touch_the_ledger(market, env):
    _run(market, env, exploration_id="diag-2")
    assert not os.path.exists(env["ledger_path"]) or not _runs(env, "c27-breakout-perp")


def test_sentences_are_plain_and_match_the_numbers(market, env):
    report, _ = _run(market, env, exploration_id="diag-3")
    diag = report["diagnostic"]
    sentences = diag["works"] + diag["fails"] + diag["notes"]
    assert sentences and all(not any(word in s.lower() for word in JARGON) for s in sentences)
    net = diag["totals"]["net_bp_mean"]
    assert any(("pierde" if net <= 0 else "gana") in s for s in (diag["fails"] if net <= 0 else diag["works"]))
    for item in diag["by_exit"]:
        if item["trades"] >= rep.MIN_GROUP and item["reason"] == "target":
            side = diag["works"] if item["net_bp_mean"] > 0 else diag["fails"]
            assert any(s.startswith("Los cierres por objetivo") for s in side)


def test_progress_is_json_lines_that_only_go_forward(market, env):
    _, events = _run(market, env, exploration_id="diag-4")
    assert events[0]["progress"] == 0 and events[-1]["progress"] == 100 and events[-1]["phase"] == "Listo"
    values = [e["progress"] for e in events]
    assert values == sorted(values) and len(set(values)) > 4
    assert all(set(e) == {"progress", "phase", "detail"} and 0 <= e["progress"] <= 100 for e in events)


def test_progress_moves_with_the_work_not_in_fixed_steps(market, env):
    _, short = _run(market, env, exploration_id="v-short", mode="variants", vary="stop_atr", values=["1", "2"])
    _, long = _run(market, env, exploration_id="v-long", mode="variants", vary="stop_atr", values=["1", "2", "3", "4", "5"])
    assert len([e for e in long if e["phase"] == "Probando variantes"]) > len([e for e in short if e["phase"] == "Probando variantes"])


# -------------------------------------------------------------------------------------------------- variants
def test_every_variant_is_in_the_ledger_before_the_report_exists(market, env, monkeypatch):
    seen = {}
    real = explore._write_report

    def spy(directory, report):
        seen["ledger_rows"] = len(_runs(env, "c27-breakout-perp"))
        seen["report_existed"] = os.path.exists(os.path.join(directory, "report.json"))
        return real(directory, report)

    monkeypatch.setattr(explore, "_write_report", spy)
    report, _ = _run(market, env, exploration_id="var-1", mode="variants", vary="stop_atr", values=["1", "1.5", "2", "3"])
    assert seen == {"ledger_rows": 4, "report_existed": False}
    assert report["attempts_in_family"] == 4 and report["family"] == "c27-breakout-perp"
    runs = _runs(env, "c27-breakout-perp")
    assert [json.loads(r["params_json"])["value"] for r in runs] == ["1", "1.5", "2", "3"]
    assert sorted(v["trial_id"] for v in report["variants"]) == sorted(r["id"] for r in runs)


def test_variants_are_ranked_by_net_result_then_by_entries_per_day(market, env):
    report, _ = _run(market, env, exploration_id="var-2", mode="variants", vary="target_stop_ratio",
                     values=["1", "1.5", "2", "2.5", "3"])
    rows = report["variants"]
    assert [r["rank"] for r in rows] == list(range(1, len(rows) + 1))
    ok = [r for r in rows if r["status"] == "ok"]
    assert len(ok) >= 3
    keys = [(-r["net_bp_mean"], -r["entries_per_day"]) for r in ok]
    assert keys == sorted(keys)
    assert rows[:len(ok)] == ok            # the ones that did not run go last
    assert all(set(r) >= {"value", "label", "trades", "entries_per_day", "net_bp_mean", "gross_bp_mean", "hit_rate",
                          "status", "trial_id"} for r in rows)
    assert sum(r["is_base"] for r in rows) == 0 or [r["value"] for r in rows if r["is_base"]] == ["2"]
    assert report["variants_headline"] and report["vary"]["kind"] == "param"


def test_the_base_value_is_marked_and_reuses_the_diagnostic(market, env):
    report, _ = _run(market, env, exploration_id="var-3", mode="variants", vary="target_stop_ratio", values=["2", "3"])
    base = [r for r in report["variants"] if r["is_base"]][0]
    assert base["value"] == "2" and base["trades"] == report["diagnostic"]["totals"]["trades"]
    assert base["net_bp_mean"] == pytest.approx(report["diagnostic"]["totals"]["net_bp_mean"])


def test_more_than_twelve_values_is_refused_and_nothing_is_written(market, env):
    with pytest.raises(contract.ContractError, match="12"):
        _run(market, env, exploration_id="var-4", mode="variants", vary="stop_atr", values=[str(1 + k / 10) for k in range(13)])
    assert not os.path.exists(os.path.join(env["out_dir"], "var-4")) and not os.path.exists(env["ledger_path"])
    _run(market, env, exploration_id="var-5", mode="variants", vary="stop_atr", values=[str(1 + k / 10) for k in range(12)])


def test_a_failed_variant_is_recorded_too(market, env):
    spec = json.loads(json.dumps(CUSTOM_A))
    path = "rules.checks[down].node.and[2].right.mul[1]"
    report, _ = _run(market, env, strategy=spec, exploration_id="var-6", mode="variants", vary=path, values=["0", "5.5", "7"])
    by_value = {r["value"]: r for r in report["variants"]}
    assert report["vary"]["kind"] == "condition" and "atr_ok" in report["vary"]["label"]
    assert by_value["5.5"]["status"] == "error" and by_value["5.5"]["error"]     # a constant with a point is not valid
    assert by_value["0"]["is_base"] and by_value["7"]["status"] in ("ok", "no_trades")
    runs = _runs(env, "test-custom-a")
    assert len(runs) == 3 and {r["status"] for r in runs} >= {"error"}
    assert report["attempts_in_family"] == 3


def test_repeating_an_exploration_adds_runs_not_variants(market, env):
    for name in ("again-1", "again-2"):
        report, _ = _run(market, env, exploration_id=name, mode="variants", vary="stop_atr", values=["1", "2"])
    assert report["attempts_in_family"] == 2 and len(_runs(env, "c27-breakout-perp")) == 4


def test_what_to_vary_must_exist_and_be_a_number(market, env):
    for vary, values in (("nope", ["1"]), ("rules.checks[9].node", ["1"]), ("rules.checks[long_break].node.left", ["1"]),
                         ("stop_atr", ["abc"]), ("stop_atr", [])):
        with pytest.raises(contract.ContractError):
            _run(market, env, exploration_id="bad", mode="variants", vary=vary, values=values)
    assert not os.path.exists(env["ledger_path"])


# ----------------------------------------------------------------------------------------- not supported
def test_an_unsupported_strategy_gets_a_report_that_says_why(market, env):
    report, events = _run(market, env, strategy=C32, exploration_id="unsup", mode="variants", vary="pct_high", values=["80", "90"])
    assert report["status"] == "unsupported" and "funding" in report["unsupported"]["reason"]
    assert report["diagnostic"] is None and report["variants"] is None
    assert not os.path.exists(env["ledger_path"]) or not _runs(env, "c32-funding-contrarian-24h-perp")
    assert events[-1]["progress"] == 100
    assert "No se pudo evaluar" in open(os.path.join(env["out_dir"], "unsup", "report.md"), encoding="utf-8").read()


# ------------------------------------------------------------------------------------- refusals and files
def test_an_existing_exploration_and_a_bad_id_are_refused(market, env):
    _run(market, env, exploration_id="once")
    with pytest.raises(contract.ContractError, match="ya existe"):
        _run(market, env, exploration_id="once")
    with pytest.raises(contract.ContractError):
        _run(market, env, exploration_id="../escape")


def test_a_strategy_by_id_path_or_dict(market, env):
    by_id, _ = _run(market, env, strategy="c27-breakout-perp-v1", exploration_id="by-id")
    by_path, _ = _run(market, env, strategy=C27, exploration_id="by-path")
    by_dict, _ = _run(market, env, strategy=load_spec(C27), exploration_id="by-dict")
    assert by_id["spec_hash"] == by_path["spec_hash"] == by_dict["spec_hash"]
    with pytest.raises(contract.ContractError):
        _run(market, env, strategy="no-such-strategy", exploration_id="x")


# ---------------------------------------------------------------- real datasets: holdout and manifest
@pytest.fixture(scope="module")
def dataset_dir(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("explore-data")
    cache = str(tmp / "cache")
    rows = helpers.synthetic_regimes(8 * 1440, seed=9, scale=4.0)
    helpers.write_cache(cache, PRODUCT, rows)
    config = tmp / "gate.json"
    config.write_text(json.dumps({"holdout_from": "2025-03-09", "default_from": "2025-03-01",
                                  "default_products": [PRODUCT], "rules": {"min_trades": 100}}))
    export_practice.export(PRODUCT, ["1m", "5m"], helpers.START_MS, contract.date_ms("2025-03-09"),
                           str(tmp / "practice" / PRODUCT), cache_dir=cache, gate_config=str(config), with_funding=False)
    return str(tmp / "practice"), str(config)


def test_it_runs_on_a_sealed_dataset_with_the_gate_products(dataset_dir, env):
    datasets, config = dataset_dir
    stream = io.StringIO()
    report = explore.run_exploration(C27, datasets_dir=datasets, gate_config=config, exploration_id="real", stream=stream, **env)
    assert report["products"] == [PRODUCT] and report["window"]["to"] == "2025-03-09T00:00:00Z"
    assert report["diagnostic"]["totals"]["trades"] > 5
    assert report["diagnostic"]["totals"]["funding_complete_share"] == 0       # no funding in this dataset: said, not hidden
    assert any("funding" in s for s in report["diagnostic"]["notes"])


def test_a_dataset_that_reaches_the_holdout_is_refused(dataset_dir, env, tmp_path):
    datasets, _ = dataset_dir
    earlier = tmp_path / "earlier.json"
    earlier.write_text(json.dumps({"holdout_from": "2025-03-05", "default_from": "2025-03-01", "default_products": [PRODUCT]}))
    with pytest.raises(contract.ContractError, match="reserva"):
        explore.run_exploration(C27, datasets_dir=datasets, gate_config=str(earlier), exploration_id="late", **env)
    assert not os.path.exists(os.path.join(env["out_dir"], "late"))


def test_a_modified_dataset_and_a_missing_one_are_refused(dataset_dir, env, tmp_path):
    datasets, config = dataset_dir
    copy = tmp_path / "copy"
    shutil.copytree(datasets, copy)
    path = copy / PRODUCT / "{}_1m.parquet".format(PRODUCT)
    path.chmod(0o644)
    path.write_bytes(path.read_bytes()[:-8] + b"\x00" * 8)
    with pytest.raises(contract.ContractError, match="manifiesto"):
        explore.run_exploration(C27, datasets_dir=str(copy), gate_config=config, exploration_id="tampered", **env)
    with pytest.raises(contract.ContractError, match="falta el dataset"):
        explore.run_exploration(C27, datasets_dir=datasets, gate_config=config, products=["PF_ETHUSD"],
                                exploration_id="missing", **env)


def test_the_command_line_prints_progress_and_writes_the_report(dataset_dir, env, capsys):
    datasets, config = dataset_dir
    code = explore.main(["--strategy", "c27-breakout-perp-v1", "--mode", "variants", "--vary", "stop_atr", "--values", "1,2",
                         "--datasets-dir", datasets, "--gate-config", config, "--exploration-id", "cli",
                         "--out-dir", env["out_dir"], "--ledger", env["ledger_path"]])
    assert code == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert lines[-1]["progress"] == 100 and all(set(e) == {"progress", "phase", "detail"} for e in lines)
    assert os.path.exists(os.path.join(env["out_dir"], "cli", "report.json"))
    assert explore.main(["--strategy", "c27-breakout-perp-v1", "--mode", "variants", "--vary", "stop_atr",
                         "--datasets-dir", datasets, "--gate-config", config, "--out-dir", env["out_dir"],
                         "--ledger", env["ledger_path"]]) == 2


# --------------------------------------------------------------------------------- the sentence rules
def _diag(trades_by_exit, per_day=25.0, funding=1.0):
    """A diagnostic made of fixed numbers: (reason, count, gross, net); every trade of a group has exactly those."""
    trades = []
    for reason, count, gross, net in trades_by_exit:
        for k in range(count):
            trades.append({"product": PRODUCT, "side": "LONG" if k % 2 else "SHORT", "exit_reason": reason,
                           "gross_bp": gross, "net_bp": net,
                           "funding_bp": 0.0, "funding_complete": funding > 0})
    days = len(trades) / per_day
    return rep.build_diagnostic(trades, {PRODUCT: days}, {"raw": len(trades), "skipped_by_cost": 0},
                                ["owner_close_crosses_frozen_donchian_mid"], 100)


def test_the_example_sentences_come_out_of_the_rules():
    diag = _diag([("target", 30, 80, 70), ("rule", 53, 5, -40), ("stop", 17, -20, -30)])
    assert "Los cierres por objetivo ganan +70 pb en promedio (son el 30 % de las operaciones)." in diag["works"]
    rule = [s for s in diag["fails"] if s.startswith("La salida por regla propia")][0]
    assert "cruce de la media del canal" in rule and "cierra el 53 % de las operaciones y siempre pierde" in rule
    assert any(s.startswith("Entra 25 veces por día") for s in diag["fails"])
    assert not any(word in s.lower() for s in diag["works"] + diag["fails"] for word in JARGON)


def test_a_strategy_that_wins_is_not_told_it_fails():
    diag = _diag([("target", 60, 80, 40), ("stop", 40, -30, -20)], per_day=2.0)
    assert any(s.startswith("En total gana") for s in diag["works"])
    assert not any(s.startswith("En total pierde") or "Entra" in s for s in diag["fails"])
    assert rep.sentences(_diag([("target", 5, 80, 40)]), [], 100)[1][-1].startswith("Con solo 5 operaciones")
