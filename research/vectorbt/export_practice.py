"""Exports Balancita's official Kraken candles of the PRACTICE window to sealed Parquet files with a manifest.

``python -m research.vectorbt.export_practice --product PF_XBTUSD --out data/research-vectorbt/practice``

* Only the window ``[from, holdout_from)`` of ``config/strategy-gate.json`` can be asked for; a window that touches the
  holdout is refused (never trimmed), and no candle that closes after it is ever read from the source.
* The source is a candle cache (``candles-<product>.sqlite``, the format of ``futures_history.CandleCache``) opened
  READ-ONLY. ``--fetch`` first fills a cache of the lab's own (``--cache-dir``) from Kraken's public charts API.
  Nothing is written into any Balancita database.
* Quiet minutes are filled with flat candles exactly like the engine does (``fill_gaps``) and every filled row says so
  in ``filled``; prices keep their original text (``*_text``) next to the float64 columns the lab computes with.
* The output is sealed: a second export to the same folder with other bytes is refused; the files are read-only.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq

from . import data_contract as contract
from .engine import CandleCache, fetch_funding, fill_gaps

SCHEMA = "balancita-research-dataset.v1"
COLUMNS = ("open", "high", "low", "close", "volume_btc")


def read_cache(cache_dir, product, resolution, from_ms, to_ms):
    """Candles of ``[from_ms, to_ms)`` that CLOSE by ``to_ms``, from a cache opened read-only."""
    path = os.path.join(cache_dir, "candles-{}.sqlite".format(product))
    if not os.path.exists(path):
        raise contract.ContractError("no hay caché de velas en {} (usá --fetch o --cache-dir)".format(path))
    step = contract.INTERVAL_MS[resolution]
    db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    try:
        rows = db.execute("SELECT t,o,h,l,c,v FROM candles WHERE res=? AND t>=? AND t+?<=? ORDER BY t",
                          (resolution, from_ms, step, to_ms)).fetchall()
    finally:
        db.close()
    return [{"bucket_start": t, "open": o, "high": h, "low": l, "close": c, "volume_btc": v}
            for t, o, h, l, c, v in rows]


def build_table(raw, resolution, product):
    """Filled candle table: float64 for the lab, the original text for exactness, ``filled`` marks the quiet minutes."""
    step = contract.INTERVAL_MS[resolution]
    seen = {c["bucket_start"] for c in raw}
    rows = fill_gaps(raw, step)
    columns = {
        "product_id": [product] * len(rows),
        "resolution": [resolution] * len(rows),
        "bucket_start_ms": [r["bucket_start"] for r in rows],
    }
    for name in COLUMNS:
        columns[name] = [float(r[name]) for r in rows]
    for name in COLUMNS:
        columns[name + "_text"] = [r[name] for r in rows]
    columns["filled"] = [r["bucket_start"] not in seen for r in rows]
    columns["source"] = ["kraken-official-candles"] * len(rows)
    return rows, pa.table(columns)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_parquet(table, path):
    # No pandas metadata, fixed compression: the same rows always give the same bytes.
    pq.write_table(table.replace_schema_metadata(None), path, compression="zstd", compression_level=3,
                   use_dictionary=True, write_statistics=True, data_page_version="2.0")


def export(product, resolutions, from_ms, to_ms, out_dir, *, cache_dir, gate_config=None, fetch=False,
           with_funding=True, funding_source=fetch_funding):
    config = contract.load_gate_config(gate_config)
    holdout = contract.holdout_ms(config)
    contract.check_window(from_ms, to_ms, holdout)
    if fetch:
        cache = CandleCache(os.path.join(cache_dir, "candles-{}.sqlite".format(product)))
        try:
            for resolution in resolutions:
                cache.ensure(product, resolution, from_ms, to_ms)
        finally:
            cache.close()
    staging = out_dir + ".staging"
    os.makedirs(staging, exist_ok=True)
    files = {}
    for resolution in resolutions:
        raw = read_cache(cache_dir, product, resolution, from_ms, to_ms)
        if not raw:
            raise contract.ContractError("sin velas {} de {} en la ventana pedida".format(resolution, product))
        rows, table = build_table(raw, resolution, product)
        contract.check_candles(rows, resolution, holdout)
        name = "{}_{}.parquet".format(product, resolution)
        write_parquet(table, os.path.join(staging, name))
        files[name] = {"rows": table.num_rows, "filled_rows": sum(r["filled"] for r in table.to_pylist()),
                       "first_bucket_ms": rows[0]["bucket_start"], "last_bucket_ms": rows[-1]["bucket_start"]}
    if with_funding:
        periods = [(s, r) for s, r in funding_source(product) if s + 3_600_000 <= to_ms]
        name = "{}_funding.parquet".format(product)
        table = pa.table({"product_id": [product] * len(periods), "period_start_ms": [s for s, _ in periods],
                          "relative_rate_per_hour": [float(r) for _, r in periods]})
        write_parquet(table, os.path.join(staging, name))
        files[name] = {"rows": len(periods)}
    for name, info in files.items():
        info["sha256"] = sha256_file(os.path.join(staging, name))
    dataset_sha = hashlib.sha256("".join("{}:{}\n".format(n, files[n]["sha256"]) for n in sorted(files)).encode()).hexdigest()
    manifest = {
        "schema": SCHEMA, "product_id": product, "resolutions": list(resolutions),
        "start_inclusive_utc": contract.iso(from_ms), "end_exclusive_utc": contract.iso(to_ms),
        "holdout_from": config["holdout_from"], "gate_config_sha256": sha256_file(
            gate_config or contract.DEFAULT_GATE_CONFIG),
        "dataset_sha256": dataset_sha, "source": "kraken-official-candles", "files": files,
        "filled_rows_note": "filled=true marks quiet minutes filled with a flat candle, as the engine does",
        "created_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    return _seal(staging, out_dir, manifest)


def _seal(staging, out_dir, manifest):
    target_manifest = os.path.join(out_dir, "manifest.json")
    if os.path.exists(target_manifest):
        with open(target_manifest, encoding="utf-8") as handle:
            sealed = json.load(handle)
        for name in os.listdir(staging):
            os.remove(os.path.join(staging, name))
        os.rmdir(staging)
        if sealed["dataset_sha256"] != manifest["dataset_sha256"]:
            raise contract.ContractError("{} ya está sellado con otros datos (usá otra carpeta)".format(out_dir))
        return sealed
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    with open(os.path.join(staging, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.rename(staging, out_dir)
    for name in os.listdir(out_dir):
        os.chmod(os.path.join(out_dir, name), stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--product", default="PF_XBTUSD")
    parser.add_argument("--resolutions", default="1m,5m")
    parser.add_argument("--gate-config", default=None)
    parser.add_argument("--from", dest="from_date", default=None, help="YYYY-MM-DD (default: default_from of the gate)")
    parser.add_argument("--to", dest="to_date", default=None, help="YYYY-MM-DD, exclusive (default: the holdout)")
    parser.add_argument("--cache-dir", default="data/research-vectorbt/cache")
    parser.add_argument("--fetch", action="store_true", help="fill the lab's own cache from Kraken's public API first")
    parser.add_argument("--no-funding", action="store_true")
    parser.add_argument("--out", default="data/research-vectorbt/practice")
    args = parser.parse_args(argv)
    config = contract.load_gate_config(args.gate_config)
    from_ms = contract.date_ms(args.from_date or config["default_from"])
    to_ms = contract.date_ms(args.to_date) if args.to_date else contract.holdout_ms(config)
    try:
        manifest = export(args.product, args.resolutions.split(","), from_ms, to_ms,
                          os.path.join(args.out, args.product), cache_dir=args.cache_dir, gate_config=args.gate_config,
                          fetch=args.fetch, with_funding=not args.no_funding)
    except contract.ContractError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    print(json.dumps({k: manifest[k] for k in ("product_id", "start_inclusive_utc", "end_exclusive_utc",
                                              "dataset_sha256")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
