import json
import os
import sqlite3

import pyarrow.parquet as pq
import pytest

from research.vectorbt import data_contract as contract
from research.vectorbt import export_practice
from research.vectorbt.tests import helpers

PRODUCT = "PF_XBTUSD"


def _config(tmp_path, holdout):
    path = tmp_path / "gate.json"
    path.write_text(json.dumps({"holdout_from": holdout, "default_from": "2025-03-01"}))
    return str(path)


def _cache_across_holdout(tmp_path):
    """Three days of candles; the holdout falls in the middle of day two (2025-03-02 12:00 would not be a date, so
    the holdout is day two and everything from it on is poisoned with absurd prices."""
    minutes = helpers.synthetic_minutes(3 * 1440)
    poison_from = helpers.START_MS + 1440 * helpers.MINUTE_MS
    for row in minutes:
        if row["bucket_start"] >= poison_from:
            row.update(open="1", high="999999999", low="1", close="999999999", volume_btc="1")
    cache = str(tmp_path / "cache")
    helpers.write_cache(cache, PRODUCT, minutes)
    return cache


def test_candles_from_the_holdout_never_reach_the_dataset(tmp_path):
    cache = _cache_across_holdout(tmp_path)
    config = _config(tmp_path, "2025-03-02")
    holdout = contract.date_ms("2025-03-02")
    out = str(tmp_path / "practice" / PRODUCT)
    export_practice.export(PRODUCT, ["1m", "5m"], helpers.START_MS, holdout, out, cache_dir=cache,
                           gate_config=config, with_funding=False)
    for resolution, step in (("1m", 60_000), ("5m", 300_000)):
        table = pq.read_table(os.path.join(out, "{}_{}.parquet".format(PRODUCT, resolution)))
        starts = table["bucket_start_ms"].to_pylist()
        assert starts and max(starts) + step <= holdout
        assert max(table["high"].to_pylist()) < 999999


def test_a_window_that_touches_the_holdout_is_refused_not_trimmed(tmp_path):
    cache = _cache_across_holdout(tmp_path)
    config = _config(tmp_path, "2025-03-02")
    with pytest.raises(contract.ContractError):
        export_practice.export(PRODUCT, ["1m"], helpers.START_MS, contract.date_ms("2025-03-03"),
                               str(tmp_path / "out"), cache_dir=cache, gate_config=config, with_funding=False)
    assert not os.path.exists(tmp_path / "out")


def test_the_source_cache_is_opened_read_only(tmp_path):
    cache = _cache_across_holdout(tmp_path)
    path = os.path.join(cache, "candles-{}.sqlite".format(PRODUCT))
    before = os.path.getmtime(path)
    export_practice.export(PRODUCT, ["1m"], helpers.START_MS, contract.date_ms("2025-03-02"),
                           str(tmp_path / "out"), cache_dir=cache, gate_config=_config(tmp_path, "2025-03-02"),
                           with_funding=False)
    assert os.path.getmtime(path) == before
    assert not os.path.exists(path + "-wal")


def test_check_candles_rejects_a_candle_that_closes_after_the_holdout():
    holdout = contract.date_ms("2025-03-02")
    row = {"bucket_start": holdout - 60_000 + 1, "open": "1", "high": "2", "low": "1", "close": "2", "volume_btc": "1"}
    with pytest.raises(contract.ContractError):
        contract.check_candles([row], "1m", holdout)
