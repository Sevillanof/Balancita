# Funding en tiempo real por WebSocket (solo BTC)

Estado: implementado para `PF_XBTUSD`. Los otros 7 productos quedan pendientes
(ver el final). Complementa a `captura-funding-184.md`: el REST
`/historical-funding-rates` sigue siendo el respaldo y la fuente de la
comparación.

## Qué se captura

El ticker WS de Kraken Futures trae, para el periodo horario en curso,
`funding_rate` (USD absolutos por contrato y hora) y `relative_funding_rate`,
y para el siguiente periodo `funding_rate_prediction` y
`relative_funding_rate_prediction` (Kraken avisa de que pueden ser muy
inexactas), más `next_funding_rate_time` (cierre del periodo en curso, ms
epoch). Kraken omite los campos con valor cero: un campo ausente se guarda
como el texto `'0'`, nunca como "falta".

Tablas aditivas, solo-añadir (triggers que abortan UPDATE y DELETE), creadas
junto a las de sightings; no son una migración numerada, así que los lectores
de esquema 3-7 siguen funcionando:

- `paper_futures_funding_ws_observations`: `product_id`, `received_at` (reloj
  local), `event_time` (el `time` del ticker, solo diagnóstico),
  `connected_at` (identifica la conexión), `first_after_connect`,
  `funding_rate`, `relative_funding_rate`, `funding_rate_prediction`,
  `relative_funding_rate_prediction`, `next_funding_rate_time`. Se escribe en
  el primer ticker tras cada (re)conexión y cuando cambia cualquiera de los
  cinco valores. Las predicciones tienen columnas propias y nunca se leen como
  tasa.
- `paper_futures_funding_ws_marks`: `product_id`, `at`, `connected_at`,
  `kind` (`alive` | `closed`). `alive` como mucho cada 30 s mientras llegan
  tickers (se escribe después de la observación, así que detrás de un `alive`
  siempre hay una observación de esa conexión); `closed` al cerrarse, reconectar
  o parar el socket. Sin esto, "no cambió" y "no estábamos" serían
  indistinguibles.

Escritor único: las filas las escribe el colector del proceso que ya tiene el
`FuturesMarketStore` abierto para escritura (el del candado de
`platform/writer-lock.ts`); no se abre ninguna segunda conexión de escritura.
Un fallo al guardar funding se reporta por `onResilience`
(`funding_ws_capture_failed`) y no para la captura de mercado.

## Tasa causal de un periodo

`FuturesMarketStore.fundingWsRate(productId, periodEndMs)` responde "tasa del
periodo que cierra en `periodEndMs`" usando solo filas con `received_at <
periodEndMs` (lo posterior no se lee, así que la respuesta es la misma en
cualquier T posterior). Existe solo si se cumple todo:

1. Cobertura: la última marca con `at < periodEndMs` es `alive` y tiene como
   mucho 90 s (`FUNDING_WS_COVERAGE_MAX_SILENCE_MS`, PROVISIONAL: 3 intervalos
   de `alive`). Si el WS estaba caído al cierre: `no_coverage`.
2. La última observación con `received_at < periodEndMs` es de la misma
   conexión que esa marca (`connection_mismatch` si no).
3. Esa observación anuncia este cierre: `next_funding_rate_time ==
   periodEndMs` (`period_mismatch` si no; falla cerrado).

Resultados no disponibles: `no_table`, `no_coverage`, `no_observation`,
`connection_mismatch`, `period_mismatch`. En todos, el respaldo es REST
(`funding_sightings` / `funding_periods`). Límite conocido: un cambio de tasa
en los últimos ≤ 90 s antes del cierre que no llegara por el socket no se ve;
la comparación con REST lo cuenta.

SQL equivalente (para `E` = fin del periodo en ms):

```sql
-- cobertura
SELECT at, connected_at, kind FROM paper_futures_funding_ws_marks
 WHERE product_id = 'PF_XBTUSD' AND at < :E ORDER BY at DESC, rowid DESC LIMIT 1;
-- tasa
SELECT funding_rate, relative_funding_rate, connected_at, next_funding_rate_time
  FROM paper_futures_funding_ws_observations
 WHERE product_id = 'PF_XBTUSD' AND received_at < :E
 ORDER BY received_at DESC, rowid DESC LIMIT 1;
```

Válida solo si la marca es `alive` con `:E - at <= 90000`, mismo
`connected_at`, y `next_funding_rate_time = :E`.

## Comparación con REST

`compareFundingWsWithSightings(productId, knownAtCutoff)` toma la última
sighting de cada periodo y la compara con la tasa WS por igualdad numérica
exacta. Devuelve `compared`, `matched`, `mismatched`, `onlyWs`, `onlyRest` y la
lista de discrepancias (`startMs`, `ws`, `rest`). No resuelve ni promedia
ninguna. Una discrepancia no es un error de captura per se: puede ser el
último movimiento de tasa antes del cierre; por eso se cuenta y se revisa.

## Cómo debe consumirlo el cargador de Python (pendiente, no se toca aquí)

`futures_funding_context.py` no se modifica en esta rama. Cuando se adapte:

- Abrir la base en solo lectura y comprobar con `sqlite_master` que existen las
  dos tablas (bases antiguas no las tienen: caer al comportamiento actual).
- Para el periodo H (fin `E`), aplicar las consultas de arriba con
  `received_at < E`; si hay cobertura y la observación anuncia `E`, la tasa de
  H está disponible desde `E` (no desde la siguiente consulta REST).
- Nunca leer `funding_rate_prediction` ni `relative_funding_rate_prediction`
  como tasa.
- Si no hay tasa WS, usar la sighting/REST como hasta ahora. Si hay ambas y
  difieren, no elegir en silencio: registrar la discrepancia y usar la REST
  como autoridad hasta que el recuento de discrepancias justifique otra cosa.
- La conciliación vale solo para BTC hasta que se amplíe la captura.

## Pendiente para los otros 7 productos

El colector WS está fijado a `PF_XBTUSD` (`marketSubscriptions`,
`FUTURES_PRODUCT`). Ampliar exige suscribir el ticker de cada producto,
llevar una clave de cambio y una marca `alive` por producto, y que
`FundingWsMark`/`FundingWsObservation` usen el `product_id` del mensaje. Las
tablas y las consultas ya llevan `product_id`.
