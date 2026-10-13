# Mission Control: informe de viabilidad y plan por fases

Estado: auditoría (sin cambios de código). Fecha: 2026-10-13. Base: `main` @ b3f8e62.
Referencia visual: ZIP de Stitch v5 (6 pantallas + `DESIGN.md` "Obsidian Mission Control").

Alcance de esta entrega: solo documentación. No se toca el motor, la ingesta, la
contabilidad, C29-C32 ni Kronos. El ADR 0001 sigue siendo el marco (paper, 100 USD
fijos por operación, un modelo de costes por producto, sin órdenes reales).

## 0. Resumen

- El front actual ya tiene la mayor parte de la **mecánica** que pide Mission Control:
  WebSocket con secuencia y resync, gráfico con marcadores clicables, selección de
  decisión, cuenta paper, ranking de estrategias, backtest, Qwen y Kronos.
- Lo que **no existe en el backend** es lo que la nueva interfaz vende como núcleo:
  trazabilidad completa por etapas, salud real de los seis componentes y contadores de
  "por qué no operó". Hay datos sueltos en SQLite y en JSON de disco, pero casi nada
  expuesto por HTTP.
- Stitch es solo referencia: las pantallas contienen mucho contenido inventado
  (ver §2). Ninguna de esas cifras debe llegar a la UI.
- Recomendación: empezar por fundamentos visuales (cero riesgo para el trader), después
  añadir un **gateway de solo lectura** nuevo para observabilidad, sin tocar los
  procesos que escriben.

## 1. Estado actual (resumen verificado)

Frontend (`src/`, React 19, Vite 8, React Compiler, `lightweight-charts` 5.2):
- Sin router: `App.tsx` enruta por `window.location.pathname`; `/estrategias` es el
  Laboratorio y cualquier otra ruta cae en Terminal.
- Estilos en CSS plano con tres sistemas de tokens: `--color-*` (`shared/styles/ui.css`),
  `--demo-*` (`app/DemoShell.css`, oscuro fijo) y `--lab-*` (`StrategyLab.css`, oklch).
- Terminal: `FuturesTerminal.tsx` (1039 líneas) mezcla WebSocket, reducción de estado,
  comandos paper, health y cuatro paneles. La lógica reutilizable es pura y con tests:
  `terminal-stream-client`, `terminal-state`, `terminal-batch`, `terminal-chart-model`,
  `terminal-decisions`, `chart-indicators`.
- Gráfico: `ApprovedTerminalChart` (marcadores, clic en marcador → `onSelect`, líneas de
  entrada/stop/objetivo), `TerminalChartPanel` (indicadores EMA/Bollinger/VWAP/Donchian/RSI
  calculados en el front, paneles de flujo/OI/liquidaciones).
- Decisiones: `TerminalDecisions` agrupa WAIT consecutivos; `SelectedDecision` muestra
  acción, estrategia, motivo, hora, id y condiciones de las propuestas.
- Estrategias: `StrategyLab.tsx` (1481 líneas, ~50 `useState`): ranking, editor
  (reglas/parámetros/riesgo/plan/json/versiones), importar, variantes, ciclo de estados
  con gates, Qwen, Kronos, carry. `ReplayPanel`/`replay-api` no se renderizan (código
  muerto con test propio).
- Tests: 20 archivos Vitest en `src` (FuturesTerminal 22 casos, StrategyLab 17), Playwright
  con 3 viewports y respuestas mockeadas. No hay CI en `.github`.
- No se ejecutaron lint/typecheck/tests en la auditoría (no hay `node_modules`); el primer
  paso de la Fase 1 es fijar la línea base con `pnpm install && pnpm typecheck && pnpm lint && pnpm test`.

Backend (Fastify 5 + motor Python por subproceso, SQLite):
- Gateway `/api-live` (8789): `terminal/bootstrap`, `terminal/chart`, `health`, `system`,
  `qwen/scores`, `kronos/scores`, y WS `terminal/stream` con `snapshot`, `market.updated`,
  `analysis.completed`, `account/position/order/fill`, `engine.status`, `heartbeat`, `resync.required`.
- Registro de estrategias `/api-strategies` (8790): `strategies`, `ranking`, `backtest`,
  `evaluate`, `plans`, `carry`, `replays`, `schema`, estados y versiones.
- Hechos que condicionan el diseño:
  - `pnpm dev` lanza vite, capture, live, news, llm, q, qwenexit, verdict, scores, forward,
    carry, strategies. **No** lanza Kronos, el colector de libro ni el experimento multi
    (arms A/B/C), que corren aparte.
  - El libro D (ejecución paper antigua) está retirado: `bootstrap.engine`, equity,
    posiciones y órdenes del Terminal reflejan su base histórica y no son el estado de las
    estrategias activas. Hoy el trading real simulado vive en `forward` (y en Qwen/Kronos/C31).
  - No hay SSE.

## 2. Qué trae Stitch y qué es inventado

Pantallas: espera sin operaciones (3 h), investigación de decisión, salud del sistema,
estrategias (inventario con validación), detalle C29, comparación de experimentos.
**Brecha: no hay vista base de Terminal con posición abierta.** Se reconstruiría con el
mismo layout (cabecera, gráfico protagonista, panel derecho, tabla inferior) usando
`positionLines` y la cuenta/posición reales; se hace en Fase 2, no ahora.

Contenido de las maquetas que NO tiene respaldo real y no debe implementarse:
- Latencias y frecuencias: RTT 1,1 ms, "100 Hz", ciclo 0,14 ms, "14 ms" por ciclo, latencia
  de auditoría, heartbeat <0,04 ms, "Rust/WASM", "L2 WebSocket".
- Capital: "10.000 USDT base", AUM 250.000 USD, "Capital protegido", "Ahorro simulado
  $92,50". El ADR fija 100 USD por operación; los resultados vienen del libro de cada
  estrategia, sin cartera ni capital global.
- Métricas de microestructura (CVD, delta, absorción en ask, profundidad ask, spread en
  pbs al tick) y "Traza ID #TRC-…": no hay trazas por decisión.
- Estrategias y modelos que no existen así: "C26 Breakout Vol/C25 Mean Reversion"
  (los nombres reales de C25-C27 son otros), "Qwen 2.5 7B", "Kronos HMM", "Ensemble",
  "Sharpe 2,14", "Profit factor", "Bonferroni N<80 y t>2,0 con p<0,05" como criterio.
- Acciones: "Reiniciar módulo C26", "Descargar volcado (.log)", "Exportar JSON": implican
  controlar procesos y exponer logs. Fuera de alcance (la UI no reinicia nada).
- Cifras con "%" de win rate usadas como señal de calidad ("Robusta", "Validada") por
  número de operaciones: contradice la regla de no declarar validada una estrategia solo
  por N.
- Vocabulario de pantalla "Filtro de fricción / veto volatilidad / veto funding" como
  motivos de descarte: solo sirven si coinciden con `reason_code` reales (§4).

Elementos buenos para adoptar: sistema visual (superficies oscuras, verde/ámbar/rojo,
Inter + métricas mono), cabecera con selector de producto e indicador de salud con
desplegable, panel de investigación por etapas con "no corresponde"/"no disponible",
bloque "evaluación posterior" separado de lo conocido al decidir, aviso de segregación de
experimentos, tarjetas por experimento sin cartera consolidada.

## 3. Respuestas a los 8 puntos del informe

### 3.1 Qué podemos construir hoy con el backend actual

- Layout compartido, navegación Terminal/Estrategias, tokens y componentes base.
- Terminal: gráfico de velas en vivo con marcadores de decisiones del verdict C (WS
  `analysis.completed`), selección desde gráfico y desde historial, panel de la decisión
  con propuestas por estrategia y condiciones (`passed`, features), cuenta/posición/órdenes
  tal como las publica el gateway.
- Chips de salud simples ya existentes (captura live/stale, procesos del supervisor).
- Estrategias: lista con estado, versión, hash, fiabilidad (`verdict`, trades, hit rate,
  `mean_net_bp`, `t_stat`), detalle con reglas, versiones y eventos, backtest in/out of
  sample con `max_drawdown` y trades, planes, carry, Qwen y Kronos con curva de equity por
  operación cerrada.
- Tarjetas por experimento usando solo lo que ya expone cada fuente (Qwen y Kronos
  `scores`, forward vía registro, carry), cada una con su propio libro.

### 3.2 Existe parcialmente

| Funcionalidad | Qué hay | Qué falta |
|---|---|---|
| Salud global | `health.capture` (live/stale/unavailable + `lastReceivedAt`), `health.processes` (running/restarting/down), `system` (CPU/RSS, Qwen y Kronos) | Salud por componente con criterio explícito; frescura por feed; Kronos, libro y quote archive no están en `processes` |
| Datos | Última recepción de ticker, `known_at` de velas | `data_gaps` y diagnósticos `resilience/retention/eventloop.jsonl` solo en disco |
| Procesamiento | Estado de procesos, conteo de decisiones Qwen (total, última hora, latencia media) | Conteo de verdicts por ciclo; sin heartbeat de procesos en BD |
| Estrategias | Estado y fiabilidad por estrategia | `forward_status` (lag, velas perdidas, ciclos obsoletos) se sobrescribe cada pasada y no se sirve |
| Decisiones | Verdict C inmutable por producto y minuto con acción, `reason_code` y propuestas; decisiones Q con probabilidades; Kronos con `side NULL` | Descartes de forward (`skipped` del simulador, p. ej. `target_does_not_clear_cost`) no se persisten; Q no registra el fallo de modelo |
| Ejecución paper | Trades inmutables de forward (entrada, salida, motivo, `net_bp`, `pnl_usd`, funding), Qwen `open_position` | Sin endpoint para forward/C31; posición abierta sin PnL no realizado salvo Qwen |
| Riesgo | Gates 409 al activar estrategias; stale gate del forward | No hay motor de riesgo en el stack dev (solo `multi_risk.py`, fuera del dev) ni API de exposición/margen/pérdida diaria |
| Evaluación posterior | `forecasts` con retornos a 15/60/240/1440 min, barreras y MFE/MAE; Q a 30 min calculado al leer; replay con `outcome_close` | Sin endpoint para forecasts; sin retorno posterior de verdicts C que no pasan por forecasts |
| Costes | Un modelo por producto en `futures_costs.py`; fees y spread en Qwen scores | Sin endpoint de costes por producto |

### 3.3 Información que el backend todavía no proporciona

1. **Salud por componente** (Datos, Procesamiento, Estrategias, Decisiones, Ejecución
   paper, Riesgo) con estado correcto/advertencia/error/sin datos y la razón verificable.
2. **Tiempo desde la última operación**: no existe el campo; es derivable de
   `forward_trade`, `qwen_exit_trade` y los trades de Qwen/Kronos.
3. **Contadores de evaluaciones, señales detectadas y descartadas con motivo** por
   ventana (3 h, 24 h). Existe la materia prima en `paper_futures_verdicts` (una fila por
   producto y minuto, también WAIT, con `reason_code`), pero hay que agregarla.
4. **Descartes por coste/protección del simulador** del forward (no se persisten).
5. **Riesgo**: no hay registro de rechazos del motor de riesgo en el stack activo.
6. **Traza completa por decisión** (mercado → estrategias → combinador/modelo → riesgo →
   decisión → ejecución): no existe un id de decisión que enlace el verdict C, la
   decisión Q, la entrada de forward y el resultado. Cada fuente tiene su clave
   (producto + bucket) y se puede correlacionar por ahí, pero la correlación hoy no está
   hecha ni expuesta.
7. **Funding en vivo**: el gateway reporta `unknown`; el histórico está en la base de
   mercado sin endpoint.
8. **Equity/PnL agregado** por experimento comparable: Qwen y Kronos lo exponen; forward,
   C31 y combinadores no. (No se debe crear cartera; se necesita equity por experimento.)
9. **Fallos silenciosos**: si Qwen está caído no se escribe nada para ese bucket; hoy no
   se puede distinguir "no hubo señal" de "no se evaluó".
10. **Experimentos multi (brazos A/B/C)**: persistidos en `multi.sqlite`, fuera del stack
    dev y sin endpoint.

### 3.4 Componentes actuales a reutilizar

- Lógica pura con tests: `terminal-stream-client`, `terminal-state`, `terminal-batch`,
  `terminal-chart-model`, `terminal-decisions`, `terminal-market`, `chart-indicators`,
  `strategy-spec`, `shared/finance/format`.
- `ApprovedTerminalChart` (wrapper de lightweight-charts con marcadores, selección y
  líneas de posición), separando antes la lógica de marcadores.
- Clientes de API de `strategy-lab/infrastructure` y `carry-api`; `ApprovedPortfolioTables`.
- Proxy de desarrollo y `ui.css` como base de tokens.
- `AppStatusChips` y `SystemUsageChip` como origen de datos del nuevo indicador global.

### 3.5 Qué conviene sustituir

- Los tres sistemas de tokens por un único conjunto (`--mc-*`) derivado de `DESIGN.md`.
  Eliminar las lecturas CSS muertas (`--chart-up`, `--warning`, `--info`).
- `FuturesTerminal.tsx`: extraer un hook de stream y componentes de presentación.
- `StrategyLab.tsx`: dividir por pestañas; mover estado a hooks por responsabilidad.
- Cabecera `ApprovedTradingHeader` por la barra Mission Control con indicador de salud.
- Código muerto `ReplayPanel`/`replay-api` y restos de la fuente mock en `TerminalEntry`
  (decidir si se elimina o se cablea).
- Velas sintéticas en Lab (`lab-candles.ts`): permiten backtests sobre datos inventados;
  quitar o bloquear en la UI.
- Cálculos financieros en la vista (PnL neto con `funding_complete` en `FuturesTerminal`,
  `netBp/100` en `QwenPanels`): pasar a valores entregados por el backend o a un
  formateador único sin aritmética de negocio.

### 3.6 Cambios de backend necesarios

Principio: **solo lectura, aditivos y sin tocar procesos de escritura**. Se justifican
antes de implementarlos (cada uno requiere visto bueno de Fran).

B1. `GET /api/observability/health` en el gateway (solo lectura): estado de los seis
componentes calculado con reglas documentadas a partir de datos reales.
- Datos: `capture.status` + antigüedad de ticker y de la última vela cerrada + `data_gaps` recientes.
- Procesamiento: procesos del supervisor + conteo de verdicts del último ciclo esperado.
- Estrategias: estados del registro + `forward_status` actual.
- Decisiones: último verdict C y última decisión Q por producto vs. cadencia esperada.
- Ejecución paper: último ciclo de forward, `diverged_trades`, bloqueos por vela tardía.
- Riesgo: "sin datos" mientras no exista fuente (no verde por omisión).

B2. `GET /api/observability/activity?window=3h|24h&product=` : evaluaciones (filas de
verdict por producto/minuto), señales con propuesta direccional, descartes agrupados por
`reason_code`, última operación por experimento. Agregación pura sobre tablas existentes.

B3. `GET /api/decisions?product=&from=&to=` y `GET /api/decisions/:key`: correlación por
(producto, bucket) del verdict C, decisión Q y trade de forward, con las etapas
disponibles y marcando las ausentes como `unavailable`. Incluye evaluación posterior
(`forecasts`) separada y con su propio `known_at`, para no mezclar lo conocido al decidir
con lo retrospectivo.

B4. Persistencia mínima de descartes del forward y de fallos de Q (nuevas tablas
aditivas, nunca columnas en tablas inmutables). **Esto toca procesos de escritura**:
se propone aparte, tras pruebas, y es opcional (sin él, la UI muestra "no registrado").

B5. `GET /api/experiments`: lista de experimentos independientes (estrategias
individuales/forward, Qwen, Kronos, C31, carry) con resumen contable que ya calculan
`summarize_trades` y los `scores`, sin consolidar. Exponer los JSON de disco
(`forward-reliability`, `qwen-exit-summary`) por HTTP de solo lectura.

B6. Servir `data_gaps` y costes por producto (lectura de `futures_costs.py`).

Ninguno altera estrategias, simulador, contabilidad ni ingesta. B1-B3 y B5-B6 leen
SQLite en modo solo lectura (WAL), igual que el gateway actual.

### 3.7 Riesgos para el funcionamiento actual

| Riesgo | Mitigación |
|---|---|
| Carga de lectura sobre SQLite compartido (verdicts por minuto, 8 productos) | Conexión `readonly`, consultas acotadas por ventana, caché de 15 s como en `scores`, índices ya existentes; medir antes de activar |
| Memoria/CPU de la Mac (historial de problemas) | No añadir procesos; el gateway ya corre. Sin polling nuevo agresivo; reutilizar WS |
| Rediseño de `FuturesTerminal` rompe el WS (seq, resync, batcher) | Extraer sin cambiar la lógica; mover primero tests de caracterización; no tocar `terminal-state`/`terminal-stream-client` en Fase 1-2 |
| Mostrar verde por omisión | Estados "sin datos" explícitos; criterios por componente documentados y con tests |
| Datos de D histórico mostrados como actuales | Etiquetar origen y `known_at`; Fase 2 decide qué se muestra como "posición paper" real |
| Mezcla de experimentos | Contratos con `experiment_id`; vistas siempre filtradas; test que verifica que un resultado pertenece al experimento seleccionado |
| Interpretar `reason_code` mal | Diccionario único en front con cobertura de todos los códigos del backend; código desconocido se muestra literal |
| Cambios de contrato | Solo endpoints nuevos; los existentes no cambian |
| Cálculos financieros en la UI | Prohibido; formateo solamente |
| Sin CI en el repo | La línea base local de la Fase 0 y checklist por PR |
| Capital/estados en Stitch contradicen el ADR | No se copia ninguna cifra; ver §2 |

## 4. Mapa de datos por pantalla

Terminal
- Gráfico: `terminal/chart` + WS `market.updated`. Marcadores de verdict C vía
  `analysis.completed`; salidas vía órdenes reduce-only (D histórico) hasta que B3 aporte
  trades de forward.
- Estado del trader: acción más reciente y su `reason_code`; "esperando" solo si el último
  verdict existe y es reciente.
- Historial: filas de `analyses` (últimas 100) → B3 para ventanas largas.
- Posición/resultados: `position.updated`/`account.updated` (hoy D histórico); forward en B5.
- Salud: B1. Espera prolongada: B2.

Investigación (etapas)
1. Mercado: precios y `known_at` de la vela; datos de libro solo si el colector está activo (si no, "no disponible").
2. Estrategias: `proposals[]` del verdict C con condiciones.
3. Combinador/modelo: decisión Q (opción, probabilidades) o selección multi; "no corresponde" si no interviene.
4. Riesgo: `unavailable` salvo gates del simulador/multi.
5. Decisión final: acción y motivo (`reason_code`).
6. Ejecución paper: trade de forward asociado (B3) o "no corresponde".
7. Evaluación posterior: `forecasts` (15/60/240/1440 min, barreras, MFE/MAE), etiquetada como retrospectiva.

Estrategias/Experimentos
- Lista y detalle: registro S. Backtest/OOS: `/backtest`. Paper: forward (B5).
- Costes: backtest y trades incluyen fees y funding; no se recalcula nada.
- Comparación: tarjetas independientes, sin suma. Curvas de equity solo donde exista serie real (Qwen, Kronos); el resto "pendiente".
- Veredicto estadístico: usar `reliability.verdict` y campos de DSR/overfitting del ranking. No usar el umbral por número de operaciones.

## 5. Plan por fases

Convenciones: rama `claude/project-thread-vinibq` y derivadas por fase; un PR pequeño por
fase (o sub-fase); sin merge sin revisión de Fran; antes de cada PR: `pnpm typecheck`,
`pnpm lint`, `pnpm test`, y `pnpm test:server` si se tocó servidor.

### Fase 0: línea base (sin código)
- `pnpm install`, ejecutar typecheck/lint/test/e2e y registrar el resultado.
- Decidir con Fran: nombre de tokens, qué hacer con el código muerto (Replay) y con las velas sintéticas.
- Aceptación: línea base documentada; los fallos previos conocidos (p. ej. tests de noticias) listados, no corregidos aquí.

### Fase 1: fundamentos visuales (solo front)
- Tokens únicos (`--mc-*`) desde `DESIGN.md`; tipografía; componentes: `AppShell`, `TopBar`,
  `Panel`, `Metric`, `StatusPill`, `DataState` (loading/error/vacío/no disponible).
- Navegación Terminal/Estrategias, ruta `/terminal` explícita (hoy es el caso por defecto).
- Adaptar sin perder funciones: las pantallas actuales se montan en el shell nuevo.
- Dependencias: Fase 0. Riesgo: bajo.
- Aceptación: todas las funciones actuales operativas; e2e en 3 viewports verdes; capturas
  antes/después; ningún cambio en `server/` ni `python/`.

### Fase 2: Terminal
- Extraer `useTerminalStream` y componentes de presentación sin cambiar el protocolo.
- Layout con gráfico protagonista, panel de estado y tabla de historial; reconstruir la vista
  base con posición abierta a partir de `positionLines` y la cuenta publicada.
- Selección bidireccional gráfico↔historial (ya existe `onSelect`; añadir selección desde la tabla y scroll/foco al marcador).
- Dependencias: Fase 1. Aceptación: tests de caracterización del WS intactos; la decisión
  seleccionada pertenece al producto y periodo mostrados; estados de carga/error/sin datos.

### Fase 3: observabilidad
- Backend B1+B2 (+B6 `data_gaps`), solo lectura, con tests y pruebas de carga contra una copia de la base.
- Front: indicador global, desplegable con seis componentes, "sin datos" real, bloque de
  espera prolongada con los contadores y motivos.
- Dependencias: aprobación de B1/B2 por Fran. Aceptación: con captura detenida el
  indicador pasa a advertencia/error aunque el WS siga abierto; sin operaciones y con
  verdicts frescos se muestra "operación normal"; no hay cifras de latencia inventadas.

### Fase 4: investigación
- Backend B3 (y B4 opcional). Front: panel por etapas, etapas no disponibles, evaluación
  posterior separada.
- Aceptación: cada etapa muestra origen y `known_at`; ninguna explicación redactada que no
  salga de un campo del backend; navegación decisión→gráfico y gráfico→decisión.

### Fase 5: estrategias
- Listado, detalle, rendimiento, actividad e historial/backtest sobre el registro actual;
  dividir `StrategyLab.tsx` conservando editor, importar, variantes, estados, versiones, Qwen, Kronos y carry.
- Aceptación: tests actuales de Lab siguen verdes; backtest/OOS/paper rotulados por separado;
  sin velas sintéticas.

### Fase 6: experimentos
- Backend B5. Front: tarjetas independientes, curvas de equity solo con series reales,
  matriz de atribución solo si existe dato, enlaces a Terminal.
- Aceptación: ningún total consolidado; cada cifra con su origen; navegación Estrategias↔Terminal conservando producto y experimento.

## 6. Decisiones que necesitan a Fran

1. ¿Aprobar B1-B3, B5-B6 (solo lectura)? B4 (nuevas tablas de descartes) ¿ahora, después o nunca?
2. Experimentos que mostrará la pantalla de comparación: forward (C29, C30, C32), Qwen, Kronos, C31, carry y los brazos A/B/C (estos hoy fuera del stack dev).
3. Qué es "posición paper actual" del Terminal mientras el libro D esté retirado: forward por estrategia.
4. Eliminar o cablear Replay; quitar velas sintéticas y restos de mock.

## 7. Fuera de alcance

Controles de procesos desde la UI (reiniciar módulos, volcar logs), nuevas estrategias,
cambios en costes o simulador, órdenes reales, cualquier lectura del holdout.
