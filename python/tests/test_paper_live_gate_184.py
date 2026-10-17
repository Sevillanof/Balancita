"""#184 PR 5a: the real-session gate says who may open the capture of Kraken, apart from real orders (test_no_real_orders_184).

The capture has no mark in its tables, so it is recognised by where it comes from: an entry of ``AUTHORIZED_SESSIONS`` (code, reviewed
commit) must match the configuration's ``authorization_ref``, the source file and the first decision. The list is empty today."""

import os
import shutil
import sqlite3
import unittest
from unittest import mock

from balancita_engine import paper_live_process as LP
from test_paper_live_integration import FIRST_DECISION, INGEST_KW
from test_paper_live_process_185 import Base, Clock, config_dict

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
        body = dict(source_id=LP.REAL_SOURCE, authorization_ref=REF, ingest_kw=dict(INGEST_KW, causal_until_clock=True))
        body.update(over)
        return LP.validate_config(config_dict(**body))

    def failed(self, config, path):
        report = LP.preflight(config, self.directory, path, strategies=self.cache["strategies"])
        return report, sorted(c["name"] for c in report["checks"] if not c["ok"])

    def grant(self, path, **over):
        return {REF: dict({"source_path": path, "decide_from_ms": FIRST_DECISION}, **over)}

    def test_no_session_is_authorized_in_the_code(self):
        self.assertEqual(LP.AUTHORIZED_SESSIONS, {})        # adding one is a reviewed commit that names its BAL-DECISION and changes this line

    def test_the_capture_passes_only_with_an_entry_that_matches_the_reference_the_file_and_the_first_decision(self):
        path = self.real_copy()
        with mock.patch.dict(LP.AUTHORIZED_SESSIONS, self.grant(path)):
            report, failed = self.failed(self.config(), path)
            self.assertEqual(failed, [], report)

    def test_every_mismatch_is_refused_and_nothing_is_written(self):
        path = self.real_copy()
        other = self.real_copy("other.sqlite")
        cases = {
            "another file": (self.grant(other), self.config()),
            "another first decision": (self.grant(path, decide_from_ms=FIRST_DECISION + 60_000), self.config()),
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
