# Muestra parcial real de PF_XBTUSD para la Etapa 10 (18-oct-2026, UTC)

Datos públicos de Kraken Futures (PF_XBTUSD) leídos sin modificar de `futures-market.sqlite` (captura viva, solo lectura), después del cambio #264. No contiene nada privado, credenciales ni cuerpos crudos de funding. Mismas columnas y formato que la primera muestra (una fila JSON por línea).

## Tramo de velas

- Desde 2026-10-17T12:40:00.000Z (1792240800000 ms) hasta 2026-10-18T08:07:00.000Z (1792310820000 ms): 1168 velas de 1 minuto, una por minuto, consecutivas (la última revisión por `known_at`, desempate por `revision_hash`).
- Huecos reales de datos en el tramo de velas: ninguno.

## Tickers (WebSocket, feed `ticker`)

Tres ventanas cortas (~17 s) centradas en cortes reales del WebSocket, achicadas para respetar el tope:

- 2026-10-17T15:33:44.237Z a 2026-10-17T15:34:01.237Z (37 eventos; contiene el corte real del WebSocket que empieza a las 2026-10-17T15:33:50.237Z)
- 2026-10-17T21:52:49.475Z a 2026-10-17T21:53:06.475Z (34 eventos; contiene el corte real del WebSocket que empieza a las 2026-10-17T21:52:55.475Z)
- 2026-10-18T08:02:34.066Z a 2026-10-18T08:02:51.066Z (36 eventos; contiene el corte real del WebSocket que empieza a las 2026-10-18T08:02:40.066Z)

## Cotizaciones de todo el tramo

`paper_futures_xbt_quotes.csv.gz`: los 125589 tickers del WebSocket de PF_XBTUSD recibidos entre 2026-10-17T12:40:00Z y el fin de la última vela (2026-10-18T08:07Z), en orden de llegada, tal como los exportó Captura (136750 filas hasta 09:39Z; acá se cortan al final de las velas). Columnas: `epoch, seq, received_at, event_time, persisted_at, bid, ask` (bid y ask como cadenas, sin tocar). Se omiten `last`, `mark` y el `event_id`, que la sesión no lee; `real_world.py` arma el `event_id` como `ticker:PF_XBTUSD:<epoch>:<seq>`. Mayor hueco entre tickers: 3,723 s (2026-10-17T21:52:55Z). `real_world.py` los escribe en una base con forma de captura a la hora en que llegaron.

## Funding

Solo consultas (`polls`), períodos, avistamientos y respuestas (sin `raw_response`; con `raw_response_bytes` y `raw_response_sha256_check`) desde 2026-10-17T12:40:00.000Z. Los cuerpos crudos de ~1 MB no se incluyen.

## Archivos (filas; bytes; sha256)

- `paper_futures_funding_periods.jsonl`: 20 filas, 4857 bytes, sha256 `e925761f097c82eebfe70fbfc5105b976f4c26789da84bb6dbdb65e395d33415`
- `paper_futures_funding_polls.jsonl`: 39 filas, 26048 bytes, sha256 `ae0ae350baa2993831050185edb91e93729495379ac3716fcc38af4901fb60e0`
- `paper_futures_funding_responses.jsonl`: 20 filas, 5419 bytes, sha256 `eca60bacdff2081600113aa93a7f9887e61e67bd0461bf89527a76490e88b3f8`
- `paper_futures_funding_sightings.jsonl`: 78 filas, 20673 bytes, sha256 `3ce88b1b545a2df684b2e4ede884ec9e46c0179e4b3bd1a15e012b7446d094d6`
- `paper_futures_market_events.jsonl`: 107 filas, 384048 bytes, sha256 `cd740226ffd5872a1299ac191f7f388132d330489301cc25bec8f57762ad47fe`
- `paper_futures_official_candle_responses.jsonl`: 1168 filas, 735104 bytes, sha256 `0dca85ab29a7f642145ed4c0ff6f7d00a90295da9d302c5e04ad7f3482cf52f2`
- `paper_futures_official_candles.jsonl`: 1168 filas, 437804 bytes, sha256 `68779bd5de08edd5e33457dc9c2e86f4e3b66eaf0b605b4ec162be7b071ee153`
- `paper_futures_xbt_quotes.csv.gz`: 125589 filas, 1346772 bytes, sha256 `5668412ca64cbb824ee141dd59fd417cc4c48ba20967e5b073735fd621035b26`

Las horas `*_at`, `event_time`, `bucket_start`, `start_ms`, `end_ms` son milisegundos Unix UTC.
