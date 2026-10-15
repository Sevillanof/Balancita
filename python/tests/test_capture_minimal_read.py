"""Synthetic tests for capture_minimal_read: bounded reads, guards and aggregation. No real data is touched."""
import os
import sqlite3
import tempfile
import time
import unittest

from balancita_engine import capture_minimal_read as m

A0, A1 = m.WINDOW_A
B0, B1 = m.WINDOW_B

SCHEMA = """
CREATE TABLE paper_futures_official_candles (product_id TEXT, interval_ms INTEGER, bucket_start INTEGER, revision_hash TEXT,
  known_at INTEGER, open_price TEXT, high_price TEXT, low_price TEXT, close_price TEXT, volume_btc TEXT, response_sha256 TEXT,
  PRIMARY KEY (product_id, interval_ms, bucket_start, revision_hash));
CREATE TABLE paper_futures_candle_revisions (candle_id TEXT, revision INTEGER, interval_ms INTEGER, bucket_start INTEGER,
  known_at INTEGER, close_at INTEGER, is_closed INTEGER, coverage TEXT, open_price TEXT, high_price TEXT, low_price TEXT,
  close_price TEXT, volume_btc TEXT, trade_count INTEGER, source_hash TEXT, PRIMARY KEY (candle_id, revision));
CREATE TABLE paper_futures_funding_periods (response_sha256 TEXT, start_ms INTEGER, product_id TEXT, end_ms INTEGER,
  funding_rate TEXT, known_at INTEGER, unit TEXT, PRIMARY KEY (response_sha256, start_ms));
CREATE TABLE paper_futures_funding_responses (sha256 TEXT PRIMARY KEY, received_at INTEGER, server_time INTEGER, raw_response TEXT);
"""


def make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


def official(conn, product, bucket, known=None, rev="h", close="100"):
    conn.execute("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (product, m.MINUTE_MS, bucket, rev, known or bucket + 120_000, "100", "101", "99", close, "1", "r"))


def revision(conn, bucket, rev, closed, close="100"):
    conn.execute("INSERT INTO paper_futures_candle_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%d:%d" % (m.BTC, m.MINUTE_MS, bucket), rev, m.MINUTE_MS, bucket, bucket + 61_000, bucket + 60_000,
                  closed, "full", "100", "101", "99", close, "1", 3, "s"))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = make_db(self.path)

    def guard(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        return m._Guard(ro, time.monotonic())


class ReadTests(Fixture):
    def test_2a_reads_only_the_window_and_products_with_pk_plan(self):
        for b in range(A0, A0 + 3 * m.MINUTE_MS, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            official(self.conn, m.ETH, b)
        official(self.conn, m.BTC, A1)                      # outside the window
        official(self.conn, "PF_SOLUSD", A0)                # other product
        rows = m.read_2a(self.guard(), m.Ledger())
        self.assertEqual(len(rows), 6)
        self.assertEqual({r[0] for r in rows}, {m.BTC, m.ETH})

    def test_2a_stops_on_row_budget_without_returning_rows(self):
        self.conn.executemany("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                              [(m.BTC, m.MINUTE_MS, A0 + i * m.MINUTE_MS, "h", 0, "1", "1", "1", "1", "1", "r") for i in range(30)])
        old = m.CAPS["2a"]
        m.CAPS["2a"] = 10
        self.addCleanup(m.CAPS.__setitem__, "2a", old)
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2a(self.guard(), m.Ledger())
        self.assertEqual(ctx.exception.reason, "row_budget")

    def test_2b_hides_values_of_open_revisions(self):
        revision(self.conn, B0, 1, 0, close="777")
        revision(self.conn, B0, 2, 1, close="105")
        revision(self.conn, B1, 1, 1)                        # outside
        rows = m.read_2b(self.guard(), m.Ledger())
        self.assertEqual(len(rows), 2)
        open_row = [r for r in rows if r[3] == 0][0]
        self.assertTrue(all(v is None for v in open_row[4:]))
        self.assertEqual([r for r in rows if r[3] == 1][0][7], "105")

    def test_2c_filters_by_start_and_product(self):
        ins = "INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)"
        self.conn.execute(ins, ("a", A0, m.BTC, A0 + 3_600_000, "0.1", 1, "u"))
        self.conn.execute(ins, ("a", A1, m.BTC, A1 + 3_600_000, "0.1", 1, "u"))
        self.conn.execute(ins, ("b", A0, "PF_SOLUSD", A0 + 3_600_000, "0.1", 1, "u"))
        self.assertEqual(len(m.read_2c(self.guard(), m.Ledger())), 1)

    def test_2d_byte_budget_stops_before_reading_bodies(self):
        self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES ('s',?,?,?,?,?,?)", (A0, m.BTC, A0 + 1, "1", 1, "u"))
        self.conn.execute("INSERT INTO paper_futures_funding_responses VALUES ('s',?,?,?)", (A0 + 5, A0 + 5, "x" * 50))
        old = m.MAX_BODY_BYTES
        m.MAX_BODY_BYTES = 10
        self.addCleanup(setattr, m, "MAX_BODY_BYTES", old)
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2d(self.guard(), m.Ledger())
        self.assertEqual(ctx.exception.reason, "byte_budget")


class GuardTests(Fixture):
    def test_authorizer_denies_writes_and_other_columns(self):
        g = self.guard()
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2a", "SELECT response_sha256 FROM paper_futures_official_candles")
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2a", "SELECT * FROM paper_futures_funding_periods")
        with self.assertRaises(sqlite3.DatabaseError):
            g.conn.execute("DELETE FROM paper_futures_official_candles")

    def test_connection_is_query_only(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        self.assertEqual(ro.execute("PRAGMA query_only").fetchone()[0], 1)

    def test_identity_requires_dir_name_and_size(self):
        with self.assertRaises(m.Stopped):
            m.check_identity(self.path)                       # too small
        other = os.path.join(self.dir, "x.sqlite")
        open(other, "w").close()
        with self.assertRaises(m.Stopped):
            m.check_identity(other)


class SummaryTests(unittest.TestCase):
    def test_official_summary_counts_gaps_and_differing_revisions(self):
        rows = [(m.BTC, A0, 5, "h1", "1", "2", "0", "1", "1"), (m.BTC, A0, 9, "h2", "1", "2", "0", "2", "1"),
                (m.BTC, A0 + 3 * m.MINUTE_MS, 5, "h1", "1", "2", "0", "1", "1")]
        s = m.summarize_official(rows)[m.BTC]
        self.assertEqual(s["minutes_present"], 2)
        self.assertEqual(s["minutes_with_differing_revisions"], 1)
        self.assertEqual(s["minutes_missing"], m.EXPECTED_MINUTES_A - 2)
        self.assertEqual(s["missing_runs"]["longest"][0]["minutes"], m.EXPECTED_MINUTES_A - 4)

    def test_own_minutes_uses_first_and_last_closed_revision(self):
        rows = [(B0, 1, B0 + 1, 0, None, None, None, None, None), (B0, 2, B0 + 2, 1, "1", "2", "0", "1", "1"),
                (B0, 3, B0 + 3, 1, "1", "2", "0", "2", "1")]
        candles, summary = m.own_minutes(rows)
        self.assertEqual(len(candles), 2)
        self.assertEqual(summary["minutes_whose_first_and_last_closed_revision_differ"], 1)

    def test_cli_only_takes_db(self):
        with self.assertRaises(SystemExit):
            m.main(["--db", "x", "--from", "1"])


if __name__ == "__main__":
    unittest.main()
