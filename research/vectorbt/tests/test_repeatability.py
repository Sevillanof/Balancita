import json
import os

import pytest

from research.vectorbt import data_contract as contract
from research.vectorbt import export_practice
from research.vectorbt.tests import helpers

PRODUCT = "PF_XBTUSD"
CONFIG = {"holdout_from": "2025-03-03", "default_from": "2025-03-01"}


def _setup(tmp_path, seed=7):
    cache = str(tmp_path / "cache{}".format(seed))
    helpers.write_cache(cache, PRODUCT, helpers.synthetic_minutes(2 * 1440, seed=seed))
    config = tmp_path / "gate.json"
    config.write_text(json.dumps(CONFIG))
    return cache, str(config)


def _export(tmp_path, cache, config, name):
    return export_practice.export(PRODUCT, ["1m", "5m"], helpers.START_MS, contract.date_ms("2025-03-03"),
                                  str(tmp_path / name), cache_dir=cache, gate_config=config, with_funding=False)


def test_same_inputs_give_the_same_bytes(tmp_path):
    cache, config = _setup(tmp_path)
    first, second = _export(tmp_path, cache, config, "a"), _export(tmp_path, cache, config, "b")
    assert first["dataset_sha256"] == second["dataset_sha256"]
    assert first["files"] == second["files"]


def test_a_sealed_dataset_is_read_only_and_cannot_be_replaced_with_other_data(tmp_path):
    cache, config = _setup(tmp_path)
    manifest = _export(tmp_path, cache, config, "sealed")
    assert _export(tmp_path, cache, config, "sealed")["dataset_sha256"] == manifest["dataset_sha256"]
    for name in os.listdir(tmp_path / "sealed"):
        assert not os.access(tmp_path / "sealed" / name, os.W_OK) or os.geteuid() == 0
    other_cache, _ = _setup(tmp_path, seed=99)
    with pytest.raises(contract.ContractError):
        _export(tmp_path, other_cache, config, "sealed")
