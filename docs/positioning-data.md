# Posicionamiento y prima de Kraken

Colector separado (`pnpm --dir server positioning:collect`, en `pnpm dev` como `positioning`; añadirlo a `DEV_ONLY` si se usa). Base propia `server/data/dev-live/positioning.sqlite`, un solo escritor (lock), solo endpoints públicos de gráficos de Kraken Futures.

- `positioning`: por hora y producto (los 8 fijados), desde 2024-01: % de cuentas largas y del 20 % más grande, recuentos y open interest del top.
- `premium`: (mark − spot)/spot en puntos básicos. Por hora desde 2022-03; por minuto solo los últimos 7 días. Los primeros meses de 2022 traen valores extremos (índice spot inestable): no usarlos sin filtrar.
- Solo se guardan buckets cerrados. Primera pasada: baja el historial (~2 min por producto); después una pasada por minuto, que no pide nada si no hay bucket nuevo.
- Terminal: paneles "Long/short" (ya existía, ahora con historial y los 8 productos) y "Prima perpetuo-contado (pb)". No cambian la escala de las velas.
- Estrategias: `python/balancita_engine/positioning_data.py` (`load_positioning`, `load_premium`, `as_of`). Un bucket es usable solo desde su cierre. El holdout (desde 2026-04-19) no se toca: quien lo use debe cortar por fecha.
- Qwen en vivo no cambia.

## Fichas de indicadores (`config/indicators.json`)

El colector baja y guarda solo lo que declara una ficha activa; no hay descarga "por si acaso".

- Una ficha dice: serie (`positioning` o `premium`), productos (`pinned` o lista), resolución (`1h` o `1m`), historia (`history_from` para 1h, `keep_days` para 1m) y quién la usa (`chart`, `strategy` o `qwen`). Una ficha activa sin usuarios es inválida y el colector no arranca.
- Si dos fichas piden la misma serie, se descarga una vez, con la historia más larga.
- Archivar: `state: "archived"` con `archived_since`. Deja de actualizarse; a los `purge_after_days` (14) se borran sus datos, salvo que otra ficha activa los necesite.
- Alta de un indicador nuevo = ficha nueva (PR). Pedir una historia más larga que la ya bajada no rellena hacia atrás: se borra la serie y se vuelve a bajar.
- La Terminal muestra un panel solo si tiene datos. En Estrategias, `positioning_data.is_available(...)` dice si una ficha activa cubre la serie y el producto.
