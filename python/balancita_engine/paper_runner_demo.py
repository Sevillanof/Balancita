"""Reproducible demo of a whole paper session (stage 8C): offline, isolated, synthetic events, no network, no clock.

    python -m balancita_engine.paper_runner_demo run     DIR            # one uninterrupted process
    python -m balancita_engine.paper_runner_demo compare WORKDIR        # continuous vs. killed and recovered elsewhere
    python -m balancita_engine.paper_runner_demo informe FILE.md        # the same, written as a report

``compare`` runs the same events twice. First in one process. Then in a chain of independent processes, each one killed
(``os._exit``, no cleanup) at a different point of the write path, the next one recovering from the files the dead one left
behind and redelivering every event. It prints the summary block of both runs and fails (exit code 1) unless the final
financial state, the accounting hashes and the decision records are identical.

The numbers come from the real engine fed with the events built here; nothing is typed in by hand. The session exercises:
a long closed at its target, a short closed between candles by a quote far beyond the stop (a loss larger than planned),
a third signal rejected by the open-risk limit, a signal that expires without a quote, a position still open at the end,
funding that arrives after the close, a contradictory version of it that goes to quarantine and reclassifies the gain,
redelivered duplicates and one hole in the quotes stream that nobody declared.

Nothing here touches the forward, ``capture``, Kronos, Qwen, any database or any public feed.
"""

import json
import os
import shutil
import subprocess
import sys
from decimal import Decimal

from . import paper_runner_store as ST
from . import signal_continuity as SC
from .paper_runner import PaperRunner, RunnerConfig, make_event
from .paper_runner_report import counts, integrated_audit, summary_block
from .portfolio_audit import accounting_digest
from .portfolio_scenarios import ScriptedStrategy

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
T0 = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
T1 = T0 + 5 * MIN
BTC, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
SOURCE = "demo-feed"
BUY, SELL = {"action": "BUY", "strength": "0.8"}, {"action": "SELL", "strength": "0.8"}
SCRIPT = {(BTC, T0): BUY, (ETH, T0): SELL, (SOL, T0): BUY, (SOL, T1): BUY, (BTC, T1): BUY}
PRICES = {BTC: ("100000", "1000"), ETH: ("3500", "70"), SOL: ("180", "4.5")}
# Funding is known for ETH and SOL from the start; BTC's arrives late (and then a contradictory version of it).
KNOWN_FUNDING = tuple((p, ((T0 - 2 * HOUR, T0 + 48 * HOUR, "0.00001"),)) for p in (ETH, SOL))
# Four deaths, each in a different place: after deciding an entry (A/B), right after the candle that closes the long (D),
# after journaling the reconciliation of late funding (E) and in the middle of writing the contradictory funding (F).
CRASH_PLAN = (("after_journal", "decision", 1), ("after_apply", "event_accepted", 9), ("after_journal", "reconciliation", 1),
              ("mid_journal", "event_accepted", 1))


def config():
    return RunnerConfig(funding=KNOWN_FUNDING, start_ms=T0 - HOUR)


def strategies():
    return [ScriptedStrategy("scripted-a", SCRIPT)]


def _quote(product, t, mid, half_bps="0.5"):
    mid, half = D(mid), D(half_bps) / D(10_000)
    return {"product_id": product, "time_ms": t, "received_ms": t, "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}


def _candle(product, bucket, o, h, l, c):     # noqa: E741
    return {"product_id": product, "bucket_ms": bucket,
            "candle": {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}}


def _cycle(product, at, t):
    price, atr = PRICES[product]
    return {"product_id": product, "cycle_ms": at, "price": price, "atr": atr}


def events():
    """The session, in arrival order. Each source stream numbers its own events from 1; the quotes stream loses one."""
    raw = [
        (T0 + 2 * SEC, "cycle", "cycles", _cycle(BTC, T0, 0)),
        (T0 + 3 * SEC, "cycle", "cycles", _cycle(ETH, T0, 0)),
        (T0 + 4 * SEC, "cycle", "cycles", _cycle(SOL, T0, 0)),
        (T0 + 6 * SEC, "quote", "quotes", _quote(BTC, T0 + 6 * SEC, "100010")),
        (T0 + 7 * SEC, "quote", "quotes", _quote(ETH, T0 + 7 * SEC, "3500")),
        (T0 + 8 * SEC, "quote", "quotes", _quote(SOL, T0 + 8 * SEC, "180")),                 # no room left: rejected
        (T0 + 25 * SEC, "quote", "quotes", _quote(ETH, T0 + 25 * SEC, "3650")),              # far beyond the 3640 stop
        (T0 + 2 * MIN, "candle", "candles", _candle(BTC, T0 + MIN, 100010, 100100, 99900, 100010)),
        (T0 + 2 * MIN, "candle", "candles", _candle(ETH, T0 + MIN, 3660, 3670, 3640, 3650)),
        (T0 + 3 * MIN, "candle", "candles", _candle(BTC, T0 + 2 * MIN, 100010, 103500, 100000, 103400)),
        (T0 + 3 * MIN + 10 * SEC, "quote", "quotes", _quote(BTC, T0 + 3 * MIN + 10 * SEC, "103400")),
        (T1 + 2 * SEC, "cycle", "cycles", _cycle(SOL, T1, 0)),
        (T1 + 3 * SEC, "cycle", "cycles", _cycle(BTC, T1, 0)),
        (T1 + 6 * SEC, "quote", "quotes", _quote(SOL, T1 + 6 * SEC, "180")),                  # SOL opens and stays open
        (T1 + 3 * MIN, "quote", "quotes", _quote(BTC, T1 + 3 * MIN, "103500")),               # too late for the BTC signal
        (T1 + 4 * MIN, "candle", "candles", _candle(SOL, T1 + 3 * MIN, 180, 181, 179, 180.5)),
        (T0 + HOUR + 5 * MIN, "funding", "funding", {"product_id": BTC, "periods": [[T0 - HOUR, T0 + HOUR, "0.0001"]]}),
        (T0 + HOUR + 10 * MIN, "funding", "funding", {"product_id": BTC, "periods": [[T0 - HOUR, T0 + HOUR, "0.0002"]]}),
    ]
    raw.sort(key=lambda row: row[0])
    next_offset, out = {}, []
    for t, kind, stream, payload in raw:
        offset = next_offset.get(stream, 0) + 1
        if stream == "quotes" and offset == 4:
            offset += 1                      # the producer's 4th quote never arrives: a hole nobody declares
        next_offset[stream] = offset
        out.append(make_event(kind, payload, t_ms=t, source=SOURCE, stream=stream, source_offset=offset))
    # delivery noise a real source produces: the same messages again, at the end
    return out + [dict(out[3]), dict(out[-2])]


END_MS = T0 + 2 * HOUR


def feed(runner, evs, crash=None):
    """Delivers every event (redelivering what a recovered process has already seen) and finishes the session."""
    if crash is not None:
        ST.arm(crash[0], crash[2], crash[1])      # (point, kind, nth)
    at = runner.clock
    try:
        for event in evs:
            at = event["t_ms"]
            runner.handle(event)
        if runner.status == "PROCESSING":
            runner.finish(max(runner.clock, END_MS))
    except SC.SimulatedCrash:
        return at
    finally:
        ST.disarm()
        SC.disarm()
    return None


def digests(runner):
    return {"financial": runner.financial_digest(), "accounting": accounting_digest(runner.portfolio),
            "ledger": runner.portfolio.ledger_hash(), "executor": runner.executor.ledger_hash(),
            "positions": sorted(b.intent["intent_id"] for b in runner.portfolio.positions.values()),
            "trades": sorted(t["trade_id"] for t in runner.portfolio.trades),
            "capital_log": [(e["kind"], e["delta_usd"]) for e in runner.portfolio.capital_log],
            "adjustments": [a["hash"] for a in runner.portfolio.adjustments],
            "reclassifications": [r["hash"] for r in runner.portfolio.reclassifications]}


def step(directory, recovery_ms=None, crash=None):
    """One process of the chain: create or recover, deliver everything, finish. Returns what happened."""
    if recovery_ms is None:
        runner = PaperRunner.create(directory, config(), strategies())
    else:
        runner = PaperRunner.recover(directory, config(), strategies(), recovery_ms)
    crashed_at = feed(runner, events(), crash)
    if crashed_at is not None:
        return {"crashed_at_ms": crashed_at}
    return {"done": True, "digests": digests(runner), "block": summary_block(runner), "counts": _plain(counts(runner)),
            "audit": integrated_audit(runner)["violations"], "recoveries": runner.recoveries,
            "report_digest": runner.report()["digests"]}


def _plain(value):
    return json.loads(json.dumps(value, default=str))


def _child(args):
    """Run ``step`` in a brand-new interpreter. A crash is ``os._exit``: no ``finally``, no flush, no release of anything."""
    code = ("import json, os, sys\nfrom balancita_engine import paper_runner_demo as M\n"
            "a = json.loads(sys.argv[1])\n"
            "out = M.step(a['dir'], a.get('recovery_ms'), tuple(a['crash']) if a.get('crash') else None)\n"
            "print(json.dumps(out), flush=True)\n"
            "os._exit(77 if 'crashed_at_ms' in out else 0)\n")
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(filter(None, [os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                                       os.environ.get("PYTHONPATH", "")])))
    proc = subprocess.run([sys.executable, "-c", code, json.dumps(args)], capture_output=True, text=True, env=env, timeout=300)
    if proc.returncode not in (0, 77):
        raise RuntimeError("child failed: " + proc.stderr)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def run_continuous(directory):
    return _child({"dir": directory})


def run_interrupted(directory, plan=CRASH_PLAN):
    """Kill a process at each point of ``plan``; every next process recovers from the wreckage; the last one finishes."""
    history, recovery_ms = [], None
    for crash in plan:
        out = _child({"dir": directory, "recovery_ms": recovery_ms, "crash": list(crash)})
        if "crashed_at_ms" not in out:
            raise RuntimeError("the planned fault never fired: {}".format(crash))
        history.append({"crash": list(crash), "crashed_at_ms": out["crashed_at_ms"]})
        recovery_ms = out["crashed_at_ms"]
    final = _child({"dir": directory, "recovery_ms": recovery_ms})
    final["history"] = history
    return final


def compare(workdir):
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir)
    continuous = run_continuous(os.path.join(workdir, "continuous"))
    recovered = run_interrupted(os.path.join(workdir, "recovered"))
    keys = ("financial", "accounting", "ledger", "executor", "positions", "trades", "capital_log", "adjustments",
            "reclassifications")
    identical = {k: continuous["digests"][k] == recovered["digests"][k] for k in keys}
    return {"continuous": continuous, "recovered": recovered, "identical": identical, "all_identical": all(identical.values())}


def informe(workdir):
    """Markdown report of the demo session: operations, rejections, risks and results, plus the comparison. All of it is
    read from the engine's own report (``observability``), never typed in."""
    result = compare(workdir)
    runner = PaperRunner.recover(os.path.join(workdir, "continuous"), config(), strategies(), END_MS + HOUR)
    try:
        report = runner.report()
    finally:
        runner.close()
    sim, unc = report["sections"]["simulated"]["data"], report["sections"]["uncertain"]["data"]
    obs = report["sections"]["observed"]["data"]
    rows = ["# Informe de la sesión demo del paper runner (etapa 8C)", "",
            "Generado por `python -m balancita_engine.paper_runner_demo informe`. Eventos sintéticos y reproducibles; todos los",
            "números salen del motor real (`paper_runner_report.observability`). No mide rentabilidad: mide integración,",
            "consistencia, recuperación y trazabilidad.", "", "## Resultado", "", "```text", result["continuous"]["block"].rstrip(), "```", "",
            "## Operaciones y decisiones", "",
            "| Producto | Lado | Estado | Motivo | Resultado | P&L (USD) | Funding |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for d in sim["decisions"]:
        funding = "-" if d["funding"] is None else "{}{}".format(d["funding"]["status"], " (disputado)" if d["funding"]["disputed"] else "")
        rows.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            d["product_id"], d["side"], d["state"], ", ".join(d["reasons"]) or "-", d["result"],
            "-" if d["pnl_usd"] is None else d["pnl_usd"], funding))
    rows += ["", "## Rechazos", ""]
    rejected = [d for d in sim["decisions"] if d["state"] in ("rejected", "expired", "cancelled")]
    rows += ["- {} {}: {}".format(d["product_id"], d["side"], ", ".join(d["reasons"]) or d["state"]) for d in rejected] or ["- ninguno"]
    rows += ["", "Eventos rechazados por el runner: " + (", ".join("{} ({})".format(k, v) for k, v in obs["events"]["by_reason"].items())
                                                          or "ninguno"), "", "## Riesgos y alertas", ""]
    rows += ["- `{}` ({}): {}".format(a["code"], a["severity"], json.dumps(a["detail"], sort_keys=True)[:160])
             for a in report["alerts"]] or ["- ninguna"]
    rows += ["", "Funding en cuarentena: " + (json.dumps(unc["funding"]["quarantined_periods"], sort_keys=True) or "{}"),
             "Posiciones abiertas y vigilancia de su stop: " + (", ".join("{} {}".format(x["product_id"], x["stop_protection"])
                                                                         for x in unc["market_coverage"]) or "ninguna"),
             "", "## Comparación entre ejecución continua y recuperada", "",
             "La ejecución recuperada murió {} veces (`os._exit`, sin limpieza); cada proceso nuevo recuperó desde los archivos".format(
                 len(result["recovered"]["history"])),
             "y recibió de nuevo todos los eventos.", "", "| Punto de la muerte | Recuperación (ms) |", "| --- | --- |"]
    rows += ["| {} / {} (n.º {}) | {} |".format(h["crash"][0], h["crash"][1], h["crash"][2], h["crashed_at_ms"]) for h in result["recovered"]["history"]]
    rows += ["", "| Comprobación | Continua = recuperada |", "| --- | --- |"]
    rows += ["| {} | {} |".format(k, "sí" if v else "NO") for k, v in result["identical"].items()]
    rows += ["", "Hash financiero continuo: `{}`".format(result["continuous"]["digests"]["financial"]),
             "Hash financiero recuperado: `{}`".format(result["recovered"]["digests"]["financial"]), ""]
    return "\n".join(rows), result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or argv[0] not in ("run", "compare", "informe"):
        print(__doc__)
        return 2
    if argv[0] == "informe":
        import tempfile
        work = tempfile.mkdtemp()
        try:
            text, result = informe(work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        with open(argv[1], "w", encoding="utf-8") as handle:
            handle.write(text)
        return 0 if result["all_identical"] else 1
    if argv[0] == "run":
        shutil.rmtree(argv[1], ignore_errors=True)
        print(run_continuous(argv[1])["block"])
        return 0
    result = compare(argv[1])
    block = result["continuous"]["block"].replace("Hash ejecución recuperada: " + result["continuous"]["digests"]["financial"][:32],
                                                 "Hash ejecución recuperada: " + result["recovered"]["digests"]["financial"][:32])
    print(block)
    rec = result["recovered"]
    print("EJECUCIÓN RECUPERADA (procesos independientes)")
    print("Procesos caídos antes de terminar: {}".format(len(rec["history"])))
    for h in rec["history"]:
        print("  - muerte en {} de '{}' (n.º {}), recuperación a las {}".format(h["crash"][0], h["crash"][1], h["crash"][2], h["crashed_at_ms"]))
    print("Recuperaciones:            {}".format(rec["recoveries"]))
    print("Eventos duplicados:        {}  (reentrega completa tras cada caída)".format(rec["counts"]["duplicates"]))
    print("Violaciones contables:     {}".format(len(rec["audit"])))
    print("Coinciden: " + ", ".join("{}={}".format(k, "sí" if v else "NO") for k, v in result["identical"].items()))
    return 0 if result["all_identical"] else 1


if __name__ == "__main__":
    sys.exit(main())
