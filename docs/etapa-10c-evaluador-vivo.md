# Etapa 10C: evaluador de sesión con el pipeline del replay 9A

Estado: **diseño, contratos y pruebas sintéticas**. Código nuevo: `python/balancita_engine/paper_live_evaluator.py`; pruebas: `python/tests/test_paper_live_evaluator.py` (28). No hay conexión con la captura real, proceso persistente, lectura de bases reales ni cambios en `paper_runner.py`, forward, captura, Kronos, Qwen, estrategias congeladas, riesgo ni ADR. Sesión de integración: `mode = integration`, `evidence_class = not_forward_evidence`.

**Dependencia de 9A.** Esta PR está apilada sobre la rama de 9A (PR #153) porque importa `replay_driver`, `replay_specs` y `replay_funding_audit`, que solo existen allí. Si #153 cambia esas interfaces o se fusiona primero, hay que reapuntar esta PR; no se copió nada de 9A.

## 1. Qué es y qué no es

Recibe velas de 1 min **cerradas** y horas de funding, y devuelve eventos `cycle` y las señales de C29/C30/C32. Es un adaptador de **uno en uno** (sesión) sobre las mismas piezas que el replay lee en lote:

| Pieza                                                   | Origen (importada, no copiada)                       |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Indicadores incrementales                               | `multi_experiment.FrameFeeder`                       |
| Línea de funding del forward                            | `futures_funding_context.FundingContext` (sin tocar) |
| Condición de ciclo y construcción del contexto de señal | `signal_continuity.on_cycle` / `evaluate_cycle`      |
| C29/C30/C32 con sus hashes fijados                      | `replay_specs.load_frozen`                           |
| Volatilidad que el runner toma como `atr`               | `SpecSignalStrategy.cycle_atr`                       |
| Registro de auditoría de funding                        | `replay_funding_audit.audit_record` / `classify`     |

No se agregó ningún indicador, regla de estrategia, riesgo, costo ni contabilidad. **No es un segundo evaluador**: el evento `cycle` y las filas de auditoría salen de `replay_driver.make_cycle_event` y `replay_driver.funding_audit_row` (exportadas por 9A en #153 @ 2d97cc9); lo propio es la gestión de entradas de una sesión, cubierta por pruebas que comparan contra `replay_driver.product_events`.

## 2. Contrato

```
LiveEvaluator.create(ruta_log, estrategias, productos, decide_from_ms=..., decide_until_ms=...)
LiveEvaluator.recover(ruta_log, estrategias)                      # desde el log de entradas
ev.feed_candle(producto, vela_1m, arrival_ms) -> {cycle, duplicate, rejected}
ev.feed_funding(producto, start_ms, tasa, arrival_ms)
PaperRunner(..., evaluator=ev.evaluator)                          # lo que el runner llama por cada ciclo
ev.identity(spec_identity) / ev.report()
```

La vela es `{bucket_start, open, high, low, close, volume_btc}` (texto), como la lee `futures_simulator.frames`. El `cycle` sale con `t_ms = max(llegada de la vela que cierra la barra, cierre)`, `source`/`stream` configurables (con los del replay, el evento es **idéntico**, incluido su `event_id`).

## 3. Reglas de causalidad

- Un ciclo se evalúa solo cuando llega la vela que cierra su barra de 5 min; no existe ninguna ruta por la que una vela posterior lo alcance (el evaluador no recibe el futuro).
- El funding de una hora entra al contexto cuando llega. `FundingContext.percentile(t)` sigue filtrando por `inicio + 1 h + 10 min <= t`. Una hora que llega **después** de ciclos que la necesitaban queda registrada (`late_funding`, con cuántos ciclos se evaluaron sin ella): esos ciclos fueron causales pero no son los que daría un replay con la serie completa.
- Un minuto faltante es un **hueco**: los indicadores posteriores no son confiables, así que se reconstruye el `FrameFeeder` y no se decide durante el calentamiento que exigen los indicadores declarados (`required_warmup_ms`, mínimo un día); cada ciclo suprimido queda registrado (`suppressed`, motivo `gap_warmup`). El replay se niega a arrancar si hay huecos en su ventana de decisión.
- Una vela inválida (OHLC incoherente, no decimal, bucket desalineado) o con llegada anterior a su cierre se rechaza y se cuenta; no toca el estado ni el log. Una hora de funding que llega antes de terminar (valor provisional) también se rechaza: «el primero visto gana» nunca fija un valor provisional. Una vela repetida con contenido distinto se devuelve como duplicado pero queda registrada en el log como `candle_conflict` (se ve en `report()` y sobrevive a `recover`); la memoria para detectarlo es de dos días de velas.

## 4. Recuperación sin pickle

Cada entrada (vela, hora de funding) se escribe en un **log propio del evaluador**, encadenado por hash y con `fsync`, **antes** de usarse. `recover` vuelve a alimentar ese log a un evaluador nuevo: mismos ciclos, mismos `event_id`, misma identidad. No depende de cuánto retenga la captura ni de serializar el `FrameFeeder`.

- **Contrato del llamador.** El ciclo que devuelve un duplicado se entrega **igual** al runner, que lo deduplica por `event_id`. Si el llamador lo descarta, un ciclo evaluado antes de la caída pero no journalado se pierde (lo demuestra una prueba). `rejected` y `frames` no son durables: tras `recover`, `rejected` empieza vacío (las velas inválidas no se registran en el log) y los cuadros de ciclos que el runner no pidió se descartan pasada una hora.
- Una vela entregada de nuevo (el ingestor repite filas tras una caída) devuelve **el mismo** ciclo la primera vez que se produjo (`duplicate = true`) y no se registra otra vez: el runner lo deduplica si ya lo journaló, o lo procesa si la caída ocurrió entre «evaluado» y «journaled».
- Última línea incompleta del log: se descarta y se informa (`log_tail_discarded`). Una línea alterada, fuera de secuencia o con hash roto: `log_corrupt`. Otro conjunto de estrategias: `strategies_changed`.
- El runner no reevalúa en la recuperación: lee las señales persistidas de su `SignalLog` (decisión 8B).

## 5. Identidad verificable

`identity()` devuelve estrategia (id, versión, hash de spec), tamaños de tick fijados, períodos de indicadores, versión del ensamblado de ciclos, regla de la barra de 5 min, calentamiento, ventana de decisión, hash de código del pipeline del replay y de este módulo, el hash de los archivos de spec (si se pasa lo que devuelve `load_frozen`) y la cabeza del log de entradas. Con la misma configuración, el mismo digest; con otra ventana, otro. Los tests la comparan con el manifest del replay (hashes de spec idénticos).

## 6. Resultados de las pruebas (datos sintéticos de 9A: 37 días, C29/C30/C32 con señales reales)

| Pregunta                        | Resultado                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Mismos ciclos que el replay?   | **Sí, evento por evento**: mismo payload, `t_ms` y `event_id` que `replay_driver.product_events` (más de 200 ciclos)                                                                              |
| ¿Mismas señales de C29/C30/C32? | **Sí**: mismos `signal_id` en el mismo orden que el `SignalLog` del replay; coinciden `set_hash` y `entries_hash` de `results.json`                                                               |
| ¿Mismo orden temporal?          | Llegada no decreciente; cada ciclo después de su vela; señales por ciclo creciente                                                                                                                |
| ¿Mismas barras de 5 min?        | Las 5 min agregadas desde 1 min coinciden con las almacenadas; `consistency_5m_vs_1m`: 0 diferencias, 0 incompletas                                                                               |
| ¿Auditoría de funding?          | El resumen de la sesión coincide con el del replay                                                                                                                                                |
| ¿Lookahead?                     | Recortar el futuro no cambia el pasado; cambiar velas posteriores a un ciclo no cambia ese ciclo (y sí los posteriores); una hora de funding publicada después de un ciclo no lo alcanza          |
| ¿Recuperación?                  | Desde el log: mismos `event_id` y mismo digest; caída entre «evaluado» y «journaled por el runner»: ni se pierde ni se duplica un ciclo; las señales finales son las de la corrida ininterrumpida |
| ¿Datos malos?                   | Hueco de un minuto: reconstrucción y supresión declaradas; vela inválida rechazada; log alterado o ajeno rechazado                                                                                |

## 7. Diferencias de comportamiento (declaradas)

1. **Barra de 5 min.** El replay lee la serie oficial de 5 min; la sesión la agrega desde los 5 minutos que cubre. Sobre datos sintéticos son idénticas; sobre datos reales la diferencia es la que mide `replay_data.consistency_5m_vs_1m` (tolerancia de volumen 1e-6 relativo). **Condición previa a una sesión real**, hoy no verificable (no hay lectura real autorizada).
2. **Huecos.** La sesión reconstruye y suprime; el replay se niega (o continúa con `--allow-gaps`).
3. **Hora de llegada.** El replay usa `cierre + 2 s` por regla; la sesión, la llegada real de la vela. `event_id` coincide con el del replay solo si la llegada es exactamente cierre + 2 s (alcance de la paridad: señales y orden son iguales; la identidad del evento no, con llegadas reales). La señal no depende de ese tiempo (usa `cycle_ms`); sí depende de qué funding había llegado.
4. **Funding tardío.** Ver §3: causal, pero distinto del replay con serie completa; se cuantifica en `late_funding`.
5. **Ejecución.** El replay llena con precios modelados; la sesión, con cotizaciones observadas. **Órdenes, trades y P&L no son comparables** (además, la cartera compartida del runner es solo experimental y el forward sigue con 100 USD fijos). Lo que se compara es todo lo anterior al fill: ciclos y señales. No se afirma paridad financiera.
6. **Cadencia.** Igual que el replay: se decide en el último minuto de cada barra de 5 min; el forward evalúa cada minuto. Señales comparables, trades no (ya declarado por 9A).
7. **Ticks fijados.** El evaluador debe cargar las mismas estrategias (`load_frozen()` con los ticks fijados): con otro tick el objetivo cambia en un tick y el `signal_id` también (lo detectó la propia prueba; ahora la identidad incluye los ticks).

## 8. Bloqueos y pedidos

| #       | Qué                                                                                                                                                                                                          | Dueño                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| D-10C-1 | **Resuelto** por 9A (#153 @ 2d97cc9): `make_cycle_event` y `funding_audit_row`; esta PR ya las usa y no repite el ensamblado                                                                                 | 9A                                       |
| D-10C-2 | **El ingestor de 10B no entrega `volume_btc` en las velas** (solo OHLC), y `logvol` y otros indicadores lo necesitan. Hay que agregarlo al ingestor (y a su `SELECT`) antes de conectarlo con este evaluador | 10B (nueva PR, tras la decisión de Fran) |
| D-10C-3 | Cancelación `source_stale` (D-10-01 = B) y detección fiable de interrupciones: el evaluador no resuelve nada de esto                                                                                         | 9A + coordinador                         |
| D-10C-4 | Eventos `funding` para el runner (acumulación en el portafolio): la tabla `paper_futures_funding_periods` no tiene columna de producto; el evaluador solo usa el funding para el percentil                   | 9A / 10                                  |
| D-10C-5 | Historia de arranque (calentamiento de varios días de velas 1 min y 720 h de funding) desde una fuente autorizada; hoy no se lee ninguna base real                                                           | Fran (autorización)                      |
| D-10C-6 | La puerta 9A sigue abierta: si cambian `replay_driver`/`replay_specs`, esta PR debe seguirlos                                                                                                                | 9A                                       |

## 9. Condiciones que faltarían para una sesión paper temporal

1. Cerrar D-10C-1 a D-10C-4 y la cancelación durable `source_stale` con pruebas adversariales.
2. Autorización de Fran para leer, solo lectura y con rango acotado, la historia de arranque y comparar la barra de 5 min agregada con la oficial en datos reales.
3. Identidad separada de REST y WebSocket, identidad durable de las filas de origen y cursores compatibles con la retención de la captura (requisitos de 10B).
4. Validación de la configuración al restaurar los checkpoints (ingestor, evaluador y runner deben pertenecer a la misma sesión: hoy el checkpoint del ingestor se liga al journal del runner, y el log del evaluador a las estrategias).
5. Un procedimiento de sesión (quién llama a cada paso y en qué orden: ingestor → evaluador → runner → checkpoint) con su propia prueba de caída en cada punto.
6. Presupuesto medido de disco y recuperación en el entorno previsto (no el de la nube).
7. Mantener todas las cotizaciones en el journal durante la validación inicial (decisión de Fran).

## 10. Qué no se hizo

No se conectó con el ingestor real (D-10C-2), no se generaron eventos `funding`, no se evaluó nada sobre datos reales, no se tocó el runner y no se midió el costo de recuperación sobre historia real (el costo de reconstruir el log de entradas sobre historia real no se midió).

## 11. Cierre de 10C: identidad, retención y evidencia (decisión de Fran, 14-oct 09:49Z)

**Identidad durable.** La cabecera del log guarda `config` (estrategias con id, versión y hash de spec; productos; indicadores; tamaños de tick; ensamblado del ciclo; calentamiento; regla de la barra de 5 min; origen de eventos; ventana de decisión; hashes del pipeline de 9A y de este módulo) y su `config_digest`. `recover()` rechaza lo que no coincida: `strategies_changed` si cambia id@version; `config_incompatible` (con las claves que difieren) si cambia cualquier otra cosa, incluido un hash de spec con el mismo id@version, el origen, los ticks o el código; `log_header` si el log no trae identidad. Si no se pasa `source`, se toma el de la cabecera. `identity()` separa `config_digest` (configuración) de `digest` (identidad completa de un resultado, que suma la cabeza del log de entradas). Un cambio de código invalida los logs anteriores a propósito: no se reproduce bajo otro código.

**Retención de cuadros.** Ya no hay límite por edad. Un cuadro espera al runner mientras haya menos de `max_pending_frames` (288 por producto, un día de ciclos de 5 min) más nuevos pendientes; un ciclo evaluado seis horas después de su creación se evalúa igual (prueba). Pasado el límite, el cuadro más antiguo se descarta **con registro** (`frames_expired`); pedirlo después lanza `frame_expired` (o `already_evaluated` / `unknown_cycle`), el runner lo rechaza como `evaluation_failed`, no se crea ni cambia ninguna señal y la causa queda en `evaluation_misses`. En una recuperación del runner, el ciclo abierto sin señales persistidas vuelve a pedir su cuadro: el evaluador recuperado los reconstruye dentro del mismo límite. Memoria: `cycles` y `flags` se acotan a `retain_cycles` (2880 por producto, 10 días); `seen` guarda dos días de velas; `report()["memory"]` informa los tamaños. `audit_rows` crece con cada evaluación de una estrategia de funding y no está acotado: cabe en una sesión temporal, no en una prolongada (a definir al integrar). La política de sesiones largas no se implementa en 10C; el contrato es este.

**Evidencia de rechazos.** `rejected`, `frames_expired` y `evaluation_misses` **no son durables** (se pierden al reiniciar; `candle_conflicts` sí, porque va al log de entradas). Contrato para la integración: el paso de sesión (ingestor → evaluador → runner → checkpoint) vuelca esos registros al journal de la sesión como eventos de auditoría antes de guardar el checkpoint, con la misma regla de orden que el checkpoint del ingestor. No se agrega aquí una segunda infraestructura de persistencia.

**Dependencias que siguen abiertas.**

- D-10C-2: PR #164, aparte, apilada sobre #161: el evento `candle` del ingestor lleva `volume_btc` exacto (texto). Sin lectura de la captura.
- D-10C-3: cancelación `source_stale` con detección fiable de pérdida de continuidad (runner de 9A, vía coordinador).
- D-10C-4: eventos `funding` para la contabilidad del runner. El funding que usa C32 (percentil de la línea publicada del forward) **no es** el funding devengado por las posiciones abiertas: son dos fuentes y dos propósitos; el evaluador solo toca el primero.

**Siguiente hito (no incluido).** Integración sintética completa: SourceReader → Ingestor → LiveEvaluator → PaperRunner → Portfolio → Journal → Recuperación, con interrupciones en cada frontera de persistencia y los mismos digests y estado financiero que la corrida ininterrumpida. Sin captura real ni procesos persistentes.
