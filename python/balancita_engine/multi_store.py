"""Durable decision log of the multi-strategy experiment (PR 100, P0).

Everything that explains an entry, a rejection or a close is written here, keyed by a deterministic id, so the
same event arriving twice stores nothing new and a different payload under an old id is refused. The accounting
itself is not stored: it is a pure function of the candles plus the stored selections (replay), which is what lets
a stored experiment be reproduced bit for bit without asking Qwen again.
"""

import json
import sqlite3
import threading

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS signals(signal_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS selections(decision_id TEXT PRIMARY KEY, arm TEXT NOT NULL, product_id TEXT NOT NULL,
  cycle_ms INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS risk_outcomes(decision_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS candidates(signal_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, cycle_ms INTEGER NOT NULL,
  payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS candidate_outcomes(signal_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS executions(execution_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, digest TEXT NOT NULL,
  info TEXT NOT NULL, blob BLOB NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS trades(trade_id TEXT PRIMARY KEY, arm TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
"""


class ConflictError(Exception):
    """An id was reused with different content."""


class DecisionStore:
    def __init__(self, path=":memory:"):
        # Shared by threads on the Mac's system SQLite, which segfaults on concurrent use: serialise every call.
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        with self.lock:
            self.db.executescript(_SCHEMA)

    def close(self):
        with self.lock:
            self.db.close()

    @staticmethod
    def _dump(payload):
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)

    def _put(self, table, key_column, key, payload, extra=()):
        """Insert once. Returns True when new, False when the identical row existed; raises on a conflict."""
        text = self._dump(payload)
        with self.lock:
            row = self.db.execute("SELECT payload FROM {} WHERE {}=?".format(table, key_column), (key,)).fetchone()
            if row is not None:
                if row[0] != text:
                    raise ConflictError("{} {} already stored with different content".format(table, key))
                return False
            columns = [key_column] + [name for name, _ in extra] + ["payload"]
            values = [key] + [value for _, value in extra] + [text]
            with self.db:
                self.db.execute("INSERT INTO {}({}) VALUES({})".format(
                    table, ",".join(columns), ",".join("?" * len(values))), values)
        return True

    def _get(self, table, key_column, key):
        with self.lock:
            row = self.db.execute("SELECT payload FROM {} WHERE {}=?".format(table, key_column), (key,)).fetchone()
        return None if row is None else json.loads(row[0])

    def _all(self, table, where="", params=()):
        with self.lock:
            rows = self.db.execute("SELECT payload FROM {} {} ORDER BY rowid".format(table, where), params).fetchall()
        return [json.loads(row[0]) for row in rows]

    def put_signal(self, signal):
        return self._put("signals", "signal_id", signal["signal_id"], signal)

    def signals(self):
        return self._all("signals")

    def put_selection(self, selection):
        return self._put("selections", "decision_id", selection["decision_id"], selection, (
            ("arm", selection["arm"]), ("product_id", selection["product_id"]), ("cycle_ms", selection["cycle_ms"])))

    def get_selection(self, decision_id):
        return self._get("selections", "decision_id", decision_id)

    def selections(self, arm=None):
        return self._all("selections", "WHERE arm=?", (arm,)) if arm else self._all("selections")

    def put_risk_outcome(self, decision_id, outcome):
        return self._put("risk_outcomes", "decision_id", decision_id, outcome)

    def get_risk_outcome(self, decision_id):
        return self._get("risk_outcomes", "decision_id", decision_id)

    def risk_outcomes(self):
        with self.lock:
            rows = self.db.execute("SELECT decision_id, payload FROM risk_outcomes ORDER BY rowid").fetchall()
        return {decision_id: json.loads(payload) for decision_id, payload in rows}

    def put_candidate(self, candidate):
        return self._put("candidates", "signal_id", candidate["signal_id"], candidate, (
            ("product_id", candidate["product_id"]), ("cycle_ms", candidate["cycle_ms"])))

    def candidates(self):
        return self._all("candidates")

    def put_candidate_outcome(self, signal_id, outcome):
        return self._put("candidate_outcomes", "signal_id", signal_id, outcome)

    def candidate_outcomes(self):
        with self.lock:
            rows = self.db.execute("SELECT signal_id, payload FROM candidate_outcomes").fetchall()
        return {signal_id: json.loads(payload) for signal_id, payload in rows}

    def has_candidate_outcome(self, signal_id):
        with self.lock:
            return self.db.execute("SELECT 1 FROM candidate_outcomes WHERE signal_id=?", (signal_id,)).fetchone() is not None

    def put_checkpoint(self, key, fingerprint, digest, info, blob):
        """The latest checkpoint of an experiment. Derived data (a cache of replaying the log), so it is replaced."""
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?,?)",
                            (key, fingerprint, digest, self._dump(info), blob))

    def get_checkpoint(self, key):
        with self.lock:
            row = self.db.execute("SELECT fingerprint, digest, info, blob FROM checkpoints WHERE key=?", (key,)).fetchone()
        return None if row is None else {"fingerprint": row[0], "digest": row[1], "info": json.loads(row[2]), "blob": row[3]}

    def delete_checkpoint(self, key):
        with self.lock, self.db:
            self.db.execute("DELETE FROM checkpoints WHERE key=?", (key,))

    def put_execution(self, execution):
        return self._put("executions", "execution_id", execution["execution_id"], execution)

    def executions(self):
        return self._all("executions")

    def put_trade(self, trade):
        return self._put("trades", "trade_id", trade["trade_id"], trade, (("arm", trade["arm"]),))

    def trades(self, arm=None):
        return self._all("trades", "WHERE arm=?", (arm,)) if arm else self._all("trades")

    def set_meta(self, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, self._dump(value)))

    def get_meta(self, key):
        with self.lock:
            row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if row is None else json.loads(row[0])
