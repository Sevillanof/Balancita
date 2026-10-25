# Posicionamiento y prima de Kraken

Colector separado (`pnpm --dir server positioning:collect`, en `pnpm dev` como `positioning`; añadirlo a `DEV_ONLY` si se usa). Base propia `server/data/dev-live/positioning.sqlite`, un solo escritor (lock), solo endpoints públicos de gráficos de Kraken Futures.

- `positioning`: por hora y producto (los 8 fijados), desde 2024-01: % de cuentas largas y del 20 % más grande, recuentos y open interest del top.
- `premium`: (mark − spot)/spot en puntos básicos. Por hora desde 2022-03; por minuto solo los últimos 7 días. Los primeros meses de 2022 traen valores extremos (índice spot inestable): no usarlos sin filtrar.
- Solo se guardan buckets cerrados. Primera pasada: baja el historial (~2 min por producto); después una pasada por minuto, que no pide nada si no hay bucket nuevo.
- Terminal: paneles "Long/short" (ya existía, ahora con historial y los 8 productos) y "Prima perpetuo-contado (pb)". No cambian la escala de las velas.
- Estrategias: `python/balancita_engine/positioning_data.py` (`load_positioning`, `load_premium`, `as_of`). Un bucket es usable solo desde su cierre. El holdout (desde 2026-04-19) no se toca: quien lo use debe cortar por fecha.
- Qwen en vivo no cambia.
