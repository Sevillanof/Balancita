# Diseño: un solo catálogo de indicadores y el papel de Qwen

Estado: propuesta con decisiones del dueño del 2026-10-18 aplicadas (sin cambios de código). Rutas relativas a `python/balancita_engine/`. Todo sigue siendo papel; no se evalúa nada sobre holdout.

## 1. Estado actual

- **Dos implementaciones.** `futures_indicators.py:113/136` (`calculate_features`, ventana de 200 velas, `VERDICT_CONFIG.window_1m/5m=200` en `futures_verdicts.py:46`, usada en `:111-124`) alimenta C, Q y E. `futures_simulator.py:63` (`IncrementalFeatures`) y `:202` (`frames`) alimentan forward, backtest, fiabilidad, C31, `multi_experiment.py:91` y la sesión de papel. Hoy solo coinciden con los periodos por defecto; el EMA/RSI de Q arranca en una semilla de 200 velas, el del forward en `WARMUP_MS = 2000` velas 5m (`futures_replay.py:24`, fijo, no derivado). `multi_experiment.required_warmup_ms` (`:54`, 12×periodo, mínimo 288) es un tercer criterio.
- **Catálogo implícito.** `futures_spec_strategy.py:233` (`_PERIOD_FEATURE`) solo valida nombres con sufijo numérico; `_check_indicators` (`:254`) ignora todo lo que no encaje, por eso `5m.macd` pasa `validate_spec` (`:196`) y fallaría en ejecución. Los campos STATE de Q (`futures_llm_decisions.py:644`) leen `verdict.features` a mano.
- **Datos tardíos.** Forward: `LATE_KNOWN_MS`, `is_recovered` (`futures_forward.py:47,189`), `BLOCK_STALE_ENTRIES=False` (`:55`); solo cuentan los trades en vivo para `min_forward_trades` (para estrategias nuevas el umbral de revisión es 15 trades vivos, no 100; ver la enmienda 2026-10-18 del ADR; los trades sin clasificar nunca cuentan). Q, E y la sesión de papel (`paper_live_evaluator.py:20` solo cuenta `late_funding`) no comparten criterio.
- **Qwen.** Q pregunta cada minuto por producto (`DecisionService`, `:1188`); skips ya codificados en `paper_futures_llm_skips` (`:977`: `model_down`, `calm_skip`, `state_error`); C31 decide cierres sin stop (`futures_qwen_exit.py`); `LlamaCppProvider` timeout 30 s (`:763`). El ADR (enmienda 2026-10-12) prohíbe que Qwen ejecute o modifique posiciones abiertas.
- **Identidad.** `signal_continuity.pipeline_hash` (`:120`) hashea el código fuente de indicadores/`IncrementalFeatures`/`frames`: cualquier cambio rompe la reanudación de sesiones congeladas (falla cerrado).

## 2. Arquitectura objetivo

**A. Un código.** Nuevo `indicator_catalog.py`; `IncrementalFeatures` pasa a ser una composición de definiciones registradas. `calculate_features` se retira (sus validaciones —vela cerrada, `known_at`, OHLC, continuidad— pasan al alimentador común como `validate_candle`; un hueco en la secuencia reinicia y re-calienta con código `candle_sequence_gap`). Nuevo `feature_feed.py`: `warm_feed(market_db, product, as_of, needs)` carga velas oficiales 1m/5m ya almacenadas desde `as_of - warmup(needs)` (la captura rellena al arrancar) y devuelve el estado caliente; todos los consumidores (C, forward, backtest, Q, E, `multi_experiment`, sesión de papel) lo usan. Las velas de calentamiento son solo contexto: nunca generan trades (`decide_from_ms` = primera vela tras el calentamiento) y que se conocieran tarde no marca `recovered` (solo cuenta la vela de señal a salida, como `is_recovered`). Si faltan velas: `warmup_insufficient`, sin decisiones (nunca parcial).

**B. Catálogo extensible.** Una definición registrada = `name`, `params` (tipos/rangos), `inputs` (ohlcv | funding), `timeframes`, `warmup_bars(params)`, `factory(params)` (objeto incremental con `update(vela)`), `reference(params, velas)` (versión ingenua por ventana completa, solo para tests) y `status` (`active` | `reserved`). Nombre canónico `<scope>.<nombre><params>` con scope `1m`, `1m_previous`, `5m`, `funding`: `5m.ema50`, `1m.rsi14`, `5m.bollinger_upper20`, `5m.macd_12_26_9_hist`. Los nombres existentes no cambian (los specs congelados siguen válidos). `validate_spec` consulta el catálogo: nombre desconocido, parámetro fuera de rango, scope inexistente o entrada `reserved` → `SpecError`. Añadir un indicador = una definición + sus tests (referencia, convergencia, paridad).
Mapeo de STATE de Q (cada campo declara `needs`; el calentamiento de Q sale de ahí): `regime`→`5m.regime` (cadena de histéresis, calentamiento ≥288 barras); `returns_bp`→`1m.ret1/5/15/60` (nuevo, cierre/cierre−1); `dist_atr`→`1m.ema9, ema21, sma50, atr14`; `rsi14`→`1m.rsi14`; `bollinger_pos`→`1m.bollinger_lower20/upper20`; `donchian_pos`→`1m.donchian_low20/high20`; `atr_bp`→`1m.atr14`; `volume_rel`→`1m.candidate_volume`/`prior_volume_mean20`; `funding`→`funding.vs24h` (reservado, E).

**Convergencia (cómo se garantiza).** SMA/Bollinger/Donchian/logret: ventana+1 barras (exactas). EMA (semilla SMA): el peso de la semilla es (1−2/(n+1))^m; con m = 12·n queda ≈e⁻²⁴ ≈ 4·10⁻¹¹. Wilder (RSI/ATR, α=1/n): (1−1/n)^m; con m = 24·n queda ≈e⁻²⁴ (la regla actual 12·n deja ≈6·10⁻⁶ y no basta). logvol(span n): 12·n. `warmup_bars(indicador)` es la fórmula; el de un consumidor = máx. de sus `needs` +2, mínimo 288 (histéresis del régimen), expresado en barras de cada timeframe. Nota: el forward actual (2000 barras) queda corto para `logvol288` (necesita 3458); por el congelado C29-C32 conservan 2000 (`LEGACY_FROZEN_WARMUP_BARS`) y los nuevos usan el derivado. Garantía de paridad: mismo inicio ⇒ valores idénticos bit a bit; inicios distintos ⇒ diferencia relativa ≤1e-9 (la semilla nunca se olvida del todo; igual que dice hoy `multi_experiment.py:55`).

**C. Datos tardíos, criterio del forward para todos.** Se usan velas/funding tardíos (backfill) y el resultado se marca `recovered`; solo lo `live` cuenta para el mínimo de trades. Unificar `is_recovered`/`funding_recovered` en un módulo y usarlo en forward, Q (decisión sobre vela con `known_at − close_at > LATE_KNOWN_MS`), E, sesión de papel y `multi_experiment`.

**D. Qwen en cada OPEN; cierre solo por target, stop o regla de cierre.** Decisiones del dueño (2026-10-18, enmienda al ADR en el PR 0). Nueva pregunta de Q, ámbito `gate`: `open_gate` (`go`/`wait`), con el estado de §B. Opt-in por estrategia (`qwen_gate: true`); las congeladas (C25-C32) no cambian y su historial queda como evidencia. C31 se apaga y C32 se retira.

- _Abrir:_ la estrategia emite señal; Qwen solo confirma o veta el mismo lado (no crea trades ni cambia niveles). `wait` → no abre, código `qwen_wait`. Qwen caído/timeout/estado inválido → **no abre**, fila en `paper_futures_llm_skips` con `model_down` / `model_timeout` (nuevo, plazo 20 s < 1 barra) / `state_error`, siempre con código y razón.
- _Cerrar:_ una posición se cierra **solo** por (1) objetivo (target) alcanzado, (2) stop de protección alcanzado, o (3) una regla de cierre. El stop **nunca consulta a Qwen** y se ejecuta siempre (también con Qwen caído o con una respuesta pendiente). **No hay cierre por tiempo** (sin salida por horizonte) en estrategias nuevas; se elimina la regla de prórrogas (`hold` máx. 2, 2× horizonte, `qwen_hold_cap`). Las reglas de cierre **no están definidas**; que Qwen proponga cierres podrá ser una de ellas más adelante (requerirá su propia definición y enmienda).
- _Registro:_ decisión completa (entrada, prompt_hash, probabilidades, latencia) en `paper_futures_llm_decisions`; `paper_futures_llm_skips` gana `strategy_id`, `kind` y `recovered`. La contabilidad es función pura de velas + decisiones almacenadas: el replay no vuelve a preguntar.
- _Expectativa auditable:_ cada decisión de Qwen lleva una expectativa concreta y evaluable, guardada junto a la decisión. Esbozo de esquema (`expectation`): `{kind: "move_bp" | "hit_target_before" | "no_stop_before", side, magnitude_bp, deadline_ms, reference_price, stated_at_ms}`; p. ej. "+30 pb antes de <hora>" = `{kind:"move_bp", side:"long", magnitude_bp:30, deadline_ms:...}`. La respuesta sigue siendo restringida (letra + probabilidades); la expectativa se deriva de campos fijos, no de texto libre. Después de `deadline_ms` un evaluador (el scorer E existente o un hermano que reutilice su cálculo de resultado sobre velas, solo causal) escribe `expectation_outcome` (`met`/`missed`/`pending`, movimiento realizado, MFE/MAE, `recovered`) y se agrega por estrategia/versión de pregunta (tasa de acierto, calibración). Es medición de la calidad de Qwen; no cierra posiciones ni mueve niveles.
- _Prioridad y recuperación:_ cola con dos prioridades; lo vivo siempre antes. Tras apagado, solo se pregunta en los momentos en que la estrategia quiso abrir dentro del tramo recuperado, en orden cronológico por (estrategia, producto), con estado causal, y todo queda `recovered`. Si llega una decisión viva del mismo par con atrasos pendientes, estos caducan con la respuesta por defecto (no abre, código `recovery_expired`).
- Límite declarado: el relleno sigue siendo el cierre de la vela de decisión; la latencia se registra.
- **Preguntas abiertas (el dueño debe resolverlas).** (a) _Reglas de cierre: por definir._ (b) _Qué pasa con una posición que nunca toca target ni stop y ninguna regla dispara:_ riesgo declarado: el capital queda comprometido indefinidamente, una posición por estrategia/producto bloquea nuevas entradas y el funding sigue acumulándose como coste. Antes de poner en vivo estrategias así hay que definir las reglas de cierre. (c) Si las expectativas de Qwen deben tener un plazo máximo permitido.

**E. Funding.** Es coste para todas las estrategias. La opción b (comparación a 24 h) es la funcionalidad general: `funding.vs24h` (tasa actual vs media 24 h + cambio, causal, código+razón), reservada (`status: reserved`, `validate_spec` la rechaza) hasta implementarla; campo STATE `funding` ya existente (`:636`).

## 3. Flujo de datos

```
captura Kraken ──(velas oficiales 1m/5m, backfill al arrancar)──> market.sqlite
market.sqlite ──> warm_feed(as_of, needs) ─ validate_candle ─> FeatureEngine (catálogo)
   ├─> forward / backtest / fiabilidad / C31  (señales de specs, Book)
   ├─> multi_experiment / sesión de papel      (SpecSignalStrategy)
   └─> C (verdicts) ─> Q (STATE por needs) ─> decisions / skips
señal OPEN de estrategia con qwen_gate ─> cola (vivo > recovered) ─> llama-server
      ├ go/wait + expectativa ─> Book ;  caído/timeout ─> no abre + skip
      └ target / stop / regla de cierre ──> Book (el stop no pasa por Qwen; sin cierre por tiempo)
E (scorer) lee verdicts/decisions; califica expectativas; etiqueta recovered con el mismo criterio
```

## 4. Plan de PRs (pequeños, ordenados, cada uno con tests propios)

0. **Enmienda del ADR 2026-10-18** (pedida por Fran; solo se añade al final): catálogo único, criterio tardío del forward, Qwen en cada OPEN con expectativa auditable, cierre solo por target/stop/regla (sin cierre por tiempo), C25-C32 congeladas, funding como coste y opción b general, C31 apagada y C32 retirada. Bloquea el PR 7.
1. **Catálogo sin cambio de comportamiento:** `indicator_catalog.py`, `IncrementalFeatures` sobre él, nombre `funding.vs24h` reservado, `warmup_bars`. Test: salidas idénticas (golden de `frames` sobre velas reales) y señales de C29-C32 idénticas. Cambia `pipeline_hash` (ver §5).
2. **`validate_spec` con catálogo:** rechaza desconocidos (`5m.macd`) y reservados; test de que todos los specs de `config/strategies/` y los guardados en el registro siguen válidos (los inválidos heredados se marcan, no se borran).
3. **`feature_feed.py`:** `warm_feed`, `validate_candle`, calentamiento derivado; forward/backtest/C31/multi/sesión lo adoptan (congelados con 2000). Tests de convergencia y de huecos.
4. **C sobre el alimentador** y retirada de `calculate_features`: `VERDICT_CONFIG` v4 sin `window_*`, BD de verdicts nueva (la vieja da `CONFIG_MISMATCH`, se conserva en solo lectura). Test de paridad completo.
5. **Q:** campos STATE con `needs`; subir versiones de pregunta (`direction_1h` 2, `trade_action` 5, `exit_decision` 2) y los pines de hash en `test_futures_llm_decisions.py`.
6. **Criterio `recovered` único** en Q, E, sesión y multi.
7. **Puerta Qwen en OPEN:** pregunta `open_gate`, módulo de puerta, columnas nuevas, hook en `Book` en la apertura (el stop no pasa por Qwen). Sin `close_gate` ni cierre por horizonte.
8. **Expectativas auditables:** campo `expectation` en las decisiones y evaluador (E o hermano) que escribe `expectation_outcome`. Depende del 7.
9. **Recuperación con cola y caducidad** (solo aperturas).
10. (Posterior) implementar `funding.vs24h`.
11. (Bloqueado hasta que Fran defina las reglas de cierre) estrategias nuevas con puerta Qwen en vivo; apagar C31 y retirar C32 puede ir antes, en su propio PR pequeño.

Orden revisado: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9; los PR 1-6 no dependen de Qwen ni de reglas de cierre y pueden avanzar tras el 0.

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
5. **Qwen caído:** en un open ⇒ sin trade y fila `model_down`/`model_timeout` con código y razón.
6. **Independencia del stop:** con Qwen caído o colgado, el stop-loss se ejecuta en la misma vela y precio que sin Qwen.
7. **Validación:** `validate_spec` rechaza `5m.macd`, periodos fuera de rango y `funding.vs24h` (reservado); acepta todos los specs enviados.
8. **Sin cierre por tiempo:** una estrategia nueva sin target/stop alcanzado ni regla de cierre mantiene la posición abierta indefinidamente (no hay salida por horizonte); verificado en test.
9. **Expectativas:** cada decisión de Qwen guarda su `expectation`; pasado el plazo el evaluador la califica solo con velas causales y marca `recovered` igual que el resto.
