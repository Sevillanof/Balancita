"""Child process for the real-termination tests: writes a corpus into an archive and ends with SIGKILL at one chosen point.

``python -m experimentos.cruda_parquet.escritor_trabajo <dir> <seed> <records> <point> <occurrence> [block_records] [formato A|B] [codec]``

The process dies at the ``occurrence``-th crossing of ``point`` (``append``, ``seal_half_written``, ``seal_tmp_written``, ``seal_renamed``,
``manifest_half_written``, ``manifest_confirmed``): no ``finally``, no ``atexit``. Exit status 0 means the point was never crossed that
many times. SYNTHETIC data only.
"""
import os
import signal
import sys

from experimentos.cruda_parquet import archivo_a, archivo_b
from experimentos.cruda_parquet.archivo_a import ArchiveWriter
from experimentos.cruda_parquet.corpus import CorpusConfig, generate


def main(argv):
    directory, seed, records, point, occurrence = argv[:5]
    block_records = int(argv[5]) if len(argv) > 5 else 50
    formato = argv[6] if len(argv) > 6 else "A"
    codec = argv[7] if len(argv) > 7 else ("zstd" if formato == "B" else "zlib")
    fmt = archivo_b.FORMAT_B if formato == "B" else archivo_a.FORMAT_A
    crossed = {"n": 0}

    def hook(name, number):
        if name == point:
            crossed["n"] += 1
            if crossed["n"] >= int(occurrence):
                os.kill(os.getpid(), signal.SIGKILL)

    writer = ArchiveWriter(directory, block_records=block_records, hook=hook, codec=codec, fmt=fmt)
    for m in generate(CorpusConfig(seed=int(seed), max_records=int(records), max_size=8192)):
        writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
    writer.close()
    print("done", writer.epoch, writer.stats.appended)


if __name__ == "__main__":
    main(sys.argv[1:])
