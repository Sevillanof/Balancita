import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "python")}


def command(request_id="r1", work_id="w1"):
    return {
        "type": "work",
        "protocol_version": 1,
        "request_id": request_id,
        "run_id": "run-fixture",
        "work_id": work_id,
        "expected_state_version": 0,
        "payload": {
            "operation": "round_trip",
            "cash_usd": "1000",
            "side": "long",
            "quantity_btc": "0.01",
            "entry_price": "100",
            "exit_price": "110",
        },
    }


def read_message(process):
    line = process.stdout.readline()
    if not line:
        raise AssertionError("worker closed stdout before sending a protocol message")
    return json.loads(line)


class FuturesWorkerProcessTests(unittest.TestCase):
    def launch(self):
        return subprocess.Popen(
            [sys.executable, "-m", "balancita_engine.futures_worker"],
            cwd=ROOT,
            env=ENV,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def test_fragmented_jsonl_multiple_work_messages_require_matching_commit_ack(self):
        process = self.launch()
        try:
            pid = process.pid
            self.assertEqual(read_message(process)["type"], "ready")
            encoded = json.dumps(command("r1", "w1"), separators=(",", ":")) + "\n"
            process.stdin.write(encoded[:17])
            process.stdin.flush()
            process.stdin.write(encoded[17:])
            process.stdin.flush()
            first = read_message(process)
            self.assertEqual(first["type"], "result")
            self.assertEqual(first["result"]["realized_net_complete"], "0.09895")
            process.stdin.write(json.dumps({
                "type": "ack", "status": "committed", "protocol_version": 1,
                "request_id": "r1", "run_id": "run-fixture", "work_id": "w1",
                "applied_state_version": 1, "result_hash": "a" * 64,
            }) + "\n")
            process.stdin.flush()
            self.assertEqual(read_message(process)["status"], "committed")

            second = command("r2", "w2")
            process.stdin.write(json.dumps(second) + "\n")
            process.stdin.flush()
            self.assertEqual(read_message(process)["request_id"], "r2")
            process.stdin.write(json.dumps({
                "type": "ack", "status": "committed", "protocol_version": 1,
                "request_id": "wrong", "run_id": "run-fixture", "work_id": "w2",
                "applied_state_version": 1, "result_hash": "b" * 64,
            }) + "\n")
            process.stdin.flush()
            self.assertNotEqual(process.wait(timeout=5), 0)
            self.assertEqual(process.pid, pid)
            self.assertEqual(process.stderr.read(), "")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_rejects_protocol_version_mismatch_and_oversized_line(self):
        process = self.launch()
        try:
            self.assertEqual(read_message(process)["type"], "ready")
            invalid = command()
            invalid["protocol_version"] = 2
            process.stdin.write(json.dumps(invalid) + "\n")
            process.stdin.flush()
            response = read_message(process)
            self.assertEqual(response["type"], "error")
            self.assertIn("protocol_version", response["error"])
            process.stdin.write("x" * (1_048_577) + "\n")
            process.stdin.flush()
            self.assertEqual(read_message(process)["error"], "oversized_or_unterminated_line")
            self.assertEqual(process.wait(timeout=5), 2)
            self.assertEqual(process.stderr.read(), "")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_runtime_operation_returns_actual_c27_output_and_open_checkpoint(self):
        sys.path.insert(0, str(ROOT / "python" / "tests"))
        from futures_runtime_fixtures import CONFIG, INSTRUMENT, add_known_funding, warmed_market

        process = self.launch()
        try:
            worker_pid = process.pid
            self.assertEqual(read_message(process)["type"], "ready")
            request = {
                "type": "work", "protocol_version": 1, "request_id": "runtime-r1",
                "run_id": "runtime-run", "work_id": "runtime-w1",
                "expected_state_version": 0,
                "payload": {
                    "operation": "futures_runtime.v1", "runtime_config": CONFIG,
                    "instrument": INSTRUMENT,
                    "market_snapshot": add_known_funding(
                        warmed_market(21_600_000, breakout="long"), rate="0"
                    ),
                },
                "checkpoint": None,
            }
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            response = read_message(process)
            self.assertEqual(response["runtime_output"]["analysis"]["action"], "long")
            self.assertEqual(response["result"]["side"], "long")
            self.assertEqual(response["runtime_checkpoint"]["ledger_position"]["side"], "long")
            process.stdin.write(json.dumps({
                "type": "ack", "status": "committed", "protocol_version": 1,
                "request_id": "runtime-r1", "run_id": "runtime-run", "work_id": "runtime-w1",
                "applied_state_version": 1, "result_hash": "a" * 64,
            }) + "\n")
            process.stdin.flush()
            self.assertEqual(read_message(process)["status"], "committed")
            follow_up = {
                **request,
                "request_id": "runtime-r2",
                "work_id": "runtime-w2",
                "expected_state_version": 1,
                "payload": {
                    **request["payload"],
                    "market_snapshot": add_known_funding(
                        warmed_market(21_601_000, base_price="100000"), rate="0"
                    ),
                },
                "checkpoint": response["runtime_checkpoint"],
            }
            process.stdin.write(json.dumps(follow_up) + "\n")
            process.stdin.flush()
            held = read_message(process)
            self.assertEqual(held["runtime_output"]["analysis"]["action"], "WAIT")
            self.assertEqual(held["runtime_output"]["position"]["side"], "long")
            self.assertEqual(held["runtime_output"]["fills"], [])
            self.assertEqual(held["runtime_checkpoint"]["cash_usd"], response["runtime_checkpoint"]["cash_usd"])
            self.assertEqual(process.pid, worker_pid)
            process.stdin.write(json.dumps({
                "type": "ack", "status": "committed", "protocol_version": 1,
                "request_id": "runtime-r2", "run_id": "runtime-run", "work_id": "runtime-w2",
                "applied_state_version": 2, "result_hash": "b" * 64,
            }) + "\n")
            process.stdin.flush()
            self.assertEqual(read_message(process)["status"], "committed")
            self.assertEqual(process.stderr.read(0), "")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
