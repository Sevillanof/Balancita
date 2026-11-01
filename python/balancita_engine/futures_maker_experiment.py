"""Isolated, preregistered ETH maker/taker entry-cost experiment. No trading-account writes."""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from decimal import Decimal

from . import book_costs
from . import futures_book_execution as book
from .futures_costs import MAKER_RATE, TAKER_RATE

SCHEMA = "balancita-maker-experiment.v1"
_SQL = """
CREATE TABLE IF NOT EXISTS maker_specs(
  experiment_id TEXT PRIMARY KEY, registered_at_ms INTEGER NOT NULL, spec_json TEXT NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS maker_specs_no_update BEFORE UPDATE ON maker_specs
BEGIN SELECT RAISE(ABORT,'maker spec is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_specs_no_delete BEFORE DELETE ON maker_specs
BEGIN SELECT RAISE(ABORT,'maker spec is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_specs_no_replace BEFORE INSERT ON maker_specs
WHEN EXISTS(SELECT 1 FROM maker_specs WHERE experiment_id=NEW.experiment_id)
BEGIN SELECT RAISE(ABORT,'maker spec already exists'); END;
CREATE TABLE IF NOT EXISTS book_depth(
  product_id TEXT NOT NULL, received_at INTEGER NOT NULL, best_bid TEXT NOT NULL, best_ask TEXT NOT NULL,
  top_bids_json TEXT NOT NULL, top_asks_json TEXT NOT NULL, bid_depth_json TEXT NOT NULL, ask_depth_json TEXT NOT NULL,
  PRIMARY KEY(product_id,received_at)) STRICT;
CREATE TABLE IF NOT EXISTS book_provenance(
  product_id TEXT NOT NULL, received_at INTEGER NOT NULL, requested_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL, response_sha256 TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(product_id,received_at)) STRICT;
CREATE TRIGGER IF NOT EXISTS maker_depth_no_update BEFORE UPDATE ON book_depth
BEGIN SELECT RAISE(ABORT,'captured maker prices are immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_depth_no_delete BEFORE DELETE ON book_depth
BEGIN SELECT RAISE(ABORT,'captured maker prices are immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_depth_no_replace BEFORE INSERT ON book_depth
WHEN EXISTS(SELECT 1 FROM book_depth WHERE product_id=NEW.product_id AND received_at=NEW.received_at)
BEGIN SELECT RAISE(ABORT,'captured maker prices already exist'); END;
CREATE TRIGGER IF NOT EXISTS maker_provenance_no_update BEFORE UPDATE ON book_provenance
BEGIN SELECT RAISE(ABORT,'maker provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_provenance_no_delete BEFORE DELETE ON book_provenance
BEGIN SELECT RAISE(ABORT,'maker provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_provenance_no_replace BEFORE INSERT ON book_provenance
WHEN EXISTS(SELECT 1 FROM book_provenance WHERE product_id=NEW.product_id AND received_at=NEW.received_at)
BEGIN SELECT RAISE(ABORT,'maker provenance already exists'); END;
CREATE TABLE IF NOT EXISTS book_gap(
  product_id TEXT, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT NOT NULL, logged_ms INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS maker_gaps_no_update BEFORE UPDATE ON book_gap
BEGIN SELECT RAISE(ABORT,'maker gap evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_gaps_no_delete BEFORE DELETE ON book_gap
BEGIN SELECT RAISE(ABORT,'maker gap evidence is immutable'); END;
CREATE TABLE IF NOT EXISTS maker_reports(
  experiment_id TEXT NOT NULL, input_hash TEXT NOT NULL, report_json TEXT NOT NULL,
  PRIMARY KEY(experiment_id,input_hash)) STRICT;
CREATE TRIGGER IF NOT EXISTS maker_reports_no_update BEFORE UPDATE ON maker_reports
BEGIN SELECT RAISE(ABORT,'maker report is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_reports_no_delete BEFORE DELETE ON maker_reports
BEGIN SELECT RAISE(ABORT,'maker report is immutable'); END;
CREATE TRIGGER IF NOT EXISTS maker_reports_no_replace BEFORE INSERT ON maker_reports
WHEN EXISTS(SELECT 1 FROM maker_reports WHERE experiment_id=NEW.experiment_id AND input_hash=NEW.input_hash)
BEGIN SELECT RAISE(ABORT,'maker report already exists'); END;
"""


def default_spec():
    return {
        "schema": SCHEMA, "product": "PF_ETHUSD", "signal_source": "grid",
        "order_size_usd": "1000", "maker_rate": MAKER_RATE, "taker_rate": TAKER_RATE,
        "sample_ms": 5000, "grid_step_ms": 60000, "latency_ms": 100,
        "ttl_ms": 60000, "hold_ms": 120000, "max_gap_ms": 15000,
        "cluster_ms": 3600000, "minimum_clusters": 30, "max_bytes": 64 * 1024 * 1024,
        "promotion_allowed": False,
    }


def validate_spec(spec):
    if not isinstance(spec, dict) or set(spec) != set(default_spec()):
        raise ValueError("Especificación maker inválida.")
    if (spec["schema"] != SCHEMA or spec["product"] != "PF_ETHUSD"
            or spec["signal_source"] not in ("grid", "receipts") or spec["promotion_allowed"] is not False):
        raise ValueError("El experimento solo mide ETH en papel; no habilita maker.")
    for name in ("sample_ms", "grid_step_ms", "latency_ms", "ttl_ms", "hold_ms",
                 "max_gap_ms", "cluster_ms", "minimum_clusters", "max_bytes"):
        if type(spec[name]) is not int or spec[name] <= 0:
            raise ValueError("Parámetro maker inválido: " + name)
    if spec["hold_ms"] <= spec["ttl_ms"] + spec["max_gap_ms"] + spec["latency_ms"]:
        raise ValueError("El horizonte debe terminar después de cualquier relleno permitido.")
    if spec["minimum_clusters"] < book_costs.MIN_CLUSTERS_FOR_VERDICT:
        raise ValueError("No se reduce la evidencia mínima de 30 grupos horarios.")
    for name in ("order_size_usd", "maker_rate", "taker_rate"):
        value = book._decimal(spec[name])
        if value < 0 or (name == "order_size_usd" and value <= 0) or (name != "order_size_usd" and value >= 1):
            raise ValueError("Importe o tarifa maker inválidos.")
    return spec


class MakerStore:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(_SQL)
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def register(self, spec, *, registered_at_ms=None):
        validate_spec(spec)
        if registered_at_ms is not None and (type(registered_at_ms) is not int or registered_at_ms <= 0):
            raise ValueError("Tiempo de registro del experimento inválido.")
        identity = book.canonical_hash(spec)
        if self.db.execute("SELECT 1 FROM maker_specs WHERE experiment_id=?", (identity,)).fetchone() is None:
            with self.db:
                self.db.execute("INSERT INTO maker_specs VALUES(?,?,?)",
                                (identity, int(time.time() * 1000) if registered_at_ms is None else registered_at_ms,
                                 json.dumps(spec, sort_keys=True)))
        return identity

    def specification(self, identity):
        row = self.db.execute("SELECT * FROM maker_specs WHERE experiment_id=?", (identity,)).fetchone()
        if row is None:
            raise ValueError("El experimento debe registrarse antes de capturar datos.")
        spec = validate_spec(json.loads(row["spec_json"]))
        if book.canonical_hash(spec) != identity:
            raise ValueError("La especificación no pasa su hash.")
        return spec, row["registered_at_ms"]

    def _snapshot(self, snapshot):
        mid = snapshot.mid
        def bands(levels):
            return {
                str(band): str(sum((qty for price, qty in levels
                                   if abs(price - mid) / mid * 10000 <= band), Decimal(0)))
                for band in (5, 10, 25, 50, 100)
            }
        with self.db:
            self.db.execute("INSERT INTO book_depth VALUES(?,?,?,?,?,?,?,?)", (
                snapshot.product, snapshot.received_at_ms, str(snapshot.bids[0][0]), str(snapshot.asks[0][0]),
                json.dumps([[str(p), str(q)] for p, q in snapshot.bids]),
                json.dumps([[str(p), str(q)] for p, q in snapshot.asks]),
                json.dumps(bands(snapshot.bids)), json.dumps(bands(snapshot.asks)),
            ))
            self.db.execute("INSERT INTO book_provenance VALUES(?,?,?,?,?,?)", (
                snapshot.product, snapshot.received_at_ms, snapshot.requested_at_ms,
                snapshot.server_at_ms, snapshot.response_sha256, book.URL,
            ))

    def _gap(self, lo, hi, reason):
        with self.db:
            self.db.execute("INSERT INTO book_gap VALUES(?,?,?,?,?)",
                            ("PF_ETHUSD", lo, hi, reason, hi))

    def collect(self, identity, seconds, *, now_ms=None, sleep=time.sleep, snapshot_for=None, log=print):
        spec, registered = self.specification(identity)
        if type(seconds) is not int or seconds <= 0:
            raise ValueError("La captura requiere una duración positiva y acotada.")
        now_ms = now_ms or (lambda: int(time.time() * 1000))
        snapshot_for = snapshot_for or book.fetch_snapshot
        if now_ms() < registered:
            raise ValueError("La captura no puede preceder al registro del experimento.")
        deadline, due, last, count = now_ms() + seconds * 1000, now_ms(), None, 0
        try:
            while now_ms() < deadline:
                started = now_ms()
                try:
                    snapshot = snapshot_for(spec["product"])
                    now = now_ms()
                    if (snapshot.product != spec["product"] or snapshot.requested_at_ms < registered
                            or not 0 <= now - snapshot.received_at_ms <= book.MAX_QUOTE_AGE_MS
                            or abs(now - snapshot.server_at_ms) > book.MAX_QUOTE_AGE_MS):
                        raise book.BookError("libro_obsoleto", "Cotización maker no vigente.")
                    self._snapshot(snapshot)
                    last, count = snapshot.received_at_ms, count + 1
                except book.BookError as error:
                    self._gap(started if last is None else last, now_ms(), error.kind)
                    log("Maker: captura no evaluable: " + error.detail)
                size = sum(os.path.getsize(path) for path in (self.path, self.path + "-wal")
                           if os.path.exists(path))
                if size > spec["max_bytes"]:
                    raise ValueError("La captura maker alcanzó el límite de almacenamiento.")
                due += spec["sample_ms"]
                sleep(max(0, min(due, deadline) - now_ms()) / 1000)
        finally:
            if last is not None and now_ms() > last:
                self._gap(last, now_ms(), "capture_stopped")
        return count

    def evaluate(self, identity, *, execution_db=None):
        spec, registered = self.specification(identity)
        if spec["signal_source"] == "receipts" and execution_db is None:
            raise ValueError("El modo de señales requiere la base de recibos; no se sustituye por rejilla.")
        if spec["signal_source"] == "grid" and execution_db is not None:
            raise ValueError("La fuente de señales está congelada como rejilla; registrá otro experimento.")
        signals = None
        if execution_db is not None:
            source = sqlite3.connect("file:{}?mode=ro".format(os.path.abspath(execution_db)), uri=True)
            try:
                records = source.execute("SELECT evidence_hash,evidence_json FROM execution_receipts "
                                         "WHERE product='PF_ETHUSD' AND purpose='entry'").fetchall()
            finally:
                source.close()
            signals = []
            for digest, text in records:
                evidence = json.loads(text)
                if book.canonical_hash(evidence) != digest:
                    raise ValueError("Una señal maker no pasa el hash de su recibo.")
                book.replay_fill(evidence)
                signals.append({"time_ms": evidence["decision_at_ms"], "side": evidence["side"]})
        raw = [tuple(row) for row in self.db.execute(
            "SELECT * FROM book_depth WHERE product_id=? AND received_at>=? ORDER BY received_at",
            (spec["product"], registered))]
        gaps = [tuple(row) for row in self.db.execute("SELECT * FROM book_gap WHERE to_ms>=? ORDER BY from_ms", (registered,))]
        provenance = [tuple(row) for row in self.db.execute(
            "SELECT * FROM book_provenance WHERE received_at>=? ORDER BY received_at", (registered,))]
        payload = json.dumps({"spec": identity, "depth": raw, "gaps": gaps, "signals": signals, "provenance": provenance},
                             sort_keys=True, allow_nan=False).encode()
        input_hash = hashlib.sha256(payload).hexdigest()
        previous = self.db.execute("SELECT report_json FROM maker_reports WHERE experiment_id=? AND input_hash=?",
                                   (identity, input_hash)).fetchone()
        if previous is not None:
            return json.loads(previous["report_json"])
        snapshots, bad = book_costs.load_snapshots(self.path, spec["product"], registered)
        logged_gaps = book_costs.load_gaps(self.path, spec["product"], registered)
        if signals is None:
            grid = book_costs.grid_orders(snapshots, spec["grid_step_ms"])
            signals = [{"time_ms": order.signal_ms, "side": order.side} for order in grid]
        orders, excluded = book_costs.signal_orders(snapshots, signals, latency_ms=spec["latency_ms"])
        maker_fee = float(Decimal(spec["maker_rate"]) * 10000)
        taker_fee = float(Decimal(spec["taker_rate"]) * 10000)
        rows = book_costs.evaluate_orders(
            snapshots, orders, float(spec["order_size_usd"]), gaps=logged_gaps,
            ttl_ms=spec["ttl_ms"], hold_ms=spec["hold_ms"], latency_ms=0,
            max_gap_ms=spec["max_gap_ms"], maker_fee_bp=maker_fee, taker_fee_bp=taker_fee,
        )
        summary = book_costs.summarize_orders(rows, cluster_ms=spec["cluster_ms"])
        summary["unevaluable_signals"] = excluded
        for scenario in book_costs.SCENARIOS:
            if scenario in summary:
                paired = summary[scenario]["chase_minus_taker_bp"]
                if paired["clusters"] < spec["minimum_clusters"]:
                    summary[scenario]["verdict"] = "insufficient_data"
        clusters = (summary.get("taker_all_bp") or {}).get("clusters", 0)
        result = {
            "schema": SCHEMA, "experiment_id": identity, "input_hash": input_hash,
            "classification": "hypothetical_maker_scenarios", "analysis_scope": "entry_costs_only",
            "promotion_allowed": False, "complete_net_pnl": None,
            "status": "insufficient_data" if clusters < spec["minimum_clusters"] else "entry_costs_measured",
            "parameters": {**spec, "maker_fee_bp": maker_fee, "taker_fee_bp": taker_fee},
            "snapshots": len(snapshots), "unusable_snapshots": bad, "maker": summary,
            "source_note": "Public REST samples, no book-continuity or real-maker-fill proof. Exit costs and funding are excluded.",
        }
        with self.db:
            self.db.execute("INSERT INTO maker_reports VALUES(?,?,?)",
                            (identity, input_hash, json.dumps(result, sort_keys=True, allow_nan=False)))
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("register", "collect", "evaluate"))
    parser.add_argument("--db", required=True)
    parser.add_argument("--experiment")
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--execution-db")
    parser.add_argument("--out")
    parser.add_argument("--signal-source", choices=("grid", "receipts"), default="grid")
    args = parser.parse_args(argv)
    from .futures_qwen_live import ProcessLock
    try:
        with ProcessLock(args.db):
            store = MakerStore(args.db)
            try:
                if args.action == "register":
                    spec = default_spec()
                    spec["signal_source"] = args.signal_source
                    print(store.register(spec))
                elif not args.experiment:
                    raise ValueError("Hace falta el identificador del experimento registrado.")
                elif args.action == "collect":
                    count = store.collect(args.experiment, args.seconds)
                    if count == 0:
                        raise ValueError("No se capturaron cotizaciones; revisá los huecos registrados.")
                    print("Snapshots registrados:", count)
                else:
                    result = store.evaluate(args.experiment, execution_db=args.execution_db)
                    if args.out:
                        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
                        with open(args.out, "w", encoding="utf-8") as handle:
                            json.dump(result, handle, sort_keys=True, indent=2, allow_nan=False)
                    print(json.dumps(result, sort_keys=True, allow_nan=False))
            finally:
                store.close()
        return 0
    except (ValueError, OSError, sqlite3.Error) as error:
        print("error maker:", error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
