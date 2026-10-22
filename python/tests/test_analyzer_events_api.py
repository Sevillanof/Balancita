import json
import os
import tempfile
import unittest

from balancita_engine import analyzer_events_api as api


class AnalyzerEventsApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def _write(self, text):
        path = api.events_path(self.dir)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def test_missing_file_gives_command(self):
        out = api.read_events(self.dir, "/x/.venv-vectorbt/bin/python")
        self.assertFalse(out["available"])
        self.assertIn("/x/.venv-vectorbt/bin/python -m research.vectorbt.event_trades", out["command"])
        self.assertIn(api.events_path(self.dir), out["command"])
        self.assertIn("reason", out)

    def test_valid_file(self):
        doc = {"schema": api.SCHEMA, "cells": [], "events": {}}
        self._write(json.dumps(doc))
        self.assertEqual(api.read_events(self.dir, "py"), {"available": True, "data": doc})

    def test_broken_json(self):
        self._write("{no")
        out = api.read_events(self.dir, "py")
        self.assertFalse(out["available"])
        self.assertIn("roto", out["reason"])

    def test_other_schema_and_incomplete(self):
        self._write(json.dumps({"schema": "otro", "cells": [], "events": {}}))
        self.assertIn("esquema", api.read_events(self.dir, "py")["reason"])
        self._write(json.dumps({"schema": api.SCHEMA}))
        self.assertIn("incompleto", api.read_events(self.dir, "py")["reason"])
        self._write("[]")
        self.assertFalse(api.read_events(self.dir, "py")["available"])

    def test_does_not_write(self):
        api.read_events(self.dir, "py")
        self.assertEqual(os.listdir(self.dir), [])


if __name__ == "__main__":
    unittest.main()
