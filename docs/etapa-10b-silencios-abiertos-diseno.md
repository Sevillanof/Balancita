# D-10B-17: silencios abiertos durables (diseño, sin implementación)

Solo diseño. No cambia código, contabilidad, estrategias ni el umbral. No autoriza captura real ni sesión paper.
Base: #166 (ingestor, 7e4afbe). Integra con #165 (0ec42e3) sin modificarlo.

## 1. Qué falta hoy

- `Ingestor.state()["silences"]["open"]` se calcula con `last_ticker_ms` y un `observed_now_ms` que pasa quien llama. No se guarda en ningún lado.
- `last_ticker_ms` sí está en el checkpoint del ingestor, pero el instante hasta el cual se observó la fuente no. Tras una caída del proceso no se sabe cuánto del silencio se vio y cuánto ocurrió con el proceso muerto.
- El silencio pasa a `silences` (y a la auditoría) recién cuando llega una cotización posterior. Si la fuente no vuelve a emitir, no queda registro durable del silencio.

## 2. Principios

1. Una observación es un hecho de la sesión («a la hora H consulté la fuente y el último ticker de P era T»), no una cotización. No se inventa ninguna cotización ni vela.
2. El silencio solo se afirma hasta donde hubo observación. El tramo con el proceso caído es `observation_gap`, nunca `product_silence` ni `source_silence`.
3. Ninguna lógica financiera nueva. La cancelación sigue siendo la de #168, con la regla conservadora decidida por Fran.

## 3. Registros nuevos (append-only, en `audit.jsonl`, deduplicados por hash como el resto)

- `observation` `{observed_ms, last_ticker_ms: {producto: T}, rows_read}`. `observed_ms` es hora de reloj del proceso, declarada como tal. Se escribe solo si algún producto lleva más de `product_silence_ms` sin cotizar, y como máximo una vez por `product_silence_ms / 3` (acota el tamaño; el valor es hipótesis).
- `silence_open` `{product_id, since_ms, observed_until_ms}`. Cada `observation` lo extiende: `since_ms` fijo, `observed_until_ms` monótono creciente.
- `observation_gap` `{from_ms, to_ms, reason: "process_down"}`, escrito en `recover()` cuando `ahora - última observation` supera dos intervalos de sondeo.
- Cuando llega una cotización posterior, el registro `silences` existente gana `observed: "complete" | "partial"` y `observed_ms` (suma de tramos observados). `partial` si hubo `observation_gap` dentro del silencio.
- Cierre sin cotización: al terminar la ventana de ejecución de una orden, o al terminar la sesión, `silence_open` se cierra con `end: "window_end" | "session_end"` y `observed_until_ms`. No hay `to_ms` de mercado.

## 4. Recuperación

El checkpoint del ingestor agrega `last_observed_ms` y `open_silences` (campos de evidencia, ausentes = vacío, como `EVIDENCE_FIELDS`). `recover()`:

1. Restaura `last_ticker_ms` y `open_silences`.
2. Si hubo `observation_gap`, lo registra y marca `partial` los silencios que lo cruzan.
3. Retoma `observation` con la hora actual: si la fuente sigue sin emitir, el mismo `silence_open` se extiende (misma `since_ms`); si emitió, el cierre sigue el camino normal.

Un silencio que empieza antes de la caída y sigue después queda como un solo `silence_open` con un `observation_gap` en el medio, no como dos silencios ni como uno completo.

## 5. Clasificación y cancelación

- `classify_gap` (#165) acepta también un silencio abierto: usa `since_ms..observed_until_ms` y la misma lógica `source_silence` / `product_silence` / `unexplained`, solo sobre tramos observados. `sample_capped` y la ausencia de evidencia siguen sin interpretarse como continuidad.
- La cancelación por `source_stale` no cambia: sigue disparándose antes de entregar la cotización que cierra el intervalo (#165). Un silencio abierto sin cotización posterior no cancela nada nuevo; queda como evidencia. La orden vence por su ventana como hoy.
- Decisión abierta para Fran (no incluida): si un silencio abierto que supera el umbral debe cancelar al fin de la ventana. #168 lo soportaría con `gap_to = observed_until_ms`, pero es una política nueva y no se propone sin su aprobación.

## 6. Plan de pruebas

Mundo sintético (`live_world`), reloj y SIGKILL como en 10D. Cada caso compara contra un run continuo sin caída (`comparable_state` + registros de auditoría).

1. Silencio que empieza antes de la caída y termina después: un solo `silence_open`, un `observation_gap`, cierre `partial`.
2. Caída en cada punto de `POINTS` durante un silencio abierto: misma evidencia final.
3. La fuente nunca vuelve a emitir en la ventana: `silence_open` cerrado con `window_end`, sin cotización inventada, sin eventos nuevos al runner, estado financiero idéntico a la referencia.
4. Caída larga con el silencio ya cerrado por una cotización: `observed: partial`, nunca `complete`.
5. Idempotencia: repetir `recover()` y repetir `observation` no duplica registros.
6. Checkpoint viejo sin los campos nuevos: se restaura vacío, sin error.
7. Producto silencioso con fuente viva vs. fuente completa muda: `product_silence` vs. `source_silence`, también para silencios abiertos.
8. Mutaciones: sin `last_observed_ms`, el caso 1 debe fallar; sin `observation_gap`, el caso 4 debe fallar.
9. Digests financieros de 10D sin cambios (864 señales, 436 órdenes, 3 cierres).

## 7. Alcance y límites

- Toca solo `paper_live_ingest.py`, el checkpoint/auditoría de `paper_live_integration.py` y sus tests. No toca `paper_runner.py`, #168, contabilidad ni estrategias.
- Los intervalos (`product_silence_ms`, sondeo, `/3`) son hipótesis, igual que 15/25/45 s.
- Sigue sin cubrir lo que el ingestor no ve: filas podadas por la captura o una fuente que reporta datos viejos como nuevos.
- Sin sesión real, sin bases ni endpoints nuevos.
