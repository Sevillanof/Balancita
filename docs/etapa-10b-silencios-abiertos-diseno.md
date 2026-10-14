# D-10B-17: silencios abiertos durables (diseño, sin implementación)

Solo diseño. No cambia código, contabilidad, estrategias ni umbrales. No autoriza captura real ni sesión paper.

**Decisión de Fran (15:52Z):** se autoriza cancelar por `source_stale` con el silencio todavía abierto, con diez condiciones (§6). La cancelación se ata al **flujo de eventos** (§3.1), no a la cota de observación; D-17-13, 14, 15 y 16 resueltos aquí. Sin cambios en `paper_runner.py` ni #168, salvo el gancho opcional de §6.1, que solo puede hacer 9A.
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

Esa fila entra al runner como cualquier otra (no se toca `released_ms`) y además se registra `silence_contradicted` `{product_id, since_ms, observed_until_ms, quote_ms}`, append-only y enlazado al `silence_open`: **la evidencia de un silencio abierto nunca es prueba de hueco, y ninguna cancelación se apoya en `observed_until_ms` salvo el camino (b) de §3.1, con sus condiciones**. La alternativa de adelantar `released_ms` en cada sondeo se descarta: se saltea las retenciones de `_watermark` por velas atrasadas y por `ticker_more`/`candle_more` (`paper_live_ingest.py:376-387`).

### 3.1 Cuándo se cancela: atado al flujo de eventos (condición 4 de Fran; D-17-13, D-17-14)

`hold_ms` y `observed_until_ms` solos no prueban un hueco. La prueba es el propio flujo de eventos que el ingestor entrega en orden bajo su marca de agua natural (`max_seen_ms - hold_ms`, con sus retenciones). Para un producto P con última cotización `since_ms` y `gap_to_ms = since_ms + limit_ms + 1` (primer instante en que se supera el umbral, independiente de cuándo se sondeó):

- **(a) Atado al flujo.** Antes de entregar el primer evento con `t_ms > gap_to_ms` (de cualquier producto, o un tick de reloj), si P tiene órdenes pendientes y no hubo cotización de P en `(since_ms, gap_to_ms]`, la sesión declara `cancel_for_source_loss(P, since_ms, gap_to_ms, t_ms=gap_to_ms)`. El journal sigue en `<= gap_to_ms`, y la marca de agua natural ya probó que salió todo lo que tiene `t <= gap_to_ms`. Es función solo del flujo, así que la corrida continua y la recuperada declaran exactamente lo mismo, con el mismo `t_ms` (así los digests coinciden: no entra `decided_at_ms` dependiente del sondeo ni la hora en que otras órdenes vencen).
- **Varios productos en el mismo paso (D-17-17).** Si un evento cruza el `gap_to_ms` de más de un producto, las declaraciones se hacen en orden ascendente de `(gap_to_ms, product_id)`, incluida la cancelación al cierre de #165 cuando cae en el mismo paso. Así el `t_ms` de cada una es `>=` el reloj del runner y #168 no rechaza (`source_loss_in_the_past`). Declarar primero el mayor haría que la segunda llegara con `t_ms` menor y detendría la sesión.
- **(b) Sin eventos posteriores** (un solo producto o fuente muda más allá de `alive_until`): no hay flujo que la ate. Solo entonces se usa la observación, y únicamente si se cumple todo: sondeo agotado en ambas tablas (`more_to_read` falso), sin eventos pendientes en el ingestor, `ticker_more`/`candle_more`/vela atrasada falsos, reloj de la fuente (nunca la cota del proceso), `gap_to_ms <= observed_until_ms` y reloj del runner `<= gap_to_ms`. Se declara con `t_ms = gap_to_ms` (el mismo valor que en (a)) y, **en la misma operación**, `released_ms = max(released_ms, gap_to_ms)`. Como el runner nunca quedó atrás de ese `t_ms`, no hay evento previo pendiente al que se le adelante el reloj (condición 5).
- **Recuperación:** `recover()` toma `released_ms >= max(gap_to_ms)` de `runner.source_losses`, de modo que si la muerte ocurre entre la cancelación y el checkpoint del ingestor, una fila real con `t <= gap_to_ms` no entra al runner después. Una fila tardía así se cuenta en `late_source_rows` y se escribe `silence_contradicted` (solo como evidencia; la cancelación ya es durable).

Si en el tramo aparece una cotización de P con `t_ms` en `(since_ms, gap_to_ms]` o el hueco queda cerrado antes, no se declara nada por este camino. La cotización que cierra el hueco sigue pasando por el camino de #165 (cancelar antes de entregarla, `to` = hora de la cotización).

La cota del proceso (fuente totalmente muda) **no cumple (b)**: nunca cancela, solo registra evidencia (`clock: "process"`).

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

- **Durante el silencio abierto:** según §3.1 (a) o (b), con `t_ms = gap_to_ms` exacto. No espera al vencimiento.
- **Antes del vencimiento ordinario (D-17-15):** el vencimiento ocurre dentro de `_tick`/`_expire` al entregar cualquier evento con `t > deadline_ms`. Como la declaración de (a) se hace antes de entregar el primer evento con `t > gap_to_ms`, y `gap_to_ms` se compara con el `deadline_ms` de cada orden, la comprobación ocurre antes del vencimiento sin tocar el runner: si `gap_to_ms <= deadline_ms` la orden se cancela, si no, su ventana terminó dentro del umbral permitido y vence como hoy. El único caso que la sesión sola no puede resolver está en §6.1.
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

**Cambio en #168:** ninguno. `t_ms = gap_to_ms >= reloj del runner` y `source_loss_after_quote` se cumplen por construcción (§3.1); si el runner rechazara, la sesión se detiene.

### 6.1 Órdenes con `deadline_ms < gap_to_ms`: decisión de Fran pendiente

`cancel_for_source_loss` cancela toda orden de P cuya ventana se solapa con `[since_ms, gap_to_ms]` (`hi = min(gap_to, deadline) > lo`). Una orden con `deadline_ms <= since_ms + limit_ms` terminó su ventana sin superar el umbral: lo correcto es que venza por `no_quote_in_window`, no que se cancele por `source_stale` (condición 10 de Fran). Cuando hay ticks de reloj vence antes. Sin ticks, no: `_expire` depende del producto (una cotización de otro producto solo vence órdenes de ese producto, `execution_timing.py:205`) y el vencimiento global solo llega con un tick (`:236`). La orden de P sigue pendiente hasta la cotización de cierre de P, y ahí el camino de #165 también la cancelaría. **Diferir no cambia el resultado: solo lo posterga**, así que no existe `source_stale_deferred`.

Opciones para Fran:

- **(a) Pedido a 9A** (único dueño de `paper_runner.py`): parámetro opcional que deje fuera las órdenes con `deadline_ms < gap_to_ms`, aplicable en los dos caminos (abierto y cierre de #165), más una forma determinista de vencerlas (por ejemplo `_expire` del producto en `t_ms`) sin inventar eventos. Cambia #168 y exige revisión propia.
- **(b) Aceptar** que esas órdenes se cancelen por `source_stale`, como ya hace #165 hoy, y declararlo en la documentación y en el registro (`trigger` y `deadline_before_gap_to: true` en `source_stale_detected`).

**Decisión de Fran (16:07Z, D-17-19): opción (a); rechaza aceptar cancelaciones `source_stale` de órdenes cuya ventana terminó antes de superar el umbral.** Autoriza al responsable de 9A a modificar #168 (PR acotada o commit adicional). Contrato obligatorio de Fran:

1. Si `deadline_ms` es anterior al primer instante de superación del umbral, la orden vence normalmente.
2. Si el umbral se supera mientras la orden sigue siendo ejecutable, puede cancelarse por `source_stale`.
3. La misma regla en silencios abiertos y cerrados.
4. La igualdad en los límites se resuelve explícitamente: el silencio es excesivo solo cuando supera el umbral (`gap_to_ms = since_ms + limit_ms + 1`).
5. Se reutiliza la lógica de vencimiento de `TimedExecutor`, con sus motivos originales.
6. Sin cotizaciones, ticks ni timestamps retroactivos inventados para provocar vencimientos.
7. Durable, idempotente y recuperable tras `SIGKILL`.
8. Sin cambios en posiciones, stops, estrategias ni contabilidad.

La implementación en `paper_runner.py` es de 9A (pedido enviado). Esta rama no copia ni reimplementa nada del runner: usa la firma nueva cuando 9A la entregue, y la parte de sesión que cancela queda bloqueada hasta entonces. El ingestor (silencios abiertos durables, registros y recuperación) no depende de 9A. Después, 9A/D revisan #168 y se actualiza #165 y este diseño.

Pruebas adicionales exigidas por Fran, comparando órdenes, motivos, journal y estado financiero entre corrida continua y recuperada: deadline antes del umbral; deadline exactamente en el límite; orden vigente al superarse el umbral; silencio abierto sin cotización posterior; cotización que cierra el silencio después del deadline; dos productos con órdenes y deadlines distintos; recuperación después de una caída anterior y posterior al vencimiento. Se suman a los casos L y O de §8.1.

Resoluciones de la revisión de D sobre b1e941e:

- **Borde (D-17-22):** `stale_quote_gaps` usa `>` (`paper_live_integration.py:170`) y `_expire` vence con `now > deadline` (`execution_timing.py:262`). Por lo tanto `deadline_ms < gap_to_ms` vence y `deadline_ms >= gap_to_ms` puede cancelarse. Se prueban los dos bordes: `deadline = gap_to - 1` (vence) y `deadline = gap_to` (se cancela).
- **Sesión (D-17-20):** `affected_orders` de #165 (`paper_live_integration.py:180`) usa el mismo solapamiento que el runner, así que hoy anota en `pending_hit` órdenes que ahora deben vencer. La sesión aplica la misma regla (`deadline_ms >= gap_to_ms`) y registra aparte las que vencen (`expired_not_cancelled`) y las canceladas, según lo que devuelva 9A.
- **Reloj del vencimiento (D-17-21), para el contrato de 9A:** hay que fijar qué `now_ms` usa el vencimiento dentro de `cancel_for_source_loss`. En el camino abierto solo existe `t_ms = gap_to_ms`; en el de cierre, `on_quote` vencería con `received_ms` (`execution_timing.py:205`) pero la declaración usa `persisted_at`. `decided_at_ms` debe coincidir entre la corrida continua y la recuperada, y el caso L lo compara.

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
5. Fila con `persisted_at` en `(released_ms, observed_until_ms]` de un silencio ya observado, **sin cancelación declarada** (D-17-09, D-17-16): se entrega al runner como siempre, se escribe `silence_contradicted` enlazado, el `silence_open` previo no cambia y la recuperación da el mismo resultado. Caso aparte: fila con `persisted_at <= released_ms` (tardía de verdad), solo se cuenta.
   5b. Fuente totalmente muda sin filas: los registros llevan `clock: "process"`, no entran en la comparación de determinismo y ninguno llega a `gap_to`. La prueba sigue hasta que la fuente vuelve: la primera fila real no genera `silence_contradicted` (D-17-11).
6. Caída entre `audit.jsonl` y el checkpoint, en ambos órdenes: la auditoría se rehace desde el checkpoint sin duplicados.
7. Idempotencia: repetir `recover()` y repetir `observation`.
8. Checkpoint viejo sin los campos nuevos: se restaura vacío, sin error.
9. Producto que nunca cotizó (`never_quoted`) y varias órdenes con ventanas distintas (`silence_at_window_end` por orden).
10. Cantidad de `observation` acotada con 8 productos callados.
11. Mutaciones: quitar `observed_until_ms` del checkpoint rompe el caso 1; quitar `observation_gap` rompe 4; no registrar `silence_contradicted` rompe 5.
12. Digests financieros de 10D: **verificar y explicar** (D-17-22). Sin órdenes con `deadline < gap_to` que hoy se cancelan al cierre, deben ser idénticos (864 señales, 436 órdenes, 3 cierres); si el mundo sintético tiene alguna, la diferencia se enumera orden por orden (de `source_stale` a vencimiento) y no cambia fills, posiciones ni caja.

### 8.1 Pruebas obligatorias de la decisión de Fran

Cada una compara corrida continua y recuperada (equivalencia financiera donde sea comparable: `comparable_state`, órdenes, posiciones, caja) y fija las formas esperadas de §7:

- A. La fuente nunca vuelve a emitir, con una orden pendiente: se cancela por `source_stale` con el silencio abierto, sin cotización inventada; luego no vence.
- B. La orden llega al final de su ventana con el silencio abierto: se comprueba la condición antes del vencimiento ordinario y se cancela; con condición no cumplida, vence como hoy.
- C. Un producto silencioso con otros productos activos: solo se cancelan sus órdenes; las de los otros productos, posiciones y stops quedan idénticos.
- D. Caída durante el silencio abierto (todos los `POINTS`, SIGKILL): una sola cancelación, idempotente, con `observation_gap` y sin contarlo como silencio.
- E. Recuperación posterior al vencimiento: una orden ya vencida o ya llenada no se cancela (sin cancelaciones retroactivas).
- F. Evento de mercado retenido con `t_ms` anterior al avance de observación: se entrega antes de declarar; si es del mismo producto el silencio desaparece y no hay cancelación; el reloj del journal no pasa por delante.
- G. Fila tardía posterior a una cancelación del camino (b) (`persisted_at <= gap_to_ms`): no entra al runner (`released_ms` adelantado en la misma operación, y recuperado de `runner.source_losses` tras una muerte entre cancelación y checkpoint), queda `silence_contradicted`.
- K. Misma cancelación, distinto sondeo y caídas: el digest financiero y el `t_ms` de la entrada `source_loss` son idénticos en corrida continua y recuperada (D-17-13).
- L. Orden con `deadline_ms < gap_to_ms` y sin eventos intermedios: queda fijado el resultado de la opción elegida en §6.1: con (a), elegida, vence por `no_quote_in_window` en ambos caminos y se prueba que dan lo mismo.
- O. Dos productos cuyo `gap_to_ms` cruza el mismo evento: las declaraciones salen en orden `(gap_to_ms, product_id)`; sin `source_loss_in_the_past`, incluido el caso en que uno de ellos cierra por cotización de #165 en el mismo paso (D-17-17).
- M. Muerte entre `cancel_for_source_loss` y el checkpoint del ingestor, con una fila real de `t <= gap_to_ms` en la fuente (D-17-14 iii).
- N. Vela atrasada de otro producto con `t <= gap_to_ms`: se entrega, no se descarta (D-17-14 i).
- H. Audit adelantado con checkpoint anterior (muerte entre ambos) y a la inversa: sin duplicados ni registros distintos.
- I. Cota del proceso (fuente totalmente muda) nunca cancela.
- J. Mutaciones: cancelar con `t_ms` = reloj del sondeo rompe K; usar `observed_until_ms` como `gap_to` rompe la equivalencia; adelantar `released_ms` sin las condiciones de (b) rompe N; no recuperar `released_ms` de `source_losses` rompe M; quitar la comparación `gap_to_ms <= deadline_ms` rompe B.

## 9. Hallazgos de D resueltos

D-17-01 reemplazado por D-17-09 (§3, §6) y D-17-10 (§3, caso 5b), D-17-02 (§4), D-17-03 (§4, caso 3), D-17-04 (§5, §7, caso 6), D-17-11 y D-17-12 (§3, §4, caso 5b), D-17-13 a 22 (§3, §3.1, §6, §6.1, §8 caso 12, casos G, K a O), LOW 05 (`silence_at_window_end`), 06 (`never_quoted`), 07 (tope de `observation`), 08 (§10).

## 10. Dónde se implementa

Dos PR apiladas, ninguna toca `paper_runner.py`, #168, contabilidad ni estrategias:

1. Ingestor: `paper_live_ingest.py` y sus tests, base #166 (#172 @ d122f51).
2. Sesión: checkpoint/auditoría, `classify_gap` y `affected_orders` (D-17-20) en `paper_live_integration.py`, y los casos 2, 3, 6 y 9, base #165 (que contiene #166), después de la primera (#174).

Los intervalos (`product_silence_ms`, `dead_after_ms`, `hold_ms`) siguen siendo hipótesis, como 15/25/45 s. Sigue sin cubrirse lo que el ingestor no ve: filas podadas por la captura o una fuente que reporta datos viejos como nuevos. Sin sesión real, bases ni endpoints nuevos.

## 11. Contrato de #168 @ 750f96a incorporado (Fran 17:48Z, puntos 2, 3 y 5)

- **Firma única:** la sesión llama solo a `cancel_for_source_loss(product_id, gap_from_ms, gap_to_ms, t_ms, threshold_ms)`. El umbral es el `max_quote_gap_ms` de la identidad inmutable de la sesión, el mismo que usan `stale_quote_gaps`, `affected_orders` y la declaración; no hay un valor implícito distinto. Un umbral distinto para el mismo intervalo lo rechaza el runner (`source_loss_conflict`).
- **Sin lógica de vencimiento duplicada:** ni el ingestor ni `LiveSession` deciden cuándo vence una orden. Las que tienen `deadline_ms <= desde + umbral` (igualdad incluida) vencen dentro del runner con `TimedExecutor.expire_orders` y sus motivos originales (`no_quote_in_window`, `no_valid_quote_in_window`); la sesión solo las lista como `expiring` en la evidencia y omite la declaración abierta si no hay ninguna que cancelar.
- **Registros separados:** la observación (`observation`, `observation_gap`, `silence_open`, `silence_contradicted`, `silence_at_window_end`) es del ingestor; la decisión es el `source_loss` del runner, que en el audit lleva `cancelled` (por `source_stale`), `expired` (vencimientos ordinarios), `expired_reasons`, `threshold_ms`, el intervalo `gap` y `declared_ms`. Un vencimiento ordinario nunca figura como cancelación de fuente.
- **Instante de la declaración:** `t_ms = gap_to` (última cotización + umbral + 1), por el flujo o por la prueba de la observación; en el diario queda `max(t_ms, último t_ms)`.
- **Pruebas en el circuito completo** (`TestSilenceStillOpen`, `TestDeadlineAgainstTheThreshold`, `TestOpenHolesOrder`, `TestSourceStaleCancellation` con SIGKILL real): deadline antes, igual y después del límite, silencio abierto sin cotización posterior, cotización que cierra el silencio, dos productos, recuperación tras la caída, caída entre `source_loss` y `source_loss_expiry` y entre la declaración y el checkpoint, con equivalencia de órdenes, motivos, cartera y evidencia entre corrida continua y recuperada. Diferencia operativa propia de la recuperación: si la caída ocurre antes de la declaración, `declared_ms` es el reloj de la recuperación.
