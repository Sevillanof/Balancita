"""#184 PR 5a: the real-session gate says who may open the capture of Kraken, apart from real orders (test_no_real_orders_184).

The capture has no mark in its tables, so it is recognised by where it comes from: an entry of ``AUTHORIZED_SESSIONS`` (code, reviewed
commit) must match the configuration's ``authorization_ref``, the source file and the first decision. The list is empty today."""

import io
import json
import os
import shutil
import sqlite3
import sys
import unittest
from unittest import mock

from balancita_engine import paper_live_process as LP
from real_session import DECIDE_FROM as FIRST_DECISION, DECIDE_UNTIL as LAST_DECISION, INGEST_KW, MAX_QUOTE_GAP_MS
from real_session import Base, Clock, config_dict

REF = "BAL-DECISION-999-01"


class TestRealSessionGate(Base):
    def real_copy(self, name="real-copy.sqlite", keep_marker=False):
        path = os.path.join(self.root, name)
        shutil.copyfile(self.world.path, path)
        if not keep_marker:
            db = sqlite3.connect(path)
            db.execute("DROP TABLE {}".format(LP.MARKER_TABLE))              # what the real capture does not have
            db.commit()
            db.close()
        return path

    def config(self, **over):
        body = dict(source_id=LP.REAL_SOURCE, authorization_ref=REF, ingest_kw=dict(INGEST_KW, causal_until_clock=True),
                    stale_stop={"stop_quote_gap_ms": MAX_QUOTE_GAP_MS + 1})
        body.update(over)
        return LP.validate_config(config_dict(**body))

    def failed(self, config, path):
        report = LP.preflight(config, self.directory, path, strategies=self.cache["strategies"])
        return report, sorted(c["name"] for c in report["checks"] if not c["ok"])

    def grant(self, path, **over):
        return {REF: dict({"source_path": path, "directory": self.directory, "decide_from_ms": FIRST_DECISION, "decide_until_ms": LAST_DECISION}, **over)}

    def test_no_session_is_authorized_in_the_code(self):
        self.assertEqual(LP.AUTHORIZED_SESSIONS, {})        # adding one is a reviewed commit that names its BAL-DECISION and changes this line

    def test_the_capture_passes_only_with_an_entry_that_matches_the_reference_the_file_and_the_first_decision(self):
        path = self.real_copy()
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            report, failed = self.failed(self.config(), path)
            self.assertEqual(failed, [], report)

    def test_a_real_session_without_the_stale_stop_is_refused_even_when_it_is_authorized(self):
        path = self.real_copy()
        bare = LP.validate_config(config_dict(source_id=LP.REAL_SOURCE, authorization_ref=REF, ingest_kw=dict(INGEST_KW, causal_until_clock=True)))
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            report, failed = self.failed(bare, path)
        self.assertEqual(failed, ["stale_stop_named"], report)
        self.assertFalse(report["ok"])

    def test_every_mismatch_is_refused_and_nothing_is_written(self):
        path = self.real_copy()
        other = self.real_copy("other.sqlite")
        cases = {
            "another file": (self.grant(other), self.config()),
            "another first decision": (self.grant(path, decide_from_ms=FIRST_DECISION + 60_000), self.config()),
            "another end of the window": (self.grant(path, decide_until_ms=LAST_DECISION + 60_000), self.config()),
            "another session directory": (self.grant(path, directory=os.path.join(self.root, "elsewhere")), self.config()),
            "no reference in the configuration": (self.grant(path), self.config(authorization_ref=None)),
            "a reference the code does not list": ({"BAL-DECISION-999-02": self.grant(path)[REF]}, self.config()),
            "an empty list": ({}, self.config()),
        }
        for label, (grants, config) in cases.items():
            config = {k: v for k, v in config.items() if v is not None}
            with mock.patch.dict(LP.AUTHORIZED_SESSIONS, grants, clear=True):
                self.assertEqual(self.failed(config, path)[1], ["real_session_authorized"], label)
                with self.assertRaises(LP.ProcessError) as caught:
                    LP.Supervisor(config, self.directory, path, clock=Clock().now, strategies=self.cache["strategies"]).start()
                self.assertEqual(caught.exception.reason, "real_session_not_authorized", label)
                self.assertFalse(os.path.exists(self.directory), label)

    def test_a_source_nobody_authorized_is_not_even_opened(self):
        path = self.real_copy()
        with mock.patch.object(LP, "SourceReader", side_effect=AssertionError("the source was opened")):
            report, failed = self.failed(self.config(), path)
        self.assertEqual(failed, ["real_session_authorized"])
        self.assertFalse(report["ok"])

    def test_the_command_line_does_not_take_the_synthetic_fixture(self):
        config = os.path.join(self.root, "config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(config_dict(), handle)                       # source_id synthetic, the fixture's marker present
        for command in (["preflight"], ["run", "--clock-from-ms", "0"]):
            stderr = io.StringIO()
            with mock.patch.object(sys, "stderr", stderr):
                code = LP.main(command + ["--config", config, "--directory", self.directory, "--source", self.world.path])
            self.assertEqual(code, LP.EXIT_REFUSED, command)
            self.assertIn("real_session_not_authorized", stderr.getvalue())
            self.assertFalse(os.path.exists(self.directory))

    def test_the_configuration_alone_never_opens_the_capture(self):
        path = self.real_copy()
        self.assertEqual(self.failed(self.config(), path)[1], ["real_session_authorized"])            # a well-formed reference, no entry in the code

    def test_a_source_that_says_it_is_the_capture_but_carries_the_fixture_marker_is_refused(self):
        path = self.real_copy("marked.sqlite", keep_marker=True)
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            self.assertEqual(self.failed(self.config(), path)[1], ["source_kind"])

    def test_an_unknown_source_id_is_refused(self):
        path = self.real_copy()
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            self.assertEqual(self.failed(self.config(source_id="kraken-live"), path)[1], ["real_session_authorized"])

    def test_the_capture_still_needs_the_causal_option(self):
        path = self.real_copy()
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            self.assertEqual(self.failed(self.config(ingest_kw=dict(INGEST_KW)), path)[1], ["causal_ingest"])


if __name__ == "__main__":
    unittest.main()
