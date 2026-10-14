# Etapa 10D: integración sintética completa

Estado: borrador, solo offline. No lee capturas reales, no abre procesos persistentes, no toca estrategias congeladas
(C29, C30, C32), forward, Kronos, Qwen, captura ni ADR. `paper_runner.py` no se modifica aquí (es de 9A; la rama contiene el cambio de #168).

Pila: esta rama parte de la rama de #153 (9A, 977e542) y contiene las ramas de #163 (10C, 12dc0c0), #164 (volumen,
4302be1, sobre #161), #166 (continuidad de la fuente, 7180560) y #168 (cancelación `source_stale`, 92b86ab). Nada se copió: se
fusionaron las ramas. Cambios propios:

- `python/balancita_engine/paper_live_integration.py`: la sesión (`LiveSession`), el diario de auditoría y los puntos de falla.
- `python/balancita_engine/paper_live_evaluator.py`: un único gancho de pruebas (`self.fault`) en `feed_candle`, sin efecto si es `None`.
- `python/tests/live_world.py` y `python/tests/test_paper_live_integration.py`: mundo sintético y 50 pruebas.

## 0. Árbol de dependencias

```
main
 └─ #153 9A replay y runner (56d9e04)
     ├─ #168 cancelación source_stale (92b86ab)
     ├─ #163 10C evaluador vivo (c5b31d7)
     └─ #167 adaptador de funding contable (diseño, sin integrar)
 └─ #161 10B ingestor offline
     └─ #164 velas con volumen (4302be1)
         └─ #166 continuidad e identidad de la fuente (7180560)
#165 10D integración = #153 + #163 + #164 + #166 + #168 (fusionadas, nada copiado)
```

El adaptador de funding (#167) no está integrado en 10D: la sesión sigue usando la tabla sintética de devengo.

## 1. Camino de eventos

```
SQLite sintética (velas 1m con volumen, cotizaciones bid/ask, synthetic_fundpct, synthetic_accrual)
  └─ SourceReader (solo lectura)
      └─ Ingestor.poll          bucket_ms -> bucket_start, OHLCV exacto, volume_btc nunca inventado
          ├─ vela válida   -> LiveEvaluator.feed_candle  (1º: evaluator.jsonl con fsync; 2º: evaluación)
          │                     └─ evento de ciclo (RP.make_cycle_event) -> PaperRunner.handle
          ├─ vela inválida -> evidencia de rechazo en audit.jsonl, nunca una señal
          ├─ cotización    -> PaperRunner.handle (cola de ejecución de 9A)
          ├─ fundpct       -> LiveEvaluator.feed_funding   (percentil de C32)
          └─ accrual       -> evento `funding` del runner  (devengo de posiciones)
  PaperRunner -> Portfolio -> runner/runner-journal.jsonl (+ señales y checkpoint propios)
  Cada paso: poll -> entrega -> audit -> runner.checkpoint() -> session-checkpoint.json
```

El checkpoint de sesión nunca va por delante de ningún diario. Se escribe con tmp, fsync, `os.replace` y fsync del directorio.

## 2. Identidades y relación entre los diarios

| Archivo                   | Qué guarda                                                                                                                                                           | Identidad                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `session.json`            | identidad inmutable de la sesión (`session_id`, fuente, productos, ventana, estrategias y hashes, tope de cuadros y ciclos, configuración del ingestor y del runner) | `session_id`                                     |
| `evaluator.jsonl`         | entradas del evaluador con cadena de hashes                                                                                                                          | su cabecera lleva `session_id` y `config_digest` |
| `audit.jsonl`             | evidencia (rechazos, conflictos, cuadros descartados, evaluaciones fallidas, fondeo tardío, cortes de fuente), idempotente, `record_id` = hash del contenido         | cabecera con `session_id`                        |
| `runner/`                 | diario del runner, señales y su checkpoint                                                                                                                           | el checkpoint del runner declara el `session_id` |
| `session-checkpoint.json` | cursor del ingestor, longitudes y cabezas de hash de los tres diarios                                                                                                | `session_id`                                     |

`recover` verifica todo antes de llamar a `PaperRunner.recover` (que escribe una entrada de recuperación). Una sesión rechazada
queda intacta (prueba incluida). Motivos de rechazo estables: `session_mismatch`, `checkpoint_foreign_session`,
`checkpoint_ahead_of_runner|evaluator|audit`, `checkpoint_foreign_*_journal`, `runner_checkpoint_foreign_session`,
`runner_checkpoint_behind`, `evaluator_<motivo>`. Recuperar con otros `max_pending_frames`, `retain_cycles`, otra fuente o
otra configuración del ingestor se rechaza explícitamente.

## 3. Resultados financieros sintéticos (corrida continua)

Mundo determinista: velas de 1 minuto con volumen, 3 cotizaciones por minuto con medio spread de 0,05 pb, historia de fondeo
declarada sintética, decisiones durante un día más el seguimiento hasta cerrar.

- 864 señales, 436 órdenes, 3 operaciones cerradas, 0 posiciones abiertas.
- Comisiones: 1,186825 USD. Fondeo contabilizado por el portafolio: 0,945780 USD (3 ajustes de fondeo aplicados por el mecanismo existente del runner, tasa sintética explícita `0.0001`).
- Equity: 1031,3785 USD (cuenta experimental del runner, no el forward de 100 USD fijos).
- Digests: financiero `cf0446c1…351c`, órdenes `57031c71…6c80`, señales `32c1c980…5081`.
- Sin obligaciones de fondeo ni ciclos abiertos al final (`integrity()`).

Referencia independiente: un `PaperRunner` en memoria alimentado con eventos construidos directo de las listas del mundo
(cotizaciones por fórmula, velas y ciclos por `RP.product_events`, eventos de devengo con `make_event`), sin ingestor, evaluador
vivo, diarios ni sesión. Las pruebas exigen igual contabilidad y digests.

## 4. Fondeo: dos canales separados

- `synthetic_fundpct` solo alimenta `evaluator.feed_funding` (percentil de C32).
- `synthetic_accrual` solo se convierte en eventos `funding` del runner (devengo de posiciones).
- Tablas, cursores y liberación por `arrival_ms` separados. Prueba: cambiar la tasa de devengo cambia el dinero y no cambia una sola señal; cambiar `fundpct` cambia señales y no el devengo.
- Alcance: el devengo usa tasas sintéticas explícitas. No se definió ninguna fuente real de fondeo devengado (D-10C-4 sigue abierto).

## 5. Continua vs recuperada

La corrida B parte de una instantánea de calentamiento por `recover` y se compara paso a paso con la continua (estado, señales,
órdenes, fills, operaciones, contabilidad y digests). También hay una corrida de un día completo con una muerte en la entrada y una
doble muerte consecutiva, ambas convergen al resultado continuo.

## 6. Cortes de proceso por frontera

Se inyecta `FaultInjected` (BaseException) en cada punto de `POINTS`, antes de la entrada, la salida y la aplicación del fondeo:

| Frontera                                                  | Punto                                                    |
| --------------------------------------------------------- | -------------------------------------------------------- |
| (a) lectura del ingestor y entrega al evaluador           | `after_poll`, `before_handle`                            |
| (b) escritura del log del evaluador y evaluación          | `input_logged`                                           |
| (c) evaluación del ciclo y diario del runner              | `after_evaluation`                                       |
| (d) diario del runner y checkpoint                        | `after_runner`, `after_audit`, `after_runner_checkpoint` |
| (e) escritura temporal del checkpoint y reemplazo atómico | `checkpoint_tmp_written`, `after_checkpoint`             |

Tras la recuperación se exige: mismas señales, órdenes, fills, operaciones, resultado y estado contable; ninguna operación
duplicada; ninguna obligación de fondeo perdida (muerte justo antes del evento de fondeo lo aplica una vez). También: muerte con
orden pendiente sin tiempo caído deja la orden, y con tiempo caído la cancela y lo dice (`runner_interrupted`).

## 6 bis. Reloj a su cadencia normal y terminación real del proceso

Pedido de Fran (11:50Z). Las pruebas de las secciones 3 a 6 desactivan los eventos `clock` para poder compararse con la
referencia independiente, que no los tiene. Se agregan dos clases que usan los `clock` del ingestor a su cadencia normal (cada
5 s de tiempo de la fuente, más de 10.000 eventos en el día sintético):

- `TestClockAtItsNormalCadence`: los `clock` llegan al runner a la cadencia normal; una segunda corrida que parte de una recuperación llega al mismo estado paso a paso; las nueve fronteras de `POINTS` en la entrada dan el mismo resultado que la corrida continua; una muerte entre dos `clock` ni repite ni salta un tick.
- `TestRealProcessTermination`: el proceso hijo `python/tests/live_kill_worker.py` recupera el directorio, arma `os.kill(os.getpid(), SIGKILL)` en una frontera y da un paso. El padre verifica que terminó por SIGKILL (si la frontera no se cruzó, la prueba falla), recupera el directorio desde disco en otro proceso y compara cada paso posterior contra la corrida continua. Cubre las nueve fronteras y la muerte en el séptimo ciclo de un paso con varias velas.

Limitación: el padre y el hijo comparten sistema de archivos y caché; no se simula pérdida de datos no sincronizados.

## 7. Evidencia de errores

La evidencia se escribe en `audit.jsonl` antes del checkpoint, con identificador derivado del contenido, por lo que una muerte
ni la pierde ni la duplica (pruebas de muerte antes y después de la escritura de auditoría). El diario rechaza una cadena cortada
y repara una última línea a medio escribir. Cubre: vela con volumen no numérico (evidencia, no señal), vela sin volumen (no se
inventa), fondeo tardío, conflictos de velas, cuadros vencidos y cortes de la fuente.

## 8. `source_stale` (D-10C-3): cancelación durable por el punto de entrada del runner

La sesión llama a `PaperRunner.cancel_for_source_loss(product_id, gap_from_ms, gap_to_ms, t_ms)` (#168, reutiliza el executor y el diario del runner; no toca estrategias, stops de posiciones abiertas ni riesgo).

- Funciones puras `stale_quote_gaps` y `affected_orders`; la sesión las aplica por cotización (`_continuity`) **antes** de entregar al runner la cotización que cierra el hueco, con `t_ms` igual al tiempo del diario de esa cotización (el runner exige `t_ms >= gap_to_ms`).
- Si hay órdenes pendientes del producto cuya ventana solapa el hueco, la sesión llama al runner y escribe `source_stale_cancellation` con `applied: true`, el hueco y los ids que devolvió la API (la API también cancela, de forma conservadora, una orden decidida durante el hueco). Si el runner lo rechaza, escribe el registro con `applied: false` y el código del rechazo y **la sesión se detiene** con el error; no entrega la cotización a órdenes que debieron cancelarse.
- `flush_audit` además vuelca cada `source_loss` que el runner dejó durable (`source: runner`, `kind: source_loss`). Así, una muerte entre la cancelación y la escritura del registro de la sesión no pierde la evidencia: se deriva de nuevo del diario del runner.
- El runner es idempotente por `(producto, desde, hasta)`: reentregar la cotización tras una recuperación no cancela dos veces.
- **Cotización previa tras una recuperación:** `LiveSession.recover` toma la cotización previa de cada producto del runner (`quote_t_ms`, `last_quote_ms`), no de la memoria del proceso muerto. Sin eso, un hueco abierto cuando el proceso murió (inicio del hueco ya procesado, final todavía no entregado) no se veía y la primera cotización posterior llenaba la orden. Una cotización reentregada nunca retrocede ese valor.
- Límite de continuidad por defecto: 15 s (hipótesis, sin validar con datos reales). Las pruebas del circuito usan 25 s porque las cotizaciones sintéticas llegan cada 20 s; el hueco de la prueba es de 40 s (la cotización de 10 s de un minuto falta), menor que los 45 s del silencio del ingestor.
- Una pausa de 45 s no es garantía suficiente (prueba incluida).

Pruebas (`TestSourceStaleCancellation`): el hueco cancela la única orden pendiente antes de la cotización que lo cierra (el `source_loss` y el `order_cancelled` van antes en el diario del runner); sin la cancelación (límite desactivado) esa cotización llena la orden (regresión); solo se cancela esa orden; y, con terminación real (SIGKILL) del proceso hijo en `after_poll`, antes de entregar el evento previo a la cotización final, justo antes de ella, justo después y al final de la entrega, el proceso recuperado cancela la orden una sola vez, antes de la cotización, con los mismos `financial_digest`, órdenes, operaciones, `source_losses`, entradas `source_loss` y `order_cancelled` y evidencia de auditoría que la corrida continua (los puntos incluyen la caída entre la cancelación y el checkpoint: `after_audit`, `after_runner_checkpoint`, `checkpoint_tmp_written`, `after_checkpoint`). `state_digest` no se compara entre corrida continua y recuperada porque cuenta las entradas de recuperación; sí entre ejecuciones iguales. Además: repetir el mismo intervalo (llamada directa y por la sesión) no escribe nada; si el runner rechaza la cancelación, el registro queda `applied: false` con el código del rechazo, sin ids, y la sesión se detiene sin entregar la cotización. Las suites de reloj normal y SIGKILL de 6 bis se repitieron completas con el runner nuevo (45 pruebas OK antes de añadir estas dos).

Dos productos, posiciones y stops, en la sesión (`TestSourceStaleInTheSessionWithTwoProducts`): el mundo del circuito tiene un solo producto, así que estas pruebas usan la `LiveSession` real (`_deliver`, `_continuity`) sobre un `PaperRunner` real que recibe eventos escritos a mano con los auxiliares de las pruebas de recuperación del runner. Prueban el cableado de la sesión, no las estrategias: con una orden pendiente de BTC y otra de ETH, un hueco de 26 s en BTC cancela solo la de BTC (motivo `source_stale`, ids en la auditoría con `applied: true`), la posición nunca se abre y la de ETH sigue pendiente; sin el límite la misma cotización llena la orden; con dos posiciones abiertas, un hueco de 35 s no llama al runner, no escribe `source_loss` y los stops y objetivos no cambian. Lo que no cubre ninguna prueba de esta rama: un hueco con posición abierta y orden pendiente de otro producto dentro del circuito completo (SourceReader a Journal) con estrategias reales; el circuito completo tiene un producto y las órdenes de una posición abierta del mismo producto se rechazan, no quedan pendientes.

## 9. Mediciones

Mundo sintético de un día de decisiones: corrida continua 41 s, preparación completa de las pruebas 73 s, crecimiento máximo de
memoria ~175 MB, 282 pasos, 13.308 eventos del runner, 14.064 entradas del diario del runner, 8.405 del log del evaluador,
437 del diario de auditoría. Memoria del evaluador al final: 288 ciclos, 288 banderas, 0 cuadros pendientes, 2.880 velas vistas.
La suite de integración tarda ~290 s sin reloj y otros ~250 s con reloj y terminación real (dos mundos sintéticos), por lo que el trabajo de Python de CI se alarga.

## 10. Riesgos sin resolver

1. Los umbrales de continuidad (15 s de la sesión, 15 s de silencio de producto, 45 s de la fuente) son hipótesis sin validar con datos reales.
2. No hay fuente real de fondeo devengado; el devengo solo se probó con tasas sintéticas (D-10C-4).
3. El runner emitió 3 rechazos `late_candle` en el mundo sintético; se registran pero no se investigó su origen en datos reales.
4. Residuos BAJOS de la revisión de D: `dropped_on_recovery` sin tope; la etiqueta `frame_expired` tras una recuperación puede confundirse con cuadros reconstruidos.
5. `last_quote` por producto se acota en memoria, pero el calentamiento histórico real necesitaría autorización para leer datos.
6. El agregado de 5 minutos del evaluador no es la barra oficial de Kraken; la paridad con velas reales no está probada.
7. La ejecución con cotizaciones observadas es simulada; no hay bid/ask histórico.
8. Duración de la suite (~9 min en local) y 175 MB de pico en CI.
9. Las pruebas de corte con `FaultInjected` son inyecciones en el mismo proceso. La terminación real (SIGKILL, ver 6 bis) es de un proceso hijo en el mismo equipo y sistema de archivos; un corte de energía con pérdida de la caché del sistema de archivos no se prueba.

### Residuos BAJOS de la revisión de D (declarados, no resueltos en esta PR)

- `late_candle`: los 3 rechazos los emite el runner y aparecen igual en el oráculo independiente, por lo que no vienen de la integración. Su causa exacta en este mundo sintético no se investigó.
- Un `frame_expired` real entre el último checkpoint y una muerte se pierde como evidencia (el cuadro se reconstruye al recuperar y se cuenta como `dropped_on_recovery`).
- `_due_funding` asume `arrival_ms` monótono por `rowid`. La fuente real tendría que garantizarlo.
- `source_stale` solo se evalúa cuando llega la cotización siguiente; un corte que no termina no genera evidencia hasta que termine (la API del runner declara la pérdida una vez observado su final).
- D-10B-17 (#166): los silencios abiertos del ingestor no son durables ni se vuelcan a `audit.jsonl`.
- Base: esta rama ya incluye la 9A actual (f32ff48 y 56d9e04).

## 11. GO/NO-GO para una sesión paper temporal (no iniciada)

**NO-GO por ahora.** La integración sintética está demostrada y es reproducible (revisión independiente de D sobre 92ecf02: sin
BLOCKER, HIGH ni MEDIUM), pero antes de una sesión temporal con cotizaciones observadas faltan:

1. ~~Punto de entrada de cancelación por `source_stale`~~: hecho en #168 y cableado aquí; falta su merge y la decisión de Fran.
2. La fuente de fondeo devengado real (D-10C-4): el diseño del adaptador está en #167; falta confirmarlo con datos reales (autorización de Fran).
3. ~~D-10B-06 y D-10B-07~~: hechos en #166 (silencios de producto y de fuente, `data_gaps`, origen REST/WS, época). Esta rama ya los contiene; cambió el `event_id` de las cotizaciones (D-10B-15) y se repitió la suite completa. No se vuelcan a `audit.jsonl` ni son durables los silencios abiertos (D-10B-17).
4. La autorización de Fran para el alcance de la sesión (duración, productos, ruta de datos).

Con esos puntos cerrados y CI 5/5 sobre el HEAD final, el GO es razonable.
