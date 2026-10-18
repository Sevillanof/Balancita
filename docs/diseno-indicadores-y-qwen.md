# Diseño: un solo catálogo de indicadores y el papel de Qwen

Estado: propuesta (sin cambios de código). Rutas relativas a `python/balancita_engine/`. Todo sigue siendo papel; no se evalúa nada sobre holdout.

## 1. Estado actual

- **Dos implementaciones.** `futures_indicators.py:113/136` (`calculate_features`, ventana de 200 velas, `VERDICT_CONFIG.window_1m/5m=200` en `futures_verdicts.py:46`, usada en `:111-124`) alimenta C, Q y E. `futures_simulator.py:63` (`IncrementalFeatures`) y `:202` (`frames`) alimentan forward, backtest, fiabilidad, C31, `multi_experiment.py:91` y la sesión de papel. Hoy solo coinciden con los periodos por defecto; el EMA/RSI de Q arranca en una semilla de 200 velas, el del forward en `WARMUP_MS = 2000` velas 5m (`futures_replay.py:24`, fijo, no derivado). `multi_experiment.required_warmup_ms` (`:54`, 12×periodo, mínimo 288) es un tercer criterio.
- **Catálogo implícito.** `futures_spec_strategy.py:233` (`_PERIOD_FEATURE`) solo valida nombres con sufijo numérico; `_check_indicators` (`:254`) ignora todo lo que no encaje, por eso `5m.macd` pasa `validate_spec` (`:196`) y fallaría en ejecución. Los campos STATE de Q (`futures_llm_decisions.py:644`) leen `verdict.features` a mano.
- **Datos tardíos.** Forward: `LATE_KNOWN_MS`, `is_recovered` (`futures_forward.py:47,189`), `BLOCK_STALE_ENTRIES=False` (`:55`); solo cuentan los trades en vivo para `min_forward_trades`. Q, E y la sesión de papel (`paper_live_evaluator.py:20` solo cuenta `late_funding`) no comparten criterio.
- **Qwen.** Q pregunta cada minuto por producto (`DecisionService`, `:1188`); skips ya codificados en `paper_futures_llm_skips` (`:977`: `model_down`, `calm_skip`, `state_error`); C31 decide cierres sin stop (`futures_qwen_exit.py`); `LlamaCppProvider` timeout 30 s (`:763`). El ADR (enmienda 2026-10-12) prohíbe que Qwen ejecute o modifique posiciones abiertas.
- **Identidad.** `signal_continuity.pipeline_hash` (`:120`) hashea el código fuente de indicadores/`IncrementalFeatures`/`frames`: cualquier cambio rompe la reanudación de sesiones congeladas (falla cerrado).

## 2. Arquitectura objetivo

**A. Un código.** Nuevo `indicator_catalog.py`; `IncrementalFeatures` pasa a ser una composición de definiciones registradas. `calculate_features` se retira (sus validaciones —vela cerrada, `known_at`, OHLC, continuidad— pasan al alimentador común como `validate_candle`; un hueco en la secuencia reinicia y re-calienta con código `candle_sequence_gap`). Nuevo `feature_feed.py`: `warm_feed(market_db, product, as_of, needs)` carga velas oficiales 1m/5m ya almacenadas desde `as_of - warmup(needs)` (la captura rellena al arrancar) y devuelve el estado caliente; todos los consumidores (C, forward, backtest, Q, E, `multi_experiment`, sesión de papel) lo usan. Las velas de calentamiento son solo contexto: nunca generan trades (`decide_from_ms` = primera vela tras el calentamiento) y que se conocieran tarde no marca `recovered` (solo cuenta la vela de señal a salida, como `is_recovered`). Si faltan velas: `warmup_insufficient`, sin decisiones (nunca parcial).

**B. Catálogo extensible.** Una definición registrada = `name`, `params` (tipos/rangos), `inputs` (ohlcv | funding), `timeframes`, `warmup_bars(params)`, `factory(params)` (objeto incremental con `update(vela)`), `reference(params, velas)` (versión ingenua por ventana completa, solo para tests) y `status` (`active` | `reserved`). Nombre canónico `<scope>.<nombre><params>` con scope `1m`, `1m_previous`, `5m`, `funding`: `5m.ema50`, `1m.rsi14`, `5m.bollinger_upper20`, `5m.macd_12_26_9_hist`. Los nombres existentes no cambian (los specs congelados siguen válidos). `validate_spec` consulta el catálogo: nombre desconocido, parámetro fuera de rango, scope inexistente o entrada `reserved` → `SpecError`. Añadir un indicador = una definición + sus tests (referencia, convergencia, paridad).
Mapeo de STATE de Q (cada campo declara `needs`; el calentamiento de Q sale de ahí): `regime`→`5m.regime` (cadena de histéresis, calentamiento ≥288 barras); `returns_bp`→`1m.ret1/5/15/60` (nuevo, cierre/cierre−1); `dist_atr`→`1m.ema9, ema21, sma50, atr14`; `rsi14`→`1m.rsi14`; `bollinger_pos`→`1m.bollinger_lower20/upper20`; `donchian_pos`→`1m.donchian_low20/high20`; `atr_bp`→`1m.atr14`; `volume_rel`→`1m.candidate_volume`/`prior_volume_mean20`; `funding`→`funding.vs24h` (reservado, E).

**Convergencia (cómo se garantiza).** SMA/Bollinger/Donchian/logret: ventana+1 barras (exactas). EMA (semilla SMA): el peso de la semilla es (1−2/(n+1))^m; con m = 12·n queda ≈e⁻²⁴ ≈ 4·10⁻¹¹. Wilder (RSI/ATR, α=1/n): (1−1/n)^m; con m = 24·n queda ≈e⁻²⁴ (la regla actual 12·n deja ≈6·10⁻⁶ y no basta). logvol(span n): 12·n. `warmup_bars(indicador)` es la fórmula; el de un consumidor = máx. de sus `needs` +2, mínimo 288 (histéresis del régimen), expresado en barras de cada timeframe. Nota: el forward actual (2000 barras) queda corto para `logvol288` (necesita 3458); por el congelado C29-C32 conservan 2000 (`LEGACY_FROZEN_WARMUP_BARS`) y los nuevos usan el derivado. Garantía de paridad: mismo inicio ⇒ valores idénticos bit a bit; inicios distintos ⇒ diferencia relativa ≤1e-9 (la semilla nunca se olvida del todo; igual que dice hoy `multi_experiment.py:55`).

**C. Datos tardíos, criterio del forward para todos.** Se usan velas/funding tardíos (backfill) y el resultado se marca `recovered`; solo lo `live` cuenta para el mínimo de trades. Unificar `is_recovered`/`funding_recovered` en un módulo y usarlo en forward, Q (decisión sobre vela con `known_at − close_at > LATE_KNOWN_MS`), E, sesión de papel y `multi_experiment`.

**D. Qwen en OPEN y CLOSE de cada estrategia (no cada minuto).** Nuevas preguntas de Q, ámbito `gate`: `open_gate` (`go`/`wait`) y `close_gate` (`close`/`hold`), con el estado de §B más `position`. Opt-in por estrategia (`qwen_gate: true`); las congeladas (C29-C32, Kronos) no cambian hasta 100 trades forward.
- *Abrir:* la estrategia emite señal; Qwen solo confirma o veta el mismo lado (no crea trades ni cambia niveles, como el ADR de 2026-10-12). `wait` → no abre, código `qwen_wait`. Qwen caído/timeout/estado inválido → **no abre**, fila en `paper_futures_llm_skips` con `model_down` / `model_timeout` (nuevo, plazo 20 s < 1 barra) / `state_error`.
- *Cerrar:* el **stop-loss nunca consulta a Qwen** y se ejecuta siempre (también con Qwen caído y mientras una respuesta está pendiente). El objetivo (target) también es determinista. "Cierre normal" = salida por regla de la estrategia o por horizonte; Qwen puede responder `hold` (máx. 2 prórrogas o 2× horizonte, luego cierre forzado `qwen_hold_cap`). Qwen caído en un cierre normal → cierra por regla (`model_down`, anotado); protege más que esperar.
- *Registro:* decisión completa (entrada, prompt_hash, probabilidades, latencia) en `paper_futures_llm_decisions`; `paper_futures_llm_skips` gana `strategy_id`, `kind` (open/close) y `recovered`. La contabilidad es función pura de velas + decisiones almacenadas: el replay no vuelve a preguntar.
- *Prioridad y recuperación:* cola con dos prioridades; lo vivo siempre antes. Tras apagado, solo se pregunta en los momentos en que la estrategia quiso abrir/cerrar dentro del tramo recuperado, en orden cronológico por (estrategia, producto), con estado causal (lecciones solo anteriores a la vela), y todo queda `recovered`. Si una decisión viva del mismo par llega con atrasos pendientes, estos caducan con la respuesta por defecto (no abre / cierra por regla, código `recovery_expired`) para que el libro sea determinista.
- Límite declarado: el relleno sigue siendo el cierre de la vela de decisión; la latencia se registra.

**E. Funding opción b.** Solo se reserva: `funding.vs24h` (tasa actual vs media 24 h + cambio, causal, código+razón) con `status: reserved` en el catálogo (`validate_spec` lo rechaza) y el campo STATE `funding` ya existente (`:636`). Se implementa después.

## 3. Flujo de datos

```
captura Kraken ──(velas oficiales 1m/5m, backfill al arrancar)──> market.sqlite
market.sqlite ──> warm_feed(as_of, needs) ─ validate_candle ─> FeatureEngine (catálogo)
   ├─> forward / backtest / fiabilidad / C31  (señales de specs, Book)
   ├─> multi_experiment / sesión de papel      (SpecSignalStrategy)
   └─> C (verdicts) ─> Q (STATE por needs) ─> decisions / skips
señal OPEN/CLOSE de estrategia con qwen_gate ─> cola (vivo > recovered) ─> llama-server
      ├ go/close/hold ─> Book ;  caído/timeout ─> no abre / cierra por regla + skip
      └ stop-loss ─────────────────────────────> Book (sin pasar por Qwen)
E (scorer) lee verdicts/decisions; etiqueta recovered con el mismo criterio
```

## 4. Plan de PRs (pequeños, ordenados, cada uno con tests propios)

0. **Enmienda del ADR** (solo si Fran la pide expresamente; el ADR es de solo lectura): Qwen decide cierres normales y confirma aperturas de todas las estrategias opt-in.
1. **Catálogo sin cambio de comportamiento:** `indicator_catalog.py`, `IncrementalFeatures` sobre él, nombre `funding.vs24h` reservado, `warmup_bars`. Test: salidas idénticas (golden de `frames` sobre velas reales) y señales de C29-C32 idénticas. Cambia `pipeline_hash` (ver §5).
2. **`validate_spec` con catálogo:** rechaza desconocidos (`5m.macd`) y reservados; test de que todos los specs de `config/strategies/` y los guardados en el registro siguen válidos (los inválidos heredados se marcan, no se borran).
3. **`feature_feed.py`:** `warm_feed`, `validate_candle`, calentamiento derivado; forward/backtest/C31/multi/sesión lo adoptan (congelados con 2000). Tests de convergencia y de huecos.
4. **C sobre el alimentador** y retirada de `calculate_features`: `VERDICT_CONFIG` v4 sin `window_*`, BD de verdicts nueva (la vieja da `CONFIG_MISMATCH`, se conserva en solo lectura). Test de paridad completo.
5. **Q:** campos STATE con `needs`; subir versiones de pregunta (`direction_1h` 2, `trade_action` 5, `exit_decision` 2) y los pines de hash en `test_futures_llm_decisions.py`.
6. **Criterio `recovered` único** en Q, E, sesión y multi.
7. **Puerta Qwen:** preguntas `open_gate`/`close_gate`, módulo de puerta, columnas nuevas, hook en `Book` (stop fuera de la puerta).
8. **Recuperación con cola y caducidad.**
9. (Posterior) implementar `funding.vs24h`.

## 5. Qué cambia para lo existente

- **Estrategias congeladas / forward:** los ficheros de spec no se tocan ⇒ `FROZEN_SPEC_HASHES` y hashes de forward intactos; el calentamiento legado evita que C29-C32 cambien de valores. No llevan puerta Qwen.
- **Q:** cambian las entradas numéricas (semilla de 2000+ en vez de 200) ⇒ las preguntas son otras: subir versión, la calibración (`decision-calibration.json`) y las lecciones se reinician por id@version; el historial v1/v4 queda como está, sin mezclarse.
- **E (scorer):** puntúa por `verdict_hash`; con BD de verdicts nueva E reinicia su tienda de scores (la antigua queda de solo lectura); no se mezclan informes.
- **Sesión de papel / `signal_continuity`:** `pipeline_hash` cambia en el PR 1 (y en el 4 si toca fuentes hasheadas) ⇒ las sesiones en curso no son reanudables; hay que abrir una nueva (la enmienda de 2026-10-16 ya dice que cambios afectan solo a sesiones nuevas). Agrupar los cambios del pipeline para pagar este coste una vez; también caducan los checkpoints de `multi_experiment`.

## 6. Riesgos

Velas históricas insuficientes en un producto nuevo (mitigado: `warmup_insufficient`, no opera); latencia de Qwen vs. precio de relleno; Qwen vetando solo en tendencias (sesgo de muestra: se guarda cada candidato con su resultado sombra); la cola de recuperación puede retrasar lo vivo si no se acota (una petición a la vez, plazo duro); specs guardados antiguos con nombres inválidos; coste de CPU de calentar 3458+ barras por producto en cada arranque (se cachea en checkpoint, verificado con el test de reanudación).

## 7. Tests de aceptación

1. **Paridad:** mismas velas ⇒ C, forward, Q, E, sesión y multi producen valores idénticos por cada entrada del catálogo (bit a bit con mismo inicio) y cada `reference()` coincide con la versión incremental.
2. **Convergencia:** arranque con `warmup_bars` vs. historia 10× más larga ⇒ diferencia relativa ≤1e-9 por indicador; con menos barras, el test falla (prueba la fórmula).
3. **Calentamiento sin trades:** ningún trade abre dentro del calentamiento; velas tardías de calentamiento no marcan `recovered`.
4. **Recuperación:** con huecos de captura, lo tardío sale `recovered`, no suma al mínimo, Qwen se consulta solo en los momentos de abrir/cerrar del tramo, y una decisión viva se atiende antes que el atraso.
5. **Qwen caído:** en un open ⇒ sin trade y fila `model_down`/`model_timeout`; en un cierre normal ⇒ cierra por regla.
6. **Independencia del stop:** con Qwen caído, colgado o respondiendo `hold`, el stop-loss se ejecuta en la misma vela y precio que sin Qwen.
7. **Validación:** `validate_spec` rechaza `5m.macd`, periodos fuera de rango y `funding.vs24h` (reservado); acepta todos los specs enviados.
