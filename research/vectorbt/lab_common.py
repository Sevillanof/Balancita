"""What the sweep and the feature study share: the dataset check against the gate's holdout and the 1m arrays."""

import hashlib
import json
import os
from datetime import datetime, timezone

import numpy as np
import pyarrow.parquet as pq

from . import data_contract as contract
from .engine import ROOT


def resolve_path(path):
    """A relative path is looked up in the working directory first, then in the repository root."""
    if os.path.isabs(path) or os.path.exists(path):
        return path
    return os.path.join(ROOT, path)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _parse_utc(text):
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def check_dataset(directory, gate_config=None):
    """Refuses a dataset that reaches the holdout or whose files do not match its manifest. Returns the manifest."""
    config_path = gate_config or contract.DEFAULT_GATE_CONFIG
    holdout = contract.holdout_ms(contract.load_gate_config(config_path))
    manifest_path = os.path.join(directory, "manifest.json")
    if not os.path.exists(manifest_path):
        raise contract.ContractError("no hay manifiesto en {}".format(directory))
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if _parse_utc(manifest["end_exclusive_utc"]) > holdout:
        raise contract.ContractError("el dataset llega hasta {} y pisa la reserva (desde {}): no se usa".format(
            manifest["end_exclusive_utc"], contract.iso(holdout)))
    for name, info in manifest["files"].items():
        path = os.path.join(directory, name)
        if not os.path.exists(path) or sha256_file(path) != info["sha256"]:
            raise contract.ContractError("{} no coincide con el manifiesto (¿se modificó?)".format(name))
        for resolution, step in contract.INTERVAL_MS.items():
            if name.endswith("_{}.parquet".format(resolution)) and info["last_bucket_ms"] + step > holdout:
                raise contract.ContractError("{} tiene velas que cierran después de la reserva".format(name))
    expected = hashlib.sha256("".join("{}:{}\n".format(n, manifest["files"][n]["sha256"])
                                      for n in sorted(manifest["files"])).encode()).hexdigest()
    if expected != manifest["dataset_sha256"]:
        raise contract.ContractError("el hash del dataset no coincide con el de sus archivos")
    return manifest


def load_1m(directory, manifest):
    """Index (ms) and float64 OHLCV arrays of the 1m table."""
    table = pq.read_table(os.path.join(directory, "{}_1m.parquet".format(manifest["product_id"])))
    index = np.array(table["bucket_start_ms"].to_pylist(), dtype=np.int64)
    o, h, l, c, v = (np.array(table[name].to_numpy(), dtype=np.float64)
                     for name in ("open", "high", "low", "close", "volume_btc"))
    return index, o, h, l, c, v


def load_candles(directory, manifest, resolution):
    """Index (ms) and float64 OHLCV arrays of the ``resolution`` table (``1m`` or ``5m``)."""
    table = pq.read_table(os.path.join(directory, "{}_{}.parquet".format(manifest["product_id"], resolution)))
    index = np.array(table["bucket_start_ms"].to_pylist(), dtype=np.int64)
    o, h, l, c, v = (np.array(table[name].to_numpy(), dtype=np.float64)
                     for name in ("open", "high", "low", "close", "volume_btc"))
    return index, o, h, l, c, v
