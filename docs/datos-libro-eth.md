# Libro de ETH cada 10 s

Operación-mejoras S1 (`odd/tasks/operacion-mejoras.md`, T1). La captura guarda una foto del libro de órdenes de `PF_ETHUSD` **cada 10 s** (antes cada 30 s). Mismo rango (±0,1 % del precio medio, tope de 100 niveles por lado), mismo formato (foto recortada, `sampled`, sin deltas). BTC y el resto de los productos no cambian: BTC no se suscribe al libro y los demás no capturan eventos de mercado.

## Por qué

Un tercio de las patas de la sombra maker terminaban `sin_datos`: la sombra necesita una foto como máximo 20 s antes de la pata oficial y, con fotos cada 30 s, a veces no había (`odd/tasks/maker-sombra.md`). Con 10 s, con el libro sano, cada pata tiene una foto dentro de esa ventana (no se midió todavía la tasa de `sin_datos` con la nueva cadencia).

## Configuración

| Variable                     | Valor por defecto | Efecto                                                                                                                                                       |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FUTURES_ETH_BOOK_SAMPLE_MS` | `10000`           | Milisegundos mínimos entre dos fotos de ETH. Vacío, no numérico o menor que `1000` (el reloj del muestreador) = 10 s. `30000` restaura la cadencia anterior. |

Código: `server/src/features/kraken-futures/capture-book-sample.ts` (la usa `server/src/app/capture-main.ts`). La captura lee la variable al arrancar: cambiarla pide reiniciar el proceso de captura.

Una foto no se guarda si el libro reconstruido no es válido o lleva más de 10 s sin moverse (igual que antes); en ese caso el hueco es del libro, no de la cadencia.

## Costo de disco (medido)

Medido con las 2.000 fotos de ETH más recientes de `server/data/dev-live/futures-market.sqlite` (lectura solamente; copiadas a una base temporal con el mismo esquema e índices; 21 niveles de compra y 21 de venta por foto, 2026-11-09). Bytes por foto, sumando el evento (`paper_futures_market_events`), su copia (`paper_futures_book_snapshots`) y los tres índices:

| Parte                                                                      | Bytes por foto |
| -------------------------------------------------------------------------- | -------------- |
| Evento: `normalized_json` (1.973) + `raw_json` (69) + id y hash + columnas | ≈ 2.260        |
| Copia en `book_snapshots` (`bids_json` + `asks_json` + columnas)           | ≈ 1.760        |
| Índices (clave de cada tabla y `received`)                                 | ≈ 220          |
| **Carga útil total**                                                       | **≈ 4,2 KB**   |
| Con las páginas de 4 KB enteras (cada fila no comparte página con otra)    | ≈ 6,6 KB       |

Las dos cifras son los extremos: en la base real las filas de ticker y trade (chicas) comparten páginas con las fotos, así que el costo real está cerca de 4,2 KB; 6,6 KB es el tope (coincide con los ≈ 6,5 KB de `docs/resumen-minuto-eth.md`).

| Cadencia | Fotos por día | Carga útil (4,2 KB) | Tope (6,6 KB) | 7 días de retención |
| -------- | ------------- | ------------------- | ------------- | ------------------- |
| 30 s     | 2.880         | ≈ 12 MB             | ≈ 19 MB       | ≈ 85–133 MB         |
| **10 s** | **8.640**     | **≈ 37 MB**         | **≈ 57 MB**   | **≈ 260–400 MB**    |
| Aumento  | +5.760        | **+25 MB**          | **+38 MB**    | +175–270 MB         |

Son cotas superiores: la foto solo se guarda con el libro válido y fresco (en la base local hubo 5.137 fotos en ~3 días, menos que las 8.640 diarias de una captura sin cortes). Sin impacto en CPU apreciable: reconstruir y recortar la foto cuesta ≈ 0,3 ms (`docs/resumen-minuto-eth.md`), ahora 8.640 veces por día.

## Retención y Parquet

- **Retención en SQLite:** las fotos son eventos `feed='book'`; duran 7 días (`FUTURES_EVENT_RETENTION_DAYS`, `capture-savings.ts`), sin cambios. Se borran en lotes pequeños (`docs/retencion-sin-bloqueo.md`): el triple de fotos por día es el triple de filas de libro que borra la retención (+5.760 por día), junto a los trades y tickers de ETH, que son más numerosos.
- **Parquet nocturno (`python/archivo_parquet`):** los eventos de libro se archivan con `market_events` (la tabla se exporta entera por día, agrupada por producto, zstd nivel 9, filtro típico por `feed`); `paper_futures_book_snapshots` está en la lista de exclusión como copia derivada de `market_events` (`nocturno.TABLAS_EXCLUIDAS`). No hay ninguna suposición de tamaño por día ni por feed en `config.py`, `nocturno.py` ni `docs/archivo-parquet.md`, así que **no hace falta tocar `python/archivo_parquet`**. No se midió el tamaño del Parquet de las fotos; la copia diaria de SQLite sube lo medido arriba.
- **Resumen por minuto:** `depth_bid` y `depth_ask` son el promedio de las fotos del minuto: pasan de 2 a 6 fotos por minuto; `events_seen` cuenta las 6.
