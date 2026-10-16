"""Child process for the real-termination tests: writes a corpus into an archive and ends with SIGKILL at one chosen point.

``python -m experimentos.cruda_parquet.escritor_trabajo <dir> <seed> <records> <point> <occurrence> [block_records]``

The process dies at the ``occurrence``-th crossing of ``point`` (``append``, ``seal_half_written``, ``seal_tmp_written``, ``seal_renamed``,
``manifest_half_written``, ``manifest_confirmed``): no ``finally``, no ``atexit``. Exit status 0 means the point was never crossed that
many times. SYNTHETIC data only.
"""
import os
import signal
import sys

from experimentos.cruda_parquet.archivo_a import ArchiveWriter
from experimentos.cruda_parquet.corpus import CorpusConfig, generate


def main(argv):
    directory, seed, records, point, occurrence = argv[:5]
    block_records = int(argv[5]) if len(argv) > 5 else 50
    crossed = {"n": 0}

    def hook(name, number):
        if name == point:
            crossed["n"] += 1
            if crossed["n"] >= int(occurrence):
                os.kill(os.getpid(), signal.SIGKILL)

    writer = ArchiveWriter(directory, block_records=block_records, hook=hook)
    for m in generate(CorpusConfig(seed=int(seed), max_records=int(records), max_size=8192)):
        writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
    writer.close()
    print("done", writer.epoch, writer.stats.appended)


if __name__ == "__main__":
    main(sys.argv[1:])
