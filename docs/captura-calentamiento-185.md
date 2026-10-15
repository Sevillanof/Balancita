# Disponibilidad de calentamiento de la captura viva (#185, etapa 1)

Herramienta: `python/balancita_engine/capture_warmup_availability.py` (`capture-warmup-availability.v1`). Pruebas: `python/tests/test_capture_warmup_availability.py`.
Autorización: BAL-DECISION-185-02 ([6199674315](https://github.com/Sevillanof/Balancita/issues/185#issuecomment-6199674315)). Esta PR no corre nada contra datos reales: solo agrega la herramienta. Una sola ejecución, en la Mac de Fran, después del GO de D y del CI completo sobre el HEAD exacto.

## Qué responde

¿La captura viva tiene, para `PF_XBTUSD`, velas oficiales de 1 minuto en `[2026-10-01T00:00Z, 2026-10-13T01:00Z)` (17 340 minutos) y al menos 17 290 minutos consecutivos hasta el final de la ventana, sin campos vacíos? 17 290 = `required_warmup_ms` de las estrategias congeladas (1 037 400 000 ms = 3 458 barras de 5 min = 288 h 10 min); la prueba lo recalcula del código. Es una prueba de disponibilidad: no es el calentamiento de una sesión, no mira valores ni compara con Kraken.

## Qué lee

- Un agregado: conteo de filas, minutos distintos, mínimo y máximo de `bucket_start`, y cuántas filas tienen vacío (o nulo) algún campo de precio o volumen. Los campos de precio y volumen solo los puede leer ese agregado y devuelve un entero.
- Las filas `(bucket_start, known_at)` de la ventana.
- Nada más: ninguna otra tabla, columna, producto, intervalo ni ventana. El autorizador de SQLite deniega el resto y la herramienta rechaza otra ventana u otro producto.

## Topes

- 60 000 filas escaneadas en total: el agregado (que es el preconteo) más el fetch. Se corre el agregado primero; si `2 × filas > 60 000` no se hace el fetch y se informa el conteo. No hay muestreo.
- 60 s por consulta y 10 min en total. Sin reintentos. Con exceso o falla se detiene e informa (código de salida 2).
- Apertura `mode=ro` y `PRAGMA query_only` leído de vuelta (debe ser 1); un enlace simbólico se rechaza; el archivo debe llamarse `futures-market.sqlite`.

## Salida

JSON con versión, ventana, guardas, conteos, filas escaneadas, disponibilidad (minutos presentes y faltantes, tramos faltantes con inicio y largo, minutos consecutivos hasta el final, revisiones por vela, `known_at` menos fin de la vela), veredicto (`apta` o `bloqueada` con motivos), identidad del archivo antes y después (nombre, tamaño, fecha de modificación, archivo regular) y huella SHA-256. Sin precios, tasas ni volúmenes.

Con `bloqueada` no se mueve la ventana y no se corre la etapa 2 de BAL-DECISION-185-02: se informa y se espera la decisión de Fran.

## Ejecución (solo con la autorización y el GO de D)

```
cd python
python3 -m balancita_engine.capture_warmup_availability --db <ruta>/dev-live/futures-market.sqlite > warmup.json
```

Antes de correr: comparar `shasum` de los dos archivos de la herramienta con los publicados en la Issue y el HEAD con el revisado por D. Después: publicar en #185 el HEAD, los hashes, la identidad antes y después, los agregados y la aptitud (el JSON no contiene series).
