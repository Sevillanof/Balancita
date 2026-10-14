# PaperRunner: cancelación durable por `source_stale` (D-10C-3)

Decisión de Fran (2026-10-14, tras 10D): una API durable del runner que cancele las órdenes pendientes afectadas cuando la fuente perdió continuidad. Reutiliza el executor y el diario existentes. No modifica estrategias, stops de posiciones abiertas ni reglas de riesgo.

## API

```python
PaperRunner.cancel_for_source_loss(product_id: str, gap_from_ms: int, gap_to_ms: int, t_ms: int) -> list[str]
```

Devuelve los ids de las órdenes afectadas por la pérdida.

- **Qué cancela:** las órdenes pendientes de `product_id` cuya ventana de ejecución (`earliest_fill_ms`, `deadline_ms`) se solapa con `[gap_from_ms, gap_to_ms]` (mismo criterio que `runner_interrupted`: `min(deadline, gap_to) > max(earliest_fill, gap_from)`). No toca órdenes ya llenadas, vencidas o canceladas, otros productos, posiciones abiertas ni sus stops.
- **Antes de la cotización posterior al corte:** si el executor ya recibió una cotización del producto con `time_ms >= gap_to_ms` se rechaza con `source_loss_after_quote` y no escribe nada. La brecha se mide en el reloj del diario (`t_ms` de los eventos, cuando la fuente persistió la cotización), que puede ser posterior al `time_ms` de la propia cotización; la comprobación usa el más tardío de los dos. La sesión debe llamar a la API antes de entregar la cotización que cierra la brecha.
- **Idempotente** por `(product_id, gap_from_ms, gap_to_ms)`: una segunda llamada devuelve los mismos ids y no escribe nada.
- **Durable:** primero se escribe en el diario `source_loss` (clave, ids afectados y ventana descubierta de cada uno) y después un `order_cancelled` por orden con motivo `source_stale`. Si el proceso muere entre ambos, la recuperación termina las cancelaciones anunciadas por el `source_loss` (antes de calcular las órdenes interrumpidas) y no las duplica.
- **Rechazos explícitos:** `not_processing`, `source_loss_not_applicable` (modo modelado: no hay fuente de cotizaciones), `source_loss_invalid` (producto vacío, no enteros, `gap_to <= gap_from`), `source_loss_in_the_past` (`t_ms` anterior al reloj del runner), `source_loss_after_quote`.

- **Conservadora:** también cancela una orden decidida durante la brecha cuya `earliest_fill_ms` cae dentro de ella (nadie vigilaba la fuente mientras esperaba).

## Qué cambió

- `paper_runner.py`: `cancel_for_source_loss`, `_finish_source_losses`, entrada de diario `source_loss`, estado `source_losses` (se reconstruye del diario; entra en `state_digest` solo si no está vacío, así los digests existentes no cambian), `orders()` muestra `cancelled` también para `source_stale`.
- `execution_timing.py`: `source_stale` se agrega a `CANCEL_REASONS`. El comportamiento del executor no cambia; cambia la identidad de compilación (`build_identity`) por el módulo tocado, como siempre que se toca un módulo del motor.
- Sin cambios en `engine_behavior`, estrategias, riesgo, costos ni portfolio.

## Pruebas (`test_paper_runner_source_loss.py`, 14)

Solo cancela lo afectado; una brecha fuera de la ventana no cancela nada; posiciones abiertas intactas (mismo `financial_digest`); cancelación antes de la cotización y la orden no se llena; regresión del corte de 26 s (sin cancelación, la misma cotización llena la orden); rechazo tras la cotización; idempotencia (misma lista, mismo diario, mismos digests); otra brecha sobre la misma orden no cancela dos veces; recuperación tras cancelación limpia; muerte entre `source_loss` y `order_cancelled` y entrada de diario truncada (la recuperación termina la cancelación una sola vez); reproducción del diario con el mismo `state_digest`; llamadas inválidas sin escribir; modo modelado rechazado.

## Límites

La detección de la pérdida (cuándo hay una brecha y qué umbral usar) no está aquí: es de la sesión/ingestor y sus umbrales siguen como hipótesis. Esta API solo ejecuta la cancelación que la sesión decida y la deja durable y auditable.

## Causalidad (revisión de #168)

- **Brecha futura:** una declaración nueva exige `t_ms >= gap_to_ms`; una interrupción no se declara completa antes de observar su final (`source_loss_before_gap_end`). Una declaración ya persistida se repite con cualquier `t_ms` y no escribe nada.
- **Relojes:** la comprobación `source_loss_after_quote` usa el máximo entre el `t_ms` del diario de la última cotización entregada y su `time_ms`. Probado con `event_time == persisted_at`, `event_time < persisted_at`, cotizaciones REST y WebSocket, cancelación antes y después de entregar la cotización.
- Los tiempos del diario no retroceden entre llamadas sucesivas.
- Una brecha entre cotizaciones no prueba por sí sola una caída de la fuente; quién declara la pérdida debe apoyarse en evidencia explícita.
- **Residuo declarado (LOW):** `quote_t_ms` (tiempo del diario de la última cotización por producto) no entra en `state_digest`. Se reconstruye siempre por reproducción completa del diario; si alguna vez se restaura desde una instantánea, debe viajar con ella.
