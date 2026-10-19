# Movimientos de Qwen y Kronos (API)

Solo lectura. Gateway en vivo: `GET /api/movements` (por Vite: `/api-live/movements`). Abre las bases de cada modelo en modo lectura; no escribe nada.

## De dónde sale cada uno (ninguno pasa por el proceso D)

- **Qwen** = C31 (`futures_qwen_exit.py`): abre posiciones con las especificaciones de `config/qwen-exit.json` y Qwen decide cada cierre. Base propia `qwen-exit.sqlite` (`qwen_exit_trade`, `qwen_exit_open`, `qwen_exit_decision`). Las decisiones de Q (comprar/mantener/vender) siguen en `/api/qwen/scores` y no abren posiciones en el paper de D.
- **Kronos** (`kronos_lab`): opera si su pronóstico a 4 h supera el doble del costo; sale a las 4 h. Base propia `kronos.sqlite` (`decision`, `trade`). Los pronósticos que no operan solo se cuentan (`forecasts_without_trade`).

La ruta de las bases sale de `QWEN_EXIT_SUMMARY_PATH` / `KRONOS_SUMMARY_PATH` (misma carpeta) o `QWEN_EXIT_DB_PATH` / `KRONOS_DB_PATH`.

## Parámetros

`source=qwen|kronos` (por defecto qwen), `product=PF_XXX`, `status=open|closed`, `from`/`to` (ms epoch o `AAAA-MM-DD`, sobre la hora de apertura), `limit` (1-200, 50), `offset`. Más nuevo primero. Parámetro inválido: 400 `{status:"error", reason}`.

## Respuesta

`summary` por fuente (operaciones, abiertas, cerradas, aciertos, `hit_rate`, `net_usd`, `forecasts_without_trade`; respeta producto y fechas, no el estado), `page {limit, offset, total}`, `items[]`, `sources` (`ok|off`) y `reasons`. Cada item: hora de apertura/cierre, producto, `side` LONG/SHORT, precios de entrada/salida (null mientras está abierta), tamaño, `fees_usd` (derivadas de la tasa taker congelada), `funding_usd` y `funding_status` (Kronos: `not_charged`), `net_usd`, `net_pct` (sobre 100 USD), `open_reason`, `close_reason`, `decision` (Qwen: respuesta y probabilidad) o `forecast` (Kronos: pb esperados y umbral). Una abierta se valora al último cierre de vela.
