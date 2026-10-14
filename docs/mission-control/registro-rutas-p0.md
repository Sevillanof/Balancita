# Registro de rutas P0: dependencias retiradas y errores de rutas

Alcance: toda petición HTTP/WS que el frontend (`src/`) hace en Terminal y Estrategias, verificada contra los
servidores reales (gateway `server/src/app/gateway-main.ts` y registro S Python
`balancita_engine.futures_strategy_registry`), con bases temporales y datos sintéticos («DATOS DE EJEMPLO»).
Prueba: `e2e/integracion-gateway.pw.ts` (sin mocks de red). Los registros crudos de cada recorrido salen en
`playwright-artifacts/integracion-gateway/solicitudes-*.json`.

## Hallazgos

| #   | Método y URL                       | HTTP (antes)                          | Causa                                                                                                                                                                                            | Corrección                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api-mock/terminal/bootstrap` | 502 (el MOCK no corre)                | `loadLabCandles` (Estrategias) probaba `live`, luego `mock`, luego velas **sintéticas** inventadas. El MOCK ya no se arranca (`pnpm dev` no lo levanta) y Fran decidió que no se usa.            | `loadLabCandles` pide solo `/api-live`. Sin velas lanza error; la pantalla dice «Velas de Terminal no disponibles… No se dibujan velas de ejemplo». `TerminalSource` y `terminalApiBase` quedan solo en `live`. El frontend ya no referencia `/api-mock`.                                                |
| 2   | `GET /api-strategies/health`       | 502 con S apagado                     | Una sola sonda al conectar. Es legítima (no hay otra forma de saber si S vive), pero su fallo se mostraba como «Sin conexión… datos de ejemplo» en la barra y el resto de las peticiones seguía. | Se mantiene **una** sonda. Con S apagado: barra «Registro de estrategias no disponible: servicio sin iniciar», alerta con el detalle y ninguna otra petición a S (comprobado: un `GET /health` y nada más en 1,5 s).                                                                                     |
| 3   | `GET /api-strategies/carry`        | 502 con S apagado                     | `CarryPanel` se montaba siempre y pedía su resumen aunque S no respondiera; ante el fallo no mostraba nada (silencio presentado como ausencia).                                                  | `CarryPanel` solo se monta con el registro conectado. Si S responde pero el resumen falla: «Carry de funding no disponible: el registro no devolvió su resumen».                                                                                                                                         |
| 4   | `POST /api-strategies/evaluate`    | 400 `bad_request` «'bucket_start_ms'» | **Fixture**, no código: el verdicts DB del gateway guarda `payload_json = {}`, que S no puede evaluar. Con verdicts reales siempre existe `bucket_start_ms`.                                     | `e2e/support/seed_registry_sandbox.py` genera para S veredictos reales (motor de veredictos) sobre velas sintéticas del propio test Python. **Pendiente de decisión**: S responde 400 «bad_request» por un `KeyError` ante un payload mal formado; conviene un código y mensaje explícitos (no se tocó). |

## Inventario de peticiones (Terminal y Estrategias)

Todas responden 200 con ambos servicios levantados (`solicitudes-terminal.json`, `solicitudes-estrategias.json`).

| Método | URL                                                                                            | Servidor   | Quién la pide                                                                          |
| ------ | ---------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| GET    | `/api-live/terminal/bootstrap[?product=]`                                                      | gateway    | `TerminalEntry`, `loadLabCandles`                                                      |
| WS     | `/api-live/terminal/stream[?product=]`                                                         | gateway    | `useTerminalStream` (no se tocó)                                                       |
| GET    | `/api-live/terminal/chart`                                                                     | gateway    | `terminal-chart-client`                                                                |
| GET    | `/api-live/health`, `/api-live/system`                                                         | gateway    | `AppStatusChips`, `FuturesTerminal`, `SystemUsageChip`                                 |
| GET    | `/api-live/observability/health`, `/api-live/observability/activity`                           | gateway    | `observability-api` (corregidas en #149)                                               |
| GET    | `/api-live/qwen/scores`, `/api-live/kronos/scores`                                             | gateway    | `qwen-scores` (Estrategias)                                                            |
| GET    | `/api-strategies/health`                                                                       | registro S | `connectStrategyApi` (una sonda)                                                       |
| GET    | `/api-strategies/ranking`, `/strategies/:id`, `/plans`, `/carry`                               | registro S | `StrategyLab`, `CarryPanel`                                                            |
| POST   | `/api-strategies/backtest`, `/evaluate`, `/import`                                             | registro S | `StrategyLab`, `NewStrategyModal` (import como borrador)                               |
| POST   | `/api-strategies/strategies`, `/variants`, `/state`, `/delete`, `/translate`, `/carry/enabled` | registro S | acciones del Laboratorio; **no se ejercitan** en la prueba (escriben estado o activan) |
| GET    | `/api-strategies/replays[...]`                                                                 | registro S | `ReplayPanel` existe pero **no está montado** en ninguna pantalla                      |

## Decisión sobre el modo MOCK

- Frontend: sin dependencias del MOCK. Quedan solo los tipos de datos `mode: 'mock'` del bootstrap, que los tests
  unitarios usan como fixture de formato.
- Servidor/scripts: `server/src/app/mock-main.ts` y la entrada `/api-mock` del proxy de Vite siguen en el código pero
  `pnpm dev` ya no arranca el MOCK (`MOCK_ARGS` sin uso). No se tocaron: retirarlos es un cambio de scripts de
  desarrollo que no corresponde a esta línea.

## Cómo se verificó

- `e2e/integracion-gateway.pw.ts` levanta el gateway real y el registro S real (Python, DB temporal, velas y veredictos
  sintéticos) detrás del proxy de Vite y recorre: B1/B2, controles del Terminal, Estrategias (lista, detalle,
  periodo 90 d, Carry, modal «Nueva estrategia» importando un borrador con «operar en paper ya» desmarcado, y un JSON
  roto rechazado). Cero 4xx/5xx y cero `/api-mock`.
- Con S apagado: estado honesto, una sola sonda a `/api-strategies/health`, sin Carry ni ranking.
