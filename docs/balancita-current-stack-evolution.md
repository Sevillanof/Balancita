# Balancita — evolución del stack actual (React/Fastify/Kraken)

> **Estado: superseded.** Este documento fue reemplazado por
> [`docs/balancita-main-screen-roadmap.md`](balancita-main-screen-roadmap.md).
> Se conserva únicamente como análisis histórico y no debe guiar la
> implementación.

## 1. Recomendación

Camino de menor costo. Modificar el stack actual (React 19 + TypeScript +
Vite + Fastify + SQLite + Kraken) para llegar al mismo layout de cabina de
una pantalla es más barato y de menor riesgo que reescribir en
FastAPI/Rust — ver comparación de costos en §3. La arquitectura de datos ya
es avanzada (Kraken, velas intradía, pronósticos, SSE); lo que falta es
composición visual, no una nueva plataforma.

## 2. Estado actual verificado

- `.dashboard` en [`src/app/dashboard.css`](../src/app/dashboard.css) usa
  `display: flex; flex-direction: column`: el primer viewport de escritorio
  apila verticalmente encabezado, disclaimer, panel de observabilidad,
  detalle/gráfico, grilla de trade+portfolio y paneles secundarios. No hay un
  layout de una sola pantalla con gráfico/acciones/noticias como área de
  trabajo primaria.
- El gráfico en [`src/providers/kraken-market-data.ts`](../src/providers/kraken-market-data.ts)
  usa `OHLC_INTERVAL_MINUTES = 1440` (velas diarias), no 1m.
- [`src/app/intelligence/IntelligenceStatusPanel.tsx`](../src/app/intelligence/IntelligenceStatusPanel.tsx)
  muestra estado agregado del pipeline (modo, conexión, advertencias), no una
  lista de noticias individuales con proveniencia visible.
- El servidor ya expone `GET /api/intelligence/stream` (SSE),
  `GET /api/intelligence/shadow/status` y `POST /api/analyze`
  ([`server/src/app.ts`](../server/src/app.ts)); colección Kraken durable,
  velas intradía y motor técnico ya existen en
  `server/src/intelligence/`, con la publicación SSE implementada en
  [`server/src/intelligence/stream.ts`](../server/src/intelligence/stream.ts).
- Nota de vigencia: [`docs/bitcoin-market-intelligence-roadmap.md`](bitcoin-market-intelligence-roadmap.md)
  describe el estado "tras la fase 9.3" y menciona Coinbase en varias
  secciones; el código actual usa Kraken (`src/providers/kraken-market-data.ts`,
  `server/src/intelligence/market/`). Ese texto de roadmap está desactualizado
  en ese punto puntual; el código verificado es la fuente autoritativa. Las
  referencias de línea pueden derivar con el tiempo — enlazar por ruta, no por
  número de línea, al planificar trabajo nuevo.

## 3. Comparación de costo

| Camino                                      | Horas     | Semanas (1 FTE) |
| ------------------------------------------- | --------- | --------------- |
| Evolución del stack actual (este documento) | 160–280 h | 4–7 semanas     |
| Reescritura FastAPI + Rust/WASM             | 560–840 h | 14–21 semanas   |

Supuesto: un ingeniero senior full-time, ya familiarizado con React/TypeScript
y con el código de este repositorio.

## 4. Mapa del layout objetivo

```
+-------------------------------------------------------------+------------------------+
| Balancita (BTC/EUR)                                          | EUR disponible: X.XXX  |
+-------------------------------------------------------------+------------------------+
|                                                               | Noticias (proveniencia)|
|             Gráfico BTC-EUR 1m (Lightweight Charts)          | - fuente · hora · link |
|                                                               | - fuente · hora · link |
+-------------------------------------------------------------+------------------------+
| [Comprar] [Vender]        [Control automático: señales]      | Resumen del instrumento|
+-------------------------------------------------------------+------------------------+
```

Observabilidad avanzada (SLIs, frescura, huecos) pasa a una sección de
divulgación secundaria (`<details>`), no se elimina.

## 5. Qué mantener / cambiar / mover

| Elemento                                                              | Acción                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kraken, SQLite, motor de pronósticos, SSE                             | **Mantener** sin cambios de contrato                                                                                                                                                      |
| `PortfolioRepository`, `OrderExecutionProvider`, contratos de dominio | **Mantener** — no reescribir                                                                                                                                                              |
| `.dashboard` (`flex column`)                                          | **Cambiar** a CSS Grid de una pantalla (gráfico+noticias arriba, acciones+resumen abajo)                                                                                                  |
| Intervalo de velas del gráfico (`1440` min)                           | **Cambiar** a velas 1m usando el motor intradía ya existente en el servidor                                                                                                               |
| `IntelligenceStatusPanel`                                             | **Mover** a `<details>` secundario; **agregar** un panel de noticias individual con proveniencia en su lugar en el layout primario                                                        |
| Alertas, laboratorio TTWO/SPCX                                        | **Mantener** como `<details>` secundarios (ya lo son)                                                                                                                                     |
| Control automático                                                    | **Agregar** como control visible junto a Comprar/Vender; sólo emite señales o corre una simulación sombra aislada, nunca escribe en el ledger de paper trading principal sin confirmación |

No se recomienda reescribir ningún dominio o proveedor existente.

## 6. Hitos ordenados

| Hito | Resultado                                                           | Archivos probables                                                                                                                                                                    | Tests                                                             | Estimado |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| 1    | Grilla CSS de una pantalla (gráfico+noticias, acciones+resumen)     | [`src/app/BtcEurDashboard.tsx`](../src/app/BtcEurDashboard.tsx), [`src/app/dashboard.css`](../src/app/dashboard.css)                                                                  | Render/a11y de layout                                             | 20–30 h  |
| 2    | Gráfico 1m real vía motor de velas intradía del servidor            | [`src/providers/kraken-market-data.ts`](../src/providers/kraken-market-data.ts), [`src/app/chart/PriceChart.tsx`](../src/app/chart/PriceChart.tsx), `server/src/intelligence/market/` | Tests de límites de vela y warm-up ya existentes + integración UI | 30–50 h  |
| 3    | Panel de noticias con proveniencia visible                          | nuevo `src/app/intelligence/NewsPanel.tsx`, `server/src/intelligence/news/`                                                                                                           | Tests de proveniencia (fuente/URL/tiempos)                        | 40–60 h  |
| 4    | Control automático (señales + simulación sombra aislada)            | nuevo `src/app/trade/AutoSignalControl.tsx`, `server/src/intelligence/shadow/`                                                                                                        | Tests de aislamiento (nunca muta ledger principal)                | 30–50 h  |
| 5    | Mover observabilidad a divulgación secundaria + limpieza responsive | [`src/app/intelligence/IntelligenceStatusPanel.tsx`](../src/app/intelligence/IntelligenceStatusPanel.tsx), `dashboard.css`                                                            | Tests de render + `format:check`/`lint`                           | 20–30 h  |
| 6    | Verificación de frescura en vivo + CORS de desarrollo (§8/§9)       | `server/src/config.ts`, `.env`                                                                                                                                                        | Smoke manual + checklist de aceptación (§11)                      | 20–40 h  |
| 7    | Rollback y checklist final                                          | —                                                                                                                                                                                     | Checklist completo (§11)                                          | —        |

Total: 160–280 h coincide con el rango de §3.

## 7. Comportamiento responsive

- La grilla primaria (gráfico+noticias) colapsa a una columna por debajo de
  un breakpoint de escritorio angosto (por ejemplo `< 1024px`), manteniendo
  el gráfico primero.
- Los controles inferiores (Comprar/Vender/automático/resumen) se apilan en
  una fila scrolleable horizontal en viewports estrechos, igual que la
  estrategia ya usada por `.table-scroll` en portfolio/trade.
- Ningún elemento crítico (precio, botones de acción) queda oculto sin
  scroll explícito.

## 8. Verificación CORS / origen de desarrollo

- `server/src/config.ts` expone `GEMINI_SERVER_CORS_ORIGIN`
  (por defecto `http://localhost:5173`, el puerto de Vite).
- Antes de cada hito con llamadas nuevas al servidor, confirmar que el origen
  del frontend en desarrollo coincide con el valor configurado; documentar
  cualquier cambio de puerto en `.env` en vez de hardcodear otro origen.

## 9. Aceptación de frescura de datos en vivo

- Cada dato mostrado (precio, vela, noticia) expone su frescura
  (`tiempo de visualización − tiempo de evento`) según las definiciones ya
  fijadas en [`docs/bitcoin-market-intelligence-roadmap.md`](bitcoin-market-intelligence-roadmap.md#3-definiciones-de-tiempo-y-frescura).
- Ningún hito de este plan puede describir un dato como "en vivo" sin mostrar
  esa métrica junto al valor.

## 10. Límite de señales automáticas / sin órdenes

- El control automático puede: mostrar señales calculadas y correr una
  simulación sombra completamente aislada.
- El control automático no puede: ejecutar, previsualizar o confirmar una
  orden real; escribir en `balancita:simulator` o en el ledger de paper
  trading principal sin una confirmación manual explícita del usuario.
- Esta separación se verifica con un test de superficie (igual al ya
  existente entre `analysis` y `orders`): el control automático no debe
  importar ni invocar `OrderExecutionProvider`.

## 11. Estrategia de rollback

- Cada hito es un commit de trabajo independiente sobre una rama de feature;
  ningún hito borra código de dominio o proveedor existente.
- Si un hito de layout introduce una regresión visual o de accesibilidad,
  revertir sólo ese commit; los contratos de dominio no cambian entre hitos,
  por lo que el rollback no afecta pronósticos, portfolio ni paper trading.
- La observabilidad avanzada nunca se elimina, sólo se oculta detrás de
  `<details>`; puede reexponerse en un solo commit si hace falta depurar.

## 12. Checklist de aceptación final

- [ ] Primer viewport de escritorio muestra gráfico 1m, noticias con
      proveniencia, acciones y resumen sin scroll vertical obligatorio.
- [ ] Gráfico usa velas 1m del motor intradía del servidor, no diarias.
- [ ] Noticias visibles muestran fuente, hora y enlace por cada elemento.
- [ ] Control automático nunca ejecuta ni autoriza una orden real ni escribe
      en el ledger principal sin confirmación explícita.
- [ ] Observabilidad avanzada accesible pero no intrusiva (`<details>`).
- [ ] `pnpm test`, `pnpm test:server`, `typecheck`, `lint`, `build`,
      `format:check` en verde.
- [ ] CORS de desarrollo verificado contra el puerto real de Vite.
