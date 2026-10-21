"""Run the units of one CI group in WORKERS parallel unittest processes.

Reads units.txt (written by ci_python_group.py), packs the units into WORKERS
processes with the same weights, runs them side by side, prints every worker's
log and then ONE summary line `Ran N tests in Xs` that the CI step "Check that
unittest ran exactly the tests loaded" reads. Exit code is non-zero if any
worker fails. Every unit still runs exactly once.

Usage: python scripts/ci_python_run.py <workers>
"""
import json
import re
import subprocess
import sys
import time

DEFAULT_WEIGHT = 30


def main():
    workers = int(sys.argv[1])
    units = open("units.txt").read().split()
    if not units:
        print("Ran 0 tests in 0.000s")
        return 0
    weights = json.load(open("python/tests/ci_weights.json"))
    order = sorted(units, key=lambda u: (-weights.get(u, DEFAULT_WEIGHT), u))
    load = [0] * workers
    bucket = [[] for _ in range(workers)]
    for u in order:
        w = min(range(workers), key=lambda k: (load[k], k))
        bucket[w].append(u)
        load[w] += weights.get(u, DEFAULT_WEIGHT)
    start = time.time()
    procs = []
    for i, mine in enumerate(b for b in bucket if b):
        log = open("worker-%d.log" % i, "w")
        p = subprocess.Popen(
            [sys.executable, "-m", "unittest", "--durations=0"] + sorted(mine),
            stdout=log, stderr=subprocess.STDOUT,
        )
        procs.append((i, p, log))
    failed, total = False, 0
    for i, p, log in procs:
        failed |= p.wait() != 0
        log.close()
        text = open("worker-%d.log" % i).read()
        print("=== worker %d ===" % i)
        print(text)
        m = re.findall(r"^Ran (\d+) tests? in ", text, re.M)
        if not m:
            failed = True
        else:
            total += int(m[-1])
    print("Ran %d tests in %.3fs" % (total, time.time() - start))
    return 1 if failed else 0


sys.exit(main())
