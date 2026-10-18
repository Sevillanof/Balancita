"""Real Kraken capture rows (17-oct-2026), read-only, for the rule tests that must not run on invented data.

Each table is one .jsonl file with the original column names; see fixtures/muestra-real/README.md for the sections taken.
"""
import json
import os

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "muestra-real")
PARTIAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "muestra-parcial")   # 1168 minutes of PF_XBTUSD


def rows(table, directory=DIR):
    with open(os.path.join(directory, "paper_futures_{}.jsonl".format(table)), encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]
