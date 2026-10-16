"""Final gate of the Python CI groups: the union of the ids each group loaded must be exactly the ids of one full
`discover -s python/tests`: none missing, none repeated, none unknown, every expected group file present.

Usage: python scripts/ci_python_compare.py <groups> <ids-dir>   (run from the repository root)
"""
import collections
import glob
import os
import re
import sys
import unittest


def walk(suite, out):
    for t in suite:
        walk(t, out) if isinstance(t, unittest.TestSuite) else out.append(t.id())


def compare(full, grouped, indexes, groups):
    """Returns the list of problems (empty when the groups run exactly the full discovery)."""
    problems = []
    if sorted(indexes) != list(range(groups)):
        problems.append("expected group files 0..%d, found %s" % (groups - 1, sorted(indexes)))
    c_full, c_group = collections.Counter(full), collections.Counter(grouped)
    missing = sorted((c_full - c_group).elements())
    extra = sorted((c_group - c_full).elements())
    if missing:
        problems.append("%d tests in no group: %s" % (len(missing), missing[:20]))
    if extra:
        problems.append("%d tests duplicated or unknown: %s" % (len(extra), extra[:20]))
    if any("unittest.loader." in i for i in full):
        problems.append("a module fails to import")
    return problems


def main():
    groups, ids_dir = int(sys.argv[1]), sys.argv[2]
    full = []
    walk(unittest.defaultTestLoader.discover("python/tests"), full)
    grouped, indexes = [], []
    for f in sorted(glob.glob(os.path.join(ids_dir, "ids-*.txt"))):
        ids = [l for l in open(f).read().splitlines() if l]
        print("%s: %d tests" % (f, len(ids)))
        grouped += ids
        indexes.append(int(re.search(r"ids-(\d+)\.txt$", f).group(1)))
    print("groups total: %d; full discovery: %d" % (len(grouped), len(full)))
    problems = compare(full, grouped, indexes, groups)
    if problems:
        raise SystemExit("\n".join(problems))
    print("OK: the %d groups run exactly the %d tests of the full discovery" % (groups, len(full)))


if __name__ == "__main__":
    main()
