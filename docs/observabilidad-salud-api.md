# `GET /api/observability/health` (Mission Control B1)

Estado de seis componentes del sistema, calculado **solo** con evidencia que se puede leer en el momento de la
consulta. Solo lectura: no escribe, no lanza procesos y no hace polling. Vive en el gateway (`/api-live/observability/health`
detrás del proxy de Vite, igual que `/api/health` y `/api/system`).

Código: `server/src/features/live-gateway/observability-health.ts`. Pruebas: `observability-health.test.ts`.
Ejemplos reales (generados por las pruebas con datos de fixture): `docs/mission-control/b1/`.

## Reglas

1. Un estado se deriva de evidencia leída ahora. Sin fuente, o con una fuente que no se puede leer: `unknown` («Sin datos»).
2. La ausencia de errores no es salud: `ok` exige que cada comprobación **obligatoria** haya encontrado evidencia reciente. Una
   comprobación obligatoria `unknown` impide que el componente sea `ok`.
3. Un proceso activo no prueba que produzca: el estado de un proceso se contrasta con su salida (una fila, una vela, un
   resumen). Proceso `running` + salida vieja o inexistente = `error` (`process_active_output_stale` /
   `process_active_without_output`). Salida fresca + proceso `down` = `warning`.
4. Si el supervisor no lanzó un proceso (p. ej. `DEV_ONLY=vite,capture,live,forward,strategies` no lanza `verdict`), la salida vieja
   de ese proceso es `unknown`, no «caído» ni `ok`. Solo `capture` es obligatorio: sin ticker reciente es `error` aunque no haya
   información del supervisor.
5. El estado global es el peor de los seis (`error` > `warning` > `unknown` > `ok`). **Nunca es `ok` si algún componente es
   `unknown`**; hoy Riesgo es siempre `unknown`, así que el global no puede ser `ok` hasta que exista esa fuente.

## Contrato (`observability-health.v1`)

```jsonc
{
  "schema": "observability-health.v1",
  "generated_at_ms": 1790000000000,
  "cache_ms": 15000,
  "overall": {
    "status": "ok | warning | error | unknown",
    "reason": "texto",
    "failing": ["data", ...],      // componentes en warning/error
    "unverified": ["risk", ...]    // componentes en unknown
  },
  "components": [                  // siempre seis, en este orden:
    {                              // data, processing, strategies, decisions, paper, risk
      "id": "data",
      "label": "Datos",
      "status": "ok | warning | error | unknown",
      "summary": "razón principal",
      "checks": [{
        "id": "ticker_freshness", "label": "...",
        "status": "ok | warning | error | unknown",
        "required": true,          // las no obligatorias solo cuentan si no son unknown
        "value": 2000,             // edad en ms, conteo o estado del proceso; null si no se pudo medir
        "rule": "umbral aplicado",
        "detail": "qué se encontró"
      }],
      "evidence": [{
        "source": "paper_futures_market_events (feed=ticker)",
        "origin": "futures-market.sqlite",   // nombre de archivo, sin ruta
        "last_updated_ms": 1789999998000,    // el timestamp más nuevo que trae la evidencia; null si no se leyó
        "state": "read | missing | unreadable",
        "detail": "solo si no se leyó"
      }],
      "items": [ /* por producto, estrategia o experimento, cuando aplica */ ],
      "limitations": ["lo que este componente no puede decir"]
    }
  ]
}
```

Ejemplos: [saludable (global `unknown` por Riesgo)](mission-control/b1/ejemplo-saludable.json),
[degradado](mission-control/b1/ejemplo-degradado.json), [sin datos](mission-control/b1/ejemplo-sin-datos.json).

## Evidencia y umbrales por componente

Los umbrales salen de las cadencias reales del código; ninguno es un número «razonable» sin origen.

| Componente      | Comprobación (obligatoria salvo nota)         | Evidencia                                                                              | Umbral y justificación                                                                                                                                                                           |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Datos           | Frescura del ticker (peor de los 8 productos) | `paper_futures_market_events`, `feed='ticker'`, `received_at`                          | ok ≤ 15 s (`MARKET_STALE_AFTER_MS`, el límite de la captura; el ticker llega por REST cada 1 s), warning ≤ 60 s (4×), error más allá o sin ticker en 10 min                                      |
| Datos           | Frescura de la vela de 1 min (peor producto)  | `paper_futures_official_candles`, 1 min, cierre = `bucket_start+60 s`                  | ok ≤ 120 s (la vela se pide 3 s después de cada minuto: 1 minuto + margen de un sondeo perdido), warning ≤ 300 s                                                                                 |
| Datos           | Huecos conocidos                              | `paper_futures_data_gaps` (24 h)                                                       | warning si hay un hueco en la última hora; los de 24 h se cuentan                                                                                                                                |
| Datos           | Proceso de captura vs. datos (no obligatoria) | `dev-health.json` + ticker                                                             | proceso activo sin ticker reciente = error                                                                                                                                                       |
| Procesamiento   | Archivo de salud del supervisor               | `dev-health.json` (`updated_at_ms`)                                                    | ok ≤ 30 s (el supervisor lo reescribe cada 5 s); si no, el estado de procesos es `unknown`                                                                                                       |
| Procesamiento   | Continuidad de evaluaciones                   | `paper_futures_verdicts.written_at`                                                    | ok ≤ 3 min (1 verdict por producto y minuto, margen 3×), warning ≤ 10 min; con proceso `verdict` activo y sin verdicts recientes = error                                                         |
| Procesamiento   | Estado de cada proceso (no obligatoria)       | `dev-health.json`                                                                      | running ok, restarting warning, down error (warning si no es del pipeline)                                                                                                                       |
| Estrategias     | Registro                                      | `strategy_events` (último estado por estrategia)                                       | solo prueba que el registro se lee                                                                                                                                                               |
| Estrategias     | Forward vigente por estrategia                | `forward_status.checked_ms` de cada par esperado                                       | por estrategia esperada: ok si todos sus productos tienen ciclo vigente (≤ 90 min), warning si solo algunos, error si ninguno. Una fila antigua no cuenta como actividad (ver «Pares esperados») |
| Estrategias     | C31 y Kronos (no obligatorias)                | `qwen-exit-summary.json`, `kronos-summary.json` (mtime), proceso                       | resumen ≤ 1,5 ciclos (C31: 30 min; Kronos: 60 min); proceso activo sin resumen reciente = error                                                                                                  |
| Decisiones      | Cadencia de decisiones C (peor producto)      | último `paper_futures_verdicts` por producto                                           | igual que continuidad de evaluaciones; se informan acción, `reason_code`, edad y evaluaciones en 10 min                                                                                          |
| Decisiones      | Decisiones de Qwen (no obligatoria)           | `paper_futures_llm_decisions.written_at`                                               | sin umbral: Q salta los minutos en calma (calm-skip) y no hay cadencia fija; se informa sin juzgar                                                                                               |
| Ejecución paper | Ciclo del forward por estrategia y producto   | `forward_status.checked_ms` de cada par esperado                                       | por par: ok ≤ 90 min (1,5 ciclos de `--loop-seconds 3600`), warning ≤ 120 min, error más allá o sin fila; el estado es el del **peor par** y el detalle nombra los retrasados                    |
| Ejecución paper | Anomalías registradas                         | `forward_status` de los pares esperados (`diverged_trades`, `candle_lag_ms`, bloqueos) | warning si hay trades divergentes (piden `--rebuild`) o vela con retraso > 10 min; bloqueos y ciclos obsoletos se informan sin juzgar                                                            |
| Riesgo          | Fuente de riesgo                              | ninguna                                                                                | siempre `unknown`: `multi_risk.py` corre fuera de `pnpm dev` y no hay registro de rechazos, exposición, margen ni pérdida diaria                                                                 |

### Pares esperados (estrategia × producto)

El forward actualiza, en cada ciclo, cada estrategia medida × cada producto de su lista. El gateway reconstruye esa lista con las
mismas entradas que `futures_forward.effective_registration`, y **no** supone que todas las estrategias o productos estén
habilitados:

1. Estrategias del archivo `config/forward-strategies.json`, **salvo** las que el registro (`strategy_events`: versión activa, o la
   versión más nueva con su propio estado) tiene en un estado distinto de `active`. Una estrategia solo del archivo necesita su
   especificación en `config/strategies/`; si no la tiene el forward la omite y se informa en `limitations`.
2. Más toda estrategia que el registro tiene `active`.
3. Productos: los que itera el forward (`FUTURES_PRODUCTS`, si no la lista fijada en `config/futures-products.json`), tomados
   del mismo entorno que el gateway. El runner no tiene filtro de productos por estrategia.

Si alguna de esas entradas no se puede leer (registro, archivo de registro, carpeta de specs, lista de productos), el conjunto no
se puede determinar y las comprobaciones `forward_cycle` y `forward_coverage` son `unknown` aunque haya filas frescas. Una estrategia
activada hace menos de 90 min según el registro y todavía sin fila es `warning` (`awaiting_first_cycle`), no un error. Las filas de
`forward_status` de pares que ya no se esperan (estrategia apagada) no se usan para juzgar actividad y se cuentan en
`rows_not_expected`.

## Seguridad y rendimiento

- Cada fuente se abre con `DatabaseSync(path, { readOnly: true })` + `PRAGMA query_only=ON`, se consulta y se cierra. No hay
  conexiones persistentes (no retiene lecturas WAL) y no se toca ninguna tabla existente. Las pruebas comprueban que los
  archivos conservan bytes, tamaño y fecha de modificación.
- Todas las consultas están acotadas por clave o ventana (planes de consulta verificados con `EXPLAIN QUERY PLAN`):
  ticker `SEARCH … paper_futures_market_received (product_id=? AND received_at>?)` (ventana 10 min), vela
  `SEARCH … autoindex (product_id=? AND interval_ms=? AND bucket_start>?)`, huecos `SEARCH … detected_at>?`, verdicts
  `SEARCH … COVERING INDEX (product_id=? AND bucket_start>?)`. El último evento de cualquier feed usa `ORDER BY rowid DESC LIMIT 1`.
- Caché de 15 s en el proceso del gateway (misma idea que `scores`): como mucho una computación cada 15 s sin importar cuántos
  clientes consulten. El front no está conectado a este endpoint todavía; cuando lo esté no debe consultar más seguido que eso.
- No se agregan procesos: es una ruta más del gateway existente. No se toca el WebSocket, la captura, estrategias, decisiones ni contabilidad.
- `strategy_events` se agrupa completo por estrategia y versión: crece con los cambios de estado del registro (una fila por
  activación o baja), no con las operaciones.
- El historial de trades no se lee: no hay consultas sobre `forward_trade` (la última operación por experimento es B2).
  `forward_status` y `forward_open` tienen una fila por estrategia y producto, así que el coste crece con estrategias × productos,
  no con el historial.
- Única edición fuera del gateway: `scripts/dev-provider-env.mjs` le pasa al proceso `live` cuatro rutas más
  (`FUTURES_FORWARD_DB_PATH`, `FUTURES_STRATEGIES_DB_PATH`, `FUTURES_FORWARD_REGISTRATION_PATH`, `FUTURES_STRATEGY_SPECS_DIR`)
  para leer esas bases y archivos en modo solo lectura.

### Medición (copia sintética, nunca la captura de la Mac)

`node --experimental-strip-types src/features/live-gateway/observability-health-bench.ts --scale 1` genera, en una carpeta
temporal, una base de mercado de **1 087 MB** (24 h de tickers de 1 s × 8 productos con 900 B por evento, 7 días de trades de
`PF_XBTUSD`, 10 días de velas de 1 min, huecos), 30 días de verdicts (≈ 345 000 filas) y un forward con 3 estrategias × 8 productos
y 200 trades por par (la última fila del cuadro los lleva a 20 000). Cada medida abre las bases, consulta y cierra, sin caché:

| Caso                                                                  | p50    | p95    | máx    | Lecturas fallidas |
| --------------------------------------------------------------------- | ------ | ------ | ------ | ----------------- |
| Informe sin caché, escritor inactivo                                  | 3,1 ms | 4,1 ms | 4,3 ms | 0 de 40           |
| Informe sin caché, escritor insertando (2 000 filas por vuelta, WAL)  | 1,8 ms | 4,4 ms | 6,0 ms | 0 de 40           |
| Informe sin caché con `forward_trade` ×100 (de 4 800 a 480 384 filas) | 1,8 ms | 2,7 ms | 2,9 ms | 0 de 40           |

La última fila comprueba que el historial de trades no mueve la latencia: no hay consultas sobre esa tabla. Las diferencias entre
filas son ruido de la medición (una sola máquina, 40 repeticiones).

Con la caché de 15 s son ≤ 240 computaciones por hora, unos 0,5 s de CPU por hora en total. Medición en un contenedor Linux con
la caché de páginas caliente; en la Mac el orden de magnitud debería ser el mismo, pero no se midió allí ni se ejecutó nada
sobre la base viva.

## Límites conocidos

- Sin `dev-health.json` reciente (Windows no lo reescribe cada 5 s, o el supervisor no corre) el estado de los procesos es
  `unknown` y los componentes que dependen de él no pueden ser `ok` salvo que su salida sea fresca.
- Kronos no está en el supervisor: su proceso se sabe solo por el muestreo de recursos (POSIX).
- Los descartes del forward (coste/protección) y los fallos de Q no se persisten (B4 pospuesto): no se pueden evaluar.
- No hay PnL no realizado ni posiciones abiertas por estrategia (B5) ni actividad, última operación y motivos de espera (B2).
- Riesgo queda en «Sin datos» hasta que exista una fuente real. No se crea ningún mecanismo nuevo de persistencia.
