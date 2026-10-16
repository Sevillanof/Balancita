"""Issue #248: measurement script for candidate A (candidate B comes in the next PR). NOT a test: large runs never go through CI.

``PYTHONPATH=python python3 -m experimentos.cruda_parquet.medir [--registros N ...] [--max-bytes B] [--seed S] [--bloque N] [--codec zlib|lzma]``

Each phase (generate, write+seal, query, rebuild) runs in a FRESH child process; the child's peak memory and CPU come from
``resource.getrusage(RUSAGE_CHILDREN)`` read by a wrapper process whose only child is the workload, so phases never share memory (same idea as
``measure_growth_186.py``). Everything is SYNTHETIC: nothing here calibrates the real capture and nothing is extrapolated.
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
from experimentos.cruda_parquet.corpus import CorpusConfig, Message, corpus_hash, generate, size_summary
from experimentos.cruda_parquet.derivacion import derivation_hash, derive_minutes

GIB = 1024 ** 3
DEFAULT_CAP = 2 * GIB  # original + compressed + temporary space must fit here, else the step is skipped and declared
FIELD = struct.Struct(">I")
PYTHON_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def child_env() -> dict:
    return dict(os.environ, PYTHONPATH=PYTHON_DIR)


def fits(corpus_bytes: int, block_bytes: int, cap: int = DEFAULT_CAP) -> bool:
    """Worst case the compressed archive is as big as the original: corpus file + archive + one block of temporary space."""
    return 2 * corpus_bytes + block_bytes <= cap


def write_corpus(path: str, messages) -> dict:
    count = total = 0
    with open(path, "wb") as handle:
        for m in messages:
            for part in (m.source.encode(), m.endpoint.encode(), m.product.encode(), m.provider_time.encode(), m.provider_seq.encode(),
                         str(m.received_at).encode(), m.raw):
                handle.write(FIELD.pack(len(part)))
                handle.write(part)
            count += 1
            total += len(m.raw)
    return {"records": count, "raw_bytes": total}


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


def directory_bytes(path: str) -> int:
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, files in os.walk(path) for f in files)


# ---- workloads (each runs in its own process) --------------------------------------------------

def work_generate(args) -> dict:
    started = time.perf_counter()
    config = CorpusConfig(seed=args.seed, max_records=args.registros, max_corpus_bytes=args.max_bytes)
    info = write_corpus(os.path.join(args.work, "corpus.bin"), generate(config))
    sizes = size_summary(read_corpus(os.path.join(args.work, "corpus.bin")))
    digest, _, _ = corpus_hash(read_corpus(os.path.join(args.work, "corpus.bin")))
    return dict(info, seconds=round(time.perf_counter() - started, 3), corpus_sha256=digest, sizes=sizes)


def work_write(args) -> dict:
    archive = os.path.join(args.work, "archivo_a")
    shutil.rmtree(archive, ignore_errors=True)
    started = time.perf_counter()
    writer = A.ArchiveWriter(archive, block_records=args.bloque, block_bytes=args.bloque_bytes, codec=args.codec)
    for m in read_corpus(os.path.join(args.work, "corpus.bin")):
        writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
    writer.close()
    stats = writer.stats.as_dict()
    wall = time.perf_counter() - started
    return {"wall_seconds": round(wall, 3), "records_per_second": round(stats["appended"] / wall, 1) if wall else None,
            "append_seconds": round(stats["append_seconds"], 3), "seal_seconds": round(stats["seal_seconds"], 3),
            "seal_cpu_seconds": round(stats["seal_cpu_seconds"], 3), "blocks": stats["sealed_blocks"], "raw_bytes": stats["sealed_raw_bytes"],
            "archive_bytes": directory_bytes(archive), "ratio": round(stats["sealed_raw_bytes"] / max(1, stats["sealed_file_bytes"]), 3),
            "peak_buffer_bytes": stats["peak_buffer_bytes"], "peak_temp_block_bytes": stats["peak_temp_bytes"], "codec": args.codec}


def work_query(args) -> dict:
    archive = os.path.join(args.work, "archivo_a")
    out = {}
    started = time.perf_counter()
    reader = A.ArchiveReader(archive)
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
    archive = os.path.join(args.work, "archivo_a")
    started = time.perf_counter()
    reader = A.ArchiveReader(archive)
    from_archive = derivation_hash(derive_minutes(reader.records()))
    seconds = round(time.perf_counter() - started, 3)
    from_corpus = derivation_hash(derive_minutes(read_corpus(os.path.join(args.work, "corpus.bin"))))
    exact = all(a.raw == b.raw for a, b in zip(reader.records(), read_corpus(os.path.join(args.work, "corpus.bin"))))
    return {"seconds_from_archive": seconds, "derivation_sha256": from_archive, "equals_corpus": from_archive == from_corpus,
            "byte_exact_round_trip": exact}


WORKLOADS = {"generar": work_generate, "escribir": work_write, "consultar": work_query, "reconstruir": work_rebuild}


# ---- process plumbing ---------------------------------------------------------------------------

def cli_args(args, phase: str):
    return [phase, "--work", args.work, "--registros", str(args.registros), "--max-bytes", str(args.max_bytes), "--seed", str(args.seed),
            "--bloque", str(args.bloque), "--bloque-bytes", str(args.bloque_bytes), "--codec", args.codec]


def run_wrapper(args) -> None:
    """Spawn the workload as the ONLY child, then report its peak RSS and CPU from RUSAGE_CHILDREN."""
    started = time.perf_counter()
    proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.medir", "trabajo"] + cli_args(args, args.fase),
                          capture_output=True, text=True, env=child_env())
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = {"fase": args.fase, "returncode": proc.returncode, "elapsed_seconds": round(time.perf_counter() - started, 3),
              "peak_rss_mib": round(usage.ru_maxrss / 1024.0, 1), "cpu_user_seconds": round(usage.ru_utime, 3),
              "cpu_system_seconds": round(usage.ru_stime, 3)}
    try:
        result["detalle"] = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        result["error"] = (proc.stderr or proc.stdout)[-400:]
    print(json.dumps(result, sort_keys=True))


def orchestrate(args) -> dict:
    report = {"python": sys.version.split()[0], "platform": sys.platform, "seed": args.seed, "codec": args.codec, "bloque_registros": args.bloque,
              "bloque_bytes": args.bloque_bytes, "tope_bytes": DEFAULT_CAP, "escalones": []}
    for registros in args.registros_lista:
        args.registros = registros
        step = {"registros_pedidos": registros, "max_bytes_corpus": args.max_bytes}
        worst = min(args.max_bytes, registros * 64 * 1024)
        if not fits(worst, args.bloque_bytes):
            step["omitido"] = "el original + comprimido + bloque temporal no entran en %d bytes" % DEFAULT_CAP
            report["escalones"].append(step)
            continue
        args.work = tempfile.mkdtemp(prefix="cruda-medir-")
        try:
            for phase in ("generar", "escribir", "consultar", "reconstruir"):
                out = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.medir", "envoltura"] + cli_args(args, phase),
                                     capture_output=True, text=True, env=child_env())
                step[phase] = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {"error": out.stderr[-400:]}
            step["disco"] = {"corpus_bytes": os.path.getsize(os.path.join(args.work, "corpus.bin")),
                             "archivo_a_bytes": directory_bytes(os.path.join(args.work, "archivo_a"))}
        finally:
            shutil.rmtree(args.work, ignore_errors=True)
        report["escalones"].append(step)
    return report


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
    p.add_argument("--codec", default="zlib", choices=["zlib", "lzma"])
    p.add_argument("--work", default="")
    return p


def main(argv=None) -> None:
    args = parser().parse_args(argv)
    if args.modo == "orquestar":
        print(json.dumps(orchestrate(args), indent=2, sort_keys=True))
    elif args.modo == "envoltura":
        run_wrapper(args)
    else:
        print(json.dumps(WORKLOADS[args.fase](args), sort_keys=True))


if __name__ == "__main__":
    main()
