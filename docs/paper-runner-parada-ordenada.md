# Paper runner: parada ordenada (#186, decisión D-186-1)

`PaperRunner.stop_orderly(t_ms)` es la parte del runner de la parada ordenada de la sesión paper. La decisión de Fran en #186 (BAL-DECISION-186-01) fue **Cancelar**.

## Qué hace

- Escribe en el journal la entrada `operator_stop` (qué órdenes se cancelan, cuáles vencen y sus ventanas) y después una `order_cancelled` por orden, con el motivo `operator_stop`.
- Una orden cuya ventana ya había terminado antes del instante de la parada no se cancela: termina con el vencimiento propio del ejecutor (`no_quote_in_window` o `no_valid_quote_in_window`).
- Si cualquiera de esas escrituras falla, la llamada lanza `RunnerError` (el runner queda REFUSED) y la parada **no** debe informarse como hecha.
- Si el proceso muere a mitad, la recuperación termina las cancelaciones anunciadas con el mismo motivo, una sola vez.
- Desde la entrada `operator_stop` el runner queda en estado terminal `STOPPED`: `handle` y las declaraciones de pérdida de fuente se rechazan (`not_processing`), en vivo y al reproducir el journal. Una recuperación de una corrida parada termina las cancelaciones anunciadas, queda `STOPPED` y no reanuda nada (no escribe `recovery` ni decide señales pendientes). Se puede escribir checkpoint y `finish()` (queda `FINISHED`). Llamar de nuevo a `stop_orderly` no agrega entradas.
- `t_ms` nunca retrocede el journal: el instante efectivo es `max(t_ms, último t_ms)`.

## Qué no hace

- No cierra ni modifica posiciones abiertas, stops, objetivos, riesgo ni contabilidad. No inventa cotizaciones, ticks ni salidas.
- **Con el motor detenido nadie evalúa stops ni objetivos.** Eso no es protección activa: las posiciones abiertas quedan sin observación hasta que otra recuperación vuelva a mirar (ver `LateRecovery` y el hueco `runner_interrupted`).
- No llama a `finish()`, no escribe checkpoint y no cierra el candado: eso lo decide quien llama (la sesión).
