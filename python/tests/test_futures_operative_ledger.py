import json
import unittest

from balancita_engine.futures_ledger import FuturesLedger
from balancita_engine.futures_operative_state import ExactLedgerIdentityPort


class OperativeLedgerTests(unittest.TestCase):
    def test_fresh_ledger_restore_keeps_financial_state_and_exact_old_fill_identity(self):
        committed, pending = {}, {}
        checkpoint = None

        def make_port():
            return ExactLedgerIdentityPort(
                lambda kind, key: committed.get((kind, key)),
                lambda kind, key, value: pending.__setitem__((kind, key), value),
            )

        continuous = FuturesLedger("10000")
        resumed_snapshot = None
        encoded_sizes = {}
        for count in (20, 40, 80):
            for index in range(count if count == 20 else (count - (20 if count == 40 else 40))):
                n = index + (0 if count == 20 else (20 if count == 40 else 40))
                port = make_port()
                ledger = FuturesLedger.restore_operative(checkpoint, identity_port=port) if checkpoint else FuturesLedger("10000")
                if checkpoint is None:
                    ledger._ledger_identity_port = port
                at = n * 1000 + 100
                ledger.observe_funding("window-{}".format(n), at, at + 500, "0.0001", at)
                ledger.open("long", "0.005", "100000", "taker", at, fill_id="open-{}".format(n))
                ledger.accrue_funding(at, at + 100)
                ledger.close("0.005", "99999", "taker", at + 100, fill_id="close-{}".format(n))
                pending.clear()
                pending.update({(u["kind"], u["key"]): u["value"] for u in ledger.drain_operative_identity_updates()})
                committed.update(pending)
                pending.clear()
                checkpoint = ledger.operative_checkpoint()
                continuous.observe_funding("window-{}".format(n), at, at + 500, "0.0001", at)
                continuous.open("long", "0.005", "100000", "taker", at)
                continuous.accrue_funding(at, at + 100)
                continuous.close("0.005", "99999", "taker", at + 100)
            resumed = FuturesLedger.restore_operative(checkpoint, identity_port=make_port())
            resumed_state = resumed.snapshot("100000")
            continuous_state = continuous.snapshot("100000")
            self.assertEqual({key: value for key, value in resumed_state.items() if key != "events"},
                             {key: value for key, value in continuous_state.items() if key != "events"})
            encoded_sizes[count] = len(json.dumps(checkpoint, sort_keys=True, separators=(",", ":")).encode())
            resumed_snapshot = resumed.snapshot("100000")

        self.assertEqual(resumed_snapshot["cash_usd"], "10000")
        self.assertEqual(resumed_snapshot["quantity_btc"], "0")
        self.assertEqual(resumed_snapshot["fees_usd"], "39.9998")
        self.assertTrue(resumed_snapshot["funding_complete"])
        self.assertEqual(set(encoded_sizes), {20, 40, 80})
        self.assertLessEqual(max(encoded_sizes.values()) - min(encoded_sizes.values()), 128)

        restored = FuturesLedger.restore_operative(checkpoint, identity_port=make_port())
        before = restored.snapshot("100000")
        restored.open("long", "0.005", "100000", "taker", 100, fill_id="open-0")
        self.assertEqual(restored.snapshot("100000"), before)
        with self.assertRaises(ValueError):
            restored.open("long", "0.006", "100000", "taker", 100, fill_id="open-0")

    def test_restore_requires_identity_port_and_rejects_malformed_totals(self):
        ledger = FuturesLedger("10000")
        checkpoint = ledger.operative_checkpoint()
        with self.assertRaises(ValueError):
            FuturesLedger.restore_operative(checkpoint, identity_port=None)
        bad = dict(checkpoint, fees="-1")
        port = ExactLedgerIdentityPort(lambda kind, key: None, lambda kind, key, value: None)
        with self.assertRaises(ValueError):
            FuturesLedger.restore_operative(bad, identity_port=port)

    def test_funding_gap_remains_incomplete_after_later_known_evidence(self):
        port = ExactLedgerIdentityPort(lambda kind, key: None, lambda kind, key, value: None)
        ledger = FuturesLedger("10000")
        ledger._ledger_identity_port = port
        ledger.open("long", "0.005", "100000", "taker", 0, fill_id="gap-open")
        ledger.accrue_funding(0, 100)
        ledger.close("0.005", "100000", "taker", 100, fill_id="gap-close")
        incomplete = ledger.operative_checkpoint()
        resumed = FuturesLedger.restore_operative(incomplete, identity_port=port)
        resumed.observe_funding("later", 100, 200, "0.0001", 100)
        self.assertFalse(resumed.funding_complete)
        self.assertIsNone(resumed.snapshot("100000")["net_complete"])


if __name__ == "__main__":
    unittest.main()
