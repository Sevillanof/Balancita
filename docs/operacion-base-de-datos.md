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

`futures-market`, `qwen-live` (`qwen-live/live.sqlite`), `futures-verdicts`, `positioning`, `futures-news`, `futures-forecast-scores`, `futures-llm-decisions`.

- Destino: `server/data/backups/` (`FUTURES_DB_BACKUP_DIR`), archivos `<base>-AAAAMMDD-HHMMSS.sqlite`.
- Se conservan las **3 últimas buenas** por base (`FUTURES_DB_BACKUP_KEEP`); cada día (`FUTURES_DB_BACKUP_DAYS`, 0 = apagado). Pide ~3 veces el tamaño de cada base en disco (la de captura pesa GBs).
- Antes de copiar se hace `quick_check` de la **fuente**: si falla, no se copia nada, **la última copia buena queda intacta** y Salud muestra ERROR. La copia nueva también pasa `quick_check` antes de entrar en su lugar (se escribe como `.tmp` y se renombra).
- No corre mientras la limpieza trabaja, ni en los 10 min posteriores a un despertar, y nunca dos a la vez. Un intento fallido se reintenta a la hora, no en bucle.
- Una base que no existe (p. ej. no se usa `qwen-live`) se omite.

## Detección y mensaje claro

`quick_check` de la base de captura **cada 15 min** (proceso hijo, se corta a los 10 min sin dar veredicto) y justo después de cada despertar. Si una escritura de la captura devuelve «malformed» se marca la base como dañada al instante y se confirma con un chequeo. El estado se publica en `server/data/dev-live/db-health-state.json`.

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

## `synchronous`: NORMAL (decisión)

Medido (SQLite WAL, 20.000 commits de una fila de 600 B, Linux, SSD de la VM): `NORMAL` 24-26 µs por commit, `FULL` 166-170 µs (≈7×, +145 µs por commit; a ~100 eventos/s son ~1,5 % de un núcleo). En una Mac el costo real de `FULL` es distinto (el fsync normal es más barato que en esta VM, pero `F_FULLFSYNC` mucho más caro) y debe medirse ahí.

Se mantiene **`NORMAL`**: en WAL, `NORMAL` no corrompe la base ante un corte (puede perder los últimos commits, no dejarla inconsistente) y el sueño no es un corte de energía. El daño del 2-nov apunta a una limpieza masiva sobre un archivo grande interrumpida por el sueño, que es lo que se ataca arriba. Quien quiera `FULL` lo activa con `FUTURES_DB_SYNCHRONOUS=full` y mira `eventloop.jsonl`. `wal_autocheckpoint` queda explícito en 1.000 páginas (~4 MB).

## Archivos que genera

`server/data/dev-live/`: `health.jsonl` (cada chequeo y copia), `db-health-state.json` (estado que lee Salud), `resilience.jsonl` (incluye `despertar`), `retention.jsonl`. `server/data/backups/`, `server/data/snapshots/`: todo ignorado por git.
