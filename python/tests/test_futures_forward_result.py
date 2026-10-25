import json
import os
import shutil
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine.futures_forward import _SCHEMA, open_is_recovered
from balancita_engine.futures_forward_result import OPEN_LABEL, UNCLASSIFIED, read_forward, read_q_skips, strategy_block
from balancita_engine.futures_spec_strategy import load_specs
from balancita_engine.futures_strategy_reliability import FORWARD_MIN_TRADES, FORWARD_SCHEMA
from balancita_engine.futures_strategy_registry import StrategyRegistry, StrategyService, make_handler

NOW = 1_800_000_000_000
HOUR = 3_600_000
SID = "c30-momentum-12h-perp-v1"


def _side(trades, pnl, incomplete=0):
    return {"trades": trades, "pnl_usd": pnl, "mean_net_bp": 12.5 if trades else None,
            "hit_rate": 0.5 if trades else None, "funding_incomplete_trades": incomplete,
            "net_is_definitive": incomplete == 0}


class ForwardResultTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.forward_db = os.path.join(self.dir, "forward.sqlite")
        self.summary = os.path.join(self.dir, "forward-reliability.json")
        self.market = os.path.join(self.dir, "market.sqlite")
        self.decisions = os.path.join(self.dir, "decisions.sqlite")

    def seed(self, *, last_run=NOW - HOUR // 2, live=7, recovered=2, side="LONG", funding_ok=True, position=True,
             entry_recovered=None, unclassified=0):
        for path in (self.forward_db, self.market):
            if os.path.exists(path):
                os.remove(path)
        db = sqlite3.connect(self.forward_db)
        db.executescript(_SCHEMA)
        db.execute("INSERT INTO forward_status VALUES(?,?,?)",
                   (SID, "PF_XBTUSD", json.dumps({"checked_ms": last_run})))
        db.execute("INSERT INTO forward_open VALUES(?,?,?,?)", (SID, "PF_XBTUSD", "hash1", json.dumps(
            {"side": side, "entry": "100", "stop": "90", "target": "120", "opened_at": str(NOW - 2 * HOUR),
             **({} if entry_recovered is None else {"recovered": entry_recovered})}
            if position else None)))
        db.commit()
        db.close()
        funding = {"usable": funding_ok, "code": "ok" if funding_ok else "stale_history",
                   "reason": "ok" if funding_ok else "el funding observado llega con retraso", "checked_ms": NOW - 10}
        body = {"schema": FORWARD_SCHEMA, "updated_ms": last_run, "min_forward_trades": FORWARD_MIN_TRADES, "strategies": {SID: {
            "spec_hash": "hash1", "start_ms": NOW - 100 * HOUR, "open_positions": 1,
            "summary_without_recovered": _side(live, 31.5, incomplete=1),
            "summary_recovered": _side(recovered, -4.0),
            "summary_unclassified": _side(unclassified, 9.0),
            "funding_state": {"PF_XBTUSD": funding}, "missing_candles_1m": 0, "max_candle_lag_ms": 1000}}}
        with open(self.summary, "w") as handle:
            json.dump(body, handle)
        market = sqlite3.connect(self.market)
        market.execute("CREATE TABLE IF NOT EXISTS paper_futures_official_candles(product_id TEXT, "
                       "interval_ms INTEGER, bucket_start INTEGER, known_at INTEGER, close_price TEXT)")
        market.executemany("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?)", [
            ("PF_XBTUSD", 60_000, NOW - 120_000, NOW - 60_000, "101"),
            ("PF_XBTUSD", 60_000, NOW - 60_000, NOW, "110"),      # newest bucket, first-known revision
            ("PF_XBTUSD", 60_000, NOW - 60_000, NOW + 5, "999"),  # a later revision must not be read
        ])
        market.commit()
        market.close()

    def read(self):
        return read_forward(self.forward_db, self.summary, self.market, self.decisions, now_ms=NOW)

    def block(self, forward=None, state="active", min_trades=100):
        return strategy_block(forward or self.read(), SID, {"state": state, "reason": None, "since_ms": 5},
                              min_trades=min_trades, spec_hash="hash1")

    def test_live_and_recovered_are_apart_and_only_live_counts_toward_the_minimum(self):
        self.seed()
        block = self.block()
        self.assertEqual((block["live"]["closed"], block["live"]["net_usd"]), (7, 31.5))
        self.assertEqual((block["recovered"]["closed"], block["recovered"]["net_usd"]), (2, -4.0))
        self.assertEqual(block["live"]["funding_incomplete"], 1)
        self.assertFalse(block["live"]["net_is_definitive"])
        self.assertEqual(block["progress"], {"live_trades": 7, "min_trades": 100, "remaining": 93, "reached": False,
                                             "counts_toward_min": "solo operaciones en vivo"})

    def test_progress_is_reached_exactly_at_the_minimum(self):
        self.seed(live=100)
        self.assertTrue(self.block()["progress"]["reached"])
        self.assertFalse(self.block(min_trades=101)["progress"]["reached"])
        self.assertEqual(self.block(min_trades=101)["progress"]["remaining"], 1)
        self.assertEqual(self.block(min_trades=99)["progress"]["remaining"], 0)

    def test_open_position_is_valued_at_the_first_known_latest_close_and_labelled(self):
        self.seed()
        (position,) = self.block()["open"]["positions"]
        self.assertEqual(position["label"], OPEN_LABEL)
        self.assertEqual((position["mark_price"], position["mark_bucket_ms"]), ("110", NOW - 60_000))
        # Long from 100 to 110 on 100 USD: +10 gross, less the exit impact (0.6 bp) and 5 bp of fees on both legs.
        self.assertEqual(position["pnl_usd"], 9.8943)
        self.assertEqual(position["net_bp"], 989.434)
        self.assertEqual(self.block()["open"]["pnl_usd"], position["pnl_usd"])

    def test_open_position_is_classified_by_its_entry_inside_live_or_recovered(self):
        self.seed(entry_recovered=False)
        block = self.block()
        self.assertEqual([p["classification"] for p in block["live"]["open"]["positions"]], ["en vivo"])
        self.assertEqual(block["recovered"]["open"]["count"], 0)
        self.assertEqual(block["open"]["count"], 1)
        self.seed(entry_recovered=True)
        block = self.block()
        self.assertEqual(block["live"]["open"]["count"], 0)
        self.assertEqual(block["live"]["open"]["pnl_usd"], 0)
        (position,) = block["recovered"]["open"]["positions"]
        self.assertEqual(position["classification"], "recuperada (entrada con datos llegados tarde)")
        self.assertEqual(position["label"], OPEN_LABEL)
        self.assertEqual(block["recovered"]["open"]["pnl_usd"], position["pnl_usd"])
        self.assertEqual(block["open"]["count"], 1)

    def test_a_row_written_before_the_classification_is_unclassified_not_live(self):
        self.seed()
        block = self.block()
        self.assertEqual(block["live"]["open"]["count"], 0)
        self.assertEqual(block["live"]["open"]["pnl_usd"], 0)
        self.assertEqual(block["recovered"]["open"]["count"], 0)
        self.assertEqual(block["open"]["count"], 1)
        (position,) = block["unclassified_open"]["positions"]
        self.assertEqual(position["classification"], UNCLASSIFIED)
        self.assertIsNone(position["recovered"])
        self.assertEqual(position["label"], OPEN_LABEL)
        self.assertEqual(block["unclassified_open"]["pnl_usd"], position["pnl_usd"])
        self.assertEqual(block["progress"]["live_trades"], 7)

    def test_closed_trades_of_the_old_rule_are_a_block_of_their_own_and_never_live(self):
        self.seed(unclassified=28)
        block = self.block()
        self.assertEqual(block["unclassified"]["closed"], 28)
        self.assertEqual(block["unclassified"]["net_usd"], 9.0)
        self.assertIn("#283", block["unclassified"]["note"])
        self.assertIn("`--rebuild` los recalcula conservando la evidencia", block["unclassified"]["hint"])
        self.assertEqual((block["live"]["closed"], block["progress"]["live_trades"]), (7, 7))
        self.assertEqual(block["progress"]["remaining"], 93)
        self.seed()
        self.assertEqual(self.block()["unclassified"]["closed"], 0)

    def test_classified_rows_leave_the_unclassified_block_empty(self):
        for flag in (True, False):
            self.seed(entry_recovered=flag)
            self.assertEqual(self.block()["unclassified_open"]["count"], 0)

    def test_a_null_or_non_boolean_flag_is_unclassified(self):
        for junk in (None, 0, "no"):
            self.seed()
            db = sqlite3.connect(self.forward_db)
            (payload,) = db.execute("SELECT payload FROM forward_open").fetchone()
            db.execute("UPDATE forward_open SET payload=?", (json.dumps(dict(json.loads(payload), recovered=junk)),))
            db.commit()
            db.close()
            block = self.block()
            self.assertEqual(block["unclassified_open"]["count"], 1)
            self.assertEqual(block["unclassified_open"]["positions"][0]["classification"], UNCLASSIFIED)
            self.assertEqual(block["live"]["open"]["count"], 0)

    def test_entry_on_a_late_1m_candle_is_recovered_only_that_candle(self):
        b = 1_000_000 * 60_000
        self.assertTrue(open_is_recovered(b, {b}, set(), []))
        self.assertFalse(open_is_recovered(b, {b - 60_000, b + 60_000}, set(), []))
        self.assertFalse(open_is_recovered(b, set(), set(), []))

    def test_entry_on_a_late_5m_candle_window(self):
        b = 1_000_000 * 60_000
        self.assertTrue(open_is_recovered(b, set(), {b}, []))
        self.assertTrue(open_is_recovered(b, set(), {b - 240_000}, []))
        self.assertFalse(open_is_recovered(b, set(), {b - 300_000}, []))
        self.assertFalse(open_is_recovered(b, set(), {b + 60_000}, []))

    def test_entry_on_late_funding_window(self):
        b = 1_000_000 * 60_000
        self.assertTrue(open_is_recovered(b, set(), set(), [b + 60_000]))
        self.assertTrue(open_is_recovered(b, set(), set(), [b - 239_000]))
        self.assertFalse(open_is_recovered(b, set(), set(), [b - 240_000]))
        self.assertFalse(open_is_recovered(b, set(), set(), [b + 61_000]))

    def test_a_short_loses_when_the_market_rises(self):
        self.seed(side="SHORT")
        self.assertLess(self.block()["open"]["positions"][0]["pnl_usd"], -10.0)

    def test_flat_book_has_no_open_positions(self):
        self.seed(position=False)
        self.assertEqual(self.block()["open"]["count"], 0)

    def test_late_forward_is_flagged_with_minutes_and_reason(self):
        self.seed(last_run=NOW - 3 * HOUR)
        block = self.block()
        self.assertTrue(block["late"])
        self.assertEqual(block["problems"][0]["code"], "late")
        self.assertIn("180 min", block["problems"][0]["reason"])
        self.assertIn("60 min", block["problems"][0]["reason"])

    def test_the_late_limit_is_one_and_a_half_periods(self):
        self.seed(last_run=NOW - 89 * 60_000)
        self.assertFalse(self.block()["late"])
        self.seed(last_run=NOW - 90 * 60_000)
        self.assertFalse(self.block()["late"])
        self.seed(last_run=NOW - 91 * 60_000)
        self.assertTrue(self.block()["late"])

    def test_unusable_funding_gives_code_and_reason_per_product(self):
        self.seed(funding_ok=False)
        forward = self.read()
        self.assertEqual(forward["funding"]["PF_XBTUSD"]["code"], "stale_history")
        problems = self.block(forward)["problems"]
        self.assertEqual(problems[0]["code"], "funding_stale_history")
        self.assertIn("PF_XBTUSD: el funding observado llega con retraso", problems[0]["reason"])

    def test_a_changed_spec_is_reported(self):
        self.seed()
        block = strategy_block(self.read(), SID, {"state": "active"}, min_trades=100, spec_hash="otro")
        self.assertIn("spec_changed", [p["code"] for p in block["problems"]])

    def test_retired_strategy_is_not_late_and_keeps_its_reason(self):
        self.seed(last_run=NOW - 9 * HOUR)
        block = self.block(state="retired")
        self.assertIsNone(block["late"])
        self.assertEqual(block["state"], {"code": "retired", "reason": "desactivada en el registro", "since_ms": 5})

    def test_no_summary_says_why_instead_of_unknown(self):
        forward = self.read()
        self.assertFalse(forward["summary_available"])
        block = self.block(forward)
        self.assertFalse(block["available"])
        self.assertEqual(block["problems"][0]["code"], "no_summary")

    def test_active_strategy_missing_from_the_summary_is_named(self):
        self.seed()
        block = strategy_block(self.read(), "otra", {"state": "active"}, min_trades=100)
        self.assertEqual(block["problems"][0]["code"], "not_measured")

    def test_fresh_active_strategy_without_trades_says_so(self):
        self.seed(live=0, recovered=0, position=False)
        self.assertEqual([p["code"] for p in self.block()["problems"]], ["no_trades_yet"])

    def seed_skips(self):
        db = sqlite3.connect(self.decisions)
        db.execute("CREATE TABLE paper_futures_llm_skips(skip_id INTEGER PRIMARY KEY, product_id TEXT, "
                   "bucket_start INTEGER, question_id TEXT, question_version INTEGER, code TEXT, reason TEXT, "
                   "written_at INTEGER)")
        rows = [("PF_XBTUSD", "model_down", NOW - 60_000), ("PF_XBTUSD", "state_error", NOW - HOUR), ("PF_XBTUSD", "model_down", NOW - 2 * HOUR),
                ("PF_ETHUSD", "calm_skip", NOW - 30 * HOUR), ("PF_ETHUSD", "stale_verdict", NOW - 8 * 24 * HOUR)]
        db.executemany("INSERT INTO paper_futures_llm_skips(product_id, bucket_start, question_id, question_version, "
                       "code, reason, written_at) VALUES(?,0,'q1',1,?,?,?)",
                       [(p, c, "motivo " + c, w) for p, c, w in rows])
        db.commit()
        db.close()

    def test_q_skips_are_counted_per_code_in_each_window_and_latest_first(self):
        self.seed_skips()
        skips = read_q_skips(self.decisions, NOW)
        # A skip written exactly one hour ago is still inside the hour.
        self.assertEqual(skips["windows"]["1h"], {"total": 2, "by_code": {"model_down": 1, "state_error": 1}})
        self.assertEqual(skips["windows"]["24h"]["by_code"], {"model_down": 2, "state_error": 1})
        self.assertEqual(skips["windows"]["7d"]["by_code"], {"calm_skip": 1, "model_down": 2, "state_error": 1})
        self.assertEqual([s["code"] for s in skips["latest"]],
                         ["stale_verdict", "calm_skip", "model_down", "state_error", "model_down"])
        self.assertEqual(skips["latest"][0]["reason"], "motivo stale_verdict")

    def test_q_skips_without_database_or_table_give_a_reason(self):
        self.assertIn("sin base", read_q_skips(self.decisions, NOW)["reason"])
        sqlite3.connect(self.decisions).close()
        skips = read_q_skips(self.decisions, NOW)
        self.assertFalse(skips["available"])
        self.assertIn("todavía no existe", skips["reason"])

    def service(self):
        registry = StrategyRegistry(os.path.join(self.dir, "s.db"))
        self.addCleanup(registry.close)
        registry.seed(load_specs())
        registry.apply_closed()
        return StrategyService(registry, None, {}, market_db_path=self.market, forward_db_path=self.forward_db,
                               forward_summary_path=self.summary, decisions_db_path=self.decisions)

    def test_inventory_fills_forward_trades_and_keeps_a_reason_where_none_applies(self):
        self.seed()
        inventory = self.service().inventory()
        rows = {r["id"]: r for r in inventory["strategies"]}
        # The fixture hash is not the real spec hash, so the block says the spec changed.
        c30 = rows[SID]["forward"]
        self.assertTrue(c30["available"])
        self.assertEqual(c30["trades"]["live"]["closed"], 7)
        self.assertIn("spec_changed", [p["code"] for p in c30["problems"]])
        self.assertNotIn("c31-qwen-exit-perp-v1", rows)
        self.assertIn("Kronos", rows["kronos-small-1h-h4-v1"]["forward"]["missing"])
        self.assertIsNone(rows["kronos-small-1h-h4-v1"]["forward"]["trades"])
        self.assertIn("funding", inventory["forward_health"])

    def test_http_forward_route_is_get_only_and_lists_every_strategy(self):
        self.seed()
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.service()))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = "http://127.0.0.1:{}/api-strategies/forward".format(server.server_address[1])
        with urllib.request.urlopen(url, timeout=30) as response:
            body = json.loads(response.read())
        self.assertEqual(body["schema"], "futures-forward-result.v1")
        self.assertEqual(body["cadence_s"], 3600)
        self.assertIn(SID, [s["id"] for s in body["strategies"]])
        self.assertIn("PF_XBTUSD", body["funding"])
        self.assertFalse(body["q_skips"]["available"])
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(urllib.request.Request(url, data=b"{}", method="POST"), timeout=30)
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
