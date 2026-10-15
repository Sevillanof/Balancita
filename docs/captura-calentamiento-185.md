# Disponibilidad de calentamiento de la captura viva (#185, etapa 1)

Herramienta: `python/balancita_engine/capture_warmup_availability.py` (`capture-warmup-availability.v1`). Pruebas: `python/tests/test_capture_warmup_availability.py`.
Ventana: la primera (`[2026-10-01T00:00Z, 2026-10-13T01:00Z)`, versión `v1`) salió `bloqueada` porque la captura empieza el 1-oct a las 19:50Z; Fran autorizó repetir una sola vez con esta ventana (versión `v2`, mismos topes y columnas; [6200506915](https://github.com/Sevillanof/Balancita/issues/185#issuecomment-6200506915)).
Autorización: BAL-DECISION-185-02 ([6199674315](https://github.com/Sevillanof/Balancita/issues/185#issuecomment-6199674315)). Esta PR no corre nada contra datos reales: solo agrega la herramienta. Una sola ejecución, en la Mac de Fran, después del GO de D y del CI completo sobre el HEAD exacto.

## Qué responde

¿La captura viva tiene, para `PF_XBTUSD`, velas oficiales de 1 minuto en `[2026-10-01T19:50Z, 2026-10-13T21:00Z)` (17 350 minutos, 60 de margen) y al menos 17 290 minutos consecutivos hasta el final de la ventana, sin campos vacíos en esos 17 290 minutos? 17 290 = `required_warmup_ms` de las estrategias congeladas (1 037 400 000 ms = 3 458 barras de 5 min = 288 h 10 min); la prueba lo recalcula del código. Es una prueba de disponibilidad: no es el calentamiento de una sesión, no mira valores ni compara con Kraken.

## Qué lee

- Una sola consulta, sin preconteo ni agregado previo: `SELECT bucket_start, known_at, <bandera 0/1 de campos vacíos> ... ORDER BY bucket_start LIMIT 60000`. Los campos de precio y volumen solo aparecen dentro de esa bandera, así que de la base sale un 0 o un 1, nunca un valor. Los conteos, los minutos distintos, el mínimo y el máximo se calculan en Python.
- Nada más: ninguna otra tabla, columna, producto, intervalo ni ventana. El autorizador de SQLite deniega el resto y la herramienta rechaza otra ventana u otro producto.

## Topes

- 60 000 filas escaneadas: el `LIMIT` hace que la base nunca recorra más. Si vuelven 60 000 filas, la ventana puede tener más: se detiene con `row_budget` y no analiza nada (con exactamente 60 000 filas también se rechaza, a propósito). No hay muestreo.
- Antes de leer, `EXPLAIN QUERY PLAN` debe mostrar un `SEARCH` sobre el índice de la clave primaria, sin `SCAN` ni orden temporal; si no, se detiene con `query_plan`. El plan se publica en la salida: es la prueba de que "filas escaneadas" es lo que se dice.
- 60 s por consulta y 10 min en total. Sin reintentos. Con exceso o falla se detiene e informa (código de salida 2).
- Apertura `mode=ro` y `PRAGMA query_only` leído de vuelta (debe ser 1); un enlace simbólico se rechaza; el archivo debe llamarse `futures-market.sqlite`.

## Salida

JSON con versión, ventana, guardas, conteos, filas escaneadas, disponibilidad (minutos presentes y faltantes, tramos faltantes con inicio y largo, minutos consecutivos hasta el final, revisiones por vela, `known_at` menos fin de la vela), veredicto (`apta` o `bloqueada` con motivos; un campo vacío bloquea solo si está en los 17 290 minutos que cierran la ventana, los demás se informan), plan de consulta, identidad del archivo antes y después (nombre, tamaño, fecha de modificación, archivo regular) y huella SHA-256. Sin precios, tasas ni volúmenes.

Con `bloqueada` no se mueve la ventana y no se corre la etapa 2 de BAL-DECISION-185-02: se informa y se espera la decisión de Fran.

## Ejecución (solo con la autorización y el GO de D)

```
cd python
python3 -m balancita_engine.capture_warmup_availability --db <ruta>/dev-live/futures-market.sqlite > warmup.json
```

Antes de correr: comparar `shasum` de los dos archivos de la herramienta con los publicados en la Issue y el HEAD con el revisado por D. Después: publicar en #185 el HEAD, los hashes, la identidad antes y después, los agregados y la aptitud (el JSON no contiene series).
