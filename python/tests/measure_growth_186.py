"""Issue #186 (matrix B8, E7; scenario S-M1): how the durable files and the time to read the journal grow with the length of a session.
INVENTED DATA ONLY: the day of traffic is the one the synthetic world of the integration tests produces (two products, quotes and
candles), never the Mac's capture. There is no approved threshold: this reports numbers, it does not judge them.

Two measurements, kept apart on purpose:
* REAL, at the scale the synthetic world reaches: a session is run (``new_session``/``step``), the size of each durable file and the time
  ``recover_session`` takes (the full replay of the journal through the runner) are measured.
* SYNTHETIC, at 1, 7 and 30 days: the journal of that real run is replayed as many times as needed into a new file (new sequence,
  time shifted a whole number of days, hash chain rebuilt, written without fsync) and ``FileRunnerJournal.load`` (read + verify the
  chain + decode) is timed, with the peak resident memory of the process. This is the I/O and hashing part of a recovery; the replay of
  the events through the runner is NOT extrapolated (the shifted events would not be a valid history for it).

Run: ``PYTHONPATH=python python3 python/tests/measure_growth_186.py [days ...]`` from the repository root (default 1 7 30)."""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from balancita_engine import replay_specs as RS
from balancita_engine.multi_signals import stable_hash
from balancita_engine.paper_runner_store import GENESIS, JOURNAL_FILE, FileRunnerJournal
from live_world import LOAD_START, World
from test_paper_live_integration import BTC, ETH, HOLE, TIMES, journal_clock, new_session, recover_session

DAY_MS = 86_400_000


def file_sizes(directory):
    sizes = {}
    for root, _, files in os.walk(directory):
        for name in files:
            sizes[os.path.relpath(os.path.join(root, name), directory)] = os.path.getsize(os.path.join(root, name))
    return sizes


def real_run(root, steps=None):
    """A session over the synthetic world; returns its directory, the days of market it spans and the seconds its recovery takes."""
    strategies, _ = RS.load_frozen()
    world = World(root, quote_holes=[HOLE], second_product_shift=-3)
    world.release_until(LOAD_START)
    directory = os.path.join(root, "s")
    session = new_session(world, directory, strategies, products=(BTC, ETH))
    for now in TIMES[:steps]:
        world.release_until(now)
        session.step(now)
    session.runner.close()
    session.reader.close()
    session.funding.close()
    started = time.time()
    again = recover_session(world, directory, strategies, journal_clock(directory), products=(BTC, ETH))
    seconds = time.time() - started
    again.runner.close()
    again.reader.close()
    again.funding.close()
    journal = FileRunnerJournal.load(os.path.join(directory, "runner", JOURNAL_FILE))
    span = (max(e["t_ms"] for e in journal.entries[1:]) - min(e["t_ms"] for e in journal.entries[1:])) / DAY_MS
    world.close()
    return directory, journal, span, seconds


def synthetic_journal(path, base, days_of_base, days):
    """``days`` days of journal built by repeating ``base`` (whose body spans ``days_of_base`` days) with the clock shifted a whole
    number of base spans; the last repetition is cut where the target number of entries (the base's rate per day) is reached."""
    target = int(round(len(base.entries) / days_of_base * days))
    head, seq, span = GENESIS, 0, int(round(days_of_base * DAY_MS))
    with open(path, "wb") as handle:
        copy = 0
        while seq < target:
            for entry in base.entries:
                if seq >= target:
                    break
                seq += 1
                body = {"seq": seq, "t_ms": entry["t_ms"] + copy * span, "kind": entry["kind"], "data": entry["data"], "prev": head}
                body["hash"] = head = stable_hash(body)
                handle.write((json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
            copy += 1
    return seq


LOADER = """
import re, resource, sys, time
from balancita_engine.paper_runner_store import FileRunnerJournal
started = time.time()
FileRunnerJournal.load(sys.argv[1])
seconds = time.time() - started
try:
    peak = int(re.search(r"VmHWM:\\s+(\\d+) kB", open("/proc/self/status").read()).group(1)) * 1024     # Linux: this process only
except (OSError, AttributeError):
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
print(seconds, peak)
"""


def load_in_a_fresh_process(path):
    """Seconds to read + verify the journal and the peak resident memory (MB) of a process that does nothing else."""
    import subprocess
    env = dict(os.environ, PYTHONPATH=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out = subprocess.run([sys.executable, "-W", "ignore", "-c", LOADER, path], env=env, capture_output=True, text=True, check=True).stdout.split()
    return float(out[0]), float(out[1]) / 1e6


def measure(days_list, steps=None, out=print):
    root = tempfile.mkdtemp()
    try:
        directory, journal, span, recover_seconds = real_run(root, steps)
        sizes = file_sizes(directory)
        total = sum(sizes.values())
        out("REAL RUN (invented data): spans {:.2f} days of market, {} journal entries".format(span, len(journal.entries)))
        out("  durable bytes by file: {}".format(json.dumps(sizes, sort_keys=True)))
        out("  total {:.1f} MB = {:.1f} MB/day; full recovery of the runner took {:.1f} s".format(total / 1e6, total / 1e6 / span, recover_seconds))
        report = {"span_days": span, "entries": len(journal.entries), "bytes": total, "recover_seconds": recover_seconds, "synthetic": {}}
        for days in days_list:
            path = os.path.join(root, "synthetic-{}.jsonl".format(days))
            built = synthetic_journal(path, journal, max(span, 1e-9), days)
            seconds, peak = load_in_a_fresh_process(path)
            row = {"entries": built, "journal_mb": os.path.getsize(path) / 1e6, "load_seconds": seconds, "peak_rss_mb": peak}
            report["synthetic"][days] = row
            out("  {:>3} days: {:>9} entries, journal {:>8.1f} MB, read+verify {:>6.1f} s, fresh-process peak RSS {:>7.0f} MB".format(
                days, built, row["journal_mb"], seconds, peak))
            os.remove(path)
        return report
    finally:
        shutil.rmtree(root, True)


if __name__ == "__main__":
    measure([int(a) for a in sys.argv[1:]] or [1, 7, 30])
