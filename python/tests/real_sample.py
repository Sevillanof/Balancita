"""Real Kraken capture rows (17-oct-2026), read-only, for the rule tests that must not run on invented data.

Each table is one .jsonl file with the original column names; see fixtures/muestra-real/README.md for the sections taken.
"""
import json
import os

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "muestra-real")


def rows(table):
    with open(os.path.join(DIR, "paper_futures_{}.jsonl".format(table)), encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]
