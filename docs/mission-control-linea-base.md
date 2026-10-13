# Mission Control: línea base técnica (Fase 0)

Fecha: 2026-10-13. Commit base: `bd619c3` (`main`, #122). Rama: `claude/mission-control-fase-0`.
Solo se midió; no se corrigió nada ni se modificó código funcional.

## 1. Entorno de la medición

- Contenedor cloud aislado (Linux, 4 núcleos, Node 22.22.0, pnpm 10.28.0, Python 3.13.16).
  **No** es la Mac de Fran: no hay capturas, forward, Kronos ni colector de libro en este
  contenedor (se comprobó con `pgrep`), no se leyó ninguna base de datos de datos reales y no
  se tocó ningún proceso de trading. Las pruebas no pueden afectar las mediciones de la Mac.
- Dependencias instaladas con `pnpm install --frozen-lockfile` en la raíz y en `server/`
  (lockfile respetado, sin cambios en el árbol; `git status` limpio al terminar).
- `pnpm audit --prod`: sin vulnerabilidades conocidas.
- Diferencia de entorno relevante: en la Mac el Python es el 3.9 de Xcode; aquí 3.13. Los
  resultados de Python no garantizan lo mismo en 3.9.

## 2. Resultados

| Comprobación | Comando | Resultado | Duración |
|---|---|---|---|
| TypeScript (front) | `pnpm typecheck` | Pasa | 7 s |
| TypeScript (servidor) | `pnpm typecheck:server` | Pasa | 4 s |
| ESLint | `pnpm lint` | Pasa | 11 s |
| Prettier | `pnpm format:check` | **Falla**: 54 archivos | 8 s |
| Vitest front | `pnpm test` | Pasa: 20 archivos, 111 tests | 15 s |
| Vitest servidor | `pnpm test:server` | Pasa: 30 archivos, 242 tests | 8 s |
| Python (unittest) | `PYTHONPATH=python python3 -m unittest discover -s python/tests` | **Falla**: 872 tests, 3 errores | 353 s |
| Build | `pnpm build` | Pasa | 10 s |
| Playwright e2e | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium pnpm test:e2e` | **Falla**: 9 pasan, 3 fallan | 32 s |

Notas de ejecución:
- Playwright necesita el Chromium ya instalado en el contenedor; sin esa variable el
  navegador no se encuentra. No se descargó ninguno.
- El primer intento de Python usó `-I` (modo aislado) por error mío: ignora `PYTHONPATH` y
  todos los módulos fallaron al importar `balancita_engine`. Es un error de invocación, no
  del repo; la cifra de la tabla es del comando correcto.
- Los warnings `ExperimentalWarning: SQLite` en los tests de servidor son esperados (`node:sqlite`).

## 3. Fallos y clasificación

### 3.1 Previos al trabajo de Mission Control (en `main` antes de cualquier cambio de este hilo)

**P1. Python: 3 errores en `test_futures_news.py`.** Fixtures inexistentes:
`server/src/features/news/__fixtures__/fed.rss` (y el fixture SEC/Atom) no están en el repo.
- `FeedParsingTests.test_atom_entries_use_the_alternate_link_and_updated`
- `FeedParsingTests.test_real_world_rss_fixtures`
- `IngestTests.test_the_real_sec_fixture_dedupes_a_relative_and_an_absolute_link`
Causa: la memoria del proyecto ya lo registra como conocido (fixtures borrados en #86). No es
del entorno ni de Mission Control. Afecta al módulo de noticias, que no interviene en el stack
de las pantallas nuevas.

**P2. e2e: `estrategias shows the same chips as the terminal when the gateway is up`
(`e2e/screens.pw.ts:207`), falla en los 3 viewports.** El test simula `/api-live/health` con
`capture.last_received_at`, pero `AppStatusChips.tsx:59` lee `capture.lastReceivedAt` y el
gateway real emite `lastReceivedAt` (`market-follower.ts:226`). Con la clave del fixture el
componente no obtiene antigüedad de precio, y el indicador muestra «Con problemas» en vez de
«En vivo». El fallo está en el fixture del test (clave desfasada), no en el comportamiento
real del gateway. Historia del repo aplastada (squash), así que no se pudo ubicar el commit
exacto. Importa para Mission Control: el indicador de salud es el que se va a reemplazar.

**P3. Prettier: 54 archivos sin formato** (por ejemplo
`server/src/platform/config.ts`, `src/app/AppStatusChips.test.tsx`). El formato no se aplica
en el repo y no hay CI. No es un fallo funcional.

### 3.2 Problemas del entorno

**E1.** Playwright: requiere `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (ver notas). Sin ella el
e2e no arranca en este contenedor.
**E2.** Python 3.13 aquí frente a 3.9 en la Mac: los 872 tests no validan la versión de
producción.
**E3.** Una memoria previa del proyecto decía que 3 archivos Vitest no cargaban `ws`/`fastify`
en la nube. En esta medición los 30 archivos del servidor cargan y pasan; si reaparece, es del
entorno de aquel momento, no del código.

### 3.3 Posibles regresiones

Ninguna observada: no se modificó código en este hilo y todos los fallos corresponden a causas
previas descritas arriba. (No hay una medición anterior con la que comparar resultados
numéricos; esta es la línea base.)

## 4. Otros hallazgos útiles para la Fase 1

- Sin CI en `.github`: nada obliga hoy a que lint/format/test pasen antes de mergear.
- Cobertura de e2e: 12 casos (4 × 3 viewports). Solo comprueban altura de listas, chips de
  estado y errores; los screenshots no se comparan. No cubren editor ni paneles de Estrategias,
  que se tocarán en las fases siguientes.
- Sin tests directos: `SelectedDecision`, `TerminalDecisions`, `ApprovedPortfolioTables`,
  `SystemUsageChip`, `ApprovedTradingHeader`, `CarryPanel`, `QwenPanels`, `NewStrategyModal`.
- `ReplayPanel` y `replay-api` tienen test propio pero no se renderizan (código muerto).
- Tiempo de cada comprobación (excepto Python, 6 min) es corto; el conjunto rápido tarda ~1 min.

## 5. Riesgos a resolver antes de empezar la Fase 1

1. **Arreglar o aceptar P2.** Cualquier cambio en la cabecera/chips de estado rompe o enmascara
   este e2e. Propuesta: PR aparte y mínimo que corrija la clave del fixture (`lastReceivedAt`).
   Mientras no se haga, la Fase 1 debe tratarlo como fallo conocido.
2. **Decidir sobre P1.** Restaurar los fixtures de noticias o retirar esos tests; hoy deja la
   suite Python en rojo y oculta regresiones reales entre 872 tests.
3. **Decidir sobre el formato (P3).** Si se activa `format:check` como requisito, hay que
   aplicar Prettier en un commit puramente de formato antes de la Fase 1; si no, el diff de
   Fase 1 se mezclaría con ruido de formato en cualquier archivo que toque.
4. **Sin CI.** Acordar que la línea base de esta página (typecheck, lint, Vitest, servidor,
   build y e2e salvo P2) es el criterio mínimo de cada PR de Mission Control.
5. **Confirmar en la Mac.** La línea base se midió en el contenedor. Si se quiere la misma
   referencia con Python 3.9, tendría que correrse en la Mac con `pnpm dev` parado, o con
   procesos de captura y forward en marcha pero sin competir por CPU (decisión de Fran).

## 6. Cómo reproducir

```
pnpm install --frozen-lockfile && pnpm --dir server install --frozen-lockfile
pnpm typecheck && pnpm typecheck:server && pnpm lint && pnpm format:check
pnpm test && pnpm test:server && pnpm build
PYTHONPATH=python python3 -m unittest discover -s python/tests
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<ruta a chromium> pnpm test:e2e
```
