# Etapa 10D: integración sintética completa

Estado: borrador, solo offline. No lee capturas reales, no abre procesos persistentes, no toca estrategias congeladas
(C29, C30, C32), forward, Kronos, Qwen, captura ni ADR. `paper_runner.py` no se modifica (es de 9A).

Pila: esta rama parte de la rama de #153 (9A, 977e542) y contiene las ramas de #163 (10C, 12dc0c0) y #164 (volumen,
4302be1, sobre #161). Nada se copió: se fusionaron las ramas. Cambios propios:

- `python/balancita_engine/paper_live_integration.py`: la sesión (`LiveSession`), el diario de auditoría y los puntos de falla.
- `python/balancita_engine/paper_live_evaluator.py`: un único gancho de pruebas (`self.fault`) en `feed_candle`, sin efecto si es `None`.
- `python/tests/live_world.py` y `python/tests/test_paper_live_integration.py`: mundo sintético y 35 pruebas.

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

| Archivo | Qué guarda | Identidad |
| --- | --- | --- |
| `session.json` | identidad inmutable de la sesión (`session_id`, fuente, productos, ventana, estrategias y hashes, tope de cuadros y ciclos, configuración del ingestor y del runner) | `session_id` |
| `evaluator.jsonl` | entradas del evaluador con cadena de hashes | su cabecera lleva `session_id` y `config_digest` |
| `audit.jsonl` | evidencia (rechazos, conflictos, cuadros descartados, evaluaciones fallidas, fondeo tardío, cortes de fuente), idempotente, `record_id` = hash del contenido | cabecera con `session_id` |
| `runner/` | diario del runner, señales y su checkpoint | el checkpoint del runner declara el `session_id` |
| `session-checkpoint.json` | cursor del ingestor, longitudes y cabezas de hash de los tres diarios | `session_id` |

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

| Frontera | Punto |
| --- | --- |
| (a) lectura del ingestor y entrega al evaluador | `after_poll`, `before_handle` |
| (b) escritura del log del evaluador y evaluación | `input_logged` |
| (c) evaluación del ciclo y diario del runner | `after_evaluation` |
| (d) diario del runner y checkpoint | `after_runner`, `after_audit`, `after_runner_checkpoint` |
| (e) escritura temporal del checkpoint y reemplazo atómico | `checkpoint_tmp_written`, `after_checkpoint` |

Tras la recuperación se exige: mismas señales, órdenes, fills, operaciones, resultado y estado contable; ninguna operación
duplicada; ninguna obligación de fondeo perdida (muerte justo antes del evento de fondeo lo aplica una vez). También: muerte con
orden pendiente sin tiempo caído deja la orden, y con tiempo caído la cancela y lo dice (`runner_interrupted`).

## 7. Evidencia de errores

La evidencia se escribe en `audit.jsonl` antes del checkpoint, con identificador derivado del contenido, por lo que una muerte
ni la pierde ni la duplica (pruebas de muerte antes y después de la escritura de auditoría). El diario rechaza una cadena cortada
y repara una última línea a medio escribir. Cubre: vela con volumen no numérico (evidencia, no señal), vela sin volumen (no se
inventa), fondeo tardío, conflictos de velas, cuadros vencidos y cortes de la fuente.

## 8. `source_stale` (D-10C-3 sigue abierto)

Política: cancelar las órdenes pendientes cuya continuidad de fuente se perdió. Aquí está diseñada y probada solo como evidencia:

- Funciones puras `stale_quote_gaps` y `affected_orders`; la sesión las aplica por cotización (`_continuity`) y escribe un registro `source_stale_pending_order` con `applied: false` y `reason: runner_cancel_entry_point_missing`.
- Caso de regresión del corte de 26 s: con el límite de 15 s lo detecta aunque el ingestor (umbral de 45 s) nunca lo llame caída, y se prueba sin duplicar el registro al reentregar la cotización.
- Una pausa de 45 s no es garantía suficiente (prueba incluida).
- **No se cancela nada**: falta un punto de entrada del runner para cancelar una orden por esta causa. Eso es de 9A y debe pedirse por coordinación.

## 9. Mediciones

Mundo sintético de un día de decisiones: corrida continua 41 s, preparación completa de las pruebas 73 s, crecimiento máximo de
memoria ~175 MB, 282 pasos, 13.308 eventos del runner, 14.064 entradas del diario del runner, 8.405 del log del evaluador,
437 del diario de auditoría. Memoria del evaluador al final: 288 ciclos, 288 banderas, 0 cuadros pendientes, 2.880 velas vistas.
La suite de integración tarda ~290 s, por lo que el trabajo de Python de CI se alarga.

## 10. Riesgos sin resolver

1. `source_stale` no se aplica (falta el punto de entrada en el runner, de 9A).
2. No hay fuente real de fondeo devengado; el devengo solo se probó con tasas sintéticas (D-10C-4).
3. El runner emitió 3 rechazos `late_candle` en el mundo sintético; se registran pero no se investigó su origen en datos reales.
4. Residuos BAJOS de la revisión de D: `dropped_on_recovery` sin tope; la etiqueta `frame_expired` tras una recuperación puede confundirse con cuadros reconstruidos.
5. `last_quote` por producto se acota en memoria, pero el calentamiento histórico real necesitaría autorización para leer datos.
6. El agregado de 5 minutos del evaluador no es la barra oficial de Kraken; la paridad con velas reales no está probada.
7. La ejecución con cotizaciones observadas es simulada; no hay bid/ask histórico.
8. Duración de la suite (~5 min) y 175 MB de pico en CI.
9. Las pruebas de corte son inyecciones en el mismo proceso, no `kill -9` reales; el fsync del sistema de archivos real no se prueba.

## 11. GO/NO-GO para una sesión paper temporal (no iniciada)

**NO-GO por ahora.** La integración sintética está demostrada y es reproducible, pero antes de una sesión temporal con cotizaciones
observadas faltan: (1) el punto de entrada de cancelación por `source_stale` en el runner (9A), (2) la decisión sobre la fuente
de fondeo devengado, (3) una revisión independiente de esta PR (agente D) y la autorización de Fran para el alcance de la
sesión (duración, productos, ruta de datos). Con esos tres puntos cerrados y CI 5/5 sobre el HEAD final, el GO es razonable.
