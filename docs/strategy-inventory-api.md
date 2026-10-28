# Inventario de estrategias (`GET /api-strategies/inventory`)

Lectura de solo lectura del registro S (`futures_strategy_registry.py`, código en `futures_strategy_inventory.py`). `strategy-closed.json` puede traer `retired` (`{id: {date, reason}}`): el inventario muestra esa fecha (`since_ms`) y ese motivo en la fila cerrada; C32 se retiró así el 2026-10-18 (sin operaciones nuevas, historial y spec intactos). Combina, sin escribir nada, el estado del registro con `config/strategy-closed.json`, `strategy-freeze.json`, `forward-strategies.json`, `qwen-exit.json`, `strategy-reliability.json`, los specs de `config/strategies/`, el descriptor de Kronos. `--config-dir` (CLI del registro) cambia la carpeta de config que lee el inventario (pruebas con una copia); por defecto es `config/`.

Dos ejes que no se mezclan y se etiquetan igual en todas las vistas (`src/features/strategy-lab/domain/strategy-labels.ts`):

- **`operational`**: si corre. `state` ∈ `active` (activa), `shadow` (en sombra), `draft` (borrador), `retired` (desactivada), `closed` (cerrada), `tracking` (contador en seguimiento, no opera), `inactive`, `unverified` (estado no verificado). `basis`: `registry` (estado del registro), `config` (solo registrada en un config: C31) o `none`. **`active` solo viene del registro y significa «activa en el registro»: ni el registro ni un config prueban que el proceso corra ahora (eso es B5). C31, registrada solo en `qwen-exit.json`, es `unverified`.** `counts.active` cuenta solo `active` del registro.
- **`research`**: qué dice la evidencia. `state` ∈ `reliable_edge`, `tentative_edge`, `candidate_edge`, `no_edge`, `negative_edge`, `insufficient_data` (veredicto de `strategy-reliability.json` para exactamente ese spec), `unmeasured` (sin medición comparable) o `registry_note`. `evidence_of_edge` (la UI lo rotula «Evidencia preliminar») es `true` solo para `candidate_edge` o mejor; `reliable` solo para `reliable_edge`; `investigating` marca las estrategias no cerradas cuya evidencia todavía no concluye (`candidate_edge`, `insufficient_data` o sin medición).
- `frozen`: está en `strategy-freeze.json` (no cambia hasta 100 operaciones forward). No es un estado operativo.

## Respuesta

```
{ schema: "futures-strategy-inventory.v1",
  cost_model: {version, hash} | null, notional_usd: "100", thresholds, forward_min_trades, period,
  counts: {strategies, active, frozen, closed, investigating, edge_evidence},
  strategies: [{ id, version, name, description, kind: rules|qwen_exit|model, spec_hash,
                 operational: {state, basis, since_ms, reason},
                 frozen, research: {state, evidence_of_edge, reliable, investigating,
                                    backtest: {trades, hit_rate, mean_net_bp, pnl_usd, t_stat, deflated_probability,
                                               folds_positive, folds_judged, selection_trials, verdict,
                                               ranges: {previous|recent: {...}}} | null, text?},
                 forward: {registered, start_ms, registered_at, min_trades, trades: bloque | null, available, missing: motivo | null, problems},
                 market: {products, horizon_minutes, exit_by: rules|qwen|time|null}, note, no_backtest }],
  forward_health: {generated_ms, cadence_s, funding, q_skips, ...} | null,
  missing: [ ... ] }
```

`forward.trades` y `forward_health` vienen de `GET /api-strategies/forward` (`docs/forward-result-api.md`): operaciones en vivo y recuperadas por separado, posiciones abiertas valuadas, progreso hacia el mínimo, último ciclo y atraso, estado de funding por producto y saltos de Q. Si no aplica (C31, Kronos, cerradas, o el servicio sin rutas del forward), `trades` es `null` y `missing` dice el motivo.

Los cerrados (C25-C28) se borran del registro al arrancar: vuelven desde `config/strategies/` con su `operational.state = "closed"` y sus cifras de backtest. Una entrada de fiabilidad solo cuenta si su `spec_hash` es el del spec actual; si no, `unmeasured`. Sin un config, el campo queda `null`/vacío (nunca un valor inventado).

## Qué no existe todavía (B5, no se inventa)

- Si los procesos forward, C31 y Kronos están corriendo ahora (el config registra el inicio, no la ejecución). Kronos no tiene registro de inicio en ningún config: `Estado no verificado`.
- Resultados de C31 y Kronos (archivos locales de `qwen-exit` y `kronos_lab`).

El mismo texto se devuelve en `missing`.
