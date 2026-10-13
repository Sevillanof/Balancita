"""Restart across two real Python processes: the first writes a checkpoint and a journal to disk and ends; the second
rebuilds everything from those two files and finishes the scenario. Offline proof of recovery, not a persistence system
for production.

    python -m balancita_engine.portfolio_two_process first  --scenario NAME --dir D
    python -m balancita_engine.portfolio_two_process second --scenario NAME --dir D

The two processes share nothing but the files in ``D``. The scenario *inputs* (candles, signals) are rebuilt from the
scenario definition in each process: that stands in for a durable event source, which the forward does not have yet
for signals (see the report).
"""

import argparse
import json
import os
import subprocess
import sys

from .portfolio_offline import (
    Journal, RecoveryError, _finish, _groups, begin, compare_with_uninterrupted, first_process, read_checkpoint,
    second_process, write_checkpoint,
)
from .portfolio_scenarios import all_scenarios

JOURNAL = "journal.jsonl"
CHECKPOINT = "checkpoint.ckpt"
RESULT = "result.json"
PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def scenario_named(name):
    for scenario in all_scenarios():
        if scenario["name"] == name:
            return scenario
    raise SystemExit("unknown scenario {!r}".format(name))


def positions(executor):
    """Open positions as plain data, for comparing runs."""
    return {product: {"intent_id": b.intent["intent_id"], "side": b.position["side"], "notional": str(b.notional),
                      "entry": str(b.position["entry"]), "stop": str(b.position["stop"]), "target": b.position["target_text"],
                      "planned_loss": str(b.planned_loss_usd)} for product, b in sorted(executor.portfolio.positions.items())}


def summary(run):
    executor = run["executor"]
    return {"ledger_hash": run["ledger_hash"], "state_digest": run["state_digest"], "feed_hash": run["feed_hash"],
            "journal_hash": run["journal_hash"], "journal_entries": run["journal_entries"], "snapshot": run["snapshot"],
            "capital_definitive_usd": run["snapshot"]["capital_definitive_usd"], "positions": positions(executor),
            "closed_trades": run["snapshot"]["closed_trades"], "violations": run["violations"],
            "stats": run["stats"], "restart": run["restart"]}


def first(scenario, directory):
    """Process 1: run until the crash minute, persist, and end without any further cleanup."""
    journal = Journal(os.path.join(directory, JOURNAL))
    executor = begin(scenario, journal)
    first_process(scenario, executor, _groups(scenario["events"]),
                  lambda ckpt: write_checkpoint(os.path.join(directory, CHECKPOINT), ckpt))
    return 0


def second(scenario, directory):
    """Process 2: nothing in memory from process 1. Raises ``RecoveryError`` when the files cannot be trusted."""
    journal = Journal.load(os.path.join(directory, JOURNAL), scenario)
    stored = read_checkpoint(os.path.join(directory, CHECKPOINT))
    groups = _groups(scenario["events"])
    executor, info = second_process(scenario, journal, stored, groups)
    result = {"name": scenario["name"], "scenario_hash": scenario["scenario_hash"], "restart": dict(info, restored_from="files in a new process")}
    done = compare_with_uninterrupted(scenario, _finish(executor, result, groups))
    out = summary(done)
    out["reference"] = {k: summary(done["reference"])[k] for k in ("ledger_hash", "state_digest", "feed_hash", "capital_definitive_usd", "positions", "closed_trades")}
    out["journal_on_disk_hash"] = Journal.load(os.path.join(directory, JOURNAL), scenario).head
    with open(os.path.join(directory, RESULT), "w", encoding="utf-8") as handle:
        json.dump(out, handle, sort_keys=True, indent=1)
    return 0


def run_python(role, name, directory):
    """Starts a brand-new interpreter for one role. Returns the completed process."""
    env = dict(os.environ, PYTHONPATH=PARENT + os.pathsep + os.environ.get("PYTHONPATH", ""))
    return subprocess.run([sys.executable, "-m", "balancita_engine.portfolio_two_process", role, "--scenario", name, "--dir", directory],
                          env=env, capture_output=True, text=True)


def run_two_process(name, directory):
    """Process 1 to completion, then process 2. Returns ``(second_process_completed, result_or_None)``."""
    one = run_python("first", name, directory)
    if one.returncode != 0:
        raise RuntimeError("first process failed: " + one.stderr)
    two = run_python("second", name, directory)
    if two.returncode != 0:
        return two, None
    with open(os.path.join(directory, RESULT), encoding="utf-8") as handle:
        return two, json.load(handle)


def _rewrite(path, transform):
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines(keepends=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("".join(transform(lines)))


def refusal_matrix(name, other_name, base_dir):
    """Sabotages the persisted files in several ways and runs a fresh second process on each. Returns
    ``{case: (exit code, reason or None, result_written)}``; every case must be refused, never recovered silently."""
    import shutil

    def case(label, sabotage, other_dir=None):
        directory = os.path.join(base_dir, label)
        os.makedirs(directory)
        one = run_python("first", name, directory)
        if one.returncode != 0:
            raise RuntimeError(one.stderr)
        sabotage(directory)
        two = run_python("second", name, directory)
        reason = None
        for line in two.stderr.splitlines():
            if line.startswith("RECOVERY_REFUSED "):
                reason = line.split(" ", 1)[1]
        return label, (two.returncode, reason, os.path.exists(os.path.join(directory, RESULT)))

    def delete(file):
        return lambda d: os.remove(os.path.join(d, file))

    def flip_char(d):  # a changed digit inside an entry: valid JSON, broken hash chain
        _rewrite(os.path.join(d, JOURNAL), lambda lines: lines[:10] + [lines[10].replace('"kind"', '"kinD"', 1)] + lines[11:])

    def torn_tail(d):  # the last line cut in half, as a crash in the middle of an append would leave it
        _rewrite(os.path.join(d, JOURNAL), lambda lines: lines[:-1] + [lines[-1][: len(lines[-1]) // 2]])

    def garbage(d):
        _rewrite(os.path.join(d, JOURNAL), lambda lines: lines[:5] + ["not json at all\n"] + lines[5:])

    def reorder(d):  # entries swapped: each line is valid, the sequence is not
        _rewrite(os.path.join(d, JOURNAL), lambda lines: lines[:3] + [lines[4], lines[3]] + lines[5:])

    def empty(d):
        open(os.path.join(d, JOURNAL), "w").close()

    def truncated_but_valid(d):  # a clean prefix of the chain, shorter than the checkpoint's position
        _rewrite(os.path.join(d, JOURNAL), lambda lines: lines[:12])

    def foreign(d):  # a journal that is valid, but belongs to another scenario
        other = os.path.join(base_dir, "_other")
        if not os.path.exists(other):
            os.makedirs(other)
            run_python("first", other_name, other)
        shutil.copy(os.path.join(other, JOURNAL), os.path.join(d, JOURNAL))

    def bad_checkpoint(d):
        path = os.path.join(d, CHECKPOINT)
        with open(path, "rb") as handle:
            data = bytearray(handle.read())
        data[len(data) // 2] ^= 0xFF
        with open(path, "wb") as handle:
            handle.write(bytes(data))

    cases = [("diario_ausente", delete(JOURNAL)), ("diario_vacio", empty), ("diario_con_entrada_alterada", flip_char),
             ("diario_con_linea_basura", garbage), ("diario_con_cola_cortada", torn_tail), ("diario_reordenado", reorder),
             ("diario_truncado_valido", truncated_but_valid), ("diario_de_otro_escenario", foreign),
             ("checkpoint_ausente", delete(CHECKPOINT)), ("checkpoint_alterado", bad_checkpoint)]
    return dict(case(label, fn) for label, fn in cases)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("first", "second"))
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args(argv)
    scenario = scenario_named(args.scenario)
    try:
        code = (first if args.role == "first" else second)(scenario, args.dir)
    except RecoveryError as error:
        sys.stderr.write("RECOVERY_REFUSED {}\n".format(error.reason))
        return 3
    return code


if __name__ == "__main__":
    sys.exit(main())
