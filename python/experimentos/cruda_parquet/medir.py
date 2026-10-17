"""Issue #248: measurement script for candidates A (standard library) and B (Parquet). NOT a test: large runs never go through CI.

``PYTHONPATH=python python3 -m experimentos.cruda_parquet.medir [--formato A|B] [--registros N ...] [--max-bytes B] [--seed S] [--bloque N] [--codec C]``

B needs pyarrow: run it with the interpreter of the pinned virtualenv (docs/experimento-cruda-248.md). Codecs: A zlib|lzma, B zstd|snappy|gzip|none.

Each phase (generate, write+seal, query, rebuild) runs in a FRESH child process; the child's peak memory (whole process, never assumed
constant: manifest, query lists, decompression and copies while sealing all count) and CPU come from
``resource.getrusage(RUSAGE_CHILDREN)`` read by a wrapper process whose only child is the workload, so phases never share memory. Everything is SYNTHETIC: nothing here calibrates the real capture and nothing is extrapolated.
"""
from __future__ import annotations

import argparse
import json
import os
import resource
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from typing import Iterator

from experimentos.cruda_parquet import archivo_a as A
from experimentos.cruda_parquet import archivo_b as B
from experimentos.cruda_parquet.confirmacion import compare_paths
from experimentos.cruda_parquet.corpus import CorpusConfig, Message, corpus_hash, generate, size_summary
from experimentos.cruda_parquet.derivacion import derivation_hash, derive_minutes

GIB = 1024 ** 3
DEFAULT_CAP = 2 * GIB  # original + compressed + temporary space must fit here, else the step is skipped and declared
FIELD = struct.Struct(">I")
PYTHON_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def child_env() -> dict:
    return dict(os.environ, PYTHONPATH=PYTHON_DIR)


def estimate_fits(corpus_bytes: int, block_bytes: int, cap: int = DEFAULT_CAP) -> bool:
    """ESTIMATE only (not a guarantee): corpus file + an archive as big as the raw bytes + one block of temporary space.

    It ignores serialisation overhead, compression that expands, metadata, filesystem rounding and any other artifact. What IS enforced
    while running is the HARD STOP below: the corpus file never exceeds its cap (``write_corpus``) and ArchiveWriter refuses to seal a block
    when corpus + archive tree + the new block would pass ``cap`` (``BudgetExceeded``). Memory is NOT limited by either; it is measured."""
    return 2 * corpus_bytes + block_bytes <= cap


def rss_mib(maxrss: int, platform: str) -> float:
    """``ru_maxrss`` is KiB on Linux and BYTES on macOS (Darwin); other platforms are not claimed (treated like Linux, flagged by name)."""
    return round(maxrss / (1048576.0 if platform == "darwin" else 1024.0), 1)


META = ("source", "endpoint", "product", "provider_time", "provider_seq", "received_at")


def _meta(item) -> tuple:
    return tuple(getattr(item, name) for name in META)


def compare_streams(left, right) -> dict:
    """Full comparison: same cardinality AND the same payload bytes AND the same metadata fields for every pair (a truncated, missing or
    re-labelled record cannot pass). Identity (epoch, arrival_no) is not compared: the corpus has none."""
    import hashlib
    count_left = count_right = mismatches = 0
    digest_left, digest_right = hashlib.sha256(), hashlib.sha256()
    sentinel = object()
    iterator_left, iterator_right = iter(left), iter(right)
    while True:
        a, b = next(iterator_left, sentinel), next(iterator_right, sentinel)
        if a is sentinel and b is sentinel:
            break
        if a is not sentinel:
            count_left += 1
            digest_left.update(hashlib.sha256(a.raw).digest())
        if b is not sentinel:
            count_right += 1
            digest_right.update(hashlib.sha256(b.raw).digest())
        if a is sentinel or b is sentinel or a.raw != b.raw or _meta(a) != _meta(b):
            mismatches += 1
    return {"count_left": count_left, "count_right": count_right, "mismatches": mismatches,
            "sha256_left": digest_left.hexdigest(), "sha256_right": digest_right.hexdigest(),
            "equal": count_left == count_right and mismatches == 0 and digest_left.digest() == digest_right.digest()}


def frame_bytes(m) -> int:
    return 7 * FIELD.size + sum(len(p) for p in (m.source.encode(), m.endpoint.encode(), m.product.encode(), m.provider_time.encode(),
                                                 m.provider_seq.encode(), str(m.received_at).encode(), m.raw))


def write_corpus(path: str, messages, max_file_bytes=None) -> dict:
    """Writes the corpus file; with ``max_file_bytes`` it stops BEFORE a frame that would pass the cap (hard limit on the file)."""
    count = total = written = 0
    stopped = False
    with open(path, "wb") as handle:
        for m in messages:
            if max_file_bytes is not None and written + frame_bytes(m) > max_file_bytes:
                stopped = True
                break
            for part in (m.source.encode(), m.endpoint.encode(), m.product.encode(), m.provider_time.encode(), m.provider_seq.encode(),
                         str(m.received_at).encode(), m.raw):
                handle.write(FIELD.pack(len(part)))
                handle.write(part)
            written += frame_bytes(m)
            count += 1
            total += len(m.raw)
    return {"records": count, "raw_bytes": total, "file_bytes": written, "stopped_by_file_cap": stopped}


def read_corpus(path: str) -> Iterator[Message]:
    with open(path, "rb") as handle:
        while True:
            head = handle.read(4)
            if not head:
                return
            parts = []
            for index in range(7):
                length = FIELD.unpack(head if index == 0 else handle.read(4))[0]
                parts.append(handle.read(length))
            yield Message(parts[0].decode(), parts[1].decode(), parts[2].decode(), parts[6], parts[3].decode(), parts[4].decode(), int(parts[5]))


def fmt_of(args):
    if args.formato == "B":
        if not B.available():
            raise SystemExit("candidate B needs pyarrow: run with the interpreter of the pinned virtualenv")
        return B.FORMAT_B
    return A.FORMAT_A


def archive_dir(args) -> str:
    return os.path.join(args.work, "archivo_" + args.formato.lower())


def tree_total(path: str) -> int:
    return A.tree_bytes(path)


def directory_bytes(path: str) -> int:
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, files in os.walk(path) for f in files)


# ---- workloads (each runs in its own process) --------------------------------------------------

def work_generate(args) -> dict:
    started = time.perf_counter()
    config = CorpusConfig(seed=args.seed, max_records=args.registros, max_corpus_bytes=args.max_bytes)
    info = write_corpus(os.path.join(args.work, "corpus.bin"), generate(config), max_file_bytes=max(0, args.tope_bytes // 2 - args.bloque_bytes))
    sizes = size_summary(read_corpus(os.path.join(args.work, "corpus.bin")))
    digest, _, _ = corpus_hash(read_corpus(os.path.join(args.work, "corpus.bin")))
    return dict(info, seconds=round(time.perf_counter() - started, 3), corpus_sha256=digest, sizes=sizes)


def work_write(args) -> dict:
    archive = archive_dir(args)
    shutil.rmtree(archive, ignore_errors=True)
    started = time.perf_counter()
    corpus_bytes = os.path.getsize(os.path.join(args.work, "corpus.bin"))
    writer = A.ArchiveWriter(archive, block_records=args.bloque, block_bytes=args.bloque_bytes, codec=args.codec,
                             max_dir_bytes=args.tope_bytes, external_bytes=corpus_bytes, fmt=fmt_of(args))
    try:
        for m in read_corpus(os.path.join(args.work, "corpus.bin")):
            writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
        writer.close()
    except A.BudgetExceeded as error:
        return {"stopped": "budget", "reason": str(error), "appended": writer.stats.appended, "sealed_blocks": writer.stats.sealed_blocks,
                "total_bytes": corpus_bytes + A.tree_bytes(archive), "limit_bytes": args.tope_bytes}
    stats = writer.stats.as_dict()
    wall = time.perf_counter() - started
    return {"wall_seconds": round(wall, 3), "records_per_second": round(stats["appended"] / wall, 1) if wall else None,
            "append_seconds": round(stats["append_seconds"], 3), "seal_seconds": round(stats["seal_seconds"], 3),
            "seal_cpu_seconds": round(stats["seal_cpu_seconds"], 3), "blocks": stats["sealed_blocks"], "raw_bytes": stats["sealed_raw_bytes"],
            "archive_bytes": directory_bytes(archive), "ratio": round(stats["sealed_raw_bytes"] / max(1, stats["sealed_file_bytes"]), 3),
            "peak_buffer_bytes": stats["peak_buffer_bytes"], "confirm_latency_max_seconds": round(stats["confirm_latency_max"], 4),
            "confirm_latency_mean_seconds": round(stats["confirm_latency_sum"] / max(1, stats["confirmed_records"]), 4),
            "confirmed_records": stats["confirmed_records"], "pending_at_close": writer.pending, "peak_temp_block_bytes": stats["peak_temp_bytes"], "codec": args.codec, "formato": args.formato,
            "total_bytes": corpus_bytes + A.tree_bytes(archive), "limit_bytes": args.tope_bytes}


def work_query(args) -> dict:
    archive = archive_dir(args)
    out = {}
    started = time.perf_counter()
    reader = A.ArchiveReader(archive, fmt_of(args))
    out["startup_seconds"] = round(time.perf_counter() - started, 4)
    entries = reader.entries
    mid = entries[len(entries) // 2]
    started = time.perf_counter()
    window = list(reader.query(mid["recv_min"], mid["recv_max"] + 1, "PF_XBTUSD"))
    out["range_product"] = {"seconds": round(time.perf_counter() - started, 4), "records": len(window)}
    started = time.perf_counter()
    kinds = {}
    for _, _, kind in A.annotate(reader.records()):
        kinds[kind] = kinds.get(kind, 0) + 1
    out["annotate_all"] = {"seconds": round(time.perf_counter() - started, 4), "marks": kinds}
    started = time.perf_counter()
    found = reader.get(*mid["first"])
    out["get_one"] = {"seconds": round(time.perf_counter() - started, 4), "found": found is not None}
    started = time.perf_counter()
    out["verify_all"] = dict(reader.verify(), seconds=round(time.perf_counter() - started, 4))
    return out


def work_rebuild(args) -> dict:
    archive = archive_dir(args)
    started = time.perf_counter()
    reader = A.ArchiveReader(archive, fmt_of(args))
    from_archive = derivation_hash(derive_minutes(reader.records()))
    seconds = round(time.perf_counter() - started, 3)
    from_corpus = derivation_hash(derive_minutes(read_corpus(os.path.join(args.work, "corpus.bin"))))
    comparison = compare_streams(reader.records(), read_corpus(os.path.join(args.work, "corpus.bin")))
    return {"seconds_from_archive": seconds, "derivation_sha256": from_archive, "equals_corpus": from_archive == from_corpus,
            "byte_exact_round_trip": comparison["equal"], "comparison": comparison}


def work_contrast(args) -> dict:
    """A real SIGKILL at 60 % of the records, then the pending-consuming path against the confirmed one (BAL-REV-183-DURABILIDAD-09).

    Reference = derivation over CONFIRMED records only; the pending path consumed every appended record. Divergence is labelled, not
    "fixed"; no sync frequency or loss window is chosen here. Uses its own small synthetic corpus (seed, up to 20 000 records)."""
    count = min(args.registros, 20_000)
    kill_at = max(1, count * 6 // 10)
    directory = os.path.join(args.work, "contraste_" + args.formato.lower())
    shutil.rmtree(directory, ignore_errors=True)
    started = time.perf_counter()
    proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.escritor_trabajo", directory, str(args.seed), str(count), "append",
                           str(kill_at), str(args.bloque if args.bloque < count else max(1, count // 10)), args.formato, args.codec],
                          capture_output=True, text=True, env=child_env())
    fmt = fmt_of(args)
    recovery = A.recover(directory, fmt)
    consumed = list(generate(CorpusConfig(seed=args.seed, max_records=count, max_size=8192)))[:kill_at]
    reader = A.ArchiveReader(directory, fmt)
    confirmed = list(reader.records())
    # the corpus has no identity: the killed run numbers its records 1..N in epoch 1, in the corpus order
    consumed_records = [A.Record(1, i + 1, m.received_at, m.source, m.endpoint, m.product, m.provider_time, m.provider_seq, m.raw)
                        for i, m in enumerate(consumed)]
    result = compare_paths(consumed_records, confirmed)
    result.update({"killed": proc.returncode < 0, "returncode": proc.returncode, "kill_after_appended": kill_at, "seconds": round(time.perf_counter() - started, 3),
                   "recovery": {k: v for k, v in recovery.items() if v}, "confirmed_blocks": len(reader.entries)})
    return result


WORKLOADS = {"generar": work_generate, "escribir": work_write, "consultar": work_query, "reconstruir": work_rebuild, "contrastar": work_contrast}


# ---- process plumbing ---------------------------------------------------------------------------

def cli_args(args, phase: str):
    return [phase, "--work", args.work, "--registros", str(args.registros), "--max-bytes", str(args.max_bytes), "--seed", str(args.seed),
            "--bloque", str(args.bloque), "--bloque-bytes", str(args.bloque_bytes), "--codec", args.codec, "--formato", args.formato, "--tope-bytes", str(args.tope_bytes)]


def run_wrapper(args) -> None:
    """Spawn the workload as the ONLY child, then report its peak RSS and CPU from RUSAGE_CHILDREN."""
    started = time.perf_counter()
    proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.medir", "trabajo"] + cli_args(args, args.fase),
                          capture_output=True, text=True, env=child_env())
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = {"fase": args.fase, "returncode": proc.returncode, "elapsed_seconds": round(time.perf_counter() - started, 3),
              "peak_rss_mib": rss_mib(usage.ru_maxrss, sys.platform), "rss_platform": sys.platform, "cpu_user_seconds": round(usage.ru_utime, 3),
              "cpu_system_seconds": round(usage.ru_stime, 3)}
    try:
        result["detalle"] = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        result["error"] = (proc.stderr or proc.stdout)[-400:]
    print(json.dumps(result, sort_keys=True))


def orchestrate(args) -> dict:
    default_codec(args)
    report = {"python": sys.version.split()[0], "platform": sys.platform, "formato": args.formato, "pyarrow": B.version() if args.formato == "B" else None, "seed": args.seed, "codec": args.codec, "bloque_registros": args.bloque,
              "bloque_bytes": args.bloque_bytes, "tope_bytes": args.tope_bytes, "escalones": []}
    for registros in args.registros_lista:
        args.registros = registros
        step = {"registros_pedidos": registros, "max_bytes_corpus": args.max_bytes}
        worst = min(args.max_bytes, registros * 64 * 1024)
        if registros < 1 or args.max_bytes < 1 or args.bloque_bytes < 1 or args.tope_bytes < 1:
            step["omitido"] = "argumentos no positivos"
            report["escalones"].append(step)
            continue
        if not estimate_fits(worst, args.bloque_bytes, args.tope_bytes):
            step["omitido"] = "estimación: original + comprimido + bloque temporal no entran en %d bytes (el tope duro se aplica igual al correr)" % args.tope_bytes
            report["escalones"].append(step)
            continue
        args.work = tempfile.mkdtemp(prefix="cruda-medir-")
        try:
            for phase in ("generar", "escribir", "consultar", "reconstruir", "contrastar"):
                if tree_total(args.work) > args.tope_bytes:
                    step["detenido"] = "los archivos de trabajo ya pasan el tope de %d bytes antes de la fase %s" % (args.tope_bytes, phase)
                    break
                out = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.medir", "envoltura"] + cli_args(args, phase),
                                     capture_output=True, text=True, env=child_env())
                step[phase] = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {"error": out.stderr[-400:]}
            step["disco"] = {"corpus_bytes": os.path.getsize(os.path.join(args.work, "corpus.bin")),
                             "archivo_bytes": directory_bytes(archive_dir(args)), "total_bytes": tree_total(args.work)}
        finally:
            shutil.rmtree(args.work, ignore_errors=True)
        report["escalones"].append(step)
    return report


def default_codec(args) -> None:
    valid = ("zlib", "lzma") if args.formato == "A" else B.CODECS
    if args.codec is None:
        args.codec = valid[0]
    if args.codec not in valid:
        raise SystemExit("codec %s is not valid for format %s (use %s)" % (args.codec, args.formato, "/".join(valid)))


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("modo", nargs="?", default="orquestar", choices=["orquestar", "envoltura", "trabajo"])
    p.add_argument("fase", nargs="?", choices=sorted(WORKLOADS))
    p.add_argument("--registros", type=int, default=10_000)
    p.add_argument("--registros-lista", type=int, nargs="*", default=[10_000, 100_000])
    p.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    p.add_argument("--seed", type=int, default=248)
    p.add_argument("--bloque", type=int, default=10_000)
    p.add_argument("--bloque-bytes", type=int, default=8 * 1024 * 1024)
    p.add_argument("--formato", default="A", choices=["A", "B"])
    p.add_argument("--codec", default=None, choices=["zlib", "lzma", "zstd", "snappy", "gzip", "none"], help="default: zlib for A, zstd for B")
    p.add_argument("--tope-bytes", type=int, default=DEFAULT_CAP, help="hard limit on corpus + archive files (default 2 GiB)")
    p.add_argument("--work", default="")
    return p


def main(argv=None) -> None:
    args = parser().parse_args(argv)
    default_codec(args)
    if args.modo == "orquestar":
        print(json.dumps(orchestrate(args), indent=2, sort_keys=True))
    elif args.modo == "envoltura":
        run_wrapper(args)
    else:
        print(json.dumps(WORKLOADS[args.fase](args), sort_keys=True))


if __name__ == "__main__":
    main()
