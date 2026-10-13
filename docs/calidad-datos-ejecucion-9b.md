# Etapa 9B: calidad de datos y ejecución (contratos de métricas y plan de medición)

Estado: **investigación + utilidades aisladas**. Código: `python/balancita_engine/data_quality.py`; pruebas: `python/tests/test_data_quality.py`. Funciones puras (milisegundos y diccionarios), sin red, sin reloj de pared, sin bases, sin importar `PaperRunner`, `Portfolio` ni `ModelledExecutor` (su dueño es la etapa 9A). **No aprueba nada**: el umbral de 120 s (`PaperRunnerConfig.coverage_gap_ms`), las políticas experimentales y el sizing siguen siendo hipótesis. No toca forward, captura, Kronos, Qwen, estrategias, riesgo ni ADR.

## 1. Regla general de los contratos

1. Toda métrica lleva su **clase de evidencia**: `observed` (marcas y precios que vinieron del feed de Kraken), `modelled` (salió del modelo de costes o de un fill simulado) o `insufficient` (menos de `min_samples` observaciones: no se reporta como número firme).
2. Un número modelado **nunca** se compara contra el modelo mismo: `execution_vs_model` excluye (y cuenta) los fills `modelled`.
3. Toda ejecución histórica queda identificada como modelada (`execution=simulated_candle_open`, auditoría 9A §10).
4. Cada percentil es un valor observado (nearest-rank, sin interpolar). Siempre se informa `n`.
5. Los umbrales entran como argumento; ninguna función trae uno aprobado.

## 2. Contratos de métricas

Esquema: `balancita-data-quality.v1`. Tiempos en ms epoch.

### 2.1 Latencia de recepción (`receive_latency`)

- Definición: `received_ms − time_ms` por cotización (instante del exchange → instante de recepción), por producto.
- Entrada: `{product_id, time_ms, received_ms}`. Si falta una marca se cuenta en `missing_stamp` (no se adivina); `received < time` es sesgo de reloj o marca mala: `negative`, fuera de los percentiles.
- Salida: `n, min, p50, p90, p99, max, evidence, missing_stamp, negative`.
- **Hallazgo:** `quote_snapshot` del archivo (`quote-archive.ts`) guarda solo `received_at`. **No tiene el instante del exchange**, así que el archivo no sirve para esta métrica. Hoy solo se puede medir sobre `paper_futures_market_events` (tiene `event_time` y `received_at`, retención 24 h). Ver decisión D1.
- Lo que sí mide hoy cualquier colector sin cambios: `rtt` de un GET (≈ 230–440 ms desde el contenedor, un instante) y `candle_lag_ms` que ya expone `/api/observability/health`. No son la latencia de recepción de cotizaciones.

### 2.2 Intervalos sin cotizaciones y pérdida de cobertura (`quote_gaps`, `gap_sensitivity`)

- Silencio: tiempo entre dos instantes de evidencia consecutivos dentro de la ventana, más el tramo inicial y el final. Solo se listan los **estrictamente mayores** que el umbral (misma regla que `coverage_gap_ms` del runner: `> umbral`).
- Tipos: `leading`, `internal`, `trailing`, `no_quotes` (ventana sin ninguna cotización).
- Salida: `gaps[]`, `silent_ms`, `max_gap_ms`, `coverage_ratio = 1 − silent/ventana`.
- `gap_sensitivity` repite la lectura con 10, 30, 60, 120, 300 y 600 s; por construcción `silent_ms` es no creciente al subir el umbral (prueba).
- Alimenta tanto la captura (`quote_archive_gap`, ya registra silencios del archivo) como el runner.

### 2.3 Cobertura de vigilancia de stops (`stop_watch_coverage`)

- Por posición, entre entrada y salida (o ahora si está abierta). Evidencia: cotizaciones aceptadas **después** de la entrada (la que abrió la posición no cuenta) y rangos de velas procesadas después del minuto de entrada.
- Clases, con el mismo vocabulario que `closed_trade_coverage` del runner (arquitectura §12): `continuous`, `gaps_covered_by_candles`, `gaps_without_evidence`, y `insufficient_evidence` (nunca hubo evidencia: **no** es `continuous` por ser corta).
- Un tramo sin cubrir de hasta el umbral se tolera (igual que la auditoría 8C).
- Es una **implementación independiente** pensada como segunda opinión: la propuesta es compararla con la cobertura que produce el runner cuando 9A esté integrada (ver §5).

### 2.4 Spread e impacto (`spread_report`, `book_impact_bps`)

- Spread observado = `(ask−bid)/mid` en pb; se compara con la mediana del modelo (`futures_costs.spread_bps`), con `observed_over_model`.
- `repeat_ratio`: proporción de cotizaciones consecutivas con el mismo bid/ask. `analytics/spreads` repite ~80 % de los minutos (forward-fill): el reporte lo declara, no lo corrige.
- Impacto: recorrer el libro (mejor precio primero) para una orden de mercado de N USD; devuelve pb contra el mid, o `None` si la profundidad visible no alcanza (no se extrapola).
- **Ojo con el orden:** el endpoint `orderbook` de Kraken devuelve bids y asks en orden ascendente; hay que ordenar (bids descendente, asks ascendente) antes de llamar. Sin ordenar el resultado es absurdo (~10 000 pb).

### 2.5 Ejecución modelada contra evidencia (`execution_vs_model`)

- Entrada: fills con `mid` de la cotización al decidir, `price` pagado, `execution ∈ {observed, modelled}`.
- `residual_bps = slippage observado − side_impact_bps(producto)`; positivo = el modelo fue optimista. Salida por producto: resumen del residuo, media, `optimistic_share`, `model_impact_bps` y resumen del slippage observado.
- Solo `observed` mide. Hoy **no hay ningún fill observado** (todo es papel); la métrica se activa con cotizaciones capturadas (archivo `quotes:archive`) o con el colector de libro. Mientras tanto la comparación posible es la de §3 (libro instantáneo contra tabla del modelo).

### 2.6 Evidencia para el umbral de 120 s (`gap_stop_exposure`, `threshold_evidence`)

- `gap_stop_exposure`: para cada silencio, ¿alguna vela que lo solape tocó el precio del stop? Es una **cota superior** (`possible_breach`): el toque pudo ser antes o después del silencio. Nunca se llama "stop fallado confirmado".
- `threshold_evidence` devuelve, para un umbral candidato: silencios totales y por encima, tiempo observado, parte silenciosa, brechas posibles y `needed_observations` por la regla de tres (con 1 % y 95 % de confianza son 299 silencios por encima del umbral). Veredictos: `insufficient_evidence`, `breaches_observed`, `supports_review`. **`approved` es siempre `False`**: la decisión es de una persona.

## 3. Comparación inicial de costes modelados contra el libro público (un instante, no evidencia)

Sondeo único del 2026-10-13 (GET público `orderbook`, 3 lecturas por producto con 1 s de separación; script en `etapa-9b/sondeos/`). Es una foto, no una distribución: sirve para ver el orden de magnitud y probar las utilidades.

| Producto   | Spread modelo (pb) | Spread libro (pb) | Impacto modelo (pb, 1 000 USD) | Impacto libro 100 USD (pb) |
| ---------- | ------------------ | ----------------- | ------------------------------ | -------------------------- |
| PF_XBTUSD  | 0,12               | 0,12              | 0,06                           | 0,06                       |
| PF_ETHUSD  | 0,38               | 0,40              | 0,19                           | 0,20                       |
| PF_SOLUSD  | 0,84               | 0,93–1,87         | 0,42                           | 0,47–0,93                  |
| PF_XRPUSD  | 0,68               | 0,73              | 1,54                           | 0,37                       |
| PF_HYPEUSD | 1,49               | 3,92–4,16         | 1,48                           | 1,96–2,08                  |
| PF_ZECUSD  | 3,28               | 1,39–1,72         | 2,29                           | 0,70–0,86                  |
| PF_ADAUSD  | 3,10               | 3,81              | 2,77                           | 1,90                       |
| PF_NEARUSD | 5,41               | 4,15              | 3,55                           | 2,07                       |

Lecturas (todas provisionales):

- A 100 USD el libro visible no es el límite: el impacto es la mitad del spread (el toque). La tabla del modelo se midió para ~1 000 USD; con 100 USD fijos por operación (ADR 0001) el modelo es conservador en XRP, ZEC, ADA y NEAR.
- **HYPE** sale optimista en el modelo en este instante (impacto ≈ 2,0 pb contra 1,48 y spread ≈ 4 contra 1,49). Un instante no basta; es el primer candidato a vigilar.
- La mediana modelada vale por una distribución: hace falta muestrear el spread durante días y por franja horaria antes de tocar la tabla.

## 4. Pruebas propuestas

Hechas (en este PR, `test_data_quality.py`, 22 pruebas, sintéticas):
percentil nearest-rank y regla de tres; latencia con marcas faltantes y negativas; silencios (estricto `>`, extremos, ventana vacía, duplicados, fuera de ventana, monotonía de la sensibilidad); las cuatro clases de cobertura y el caso "corta sin evidencia"; spread con inválidos y repeticiones; recorrido del libro y falta de profundidad; residuo del modelo y exclusión de fills modelados; el umbral nunca se aprueba; pureza del módulo (sin `time`, `socket`, `sqlite3`, `random`, ni dependencia de `paper_runner`/`portfolio`).

Propuestas (dependen de 9A o de datos aún inexistentes):

1. **Paridad con el runner.** Con el runner integrado, generar sesiones sintéticas y exigir que `stop_watch_coverage` coincida con `closed_trade_coverage`. Una discrepancia es un defecto en uno de los dos.
2. **Latencia inyectada.** Reproducir cotizaciones con latencias conocidas y comprobar que los percentiles las recuperan y que `ExecutionPolicy.max_quote_age_ms` (5 s) rechaza lo esperado.
3. **Propiedad:** cualquier permutación de entrada de `quote_gaps` da el mismo resultado; añadir una cotización nunca aumenta `silent_ms`.
4. **Replay sin lookahead** (9A): el replay con velas no puede producir `observed`; si lo hace, la prueba falla.
5. **Fixture real congelado** de `quote_snapshot` (cuando exista) para fijar el formato de entrada.

## 5. Plan de medición (por fases, todo solo lectura y sin procesos persistentes nuevos)

| Fase       | Qué se mide                                          | Fuente                                                            | Condición                                                                                                        |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M0 (hecha) | utilidades + foto del libro                          | repo + API pública                                                | este PR                                                                                                          |
| M1         | silencios y cobertura del archivo de cotizaciones    | `quote_snapshot`, `quote_archive_gap`                             | autorización de Fran para leer la Mac: hoy el archivo (≈ 2026-10-12 en adelante) está fuera del rango autorizado |
| M2         | latencia de recepción real                           | `paper_futures_market_events` (24 h) o `event_time` en el archivo | decisión D1 (cambio en `quote-archive.ts`, fuera de esta etapa)                                                  |
| M3         | spread/impacto por hora y producto durante ≥ 14 días | archivo + libro BTC/ETH del colector                              | colector del libro ya existe, **sin activar**; no lo activo                                                      |
| M4         | residuo modelo vs observado                          | fills con cotización capturada                                    | requiere operaciones reales de papel con cotización archivada                                                    |
| M5         | evidencia del umbral                                 | `gap_stop_exposure` sobre M1 + velas de 1 m                       | ≥ 299 silencios por encima del umbral candidato (regla de tres al 1 %)                                           |

Qué falta para **validar** (no aprobar) 120 s: (a) el archivo de cotizaciones con suficientes posiciones-hora para ver silencios reales por producto y hora; (b) para cada silencio superior al umbral, si una vela de 1 m tocó el stop (`possible_breach`), con la tasa de brechas acotada por la regla de tres; (c) distribución de silencios por causa (WS, REST, VPN, Mac dormida) para distinguir pérdida de datos de mercado quieto — `PF_NEARUSD` o `PF_ZECUSD` pueden pasar más de 120 s sin cambio de cotización sin que falle nada; (d) sensibilidad: cuánto cambia el tiempo "no observado" entre 60, 120 y 300 s. Con los datos de hoy (≈ un día de archivo y nada leído) la respuesta es `insufficient_evidence`.

## 6. Limitaciones

- Las velas de 1 m no resuelven qué pasó dentro del minuto: `possible_breach` es cota superior.
- El archivo guarda 1 cotización cada 10 s por producto: no es el flujo completo, así que un silencio de 10–20 s en el archivo puede no ser un silencio real.
- Foto del libro ≠ ejecución real: la profundidad cambia y el impacto de una orden agresiva no se conoce hasta que existan fills observados.
- Nada de esto prueba rentabilidad ni valida una política.

## 7. Dependencias

- **9A:** ninguna de las utilidades depende de 9A. La paridad con el runner (§4.1) y el etiquetado `modelled` en el replay son posteriores a su integración. No copié implementaciones provisionales.
- **Etapa 10:** sin dependencia directa; las clases de evidencia (`observed/modelled/insufficient`) podrían reutilizarse.
- **Mission Control:** `candle_lag_ms` y la salud ya existen; esta etapa no toca frontend.
