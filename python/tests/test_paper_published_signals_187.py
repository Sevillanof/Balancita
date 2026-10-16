"""Issue #187 (BAL-DECISION-187-04): the ``signal`` stage of the published intervals is read from ``signals_persisted.refs`` and checked
against the ``SignalLog`` by ``seq`` and ``entry_hash``. WAIT signals are included and get no decision and no order. A reference that does
not match is published as unverified. Invented data; read only."""

import unittest

from balancita_engine import paper_live_publish as PUB

import test_paper_runner as T


def refs(runner):
    return [ref for e in runner.journal.entries if e["kind"] == "signals_persisted" for ref in e["data"]["refs"]]


def by_product(block):
    return {row["product_id"]: row for row in block["intervals"]}


class TestSignalStage(T.Rig):
    def mixed(self):
        """BTC buys, ETH waits: one decision and one signal that never became a decision."""
        script = {"scripted-a": {(T.BTC, T.CYCLE): self.call("BUY"), (T.ETH, T.CYCLE): self.call("WAIT")}}
        r = self.runner(script)
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC), T.cycle(T.CYCLE + 3 * T.SEC, T.ETH)])
        return r

    def test_a_decision_row_carries_the_verified_signal_it_came_from(self):
        r = self.mixed()
        block = PUB.intervals(r)
        stage = by_product(block)[T.BTC]["stages"]["signal"]
        [ref] = [x for x in refs(r) if x["action"] == "BUY"]
        self.assertEqual((stage["state"], stage["action"], stage["seq"], stage["entry_hash"]),
                         ("recorded", "BUY", ref["seq"], ref["entry_hash"]))
        self.assertEqual(by_product(block)[T.BTC]["stages"]["decision"]["state"], "recorded")

    def test_a_wait_signal_is_published_with_no_decision_and_no_order(self):
        r = self.mixed()
        row = by_product(PUB.intervals(r))[T.ETH]
        self.assertEqual((row["stages"]["signal"]["state"], row["stages"]["signal"]["action"]), ("recorded", "WAIT"))
        self.assertEqual(row["stages"]["decision"], {"state": "none", "decided_ms": None})
        self.assertEqual((row["stages"]["order"]["state"], row["stages"]["trade"]["state"]), ("none", "none"))
        self.assertEqual(r.orders() and [o["product_id"] for o in r.orders()], [T.BTC])          # nothing was made up for ETH

    def test_the_contract_is_complete_when_every_reference_checks_out(self):
        block = PUB.intervals(self.mixed())
        self.assertEqual(block["contract"], {"complete": True, "stages_present": ["signal", "decision", "order", "trade"], "stages_missing": []})
        self.assertEqual(block["signal_references"], {"verified": 2, "unverified": []})

    def test_the_filters_apply_to_wait_rows_too(self):
        r = self.mixed()
        self.assertEqual([x["product_id"] for x in PUB.intervals(r, product=T.ETH)["intervals"]], [T.ETH])
        self.assertEqual(PUB.intervals(r, product=T.BTC)["signal_references"]["verified"], 2)
        wait_ms = r.log.entries[by_product(PUB.intervals(r))[T.ETH]["stages"]["signal"]["seq"] - 1]["data"]["generated_ms"]
        waits = lambda block: [x["product_id"] for x in block["intervals"] if x["stages"]["decision"]["state"] == "none"]
        self.assertEqual(waits(PUB.intervals(r, to_ms=wait_ms)), [])                        # the window ends before the wait signal
        self.assertEqual(waits(PUB.intervals(r, from_ms=wait_ms)), [T.ETH])

    def test_a_reference_that_does_not_match_the_log_is_unverified_and_makes_no_row(self):
        for name, damage, reason in (
                ("missing seq", lambda r, ref: ref.update(seq=999), "reference_missing"),
                ("hash", lambda r, ref: ref.update(entry_hash="0" * 64), "entry_hash_mismatch"),
                ("key", lambda r, ref: ref.update(key="other"), "key_mismatch"),
                ("action", lambda r, ref: ref.update(action="SELL"), "action_mismatch")):
            with self.subTest(case=name):
                r = self.mixed()
                [ref] = [x for x in refs(r) if x["action"] == "WAIT"]
                damage(r, ref)
                block = PUB.intervals(r)
                self.assertEqual([u["reason"] for u in block["signal_references"]["unverified"]], [reason])
                self.assertFalse(block["contract"]["complete"])
                self.assertNotIn(T.ETH, by_product(block))                  # the wait signal is not published on an untrusted reference

    def test_a_decision_whose_reference_is_untrusted_has_an_unverified_signal_stage(self):
        r = self.mixed()
        [ref] = [x for x in refs(r) if x["action"] == "BUY"]
        ref["entry_hash"] = "0" * 64
        block = PUB.intervals(r)
        stage = by_product(block)[T.BTC]["stages"]["signal"]
        self.assertEqual((stage["state"], stage["reason"]), ("unverified", "no_verified_reference"))
        self.assertEqual(by_product(block)[T.BTC]["stages"]["order"]["state"], "pending")        # the rest is still published as it was
        self.assertFalse(block["contract"]["complete"])

    def test_a_runner_with_no_signals_publishes_an_empty_complete_block(self):
        r = self.runner()
        block = PUB.intervals(r)
        self.assertEqual((block["intervals"], block["signal_references"]), ([], {"verified": 0, "unverified": []}))


if __name__ == "__main__":
    unittest.main()
