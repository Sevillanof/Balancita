# Registro del 404 de observabilidad (hotfix tras #148)

| Campo                               | Valor                                                                                                                                                                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Método y URL pedida por el frontend | `GET /api-live/api/observability/health` y `GET /api-live/api/observability/activity?window=…&product=…`                                                                                                                                                             |
| Lo que recibe el gateway            | `/api/api/observability/…` (el proxy de Vite reescribe `/api-live` → `/api`)                                                                                                                                                                                         |
| Ruta real del gateway               | `/api/observability/health`, `/api/observability/activity`                                                                                                                                                                                                           |
| Código HTTP                         | 404                                                                                                                                                                                                                                                                  |
| Causa                               | `HEALTH_URL` y `ACTIVITY_URL` repetían `/api` detrás de `/api-live`. Los mocks de Playwright y los tests unitarios usaban la misma URL equivocada, así que coincidían con el frontend y nunca tocaron el gateway real.                                               |
| Corrección                          | `/api-live/observability/health` y `/api-live/observability/activity`                                                                                                                                                                                                |
| Prueba que lo detecta               | `e2e/integracion-gateway.pw.ts`: levanta `gateway-main.ts` real con bases temporales (datos sintéticos) detrás del proxy de Vite y recorre B1, B2 3 h/24 h, cambio de producto, inspector, controles del gráfico, Terminal ↔ Estrategias. Con las URLs viejas falla. |

Otras rutas `/api-live/*` revisadas (`health`, `system`, `terminal/bootstrap`, `terminal/chart`,
`qwen/scores`, `kronos/scores`): responden 200 por el proxy.

Al recorrer Estrategias en ese aislamiento (solo gateway en vivo; sin registro S ni MOCK) aparecen
502 por servicios no levantados, no 404: `GET /api-strategies/health`, `GET /api-strategies/carry`
y `GET /api-mock/terminal/bootstrap`. Quedan en `playwright-artifacts/integracion-gateway/solicitudes.json`.
