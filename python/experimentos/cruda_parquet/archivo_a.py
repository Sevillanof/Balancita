"""Candidate A (issue #248): the simple reference, standard library only.

Original messages are kept byte for byte in blocks compressed with zlib (or lzma). A block is a file; a manifest line CONFIRMS it.

Directory layout::

    epoch-000001     one EMPTY marker per epoch ever claimed (created O_EXCL + directory fsync BEFORE the first record of a writer is
                     accepted; the NAME is the ledger, so a kill while claiming cannot leave a half-written number behind)
    manifest.jsonl   one JSON line per CONFIRMED block (append-only)
    000001.blk       sealed block: header + compressed payload + sha256 trailer over everything before it
    000002.blk.tmp   block being sealed (never read as valid)
    *.partial        evidence of an interrupted or corrupt block, kept, never promoted

States of a message, in the words of CAPA-CRUDA-08: pending (in the writer's buffer), sealed-confirmed (block renamed AND manifest line
fsynced). A kill loses the pending ones: their numbers are NOT reused because every writer start takes a NEW ``epoch`` and the identity of a
message is ``(epoch, arrival_no)``.

Not demonstrated here: power loss and what the disk does on ``fsync`` (declared in the report).
"""
from __future__ import annotations

import hashlib
import json
import lzma
import os
import struct
import time
import zlib
from typing import Callable, Dict, Iterator, List, NamedTuple, Optional, Tuple

MAGIC = b"CRB1"
HEADER = struct.Struct(">4sBIQQ")  # magic, codec, record count, raw bytes, compressed length
FRAME = struct.Struct(">IQQBHHHHI")  # epoch, arrival_no, received_at, source, len(endpoint, product, time, seq), len(raw)
CODECS = {1: ("zlib", lambda b: zlib.compress(b, 6), zlib.decompress), 2: ("lzma", lambda b: lzma.compress(b, preset=1), lzma.decompress)}
CODEC_IDS = {name: key for key, (name, _, _) in CODECS.items()}
SOURCES = {"ws": 1, "rest": 2}
SOURCE_NAMES = {1: "ws", 2: "rest"}


class Record(NamedTuple):
    epoch: int
    arrival_no: int
    received_at: int
    source: str
    endpoint: str
    product: str
    provider_time: str
    provider_seq: str
    raw: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.raw).hexdigest()


def encode_records(records: List[Record]) -> bytes:
    out = []
    for r in records:
        parts = [r.endpoint.encode(), r.product.encode(), r.provider_time.encode(), r.provider_seq.encode()]
        out.append(FRAME.pack(r.epoch, r.arrival_no, r.received_at, SOURCES[r.source], *[len(p) for p in parts], len(r.raw)))
        out.extend(parts)
        out.append(r.raw)
        out.append(hashlib.sha256(r.raw).digest())
    return b"".join(out)


def decode_records(payload: bytes) -> Iterator[Record]:
    pos = 0
    while pos < len(payload):
        epoch, arrival, received, source, le, lp, lt, ls, lr = FRAME.unpack_from(payload, pos)
        pos += FRAME.size
        text = []
        for length in (le, lp, lt, ls):
            text.append(payload[pos:pos + length].decode())
            pos += length
        raw = payload[pos:pos + lr]
        pos += lr
        if hashlib.sha256(raw).digest() != payload[pos:pos + 32]:
            raise ValueError("record hash mismatch")
        pos += 32
        yield Record(epoch, arrival, received, SOURCE_NAMES[source], text[0], text[1], text[2], text[3], raw)


def build_block(records: List[Record], codec: str) -> bytes:
    payload = encode_records(records)
    packed = CODECS[CODEC_IDS[codec]][1](payload)
    head = HEADER.pack(MAGIC, CODEC_IDS[codec], len(records), len(payload), len(packed))
    body = head + packed
    return body + hashlib.sha256(body).digest()


def parse_block(data: bytes) -> List[Record]:
    """Verify the trailer, then decode. Raises ValueError for anything that is not a complete, intact block."""
    if len(data) < HEADER.size + 32:
        raise ValueError("block too short")
    body, trailer = data[:-32], data[-32:]
    if hashlib.sha256(body).digest() != trailer:
        raise ValueError("block trailer mismatch")
    magic, codec, count, raw_bytes, packed_len = HEADER.unpack_from(body)
    if magic != MAGIC or codec not in CODECS or len(body) != HEADER.size + packed_len:
        raise ValueError("block header invalid")
    payload = CODECS[codec][2](body[HEADER.size:])
    if len(payload) != raw_bytes:
        raise ValueError("block length mismatch")
    records = list(decode_records(payload))
    if len(records) != count:
        raise ValueError("block count mismatch")
    return records


def _read(path: str, mode: str = "rb"):
    with open(path, mode) as handle:
        return handle.read()


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _manifest_entry(number: int, name: str, data: bytes, records: List[Record], codec: str, adopted: bool) -> dict:
    entry = {
        "block": number, "file": name, "codec": codec, "count": len(records),
        "raw_bytes": sum(len(r.raw) for r in records), "file_bytes": len(data),
        "file_sha256": hashlib.sha256(data).hexdigest(),
        "first": [records[0].epoch, records[0].arrival_no], "last": [records[-1].epoch, records[-1].arrival_no],
        "recv_min": min(r.received_at for r in records), "recv_max": max(r.received_at for r in records),
        "products": sorted({r.product for r in records}),
    }
    if adopted:
        entry["adopted_after_crash"] = True
    return entry


def read_manifest(directory: str) -> List[dict]:
    """Confirmed blocks. A last line cut by a kill (no newline / broken JSON) was never confirmed and is ignored."""
    path = os.path.join(directory, "manifest.jsonl")
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, "rb") as handle:
        for line in handle.read().split(b"\n"):
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line.decode("utf-8")))
            except ValueError:
                break
    return entries


def _manifest_valid_end(directory: str) -> int:
    """Byte offset just after the last complete manifest line."""
    path = os.path.join(directory, "manifest.jsonl")
    if not os.path.exists(path):
        return 0
    data = _read(path)
    end = 0
    pos = 0
    while True:
        nl = data.find(b"\n", pos)
        if nl == -1:
            break
        try:
            json.loads(data[pos:nl].decode("utf-8"))
        except ValueError:
            break
        end = nl + 1
        pos = nl + 1
    return end


def recover(directory: str) -> dict:
    """Make the directory consistent after a stop. Never promotes a partial block.

    * ``*.blk.tmp`` -> renamed ``*.partial`` (evidence, ignored).
    * ``N.blk`` not in the manifest: if its trailer verifies it is COMPLETE (the kill came between rename and manifest) and is adopted by
      appending a manifest line marked ``adopted_after_crash``; otherwise renamed ``.partial``.
    * A confirmed block that is missing or corrupt is REPORTED (``confirmed_damaged``), never repaired silently.
    """
    os.makedirs(directory, exist_ok=True)
    report = {"partial": [], "adopted": [], "confirmed_damaged": [], "manifest_truncated_bytes": 0}
    path = os.path.join(directory, "manifest.jsonl")
    if os.path.exists(path):
        end = _manifest_valid_end(directory)
        extra = os.path.getsize(path) - end
        if extra:
            with open(path, "r+b") as handle:
                handle.truncate(end)
                handle.flush()
                os.fsync(handle.fileno())
            report["manifest_truncated_bytes"] = extra
    confirmed = {e["file"] for e in read_manifest(directory)}
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if name.endswith(".blk.tmp"):
            os.replace(full, full[:-len(".blk.tmp")] + ".blk.partial")
            report["partial"].append(name)
        elif name.endswith(".blk") and name not in confirmed:
            data = _read(full)
            try:
                records = parse_block(data)
            except Exception:
                os.replace(full, full + ".partial")
                report["partial"].append(name)
                continue
            codec = CODECS[data[4]][0]
            with open(path, "ab") as handle:
                handle.write((json.dumps(_manifest_entry(int(name[:-4]), name, data, records, codec, True), sort_keys=True) + "\n").encode())
                handle.flush()
                os.fsync(handle.fileno())
            report["adopted"].append(name)
    for entry in read_manifest(directory):
        full = os.path.join(directory, entry["file"])
        if not os.path.exists(full) or hashlib.sha256(_read(full)).hexdigest() != entry["file_sha256"]:
            report["confirmed_damaged"].append(entry["file"])
    _fsync_dir(directory)
    return report


def last_epoch(directory: str) -> int:
    best = 0
    if os.path.isdir(directory):
        for name in os.listdir(directory):
            if name.startswith("epoch-") and name[6:].isdigit():
                best = max(best, int(name[6:]))
    for entry in read_manifest(directory):
        best = max(best, entry["last"][0])
    return best


class BudgetExceeded(Exception):
    """The next block would push the files of the experiment past ``max_dir_bytes``. Nothing is written for that block."""


def tree_bytes(directory: str) -> int:
    total = 0
    for base, _, files in os.walk(directory):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


class WriterStats:
    def __init__(self):
        self.appended = 0
        self.sealed_blocks = 0
        self.sealed_raw_bytes = 0
        self.sealed_file_bytes = 0
        self.append_seconds = 0.0
        self.seal_seconds = 0.0
        self.seal_cpu_seconds = 0.0
        self.peak_buffer_bytes = 0
        self.peak_temp_bytes = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


class ArchiveWriter:
    """Single writer. ``hook(point, n)`` lets a test or a worker stop the process at an exact point (SIGKILL)."""

    def __init__(self, directory: str, block_records: int = 2000, block_bytes: int = 4 * 1024 * 1024, codec: str = "zlib",
                 hook: Optional[Callable[[str, int], None]] = None, max_dir_bytes: Optional[int] = None, external_bytes: int = 0):
        self.directory = directory
        self.block_records = block_records
        self.block_bytes = block_bytes
        self.codec = codec
        self.hook = hook or (lambda point, n: None)
        # Hard stop on the files of the experiment: bytes already on disk (this tree + ``external_bytes`` such as the corpus file) plus the
        # block about to be written (it exists twice at the peak: as ``.tmp`` and after the rename is accounted for by the same bytes).
        self.max_dir_bytes = max_dir_bytes
        self.external_bytes = external_bytes
        self.recovery = recover(directory)
        self.epoch = self._claim_epoch()  # a NEW epoch on every start: pending numbers lost in a kill are never reused
        numbers = [int(n[:6]) for n in os.listdir(directory) if len(n) >= 10 and n[:6].isdigit() and ".blk" in n]
        self.next_block = max(numbers + [e["block"] for e in read_manifest(directory)] + [0]) + 1
        self.next_arrival = 1
        self.buffer: List[Record] = []
        self.buffer_bytes = 0
        self.stats = WriterStats()
        self.closed = False

    def _claim_epoch(self) -> int:
        """Claim ``last + 1`` with an exclusive create of an empty marker file; a taken name means somebody (or an earlier run) has it."""
        candidate = last_epoch(self.directory) + 1
        while True:
            self.hook("epoch_claim_start", candidate)
            try:
                fd = os.open(os.path.join(self.directory, "epoch-%06d" % candidate), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                candidate += 1
                continue
            self.hook("epoch_claim_created", candidate)
            os.close(fd)
            _fsync_dir(self.directory)
            self.hook("epoch_claim_durable", candidate)
            return candidate

    def append(self, source: str, endpoint: str, product: str, raw: bytes, provider_time: str, provider_seq: str, received_at: int) -> Tuple[int, int]:
        started = time.perf_counter()
        record = Record(self.epoch, self.next_arrival, received_at, source, endpoint, product, provider_time, provider_seq, bytes(raw))
        self.next_arrival += 1
        self.buffer.append(record)
        self.buffer_bytes += len(raw)
        self.stats.appended += 1
        self.stats.peak_buffer_bytes = max(self.stats.peak_buffer_bytes, self.buffer_bytes)
        self.stats.append_seconds += time.perf_counter() - started
        self.hook("append", self.stats.appended)
        if len(self.buffer) >= self.block_records or self.buffer_bytes >= self.block_bytes:
            self.seal()
        return record.epoch, record.arrival_no

    @property
    def pending(self) -> int:
        return len(self.buffer)

    def seal(self) -> None:
        if not self.buffer:
            return
        wall, cpu = time.perf_counter(), time.process_time()
        records, self.buffer, self.buffer_bytes = self.buffer, [], 0
        data = build_block(records, self.codec)
        if self.max_dir_bytes is not None:
            needed = self.external_bytes + tree_bytes(self.directory) + len(data) + 1024  # block + a generous manifest line
            if needed > self.max_dir_bytes:
                self.buffer = records + self.buffer
                self.buffer_bytes = sum(len(r.raw) for r in self.buffer)
                raise BudgetExceeded("sealing block %d needs %d bytes, limit %d" % (self.next_block, needed, self.max_dir_bytes))
        name = "%06d.blk" % self.next_block
        tmp = os.path.join(self.directory, name + ".tmp")
        final = os.path.join(self.directory, name)
        with open(tmp, "wb") as handle:
            half = len(data) // 2
            handle.write(data[:half])
            handle.flush()
            self.hook("seal_half_written", self.next_block)
            handle.write(data[half:])
            handle.flush()
            os.fsync(handle.fileno())
        self.stats.peak_temp_bytes = max(self.stats.peak_temp_bytes, len(data))
        self.hook("seal_tmp_written", self.next_block)
        os.replace(tmp, final)
        _fsync_dir(self.directory)
        self.hook("seal_renamed", self.next_block)
        entry = _manifest_entry(self.next_block, name, data, records, self.codec, False)
        with open(os.path.join(self.directory, "manifest.jsonl"), "ab") as handle:
            line = (json.dumps(entry, sort_keys=True) + "\n").encode()
            handle.write(line[:len(line) // 2])
            handle.flush()
            self.hook("manifest_half_written", self.next_block)
            handle.write(line[len(line) // 2:])
            handle.flush()
            os.fsync(handle.fileno())
        self.hook("manifest_confirmed", self.next_block)
        self.next_block += 1
        self.stats.sealed_blocks += 1
        self.stats.sealed_raw_bytes += entry["raw_bytes"]
        self.stats.sealed_file_bytes += len(data)
        self.stats.seal_seconds += time.perf_counter() - wall
        self.stats.seal_cpu_seconds += time.process_time() - cpu

    def close(self) -> None:
        if not self.closed:
            self.seal()
            self.closed = True


class ArchiveReader:
    """Reads CONFIRMED blocks only, verifying each block against its manifest hash before decoding it.

Memory is NOT constant: it holds the whole manifest, decodes (and keeps alive) one block plus its compressed bytes at a time, and
``query``/``records`` consumers may materialise lists. Measure the total peak of each phase (see medir.py); do not assume a bound."""

    def __init__(self, directory: str):
        self.directory = directory
        self.entries = read_manifest(directory)

    def _block(self, entry: dict) -> List[Record]:
        data = _read(os.path.join(self.directory, entry["file"]))
        if hashlib.sha256(data).hexdigest() != entry["file_sha256"]:
            raise ValueError("confirmed block %s does not match its manifest hash" % entry["file"])
        return parse_block(data)

    def records(self) -> Iterator[Record]:
        for entry in self.entries:
            yield from self._block(entry)

    def query(self, recv_from: int, recv_to: int, product: Optional[str] = None) -> Iterator[Record]:
        """Records with recv_from <= received_at < recv_to; blocks outside the range or without the product are not opened."""
        for entry in self.entries:
            if entry["recv_max"] < recv_from or entry["recv_min"] >= recv_to:
                continue
            if product is not None and product not in entry["products"]:
                continue
            for record in self._block(entry):
                if recv_from <= record.received_at < recv_to and (product is None or record.product == product):
                    yield record

    def get(self, epoch: int, arrival_no: int) -> Optional[Record]:
        for entry in self.entries:
            if (epoch, arrival_no) < tuple(entry["first"]) or (epoch, arrival_no) > tuple(entry["last"]):
                continue
            for record in self._block(entry):
                if (record.epoch, record.arrival_no) == (epoch, arrival_no):
                    return record
        return None

    def verify(self) -> Dict[str, int]:
        blocks = records = 0
        for entry in self.entries:
            records += len(self._block(entry))
            blocks += 1
        return {"blocks": blocks, "records": records}


def annotate(records) -> Iterator[Tuple[int, int, str]]:
    """Marks, never deletes: (epoch, arrival_no, kind) for duplicates, empty, invalid UTF-8, invalid JSON and sequence regressions."""
    seen = set()
    last_seq: Dict[str, int] = {}
    for r in records:
        key = (r.source, r.endpoint, r.sha256)
        if key in seen:
            yield r.epoch, r.arrival_no, "duplicate_raw"
        seen.add(key)
        if not r.raw:
            yield r.epoch, r.arrival_no, "empty"
            continue
        try:
            text = r.raw.decode("utf-8")
        except UnicodeDecodeError:
            yield r.epoch, r.arrival_no, "invalid_utf8"
            continue
        try:
            json.loads(text)
        except ValueError:
            yield r.epoch, r.arrival_no, "invalid_json"
            continue
        if r.endpoint == "trade" and r.provider_seq.isdigit():
            seq = int(r.provider_seq)
            previous = last_seq.get(r.product, 0)
            if seq <= previous:
                yield r.epoch, r.arrival_no, "seq_regression"
            else:
                last_seq[r.product] = seq
