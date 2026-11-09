"""The funding cache file (``funding-{product}.json``) and the cache directory that parallel test groups share.

Why: ``History.funding`` writes the file with ``open(path, "w")`` + ``json.dump``. The ``open`` truncates it first, so a second
process that reads the same directory in that instant sees an empty/partial file (``JSONDecodeError``). The CI groups run several
unittest processes side by side from the same checkout, so the shared default directory (``data/qwen-trader/cache``) is the
collision point. ``futures_funding_cache`` gives (a) an injectable directory (``BALANCITA_QWEN_CACHE_DIR``, one temp dir per
worker in ``scripts/ci_python_run.py``) and (b) an atomic write (temp file + ``os.replace``).
"""
import json
import os
import shutil
import tempfile
import threading
import unittest
from unittest import mock

from balancita_engine import futures_funding_cache as fc

ROWS = [[1000, 0.0001], [2000, -0.0002]]


class CacheDirTests(unittest.TestCase):
    def test_the_environment_variable_replaces_the_default_directory(self):
        self.assertEqual(fc.default_cache_dir("/repo/data/cache", {fc.CACHE_DIR_ENV: "/tmp/mine"}), "/tmp/mine")

    def test_without_the_variable_or_with_an_empty_one_the_default_is_kept(self):
        self.assertEqual(fc.default_cache_dir("/repo/data/cache", {}), "/repo/data/cache")
        self.assertEqual(fc.default_cache_dir("/repo/data/cache", {fc.CACHE_DIR_ENV: ""}), "/repo/data/cache")

    def test_it_reads_the_real_environment_when_none_is_given(self):
        with mock.patch.dict(os.environ, {fc.CACHE_DIR_ENV: "/tmp/from-env"}):
            self.assertEqual(fc.default_cache_dir("/repo/data/cache"), "/tmp/from-env")


class FileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, "sub", "funding-PF_XBTUSD.json")

    def test_a_missing_file_reads_as_none(self):
        self.assertIsNone(fc.read_rows(self.path))

    def test_write_then_read_round_trips_and_creates_the_directory(self):
        fc.write_rows_atomic(self.path, ROWS)
        self.assertEqual(fc.read_rows(self.path), ROWS)
        with open(self.path, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), ROWS)           # the same plain JSON list the trader has always written

    def test_overwriting_replaces_the_rows_and_leaves_no_temporary_file(self):
        fc.write_rows_atomic(self.path, ROWS)
        fc.write_rows_atomic(self.path, ROWS[:1])
        self.assertEqual(fc.read_rows(self.path), ROWS[:1])
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ["funding-PF_XBTUSD.json"])

    def test_a_failed_write_keeps_the_old_file_and_leaves_no_temporary_file(self):
        fc.write_rows_atomic(self.path, ROWS)
        with mock.patch.object(fc.json, "dump", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                fc.write_rows_atomic(self.path, ROWS[:1])
        self.assertEqual(fc.read_rows(self.path), ROWS)
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ["funding-PF_XBTUSD.json"])


class RaceReproductionTests(unittest.TestCase):
    """Deterministic two-party interleaving (no timing): the reader runs exactly while the writer is half way."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, "funding-PF_XBTUSD.json")
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(ROWS, handle)

    def read_while_the_writer_is_half_way(self, write):
        """Runs ``write`` in a thread, stops it inside ``json.dump`` and reads the file from this thread at that moment."""
        halfway, resume, seen = threading.Event(), threading.Event(), {}
        real_dump = json.dump

        def paused_dump(obj, handle, *a, **k):
            halfway.set()
            resume.wait(5)
            return real_dump(obj, handle, *a, **k)

        def writer():
            with mock.patch.object(json, "dump", paused_dump):
                write()

        thread = threading.Thread(target=writer)
        thread.start()
        self.assertTrue(halfway.wait(5))
        try:
            seen["rows"] = fc.read_rows(self.path)
        except ValueError as error:                     # json.JSONDecodeError
            seen["error"] = error
        finally:
            resume.set()
            thread.join(5)
        return seen

    def test_reproduction_the_plain_open_w_write_is_seen_empty_by_a_concurrent_reader(self):
        def naive_write():
            with open(self.path, "w", encoding="utf-8") as handle:        # what History.funding does today
                json.dump([[1, 0.5]], handle)

        seen = self.read_while_the_writer_is_half_way(naive_write)
        self.assertIn("error", seen)                                      # the torn read that fails a test in CI

    def test_the_atomic_write_is_never_seen_half_done(self):
        seen = self.read_while_the_writer_is_half_way(lambda: fc.write_rows_atomic(self.path, [[1, 0.5]]))
        self.assertEqual(seen, {"rows": ROWS})                            # the old complete file, then the new one
        self.assertEqual(fc.read_rows(self.path), [[1, 0.5]])


class SeparateDirectoriesTests(unittest.TestCase):
    def test_two_workers_with_their_own_directory_do_not_see_each_other(self):
        a, b = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, a, True)
        self.addCleanup(shutil.rmtree, b, True)
        fc.write_rows_atomic(os.path.join(a, "funding-PF_XBTUSD.json"), ROWS)
        self.assertIsNone(fc.read_rows(os.path.join(b, "funding-PF_XBTUSD.json")))


if __name__ == "__main__":
    unittest.main()
