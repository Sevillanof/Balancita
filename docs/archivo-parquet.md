# Archivo Parquet a largo plazo (fase 1)

Diseño: `analisis/archivo-parquet/informe.md`. Esta fase es un exportador **offline**: lee una **copia** de SQLite, escribe archivos Parquet verificados y un manifiesto. No borra nada en SQLite, no toca la captura ni cambia ninguna lectura existente. Código en `python/archivo_parquet/`.

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

Tablas soportadas: `verdicts` (`paper_futures_verdicts`), `llm_decisions` (`paper_futures_llm_decisions`) y `market_events` (`paper_futures_market_events`). Para sumar otra se agrega una entrada en `python/archivo_parquet/config.py` (nombre, columna de tiempo, clave, columnas, columna de hash).

## Qué se guarda

```
<destino>/<base>/<tabla>/anio=YYYY/mes=MM/dia=DD/part-<sha8>.parquet
<destino>/manifiesto.jsonl
```

- Un archivo por día UTC y tabla; zstd nivel 3; grupos de ~128 000 filas; ordenado por clave (producto y tiempo primero). En `market_events` la clave es `(product_id, received_at, event_id)`: lleva `event_id` para tener un orden total.
- Tiempos como entero en milisegundos UTC. `payload_json` (y los demás textos) se guardan tal cual, sin reinterpretar. `schema_version` va en los metadatos del archivo y en el manifiesto.
- Una línea de manifiesto por archivo: base, tabla, día, ruta, filas, clave mín/máx, tiempo mín/máx, producto mín/máx, grupos de filas, bytes, sha256, suma de control, `schema_version`, fecha de exportación. Es el **catálogo**.

## Qué garantiza

- Lee solo una copia: la abre en solo lectura, rechaza `server/data/dev-live/*` y exige una carpeta `snapshots/` o `backups/` (o `--copia-confirmada` si es una copia en otro sitio). Antes corre `quick_check`; si falla, no exporta.
- Solo días cerrados con 1 día de margen; los que ya están en el manifiesto se saltan (idempotente).
- Por cada día: escribe `.tmp`, lo relee entero con verificación de checksum de páginas y compara con la copia (cantidad de filas = `COUNT(*)` del rango, clave mín/máx, suma de control del contenido: el conjunto de `verdict_hash`/`content_hash` cuando existe, el hash de cada fila si no). Recién entonces renombra y agrega la línea al manifiesto. Si algo difiere: no se promueve, el día queda en `no_confirmados` del reporte y el código de salida es 1.
- Memoria acotada: lotes de ~50 000 filas al leer la copia, un grupo de ~128 000 filas al escribir.
- `verificar` vuelve a comprobar sha256, relectura, filas, claves y suma de control de cada línea, y lista archivos `part-*` que no están en el manifiesto.

## Encontrar datos rápido

1. El **catálogo** (manifiesto) elige solo los archivos del rango de tiempo y del producto pedidos; no se abre ningún otro.
2. Dentro de cada archivo, el orden por producto y tiempo y las **estadísticas de grupo de filas** (mín/máx por columna) dejan saltar los bloques que no pueden contener lo pedido.
3. `buscar` imprime el informe (archivos elegidos y en catálogo, grupos de filas leídos y en total, bytes leídos) y las filas. En Python: `archivo_parquet.leer.buscar_archivo(...)` y `leer_archivo(destino, base, tabla, desde_ms, hasta_ms, columnas=None)`; el rango es `[desde, hasta)`.
4. Consulta DuckDB equivalente, sin instalar DuckDB: `buscar ... --duckdb` (o `leer.consulta_duckdb(...)`) imprime un `SELECT ... FROM read_parquet('.../anio=*/mes=*/dia=*/part-*.parquet', hive_partitioning = true) WHERE ...` con filtro de partición. Está probada solo como texto; no se ejecutó contra DuckDB.

`medir` cronometra cuatro búsquedas típicas (un producto en 1 hora, un día completo, una semana filtrando por una columna, una fila por clave) e informa mediana de tiempo, archivos y bytes leídos. Con `--sintetico-dias 30` lo hace sobre datos sintéticos grandes. Esos tiempos son de una máquina y un corpus sintético: no extrapolar a producción.

## Qué NO hace todavía

- **No borra nada** en SQLite ni cambia ventanas de retención (fase 3).
- **No hay respaldo fuera del VPS** ni restauración de prueba (fase 2): los Parquet y el manifiesto viven donde se exportan.
- **No hay rotación ni compactación mensual** (fase 4) ni exportación mensual de tablas chicas (posicionamiento, noticias...).
- No corre solo: hay que lanzarlo a mano o desde un trabajo programado que se agregue después. No se probó con una copia real.
- Es confirmación lógica: un disco que miente en `fsync` no está probado. Si el manifiesto se pierde, hay que reexportar (los archivos sin línea se descartan al reexportar ese día).
- El lector no une todavía SQLite reciente con Parquet histórico.
- Las tablas de las demás bases (puntajes de pronóstico, posicionamiento, noticias...) se suman luego por configuración.
