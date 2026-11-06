# datos-utiles

Guardar y archivar lo que sirve para mejorar al maestro y al portero, y dejar de capturar lo que no sirve, sin perder nada en el camino.
Continúa `odd/tasks/parquet-respaldo-completo.md` (T4 de esa feature queda absorbida acá).

## Specs

- **S1** — El Parquet nocturno archiva la base del trader `qwen-live`: `live` (decisiones con el veredicto de cada experto, operaciones, recibos de ejecución, acciones por noticias, versiones de configuración) y `auditor` (`miradas`), con la misma verificación de ida y vuelta que el resto.
- **S2** — El Parquet archiva también, de `futures-market`: velas oficiales de ETH y BTC, `funding_periods` y `analytics_points`; posicionamiento, prima y noticias siguen archivados.
- **S3** — Todas las demás tablas y bases quedan en una lista explícita de exclusión con su motivo, de modo que `nocturno` sale con código 0 solo cuando lo útil está completo.
- **S4** — Se empieza a guardar un resumen por minuto de ETH derivado de los eventos de mercado (volumen comprador/vendedor, cantidad de trades, spread y profundidad), antes de recortar ningún dato crudo.
- **S5** — Dejar de capturar eventos de mercado de los productos que no se operan (todo menos ETH), después de archivarlos una vez en Parquet. _Riesgo alto (datos): requiere OK explícito del usuario al ejecutarlo._
- **S6** — Dejar de guardar el cuerpo crudo de cada respuesta de funding (queda el dato interpretado y su hash), después de archivarlo. _Riesgo alto: OK explícito._
- **S7** — Apagar la captura del motor viejo D (`verdicts`, decisiones LLM viejas, puntaje de pronósticos) después de archivarla una vez. _Riesgo alto: OK explícito._

## Tasks

| ID  | Specs  | Ruta                                                                         | Estado                     | Commit                     |
| --- | ------ | ---------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| T1  | S1, S3 | `python/archivo_parquet/config.py` (+ `nocturno.BASES`, exclusiones) + tests | pendiente                  | — (lo commitea el usuario) |
| T2  | S2, S3 | `python/archivo_parquet/config.py` + tests                                   | pendiente                  | —                          |
| T3  | S4     | captura de mercado (TS) + tabla nueva + tests                                | pendiente                  | —                          |
| T4  | S5     | captura de mercado                                                           | pendiente (OK del usuario) | —                          |
| T5  | S6     | funding                                                                      | pendiente (OK del usuario) | —                          |
| T6  | S7     | `scripts/dev-provider-env.mjs` hijos de D                                    | pendiente (OK del usuario) | —                          |

## Log

- **L1** (usuario, 2026-11-05): «Que decis? Si qwen live no lo usamos mas. Ahora qwen solo se usa para catalogar las noticias y dar un resumen. Ahora usamos la formula de maestro, portero y el ciclo de vida de la entrada y salida de operaciones. Eso es lo importante, las velas, veredictos de cada experto, decisiones, operaciones con todos sus datos que nos sirvan para mejorar al maestro y al portero.»
- **L2** (usuario): «Algo de esos datos que tenemos, puede ayudar al maestro y al portero a mejorar en un futuro? O son datos inservibles?» → respuesta: microestructura de ETH resumida por minuto y analíticas sirven; cuerpos crudos de funding, revisiones de velas, `verdicts` de D y eventos de los otros 7 productos no. No tirar nada sin archivarlo antes.
- **L3** (usuario): «Me parece bien».
- **L4** (evidencia): el maestro lee velas de ETH y BTC por API a su cache (`qwen-live_cache`), prima y sesgo long/short de `positioning.sqlite` y funding por API; el entrenamiento del portero lee `funding_periods` de `futures-market`. El trader no lee `market_events` (5,0 GB en VPS) ni `verdicts` (2,2 GB). `funding_responses` 1,2 GB. Por confirmar: si el tramo vivo del gráfico sale de los eventos de ETH.
- **L5** (pendiente aparte): activar en el VPS `ops/vps/` (instalar scripts, `HC_PING_URL_RESPALDO`, reiniciar `balancita.service`). El usuario ya hizo `git pull` en el VPS.
- **L6** (T1+T2): Parquet archiva qwen-live (decisiones, operaciones cerradas con funding completo, recibos por `recorded_at_ms`, acciones por noticias, config) y auditor (miradas resueltas), velas oficiales / funding_periods / analytics_points por `known_at`; exclusiones por base con motivo. 110 tests OK; dry-run sobre copia VPS código 0.
- **L7** (T3): la captura solo guarda ticker de ETH (trades WS fijado a PF_XBTUSD, `bookFeed: false`): sin trades ni libro el resumen solo da spread y tamaños top. Módulo `server/src/features/market-summary/` con 13 tests, sin conectar a `server/src/app/capture-main.ts` hasta que el usuario decida.
- **L8** (usuario, 2026-11-06): «si, hagamoslo. si el respaldo sale bien, hace el recorte» — aprueba la opción 2 (capturar trades y libro de ETH y conectar el resumen) y autoriza T4-T6 condicionado a que el respaldo del 06-nov 04:30 Madrid salga OK.
- **L9** (T3): captura de trades de ETH (todos) y libro de ETH muestreado cada 30 s dentro de ±0,1 % (sin deltas), resumen por minuto conectado en `server/src/app/capture-main.ts`; BTC sin cambios. Estimado: trades ETH ~0,4-0,5 GB/día (retención 7 días), libro ~19 MB/día, resumen ~60 MB/año. 596 tests de server OK. La tabla del resumen se archiva en Parquet (`eth_minute_summary`). Riesgo: `futures_maker.py` ahora también ve trades de ETH en la cinta.
- **L10** (respaldo 06-nov): rc=1 por un solo hueco: `market_events` del 2026-11-02, recortado por la retención antes de que existiera el respaldo del VPS. Sin recortes. Usuario: «Si, hacelo» → registrado en `PERIODOS_PERDIDOS_ACEPTADOS`; los recortes quedan para cuando un respaldo salga OK.
