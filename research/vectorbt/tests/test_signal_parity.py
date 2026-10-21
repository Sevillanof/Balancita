"""C27 in VectorBT against the engine, on synthetic candles: zero signal differences, every exit difference explained."""

import json

import numpy as np
import pytest

from research.vectorbt import data_contract as contract
from research.vectorbt import export_practice, parity
from research.vectorbt.engine import load_spec
from research.vectorbt.tests import helpers

PRODUCT = "PF_XBTUSD"
SPEC = "config/strategies/c27-breakout-perp-v1.json"


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("parity")
    cache = str(tmp / "cache")
    helpers.write_cache(cache, PRODUCT, helpers.synthetic_minutes(14 * 1440, seed=11))
    config = tmp / "gate.json"
    config.write_text(json.dumps({"holdout_from": "2025-03-15", "default_from": "2025-03-01"}))
    out = str(tmp / "practice" / PRODUCT)
    export_practice.export(PRODUCT, ["1m", "5m"], helpers.START_MS, contract.date_ms("2025-03-15"), out,
                           cache_dir=cache, gate_config=str(config), with_funding=False)
    return out


@pytest.fixture(scope="module")
def result(dataset):
    return parity.compare(load_spec(SPEC), dataset)


def test_there_are_signals_to_compare(result):
    signals = result["signals"]
    assert signals["engine_long"] > 5 and signals["engine_short"] > 5


def test_zero_signal_differences(result):
    assert result["signals"]["differences"] == 0, result["signals"]["first_differences"]


def test_trades_agree_except_for_explained_touches(result):
    trades = result["trades"]
    assert trades["engine"] > 10
    assert trades["matched_by_entry"] >= trades["engine"] - 1 - trades["different_exit"]
    for difference in trades["first_exit_differences"]:
        assert difference["engine_exit_candle_only_touches_level"], difference
    assert trades["same_exit_max_abs_residual_bp"] < 0.01


def test_a_tampered_dataset_is_refused(dataset, tmp_path):
    import shutil
    copy = tmp_path / "copy"
    shutil.copytree(dataset, copy)
    path = copy / "PF_XBTUSD_1m.parquet"
    path.chmod(0o644)
    path.write_bytes(path.read_bytes()[:-8] + b"\x00" * 8)
    with pytest.raises(contract.ContractError):
        parity.load_dataset(str(copy), "1m")
