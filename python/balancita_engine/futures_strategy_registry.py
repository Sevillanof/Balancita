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
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

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
from .futures_strategy_backtest import MIN_TRADES, load_verdict_rows, run_backtest
from .futures_strategy_translate import TranslationError, default_provider, translate

REGISTRY_SCHEMA = "futures-strategy-registry.v1"
STATES = ("draft", "shadow", "active", "retired")
DAY_MS = 86_400_000
PERIOD_DAYS = (7, 30, 90)
DEFAULT_PORT = 8790
# Promotion gates (ADR 0001, Evaluation): out of sample, deflated Sharpe, minimum trade count.
GATE_MIN_OOS_TRADES = MIN_TRADES
GATE_MIN_DSR = 0.95
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


class StrategyRegistry:
    def __init__(self, path, *, clock=_now_ms):
        self.clock = clock
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
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
            """
        )
        for table in ("strategy_versions", "strategy_events", "strategy_backtests", "strategy_registry_meta"):
            self.db.executescript(
                "CREATE TRIGGER IF NOT EXISTS {0}_no_update BEFORE UPDATE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;"
                "CREATE TRIGGER IF NOT EXISTS {0}_no_delete BEFORE DELETE ON {0} "
                "BEGIN SELECT RAISE(ABORT, 'strategy registry is append-only'); END;".format(table))
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO strategy_registry_meta VALUES('schema', ?)", (REGISTRY_SCHEMA,))

    # --- seeding and reads ------------------------------------------------

    def seed(self, specs):
        """Records shipped specs (C25-C28) as active v1 the first time they are seen."""
        with self.lock, self.db:
            for spec in specs.values():
                if self._version_row(spec["id"], None) is not None:
                    continue
                self._insert_version(spec, "builtin", None, None)
                self.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                "VALUES(?,?,?,?,?)", (spec["id"], spec["version"], "active", "builtin", 0))

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
            "name": spec["name"], "description": spec.get("description", ""), "kind": spec.get("kind", "rules"),
            "state": state["state"], "state_reason": state["reason"], "state_known_at": state["known_at"],
            "active_version": self._active_version(row["strategy_id"]), "origin": row["origin"],
            "parent": None if row["parent_id"] is None else {"id": row["parent_id"], "version": row["parent_version"]},
            "created_at": row["created_at"],
        }

    def list(self):
        ids = [r[0] for r in self.db.execute(
            "SELECT strategy_id FROM strategy_versions GROUP BY strategy_id ORDER BY MIN(created_at), strategy_id")]
        return [self._entry(self._version_row(strategy_id, None)) for strategy_id in ids]

    def detail(self, strategy_id, version=None):
        row = self.version(strategy_id, version)
        versions = [self._entry(self._version_row(strategy_id, v)) for (v,) in self.db.execute(
            "SELECT version FROM strategy_versions WHERE strategy_id=? ORDER BY version", (strategy_id,))]
        events = [{"version": r[0], "state": r[1], "reason": r[2], "known_at": r[3]} for r in self.db.execute(
            "SELECT version, state, reason, known_at FROM strategy_events WHERE strategy_id=? ORDER BY seq",
            (strategy_id,))]
        return dict(self._entry(row), spec=row["spec"], versions=versions, events=events)

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
            if rules_hash(json.loads(stored)) == rules:
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

    def import_spec(self, spec):
        """An imported spec always lands as a new draft; a taken id gets a fresh one."""
        spec = self._validated(spec)
        taken = self._version_row(spec["id"], None) is not None
        return self.save(spec, "new", origin="import", new_id=None if taken else spec["id"])

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

    def set_state(self, strategy_id, version, state, reason="manual"):
        if state not in STATES:
            raise RegistryError("invalid_state", "state must be one of " + ", ".join(STATES))
        with self.lock, self.db:
            row = self.version(strategy_id, version)
            current = self._state(strategy_id, row["version"])["state"]
            gates = self.gates(row, state, current)
            if not all(gate["passed"] for gate in gates):
                raise RegistryError("gate_failed", "the {} gate is not met".format(state), 409, {"gates": gates})
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

    def gates(self, row, state, current):
        """The checks a transition to ``state`` must pass (PS-08e)."""
        if state in ("retired", "draft") or (state == "shadow" and current == "active"):
            return []
        backtest = self.latest_backtest(row["spec_hash"])
        if state == "shadow":
            return [{"code": "backtested", "passed": backtest is not None, "value": backtest is not None,
                     "threshold": True}]
        oos = (backtest or {}).get("out_of_sample", {})
        dsr = (backtest or {}).get("deflated_sharpe_probability")
        return [
            {"code": "was_in_shadow", "passed": current == "shadow", "value": current, "threshold": "shadow"},
            {"code": "oos_trades", "passed": oos.get("trades", 0) >= GATE_MIN_OOS_TRADES,
             "value": oos.get("trades", 0), "threshold": GATE_MIN_OOS_TRADES},
            {"code": "oos_mean_net_bp_positive", "passed": (oos.get("mean_net_bp") or 0) > 0,
             "value": oos.get("mean_net_bp"), "threshold": 0},
            {"code": "deflated_sharpe", "passed": dsr is not None and dsr >= GATE_MIN_DSR,
             "value": dsr, "threshold": GATE_MIN_DSR},
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

    def __init__(self, registry, verdicts_db_path, products, provider_factory=None):
        self.registry = registry
        self.provider_factory = provider_factory or (lambda: default_provider(os.environ))
        self.verdicts_db_path = verdicts_db_path
        self.products = products
        self._cache = {}
        self._results = {}

    def _tick(self, product_id):
        if product_id not in self.products:
            raise RegistryError("unknown_product", "unknown product " + str(product_id))
        return self.products[product_id]

    def _verdicts(self, product_id, days):
        if days not in PERIOD_DAYS:
            raise RegistryError("invalid_period", "days must be one of 7, 30, 90")
        if not self.verdicts_db_path or not os.path.exists(self.verdicts_db_path):
            raise RegistryError("verdicts_unavailable", "no verdicts DB yet", 503)
        db = sqlite3.connect("file:{}?mode=ro".format(self.verdicts_db_path), uri=True)
        try:
            last = db.execute("SELECT MAX(bucket_start) FROM paper_futures_verdicts WHERE product_id=?",
                              (product_id,)).fetchone()[0]
        except sqlite3.OperationalError as error:
            raise RegistryError("verdicts_unavailable", str(error), 503) from error
        finally:
            db.close()
        if last is None:
            return []
        start = last + 60_000 - days * DAY_MS
        key = (product_id, start, last)
        if key not in self._cache:
            self._cache = {key: load_verdict_rows(self.verdicts_db_path, product_id, start, last + 60_000)}
        return self._cache[key]

    def backtest(self, spec, product_id, days, *, strategy_id=None, version=None, record=True):
        tick = self._tick(product_id)
        verdicts = self._verdicts(product_id, days)
        digest = spec_hash(spec)
        key = (digest, product_id, days, verdicts[0]["bucket_start_ms"] if verdicts else None,
               verdicts[-1]["bucket_start_ms"] if verdicts else None)
        if key in self._results:
            return self._results[key]
        result = run_backtest(spec, verdicts, tick_size=tick,
                              trial_sharpes=self.registry.trial_sharpes(product_id, digest))
        result.update(spec_hash=digest, product_id=product_id, days=days)
        if record and verdicts:
            self.registry.record_backtest(digest, strategy_id or spec["id"], version, product_id, result)
        if len(self._results) > 500:
            self._results.clear()
        self._results[key] = result
        return result

    def ranking(self, product_id, days):
        rows = []
        buy_and_hold = None
        try:
            self._verdicts(product_id, days)
        except RegistryError as error:
            if error.code != "verdicts_unavailable":
                raise
            return {"product_id": product_id, "days": days, "buy_and_hold_pct": None, "min_trades": MIN_TRADES,
                    "verdicts_available": False, "detail": error.detail,
                    "strategies": [dict(e, return_pct=None, pnl_usd=None, hit_rate=None, trades=0, wins=0,
                                        few_trades=True, deflated_sharpe_probability=None)
                                   for e in self.registry.list()]}
        for entry in self.registry.list():
            row = self.registry.version(entry["id"], entry["version"])
            result = self.backtest(row["spec"], product_id, days, strategy_id=entry["id"],
                                   version=entry["version"])
            buy_and_hold = result["buy_and_hold_pct"]
            total = result["all"]
            rows.append(dict(entry, return_pct=total["return_pct"], pnl_usd=total["pnl_usd"],
                             hit_rate=total["hit_rate"], trades=total["trades"], wins=total["wins"],
                             few_trades=total["trades"] < MIN_TRADES,
                             deflated_sharpe_probability=result["deflated_sharpe_probability"]))
        rows.sort(key=lambda r: (-(r["return_pct"] or 0), r["id"]))
        return {"product_id": product_id, "days": days, "buy_and_hold_pct": buy_and_hold,
                "min_trades": MIN_TRADES, "verdicts_available": True, "strategies": rows}

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
            if method == "GET" and parts == ["ranking"]:
                return service.ranking(product, days)
            if method == "GET" and len(parts) == 2 and parts[0] == "strategies":
                return registry.detail(parts[1], query.get("version"))
            if method == "GET" and len(parts) == 3 and parts[0] == "strategies" and parts[2] == "export":
                return registry.version(parts[1], query.get("version"))["spec"]
            if method != "POST":
                raise RegistryError("not_found", "no route", 404)
            body = self._body()
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
            if parts == ["translate"]:
                return service.translate(body.get("text"), body.get("source", "auto"))
            if parts == ["import"]:
                return registry.import_spec(body.get("spec", body))
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
                                          body.get("reason") or "manual")
            raise RegistryError("not_found", "no route", 404)

        def _handle(self, method):
            try:
                self._send(200, self._dispatch(method))
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
    parser.add_argument("--port", type=int, default=int(os.environ.get("STRATEGIES_PORT", DEFAULT_PORT)))
    args = parser.parse_args(argv)
    registry = StrategyRegistry(args.strategies_db)
    registry.seed(load_specs(args.specs_dir))
    products = dict(load_pinned_products())
    service = StrategyService(registry, args.verdicts_db, products)
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
