# Fila de confirmación del funding en la captura (Issue #184): diseño

Estado: **solo diseño. No hay código ni cambio en la captura viva ni en su base.** Para escribir el código hace falta antes una autorización escrita de Fran para tocar la captura (ver «Qué falta»). Este documento no autoriza ninguna lectura, sesión ni cambio.

## Problema (medido)

La lectura de solo lectura de BAL-DECISION-184-02 (`funding-184.json`, SHA-256 `f1a91c8a28b2220245f06b4b337481c22af52e725ac5e8e03d9a00f0b0fc0558`, HEAD `22b7abe`) dejó la parte de tiempos de #184 sin poder medirse:

- Desde el 11-oct 10:00Z solo hay filas **provisionales** (11 a 12 horas por producto en la ventana de 48 h). Las horas definitivas llegaron mucho después del fin del período (mediana ≈ 16,8 h).
- Publicación medible a tiempo: **1 de 73 períodos**. La regla de 10 minutos, el plazo y «primero visto gana» no se pueden juzgar.

Causa en el código (lectura, no medición): `FuturesMarketStore.appendNewFundingKnowledge` guarda una respuesta solo si trae un par (inicio, tasa) que no estaba. La confirmación posterior de un período ya conocido, con la misma tasa, no escribe nada. Además `live-capture.ts` consulta el funding 30 s después de cada hora y reintenta cada minuto hasta 10 veces mientras la hora nueva no aparezca; después no vuelve a consultar hasta la hora siguiente, así que casi nunca hay una consulta pasados los 10 minutos del cierre.

## Diseño

1. **Tabla aditiva `paper_futures_funding_confirmations`** (`STRICT`, solo se agrega; con triggers que prohíben `UPDATE` y `DELETE`, como el resto de la evidencia de funding):
   `product_id`, `start_ms`, `funding_rate`, `stage` (`just_closed` o `after_lag`), `end_ms`, `received_at`, `server_time`, `response_sha256`. Clave primaria `(product_id, start_ms, funding_rate, stage)`: queda la **primera** vista por período, tasa y etapa; si la tasa cambia, aparece una fila nueva (evidencia de conflicto, igual que en `paper_futures_funding_periods`).
2. **Qué se escribe.** Después de `appendNewFundingKnowledge`, para cada producto, un método nuevo `recordFundingConfirmations(response, productId)` guarda una fila por cada período que ya terminó (`end_ms <= received_at`) y que terminó hasta 6 h antes de la respuesta. Etapa `just_closed` si la respuesta llegó dentro de 10 min del fin, `after_lag` si llegó después. El período abierto no se guarda (ya lo cubre la primera vista). El método **no decide** cuándo un período es definitivo: guarda `received_at` y el `server_time` de la propia respuesta; la regla la aplican los lectores.
3. **No se guarda el cuerpo de la respuesta.** Pesa ≈ 1 MiB cada una (26,6 MB las 26 leídas), por 8 productos y por hora. El hash solo identifica la respuesta; la fila ocupa unas decenas de bytes. Con 8 productos, ≤ 7 períodos nuevos por consulta y 2 etapas, son pocas decenas de filas por hora.
4. **Una consulta más por hora.** Pasados 11 minutos de cada hora (`SETTLE_POLL_OFFSET_MS`), una consulta de funding por producto, además de las actuales. Hoy son 8 consultas por hora más los reintentos; esto agrega 8. Se calcula con una función pura (`fundingPollDelayMs`) que reemplaza la lógica en línea de `scheduleFundingPoll`; con `fundingPollMs` fijo (pruebas) todo queda como está.
5. **Sin cambiar la versión del esquema.** `CREATE TABLE IF NOT EXISTS`, sin migración numerada: los lectores de solo lectura que hoy aceptan versiones 3 a 7 no se rompen. El esquema congelado `python/tests/real_futures_schema.sql` se regenera (la prueba `futures-schema-fixture` lo exige).
6. **Lectura.** `fundingConfirmations(productId, knownAtCutoff)` devuelve las filas con `received_at <= corte`, y `[]` si la tabla no existe (base vieja). Los lectores de Python (adaptador y validador) se actualizan **después**, en otra PR, para usar estas filas; este cambio por sí solo no modifica ninguna medición ni la contabilidad.

## Qué no cambia

Las tablas y filas existentes (`paper_futures_funding_responses`, `paper_futures_funding_periods`), la regla «primero visto gana» del almacén, las señales, el forward, la cartera, el ADR, los umbrales y las reglas de producto. No se agrega ninguna llamada fuera de la API pública de funding que ya se usa.

## Riesgos

- Toca el escritor y el esquema de la base viva (≈ 7 GB, en uso) la primera vez que arranque el código nuevo: la tabla se crea al abrir la base. Es aditiva y vacía, pero es una escritura sobre una base activa, por eso va con autorización explícita y un arranque controlado.
- Una consulta más por hora por producto: dentro de lo que ya se hace, sin cambiar el límite de tasa.
- Las filas nuevas no se leen todavía: sin la segunda PR (adaptador y validador) no mejoran ninguna medición. No hay efecto en la contabilidad ni en la sesión.
- Si la consulta de los 11 minutos falla, la etapa `after_lag` no se escribe ese período; queda `just_closed` (si hubo) y la ausencia se ve. Nada se completa a mano.

## Plan de pruebas (sin tocar ninguna base real)

- Almacén: `recordFundingConfirmations` escribe una fila por período, tasa y etapa; no repite; no escribe periodos abiertos ni anteriores a 6 h; guarda el `serverTime` crudo (incluida la forma de 2 decimales); `UPDATE` y `DELETE` fallan; sobre una base de solo lectura lanza error; sobre una base vieja sin la tabla la crea y `fundingConfirmations` devuelve `[]` antes de eso.
- Esquema: la prueba `futures-schema-fixture` con el SQL regenerado; la versión de esquema sigue siendo 7.
- Consultas: `fundingPollDelayMs` con relojes inventados (después de la hora, con la hora nueva listada o no, a los 11 minutos, ya pasada la ventana), y una prueba de `createLiveCapture` con `clock` y consultas falsas que muestra una fila `after_lag`.
- Python: las pruebas que planean sentencias contra el esquema congelado siguen pasando.

## Qué falta

1. **Autorización escrita de Fran para modificar el código de la captura** (`futures-market-store.ts` y `live-capture.ts`) y, más adelante, para arrancarla con el cambio. Las instrucciones del proyecto prohíben tocar la captura viva y los colectores sin ella.
2. Con esa autorización: PR del código y las pruebas, GO de D sobre el HEAD exacto, CI 15/15 y merge por BAL-DECISION-182-01. El arranque con el cambio es un paso aparte.
3. Segunda PR: el adaptador y el validador leen las confirmaciones; recién entonces se puede volver a medir la publicación.
