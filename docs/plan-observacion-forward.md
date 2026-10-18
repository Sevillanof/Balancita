# Plan de observación forward (camino 3)

Fecha: 2026-10-12. Estado: **diseño y tareas, nada construido.** Decisión de Fran: suspender la investigación histórica, mantener Balancita operando en paper con las estrategias forward ya en marcha y empezar a recopilar información nueva del mercado. Solo datos públicos de Kraken Futures, sin credenciales ni órdenes reales (ADR 0001). No se ejecutan pruebas de rentabilidad, no se usan los últimos 60 días reservados ni `holdout`, no se crean estrategias ni se toca el prompt de Qwen ni OKX.

Pregunta que este plan sí responde: _¿tenemos una fuente de información de mercado fiable y un coste de ejecución medido, mientras observamos qué hacen las estrategias congeladas?_ No pretende demostrar una ventaja: con ocho semanas la potencia estadística no alcanza para eso.

## Estado actual verificado en el repo (main @ 6420f0c)

- `capture-main.ts` es el único escritor de `futures-market.sqlite`. Guarda velas oficiales, **ticker (poll de 1 s, retención 24 h)**, funding y velas observadas de los 8 perpetuos. La WebSocket de trades/libro está fijada a `PF_XBTUSD`, y el libro está **desactivado** (`bookFeed: false`): en la prueba FK-02 el libro de BTC generó 13.801 eventos en 15 s (~900 por segundo).
- Hoy **se pierde el bid/ask histórico** al recortar tickers a 24 h y trades a 7 días. Kraken no entrega bid/ask pasado, así que lo que no archivamos no se recupera.
- Las series agregadas (CVD, liquidez, OI) y el libro por rango se consultan a Kraken, no se guardan.
- La captura corre en la Mac de Fran (`pnpm dev`); una caída de 39,5 h ya ocurrió por reposo.

## Principios

1. **Proceso separado y aislado.** Un colector nuevo con su propia base y su propio lock; no modifica `capture-main.ts` ni el motor forward.
2. **Captura de calidad antes que análisis.** No se calculan retornos ni correlaciones con los datos nuevos hasta el 7 de diciembre. Solo se mide calidad de datos y costes.
3. **Hipótesis antes de mirar.** Cualquier análisis predictivo posterior se registra primero en `analisis/nuevas-senales/registro-pruebas.json`.
4. **Observado, simulado, estimado** son tres categorías separadas en todo informe. Nunca se asume un fill maker perfecto.
5. **Piloto con BTC y ETH.** Los otros 6 productos solo si el piloto es estable.

## Etapa 1. Auditoría de los forward existentes (C29, C30, C32 [retirada el 2026-10-18, solo historial], Kronos)

Objetivo: confirmar que registran operaciones sin duplicados y con resultado neto completo. Solo lectura.

- Script `python -m balancita_engine.forward_audit` (solo lee `forward.sqlite` y `kronos-summary.json`): operaciones por estrategia y estado; duplicados (id, entrada, producto); operaciones sin salida o sin coste neto; etiqueta `recovered`; `data_gaps` y horas sin datos; si C32 realmente opera (requiere haber corrido `funding:backfill` una vez, ver memoria); si Kronos sigue vivo; divergencias del forward (`diverged`).
- Salida: `forward-audit.json` y un resumen en Markdown con la fecha y el hash de las bases leídas.
- Necesita correr en la Mac (los datos están allí y la lectura de `server/data/dev-live` requiere tu autorización, que se pide antes de ejecutar).
- Aceptación: tests con una base sintética con duplicados y huecos conocidos; el informe no modifica ninguna base.

## Etapa 2. Captura del libro y las operaciones (BTC y ETH)

**Colector `book-capture` (proceso Node propio, base `futures-book.sqlite`, `acquireWriterLock`).**

Qué se guarda y a qué ritmo (no se guardan los deltas del libro, que serían ~80 M eventos/día por producto):

| Tabla            | Contenido                                                                                                                                                   | Ritmo                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `quotes`         | bid, ask, tamaños, mark, index, funding; hora de recepción y del exchange                                                                                   | 1 fila/s por producto (copia de largo plazo de lo que hoy se borra a las 24 h) |
| `depth`          | liquidez acumulada en 5, 10, 25 y 50 pb por lado, desequilibrio, precio medio de comprar/vender 100 USD y 1.000 USD recorriendo el libro, validez del libro | 1 fila/s por producto                                                          |
| `trades`         | todas las operaciones públicas: uid, precio, cantidad, lado agresor, hora del exchange y de recepción                                                       | cada una                                                                       |
| `capture_health` | huecos, reconexiones, mensajes descartados, latencia p50/p95/p99, libro inválido, bytes escritos                                                            | cada 60 s                                                                      |

Diseño:

- Una conexión WebSocket pública con `product_ids: [PF_XBTUSD, PF_ETHUSD]` en `book`, `trade` y `ticker`. El libro se reconstruye en memoria; cada segundo se calculan las características y se escribe **un lote en una sola transacción**.
- **Contrapresión:** cola de entrada acotada. Si se supera, se descartan deltas, se marca el libro como inválido, se cuenta el hueco y se pide un snapshot nuevo (no se acumulan mensajes sin límite). Meta de recursos configurable: CPU de un núcleo bajo ~10 %, memoria < 300 MB; el colector se autolimita (baja a 2 s por fila) y, si el disco libre baja de 10 GB, se detiene limpiamente.
- **Marcas temporales:** hora de recepción (monótona y UTC) y hora del exchange en cada fila. Secuencia del feed (`seq`) guardada solo como información: Kraken no documenta continuidad, así que un salto no se llama hueco (regla ya establecida en el repo); hueco es: reconexión, secuencia repetida/regresiva, libro cruzado, más de N segundos sin mensajes.
- **Reinicios:** al arrancar escribe un registro de epoch; los trades se deduplican por uid; tras una caída reconstruye con un snapshot nuevo y marca el intervalo perdido como hueco.
- **Almacenamiento (estimación a validar en el piloto):** del orden de 20–50 MB por día para BTC y ETH juntos (1 s de quotes y depth, trades completos); unos 1–3 GB en 8 semanas. El piloto mide la cifra real antes de ampliar.
- **Reposo de la Mac:** se documenta `caffeinate`/launchd (ofrecido antes, sin respuesta). Mientras tanto los huecos quedan etiquetados.
- **Límites legales:** uso personal y no comercial (términos de Kraken); sin redistribuir datos.

Criterio para ampliar a los 8 productos: 7 días continuos del piloto con ≥ 98 % de cobertura, p99 de latencia bajo el límite fijado y sin saturación.

## Etapa 3. Medición de costes maker/taker sobre esos datos

Módulo Python `balancita_engine/book_costs.py`, solo lectura de `futures-book.sqlite`, con tres categorías explícitas:

- **Observado:** spread cotizado (ask − bid) en pb, su distribución por hora del día y por volatilidad; trades reales y su lado.
- **Simulado (determinista):** coste de una orden taker de 100 USD comprando/vendiendo recorriendo el libro, comparado con el precio medio (impacto + medio spread). Comisiones del esquema nivel 1 (maker 0,02 %, taker 0,05 %) como parámetro versionado.
- **Estimado (con etiqueta y banda):** ejecución maker. Se reportan dos extremos, sin elegir uno: _optimista_ (la orden en el mejor precio se considera ejecutable cuando un trade cruza ese precio) y _conservador_ (solo si el volumen negociado en ese precio supera el que tenía delante en la cola cuando se colocó). Además, selección adversa descriptiva: movimiento del medio a 1, 10 y 60 s tras el hipotético fill. Los fills maker son _hipotéticamente ejecutables_, nunca fills reales.
- Aceptación: tests con libros sintéticos de costes conocidos; el módulo no reporta retornos de estrategias.

## Etapa 4. Informe de seguimiento reproducible

`python -m balancita_engine.forward_watch report --out <dir>` (semanal y bajo demanda):

- **Estrategias forward:** operaciones independientes (agrupadas por día y producto), neto medio, error estándar y _t_ con agrupamiento, número de pruebas acumuladas del registro (para DSR), fracción de operaciones `recovered`, concentración (peso de las 3 mayores), advertencia de dependencia. _Alcanzar 100 operaciones y t > 2 es una señal de revisión, no una prueba de rentabilidad._
- **Calidad de datos:** cobertura, huecos, reconexiones, latencias, libro inválido, tamaño en disco y crecimiento.
- **Costes:** las tres categorías de la etapa 3.
- Reproducible: entrada fija (hash de las bases), salida determinista, `report.json` y `report.md`, versión del código y de los criterios. Idéntico resultado con los mismos datos.

## Etapa 5. Criterios de revisión del 7 de diciembre de 2026

Se congelan **ahora** (antes de tener datos) en `docs/criterios-revision-2026-12-07.md` con su hash. Resumen:

| Pregunta                                   | Criterio                                                                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Hay ventaja en alguna estrategia forward? | ≥ 15 operaciones forward en vivo (punto de revisión, ADR 2026-10-18), _t_ con agrupamiento > 2, neto > 0 tras costes, resultado no explicado por ≤ 3 operaciones, y corrección por pruebas acumuladas. Cumplirlo solo habilita una revisión, no una conclusión. |
| ¿Cuánto cuesta operar?                     | Spread, impacto y banda maker (optimista/conservador) en BTC y ETH, separados por categoría.                                                                                                                                                                    |
| ¿Se pueden reducir costes?                 | Solo si el maker conservador mejora el coste neto con selección adversa incluida.                                                                                                                                                                               |
| ¿La infraestructura es fiable?             | Cobertura ≥ 95 % del piloto, huecos explicados, sin saturación.                                                                                                                                                                                                 |
| ¿Vale la pena continuar?                   | Evidencia obtenida frente al coste de investigación. Tres salidas posibles ya definidas: ampliar a 8 productos, pausar el laboratorio, o preregistrar una única hipótesis nueva con presupuesto de pruebas declarado.                                           |

Reglas: no se cambian retrospectivamente; ninguna hipótesis predictiva se prueba con los datos nuevos antes de la revisión.

## Tareas y orden de PRs (cada una pequeña e independiente)

| #   | Tarea                                                                                                   | Depende                   | Entregable                                                                  |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| T0  | Este plan y los criterios congelados                                                                    | —                         | `docs/plan-observacion-forward.md`, `docs/criterios-revision-2026-12-07.md` |
| T1  | `forward_audit` solo lectura + tests                                                                    | —                         | módulo Python, informe de la Mac                                            |
| T2a | Esquema y almacén de `futures-book.sqlite` (tablas, triggers append-only, migraciones, lock)            | T0                        | PR con tests                                                                |
| T2b | Colector WebSocket (BTC y ETH): reconstrucción del libro, características por segundo, lote por segundo | T2a                       | PR con tests y simulador de feed                                            |
| T2c | Contrapresión, salud, huecos, reinicio, límites de recursos                                             | T2b                       | PR con tests de estrés                                                      |
| T2d | Piloto en la Mac (7 días) y medición real de almacenamiento y CPU                                       | T2c, autorización de Fran | informe de piloto                                                           |
| T3  | `book_costs` (observado, simulado, estimado maker con banda)                                            | T2a                       | PR con tests sintéticos                                                     |
| T4  | `forward_watch report` reproducible                                                                     | T1, T3                    | PR con tests de determinismo                                                |
| T5  | Ampliar a 8 productos (si el piloto cumple)                                                             | T2d                       | PR pequeña de configuración                                                 |
| T6  | Revisión del 7 de diciembre                                                                             | T4                        | informe y decisión de Fran                                                  |

Entre T0 y T2a puede archivarse **desde ya** el bid/ask que hoy se borra a las 24 h (cambio mínimo en `market:prune`): decisión tuya, porque toca el proceso de captura actual.

## Decisiones que necesito de Fran

1. ¿Autorizás ejecutar la auditoría (T1) en la Mac, incluida la lectura de `server/data/dev-live` y de la base forward?
2. ¿Dónde corre el colector? Por defecto en la Mac con `launchd` y `caffeinate`; los huecos por reposo quedan etiquetados.
3. ¿Querés que archive el bid/ask antes de que exista el colector (cambio de retención mínimo)?

## Trabajo futuro, no implementado (registrado 2026-10-12 a pedido de Fran)

**Portafolio compartido de 1.000 USD** con tamaño de posición dinámico y límites de riesgo globales (hoy cada operación es de 100 USD fijos y cada estrategia lleva su libro). No se implementa ahora: exigiría tocar sizing y riesgo de las estrategias congeladas (C29-C32, Kronos) y no se toca antes de la revisión del 2026-12-07 ni de las 100 operaciones. Cuando se aborde irá como brazo aparte en paper, con ADR enmendado antes de implementarlo.

## Orden de PRs acordado (2026-10-12)

1 docs (#106) · 2 funding (#107) · 3 clave `spec_hash` y auditoría forward (#108) · 4 archivo de bid/ask (#109) · 5 colector BTC/ETH independiente · 6 medición de costes maker/taker · 7 reporte semanal reproducible.
