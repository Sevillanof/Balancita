"""Read-only view of how the forward is going, per strategy (``GET /api-strategies/forward``).

Nothing here writes. It reads what the forward runner and Q already keep:

* ``forward-reliability.json`` (``futures_forward.write_summary``): live and recovered trades apart, the
  funding state per product, the spec hash and the start of every strategy,
* ``forward.sqlite``: the open positions and when the last cycle ran (``forward_status.checked_ms``),
* the market DB: the latest official 1m close, to value the open positions,
* the decisions DB: ``paper_futures_llm_skips`` (why Q did not decide).

Only live trades count toward the minimum (``FORWARD_MIN_TRADES``); recovered ones are shown apart. An open
position is valued at the latest official close as if closed now (entry and exit costs of the cost model, no
funding accrued yet) and always carries the label ``OPEN_LABEL``. Every problem comes with a stable code and a
reason in Spanish: the view never says just "unknown". Contract: ``docs/forward-result-api.md``.
"""

import json
import os
import sqlite3
from decimal import Decimal

from .futures_costs import exit_fill, fee_rate
from .futures_strategy_reliability import FORWARD_SCHEMA

RESULT_SCHEMA = "futures-forward-result.v1"
OPEN_LABEL = "abierta, valuada a mercado"
# The dev launcher runs the forward every hour (scripts/dev-provider-env.mjs).
FORWARD_LOOP_SECONDS = 3600
# A cycle is late after one and a half periods (the same rule as /api/observability/health).
LATE_FACTOR = 1.5
ONE_MINUTE_MS = 60_000
SKIP_WINDOWS = (("1h", 3_600_000), ("24h", 86_400_000), ("7d", 7 * 86_400_000))
LATEST_SKIPS = 10

STATE_REASONS = {
    "active": "activa en el registro",
    "shadow": "en sombra: no abre operaciones",
    "draft": "borrador: aún no se mide",
    "retired": "desactivada en el registro",
    "closed": "cerrada: ya no opera",
    "off": "apagada",
    "unverified": "estado no verificado: ningún registro prueba que corra",
    "tracking": "contador en seguimiento",
    "inactive": "contador inactivo",
}


def _json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    return body if isinstance(body, dict) and body.get("schema") == FORWARD_SCHEMA else None


def _connect(path):
    if not path or not os.path.exists(path):
        return None
    return sqlite3.connect("file:{}?mode=ro".format(path), uri=True)


def _open(positions):
    return {"count": len(positions), "label": OPEN_LABEL, "positions": positions,
            "pnl_usd": round(sum(p["pnl_usd"] for p in positions if p["pnl_usd"] is not None), 4)}


def _side(summary):
    """The fields the owner reads of a group of closed trades; ``net_usd`` is after costs and the funding known."""
    summary = summary or {}
    return {
        "closed": summary.get("trades", 0), "net_usd": summary.get("pnl_usd", 0.0),
        "mean_net_bp": summary.get("mean_net_bp"), "hit_rate": summary.get("hit_rate"),
        "funding_incomplete": summary.get("funding_incomplete_trades", 0),
        "net_is_definitive": summary.get("net_is_definitive", summary.get("trades", 0) == 0),
    }


def _latest_close(market, product_id):
    """``(close_price, bucket_ms)`` of the newest official 1m candle (its first-known revision) or ``None``."""
    if market is None:
        return None
    try:
        row = market.execute(
            "SELECT close_price, bucket_start FROM paper_futures_official_candles WHERE product_id=? "
            "AND interval_ms=? ORDER BY bucket_start DESC, known_at ASC LIMIT 1",
            (product_id, ONE_MINUTE_MS)).fetchone()
    except sqlite3.Error:
        return None
    return None if row is None else (Decimal(row[0]), row[1])


def _open_positions(forward, market, strategy_id, spec_hash, notional):
    """The open positions of a strategy valued at the latest official close, each labelled ``OPEN_LABEL``."""
    if forward is None:
        return []
    try:
        rows = forward.execute("SELECT product_id, payload FROM forward_open WHERE strategy_id=? AND spec_hash=?",
                               (strategy_id, spec_hash)).fetchall()
    except sqlite3.Error:
        return []
    positions = []
    for product_id, payload in sorted(rows):
        position = json.loads(payload) if payload else None
        if position is None:
            continue
        entry, side = Decimal(position["entry"]), position["side"]
        item = {"product_id": product_id, "side": side, "entry_price": position["entry"],
                "opened_at_ms": int(position["opened_at"]), "label": OPEN_LABEL,
                "mark_price": None, "mark_bucket_ms": None, "pnl_usd": None, "net_bp": None,
                "recovered": bool(position.get("recovered")),
                "classification": ("recuperada (entrada con datos llegados tarde)" if position.get("recovered")
                                   else "en vivo")}
        mark = _latest_close(market, product_id)
        if mark is not None:
            price, bucket = mark
            quantity = notional / entry
            out = exit_fill(price, side, product_id, "strategy_exit")
            gross = (out - entry) * quantity if side == "LONG" else (entry - out) * quantity
            net = gross - (entry + out) * quantity * fee_rate("taker")
            item.update(mark_price=str(price), mark_bucket_ms=bucket, pnl_usd=float(round(net, 4)),
                        net_bp=float(round(net / notional * 10_000, 4)))
        positions.append(item)
    return positions


def _last_run(forward, strategy_id):
    if forward is None:
        return None
    try:
        rows = forward.execute("SELECT payload FROM forward_status WHERE strategy_id=?", (strategy_id,)).fetchall()
    except sqlite3.Error:
        return None
    checked = [json.loads(p).get("checked_ms") for (p,) in rows]
    checked = [c for c in checked if c is not None]
    return max(checked) if checked else None


def read_q_skips(decisions_db, now_ms):
    """Counts per code over recent windows and the latest skips of Q, read-only."""
    base = {"available": False, "reason": None, "windows": {}, "latest": []}
    db = _connect(decisions_db)
    if db is None:
        return dict(base, reason="sin base de decisiones de Q: Q no ha corrido o la ruta no está configurada")
    try:
        windows = {}
        for name, span in SKIP_WINDOWS:
            by_code = dict(db.execute("SELECT code, COUNT(*) FROM paper_futures_llm_skips WHERE written_at>=? "
                                      "GROUP BY code ORDER BY code", (now_ms - span,)).fetchall())
            windows[name] = {"total": sum(by_code.values()), "by_code": by_code}
        latest = [{"product_id": p, "bucket_start": b, "question_id": q, "code": c, "reason": r, "written_at": w}
                  for p, b, q, c, r, w in db.execute(
                      "SELECT product_id, bucket_start, question_id, code, reason, written_at "
                      "FROM paper_futures_llm_skips ORDER BY skip_id DESC LIMIT ?", (LATEST_SKIPS,))]
    except sqlite3.Error:
        return dict(base, reason="la tabla de saltos de Q todavía no existe: Q no ha corrido con esta versión")
    finally:
        db.close()
    return {"available": True, "reason": None, "windows": windows, "latest": latest}


def read_forward(forward_db, summary_path, market_db, decisions_db, *, now_ms, notional="100",
                 loop_seconds=FORWARD_LOOP_SECONDS):
    """Everything the forward knows now, per strategy id, plus the funding per product and the Q skips."""
    summary = _json(summary_path)
    forward, market = _connect(forward_db), _connect(market_db)
    strategies, funding = {}, {}
    try:
        for strategy_id, entry in ((summary or {}).get("strategies") or {}).items():
            digest = entry.get("spec_hash")
            positions = _open_positions(forward, market, strategy_id, digest, Decimal(notional))
            strategies[strategy_id] = {
                "spec_hash": digest, "start_ms": entry.get("start_ms"),
                "live": _side(entry.get("summary_without_recovered")),
                "recovered": _side(entry.get("summary_recovered")),
                "open": _open(positions),
                "live_open": _open([p for p in positions if not p["recovered"]]),
                "recovered_open": _open([p for p in positions if p["recovered"]]),
                "last_run_ms": _last_run(forward, strategy_id) or (summary or {}).get("updated_ms"),
                "funding_state": entry.get("funding_state") or {},
                "missing_candles_1m": entry.get("missing_candles_1m", 0),
                "max_candle_lag_ms": entry.get("max_candle_lag_ms"),
            }
            for product_id, state in strategies[strategy_id]["funding_state"].items():
                if product_id not in funding or state.get("checked_ms", 0) > funding[product_id].get("checked_ms", 0):
                    funding[product_id] = state
    finally:
        for db in (forward, market):
            if db is not None:
                db.close()
    return {
        "schema": RESULT_SCHEMA, "generated_ms": now_ms, "cadence_s": loop_seconds,
        "late_after_s": int(loop_seconds * LATE_FACTOR),
        "summary_updated_ms": (summary or {}).get("updated_ms"), "summary_available": summary is not None,
        "min_trades": (summary or {}).get("min_forward_trades"),
        "strategies": strategies, "funding": dict(sorted(funding.items())),
        "q_skips": read_q_skips(decisions_db, now_ms),
    }


def _minutes(ms):
    return max(0, round(ms / ONE_MINUTE_MS))


def strategy_block(forward, strategy_id, operational, *, min_trades, spec_hash=None, kind="rules"):
    """The per-strategy result for the inventory: ``forward`` is ``read_forward``'s output.

    Returns ``None`` when the strategy is not measured by the forward runner by design (C31, Kronos, carry,
    closed ones); the caller then keeps ``trades: null`` with its own reason.
    """
    state = operational.get("state")
    reason = operational.get("reason") or STATE_REASONS.get(state, "estado sin motivo registrado")
    now_ms = forward["generated_ms"]
    problems = []
    raw = forward["strategies"].get(strategy_id)
    block = {"state": {"code": state, "reason": reason, "since_ms": operational.get("since_ms")},
             "problems": problems}
    running = state == "active"
    if raw is None:
        if running:
            code, text = (("no_summary", "el forward no ha escrito su resumen (proceso detenido o sin ciclos todavía)")
                          if not forward["summary_available"] else
                          ("not_measured", "el forward no mide esta estrategia: no está en forward-strategies.json "
                                           "ni tiene resumen"))
            problems.append({"code": code, "reason": text})
        return dict(block, available=False, live=None, recovered=None, open=None, progress=None,
                    last_run_ms=None, late=None)
    live, recovered = raw["live"], raw["recovered"]
    last_run = raw["last_run_ms"]
    late = None
    if running:
        late = last_run is None or now_ms - last_run > forward["late_after_s"] * 1000
        if late:
            problems.append({"code": "late", "reason": (
                "el forward no corre desde hace {} min (se espera un ciclo cada {} min)".format(
                    _minutes(now_ms - last_run), _minutes(forward["cadence_s"] * 1000)) if last_run is not None
                else "el forward no tiene ningún ciclo registrado")})
    if spec_hash is not None and raw["spec_hash"] != spec_hash:
        problems.append({"code": "spec_changed", "reason": "el forward mide otra versión del spec ({}); "
                         "la actual aún no tiene resumen".format((raw["spec_hash"] or "?")[:8])})
    for product_id, funding in sorted(raw["funding_state"].items()):
        if not funding.get("usable", True):
            problems.append({"code": "funding_" + str(funding.get("code")),
                             "reason": "{}: {}".format(product_id, funding.get("reason"))})
    if raw["missing_candles_1m"]:
        problems.append({"code": "missing_candles", "reason":
                         "faltan {} velas de 1 min en la captura".format(raw["missing_candles_1m"])})
    if running and not problems and live["closed"] + recovered["closed"] + raw["open"]["count"] == 0:
        problems.append({"code": "no_trades_yet", "reason": "todavía no hubo ninguna señal que abriera operación"})
    done = live["closed"]
    live = dict(live, open=raw["live_open"])
    recovered = dict(recovered, open=raw["recovered_open"])
    return dict(block, available=True, spec_hash=raw["spec_hash"], start_ms=raw["start_ms"], live=live,
                recovered=recovered, open=raw["open"],
                progress={"live_trades": done, "min_trades": min_trades,
                          "remaining": None if min_trades is None else max(0, min_trades - done),
                          "reached": min_trades is not None and done >= min_trades,
                          "counts_toward_min": "solo operaciones en vivo"},
                last_run_ms=last_run, late=late, funding_state=raw["funding_state"])
