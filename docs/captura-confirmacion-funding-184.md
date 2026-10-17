# Registro de avistamientos y de intentos del funding en la captura (Issue #184)

Estado: diseño y código en la PR de implementación; el diseño llegó antes en la PR #258. Probado solo con datos inventados. **Crear las tablas en la base viva ocurre únicamente al arrancar la captura con este código, paso aparte con orden propia.** Este documento no autoriza ninguna sesión, orden ni consulta fuera de la API pública de funding que ya se usa.

## Problema (medido)

La lectura de solo lectura de BAL-DECISION-184-02 (`funding-184.json`, SHA-256 `f1a91c8a28b2220245f06b4b337481c22af52e725ac5e8e03d9a00f0b0fc0558`, HEAD `22b7abe`) dejó la parte de tiempos de #184 sin poder medirse:

- En ETH, desde el 11-oct 10:00Z solo hay filas **provisionales** (12 horas solo provisionales y 2 solo de respuestas rechazadas: 14 sin cubrir); en XBT la máscara de cobertura son las horas 0 a 33 más la 45. Las horas definitivas llegaron mucho después del fin del período (mediana ≈ 16,8 h).
- Publicación medible a tiempo: **4 de 73 períodos** (2 por producto, todos a tiempo; en ambos productos es la hora 33, con primera definitiva a ≈50,8 min).

Causa en el código (lectura, no medición): `FuturesMarketStore.appendNewFundingKnowledge` guarda una respuesta solo si trae un par (inicio, tasa) que no estaba. La confirmación posterior de un período ya conocido, con la misma tasa, no escribe nada. Además la captura consulta el funding 30 s después de cada hora y reintenta cada minuto hasta 10 veces mientras la hora nueva no aparezca; después no vuelve a consultar hasta la hora siguiente.

## Qué mide y qué no

**Kraken no envía ninguna señal de «definitivo».** En el adaptador (`funding_adapter.py`) «definitivo» es una regla propia: `fin + settle_lag_ms <= server_time`. Medir la publicación con esa regla sería circular («dentro del plazo» saldría sostenida por construcción y «no antes de 10 min» no podría fallar). Por eso este cambio **no promete medir cuándo Kraken da un período por definitivo**.

Lo que sí permite medir, comparando tasas entre avistamientos y sin reutilizar la regla del adaptador:

- si la tasa de un período **cambia** entre su primera vista (abierta o recién cerrada) y las vistas posteriores (+30 s, +11 min, +60,5 min, +71 min);
- si el período **aparece listado** dentro del plazo y a qué distancia de su fin;
- cuántos intentos hubo, cuántos fallaron y cómo, para que la ausencia de un avistamiento se pueda leer: «falló» (fila con error), «no se consultó» (no hay fila) o «el proceso no corría» (no hay filas de ningún producto).

El lector que use estas tablas (segunda PR, aparte) tiene que comparar tasas entre avistamientos; no puede reutilizar `final_starts`.

## Diseño

Dos tablas aditivas (`STRICT`, solo `INSERT`, triggers contra `UPDATE` y `DELETE`):

1. **`paper_futures_funding_sightings`**: una fila por `(product_id, start_ms, received_at)` con `funding_rate` (texto exacto), `end_ms`, `server_time` (crudo, como llegó) y `response_sha256`. Se escribe por cada período **cerrado hasta 2 horas antes** de la respuesta (≈ 2 períodos por consulta). No se guarda un «estado» ni una etapa: no hay columna de conteo ni de última vista (obligarían a `UPDATE`). Dos avistamientos de la misma tasa con otro hash son dos filas; un cambio de tasa aparece solo, como dos filas con tasas distintas. La ventana de 2 h cubre el plazo del validador (fin + 10 min + 60 min = 70 min).
2. **`paper_futures_funding_polls`**: una fila por intento `(product_id, started_at, purpose)`, éxito o no, **sin cuerpo**: `purpose` (`startup`, `hourly`, `retry`, `settle`), `scheduled_at`, `finished_at`, `outcome` (`ok`, `http_error`, `timeout`, `parse_error`, `network_error`, `aborted`), `http_status`, `detail` (≤ 200 caracteres), `response_sha256` (nulo si no hubo respuesta). Las 8 consultas son seriales: `started_at` de cada una dice cuándo se consultó ese producto.

**Una consulta más por hora.** Además de las actuales (hora + 30 s y reintentos), una **consulta de asentamiento a +11 min** por producto. Una función pura (`fundingPollDelayMs`) decide el próximo momento y su `purpose`; con `fundingPollMs` fijo (pruebas) los tiempos no cambian. La consulta de la hora siguiente (+60,5 min) ya ve el período cerrado: con el registro, cada período queda con avistamientos a +30 s, +11 min, +60,5 min y +71 min.

**Capa cruda.** Las filas son una transformación de una respuesta cuyo cuerpo casi nunca se guarda (`appendNewFundingKnowledge` guarda la respuesta solo si trae un par nuevo): el `response_sha256` identifica la respuesta, pero apunta a un cuerpo que no está en la base. Para que la fila se pueda volver a verificar, cada intento con respuesta guarda un **extracto literal** (`extract_text`: el `serverTime` crudo y el texto literal de los objetos de período de la ventana, tal como llegaron) con su propio SHA-256 (`extract_sha256`). Son pocos cientos de bytes. El cuerpo completo (~1 MiB) sigue sin guardarse; es un apartamiento declarado del criterio de capa cruda (CAPA-CRUDA-07/08) y queda a aceptación del revisor.

**Sin número de migración.** El almacén registra sus tablas en `paper_futures_market_migrations` (1 a 7). Estas dos se crean con `CREATE TABLE IF NOT EXISTS` **sin** número nuevo, como excepción declarada: así los lectores de solo lectura que hoy aceptan las versiones 3 a 7 no se rompen. Los lectores detectan las tablas en `sqlite_master`; `fundingSightings` devuelve `null` si la tabla no existe (base vieja) y `[]` si existe y está vacía.

**Tamaño.** Con 8 productos y ≈ 3 consultas por hora, unas decenas de filas por hora de avistamientos y 24 a 48 de intentos (más el extracto); del orden de decenas de MB por año.

## Qué no cambia

Las tablas y filas existentes (`paper_futures_funding_responses`, `paper_futures_funding_periods`), la regla «primero visto gana» del almacén, las señales, el forward, la cartera, el ADR, los umbrales y las reglas de producto. La escritura de las tablas nuevas nunca bloquea la captura: si falla, se registra en el log y la consulta sigue. No se agrega ninguna llamada fuera de la API pública de funding que ya se usa; el límite de tasa no cambia de orden (8 consultas más por hora).

## Riesgos

- La primera vez que arranque el código nuevo sobre la base viva (≈ 7 GB, en uso) se crean las dos tablas: aditivas y vacías, pero es una escritura sobre una base activa. Está autorizada por Fran (BAL-CONSTANCIA-184-AUT-01) y se hace como paso aparte con orden propia; la base no se borra ni se reescribe.
- Sin la segunda PR (lectores) las filas nuevas no mejoran ninguna medición ni tocan la contabilidad.
- Si una consulta falla, el intento queda registrado con su error; nada se completa a mano.

## Pruebas (todas con datos inventados, ninguna base real)

- Avistamientos: ventana de 2 h, período abierto excluido, mismas tasa y hora no se repiten, misma tasa con otro hash son dos filas, cambio de tasa son dos filas, `serverTime` crudo (incluida la forma de 2 decimales), extracto literal con su hash.
- Intentos: un intento fallido deja una fila sin hash; sin captura no hay filas.
- Inmutabilidad: `UPDATE` y `DELETE` fallan; una base de solo lectura rechaza escribir; tabla ausente (`null`) distinta de vacía (`[]`); la versión de esquema sigue siendo 7 y las tablas existentes no se tocan.
- Calendario: `fundingPollDelayMs` con relojes inventados (reintento, asentamiento a +11 min, hora siguiente) y clasificación de errores; `createLiveCapture` con consultas falsas.
- Esquema: la prueba `futures-schema-fixture` con `python/tests/real_futures_schema.sql` regenerado; pruebas Python de lectura sobre ese esquema.

## Qué falta

1. Orden aparte para correr la captura con el cambio (autorizada por Fran; no hay que detener `pnpm dev` si solo se reinicia la captura, a confirmar en la orden).
2. Segunda PR: lectores (adaptador y validador) que comparan tasas entre avistamientos.
