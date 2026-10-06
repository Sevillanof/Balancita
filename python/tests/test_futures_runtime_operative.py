import hashlib
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from copy import deepcopy
from decimal import Decimal, localcontext
from itertools import count

from balancita_engine.futures_operative_state import (
    ExactIdentityPort,
    ExactLedgerIdentityPort,
    OperativeIdentityUnavailableError,
)
from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT, add_known_funding, warmed_market

POLICY = "futures-operative-checkpoint.v1"
ACTIVE = ("accepted", "partially_filled")

# sha256 of the canonical JSON of legacy checkpoints captured before the
# opt-in policy existed; the default (no key) bytes must never change.
LEGACY_GOLDEN = {
    "lab": "412d101091eca054a301e801afc1d78b482136168fc1b4086fdcfecce747eb5e",
    "risk_funding": "365cf4cd622003069a9f4d992d71e07c38081ff8d0d2a00a26135d34d224536a",
    "risk_open": "7628868c9e990acf96ffb038786dbcf74bdd62a009b06ed8c7175705e798f260",
}


def risk_config(**extra):
    config = dict(CONFIG)
    config.update(
        version="futures-runtime-risk.v1",
        execution_latency_ms=100,
        daily_loss_fraction="0.01",
    )
    config.update(extra)
    return config


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def legacy_digest(kind):
    if kind == "lab":
        engine = FuturesRuntime(run_id="golden", config=dict(CONFIG), instrument=INSTRUMENT)
        engine.process(warmed_market(21_600_000, breakout="long"))
    else:
        extra = {"funding_policy_version": "funding-separation.v1"} if kind == "risk_funding" else {}
        engine = FuturesRuntime(run_id="golden", config=risk_config(**extra), instrument=INSTRUMENT)
        engine.process(warmed_market(21_600_000, breakout="long"))
        engine.process(warmed_market(21_600_100, base_price="100000"))
    return hashlib.sha256(canonical(engine.checkpoint()).encode()).hexdigest()


class IdentityStore:
    """In-memory committed identity stores with explicit post-job commit."""

    def __init__(self, fail=False):
        self.execution, self.ledger, self.fail = {}, {}, fail

    def _lookup(self, table):
        def lookup(kind, key):
            if self.fail:
                raise ConnectionError("identity store unavailable")
            return table.get((kind, key))
        return lookup

    def ports(self):
        return {
            "execution_identity_port": ExactIdentityPort(
                self._lookup(self.execution), lambda kind, key, value: None
            ),
            "ledger_identity_port": ExactLedgerIdentityPort(
                self._lookup(self.ledger), lambda kind, key, value: None
            ),
        }

    def commit(self, runtime):
        updates = runtime.drain_operative_identity_updates()
        for item in updates["execution"]:
            self.execution[(item["kind"], item["key"])] = item["value"]
        for item in updates["ledger"]:
            self.ledger[(item["kind"], item["key"])] = item["value"]


def operative_runtime(store, checkpoint=None, **extra):
    return FuturesRuntime(
        run_id="operative-run",
        config=risk_config(operative_checkpoint_policy_version=POLICY, **extra),
        instrument=INSTRUMENT,
        checkpoint=checkpoint,
        **store.ports(),
    )


def funded(market, base):
    """Known funding for the whole cycle, ending before the next cycle starts."""
    add_known_funding(market, interval_id="cycle-{}".format(base), start_ms=base, rate="0.0001")
    next(e for e in market["events"] if e["type"] == "funding")["end_time_ms"] = base + 500_000
    return market


def terminal_orders(runtime):
    return sum(1 for order in runtime.execution_adapter.orders.values() if order["state"] not in ACTIVE)


def stale_replay(restore, *, full_cycles, **extra):
    """Evaluate two breakout signals, then replay stale candles on a fresh book.

    Returns the observable decision of the replay job so a continuous runtime
    and a runtime rebuilt from the compact checkpoint before every job can be
    compared.
    """
    store, sequences = IdentityStore(), count(1)
    runtime = operative_runtime(store, **extra)

    def job(market):
        nonlocal runtime
        next(e for e in market["events"] if e["type"] == "book_snapshot")["sequence"] = next(sequences)
        if restore:
            runtime = operative_runtime(store, checkpoint=deepcopy(runtime.checkpoint()), **extra)
        result = runtime.process(market)
        store.commit(runtime)
        return result

    def cycle(base):
        opened = job(funded(warmed_market(base, breakout="long", book_size="0.005"), base))
        if not full_cycles:
            return
        opened = job(funded(warmed_market(base + 100, book_size="0.005"), base))
        stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
        crossing = funded(warmed_market(base + 200, base_price="100000"), base)
        next(e for e in crossing["events"] if e["type"] == "ticker")["mark_usd"] = str(stop - 1)
        next(e for e in crossing["events"] if e["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        job(crossing)
        job(funded(warmed_market(base + 300, base_price="100000"), base))

    first, second = 21_600_000, 22_200_000
    cycle(first)
    cycle(second)
    stale = funded(warmed_market(second + 400, book_size="0.005"), second)
    old = warmed_market(first, breakout="long")
    stale["events"] = [e for e in stale["events"] if e["type"] != "candle"] + [
        e for e in old["events"] if e["type"] == "candle"
    ]
    result = job(stale)
    return {
        "analysis": result["analysis"]["reason_codes"],
        "risk": result["risk"],
        "orders": result["orders"],
        # Terminal orders are history, which the compact checkpoint does not carry.
        "active_orders": sorted(
            order_id for order_id, order in runtime.execution_adapter.orders.items()
            if order["state"] in ACTIVE
        ),
        "metadata_of_active": sorted(
            order_id for order_id in runtime.execution_metadata
            if runtime.execution_adapter.orders[order_id]["state"] in ACTIVE
        ),
        "new_orders": [order["order_id"] for order in result["orders"] if order["type"] == "order_accepted"],
    }


class RuntimeOperativeRestoreTests(unittest.TestCase):
    def test_stale_candle_replay_of_an_evaluated_signal_matches_continuous_run(self):
        continuous = stale_replay(False, full_cycles=True)
        self.assertEqual(continuous["analysis"], ["signal_already_evaluated"])
        self.assertEqual(stale_replay(True, full_cycles=True), continuous)

    def test_stale_replay_of_a_signal_that_never_produced_an_order_matches_continuous_run(self):
        # A $1 notional cap makes every breakout evaluate to "below minimum quantity":
        # the signal is consumed but no order id exists to protect it.
        extra = {"max_notional_usd": "1"}
        continuous = stale_replay(False, full_cycles=False, **extra)
        self.assertEqual(continuous["analysis"], ["signal_already_evaluated"])
        self.assertEqual(continuous["active_orders"], [])
        self.assertEqual(stale_replay(True, full_cycles=False, **extra), continuous)

    def test_every_job_fresh_restore_matches_continuous_run_and_checkpoint_is_bounded(self):
        continuous_store, fresh_store = IdentityStore(), IdentityStore()
        continuous = operative_runtime(continuous_store)
        sizes, sequences = {}, count(1)

        def job(market):
            # An exact book identity can never refill its liquidity budget, so each
            # job observes a distinct snapshot like a live feed would.
            next(e for e in market["events"] if e["type"] == "book_snapshot")["sequence"] = next(sequences)
            ledger_before = len(continuous.ledger.events)
            events_before = len(continuous.execution_adapter.events)
            checkpoint = continuous.checkpoint()
            fresh = operative_runtime(fresh_store, checkpoint=deepcopy(checkpoint))
            expected = continuous.process(deepcopy(market))
            actual = fresh.process(deepcopy(market))
            continuous_store.commit(continuous)
            fresh_store.commit(fresh)
            # Audit history is deliberately not carried by the compact checkpoint:
            # the restored runtime reports only the events of its own job.
            expected["ledger"]["events"] = expected["ledger"]["events"][ledger_before:]
            expected["execution_events"] = expected["execution_events"][events_before:]
            self.assertEqual(actual, expected)
            self.assertEqual(
                {k: v for k, v in fresh.ledger.snapshot("100000").items() if k != "events"},
                {k: v for k, v in continuous.ledger.snapshot("100000").items() if k != "events"},
            )
            self.assertEqual(fresh.checkpoint(), continuous.checkpoint())
            self.assertEqual(fresh_store.execution, continuous_store.execution)
            self.assertEqual(fresh_store.ledger, continuous_store.ledger)
            return expected

        cycle = 0
        while terminal_orders(continuous) < 80:
            base = 21_600_000 + cycle * 600_000
            cycle += 1
            job(funded(warmed_market(base, breakout="long", book_size="0.005"), base))
            opened = job(funded(warmed_market(base + 100, book_size="0.005"), base))
            self.assertEqual(opened["position"]["quantity_btc"], "0.005")
            stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
            crossing = funded(warmed_market(base + 200, base_price="100000"), base)
            next(e for e in crossing["events"] if e["type"] == "ticker")["mark_usd"] = str(stop - 1)
            next(e for e in crossing["events"] if e["type"] == "book_snapshot").update(
                valid=False, contiguous=False
            )
            queued = job(crossing)
            self.assertIsNotNone(queued["risk"]["reduction_intent_id"])
            closed = job(funded(warmed_market(base + 300, base_price="100000"), base))
            self.assertEqual(closed["position"]["quantity_btc"], "0")
            for mark in (20, 40, 80):
                if terminal_orders(continuous) >= mark and mark not in sizes:
                    sizes[mark] = len(canonical(continuous.checkpoint()).encode())
        self.assertEqual(set(sizes), {20, 40, 80})
        self.assertLessEqual(sizes[80], sizes[20] + 2048, sizes)

    def test_default_config_checkpoint_bytes_are_unchanged(self):
        for kind, digest in LEGACY_GOLDEN.items():
            self.assertEqual(legacy_digest(kind), digest, kind)

    def test_policy_requires_risk_runtime_known_value_and_exact_ports(self):
        store = IdentityStore()
        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="r", config=risk_config(operative_checkpoint_policy_version="v2"),
                           instrument=INSTRUMENT, **store.ports())
        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="r", config=dict(CONFIG, operative_checkpoint_policy_version=POLICY),
                           instrument=INSTRUMENT, **store.ports())
        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="r", config=risk_config(operative_checkpoint_policy_version=POLICY),
                           instrument=INSTRUMENT)
        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="r", config=risk_config(), instrument=INSTRUMENT, **store.ports())

    def test_legacy_and_compact_checkpoints_never_cross_restore(self):
        store = IdentityStore()
        compact = operative_runtime(store)
        compact.process(warmed_market(21_600_000, breakout="long"))
        compact_checkpoint = compact.checkpoint()
        legacy = FuturesRuntime(run_id="operative-run", config=risk_config(), instrument=INSTRUMENT)
        legacy.process(warmed_market(21_600_000, breakout="long"))
        legacy_checkpoint = legacy.checkpoint()

        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="operative-run", config=risk_config(), instrument=INSTRUMENT,
                           checkpoint=deepcopy(compact_checkpoint))
        relabelled = deepcopy(compact_checkpoint)
        relabelled["runtime_config"] = risk_config()
        with self.assertRaises(ValueError):
            FuturesRuntime(run_id="operative-run", config=risk_config(), instrument=INSTRUMENT,
                           checkpoint=relabelled)
        with self.assertRaises(ValueError):
            operative_runtime(IdentityStore(), checkpoint=deepcopy(legacy_checkpoint))
        relabelled = deepcopy(legacy_checkpoint)
        relabelled["runtime_config"] = risk_config(operative_checkpoint_policy_version=POLICY)
        with self.assertRaises(ValueError):
            operative_runtime(IdentityStore(), checkpoint=relabelled)
        # The legacy path stays restorable and full-history.
        self.assertIn("ledger_events", legacy_checkpoint)
        self.assertNotIn("ledger_events", compact_checkpoint)
        self.assertNotIn("execution_checkpoint", compact_checkpoint)
        FuturesRuntime(run_id="operative-run", config=risk_config(), instrument=INSTRUMENT,
                       checkpoint=deepcopy(legacy_checkpoint))

    def test_unavailable_identity_lookup_fails_closed_without_partial_checkpoint(self):
        store = IdentityStore()
        engine = operative_runtime(store)
        checkpoint = engine.checkpoint()
        failing = IdentityStore(fail=True)
        restored = operative_runtime(failing, checkpoint=checkpoint)
        with self.assertRaises(OperativeIdentityUnavailableError):
            restored.process(warmed_market(21_600_000, breakout="long"))
        with self.assertRaises(ValueError):
            restored.checkpoint()
        with self.assertRaises(ValueError):
            restored.drain_operative_identity_updates()
        # The same job succeeds once the store is reachable again.
        recovered = operative_runtime(store, checkpoint=checkpoint)
        recovered.process(warmed_market(21_600_000, breakout="long"))
        recovered.checkpoint()



WORKER_ROOT = Path(__file__).resolve().parents[2]


class WorkerHost:
    """Plays the Node host for the plain (non-opted) worker protocol."""

    def __init__(self, unavailable=False):
        self.rows, self.queries, self.unavailable = {}, [], unavailable
        self.process = subprocess.Popen(
            [sys.executable, "-m", "balancita_engine.futures_worker"], cwd=WORKER_ROOT,
            env={**os.environ, "PYTHONPATH": str(WORKER_ROOT / "python")},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.read()  # ready

    def read(self):
        line = self.process.stdout.readline()
        return json.loads(line) if line else None

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        self.process.stdout.close()
        self.process.stderr.close()


class WorkerOperativeBridgeTests(unittest.TestCase):
    def test_non_opted_worker_result_and_checkpoint_are_unchanged(self):
        host = WorkerHost()
        try:
            config = risk_config()
            host.send({
                "type": "work", "protocol_version": 1, "request_id": "r", "run_id": "operative-run",
                "work_id": "w", "expected_state_version": 0,
                "payload": {"operation": "futures_runtime.v3", "runtime_config": config,
                            "instrument": INSTRUMENT, "market_snapshot": warmed_market(21_600_000, breakout="long")},
            })
            message = host.read()
            self.assertEqual(message["type"], "result")
            self.assertNotIn("runtime_identity_updates", message)
            self.assertIn("ledger_events", message["runtime_checkpoint"])
            self.assertEqual(host.queries, [])
        finally:
            host.process.kill()
            host.process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
