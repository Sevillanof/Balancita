# Etapa 9A: replay histórico aislado con ejecución modelada

Prueba de integración y reproducibilidad del motor existente contra velas y funding públicos de Kraken. **No es evidencia de rentabilidad independiente**: las velas ya se usaron en investigación previa y toda ejecución es `MODELLED_EXECUTION` (no existe bid/ask histórico).

## Qué hay

| Módulo                | Qué hace                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay_data.py`      | Puerta de datos: `mode=ro`, `PRAGMA query_only=ON`, rango fijo `2025-10-13 <= t < 2026-08-02` (el periodo reservado no se lee), consultas acotadas, verificación de series     |
| `replay_execution.py` | `ModelledExecutor`: llena órdenes con un precio de vela fechado en el instante del fill; nunca crea `QuoteWatch` ni cotizaciones                                               |
| `replay_specs.py`     | C29, C30 y C32 desde sus archivos `config/strategies/*.json`, con el intérprete declarativo existente (`propose_spec`), sin reimplementar ni aproximar; hashes de spec fijados |
| `replay_compare.py`   | Comparación entre escenarios: señales, órdenes, trades y trayectoria, por separado                                                                                             |
| `replay_driver.py`    | Genera los eventos (velas, funding, ciclos, precios modelados), corre el `PaperRunner` en `execution_mode="modelled"` y escribe `results.json` una sola vez                    |
| `paper_runner.py`     | Solo agrega `execution_mode` (por defecto `quotes`, idéntico a 8A-8C), el evento `modelled_price` y el rechazo de `quote` en modo modelado                                     |

No hay segundo motor: decisión, tamaño, costes, funding y contabilidad son `Portfolio`, `Book` y `futures_costs`, sin cambios.

## Estrategias congeladas (A1)

La corrida usa C29, C30 y C32 tal como están congeladas (`strategy_set=frozen`, por defecto). `SpecSignalStrategy` entrega el cuadro del ciclo a `propose_spec` (el mismo intérprete del forward) y traduce la propuesta al contrato de señales del runner. Un spec editado, con otro hash que el fijado en `FROZEN_SPEC_HASHES`, no carga. Los `mx-*` quedan solo como fixtures (`strategy_set=mx`).

Paridad demostrada (tests): para las mismas velas cerradas y el mismo instante de evaluación, acción, dirección, precio de referencia, indicadores (ATR, logret, logvol, `fundpct`), stop, objetivo (a menos de un tick), horizonte, códigos de razón, condiciones e identidad de estrategia coinciden con `futures_simulator.frames` + `propose_spec`.

Paridad **no** reclamada, por diseño: el forward evalúa cada vela de 1 min con un libro independiente de 100 USD por estrategia; el replay decide en el último minuto de cada barra de 5 min y comparte una cartera (un trade bloquea al siguiente, el capital es común). Las señales son comparables, los trades no. La cartera compartida es un experimento aislado; el régimen del forward sigue siendo 100 USD fijos por trade (ADR 0001) y este replay no lo reemplaza.

**Alcance de la paridad:** es paridad del camino de código (mismo intérprete e indicadores sobre las mismas velas), no contraste con resultados reales del forward: el forward empezó en octubre, dentro del periodo reservado, y no puede compararse en la ventana autorizada. Los trades del replay (una posición por producto, cartera compartida) no son comparables con los libros de 100 USD del forward.

## Funding: aislamiento y causalidad (A2, A3)

Dos límites distintos: el **límite global** (2026-08-02T00:00Z, periodo reservado, nunca se lee) y el **límite local** de cada lectura (el fin de datos de la corrida). La respuesta guardada de Kraken contiene un año de horas, incluidas las reservadas, y SQLite carga el valor completo si se lo consulta con `substr`, `length` sobre un `CAST` o funciones JSON: eso **no** se considera aislamiento.

`relative_funding` lee la respuesta con E/S incremental de SQLite (`Connection.blobopen` en Python >= 3.11; `sqlite3_blob_*` vía ctypes en Python < 3.11), en bloques de 512 bytes, y se detiene en el primer periodo con inicio `>=` el límite local. Si no hay E/S incremental disponible, **no lee** (no hay camino de respaldo que cargue el valor entero). El límite local no puede ser posterior a `cap - 48 h` (`FUNDING_MARGIN_MS`): el bloque leído tras el límite queda dentro del historial autorizado y el límite global no se alcanza ni siquiera por ese bloque. Por eso una corrida no puede decidir ni cargar datos en las últimas 48 h antes del cap (la ventana aprobada llega hasta `2026-07-31T23:59Z`). Se usa siempre `relativeFundingRate`, nunca se convierte la tasa absoluta. Respuestas: la más vieja y las dos más nuevas, igual que el forward.

Qué está demostrado y qué no:

- Demostrado (test sintético, ambos lectores): se destruyen todas las páginas de la respuesta desde el cap en adelante y se rompe el puntero de la página anterior; la lectura incremental devuelve exactamente lo mismo, mientras que una lectura completa del valor falla. Es decir, las páginas posteriores no se leen.
- No demostrado: no hay traza de E/S del sistema operativo sobre una base real; el manifest registra el lector, el bloque, los bytes leídos, el límite local y el global.
- Las corridas y auditorías hechas **antes** de este cambio (humo con los cuatro escenarios; primera auditoría de paridad de fuentes) usaron un lector que carga el valor completo (`substr`) y que parseó el primer periodo reservado para detectar el límite: no deben presentarse como aisladas.

- Una hora llega a `inicio + 1 h + 10 min`; una hora ausente es desconocida, nunca 0.
- Decisión de Fran (14-oct): se reproduce exactamente el cálculo vigente de C32 (`FundingContext.percentile()`, sin modificar ni reimplementar) y se expone su incertidumbre. El carry-forward no queda aprobado como política definitiva.
- Auditoría por evaluación (`funding_audit.jsonl`, con hash en `results.json`): hora de decisión, última hora usada y su antigüedad, horas faltantes, registros usados, duración real de la ventana, si hubo carry-forward (y su causa: `data_gap`; una hora aún en espera de publicación se marca aparte, no es carry-forward), percentil del forward y si la señal dependió de evidencia incompleta.
- Lectura estricta independiente, solo diagnóstico (`replay_funding_audit.py`): exige la última hora elegible presente y 720 horas naturales consecutivas, sin tratar horas desconocidas como cero ni arrastrar tasas; si falta evidencia devuelve `unknown`, nunca una señal alternativa. No altera decisiones, trades, P&L ni contabilidad. `funding_diagnostics.audit` informa evaluaciones, carry-forward, ventanas incompletas, señales originales que desaparecen, señales adicionales o distintas y porcentaje de divergencia. No es evidencia de rentabilidad.
- Paridad de fuentes: un test compara, sobre una base sintética con revisiones distintas, los periodos que lee el forward (`load_periods`) con los del replay (misma selección: la respuesta más vieja y las dos más nuevas, primera vista gana).

## Política de ventana (A6)

`window_policy`: `decide_until_data_end` (política objetivo y valor por defecto, decisión de Fran 2026-10-14: se decide hasta el fin de los datos; las posiciones abiertas salen como `open_at_window_end`, marcadas a la última vela, y nunca se cierran con precios posteriores) o `cut_decisions_24h_before_end` (política original de las primeras corridas, conservada para reproducirlas). La política queda en el manifest y en `results.json`. Los resultados distinguen P&L realizado (trades cerrados) de P&L no realizado (posiciones abiertas) en `pnl_split`; no se comparan corridas con posiciones abiertas como si fueran resultados realizados.

## Comparación de escenarios (A5)

`python -m balancita_engine.replay_compare SALIDA.json DIR1 DIR2 ...` separa: señales idénticas, decisiones comparables, órdenes divergentes, trades que existen solo en algunos escenarios, diferencias de ejecución de oportunidades comparables y trayectoria global (la diferencia de P&L se parte en trades comparables, solo del escenario y solo de la base). No se atribuye todo el cambio al slippage ni se supone un orden entre escenarios. `S0` es contrafactual; `S2` es estrés no causal.

## Evidencia (A7)

Las velas OHLC no son cotizaciones: ninguna operación se clasifica como observada. Cada trade lleva `evidence_class`: `estimated_by_ohlc` (stop, objetivo o cierre inferidos de velas) o `uncertain_entry_minute_stop` (stop asumido dentro del minuto de entrada: el extremo puede haber ocurrido antes del fill).

## Reglas temporales (por regla, no por `known_at` del backfill)

- La vela 1 m `b` llega en `b + 60 s + 2 s`; el ciclo de la barra 5 m que cierra en `c` llega en `c + 2 s`, después de la vela.
- El funding de la hora `[s, s+1h)` llega en `s + 1 h + 10 min`. Una hora ausente es desconocida, no 0.
- Escenarios de ejecución (sensibilidad, no observaciones): `S0` contrafactual, apertura de la vela donde cierra la decisión (un precio anterior a la entrega de la decisión); `S1` (base) apertura de la vela siguiente; `S2` extremo adverso de la vela de entrada (estrés, no causal); `S3` = `S1` más un impacto adicional igual al impacto vigente de cada producto: sensibilidad experimental autorizada por Fran el 2026-10-14, sin validación para operaciones futuras ni para cambiar el modelo financiero (parámetros y advertencias en el manifest).
- La vela del minuto de entrada la resuelve el ejecutor: si su rango toca el stop, cierra en el stop con evidencia `assumed_stop_entry_minute` (estimada); un objetivo tocado se ignora.

## Uso

```
PYTHONPATH=python python3 -m balancita_engine.replay_driver \
  --candles-db <market.sqlite> --funding-db <market.sqlite> --products PF_XBTUSD \
  --decision-start 2026-03-01 --decision-end 2026-03-08 --scenario S1 --out <directorio-nuevo>
```

`--strategy-set frozen|mx` y `--window-policy` completan las opciones. Solo lectura sobre las bases; escribe únicamente en `--out`. Se niega a arrancar si hay huecos de velas 1 m en la ventana de decisión (salvo `--allow-gaps`, que queda declarado en el manifest), revisiones conflictivas, OHLC inválido o una ventana fuera de rango.

## Limitaciones

Stop con evidencia OHLC (estimada); parámetros de ejecución, riesgo y sizing son hipótesis no aprobadas; "funding conocido al inicio de la hora" es una hipótesis no probada (por eso el retraso de 10 min); `S2` usa información posterior al fill.

## Paridad de fuentes de funding (opción B)

`python -m balancita_engine.replay_funding_parity FUENTE_DEL_FORWARD OTRA_BASE PRODUCTO SALIDA.json` compara, solo lectura y dentro del rango autorizado (hasta `cap - 48 h`), la fuente que usa el forward (`server/data/dev-live/futures-market.sqlite`, según `scripts/dev-provider-env.mjs`) con otra base: periodos, tasas, horas faltantes, percentil de `FundingContext` en cada hora publicada y señales de C32. Las pruebas sintéticas no sustituyen la comprobación sobre datos reales.

### Alcances declarados de la paridad

- La señal C32 se compara solo por bandas de percentil (`pct_low`/`pct_high`), no por el valor numérico del percentil.
- El rango replayable de funding termina en 2026-07-31T00:00Z (tope global menos 48 h). `load_data` rechaza un `data_end` posterior.
- Las 7-8 horas faltantes por producto son horas desconocidas, no rellenadas. El informe de paridad por producto debe listarlas (`missing_hours_list`) junto con sus registros en la tabla de períodos; las de febrero son solo 2 de ellas.

### Residuo del aislamiento

Aun con el lector incremental, el read-ahead del sistema operativo y su caché de páginas pueden haber tocado bytes posteriores al corte. Esto no se puede descartar sin una traza de E/S del SO; el manifest declara «no OS-level I/O trace».

### Traza de bytes entregados al lector (criterio de Fran, 2026-10-14)

No se exige traza de E/S del sistema operativo: se exige una prueba a nivel de bytes entregados al lector y de períodos decodificados. Por cada respuesta leída, el manifest (`reads` → `funding_stream` → `responses`) y la salida de paridad (`trace`) registran: fuente, SHA de la respuesta, offset inicial (`first_read`), último rango (`last_read`), cantidad de lecturas, bytes pedidos y recibidos, offset máximo exclusivo, contigüidad desde 0, hash de la lista completa de lecturas, `delivered_sha256` de los bytes entregados, el máximo `timestamp` que aparece en esos bytes (escaneo independiente del parser), períodos decodificados y el máximo decodificado, límite local y motivo exacto de detención (`first_period_at_or_after_local_limit`, `end_of_rates_array` o `end_of_blob`).

Reglas que abortan con error explícito: un `timestamp` de período igual o posterior al tope global (2026-08-02T00:00Z) en los bytes entregados o en un período decodificado; respuesta truncada o fuera de orden antes del corte; falta de E/S incremental (no hay lectura completa de reserva). Consecuencia: un salto temporal que lleve el siguiente período a la zona reservada dentro del mismo bloque de 512 bytes que el período de corte falla en vez de continuar. El margen de 48 horas es el mecanismo; esta traza es la prueba.

Casos adversariales (`python/tests/test_replay_9a_isolation.py`): horas consecutivas con la primera fecha no permitida pegada a la última procesable, horas faltantes, saltos largos (con y sin llegar a la zona reservada), respuesta truncada antes y después del corte, JSON malformado tras el corte, orden inverso antes y después del corte, BLOB grande con páginas de overflow, sin fallback a lectura completa. En datos reales se exige que la traza cumpla las mismas propiedades (contigua desde 0, sin timestamps reservados en los bytes entregados, mismo motivo de corte). Las lecturas físicas de páginas de SQLite no se interpretan como acceso lógico a los períodos que contienen.

Refuerzos tras la revisión de D (D-9A-26/27/28): un `timestamp` cortado en el borde del último bloque entregado aborta si su prefijo visible (de 7 caracteres o más) alcanza el prefijo del tope; un prefijo visible menor que el del tope pasa y queda registrado en `unresolved_partial_timestamp` (por ejemplo `2026-07-3`); solo un prefijo de a lo sumo 6 caracteres (el año) es indecidible y no puede contener información del holdout. El orden de claves del fragmento posterior al corte no se verifica porque nunca se decodifica. La corrida aborta si en los bytes entregados hay menos sellos que períodos decodificados, y si la primera clave de un período no es `timestamp`. Las lecturas son bloques contiguos de `chunk_bytes` desde el offset 0 (`contiguous_from_zero`); `first_read`, `last_read` y `reads_sha256` permiten reconstruir la lista completa.
