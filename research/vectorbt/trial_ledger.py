"""Append-only ledger of every VectorBT lab run. It feeds the gate's attempts counter (deflated Sharpe).

One writer: this module (class ``Ledger``). The gate only reads the file, read-only, and the lab never writes into
``gate.sqlite``. Rows are never updated or deleted (SQL triggers abort both).

Run vs variant: every ``record_run`` is a new row (a new RUN). A variant is a distinct hypothesis, identified by
``variant_key`` = sha256 of the canonical JSON ``{family, params}``. Repeating a configuration adds a run but not a
variant; only variants count as attempts for the gate.

Selection: choosing a run for the gate is recorded as a NEW row with status ``selection`` (``record_selection``) and
``selected_for_gate = 1``; it points at the chosen trial in ``metrics_json``. The chosen row itself is never touched.
"""

import hashlib
import json
import os
import platform
import sqlite3
import time
import urllib.parse

from research.vectorbt.data_contract import ContractError
from research.vectorbt.engine import ROOT, futures_costs
from balancita_engine.strategy_gate import family_of

DEFAULT_PATH = os.path.join(ROOT, "data", "research-vectorbt", "ledger.sqlite")
STATUSES = ("ok", "error", "no_trades", "selection")

SCHEMA = """
CREATE TABLE IF NOT EXISTS trials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  parent_experiment_id TEXT,
  family TEXT NOT NULL,
  source_strategy_id TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  params_json TEXT NOT NULL,
  seed INTEGER,
  dataset_sha256 TEXT,
  gate_config_sha256 TEXT,
  cost_model_version TEXT NOT NULL,
  vectorbt_version TEXT,
  python_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','error','no_trades','selection')),
  metrics_json TEXT,
  error TEXT,
  started_at_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  selected_for_gate INTEGER NOT NULL DEFAULT 0 CHECK(selected_for_gate IN (0,1)));
CREATE INDEX IF NOT EXISTS trials_family ON trials(family);
CREATE TRIGGER IF NOT EXISTS trials_no_update BEFORE UPDATE ON trials
  BEGIN SELECT RAISE(ABORT, 'trials is append-only: UPDATE is not allowed'); END;
CREATE TRIGGER IF NOT EXISTS trials_no_delete BEFORE DELETE ON trials
  BEGIN SELECT RAISE(ABORT, 'trials is append-only: DELETE is not allowed'); END;
"""


def variant_key(family, params):
    """Stable hash of the hypothesis: canonical JSON of the family and the (sorted) parameters."""
    canonical = json.dumps({"family": family, "params": params}, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _vectorbt_version():
    try:
        import vectorbt
        return getattr(vectorbt, "__version__", None)
    except Exception:  # the ledger must work without the heavy dependency
        return None


def _readonly(path):
    return sqlite3.connect("file:{}?mode=ro".format(urllib.parse.quote(os.path.abspath(path))), uri=True, timeout=5)


class Ledger:
    def __init__(self, path=DEFAULT_PATH, timeout=30):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=timeout)
        self.conn.executescript(SCHEMA)

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def record_run(self, *, experiment_id, source_strategy_id, params, status="ok", family=None,
                   parent_experiment_id=None, seed=None, dataset_sha256=None, gate_config_sha256=None,
                   metrics=None, error=None, started_at_ms=None, duration_ms=None, selected_for_gate=False):
        """Appends one run and returns its id. ``family`` defaults to the strategy id without its ``-vN`` suffix."""
        if status not in STATUSES:
            raise ValueError("unknown status: {}".format(status))
        family = family or family_of(source_strategy_id)
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO trials(experiment_id,parent_experiment_id,family,source_strategy_id,variant_key,params_json,"
                "seed,dataset_sha256,gate_config_sha256,cost_model_version,vectorbt_version,python_version,status,"
                "metrics_json,error,started_at_ms,duration_ms,selected_for_gate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (experiment_id, parent_experiment_id, family, source_strategy_id, variant_key(family, params),
                 json.dumps(params, sort_keys=True, default=str), seed, dataset_sha256, gate_config_sha256,
                 futures_costs.COST_MODEL_VERSION, _vectorbt_version(), platform.python_version(), status,
                 None if metrics is None else json.dumps(metrics, sort_keys=True, default=str), error,
                 int(time.time() * 1000) if started_at_ms is None else started_at_ms, duration_ms,
                 1 if selected_for_gate else 0))
        return cur.lastrowid

    def record_selection(self, trial_id, experiment_id=None):
        """Marks a run as chosen for the gate by appending a ``selection`` row (the chosen row is left untouched)."""
        row = self.conn.execute(
            "SELECT experiment_id,family,source_strategy_id,params_json,seed,dataset_sha256,gate_config_sha256 "
            "FROM trials WHERE id=?", (trial_id,)).fetchone()
        if row is None:
            raise ValueError("unknown trial: {}".format(trial_id))
        return self.record_run(experiment_id=experiment_id or row[0], family=row[1], source_strategy_id=row[2],
                               params=json.loads(row[3]), seed=row[4], dataset_sha256=row[5],
                               gate_config_sha256=row[6], status="selection", metrics={"selected_trial_id": trial_id},
                               selected_for_gate=True)

    def distinct_variants(self, family):
        return self.conn.execute("SELECT COUNT(DISTINCT variant_key) FROM trials WHERE family=?",
                                 (family,)).fetchone()[0]

    def runs(self, family):
        """All runs of the family (selection rows excluded), oldest first, as dicts."""
        cur = self.conn.execute("SELECT * FROM trials WHERE family=? AND status!='selection' ORDER BY id", (family,))
        names = [d[0] for d in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]


def count_distinct_variants(path, family):
    """Distinct variants of ``family`` read-only; 0 only if the file does not exist. Never writes.

    An existing file that cannot be read (corrupt, no ``trials`` table) raises ``ContractError``: returning 0 would
    undercount attempts.
    """
    if not os.path.isfile(path):
        return 0
    try:
        conn = _readonly(path)
        try:
            return conn.execute("SELECT COUNT(DISTINCT variant_key) FROM trials WHERE family=?",
                                (family,)).fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise ContractError("El registro de intentos existe pero no se puede leer ({}): {}".format(path, exc)) from exc
