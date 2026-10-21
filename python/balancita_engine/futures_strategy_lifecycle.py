"""Delete a strategy from the front, completely (odd/tasks/strategy-lifecycle.md).

Runs inside the registry process S. S owns the registry DB, the replay run DBs, the repo config files of a
shipped strategy and the offline Qwen practice files, so it deletes those itself. The other databases belong to other
processes (single writer): the gate process deletes its own rows (``strategy_gate purge``) and the forward runner
consumes a purge request file on its next loop (``strategy_purge``). ``PURGE_PAPER_LEDGER`` (off) keeps the
append-only paper ledgers, see ``strategy_purge``.
"""

import json
import os
import sqlite3

from . import strategy_purge
from . import strategy_gate_models

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
# Tables of the Qwen practice files (data/qwen-practice, written by the offline futures_qwen_practice command).
PRACTICE_FILES = (("signals.sqlite", [("signals", "strategy_id")]),
                  ("practice.sqlite", [("decisions", "strategy_id")]))
FORWARD_TARGETS = (
    ("forward_status", "strategy_id"), ("forward_open", "strategy_id"), ("forward_diverged", "strategy_id"),
    ("forward_recovered", "strategy_id"), ("forward_blocked", "strategy_id"), ("forward_unclassified", "strategy_id"),
    ("forward_era", "strategy_id"), ("forward_first_seen", "strategy_id"),
    ("forward_trade", "strategy_id"), ("forward_trade_funding", "strategy_id"))
FORWARD_LEDGER = ("forward_trade", "forward_trade_funding")


class LifecycleError(Exception):
    def __init__(self, code, detail, status=400):
        super().__init__(detail)
        self.code, self.detail, self.status = code, detail, status


def forward_stats(db_path, strategy_id):
    """``(trades, net_usd)`` stored in the forward DB for the strategy (read-only); zeros when there is none."""
    if not db_path or not os.path.exists(db_path):
        return 0, 0.0
    db = sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True, timeout=10)
    try:
        rows = db.execute("SELECT payload FROM forward_trade WHERE strategy_id=?", (strategy_id,)).fetchall()
    except sqlite3.Error:
        return 0, 0.0
    finally:
        db.close()
    net = 0.0
    for (payload,) in rows:
        try:
            net += float(json.loads(payload).get("pnl_usd") or 0)
        except (TypeError, ValueError):
            continue
    return len(rows), round(net, 2)


def _drop_from_json(path, edit):
    """Rewrites a repo config JSON through ``edit(body) -> changed``; atomic; ``False`` when nothing changed."""
    if not path or not os.path.exists(path):
        return False
    with open(path, encoding="utf-8") as handle:
        body = json.load(handle)
    if not edit(body):
        return False
    temporary = path + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(temporary, path)
    return True


class Lifecycle:
    def __init__(self, registry, gate, *, forward_db_path=None, purge_dir=None, consumers=("forward",),
                 specs_dir=None, forward_registration_path=None, freeze_path=None, qwen_exit_config=None,
                 replays=None, qwen_practice_dir=None, account_db_path=None):
        self.registry, self.gate = registry, gate
        self.forward_db_path, self.purge_dir, self.consumers = forward_db_path, purge_dir, tuple(consumers)
        self.specs_dir, self.forward_registration_path = specs_dir, forward_registration_path
        self.freeze_path, self.qwen_exit_config = freeze_path, qwen_exit_config
        self.replays, self.qwen_practice_dir = replays, qwen_practice_dir
        self.account_db_path = account_db_path

    # ------------------------------------------------------------------ what the dialog shows

    def _refuse_if_protected(self, strategy_id):
        if strategy_purge.is_protected(strategy_id):
            raise LifecycleError("protected", strategy_purge.PROTECTED_MESSAGE, 400)

    def _qwen_dependency(self, strategy_id):
        """Why C31 (Qwen) needs this strategy, else ``None``. A dependency of a running Qwen blocks the delete."""
        path = self.qwen_exit_config
        if not path or not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
        if strategy_id not in config.get("entry_specs", []):
            return None
        return "off" if config.get("off") else "on"

    def preview(self, strategy_id):
        self._refuse_if_protected(strategy_id)
        info = self.registry.lifecycle(strategy_id)
        trades, net = forward_stats(self.forward_db_path, strategy_id)
        runs = self.gate._query("SELECT kind, verdict FROM runs WHERE strategy_id=? ORDER BY id", (strategy_id,))
        locks = self.gate._query("SELECT locked_at, verdict, status FROM exam_locks WHERE strategy_id=?", (strategy_id,))
        exam = {"taken": False}
        if locks:
            exam = {"taken": True, "verdict": locks[0]["verdict"] or locks[0]["status"],
                    "date": strategy_purge_date(locks[0]["locked_at"])}
        warnings = []
        dependency = self._qwen_dependency(strategy_id)
        if dependency == "off":
            warnings.append("Qwen (C31, hoy apagado) usa esta estrategia como entrada: si lo reactivás vas a "
                            "necesitar volver a crearla.")
        blocked = dependency == "on"
        return dict(info, forward_trades=trades, forward_net_usd=net, gate_runs=len(runs),
                    gate_practice_runs=sum(1 for r in runs if r["kind"] == "practice"), exam=exam,
                    ledger_kept=(not strategy_purge.PURGE_PAPER_LEDGER) and trades > 0,
                    warnings=warnings, blocked=blocked)

    # ------------------------------------------------------------------ the delete itself

    def delete(self, strategy_id, confirm):
        self._refuse_if_protected(strategy_id)
        info = self.registry.lifecycle(strategy_id)
        if confirm not in (strategy_id, info["name"]):
            raise LifecycleError("confirmation_required", "Escribí el nombre de la estrategia para borrarla.", 409)
        if self._qwen_dependency(strategy_id) == "on":
            raise LifecycleError("in_use", "Qwen (C31) está operando con esta estrategia como entrada: no se puede "
                                           "borrar mientras esté encendido.", 409)
        hashes = [v["spec_hash"] for v in info["versions"]]
        steps = {}
        steps["gate"] = self.gate.purge(strategy_id)
        steps["paper_account"] = self._purge_account(strategy_id)
        if self.replays is not None:
            steps["replays"] = self.replays.purge_strategy(strategy_id)
        steps["qwen_practice"] = self._purge_practice(strategy_id)
        steps["config"] = self._purge_config(strategy_id, info["builtin"])
        steps["registry"] = self.registry.hard_delete(strategy_id)
        purge_id = None
        if self.purge_dir and self.consumers:
            purge_id = strategy_purge.write_request(self.purge_dir, strategy_id, hashes, self.consumers)
        return {"id": strategy_id, "deleted": True, "purge_id": purge_id, "state": "running" if purge_id else "done",
                "steps": steps, "ledger_kept": not strategy_purge.PURGE_PAPER_LEDGER}

    def _purge_account(self, strategy_id):
        """D's hash-chained account DB (retired, so nobody else writes it): the purge tool rechains it (ADR 0001)."""
        from . import futures_paper_account_purge

        if not strategy_purge.PURGE_PAPER_LEDGER or not futures_paper_account_purge.has_strategy(
                self.account_db_path, strategy_id):
            return {"skipped": True}
        self.gate.run_module(["balancita_engine.futures_paper_account_purge", "--account-db",
                              os.path.abspath(self.account_db_path), "--strategy", strategy_id], "account")
        return {"skipped": False}

    def _purge_practice(self, strategy_id):
        if not self.qwen_practice_dir or not os.path.isdir(self.qwen_practice_dir):
            return {}
        out = {}
        for name, targets in PRACTICE_FILES:
            path = os.path.join(self.qwen_practice_dir, name)
            if not os.path.exists(path):
                continue
            db = sqlite3.connect(path, timeout=5)
            try:
                tables = {t for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "decision_errors" in tables and "decisions" in tables:
                    with db:
                        db.execute("DELETE FROM decision_errors WHERE signal_id IN "
                                   "(SELECT signal_id FROM decisions WHERE strategy_id=?)", (strategy_id,))
                out[name] = strategy_purge.delete_rows(db, targets, strategy_id)
            except sqlite3.OperationalError as error:
                out[name] = {"error": str(error)}
            finally:
                db.close()
        return out

    def _purge_config(self, strategy_id, builtin):
        done = []
        if builtin and self.specs_dir and os.path.isdir(self.specs_dir):
            for name in sorted(os.listdir(self.specs_dir)):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(self.specs_dir, name)
                try:
                    with open(path, encoding="utf-8") as handle:
                        found = json.load(handle).get("id") == strategy_id
                except (OSError, ValueError):
                    continue
                if found:
                    os.remove(path)
                    done.append(name)
        if _drop_from_json(self.forward_registration_path,
                           lambda body: body.get("strategies", {}).pop(strategy_id, None) is not None):
            done.append("forward-strategies.json")

        def freeze(body):
            ids = body.get("ids", [])
            if strategy_id not in ids:
                return False
            body["ids"] = [i for i in ids if i != strategy_id]
            return True

        if _drop_from_json(self.freeze_path, freeze):
            done.append("strategy-freeze.json")
        return done

    # ------------------------------------------------------------------ progress

    def purges(self):
        if not self.purge_dir:
            return []
        strategy_purge.collect_finished(self.purge_dir)
        return strategy_purge.active(self.purge_dir)

    def purge_status(self, purge_id):
        if not self.purge_dir:
            return {"purge_id": purge_id, "state": "done", "consumers": {}}
        result = strategy_purge.status(self.purge_dir, purge_id)
        strategy_purge.collect_finished(self.purge_dir)
        return result


def strategy_purge_date(ms):
    import time

    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


__all__ = ["Lifecycle", "LifecycleError", "forward_stats", "strategy_gate_models"]
