"""Read-only instrumentation of the strategy gate's simulator: signals, discards, exit evidence and cost breakdown.

``TracedBook`` is a ``Book`` that only OBSERVES: every decision, price and trade is the one ``Book`` produces (the
tests pin that a traced run books the same trades as a plain one). It adds, per product:

* ``signal`` rows: every LONG/SHORT proposal with what became of it (``accepted``, ``rejected_<reason>``,
  ``rejected_stale_data``, ``position_open``). WAIT / ABSTAIN proposals are NOT rows (there would be millions): they are
  counted by reason in the ``summary`` row.
* ``trade`` rows: for each closed trade the conditions the simulator evaluated at entry and, for a ``strategy_exit``,
  at the exit minute (value, operator, threshold, passed), the exit candle, and a cost breakdown.

Cost breakdown (``kraken-futures-costs.v2``): gross (reference prices) minus execution (modelled impact, which already
includes half the spread; a stop also pays a full spread) minus taker fees minus funding. An unknown funding is
``null`` and stays out of the sum: it is never counted as zero.

``python -m balancita_engine.gate_trace --run 14 --cache-dir CACHE --out DIR`` replays a stored practice run with the same
code and checks it reproduces the stored trades (``--data-dir`` holds ``artifacts/<run>/``).
"""

import argparse
import collections
import gzip
import hashlib
import json
import os
import sys
from decimal import Decimal

from .futures_costs import fee_rate, stop_exit_bps, side_impact_bps
from .futures_simulator import Book
from .futures_spec_strategy import propose_spec

TRACE_SCHEMA = "balancita.gate-trace.v1"
TRACE_FILE = "trace.jsonl.gz"
D = Decimal
SIDES = ("LONG", "SHORT")


def _text(value):
    return None if value is None else str(value)


def _bp(usd, notional):
    return None if usd is None else float(round(usd / notional * 10_000, 4))


def cost_breakdown(trade, fill, reference_entry, notional, product):
    """Gross, execution, fees, funding and net of one closed trade, in USD and bp; ``None`` where unknown.

    ``gross - entry_execution - exit_execution - fees - funding == net`` up to the simulator's rounding
    (``reconciles``). ``funding_usd`` is ``None`` when no funding period covered the holding time.
    """
    sign = 1 if trade["side"] == "LONG" else -1
    quantity, entry, exit_price = D(trade["quantity"]), D(trade["entry_price"]), D(trade["exit_price"])
    reference_exit = D(fill["reference_price"])
    gross = (reference_exit - reference_entry) * quantity * sign
    entry_execution = (entry - reference_entry) * quantity * sign
    exit_execution = (reference_exit - exit_price) * quantity * sign
    fees = (entry + exit_price) * quantity * fee_rate("taker")
    funding = None if trade["funding_usd"] is None else D(str(trade["funding_usd"]))
    net = D(str(trade["pnl_usd"]))
    rebuilt = gross - entry_execution - exit_execution - fees - (funding or D(0))
    return {
        "gross_usd": _text(gross), "entry_execution_usd": _text(entry_execution),
        "exit_execution_usd": _text(exit_execution), "fees_usd": _text(fees),
        "funding_usd": None if funding is None else _text(funding), "funding_status": trade["funding_status"],
        "net_usd": _text(net),
        "gross_bp": _bp(gross, notional), "execution_bp": _bp(entry_execution + exit_execution, notional),
        "fees_bp": _bp(fees, notional), "funding_bp": _bp(funding, notional), "net_bp": trade["net_bp"],
        "reconciles": abs(rebuilt - net) <= D("0.0002"),
        "model": {"entry_impact_bp": _text(side_impact_bps(product)),
                  "exit_bp": _text(0 if trade["exit_reason"] == "target" else
                                   stop_exit_bps(product) if trade["exit_reason"] == "stop" else side_impact_bps(product)),
                  "spread_note": "the impact already includes half the spread; only a stop adds a full spread"},
    }


class TracedBook(Book):
    """A ``Book`` that records what it decided. It changes nothing it books."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.signals = []
        self.evidence = []                   # parallel to ``trades``
        self.counts = collections.Counter()  # "WAIT:entry_conditions_not_met", "frames:not_ready", ...
        self._last = None
        self._entry_conditions = None
        self._exit_conditions = None
        self._frame = None

    # -- observation hooks (pure: propose_spec has no side effects)

    def _entry_proposal(self, current, common):
        self._last = super()._entry_proposal(current, common)
        return self._last

    def _rule_exit(self, position, current, common, close):
        result = super()._rule_exit(position, current, common, close)
        if result is not None:
            again = propose_spec(self.spec, current, position_side=position["side"],
                                 delegated_strategy_id=position["delegated"], frozen_target=position["target_text"],
                                 frozen_invalidation=position["frozen_invalidation"], **common)
            self._exit_conditions = again["conditions"]
        return result

    def _signal(self, bucket, proposal, outcome):
        self.counts["{}:{}".format(proposal["action"], outcome)] += 1
        self.signals.append({"bucket_ms": bucket, "side": proposal["action"], "outcome": outcome,
                             "reason_code": proposal["reason_code"], "stop": proposal.get("proposed_stop"),
                             "target": proposal.get("proposed_target")})

    def on_frame(self, bucket, current, previous, trend, regime):
        self._last, self._frame = None, current
        was_open = self.position is not None
        skipped, decisions, blocked = len(self.skipped), len(self.decisions), len(self.blocked)
        super().on_frame(bucket, current, previous, trend, regime)
        if was_open:
            self.counts["frames:position_open"] += 1
            if current.get("ready"):
                proposal = propose_spec(self.spec, current, previous=previous, trend=trend, regime=regime,
                                        tick_size=self.tick_size)
                if proposal["action"] in SIDES:
                    self._signal(bucket, proposal, "position_open")
            return
        if not current.get("ready"):
            self.counts["frames:not_ready"] += 1
            return
        self.counts["frames:flat_ready"] += 1
        proposal = self._last
        if proposal is None:
            return
        if proposal["action"] not in SIDES:
            self.counts["{}:{}".format(proposal["action"], proposal["reason_code"])] += 1
            return
        if len(self.blocked) > blocked:
            self._signal(bucket, proposal, "rejected_stale_data")
        elif len(self.skipped) > skipped:
            self._signal(bucket, proposal, "rejected_" + self.skipped[-1]["reason"])
        elif self.position is not None and len(self.decisions) > decisions:
            self._signal(bucket, proposal, "accepted")
            self._entry_conditions = proposal["conditions"]
        else:
            self._signal(bucket, proposal, "rejected_unknown")

    def _finish(self, bucket, exit_price, reason, end_ms=None, executable=None, evidence=None, details=None):
        position = self.position
        entry_conditions, exit_conditions = self._entry_conditions, self._exit_conditions
        reference_entry = D(position["decision"]["reference_close"])
        frame = self._frame or {}
        self._entry_conditions = self._exit_conditions = None
        super()._finish(bucket, exit_price, reason, end_ms=end_ms, executable=executable, evidence=evidence,
                        details=details)
        trade, fill = self.trades[-1], self.fills[-1]
        self.evidence.append({
            "entry_time_ms": trade["entry_time_ms"], "exit_time_ms": trade["exit_time_ms"], "side": trade["side"],
            "exit_reason": reason, "entry_conditions": entry_conditions,
            "exit_conditions": exit_conditions if reason == "strategy_exit" else None,
            "exit_candle": {"bucket_ms": bucket, "open": frame.get("candidate_open"), "high": frame.get("candidate_high"),
                            "low": frame.get("candidate_low"), "close": frame.get("candidate_close")},
            "costs": cost_breakdown(trade, fill, reference_entry, self.notional, self.product)})

    def report(self, start_ms, end_ms):
        """``{"signals", "trades", "counts"}`` for the trades the gate keeps (same window filter as ``book_trades``)."""
        kept = [dict(ev, trade_ref=i) for i, (t, ev) in enumerate(zip(self.trades, self.evidence))
                if t["entry_time_ms"] >= start_ms and t["exit_time_ms"] <= end_ms]
        return {"signals": [s for s in self.signals if s["bucket_ms"] >= start_ms], "trades": kept,
                "counts": dict(self.counts)}


# --------------------------------------------------------------------------- artifact


def trace_lines(run_id, spec_hash_value, per_product):
    """JSON lines for the run's ``trace.jsonl.gz``: ``per_product`` is ``[(product, start_ms, end_ms, report)]``."""
    lines = []
    for product, start_ms, end_ms, report in sorted(per_product, key=lambda item: item[0]):
        base = {"schema": TRACE_SCHEMA, "run_id": run_id, "spec_hash": spec_hash_value, "product_id": product}
        lines.append(dict(base, type="summary", from_ms=start_ms, to_ms=end_ms, counts=report["counts"]))
        lines.extend(dict(base, type="signal", **row) for row in report["signals"])
        lines.extend(dict(base, type="trade", **row) for row in report["trades"])
    return lines


def encode(lines):
    body = ("\n".join(json.dumps(line, sort_keys=True, ensure_ascii=False) for line in lines) + ("\n" if lines else "")).encode()
    return gzip.compress(body, mtime=0), hashlib.sha256(body).hexdigest()


def read_trace(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# --------------------------------------------------------------------------- replay of a stored run

COMPARED = ("side", "entry_time_ms", "entry_price", "stop_price", "target_price", "exit_time_ms", "exit_price",
            "exit_reason", "quantity", "notional_usd")


def replay(data_dir, run_id, cache_dir, out_dir, funding="none", products=None, provider=None):
    """Re-runs stored practice ``run_id`` with ``TracedBook`` and compares it with its stored trades.

    Reads only ``artifacts/<run_id>`` and the candle cache; writes ``<out_dir>/<run_id>/trace.jsonl.gz``. Returns a
    dict with per-product counts and every difference found. ``funding``: ``none`` (compare the price path and the
    exits; funding-dependent fields are not compared) or ``network`` (Kraken's public funding history).
    """
    from . import strategy_gate as g
    folder = os.path.join(data_dir, g.ARTIFACTS_DIR, str(run_id))
    with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest["kind"] != "practice" or manifest["range_end_ms_exclusive"] > g._date_ms(manifest["holdout_from"]):
        raise ValueError("only practice runs that end before the holdout are replayed")
    stored = [json.loads(line) for line in gzip.open(os.path.join(folder, manifest["trades_file"]), "rt")]
    provider = provider or g.KrakenProvider(cache_dir)
    ticks = dict(g.resolve_products(None))
    per_product, summary, differences = [], {}, []
    for product in products or manifest["products"]:
        rows = provider.funding(product) if funding == "network" else []
        job = {"index": 0, "label": "replay", "spec": manifest["spec"], "product": product, "tick": ticks[product],
               "start_ms": manifest["range_start_ms"], "end_ms": manifest["range_end_ms_exclusive"],
               "provider": provider, "funding": rows, "trade_source": None, "want_closes": True, "trace": True}
        out = g.simulate_task(job)
        mine = [t for t in stored if t["product_id"] == product]
        again = sorted(out["full_trades"], key=lambda t: (t["entry_time_ms"], t["side"]))
        mine.sort(key=lambda t: (t["entry_time_ms"], t["side"]))
        summary[product] = {"stored": len(mine), "replayed": len(again)}
        if len(mine) != len(again):
            differences.append("{}: {} stored vs {} replayed trades".format(product, len(mine), len(again)))
        for a, b in zip(mine, again):
            bad = [k for k in COMPARED if str(a[k]) != str(b[k])]
            if bad:
                differences.append("{} {}: {}".format(product, a.get("trade_id"), bad))
        per_product.append((product, manifest["range_start_ms"], manifest["range_end_ms_exclusive"], out["trace"]))
    data, digest = encode(trace_lines(run_id, manifest["spec_hash"], per_product))
    os.makedirs(os.path.join(out_dir, str(run_id)), exist_ok=True)
    with open(os.path.join(out_dir, str(run_id), TRACE_FILE), "wb") as handle:
        handle.write(data)
    return {"run_id": run_id, "spec_hash": manifest["spec_hash"], "products": summary, "differences": differences,
            "trace_sha256": digest}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--run", type=int, required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--funding", choices=("none", "network"), default="none")
    args = parser.parse_args(argv)
    result = replay(args.data_dir, args.run, args.cache_dir, args.out, args.funding)
    print(json.dumps(result, indent=1))
    return 1 if result["differences"] else 0


if __name__ == "__main__":
    sys.exit(main())
