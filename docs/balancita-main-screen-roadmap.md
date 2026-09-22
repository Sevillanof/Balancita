# Balancita — roadmap canónico de la pantalla principal

## 1. Decisión

Reestructurar Balancita en **exactamente tres fases secuenciales**, cada una
con una sola responsabilidad. Ninguna fase avanza trabajo de la siguiente.

| Fase | Responsabilidad única                                                    |
| ---- | ------------------------------------------------------------------------ |
| 1    | Reproducir la experiencia visual del wireframe con datos mock, sin red   |
| 2    | Reemplazar sólo el gráfico por velas BTC-EUR 1m reales de Kraken         |
| 3    | Reemplazar sólo las noticias por un pipeline de tiempo real del servidor |

Este documento es la única fuente de verdad para el orden de implementación
de la pantalla principal. Reemplaza a
[`docs/balancita-current-stack-evolution.md`](balancita-current-stack-evolution.md)
y a [`docs/balancita-rewrite-fastapi-rust.md`](balancita-rewrite-fastapi-rust.md),
que quedan como análisis histórico.

## 2. Principio: una fase por vez

- No se adelanta trabajo de la fase 2 durante la fase 1, ni de la fase 3
  durante la 1 o la 2.
- Cada fase congela lo aprobado en la anterior: la fase 2 no vuelve a tocar
  el layout aprobado en la fase 1; la fase 3 no vuelve a tocar el layout ni
  el gráfico aprobados en las fases 1 y 2.
- La implementación preserva el stack actual (React + Fastify + Kraken +
  SQLite) salvo bloqueo técnico demostrado y documentado.
- Ninguna fase habilita ejecución automática de órdenes reales.

## 3. Contrato visual

Referencia de escritorio (desktop-first), según el wireframe de
`doc/idea-balancita.md`:

```text
+-------------------------------------------------------------+------------------------+
| A. Marca / título (arriba izquierda)                        | B. Dinero disponible   |
|    Balancita (BTC/EUR)                                       |    (arriba derecha)    |
+-------------------------------------------------------------+------------------------+
|                                                               |                        |
| C. Gráfico dominante (izquierda)                             | D. Noticias (derecha)  |
|    velas BTC-EUR                                              |    lista con fuente    |
|                                                               |                        |
+-------------------------------------------------------------+------------------------+
| E. Comprar / Vender / control automático (abajo izquierda)   | F. Resumen BTC-EUR     |
|                                                               |    (abajo derecha)     |
+-------------------------------------------------------------+------------------------+
```

| Área | Contenido                             | Fase que la define | Fase que la puebla con dato real   |
| ---- | ------------------------------------- | ------------------ | ---------------------------------- |
| A    | Marca/título                          | 1                  | —                                  |
| B    | Dinero disponible                     | 1                  | ya existe (ledger local)           |
| C    | Gráfico dominante                     | 1 (mock)           | 2 (Kraken 1m)                      |
| D    | Noticias                              | 1 (fixtures)       | 3 (pipeline servidor)              |
| E    | Comprar / Vender / control automático | 1                  | paper local; auto fuera de alcance |
| F    | Resumen BTC-EUR                       | 1                  | 2 (deriva de datos reales)         |

Comprar/Vender conserva el flujo de paper trading local ya existente; la fase
1 sólo lo reubica y no rediseña su comportamiento. El control automático es
**sólo presentación**: se muestra deshabilitado y no ejecuta ninguna acción.

Comportamiento responsive: por debajo de un breakpoint de escritorio angosto
(por ejemplo `< 1024px`), la grilla C/D colapsa a una columna manteniendo el
gráfico primero; los controles E/F pasan a una fila scrolleable horizontal,
igual que el patrón `.table-scroll` ya usado en portfolio/trade. Ningún
elemento crítico (precio, botones de acción) queda oculto sin scroll
explícito.

## 4. Fase 1 — Pantalla principal (mock, sin red)

Reproducir el contrato visual de la sección 3 con datos deterministas. No
integra Kraken ni fuentes de noticias reales.

- **Estados sin red**: loading, empty, error y stale se definen y prueban con
  fixtures locales; ningún estado depende de una llamada de red real.
- **Accesibilidad**: navegación por teclado, roles/etiquetas semánticas,
  foco visible, sin saltos de layout entre estados.
- **Pruebas visuales**: capturas de referencia en `1440 × 900` y `390 × 844`,
  además de pruebas de render/a11y por área. En escritorio, las áreas A–F
  deben quedar visibles en el primer viewport, sin solapamientos ni scroll
  vertical obligatorio.
- **Puerta de salida**: aprobación visual explícita del usuario sobre el
  layout resultante. Sin esa aprobación, la fase 2 no comienza.

### Entregables y archivos probables

- `src/app/BtcEurDashboard.tsx` — reorganización a grilla de una pantalla.
- `src/app/dashboard.css` — grid de escritorio + colapso responsive.
- `src/app/intelligence/NewsPanel.tsx` (nuevo) — lista de noticias con
  fixtures, sin llamada de red.
- Control automático deshabilitado junto a Comprar/Vender (componente nuevo
  o extensión del existente en `src/app/trade/`).
- Fixtures de noticias en `src/test/` o equivalente.

### Pruebas RED/GREEN aplicables

- RED: render de cada área (A–F) y de cada estado (loading/empty/error/stale)
  sin implementación → falla.
- GREEN: layout completo con fixtures, estados cubiertos, control automático
  deshabilitado sin handlers activos, cero llamadas de red durante los tests.

## 5. Fase 2 — Gráfico con dato real

Conserva **congelado** el layout aprobado en la fase 1. Reemplaza únicamente
el adapter/fixture del gráfico por velas BTC-EUR 1m de Kraken, usando el
servidor existente. Las noticias siguen siendo fixtures. No se reescribe el
stack.

- **Cobertura obligatoria**: warm-up, actualización, reconexión, gaps/datos
  fuera de orden, distinción vela cerrada vs. provisional, tiempos de
  evento/recepción/visualización, frescura visible y degradación a stale.
- Reutiliza el motor de velas intradía y las semánticas de tiempo/frescura ya
  implementadas en `server/src/intelligence/market/` (fases B y C del
  historial de `docs/implementation-progress.md`); no se reimplementan desde
  cero.

### Entregables y archivos probables

- `src/providers/kraken-market-data.ts` — adaptador de 1m en lugar de velas
  diarias (`OHLC_INTERVAL_MINUTES`).
- `src/app/chart/PriceChart.tsx` — consumo del feed real conservando la
  integración actual de Lightweight Charts.
- Endpoint/stream del servidor ya existente (`server/src/app.ts`,
  `server/src/intelligence/stream.ts`) reutilizado, no reescrito.

### Pruebas RED/GREEN aplicables

- RED: pruebas de límites de vela, warm-up y reconexión con fixtures
  reproducibles → fallan contra el adapter mock previo.
- GREEN: mismas pruebas contra el adapter real, más pruebas de integración
  de UI que verifican que el layout de la fase 1 no cambió.

### Criterio de salida

Frescura visible en pantalla, degradación a stale demostrada con un
fixture/simulación de corte de red, y layout idéntico al aprobado en la
fase 1.

## 6. Fase 3 — Noticias en tiempo real

Conserva **congelados** el layout y el gráfico aprobados en las fases 1 y 2.
Reemplaza únicamente los fixtures de noticias por el pipeline del servidor.

"Tiempo real" significa **ingestión server-side desde fuentes oficiales o
licenciadas** con **push inmediato por SSE**, sujeto a la frecuencia de
publicación/consulta propia de cada fuente. No implica menor latencia que la
fuente original.

Cada ítem de noticia expone seis campos observables: `source`, `URL`,
`publishedAt`, `ingestedAt`, `displayedAt`/frescura y `licenseStatus`.

- **Cobertura obligatoria**: deduplicación y correcciones de ítems ya
  publicados, reconexión, estado stale y manejo de error del stream.
- No se agrega automatización financiera de ningún tipo.

### Entregables y archivos probables

- `src/app/intelligence/NewsPanel.tsx` — consumo del stream real en lugar de
  fixtures.
- `server/src/intelligence/news/` — pipeline ya existente (fase E del
  historial), expuesto a esta pantalla en vez de reimplementado.
- Extensión del stream SSE existente (`server/src/intelligence/stream.ts`)
  para publicar noticias.

### Pruebas RED/GREEN aplicables

- RED: pruebas de proveniencia (los seis campos obligatorios), deduplicación
  y reconexión contra el pipeline real, ejecutadas primero contra los
  fixtures de la fase 1.
- GREEN: mismas pruebas contra el pipeline real; prueba de integración que
  verifica que layout y gráfico no cambiaron.

### Criterio de salida

Cada ítem visible expone sus seis campos observables, la deduplicación
está probada y el stream se degrada a un estado stale/error visible ante un
corte simulado.

## 7. Dependencias entre fases

| Fase | Depende de                        | Bloquea                                |
| ---- | --------------------------------- | -------------------------------------- |
| 1    | Ninguna                           | Aprobación visual habilita la 2        |
| 2    | Layout aprobado (1)               | Verificación de frescura habilita la 3 |
| 3    | Layout + gráfico aprobados (1, 2) | Ninguna fase adicional de este roadmap |

## 8. Fuera de alcance

- Reescritura a FastAPI/Rust (`docs/balancita-rewrite-fastapi-rust.md`).
- Órdenes reales, dinero real, custodia o integración de broker.
- Pronósticos o ejecución automática de estrategias sobre el ledger
  principal.
- Refactor amplio de portfolio/watchlist más allá de lo que este roadmap
  requiere para el layout de la pantalla principal.

## 9. Orden de implementación dentro de cada fase

**Fase 1**: (1) estructura de grilla y áreas A–F, (2) fixtures de datos y
noticias, (3) estados loading/empty/error/stale, (4) accesibilidad y
responsive, (5) pruebas visuales, (6) solicitud de aprobación.

**Fase 2**: (1) adapter Kraken 1m reutilizando el motor intradía existente,
(2) warm-up y actualización, (3) reconexión y gaps/out-of-order, (4)
distinción vela cerrada/provisional y tiempos de evento/recepción/
visualización, (5) frescura visible y degradación stale, (6) verificación de
layout congelado.

**Fase 3**: (1) conexión del panel de noticias al pipeline del servidor, (2)
proveniencia completa por ítem, (3) deduplicación y correcciones, (4)
reconexión/stale/error del stream, (5) verificación de layout y gráfico
congelados.

## 10. Checklist final

- [ ] Fase 1 aprobada visualmente por el usuario antes de iniciar la fase 2.
- [ ] Fase 2 no modifica el layout aprobado en la fase 1.
- [ ] Fase 3 no modifica el layout ni el gráfico aprobados en las fases 1 y 2.
- [ ] Cada noticia mostrada expone sus seis campos observables.
- [ ] Ninguna fase habilita ejecución automática de órdenes reales.
- [ ] `pnpm test`, `typecheck`, `lint`, `build` y `format:check` quedan en
      verde al cerrar cada fase.

## 11. Siguiente paso

Implementar únicamente la fase 1, tras una autorización separada y explícita
del usuario para pasar de documentación a implementación.
