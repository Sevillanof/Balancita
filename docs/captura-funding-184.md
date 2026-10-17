# Medición de solo lectura del funding capturado (Issue #184)

Estado: **herramienta lista para revisión; no se corrió sobre datos reales.** Código: `python/balancita_engine/capture_funding_184.py` (`capture-funding-184.v1`). Pruebas con datos inventados: `python/tests/test_capture_funding_184.py`.

Autorización: BAL-DECISION-184-02 (lectura de solo lectura de lo ya capturado para validar el funding de #184), la propuesta BAL-PROPUESTA-184-LECTURA-02 con el GO de D, y la constancia BAL-REGISTRO-184-EXCEPCION-01 del mensaje de Fran sobre el período posterior al 2026-08-02.

## Qué es

Una sola corrida mide, para `PF_XBTUSD` y `PF_ETHUSD` en `[2026-10-10T00:00Z, 2026-10-12T00:00Z)`, si el funding capturado sostiene lo que supone el adaptador de #167: cobertura por hora, revisiones y publicación, unidades (relativo × precio contra absoluto), referencia de precio y tiempos. No fija umbrales, no cambia el adaptador, el validador ni ningún parser, y no convierte una diferencia sin causa en una regla de producto.

## Qué reutiliza sin cambios

`capture_minimal_read` (etapa 2 de #183): las sentencias de 2a, 2c y 2d, el autorizador por sentencia, el control del plan (`SEARCH`, sin `SCAN` ni orden temporal), las búsquedas acotadas por `rowid`, los controles de orden, la identidad del archivo, `mode=ro` + `query_only` y los topes de 2c y 2d. Y `capture_funding_diagnosis` para clasificar la publicación (`early`, `late`, `not_causal`).

## Qué cambia respecto de la etapa 2 (todo declarado)

- Solo se lee `paper_futures_official_candles` (1 min, referencia de precio), `paper_futures_funding_periods` y `paper_futures_funding_responses`. No se usa 2b ni ninguna otra tabla.
- El tope de 2a es 6 000 filas (mismo texto de la sentencia; cambia solo el `LIMIT`). 2c y 2d conservan 600 y 1 200.
- **Tope de la corrida:** 8 000 filas y 200 MB en total, sumando filas recorridas y toda lectura de una fila (búsqueda binaria incluida). Se controla antes de leer, a partir de los topes por etapa (7 800), y de nuevo al terminar. El total de 173 000 de BAL-DECISION-185-02 no se amplía ni se usa; `--prior-rows` se publica, no se suma.
- La excepción del período protegido es la propia ventana (la única que `capture_validation` acepta); `HOLDOUT_START_MS` no cambia. Los márgenes de 2c (−1 h / +3 h sobre `known_at`) se leen solo como `rowid` + instante, nunca se validan ni se publican, y cuentan en los topes.

## Tablas y columnas que el autorizador deja pasar, por sentencia

| Sentencia         | Tabla                             | Columnas                                                                                                                                                |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a (referencia)   | `paper_futures_official_candles`  | `product_id`, `interval_ms` (filtro), `bucket_start`, `revision_hash`, `known_at`, `open_price`, `high_price`, `low_price`, `close_price`, `volume_btc` |
| 2c_bound          | `paper_futures_funding_periods`   | `rowid`, `known_at`                                                                                                                                     |
| 2c                | `paper_futures_funding_periods`   | `rowid`, `product_id`, `start_ms`, `end_ms`, `funding_rate`, `known_at`, `unit`, `response_sha256`                                                      |
| 2d_bound          | `paper_futures_funding_responses` | `rowid`, `received_at`                                                                                                                                  |
| 2d_meta           | `paper_futures_funding_responses` | `rowid`, `sha256`, `received_at`                                                                                                                        |
| 2d_lookup         | `paper_futures_funding_periods`   | `response_sha256`, `product_id`                                                                                                                         |
| 2d_size / 2d_body | `paper_futures_funding_responses` | `sha256`, `raw_response` (el tamaño con `octet_length` antes de leer el cuerpo)                                                                         |

Las lecturas de borde de la búsqueda binaria (2c_bound y 2d_bound) devuelven solo `rowid` y un instante, pueden caer fuera de la ventana, se cuentan en los topes y no se publican. Las sentencias son las de `capture_minimal_read`; la única diferencia es el valor de `LIMIT` de 2a.

## Qué publica (solo agregados)

Cobertura por hora (máscara de 48 caracteres: una hora cuenta como cubierta solo con un período definitivo según una respuesta interpretada; las horas con solo filas provisionales o de respuestas rechazadas se publican aparte), cantidad de filas y de tasas distintas por período, desfase de la primera respuesta definitiva respecto del fin, clasificación de publicación, error relativo de la unidad en cuantiles (una razón, no valores), antigüedad de la referencia, `serverTime − received_at`, forma de cada `serverTime` rechazado, y una entrada por hipótesis del adaptador (relativo = absoluto / precio; definitivo no antes de 10 min; definitivo dentro del plazo; «primero visto gana») con `sostenida`, `contradicha` o `no_medible` calculada solo con conteos: `no_medible` si no se midió nada, `contradicha` si algún caso medido va en contra, `sostenida` si todos los medidos coinciden. Los conteos van al lado; el veredicto no es una regla de producto. Ninguna tasa, precio, volumen, dígito de `serverTime` ni cuerpo de respuesta sale del proceso.

## Cómo se corre (lo hace el RC una sola vez, con el HEAD aprobado)

1. Worktree limpio del HEAD aprobado, sin tocar `pnpm dev` ni la captura.
2. Intérprete **fijo en la orden al RC** (ruta absoluta y versión); con Python ≥ 3.11 también se interpretan los `serverTime` de dos decimales; con 3.9 esos quedan rechazados y se informa.
3. `PYTHONPATH=python <python> -m balancita_engine.capture_funding_184 --db <ruta absoluta>/dev-live/futures-market.sqlite --prior-rows 63089 > salida.json`. Salida 0, o 2 con `stopped.reason`; una parada se publica y no se repite sin nueva aprobación.
4. Se publica el JSON tal cual, con el HEAD, la versión de Python, el tamaño, `mtime` y el par dispositivo/inodo antes y después (la captura viva puede crecer: la prueba de que no se escribió es el modo `ro`, el autorizador y `query_only`).
