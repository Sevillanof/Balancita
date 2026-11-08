# Archivo Parquet a largo plazo (fases 1 a 3)

Diseño: `analisis/archivo-parquet/informe.md` y, para el formato por tabla (formato 2), `analisis/archivo-parquet/formatos-por-tabla.md`. Es un exportador **offline**: lee una **copia** de SQLite, escribe archivos Parquet verificados y un manifiesto; la fase 2 suma más tablas, grupos de filas chicos y el respaldo fuera del VPS. El exportador (fases 1 y 2) no borra nada ni toca la captura. La fase 3 suma la **exportación nocturna automática** (parte A) y el **borrado seguro de lo ya archivado** (parte B, apagado por defecto). Código en `python/archivo_parquet/` y `server/src/features/archive-prune/`.

## Instalar (una vez, fuera del repo)

pyarrow no es dependencia del proyecto (no está en `pyproject`, lockfiles ni workflows; el CI no lo instala y las pruebas que lo necesitan se saltan). Entorno aparte con hashes:

```sh
uv venv ~/.venvs/archivo-pq
uv pip install --python ~/.venvs/archivo-pq/bin/python --require-hashes -r python/archivo_parquet/requisitos.txt
```

## Usar

Siempre desde `python/` (o con `PYTHONPATH=python`) y con el Python de ese entorno:

```sh
PY=~/.venvs/archivo-pq/bin/python
# 1. copia consistente (nunca la base viva)
pnpm db:snapshot server/data/dev-live/futures-verdicts.sqlite
# 2. exportar los días UTC cerrados (+1 día de margen) que aún no están en el manifiesto
$PY -m archivo_parquet exportar --copia server/data/snapshots/futures-verdicts-<fecha>.sqlite --base futures-verdicts --destino /ruta/archivo [--tablas verdicts,llm_decisions,market_events] [--dry-run]
# 3. revalidar todo el manifiesto contra los archivos
$PY -m archivo_parquet verificar --destino /ruta/archivo
# 4. buscar
$PY -m archivo_parquet buscar --destino /ruta/archivo --base futures-verdicts --tabla verdicts --producto PF_XBTUSD \
    --desde 2026-11-01T10:00 --hasta 2026-11-01T11:00 --donde action=LONG --columnas bucket_start,action,reason_code
# 5. medir: tamaño SQLite vs Parquet y tiempos de búsquedas típicas
$PY -m archivo_parquet medir --copia <copia> --destino /ruta/archivo --base futures-verdicts
$PY -m archivo_parquet medir --base prueba --sintetico-dias 30 --productos 6   # datos sintéticos, en carpeta temporal
```

Códigos de salida: `0` bien; `1` hay días o archivos **sin confirmar** (el detalle sale en el reporte JSON); `2` uso incorrecto o copia rechazada.

Tablas soportadas (cada una es una entrada en `python/archivo_parquet/config.py`; `--tablas` elige cuáles, y las que la copia no tiene se informan como `tablas_ausentes`). Se usa **un solo archivo de manifiesto** y una carpeta por tabla; cada base se exporta con su `--base` (así un solo destino sirve para todas):

| Tabla (archivo)                                                             | SQLite                                                                                                | Base                    | Tiempo de partición                                                | Partición |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ | --------- |
| `verdicts`                                                                  | `paper_futures_verdicts`                                                                              | futures-verdicts        | `bucket_start`                                                     | día       |
| `llm_decisions`                                                             | `paper_futures_llm_decisions`                                                                         | futures-verdicts        | `bucket_start`                                                     | día       |
| `market_events`                                                             | `paper_futures_market_events`                                                                         | futures-market          | `received_at`                                                      | día       |
| `forecasts`, `forecast_returns`, `forecast_barriers`, `forecast_excursions` | `paper_futures_forecasts`, `..._forecast_returns`, `..._forecast_barriers`, `..._forecast_excursions` | futures-forecast-scores | `bucket_start` (minuto de la decisión, no `written_at`)            | día       |
| `positioning`                                                               | `positioning`                                                                                         | positioning             | `bucket_ms`                                                        | mes       |
| `premium`                                                                   | `premium`                                                                                             | positioning             | `bucket_ms`                                                        | mes       |
| `news_items`                                                                | `paper_futures_news_items`                                                                            | futures-news            | `received_at` (siempre existe; `published_at` puede ser NULL)      | mes       |
| `news_analysis`                                                             | `paper_futures_news_analysis`                                                                         | futures-news            | `analyzed_at`                                                      | mes       |
| `funding_responses`                                                         | `paper_futures_funding_responses`                                                                     | futures-market          | `received_at`                                                      | mes       |
| `candle_revisions`                                                          | `paper_futures_candle_revisions`                                                                      | futures-market          | `bucket_start` (la vela y sus revisiones caen juntas)              | mes       |
| `forecast_verdicts`                                                         | `paper_futures_forecast_verdicts`                                                                     | futures-forecast-scores | `bucket_start`                                                     | mes       |
| `llm_skips`                                                                 | `paper_futures_llm_skips`                                                                             | futures-llm-decisions   | `bucket_start`                                                     | mes       |
| `premium_1m`                                                                | `premium` (solo `interval_ms = 60000`)                                                                | positioning             | `bucket_ms`                                                        | día       |
| `qwen_decisions`                                                            | `decisions`                                                                                           | qwen-live__live         | `t_ms` (hora de la decisión)                                       | día       |
| `qwen_trades`                                                               | `trades` (solo `status = 'closed'`, con funding completo)                                             | qwen-live__live         | `exit_ms` (hora de la salida)                                      | día       |
| `qwen_execution_receipts`                                                   | `execution_receipts`                                                                                  | qwen-live__live         | `recorded_at_ms` (cuándo se grabó, **no** `signal_ms`)             | día       |
| `qwen_news_actions`                                                         | `news_actions`                                                                                        | qwen-live__live         | `consumed_ms`                                                      | día       |
| `qwen_config_versions`                                                      | `config_versions`                                                                                     | qwen-live__live         | `activated_ms`                                                     | mes       |
| `auditor_miradas`                                                           | `miradas` (solo días con todas resueltas)                                                             | qwen-live__auditor      | `t_ms` (hora de la mirada)                                         | día       |
| `auditor_operaciones`                                                       | `operaciones` (solo días con todas resueltas)                                                         | qwen-live__auditor      | `entry_ms` (hora de la entrada)                                    | día       |
| `auditor_hechos`                                                            | `hechos_mirada` (hechos del maestro e identidad del proponente, ver `docs/auditor-para-entrenar.md`)  | qwen-live__auditor      | `t_ms`                                                             | día       |
| `auditor_propuestas`                                                        | `propuestas` (solo días con todas etiquetadas)                                                        | qwen-live__auditor      | `t_ms`                                                             | día       |
| `auditor_mirada_operaciones`                                                | `mirada_operaciones`                                                                                  | qwen-live__auditor      | `t_ms`                                                             | día       |
| `auditor_resultados`                                                        | `resultados_operacion` (solo días con todos los resultados finales)                                   | qwen-live__auditor      | `exit_ms` (hora de la salida)                                      | día       |
| `auditor_reentrenos`                                                        | `reentrenos` (registro solo-agregar)                                                                  | qwen-live__auditor      | `creado_ms`                                                        | mes       |
| `official_candles`                                                          | `paper_futures_official_candles` (todos los productos; ETH y BTC incluidos)                           | futures-market          | `known_at` (cuándo llegó la revisión)                              | día       |
| `eth_minute_summary`                                                        | `paper_futures_eth_minute_summary` (resumen por minuto de ETH, ver `docs/resumen-minuto-eth.md`)      | futures-market          | `minute_start_ms` (una fila por minuto cerrado, no cambia después) | día       |
| `funding_periods`                                                           | `paper_futures_funding_periods`                                                                       | futures-market          | `known_at`                                                         | mes       |
| `analytics_points`                                                          | `paper_futures_analytics_points`                                                                      | futures-market          | `known_at`                                                         | día       |

Cada tabla declara su `granularidad`: `dia` (carpeta `anio=/mes=/dia=`) o `mes` (carpeta `anio=/mes=`, un archivo por mes; para tablas chicas). Un mes se exporta cuando terminó hace al menos 1 día (mismo margen de 1 día que los días). En el manifiesto, `dia` de un archivo mensual es el día 1 del mes y la línea trae `granularidad`. Los puntajes de pronóstico usan el minuto de la decisión: un puntaje de 24 h se escribe al día siguiente pero cae en el día de la decisión, por eso el margen importa. Las noticias no tienen producto (las búsquedas por producto no aplican). La base SQLite de noticias se conserva: nada la borra.

### qwen-live y tablas que SQLite todavía modifica (datos-útiles S1, S2)

`qwen-live__live` (decisiones con el veredicto de cada experto, operaciones, recibos de ejecución, acciones por noticias y versiones de configuración) y `qwen-live__auditor` (`miradas`, `operaciones` y las tablas para entrenar) son bases **mutables**: el trader y el auditor actualizan filas. El archivo solo guarda lo que **ya no puede cambiar**, con la misma verificación de ida y vuelta que el resto. Reglas (en `config.py`, por tabla):

| Tabla                                                         | Qué cambia en SQLite                                                                                                      | Qué se exporta                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `decisions`                                                   | nada (`INSERT OR IGNORE` por producto y balde)                                                                            | todo, por `t_ms`                                                                                                                                                                                                                                                                           |
| `trades`                                                      | la fila se actualiza abierta y, ya cerrada, mientras el motor concilia el funding (`funding_status`)                      | solo `status = 'closed'`, por `exit_ms`. **Un día se exporta solo si todas sus operaciones cerradas tienen `funding_status = 'complete'`**; si queda una pendiente, el día va a `pendientes_por_abrir` (con motivo) hasta una copia más nueva. Las abiertas no pertenecen a ningún período |
| `execution_receipts`                                          | nada (triggers de solo-agregar)                                                                                           | todo, por `recorded_at_ms`: el recibo de funding con que se concilia una operación vieja conserva el `signal_ms` de su salida pero se graba días después; con `signal_ms` caería en un día ya archivado y no se exportaría jamás                                                           |
| `news_actions`                                                | nada                                                                                                                      | todo, por `consumed_ms`                                                                                                                                                                                                                                                                    |
| `config_versions`                                             | nada (triggers de solo-agregar)                                                                                           | todo, por mes de `activated_ms`                                                                                                                                                                                                                                                            |
| `miradas` (auditor)                                           | el auditor las actualiza hasta darles el veredicto de 36 h; entonces fija `resuelto_ms` y no las toca más                 | **un día se exporta solo si todas sus miradas tienen `resuelto_ms`**; si queda una sin resolver, el día va a `pendientes_por_abrir`                                                                                                                                                        |
| `operaciones` (auditor)                                       | el auditor las completa hasta tener los tres horizontes de dirección y fija `resuelto_ms`                                 | un día se exporta solo si todas tienen `resuelto_ms`. Estaba sin cubrir desde la dirección 4/12/24 h (T2): ahora se archiva                                                                                                                                                                |
| `propuestas` (auditor)                                        | `resolve` calcula la etiqueta contrafactual después y fija `resuelto_ms` (o la deja `sin_datos` pasadas 48 h sin precios) | un día se exporta solo si todas sus propuestas tienen `resuelto_ms`                                                                                                                                                                                                                        |
| `resultados_operacion` (auditor)                              | se actualiza mientras el funding no está completo; entonces fija `resultado_ms`                                           | un día se exporta solo si todos sus resultados tienen `resultado_ms`                                                                                                                                                                                                                       |
| `hechos_mirada`, `mirada_operaciones`, `reentrenos` (auditor) | nada (`INSERT OR IGNORE`; `reentrenos` con triggers de solo-agregar)                                                      | todo, por `t_ms` (`creado_ms` en `reentrenos`, un archivo por mes)                                                                                                                                                                                                                         |

Esto lo implementa `TablaConfig.inmutable_sql` (condición de las filas que ya no cambian) junto con `filtro_sql`: el exportador **nunca** archiva «lo que ya se puede» de un período, porque el manifiesto lo daría por hecho y el resto no se archivaría jamás. Una operación cuyo funding nunca llega a `complete`, o una mirada que nunca se resuelve, **bloquea su día** (queda pendiente, no es un hueco ni pone el código en 1): hay que mirarlo a mano. Las tablas puramente de estado (`trader_state`, `meta`) no se archivan: están en la lista de exclusión.

`official_candles`, `funding_periods` y `analytics_points` (futures-market) son solo-agregar, pero un dato viejo se puede aprender tarde (en la copia del VPS hay revisiones de velas aprendidas hasta 10 días después de su minuto, y funding aprendido hasta un año después). Por eso se parten por `known_at` (cuándo llegó a nuestra base), que no puede caer en un período ya cerrado; con `bucket_start` o `start_ms` una revisión tardía no se archivaría nunca. Se archivan todos los productos (la tabla es chica); el filtro por ETH y BTC se hace al leer.

### Lista de exclusión (datos-útiles S3)

Toda tabla o base con copia que **no** se archiva está en una lista explícita con su motivo (`nocturno.TABLAS_EXCLUIDAS`, por base, y `nocturno.BASES_EXCLUIDAS`). La regla sigue igual: lo que ni se exporta ni está en la lista es un hueco (`tablas_sin_cubrir` / `bases_sin_cubrir`, código 1). La exclusión es **por base**: `meta` de una base no excluye la `meta` de otra.

| Base                    | Tabla (SQLite)                                                                                                                                        | Motivo                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| futures-market          | `paper_futures_analytics_responses`, `paper_futures_official_candle_responses`                                                                        | respuesta cruda guardada solo por procedencia; el dato útil ya se archiva interpretado                     |
| futures-market          | `paper_futures_book_snapshots`, `paper_futures_ticker_snapshots`                                                                                      | copia derivada de `market_events` (clave foránea a `event_id`), que ya se archiva                          |
| futures-market          | `paper_futures_funding_sightings`, `..._funding_polls`, `..._funding_ws_marks`, `..._funding_ws_observations`, `..._funding_backlog`, `..._data_gaps` | diagnóstico / estado de la propia captura; el periodo de funding ya está en `funding_periods`              |
| futures-market          | `paper_futures_instrument_versions`, `..._market_migrations`, `..._market_quality_policies`                                                           | metadatos o configuración que quedan en SQLite para siempre                                                |
| futures-verdicts        | `paper_futures_verdict_meta`, `paper_futures_verdict_products`                                                                                        | metadatos del motor D                                                                                      |
| futures-llm-decisions   | `paper_futures_llm_meta`; `paper_futures_llm_errors`                                                                                                  | metadatos del motor D; errores del motor D (apagado, S7)                                                   |
| futures-forecast-scores | `paper_futures_forecast_meta`                                                                                                                         | metadatos del motor D                                                                                      |
| positioning             | `collector_run`                                                                                                                                       | registro de arranques del recolector (diagnóstico)                                                         |
| futures-news            | `paper_futures_news_meta`, `..._news_source_sets`, `..._news_polls`, `..._news_errors`, `..._news_briefings`                                          | metadatos/configuración; diagnóstico de la captura; errores; resúmenes derivados de noticias ya archivadas |
| qwen-live__live         | `trader_state`, `meta`                                                                                                                                | estado vivo, queda en SQLite y en las copias diarias                                                       |
| qwen-live__live         | `account`                                                                                                                                             | una sola fila inmutable (capital inicial)                                                                  |
| qwen-live__live         | `examples`, `rebotes`, `skipped`, `errors`                                                                                                            | fuera de lo útil para mejorar al maestro y al portero; diagnóstico; derivados                              |
| qwen-live__auditor      | `meta`                                                                                                                                                | estado vivo                                                                                                |

Bases con copia que no se archivan: `qwen-live_cache__*` (caché de velas que se reconstruye sola), `forward__*`, `maker-costs__*` y `futures-strategies` (bases chicas que quedan en SQLite y en las copias diarias). Una clave de `BASES_EXCLUIDAS` que termina en `__` es un prefijo; el resto, un nombre exacto (`futures-strategies-extra` **no** está excluida). Los motivos completos están en el código.

## Exportación nocturna automática (fase 3, parte A)

Un solo comando, en la Mac, sin `sudo` (crea el entorno aparte con pyarrow y hashes, genera el agente de launchd y hace una corrida de prueba `--dry-run`; se puede repetir sin problema):

```sh
bash ops/launchd/instalar-archivo-parquet.sh
```

Lo que queda instalado: `~/.venvs/archivo-parquet` (fuera del repo), `~/Library/LaunchAgents/com.balancita.archivo-parquet.plist` (plantilla en `ops/launchd/`) y una corrida **todas las noches a las 04:30 hora local de la Mac** (si la Mac duerme a esa hora, launchd la corre al despertar; además `StartInterval` de 3600 s la reintenta cada hora, y las corridas sin novedad son baratas). Para actualizar el agente basta repetir el instalador: recarga el existente con `launchctl bootout` + `bootstrap`. Prioridad baja (`Nice`, `LowPriorityIO`). El resultado va a `~/balancita-data.noindex/archivo-parquet`.

`python -m archivo_parquet nocturno [--destino D] [--respaldos R] [--bases a,b] [--dry-run]` (destino: `--destino`, o `BALANCITA_ARCHIVO_DESTINO`, o `~/balancita-data.noindex/archivo-parquet`; copias: `--respaldos`, o `BALANCITA_RESPALDOS_DIR`, o `server/data/backups`):

- Por cada base elige la copia diaria **más reciente que pase `quick_check`** (nunca la base viva), exporta todas las tablas que tenga, corre `verificar` sobre todo el archivo y agrega una línea de resumen a `nocturno.jsonl` en el destino.
- No usa una copia con menos de 5 min de vida ni si hay un `.tmp` de copia en curso (de menos de 2 h): lo deja para otra noche. Una base sin ninguna copia (no se usa) se omite sin error; una copia ilegible o con `quick_check` malo cuenta como sin confirmar.
- Un solo proceso a la vez (`flock` sobre `.nocturno.lock`); es idempotente (lo ya confirmado se salta).
- No exporta en los 10 min posteriores a un despertar: en macOS lo sabe por `sysctl kern.waketime`; en otros sistemas no hay forma simple y no se aplica. Si la guarda se activa, el propio comando **espera** (ya con `nice` y el candado tomado, en tramos de 30 s, releyendo el despertar en cada tramo) hasta que pasen esos 10 min, con un tope de 15 min de espera total; un nuevo despertar durante la espera recalcula. En `--dry-run` no espera. Si el tope no alcanza sale con `3` y el `StartInterval` de launchd lo reintenta.
- Una corrida sin novedad es barata: si hoy (UTC) ya hubo una corrida con código `0` sobre la misma copia de una base (según `nocturno.jsonl`), esa base queda `sin_novedad` sin repetir su `quick_check`; `verificar` sí corre siempre.
- Códigos: `0` todo confirmado; `1` el archivo quedó **incompleto o sin confirmar**: un día sin confirmar, una base esperada sin copia buena (`sin_copias` incluido), una copia de otra base que no se archiva (`bases_sin_cubrir`; solo las de la lista de exclusión de arriba están excluidas a propósito), tablas de la copia que ni se archivan ni están en la lista de exclusión de su base (`tablas_sin_cubrir`), columnas nuevas (`avisos`), `omitidos_por_retencion`, `reemplazos_omitidos`, archivos huérfanos, `verificar` con problemas, o cualquier error inesperado (la línea de `nocturno.jsonl` se escribe igual). Los períodos todavía abiertos (`pendientes_por_abrir`: sin terminar, o con filas que SQLite aún puede modificar, ver «qwen-live y tablas que SQLite todavía modifica») no son un hueco. Un período que ya no se puede archivar completo y cuya pérdida el usuario aceptó va en `PERIODOS_PERDIDOS_ACEPTADOS` (`nocturno.py`, con su motivo): se informa en `perdidos_aceptados` y no es hueco. Hoy: `market_events` del 2026-11-02 (la retención lo recortó antes de que existiera el respaldo del VPS). Una copia que todavía se está escribiendo (muy nueva o con `.tmp` en curso) no se saltea: se espera a que madure, hasta `TOPE_ESPERA_COPIA_S` (1 h); `2` uso incorrecto o sin pyarrow; `3` no corrió a propósito (otra corrida en curso o despertar reciente que no terminó en el tope de espera; no es un fallo, el reintento horario o la noche siguiente lo recupera).
- Con `--dry-run` no escribe nada (ni el log) y no toma el candado.

## Borrado seguro de lo ya archivado (fase 3, parte B)

**Apagado por defecto y NO lo enciende el instalador.** Fran lo activa a mano cuando quiera, con `FUTURES_ARCHIVE_DELETE=1` en el proceso dueño de la base (`=dry-run` solo informa en `retention.jsonl` qué borraría). Para apagarlo: quitar la variable y reiniciar ese proceso.

Quién borra: solo el proceso que ya es dueño de cada base.

| Tabla                                                                                                  | Dueño de la base                                           | ¿Borra por archivo?                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `positioning`, `premium`                                                                               | recolector de posicionamiento (`pnpm positioning:collect`) | **Sí** (ventana 30 días, por mes)                                                                                                |
| `verdicts`, `llm_decisions`, `forecasts*`                                                              | procesos Python; tienen trigger `no_delete` (inmutables)   | **No**: otro proceso la escribe y el trigger impide borrar sin desactivarlo                                                      |
| `market_events`                                                                                        | captura                                                    | **No**: la retención de la captura ya la recorta (tickers 48 h, resto 7 días) y tiene triggers; el archivo no cambia esa ventana |
| `news_items`, `news_analysis`                                                                          | Python (inmutable)                                         | **Nunca**: las noticias no se borran                                                                                             |
| `qwen_*`, `auditor_*`, `official_candles`, `funding_periods`, `analytics_points`, `eth_minute_summary` | trader en vivo, auditor y captura de mercado               | **No** (sin especificación en `archive-tables.ts`: la puerta no las conoce y no borra nada)                                      |

La puerta (`archive-gate.ts`, solo lectura) deja borrar un día/mes únicamente si: está confirmado en `manifiesto.jsonl` **con `verificacion_ida_vuelta: true` y `formato_version` al menos el mínimo** (`MIN_FORMAT_VERSION` = 2; el exportador del formato 2 escribe esos campos solo después de la prueba de no pérdida, y **lo archivado con las fases 1 y 2 sigue bloqueado** hasta que se reexporte); el archivo existe con el mismo tamaño y sha256 del manifiesto (sha256 en streaming con tope de 5 s, cacheado por mtime); terminó hace más que la ventana de la tabla **más 1 día de margen**; y la base no tiene más filas del período que el archivo. Con `FUTURES_ARCHIVE_REQUIRE_OFFSITE=1` también exige `confirmado_fuera` en `respaldo-estado.jsonl` (apagado mientras no haya VPS). Si el manifiesto falta, no se lee o hay cualquier duda: no se borra nada. Antes de empezar cada período se verifica que exista una copia diaria buena de la base de menos de 30 h.

El ejecutor borra por rango de tiempo en transacciones cortas (100 a 1.000 filas), anota cada paso en `retention.jsonl` (`kind: archive-delete`, tabla, día, filas), y es idempotente (si se corta a la mitad, la próxima vez sigue). Si una tabla tiene trigger de borrado, no la toca ni lo desactiva. El hook `archive` del `retention-runner` comparte presupuesto de 6 s por ciclo, `canRun`, despertar y checkpoint; el recolector de posicionamiento (que no tiene runner) usa `runArchiveCycle` con el mismo presupuesto y lee de `db-health-state.json` si hubo un despertar hace menos de 10 min o la base está dañada.

Después de borrar, SQLite no devuelve el espacio al disco: ver «Compactar» en `docs/operacion-base-de-datos.md` (`pnpm db:compact`).

## Qué se guarda (formato 2)

```
<destino>/<base>/<tabla>/anio=YYYY/mes=MM/[dia=DD/]part-<sha8>.parquet
<destino>/<base>/<tabla>/anio=YYYY/mes=MM/[dia=DD/]part-<sha8>.hashes   (32 bytes por fila; ver «No pérdida»)
<destino>/manifiesto.jsonl
<destino>/manifiesto-reemplazadas.jsonl                                  (auditoría de líneas viejas reemplazadas)
```

Reglas comunes (todas en `config.py` por tabla y aplicadas en `formato.py`):

- Un archivo por período (día o mes) y tabla, **ordenado por clave** (declarado en `sorting_columns`), con **un grupo de filas por producto** donde la tabla tiene producto (`grupo_por`), partido en trozos si pasa el tope `filas_por_grupo`.
- Tiempos `int64` ms UTC, enteros `int64`, reales `float64` (bit a bit; `byte_stream_split` solo en positioning/premium, donde se midió −7 %), texto `string` sin reinterpretar, blob `binary`. Los precios y tasas que SQLite guarda como TEXT quedan como texto.
- **Todas las columnas son nullable en el archivo**: un NULL inesperado en una columna NOT NULL no tira el período, se guarda y queda en `avisos` del manifiesto.
- **Diccionario solo en las columnas de pocos valores** (`product_id`, `action`, `regime`, `reason_code`, `coverage`, `j_*` de texto corto); nunca en hashes ni JSON. **Estadísticas apagadas en JSON y texto largo** (el min/max de 11 KB no sirve). **Índice de páginas** y **checksum de páginas** siempre. zstd 3 en las tablas chicas, **9 en las pesadas** y **19 solo en `funding_responses`**. pyarrow 21 no tiene bloom filters.
- **Metadatos del archivo**: `sqlite_ddl` (el `CREATE TABLE` original, para recrear la tabla sin el repo de esa época), `ddl_sha256`, `schema_version`, `formato_version`, `clave`, `grupo_por`, `columnas_sqlite`, `derivadas`.
- **JSON original íntegro** (`payload_json`, etc.) más columnas derivadas `j_*` **solo para lo que el código consulta** (después de las originales; no existen en SQLite y se verifican contra el JSON releído). Un JSON roto o una ruta ausente da NULL en la derivada, nunca un error.
- Columnas `mixto` (bases no STRICT como `qwen-live`, donde una columna puede traer cualquier tipo): se guardan como texto más una columna `tipo_<col>` con el `typeof()` de cada valor. Hoy ninguna tabla de `TABLAS` las usa (el motor y las pruebas sí; ver «Segunda tanda»).

### Las tres tablas pesadas

| Tabla               | Período                  | Orden y grupos                                                                                | Detalles                                                                                                                                                                                            |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdicts`          | día                      | `(product_id, bucket_start)`; **un grupo por producto** (tope 2 000 filas)                    | zstd 9; `payload_json` íntegro sin diccionario ni estadísticas; derivadas `j_selected_strategy_id`, `j_knowledge_lag_ms`, `j_previous_regime`, `j_config_hash`, `j_schema_version`, `j_proposals_n` |
| `funding_responses` | mes                      | `(received_at, sha256)`; grupos de 16 filas (~16 MB)                                          | **zstd 19**, páginas de 64 MB para que zstd vea cuerpos enteros; `raw_response` sin diccionario ni estadísticas; sin producto                                                                       |
| `candle_revisions`  | mes (por `bucket_start`) | `(interval_ms, bucket_start, candle_id, revision)`; un grupo por intervalo, tope 50 000 filas | zstd 9; **todas las revisiones** (no se pierde historia); precios como texto; diccionario solo en `coverage`                                                                                        |

**`funding_responses` desde S6 (datos-útiles):** la captura ya no guarda el cuerpo crudo de cada respuesta de funding (ver `docs/funding-cuerpo-respuestas.md`). Las filas **nuevas** llevan en `raw_response` un cuerpo corto de menos de 1 KB (`{"balancitaSlim":true,"fullSha256":…,"fullBytes":…,"serverTime":…,"rates":[solo los períodos nuevos]}`) y su `sha256` sigue siendo el del cuerpo entero; las filas **viejas** (≈1 MB) no se tocan. Las columnas y tipos son los mismos, así que un mes puede mezclar ambas y la ida y vuelta sigue siendo exacta (`test_funding_responses_filas_viejas_y_nuevas_delgadas_ida_y_vuelta_exacta`). Los meses que se exporten después del corte pesan casi nada; los anteriores se archivan con el cuerpo entero y no cambian.

Las rutas de las `j_*` salen de `evaluate_verdict` (`python/balancita_engine/futures_verdicts.py`) y de quienes leen el JSON (`paper-engine-follower.ts`, `futures_forecast_scores.py`); **no se confirmaron con un `payload_json` real**: por confirmar con datos reales (muestra de 3 filas, informe sección 12). Si una ruta no existiera, la derivada queda en NULL y se corrige en `config.py` re-exportando; la verificación de no pérdida **no depende de las `j_*`**.

### Resto de las tablas (formato del informe, a afinar con datos reales)

`llm_decisions`, `llm_skips`, `forecast_verdicts`, `forecasts*`, `positioning`, `premium`, `news_*` y `market_events` ya pasan por el mismo motor (formato 2, hash por fila completo, diccionario/estadísticas por columna, un grupo por producto). Sus parámetros son los del informe; no se afinaron con datos reales.

- **`premium_1m`** (nuevo, por día): la serie de 1 minuto se recorta a 7 días en SQLite, así que el archivo mensual llega tarde y no la tiene. `premium_1m` filtra `interval_ms = 60000`, se exporta **al día siguiente (margen 0)** y es la que hay que encender para no perder esa serie. El `premium` mensual sigue **sin filtro** (no se pierde lo ya archivado; los minutos que aún existían quedan duplicados ahí).
- **`market_events`**: ver «`market_events` y la retención de 48 h».

## Prueba de NO pérdida (fila a fila, columna a columna)

Antes de escribir una línea en el manifiesto, el exportador hace esto con **todas** las columnas de SQLite (no solo `verdict_hash` o `content_hash`):

1. **Representación canónica por `typeof()`**: `N` nulo; `I` + entero decimal; `R` + los 8 bytes IEEE-754 en hex (distingue 0.0, inf y cualquier bit); `T`/`B` + largo en bytes + `:` + bytes tal cual (el JSON es el texto original byte a byte). `''` ≠ NULL, texto `'7'` ≠ entero `7`, texto ≠ blob. En Python el tipo de la celda **es** el `typeof()` de SQLite.
2. **Hash por fila** = SHA-256 de las canónicas de todas las columnas separadas por `0x1f`. Se toma al leer la copia (esa es la lista «de la copia»).
3. Se relee el Parquet recién escrito **fila a fila con checksum de páginas** y se calcula el mismo hash. La lista de hashes se compara **posición a posición** (la suma no ve filas cambiadas de lugar, duplicadas o intercambiadas; la lista sí). Además: `COUNT(*)` del rango, clave mín/máx, orden estricto por clave, metadatos (`schema_version`, `formato_version`, `sqlite_ddl`, `clave`), pie del archivo, índice de páginas y cada `j_*` contra el JSON releído.
4. Una celda cuyo `typeof()` no sea el declarado (p. ej. texto en una columna REAL de una base no STRICT) **falla ese período con fila y columna** (salvo columnas `mixto`).
5. **Solo si todo coincide** se escriben `formato_version: 2` y `verificacion_ida_vuelta: true`, más `hash_filas_sha256` (hash de la lista de hashes), `ruta_hashes`, `ddl_sha256`, `derivadas`, `avisos` y `tiempo_copia`. Si algo difiere: el archivo no se promueve, el período queda en `no_confirmados` y el código de salida es 1.

`verificar` repite todo lo anterior sobre lo ya archivado (hash por fila, lista lateral `.hashes` si existe —si falta vale el hash del manifiesto—, derivadas, metadatos). Las líneas del formato 1 (sin `formato_version`) se siguen revalidando como antes y se listan en `formato_viejo`.

Lo que SQLite ya pierde antes de llegar al archivo (no es del Parquet): `NaN` → NULL en STRICT y `'12'` → `12` en columna INTEGER. **Prueba de arranque** (`test_archivo_parquet_formato2`): se restaura el archivo en una SQLite nueva con el `sqlite_ddl` de sus metadatos y se compara `typeof(col), col` celda a celda con la copia original (int64 extremos, `5e-324`, `1e308`, `inf`, `''` vs NULL, texto vs blob, NUL dentro de texto).

**Todavía no está** el paso 7.3.5 del informe (repetir el hash de fila contra la **base viva** justo antes de borrar y comparar con la lista `.hashes`): está en «Segunda tanda». Hasta entonces la puerta de TypeScript sigue con «la base no tiene más filas que el archivo».

## Reemplazar un período del formato viejo

Un período cuya línea de manifiesto no tiene `formato_version` (fases 1 y 2) **no cuenta como hecho**: el exportador lo reexporta y lo reemplaza, de forma segura:

1. Escribe un archivo nuevo (`part-<sha8>` distinto), lo verifica entero y recién entonces lo promueve.
2. **No reemplaza si la copia tiene menos filas** que el archivo viejo o si el rango de claves no lo cubre (se perderían filas): lo informa en `reemplazos_omitidos` y deja el viejo intacto.
3. Reemplaza la línea vieja por la nueva **en forma atómica** (archivo temporal + fsync + rename; la nueva trae `reemplaza: <ruta vieja>`). La vieja se anota antes en `manifiesto-reemplazadas.jsonl`. Siempre hay **una sola línea por período** (la puerta de TypeScript bloquea períodos repetidos).
4. El archivo viejo (y su `.hashes`) queda huérfano y se borra. Si el proceso muere antes del rename, el manifiesto viejo sigue válido y el archivo nuevo es un huérfano que `verificar` lista y la próxima corrida descarta.

El reporte trae `reemplazados` aparte de `exportados`, y `nocturno.jsonl` los cuenta.

## Qué garantiza

- Lee solo una copia: la abre en solo lectura, rechaza `server/data/dev-live/*` y exige una carpeta `snapshots/` o `backups/` (o `--copia-confirmada` si es una copia en otro sitio). Antes corre `quick_check`; si falla, no exporta.
- Solo períodos cerrados con su margen (1 día por defecto; 0 en `market_events` y `premium_1m`); los que ya están en el manifiesto con formato 2 se saltan (idempotente).
- Por cada período: escribe `.tmp`, lo relee entero con checksum de páginas y compara fila a fila (ver «Prueba de NO pérdida»). Recién entonces renombra y agrega la línea al manifiesto.
- Columnas nuevas en SQLite que la configuración no conoce: se avisan (`avisos` del reporte) y **no se archivan** hasta sumarlas (subir `schema_version`); si **falta** una columna, no se exporta.
- Memoria acotada: lotes de a lo sumo un grupo de filas al leer SQLite y al releer (con filas de 1 MB, 16 filas). Medido (sintético): ~330 MB de RSS en 11 520 veredictos y ~380 MB en 120 cuerpos de funding de 1 MB; no correr dos exportaciones pesadas en paralelo.
- `verificar` vuelve a comprobar sha256, relectura, hash de cada fila, derivadas y metadatos de cada línea, y lista archivos `part-*` que no están en el manifiesto.

## `market_events` y la retención de 48 h

La retención de la captura borra los tickers con más de **48 h** (antes 24 h) y recorta `normalized_json` (la copia del mensaje del proveedor que repite `raw_json`) también a las 48 h; los trades y libros duran 7 días (`FUTURES_TICKER_RETENTION_HOURS`, `FUTURES_RAW_COPY_KEEP_HOURS`, `FUTURES_EVENT_RETENTION_DAYS`; valores en `server/src/features/kraken-futures/capture-savings.ts`).

Con 48 h, **una sola copia diaria ve entero el día anterior**: el día D termina a las 00:00 UTC de D+1, y su inicio se borra recién a las 00:00 UTC de D+2. Cualquier copia tomada entre esos dos instantes (la copia diaria cae siempre en esa ventana de 24 h) tiene el día D completo y sin recortar. Con 24 h esa ventana no existía (el inicio de D ya se había borrado cuando D terminaba).

Por eso `market_events` usa **margen 0** (se exporta apenas la copia lo ve cerrado) y dos guardas, para no certificar nunca un día incompleto:

- **Inicio**: la primera fila del día debe estar a menos de 10 minutos de las 00:00. Si la copia ya lo perdió, el período va a `omitidos_por_retencion` del reporte (y de `nocturno.jsonl`) y la corrida sale con código 1: es un hueco del archivo.
- **Fin** (nuevo): la fila más nueva de la tabla en la copia debe estar a menos de 1 minuto del final del día (`tolerancia_fin_ms`). Una copia tomada antes de que el día terminara no lo tiene entero: ese día va a `pendientes_por_abrir` y se exporta con la copia siguiente. Los tickers llegan cada segundo, así que cualquier copia posterior al fin lo cumple.

Qué puede salir mal: si la exportación nocturna corre con una copia tomada después de las 00:00 UTC de D+2 (por ejemplo si la copia diaria se atrasó más de un día, o la Mac estuvo apagada), el día D llega recortado y queda en `omitidos_por_retencion`. No se pierde nada que estuviera archivado; lo que ya no está en la base no se puede recuperar. Mirar `omitidos_por_retencion` en `nocturno.jsonl` tras cada corrida; si aparece algo, subir `FUTURES_TICKER_RETENTION_HOURS`.

Costo de disco: los tickers (1 por segundo y producto) ocupan el doble en la base viva (≈1 GB más). Los períodos ya archivados en el formato viejo de esta tabla siguen bloqueados para el borrado.

## Medición (datos sintéticos; esta máquina; no extrapolar)

`python -m archivo_parquet medir --base x --sintetico-dias N --productos P --tablas verdicts|funding_responses|candle_revisions` (ahora mide la exportación por tabla). Los datos sintéticos tienen la forma real de las tablas (payload de veredictos con `selected`, 6 `proposals` y 3×90 features de ~9 KB; cuerpos de funding de 1 MB que son el anterior con un período nuevo al final; velas con revisiones por trade) pero precios y features al azar: la compresión con datos reales puede variar ±30 %.

| Tabla (sintético)                                               | Filas   | SQLite (contenido) | Parquet                | Razón                                          | Exportar + verificar     | Una hora de un producto             | Un día / una fila                      |
| --------------------------------------------------------------- | ------- | ------------------ | ---------------------- | ---------------------------------------------- | ------------------------ | ----------------------------------- | -------------------------------------- |
| `verdicts` (8 productos, 3 días, 1/min)                         | 34 560  | 271 MB             | 38,2 MB (≈12,7 MB/día) | 7,1×                                           | 39 s (≈13 s/día)         | 21 ms, 1 de 8 grupos, 1,6 MB leídos | 389 ms (día completo con JSON) / 30 ms |
| `funding_responses` (2 días × 24, cuerpo ~1 MB)                 | 48      | 49,6 MB            | 0,33 MB                | ≈150× (con 120 filas: 137×)                    | 2,3 s (120 filas: 6,6 s) | —                                   | 235 ms (24 cuerpos) / 82 ms            |
| `candle_revisions` (1 producto, 3 días, 60 revisiones por vela) | 259 200 | 48,7 MB            | 11,3 MB                | 4,3× (precios al azar; los reales repiten más) | 11 s                     | 20 ms, 1 de 6 grupos, 2,2 MB leídos | 60 ms (un día) / 27 ms                 |

Con `verdicts` el ahorro real sale de borrar de SQLite (el Parquet pesa ≈1/7). En `funding_responses` la razón depende de cuánto se parezcan los cuerpos reales: con 672 filas de 1 MB (lo que hay hoy) la exportación tardaría ≈35 s en esta máquina. Los tiempos de búsqueda son medianas de 3 corridas con archivo caliente en el sistema operativo.

## Segunda tanda (no hecho en este cambio)

- Hecho en datos-útiles: `official_candles`, `funding_periods`, `analytics_points` y `qwen-live` (`live` y `auditor`; sus columnas siguen la afinidad de SQLite y no necesitaron `mixto`). Queda en la lista de exclusión, sin archivar: `official_candle_responses` y `analytics_responses` (crudos), `funding_sightings`, `funding_polls`, `funding_ws_*`, `news_briefings`, `news_polls` y las bases chicas.
- **Paso 7.3.5**: repetir el hash de fila contra la base viva justo antes de borrar (`archive-pruner.ts`) y comparar con `.hashes`; ampliar `archive-tables.ts` (especificaciones para verdicts, scores, llm, news y market con `dropTriggers` y `children`) y el borrado por transacción levantando y reponiendo los triggers `_no_delete`. **El borrado sigue apagado** (`FUTURES_ARCHIVE_DELETE` sin definir) y `MIN_FORMAT_VERSION` **no se tocó** (ya era 2): el exportador nuevo escribe de verdad ese formato y `test_archivo_parquet_formato2.PuertaTypeScriptTests` corre la puerta real contra un archivo certificado (pasa) y contra la misma línea sin los dos campos (queda bloqueada).
- Confirmar las rutas `j_*` y la compresión con muestras reales (informe sección 12) y decidir las propuestas del informe que cambian la captura o los esquemas (guardar menos cuerpos de funding, menos revisiones de velas, quitar tablas vacías, fusiones): todas siguen sin hacerse.

## Encontrar datos rápido

1. El **catálogo** (manifiesto) elige solo los archivos del rango de tiempo y del producto pedidos; no se abre ningún otro.
2. Dentro de cada archivo, el orden por producto y tiempo, el **grupo de filas por producto**, las **estadísticas de grupo** (mín/máx por columna) y el índice de páginas dejan saltar lo que no puede contener lo pedido. Las columnas `j_*` permiten filtrar (`--donde j_selected_strategy_id=breakout`) sin abrir el JSON; en un archivo del formato 1 salen como NULL.
3. `buscar` imprime el informe (archivos elegidos y en catálogo, grupos de filas leídos y en total, bytes leídos) y las filas. En Python: `archivo_parquet.leer.buscar_archivo(...)` y `leer_archivo(destino, base, tabla, desde_ms, hasta_ms, columnas=None)`; el rango es `[desde, hasta)`.
4. Consulta DuckDB equivalente, sin instalar DuckDB: `buscar ... --duckdb` (o `leer.consulta_duckdb(...)`) imprime un `SELECT ... FROM read_parquet('.../anio=*/mes=*/dia=*/part-*.parquet', hive_partitioning = true) WHERE ...` con filtro de partición. Está probada solo como texto; no se ejecutó contra DuckDB.

**Por qué grupos chicos.** (Con el formato 2 el grupo es el del producto; el razonamiento y los números de abajo son de la fase 2.) Con un solo grupo por día (9,5 mil filas de ~11 KB), buscar un producto en 1 hora leía el día completo (0,24 s medidos). Con grupos de 2 000 filas, las estadísticas (mín/máx de producto y de tiempo por grupo) dejan saltar los grupos que no pueden contener lo pedido. Prueba (`test_archivo_parquet_fase2`, datos sintéticos): de 5 grupos se leen 1 o 2 y los bytes leídos bajan a ~20 %. Medición sintética con filas de 11 KB (4 productos × 2 400 filas, un producto en 1 hora, mejor de 5): 2 de 5 grupos, 23 MB leídos y ~158 ms, contra 1 grupo, 56 MB y ~395 ms. Son números de esta máquina con datos sintéticos incompresibles: no extrapolar. Los grupos que mezclan el final de un producto con el inicio del siguiente no se pueden descartar por tiempo, por eso a veces se leen 2.

`medir` cronometra cuatro búsquedas típicas (un producto en 1 hora, un día completo, una semana filtrando por una columna, una fila por clave) e informa mediana de tiempo, archivos y bytes leídos. Con `--sintetico-dias 30` lo hace sobre datos sintéticos grandes. Esos tiempos son de una máquina y un corpus sintético: no extrapolar a producción.

## Respaldo fuera del VPS (fase 2)

Comando `respaldar`: envuelve **rclone** (si no está instalado, falla con un mensaje claro; no se agregó ninguna dependencia de Python). Sube a un remoto **solo** los archivos que el manifiesto ya confirmó y que todavía no están (o están dañados) en el remoto, el manifiesto **al final**, y después verifica tamaño y sha256 contra lo que dice el manifiesto.

```sh
# una vez, FUERA del repo: configurar el remoto (y de preferencia un remoto cifrado encima)
rclone config
# probar sin subir nada
$PY -m archivo_parquet respaldar --destino /ruta/archivo --remoto mi-remoto-cifrado:archivo --dry-run
# respaldar de verdad
$PY -m archivo_parquet respaldar --destino /ruta/archivo --remoto mi-remoto-cifrado:archivo
# probar que se puede restaurar: baja un día al azar (o --dia 2026-11-01) a una carpeta temporal y lo verifica
$PY -m archivo_parquet restaurar-prueba --destino /ruta/archivo --remoto mi-remoto-cifrado:archivo [--dia 2026-11-01] [--base ...] [--tabla ...]
```

Cómo funciona, en simple:

1. Lista el remoto (`rclone lsjson --recursive --hash`) y compara con el manifiesto. Lo que falta o difiere en tamaño/sha256 se sube de a un archivo con `rclone copyto --checksum` (un fallo no frena a los demás). Antes de subir se comprueba que el archivo local siga igual que el manifiesto.
2. Vuelve a listar y verifica cada archivo. Si el remoto no entrega sha256 (por ejemplo un remoto `crypt`), usa `rclone check --download` para comparar el contenido real, solo de lo recién subido; lo que ya se había confirmado y mantiene su tamaño no se vuelve a bajar.
3. Sube el manifiesto al final y lo verifica. Contiene solo las líneas de archivos confirmados en el remoto, así el manifiesto remoto nunca lista algo que el remoto no tiene.
4. Escribe `respaldo-estado.jsonl` en la carpeta del archivo: una línea `{"archivo", "fecha", "confirmado_fuera", "sha256"}` cada vez que cambia lo conocido de un archivo (también para `manifiesto.jsonl`). La última línea de cada archivo manda. Una fase futura de borrado debe leer `respaldo.confirmados_fuera(destino)` ("confirmado fuera del VPS") y, aun así, reverificar.

Código de salida: `0` todo confirmado; `1` hubo fallos de subida, archivos sin confirmar o locales alterados (detalle en el JSON); `2` uso incorrecto o rclone ausente.

**Garantías.** Nunca borra en el origen ni en el remoto: el código solo permite los subcomandos `lsjson`, `copyto` y `check` de rclone (ni `sync`, ni `delete`, ni `move`). Si un archivo del remoto aparece dañado, se **sobrescribe** con el bueno; no se borra nada. **Sin credenciales**: el remoto se configura con `rclone config` (el archivo de configuración de rclone queda fuera del repo); `--remoto` solo acepta `nombre:ruta`, rechaza cadenas de conexión con opciones o claves, y el nombre del remoto no se escribe en el estado ni en los mensajes de error.

**Cifrado (recomendado).** Crear con `rclone config` un remoto de tipo `crypt` encima del almacenamiento (S3, B2, SFTP...) y usar ese nombre en `--remoto`. Así lo que sale del VPS va cifrado y las claves del `crypt` quedan solo en la configuración de rclone, que hay que guardar aparte y con copia (si se pierde, no hay forma de descifrar). Un remoto `crypt` no entrega sha256: la verificación pasa por `rclone check --download` (más lenta, solo lo nuevo).

### Programarlo cada noche (ejemplos; el VPS aún no existe, nada de esto está instalado)

El orden de la noche es: copia consistente, exportar, respaldar. Un script, por ejemplo `/opt/balancita/archivo-noche.sh`:

```sh
#!/bin/sh
set -eu
PY=/opt/archivo-pq/bin/python
cd /opt/balancita
pnpm db:snapshot server/data/dev-live/futures-verdicts.sqlite   # (y las demás bases)
$PY -m archivo_parquet exportar --copia "$(ls -t server/data/snapshots/futures-verdicts-*.sqlite | head -1)" --base futures-verdicts --destino /datos/archivo
$PY -m archivo_parquet verificar --destino /datos/archivo
$PY -m archivo_parquet respaldar --destino /datos/archivo --remoto mi-remoto-cifrado:archivo
```

- **cron** (`crontab -e`): `30 3 * * * /opt/balancita/archivo-noche.sh >> /var/log/archivo-noche.log 2>&1`
- **systemd**: `archivo-noche.service` (`Type=oneshot`, `ExecStart=/opt/balancita/archivo-noche.sh`) y `archivo-noche.timer` (`OnCalendar=*-*-* 03:30:00`, `Persistent=true`); activar con `systemctl enable --now archivo-noche.timer`.
- **launchd** (macOS, `~/Library/LaunchAgents/com.balancita.archivo-noche.plist`): `ProgramArguments` con la ruta del script y `StartCalendarInterval` con `Hour` 3 y `Minute` 30; cargar con `launchctl load`.

Mirar el código de salida: distinto de 0 debe avisar a alguien. Una vez al mes conviene correr `restaurar-prueba` a mano.

## Qué NO hace todavía

- **El borrado está apagado** (`FUTURES_ARCHIVE_DELETE` sin definir). Los archivos nuevos del formato 2 ya pasan la puerta; los de las fases 1 y 2 siguen bloqueados hasta reexportarse (se reemplazan solos en la próxima corrida). Veredictos, decisiones, puntajes, funding y noticias no se borran por archivo (ver la tabla de arriba y «Segunda tanda»).
- **No hay rotación ni compactación** (fase 4): ni compactar días en archivos más grandes, ni rotar o limitar lo que ya está en el remoto, ni rotar las claves del remoto cifrado.
- La exportación nocturna corre sola en la Mac solo después de ejecutar el instalador; los ejemplos de cron/systemd/launchd del VPS siguen siendo ejemplos. No se probó con una copia real (todo con datos sintéticos). No se probó con rclone real ni con un remoto real (las pruebas usan un remoto falso en una carpeta local), ni con una copia real.
- La verificación depende de lo que el remoto sepa hacer: sin sha256 se usa `rclone check --download`. Un remoto que miente sobre lo que guarda no está probado; por eso existe `restaurar-prueba`.
- Es confirmación lógica: un disco que miente en `fsync` no está probado. Si el manifiesto local se pierde, hay que reexportar (los archivos sin línea se descartan al reexportar ese día); el manifiesto del remoto sirve de copia del catálogo.
- El lector no une todavía SQLite reciente con Parquet histórico.
- Los esquemas de las tablas nuevas salen del código de captura (no se leyó ninguna base real); si **falta** una columna, la exportación se rechaza hasta subir `schema_version`; una columna **extra** solo avisa.
