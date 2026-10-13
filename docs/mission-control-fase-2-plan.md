# Mission Control, Fase 2: Terminal (plan detallado)

Estado: plan aprobado por Fran el 2026-10-13 con los ajustes de §6; sin código. Parte de `docs/mission-control-viabilidad.md` (§0.1 y Fase 2) y del
estado de `main` tras la Fase 1 (#132). Solo front: sin cambios en `server/`, `python/`, estrategias,
contabilidad ni comportamiento del trader. Los backend B1-B6 no entran aquí.

## 1. Reglas innegociables de la fase

1. **WebSocket y resync intactos.** El protocolo (`subscribe`/`resume`, `snapshot`, `resync.required`,
   salto de `seq`, deduplicación por `event_id`, backoff 500 ms a 10 s, `paper.command`) no cambia.
   La extracción a un hook es un movimiento de código, sin reescritura.
2. **Histórico no es actual.** Nada del libro D retirado ni de un run anterior se muestra como estado
   actual. Si no se puede determinar si hay posición abierta: «No disponible», nunca «sin posición».
3. **Origen, experimento y frescura** visibles en cada bloque con datos.
4. Sin cálculos financieros nuevos en la UI; sin cifras inventadas de las maquetas (§2 del informe).
5. Mejoras pendientes de Fran que **no** son de esta fase: indicador desplegable de salud (Fase 3) y
   editor de Estrategias (Fase 5).

## 2. Mapa de `FuturesTerminal.tsx` (1021 líneas, verificado)

| Bloque                                                           | Líneas   | Estado hoy                            |
| ---------------------------------------------------------------- | -------- | ------------------------------------- |
| Efecto WS + resync (deps `[bootstrap, apiBase, product]`)        | 79-252   | Inline en el componente               |
| `sendCommand` (exige socket OPEN, `expected_state_version`)      | 392-410  | Inline                                |
| Reloj 1 s y `/health` cada 10 s (solo `paper_live`)              | 354-379  | Inline                                |
| `flowInputs`, `statusItems`, `diagnosis`                         | 380-529  | Inline; alimentan `AppStatusChips`    |
| Strip de mercado                                                 | 556-609  | Inline                                |
| `ApprovedTerminalLayout` (gráfico + decisiones)                  | 618-749  | Presentacional, 18 líneas             |
| `TerminalMarketChart` / `TerminalDecisions` / `SelectedDecision` | 619-671  | Componentes propios, con muchas props |
| Bloque «Análisis seleccionado»                                   | 673-746  | Inline                                |
| Controles simulados                                              | 752-871  | Inline                                |
| Cuenta paper                                                     | 872-939  | Inline                                |
| `ApprovedPortfolioTables` (posición abierta y órdenes/fills)     | 940-1014 | Presentacional                        |

Lo de 750-1016 se oculta cuando `engineOff`.

### Hallazgo que condiciona la fase

La Terminal **no separa hoy** lo histórico de lo actual. «Cuenta paper» (saldo, patrimonio, PnL),
«Posición abierta» y «Órdenes y ejecuciones» muestran el estado del run del gateway sin etiqueta de
origen ni de antigüedad; la posición abierta usa un único `position`, y `positions` (una por book)
solo llega al gráfico. No existe ninguna etiqueta «Histórico» ni «forward» en la superficie de la
Terminal (solo «operaciones forward» de Kronos dentro del chip de diagnóstico). La separación que
Fran exige es por tanto **trabajo nuevo de esta fase**, no una conservación.

## 3. Qué se reutiliza

Sin cambios o con cambios mínimos:

- Lógica pura con tests: `terminal-stream-client`, `terminal-state`, `terminal-batch`,
  `terminal-decisions`, `terminal-market`, `terminal-flow`, `terminal-labels`, `terminal-chart-model`.
- Presentacionales: `ApprovedTerminalLayout`, `ApprovedPortfolioTables`, `TerminalDecisions`,
  `SelectedDecision`, `ApprovedTerminalChart`, `TerminalChartPanel`.
- Fase 1: `AppShell`, `TopBar`, `Panel`, `Metric`, `StatusPill`, `DataState`.
- `AppStatusChips` y `SystemUsageChip` siguen en el slot de estado de la barra superior.

A extraer porque están acoplados al padre: strip de mercado, controles simulados, cuenta paper,
bloque «Análisis seleccionado», y toda la lógica WS.

## 4. Textos y testids que no se pueden romper sin migrar sus tests

Vitest (`FuturesTerminal.test.tsx`, 1530 líneas, usa dos stubs de WebSocket) y e2e (`e2e/screens.pw.ts`)
dependen de: regiones «Decisiones del motor», «Análisis seleccionado», «Controles simulados»,
«Posiciones y operaciones»; textos «Último trade público · USD/BTC», «Financiación: desconocida»,
«Motor paper: en marcha», «Comando no aplicado: superseded», «Run: child-run», «WAIT ×N»; botones
«Pausar entradas (MOCK)», «Reanudar entradas (MOCK)», «Nueva cuenta/run (MOCK)», «Confirmar nueva
cuenta»; testids `flow-status`, `switch-slot`, `approved-chart-renderer`, `approved-terminal-layout`,
`approved-portfolio-tables`. Regla: los PR de movimiento de código (2.1 y 2.2) no cambian ninguno; los
PR que sí cambian un texto actualizan su test en el mismo PR y lo dicen en la descripción.

## 5. División en PR pequeños

Cada PR sale de `main` actualizado (no se apilan), pasa los 5 jobs de CI y queda sin merge hasta la
aprobación de Fran. Orden:

**2.1. Caracterización del WS (solo tests).** Antes de mover nada, inventariar qué escenarios de
protocolo ya cubren `FuturesTerminal.test.tsx`, `terminal-stream-client.test.ts` y `terminal-state.test.ts`,
y añadir los que falten sobre el comportamiento actual: `resume` tras reconexión, `resync.required` ⇒
cierre y `subscribe` completo, salto de `seq`, duplicados, run ajeno rechazado salvo `awaitingNewRun`,
backoff. Sin tocar producción. Si ya está todo cubierto, el PR lo documenta y se omite.

**2.2. Extraer `useTerminalStream` (movimiento puro).** Mismas dependencias del efecto, mismos
estados (`state, connected, error, commandPending, commandStatus, commandVersion, activeRunId`) y mismo
`sendCommand`. Criterio: diff de comportamiento nulo, todos los tests del 2.1 y los previos sin editarse.

**2.3. Extraer bloques de presentación (movimiento puro).** `MarketStrip`, `PaperAccountPanel`,
`SelectedAnalysis`, `SimulatedControls` como componentes con props explícitas, mismos textos, roles y
testids. Sin tocar estilos más que lo necesario.

**2.4. Procedencia: origen, experimento y frescura.** Componente `DataProvenance` (solo presentación)
que recibe origen y `known_at` ya existentes en los datos y los muestra; «No disponible» donde no existan.
Se etiquetan como «Histórico» el equity, las posiciones y las órdenes de un run cerrado o del libro D, y
la posición actual pasa a «No disponible» cuando la fuente no se puede verificar (mientras no exista
forward vía B5). Criterios de aceptación: (a) datos del libro D o de un run anterior nunca se renderizan como actuales;
(b) las decisiones de otros productos o períodos no contaminan el gráfico seleccionado: marcadores,
líneas de entrada/stop/objetivo y selección se filtran por producto y ventana visibles, con test que
mezcla decisiones de dos productos y de períodos distintos y comprueba que el gráfico solo recibe las
del seleccionado; (c) ningún estado ni timestamp que el backend no proporcione.

**2.5. Reorganización visual de la Terminal según Stitch.** Mayor protagonismo del gráfico y nueva
disposición de los bloques; solo CSS y composición con los componentes del 2.3. Capturas antes/después
en 3 viewports.

**2.6. Simplificación del panel de decisiones.** Presentación de `TerminalDecisions` y
`SelectedAnalysis`: jerarquía, agrupación de WAIT, eliminar ruido visual. Sin cambiar qué se decide ni
los datos mostrados, y sin explicaciones que no salgan de un campo real.

**2.7. Selección gráfico↔historial.** Verificar que la selección por marcador y por fila ya sincroniza
(`onSelect`, `selectedId`) y cerrar solo los huecos, con tests.

Todos los PR van en serie. 2.2 y 2.3 se ejecutan de forma secuencial (ambos tocan `FuturesTerminal.tsx`): 2.3 parte de `main` con 2.2 ya integrado.

## 6. Decisiones de Fran (2026-10-13), vinculantes para 2.4 y 2.3

1. **Posiciones y cuenta paper.** Se conserva la información del gateway, con origen, run y
   antigüedad bien identificados. Los datos del libro D retirado se muestran como históricos, nunca
   como posiciones actuales. Mientras no exista B5, el bloque de posiciones actuales dice «No
   disponible» si no hay fuente verificable. La información antigua no se oculta: pasa a un apartado
   secundario de historial o diagnóstico. No se inventan estados ni timestamps que el backend no da.
2. **Controles simulados.** Misma funcionalidad, confirmaciones y restricciones, pero en una sección
   secundaria llamada «Herramientas de simulación». Identifican claramente el run sobre el que actúan,
   no controlan experimentos forward y no se presentan como controles generales del trader. Los
   textos de los botones y regiones que usan los tests solo cambian en el PR que migra esos tests (2.3
   o 2.5, según dónde se mueva la sección) y se declara en su descripción.
3. **Implementación.** Se conservan los siete PR; 2.2 y 2.3 en secuencia; criterio de 2.4 corregido
   como arriba.
4. **2.1.** Primero verificar qué casos ya están cubiertos y no duplicar; PR pequeño solo de tests, sin
   tocar código de producción. Sin merge automático y sin avanzar a 2.2 hasta que Fran revise 2.1.

Prioridad absoluta: preservar el funcionamiento actual del trader.

## 7. Riesgos y mitigación

| Riesgo                                                 | Mitigación                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Romper resync al extraer el hook                       | 2.1 antes de 2.2; el hook conserva el efecto y sus dependencias literales    |
| Cambio de dependencias del efecto ⇒ reconexiones       | Test que cuenta aperturas de socket al re-renderizar con las mismas props    |
| Textos/regiones usados por tests                       | §4; los movimientos puros no los tocan                                       |
| Presentar histórico como actual                        | 2.4 con test de no-regresión; «No disponible» por defecto                    |
| Rediseño que oculte funciones (controles, diagnóstico) | Checklist de funciones de la Terminal en la descripción de 2.5               |
| Peso de `FuturesTerminal.test.tsx` (1530 líneas)       | No se reescribe; solo se añaden tests nuevos o se mueven junto a lo extraído |
