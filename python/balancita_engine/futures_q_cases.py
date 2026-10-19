"""Read-only view of what Q (Qwen) decided in each case, for the Strategies page.

Nothing here writes. It reads the decisions DB that ``futures_llm_decisions`` keeps (the same file as
``futures_forward_result.read_q_skips``) and merges its three append-only tables into one list, newest first:

* ``paper_futures_llm_decisions``: the question (id and version), the probability of every option, the option
  chosen, the confidence, the probability source, the prompt version and the latency,
* ``paper_futures_llm_skips``: why Q did not ask the model (``model_down``, ``model_loading``, ``calm_skip``,
  ``stale_verdict``, ``state_error``),
* ``paper_futures_llm_errors``: the model answered but nothing usable came out (``no_letters``, ``bad_json``...).

``model_state`` says apart the cases where the local model was never started (the dev launcher tells it through
``Q_NOT_STARTED_REASON``) or was started and has stopped (the supervisor's ``dev-health.json``) from the plain
"llama-server does not answer" that Q itself records. Contract: ``docs/forward-result-api.md``.
"""

import json
import os
import sqlite3

Q_CASES_LIMIT = 20

_DECISIONS = (
    "SELECT product_id, bucket_start, question_id, question_version, chosen, probabilities_json, confidence, "
    "probability_source, prompt_version, latency_ms, model_ref, timings_json, written_at "
    "FROM paper_futures_llm_decisions ORDER BY written_at DESC, bucket_start DESC LIMIT ?"
)
_SKIPS = (
    "SELECT product_id, bucket_start, question_id, question_version, code, reason, written_at "
    "FROM paper_futures_llm_skips ORDER BY written_at DESC, skip_id DESC LIMIT ?"
)
_ERRORS = (
    "SELECT product_id, bucket_start, question_id, question_version, kind, message, written_at "
    "FROM paper_futures_llm_errors ORDER BY written_at DESC, error_id DESC LIMIT ?"
)


def _timings(text):
    """``prompt_ms`` (reading the prompt) and ``predicted_ms`` (answering) llama-server reported; empty when absent."""
    try:
        found = json.loads(text)
    except (TypeError, ValueError):
        return {}
    return found if isinstance(found, dict) else {}


def _health_process(env, name):
    path = (env.get("DEV_HEALTH_FILE") or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
        process = body["processes"][name]
    except (OSError, ValueError, TypeError, KeyError):
        return None
    return process if isinstance(process, dict) else None


def _exit_text(process):
    last = process.get("last_exit")
    return "" if last is None else " (salió con {})".format(last)


def model_state(env):
    """Why the local model cannot be asked, when the launcher knows it; ``None`` when nothing says it is not there."""
    reason = (env.get("Q_NOT_STARTED_REASON") or "").strip()
    if reason:
        return {"code": "not_started", "reason": reason}
    llm = _health_process(env, "llm")
    if llm is not None and llm.get("status") in ("down", "restarting"):
        return {"code": "llm_stopped", "reason": "llama-server se detuvo{}: el modelo local ya no corre".format(
            _exit_text(llm))}
    q = _health_process(env, "q")
    if q is not None and q.get("status") in ("down", "restarting"):
        return {"code": "q_stopped", "reason": "el servicio de decisiones de Qwen se detuvo{}".format(_exit_text(q))}
    return None


def _connect(path):
    if not path or not os.path.exists(path):
        return None
    return sqlite3.connect("file:{}?mode=ro".format(path), uri=True)


def read_q_cases(decisions_db, now_ms, env=None):
    """The latest ``Q_CASES_LIMIT`` cases of Q (decided or not), newest first, read-only."""
    env = os.environ if env is None else env
    base = {"available": False, "reason": None, "model": model_state(env), "latest": []}
    db = _connect(decisions_db)
    if db is None:
        return dict(base, reason="sin base de decisiones de Q: Q no ha corrido o la ruta no está configurada")
    try:
        cases = []
        for row in db.execute(_DECISIONS, (Q_CASES_LIMIT,)):
            (product, bucket, question, version, chosen, probabilities, confidence, source, prompt, latency, model,
             timings, at) = row
            timings = _timings(timings)
            cases.append({"kind": "decision", "product_id": product, "bucket_start": bucket,
                          "question_id": question, "question_version": version, "chosen": chosen,
                          "probabilities": json.loads(probabilities), "confidence": confidence,
                          "probability_source": source, "prompt_version": prompt, "latency_ms": latency,
                          "model_ref": model, "written_at": at,
                          "prompt_ms": timings.get("prompt_ms"), "predicted_ms": timings.get("predicted_ms")})
        for kind, query in (("skip", _SKIPS), ("error", _ERRORS)):
            for product, bucket, question, version, code, reason, at in db.execute(query, (Q_CASES_LIMIT,)):
                cases.append({"kind": kind, "product_id": product, "bucket_start": bucket,
                              "question_id": question, "question_version": version, "code": code,
                              "reason": reason, "written_at": at})
    except (sqlite3.Error, ValueError):
        return dict(base, reason="las tablas de decisiones de Q todavía no existen: Q no ha corrido con esta versión")
    finally:
        db.close()
    cases.sort(key=lambda case: (case["written_at"], case["bucket_start"]), reverse=True)
    return dict(base, available=True, latest=cases[:Q_CASES_LIMIT])
