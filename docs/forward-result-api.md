# Resultado del forward (`GET /api-strategies/forward`)

Lectura de solo lectura (`python/balancita_engine/futures_forward_result.py`, servida por el registro S). No hay escritores nuevos: lee lo que ya guardan el forward y Q.

| Fuente                                                                     | Qué aporta                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `forward-reliability.json` (`--forward-summary` o `STRATEGY_FORWARD_PATH`) | operaciones cerradas en vivo y recuperadas por separado, estado de funding por producto, hash del spec, inicio |
| `forward.sqlite` (`--forward-db`)                                          | posiciones abiertas (`forward_open`) y hora del último ciclo (`forward_status.checked_ms`)                     |
| base de mercado (`--market-db`)                                            | último cierre oficial de 1 min (primera revisión conocida) para valuar las abiertas                            |
| base de decisiones de Q (`--decisions-db`)                                 | `paper_futures_llm_skips`                                                                                      |

El inventario (`GET /api-strategies/inventory`, `docs/strategy-inventory-api.md`) llena con el mismo bloque `forward.trades` de cada estrategia y trae `forward_health`. `GET /api-strategies/forward` devuelve lo mismo en una sola respuesta.

## Respuesta

```
{ schema: "futures-forward-result.v1", generated_ms, cadence_s: 3600, late_after_s: 5400,
  summary_updated_ms, summary_available, min_trades,
  funding: { PF_XBTUSD: {usable, code, reason, checked_ms}, ... },     // por producto
  q_skips: { available, reason,
             windows: { "1h"|"24h"|"7d": {total, by_code: {model_down|state_error|calm_skip|stale_verdict: n}} },
             latest: [{product_id, bucket_start, question_id, code, reason, written_at}] },   // últimos 10
  strategies: [{ id, name, kind, spec_hash, operational, forward: {
      registered, start_ms, registered_at, min_trades, available, missing, problems: [{code, reason}],
      trades: null | {
        state: {code, reason, since_ms},          // active | off | retired | closed | ... con motivo siempre
        live:      {closed, net_usd, mean_net_bp, hit_rate, funding_incomplete, net_is_definitive, open: {count, label, pnl_usd, positions}},
        recovered: {... mismos campos ...},
        unclassified_open: {count, label, pnl_usd, positions: [...]},   // abiertas previas a la clasificación
        open: {count, label: "abierta, valuada a mercado", pnl_usd,
               positions: [{product_id, side, entry_price, opened_at_ms, mark_price, mark_bucket_ms, pnl_usd, net_bp, label}]},
        progress: {live_trades, min_trades, remaining, reached, counts_toward_min: "solo operaciones en vivo"},
        last_run_ms, late,                        // late solo se juzga en estrategias activas
        funding_state: {producto: {...}}, problems } } }] }
```

## Reglas

- **Solo las operaciones en vivo cuentan para el mínimo** (15, `min_forward_trades` de `config/forward-strategies.json`; antes 100). Las sin clasificar nunca cuentan. Las recuperadas (velas o funding aprendidos tarde) se muestran aparte con los mismos campos y no suman al progreso.
- `net_usd` es neto de costes y del funding conocido. Si hay operaciones con funding incompleto (`funding_incomplete > 0`), `net_is_definitive` es `false`: el neto aún puede cambiar.
- **Las abiertas se clasifican desde que abren, por su entrada**: `recuperada (entrada con datos llegados tarde)` si la vela de señal/entrada (1 min o 5 min) o el funding de la entrada se aprendieron tarde, con los mismos criterios que el forward usa al cerrar (`futures_forward.open_is_recovered`, guardado en `forward_open.payload.recovered`); si no, `en vivo`. Cada bloque (`live`, `recovered`) trae sus abiertas en `open`; `open` de nivel superior es el total. **Una abierta en vivo aún puede terminar recuperada al cerrar**, si entre la entrada y la salida llega una vela tarde: entonces la operación cerrada pasa a recuperadas, como hoy. Filas guardadas antes de esta clasificación (sin marca `recovered`) **no** cuentan como en vivo: van en `unclassified_open` (`recovered: null`, `classification`: «sin clasificar: abierta antes de la clasificación; se clasifica en el próximo ciclo»), no entran en `live.open` ni en `recovered.open`, y el forward las clasifica al reescribirlas en el siguiente ciclo. `/estrategias` las muestra en un bloque aparte «Sin clasificar». Cada abierta se valúa al último cierre oficial de 1 min como si se cerrara ahora, con comisiones y ejecución de entrada y salida del modelo de costes y **sin funding devengado**; lleva siempre la etiqueta «abierta, valuada a mercado». Sin precio, `pnl_usd` es `null` y la vista lo dice.
- **Atraso (`late`)**: el último ciclo es más viejo que 1,5 períodos (`cadence_s` = 3600 → 90 min, la misma regla que `/api/observability/health`). Solo se evalúa en estrategias `active`; en las demás es `null`.
- **Nunca un «desconocido» sin motivo.** Cada problema trae un código estable y un texto: `no_summary` (el forward no escribió su resumen), `not_measured` (activa pero sin resumen), `late`, `spec_changed` (el forward mide otro hash), `funding_<código>` (funding no usable en un producto, con el motivo de `funding_state`), `missing_candles`, `no_trades_yet`. Si una estrategia no se mide en `forward.sqlite` por diseño (C31, Kronos, carry, cerradas), `trades` es `null` y `forward.missing` dice dónde vive su resultado o por qué está apagada (C31: `apagada: <motivo>`, con `operational.since_ms` = fecha del bloque `off` de `config/qwen-exit.json`).
- Funding por producto: el estado más reciente entre los resúmenes de las estrategias (`futures_funding_context.funding_state`: `usable`, `code`, `reason`).
- Saltos de Q: conteos por código en 1 h, 24 h y 7 d y los 10 últimos con su motivo. Si la base o la tabla no existen, `available: false` con el motivo.

## Cadencia

El lanzador de desarrollo corre el forward cada 3600 s (decisión del propietario). La salud de observabilidad espera un ciclo cada 60 min (ok hasta 90, warning hasta 120).

Esto muestra el registro forward ya aprobado de cada estrategia; no calcula backtest ni rendimiento sobre datos de holdout.
