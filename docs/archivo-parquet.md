# Archivo Parquet a largo plazo (fases 1 y 2)

Diseño: `analisis/archivo-parquet/informe.md`. Es un exportador **offline**: lee una **copia** de SQLite, escribe archivos Parquet verificados y un manifiesto; la fase 2 suma más tablas, grupos de filas chicos y el respaldo fuera del VPS. No borra nada en SQLite, no toca la captura ni cambia ninguna lectura existente. Código en `python/archivo_parquet/`.

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

| Tabla (archivo)                                                             | SQLite                                                                                                | Base                    | Tiempo de partición                                           | Partición |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------- | --------- |
| `verdicts`                                                                  | `paper_futures_verdicts`                                                                              | futures-verdicts        | `bucket_start`                                                | día       |
| `llm_decisions`                                                             | `paper_futures_llm_decisions`                                                                         | futures-verdicts        | `bucket_start`                                                | día       |
| `market_events`                                                             | `paper_futures_market_events`                                                                         | futures-market          | `received_at`                                                 | día       |
| `forecasts`, `forecast_returns`, `forecast_barriers`, `forecast_excursions` | `paper_futures_forecasts`, `..._forecast_returns`, `..._forecast_barriers`, `..._forecast_excursions` | futures-forecast-scores | `bucket_start` (minuto de la decisión, no `written_at`)       | día       |
| `positioning`                                                               | `positioning`                                                                                         | positioning             | `bucket_ms`                                                   | mes       |
| `premium`                                                                   | `premium`                                                                                             | positioning             | `bucket_ms`                                                   | mes       |
| `news_items`                                                                | `paper_futures_news_items`                                                                            | futures-news            | `received_at` (siempre existe; `published_at` puede ser NULL) | mes       |
| `news_analysis`                                                             | `paper_futures_news_analysis`                                                                         | futures-news            | `analyzed_at`                                                 | mes       |

Cada tabla declara su `granularidad`: `dia` (carpeta `anio=/mes=/dia=`) o `mes` (carpeta `anio=/mes=`, un archivo por mes; para tablas chicas). Un mes se exporta cuando terminó hace al menos 1 día (mismo margen de 1 día que los días). En el manifiesto, `dia` de un archivo mensual es el día 1 del mes y la línea trae `granularidad`. Los puntajes de pronóstico usan el minuto de la decisión: un puntaje de 24 h se escribe al día siguiente pero cae en el día de la decisión, por eso el margen importa. Las noticias no tienen producto (las búsquedas por producto no aplican). La base SQLite de noticias se conserva: nada la borra.

## Qué se guarda

```
<destino>/<base>/<tabla>/anio=YYYY/mes=MM/dia=DD/part-<sha8>.parquet
<destino>/manifiesto.jsonl
```

- Un archivo por día UTC (o por mes, en las tablas mensuales) y tabla; zstd nivel 3; ordenado por clave (producto y tiempo primero). **Grupos de filas**: ~2 000 filas en las tablas con filas pesadas (JSON de ~10 KB: `verdicts`, `llm_decisions`, `market_events`, noticias) y ~128 000 en las chicas; se cambia con `filas_por_grupo` en la configuración de cada tabla. En `market_events` la clave es `(product_id, received_at, event_id)`: lleva `event_id` para tener un orden total.
- Tiempos como entero en milisegundos UTC. `payload_json` (y los demás textos) se guardan tal cual, sin reinterpretar. `schema_version` va en los metadatos del archivo y en el manifiesto.
- Una línea de manifiesto por archivo: base, tabla, día, ruta, filas, clave mín/máx, tiempo mín/máx, producto mín/máx, grupos de filas, bytes, sha256, suma de control, `schema_version`, fecha de exportación. Es el **catálogo**.

## Qué garantiza

- Lee solo una copia: la abre en solo lectura, rechaza `server/data/dev-live/*` y exige una carpeta `snapshots/` o `backups/` (o `--copia-confirmada` si es una copia en otro sitio). Antes corre `quick_check`; si falla, no exporta.
- Solo días cerrados con 1 día de margen; los que ya están en el manifiesto se saltan (idempotente).
- Por cada día: escribe `.tmp`, lo relee entero con verificación de checksum de páginas y compara con la copia (cantidad de filas = `COUNT(*)` del rango, clave mín/máx, suma de control del contenido: el conjunto de `verdict_hash`/`content_hash` cuando existe, el hash de cada fila si no). Recién entonces renombra y agrega la línea al manifiesto. Si algo difiere: no se promueve, el día queda en `no_confirmados` del reporte y el código de salida es 1.
- Memoria acotada: lotes de ~50 000 filas al leer la copia, un grupo de filas (2 000 o 128 000 según la tabla) al escribir.
- `verificar` vuelve a comprobar sha256, relectura, filas, claves y suma de control de cada línea, y lista archivos `part-*` que no están en el manifiesto.

## Encontrar datos rápido

1. El **catálogo** (manifiesto) elige solo los archivos del rango de tiempo y del producto pedidos; no se abre ningún otro.
2. Dentro de cada archivo, el orden por producto y tiempo y las **estadísticas de grupo de filas** (mín/máx por columna) dejan saltar los bloques que no pueden contener lo pedido.
3. `buscar` imprime el informe (archivos elegidos y en catálogo, grupos de filas leídos y en total, bytes leídos) y las filas. En Python: `archivo_parquet.leer.buscar_archivo(...)` y `leer_archivo(destino, base, tabla, desde_ms, hasta_ms, columnas=None)`; el rango es `[desde, hasta)`.
4. Consulta DuckDB equivalente, sin instalar DuckDB: `buscar ... --duckdb` (o `leer.consulta_duckdb(...)`) imprime un `SELECT ... FROM read_parquet('.../anio=*/mes=*/dia=*/part-*.parquet', hive_partitioning = true) WHERE ...` con filtro de partición. Está probada solo como texto; no se ejecutó contra DuckDB.

**Por qué grupos chicos.** Con un solo grupo por día (9,5 mil filas de ~11 KB), buscar un producto en 1 hora leía el día completo (0,24 s medidos). Con grupos de 2 000 filas, las estadísticas (mín/máx de producto y de tiempo por grupo) dejan saltar los grupos que no pueden contener lo pedido. Prueba (`test_archivo_parquet_fase2`, datos sintéticos): de 5 grupos se leen 1 o 2 y los bytes leídos bajan a ~20 %. Medición sintética con filas de 11 KB (4 productos × 2 400 filas, un producto en 1 hora, mejor de 5): 2 de 5 grupos, 23 MB leídos y ~158 ms, contra 1 grupo, 56 MB y ~395 ms. Son números de esta máquina con datos sintéticos incompresibles: no extrapolar. Los grupos que mezclan el final de un producto con el inicio del siguiente no se pueden descartar por tiempo, por eso a veces se leen 2.

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

- **No borra nada** en SQLite ni cambia ventanas de retención. Falta el **borrado verificado** (fase 3): leer `respaldo-estado.jsonl`, reverificar antes de borrar y recién entonces recortar SQLite. Hasta entonces el respaldo solo suma.
- **No hay rotación ni compactación** (fase 4): ni compactar días en archivos más grandes, ni rotar o limitar lo que ya está en el remoto, ni rotar las claves del remoto cifrado.
- No corre solo: los ejemplos de cron/systemd/launchd de arriba son para cuando exista el VPS. No se probó con rclone real ni con un remoto real (las pruebas usan un remoto falso en una carpeta local), ni con una copia real.
- La verificación depende de lo que el remoto sepa hacer: sin sha256 se usa `rclone check --download`. Un remoto que miente sobre lo que guarda no está probado; por eso existe `restaurar-prueba`.
- Es confirmación lógica: un disco que miente en `fsync` no está probado. Si el manifiesto local se pierde, hay que reexportar (los archivos sin línea se descartan al reexportar ese día); el manifiesto del remoto sirve de copia del catálogo.
- El lector no une todavía SQLite reciente con Parquet histórico.
- Los esquemas de las tablas nuevas salen del código de captura (no se leyó ninguna base real); si una columna cambia, la exportación se rechaza hasta subir `schema_version`.
