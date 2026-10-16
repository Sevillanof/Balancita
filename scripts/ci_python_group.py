"""Select the Python test units of one CI group (BAL CI-speed, balanced split).

A unit is a whole test module, or a single TestCase class (`module.Class`) for
the modules that hold slow real-process tests (see python/tests/ci_weights.json).
Units are packed into GROUPS groups with longest-first greedy packing on the
recorded weights (seconds). A unit with no recorded weight gets DEFAULT_WEIGHT,
so a new module or class is always assigned to some group and never left out.

Note: if two split modules shared one TestCase class (by import), their ids would fall under one unit and the
group's "ran == expected" check would fail (safe side). Today no class is shared.

Usage: python scripts/ci_python_group.py <group-index> <groups>
Writes units.txt (units to run) and ids-<index>.txt (test ids loaded).
"""
import glob
import json
import os
import sys
import unittest

DEFAULT_WEIGHT = 30


def walk(suite, out):
    for t in suite:
        walk(t, out) if isinstance(t, unittest.TestSuite) else out.append(t.id())


def main():
    index, groups = int(sys.argv[1]), int(sys.argv[2])
    weights = json.load(open("python/tests/ci_weights.json"))
    split = {k.split(".")[0] for k in weights if "." in k}
    modules = sorted(os.path.basename(p)[:-3] for p in glob.glob("python/tests/test*.py"))
    units = {}  # unit -> list of test ids
    for m in modules:
        ids = []
        walk(unittest.defaultTestLoader.loadTestsFromName(m), ids)
        bad = [i for i in ids if i.startswith("unittest.loader.")]
        if bad:
            raise SystemExit("modules that fail to import: %s" % bad)
        if m in split:
            for i in ids:
                units.setdefault(i.rsplit(".", 1)[0], []).append(i)
        else:
            units[m] = ids
    order = sorted(units, key=lambda u: (-weights.get(u, DEFAULT_WEIGHT), u))
    load = [0] * groups
    bucket = [[] for _ in range(groups)]
    for u in order:
        g = min(range(groups), key=lambda k: (load[k], k))
        bucket[g].append(u)
        load[g] += weights.get(u, DEFAULT_WEIGHT)
    mine = sorted(bucket[index])
    ids = sorted(i for u in mine for i in units[u])
    open("units.txt", "w").write(" ".join(mine))
    open("ids-%d.txt" % index, "w").write("\n".join(ids) + ("\n" if ids else ""))
    print("group %d/%d: %d units, %d tests, ~%ds" % (index, groups, len(mine), len(ids), load[index]))
    print("\n".join(mine))


main()
