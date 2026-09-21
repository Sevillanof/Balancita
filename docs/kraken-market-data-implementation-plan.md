# Plan de implementación: Kraken como plaza de mercado BTC-EUR

## Propósito

Handoff de implementación para otra IA que trabaje bajo TDD estricto. Contiene
**únicamente trabajo pendiente**: reemplazar Coinbase por Kraken como única
plaza de mercado BTC-EUR en el frontend y el servidor, y habilitar backfill
histórico más replay determinista sobre datos Kraken. No repite fases ya
implementadas de Balancita (ver `docs/implementation-progress.md`) ni el
roadmap de inteligencia (ver `docs/bitcoin-market-intelligence-roadmap.md`).

## Decisión y alcance

- **Kraken es la única plaza BTC-EUR** en toda la app (frontend y servidor).
  No se mezclan proveedores para el mismo instrumento.
- **Uso personal y local únicamente.** Balancita no se opera para terceros ni
  se aloja como servicio público mientras dependa de Kraken en este alcance.
- **Solo endpoints públicos**: REST público (`/0/public/*`) y WebSocket v2
  público. Ninguna clave de API ni endpoint privado forma parte de este
  alcance.
- Si existe alguna clave de Kraken expuesta en algún canal (chat, historial,
  variable de entorno de prueba, etc.), **revocarla en la cuenta de Kraken y
  no usarla** en ningún commit, fixture, log o variable de entorno. Este plan
  no depende de ninguna clave.
- **Sin órdenes reales.** El paper trading simulado existente sigue siendo
  100% local y no debe poder resolver ni llamar ningún endpoint de órdenes de
  Kraken.
- **No tocar `doc/**`** (fuente de verdad inmutable) ni
  `server/data/market.sqlite` (base de datos en vivo). Tests y desarrollo usan
  fixtures y almacenamiento en memoria o temporal.
- Preservar `event time`, `received time` y `trade_id` en cada observación,
  igual que exige el roadmap de inteligencia vigente.
- Separar estrictamente `shadow_live` (evidencia prospectiva de la app en
  ejecución) de `historical_replay` (simulación retrospectiva sobre un dataset
  congelado). Nunca se combinan en un mismo reporte o consulta.

## Fuera de alcance (no implementar en este plan)

- API privada de Kraken, autenticación, firmas o cualquier endpoint que
  requiera clave.
- `AddOrder` y cualquier colocación, modificación o cancelación de órdenes
  reales.
- Funding, depósitos, retiros o cualquier movimiento de fondos reales.
- Noticias históricas o su provenance point-in-time (permanece fuera de este
  alcance; ya está fuera de alcance en el roadmap general).
- Trading automático o algorítmico de cualquier tipo.
- Cualquier afirmación o medición de rentabilidad. El replay histórico es una
  validación de ingeniería, no evidencia de resultado financiero.

## Nota sobre términos de uso

El uso personal y no comercial reduce el riesgo de incumplimiento, pero los
términos exactos aplicables a datos de mercado de Kraken dependen de la
jurisdicción del usuario y pueden cambiar. Este plan no constituye asesoría
legal. El adaptador implementado debe:

- consumir solo endpoints públicos documentados;
- no redistribuir datos de mercado a terceros ni exponer un servicio público
  que reenvíe datos de Kraken;
- registrar la fecha de revisión de los términos vigentes en el momento de
  implementar HR-5/KRA-4, igual que exigía el gate de proveedor del plan
  anterior.

## Arquitectura objetivo

```text
Time & Sales archive (histórico congelado, descarga puntual)
        -> REST /public/Trades (catch-up / recovery de huecos)
        -> WebSocket v2 "trade" (stream en vivo)
        -> velas cerradas (agregación local, nunca velas en formación)
```

Reglas de la tubería:

- El archivo histórico (`Time & Sales`) es la fuente para poblar un dataset
  congelado de backfill; nunca se usa como fuente en vivo.
- El catch-up/recovery vía REST público `Trades` cubre huecos entre el
  archivo histórico y el stream en vivo, y cualquier reconexión del
  WebSocket.
- El stream en vivo es WebSocket v2, canal `trade`, único origen de
  observaciones `shadow_live` en tiempo real.
- Las velas se agregan localmente a partir de trades individuales (event
  time, received time, trade ID de Kraken); nunca se usa el endpoint REST
  `OHLC` como fuente canónica de replay ni de velas cerradas: `OHLC` devuelve
  como máximo 720 velas y su último elemento puede ser la vela aún en
  formación (no cerrada). Puede usarse únicamente como verificación cruzada
  opcional, nunca como fuente primaria de features técnicos ni de replay.

## Nomenclatura y mapeo de pares

- Identificador de dominio interno (`InstrumentId`): se mantiene `BTC-EUR` sin
  cambios en los contratos existentes (`src/domain/market-data.ts` y
  consumidores).
- Par REST de Kraken: `XBTEUR` (parámetro `pair` en `/0/public/Trades` y en
  `/0/public/AssetPairs` para resolver metadatos/decimales).
- Par WebSocket v2 de Kraken: `BTC/EUR` (formato con barra, distinto del REST)
  cuando el mensaje de suscripción lo requiera.
- El adaptador traduce `BTC-EUR` (dominio) ↔ `XBTEUR` (REST) ↔ `BTC/EUR` (WS
  v2) en un único módulo de mapeo, cubierto por tests unitarios; ningún otro
  módulo debe conocer los identificadores nativos de Kraken.

## Unidades de trabajo (RED → GREEN → REFACTOR)

Continúan la numeración de `odd/tasks/kraken-market-data.md`. Cada unidad
debe observar RED antes de implementar y cerrar con un commit propio.

### KRA-2 — Proveedor de mercado del navegador

RED:

- Tests con fixtures para el mapeo de pares (`BTC-EUR` ↔ `XBTEUR` ↔
  `BTC/EUR`).
- Tests para parseo de trades y agregación a velas cerradas a partir de
  fixtures de WebSocket v2 `trade` y de `/0/public/Trades`.
- Tests que rechacen construir una vela con datos incompletos o abiertos.

GREEN:

- Implementar `src/providers/kraken-market-data.ts` detrás del contrato
  `MarketDataProvider` existente (mismo contrato que hoy implementa
  `src/providers/coinbase-market-data.ts`).
- Selección de proveedor: reemplazar el valor `coinbase` de
  `VITE_MARKET_DATA_PROVIDER` por `kraken`; `mock` se mantiene sin cambios.
- Mantener `src/providers/coinbase-market-data.ts` sin borrar hasta que
  `kraken-market-data.ts` alcance paridad de tests y comportamiento.

Comandos:

```bash
pnpm test -- src/providers/kraken-market-data
pnpm typecheck
pnpm lint
```

### KRA-3 — Colector del servidor en vivo

RED:

- Tests con fixtures de WebSocket v2 `trade` para: deduplicación por
  `trade_id`, preservación de event time y received time, reconexión con
  backoff, y persistencia append-only en el store existente.
- Tests que prueben que un gap detectado dispara catch-up vía REST
  `/0/public/Trades` acotado por rango de `trade_id`/tiempo, no un backfill
  completo.

GREEN:

- Implementar `server/src/intelligence/market/kraken-market-collector.ts`
  como reemplazo de `coinbase-market-collector.ts`, con la misma interfaz de
  ciclo de vida (`onReady`/`onClose`) usada hoy.
- Actualizar configuración (`server/src/config.ts` y variables de entorno)
  para apuntar a Kraken; eliminar cualquier variable específica de Coinbase
  solo después de confirmar paridad.
- Mantener `coinbase-market-collector.ts` sin borrar hasta paridad probada.

Comandos:

```bash
pnpm --dir server test -- kraken-market-collector
pnpm typecheck:server
```

### KRA-4 — Backfill histórico y orquestación de replay

RED:

- Tests de importación cursor-based sobre fixtures de `Time & Sales`/REST
  `Trades`: alineación de ventanas, reintentos acotados con backoff, huecos
  detectados y registrados como evidencia (nunca rellenados en silencio).
- Tests que rechacen congelar un dataset con duplicados conflictivos o huecos
  no resueltos.
- Tests de aislamiento: un forecast `historical_replay` nunca aparece en una
  consulta o reporte `shadow_live`, y viceversa.
- Tests de reproducibilidad: correr el mismo dataset y versión dos veces debe
  producir los mismos hashes de dataset, forecast y outcome.

GREEN:

- Añadir el importador de backfill y el dataset histórico congelado bajo
  `server/src/intelligence/replay/` (candle-native, con hash canónico), sin
  tocar `server/data/market.sqlite`.
- Añadir `sourceMode: 'shadow_live' | 'historical_replay'` y `replayRunId` a
  los contratos de forecast, con migración retrocompatible (filas existentes
  se leen como `shadow_live`).
- Añadir runs y checkpoints de replay con reloj virtual derivado solo de
  velas cerradas; nunca usar `Date.now()` para el `createdAt` de dominio del
  forecast durante un replay.

Comandos:

```bash
pnpm --dir server test -- replay
pnpm --dir server test -- forecast
pnpm typecheck:server
```

### KRA-5 — Regresión completa y remoción de Coinbase

RED:

- Confirmar que ya no queda ninguna referencia runtime a Coinbase en
  frontend/servidor mediante una búsqueda dirigida antes de borrar código
  (`rg -n "coinbase" --glob '*.ts' src server/src`), revisando cada match.

GREEN:

- Borrar `src/providers/coinbase-market-data.ts` (+ test),
  `server/src/intelligence/market/coinbase-market-collector.ts` (+ test), y
  cualquier variable de entorno/documentación runtime específica de
  Coinbase, solo después de que KRA-2/KRA-3/KRA-4 estén verdes y con paridad
  confirmada.
- Ejecutar todos los gates:

```bash
pnpm test
pnpm test:server
pnpm typecheck
pnpm typecheck:server
pnpm lint
pnpm build
pnpm format:check
```

- Confirmar manualmente: ninguna credencial de Kraken en el repo, ninguna
  dependencia runtime de Coinbase, ningún reporte que mezcle
  `shadow_live`/`historical_replay`, y `server/data/market.sqlite` sin
  modificaciones fuera de lo que el propio server escribe en ejecución
  normal.

## Migración y remoción de Coinbase

1. Implementar Kraken en paralelo a Coinbase (KRA-2, KRA-3) sin apagar el
   colector existente.
2. Probar paridad funcional (misma forma de contrato, mismos estados de
   error/stale/gap) con fixtures Kraken.
3. Cambiar la selección por defecto (`VITE_MARKET_DATA_PROVIDER`,
   configuración del servidor) a Kraken.
4. Recién entonces borrar el código Coinbase (KRA-5). No mantener ambos
   proveedores activos en producción de forma indefinida: el objetivo final
   es una única plaza.

## Criterios de aceptación

- Kraken es la única plaza de mercado BTC-EUR en tiempo de ejecución
  (frontend y servidor).
- Ningún endpoint privado ni clave de Kraken se usa en ningún punto del
  código, fixtures, tests o configuración.
- El backfill histórico y la colección en vivo usan identificadores de trade
  de Kraken y preservan event time y received time.
- Los reportes históricos y en vivo no pueden mezclar modos de evidencia.
- El paper trading existente sigue siendo local y no puede invocar ningún
  endpoint de órdenes de Kraken.
- `doc/**` y `server/data/market.sqlite` permanecen sin modificaciones fuera
  de la escritura normal del servidor en ejecución.
- Todos los checks aplicables (`test`, `test:server`, `typecheck`,
  `typecheck:server`, `lint`, `build`, `format:check`) pasan en verde.

## Rollback

- Cada unidad de trabajo (KRA-2 a KRA-5) es un commit independiente; revertir
  el commit correspondiente restaura el estado anterior a esa unidad.
- Mientras Coinbase no se haya borrado (antes de KRA-5), volver a
  `VITE_MARKET_DATA_PROVIDER=coinbase` y a la configuración previa del
  colector del servidor restaura el comportamiento anterior sin revertir
  código.
- Si el backfill histórico produce un dataset con huecos o duplicados no
  resueltos, no congelar ese dataset ni iniciar un run de replay sobre él;
  descartar el dataset y reintentar la importación.
- Ningún paso de este plan requiere modificar `server/data/market.sqlite`;
  por lo tanto, un rollback nunca implica restaurar la base de datos en
  vivo.

## Referencias oficiales de Kraken (verificar vigencia antes de KRA-4)

- Datos OHLC (uso solo como verificación cruzada, no como fuente canónica):
  https://docs.kraken.com/api/docs/rest-api/get-ohlc-data
- Trades recientes (REST público, catch-up/recovery):
  https://docs.kraken.com/api/docs/rest-api/get-recent-trades
- Pares de activos tradeables (resolución de `XBTEUR` y metadatos):
  https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs
- Límites de tasa de la REST API pública:
  https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits
- WebSocket v2, canal `trade`:
  https://docs.kraken.com/api/docs/websocket-v2/trade
- Términos legales de Kraken (revisar vigencia y jurisdicción aplicable):
  https://www.kraken.com/legal

## Instrucción final para la próxima IA

Empezar por KRA-2 con fixtures, sin red real en los tests. No borrar el
código de Coinbase hasta confirmar paridad de KRA-2 y KRA-3. Mantener
`historical_replay` y `shadow_live` separados en todo momento y nunca tocar
`server/data/market.sqlite` durante el desarrollo o los tests.
