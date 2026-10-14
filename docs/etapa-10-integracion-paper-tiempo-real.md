# Etapa 10: integración paper en tiempo real (diseño de contratos)

Estado: **solo diseño, nada implementado**. Fecha: 2026-10-13. Base: `main` en bacd2d1 (Etapa 8 completa, B1 y B2 fusionados, Terminal con salud #148). Documentos que lo sustentan: [paper-runner-arquitectura.md](paper-runner-arquitectura.md) (D1-D8 y garantías de 8C), [paper-runner-8c-informe.md](paper-runner-8c-informe.md), [observabilidad-salud-api.md](observabilidad-salud-api.md), [observabilidad-actividad-api.md](observabilidad-actividad-api.md), [resiliencia-conexiones.md](resiliencia-conexiones.md) y [mission-control-viabilidad.md](mission-control-viabilidad.md).

**Estado tras la auditoría conjunta (2026-10-14).** La dirección de este documento está aprobada para **diseño y pruebas aisladas**, no para funcionamiento desatendido. Quedan fijados: fuente = la captura existente (sin cliente Kraken propio); estrategias = C29/C30/C32 congeladas, en una sesión de integración separada (`mode = integration`, `evidence_class = not_forward_evidence`); cartera experimental separada, que no sustituye los 100 USD fijos del forward ni toca el ADR; sin proceso persistente en la Mac; sin órdenes reales. **Sin reducción del journal de cotizaciones por ahora** (ver §9 G2): el muestreo cada 30 s de la primera versión queda retirado como propuesta. La marca de agua de 2 s es una hipótesis a probar, no un parámetro aprobado. Detener el reloj cuando cae la captura necesita pruebas que distingan caída del proveedor de datos de un mercado sin cotizaciones (§3.3 punto 4 y `python/tests/test_paper_live_ingest.py`). 9A corrió con `mx-*` y no con C29/C30/C32: el evaluador y la selección de estrategias de la sesión viva no se definen aquí (§3.4, §10).

Solo paper, datos públicos de Kraken, sin órdenes reales, sin credenciales. Este documento no abre conexiones, no lanza procesos y no modifica forward, `capture`, Kronos, Qwen, estrategias congeladas, parámetros de riesgo ni el ADR 0001.

## 1. Objetivo y alcance

Recorrido a definir:

```
Kraken ─► [captura existente] ─► market.sqlite ─► INGESTOR ─► PaperRunner ─► Journal ─► publicación ─► Gateway API ─► Terminal
 (público)   (no cambia)        (solo lectura)    (nuevo)    (Etapa 8)    (durable)   (nuevo)         (nuevo)     (Mission Control)
```

Qué entrega esta etapa: los **contratos** (entradas del runner, archivos publicados, endpoints, estados, alertas), la lista de **componentes reutilizables**, los **adaptadores** que faltan, la **recuperación** ante cada tipo de desconexión y las **condiciones de una sesión desatendida**. Qué no entrega: ninguna conexión operativa, ningún proceso, ninguna ruta nueva en el gateway.

Lo que la sesión en vivo **no es**:

- **No es un segundo motor de trading.** Es el mismo `PaperRunner` de la Etapa 8 (que solo coordina y no tiene reglas propias) alimentado por el mundo real en lugar de por eventos sintéticos.
- **No reemplaza ni interfiere con el forward.** El forward (`futures_forward.py`) sigue siendo la evidencia de las 100 operaciones de C29/C30/C32/Kronos. La sesión de esta etapa es una **sesión de integración con identidad propia** (§3.5): sus operaciones nunca se suman al forward.
- **No abre conexiones a Kraken.** Lee lo que la captura ya guardó (decisión A1, §3.1).

## 2. Qué hay hoy y qué se reutiliza

### 2.1 Componentes reutilizables (sin cambios)

| Responsabilidad                                                | Componente existente                                                                                                                               | Uso en la sesión en vivo                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Datos públicos de Kraken (WS + REST)                           | `capture` (`live-capture.ts`, `futures-market.ts`, `ticker-poll.ts`, `official-candles.ts`, `market-analytics.ts`) escribe `futures-market.sqlite` | única fuente de mercado; el ingestor la **lee** en modo solo lectura                     |
| Resiliencia de la captura                                      | vigilante WS, `fresh-fetch.ts`, `connection-health.ts`, `resilience.jsonl`, tabla `paper_futures_data_gaps`                                        | su evidencia se **consume** (huecos, incidentes) para etiquetar cobertura; no se duplica |
| Archivo de bid/ask                                             | `quote-archive.ts` (`quote_snapshot`, `quote_archive_gap`)                                                                                         | fuente alternativa y retención más larga que los 24 h de tickers                         |
| Coordinación, journal, checkpoint, lock, offsets, recuperación | `PaperRunner`, `paper_runner_store.py` (`FileRunnerJournal`, `OffsetLedger`, `DirectoryLock`)                                                      | **tal cual**: la entrada es `PaperRunner.handle(evento)`                                 |
| Ejecución causal por cotización                                | `TimedExecutor` + `QuoteWatch`                                                                                                                     | es el ejecutor de la sesión en vivo (cotizaciones observadas, no precios modelados)      |
| Cartera, costes, funding, auditoría                            | `Portfolio`, `futures_costs`, `portfolio_funding`, `portfolio_audit`                                                                               | sin cambios                                                                              |
| Estrategias y señales                                          | `signal_continuity.evaluate_cycle`, `SignalLog`, `multi_signals`, `futures_simulator.frames`                                                       | las mismas versiones congeladas, solo lectura del registro                               |
| Contrato de lectura                                            | `paper_runner_report.observability` (`balancita-paper-runner-report.v2`)                                                                           | base del archivo publicado (§5.1)                                                        |
| Observabilidad del gateway                                     | B1 (`observability-health.ts`), B2 (`observability-activity.ts`), caché de 15 s, lectura `readOnly`                                                | patrón a copiar; B1 y B2 reciben un componente más (§5.4)                                |
| Terminal                                                       | `useTerminalStream`, `terminal-stream-client.ts`, `FuturesTerminal.tsx`, etiquetas `observed/simulated/estimated/uncertain`                        | solo consumidor; Mission Control es dueño del front                                      |

### 2.2 Lo que **no** existe y hay que construir (resumen; detalle en §9)

1. **Ingestor**: lee `market.sqlite` y emite eventos del runner (§3).
2. **Evaluador en vivo** de ciclos de 5 min con el mismo pipeline de indicadores que el forward (hoy el runner solo conoce `minimal_evaluator`, que es sintético) (§3.4).
3. **Proceso de sesión** que une ingestor y runner, con heartbeat y publicación atómica del informe (§4).
4. **Contratos de publicación y endpoints** del gateway (§5).
5. **Máquina de estados operativa** de la sesión (más amplia que la del runner) y su catálogo de alertas (§7).
6. **Procedimiento de sesión desatendida**: pre-vuelo, guardas, parada (§8).

## 3. Ingestor: adaptadores de entrada

### 3.1 Decisión A1: leer la captura, no hablar con Kraken

| Opción                                                                                                                             | Costo                                                                                                      | Riesgo                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 (recomendada)**: el ingestor lee `market.sqlite` (y `quote_snapshot`) en solo lectura, como ya hacen B1, B2 y `quote-archive` | cero conexiones nuevas; los datos que ve el runner son los mismos que ven forward y Terminal; reproducible | depende de que la captura esté viva (se mide y se declara, §6); latencia de lectura añadida                                                                                |
| A2: cliente propio de Kraken WS/REST dentro de la sesión                                                                           | independiente de la captura                                                                                | segunda conexión y segundo conjunto de reglas de resiliencia; datos distintos a los del forward; viola la restricción de no abrir conexiones y duplica `connection-health` |

Con A1 el ingestor es un lector con tres cursores durables (uno por stream) y ninguna lógica de red. Lectura: `file:...?mode=ro` + `PRAGMA query_only=ON`, consulta acotada por cursor, conexión abierta y cerrada por lote (patrón de B1/B2). Nunca escribe en la base de la captura, nunca cambia su retención.

### 3.2 Mapeo de fuentes a eventos del runner

El sobre es `make_event(kind, payload, t_ms, source, stream, source_offset, source_epoch)`. `source` es siempre `kraken-capture` (es lo que identifica de dónde salió; el dato original es público de Kraken). `|` y `#` no se admiten en nombres, `:` sí.

| Evento       | Origen en la base de la captura                                                                                           | `stream`              | `source_offset`                                                                                                                                 | `source_epoch`     | `t_ms` (llegada)                                                           | Payload                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `quote`      | `paper_futures_market_events` con `feed='ticker'` (`normalized_json`: bid, ask) y, para retención larga, `quote_snapshot` | `ticker:<PRODUCTO>`   | ninguno (`null`): el `seq` de los tickers **no** es contiguo (§9 G3); la deduplicación va por `event_id` y los silencios se detectan por tiempo | `epoch` de la fila | `persisted_at` (§3.3)                                                      | `product_id`, `bid`, `ask`, `time_ms` (`event_time`), `received_ms` (`received_at`) |
| `candle` 1 m | `paper_futures_official_candles`, `interval_ms=60000`, **primera revisión** por `known_at`                                | `candle1m:<PRODUCTO>` | `bucket_start / 60000` (contiguo por construcción: un hueco es un hueco real)                                                                   | 0                  | `max(known_at, bucket_start + 60 s)`                                       | `product_id`, `bucket_ms`, `candle` (OHLC)                                          |
| `candle` 5 m | ídem, `interval_ms=300000`                                                                                                | `candle5m:<PRODUCTO>` | `bucket_start / 300000`                                                                                                                         | 0                  | `max(known_at, bucket_start + 300 s)`                                      | ídem; alimenta al evaluador, no a la cartera                                        |
| `cycle`      | **generado por el ingestor** al cierre de cada barra de 5 m, a partir de las velas (§3.4)                                 | `cycle:<PRODUCTO>`    | `bucket_start / 300000`                                                                                                                         | 0                  | instante en que la vela de 1 m que cierra la barra llegó                   | `product_id`, `cycle_ms`, `price`, `atr` (strings)                                  |
| `funding`    | `paper_futures_funding_periods`                                                                                           | `funding:<PRODUCTO>`  | índice horario del período (`start / 3600000`)                                                                                                  | 0                  | `max(persisted, start + 1 h + 10 min)` (misma espera que `FundingContext`) | `product_id`, `periods`                                                             |
| `reconcile`  | generado al terminar cada hora                                                                                            | `reconcile:main`      | índice horario                                                                                                                                  | 0                  | fin de hora + 10 min                                                       | `{}`                                                                                |
| `clock`      | generado por el ingestor (§3.3)                                                                                           | `clock:main`          | ninguno                                                                                                                                         | 0                  | marca de la fuente                                                         | `{}`                                                                                |

Reglas del mapeo:

- **Una vela nunca llega antes de cerrar.** `candle_not_closed` ya la rechaza, pero el ingestor ni siquiera la emite antes de `bucket + intervalo`.
- **Primera revisión gana.** La tabla de velas admite varias revisiones por bucket (`revision_hash` en la clave primaria; la captura las conserva como evidencia inmutable). El runner acepta una sola por `(producto, bucket)` y rechaza la distinta como `conflicting_candle`. El ingestor emite la de menor `known_at` (la que un observador vivo habría visto) y registra las posteriores como observación `candle_revised` (alerta informativa, §7.3), sin aplicarlas. Una revisión posterior **no** reescribe operaciones ya cerradas: se informa como incertidumbre.
- **Producto desconocido o fuera del universo congelado** (8 `PF_*`): se descarta en el ingestor y se cuenta; no llega al journal.
- **Datos inválidos** (bid/ask invertidos, precio ≤ 0, `received_at < event_time`): el runner ya los rechaza (`invalid_quote`, `invalid_candle`) y consumen su offset. El ingestor no los corrige ni los filtra: el rechazo queda en el journal como evidencia.

### 3.3 Orden, marca de agua y reloj

El runner exige `t_ms` no decreciente sobre **todos** los eventos (I6: lo atrasado se rechaza, nunca se reordena). Con ocho productos y cuatro tipos de flujo salen de tablas distintas, escritas por procesos con distintos retrasos. Un ingestor ingenuo que lea tablas por separado produciría rechazos `out_of_order_event` y pérdida silenciosa de datos. Diseño:

1. **El tiempo de llegada es el de la fuente, no el del reloj de pared.** `t_ms = persisted_at` (o `known_at`) de la fila origen. Es determinista y reproducible desde la base. El reloj de pared nunca entra en el journal.
2. **Marca de agua.** El ingestor mantiene, por stream, el último tiempo leído y solo emite eventos con `t ≤ watermark = min(últimos tiempos de los streams vivos) - ingest_hold_ms`. `ingest_hold_ms` (valor inicial propuesto: 2 000 ms, **hipótesis a medir**, igual que la espera de asentamiento de las velas) cubre filas confirmadas con retraso. Una fila que llegue por debajo de la marca de agua ya emitida **no se descarta en silencio**: se cuenta en `late_source_rows` y dispara la alerta `ingest_late_rows` con el detalle (producto, stream, adelanto).
3. **Un stream mudo no frena a los demás para siempre.** Se define "vivo" por stream: sin filas nuevas durante `stream_dead_after_ms` (ticker: 45 s, el mismo umbral del vigilante de la captura; vela de 1 m: 180 s, el de la puerta de frescura del forward) deja de contar para la marca de agua y se declara `stream_silent` (§7.3). Es una decisión de **cobertura**, no de datos: lo que esos streams traigan después entra en orden o se rechaza y se cuenta.
4. **`clock` solo avanza con evidencia de que la captura está viva.** Un heartbeat `clock` cada 5 s del tiempo de la fuente, emitido únicamente si al menos el ticker de BTC (o el stream de mayor liquidez vivo) y la propia captura (`dev-health.json`, `updated_at_ms`) están frescos. Si la captura está caída **el reloj del runner se detiene**: no se vencen órdenes ni se cierran ventanas por una caída que no es del mercado. Esto tiene un costo que se discute en §6 (fila "captura caída"). **Regla de distinción (probada en 10B con datos sintéticos):** la fuente está caída solo si **ningún** stream avanza (todos los productos) durante `stream_dead_after_ms`; si un producto calla y otros avanzan, es mercado mudo de ese producto, el reloj sigue y las órdenes de ese producto pueden vencer por `no_quote_in_window`. Un `clock` nunca se emite con la fuente caída.

El `t_ms` del sobre (llegada al runner) y el `received_ms` de la cotización (llegada a la captura) son dos cosas distintas y el contrato las separa: la ventana de ejecución del `TimedExecutor` usa `received_ms`; el orden del runner usa `t_ms`.

### 3.4 Evaluador en vivo (el hueco más importante)

`PaperRunner` recibe un `cycle` con `price` y `atr` y llama a un `evaluator(strategies, payload)`. Hoy el único evaluador es `minimal_evaluator` (un cuadro sintético con `candidate_close`). Las estrategias congeladas necesitan el cuadro completo (`current`, `trend`, `regime`, percentil de funding `fundpct`) que produce `futures_simulator.frames()` a partir de velas de 1 m y 5 m con indicadores incrementales.

Contrato propuesto del evaluador en vivo (`LiveFrameEvaluator`):

- Mantiene `IncrementalFeatures` de 1 m y 5 m **alimentados por las mismas velas que el runner aceptó** (no lee la base por su cuenta: sale de los eventos `candle` ya admitidos, así lo que ve la estrategia es lo que está en el journal).
- **Calentamiento declarado**: antes de la primera decisión, reproduce las velas históricas previas (de `official_candles`, primera revisión, hasta el instante de inicio de sesión) con la misma función que el replay de 9A. Duración mínima: la mayor ventana de indicadores más 30 días de funding para `fundpct` (`FundingContext` exige 30 días). Un calentamiento incompleto deja la sesión en `WARMING_UP` y **no emite ciclos accionables**.
- **Recuperable**: el estado del evaluador es función de las velas aceptadas; tras una caída se reconstruye con el calentamiento más el journal. No se serializa (D2: sin snapshots ni `pickle`).
- **Misma condición de ciclo que el forward** (`signal_continuity.on_cycle`: último minuto de la barra de 5 m, indicadores listos) y mismo pipeline: debe ser **el mismo código que usa 9A en el replay**, no una copia. Si el evaluador vivo y el de replay no son el mismo módulo, un replay no demuestra nada sobre la sesión viva. Dependencia con 9A (§10).
- **Identidad del evaluador**: su hash de código y el del generador de frames entran al manifiesto del runner (ya lo exige el diseño de 9A, correcciones 7). Cada ciclo guarda el hash de `price`, `atr` y `fundpct` entregados.

### 3.5 Qué estrategias y qué cartera ve la sesión (aprobado para diseño y pruebas aisladas)

Las estrategias activas ya corren en el forward. Si la sesión en vivo ejecuta C29/C30/C32 otra vez, produce operaciones **duplicadas** de las mismas señales, con otro modelo de ejecución (cotizaciones observadas y cartera compartida de 1 000 USD con `PortfolioPolicy`, no los 100 USD fijos del forward). Eso no es un segundo motor, pero sí una segunda contabilidad de las mismas ideas, y mezclarla con las 100 operaciones del forward contaminaría la evidencia.

Decisión (auditoría 2026-10-14): **sesión de integración** (`mode = integration`, `evidence_class = not_forward_evidence`):

- Las mismas versiones congeladas (id, versión, `code_hash`, `pipeline_hash` del manifiesto), leídas del registro sin modificarlas.
- Directorio propio, journal propio, nunca la base del forward.
- Cada superficie (Terminal, API, informe) la rotula **"Sesión de integración (paper, no es evidencia del forward)"**.
- Sus resultados prueban integración, consistencia, latencia y recuperación; **no rentabilidad**. Misma lectura que el informe de 8C.

Es un experimento aislado: no sustituye el régimen del forward ni modifica el ADR (cambiarlo requiere autorización expresa de Fran). Roza dos reglas de `AGENTS.md`: C25-C31 y Kronos no se modifican hasta las 100 operaciones forward (la sesión no los modifica, solo los ejecuta aparte), y el ADR fija 100 USD por operación (el dimensionamiento de `Portfolio` es el de la cartera compartida, distinto, registrado solo como trabajo futuro en `docs/plan-observacion-forward.md`).

### 3.6 Cursores, idempotencia y reinicio del ingestor

- Un cursor por stream, derivado del **journal del runner** (el `OffsetLedger` ya sabe qué offset está procesado por `(source, stream, epoch)`): el ingestor no tiene estado durable propio. Tras reiniciar, pregunta al runner el offset contiguo confirmable de cada stream y retoma desde el siguiente. Cero estado adicional que pueda divergir.
- El runner ya deduplica por `event_id` (mismo contenido: ignorado y contado; distinto contenido: conflicto y nunca reemplaza) y por offset reutilizado. Releer filas ya procesadas es seguro.
- `event_id` determinista: hash de `(kind, source, stream, epoch, offset, t_ms, payload)` (el valor por defecto de `make_event`).
- Cambio de época de la fuente (la captura reinició su numeración): el ingestor sube `source_epoch`; una época vieja se rechaza (`stale_epoch`), como en 8B.

## 4. Proceso de sesión (topología)

Un solo proceso Python, `paper_live_session` (módulo nuevo, CLI), que contiene el ingestor y el `PaperRunner` en el mismo lazo. Motivos: el runner es Python y tiene lock de un solo escritor; evita IPC entre procesos; una sola unidad que supervisar.

```
paper-session/<run_id>/
  runner.lock                  # DirectoryLock (8B), un solo escritor
  runner-journal.jsonl         # verdad durable (8B/8C)
  signals.jsonl                # SignalLog
  runner-checkpoint.json       # verificación
  quarantine/                  # evidencia (8B)
  session-manifest.json        # identidad de la sesión (§5.2), escrito una vez
  report.json                  # informe publicado (§5.1), reemplazo atómico
  heartbeat.json               # vivo/estado/marcas de agua (§5.3), reemplazo atómico
  ingest-state.json            # contadores del ingestor (solo informativo, no es verdad)
```

- **Ciclo de vida.** `create` (sesión nueva) o `recover` (reanudación tras caída; con el reloj de recuperación, D4/D7); lazo de lectura → `handle` → checkpoint periódico → publicación. Parada ordenada con `close()`.
- **Dónde corre.** Por defecto **no** dentro de `pnpm dev`: un proceso persistente sin autorización es lo que se prohíbe hoy. Cuando se autorice, un lanzador aparte (patrón de Kronos / plantilla launchd de #114), no el supervisor de `dev.mjs`, para que una caída de la sesión no toque a `capture`/`forward` ni al revés. Decisión 10 (§12).
- **Aislamiento.** Solo lee la base de la captura (`mode=ro`), el registro de estrategias y la configuración; solo escribe dentro de su directorio. No usa los puertos de la captura, no toma sus locks, no escribe en las bases del forward.
- **Costo.** El replay del journal es O(n) (decisión D2 de 8B). Para una sesión de días a semanas es aceptable; el umbral en que hace falta una optimización medible queda fijado como **criterio de aceptación de 10B** (tiempo de recuperación ≤ umbral acordado con un journal de N eventos sintéticos al ritmo real: 8 productos × 1 ticker/s ≈ 700 000 eventos por día). El journal del runner guarda cada cotización aceptada: su tamaño diario es una **brecha abierta** (§9 G2) que condiciona la política de cotizaciones.

## 5. Contratos entre backend y frontend

Principio: el gateway **no** ejecuta Python ni interpreta el journal. Lee archivos que la sesión publica de forma atómica, exactamente como B1/B2 leen bases en solo lectura. Si el archivo no existe, no es legible o está viejo, el gateway lo dice (`unavailable` / `stale`), nunca inventa ni usa un valor anterior como si fuera actual (criterio ya fijado en `mission-control-fase-2-plan.md`: datos de un run anterior nunca se renderizan como actuales).

### 5.1 `report.json` (`balancita-paper-session-report.v1`)

Envuelve `balancita-paper-runner-report.v2` sin reinterpretarlo:

```jsonc
{
  "schema": "balancita-paper-session-report.v1",
  "run_id": "…",
  "manifest_hash": "…",
  "generated_at_source_ms": 1791030000000, // reloj de la fuente (el del runner)
  "generated_at_wall_ms": 1791030002100, // solo para medir antigüedad en el gateway
  "journal": { "entries": 1234, "head": "…", "checkpoint_upto_seq": 1230 },
  "runner": {
    /* paper_runner_report.observability(runner): state, alerts, sections observed|simulated|estimated|uncertain, audit */
  },
  "session": {
    "state": "LIVE", // §7.1
    "mode": "integration",
    "evidence_class": "not_forward_evidence",
    "execution_class": "observed_quotes", // vs MODELLED_EXECUTION de 9A (§10)
    "alerts": [/* catálogo §7.3, con severidad, desde cuándo, detalle */],
  },
  "ingest": {
    "streams": [
      {
        "stream": "ticker:PF_XBTUSD",
        "state": "alive|silent|dead",
        "last_source_ms": 0,
        "last_offset": 0,
        "epoch": 0,
        "lag_ms": 0,
      },
    ],
    "watermark_ms": 0,
    "hold_ms": 2000,
    "counters": {
      "emitted": 0,
      "late_source_rows": 0,
      "dropped_unknown_product": 0,
      "candle_revisions_seen": 0,
    },
  },
  "positions": [/* §5.4: B5 */],
  "intervals": [/* §5.5: B3 */],
}
```

Reglas:

- Cada dato conserva su clase (`observed`, `simulated`, `estimated`, `uncertain`) tal como la entrega el runner. El gateway no cambia clases ni calcula cifras financieras (cero cálculo en la UI y en el gateway, criterio ya vigente en MC).
- Escritura: temporal + `fsync` + `rename` + `fsync` del directorio (`write_atomic`). El gateway nunca ve un archivo a medias.
- Cadencia: cada 5 s si hubo cambio, y siempre tras un `checkpoint`, un evento de alerta o un cambio de estado. El informe completo crece con la cartera, no con el journal; un tope de tamaño y de filas (`trades`, `orders`) con `truncated` explícito es obligatorio, igual que `by_reason` en B2.
- `generated_at_wall_ms` no es dato financiero: sirve para que el gateway distinga "la sesión dejó de publicar" de "el mercado está quieto".

### 5.2 `session-manifest.json` (`balancita-paper-session-manifest.v1`)

Se escribe una vez al crear la sesión: `run_id`, `started_source_ms`, manifiesto del runner (estrategias con `code_hash`/`pipeline_hash`, políticas con hash, `cost_model_hash`, `build_identity`, `engine_behavior`, `evaluator_hash`), versión del ingestor, `hold_ms`, `stream_dead_after_ms`, y la etiqueta `policy_status: experimental` de las políticas de ejecución, vigilancia, cobertura y marca de agua. Es lo que la Terminal muestra como "qué está corriendo".

### 5.3 `heartbeat.json` (`balancita-paper-session-heartbeat.v1`)

Liviano (< 1 KB), cada 5 s aunque no haya eventos: `pid`, `run_id`, `state`, `wall_ms`, `source_ms`, `watermark_ms`, `journal_head`, `last_checkpoint_seq`, `lock_held`. Es la única evidencia de que la sesión está **viva**; el informe puede estar quieto legítimamente. El gateway aplica la regla de B1: un proceso activo no prueba que produzca, y datos recientes con proceso muerto es `warning`.

### 5.4 Posiciones verificadas (alimenta B5)

B5 hoy se define de dos maneras en los documentos: _"posiciones actuales verificadas"_ (`mission-control-fase-2-plan.md`, requisito explícito: sin B5 la Terminal dice "No disponible") y _"lista de experimentos"_ (`mission-control-viabilidad.md`). Esta etapa alimenta la primera, con el contrato que ya sabe producir el runner (`protection()`, `Portfolio.snapshot()`):

```jsonc
"positions": [{
  "intent_id": "…", "product_id": "PF_ETHUSD", "side": "LONG", "strategy_id": "C29", "strategy_version": "…",
  "entry_ms": 0, "entry_price": "…", "stop": "…", "target": "…", "notional_usd": "…",
  "unrealized_usd": "…",                       // clase estimated
  "mark": { "price": "…", "quote_ms": 0, "age_ms": 0 },   // última cotización observada del producto
  "stop_protection": "observed | observed_by_candles | not_yet_observed | unobserved",
  "coverage": { "quotes_watched": 0, "last_watched_ms": 0, "silent_now_ms": 0, "gaps": [] },
  "verified": true,                            // §5.4.1
  "classes": { "price": "observed", "pnl": "estimated", "position": "simulated" }
}]
```

#### 5.4.1 Qué significa "verificada"

Una posición se marca `verified: true` solo si: el journal está íntegro (cadena verificada, último checkpoint reproducido), el informe es más reciente que el umbral de frescura, y la posición no está en cuarentena de funding ni en un hueco sin cobertura. En cualquier otro caso `verified: false` con el motivo; **nunca** se presenta una posición no verificada como actual. Una posición `simulated` jamás se llama "abierta en Kraken": es una posición del simulador sobre cotizaciones observadas.

### 5.5 Intervalos (alimenta B3)

B3 se define en `mission-control-viabilidad.md` como `GET /api/decisions?product=&from=&to=` y `GET /api/decisions/:key`: correlación por `(producto, bucket)` entre veredicto, decisión y operación, con etapas ausentes marcadas `unavailable`. El runner ya tiene la cadena completa y causal de una decisión (`decisions(runner)` en `paper_runner_report.py`: señal → decisión → orden → apertura/rechazo → cierre, con `timeline`). El informe publica por intervalo:

```jsonc
"intervals": [{
  "key": "<signal_key>", "product_id": "…", "bucket_ms": 0,
  "stages": {
    "signal":   { "state": "ok", "origin": "original", "generated_ms": 0, "persisted_ms": 0 },
    "decision": { "state": "ok", "decided_ms": 0 },
    "order":    { "state": "expired|opened|rejected|cancelled|pending", "reasons": [], "timeline": {} },
    "trade":    { "state": "closed|open|none", "trade_id": "…", "exit_reason": "…" }
  },
  "execution_class": "observed_quotes"
}]
```

Con un tope de ventana (p. ej. últimas 24 h) y un cursor `?since_seq=`. Nota: "intervalos" en el pedido de esta etapa y "decisiones por bucket" en el documento de viabilidad parecen ser lo mismo (el intervalo `[from, to]` de la consulta); si "intervalos" significa otra cosa (p. ej. intervalos de confianza o de ejecución), queda abierto (§12, decisión 4 lo fija como correlación por intervalo). Los veredictos de C y las decisiones de Qwen siguen viniendo de sus bases (B3 original); la sesión aporta solo las etapas de ejecución paper.

### 5.6 Endpoints del gateway (proyectados, no implementados)

Todos de solo lectura, caché de 15 s por consulta (como B1/B2), `readOnly` sobre archivos, sin procesos ni polling. Se montan en el gateway existente: `/api-live/paper-session/...` → `/api/paper-session/...` (el proxy de Vite quita `/api-live`; ver el 404 de #149: la ruta del front **no** lleva `/api` dos veces).

| Endpoint                                              | Devuelve                                                                              | Fuente                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `GET /api/paper-session/status`                       | estado de la sesión, heartbeat, marca de agua, alertas, identidad, clase de evidencia | `heartbeat.json` + `report.json` |
| `GET /api/paper-session/positions`                    | posiciones verificadas (B5)                                                           | `report.json`                    |
| `GET /api/paper-session/intervals?from=&to=&product=` | cadena señal→decisión→orden→operación (B3)                                            | `report.json`                    |
| `GET /api/paper-session/orders?state=&limit=`         | órdenes con estado y motivo                                                           | `report.json`                    |
| `GET /api/paper-session/integrity`                    | cadena del journal, último checkpoint, huecos de offset, auditoría                    | `report.json`                    |

Errores: `400 {"error":{"code":"invalid_window"|"invalid_product"|…}}` como B2. Estados de lectura por sección: `ok`, `unavailable` (con `detail`), `stale` (hay informe, pero más viejo que el umbral). **Ausente no es cero**: sin sesión es `unavailable`, no una cartera vacía.

### 5.7 Streaming a la Terminal

La Terminal consume hoy `/api/terminal/stream` (SSE en memoria) para mercado, y B1/B2 por polling de 30 s con caché de 15 s. Para esta etapa **no se agrega streaming nuevo**: la sesión paper se consulta por polling con el mismo patrón (`useReport`), porque su cadencia natural (ciclos de 5 min, cotizaciones por segundo pero con cartera que cambia poco) no justifica un canal continuo. Si luego se quisiera push, sería un evento nuevo del stream existente, no un canal aparte (decisión de Mission Control, no de esta etapa). El módulo `paper-engine-follower.ts` del gateway lee la cuenta del libro **D, ya retirado**; el contrato nuevo lo reemplaza y D debe quedar marcado como retirado en la Terminal (propuesta, a cargo de Mission Control).

### 5.8 Etiquetas de rotulado obligatorias en la UI (contrato de presentación)

- Toda cifra de la sesión lleva su clase; ninguna `simulated` o `estimated` se rotula como real.
- Ejecución: `Cotización observada (paper)`; la de 9A, `Ejecución modelada` (nunca mezclar en la misma tabla sin columna de clase).
- Estados degradados y alertas visibles en la primera pantalla (no escondidos en un inspector).
- Si `positions[].verified = false`, el bloque dice "No verificada" con el motivo.

### 5.9 B1 con la sesión paper

B1 hoy deja **Riesgo** siempre en `unknown` ("`multi_risk.py` corre fuera de `pnpm dev` y no hay registro de rechazos, exposición, margen ni pérdida diaria"). El informe de la sesión es la primera fuente real de esos datos. Propuesta, a implementar solo cuando 10D esté fusionada: dos comprobaciones nuevas en B1, no obligatorias mientras la sesión no esté autorizada: `session_heartbeat` (componente Procesamiento) y `risk_source` (componente Riesgo: exposición abierta, pérdida diaria y suspensiones desde `report.json`, con `evidence.origin = "paper-session/report.json"`). Mientras no haya sesión autorizada, Riesgo sigue `unknown` y el global sigue sin poder ser `ok`: no se cambia la regla 5 de B1.

## 6. Recuperación ante desconexiones

El ingestor lee una base; las desconexiones relevantes son de tres capas: Kraken↔captura, captura↔base, y sesión↔base. Cada fila indica qué evidencia lo detecta, qué hace la sesión y cómo queda informado.

| Falla                                                                                               | Evidencia que lo detecta                                                              | Qué hace la sesión                                                                                                                                                                                                                                                                                                                 | Efecto financiero                                                                                                      | Informe / alerta                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **WS de Kraken mudo / reconectando** (la captura se recupera sola, ver `resiliencia-conexiones.md`) | filas de ticker con edad > umbral, `resilience.jsonl`, `paper_futures_data_gaps`      | sigue; el stream queda `silent`                                                                                                                                                                                                                                                                                                    | cobertura de stop: `quote_gap` si hay posición abierta (8C); órdenes pendientes pueden vencer por `no_quote_in_window` | `stream_silent`, `insufficient_market_data`                                                                  |
| **Captura caída (proceso muerto)**                                                                  | `dev-health.json` viejo o ausente, ningún stream avanza, heartbeat de captura vencido | `clock` **no avanza**; estado `SOURCE_STALE`; no se abren entradas nuevas; sigue vigilando lo que llegue                                                                                                                                                                                                                           | las órdenes pendientes **no vencen** mientras dura (el reloj está parado)                                              | `source_stale` (error)                                                                                       |
| **Captura vuelve tras una caída larga**                                                             | streams reaparecen con huecos                                                         | el ingestor lee lo que haya; los offsets contiguos faltantes quedan como `offset_holes`; solo el operador puede declararlos con `gap_declared` (D8). Reloj: reanuda con el primer evento real; una orden pendiente cuya ventana quedó sin cobertura se cancela con motivo propio (**brecha**, §9 G1) en lugar de culpar al mercado | posiciones abiertas: `runner_interrupted`/`quote_gap` declaran falta de cobertura                                      | `offset_holes`, `coverage_gap`                                                                               |
| **Base de la captura bloqueada o ilegible** (WAL, `database is locked`)                             | error de lectura tras `busy_timeout`                                                  | reintenta con espera progresiva; no reinicia nada; tras N fallos seguidos → `SOURCE_STALE`                                                                                                                                                                                                                                         | igual que captura caída                                                                                                | `source_unreadable`                                                                                          |
| **Sesión muerta (crash, `SIGKILL`, Mac dormida, apagado)**                                          | heartbeat vencido (lo ve el gateway)                                                  | al relanzar: `recover` con el **reloj de recuperación** real (D4); pagos de obligaciones, `order_cancelled` con `runner_interrupted` solo si el intervalo no tiene cobertura demostrable (D7); posiciones declaran `runner_interrupted` (8C)                                                                                       | ver 8B/8C: determinista, equivalente a la corrida continua                                                             | `recovery_complete` o `recovery_incomplete`; vuelve a `RECOVERING` → `LIVE`                                  |
| **Mac dormida**                                                                                     | igual que sesión muerta y captura caída a la vez                                      | la captura y la sesión se detienen juntas. Al despertar vuelven en cualquier orden; la sesión espera `source_fresh` antes de salir de `SOURCE_STALE`                                                                                                                                                                               | un hueco real sin datos: se declara, no se rellena                                                                     | `source_stale` + `recovery_*`. **El sueño de la Mac es una causa conocida de caídas** (memoria del proyecto) |
| **Dos sesiones al mismo directorio**                                                                | `flock` exclusivo y no bloqueante                                                     | la segunda falla con `directory_locked` sin escribir un byte (8B)                                                                                                                                                                                                                                                                  | ninguno                                                                                                                | `directory_locked` (error)                                                                                   |
| **Journal o checkpoint dañado**                                                                     | verificación de cadena y replay (8B)                                                  | `REFUSED` con motivo estable (`journal_corrupt`, `checkpoint_incompatible`, `replay_diverged`, `build_incompatible`…); evidencia a cuarentena; nunca repara solo                                                                                                                                                                   | ninguno                                                                                                                | `REFUSED` (error, requiere operador)                                                                         |
| **Cambio de código financiero**                                                                     | `build_identity`/`engine_behavior` del manifiesto (D3)                                | rechaza reanudar un diario viejo                                                                                                                                                                                                                                                                                                   | ninguno                                                                                                                | `build_incompatible`                                                                                         |
| **Vela revisada por Kraken tras haberse usado**                                                     | revisiones en `official_candles`                                                      | no reaplica; registra                                                                                                                                                                                                                                                                                                              | operaciones ya cerradas no cambian; se informa como incertidumbre                                                      | `candle_revised` (info)                                                                                      |
| **Cambio de época de la fuente**                                                                    | `epoch` distinto                                                                      | sube `source_epoch`; épocas viejas se rechazan                                                                                                                                                                                                                                                                                     | ninguno                                                                                                                | contador `stale_epoch`                                                                                       |
| **Retraso del propio ingestor** (lee más lento que lo que escribe la captura)                       | `lag_ms = ahora_fuente - watermark`                                                   | no descarta; si supera el umbral, `DEGRADED`; si supera el tope, `HALTED` (§7.2)                                                                                                                                                                                                                                                   | decisiones con datos viejos: `guard_entry` ya rechaza lo vencido                                                       | `ingest_lag`                                                                                                 |
| **Reloj de la fuente retrocede** (ajuste de reloj)                                                  | `t_ms` menor que el reloj                                                             | el runner ya rechaza (`out_of_order_event`) y cuenta; si se repite, `HALTED`                                                                                                                                                                                                                                                       | ninguno                                                                                                                | `source_clock_regression`                                                                                    |
| **Pérdida de disco / sin espacio**                                                                  | error de escritura                                                                    | la durabilidad manda: sin `fsync` no se acepta evento; `HALTED` sin reparar                                                                                                                                                                                                                                                        | ninguno                                                                                                                | `journal_write_failed` (error)                                                                               |

Principio común (de 8B): **la recuperación nunca escribe en el pasado y nunca inventa cobertura.** Todo lo que no se pudo observar queda en el informe como `uncertain` o `unobserved`.

## 7. Estados operativos y alertas

### 7.1 Máquina de estados de la sesión

Más ancha que la del runner (`CREATED, PROCESSING, RECOVERING, FINISHED, REFUSED`), que se conserva intacta debajo. El estado de la sesión es una **función derivada** (heartbeat + runner + ingestor), no un estado nuevo del runner:

```
INIT ─► PREFLIGHT ─► WARMING_UP ─► LIVE ◄────────────┐
 │         │             │          │  ▲              │
 │         ▼             ▼          ▼  │              │
 │      REFUSED       REFUSED    DEGRADED ──► SOURCE_STALE ──┘ (vuelve a LIVE solo con fuente fresca)
 │                                  │             │
 │                                  ▼             ▼
 └──────────────────────────────► HALTED ◄─── RECOVERING ─► LIVE
                                      │
                                      ▼
                                   STOPPED / FINISHED
```

| Estado               | Significado                                                                                            | Abre entradas nuevas          | Vigila posiciones          |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------- |
| `INIT` / `PREFLIGHT` | creando o verificando condiciones de §8.1                                                              | no                            | n/a                        |
| `WARMING_UP`         | reproduciendo velas históricas para los indicadores                                                    | no                            | n/a                        |
| `LIVE`               | fuente fresca, ingestor al día, runner `PROCESSING`                                                    | sí                            | sí                         |
| `DEGRADED`           | funciona pero con una alerta de severidad `warning` abierta (huecos, retraso moderado, un stream mudo) | sí, salvo la política de §7.2 | sí                         |
| `SOURCE_STALE`       | la fuente no avanza; el reloj está detenido                                                            | **no**                        | con lo que llegue          |
| `RECOVERING`         | `recover` en curso (replay + obligaciones)                                                             | no                            | n/a                        |
| `HALTED`             | parada automática por una guarda de §8.2; requiere operador                                            | no                            | no avanza (no hay proceso) |
| `STOPPED`            | parada ordenada por el operador                                                                        | no                            | no                         |
| `FINISHED`           | `finish()` ejecutado                                                                                   | no                            | no                         |
| `REFUSED`            | no puede reanudar con seguridad (config distinta, cadena rota, etc.)                                   | no                            | no                         |

`SUSPENDED_ENTRIES` sigue siendo una bandera ortogonal derivada de `Portfolio` (I12): suspende entradas, nunca cierres, vigilancia, funding ni auditoría. En `DEGRADED` y `SOURCE_STALE` **la gestión de salidas continúa** con el mismo criterio que la puerta de frescura del forward: no entrar con datos viejos, sí vigilar lo abierto.

### 7.2 Política de entradas por estado de datos

Reutiliza el criterio de `resiliencia-conexiones.md` (puerta de frescura del forward: la vela de 1 m y la última de 5 m existentes y conocidas dentro de 3 min) para que ambas sesiones bloqueen por la misma razón. Umbrales propuestos (todos **hipótesis experimentales**, ninguno medido ni aprobado): ticker vivo ≤ 45 s, vela 1 m fresca ≤ 180 s, `ingest_lag_ms` ≤ 10 s para `LIVE`, ≤ 60 s para `DEGRADED`, más allá `SOURCE_STALE`/`HALTED`.

### 7.3 Catálogo de alertas

Se extiende el catálogo de 8C (`accounting_discrepancy`, `recovery_incomplete`, `funding_conflict`, `offset_holes`, `insufficient_market_data`, `stop_not_yet_observed`, `closed_trade_coverage_incomplete`, `funding_incomplete`, `entries_suspended`) con las de la sesión. Cada alerta lleva `code`, `severity` (`info|warning|error`), `since_source_ms`, `detail` y la acción esperada.

| Código                      | Severidad       | Origen    | Disparo                                                                         | Acción                                                        |
| --------------------------- | --------------- | --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `source_stale`              | error           | ingestor  | ningún stream avanza durante `stream_dead_after_ms` o `dev-health.json` vencido | revisar la captura; no hay acción de la sesión                |
| `source_unreadable`         | error           | ingestor  | lectura fallida tras reintentos                                                 | revisar la base y el disco                                    |
| `stream_silent`             | warning         | ingestor  | un stream sin filas más allá de su umbral mientras otros avanzan                | informativa; puede ser de un solo producto                    |
| `ingest_lag`                | warning / error | ingestor  | `lag_ms` sobre umbral                                                           | revisar carga de la Mac                                       |
| `ingest_late_rows`          | warning         | ingestor  | fila por debajo de la marca de agua ya emitida                                  | cuenta y detalle; si crece, subir `hold_ms` (decisión humana) |
| `source_clock_regression`   | error           | runner    | `out_of_order_event` repetido                                                   | revisar reloj                                                 |
| `candle_revised`            | info            | ingestor  | revisión posterior de una vela ya usada                                         | solo informativa                                              |
| `warmup_incomplete`         | warning         | evaluador | indicadores no listos o funding < 30 días                                       | no hay ciclos accionables                                     |
| `recovery_complete`         | info            | sesión    | recuperación terminada sin obligaciones                                         | ninguna                                                       |
| `session_heartbeat_missing` | error           | gateway   | heartbeat más viejo que el umbral                                               | sesión muerta o Mac dormida                                   |
| `directory_locked`          | error           | runner    | segundo escritor                                                                | ninguna (ya se rechazó)                                       |
| `journal_write_failed`      | error           | runner    | fallo de `fsync` o escritura                                                    | `HALTED`                                                      |
| `halted`                    | error           | sesión    | guarda de §8.2                                                                  | requiere operador                                             |

Las alertas se derivan de evidencia y se **retiran solas** cuando la evidencia vuelve a la normalidad; el historial queda en el journal (`recovery`, `event_rejected`) y en `ingest-state.json`, no en una tabla nueva.

## 8. Condiciones para ejecutar una sesión paper desatendida

Una sesión no corre sola hasta que **todas** las condiciones de §8.1 se cumplan y haya aprobación expresa de Fran para lanzar un proceso persistente (§12, decisión 10). Nada de esto se ejecuta en esta etapa.

### 8.1 Pre-vuelo (go / no-go, todo debe estar en verde)

1. **Identidad**: el árbol de trabajo coincide con el commit esperado; `build_identity` y `engine_behavior` calculados; manifiesto de sesión escrito y su hash registrado.
2. **Alcance**: solo `PF_*` de la lista fijada; sin ninguna variable de credenciales de Kraken en el entorno del proceso (la sesión **falla al arrancar** si encuentra alguna: es una condición de seguridad, no una opción).
3. **Aislamiento**: directorio propio vacío o recuperable; ningún archivo del forward, de `capture`, de Kronos ni la base viva de la Mac en su ruta de escritura; lectura de la captura en `mode=ro`.
4. **Fuente sana**: B1 reporta datos `ok` (ticker ≤ 15 s, vela 1 m ≤ 120 s) durante los últimos N minutos continuos; sin huecos abiertos en la última hora.
5. **Calentamiento completo**: indicadores listos y funding ≥ 30 días para todos los productos del universo.
6. **Espacio y rendimiento**: espacio libre suficiente para el journal proyectado (§4) y para el informe; tiempo de recuperación medido con un journal sintético del tamaño proyectado, bajo el umbral.
7. **Política etiquetada**: `policy_status: experimental` presente en el manifiesto; clase de evidencia `not_forward_evidence` presente en todo informe.
8. **Ensayo de recuperación**: una corrida de prueba con una muerte de proceso inyectada y recuperación en otro proceso da los mismos digests (la propiedad de 8C, ahora con el ingestor real sobre una copia).
9. **Sin restricciones violadas**: nada de órdenes reales; ni holdout (desde el 2-ago-2026) ni bases originales en el camino de lectura.

### 8.2 Guardas en ejecución (parada automática a `HALTED`, nunca "reparar y seguir")

- Violación contable de la auditoría integrada (`accounting_discrepancy`).
- `journal_corrupt`, `replay_diverged`, `build_incompatible`, `journal_write_failed`.
- `ingest_lag_ms` sobre el tope durante más de T segundos.
- Más de K recuperaciones en W horas (bucle de caídas).
- Sin espacio libre bajo el mínimo.
- Pérdida diaria o drawdown sobre los límites de `PortfolioPolicy`: **estos ya suspenden entradas por diseño (no son motivos de parada)**; la sesión no los modifica.
- Un heartbeat con `lock_held = false`.

Una parada deja el directorio intacto y recuperable. La sesión **nunca** reinicia sola un journal corrupto, borra cuarentena, declara huecos ni relaja un umbral.

### 8.3 Qué puede hacer sola y qué no

| Sola                                                                                       | Nunca sola                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Reconectar la lectura de la base, reintentar con espera progresiva                         | Declarar `gap_declared` (D8: operador, motivo, evidencia) |
| Pasar entre `LIVE`/`DEGRADED`/`SOURCE_STALE` según evidencia                               | Reiniciarse tras `REFUSED` o `HALTED`                     |
| Recuperarse tras una caída del propio proceso (`recover`) cuando la supervisión la relanza | Resolver funding contradictorio (D6)                      |
| Escribir checkpoint e informe                                                              | Tocar parámetros, estrategias o dimensionamiento          |
| Publicar alertas                                                                           | Cambiar `hold_ms`, umbrales o ventanas en caliente        |

### 8.4 Supervisión externa mínima

Una sesión desatendida necesita algo que la mire desde afuera. Dos capas, ninguna dentro del runner: (1) el gateway evalúa `heartbeat.json` (B1 gana un chequeo de heartbeat, §5.9); (2) el supervisor del lanzador (launchd en la Mac) la relanza con un tope de reinicios; si se supera, queda `HALTED` y la rutina de resumen diario existente lo informa. La rutina **no** debe iniciar ni reiniciar sesiones.

## 9. Brechas detectadas (qué falta)

| #   | Brecha                                                                                                                                                                                                                                                                                                                                                              | Qué pasa si no se resuelve                                                                                                                                                                                                                                                                                                            | Dueño propuesto                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Cancelación por caída de la fuente.** D7 cubre `runner_interrupted` (caída del runner). Una orden pendiente cuya ventana quedó sin cotizaciones porque la **captura** estuvo caída vence como `no_quote_in_window`, y el reporte lo imputa al mercado                                                                                                             | Un rechazo mal atribuido; la lectura de «el mercado no tuvo cotización» es falsa                                                                                                                                                                                                                                                      | Camino sin tocar el runner: el informe cruza órdenes vencidas con `paper_futures_data_gaps` y `resilience.jsonl` y las rotula `expired_during_source_outage` (capa de informe). Un evento propio `source_interrupted` en el runner requeriría tocar `paper_runner.py`: **9A** |
| G2  | **Tamaño del journal.** Cada cotización aceptada entra al journal (≈ 700 000 eventos/día para 8 productos a 1/s). Crece y alarga el replay                                                                                                                                                                                                                          | **Sin reducción ni muestreo por ahora.** Guardar menos cotizaciones cambia fills, detección de stops, huecos observables y reconstrucción. Antes de proponer una alternativa, 10B mide tamaño y tiempo de replay por día con la política actual y compara la fidelidad de cada alternativa (ver `docs/etapa-10b-ingestor-offline.md`) |
| G3  | **Contigüidad de `seq` en tickers (resuelta por el código, sin leer la captura real).** `ticker-poll.ts` escribe `seq = receivedAtMs` y `persistedAt = receivedAtMs` con `epoch = 1 000 000`: es una marca de tiempo, no un contador. El WebSocket declara `sequenceIntegrity: monotonic_only_unproven`. Un offset basado en `seq` marcaría huecos falsos o ninguno | Los tickers van con `source_offset = null` (sin `OffsetLedger`); velas con offset de bucket. Lo demuestra una prueba sobre una base sintética con el esquema real (10B). No se midió en la captura de la Mac                                                                                                                          |
| G4  | **Evaluador en vivo** (§3.4)                                                                                                                                                                                                                                                                                                                                        | No hay ciclos accionables                                                                                                                                                                                                                                                                                                             | Compartido con **9A** (mismo código)                                                                                                                                                                                                                                          |
| G5  | **`ModelledExecutor` y `executor_factory`** que 9A agrega a `paper_runner.py`: la sesión en vivo necesita el ejecutor por cotizaciones (el actual por defecto) y un manifiesto que distinga `execution_mode`. Hoy no existe el campo                                                                                                                                | Sesión en vivo y replay no se podrían comparar ni distinguir                                                                                                                                                                                                                                                                          | **9A** (dueño de `paper_runner.py`)                                                                                                                                                                                                                                           |
| G6  | **Registro durable de salidas** de estrategias de Q/Kronos en vivo                                                                                                                                                                                                                                                                                                  | n/a: la sesión usa solo estrategias deterministas congeladas; Qwen y Kronos quedan fuera de esta etapa                                                                                                                                                                                                                                | fuera de alcance                                                                                                                                                                                                                                                              |
| G7  | **Riesgo en B1** siempre `unknown`                                                                                                                                                                                                                                                                                                                                  | El global nunca llega a `ok`                                                                                                                                                                                                                                                                                                          | §5.9, tras 10D                                                                                                                                                                                                                                                                |
| G8  | **Terminal con el libro D retirado**: `paper-engine-follower.ts` aún lee `account.sqlite` de D                                                                                                                                                                                                                                                                      | Un bloque de motor «off» ambiguo                                                                                                                                                                                                                                                                                                      | **Mission Control**                                                                                                                                                                                                                                                           |
| G9  | **Descartes y fallos no persistidos** (B4 original de MC)                                                                                                                                                                                                                                                                                                           | Las alertas de la sesión no tienen paralelo para el forward                                                                                                                                                                                                                                                                           | fuera de alcance, ya pospuesto                                                                                                                                                                                                                                                |
| G10 | **Mapeo producto → estrategias de la sesión**: el runner no filtra productos por estrategia                                                                                                                                                                                                                                                                         | Estrategias evaluadas sobre productos para los que no se habilitaron                                                                                                                                                                                                                                                                  | decidir con Fran junto con §3.5                                                                                                                                                                                                                                               |
| G11 | **Calidad de datos**: huecos, velas 5 m vs agregación de 1 m, vela plana con volumen cero                                                                                                                                                                                                                                                                           | Entradas sobre datos dudosos                                                                                                                                                                                                                                                                                                          | **9B** (utilidades de calidad de datos); el ingestor las usaría como comprobaciones previas                                                                                                                                                                                   |
| G12 | **Sin medición** de latencia real de lectura ni de tamaño de journal en la Mac                                                                                                                                                                                                                                                                                      | Umbrales sin sustento                                                                                                                                                                                                                                                                                                                 | 10B mide sobre una copia sintética; la Mac no se usa                                                                                                                                                                                                                          |

## 10. Dependencias y coordinación

| Con                            | Dependencia                                                                                                                                                                                                                                                                                                                | Qué se asume hasta que exista                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **9A** (replay histórico)      | (1) `paper_runner.py` gana `executor_factory`, `execution_mode` en `RunnerConfig` y el evento `modelled_price` (sin tocar los 10 módulos de `BUILD_MODULES`); (2) el generador de frames/evaluador es un módulo que la sesión viva debe **reutilizar**, no copiar; (3) perfil de auditoría `candle_only` es solo de replay | Esta etapa documenta los contratos y no copia implementaciones provisionales. Cuando 9A fusione, el ingestor se escribe contra su evaluador. Hasta entonces, sin cambios a `paper_runner.py` |
| **9B** (calidad de datos)      | Comprobaciones de huecos, 5 m vs 1 m y OHLC que el ingestor consume como pre-vuelo                                                                                                                                                                                                                                         | Se usan solo los mínimos ya existentes en `valid_candle`/`parse_quote`                                                                                                                       |
| **Mission Control** (frontend) | Consumo de `/api/paper-session/*`, rotulado §5.8, retiro del bloque D; PR #149 corrige las rutas `/api-live/observability/*` (**esta etapa usa la ruta corregida**); PR #147 queda rechazada                                                                                                                               | No se modifica ningún archivo del frontend. Los contratos de §5 son una propuesta que MC puede ajustar antes de implementarla                                                                |
| **Forward / captura**          | Ninguna modificación; la sesión solo lee la base de la captura                                                                                                                                                                                                                                                             | Se verifica con la misma prueba de B1/B2: bytes, tamaño y fecha de las fuentes no cambian                                                                                                    |

## 11. Plan por etapas propuesto (cada una un PR separado, sin fusionar sin la revisión de Fran)

| Etapa                           | Entrega                                                                                                                                                                                                           | Criterio de aceptación                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10A** (esta)                  | este documento y contratos                                                                                                                                                                                        | revisión de Fran; decisiones de §12                                                                                                                                                |
| **10B** Ingestor offline        | `paper_live_ingest.py` que lee una **copia sintética** de la base de la captura y emite eventos; mapeo §3.2, marca de agua, cursores desde el `OffsetLedger`; mide `seq` de tickers (G3) y tamaño de journal (G2) | misma secuencia de datos ⇒ mismos digests continuos, interrumpidos y en otro proceso; filas tardías contadas, no perdidas; ninguna escritura en la base fuente (hash/tamaño/mtime) |
| **10C** Evaluador en vivo       | sobre el módulo de 9A                                                                                                                                                                                             | paridad con el replay: mismas velas ⇒ mismos ciclos y señales; calentamiento incompleto no emite ciclos accionables                                                                |
| **10D** Publicación y gateway   | `report.json`/`heartbeat.json`, endpoints `/api/paper-session/*`, B1 con `session_heartbeat` y `risk_source`, fixtures y ejemplos como en `docs/mission-control/b1/`                                              | prueba de contrato (decodificador estricto), lectura `readOnly`, caché de 15 s, estados `unavailable`/`stale`, rendimiento sobre copia sintética sin tocar la captura              |
| **10E** Sesión en seco          | proceso de sesión sobre una **copia** de la captura con inyección de fallos (corte de la fuente, lag, muerte del proceso)                                                                                         | matriz de §6 verde; ninguna conexión a Kraken; ningún proceso persistente                                                                                                          |
| **10F** Sesión real desatendida | solo con aprobación expresa de Fran, lanzador propio, §8 cumplido                                                                                                                                                 | no es parte de este diseño                                                                                                                                                         |

CI: 10A es solo documentación (`format:check` aplica a los `.md`); 10B-10E corren la suite Python completa y las del servidor, igual que cualquier PR.

## 12. Decisiones (estado tras la auditoría conjunta del 2026-10-14)

| #   | Tema                             | Estado                                                                                                                                      |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fuente del ingestor              | Aprobado para diseño y pruebas: reutilizar la captura existente, sin otro cliente de Kraken                                                 |
| 2   | Estrategias                      | Aprobado: C29/C30/C32 congeladas, sesión de integración separada, `not_forward_evidence`. Cómo reproducirlas con sus hashes: abierto (§3.4) |
| 3   | Contabilidad                     | Aprobado como experimento: cartera separada, no sustituye los 100 USD del forward ni toca el ADR                                            |
| 4   | B3                               | Aprobado: correlación señal → decisión → orden → operación por producto e intervalo                                                         |
| 5   | B5                               | Aprobado: posiciones paper verificadas y etiquetadas                                                                                        |
| 6   | B1 Riesgo                        | Podrá mostrar riesgo de la sesión cuando exista una fuente autorizada y verificable                                                         |
| 7   | Marca de agua de 2 s             | Hipótesis a probar, no parámetro aprobado                                                                                                   |
| 8   | Journal de cotizaciones          | **Sin reducción por ahora**; alternativas medidas en 10B antes de proponer nada                                                             |
| 9   | Reloj detenido con captura caída | Pendiente de pruebas que distingan caída de la captura de mercado mudo (hechas con datos sintéticos en 10B)                                 |
| 10  | Proceso persistente en la Mac    | **No autorizado**                                                                                                                           |
| 11  | Órdenes reales                   | Prohibidas                                                                                                                                  |
| 12  | Lectura de la captura real       | No autorizada en 10B (solo bases sintéticas)                                                                                                |

## 13. Restricciones respetadas

Sin código operativo; sin conexión a Kraken ni procesos; sin tocar forward, `capture`, Kronos, Qwen, C25-C32, parámetros de riesgo, ADR ni el frontend; sin credenciales; el holdout (desde 2026-08-02) no se lee; toda ejecución histórica queda identificada como modelada (9A) y la de esta sesión como cotizaciones observadas, siempre con su clase de evidencia. Las políticas de ejecución, vigilancia, cobertura y las marcas de tiempo de §3.3 y §7.2 son **hipótesis experimentales**, no valores validados ni aprobados. Nada de este diseño prueba rentabilidad.
