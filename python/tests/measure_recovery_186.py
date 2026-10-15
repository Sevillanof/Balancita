"""Issue #186, scenarios B8 / E7 (S-M1): how long a full recovery takes and how big the files get with the length of the
run. Synthetic journals only, generated here; it reads nothing real and has no approved threshold, it just reports.
Not a test (the name does not match test_*): run it by hand,

    PYTHONPATH=python python3 python/tests/measure_recovery_186.py 1 7 30

Each simulated day has, per minute and per product (two products), one quote and one 1-minute candle: no positions,
orders or signals, so these are lower bounds for the journal. The journal is always replayed whole."""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_paper_runner_recovery as T  # noqa: E402
from balancita_engine.paper_runner import PaperRunner  # noqa: E402


def events(minutes):
    out, off = [], 0
    for m in range(minutes):
        t = T.CYCLE + m * T.MIN
        for product in (T.BTC, T.ETH):
            mid = "100010" if product == T.BTC else "3500"
            off += 1
            out.append(T.quote(product, t + 5 * T.SEC, mid, off))
            off += 1
            out.append(T.candle(product, t, mid, mid, mid, mid, off))
    return out


def measure(days):
    batch = events(1440 * days)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "run")
        started = time.time()
        runner = PaperRunner.create(path, T.cfg(), T.strategies())
        runner.run(batch)
        wrote = time.time() - started
        runner.close()
        size = {name: os.path.getsize(os.path.join(path, name)) for name in sorted(os.listdir(path))}
        started = time.time()
        PaperRunner.recover(path, T.cfg(), T.strategies(), batch[-1]["t_ms"] + 1).close()
        recovered = time.time() - started
    print("days={} events={} write_s={:.1f} recover_s={:.1f} bytes_total={} {}".format(
        days, len(batch), wrote, recovered, sum(size.values()), size))


if __name__ == "__main__":
    for arg in sys.argv[1:] or ["1"]:
        measure(int(arg))
