"""Strategy registry S: single writer of the strategies DB, plus its local HTTP API.

Every strategy version is a ``balancita-strategy.v1`` spec stored append-only
and identified by its canonical hash, so a replay always finds the exact rules
that were live. Lifecycle states (draft, shadow, active, retired) are
append-only events with ``known_at``. Backtests run over C's verdicts DB,
read-only, and every distinct spec backtested counts as one trial for the
deflated Sharpe gate.

Editing never rewrites a version: "modify" appends version n+1 of the same
strategy, "new" creates another strategy and leaves the original untouched.
While a newer version is not active, the previous active version stays active.

The API binds to 127.0.0.1 only and is the strategies page's backend
(``/api-strategies`` through the Vite proxy in dev).
"""

import argparse
import copy
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import futures_carry
from .futures_products import load_pinned_products
from .futures_spec_strategy import (
    COMPARATORS,
    DEFAULT_SPEC_DIR,
    SPEC_SCHEMA,
    SpecError,
    load_specs,
    propose_spec,
    spec_hash,
    validate_spec,
)
from .futures_replay import load_range
from .futures_forward_result import read_forward
from .futures_strategy_inventory import build_inventory
from .futures_strategy_plan import all_plans, load_freeze
from .futures_strategy_reliability import load_reliability, reliability_for
from .futures_purged import cscv_pbo
from .futures_strategy_gate_api import GateApi, GateApiError
from .analyzer_events_api import read_events as read_analyzer_events
from .futures_strategy_vectorbt_api import VectorbtApi
from . import strategy_purge
from .futures_strategy_lifecycle import Lifecycle, LifecycleError
from .futures_strategy_backtest import MIN_TRADES, load_verdict_rows, run_backtest
from .futures_strategy_translate import TranslationError, default_provider, translate

REGISTRY_SCHEMA = "futures-strategy-registry.v1"
STATES = ("draft", "shadow", "active", "retired")
DAY_MS = 86_400_000
PERIOD_DAYS = (7, 30, 90)
DEFAULT_PORT = 8790
CLOSED_PATH = os.path.join(os.path.dirname(DEFAULT_SPEC_DIR), "strategy-closed.json")
# Promotion gates (ADR 0001, Evaluation): out of sample, deflated Sharpe, minimum trade count.
GATE_MIN_OOS_TRADES = MIN_TRADES
GATE_MIN_DSR = 0.95
# Purged blocks (futures_purged): the mean must be positive in most of the blocks that have trades.
GATE_MIN_FOLDS = 3
GATE_FOLDS_SHARE = 0.6
FEATURE_CATALOG = (
    "candidate_close", "candidate_low", "candidate_high", "candidate_volume", "ema9", "ema21", "sma50",
    "rsi14", "atr14", "bollinger_lower20", "bollinger_mid20", "bollinger_upper20", "bollinger_stddev20",
    "donchian_high20", "donchian_low20", "donchian_mid20", "prior_volume_mean20",
)
_SLUG = re.compile(r"[^a-z0-9]+")


def rules_hash(spec):
    """What a strategy does, without its name or numbering: two specs with equal rules hashes trade alike."""
    return spec_hash({k: v for k, v in spec.items() if k not in ("id", "version", "name", "description")})


class RegistryError(ValueError):
    """A request the registry refuses; ``code`` is stable, ``detail`` is for people."""

    def __init__(self, code, detail, status=400, extra=None):
        super().__init__(detail)
        self.code, self.detail, self.status, self.extra = code, detail, status, extra or {}


def _now_ms():
    return int(time.time() * 1000)


def _slug(text):
    return _SLUG.sub("-", str(text).lower()).strip("-")[:48] or "x"


class _LockedDb:
    """One SQLite connection shared by the HTTP threads, every call serialised.

    The system SQLite of macOS segfaults when two threads touch one connection at once (a product
    switch fires ranking, backtests and reads together), so reads are materialised under the lock.
    """

    def __init__(self, path):
        self.lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False)

    def execute(self, sql, params=()):
        with self.lock:
            return iter_rows(self._db.execute(sql, params))

    def executescript(self, script):
        with self.lock:
            return self._db.executescript(script)

    def close(self):
        with self.lock:
            self._db.close()

    def __enter__(self):
        self.lock.acquire()
        self._db.__enter__()
        return self

    def __exit__(self, *exc):
        try:
            return self._db.__exit__(*exc)
        finally:
            self.lock.release()


class iter_rows(list):
    """Rows already fetched, with the cursor's ``fetchone``/``fetchall``."""

    def __init__(self, cursor):
        super().__init__(cursor.fetchall())
        self._at = 0

    def fetchone(self):
        if self._at >= len(self):
            return None
        self._at += 1
        return self[self._at - 1]

    def fetchall(self):
        rest, self._at = self[self._at:], len(self)
        return rest


class StrategyRegistry:
    def __init__(self, path, *, clock=_now_ms):
        self.clock = clock
        self.path = path
        self.db = _LockedDb(path)
        self.lock = self.db.lock
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS strategy_registry_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS strategy_versions(
              strategy_id TEXT NOT NULL, version INTEGER NOT NULL, spec_hash TEXT NOT NULL UNIQUE,
              spec_json TEXT NOT NULL, origin TEXT NOT NULL, parent_id TEXT, parent_version INTEGER,
              created_at INTEGER NOT NULL, PRIMARY KEY(strategy_id, version)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS strategy_events(
              seq INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
              state TEXT NOT NULL, reason TEXT NOT NULL, known_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS strategy_backtests(
              seq INTEGER PRIMARY KEY, spec_hash TEXT NOT NULL, strategy_id TEXT NOT NULL, version INTEGER,
              product_id TEXT NOT NULL, first_bucket INTEGER, last_bucket INTEGER, created_at INTEGER NOT NULL,
              oos_sharpe REAL, summary_json TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS strategy_backtests_by_hash ON strategy_backtests(spec_hash, product_id, seq);
            CREATE TABLE IF NOT EXISTS strategy_titles(
              strategy_id TEXT PRIMARY KEY, title TEXT NOT NULL, set_at INTEGER NOT NULL
            ) STRICT;
            """
        )
        self._guard_triggers()
        for table in ("strategy_registry_meta",):
            self.db.executescript(
                "CREATE TRIGGER IF NOT EXISTS {0}_no_update BEFORE UPDATE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;"
                "CREATE TRIGGER IF NOT EXISTS {0}_no_delete BEFORE DELETE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;".format(table))
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO strategy_registry_meta VALUES('schema', ?)", (REGISTRY_SCHEMA,))

    # --- seeding and reads ------------------------------------------------

    def seed(self, specs):
        """Records shipped specs as DRAFT v1 the first time they are seen.

        Owner decision (2026-10-19): nothing runs in the real paper unless the user activates it. A shipped spec
        is therefore never expected from ``config/forward-strategies.json`` either; only the registry state counts.
        """
        with self.lock, self.db:
            for spec in specs.values():
                if self._version_row(spec["id"], None) is not None:
                    continue
                self._insert_version(spec, "builtin", None, None)
                self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                "VALUES(?,?,?,?,?)", (spec["id"], spec["version"], "draft", "builtin", self.clock()))

    ALL_DRAFT_KEY = "all_draft_v1"
    ALL_DRAFT_REASON = "todas a borrador por decisión del usuario"

    def migrate_all_to_draft(self):
        """One time, idempotent: every live version (active, shadow or retired) becomes draft, as a new event.

        Event-sourced like every state change: nothing is rewritten. A marker in the registry meta table makes the
        migration run once; what the user activates afterwards stays active across restarts. Deleted strategies
        are left alone. Returns the number of versions moved (0 when already done).
        """
        with self.lock, self.db:
            if self.db.execute("SELECT 1 FROM strategy_registry_meta WHERE key=?", (self.ALL_DRAFT_KEY,)).fetchone():
                return 0
            now, moved = self.clock(), 0
            for (strategy_id,) in self.db.execute("SELECT DISTINCT strategy_id FROM strategy_versions").fetchall():
                if self._deleted(strategy_id):
                    continue
                for (version,) in self.db.execute(
                        "SELECT version FROM strategy_versions WHERE strategy_id=? ORDER BY version",
                        (strategy_id,)).fetchall():
                    if self._state(strategy_id, version)["state"] in ("active", "shadow", "retired"):
                        self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                        "VALUES(?,?,?,?,?)", (strategy_id, version, "draft", self.ALL_DRAFT_REASON, now))
                        moved += 1
            self.db.execute("INSERT INTO strategy_registry_meta VALUES(?,?)", (self.ALL_DRAFT_KEY, str(now)))
            return moved

    def apply_closed(self, path=None):
        """Deletes the strategies ``config/strategy-closed.json`` lists (once; later starts find them deleted)."""
        with open(path or CLOSED_PATH, encoding="utf-8") as handle:
            closed = json.load(handle)
        retired = closed.get("retired") or {}
        for strategy_id in closed["ids"]:
            if self._version_row(strategy_id, None) is not None and not self._deleted(strategy_id):
                reason = (retired.get(strategy_id) or {}).get("reason") or closed.get("reason", "closed")
                self.delete(strategy_id, strategy_id, reason=reason)

    def _version_row(self, strategy_id, version):
        sql = ("SELECT strategy_id, version, spec_hash, spec_json, origin, parent_id, parent_version, created_at "
               "FROM strategy_versions WHERE strategy_id=? ")
        if version is None:
            row = self.db.execute(sql + "ORDER BY version DESC LIMIT 1", (strategy_id,)).fetchone()
        else:
            row = self.db.execute(sql + "AND version=?", (strategy_id, int(version))).fetchone()
        if row is None:
            return None
        return {"strategy_id": row[0], "version": row[1], "spec_hash": row[2], "spec": json.loads(row[3]),
                "origin": row[4], "parent_id": row[5], "parent_version": row[6], "created_at": row[7]}

    def version(self, strategy_id, version=None):
        row = self._version_row(strategy_id, version)
        if row is None:
            raise RegistryError("not_found", "unknown strategy {} v{}".format(strategy_id, version), 404)
        return row

    def _state(self, strategy_id, version):
        row = self.db.execute("SELECT state, reason, known_at FROM strategy_events WHERE strategy_id=? AND version=? "
                              "ORDER BY seq DESC LIMIT 1", (strategy_id, version)).fetchone()
        return {"state": "draft", "reason": "created", "known_at": None} if row is None else {
            "state": row[0], "reason": row[1], "known_at": row[2]}

    def _active_version(self, strategy_id):
        for (version,) in self.db.execute(
                "SELECT version FROM strategy_versions WHERE strategy_id=? ORDER BY version DESC", (strategy_id,)):
            if self._state(strategy_id, version)["state"] == "active":
                return version
        return None

    def _entry(self, row):
        spec = row["spec"]
        state = self._state(row["strategy_id"], row["version"])
        return {
            "id": row["strategy_id"], "version": row["version"], "spec_hash": row["spec_hash"],
            "name": self._title(row["strategy_id"], spec), "description": spec.get("description", ""),
            "kind": spec.get("kind", "rules"),
            "state": state["state"], "state_reason": state["reason"], "state_known_at": state["known_at"],
            "active_version": self._active_version(row["strategy_id"]), "origin": row["origin"],
            "parent": None if row["parent_id"] is None else {"id": row["parent_id"], "version": row["parent_version"]},
            "created_at": row["created_at"],
            "reliability": self._reliability(spec),
            "frozen": row["strategy_id"] in load_freeze()["ids"],
        }

    def _title(self, strategy_id, spec):
        """The name the owner gave last: a rename is not a new version, so it lives apart from the frozen specs."""
        row = self.db.execute("SELECT title FROM strategy_titles WHERE strategy_id=?", (strategy_id,)).fetchone()
        return spec["name"] if row is None else row[0]

    def rename(self, strategy_id, title):
        """Changes only the displayed title: versions, tests and exam stay exactly as they are."""
        title = " ".join(str(title or "").split())
        if not title or len(title) > 120:
            raise RegistryError("invalid_title", "El título no puede estar vacío ni pasar de 120 caracteres.")
        with self.lock, self.db:
            row = self._version_row(strategy_id, None)
            if row is None or self._deleted(strategy_id):
                raise RegistryError("not_found", "No existe la estrategia indicada.", 404)
            self.db.execute("INSERT INTO strategy_titles(strategy_id, title, set_at) VALUES(?,?,?) "
                            "ON CONFLICT(strategy_id) DO UPDATE SET title=excluded.title, set_at=excluded.set_at",
                            (strategy_id, title, self.clock()))
            return self._entry(row)

    @staticmethod
    def _reliability(spec):
        """What the stored reliability table says about exactly this spec, else ``None`` (never measured)."""
        entry = reliability_for(load_reliability(), spec)
        if entry is None:
            return None
        return {key: entry.get(key) for key in ("verdict", "trades", "hit_rate", "mean_net_bp", "t_stat")}

    def list(self):
        ids = [r[0] for r in self.db.execute(
            "SELECT strategy_id FROM strategy_versions GROUP BY strategy_id ORDER BY MIN(created_at), strategy_id")]
        return [self._entry(self._version_row(strategy_id, None)) for strategy_id in ids
                if not self._deleted(strategy_id)]

    def _deleted(self, strategy_id):
        row = self._version_row(strategy_id, None)
        return row is not None and self._state(strategy_id, row["version"])["state"] == "deleted"

    def detail(self, strategy_id, version=None):
        row = self.version(strategy_id, version)
        versions = [self._entry(self._version_row(strategy_id, v)) for (v,) in self.db.execute(
            "SELECT version FROM strategy_versions WHERE strategy_id=? ORDER BY version", (strategy_id,))]
        events = [{"version": r[0], "state": r[1], "reason": r[2], "known_at": r[3]} for r in self.db.execute(
            "SELECT version, state, reason, known_at FROM strategy_events WHERE strategy_id=? ORDER BY seq",
            (strategy_id,))]
        return dict(self._entry(row), spec=row["spec"], versions=versions, events=events)

    def plans(self):
        """The same plan for every strategy: latest version of each spec, plus C31 and Kronos."""
        specs = {entry["id"]: self.version(entry["id"], entry["version"])["spec"] for entry in self.list()}
        return all_plans(specs)

    def replayable_specs(self):
        """Latest spec of every strategy that is not deleted: a replay is history, not paper, so drafts count."""
        return {entry["id"]: self.version(entry["id"], entry["version"])["spec"] for entry in self.list()}

    def active_specs(self, as_of_ms):
        """Active spec per strategy as of ``as_of_ms`` (for C, PS-08c)."""
        result = {}
        for strategy_id, version, state in self.db.execute(
                "SELECT strategy_id, version, state FROM strategy_events WHERE known_at<=? ORDER BY seq",
                (int(as_of_ms),)):
            if state == "active":
                result[strategy_id] = version
            elif result.get(strategy_id) == version:
                result.pop(strategy_id)
        return {sid: self.version(sid, version)["spec"] for sid, version in result.items()}

    # --- writes -----------------------------------------------------------

    def _insert_version(self, spec, origin, parent_id, parent_version):
        digest = spec_hash(spec)
        rules = rules_hash(spec)
        for strategy_id, version, stored in self.db.execute(
                "SELECT strategy_id, version, spec_json FROM strategy_versions"):
            if rules_hash(json.loads(stored)) == rules and not self._deleted(strategy_id):
                raise RegistryError("duplicate_spec", "same rules and parameters as {} v{}".format(
                    strategy_id, version), 409, {"id": strategy_id, "version": version})
        self.db.execute("INSERT INTO strategy_versions VALUES(?,?,?,?,?,?,?,?)", (
            spec["id"], spec["version"], digest, json.dumps(spec, sort_keys=True, ensure_ascii=False), origin,
            parent_id, parent_version, self.clock()))
        return digest

    def _validated(self, spec):
        try:
            return validate_spec(copy.deepcopy(spec))
        except SpecError as error:
            raise RegistryError("invalid_spec", str(error)) from error

    def save(self, spec, mode, *, origin="editor", new_id=None, new_name=None):
        """``mode`` "modify": version n+1 of ``spec["id"]``; "new": a new strategy (``new_id``)."""
        spec = copy.deepcopy(spec)
        with self.lock, self.db:
            if mode == "modify":
                latest = self._version_row(spec.get("id"), None)
                if latest is None:
                    raise RegistryError("not_found", "nothing to modify: unknown id {}".format(spec.get("id")), 404)
                spec["version"] = latest["version"] + 1
                parent = (latest["strategy_id"], latest["version"])
            elif mode == "new":
                parent_row = self._version_row(spec.get("id"), None) if spec.get("id") else None
                parent = None if parent_row is None else (parent_row["strategy_id"], parent_row["version"])
                spec["id"] = new_id or self._fresh_id(spec.get("name") or spec.get("id") or "estrategia")
                if new_name:
                    spec["name"] = new_name
                if self._version_row(spec["id"], None) is not None:
                    raise RegistryError("id_exists", "strategy id {} already exists".format(spec["id"]), 409)
                spec["version"] = 1
            else:
                raise RegistryError("invalid_mode", "mode must be modify or new")
            spec.setdefault("schema", SPEC_SCHEMA)
            self._validated(spec)
            self._insert_version(spec, origin, *(parent or (None, None)))
            self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                            "VALUES(?,?,?,?,?)", (spec["id"], spec["version"], "draft", origin, self.clock()))
            return self._entry(self._version_row(spec["id"], spec["version"]))

    def _fresh_id(self, name):
        base = "c" + str(29 + self.db.execute(
            "SELECT COUNT(DISTINCT strategy_id) FROM strategy_versions WHERE origin!='builtin'").fetchone()[0])
        candidate = "{}-{}".format(base, _slug(name))[:64]
        suffix = 2
        while self._version_row(candidate, None) is not None:
            candidate = "{}-{}-{}".format(base, _slug(name), suffix)[:64]
            suffix += 1
        return candidate

    def import_spec(self, spec, activate=False):
        """An imported spec always lands as a new strategy; a taken id gets a fresh one.

        It is a draft unless ``activate``: the owner's explicit choice to run it in
        paper at once, without promotion gates (paper only, never real orders).
        """
        spec = self._validated(spec)
        taken = self._version_row(spec["id"], None) is not None
        entry = self.save(spec, "new", origin="import", new_id=None if taken else spec["id"])
        if activate:
            entry = self.set_state(entry["id"], entry["version"], "active", "manual_import", skip_gates=True)
        return entry

    def variants(self, strategy_id, version, param, values, *, origin="variant"):
        """One new draft strategy per value of ``param``, each named after its value."""
        base = self.version(strategy_id, version)
        spec = base["spec"]
        if param not in spec.get("params", {}):
            raise RegistryError("unknown_param", "{} has no parameter {}".format(strategy_id, param))
        if not isinstance(values, list) or not values or len(values) > 20:
            raise RegistryError("invalid_values", "give 1 to 20 values")
        created = []
        for value in values:
            variant = copy.deepcopy(spec)
            variant["params"][param] = str(value).strip().replace(",", ".")
            if variant["params"][param] == spec["params"][param]:
                continue
            variant_id = "{}-{}-{}".format(strategy_id, _slug(param), _slug(variant["params"][param]))[:64]
            created.append(self.save(variant, "new", origin=origin, new_id=variant_id,
                                     new_name="{} · {} {}".format(spec["name"], param, variant["params"][param])))
        return created

    def set_state(self, strategy_id, version, state, reason="manual", skip_gates=False):
        if state not in STATES:
            raise RegistryError("invalid_state", "state must be one of " + ", ".join(STATES))
        with self.lock, self.db:
            row = self.version(strategy_id, version)
            current = self._state(strategy_id, row["version"])["state"]
            gates = [] if skip_gates else self.gates(row, state, current)
            if not all(gate["passed"] for gate in gates):
                raise RegistryError("gate_failed", "the {} gate is not met".format(state), 409, {"gates": gates})
            freeze = load_freeze()
            if state == "active" and row["version"] > 1 and strategy_id in freeze["ids"]:
                raise RegistryError("frozen", "{} no cambia hasta {} operaciones forward: crea una estrategia nueva"
                                    .format(strategy_id, freeze["min_forward_trades"]), 409)
            now = self.clock()
            if state == "active":
                previous = self._active_version(strategy_id)
                if previous is not None and previous != row["version"]:
                    self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                    "VALUES(?,?,?,?,?)", (strategy_id, previous, "retired",
                                                          "replaced_by_v{}".format(row["version"]), now))
            self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                            "VALUES(?,?,?,?,?)", (strategy_id, row["version"], state, reason, now))
            return dict(self._entry(row), gates=gates)

    def delete(self, strategy_id, confirm, reason="manual_delete"):
        """Soft delete (``deleted`` event): hides a strategy and stops it. Only startup uses it (``apply_closed``);
        the front's delete is ``StrategyRegistry.hard_delete`` through ``Lifecycle``. Needs the id typed back."""
        if confirm != strategy_id:
            raise RegistryError("confirmation_required", "escribe el id de la estrategia para borrarla", 409)
        with self.lock, self.db:
            latest = self.version(strategy_id)
            now = self.clock()
            for (version,) in self.db.execute(
                    "SELECT version FROM strategy_versions WHERE strategy_id=?", (strategy_id,)).fetchall():
                self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                "VALUES(?,?,?,?,?)", (strategy_id, version, "deleted", reason, now))
            return {"id": strategy_id, "version": latest["version"], "state": "deleted"}

    def active_ms(self, strategy_id, now_ms=None):
        """Total time any version of ``strategy_id`` spent active in paper (sum of its active periods).

        A period starts at the ``active`` event (a shipped one with ``known_at`` 0 starts when the version was
        created) and ends at the version's next event, or ``now`` while it is still active.
        """
        now = self.clock() if now_ms is None else now_ms
        total = 0
        for (version, created) in self.db.execute(
                "SELECT version, created_at FROM strategy_versions WHERE strategy_id=?", (strategy_id,)).fetchall():
            start = None
            for state, known_at in self.db.execute(
                    "SELECT state, known_at FROM strategy_events WHERE strategy_id=? AND version=? ORDER BY seq",
                    (strategy_id, version)).fetchall():
                if state == "active" and start is None:
                    start = known_at or created
                elif state != "active" and start is not None:
                    total += max(0, known_at - start)
                    start = None
            if start is not None:
                total += max(0, now - start)
        return total

    def lifecycle(self, strategy_id):
        """What the delete dialog shows about the registry side of a strategy (raises not_found when deleted)."""
        if strategy_id is None or self._version_row(strategy_id, None) is None or self._deleted(strategy_id):
            raise RegistryError("not_found", "No existe la estrategia indicada.", 404)
        latest = self._version_row(strategy_id, None)
        versions = [{"version": v, "state": self._state(strategy_id, v)["state"], "spec_hash": h,
                     "created_at": c} for v, h, c in self.db.execute(
            "SELECT version, spec_hash, created_at FROM strategy_versions WHERE strategy_id=? ORDER BY version",
            (strategy_id,)).fetchall()]
        return {"id": strategy_id, "name": self._title(strategy_id, latest["spec"]) or strategy_id, "state": versions[-1]["state"],
                "active_version": self._active_version(strategy_id), "versions": versions,
                "created_at": min(v["created_at"] for v in versions), "origin": latest["origin"],
                "builtin": latest["origin"] == "builtin", "active_ms": self.active_ms(strategy_id)}

    _GUARDED = ("strategy_versions", "strategy_events", "strategy_backtests")

    def _guard_triggers(self):
        for table in self._GUARDED:
            self.db.executescript(
                "CREATE TRIGGER IF NOT EXISTS {0}_no_update BEFORE UPDATE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;"
                "CREATE TRIGGER IF NOT EXISTS {0}_no_delete BEFORE DELETE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;".format(table))

    def hard_delete(self, strategy_id):
        """Removes every row of the strategy (versions, events, backtests): the owner's clean delete.

        The append-only guard of the registry tables is lifted for this one transaction only and put back
        afterwards, whatever happens. Returns the rows deleted per table.
        """
        with self.lock:
            hashes = [h for (h,) in self.db.execute(
                "SELECT spec_hash FROM strategy_versions WHERE strategy_id=?", (strategy_id,)).fetchall()]
            counts, raw = {}, self.db._db
            try:
                raw.execute("BEGIN IMMEDIATE")
                for table in self._GUARDED:
                    raw.execute("DROP TRIGGER IF EXISTS {}_no_delete".format(table))
                counts["strategy_events"] = raw.execute(
                    "DELETE FROM strategy_events WHERE strategy_id=?", (strategy_id,)).rowcount
                counts["strategy_backtests"] = raw.execute(
                    "DELETE FROM strategy_backtests WHERE strategy_id=?", (strategy_id,)).rowcount
                for digest in hashes:
                    counts["strategy_backtests"] += raw.execute(
                        "DELETE FROM strategy_backtests WHERE spec_hash=?", (digest,)).rowcount
                counts["strategy_versions"] = raw.execute(
                    "DELETE FROM strategy_versions WHERE strategy_id=?", (strategy_id,)).rowcount
                counts["strategy_titles"] = raw.execute(
                    "DELETE FROM strategy_titles WHERE strategy_id=?", (strategy_id,)).rowcount
                raw.execute("COMMIT")
            except BaseException:
                try:
                    raw.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            finally:
                self._guard_triggers()
            return counts

    def gates(self, row, state, current):
        """The checks a transition to ``state`` must pass (PS-08e)."""
        if state in ("retired", "draft") or (state == "shadow" and current == "active"):
            return []
        backtest = self.longest_backtest(row["spec_hash"])
        if state == "shadow":
            return [{"code": "backtested", "passed": backtest is not None, "value": backtest is not None,
                     "threshold": True}]
        oos = (backtest or {}).get("out_of_sample", {})
        dsr = (backtest or {}).get("deflated_sharpe_probability")
        folds = (backtest or {}).get("purged_folds") or {}
        judged, positive = folds.get("judged", 0), folds.get("positive", 0)
        late = ((backtest or {}).get("stress") or {}).get("late_entry_mean_net_bp")
        return [
            {"code": "was_in_shadow", "passed": current == "shadow", "value": current, "threshold": "shadow"},
            {"code": "oos_trades", "passed": oos.get("trades", 0) >= GATE_MIN_OOS_TRADES,
             "value": oos.get("trades", 0), "threshold": GATE_MIN_OOS_TRADES},
            {"code": "oos_mean_net_bp_positive", "passed": (oos.get("mean_net_bp") or 0) > 0,
             "value": oos.get("mean_net_bp"), "threshold": 0},
            {"code": "deflated_sharpe", "passed": dsr is not None and dsr >= GATE_MIN_DSR,
             "value": dsr, "threshold": GATE_MIN_DSR},
            {"code": "purged_folds_positive", "passed": judged >= GATE_MIN_FOLDS
             and positive >= math.ceil(judged * GATE_FOLDS_SHARE),
             "value": "{}/{}".format(positive, judged), "threshold": ">= {:.0%} of at least {} blocks".format(
                 GATE_FOLDS_SHARE, GATE_MIN_FOLDS)},
            {"code": "survives_late_entry", "passed": late is not None and late > 0, "value": late, "threshold": 0},
        ]

    # --- backtests ----------------------------------------------------------

    def trial_sharpes(self, product_id, exclude_hash):
        rows = self.db.execute(
            "SELECT spec_hash, oos_sharpe FROM strategy_backtests WHERE product_id=? AND spec_hash!=? ORDER BY seq",
            (product_id, exclude_hash))
        latest = {}
        for digest, sharpe in rows:
            latest[digest] = sharpe
        return list(latest.values())

    def latest_backtest(self, digest, product_id=None):
        sql = "SELECT summary_json FROM strategy_backtests WHERE spec_hash=?"
        params = [digest]
        if product_id is not None:
            sql += " AND product_id=?"
            params.append(product_id)
        row = self.db.execute(sql + " ORDER BY seq DESC LIMIT 1", params).fetchone()
        return None if row is None else json.loads(row[0])

    def longest_backtest(self, digest):
        """The backtest of the longest window: choosing the most flattering of 7, 30 and 90 days is not allowed."""
        rows = self.db.execute("SELECT summary_json FROM strategy_backtests WHERE spec_hash=? ORDER BY seq",
                               (digest,)).fetchall()
        summaries = [json.loads(row[0]) for row in rows]
        return max(reversed(summaries), key=lambda b: b.get("days") or 0, default=None) if summaries else None

    def record_backtest(self, digest, strategy_id, version, product_id, result):
        summary = {k: v for k, v in result.items() if k != "trades"}
        period = result["period"]
        with self.lock, self.db:
            if self.db.execute(
                    "SELECT 1 FROM strategy_backtests WHERE spec_hash=? AND product_id=? AND first_bucket IS ? "
                    "AND last_bucket IS ?", (digest, product_id, period["first_bucket_ms"],
                                             period["last_bucket_ms"])).fetchone():
                return
            self.db.execute(
                "INSERT INTO strategy_backtests(spec_hash, strategy_id, version, product_id, first_bucket, "
                "last_bucket, created_at, oos_sharpe, summary_json) VALUES(?,?,?,?,?,?,?,?,?)",
                (digest, strategy_id, version, product_id, result["period"]["first_bucket_ms"],
                 result["period"]["last_bucket_ms"], self.clock(), result["oos_sharpe_per_trade"],
                 json.dumps(summary, sort_keys=True)))

    def close(self):
        self.db.close()


class StrategyService:
    """What the API does: registry plus read-only verdicts, per product and period."""

    def __init__(self, registry, verdicts_db_path, products, provider_factory=None, replays=None,
                 market_db_path=None, config_dir=None, forward_db_path=None, forward_summary_path=None,
                 decisions_db_path=None, gate_data_dir=None, purge_dir=None, specs_dir=None,
                 forward_registration_path=None, freeze_path=None, qwen_exit_config=None, qwen_practice_dir=None,
                 kronos_dir=None, qwen_exit_dir=None, account_db_path=None, vectorbt_dir=None, vectorbt_python=None,
                 vectorbt_spawn=None):
        self.config_dir = config_dir
        self.forward_db_path = forward_db_path
        self.forward_summary_path = forward_summary_path or os.environ.get("STRATEGY_FORWARD_PATH")
        self.decisions_db_path = decisions_db_path
        self.registry = registry
        self.market_db_path = market_db_path
        self.replays = replays
        self.provider_factory = provider_factory or (lambda: default_provider(os.environ))
        self.verdicts_db_path = verdicts_db_path
        self.products = products
        self._cache = {}
        self._results = {}
        self.gate = GateApi(registry, data_dir=gate_data_dir, kronos_dir=kronos_dir, qwen_exit_dir=qwen_exit_dir)
        self.vectorbt = VectorbtApi(registry, self.gate, data_dir=vectorbt_dir, python=vectorbt_python,
                                    spawn=vectorbt_spawn)
        self.gate.busy_hook = self.vectorbt.busy_message
        self.lifecycle = Lifecycle(registry, self.gate, forward_db_path=forward_db_path, purge_dir=purge_dir,
                                   consumers=("forward",) if forward_db_path else (),
                                   specs_dir=specs_dir, forward_registration_path=forward_registration_path,
                                   freeze_path=freeze_path, qwen_exit_config=qwen_exit_config, replays=replays,
                                   qwen_practice_dir=qwen_practice_dir, account_db_path=account_db_path)

    def _tick(self, product_id):
        if product_id not in self.products:
            raise RegistryError("unknown_product", "unknown product " + str(product_id))
        return self.products[product_id]

    def _candles(self, product_id, days):
        """``(start_ms, candles_1m, candles_5m)`` of the last ``days`` days from the market DB (read-only).

        The error code stays ``verdicts_unavailable``: the front already maps it to "no data yet".
        """
        if days not in PERIOD_DAYS:
            raise RegistryError("invalid_period", "days must be one of 7, 30, 90")
        if not self.market_db_path or not os.path.exists(self.market_db_path):
            raise RegistryError("verdicts_unavailable", "no market DB yet", 503)
        db = sqlite3.connect("file:{}?mode=ro".format(self.market_db_path), uri=True)
        try:
            last = db.execute(
                "SELECT MAX(bucket_start) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=?",
                (product_id, 60_000)).fetchone()[0]
        except sqlite3.OperationalError as error:
            raise RegistryError("verdicts_unavailable", str(error), 503) from error
        finally:
            db.close()
        if last is None:
            return None, [], []
        start = last + 60_000 - days * DAY_MS
        key = (product_id, start, last)
        if key not in self._cache:
            try:
                ones, fives = load_range(self.market_db_path, product_id, start, last + 60_000)
            except (ValueError, sqlite3.Error) as error:
                raise RegistryError("verdicts_unavailable", str(error), 503) from error
            self._cache = {key: (start, ones, fives)}
        return self._cache[key]

    def backtest(self, spec, product_id, days, *, strategy_id=None, version=None, record=True):
        tick = self._tick(product_id)
        start, ones, fives = self._candles(product_id, days)
        digest = spec_hash(spec)
        inside = [c["bucket_start"] for c in ones if start is None or c["bucket_start"] >= start]
        key = (digest, product_id, days, inside[0] if inside else None, inside[-1] if inside else None)
        if key in self._results:
            return self._results[key]
        result = run_backtest(spec, ones, fives, start_ms=start, product_id=product_id, tick_size=tick,
                              trial_sharpes=self.registry.trial_sharpes(product_id, digest))
        result.update(spec_hash=digest, product_id=product_id, days=days)
        if record and inside:
            self.registry.record_backtest(digest, strategy_id or spec["id"], version, product_id, result)
        if len(self._results) > 500:
            self._results.clear()
        self._results[key] = result
        return result

    def ranking(self, product_id, days):
        rows = []
        buy_and_hold = None
        try:
            self._candles(product_id, days)
        except RegistryError as error:
            if error.code != "verdicts_unavailable":
                raise
            return {"product_id": product_id, "days": days, "buy_and_hold_pct": None, "min_trades": MIN_TRADES,
                    "verdicts_available": False, "detail": error.detail,
                    "strategies": [dict(e, return_pct=None, pnl_usd=None, hit_rate=None, trades=0, wins=0,
                                        few_trades=True, deflated_sharpe_probability=None)
                                   for e in self.registry.list()]}
        tried, period = {}, None
        for entry in self.registry.list():
            row = self.registry.version(entry["id"], entry["version"])
            result = self.backtest(row["spec"], product_id, days, strategy_id=entry["id"],
                                   version=entry["version"])
            tried[entry["id"]], period = result["trades"], result["period"]
            buy_and_hold = result["buy_and_hold_pct"]
            total = result["all"]
            rows.append(dict(entry, return_pct=total["return_pct"], pnl_usd=total["pnl_usd"],
                             hit_rate=total["hit_rate"], trades=total["trades"], wins=total["wins"],
                             few_trades=total["trades"] < MIN_TRADES,
                             deflated_sharpe_probability=result["deflated_sharpe_probability"]))
        rows.sort(key=lambda r: (-(r["return_pct"] or 0), r["id"]))
        overfitting = period and cscv_pbo(tried, period["first_bucket_ms"], period["last_bucket_ms"])
        return {"product_id": product_id, "days": days, "buy_and_hold_pct": buy_and_hold,
                "min_trades": MIN_TRADES, "verdicts_available": True, "overfitting": overfitting,
                "strategies": rows}

    def inventory(self):
        """Operational and research state of every strategy; reads only, writes nothing (docs/strategy-inventory-api.md)."""
        entries = self.registry.list()
        specs = {e["id"]: self.registry.version(e["id"], e["version"])["spec"] for e in entries}
        try:
            carry = futures_carry.read_summary(*_carry_paths())
        except (OSError, ValueError, KeyError):
            carry = None
        forward = None
        if self.forward_db_path or self.forward_summary_path or self.decisions_db_path:
            forward = read_forward(self.forward_db_path, self.forward_summary_path, self.market_db_path,
                                   self.decisions_db_path, now_ms=_now_ms())
        return build_inventory(entries, specs, config_dir=self.config_dir, carry=carry, forward_result=forward)

    def forward(self):
        """How the forward is going per strategy, the funding per product and Q's skips (docs/forward-result-api.md)."""
        inventory = self.inventory()
        health = inventory["forward_health"] or {}
        return dict(health, schema="futures-forward-result.v1", min_trades=inventory["forward_min_trades"],
                    strategies=[{"id": r["id"], "name": r["name"], "kind": r["kind"],
                                 "spec_hash": r["spec_hash"], "operational": r["operational"],
                                 "forward": r["forward"]} for r in inventory["strategies"]])

    def translate(self, text, source):
        """A draft spec from Pine Script or freqtrade text; nothing is saved (PS-08f)."""
        example = self.registry.version("c27-breakout-perp-v1")["spec"]
        operands = [o["ref"] for o in schema_description()["operands"]]
        try:
            return translate(text, source, provider=self.provider_factory(), example_spec=example,
                             operands=operands)
        except TranslationError as error:
            raise RegistryError(error.code, error.detail,
                                503 if error.code in ("model_unavailable", "model_error") else 400) from error

    def evaluate_latest(self, spec, product_id):
        """The spec's proposal on the newest verdict: which conditions hold on the last candle."""
        tick = self._tick(product_id)
        rows = load_verdict_rows(self.verdicts_db_path, product_id, limit=1) if self.verdicts_db_path else []
        if not rows:
            raise RegistryError("verdicts_unavailable", "no verdicts for " + product_id, 503)
        verdict = rows[-1]
        features = verdict.get("features") or {}
        proposal = propose_spec(spec, features.get("1m"), previous=features.get("1m_previous"),
                                trend=features.get("5m"), regime=verdict.get("regime", "unknown"), tick_size=tick)
        return {"bucket_start_ms": verdict["bucket_start_ms"], "regime": verdict.get("regime"),
                "proposal": proposal}


def schema_description():
    """What the editor offers: operands, comparators and node kinds of balancita-strategy.v1."""
    scopes = {"1m": "vela actual de 1 m", "1m_previous": "vela previa de 1 m", "5m": "tendencia de 5 m"}
    return {
        "schema": SPEC_SCHEMA,
        "comparators": list(COMPARATORS),
        "operands": [{"ref": "{}.{}".format(scope, field), "scope": scope, "field": field, "label": label}
                     for scope, label in scopes.items() for field in FEATURE_CATALOG],
        "position_operands": ["position.frozen_target", "position.frozen_invalidation"],
        "regimes": ["unknown", "trend", "range"],
        "nodes": ["cmp", "available", "regime_in", "not", "and", "all", "any"],
        "states": list(STATES),
        "periods_days": list(PERIOD_DAYS),
        "gates": {"min_oos_trades": GATE_MIN_OOS_TRADES, "min_deflated_sharpe": GATE_MIN_DSR},
    }


def forward_candidates(db_path):
    """Every strategy of the registry for the forward runner, read-only.

    ``{id: {spec, version, state, active_since_ms}}`` for the version that is active, else the newest one with
    its own state. ``active_since_ms`` is when that activation began (0 for the shipped ones, which nobody
    switched on). ``None`` when there is no registry to read.
    """
    if not db_path or not os.path.exists(db_path):
        return None
    db = sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)
    try:
        latest = {}
        for strategy_id, version, state, known_at in db.execute(
                "SELECT strategy_id, version, state, known_at FROM strategy_events ORDER BY seq"):
            latest[(strategy_id, version)] = (state, known_at)
        chosen = {}
        for (strategy_id, version), (state, known_at) in sorted(latest.items(), key=lambda kv: kv[0][1]):
            if state == "active" or (strategy_id not in chosen or chosen[strategy_id][1] != "active"):
                chosen[strategy_id] = (version, state, known_at)
        out = {}
        for strategy_id, (version, state, known_at) in chosen.items():
            row = db.execute("SELECT spec_json FROM strategy_versions WHERE strategy_id=? AND version=?",
                             (strategy_id, version)).fetchone()
            if row is not None:
                out[strategy_id] = {"spec": json.loads(row[0]), "version": version, "state": state,
                                    "active_since_ms": known_at}
        return out
    except sqlite3.Error:
        return None
    finally:
        db.close()


def _carry_paths():
    """(summary, state) of the funding carry counter; the dev supervisor sets both."""
    base = os.environ.get("CARRY_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "server", "data", "carry")
    return os.path.join(base, "carry-summary.json"), os.path.join(base, "carry-state.json")


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "BalancitaStrategies/1"

        def log_message(self, fmt, *args):  # quiet by default
            pass

        def _send(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise RegistryError("too_large", "request body over 1 MB", 413)
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError as error:
                raise RegistryError("invalid_json", str(error)) from error

        def _dispatch(self, method):
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            if parts[:1] == ["api-strategies"]:
                parts = parts[1:]
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            product = query.get("product", "PF_XBTUSD")
            days = int(query.get("days", "30"))
            registry = service.registry
            if method == "GET" and parts == ["health"]:
                return {"status": "ok", "schema": REGISTRY_SCHEMA}
            if method == "GET" and parts == ["schema"]:
                return schema_description()
            if method == "GET" and parts == ["strategies"]:
                return {"strategies": registry.list()}
            if method == "GET" and parts == ["carry"]:
                return futures_carry.read_summary(*_carry_paths())
            if method == "GET" and parts == ["forward"]:
                return service.forward()
            if method == "GET" and parts == ["inventory"]:
                return service.inventory()
            if method == "GET" and parts == ["plans"]:
                return {"plans": registry.plans()}
            if method == "GET" and parts[:1] == ["replays"]:
                if service.replays is None:
                    raise RegistryError("replays_unavailable", "no market DB configured", 503)
                if len(parts) == 1:
                    return {"replays": service.replays.list()}
                try:
                    if len(parts) == 3 and parts[2] == "candles":
                        return service.replays.candles(parts[1])
                    return service.replays.detail(parts[1])
                except KeyError as error:
                    raise RegistryError("not_found", str(error), 404) from error
            if method == "GET" and parts == ["ranking"]:
                return service.ranking(product, days)
            if method == "GET" and parts == ["purges"]:
                return {"purges": service.lifecycle.purges()}
            if method == "GET" and len(parts) == 2 and parts[0] == "purges":
                return service.lifecycle.purge_status(parts[1])
            if method == "GET" and len(parts) == 3 and parts[0] == "strategies" and parts[2] == "delete-preview":
                return service.lifecycle.preview(parts[1])
            if method == "GET" and len(parts) == 2 and parts[0] == "strategies":
                return registry.detail(parts[1], query.get("version"))
            if method == "GET" and len(parts) == 3 and parts[0] == "strategies" and parts[2] == "export":
                return registry.version(parts[1], query.get("version"))["spec"]
            if method != "POST":
                raise RegistryError("not_found", "no route", 404)
            body = self._body()
            if parts == ["carry", "enabled"]:
                if not isinstance(body.get("enabled"), bool):
                    raise RegistryError("invalid_carry", "enabled must be true or false")
                out_path, state_path = _carry_paths()
                futures_carry.set_enabled(state_path, body["enabled"], int(time.time() * 1000))
                return futures_carry.read_summary(out_path, state_path)
            if parts == ["validate"]:
                spec = body.get("spec", body)
                try:
                    validate_spec(spec)
                except SpecError as error:
                    return {"valid": False, "error": str(error)}
                return {"valid": True, "spec_hash": spec_hash(spec)}
            if parts == ["strategies"]:
                return registry.save(body.get("spec") or {}, body.get("mode"), new_id=body.get("new_id"),
                                     new_name=body.get("new_name"))
            if parts == ["replays"]:
                if service.replays is None:
                    raise RegistryError("replays_unavailable", "no market DB configured", 503)
                try:
                    return service.replays.start(body.get("product", product), body.get("from"), body.get("to"),
                                                 body.get("qwen"))
                except (ValueError, TypeError) as error:
                    raise RegistryError("invalid_replay", str(error)) from error
            if parts == ["translate"]:
                return service.translate(body.get("text"), body.get("source", "auto"))
            if parts == ["import"]:
                return registry.import_spec(body.get("spec", body), activate=bool(body.get("activate")))
            if parts == ["evaluate"]:
                spec = body.get("spec") or registry.version(body.get("id"), body.get("version"))["spec"]
                return service.evaluate_latest(registry._validated(spec), body.get("product", product))
            if parts == ["backtest"]:
                if body.get("spec") is not None:
                    spec = registry._validated(body["spec"])
                    strategy_id, version = spec["id"], None
                else:
                    row = registry.version(body.get("id"), body.get("version"))
                    spec, strategy_id, version = row["spec"], row["strategy_id"], row["version"]
                return service.backtest(spec, body.get("product", product), int(body.get("days", days)),
                                        strategy_id=strategy_id, version=version)
            if len(parts) == 3 and parts[0] == "strategies" and parts[2] == "variants":
                return {"created": registry.variants(parts[1], body.get("version"), body.get("param"),
                                                     body.get("values"))}
            if len(parts) == 3 and parts[0] == "strategies" and parts[2] == "state":
                return registry.set_state(parts[1], body.get("version"), body.get("state"),
                                          body.get("reason") or "manual", skip_gates=bool(body.get("paper_now")))
            if len(parts) == 3 and parts[0] == "strategies" and parts[2] == "rename":
                return registry.rename(parts[1], body.get("title"))
            if len(parts) == 3 and parts[0] == "strategies" and parts[2] == "delete":
                return service.lifecycle.delete(parts[1], body.get("confirm"))
            raise RegistryError("not_found", "no route", 404)

        def _gate(self, method):
            """Strategy gate routes; ``None`` when the path is not one of them, ``True`` once it answered itself."""
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            if parts[:1] == ["api-strategies"]:
                parts = parts[1:]
            gate = service.gate
            if method == "GET" and len(parts) == 4 and parts[0] == "gate" and parts[1] == "runs" and parts[3] == "report.md":
                name, data = gate.report(parts[2])
                self.send_response(200)
                self.send_header("Content-Type", "text/markdown; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="{}"'.format(name))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return True
            if method == "GET" and len(parts) == 4 and parts[:2] == ["gate", "runs"] and parts[3] in (
                    "visual-summary", "candles", "trades", "decisions"):
                query = {k: v[-1] for k, v in parse_qs(url.query).items()}
                if parts[3] == "visual-summary":
                    return gate.visual_summary(parts[2])
                if parts[3] == "candles":
                    return gate.candles(parts[2], query.get("product"), query.get("from"), query.get("to"),
                                        query.get("resolution"))
                if parts[3] == "decisions":
                    return gate.decisions(parts[2], query.get("product"), query.get("from"), query.get("to"),
                                          query.get("only"))
                return gate.trades(parts[2], query.get("product"), query.get("from"), query.get("to"),
                                   query.get("cursor"), query.get("limit"))
            if method == "GET" and len(parts) == 3 and parts[:2] == ["gate", "runs"]:
                return gate.run(parts[2])
            if method == "POST" and len(parts) == 4 and parts[:2] == ["gate", "runs"] and parts[3] == "cancel":
                return gate.cancel(parts[2])
            if (method == "GET" and len(parts) == 4 and parts[0] == "strategies"
                    and parts[2:] == ["gate", "preflight"]):
                query = parse_qs(url.query, keep_blank_values=True)
                if set(query) - {"evaluation_mode"} or any(len(v) != 1 for v in query.values()):
                    raise GateApiError("invalid_body", "El preflight solo admite un modo de evaluación.")
                return gate.preflight(parts[1], query.get("evaluation_mode", ["baseline_only"])[0])
            if len(parts) == 3 and parts[0] == "strategies" and parts[2] == "gate" and method == "POST":
                return gate.launch(parts[1], self._body())
            if len(parts) == 4 and parts[0] == "strategies" and parts[2] == "gate" and parts[3] == "runs" and method == "GET":
                version = {k: v[-1] for k, v in parse_qs(url.query).items()}.get("version")
                return gate.runs(parts[1], int(version) if version and version.isdigit() else None)
            return None

        def _vectorbt(self, method):
            """VectorBT exploration routes of a strategy; ``None`` when the path is not one of them."""
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            if parts[:1] == ["api-strategies"]:
                parts = parts[1:]
            vectorbt = getattr(service, "vectorbt", None)
            if vectorbt is not None and method == "GET" and parts == ["analyzer", "events"]:
                return read_analyzer_events(vectorbt.data_dir, vectorbt.python)
            if vectorbt is None or len(parts) < 3 or parts[0] != "strategies" or parts[2] != "vectorbt":
                return None
            if len(parts) == 3 and method == "GET":
                return vectorbt.status(parts[1])
            if len(parts) == 3 and method == "POST":
                return vectorbt.launch(parts[1], self._body())
            if len(parts) == 5 and method == "POST" and parts[4] == "cancel":
                return vectorbt.cancel(parts[1], parts[3])
            if len(parts) == 5 and method == "POST" and parts[4] == "confirm":
                return vectorbt.confirm(parts[1], parts[3], self._body())
            if len(parts) == 5 and method == "GET" and parts[4] == "compare":
                query = {k: v[-1] for k, v in parse_qs(url.query).items()}
                return vectorbt.compare(parts[1], parts[3], query.get("value"), query.get("run_id"))
            return None

        def _handle(self, method):
            try:
                out = self._gate(method)
                if out is True:
                    return
                if out is None:
                    out = self._vectorbt(method)
                self._send(200, out if out is not None else self._dispatch(method))
            except (GateApiError, LifecycleError) as error:
                self._send(error.status, {"error": error.code, "detail": error.detail})
            except RegistryError as error:
                self._send(error.status, dict({"error": error.code, "detail": error.detail}, **error.extra))
            except (ValueError, KeyError, TypeError) as error:
                self._send(400, {"error": "bad_request", "detail": str(error)})

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Balancita strategy registry (S)")
    parser.add_argument("--strategies-db", required=True)
    parser.add_argument("--verdicts-db", help="C's verdicts DB, opened read-only for backtests")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR, help="shipped specs seeded once (C25-C28)")
    parser.add_argument("--market-db", help="market DB (read-only) the historical replays read")
    parser.add_argument("--replays-dir", help="where each replay run DB is written (default: next to the strategies DB)")
    parser.add_argument("--config-dir", help="config folder the inventory reads (default: the repo's config/)")
    parser.add_argument("--forward-db", help="forward.sqlite (read-only): open positions and last cycle")
    parser.add_argument("--forward-summary", help="forward-reliability.json (default: $STRATEGY_FORWARD_PATH)")
    parser.add_argument("--decisions-db", help="Q's decisions DB (read-only): why Q skipped")
    parser.add_argument("--gate-dir", help="strategy gate folder (default: data/strategy-gate or $STRATEGY_GATE_DIR)")
    parser.add_argument("--purge-dir", help="where delete requests and acknowledgements live "
                                            "(default: <strategies db folder>/purge)")
    parser.add_argument("--account-db", help="D's account DB (retired, history): rewritten, chain intact, when a "
                                             "deleted strategy has rows in it")
    parser.add_argument("--vectorbt-dir", help="VectorBT lab data folder (default: data/research-vectorbt or "
                                               "$BALANCITA_VECTORBT_DIR); the interpreter is $BALANCITA_VECTORBT_PYTHON")
    parser.add_argument("--kronos-dir", help="folder with kronos.sqlite (the gate judges Kronos by its saved trades)")
    parser.add_argument("--qwen-exit-dir", help="folder with qwen-exit.sqlite (the gate judges Qwen by its saved trades)")
    parser.add_argument("--qwen-practice-dir", help="folder with the offline Qwen practice files "
                                                    "(default: data/qwen-practice)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("STRATEGIES_PORT", DEFAULT_PORT)))
    args = parser.parse_args(argv)
    registry = StrategyRegistry(args.strategies_db)
    registry.seed(load_specs(args.specs_dir))
    registry.apply_closed()
    registry.migrate_all_to_draft()
    products = dict(load_pinned_products())
    config_root = os.path.dirname(CLOSED_PATH)
    replays = None
    if args.market_db:
        from .futures_replay import ReplayJobs, qwen_factory

        directory = args.replays_dir or os.path.join(os.path.dirname(os.path.abspath(args.strategies_db)), "replays")
        replays = ReplayJobs(args.market_db, directory, lambda: registry.replayable_specs(), products,
                             qwen_factory(os.path.join(directory, "qwen-cache.db")))
    service = StrategyService(registry, args.verdicts_db, products, replays=replays, market_db_path=args.market_db,
                              config_dir=args.config_dir, forward_db_path=args.forward_db,
                              forward_summary_path=args.forward_summary, decisions_db_path=args.decisions_db, gate_data_dir=args.gate_dir,
                              purge_dir=args.purge_dir or os.path.join(os.path.dirname(os.path.abspath(args.strategies_db)), "purge"),
                              specs_dir=args.specs_dir,
                              forward_registration_path=os.path.join(config_root, "forward-strategies.json"),
                              freeze_path=os.path.join(config_root, "strategy-freeze.json"),
                              qwen_exit_config=os.path.join(config_root, "qwen-exit.json"),
                              qwen_practice_dir=args.qwen_practice_dir or os.path.join(
                                  os.path.dirname(config_root), "data", "qwen-practice"),
                              kronos_dir=args.kronos_dir, qwen_exit_dir=args.qwen_exit_dir,
                              account_db_path=args.account_db, vectorbt_dir=args.vectorbt_dir)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(service))
    print("[strategies] registry {} on http://127.0.0.1:{}".format(args.strategies_db, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        registry.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
