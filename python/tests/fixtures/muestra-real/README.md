# Muestra real de la captura de Balancita (17-oct-2026, hora UTC)

Lectura real y sin modificar de `futures-market.sqlite` (captura viva, abierta en solo lectura), tomada DESPUÉS del cambio #264 (hijo de captura pid 76139, arrancó 2026-10-17T12:39Z). Cada archivo `.jsonl` es una tabla: una fila por línea, todas las columnas con su nombre original, los textos JSON (`raw_json`, `normalized_json`, `raw_response`) tal cual están guardados (no se reinterpretó nada). Productos: PF_XBTUSD (ticker por WebSocket) y PF_ADAUSD (ticker REST; tiene velas planas con volumen 0 y poca liquidez).

## Tramos

- Tickers (`paper_futures_market_events`, feed `ticker`): se achicó la ventana para respetar el tope de 400 KB. XBT: received_at 13:58:00Z a 13:58:30Z (54 eventos; contiene el hueco real de 2,088 s que empieza a las 13:58:11,626Z). ADA: 13:56:30Z a 13:57:30Z (53 eventos; contiene el hueco real de 3,575 s que empieza a las 13:57:10,651Z). Los tickers del WebSocket de XBT pesan unos 5 KB por evento por el bloque `marketQuality`.
- Velas oficiales 1m (`paper_futures_official_candles` y `paper_futures_official_candle_responses`): buckets de 13:40Z a 14:09Z de ambos productos, todas las revisiones guardadas (hay una por vela: ninguna cambió) y las respuestas crudas que las originaron (referenciadas por `response_sha256`; `sha256` de la respuesta es la clave).
- Funding: última respuesta cruda guardada de cada producto (la de la consulta `hourly` de 2026-10-17T17:00:30Z aprox., las posteriores no guardaron respuesta nueva), con sus consultas (`paper_futures_funding_polls`), períodos (`paper_futures_funding_periods`) y avistamientos (`paper_futures_funding_sightings`). `paper_futures_funding_responses.jsonl` va SIN la columna `raw_response` porque cada cuerpo pesa ~1 MB (historial completo); en su lugar lleva `raw_response_bytes` y `raw_response_sha256_check` (sha256 del cuerpo). Los cuerpos no están en este repositorio.

## Tablas y archivos (filas; bytes; sha256)

- `paper_futures_funding_periods.jsonl`: (2 filas, 491 bytes); sha256 `ea67de8240a7c729cf47efcd619387e559f5d49ab77ac1107c80aa19a0541a4b`
- `paper_futures_funding_polls.jsonl`: (2 filas, 1340 bytes); sha256 `ae44a57d89627ade6b44c7e1e69361330cd8a9572628026b90b7f36b4f5d78e0`
- `paper_futures_funding_responses.jsonl`: (2 filas, 542 bytes); sha256 `4ca850bf2e8c524de65320151ab983b7d596a853a75d36f975202f229faf7e45`
- `paper_futures_funding_sightings.jsonl`: (4 filas, 1067 bytes); sha256 `2ad87ff7531c5408cf761b7d5467d2339f933022fad2b8746611fb77c2f6d527`
- `paper_futures_market_events.jsonl`: (107 filas, 271599 bytes); sha256 `bc73a3f055f48f7b8df1fc1fac8827380b52647e2a3456a3e2253d09b1a1ec2f`
- `paper_futures_official_candle_responses.jsonl`: (60 filas, 38180 bytes); sha256 `ec6ef45c917c8a11c0a202b01713d2cc6695dd7f10ad0707d94ecd6c1af33160`
- `paper_futures_official_candles.jsonl`: (60 filas, 22649 bytes); sha256 `cd1a4e2f2b97b5a5c8aa771dbd1e96f17cb2be61b51d3c110a434aa9fa580629`

## Columnas (iguales a las de la base)

- paper_futures_market_events: event_id, feed, product_id, epoch, seq, event_time, received_at, persisted_at, uid, raw_json, normalized_json, content_hash. Los REST traen `server_time` y `last_time` dentro de `raw_json`; XBT trae `time`.
- paper_futures_official_candles: product_id, interval_ms, bucket_start, revision_hash, known_at, open_price, high_price, low_price, close_price, volume_btc, response_sha256.
- paper_futures_official_candle_responses: product_id, sha256, interval_ms, from_ms, to_ms, received_at, raw_response.
- paper_futures_funding_polls: product_id, started_at, purpose, scheduled_at, finished_at, outcome, http_status, detail, response_sha256, extract_text, extract_sha256, extract_periods.
- paper_futures_funding_responses: sha256, received_at, server_time (+ raw_response_bytes, raw_response_sha256_check; sin raw_response).
- paper_futures_funding_periods: response_sha256, start_ms, end_ms, funding_rate, known_at, unit, product_id.
- paper_futures_funding_sightings: product_id, start_ms, received_at, funding_rate, end_ms, server_time, response_sha256.

Las horas `*_at`, `event_time`, `bucket_start`, `start_ms`, `end_ms` son milisegundos Unix UTC. El 17-oct 00:00:00Z = 1792195200000.

Los cuerpos crudos de funding (~1 MB cada uno) no están en este repositorio.
Origen: copia verificada por sha256 del paquete armado en la Mac de Fran; sin tocar la captura viva.
