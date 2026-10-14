# D-10B-17: silencios abiertos durables (diseño, sin implementación)

Solo diseño. No cambia código, contabilidad, estrategias ni umbrales. No autoriza captura real ni sesión paper.

**Decisión de Fran (15:52Z):** se autoriza cancelar por `source_stale` con el silencio todavía abierto, con diez condiciones (§6). Esto reemplaza la opción (b) de D-17-09 por la resolución de §3.1: la prueba de que no hay hueco desmentido se construye antes de cancelar, sin cambiar `paper_runner.py` ni #168.
Revisión D sobre 95d2a5a y 7af0a93: D-17-01 a 04, 09, 10 y LOW 05 a 08 resueltos aquí (sección 9).

## 1. Qué falta hoy

- `Ingestor.state()["silences"]["open"]` se calcula con `last_ticker_ms` y el `observed_now_ms` que pasa quien llama. No se guarda.
- `last_ticker_ms` está en el checkpoint, pero no hasta dónde se observó la fuente. Tras una caída no se sabe qué parte del silencio se vio.
- El silencio entra a `silences` y a la auditoría recién cuando llega una cotización posterior. Si la fuente no vuelve a emitir, no queda registro.
- `_open_silences` devuelve `[]` con la fuente `stale`, y la interrupción (`outages`) recién se anota con el ticker siguiente.

## 2. Principios

1. Una observación es un hecho de la sesión («consulté la fuente hasta T y no había nada más»), no una cotización. No se inventa cotización ni vela.
2. **Dominio de tiempo: el de la fuente.** El ingestor no tiene reloj de pared (su «ahora» es `observed_now_ms`). Única excepción, declarada y marcada `clock: "process"`: la fuente totalmente muda (§3).
3. El silencio se afirma solo hasta donde se observó. El tramo con el proceso caído es `observation_gap`, nunca silencio ni caída de Kraken.
4. Ninguna lógica financiera nueva. La cancelación es la de #168 con la regla conservadora de Fran, sin cambios.

## 3. Cuánto se observó (D-17-01, D-17-09, D-17-10)

`observed_until_ms = observed_now_ms - hold_ms`, solo si el sondeo leyó hasta agotar (`more_to_read` falso). Monótono creciente, en el dominio de la fuente.

**Esto no es la marca de agua.** La marca real es `max_seen_ms - hold_ms` (`_watermark`, `paper_live_ingest.py:376`) y `released_ms` queda congelado durante un silencio, mientras `observed_until_ms` sigue avanzando. Una fila con `persisted_at` en `(released_ms, observed_until_ms]` no es tardía (solo se descarta `t <= released_ms`): entra normal, llega al runner como cotización y cierra el silencio antes de un `observed_until_ms` que ya era durable. Hoy no suma a ningún contador.

Decisión de diseño (opción b, a confirmar por Fran): **no se toca lo que recibe el runner ni `released_ms`.** Esa fila se entrega como siempre y además se registra `silence_contradicted` `{product_id, since_ms, observed_until_ms, quote_ms}`, append-only y enlazado al `silence_open` que contradice. El `silence_open` previo no se reescribe. Consecuencia: **`observed_until_ms` nunca puede usarse como `gap_to` de #168** (§6); la evidencia de un silencio abierto no es prueba de hueco.

Alternativa (a), no propuesta: con el sondeo agotado, adelantar `released_ms` a `observed_now_ms - hold_ms`, de modo que esa fila sea tardía y se descarte. Cierra la contradicción, pero cambia lo que se entrega al runner cuando se viola `hold_ms` y obliga a revalidar los digests de 10D. Lo decide Fran.

### 3.1 Cuándo `observed_until` vale como prueba (condición 4 de Fran)

`hold_ms` solo no alcanza: una fila en `(released_ms, observed_until_ms]` puede llegar después y desmentir el hueco. Un silencio abierto solo puede dar lugar a una cancelación si se cumplen **las tres** a la vez, evaluadas en el mismo sondeo:

1. El sondeo leyó hasta agotar (`more_to_read` falso) en ambas tablas, y la fuente está `live` (hay filas de otros productos o `observed_until` es del reloj de la fuente; con la cota del proceso nunca, ver abajo).
2. `gap_to_ms = since_ms + limit_ms + 1`, no `observed_until_ms`. Es el primer instante en que el umbral queda superado, por lo tanto **no depende de cuándo se sondeó** y la corrida continua y la recuperada declaran lo mismo (`from`, `to`). Se exige `gap_to_ms <= observed_until_ms`.
3. Antes de declarar, el ingestor entrega al runner todo evento pendiente con `t_ms <= gap_to_ms` (en orden, de cualquier producto) y recién entonces adelanta `released_ms` a `gap_to_ms`. Si entre ellos hay una cotización del mismo producto, el silencio no existe y no se cancela. El reloj del journal (condición 5) nunca pasa por delante de un evento anterior todavía pendiente.

Después de declarar, una fila con `persisted_at <= gap_to_ms` es tardía como cualquier otra (`released_ms`): se descarta de la entrega, se cuenta en `late_source_rows` y se escribe `silence_contradicted` enlazado al `silence_open`. No puede entrar al runner con tiempo anterior a una cancelación ya durable. Esto cambia la entrega solo después de una cancelación comprobada, y solo para filas que violan `hold_ms`; sin cancelación todo se entrega como hoy (los digests de 10D no cambian).

La cota del proceso (fuente totalmente muda) **no cumple 1 ni 3**: nunca cancela, solo registra evidencia (`clock: "process"`).

**Fuente totalmente muda.** Sin filas no hay reloj de la fuente que avance. En ese caso `observed_now_ms` sale de la hora del proceso, y cada `observation`/`outage_open` que lo use lleva `clock: "process"` (en los demás, `clock: "source"`). **Dos cotas separadas (D-17-11):** `observed_until_source_ms` (monótona, solo del reloj de la fuente) y `observed_until_process_ms` (aparte). La del proceso nunca alimenta el máximo de la de la fuente; si lo hiciera, al volver la fuente su primera fila real generaría un `silence_contradicted` espurio. Ese valor es solo evidencia: no se usa como `gap_to`, no cancela y no entra en comparaciones de determinismo. No se propone leer otra tabla ni un latido de la captura; eso necesitaría autorización escrita de Fran.

## 4. Registros nuevos (en `audit.jsonl`, deduplicados por hash; reloj de la fuente salvo `clock: "process"` marcado)

- `observation` `{observed_until_ms, last_ticker_ms: {producto: T}}`. Un único registro por avance, para todos los productos, solo si `observed_until_ms` avanzó al menos `product_silence_ms` desde el último y algún producto lleva más de ese umbral sin cotizar. Cantidad máxima = duración de la sesión / `product_silence_ms`, sin importar cuántos productos callan (LOW 07).
- `silence_open` `{product_id, scope: "product" | "source", since_ms, observed_until_ms}`. `since_ms` = última cotización del producto. Se extiende con cada `observation`. `scope: "source"` cuando ningún producto cotizó en más de `dead_after_ms`.
- `outage_open` `{since_ms, observed_until_ms}` (D-17-03): cuando `observed_until_ms - last_any_ticker_ms > dead_after_ms`. Hoy la interrupción solo existe al llegar el ticker siguiente (`paper_live_ingest.py:303-304`) y `_open_silences` devuelve `[]` si la fuente está `stale`. Pasa a informar el silencio de toda la fuente en vez de omitirlo.
- `never_quoted` `{product_id, since_ms}` (LOW 06): el conjunto de productos esperados lo declara la sesión. Uno que nunca cotizó se cuenta como silencio desde el primer `observed_until_ms` de la sesión.
- `observation_gap` `{from_ms, to_ms}`: en el dominio de la fuente, de la última `observed_until_ms` durable al primer `observed_until_ms` tras recuperar. Se escribe en **cada** `recover()`, aunque la caída sea corta (D-17-02); no hay umbral de dos sondeos.
- Al llegar la cotización posterior, el registro `silences` existente gana `observed: "complete" | "partial"` y `observed_span_ms`. `partial` si algún `observation_gap` cae dentro del silencio.
- `silence_at_window_end` `{intent_id, deadline_ms, product_id, since_ms, observed_until_ms}` (LOW 05): uno por orden pendiente cuya ventana termina con el silencio abierto. Con varias ventanas hay un registro por orden, no uno por silencio. Es evidencia; no cancela. `deadline_ms` está en el dominio de la fuente: con la fuente totalmente muda el registro no usa la cota de la fuente, sino la del proceso, y lleva `clock: "process"` (D-17-12).

## 5. Recuperación y durabilidad (D-17-04)

- El checkpoint del ingestor es la fuente de verdad. Agrega `observed_until_ms`, `open_silences`, `open_outage` y `observation_gaps` (campos de evidencia: ausentes = vacío, como `EVIDENCE_FIELDS`).
- **No se afirma que la auditoría se reconstruya íntegramente desde el checkpoint.** `audit.jsonl` es append-only y puede llevar registros posteriores al checkpoint (se escribió el audit y la muerte llegó antes del checkpoint). Esos registros no se borran ni se reescriben. Lo que sí se afirma, y se prueba: (i) los registros derivados del estado del runner y del ingestor (`source_loss`, `silence_open` actual) se vuelven a generar con el mismo contenido, así que la deduplicación por hash no duplica; (ii) los registros de decisión (`source_stale_detected`) se escriben **antes** de la llamada al runner, que es durable por sí misma e idempotente; (iii) tras recuperar con un registro adelantado en el audit y un checkpoint anterior, el conjunto final de registros es el de la corrida continua más, como mucho, un `observation_gap`. Si el recomputo produjera un registro distinto del ya escrito (otra ventana de observación), ambos quedan y la prueba lo trata como fallo, no como caso aceptado.
- `recover()` restaura `last_ticker_ms` y los abiertos, escribe el `observation_gap` y retoma las observaciones: un silencio que cruza la caída sigue siendo **un** `silence_open` (mismo `since_ms`), con un `observation_gap` en el medio.
- Los registros son función de valores del dominio de la fuente, así que son deterministas: repetir `recover()` o una observación no duplica nada.

## 6. Clasificación y cancelación (decisión de Fran, 15:52Z)

Una orden pendiente no sobrevive hasta una nueva cotización si ya hay prueba (§3.1) de que su producto superó el umbral en su ventana. Dos puntos de decisión, ambos con `PaperRunner.cancel_for_source_loss(product, since_ms, gap_to_ms, t_ms)` de #168 sin cambios:

- **Durante el silencio abierto:** en cada sondeo, para cada producto con órdenes pendientes y `gap_to_ms = since_ms + limit_ms + 1 <= observed_until_ms`, con §3.1 cumplido, la sesión declara la pérdida con `t_ms` = reloj del journal (>= `gap_to_ms`, como exige #168). No espera al vencimiento.
- **Al final de la ventana:** antes del vencimiento ordinario de una orden (`no_quote_in_window` por tick de reloj), se comprueba esa misma condición. Si se cumple, se cancela y la orden no vence. Si no se cumple, vence como hoy.
- **La cotización que cierra el hueco** sigue pasando por el camino de #165 (cancelar antes de entregarla, con `from=since_ms`, `to=` hora de la cotización); si la orden ya fue cancelada por el camino abierto, no queda nada pendiente y no cambia nada. Las órdenes decididas dentro del hueco después de la cancelación abierta las cubre este camino, como hoy.
- **Qué no se hace:** no se tocan posiciones, stops ni riesgo; no se cancela una orden que ya venció o se llenó (sin cancelaciones retroactivas de vencimientos antiguos, condición 10); no se cancela con `observation_gap`, `never_quoted` por sí solo, ni con la cota del proceso.

Equivalencia financiera: sin cotizaciones no hay llenados dentro del hueco, y la cancelación abierta alcanza a las mismas órdenes que la cancelación al cierre. La corrida continua y la recuperada difieren solo en cuándo se escribió la entrada `source_loss` en el diario, no en el resultado financiero.

Registro (condición 9): `source_stale_detected` ahora incluye `trigger: "open_silence" | "closing_quote" | "window_end"`, el intervalo `since_ms..gap_to_ms`, `observed_until_ms` y `clock`, la evidencia (`ingestor` clasificado), los `intent_id` pendientes y, tras la llamada, los ids cancelados. Un rechazo del runner sigue escribiendo `source_stale_refused` y detiene la sesión.

Vocabulario fijo, sin mezclar:

| Registro             | Qué es                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `silence_open`       | evidencia de continuidad insuficiente                                              |
| `observation_gap`    | tiempo sin observación por interrupción del proceso                                |
| `source_stale`       | decisión de cancelar una orden pendiente                                           |
| `runner_interrupted` | cancelación del runner por su propia interrupción (8B), sin relación con la fuente |

`classify_gap` (#165) acepta también un silencio abierto (`since_ms..gap_to_ms`), solo sobre tramos observados. `sample_capped` y la ausencia de evidencia siguen sin leerse como continuidad.

**Cambio en #168:** ninguno. `t_ms >= gap_to_ms` y `source_loss_after_quote` se cumplen por construcción (§3.1); si el runner rechazara, la sesión se detiene. Si en la implementación apareciera una guarda que impide esto, se le pide al hilo 9A; no se copia ni se reimplementa.

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
5. Fila con `persisted_at` en `(released_ms, observed_until_ms]` de un silencio ya observado (D-17-09): se entrega al runner como siempre, se escribe `silence_contradicted` enlazado, el `silence_open` previo no cambia y la recuperación da el mismo resultado. Caso aparte: fila con `persisted_at <= released_ms` (tardía de verdad), solo se cuenta.
   5b. Fuente totalmente muda sin filas: los registros llevan `clock: "process"`, no entran en la comparación de determinismo y ninguno llega a `gap_to`. La prueba sigue hasta que la fuente vuelve: la primera fila real no genera `silence_contradicted` (D-17-11).
6. Caída entre `audit.jsonl` y el checkpoint, en ambos órdenes: la auditoría se rehace desde el checkpoint sin duplicados.
7. Idempotencia: repetir `recover()` y repetir `observation`.
8. Checkpoint viejo sin los campos nuevos: se restaura vacío, sin error.
9. Producto que nunca cotizó (`never_quoted`) y varias órdenes con ventanas distintas (`silence_at_window_end` por orden).
10. Cantidad de `observation` acotada con 8 productos callados.
11. Mutaciones: quitar `observed_until_ms` del checkpoint rompe el caso 1; quitar `observation_gap` rompe 4; no registrar `silence_contradicted` rompe 5.
12. Digests financieros de 10D sin cambios (864 señales, 436 órdenes, 3 cierres).

### 8.1 Pruebas obligatorias de la decisión de Fran

Cada una compara corrida continua y recuperada (equivalencia financiera donde sea comparable: `comparable_state`, órdenes, posiciones, caja) y fija las formas esperadas de §7:

- A. La fuente nunca vuelve a emitir, con una orden pendiente: se cancela por `source_stale` con el silencio abierto, sin cotización inventada; luego no vence.
- B. La orden llega al final de su ventana con el silencio abierto: se comprueba la condición antes del vencimiento ordinario y se cancela; con condición no cumplida, vence como hoy.
- C. Un producto silencioso con otros productos activos: solo se cancelan sus órdenes; las de los otros productos, posiciones y stops quedan idénticos.
- D. Caída durante el silencio abierto (todos los `POINTS`, SIGKILL): una sola cancelación, idempotente, con `observation_gap` y sin contarlo como silencio.
- E. Recuperación posterior al vencimiento: una orden ya vencida o ya llenada no se cancela (sin cancelaciones retroactivas).
- F. Evento de mercado retenido con `t_ms` anterior al avance de observación: se entrega antes de declarar; si es del mismo producto el silencio desaparece y no hay cancelación; el reloj del journal no pasa por delante.
- G. Fila tardía posterior a la cancelación (`persisted_at <= gap_to_ms`): no entra al runner, queda `silence_contradicted`.
- H. Audit adelantado con checkpoint anterior (muerte entre ambos) y a la inversa: sin duplicados ni registros distintos.
- I. Cota del proceso (fuente totalmente muda) nunca cancela.
- J. Mutaciones: quitar la entrega previa de pendientes (F) rompe F; usar `observed_until_ms` como `gap_to` rompe la equivalencia; quitar la comprobación al final de la ventana rompe B.

## 9. Hallazgos de D resueltos

D-17-01 reemplazado por D-17-09 (§3, §6) y D-17-10 (§3, caso 5b), D-17-02 (§4), D-17-03 (§4, caso 3), D-17-04 (§5, §7, caso 6), D-17-11 y D-17-12 (§3, §4, caso 5b), LOW 05 (`silence_at_window_end`), 06 (`never_quoted`), 07 (tope de `observation`), 08 (§10).

## 10. Dónde se implementa

Dos PR apiladas, ninguna toca `paper_runner.py`, #168, contabilidad ni estrategias:

1. Ingestor: `paper_live_ingest.py` y sus tests, base #166.
2. Sesión: checkpoint/auditoría y `classify_gap` en `paper_live_integration.py`, y los casos 2, 3, 6 y 9 con SIGKILL, base #165 (que contiene #166), después de la primera.

Los intervalos (`product_silence_ms`, `dead_after_ms`, `hold_ms`) siguen siendo hipótesis, como 15/25/45 s. Sigue sin cubrirse lo que el ingestor no ve: filas podadas por la captura o una fuente que reporta datos viejos como nuevos. Sin sesión real, bases ni endpoints nuevos.
