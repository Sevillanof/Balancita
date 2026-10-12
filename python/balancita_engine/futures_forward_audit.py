"""Read-only audit of the forward measurement: what is measured, with what, and what is missing.

It opens every database read-only and writes nothing but its JSON report. It answers, per strategy and product:
is the strategy registered and measured at all (a registered or active strategy that never reached the runner is
different from one that ran and found no signal), how many trades, how many are recovered, how many have a
verified funding, which spec hashes exist, whether a candle gap or a late candle is on record, and whether the
market DB holds the data the strategy needs (funding periods for the funding strategies).
"""

import argparse
import json
import os
import sqlite3
import time

from .futures_forward import load_registration
from .futures_funding_context import load_periods
from .futures_products import resolve_products
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_reliability import FORWARD_STRATEGIES_PATH

HOUR_MS = 3_600_000
AUDIT_SCHEMA = "futures-forward-audit.v1"


def _ro(path):
    return sqlite3.connect("file:{}?mode=ro".format(path), uri=True)


def _rows(db, sql, args=()):
    try:
        return db.execute(sql, args).fetchall()
    except sqlite3.OperationalError:
        return []  # the table does not exist yet


def audit(forward_db, registration, specs, candidates=None, market_db=None, now_ms=None):
    """The audit as a dict. ``candidates`` is ``futures_strategy_registry.forward_candidates`` (or ``None``)."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    ids = sorted(set(registration["strategies"]) | {s for s, c in (candidates or {}).items() if c["state"] == "active"})
    out = {}
    db = _ro(forward_db) if forward_db and os.path.exists(forward_db) else None
    try:
        for strategy_id in ids:
            registered = strategy_id in registration["strategies"]
            active = bool(candidates and candidates.get(strategy_id, {}).get("state") == "active")
            entry = {"in_forward_file": registered, "active_in_registry": active if candidates is not None else None}
            spec = specs.get(strategy_id) or (candidates or {}).get(strategy_id, {}).get("spec")
            entry["spec_hash_now"] = spec_hash(spec) if spec else None
            if db is None:
                entry["measured"] = False
                out[strategy_id] = entry
                continue
            hashes = [h for (h,) in _rows(db, "SELECT DISTINCT spec_hash FROM forward_trade WHERE strategy_id=?", (strategy_id,))]
            statuses = {p: json.loads(s) for p, s in _rows(
                db, "SELECT product_id, payload FROM forward_status WHERE strategy_id=?", (strategy_id,))}
            trades = _rows(db, "SELECT product_id, payload FROM forward_trade WHERE strategy_id=?", (strategy_id,))
            keys = [(p, json.loads(x)["entry_bucket_ms"]) for p, x in trades]
            reconciled = {(p, b) for p, b in _rows(
                db, "SELECT product_id, entry_bucket_ms FROM forward_trade_funding WHERE strategy_id=?", (strategy_id,))}
            recovered = {(p, b) for p, b in _rows(
                db, "SELECT product_id, entry_bucket_ms FROM forward_recovered WHERE strategy_id=?", (strategy_id,))}
            entry.update(
                measured=bool(statuses),  # the runner wrote a status for it: it looked at least once
                last_checked_ms=max((s["checked_ms"] for s in statuses.values()), default=None),
                products_checked=sorted(statuses),
                spec_hashes_in_trades=hashes,
                spec_hash_matches_trades=(entry["spec_hash_now"] in hashes) if hashes else None,
                trades=len(trades),
                trades_by_product={p: sum(1 for q, _ in keys if q == p) for p in sorted({q for q, _ in keys})},
                recovered_trades=sum(1 for k in keys if k in recovered),
                funding_complete_in_original=sum(1 for _, x in trades if json.loads(x).get("funding_complete") is True),
                funding_reconciled_aside=sum(1 for k in keys if k in reconciled),
                late_1m_by_product={p: s.get("late_1m") for p, s in statuses.items()},
                missing_1m_by_product={p: s.get("missing_1m") for p, s in statuses.items()},
                candle_lag_ms_by_product={p: s.get("candle_lag_ms") for p, s in statuses.items()},
                diverged_trades=sum(s.get("diverged_trades", 0) for s in statuses.values()))
            entry["funding_unknown_trades"] = (
                entry["trades"] - entry["funding_complete_in_original"] - entry["funding_reconciled_aside"])
            if not registered and active:
                entry["note"] = ("active in the registry but not in the forward file: measured only when the runner "
                                 "gets --strategies-db")
            elif not entry["measured"]:
                entry["note"] = "never reached the runner: no status row for any product"
            elif not trades:
                entry["note"] = "measured with no trades: the signal has not fired (no entry was forced)"
            out[strategy_id] = entry
    finally:
        if db is not None:
            db.close()
    funding = {}
    if market_db and os.path.exists(market_db):
        for product_id, _ in resolve_products():
            periods = load_periods(market_db, product_id)
            funding[product_id] = {"periods": len(periods), "first_ms": periods[0][0] if periods else None,
                                   "last_ms": periods[-1][0] if periods else None,
                                   "last_age_h": round((now_ms - periods[-1][0]) / HOUR_MS, 1) if periods else None}
    return {"schema": AUDIT_SCHEMA, "audited_ms": now_ms, "strategies": out, "funding_periods_in_market_db": funding}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only audit of the forward measurement.")
    parser.add_argument("--forward-db", required=True)
    parser.add_argument("--market-db")
    parser.add_argument("--strategies-db")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--registration", default=FORWARD_STRATEGIES_PATH)
    parser.add_argument("--out", help="write the report here (default: print it)")
    args = parser.parse_args(argv)
    candidates = None
    if args.strategies_db:
        from .futures_strategy_registry import forward_candidates
        candidates = forward_candidates(args.strategies_db)
    body = audit(args.forward_db, load_registration(args.registration), load_specs(args.specs_dir),
                 candidates, args.market_db)
    text = json.dumps(body, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    main()
