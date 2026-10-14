# D-10B-17: silencios abiertos durables (diseño, sin implementación)

Solo diseño. No cambia código, contabilidad, estrategias ni umbrales. No autoriza captura real ni sesión paper.
Revisión D sobre 95d2a5a: D-17-01 a 04 y LOW 05 a 08 resueltos aquí (sección 9).

## 1. Qué falta hoy

- `Ingestor.state()["silences"]["open"]` se calcula con `last_ticker_ms` y el `observed_now_ms` que pasa quien llama. No se guarda.
- `last_ticker_ms` está en el checkpoint, pero no hasta dónde se observó la fuente. Tras una caída no se sabe qué parte del silencio se vio.
- El silencio entra a `silences` y a la auditoría recién cuando llega una cotización posterior. Si la fuente no vuelve a emitir, no queda registro.
- `_open_silences` devuelve `[]` con la fuente `stale`, y la interrupción (`outages`) recién se anota con el ticker siguiente.

## 2. Principios

1. Una observación es un hecho de la sesión («consulté la fuente hasta T y no había nada más»), no una cotización. No se inventa cotización ni vela.
2. **Un solo dominio de tiempo: el de la fuente.** El ingestor no tiene reloj de pared (su «ahora» es `observed_now_ms`, lectura del reloj de la fuente). Ningún registro nuevo usa la hora del proceso.
3. El silencio se afirma solo hasta donde se observó. El tramo con el proceso caído es `observation_gap`, nunca silencio ni caída de Kraken.
4. Ninguna lógica financiera nueva. La cancelación es la de #168 con la regla conservadora de Fran, sin cambios.

## 3. Cuánto se observó (D-17-01)

`observed_until_ms = observed_now_ms - hold_ms`, solo si el sondeo leyó hasta agotar (`more_to_read` falso). Es el mismo límite de la marca de agua: toda fila con `persisted_at` menor ya fue leída y liberada, así que una fila tardía no puede contradecir evidencia ya durable. `observed_until_ms` es monótono creciente y está en el dominio de la fuente.

Una fila que igual llegue con `persisted_at <= observed_until_ms` (violación del supuesto de `hold_ms`) no reescribe nada: se cuenta en `late_source_rows` como hoy y además en `late_inside_observed`, y la auditoría la deja como evidencia. El silencio ya registrado no se corrige.

## 4. Registros nuevos (en `audit.jsonl`, deduplicados por hash; sin hora del proceso)

- `observation` `{observed_until_ms, last_ticker_ms: {producto: T}}`. Un único registro por avance, para todos los productos, solo si `observed_until_ms` avanzó al menos `product_silence_ms` desde el último y algún producto lleva más de ese umbral sin cotizar. Cantidad máxima = duración de la sesión / `product_silence_ms`, sin importar cuántos productos callan (LOW 07).
- `silence_open` `{product_id, scope: "product" | "source", since_ms, observed_until_ms}`. `since_ms` = última cotización del producto. Se extiende con cada `observation`. `scope: "source"` cuando ningún producto cotizó en más de `dead_after_ms`.
- `outage_open` `{since_ms, observed_until_ms}` (D-17-03): cuando `observed_until_ms - last_any_ticker_ms > dead_after_ms`. Hoy la interrupción solo existe al llegar el ticker siguiente (`paper_live_ingest.py:303-304`) y `_open_silences` devuelve `[]` si la fuente está `stale`. Pasa a informar el silencio de toda la fuente en vez de omitirlo.
- `never_quoted` `{product_id, since_ms}` (LOW 06): el conjunto de productos esperados lo declara la sesión. Uno que nunca cotizó se cuenta como silencio desde el primer `observed_until_ms` de la sesión.
- `observation_gap` `{from_ms, to_ms}`: en el dominio de la fuente, de la última `observed_until_ms` durable al primer `observed_until_ms` tras recuperar. Se escribe en **cada** `recover()`, aunque la caída sea corta (D-17-02); no hay umbral de dos sondeos.
- Al llegar la cotización posterior, el registro `silences` existente gana `observed: "complete" | "partial"` y `observed_span_ms`. `partial` si algún `observation_gap` cae dentro del silencio.
- `silence_at_window_end` `{intent_id, deadline_ms, product_id, since_ms, observed_until_ms}` (LOW 05): uno por orden pendiente cuya ventana termina con el silencio abierto. Con varias ventanas hay un registro por orden, no uno por silencio. Es evidencia; no cancela.

## 5. Recuperación y durabilidad (D-17-04)

- El checkpoint del ingestor es la fuente de verdad. Agrega `observed_until_ms`, `open_silences`, `open_outage` y `observation_gaps` (campos de evidencia: ausentes = vacío, como `EVIDENCE_FIELDS`).
- La auditoría se **deriva** del checkpoint, como en D-10D-08 (`flush_audit` desde `runner.source_losses`). Si el proceso muere entre `audit.jsonl` y el checkpoint, `recover()` reescribe los registros desde el checkpoint y la deduplicación por hash evita duplicados. Si muere con el checkpoint ya escrito y la auditoría atrasada, ocurre lo mismo.
- `recover()` restaura `last_ticker_ms` y los abiertos, escribe el `observation_gap` y retoma las observaciones: un silencio que cruza la caída sigue siendo **un** `silence_open` (mismo `since_ms`), con un `observation_gap` en el medio.
- Los registros son función de valores del dominio de la fuente, así que son deterministas: repetir `recover()` o una observación no duplica nada.

## 6. Clasificación y cancelación

- `classify_gap` (#165) acepta también un silencio abierto (`since_ms..observed_until_ms`) con la misma lógica `source_silence` / `product_silence` / `unexplained`, solo sobre tramos observados. `sample_capped` y la ausencia de evidencia siguen sin leerse como continuidad.
- La cancelación por `source_stale` no cambia: se dispara antes de la cotización que cierra el intervalo. Un silencio abierto sin cotización posterior no cancela nada; queda como evidencia y la orden vence por su ventana.
- Pendiente de Fran, no propuesto: cancelar al fin de la ventana con un silencio abierto. Si se aprueba, `gap_to = observed_until_ms` ya está en el dominio de la fuente y acotado por la marca de agua (§3), por eso §3 no puede relajarse.

## 7. Qué se compara en las pruebas

Cada caso corre un mundo continuo y uno con caídas y recuperación.

- **Iguales en ambos:** hechos de mercado (eventos entregados al runner), `comparable_state`, `silences` cerrados (salvo `observed`), `outages`.
- **Distintos por diseño, con forma esperada:** el recuperado tiene exactamente un `observation_gap` por `recover()`, y `observed: "partial"` donde cruza; el continuo tiene `complete` y ningún `observation_gap`. La prueba fija ambas formas.

## 8. Plan de pruebas

Mundo sintético (`live_world`), reloj y SIGKILL como en 10D.

1. Silencio de un producto que empieza antes de la caída y termina después: un `silence_open`, un `observation_gap`, cierre `partial`.
2. Caída en cada punto de `POINTS` durante un silencio abierto: mismos hechos y mismas formas (§7).
3. La fuente nunca vuelve a emitir en la ventana: `silence_at_window_end`, sin cotización inventada, sin eventos nuevos al runner, estado financiero igual a la referencia. **Con un producto mudo y con toda la fuente muda** (`outage_open`, D-17-03).
4. Caída corta (menos de un sondeo) dentro del silencio: `observation_gap` presente y cierre `partial` (D-17-02).
5. Fila tardía con `persisted_at` dentro de un silencio ya observado: no reescribe el registro, queda contada en `late_inside_observed`; la recuperación sigue siendo igual (D-17-01).
6. Caída entre `audit.jsonl` y el checkpoint, en ambos órdenes: la auditoría se rehace desde el checkpoint sin duplicados.
7. Idempotencia: repetir `recover()` y repetir `observation`.
8. Checkpoint viejo sin los campos nuevos: se restaura vacío, sin error.
9. Producto que nunca cotizó (`never_quoted`) y varias órdenes con ventanas distintas (`silence_at_window_end` por orden).
10. Cantidad de `observation` acotada con 8 productos callados.
11. Mutaciones: quitar `observed_until_ms` del checkpoint rompe el caso 1; quitar `observation_gap` rompe 4; usar hora del proceso rompe 5.
12. Digests financieros de 10D sin cambios (864 señales, 436 órdenes, 3 cierres).

## 9. Hallazgos de D resueltos

D-17-01 (§2, §3, §6), D-17-02 (§4), D-17-03 (§4, caso 3), D-17-04 (§5, §7, caso 6), LOW 05 (`silence_at_window_end`), 06 (`never_quoted`), 07 (tope de `observation`), 08 (§10).

## 10. Dónde se implementa

Dos PR apiladas, ninguna toca `paper_runner.py`, #168, contabilidad ni estrategias:

1. Ingestor: `paper_live_ingest.py` y sus tests, base #166.
2. Sesión: checkpoint/auditoría y `classify_gap` en `paper_live_integration.py`, y los casos 2, 3, 6 y 9 con SIGKILL, base #165 (que contiene #166), después de la primera.

Los intervalos (`product_silence_ms`, `dead_after_ms`, `hold_ms`) siguen siendo hipótesis, como 15/25/45 s. Sigue sin cubrirse lo que el ingestor no ve: filas podadas por la captura o una fuente que reporta datos viejos como nuevos. Sin sesión real, bases ni endpoints nuevos.
