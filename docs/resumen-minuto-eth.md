# Resumen por minuto de ETH

Una fila por minuto cerrado de `PF_ETHUSD`, guardada en `futures-market.sqlite`, tabla **`paper_futures_eth_minute_summary`**. Se calcula a partir de los eventos de mercado que la captura ya guarda (`paper_futures_market_events`), para conservar lo útil aunque después se recorten los eventos crudos (datos-utiles S4).

- Solo lee `paper_futures_market_events` y solo escribe su propia tabla: no cambia ninguna tabla, retención ni trigger.
- Código: `server/src/features/market-summary/eth-minute-summary.ts`; se engancha en `server/src/app/capture-main.ts` vía `eth-summary-wiring.ts` (arranca después de la captura y no corre mientras hay un respaldo en curso o la base está dañada; si falla, solo escribe una línea de log y la captura sigue).

## Cuándo se escribe

- Un minuto `[m, m+60 s)` se escribe cuando pasaron 5 s desde su fin (margen para eventos que se persisten tarde). El minuto abierto no se escribe.
- Revisa cada 30 s. Tras una caída recupera los minutos faltantes desde el último guardado (o desde el primer evento de ETH), de a 60 minutos por paso.
- Clave `minute_start_ms`: reiniciar no duplica ni reescribe filas (`INSERT OR IGNORE`).
- Un minuto sin ningún evento de ETH no genera fila (no se inventa).
- Los minutos se cortan por `received_at` (hora local de recepción).

## Columnas

Lo que los eventos no permiten calcular queda en `NULL`, nunca en 0.

| Columna                       | Contenido                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `minute_start_ms`             | Inicio del minuto (ms epoch), clave primaria.                                                       |
| `product_id`                  | Siempre `PF_ETHUSD`.                                                                                |
| `trade_count`                 | Cantidad de trades; `NULL` si no hubo eventos `trade`.                                              |
| `buy_volume` / `sell_volume`  | Cantidad (ETH) de trades compradores / vendedores (`side` del evento).                              |
| `vwap`                        | Precio medio ponderado por cantidad de los trades.                                                  |
| `last_price`                  | Último trade del minuto; sin trades, el último `last` de los tickers.                               |
| `spread_bp`                   | Promedio de `(ask-bid)/mid` en puntos básicos sobre los tickers del minuto.                         |
| `top_bid_size`/`top_ask_size` | Promedio del tamaño en el mejor bid / ask (de los tickers). Es solo tope del libro, no profundidad. |
| `depth_bid` / `depth_ask`     | Cantidad dentro de ±0,1 % del precio medio, promedio de las fotos completas del libro (`snapshot`). |
| `events_seen`                 | Eventos de ETH del minuto (cualquier feed), usables o no.                                           |
| `written_at_ms`               | Cuándo se escribió la fila.                                                                         |

## Qué captura la captura de ETH (datos-utiles S4, «opción 2»)

La captura abre un **segundo WebSocket** solo para `PF_ETHUSD` (`extraMarketFeed` en `live-capture.ts`). El de `PF_XBTUSD` queda exactamente como estaba (trades y ticker, sin libro).

| Dato de ETH             | Qué se guarda                                                                                                                                                                                                                                                                                                      | Cadencia                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Trades                  | **Todos**, uno por uno (`feed='trade'`, `uid` único). Fila «delgada»: el mensaje del proveedor entero queda en `raw_json`; no se copian en `normalized_json` el objeto `raw` ni la atestación de calidad del libro (≈ mitad de bytes por trade). El campo se llama `quantityBtc` aunque en ETH es cantidad de ETH. | cada trade                    |
| Libro                   | **Foto recortada**, no los deltas (serían ~80 millones de eventos por día): niveles a ±0,1 % del precio medio (la misma banda que usa el resumen; tope de 100 niveles por lado), marcada `sampled`, solo si el libro reconstruido es válido y fresco. Entra en `paper_futures_book_snapshots` también.             | como máximo **una cada 30 s** |
| Ticker                  | Sigue siendo el poll REST de 1 s (el ticker del WebSocket de ETH se descarta para no duplicarlo).                                                                                                                                                                                                                  | 1 por segundo (ya existía)    |
| Huecos del libro de ETH | `paper_futures_data_gaps` con `product_id='PF_ETHUSD'` (secuencia repetida/saltada, libro cruzado).                                                                                                                                                                                                                | cuando ocurre                 |

- Si guardar un evento de ETH falla, se escribe una línea de log (una por mensaje distinto) y el colector de ETH sigue; nunca toca BTC.
- La retención existente (`trimRawEvents`, `futures-market-prune.ts`) **no cambió** y alcanza a ETH: tickers 48 h; trades y libros 7 días; la copia duplicada del mensaje se recorta a las 48 h (hay un test que lo verifica con eventos de ETH).
- `futures_maker.py` (`tape_ranges`/`replay_trades`) lee trades de **cualquier** producto: ahora también verá los de ETH.

## Qué se llena

Con esto se llenan todas las columnas: trades → `trade_count`, `buy_volume`, `sell_volume`, `vwap`, `last_price`; tickers REST → `spread_bp`, `top_bid_size`, `top_ask_size` (y `last_price` si no hubo trades); fotos del libro → `depth_bid`, `depth_ask` (promedio de las fotos del minuto: con la cadencia de 30 s son 2 por minuto). Un minuto sin fotos o sin trades deja esas columnas en `NULL`.

## Tamaño (medido y estimado)

- **Resumen:** 1.440 filas completas por día ≈ 170 KB por día (~60 MB por año).
- **Libro de ETH:** medido con un libro real (consulta pública única a Kraken: 21 niveles de compra y 22 de venta dentro de ±0,1 %; el libro entero tiene ~1.100 niveles): una foto ocupa **≈ 6,5 KB** guardada (evento + copia en `book_snapshots` + índices). A una cada 30 s son **2.880 fotos ≈ 19 MB por día**, ~130 MB con la retención de 7 días. A una cada 10 s serían ~56 MB por día.
- **Trades de ETH:** medido en una base temporal: **≈ 1,2 KB por trade** recién guardado en la fila delgada (≈ 2,2 KB si se guardara como los de BTC). El ritmo no se pudo medir en la base viva (no se consulta); una muestra pública de 20 s dio **≈ 5 trades por segundo** (BTC: ≈ 4,5 en la misma ventana), o sea del orden de **300.000 a 430.000 trades por día ≈ 360 a 520 MB por día**, y **2,5 a 3,6 GB** con 7 días de retención. Es una muestra de 20 s: el promedio diario puede ser distinto; conviene mirar el crecimiento real de `futures-market.sqlite` los primeros días.
- **CPU:** el colector de ETH procesa un delta del libro en ≈ 4 µs (medido con 300.000 deltas sintéticos); a ~900 por segundo es ≈ 0,4 % de un núcleo. Reconstruir y recortar la foto cada 30 s cuesta ≈ 0,3 ms.
