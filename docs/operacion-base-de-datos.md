# Operación de las bases SQLite: copias, sueño de la Mac y reparación

El 2-nov-2026 se dañó `server/data/dev-live/futures-market.sqlite` (4,4 GB, WAL) cuando la Mac despertó de ~8 h de sueño con la limpieza de eventos crudos en marcha. La Mac se va a dormir de vez en cuando y no se puede evitar: el sistema tiene que aguantarlo. Este documento dice qué hace y cómo se opera.

## Regla de oro

**No abras nunca la base viva desde otra sesión, ni con `sqlite3`, ni con Python, ni con un script.** Un tercer proceso con la base abierta frena el checkpoint del WAL y, si algo falla, lo que se rompe es el archivo de la captura. Inspeccioná siempre **una copia**:

```sh
pnpm db:snapshot server/data/dev-live/futures-market.sqlite
# -> server/data/snapshots/futures-market-<fecha>.sqlite (copia consistente por la API de backup de SQLite, con su quick_check)
```

La copia se hace con la API de backup de SQLite sobre una conexión propia, de solo lectura: es una imagen consistente aunque la captura esté escribiendo. Copiar el archivo «a pelo» (`cp`) con la captura corriendo da una copia rota.

## Copia de seguridad diaria

La captura (`capture-main.ts`) copia una vez por día, de a una base por vez, en un proceso hijo (no frena el event loop):

`qwen-live` (`qwen-live/live.sqlite`), `futures-verdicts`, `positioning`, `futures-news`, `futures-forecast-scores`, `futures-llm-decisions`.

**`futures-market` (la base de captura) no se copia desde la app por defecto**: en el VPS pesa ~10 GB, la copia interna se cortaba a los 90 min y se reintentaba sin parar (57 veces seguidas, ninguna buena; `analisis/vps-qwen-lento/informe.md`), y la copia de cada noche de `ops/vps/balancita-respaldo.sh` (03:30 UTC) ya la cubre. `FUTURES_DB_BACKUP_MARKET=1` la vuelve a incluir (la primera de la lista), por ejemplo en la Mac, donde no hay otro respaldo nocturno.

- Destino: `server/data/backups/` (`FUTURES_DB_BACKUP_DIR`), archivos `<base>-AAAAMMDD-HHMMSS.sqlite`.
- Se conservan las **3 últimas buenas** por base (`FUTURES_DB_BACKUP_KEEP`); cada día (`FUTURES_DB_BACKUP_DAYS`, 0 = apagado). Pide ~3 veces el tamaño de cada base en disco (la de captura pesa GBs).
- Antes de copiar se hace `quick_check` de la **fuente**: si falla, no se copia nada, **la última copia buena queda intacta** y Salud muestra ERROR. La copia nueva también pasa `quick_check` antes de entrar en su lugar (se escribe como `.tmp` y se renombra).
- No corre mientras la limpieza trabaja, ni en los 10 min posteriores a un despertar, y nunca dos a la vez. Un intento fallido se reintenta a la hora, no en bucle.
- Una base que no existe (p. ej. no se usa `qwen-live`) se omite.

## Detección y mensaje claro

`quick_check` de la base de captura **cada 6 h** (`FUTURES_DB_INTEGRITY_MINUTES`, por defecto 360; antes 15 min) en un proceso hijo que se corta a los 45 min sin dar veredicto (`FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES`, por defecto 45; antes 10 min). En Linux los hijos de chequeo y copia corren con `nice -n 19 ionice -c3`. Una base dañada se detecta hasta 6 h tarde; la copia nocturna con `integrity_check` completo lo cubre. Además se chequea justo después de cada despertar. Si una escritura de la captura devuelve «malformed» se marca la base como dañada al instante y se confirma con un chequeo. El estado se publica en `server/data/dev-live/db-health-state.json`.

El panel **Salud del sistema** (componente «Datos», filas «Integridad de la base de captura» y «Copia de seguridad diaria») muestra:

> Base dañada: futures-market.sqlite. Reparación: restaurar la última copia buena (server/data/backups) o reconstruir descartando la tabla dañada con «pnpm db:rebuild <copia>».

en lugar de «El snapshot no contiene velas verificables». Mientras la base figure dañada, la limpieza no corre.

## Si la base está dañada

1. Parar `pnpm dev` (la captura sigue escribiendo sobre un archivo roto).
2. **Opción A, restaurar**: copiar la última copia buena de `server/data/backups/` a `server/data/dev-live/futures-market.sqlite` (borrando los `-wal` y `-shm` viejos). Se pierde lo ocurrido desde esa copia (la captura repara huecos de velas oficiales de hasta 10 días).
3. **Opción B, reconstruir** descartando la tabla dañada:
   ```sh
   pnpm db:snapshot server/data/dev-live/futures-market.sqlite   # o trabajar sobre una copia que ya tengas
   pnpm db:rebuild server/data/snapshots/futures-market-<fecha>.sqlite
   ```
   Crea `…rebuilt-<fecha>.sqlite` (más `.report.json`): tabla por tabla copia esquema y filas con los mismos rowids, descarta las tablas que no se pueden leer (`--keep-partial` conserva las filas leídas antes del fallo), recrea índices y triggers al final y termina con `integrity_check`. El informe lista qué se perdió. Después se reemplaza el archivo vivo con la base reconstruida.
4. Volver a levantar `pnpm dev`.

## Qué pasa al dormir y despertar

El detector (`platform/wake-detector.ts`) mira cada 5 s dos relojes: el de pared sigue corriendo mientras la Mac duerme y el monótono no. Un salto de más de 2 min entre ticks (o una diferencia de más de 2 min entre ambos relojes) es un despertar. Entonces (`kraken-futures/wake-guard.ts`):

1. La limpieza se **pausa 10 min** y retoma sola; un ciclo en curso termina en su próximo paso.
2. `wal_checkpoint(TRUNCATE)` y `quick_check` **antes** de reanudar escrituras pesadas. Si el chequeo dice «dañada», la limpieza y las copias no reanudan.
3. Se anota un evento `despertar` en `resilience.jsonl`, y los clientes HTTP abren conexiones nuevas durante un rato (los sockets del pool murieron). Las consultas a Kraken se reintentan con backoff (catálogo: 1 s, 2 s, 4 s…; pollers REST: su ritmo propio; WebSocket: reconexión existente).

## Limpieza suave

- Un ciclo cada 30 s que trabaja como máximo 6 s: **20 % de ocupación** (antes ~20 s de cada 15-30 s).
- Transacciones cortas de 100 a 1.000 filas (antes hasta 5.000), con `wal_checkpoint(PASSIVE)` cada 20 pasos y al cerrar un ciclo que borró algo; el checkpoint pasivo de 5 min sigue.
- No limpia con un salto de reloj reciente, con una copia en curso ni con la base dañada.

### Eventos crudos: ¿particionar por día?

Evaluado, **no migrado ahora**. Descartar un día entero (tabla o archivo por día, `DROP`/borrar archivo) evitaría el `DELETE` masivo, pero `paper_futures_market_events` es evidencia inmutable con triggers, lectores por rowid (gateway, Python) y claves foráneas de `book_snapshots` y `ticker_snapshots`; partirla toca a todos los lectores y migra GBs. Con lotes chicos, ventana del 20 % y checkpoint la limpieza deja de ser el riesgo principal; si la base vuelve a crecer o a dañarse, el siguiente paso es la partición diaria en archivos `ATTACH`.

## Retención de eventos crudos: 48 h

Desde el 2-nov-2026 los tickers y la copia duplicada del mensaje del proveedor (`raw` dentro de `normalized_json`) duran **48 h** en vez de 24 h; los trades y libros siguen en 7 días. Motivo: con 24 h, cuando una copia diaria veía terminado el día D, la retención ya había borrado sus primeras horas y el archivo Parquet quedaba incompleto; con 48 h una copia diaria siempre trae el día anterior entero (`docs/archivo-parquet.md`, «`market_events` y la retención de 48 h»). Costo: los tickers ocupan el doble en la base viva (≈1 GB más). `market:prune` (versión offline) usa los mismos valores.

Variables (todas opcionales; un valor que no sea un número positivo se ignora): `FUTURES_TICKER_RETENTION_HOURS` (48), `FUTURES_RAW_COPY_KEEP_HOURS` (48), `FUTURES_EVENT_RETENTION_DAYS` (7). Para volver a 24 h: `FUTURES_TICKER_RETENTION_HOURS=24 FUTURES_RAW_COPY_KEEP_HOURS=24` y reiniciar la captura.

## Interruptores para guardar menos (apagados por defecto)

Tres recortes de lo que la captura escribe en `futures-market.sqlite`. **Los tres vienen apagados**: sin variable, la captura escribe exactamente lo de siempre. Se encienden con una variable de entorno del proceso de captura (`.env.local` en la raíz o `VARIABLE=1 pnpm dev`) y **hay que reiniciar la captura**; se apagan quitando la variable y reiniciando (lo ya recortado no vuelve, lo nuevo se guarda entero). Valores que encienden: `1`, `true`, `on`, `yes`.

| Variable                                                                                       | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                              | Qué sigue igual                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUTURES_FUNDING_BODY=none` (por defecto desde 2026-11-06; `daily` / `full` para volver atrás) | `funding_responses`: cada respuesta nueva guarda solo el cuerpo corto (`balancitaSlim`, con el hash y el tamaño del cuerpo completo y el texto literal de los períodos nuevos); si no se pueden aislar los períodos, guarda el cuerpo completo. Ahorro: de ≈170 MB/día a ≈0,1 MB/día. Detalle: `docs/funding-cuerpo-respuestas.md`.                                                                                                                   | Igual que la fila siguiente: `funding_periods`, `funding_sightings`, `funding_polls`, la Terminal y `futures_funding_context.py` no cambian.                                                                                                                                                                                                                              |
| `FUTURES_FUNDING_BODY_DAILY=1` (heredado: solo si `FUTURES_FUNDING_BODY` no está definido)     | `funding_responses`: la primera respuesta nueva de cada día UTC y producto guarda el cuerpo completo (~1 MB); las demás respuestas nuevas guardan un cuerpo corto (`{"balancitaSlim":true,"fullSha256":…,"fullBytes":…,"serverTime":…,"rates":[solo los períodos nuevos, en el texto literal de Kraken]}`). La clave `sha256` sigue siendo la del cuerpo completo. Ahorro: de ≈170 MB/día a ≈10 MB/día.                                               | `funding_periods`, `funding_sightings`, `funding_polls` y la Terminal: no se tocan. `futures_funding_context.py` lee `["rates"]` y encuentra las tasas relativas de los períodos nuevos.                                                                                                                                                                                  |
| `FUTURES_ANALYTICS_RAW_SLIM=1`                                                                 | `analytics_responses`: la fila queda (la clave foránea de `analytics_points` apunta a ella) pero con `{"balancitaSlim":true,"sha256":…,"bytes":…}` en vez del cuerpo (≈72 MB hoy; cada fila pasa a ≈100 bytes).                                                                                                                                                                                                                                       | `analytics_points` se escribe igual: la Terminal (`terminal-chart.ts`, `market-follower.ts`) y `futures_costs.py` la leen. Nadie lee `raw_response` de analytics.                                                                                                                                                                                                         |
| `FUTURES_CANDLE_REVISIONS_COMPACT=1` (+ `FUTURES_CANDLE_REVISIONS_SETTLE_HOURS`, 6)            | `candle_revisions`: la captura sigue escribiendo cada revisión (el seguidor de la Terminal las lee en vivo por rowid). La limpieza suave, ya con la de eventos al día, borra de las velas **asentadas** (su minuto terminó hace más de 6 h) las revisiones abiertas intermedias: quedan la primera, la última y **todas las cerradas**. De ≈175 a 2-3 filas por vela. Cinco minutos de velas por paso, transacción corta, mismo presupuesto del 20 %. | Velas cerradas (`closedCandlesTail`, `candlesAsOf`, `candlesTailAsOf`), la cabeza de cada vela (`candleHeadById`, `openCandleHeads`) y la primera/última revisión cerrada que lee `capture_minimal_read.py`. `futures_history.py` no lee esta tabla (arma sus velas desde los eventos). Cambia el conteo de filas que informa `capture_inventory.py` (`capture_candles`). |

Aviso para el Parquet: lo que la compactación borra no llega al archivo si la copia se toma después. Las revisiones intermedias solo sirven para ver cómo se fue armando una vela; si se las quiere en Parquet, exportar primero (el exportador mira copias de hasta 24 h de antigüedad: dejar `FUTURES_CANDLE_REVISIONS_SETTLE_HOURS` en 48 o más).

## Tablas vacías

Revisado el 2-nov-2026 (quién escribe y quién lee cada una):

| Tabla                                                    | Filas | Escribe                                                      | Lee                                                                                         | Decisión                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paper_futures_ticker_snapshots`                         | 0     | nadie (legacy)                                               | nadie (solo `market:prune` la limpia)                                                       | **Ya no se crea en bases nuevas.** Las bases viejas la conservan y abren igual. Se quita de una copia reconstruida (abajo).                                                                                                                                                                      |
| `paper_futures_book_snapshots`                           | 0     | `futures-market-store.ts` (solo si llega un `book_snapshot`) | nadie                                                                                       | **Se queda.** Está vacía porque la captura corre con `bookFeed: false` (`live-capture.ts`): el recolector de mercado no se suscribe al libro. El libro que se encendió el 1-nov es el del `orderbook-collector`, que escribe en **su propia base** (`book_depth`, `book_gap`), no en esta tabla. |
| `paper_futures_llm_errors`                               | 0     | `futures_llm_decisions.py` al fallar una decisión            | nadie                                                                                       | Se queda: 0 filas = sin errores.                                                                                                                                                                                                                                                                 |
| `paper_futures_news_errors`                              | 0     | `futures_news.py` al fallar un análisis                      | `futures_news.py` (cuenta reintentos)                                                       | Se queda.                                                                                                                                                                                                                                                                                        |
| qwen-live `errors`, `news_actions`, `execution_receipts` | 0     | `futures_qwen_live.py`                                       | `execution_receipts`: `qwen-decisions.ts` (Terminal); `news_actions`: la regla del analista | Se quedan: tienen escritor y lector vivos.                                                                                                                                                                                                                                                       |

**Quitar las vacías de una copia** (nunca de la base viva: `pnpm dev` parado, hacer la copia con `pnpm db:snapshot` y reemplazar la viva como en «Compactar»):

```sh
pnpm db:snapshot server/data/dev-live/futures-market.sqlite
pnpm db:rebuild server/data/snapshots/futures-market-<fecha>.sqlite --drop-empty-legacy
# otras tablas: --drop-empty paper_futures_x,paper_futures_y   (deben tener 0 filas y que ninguna otra tabla las referencie)
```

La reconstruida deja afuera la tabla, sus índices y sus triggers; si una tiene filas o la referencia otra tabla, el comando se niega (código 2) y no crea nada. El informe marca `QUITADA`.

## `synchronous`: NORMAL (decisión)

Medido (SQLite WAL, 20.000 commits de una fila de 600 B, Linux, SSD de la VM): `NORMAL` 24-26 µs por commit, `FULL` 166-170 µs (≈7×, +145 µs por commit; a ~100 eventos/s son ~1,5 % de un núcleo). En una Mac el costo real de `FULL` es distinto (el fsync normal es más barato que en esta VM, pero `F_FULLFSYNC` mucho más caro) y debe medirse ahí.

Se mantiene **`NORMAL`**: en WAL, `NORMAL` no corrompe la base ante un corte (puede perder los últimos commits, no dejarla inconsistente) y el sueño no es un corte de energía. El daño del 2-nov apunta a una limpieza masiva sobre un archivo grande interrumpida por el sueño, que es lo que se ataca arriba. Quien quiera `FULL` lo activa con `FUTURES_DB_SYNCHRONOUS=full` y mira `eventloop.jsonl`. `wal_autocheckpoint` queda explícito en 1.000 páginas (~4 MB).

## Ciclo de vida de los datos

1. **Captura** → escribe en SQLite («mesa de trabajo»: los últimos días).
2. **Copia diaria** → `server/data/backups` (3 últimas buenas por base, con `quick_check`).
3. **Parquet** → cada noche (04:30, launchd) la exportación toma la última copia buena de cada base, escribe archivos Parquet verificados en `~/balancita-data.noindex/archivo-parquet` y deja el resumen en `nocturno.jsonl` (`docs/archivo-parquet.md`). Se instala con `bash ops/launchd/instalar-archivo-parquet.sh`.
4. **Borrado de lo archivado** → **apagado por defecto**. Solo posicionamiento y premium, solo meses ya confirmados y certificados en el manifiesto, fuera de la ventana de 30 días (+1 día de margen), con copia diaria buena de menos de 30 h. Veredictos, decisiones, puntajes y noticias no se borran por archivo (otro proceso las escribe y tienen triggers de inmutabilidad; las noticias no se borran nunca); los eventos crudos ya los recorta la retención de la captura (tickers y copia cruda 48 h, trades 7 días).
5. **Compactación** → manual, ver abajo.

Qué corre solo: captura, retención suave, copia diaria, chequeos de integridad y (tras el instalador) la exportación nocturna. Qué NO corre solo: el borrado de lo archivado y la compactación.

Variables de entorno de esta parte: `FUTURES_ARCHIVE_DELETE` (`1` borra, `dry-run` solo informa; vacío = apagado), `FUTURES_ARCHIVE_REQUIRE_OFFSITE=1` (además exige «confirmado fuera»; apagado hasta que haya VPS), `BALANCITA_ARCHIVO_DESTINO` (carpeta del archivo), `BALANCITA_RESPALDOS_DIR` (copias, para la exportación). **Para apagar el borrado**: quitar `FUTURES_ARCHIVE_DELETE` y reiniciar el proceso (el recolector de posicionamiento). Cada paso queda en `retention.jsonl` (`kind: archive-delete`; en el recolector, junto a su base, con `db: positioning`).

## Compactar (devolver el espacio libre al disco)

SQLite no devuelve espacio al borrar: las páginas libres quedan «reutilizables» dentro del archivo. Conviene compactar cuando el espacio libre pase de ~30 % de la base. `pnpm db:compact <copia>` lo mide y compacta **una copia**:

```sh
pnpm db:snapshot server/data/dev-live/positioning.sqlite        # copia consistente
pnpm db:compact server/data/snapshots/positioning-<fecha>.sqlite
# -> positioning-<fecha>.compact-<fecha>.sqlite (VACUUM INTO a un archivo nuevo; integrity_check y conteos por tabla iguales)
```

Para reemplazar la base viva (la compactación nunca toca la viva): 1) **parar `pnpm dev`**; 2) mover la base viva y sus `-wal`/`-shm` a una carpeta aparte (no borrarlos todavía); 3) copiar la compacta al lugar de la viva; 4) levantar `pnpm dev` y mirar `health.jsonl`; 5) borrar lo guardado a mano pasados unos días. Hace falta espacio libre en disco para la copia y la compacta. Todo lo que se escribió en la base viva desde la copia se pierde en ese reemplazo: hacer la copia justo antes de parar. El panel Salud no muestra todavía el espacio libre (no hay un lugar existente que encaje sin agregar vistas); `pnpm db:compact` lo informa.

## Archivos que genera

`server/data/dev-live/`: `health.jsonl` (cada chequeo y copia), `db-health-state.json` (estado que lee Salud), `resilience.jsonl` (incluye `despertar`), `retention.jsonl`. `server/data/backups/`, `server/data/snapshots/`: todo ignorado por git.
