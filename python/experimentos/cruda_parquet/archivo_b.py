"""Candidate B (issue #248): Parquet blocks that keep the ORIGINAL payload, on the same writer/recovery/manifest protocol as candidate A.

Only the block format differs (``archivo_a.BlockFormat``): epoch, claim, ``.tmp`` + rename, manifest line = confirmation, recovery and
``ArchiveDamaged`` are shared, so A and B are compared on the format and nothing else.

One Parquet file per block, one row per message: identity (epoch, arrival_no), ``received_at``, source, endpoint, product, the provider's
time and sequence as TEXT (never reinterpreted), ``raw_bytes`` (the payload byte for byte, binary column) and ``raw_sha256``. Parquet is NOT
compared byte for byte (the file bytes depend on the library version); what is checked is that every ``raw_bytes`` comes back identical,
the counts, and the per-record hash. Page checksums are written; the manifest sha256 of the whole file is the confirmation that counts.

pyarrow is imported HERE and nowhere else (python/tests/test_cruda_aislamiento.py). It is an optional, pinned, offline-only dependency
installed in a separate virtualenv (see docs/experimento-cruda-248.md); without it this module raises ``ParquetUnavailable`` on use.
"""
from __future__ import annotations

import hashlib
import io
from typing import List

from experimentos.cruda_parquet.archivo_a import BlockFormat, Record

try:  # pragma: no cover - exercised only where pyarrow is installed
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:  # pragma: no cover
    pa = pq = None

CODECS = ("zstd", "snappy", "gzip", "none")
COLUMNS = ("epoch", "arrival_no", "received_at", "source", "endpoint", "product", "provider_time", "provider_seq", "raw_bytes", "raw_sha256")


class ParquetUnavailable(RuntimeError):
    """pyarrow is not installed in this interpreter (the experiment's optional dependency)."""


def available() -> bool:
    return pq is not None


def version() -> str:
    return pa.__version__ if pa is not None else "unavailable"


def _need() -> None:
    if pq is None:
        raise ParquetUnavailable("pyarrow is not installed; run candidate B from the pinned virtualenv")


def build_block(records: List[Record], codec: str) -> bytes:
    _need()
    if codec not in CODECS:
        raise ValueError("unknown codec %r" % codec)
    table = pa.table({
        "epoch": pa.array([r.epoch for r in records], pa.int64()),
        "arrival_no": pa.array([r.arrival_no for r in records], pa.int64()),
        "received_at": pa.array([r.received_at for r in records], pa.int64()),
        "source": pa.array([r.source for r in records], pa.string()),
        "endpoint": pa.array([r.endpoint for r in records], pa.string()),
        "product": pa.array([r.product for r in records], pa.string()),
        "provider_time": pa.array([r.provider_time for r in records], pa.string()),
        "provider_seq": pa.array([r.provider_seq for r in records], pa.string()),
        "raw_bytes": pa.array([r.raw for r in records], pa.binary()),
        "raw_sha256": pa.array([hashlib.sha256(r.raw).hexdigest() for r in records], pa.string()),
    })
    sink = io.BytesIO()
    pq.write_table(table, sink, compression=None if codec == "none" else codec, use_dictionary=False, write_page_checksum=True)
    return sink.getvalue()


def parse_block(data: bytes) -> List[Record]:
    """Raises for anything that is not a complete, intact block (truncated footer, bad checksum, hash mismatch, wrong schema)."""
    _need()
    table = pq.read_table(io.BytesIO(data), page_checksum_verification=True)
    if tuple(table.column_names) != COLUMNS:
        raise ValueError("unexpected columns")
    cols = {name: table.column(name).to_pylist() for name in COLUMNS}
    records = []
    for i in range(table.num_rows):
        raw = cols["raw_bytes"][i]
        if hashlib.sha256(raw).hexdigest() != cols["raw_sha256"][i]:
            raise ValueError("record hash mismatch")
        records.append(Record(cols["epoch"][i], cols["arrival_no"][i], cols["received_at"][i], cols["source"][i], cols["endpoint"][i],
                              cols["product"][i], cols["provider_time"][i], cols["provider_seq"][i], raw))
    return records


def codec_of(data: bytes) -> str:
    _need()
    name = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(8).compression.lower()
    return "none" if name == "uncompressed" else name


FORMAT_B = BlockFormat("B", build_block, parse_block, codec_of)
