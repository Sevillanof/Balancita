"""Runs the offline scenarios and writes the report, the journals and the machine-readable results.

    PYTHONPATH=python python3 -m balancita_engine.portfolio_report --out analisis/validacion-cartera-offline

Nothing here depends on the clock, the network or any database; running it twice gives byte-identical files.
"""

import argparse
import json
import os
import tempfile
from decimal import Decimal

from .futures_costs import cost_model_hash
from .multi_signals import stable_hash
from .portfolio import PortfolioPolicy
from . import portfolio_two_process as TP
from .portfolio_offline import ONE_MINUTE_MS, Journal, run_scenario
from .portfolio_scenarios import all_scenarios

D = Decimal

CAPABILITIES = [
    # (capacidad, estado, dónde / qué falta)
    ("Idempotencia de intenciones y señales (`intent_id`, `signal_id`, lotes)", "existe", "`portfolio.py`; vive solo en memoria: se pierde al reiniciar si no se restaura estado"),
    ("Orden temporal (decisión retroactiva, vela no más nueva, datos del futuro)", "existe", "`portfolio.py`; también en memoria"),
    ("Idempotencia de **eventos** (misma vela o señal entregada dos veces, vela conflictiva o tardía)", "nuevo, solo en el ejecutor offline", "`portfolio_offline.py`; no existe en el forward para la cartera"),
    ("**1. Recuperación desde checkpoint persistido** (digest, huella de configuración, digest canónico del estado)", "nuevo, **demostrado entre dos procesos Python**", "`portfolio_offline` + `portfolio_two_process`. Mismo patrón que `multi_experiment` (pickle + digest + fingerprint). `Portfolio` no tiene guardado propio ni hay persistencia en el forward"),
    ("**2. Recuperación del diario desde disco** (JSONL, fsync por entrada, cadena de hashes)", "nuevo, **demostrado entre dos procesos Python**", "Ausente, vacío, alterado, con basura, con la cola cortada, reordenado, truncado o de otro escenario: rechazado (ver matriz). Falta decidir dónde vive y quién lo escribe en producción"),
    ("Escritura atómica del checkpoint (temporal + fsync + rename)", "nuevo, probado con archivo temporal", "Sin probar corrupción parcial más allá del digest"),
    ("**3. Reproducción de señales desde una fuente durable**", "**pendiente para el forward**", "Las velas sí se guardan (`capture`); las **señales** no tienen registro durable para la cartera. En la prueba de dos procesos las entradas se reconstruyen desde la definición del escenario: es un sustituto, no una fuente real"),
    ("Recuperar señales generadas mientras el proceso estaba caído", "**falta** (consecuencia del punto 3)", "Se pierden (escenario `live_gap`, también entre dos procesos); el sistema ni siquiera puede detectar que faltan"),
    ("Recuperar velas perdidas durante la caída", "existe en el forward (`futures_forward`: relleno de huecos, etiqueta `recovered`)", "No está conectado a la cartera; aquí se simula con velas reentregadas en orden"),
    ("Checkpoint/restauración de libros del experimento multiestrategia (100 USD fijos)", "existe", "`multi_experiment` + `multi_store`; no cubre `Portfolio`"),
    ("Reconciliar funding de una operación ya cerrada cuando llega tarde", "existe para el forward (`futures_funding_reconcile`)", "**Falta** para la cartera: una operación `net_complete=false` queda así y no se reclasifica ni reabre el capital definitivo"),
    ("Primer precio ejecutable posterior a la señal", "**falta**", "El módulo abre al precio de la intención (cierre de la vela de la señal) más impacto; conectarlo al forward lo exige"),
    ("Huecos de precio sobre el stop", "**falta** en el simulador", "`Book` sale siempre al precio del stop; un hueco no empeora la pérdida modelada"),
    ("Verificación independiente de límites y de la contabilidad", "nuevo", "`portfolio_offline._check_*` recalcula desde operaciones y posiciones crudas"),
]


def _usd(value):
    return "{:+.2f}".format(D(str(value)))


def _clock(scenario, t_ms):
    minutes = (t_ms - scenario["start_ms"]) // ONE_MINUTE_MS
    return "m+{:03d}".format(minutes)


def _scenario_result(scenario, run):
    snap = run["snapshot"]
    trades = run["executor"].portfolio.trades
    complete = [t for t in trades if t["net_complete"]]
    partial = [t for t in trades if not t["net_complete"]]
    decisions = run["executor"].portfolio.decisions
    reasons = {}
    for d in decisions:
        for reason in d.get("reasons", ()):
            reasons[reason] = reasons.get(reason, 0) + 1
    return {
        "name": scenario["name"], "description": scenario["description"], "scenario_hash": scenario["scenario_hash"],
        "events": len(scenario["events"]), "feed_hash": run["feed_hash"], "ledger_hash": run["ledger_hash"],
        "state_digest": run["state_digest"], "journal_hash": run["journal_hash"], "journal_entries": run["journal_entries"],
        "journal_chain_intact": run["journal_chain_intact"], "time_order_ok": run["time_order_ok"],
        "checks": run["checks"], "violations": run["violations"], "stats": run["stats"],
        "opened": len([d for d in decisions if d["status"] == "opened"]),
        "rejected": len([d for d in decisions if d["status"] == "rejected"]), "rejection_reasons": dict(sorted(reasons.items())),
        "verified": {"trades": len(complete), "net_usd": str(sum((D(str(t["net_usd"])) for t in complete), D(0))),
                     "fees_usd": str(sum((D(str(t["fees_usd"])) for t in complete), D(0))),
                     "funding_usd": str(sum((D(str(t["funding_usd"])) for t in complete if t["funding_usd"] is not None), D(0)))},
        "provisional": {"trades": len(partial), "partial_usd": str(sum((D(str(t["pnl_usd"])) for t in partial), D(0))),
                        "gains_excluded_from_capital_usd": snap["provisional_gains_usd"],
                        "losses_included_in_capital_usd": str(sum((min(D(0), D(str(t["pnl_usd"]))) for t in partial), D(0))),
                        "open_unrealized_usd": snap["unrealized_usd"], "open_positions": snap["open_positions"],
                        "funding_status": sorted({t["funding_status"] for t in partial})},
        "capital_definitive_usd": snap["capital_definitive_usd"], "equity_usd": snap["equity_usd"],
        "restart": None if run["restart"] is None else {k: v for k, v in run["restart"].items() if k != "restored_from"},
    }


def _table(rows, headers):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


def _timeline(scenario, journal):
    rows = []
    for e in journal.entries:
        d, t = e["data"], _clock(scenario, e["t_ms"])
        epoch = "" if e["epoch"] == 0 else " (época {})".format(e["epoch"])
        flag = " ↺" if d.get("replay") else ""
        if e["kind"] == "decision" and d["status"] == "opened":
            rows.append((e["seq"], t, "ABRE" + flag, "{} {}".format(d["product_id"], d["side"]),
                         "nocional {} · pérdida plan. {} de presupuesto {} · límites: {}".format(d["notional_usd"], str(d["planned_loss_usd"])[:6], str(d["risk_budget_used_usd"])[:6], ", ".join(d["limits_applied"]) or "ninguno"),
                         "capital {}".format(str(d["capital_definitive_usd"])[:9])))
        elif e["kind"] == "decision":
            rows.append((e["seq"], t, "RECHAZA" + flag, "{} {}".format(d["product_id"], d["side"]), ", ".join(d["reasons"]), ""))
        elif e["kind"] == "position_closed":
            rows.append((e["seq"], t, "CIERRA" + flag, "{} {}".format(d["product_id"], d["side"]),
                         "{} · P&L {} (bruto {}, comisiones {}, funding {}) · {} / funding {}".format(
                             d["exit_reason"], _usd(d["pnl_usd"]), _usd(d["gross_usd"]), str(d["fees_usd"])[:6],
                             "sin dato" if d["funding_usd"] is None else d["funding_usd"], d["accounting"], d["funding_status"]),
                         "capital {} → {}".format(str(d["capital_before_usd"])[:9], str(d["capital_after_usd"])[:9])))
        elif e["kind"] in ("signal_invalid", "intent_not_built", "duplicate_candle_ignored", "conflicting_candle_rejected",
                           "late_candle_refused", "candle_gap", "duplicate_events_ignored", "checkpoint_saved", "restart",
                           "simulation_note", "invariant_violation"):
            detail = {"signal_invalid": "firma no coincide con el contenido", "intent_not_built": d.get("reason", ""),
                      "duplicate_candle_ignored": "misma vela repetida", "conflicting_candle_rejected": "misma vela con otro contenido: gana la primera",
                      "late_candle_refused": "vela anterior a la última procesada", "candle_gap": "faltan {} minutos".format(d.get("missing_minutes")),
                      "duplicate_events_ignored": "{} eventos ya vistos".format(d.get("count")),
                      "checkpoint_saved": "digest de estado {}…".format(str(d.get("state_digest"))[:10]),
                      "restart": "restaurado desde checkpoint {}; {} entradas posteriores descartadas".format(
                          _clock(scenario, d.get("checkpoint_arrival_ms", 0)), d.get("uncommitted_tail_entries")),
                      "simulation_note": d.get("note", ""), "invariant_violation": d.get("rule", "")}[e["kind"]]
            rows.append((e["seq"], t + epoch if epoch else t, e["kind"] + flag, d.get("product_id", ""), detail, ""))
    return rows


REFUSAL_TEXT = {
    "diario_ausente": "el archivo del diario no existe", "diario_vacio": "el archivo existe pero está vacío",
    "diario_con_entrada_alterada": "una entrada editada (la cadena de hashes ya no cierra)", "diario_con_linea_basura": "una línea que no es JSON",
    "diario_con_cola_cortada": "la última línea cortada a la mitad (escritura interrumpida)", "diario_reordenado": "dos entradas intercambiadas",
    "diario_truncado_valido": "prefijo válido de la cadena, más corto que la posición del checkpoint",
    "diario_de_otro_escenario": "diario válido pero escrito para otro escenario", "checkpoint_ausente": "no hay checkpoint",
    "checkpoint_alterado": "un byte del checkpoint cambiado"}


def _two_process_section(recovery):
    rows = [(mode, "sí" if r["equivalent_ledger"] else "NO", "sí" if r["equivalent_state"] else "NO", "sí" if r["equivalent_feed"] else "NO",
             "sí" if r["positions_equal"] else "NO", "sí" if r["capital_equal"] else "NO", "sí" if r["journal_equals_single_process"] else "NO",
             "sí" if r["journal_on_disk_verifies"] else "NO") for mode, r in recovery["modes"].items()]
    out = ["### Prueba entre dos procesos Python independientes", "",
           "El primer proceso escribe checkpoint y diario en disco y termina por completo. El segundo, un intérprete nuevo, recupera ambos desde disco, restaura, se pone al día y completa el escenario; no comparte memoria con el primero. Se compara con una ejecución ininterrumpida.", "",
           _table(rows, ["Modo", "Libro igual", "Estado igual", "Velas igual", "Posiciones iguales", "Capital igual", "Diario igual a 1 proceso", "Diario en disco verifica"]), "",
           "`replay_log` es equivalente porque las entradas se vuelven a entregar completas. `live_gap` **debe seguir difiriendo**: las señales emitidas durante la caída no existen para el proceso nuevo, y que difiera es lo que demuestra que perderlas cambia el resultado. Al final de estos escenarios no queda ninguna posición abierta, así que «posiciones iguales» es trivial al cierre; que el checkpoint se tomó con una posición abierta y la restauración la reproduce exactamente lo comprueba `test_the_checkpoint_was_taken_with_a_position_open`.", "",
           "**Rechazos: ningún archivo ausente, corrupto o ajeno se recupera en silencio.** Cada caso es un proceso nuevo sobre archivos saboteados; ninguno escribió resultado.", "",
           _table([(case, REFUSAL_TEXT[case], reason, "sí" if code == 3 and not wrote else "NO") for case, (code, reason, wrote) in recovery["refusals"].items()],
                  ["Caso", "Qué se estropeó", "Motivo del rechazo", "Rechazado sin resultado"])]
    return out


def build_report(results, runs, recovery):
    pol = PortfolioPolicy()
    lines = ["# Validación integral offline de la cartera compartida de 1.000 USD", "",
             "Solo datos sintéticos. Sin forward, Kronos, Qwen, `capture`, colectores, bases activas ni holdout. Sin órdenes reales ni credenciales. "
             "Parámetros de riesgo aprobados, sin cambios (`PortfolioPolicy` por defecto, hash `{}`); modelo de costes `{}`.".format(pol.policy_hash(), cost_model_hash()[:12] + "…"),
             "", "## Resumen", ""]
    rows = []
    for r in results:
        rows.append((r["name"], r["events"], r["opened"], r["rejected"], r["verified"]["trades"], r["provisional"]["trades"],
                     r["capital_definitive_usd"][:9], "{}/{}".format(len(r["violations"]), r["checks"]),
                     "sí" if r["journal_chain_intact"] and r["time_order_ok"] else "NO"))
    lines += [_table(rows, ["Escenario", "Eventos", "Abiertas", "Rechazadas", "Cierres verificados", "Cierres provisionales", "Capital definitivo", "Violaciones/comprobaciones", "Diario íntegro"]), ""]
    total_v = sum(len(r["violations"]) for r in results)
    lines += ["**{} violaciones de invariantes en {} comprobaciones.** Cada comprobación recalcula el límite o la identidad contable desde las operaciones y posiciones crudas, no desde el código de límites de `portfolio.py`.".format(
        total_v, sum(r["checks"] for r in results)), ""]
    lines += ["## Qué significa «verificado» y «provisional»", "",
              "- **Verificado**: operación cerrada con funding completo para todo el tiempo mantenido y producto con costes medidos. Su P&L neto entra en el capital definitivo, y la identidad `bruto − comisiones − funding = P&L` se recalcula aparte. «Verificado» quiere decir que la aritmética del simulador cuadra con la tabla de funding **sintética** de cada escenario; no dice nada sobre el mercado real.",
              "- **Provisional**: funding parcial o ausente. El P&L parcial se informa aparte. Una **ganancia provisional no suma capital ni presupuesto de riesgo**; una **pérdida provisional sí resta** (criterio conservador del prototipo). Su valor definitivo sigue desconocido.",
              "- **No realizado**: posiciones abiertas al final. Siempre provisional.", "",
              "El funding no se infiere: una operación sin cobertura queda con `funding_usd = null` y `net_usd = null`. No existe hoy un mecanismo para reclasificarla cuando el funding llegue (ver capacidades).", ""]
    lines += ["## Capacidades de recuperación: qué existe y qué falta", "",
              _table(CAPABILITIES, ["Capacidad", "Estado", "Dónde / qué falta"]), "",
              "**Un reinicio solo cuenta como recuperación si se restaura un estado persistido.** Volver a ejecutar el escenario desde el principio no lo es. `OfflineExecutor.restore` y `Journal.load` fallan, sin alternativa silenciosa, con `no_checkpoint`, `corrupt_checkpoint`, `configuration_changed`, `journal_missing`, `journal_corrupt`, `journal_incompatible`, `journal_mismatch`, `journal_chain_broken` o `state_mismatch`.", "",
              *_two_process_section(recovery), ""]
    for r, run in zip(results, runs):
        scenario = run["scenario"]
        lines += ["## {}".format(r["name"]), "", r["description"], ""]
        lines += [_table([
            ("Hash del escenario", "`{}`".format(r["scenario_hash"])), ("Hash de las velas aplicadas", "`{}`".format(r["feed_hash"])),
            ("Hash del libro (decisiones + operaciones)", "`{}`".format(r["ledger_hash"])), ("Digest del estado final", "`{}`".format(r["state_digest"])),
            ("Hash del diario ({} entradas, cadena íntegra: {})".format(r["journal_entries"], "sí" if r["journal_chain_intact"] else "NO"), "`{}`".format(r["journal_hash"]))],
            ["Qué", "Valor"]), ""]
        v, p = r["verified"], r["provisional"]
        lines += ["**Contabilidad verificada**: {} operaciones, P&L neto {} USD (comisiones {} USD, funding {} USD).".format(v["trades"], _usd(v["net_usd"]), v["fees_usd"][:8], v["funding_usd"][:8]),
                  "", "**Provisional**: {} operaciones con funding {}, P&L parcial {} USD; ganancias excluidas del capital {} USD; pérdidas incluidas {} USD; posiciones abiertas {} (no realizado {} USD).".format(
                      p["trades"], "/".join(p["funding_status"]) or "completo", _usd(p["partial_usd"]), p["gains_excluded_from_capital_usd"][:8],
                      p["losses_included_in_capital_usd"][:8], p["open_positions"], p["open_unrealized_usd"]),
                  "", "**Capital definitivo** {} USD · **equity** (con ganancias provisionales) {} USD · rechazos por motivo: {}.".format(
                      r["capital_definitive_usd"][:9], r["equity_usd"][:9], ", ".join("{} ×{}".format(k, n) for k, n in r["rejection_reasons"].items()) or "ninguno"), ""]
        if r["restart"]:
            x = r["restart"]
            lines += ["### Reinicio simulado (modo `{}`)".format(x["mode"]), "",
                      "- Proceso terminado en m+{} con el último checkpoint persistido (de {}); un proceso nuevo, construido solo desde ese checkpoint y el diario, reinicia en m+{}.".format(
                          x["crash_after_min"], _clock(scenario, x["checkpoint_arrival_ms"]), x["restart_at_min"]),
                      "- Lo ocurrido entre el checkpoint y la caída queda en el diario (época anterior) pero **sus efectos se descartan**.",
                      "- Equivalente a la ejecución sin interrupción: libro **{}**, estado **{}** (referencia: libro `{}…`, capital {} USD, {} cierres).".format(
                          "sí" if x["equivalent_ledger"] else "NO", "sí" if x["equivalent_state"] else "NO", x["reference_ledger_hash"][:12],
                          x["reference_capital_usd"][:9], x["reference_closed_trades"])]
            if x["mode"] == "replay_log":
                lines += ["- Esta equivalencia **supone** un registro durable de eventos que hoy no existe para las señales (ver capacidades). Las entregas repetidas se descartan por `event_id`."]
            else:
                lines += ["- Las señales emitidas tras el checkpoint y antes de volver ({}) **no se recuperan** y el sistema no puede saber que faltan. Por eso el resultado difiere de la ejecución sin caída: **esta divergencia es el hallazgo**, no un error de la prueba.".format(
                    ", ".join("`{}`".format(i) for i in x["lost_signal_events"]) or "ninguna en este escenario")]
            lines += [""]
        lines += ["### Registro cronológico (selección; completo en `journals/{}.jsonl`)".format(r["name"]), "",
                  _table(_timeline(scenario, run["journal"]), ["#", "Cuándo", "Qué", "Producto", "Detalle", "Capital"]), ""]
    lines += ["## Determinismo", "",
              "Cada escenario se ejecuta dos veces dentro del generador y el diario, el libro y el estado deben coincidir bit a bit; las pruebas lo repiten en procesos separados con distintos `PYTHONHASHSEED`. Sin reloj, sin red, sin `random` (el ruido de precios sale de SHA-256).", "",
              "## Limitaciones que este informe no oculta", "",
              "1. **Precio de entrada**: el módulo abre al precio de la intención (cierre de la vela de la señal) más el impacto del modelo de costes. Conectarlo al forward exigirá el primer precio ejecutable posterior a la señal; **no está resuelto**.",
              "2. **Stops sin huecos**: el simulador sale siempre al precio del stop; la pérdida de un stop coincide con la planificada (comprobado) porque el modelo no incluye huecos ni deslizamiento extra (`slippage_buffer_bps` = 0).",
              "3. **Velas y funding sintéticos**: demuestran que la mecánica cuadra, no que haya ventaja.",
              "4. **Un solo reinicio por escenario.** El checkpoint es un `pickle` de nuestro propio archivo (misma práctica que `multi_experiment`). Un diario con la cola cortada se **rechaza** entero; no se intenta reparar ni descartar la última línea (decisión pendiente si se llevara a producción). No se probó un corte en mitad de la escritura del checkpoint más allá de que el renombrado es atómico.",
              "5. **La fuente de entradas de la prueba entre procesos es un sustituto**: ambos procesos reconstruyen velas y señales desde la definición del escenario. Eso prueba la recuperación del estado y del diario, no que exista una fuente durable de señales (punto 3, pendiente para el forward).",
              "6. **Pérdida diaria**: con la regla de admisión actual (límite diario menos pérdidas del día menos riesgo abierto) la suma pérdida realizada + riesgo planificado no supera 20 USD; `suspended_daily_loss` solo aparece si una pérdida real supera la planificada (funding, huecos). Está cubierta por `test_portfolio.py`.", ""]
    return "\n".join(lines)


def two_process_recovery():
    """Runs the real two-process recovery for both restart modes and the refusal matrix (deterministic)."""
    modes = {}
    for mode in ("replay_log", "live_gap"):
        name = "s5_integral_reinicio_" + mode
        scenario = next(s for s in all_scenarios() if s["name"] == name)
        single = run_scenario(scenario)
        reference = single["reference"]
        with tempfile.TemporaryDirectory() as directory:
            process, result = TP.run_two_process(name, directory)
            if result is None:
                raise RuntimeError("second process failed: " + process.stderr)
            on_disk = Journal.load(os.path.join(directory, TP.JOURNAL), scenario)
        modes[mode] = {
            "equivalent_ledger": result["ledger_hash"] == reference["ledger_hash"],
            "equivalent_state": result["state_digest"] == reference["state_digest"],
            "equivalent_feed": result["feed_hash"] == reference["feed_hash"],
            "positions_equal": result["positions"] == TP.positions(reference["executor"]),
            "capital_equal": result["capital_definitive_usd"] == reference["snapshot"]["capital_definitive_usd"],
            "journal_equals_single_process": result["journal_hash"] == single["journal_hash"],
            "journal_on_disk_verifies": on_disk.head == result["journal_hash"] and on_disk.verify() is None,
            "ledger_hash": result["ledger_hash"], "reference_ledger_hash": reference["ledger_hash"],
            "journal_hash": result["journal_hash"], "capital_definitive_usd": result["capital_definitive_usd"],
            "reference_capital_usd": reference["snapshot"]["capital_definitive_usd"],
            "closed_trades": result["closed_trades"], "reference_closed_trades": reference["snapshot"]["closed_trades"],
            "lost_signal_events": result["restart"]["lost_signal_events"]}
    with tempfile.TemporaryDirectory() as base:
        matrix = TP.refusal_matrix("s5_integral_reinicio_replay_log", "s1_posiciones_simultaneas", base)
    return {"modes": modes, "refusals": {k: list(v) for k, v in matrix.items()}}


def run_all(out_dir=None, *, checkpoint_dir=None):
    scenarios = all_scenarios()
    results, runs = [], []
    for scenario in scenarios:
        run = run_scenario(scenario, checkpoint_dir=checkpoint_dir)
        again = run_scenario(scenario, checkpoint_dir=checkpoint_dir)
        if (run["journal_hash"], run["ledger_hash"], run["state_digest"]) != (again["journal_hash"], again["ledger_hash"], again["state_digest"]):
            raise AssertionError("scenario {} is not deterministic".format(scenario["name"]))
        run["scenario"] = scenario
        results.append(_scenario_result(scenario, run))
        runs.append(run)
    recovery = two_process_recovery()
    if out_dir:
        os.makedirs(os.path.join(out_dir, "journals"), exist_ok=True)
        for r, run in zip(results, runs):
            with open(os.path.join(out_dir, "journals", r["name"] + ".jsonl"), "w", encoding="utf-8") as handle:
                for entry in run["journal"].entries:
                    handle.write(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n")
        payload = {"schema": "balancita-portfolio-offline-results.v1", "policy_hash": PortfolioPolicy().policy_hash(),
                   "cost_model_hash": cost_model_hash(), "scenarios": results, "recuperacion_dos_procesos": recovery,
                   "results_hash": stable_hash([results, recovery])}
        with open(os.path.join(out_dir, "resultados.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, indent=1)
            handle.write("\n")
        with open(os.path.join(out_dir, "informe.md"), "w", encoding="utf-8") as handle:
            handle.write(build_report(results, runs, recovery) + "\n")
    return results, runs


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as scratch:  # the restart scenario restores from a real file
        results, _ = run_all(args.out, checkpoint_dir=scratch)
    for r in results:
        print("{}: ledger {} journal {} violations {}".format(r["name"], r["ledger_hash"][:12], r["journal_hash"][:12], len(r["violations"])))


if __name__ == "__main__":
    main()
