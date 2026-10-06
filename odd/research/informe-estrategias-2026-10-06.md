# Informe de costes y mejora de estrategias de futuros perpetuos (paper) — PF_XBTUSD

Rama `feat/futures-process-split`. Solo análisis en scratch; no se modificó código del repo. Solo endpoints públicos de Kraken Futures. Todo en `/tmp/claude-0/-home-user/4f707055-43c8-5217-9a7c-3ea3d799cd69/scratchpad/strategies/`.

## 1. Resumen ejecutivo

- **C25-C28 no tienen ventaja bruta.** En los últimos 90 días la expectativa bruta por operación es -1,0 a -1,7 bp con slippage (+0,0 a +0,3 bp sin slippage), antes de comisiones. Con taker/taker (10 bp ida y vuelta) pierden unos -11 bp por operación; win rate 10-19 %, profit factor 0,07-0,17. Es estable por mes, régimen, lado y bloque de 30 días (180 días: mismo resultado).
- **El problema no es solo la regla de buffer de coste.** Con la volatilidad de los últimos 90 días, el 41-44 % de las señales (47-52 % en 180 días) sí supera el buffer de D (14 bp = 2×taker + maker + buffer). Aun así las operaciones que lo superan pierden lo mismo (-9,5 a -11,3 bp). El rechazo en vivo (`target_does_not_clear_cost_buffer`) refleja ATR bajo en esa sesión (ATR 1 m p10 = 11-12 USD frente a mediana 31 USD), pero levantar la regla no crearía rentabilidad.
- **Nivel de comisión de equilibrio: negativo.** Break-even por lado = -0,6 a -0,9 bp con slippage (-0,2 a +0,15 bp sin él). Ni maker/maker (2+2 bp: -3,7 a -4,1 bp netos) ni maker-entrada/taker-salida (-7,3 a -7,7 bp) los salvan.
- **Dos defectos mecánicos detectados (sin tocar código).** (a) C27 emite `invalidation = "opposite_donchian_mid_cross@None"` en el 100 % de las señales porque `calculate_features` no produce `donchian_mid20`; la salida por invalidación de C27 nunca se dispara en D (D captura el `ValueError`). (b) En C25 el 24 % de las señales ya nacen invalidadas (el cierre ya está al otro lado de EMA21); el 68 % de las operaciones de C25 sale por `strategy_exit` con mediana de 2 min de tenencia.
- **Variantes mejoradas de C25-C28 (C25'..C28'): ninguna sobrevive fuera de muestra.** Walk-forward 4 pliegues de 30 días (120 días OOS), 18 combinaciones por estrategia (stop/target 1,5-3 ATR, horizonte 30-360 min, sin salida EMA, filtro volatilidad k×coste): net OOS -11,0 a -11,3 bp, ninguna combinación positiva.
- **Candidatos nuevos C29-C34: ninguno bate costes fuera de muestra.** El menos malo es **C29m** (pullback 15 m + tendencia 1 h, entrada y objetivo maker): OOS agrupado -0,6 bp, IC95 % [-10,2; +9,3], n = 254, último pliegue -10,7 bp, 0 de 6 combinaciones positivas. No es estadísticamente distinguible de cero ni de ±5 bp.
- **Lo único con señal de dirección débil es el pullback 15 m**: bruto +7,3 bp (EE ≈ 4 bp) frente a -4,5 bp con la dirección invertida, pero ese sesgo es sobre todo el lado largo en un periodo alcista (BTC +21 % en 180 días) y se invierte en el último pliegue.
- **Recomendación:** no invertir más en C25-C28 salvo como controles congelados; si se quiere seguir, C29m solo como experimento paper para obtener estadísticas reales de rellenos maker, con criterio de parada explícito. Evidencia más sólida requiere más historia (>1 año, varios regímenes).

## 2. Datos, modelo de relleno y supuestos

**Datos** (API pública `charts/v1/trade/PF_XBTUSD`, vela abierta descartada, sin huecos):

| Intervalo | Velas | Rango (UTC) |
|---|---|---|
| 1 m | 259 200 | 2026-04-09 -> 2026-10-06 15:21 |
| 5 m / 15 m / 1 h | 51 840 / 17 280 / 4 320 | idéntico (180 días) |
| Funding horario | 8 760 | `historicalfundingrates` (1 año) |

Ventana principal: **últimos 90 días** (2026-07-08 -> 2026-10-06). Los primeros 90 días se usan como submuestra de estabilidad y para los pliegues walk-forward. Precio: 57,8k-87,4k USD; inicio ~71,4k, fin ~86,5k.

**Repetición de verdictos.** `replay.py` llama a `evaluate_verdict` del repo (sin copiar lógica) para los 259 200 buckets de 1 m, con ventanas fijas de 200 velas 1 m y 5 m. `known_at = close_at + 3,5 s` (la latencia vista en vivo). La cadena de régimen se precalcula con `calculate_features` + `update_regime` y se paraleliza en 4 procesos. **Verificación:** 0 discrepancias de régimen entre la cadena y los verdictos, y 1200 de 1200 hashes de verdicto idénticos frente a una repetición secuencial estilo servicio en tres tramos de 400 buckets (`ident.py`). La propuesta de salida usa `propose(..., position_side=...)` del repo con las características de C.

**Modelo de relleno (réplica de D en velas, `sim.py`):**

| Elemento | Supuesto |
|---|---|
| Entrada | Apertura de la vela 1 m siguiente a la señal, más/menos slippage |
| Slippage (por lado, conservador) | 1 tick (1 USD) + 0,5 bp del precio ≈ 5,3 USD ≈ 0,6 bp; ida y vuelta ≈ 1,2 bp |
| Stop / objetivo | Máximos/mínimos 1 m; si ambos en la misma vela, **stop primero**; hueco a través del stop llena en la apertura |
| Salida por `propose` | En cada cierre 1 m posterior a la entrada, con las características de C; relleno en la apertura siguiente |
| Time stop | 30 min (`time_stop_ms` de D) |
| Tamaño | Regla de D: riesgo 0,1 % de 10 000, tope 1000 USD nocional (siempre domina el tope; 1 bp ≈ 0,10 USD) |
| Comisiones | Config del repo: taker 0,0005, maker 0,0002 por lado |
| Regla de buffer de D | `|target - entry| > entry·(2·taker + 0,0002) + entry·0,0002` = 14 bp |
| Funding | Ignorado en C25-C28 (tenencia <= 30 min, igual que D); incluido en C29-C34 (prorrateo horario, marca de tiempo = inicio de hora) |

Sin límite de pérdida diaria en la simulación: los USD absolutos de abajo sobreestiman la pérdida que D permitiría (cierre diario al -1 %); la métrica comparable es bp por operación. Una operación a la vez por estrategia, sin solapes, igual que D.

## 3. Estrategias actuales: costes y simulación (últimos 90 días)

### 3.1 Señales y regla de buffer

| | C25 | C26 | C27 | C28 |
|---|---|---|---|---|
| Señales/día (90 d / 180 d) | 86,3 / 88,0 | 6,1 / 6,3 | 83,3 / 82,9 | 65,8 / 67,1 |
| Superan buffer D (90 d / 180 d) | 41,5 % / 47,1 % | 32,1 % / 36,5 % | 44,4 % / 51,6 % | 43,1 % / 49,2 % |
| Objetivo USD p10 / p50 / p90 | 32 / 89 / 200 | 18 / 72 / 180 | 30 / 92 / 213 | 31 / 91 / 209 |
| Stop USD p10 / p50 / p90 | 22 / 52 / 107 | 21 / 53 / 113 | 22 / 53 / 114 | 23 / 54 / 114 |
| ATR14 1 m USD p10 / p50 / p90 | 11,8 / 31,1 / 68,0 | 10,4 / 32,0 / 71,6 | 11,2 / 32,0 / 72,4 | 12,0 / 32,4 / 72,4 |
| Objetivo en ATR p10 / p50 / p90 | 2,66 / 2,87 / 2,94 | 1,19 / 2,37 / 3,39 | 2,65 / 2,87 / 2,94 | 2,56 / 2,87 / 2,94 |
| Stop en ATR p50 | 1,66 | 1,66 | 1,66 | 1,66 |
| Umbral de coste mediano (USD) | 107 | 107 | 106 | 106 |
| Objetivo / umbral p10 / p50 / p90 | 0,33 / 0,89 / 1,90 | 0,18 / 0,71 / 1,66 | 0,31 / 0,92 / 2,00 | 0,33 / 0,90 / 1,98 |

Notas: distancias medidas desde el relleno hipotético (apertura siguiente + slippage), por eso el objetivo mide ~2,87 ATR y no 3,0 y el stop ~1,66 ATR. Un objetivo de 3 ATR solo supera 14 bp si ATR1m > ~0,047 % del precio (~40 USD a 86k): ocurre en el 44,5 % de los minutos de los últimos 90 días (50,5 % en 180 días). Stop mediano 52 USD ≈ 6 bp frente a 14 bp de coste de ida y vuelta + buffer: el coste es ~2 veces la distancia al stop.

### 3.2 Simulación de D sin buffer (taker/taker, con slippage)

| | n | Win | Bruto bp | Neto bp | PF | Neto USD | Max DD USD |
|---|---|---|---|---|---|---|---|
| C25 | 7467 | 10 % | -1,36 | -11,36 | 0,07 | -8449 | 8449 |
| C26 | 541 | 14 % | -0,97 | -10,97 | 0,11 | -591 | 591 |
| C27 | 5317 | 19 % | -1,13 | -11,13 | 0,14 | -5895 | 5895 |
| C28 | 5718 | 10 % | -1,36 | -11,36 | 0,07 | -6471 | 6471 |

La curva de capital es prácticamente monótona descendente (DD = pérdida total). Con la regla de buffer de D aplicada (operaciones que D sí abriría): C25 n=3057 neto -11,27 bp; C26 n=173 -9,51; C27 n=2315 -11,16; C28 n=2426 -11,30. El buffer no selecciona ganadoras (bruto -1,3 / +0,5 / -1,2 / -1,3 bp).

Motivos de salida (sin buffer, 90 d): C25 `strategy_exit` 5071, stop 1089, target 1304, time 3. C27: stop 3415, target 1734, time 168 (0 salidas por invalidación, ver defecto abajo). C26: stop 275, target 173, strategy_exit 77, time 16. Tenencia p10/p50/p90 (min): C25/C28 1/2/9; C26/C27 0/3/16 (granularidad de 1 m).

### 3.3 Escenarios de comisión (neto bp por operación, sin buffer)

| Escenario | C25 | C26 | C27 | C28 |
|---|---|---|---|---|
| taker/taker (5+5 bp) | -11,36 | -10,97 | -11,13 | -11,36 |
| maker entrada / taker salida (2+5 bp) | -7,72 | -7,33 | -7,49 | -7,72 |
| maker/maker (2+2 bp) | -4,08 | -3,69 | -3,85 | -4,08 |
| PF taker/taker -> maker/maker | 0,07 -> 0,31 | 0,11 -> 0,44 | 0,14 -> 0,49 | 0,07 -> 0,32 |

Los escenarios maker son optimistas: asumen relleno seguro y sin slippage en las patas maker (sin modelo de cola ni de selección adversa). Aun así todos pierden.

### 3.4 Comisión de equilibrio (por lado, taker/taker simétrico)

| | Bruto tras slippage (bp/op) | Break-even/lado con slippage | Bruto sin slippage | Break-even/lado sin slippage |
|---|---|---|---|---|
| C25 | -1,36 | -0,68 bp | -0,08 | -0,04 bp |
| C26 | -0,97 | -0,48 bp | +0,31 | +0,15 bp |
| C27 | -1,13 | -0,56 bp | +0,15 | +0,08 bp |
| C28 | -1,36 | -0,68 bp | -0,08 | -0,04 bp |

Comparación: comisión real 5 bp/lado. Break-even <= 0,15 bp: ninguna estructura de comisiones realista (el menor nivel práctico es maker 2 bp) lo cubre. En 180 días: -0,68 / -0,86 / -0,61 / -0,73 bp con slippage.

### 3.5 Por régimen, mes y mitad (neto bp, taker/taker, n entre paréntesis)

| | C25 | C26 | C27 | C28 |
|---|---|---|---|---|
| Régimen trend | -11,41 (5170) | n/a | -11,39 (3133) | -11,40 (5177) |
| Régimen range | -11,24 (2297) | -10,97 (541) | -10,75 (2184) | -10,97 (541) |
| 2026-07 (parcial) | -11,42 (1835) | -10,55 (135) | -11,33 (1362) | -11,48 (1449) |
| 2026-08 | -11,14 (2589) | -10,87 (191) | -11,01 (1934) | -11,15 (2028) |
| 2026-09 | -11,60 (2565) | -11,32 (178) | -10,99 (1710) | -11,53 (1889) |
| 2026-10 (parcial) | -11,03 (478) | -11,31 (37) | -11,73 (311) | -11,19 (352) |
| Lado LONG / SHORT | -11,45 / -11,25 | -10,29 / -11,59 | -10,80 / -11,47 | -11,39 / -11,32 |
| 6 bloques de 30 d (180 d), rango neto | -11,0 a -11,6 | -10,7 a -12,8 | -10,9 a -11,7 | -11,1 a -11,7 |

Conclusión: resultado uniforme; no hay régimen ni periodo donde algún C25-C28 tenga ventaja bruta.

### 3.6 Defectos mecánicos observados

- **C27 `@None`:** `propose` construye `"opposite_donchian_mid_cross@" + str(current.get("donchian_mid20"))`, pero `calculate_features` no devuelve `donchian_mid20` (solo los tests lo inyectan). Verificado: la única invalidación en los 129 600 verdictos es `opposite_donchian_mid_cross@None`. En D, `propose` con umbral `"None"` lanza `ValueError`, capturado, y la salida nunca se activa. C27 en vivo solo sale por stop/target/time stop (la simulación lo refleja).
- **C25 invalidada al nacer:** 1873 de 7766 señales (24,1 %) tienen ya el cierre por debajo de EMA21 (LONG) o por encima (SHORT); la primera comprobación de salida las cierra a ~1 min. En conjunto 5071 de 7467 operaciones salen por `strategy_exit`, win rate 10 %.
- **Efecto neto:** quitar la salida por EMA21 (variantes C25'/C27') no genera ventaja (sección 4.3): el problema de fondo es la ausencia de ventaja bruta, no solo las salidas.

## 4. Candidatos y variantes: resultados fuera de muestra

**Metodología (sin lookahead).** Cuatro pliegues walk-forward sobre los 180 días (omitiendo 2 días de calentamiento): ajuste 60 d -> prueba 30 d, deslizando 30 d (pruebas: días 62-92, 92-122, 122-152, 152-180). El pliegue 4 equivale a "ajustar en los 60 d previos, probar en los últimos 30 d". Selección: mayor neto medio en ajuste con n >= 20. **Titular = OOS agrupado de los 4 pliegues (120 d)** y pliegue 4 (últimos 30 d). Señales a cierre de vela (velas oficiales 5 m/15 m/1 h, indicadores flotantes con las fórmulas del repo), entrada en la apertura 1 m siguiente, mismo modelo de salidas y slippage, taker/taker salvo indicación, funding incluido. IC95 % por bootstrap de operaciones (2000 remuestreos). `k` = el objetivo debe ser >= k x 14 bp.

### 4.1 Nuevos candidatos (C29+)

| Id | Descripción | OOS n | Neto bp | IC95 % | Bruto bp | Win | PF | t | Último pliegue (n, neto) |
|---|---|---|---|---|---|---|---|---|---|
| C29 | Pullback 15 m (misma lógica C25) + tendencia 1 h (EMA9>EMA21, cierre>SMA50); stop/target 1,5-2 / 3-4 ATR 15 m; time stop 4-12 h; k=1,5 | 266 | -4,4 | [-13,3; +5,5] | +5,6 | 39 % | 0,88 | -0,93 | 58, -15,1 |
| C29m | C29 con entrada limit post-only (espera 10 min, relleno si el mínimo/máximo cruza 1 tick) y objetivo maker | 254 | -0,6 | [-10,2; +9,3] | +5,5 | 39 % | 0,98 | -0,12 | 55, -10,7 |
| C30 | Ruptura Donchian20 + volumen>1,25x en 15 m + tendencia 1 h | 282 | -6,9 | [-14,3; +0,6] | +3,1 | 37 % | 0,79 | -1,76 | 67, -11,2 |
| C31 | 1 h: ruptura Donchian 24/48/96, stop chandelier 3-4,5 ATR 1 h, tenencia hasta 7 d | 69 | -32,0 | [-72,6; +13,3] | -22,2 | 32 % | 0,61 | -1,43 | 13, -25,1 |
| C32 | Reversión 15 m (banda Bollinger + RSI) en régimen range de 1 h, objetivo = media BB | 83 | -11,3 | [-23,5; +0,6] | -1,3 | 46 % | 0,60 | -1,87 | 19, -17,1 |
| C33 | Contrarian de funding (cuantil móvil pasado q=0,90-0,98), mantener 8-24 h, stop 3 ATR 1 h | 72 | -15,6 | [-53,7; +23,9] | -6,4 | 46 % | 0,78 | -0,77 | 18, -47,3 |
| C34 | Pullback 5 m + tendencia 1 h (el ejemplo "mismos setups en 5 m") | 816 | -11,6 | [-14,5; -8,7] | -1,6 | 35 % | 0,53 | -7,73 | 237, -11,3 |

Ninguno es positivo OOS. Los únicos con IC que incluye 0 con holgura son C29, C29m, C31 y C33, pero por falta de potencia (desviación por operación ≈ 80 bp para 15 m; con n≈250 el error estándar es ≈5 bp) y no por evidencia de ventaja.

### 4.2 Robustez

| Id | Neto bp por pliegue de prueba (1->4) | Sensibilidad: red (n comb.) neto min / mediana / max | Combinaciones positivas | Lado LONG / SHORT (neto, n) |
|---|---|---|---|---|
| C29 | -2,9 / -2,9 / +2,0 / -15,1 | 6: -11,4 / -7,8 / -4,4 | 0 | +2,8 (145) / -13,1 (121) |
| C29m | -2,8 / +1,2 / +9,4 / -10,7 | 6: -7,2 / -4,6 / -0,6 | 0 | +6,3 (137) / -8,7 (117) |
| C30 | -8,4 / -16,5 / +7,9 / -11,2 | 6: -11,1 / -8,6 / -5,1 | 0 | -2,4 (164) / -13,1 (118) |
| C31 | -100,8 / -37,0 / +14,6 / -25,1 | 6: -67,1 / -37,0 / -19,0 | 0 | +7,0 (35) / -72,2 (34) |
| C32 | -17,2 / -6,6 / -7,1 / -17,1 | 4: -12,0 / -10,2 / -8,1 | 0 | -10,6 (34) / -11,8 (49) |
| C33 | -43,3 / -19,0 / +31,9 / -47,3 | 6: -26,4 / -13,4 / +1,3 | 1 de 6 (n=37-152) | +17,8 (33) / -43,8 (39) |
| C34 | -12,4 / -12,0 / -11,0 / -11,3 | 6: -11,6 / -11,3 / -11,0 | 0 | -10,1 (456) / -13,6 (360) |

Estabilidad: el signo de C29/C29m/C30/C31/C33 cambia de pliegue a pliegue (ruido, no régimen persistente); todos pierden en el último pliegue. C29 eligió siempre los mismos parámetros (2 ATR stop, 4 ATR objetivo, 12 h) en los 4 pliegues, lo que es estabilidad de selección, pero la sensibilidad muestra que las 6 combinaciones son negativas, con mejor resultado en los parámetros de objetivo/stop más amplios (menor ratio coste/distancia).

**Prueba de dirección (180 d, bruto bp tras slippage, parámetros fijos 2/4 ATR, no OOS; EE = error estándar):**

| Id | Señal | Invertida | Siempre largo | Siempre corto |
|---|---|---|---|---|
| C29 (n≈400) | +7,3 (EE 4,1) | -4,5 | -0,9 | +2,9 |
| C30 (n≈400) | +0,7 (EE 4,4) | -0,4 | +2,0 | -1,6 |
| C34 (n≈1200) | +0,6 (EE 1,3) | -0,8 | -0,9 | +0,7 |

La dirección del pullback 15 m aporta ~12 bp frente a invertirla (≈1,7 EE; no concluyente). C30 y C34 no distinguen señal de azar.

### 4.3 Variantes mejoradas de C25-C28 (señales exactas del replay, 18 combinaciones cada una)

Cambios probados: sin salida por EMA21/invalidación, stop/target {1,5/3; 2/4; 3/6} ATR 1 m, time stop {30, 120, 360} min, filtro de volatilidad k {0, 1,2} (objetivo >= 1,2 x 14 bp); C26 conserva el objetivo en la media Bollinger.

| Id | OOS n | Neto bp | IC95 % | Bruto bp | Win | PF | Neto por pliegue | Red neto min / mediana / max | Último pliegue |
|---|---|---|---|---|---|---|---|---|---|
| C25' | 1989 | -11,0 | [-12,1; -9,9] | -1,0 | 35 % | 0,38 | -11,4 / -11,3 / -9,6 / -11,7 | -11,7 / -11,3 / -10,6 | n=507, -11,7 |
| C26' | 321 | -11,3 | [-13,6; -9,0] | -1,3 | 34 % | 0,26 | -11,8 / -10,6 / -14,7 / -5,9 | -11,5 / -11,0 / -9,9 | n=45, -5,9 |
| C27' | 2978 | -11,1 | [-12,1; -10,2] | -1,1 | 33 % | 0,40 | -10,7 / -12,0 / -10,6 / -11,3 | -11,4 / -11,0 / -10,8 | n=633, -11,3 |
| C28' | 1801 | -11,1 | [-12,4; -9,8] | -1,1 | 33 % | 0,41 | -12,4 / -11,8 / -10,7 / -9,4 | -11,4 / -11,2 / -10,6 | n=447, -9,4 |

Ninguna de las 72 combinaciones es positiva. Subir el win rate (10 % -> 33-35 %) con stops/objetivos más anchos o sin salida EMA no cambia el bruto (~-1 bp): el coste fijo de 11 bp domina cualquier cambio de salida. Con n grande el resultado es estadísticamente claro: **no hay ventaja que recuperar en estas entradas a 1 m.**

**Número de configuraciones probadas:** ~112 combinaciones de parámetros (6+6+6+6+4+6+6 candidatos + 72 variantes) por 4 pliegues. Un resultado positivo aislado sería sospechoso por comparaciones múltiples; los resultados negativos no dependen de ello.

## 5. Recomendaciones (en orden)

| # | Recomendación | Evidencia | Reemplazar o id nuevo |
|---|---|---|---|
| 1 | No aumentar exposición ni afinar C25-C28; mantenerlos como controles congelados (o pausarlos). No relajar el buffer de coste para "dejar entrar" operaciones. | Bruto -1 a -1,7 bp; 0 de 72 variantes OOS positivas; el buffer no selecciona ganadoras. | Dejarlos como están (ADR: histórico). |
| 2 | Corregir el defecto de `donchian_mid20` (C27 sin salida por invalidación) y evitar entradas ya invalidadas (C25) solo si se mantienen como control. No cambia la rentabilidad. | Sección 3.6. | Cambio de esquema de características (`c27-features.v2`) + `VERDICT_CONFIG` nuevo = nuevo hash y DB de verdictos; en la práctica C25b/C27b como ids nuevos para no mezclar series. |
| 3 | **C29m** como experimento paper: pullback 15 m + tendencia 1 h, entrada post-only, objetivo maker, stop taker, stop 2 ATR / objetivo 4 ATR (15 m), time stop 12 h, filtro k=1,5. Criterio de parada: <= 0 bp neto tras 150 operaciones o fill rate maker < 70 %. | OOS -0,6 bp, IC [-10,2; +9,3], n=254; bruto +5,5 bp; mejor del conjunto, sin evidencia suficiente. | **Id nuevo (C29).** No es reemplazo de C25 (otra marco temporal y otro modo de ejecución). |
| 4 | Capturar datos que permitan modelar maker: ticker/L1 con tamaños, trades, tasa de relleno de limit orders. | Todos los escenarios maker de este informe son optimistas. | Infraestructura (C/capture), sin id. |
| 5 | Descartar C30, C31, C32, C33, C34 en su forma actual; repetir C31/C33 solo con >= 2 años de historia. | OOS negativos; n=69-83 (C31/C32/C33) insuficientes. | Ninguno. |
| 6 | Si el nivel de comisión de la cuenta real pudiera bajar (rebates maker, tier), recalcular: C29 necesita comisión total <= ~5,5 bp ida y vuelta con relleno garantizado. | Bruto C29 +5,5 bp. | n/a. |

**Qué haría falta para implementar C29m como C29 en C (verdictos) y D (ejecución):**

- **C (`futures_verdicts.py`, `futures_strategies.py`):** ventanas de 15 m y 1 h de velas oficiales (hoy `evaluate_verdict` solo lee 1 m y 5 m; el capture ya construye 15 m y 1 h), `calculate_features` por intervalo (ya admite `interval_ms`), `VERDICT_CONFIG` nuevo (ventanas 15 m y 1 h) con nuevo hash/DB; nuevo id en `STRATEGY_IDS` y rama en `propose` (señal solo en los cierres de 15 m, `signal_key` por bucket de 15 m); `horizon_minutes` por estrategia (hoy fijo en 30 en `_proposal`); stop/objetivo en múltiplos del ATR de 15 m; `select_proposal` ya ordena por objetivo/stop; filtro k x coste en C; tests RED/GREEN y doble repetición idéntica.
- **D (`futures_paper_execution.py`):** `PAPER_EXECUTION_CONFIG` v3 con time stop por operación (hoy `time_stop_ms` global de 30 min), entrada limit post-only con cancelación a los N min y regla de relleno con el ticker (cruce de 1 tick; hoy solo `market_ioc` con espera de 5 s), objetivo como limit reduce-only y stop taker, comisión maker en el ledger (ya soportada por `FuturesLedger`), regla de buffer por estrategia (hoy `entry·(2·taker + 0,0002) + entry·0,0002` para todas), sizing sin cambios (tope 1000 USD), `funding_complete` con posiciones de hasta 12 h (funding publicado solo al cierre de hora) y tests de equivalencia vivo = repetición.

## 6. Limitaciones

- **Relleno por velas:** precios de trade, no de marca; D dispara stops con la marca. No hay libro ni cola: slippage fijo supuesto (1 tick + 0,5 bp), spread real no medido. Latencia de 3,5 s del verdicto y 100 ms de D no simuladas (entrada = apertura exacta de la vela siguiente).
- **Maker optimista:** el modelo de relleno maker (cruce de 1 tick) ignora prioridad de cola y rechazos post-only; C29m y los escenarios maker/maker son cotas superiores.
- **Una sola ventana de 180 días y un solo régimen macro** (tendencia alcista, +21 %): el sesgo largo favorece a C29/C29m/C31/C33; la dirección corta pierde sistemáticamente. No cubre un mercado bajista prolongado.
- **Potencia estadística limitada** para candidatos de 15 m-1 h (n = 69-282): solo se detectan efectos > ~10 bp. C31/C32/C33 tienen n < 100.
- **Riesgo de sobreajuste:** ~112 combinaciones x 4 pliegues; pliegues con ventanas de ajuste solapadas; los parámetros "óptimos" de C29 son los extremos de la red (objetivo/stop más amplios), lo que sugiere sensibilidad al coste y no un máximo interior.
- **Funding:** marca de tiempo asumida como inicio de hora; en C25-C28 se ignora (tenencias <= 30 min), igual que D (que además deja `funding_complete=false` en cierres previos a la publicación).
- **Sin pérdida diaria ni compounding** en la simulación de D; USD absolutos solo orientativos. Basis/mark-index no analizado (no hay histórico público de basis en velas de trade); las señales de funding usan solo la tasa horaria.
- **Réplica de D simplificada:** sin comprobación de `max_spread_bps`, tamaño mostrado ni `horizon_margin_ms`; una operación a la vez por estrategia (el selector real puede ver señales conflictivas entre estrategias).

## Anexo: archivos

`download.py` (datos), `replay.py` / `ident.py` (verdictos del repo e identidad), `sim.py` + `an1.py` (réplica de D y análisis 1), `engine.py` + `cand.py` + `cand2.py` + `cand_var.py` + `edge.py` (candidatos y variantes), resultados en `results_*.json`, datos en `data/`.
