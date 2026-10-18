# Diseño: forward incremental con checkpoints

Estado: propuesta con las respuestas del dueño del 2026-10-18 incorporadas (§8); sin cambios de código. Rutas relativas a `python/balancita_engine/`. Complementa `docs/diseno-indicadores-y-qwen.md` y las decisiones 7-11 de la enmienda del ADR 2026-10-18. Todo sigue siendo papel.

## 1. Estado actual

Cada ciclo horario (`run_forward`, `futures_forward.py:303`) y por cada (estrategia, producto):

- **Relee** todas las velas 1m/5m desde `start_ms − WARMUP_MS` (`load_range`, `:323`; `futures_replay.py:24,50`: 2000 barras 5m ≈ 6,9 d) y el funding desde `start − 30 d` (`:328`, `funding_since_ms` en `futures_funding_context.py:324`).
- **Rehace todo**: `replay` (`:330`) recorre cada vela con `frames` (`futures_simulator.py:216`, Decimal en Python puro) y recalcula todos los trades. Coste ∝ historia × estrategias × 8 productos; crece cada hora.
- **Escribe** con `INSERT OR IGNORE` (`:344`) y compara lo guardado con lo recalculado (`:353`). Las tablas derivadas (`forward_recovered`, `forward_diverged`, `forward_open`, `forward_status`) se borran y reinsertan cada ciclo (`:365-389`): la etiqueta `recovered` de un trade ya cerrado puede cambiar si llega una vela tardía.
- **Por qué hubo divergencia y legado.** El trade es función pura de lo que hay en disco hoy: una vela rellenada después cambia trades antiguos (`forward_diverged`), y retirar la puerta de datos obsoletos (#283, `:55,:63`) hizo que lo ya guardado no se reprodujera (`ERA_OLD`, `forward_unclassified`, `:359`).
- **El `spec_hash` es solo parte de la clave** (`:320`): cambiar un spec con el mismo id reproduce toda la historia desde `start_ms` con el spec nuevo. Esto debe prohibirse (§4).
- **Incompatible con borrar datos**: sin 30 d de funding y la ventana de calentamiento, un replay completo daría otros resultados para trades ya decididos.

## 2. Estado persistido por (estrategia, producto, spec_hash)

**Regla de calentamiento.** Al nacer una serie, `warm_start_ms = start_ms − warmup` se fija una vez en el checkpoint 0. «Replay completo» significa siempre desde `warm_start_ms`; así la referencia no depende de qué velas se borren después y la igualdad es bit a bit.

**Checkpoint** (uno por ciclo): `seq`, `last_bucket_ms` (último 1m procesado), `last_5m_ms`, `spec_hash`, `policy` (`stale_gate_from`, `BLOCK_STALE_ENTRIES`), `era`, `catalog_version` (hash de las definiciones de indicadores), `origin` (`start` | `migrated` | `rebuild`), `state_sha256`, `prev_sha256`, `created_ms`. El estado en sí contiene:

- **Posición abierta** (campos de `Book.position`, `futures_simulator.py:343`): lado, entry, stop, target (+`target_text`), `frozen_invalidation`, delegado, `opened_bucket/at`, `horizon_ms`, `quantity`, `reason_code`, decisión asociada; más `recovered_entry` y `late_seen` (se han visto velas tardías entre la entrada y ahora), y las decisiones abiertas de `_open_decisions` que aún esperan su horizonte. Contadores `stale_cycles`, `blocked`.
- **Indicadores**: serialización exacta (`to_state/from_state`, Decimal como texto) de dos `IncrementalFeatures` (1m y 5m): `count`, deques `closes/highs/lows/volumes`, `_ema`, `_atr`, `_rsi`, `_prev_close`, `_logvol` (`:77-90`); más `regime`, el último `current` 1m (= `previous` del siguiente frame) y el último `trend` 5m. El calentamiento acotado **no** sustituye al estado: dos arranques distintos solo coinciden a ≤1e-9, no idénticos. Sirve para arrancar series nuevas y como reserva si falta el blob (se marca `state_rebuilt` y se audita).
- **Funding**: solo para posiciones abiertas, la lista de periodos `(start, rate)` que solapan [entrada, ahora], ampliada en cada ciclo. Al cerrar se usa `accrue_funding` sobre esa lista, igual que el replay completo (mismo orden, mismos Decimal); una posición de más de 7 d no necesita más datos en SQLite. Para la comparación a 24 h (`funding.vs24h`, reservada) basta el funding de las últimas ~27 h (24 h + `MAX_PERIOD_AGE_MS` + margen), reconstruible desde SQLite.

**Dónde.** `forward.sqlite`. `forward_checkpoint` (fila pequeña, solo-añadir, triggers anti UPDATE/DELETE como `forward_trade`, cadena `prev_sha256`). `forward_checkpoint_blob(state_sha256, json)`: caché del estado completo (~100 KB), se conservan los últimos 2 y uno diario; la evidencia es el hash en la cadena, que verifica cualquier blob.

**Atomicidad.** Un ciclo por serie = una transacción `BEGIN IMMEDIATE`: trades nuevos + `forward_era` (`ERA_NOW`) + `recovered` congelado + anomalías + `forward_open`/`forward_status` (vistas derivadas para la API actual) + blob + checkpoint `seq+1`. Se comprueba que `seq` leído sigue siendo el último (un segundo proceso falla, no duplica). Reanudación: leer el último checkpoint, verificar hash del blob y cola de la cadena; si no cuadra, la serie se detiene con código y razón (no calcula).

**Avance del cursor.** Solo hasta la frontera contigua: último 1m `b` tal que existen todos los 1m desde el cursor y los 5m que cierran ≤ `b+1 min`. Un hueco espera `GAP_GRACE` = 15 min (provisional; se ajustará con el retraso máximo medido de llegada de velas en el Mac); pasado el plazo se declara (`forward_hole`, solo-añadir) y el cursor lo cruza igual que hoy lo hace el replay.

## 3. Corrección

**Tests de equivalencia** (`python/tests/test_futures_forward_incremental.py`):

1. _Replay completo vs incremental_: velas escritas a mano (stop y target en la misma vela, vela tardía, hueco declarado, funding con periodo tardío) y una muestra real pequeña del market DB; specs con muchas operaciones y uno con `logvol288`/EMA lentos. Incremental en trozos de tamaño aleatorio (semillas fijas, ≥200, incluido 1 vela y cortes en medio de un 5m o de una posición), con ida y vuelta por JSON en cada corte. Exigir listas de trades **idénticas** (todas las claves, incluidas `_CORE_KEYS`, `net_bp`, `funding_usd`), misma posición abierta, mismos conjuntos `recovered`, mismas decisiones y contadores. Igual en `IncrementalFeatures.to_state/from_state`.
2. _Caída a mitad de ciclo_: inyectar excepción antes del commit y entre la inserción de trades y la del checkpoint; reanudar; sin trade duplicado ni perdido, cadena válida, resultado igual al test 1.
3. _Datos tardíos_: vela **posterior** al cursor que llega tarde → se procesa y las decisiones sobre ella quedan `recovered` (regla de la enmienda). Vela **anterior o igual** al cursor que llega tarde (hueco declarado que se rellena) o revisada (distinto OHLC): se escribe una fila `forward_anomaly(kind late_candle | revised_candle | late_funding, bucket, known_at, hash, seen_ms)` solo-añadir; el cursor, los trades y los checkpoints no cambian (hash de las tablas antes/después idéntico). La detección consulta `known_at > último seen` con `bucket ≤ cursor`. La anomalía aparece en `forward-reliability.json` y la API; `--audit` (§6) muestra su efecto sin escribirlo. Nunca se reescribe nada.
4. _Spec nuevo_, _checkpoint manipulado_ y _dos procesos a la vez_ (§4, §2).

## 4. Cambio de spec

Un `spec_hash` nuevo abre una serie nueva con `start_ms = max(registro, instante de primera vez que se vio ese hash)` (`forward_first_seen` ya existe para ello) y su `warm_start`; nunca se reproduce historia con el spec nuevo. El spec canónico se guarda en el checkpoint 0 para poder auditar. La serie del hash antiguo no abre posiciones nuevas, pero **su posición abierta se gestiona con las reglas del spec ANTIGUO hasta que cierre** (objetivo, stop o regla de cierre); solo entonces empieza a operar la serie del spec nuevo (su primera entrada no puede ser anterior a ese cierre). El spec antiguo canónico se conserva en el checkpoint 0 de su serie para seguir evaluándola. La UI debe mostrarlo: «posición de la versión anterior, se cierra con sus reglas». Ya no existe el estado `abandoned_spec_change`.

## 5. Compatibilidad con retención

El forward incremental solo necesita de SQLite:

- **Velas**: ventana final reciente para detectar anomalías (≥48 h) y, **para arrancar series nuevas o reconstruir estado**, el calentamiento del catálogo (`warmup_bars` = máx. de `needs` +2, ≥288; Wilder 24·n, logvol 12·n → `logvol288` ≈ 3458 barras 5m ≈ 12 d). Las series en marcha no leen historia. Retención de velas ≥ 14 d en SQLite operativo (decisión del dueño), o restaurar el tramo desde Parquet.
- **Funding**: 7 d bastan para coste (posiciones abiertas llevan su lista) y 24 h; un trade cerrado con funding incompleto necesita sus periodos hasta reconciliarse (`futures_funding_reconcile.py:52`), así que no se recorta por debajo del trade pendiente más antiguo. La percentil a 30 d (`fundpct`, `futures_simulator.py:222`) **se descarta** por decisión del dueño (solo la usa C32, retirada); la feature general de funding es la comparación a 24 h (opción b), que se mantiene como señal para estrategias y Qwen. `validate_spec` debe rechazar `fundpct`.
- Archivo Parquet: se puede borrar de SQLite solo tras verificar conteos y hashes (decisión 11); el ledger y los checkpoints no se archivan ni se borran. Un `--rebuild` que necesite datos ya archivados primero los restaura; si no, se niega con `history_unavailable`.

## 6. Migración y `--rebuild`

1. Esquema nuevo (`CREATE IF NOT EXISTS`); `forward_trade`, `forward_era`, `forward_unclassified`, `forward_diverged`, `forward_trade_funding` **no se tocan**.
2. Un último ciclo por la ruta completa (la actual) hasta un `cursor_m` cerrado; su `Book` e `IncrementalFeatures` se vuelcan al **checkpoint 0** (`origin=migrated`, `warm_start` = el actual). Los trades se insertan con `INSERT OR IGNORE`: los antiguos quedan como están, con su era y su `unclassified`; la divergencia se cuenta una vez más y se congela (`forward_diverged` pasa a ser solo informe). Una posición abierta sin etiqueta de entrada conserva `recovered = null` (nunca cuenta). Desde ahí, solo ruta incremental; `--legacy-full` queda un tiempo como ruta de comparación.
3. **`--rebuild`** (ya aparta `forward.sqlite` como evidencia, `futures_forward.py:271`): ahora hace un único pase completo desde `warm_start` con los datos actuales, escribe trades y cadena de checkpoints con `origin=rebuild`, y copia `forward_first_seen`/`forward_policy`. Las tablas de legado no se copian. **`--audit`** (nuevo, solo lectura): replay completo en memoria frente a lo almacenado; informa diferencias, no escribe; se corre periódicamente.

## 7. Plan de PRs y riesgos

1. `to_state/from_state` en `IncrementalFeatures`/`Book`, y `frames` reanudable; tests de ida y vuelta. Cambia `signal_continuity.pipeline_hash` (`:120`): coordinar con el PR 1 del catálogo para pagarlo una vez.
2. Núcleo `step(estado, velas)` + test de equivalencia (§3.1), aún sin usar.
3. Esquema de checkpoints/anomalías/huecos, ciclo atómico y modo sombra (corre ambos, compara, no escribe en el ledger).
4. Migración (checkpoint 0) y cambio de `run_forward`; `--legacy-full`.
5. Regla de cambio de spec y anomalías en resumen/API (`futures_forward_result.py`).
6. `--audit` y nuevo `--rebuild`.
7. Retención: recorte de funding a 7 d y política de velas, tras verificar el Parquet (decisión 11) y varios días de sombra sin diferencias.

Riesgos: tamaño de los blobs (poda); cambios del catálogo invalidan el estado (`catalog_version` distinto → reconstruir desde ventana y marcar); la política de huecos puede retrasar decisiones vivas; un cambio de código del simulador altera el significado de estados viejos (versionar `state_version`); `Book.decisions`/`skipped` ya no crecen sin límite, pero informes que los usen cambian; la etiqueta `recovered` de un cerrado deja de poder cambiar (es intencionado).

## 8. Decisiones del dueño (2026-10-18)

1. **Cambio de spec con posición abierta**: la posición abierta se gestiona con las reglas del spec antiguo hasta que cierre (objetivo, stop o regla de cierre); solo después opera la serie del spec nuevo. La UI lo muestra: «posición de la versión anterior, se cierra con sus reglas» (§4).
2. **`GAP_GRACE` = 15 min**, provisional; se ajustará con el retraso máximo de llegada de velas medido en el Mac (§2).
3. **Retención de velas ≥ 14 días** en SQLite operativo (§5).
4. **Percentil de funding a 30 días (`fundpct`) descartada**; la feature general de funding es la comparación a 24 h (opción b), mantenida como señal para estrategias y Qwen (§5).

No quedan preguntas abiertas.
