"""The final gate of the Python CI groups (scripts/ci_python_compare.py) must name the tests when it fails, not crash
(D-238-01)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
from ci_python_compare import compare  # noqa: E402

FULL = ["m.A.test_1", "m.A.test_2", "m.B.test_3"]


class TestCompare(unittest.TestCase):
    def test_exact_union_has_no_problems(self):
        self.assertEqual(compare(FULL, ["m.A.test_1", "m.B.test_3", "m.A.test_2"], [0, 1], 2), [])

    def test_missing_test_is_listed_by_name(self):
        problems = compare(FULL, ["m.A.test_1", "m.B.test_3"], [0, 1], 2)
        self.assertEqual(len(problems), 1)
        self.assertIn("1 tests in no group", problems[0])
        self.assertIn("m.A.test_2", problems[0])

    def test_duplicated_test_is_listed_by_name(self):
        problems = compare(FULL, FULL + ["m.B.test_3"], [0, 1], 2)
        self.assertEqual(len(problems), 1)
        self.assertIn("1 tests duplicated or unknown", problems[0])
        self.assertIn("m.B.test_3", problems[0])

    def test_missing_and_duplicated_are_both_reported(self):
        problems = compare(FULL, ["m.A.test_1", "m.A.test_1", "m.B.test_3"], [0, 1], 2)
        self.assertEqual(len(problems), 2)

    def test_missing_group_file_is_reported(self):
        problems = compare(FULL, FULL, [0], 2)
        self.assertEqual(len(problems), 1)
        self.assertIn("expected group files 0..1", problems[0])

    def test_import_failure_is_reported(self):
        problems = compare(FULL + ["unittest.loader._FailedTest.x"], FULL + ["unittest.loader._FailedTest.x"], [0], 1)
        self.assertEqual(problems, ["a module fails to import"])


if __name__ == "__main__":
    unittest.main()
