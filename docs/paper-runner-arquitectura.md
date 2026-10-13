# Paper Runner (etapa 8): arquitectura

Estado: **fase 8B** (durabilidad y recuperación; 8A ya fusionada en #140). Código: `python/balancita_engine/paper_runner.py`, `paper_runner_store.py`; pruebas: `python/tests/test_paper_runner.py`, `test_paper_runner_recovery.py`. Solo paper, sin red, sin reloj de pared, sin credenciales. **No está conectado al forward, `capture`, Kronos, Qwen, ninguna base ni flujo público.** No cambia las estrategias congeladas (C25-C31 y Kronos según `AGENTS.md`; C32 en observación), `PortfolioPolicy`, el ADR 0001 ni su enmienda pendiente de dimensionamiento dinámico (queda desactivado).

## 1. Qué es (y qué no)

Una capa de coordinación. Recibe eventos de una fuente explícita, los ordena causalmente, los registra, y los reparte a los componentes existentes. **No implementa reglas de trading, riesgo, costes ni contabilidad**: todas siguen donde estaban.

```
evento de entrada ──► validar/deduplicar ──► journal (write-ahead) ──► aplicar a componentes ──► resultado observable
                          (runner)               (runner)                (existentes)               (runner, solo lectura)
```

### Componentes reutilizados (y quién manda en qué)

| Responsabilidad                                            | Componente (sin cambios)                                      | Qué hace el runner con él                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Estrategias y contrato de señal                            | `multi_signals`, `signal_continuity.evaluate_cycle`           | llama a `evaluate_cycle` con las estrategias congeladas y guarda con `SignalLog.ingest`       |
| Registro durable de señales, `guard_entry`, reconstrucción | `signal_continuity.SignalLog`                                 | única fuente de verdad de las señales; el runner solo guarda referencias (`key`, `seq`, hash) |
| Orden causal, ventana de ejecución, precio ejecutable      | `execution_timing.TimedExecutor`                              | `submit` / `on_quote` / `advance` / `on_candle`; no se reimplementa ningún chequeo            |
| Cartera única, dimensionamiento, límites, suspensiones     | `portfolio.Portfolio` + `PortfolioPolicy`                     | una sola instancia; el runner no lee ni escribe sus parámetros                                |
| Vigilancia por cotización                                  | `portfolio_watch.QuoteWatch` (vía `TimedExecutor(watch=...)`) | cableado; un cierre por cotización no se repite al llegar la vela                             |
| Motor de posiciones, salidas, P&L                          | `futures_simulator.Book` (vía `Portfolio`)                    | nada directo                                                                                  |
| Comisiones y costes                                        | `futures_costs`                                               | nada directo                                                                                  |
| Funding tardío, conciliación, disputas, reclasificación    | `portfolio_funding`, `Portfolio.dispute_funding`              | 8C: eventos `funding` y `reconcile`                                                           |
| Auditoría contable independiente                           | `portfolio_audit.audit` / `accounting_digest`                 | 8C: se ejecuta sobre el resultado integrado                                                   |

Lo **único nuevo**: sobre, orden y deduplicación de eventos, journal del runner, máquina de estados, huella de configuración, contrato de lectura. Nada de eso decide una operación.

## 2. Modelo de durabilidad: journal de entradas + replay determinista

Decisión central (consultada con el asesor; ver §8): **la verdad durable es un journal append-only y encadenado por hash de las _entradas_ del runner, no un volcado del estado.** El estado financiero (`Portfolio`, `Book`, `TimedExecutor`, `QuoteWatch`) es una función pura del journal. Recuperar = construir componentes nuevos y re-aplicar el journal; el checkpoint no guarda estado, guarda **resúmenes verificables** (hash del journal en la posición N + digests contables) que el replay debe reproducir.

Por qué así:

- Los `Book` y el `Portfolio` guardan estructuras (`Decimal`, objetos, deques) que no tienen formato versionado y la alternativa existente es `pickle`, prohibido como formato de producción. Serializar el estado exigiría tocar módulos de las etapas 5-7. El replay no toca ninguno.
- "Un checkpoint nunca declara procesado un evento cuyos efectos no son recuperables" se cumple por construcción: los efectos **son** una función del journal, y el checkpoint se escribe después de que la entrada esté en disco.
- La prueba de equivalencia pedida (continua = interrumpida = en otro proceso) es la propiedad básica del diseño, no un añadido.
- Costo: el replay es O(n) en eventos. Aceptable para esta etapa (sesiones paper offline). Si más adelante hace falta, un snapshot versionado se añade como optimización verificable contra el replay, no como fuente de verdad.

### Tipos de entrada del journal (contrato `balancita-paper-runner-journal.v1`)

Cada línea: `{seq, t_ms, kind, data, prev, hash}`, mismo formato que `SignalLog` / `Journal` (hash encadenado, `fsync` antes de contar como escrita, cola truncada = escritura incompleta, cualquier otro daño = rechazo).

| `kind`              | Clase                                 | Contenido                                                                                         | Se re-aplica en replay                                                                     |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `run_start`         | control                               | manifiesto de configuración (§5)                                                                  | verifica                                                                                   |
| `event_accepted`    | **entrada**                           | sobre del evento (`cycle`, `quote`, `candle`, `funding`, `reconcile`, `clock`) tal como se aplicó | sí                                                                                         |
| `signals_persisted` | **entrada**                           | referencias a las señales que el ciclo escribió en `SignalLog` (`key`, `seq`, `entry_hash`)       | verifica contra `SignalLog`, no re-evalúa                                                  |
| `decision`          | **entrada**                           | `signal_key`, `decided_ms`, `reference_price`, `atr`                                              | sí (`TimedExecutor.submit`)                                                                |
| `event_rejected`    | informativa para el estado financiero | sobre + motivo (`duplicate`, `conflict`, `out_of_order`, `invalid`)                               | solo contadores y, en 8B, el `OffsetLedger` (un evento rechazado **sí** consume su offset) |
| `order_cancelled`   | **entrada** (8B)                      | cancelación explícita `runner_interrupted` con el intervalo no cubierto                           | sí (`TimedExecutor.cancel`)                                                                |
| `recovery`          | control                               | qué se reanudó, qué se declaró no cubierto                                                        | no                                                                                         |

Las **decisiones del runner** son entradas explícitas (con su propio `decided_ms`) y no un efecto implícito de la llegada de la señal. Esto es lo que permite distinguir A (señal persistida, decisión pendiente) de una decisión ya tomada, y evita que una recuperación "decida en el pasado": una obligación pendiente se decide con el reloj de la recuperación y `guard_entry` rechaza lo vencido.

Las **salidas** (órdenes ejecutadas/rechazadas/vencidas, cierres, snapshots) no se escriben como verdad: se derivan. El runner las expone y guarda su digest en el checkpoint.

### Operaciones atómicas (a implementar en 8B)

1. Persistir una señal: `SignalLog.ingest` (ya atómico por línea + `fsync`).
2. Aceptar un evento: **una** línea `event_accepted` con `fsync`. Antes de ella el evento no existió para el runner; después, el replay lo reproduce. Un fallo entre la línea y la aplicación en memoria no pierde nada.
3. Checkpoint: archivo temporal + `fsync` + `os.replace` + `fsync` del directorio (patrón `write_atomic`), después de 2.

`SignalLog` y journal del runner son dos archivos. La relación es de orden de escritura: la señal se persiste **antes** de que el runner registre `signals_persisted`. Señal en `SignalLog` sin referencia en el journal = ciclo evaluado cuya decisión quedó pendiente (caso A); es una obligación detectable, no un estado inconsistente. Referencia en el journal a una señal ausente en `SignalLog` = corrupción, se rechaza.

## 3. Máquinas de estado

### Runner (operativo)

```
CREATED ─► PROCESSING ─► FINISHED
              │  ▲
              ▼  │
          DEGRADED          (datos insuficientes, hueco sin evidencia, conflicto de funding abierto)
              │
 crash ─► RECOVERING ─► PROCESSING | REFUSED   (checkpoint/journal corrupto, config incompatible)

STOPPED: parada ordenada (sin pérdida de obligaciones)
```

`SUSPENDED_ENTRIES` **no es un estado del runner**: es una bandera derivada de `Portfolio.suspension_state`, ortogonal. Solo bloquea nuevas entradas (ya implementado en `Portfolio._validate`); el runner nunca consulta la suspensión para cerrar, vigilar, contabilizar, conciliar, recuperar ni auditar.

### Orden (señal → posición)

```
SIGNAL_PERSISTED ─► DECIDED(pending) ─► OPENED ─► CLOSED
        │                 │
        │                 └──► REJECTED  (motivo del ejecutor o de la cartera)
        │                 └──► EXPIRED   (no_quote_in_window / no_valid_quote_in_window)
        └──► NOT_ACTIONABLE (WAIT) | REJECTED (reconstruida, vencida, causalidad)
```

Se corresponde 1:1 con los registros de `TimedExecutor` (`pending`, `opened`, `rejected` con su motivo); `EXPIRED` es el subconjunto de rechazos por ventana. El runner no inventa estados que los componentes no tengan.

## 4. Invariantes (cada una tiene prueba)

| #   | Invariante                                                                                                                                               | Dónde se garantiza              | Cobertura 8A                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------- |
| I1  | `candle_close ≤ generated ≤ persisted ≤ decided ≤ execution_eligible ≤ entry`                                                                            | `guard_entry` + `TimedExecutor` | sí                                 |
| I2  | señal reconstruida nunca abre; señal vencida nunca abre                                                                                                  | `guard_entry`                   | sí                                 |
| I3  | el precio de referencia no sustituye a una cotización ejecutable; sin cotización válida en ventana → rechazo                                             | `TimedExecutor`                 | sí                                 |
| I4  | una cotización posterior no mejora una decisión anterior (la primera cotización usable manda)                                                            | `TimedExecutor`                 | sí                                 |
| I5  | evento duplicado (mismo `event_id` y contenido) se ignora y se cuenta; mismo `event_id` con contenido distinto es conflicto y nunca reemplaza al primero | runner                          | sí                                 |
| I6  | evento fuera de orden (llegada anterior al reloj del runner) se rechaza, no se reordena                                                                  | runner (política explícita)     | sí                                 |
| I7  | un cierre por cotización no se repite al llegar la vela; un solo cierre                                                                                  | `QuoteWatch`                    | sí                                 |
| I8  | un capital no se reserva dos veces: la reserva ocurre solo en `Portfolio.decide` al ejecutar, y es secuencial                                            | `Portfolio`                     | sí                                 |
| I9  | misma secuencia de eventos válidos ⇒ mismo `accounting_digest` y mismo hash de journal                                                                   | replay                          | sí (en memoria); 8B entre procesos |
| I10 | un checkpoint no declara procesado un evento no durable                                                                                                  | orden de escritura              | 8B                                 |
| I11 | `source_offset` confirmado solo si es contiguo; huecos explícitos                                                                                        | `OffsetLedger`                  | 8B                                 |
| I12 | una suspensión no bloquea cierres, vigilancia, funding, conciliación, recuperación ni auditoría                                                          | `Portfolio`                     | 8C                                 |
| I13 | una posición abierta durante una interrupción declara la falta de cobertura de mercado; nunca "protegida" sin cotizaciones que lo demuestren             | runner (`coverage_gap`)         | 8C                                 |

## 5. Huella de configuración (manifiesto)

Se escribe en `run_start` y se compara en cada recuperación; cualquier diferencia **rechaza** (no hay migración implícita):

`strategies` (id, versión, `code_hash` y `pipeline_hash` de `SignalLog.frozen`), `execution_policy_hash`, `watch_policy_hash`, `stop_policy` (gap), `portfolio_policy_hash` + parámetros de `PortfolioPolicy`, `cost_model_version` + `cost_model_hash`, esquemas (`balancita-paper-runner-journal.v1`, `...-checkpoint.v1`, `balancita-signal-log.v1`, `balancita-execution-timing.v1`, `balancita-portfolio.v2`, `balancita-quote-watch.v1`), y las hipótesis de política etiquetadas `experimental` (`latency_ms`, `max_execution_delay_ms`, vigilancia, política de gaps): no son valores validados ni optimizados.

No se incluye el código fuente de cada módulo: cualquier corrección de código invalidaría todo journal antiguo. La deriva de comportamiento la detecta el replay (los digests del checkpoint no coinciden → `REFUSED`). Ver decisión D3.

## 6. Contrato de lectura (preparación para el frontend; sin UI)

`balancita-paper-runner-report.v1` (solo lectura, versionado): `status`, `orders` (pendientes/ejecutadas/rechazadas/vencidas con motivos), `portfolio` (snapshot), `integrity` (último checkpoint, eventos pendientes, huecos, auditoría), `alerts`, y cada dato etiquetado `observed` | `estimated` | `simulated` | `uncertain`. En 8A solo `status` y `orders`; el resto en 8B/8C.

## 7. Riesgos de integración

1. **Dos archivos (señales y journal del runner)**: sin transacción común. Mitigado por el orden de escritura (§2) y por la verificación cruzada al recuperar.
2. **Replay y deriva del código**: un cambio de comportamiento en un componente da otro estado con el mismo journal. Mitigado por digests en el checkpoint; no por hash de código (D3).
3. **`confirmed_source_offset`** de la etapa 5 es "mayor reconocido", no contiguo. No se usa como confirmación; 8B añade `OffsetLedger`.
4. **`TimedExecutor` exige eventos en orden de tiempo y rechaza los atrasados**: bien para causalidad, pero obliga al runner a ordenar la fuente antes de entregar (política I6: rechazar, no reordenar).
5. **Las velas se aceptan con `bucket` estrictamente creciente por producto**, y la vela del minuto de entrada no evalúa el stop. Es un límite declarado de la etapa 7, no se oculta.
6. **Hipótesis de ejecución no validadas** (latencia 1 s, ventana 60 s, spread 30 pb, etc.): el runner las usa y las etiqueta, no las optimiza.
7. **La cartera no reserva capital para órdenes pendientes**: dos órdenes pendientes pueden pasar ambas la validación individual; la reserva ocurre al ejecutar, secuencialmente, y la segunda ve el capital que dejó la primera. Es el comportamiento de la etapa 6; no se cambia.

## 8. Decisiones (aprobadas por Fran tras revisar 8A, PR #140)

| #   | Decisión                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Estado y alcance                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | Tres PR independientes (8A, 8B, 8C); 8B parte de `main` una vez fusionada 8A                                                                                                                                                                                                                                                                                                                                                                                                      | aprobada                                                                              |
| D2  | Journal de entradas + replay determinista; sin snapshot serializado ni `pickle`                                                                                                                                                                                                                                                                                                                                                                                                   | aprobada                                                                              |
| D3  | Manifiesto de políticas/esquemas/estrategias y digests de estado. **8B debe incorporar además una identificación versionada del comportamiento del motor** (`engine_behavior_id`), escrita en el manifiesto, para que un cambio de comportamiento sea una incompatibilidad declarada y no solo un digest que no coincide                                                                                                                                                          | aprobada; el identificador es trabajo de 8B                                           |
| D4  | Obligaciones pendientes tras una caída: se resuelven con el **tiempo real de la recuperación**; ninguna entrada retroactiva; la recuperación nunca re-ingesta con un `t_ms` pasado; las señales vencidas se rechazan (`signal_expired`)                                                                                                                                                                                                                                           | aprobada                                                                              |
| D5  | No se modifica el dimensionamiento ni el ADR; el tamaño es el de `Portfolio` con `PortfolioPolicy`                                                                                                                                                                                                                                                                                                                                                                                | aprobada                                                                              |
| D6  | Funding contradictorio: solo cuarentena y reclasificación existentes; ningún procedimiento automático de resolución                                                                                                                                                                                                                                                                                                                                                               | aprobada                                                                              |
| D7  | **Opción B**: cancelación explícita con motivo `runner_interrupted`, **únicamente** cuando exista un intervalo de ejecución sin cobertura demostrable (no hay cotizaciones ni velas que cubran el tramo entre la caída y la recuperación). Es una cancelación **solicitada** por el runner; el comportamiento de `TimedExecutor` cuando no se solicita cancelar queda idéntico (misma ventana, mismo `no_quote_in_window`, mismos hashes). La cancelación deja un registro propio | aprobada; se implementa en 8B, con pruebas de que sin solicitud nada cambia (etapa 6) |
| D8  | `gap_declared` manual, durable y auditable. Declarar un hueco **no** declara recuperados los eventos faltantes: solo permite que el offset contiguo avance, y el hueco queda registrado como no cubierto                                                                                                                                                                                                                                                                          | aprobada; se implementa en 8B                                                         |

## 9. Revisión del asesor (Opus) y cómo se resolvió

Veredicto: el diseño es sólido; se cerraron estos huecos.

| Hueco                                                                                                                                                                                                                                     | Resolución                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. "Píldora venenosa": una entrada ya escrita cuya aplicación lanza deja el runner en `REFUSED` para siempre                                                                                                                              | **Se valida por completo antes de escribir en el journal** (`_market_check`: campos, Decimal, velas cerradas/duplicadas/atrasadas). Regla: `_apply` no debe lanzar sobre una entrada que pasó la validación; si lo hiciera es un defecto, no un estado recuperable (prueba: `test_malformed_events_are_rejected_and_journaled`)            |
| B. Entradas fuera del journal (`funding`, `tick_sizes`, `risk_policy`)                                                                                                                                                                    | `funding_hash` y `risk_policy_hash` entran al manifiesto; `tick_sizes` no se usa. Funding nuevo llega como evento en 8C                                                                                                                                                                                                                    |
| C. Contexto `Decimal` global                                                                                                                                                                                                              | `prec` y `rounding` en el manifiesto: una recuperación con otro contexto se rechaza                                                                                                                                                                                                                                                        |
| D. Persistencia retroactiva: re-ingerir una señal con el `t_ms` original la haría parecer persistida en el pasado                                                                                                                         | **Regla**: en replay el `SignalLog` es de solo lectura (`_signals` solo corre en el camino vivo). Toda re-ingesta de una obligación usa el reloj de la recuperación                                                                                                                                                                        |
| E. Orden pendiente que cruza una caída: si la recuperación llega después del `deadline`, `_expire` la culpa al mercado (`no_quote_in_window`); si llega antes, usa la primera cotización posterior aunque hubo cotizaciones no observadas | `TimedExecutor` no tiene motivo `runner_interrupted` ni cancelación. Resolverlo toca la etapa 6. **Decisión D7 (Fran)**                                                                                                                                                                                                                    |
| F. `seq` de un conflicto de `SignalLog`                                                                                                                                                                                                   | `signals_persisted` referencia solo la línea canónica de `kind=signal` (`persisted`/`duplicate`/`already_present`); un `conflict` no genera referencia ni decisión                                                                                                                                                                         |
| Caso A son tres sub-estados                                                                                                                                                                                                               | (1) `event_accepted(cycle)` sin señal en `SignalLog`; (2) señal en `SignalLog` sin `signals_persisted`; (3) `signals_persisted` sin `decision`. 8B los detecta y resuelve cada uno con el reloj de la recuperación                                                                                                                         |
| Invariante nueva I14                                                                                                                                                                                                                      | toda señal original del `SignalLog` tiene un `event_accepted(cycle)` previo; si no, es una escritura huérfana y se rechaza la recuperación                                                                                                                                                                                                 |
| Bases de tiempo                                                                                                                                                                                                                           | velas: `bucket + 60 s`; cotizaciones: `received_ms`; decisiones: `decided_ms`. I6 usa el reloj de llegada (`t_ms`) del sobre, el mismo que ve el ejecutor (`_tick`); una vela con `bucket + 60 s > t_ms` se rechaza (`candle_not_closed`)                                                                                                  |
| Offsets (8B)                                                                                                                                                                                                                              | alcance por `(fuente, stream)`; `epoch` si la fuente reinicia numeración; "procesado" = `event_accepted` o `event_rejected` durable; el cierre señal→decisión es una obligación aparte; un hueco permanente exige una entrada durable `gap_declared` con evidencia (D8); `event_id` manda en la deduplicación, el offset en la continuidad |

## 10. Plan por fase

- **8A (esta PR)**: este documento, contratos de evento y de journal, `RunnerJournal` en memoria, `PaperRunner` mínimo (ciclo → señal persistida → decisión → ejecutor temporal → cartera, con vigilancia por cotización cableada), reconstrucción por replay con digests iguales, pruebas de escenarios 1-6, 8, 18, 20 y de causalidad.
- **8B**: journal en archivo (fsync, cola truncada, rechazo de corrupción), checkpoint verificable, `OffsetLedger`, recuperación en otro proceso, caídas A-C y G, equivalencia continua/interrumpida/otro proceso.
- **8C**: funding, conciliación, disputas y reclasificación integrados; suspensiones a través de caídas; cobertura de mercado durante interrupciones; informe, auditoría independiente, demo y comparación continua vs recuperada.

## 11. Implementación de 8B (durabilidad y recuperación)

**Archivos de una corrida** (directorio): `runner.lock`, `runner-journal.jsonl` (verdad durable), `signals.jsonl` (`SignalLog`), `runner-checkpoint.json` (solo verificación; el `checkpoint` ya **no** es una entrada del journal) y `quarantine/` (copias de evidencia; nunca se borra nada).

**Escritura.** Cada entrada se escribe con `fsync` antes de aplicarse. El checkpoint es atómico (temporal + `fsync` + `rename` + `fsync` del directorio). Puntos de falla inyectables: `before_journal`, `mid_journal` (escritura a medias), `after_journal`, `after_apply`, `before/mid/after_checkpoint`, más los del `SignalLog`.

**Recuperación = replay + obligaciones.** El replay reproduce el estado financiero sin reevaluar estrategias ni escribir en `SignalLog`. Luego se pagan las obligaciones que dejó el proceso caído, siempre con el **reloj de recuperación** (nunca con una hora pasada):

| Caso | Qué quedó a medias                                                      | Qué hace la recuperación                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | ciclo aceptado sin `signals_persisted`, o señal sin decisión            | reevalúa/persiste y decide ahora; `guard_entry` rechaza lo vencido (`signal_expired`)                                                                                                          |
| B    | decisión tomada, aún sin cotización                                     | la orden sigue pendiente; se cancela solo si su ventana quedó sin cobertura (D7)                                                                                                               |
| C    | entrada ejecutada, checkpoint sin escribir                              | el replay reconstruye la posición; se escribe un checkpoint nuevo                                                                                                                              |
| G    | checkpoint corrupto, incompatible, ausente o que el replay no reproduce | se rechaza (`corrupt_checkpoint`, `checkpoint_incompatible`, `checkpoint_missing`, `replay_diverged`) y se copia la evidencia; `bad_checkpoint="rebuild"` es una acción explícita del operador |

Se rechaza también: journal con cadena rota (`journal_corrupt`), journal detrás del checkpoint, `SignalLog` ajeno o más corto, señal sin evento aceptado (`orphan_signal`, I14), configuración distinta (`config_incompatible`) y reloj de recuperación anterior al del journal (`recovery_clock_behind`). Una cola de línea incompleta se trunca y se informa (`tail_discarded_bytes`).

**D3, comportamiento del motor.** El manifiesto incluye `engine_behavior`: huella de un escenario sintético fijo (un LONG que llega al objetivo y un SHORT que toca el stop) que pasa por `TimedExecutor` y `Portfolio`. Si cambia solo esa clave la recuperación se rechaza como `engine_behavior_changed` (no `config_incompatible`). Como los escenarios solo ven los caminos que ejercitan, el manifiesto añade `build_identity` (`balancita-paper-build.1`): hash de los bytes de los módulos financieros (`execution_timing`, `futures_costs`, `futures_simulator`, `multi_risk`, `multi_signals`, `portfolio`, `portfolio_audit`, `portfolio_funding`, `portfolio_watch`, `signal_continuity`). Cualquier cambio en ellos se rechaza como `build_incompatible`, aunque los escenarios den lo mismo; el checkpoint también lo verifica. Consecuencia buscada: tras actualizar esos módulos no se reanuda un diario viejo.

**D7, `runner_interrupted`.** Para cada orden pendiente tras el replay: `desde = max(reloj del journal, earliest_fill_ms)`, `hasta = min(reloj de recuperación, deadline_ms)`. Si `hasta > desde`, se escribe `order_cancelled` (motivo `runner_interrupted`, con el intervalo) antes de cualquier decisión nueva. Sin esa petición `TimedExecutor` se comporta igual que antes (`no_quote_in_window`). Una recuperación al mismo instante del evento caído no cancela nada y produce el mismo estado que la corrida continua.

**D8, `gap_declared`.** Evento manual y durable (operador, motivo, evidencia) que solo acepta rangos de offsets realmente faltantes. Deja avanzar el offset contiguo confirmable, pero el hueco sigue informado como `declared_gaps`; los eventos faltantes **no** pasan a ser "recuperados".

**Un solo escritor.** `runner.lock` lleva un `flock` exclusivo y no bloqueante, tomado en `create` y `recover` **antes** de leer, truncar, poner en cuarentena o escribir nada, y mantenido hasta `close()` o hasta que el proceso muere (aunque sea por `SIGKILL`). Una segunda apertura, del mismo u otro proceso, falla con `directory_locked` sin modificar un solo byte. Una recuperación rechazada libera el lock. `close()` es idempotente y deja la instancia durable inhabilitada para siempre: `handle`, `run`, `finish`, `checkpoint`, `declare_gap` y cualquier escritura del diario fallan con `runner_closed` sin tocar archivos (otro proceso puede ser ya el dueño del directorio); la lectura (`report`, digests) sigue funcionando. Un runner solo en memoria no tiene lock y no se altera.

**Offsets** por `(fuente, stream, época)` (identidad canónica `fuente|stream#época`; `|` y `#` no se admiten en los nombres). Quotes y candles pueden usar ambos el offset 1 sin conflicto y su offset contiguo confirmable se calcula por separado; un `gap_declared` indica también el `stream`. El esquema del diario pasa a `v2` y el manifiesto lleva `offset_identity`. Por identidad se llevan: observado, procesado (rangos), contiguo confirmable, huecos y gaps declarados. Un evento rechazado consume su offset (salvo duplicado, conflicto, offset reutilizado por otro evento o época vieja). Un ciclo solo marca su offset al cerrar sus obligaciones (señales y todas sus decisiones escritas).

**Equivalencia.** Corrida continua, con una o varias caídas y recuperada en otro proceso dan el mismo `financial_digest`, `accounting_digest` y `ledger_hash` (pruebas en `test_paper_runner_recovery.py`, incluido un crash real con `os._exit` y recuperación en un proceso nuevo). Con un reloj de recuperación posterior, la diferencia (señal vencida, orden cancelada) es la esperada y queda registrada.

**Limitaciones de 8B (para 8C).** Sin eventos de funding, conciliación ni disputas (casos D, E, F); sin suspensiones persistidas ni cobertura de mercado por intervalo (I13); sin reporte final ni auditoría independiente integrada; las políticas de ejecución, vigilancia y recuperación siguen siendo hipótesis experimentales. Sin sizing dinámico ni cambios al ADR.
