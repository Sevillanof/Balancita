# Continuidad durable de señales (offline, aislada)

Estado: aislada. No toca el forward activo, C29-C32, Kronos, `capture`, colectores, bases activas, parámetros de riesgo, holdout ni el ADR 0001. No está conectada a la cartera compartida. Sin red, sin reloj de pared, sin aleatoriedad.

Ataca el pendiente de [validación de la cartera offline](validacion-cartera-offline.md): sin un registro durable de señales, lo emitido durante una caída se pierde y nadie lo nota. **No** ataca (y queda fuera) el precio ejecutable posterior a la señal: una señal reconstruida nunca abre una posición retroactiva.

## Auditoría: qué había y qué se reutiliza

| Pieza existente | Qué aporta | Qué falta para este problema |
|---|---|---|
| `multi_signals` (`make_signal`, `validate_signal`, `Strategy`, `SignalContext`) | contrato `balancita-signal.v1`, `signal_id` por contenido | no se guarda como secuencia; `signal_id` incluye la fiabilidad viva |
| `futures_simulator.frames` / `multi_experiment.FrameFeeder` | características sin mirar el futuro (lote / incremental, igual salida) | — (se reutilizan tal cual: el original sale por el camino incremental, la reconstrucción por el de lote) |
| `portfolio_offline.Journal` (#122) | JSONL con cadena de hashes y fsync por entrada | se borra al abrir; rechaza entera una cola cortada; es el diario de decisiones, no el de señales |
| `portfolio_offline` checkpoint | restauración con digest | pickle; el estado de la cartera, no un offset de entrada |
| `multi_store` / `Experiment.save_checkpoint` | `put_signal` idempotente en SQLite, checkpoint de libros | SQLite (base activa); sin offsets ni detección de huecos |
| forward (#90) | relleno de huecos de velas y recuperación | no recupera señales de C31/Qwen; no distingue original de reconstruida en señales |

Decisión: JSONL con cadena de hashes y `fsync` por entrada, como #122 (la auditoría no justificó otra cosa). Es un módulo nuevo, no un segundo motor: `signal_continuity.py` solo usa las piezas de arriba.

## Diseño

**Registro (`SignalLog`, `signals.jsonl`)**: append-only. Entradas: `log_start`, `strategy_frozen`, `signal`, `conflict`, `gap`, `tail_discarded`, `checkpoint_rebuilt`. Cada una lleva `seq`, `prev` y `hash` (SHA-256 canónico).

**Entrada `signal`** (lo necesario para reproducir y auditar): `key` estable = hash de (estrategia, versión, producto, vela de origen); `origin` (`original` | `reconstructed`); la señal completa; `decision_hash` (la decisión sin la fiabilidad viva, que una reconstrucción no puede conocer); `inputs` + `inputs_hash` (precio, características 1m y 5m, régimen que vio la estrategia); `code_hash` de la versión congelada y `pipeline_hash`; `cycle_ms` (cierre de la vela 5m de origen); `generated_ms`; `source_offset` del origen; `valid_until_ms` y `executable`.

**Idempotencia** (por `key`, no por entrega): misma decisión otra vez → `duplicate` (no escribe). Otra decisión para la misma clave → entrada `conflict` (una sola vez) y gana la primera. Una reconstrucción nunca reemplaza un original; un original tardío sí pasa a ser el que cuenta sobre una reconstrucción y deja anotado si coincidía (`matches_reconstruction`).

**Durabilidad antes de procesar**: `ingest` solo retorna cuando la línea está en disco (`fsync`). El `Consumer` entrega al handler solo entradas ya persistidas y mueve el offset después de que el handler vuelve. Orden: persistir → handler (idempotente por `key`) → checkpoint. Una caída repite como mucho la llamada al handler; nunca salta una señal.

**Checkpoint** (`checkpoint.json`, atómico: temporal + fsync + rename + fsync del directorio): `committed_seq`, hash del registro en ese punto, hash de su primera entrada y el mayor `source_offset` **confirmado** (entregado al handler y reconocido, nunca el simplemente persistido), con digest propio. Al reanudar se rechaza (código de salida 3, sin escribir resultados): `corrupt_checkpoint`, `checkpoint_missing`, `log_missing`, `log_corrupt`, `log_behind_checkpoint` (registro truncado), `log_mismatch` (registro de otra corrida). No existe «si falta, empezar de nuevo»; la única salida es la acción explícita `rebuild_checkpoint`, que queda escrita en el registro y relee desde el principio (seguro porque los handlers son idempotentes). Una cola sin salto de línea (escritura que nunca se confirmó) se descarta y se anota como `tail_discarded`; cualquier otro daño rechaza el archivo entero.

**Períodos sin procesamiento**: `detect_gaps` recorre la grilla de 5 minutos por (estrategia, versión, producto) y devuelve tramos sin entrada (los WAIT también se registran: son la prueba de que el ciclo se procesó). `record_gaps` los anota una sola vez. `source_offset_holes` detecta números faltantes en la secuencia del origen (eventos perdidos).

**Reconstrucción** (`reconstruct`): exige (1) estrategias idénticas a las congeladas en el registro (`version_incompatible` si solo hay otras versiones, `code_changed_same_version` si el código cambió sin subir de versión, `pipeline_changed` si cambió el pipeline de características o el contrato de señal, `strategy_not_frozen`), (2) velas 1m y 5m completas, sin huecos ni repetidas, que cubran el último ciclo (`incomplete_candles`). Los varios huecos de una misma estrategia se acumulan. Un ciclo que no se pudo reconstruir (indicadores sin calentar, velas ausentes) queda escrito como `reconstruction_failed` y sigue siendo hueco: el informe de `recover` trae `unrecovered_gaps` y `recovered_completely`. Evalúa con `frames` y marca cada señal `origin="reconstructed"`, `executable=false`, `valid_until_ms=null`, con el hash de las velas usadas.

**Sin posiciones retroactivas**: `guard_entry(entry, ahora)` es la pregunta que todo ejecutor futuro debe hacer; lanza `RetroactiveEntryError` para cualquier reconstruida (aunque alguien ponga `executable=true`) y para un original cuya ventana (`MAX_EXECUTABLE_AGE_MS` = un ciclo de 5 min, más estricta que `max_data_age_ms` de la cartera, sin cambiarlo) ya venció. También exige causalidad: rechaza si la vela aún no cerró en el momento de evaluar (`candle_not_closed`), si la señal se generó después de ese momento (`generated_after_evaluation`) o antes del cierre de su vela (`generated_before_candle_close`). Las reconstruidas llegan al handler como `counterfactual`: sirven para auditoría y evaluación contrafactual.

**Determinismo e integridad**: `verify_log` separa dos afirmaciones: `integrity_ok` (cadena y hashes intactos) y `reproducibility_proven` (todas las señales se reevaluaron desde sus `inputs` con el código y pipeline congelados y dieron el mismo `decision_hash`; si alguna no se pudo comprobar queda en `not_checked`, y `ok` solo significa «sin evidencia de daño»). La prueba clave: las señales reconstruidas (camino por lote) coinciden con las originales (camino incremental) en `decision_hash`; dos reconstrucciones independientes dan la misma cabeza de cadena.

## Simulación de caídas

Puntos de fallo (`arm`): `before_persist`, `mid_persist` (escritura a medias), `after_persist`, `before_ack`. En la CLI, el proceso muere con `os._exit(137)`, sin limpieza.

| Caída | Resultado verificado |
|---|---|
| antes de persistir, sin reenvío | las señales perdidas se reconstruyen (idénticas a la referencia) y **ninguna** abre posición |
| a mitad de persistir, con reenvío | cola cortada descartada; mismas posiciones abribles que sin caída |
| después de persistir, con reenvío | ídem, sin duplicar efectos |
| después de persistir, reinicio tardío | la señal original quedó durable pero vencida (`signal_expired`): no abre posición |
| antes de confirmar, con reenvío | el handler repite, el efecto no se duplica |
| eventos perdidos + duplicados | huecos de origen y de ciclos detectados; duplicados descartados |

## Cómo se ejecuta

```
PYTHONPATH=python python3 -m unittest python/tests/test_signal_continuity.py          # ~30 s, incluye procesos independientes
PYTHONPATH=python python3 -m balancita_engine.signal_continuity_demo --out analisis/continuidad-senales-offline
# a mano, dos procesos:
D=$(mktemp -d)
PYTHONPATH=python python3 -m balancita_engine.signal_continuity produce --dir $D --stop 100 --crash after_persist:40   # muere con 137
PYTHONPATH=python python3 -m balancita_engine.signal_continuity recover --dir $D      # restaura, detecta, reconstruye, escribe report.json
```
`analisis/continuidad-senales-offline/` (`informe.md`, `resultados.json`) es la salida de la demo; una prueba la regenera y exige que coincida.

## Limitaciones para la integración futura (decisión de Fran, 2026-10-13)

- **`confirmed_source_offset` no es una confirmación acumulativa.** Es el mayor offset del origen que fue entregado al handler y reconocido, no necesariamente el último offset *contiguo*: si el origen tiene huecos (eventos perdidos), el valor salta por encima de ellos. No debe usarse como ack acumulativo hacia un productor real (que interpretaría «todo hasta N recibido») hasta resolver esa diferencia, por ejemplo con un offset contiguo aparte y la lista explícita de huecos (`source_offset_holes`).
- **Las reconstrucciones son contrafactuales.** Sirven para auditoría y evaluación contrafactual; nunca son órdenes. `recovered_completely = true` significa únicamente que no quedan ciclos sin señal en el registro; **no** significa que las operaciones perdidas se hayan ejecutado ni que se pudieran haber ejecutado.

## Límites

- Datos sintéticos; no demuestra ventaja de trading ni que el origen real entregue lo que aquí se simula.
- El «origen» es el productor de la demo. Conectar el forward o la cartera es trabajo posterior y requiere decisión de Fran.
- `pipeline_hash` cubre las fuentes de indicadores, características incrementales, régimen, percentil de funding, contrato de señal y las funciones de este módulo que fijan inputs/claves; es deliberadamente más estrecho que «módulos enteros», así que cambios ajenos no bloquean la recuperación, pero un cambio dentro de ese perímetro sí (falla cerrado).
- Solo una estrategia-versión por clave: cambiar parámetros exige subir la versión (y congelar la nueva).
- La reconstrucción no conoce la fiabilidad viva ni Qwen/Kronos: por eso `decision_hash` la excluye.
- La grilla de ciclos supone velas de 5 min; el funding de la demo no se usa (necesita 30 días de historia), aunque `reconstruct` acepta un `FundingContext`.
