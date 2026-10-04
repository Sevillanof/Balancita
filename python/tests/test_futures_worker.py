import json
import os
import tempfile
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
    def launch(self, env=None):
        return subprocess.Popen(
            [sys.executable, "-m", "balancita_engine.futures_worker"],
            cwd=ROOT,
            env={**ENV, **(env or {})},
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

    def test_opt_in_diagnostics_are_separate_and_correlated_without_changing_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            trace_path = Path(directory) / "trace.jsonl"
            disabled = self.run_round_trip()
            enabled = self.run_round_trip({"BALANCITA_FUTURES_DIAGNOSTICS_PATH": str(trace_path)})

            self.assertEqual(enabled[0], disabled[0])
            self.assertEqual(enabled[1], disabled[1])
            self.assertEqual(enabled[2], "")
            records = [json.loads(line) for line in trace_path.read_text().splitlines()]
            phases = [record["phase"] for record in records]
            self.assertEqual(phases, [
                "request_read_start", "request_read_end", "request_received", "request_decoded",
                "compute_start", "input_snapshot", "compute_end", "response_encoded",
                "response_write", "response_flush", "ack_read_start", "ack_read_end",
                "ack_received", "ack_parsed", "committed_ack_encoded",
                "committed_ack_write", "committed_ack_flush",
            ])
            for record in records:
                self.assertEqual((record["request_id"], record["run_id"], record["work_id"]),
                                 ("r1", "run-fixture", "w1"))
                self.assertEqual(record["process_pid"], enabled[3])
                self.assertEqual(record["clock"], "time.perf_counter_ns")
                self.assertIsInstance(record["duration_ns"], int)
                self.assertGreaterEqual(record["duration_ns"], 0)
                self.assertGreaterEqual(record["rss_bytes"], 0)
            self.assertEqual(records[0]["strategy_evaluations"], "not_instrumented")
            request_read = records[1]
            self.assertEqual(request_read["read_scope"], "line_and_transport_wait")
            self.assertGreaterEqual(request_read["duration_ns"], 0)
            self.assertEqual(request_read["request_bytes"], enabled[4])
            self.assertEqual(records[8]["response_bytes"], records[9]["response_bytes"])
            self.assertGreaterEqual(records[8]["duration_ns"], 0)
            self.assertGreaterEqual(records[9]["duration_ns"], 0)
            snapshot = records[5]
            self.assertEqual(snapshot["input_event_count"], 0)
            self.assertEqual(snapshot["book_depth"], 0)
            self.assertEqual(snapshot["state_bytes"], 0)

    def run_round_trip(self, extra_env=None):
        process = self.launch(extra_env)
        try:
            ready = read_message(process)
            process.stdin.write(json.dumps(command()) + "\n")
            process.stdin.flush()
            result = read_message(process)
            process.stdin.write(json.dumps({
                "type": "ack", "status": "committed", "protocol_version": 1,
                "request_id": "r1", "run_id": "run-fixture", "work_id": "w1",
                "applied_state_version": 1, "result_hash": "a" * 64,
            }) + "\n")
            process.stdin.flush()
            ack = read_message(process)
            process.stdin.write(json.dumps({
                "type": "shutdown", "protocol_version": 1, "request_id": "shutdown",
                "run_id": "worker", "work_id": "shutdown",
            }) + "\n")
            process.stdin.flush()
            shutdown = read_message(process)
            stderr = process.stderr.read()
            process.wait(timeout=5)
            request_bytes = len((json.dumps(command()) + "\n").encode())
            return [ready, result], [ack, shutdown], stderr, process.pid, request_bytes
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_diagnostic_output_failure_does_not_break_worker_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            output, acknowledgements, stderr, _, _ = self.run_round_trip({
                "BALANCITA_FUTURES_DIAGNOSTICS_PATH": directory,
            })
        self.assertEqual(output[1]["result"]["realized_net_complete"], "0.09895")
        self.assertEqual(acknowledgements[0]["status"], "committed")
        self.assertEqual(stderr, "")

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
