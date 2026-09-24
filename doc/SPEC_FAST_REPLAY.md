# ESPECIFICACIÓN TÉCNICA: MOTOR DE FAST REPLAY HISTÓRICO Y PERSISTENCIA OHLC (BALANCITA)

Actúa como Ingeniero de Software Cuantitativo Senior y Desarrollador Full-Stack (Node.js 22, Fastify, TypeScript, SQLite, React 19).
Debes implementar un sistema de simulación acelerada de estrategias sobre velas de 1 minuto históricas de Kraken (BTC-EUR), desacoplando el replay de la secuencia continua de trades y permitiendo evaluar cientos de barras en milisegundos sin esperar el tiempo real.

---

### 1. RESTRICCIONES DE ARQUITECTURA Y MERCADO
1. **Mercado y Activo:** Spot puro BTC-EUR, exclusivamente modelo Long / Flat (1 = posición abierta con ticket fijo de 30,00 €, 0 = flat/euros).
2. **Modelo de Fricción Económica (`costs.v1`):**
   - Comisión: 0,10% por lado (0,20% ida/vuelta).
   - Slippage modelado: 0,05% por lado (0,10% ida/vuelta).
   - Coste total de round-trip: ~0,30%[cite: 1, 2].
   - Expectancy Gate: Exigir un movimiento objetivo mínimo de ≥ 0,60% (2× coste) para disparar la orden Long[cite: 1, 2].
3. **Causalidad Estricta (Sin Look-Ahead Bias):**
   - El cálculo de indicadores (EMA, RSI, Bollinger, Donchian) en el paso `t` debe operar únicamente sobre el array de velas cerradas `[0 ... t]`[cite: 1, 2].
   - **Prohibido ejecutar al precio de cierre `close[t]`:** Las órdenes se ejecutan al precio de apertura de la barra siguiente (`open[t+1]`)[cite: 1], ajustado por slippage:
     `precio_ejecucion = open[t+1] * (1 + 0.0005)` al comprar.
4. **Métrica de Evaluación:**
   - Brier Score multiclase ($K=3$: sube, baja, plano) medido frente al baseline uniforme ($BS = 0,6667$)[cite: 1].
   - P&L neto en euros, Win Rate y Profit Factor real tras deducir `costs.v1`[cite: 1, 2].

---

### 2. TAREA 1: INGESTA Y PERSISTENCIA OHLC (BACKEND FASTIFY + SQLITE)
1. **Tabla SQLite (`candles_1m_kraken`):**
   Crear la tabla si no existe:
   ```sql
   CREATE TABLE IF NOT EXISTS candles_1m_kraken (
       timestamp INTEGER PRIMARY KEY, -- Unix time en segundos
       open REAL NOT NULL,
       high REAL NOT NULL,
       low REAL NOT NULL,
       close REAL NOT NULL,
       volume REAL NOT NULL,
       source TEXT DEFAULT 'kraken_rest_ohlc'
   );


Servicio Ingestor REST Kraken:

Implementar un adaptador que consulte el endpoint público de Kraken:
GET https://api.kraken.com/0/public/OHLC?pair=XBTEUR&interval=1

Kraken devuelve hasta 720 velas. Implementar paginación (usando el parámetro since) para recuperar hasta 1.440 velas (24 horas) o el rango solicitado.

Descartar la última vela devuelta si aún no ha cerrado.

Insertar en SQLite con INSERT OR REPLACE INTO candles_1m_kraken.

Validar continuidad: registrar una advertencia o marcar discontinuidades donde timestamp[i] - timestamp[i-1] != 60.

Endpoint Fastify:

POST /api/market/sync-ohlc: Recibe { hours?: number } (default 24), realiza la descarga, inserta en SQLite y devuelve { inserted: number, gaps_detected: number }.

3. TAREA 2: MOTOR DE FAST REPLAY BATCH (BACKEND FASTIFY)
Implementar el evaluador de alto rendimiento para ejecutar corridas completas en milisegundos:

1. Endpoint Fastify:

POST /api/replay/fast-run

Payload:
{
  strategy_id: string; // ej. "micro-trend-pullback", "donchian-volume-breakout"
  start_time?: number;
  end_time?: number;
  ticket_eur?: number; // default 30.00
}

2. Lógica de Ejecución:

Cargar en memoria el array ordenado de velas desde candles_1m_kraken.

Validar warm-up: aplicar las primeras 50 barras como warm-up (sin emitir órdenes).

Iterar el array secuencialmente aplicando la máquina de estados Long/Flat con ticket de 30 €[cite: 1, 2].

Liquidar la posición abierta residual al cierre de la última vela evaluada para computar el P&L final.

3. Respuesta:
{
  strategy_id: string;
  candles_evaluated: number;
  trades_count: number;
  win_rate_pct: number;
  profit_factor: number;
  net_pnl_eur: number;
  brier_score_multiclass: number;
  baseline_uniform_brier: 0.6667;
  execution_time_ms: number;
}

4. TAREA 3: REPLAY ACELERADO EN FRONTEND (REACT 19 + LIGHTWEIGHT CHARTS)
Para auditoría visual sin ralentizar el navegador:

Añadir en la interfaz un selector de modo: [Tiempo Real] | [Fast Replay].

En modo Fast Replay:

Añadir botón "Sincronizar Kraken OHLC (24h)".

Añadir selector de estrategia y botón "Ejecutar Backtest Rápido" (muestra la tabla de métricas del backend en <1s).

Añadir control de reproducción visual: Slider de velocidad (1x, 5x, 20x, 50x) y botones Play / Pause / Reset.

En reproducción visual, alimentar candleSeries.update()[cite: 2] mediante un temporizador (setInterval ajustable) a partir del búfer cargado, dibujando marcadores de compra/venta cuando la estrategia cambie de estado.

5. CRITERIOS DE ACEPTACIÓN Y VALIDACIÓN
Correr tests unitarios asegurando que no existan accesos a open[t] o close[t] futuros al evaluar la señal en t.

Probar la ingesta de Kraken REST y verificar en SQLite que se persistan al menos 720 velas de 1m continuas.

Ejecutar una corrida con POST /api/replay/fast-run y comprobar que el tiempo de respuesta sea inferior a 200 ms.

Validar que si no se supera el umbral de 2× coste (≥ 0,60%), la estrategia permanezca en abstención (Flat)[cite: 1, 2].