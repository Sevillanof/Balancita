# Estrategias externas en barras de 30 m, 1 h y 2 h: informe del analista C

Fecha: 2026-10-06. Solo análisis; solo datos públicos de Kraken Futures (PF_XBTUSD); solo paper (ADR 0001). No se modificó código del repo. Todo el material está en `quant/` del scratchpad.

## 1. Resumen ejecutivo

- **Ninguna estrategia externa sobrevive.** Se implementaron 29 entradas del catálogo (28 estrategias en las tablas, X28 es un modo de X27; ver `quant/catalogo-C.md`) en 30 m, 1 h y 2 h con rejillas pequeñas declaradas: **306 pruebas** en total (incluidas 15 combinaciones con A y 1 cartera). El DSR (contando todas las pruebas) máximo de todas las filas, taker y maker, es **0,00004**; con una varianza entre pruebas mucho más benigna (la de A) sube como mucho a 0,028. Ninguna fila tiene DSR cerca de 0,95.
- **Periodo OOS agrupado:** 2023-03-23 a 2026-09-17 (14 pliegues de 91 días, 1.294 días). Comprar y mantener en ese periodo: Sharpe 0,86, retorno total 181 %, DD máx. 55 %. Es un periodo muy alcista; cualquier estrategia con sesgo largo parece buena por beta.
- **Taker (5 bp + 1 tick + 0,5 bp por lado):** de 84 filas (28 estrategias x 3 marcos), 31 tienen Sharpe OOS > 0 y 14 además tienen >= 100 operaciones. Solo **1** tiene el límite inferior del IC95 % del Sharpe por encima de 0 (Cluc 2 h, 42 operaciones, no concluyente). **Ninguna** tiene alfa positivo frente a comprar y mantener con el IC95 % por encima de 0. Las filas concluyentes con Sharpe > 0 son sesgo largo de tendencia o de sesión (beta 0,4-0,7) que depende de que el mercado suba, como A; las dos excepciones sin beta (X24 2 h, Sharpe 0,48, y X27 2 h, Sharpe 0,05) no son distinguibles de cero ni son robustas entre marcos.
- **Maker/maker (2 bp por lado, optimista):** 51 filas con Sharpe > 0 y 37 concluyentes. La mejor candidata es **X03 largo solo con NYSE cerrado (30 m)**: Sharpe 1,07 [0,13; 2,02], DD 35 % frente a 55 % de comprar y mantener, 924 operaciones, pero beta 0,59 y alfa +17 %/año con IC [-6 %; +39 %]. Segunda: **X01 hora 21-23 UTC** (Quantpedia): bruto +7,2 bp por operación, neto +3,2 bp solo con maker, Sharpe 0,90 [-0,19; 1,90], y la ventaja se pierde en las dos mitades de 2026 (Sharpe -1,0 y -3,1).
- **Estacionalidad:** el efecto horario 21-23 UTC existe en bruto pero (+7 bp) no cubre 12 bp taker. El control honesto (X05: elegir la mejor ventana de 2 h en entrenamiento y operarla) da Sharpe -2,2 a -2,6: la ventana elegida no persiste. Efecto lunes / fin de semana: sin ventaja (Sharpe -0,24).
- **Momentum intradía (primera media hora) y curva intradía:** sin ventaja. Tanto la señal como su inversa pierden, así que el bruto es cero y los costes lo dominan (X06 inversa Sharpe -3 a -5,5).
- **Reversión a 1-4 h / sobrerreacción y picos de volumen:** pierden en las dos direcciones (seguir y contrarian), por ejemplo X09 contrarian Sharpe -1,1 a -2,9, X08 seguir -0,4 a -1,2: no hay ventaja bruta explotable, lo que cuadra con el informe previo del 1 m.
- **Relación con A:** las variantes de tendencia (X11 TSMOM, X12 Donchian por conjunto) son variantes de A (correlación de retornos 0,72-0,90). Las demás estrategias con Sharpe > 0 solapan con A por beta (correlación 0,4-0,65) y solo ganan los días en que A está activa. Las ortogonales (reversión, estacionalidad, funding) no tienen ventaja neta.
- **Combinaciones:** un filtro externo sobre la mejor señal de A (TSMOM 720 h largo/plano) no cambia la conclusión: K1 (ADX > 25) y K2 (NYSE cerrado) reducen el drawdown y mejoran el Sharpe maker (K2 30 m: 0,96 [-0,10; 1,95], DD 25 %) pero todos los IC incluyen 0 y no superan al control. La cartera de supervivientes (post hoc) da Sharpe 0,84 taker y 1,07 maker, con sesgo de selección sobre el mismo OOS.
- **Recomendación:** no implementar ninguna en el servicio C ni en D. Si se quiere un experimento paper de bajo coste, el único candidato defendible es A (TSMOM 720 h largo/plano, con o sin filtro NYSE cerrado) y requeriría ejecución maker que D hoy no simula; ver sección 9.

## 2. Protocolo, datos y supuestos

- **Harness:** el compartido de A (`quant/harness.py`, listo a los pocos minutos de empezar; no hizo falta uno propio). Decisión al cierre de la barra i, ejecución en la apertura de i+1, sin lookahead (el harness recalcula con barras truncadas y falla si hay fuga; las 306 configuraciones lo pasaron). Costes taker 5 bp + 0,5 bp de deslizamiento + 1 tick por lado; escenario maker/maker de 2 bp por lado separado y marcado como optimista. Funding horario sobre nocional abierto. Apalancamiento máximo 1x (ADR).
- **Datos:** velas de trades PF_XBTUSD de Kraken, 2022-03-23 a 2026-10-06 (30 m, 1 h, 2 h). **El funding publicado cubre solo ~1 año (desde 2025-10-06).** Antes de esa fecha el harness aplica el funding medio observado. Por tanto X27 (funding) solo puede operar en el último año y su OOS es corto; es un resultado de baja potencia.
- **Walk-forward:** entrenamiento expansivo (mínimo 365 días), 14 pliegues OOS de 91 días; los parámetros se eligen por Sharpe neto en entrenamiento; titular = OOS agrupado. Se exigen >= 100 operaciones OOS para considerar un resultado concluyente (las filas con (*) no lo son).
- **Pruebas y DSR:** se cuentan todas las configuraciones de todas las estrategias y marcos (306) y la varianza del Sharpe entre pruebas se calcula con todas ellas. Esa varianza es grande porque el conjunto incluye estrategias de muy alta rotación con Sharpe de -7 a -11, lo que fija un umbral SR0 anual de 7,0, absurdo como exigencia. Por eso se informa también una versión indulgente con la varianza de A (SR0 anual 2,1); la conclusión es la misma. Con cualquiera de las dos, ningún Sharpe OOS (máximo 1,07) alcanza el umbral.
- **IC95 %:** bootstrap por bloques circulares (10 días, 2.000 remuestreos) sobre retornos diarios OOS. El alfa frente a comprar y mantener es una regresión diaria sobre el retorno diario de comprar y mantener con el mismo bootstrap.
- **Benchmarks:** comprar y mantener (misma ventana OOS) y señal invertida con los mismos parámetros elegidos.
- **Supuestos y adaptaciones (declarados):**
  - No se pudo leer Quantpedia, arXiv ni los PDF de los papers (proxy de red); las reglas de los papers se basan en los resúmenes de búsqueda más mi adaptación. Las de freqtrade se leyeron del código fuente.
  - Las salidas de ROI y stop de freqtrade (de 5 m) se sustituyen por las salidas por señal de la propia estrategia o por horizonte fijo. Strategy001 se prueba con su salida literal (casi nunca dispara: es un largo permanente, 3-17 operaciones) y con una salida sana (cruce inverso EMA20/EMA50).
  - El patrón "martillo" (Strategy002) se implementó con una definición geométrica propia; SAR parabólico, MFI, Fisher-RSI y estocástico se implementaron en numpy (no TA-Lib), con diferencias menores de inicialización.
  - Donchian por conjunto (X12): el paper usa ventanas de 5 a 360 días en velas diarias; aquí se aplican esas ventanas en días reales (con barras de cada marco) y otra versión más corta (1-20 días). La salida se supone en la banda media; el dimensionamiento por volatilidad no se aplica.
  - Los marcos de 30 m y 1 h dan la misma estrategia horaria (X01, X02, X04), por eso sus resultados coinciden; no son pruebas independientes aunque se cuenten como tales (lo cual penaliza el DSR, no lo favorece).
- **Estrategias no probadas:** X30 (basis/cash-and-carry, necesita spot) y X31 (libro de órdenes / on-chain).

## 3. Catálogo (resumen)

| ID | Estrategia | Familia | Fuente | Encaja | Plaus. | Se implementa |
|----|-----------|---------|--------|--------|--------|---------------|
| X01 | Estacionalidad horaria: largo 21-23 UTC | Estacionalidad | Quantpedia | Sí | 2 | Sí |
| X02 | Idem + filtro día de semana (jue-dom) | Estacionalidad | Quantpedia | Sí | 1-2 | Sí (variante de X01) |
| X03 | Intradía vs. overnight según NYSE abierto/cerrado | Estacionalidad | Quantpedia / Vojtko | Sí | 2 | Sí |
| X04 | Efecto día de la semana (lunes) / fin de semana | Estacionalidad | Caporale-Plastun; Aharon-Qadan | Sí | 1-2 | Sí |
| X05 | Mejores horas elegidas en entrenamiento (walk-forward) | Estacionalidad | Control propio de X01 | Sí | 2 | Sí |
| X06 | Momentum intradía: primera media hora predice la última | Momentum intradía | Shen-Urquhart-Wang 2022 | Sí (30 m) | 2 | Sí |
| X07 | Curva de retorno intradía acumulado (mitad del día predice cierre) | Momentum intradía | Bouri et al. 2021 | Sí | 2 | Sí (variante de X06) |
| X08 | Momentum/reversión tras retornos intradía grandes | Impulso/reversión | Wen-Bouri-Xu-Zhao 2022 | Sí | 2 | Sí |
| X09 | Reversión a la media a 1-4 h (autocorrelación negativa) | Reversión | J. Applied Economics 2022; Sheffield Hallam | Sí | 2-3 | Sí |
| X10 | Sobrerreacción asimétrica (solo comprar tras caídas) | Reversión | Sheffield Hallam (Asymmetric Mean Reversion) | Sí | 2 | Sí (variante de X09) |
| X11 | TSMOM: signo del retorno pasado | Tendencia | Liu-Tsyvinski-Wu 2022 | Sí | 3 | Sí |
| X12 | Conjunto Donchian multi-ventana | Tendencia | Zarattini-Pagani-Barbon 2025 | Sí (escalado) | 3 | Sí |
| X13 | Breakout Donchian 20/10 (Turtle) | Tendencia | Dennis/Faith, clásico | Sí | 2-3 | Sí |
| X14 | EMA 20/50 + Heikin-Ashi (Strategy001) | Tendencia | freqtrade-strategies | Sí | 2 | Sí |
| X15 | ADXMomentum | Tendencia | freqtrade-strategies (1 h) | Sí | 2 | Sí |
| X16 | AdxSmas (ADX + cruce SMA 3/6) | Tendencia | freqtrade-strategies (1 h) | Sí | 2 | Sí |
| X17 | AwesomeMacd | Tendencia | freqtrade-strategies (1 h) | Sí | 2 | Sí |
| X18 | Supertrend ATR(10,3) | Tendencia | Práctica (O. Seban) | Sí | 2-3 | Sí |
| X19 | BbandRsi (RSI<30 y bajo banda de Bollinger) | Reversión | freqtrade-strategies (1 h) | Sí | 2 | Sí |
| X20 | RSI(2) de Connors con filtro SMA200 | Reversión | Connors-Alvarez | Sí | 2 | Sí |
| X21 | Strategy002 (RSI+estocástico+Bollinger+martillo) | Reversión | freqtrade-strategies | Sí (30 m+) | 1 (sobreajuste) | Sí |
| X22 | Strategy003 (RSI/MFI/Fisher/Bollinger) | Reversión | freqtrade-strategies | Sí | 1 (sobreajuste) | Sí |
| X23 | Cluc/BinHV45: compra bajo banda + volumen | Reversión | freqtrade-strategies | Sí | 1 (sobreajuste) | Sí (Cluc) |
| X24 | Squeeze de Bollinger / contracción de volatilidad | Volatilidad | Carter (TTM Squeeze) | Sí | 2 | Sí |
| X25 | Breakout de volatilidad de Larry Williams | Volatilidad | Williams, práctica | Sí | 2 | Sí |
| X26 | Volatilidad objetivo (gestionada) sobre BTC largo | Gestión de riesgo | Moreira-Muir; WisdomTree | Sí | 3 | Sí |
| X27 | Funding extremo contrarian | Funding | K33/The Block; He et al. | Sí (solo ~1 año) | 2-3 | Sí |
| X28 | Funding a favor de la multitud (largo si funding alto) | Funding | He-Manela-Ross-von Wachter | Sí (solo ~1 año) | 2 | Sí (modo `follow` de X27) |
| X29 | Pico de volumen: seguir o contra la barra | Volumen | Literatura volumen-retorno BTC | Sí | 2 | Sí |
| X30 | Basis / cash-and-carry perp-spot | Funding/basis | He et al. 2212.06888 | **No** (requiere spot y cobertura) | 4 (pero inaplicable) | No |
| X31 | Estrategias con libro de órdenes / on-chain | varias | Quantpedia (exchange reserves), etc. | **No** | n/a | No |

Fuentes principales (reglas, rendimiento declarado y datos requeridos de cada una en `quant/catalogo-C.md`): Quantpedia (intraday seasonality, https://quantpedia.com/strategies/intraday-seasonality-in-bitcoin; intradía/overnight, https://quantpedia.com/are-there-seasonal-intraday-or-overnight-anomalies-in-bitcoin/); Shen-Urquhart-Wang 2022 (https://research.birmingham.ac.uk/en/publications/bitcoin-intraday-time-series-momentum/); Bouri et al. 2021 (https://research.tees.ac.uk/en/publications/on-the-intraday-return-curves-of-bitcoin-predictability-and-tradi/); Wen et al. 2022 (https://ideas.repec.org:443/a/eee/ecofin/v62y2022ics1062940822000833.html); mean reversion asimétrica (https://shura.shu.ac.uk/23470/1/Asymmetric_Mean_Reversion_of_Bitcoin_Price_Returns.pdf); Liu-Tsyvinski-Wu (https://papers.ssrn.com/abstract=3379131); Zarattini-Pagani-Barbon (https://abarbon.com/papers/catching-crypto-trends); freqtrade-strategies (https://github.com/freqtrade/freqtrade-strategies); día de semana (https://journals.economic-research.pl/oc/article/view/2091, https://cris.haifa.ac.il/en/publications/bitcoin-and-the-day-of-the-week-effect/); funding (https://www.theblock.co/post/315831/perp-signal-bitcoin-bottom-bullish-year-end-k33, https://arxiv.org/html/2212.06888v5); volatilidad objetivo (https://www.wisdomtree.com/dk/insights/blog/enhancing-bitcoin-returns-using-momentum).

Sobre el sobreajuste a priori: marcadas como sospechosas de curva ajustada las de freqtrade 002/003/Cluc (ROI y condiciones optimizados con hyperopt para altcoins de 2018 a 5 m), la ventana 21-23 UTC de Quantpedia (hora elegida mirando datos) y el filtro jue-dom.

## 4. Resultados por estrategia y marco

Neto bp/op = media por operación tras costes y funding. Sharpe con IC95 % por bootstrap de bloques. DSR con las 306 pruebas. DD = drawdown máximo OOS. Alfa = intercepto anualizado de la regresión sobre comprar y mantener. (*) = menos de 100 operaciones OOS: no concluyente.

Referencia comprar y mantener (misma ventana OOS, taker): Sharpe 0,86, retorno anualizado 34 %, DD máx. 55 %.

| Estrategia | TF | Neto bp/op (taker) | Ops OOS | Sharpe OOS [IC95 %] | DSR | DD máx | Alfa vs B&H /año | Sharpe invertida | Neto bp/op (maker) | Sharpe maker [IC95 %] |
|---|---|---|---|---|---|---|---|---|---|---|
| X01 Hora 21-23 UTC | 30m | -4,1 | 1274 | -1,19 [-2,36; -0,12] | <0,001 | 45 % | -18 % | -5,31 | 3,2 | 0,90 [-0,19; 1,90] |
| X01 Hora 21-23 UTC | 1h | -4,2 | 1274 | -1,19 [-2,36; -0,12] | <0,001 | 45 % | -18 % | -5,27 | 3,2 | 0,90 [-0,19; 1,90] |
| X01 Hora 21-23 UTC | 2h | -6,8 | 1274 | -1,93 [-2,95; -0,95] | <0,001 | 61 % | -26 % | -4,55 | 0,6 | 0,17 [-0,87; 1,18] |
| X02 21-23 UTC jue-dom | 30m | -4,3 | 728 | -0,96 [-2,11; 0,11] | <0,001 | 31 % | -10 % | -4,03 | 3,1 | 0,66 [-0,39; 1,66] |
| X02 21-23 UTC jue-dom | 1h | -4,4 | 728 | -0,96 [-2,11; 0,11] | <0,001 | 30 % | -10 % | -3,99 | 3,0 | 0,66 [-0,39; 1,66] |
| X02 21-23 UTC jue-dom | 2h | -11,9 | 728 | -2,84 [-3,79; -1,93] | <0,001 | 60 % | -26 % | -2,58 | -3,6 | -0,86 [-1,83; 0,09] |
| X03 NYSE abierto/cerrado | 30m | 7,3 | 924 | 0,53 [-0,41; 1,48] | <0,001 | 47 % | -2 % | -2,21 | 14,7 | 1,07 [0,13; 2,02] |
| X03 NYSE abierto/cerrado | 1h | 3,4 | 924 | 0,24 [-0,71; 1,23] | <0,001 | 54 % | -15 % | -1,88 | 10,8 | 0,77 [-0,19; 1,77] |
| X03 NYSE abierto/cerrado | 2h | 2,6 | 924 | 0,18 [-0,79; 1,15] | <0,001 | 59 % | -18 % | -1,79 | 9,9 | 0,70 [-0,28; 1,68] |
| X04 Día de semana | 30m | -13,0 | 188 | -0,24 [-1,14; 0,68] | <0,001 | 54 % | -24 % | -0,18 | -19,3 | -0,40 [-1,40; 0,56] |
| X04 Día de semana | 1h | -13,3 | 188 | -0,24 [-1,14; 0,68] | <0,001 | 53 % | -24 % | -0,17 | -19,5 | -0,40 [-1,40; 0,56] |
| X04 Día de semana | 2h | -13,4 | 188 | -0,24 [-1,14; 0,68] | <0,001 | 53 % | -24 % | -0,16 | -19,5 | -0,40 [-1,40; 0,56] |
| X05 Mejor ventana 2 h (WF) | 30m | -8,1 | 1274 | -2,17 [-3,08; -1,22] | <0,001 | 67 % | -32 % | -3,93 | 1,4 | 0,36 [-0,66; 1,38] |
| X05 Mejor ventana 2 h (WF) | 1h | -8,1 | 1274 | -2,17 [-3,08; -1,22] | <0,001 | 67 % | -32 % | -3,91 | 1,3 | 0,36 [-0,66; 1,38] |
| X05 Mejor ventana 2 h (WF) | 2h | -9,8 | 1274 | -2,57 [-3,55; -1,59] | <0,001 | 74 % | -38 % | -3,37 | 0,6 | 0,17 [-0,87; 1,18] |
| X06 1ª media hora -> última | 30m | -12,5 | 1271 | -6,78 [-8,14; -5,59] | <0,001 | 80 % | -46 % | -5,49 | -5,3 | -2,99 [-4,04; -1,93] |
| X06 1ª media hora -> última | 1h | -14,8 | 1269 | -5,80 [-7,01; -4,68] | <0,001 | 85 % | -54 % | -3,09 | -6,8 | -2,81 [-3,99; -1,66] |
| X06 1ª media hora -> última | 2h | -12,8 | 1273 | -3,86 [-5,09; -2,74] | <0,001 | 81 % | -46 % | -3,00 | -5,4 | -1,64 [-2,82; -0,54] |
| X07 Curva intradía | 30m | -5,8 | 1272 | -0,78 [-1,92; 0,30] | <0,001 | 65 % | -23 % | -2,26 | 0,4 | 0,04 [-1,10; 1,16] |
| X07 Curva intradía | 1h | -5,7 | 1272 | -0,77 [-1,92; 0,32] | <0,001 | 65 % | -23 % | -2,25 | 0,5 | 0,05 [-1,09; 1,17] |
| X07 Curva intradía | 2h | -5,7 | 1272 | -0,76 [-1,91; 0,32] | <0,001 | 64 % | -23 % | -2,24 | 0,5 | 0,06 [-1,09; 1,18] |
| X08 Shock: seguir | 30m | -6,7 | 1199 | -1,21 [-2,30; -0,15] | <0,001 | 61 % | -24 % | -2,91 | 1,0 | 0,18 [-0,86; 1,16] |
| X08 Shock: seguir | 1h | -7,2 | 799 | -0,83 [-1,83; 0,18] | <0,001 | 52 % | -18 % | -1,80 | -0,7 | -0,11 [-1,09; 0,88] |
| X08 Shock: seguir | 2h | -5,2 | 640 | -0,42 [-1,48; 0,66] | <0,001 | 48 % | -13 % | -1,40 | 2,3 | 0,18 [-0,82; 1,18] |
| X09 Shock: contrarian | 30m | -16,0 | 1199 | -2,91 [-3,79; -2,00] | <0,001 | 87 % | -55 % | -1,21 | -8,6 | -1,59 [-2,49; -0,64] |
| X09 Shock: contrarian | 1h | -19,1 | 615 | -1,84 [-2,82; -0,84] | <0,001 | 72 % | -33 % | -0,34 | -13,5 | -1,39 [-2,38; -0,37] |
| X09 Shock: contrarian | 2h | -16,2 | 301 | -1,09 [-2,20; 0,03] | <0,001 | 48 % | -13 % | -0,43 | -1,1 | -0,09 [-1,19; 0,91] |
| X10 Comprar caídas | 30m | -13,1 | 604 | -1,79 [-2,65; -0,92] | <0,001 | 58 % | -26 % | -1,33 | -2,7 | -0,57 [-1,49; 0,39] |
| X10 Comprar caídas | 1h | -16,5 | 460 | -1,46 [-2,33; -0,48] | <0,001 | 60 % | -26 % | -0,55 | -4,7 | -0,50 [-1,47; 0,49] |
| X10 Comprar caídas | 2h | -4,9 | 159 | -0,33 [-1,35; 0,70] | <0,001 | 19 % | -3 % | -1,15 | 2,4 | 0,15 [-0,88; 1,15] |
| X11 TSMOM | 30m | 3,0 | 512 | 0,13 [-0,96; 1,19] | <0,001 | 57 % | -13 % | -1,07 | 2,0 | 0,12 [-0,97; 1,17] |
| X11 TSMOM | 1h | 0,3 | 503 | 0,02 [-1,07; 1,04] | <0,001 | 49 % | -17 % | -0,96 | 3,1 | 0,23 [-0,82; 1,24] |
| X11 TSMOM | 2h | 21,0 | 261 | 0,45 [-0,61; 1,46] | <0,001 | 44 % | -1 % | -0,92 | 3,4 | 0,13 [-0,95; 1,15] |
| X12 Conjunto Donchian | 30m | -34,7 | 60 (*) | 0,50 [-0,58; 1,52] | <0,001 | 27 % | -3 % | -0,66 | -20,2 | 0,58 [-0,52; 1,61] |
| X12 Conjunto Donchian | 1h | -34,8 | 96 (*) | 0,52 [-0,58; 1,56] | <0,001 | 27 % | -2 % | -0,72 | -21,5 | 0,58 [-0,52; 1,61] |
| X12 Conjunto Donchian | 2h | -31,7 | 64 (*) | 0,50 [-0,58; 1,53] | <0,001 | 27 % | -3 % | -0,65 | -12,2 | 0,59 [-0,49; 1,61] |
| X13 Turtle 20/10, 55/20 | 30m | -20,0 | 785 | -1,16 [-2,26; -0,05] | <0,001 | 85 % | -47 % | -0,16 | -12,6 | -0,74 [-1,83; 0,35] |
| X13 Turtle 20/10, 55/20 | 1h | -16,8 | 389 | -0,47 [-1,55; 0,58] | <0,001 | 64 % | -20 % | -0,17 | -9,5 | -0,27 [-1,34; 0,78] |
| X13 Turtle 20/10, 55/20 | 2h | -33,4 | 201 | -0,47 [-1,53; 0,54] | <0,001 | 71 % | -19 % | 0,18 | -26,1 | -0,36 [-1,42; 0,64] |
| X14 EMA+Heikin-Ashi (Strategy001) | 30m | 777,8 | 17 (*) | 0,82 [-0,14; 1,83] | <0,001 | 55 % | 1 % | -0,87 | 246,0 | 0,79 [-0,16; 1,80] |
| X14 EMA+Heikin-Ashi (Strategy001) | 1h | 133,4 | 62 (*) | 0,53 [-0,44; 1,57] | <0,001 | 55 % | -11 % | -0,64 | 13,7 | 0,15 [-0,89; 1,22] |
| X14 EMA+Heikin-Ashi (Strategy001) | 2h | 35,9 | 93 (*) | 0,26 [-0,77; 1,39] | <0,001 | 66 % | -14 % | -0,42 | 26,8 | 0,32 [-0,89; 1,42] |
| X15 ADXMomentum | 30m | -4,0 | 534 | -0,16 [-1,14; 0,89] | <0,001 | 50 % | -21 % | -0,85 | 3,4 | 0,16 [-0,81; 1,20] |
| X15 ADXMomentum | 1h | -17,3 | 287 | -0,41 [-1,55; 0,76] | <0,001 | 59 % | -29 % | -0,13 | -9,9 | -0,23 [-1,37; 0,92] |
| X15 ADXMomentum | 2h | -14,0 | 148 | -0,16 [-1,36; 1,02] | <0,001 | 45 % | -21 % | -0,10 | -6,6 | -0,07 [-1,26; 1,10] |
| X16 AdxSmas | 30m | -2,3 | 717 | -0,17 [-1,07; 0,81] | <0,001 | 60 % | -25 % | -1,32 | 5,0 | 0,30 [-0,60; 1,27] |
| X16 AdxSmas | 1h | -6,5 | 378 | -0,22 [-1,24; 0,84] | <0,001 | 68 % | -27 % | -0,54 | 0,9 | 0,02 [-1,01; 1,08] |
| X16 AdxSmas | 2h | 24,2 | 199 | 0,40 [-0,60; 1,42] | <0,001 | 54 % | -7 % | -0,76 | 31,5 | 0,52 [-0,49; 1,54] |
| X17 AwesomeMacd | 30m | 2,1 | 433 | 0,08 [-0,95; 1,11] | <0,001 | 53 % | -16 % | -0,97 | 9,4 | 0,36 [-0,65; 1,39] |
| X17 AwesomeMacd | 1h | 16,7 | 210 | 0,30 [-0,87; 1,46] | <0,001 | 61 % | -9 % | -0,74 | 24,0 | 0,44 [-0,72; 1,60] |
| X17 AwesomeMacd | 2h | 36,3 | 114 | 0,35 [-0,65; 1,33] | <0,001 | 43 % | -8 % | -0,57 | 43,6 | 0,42 [-0,57; 1,40] |
| X18 Supertrend | 30m | -8,5 | 1378 | -0,73 [-1,74; 0,27] | <0,001 | 85 % | -36 % | -1,30 | -1,2 | -0,12 [-1,10; 0,87] |
| X18 Supertrend | 1h | -18,5 | 750 | -0,84 [-1,99; 0,27] | <0,001 | 85 % | -41 % | -0,21 | -2,1 | -0,16 [-1,26; 0,87] |
| X18 Supertrend | 2h | -18,0 | 350 | -0,34 [-1,43; 0,72] | <0,001 | 73 % | -18 % | -0,08 | -10,7 | -0,20 [-1,27; 0,86] |
| X19 BbandRsi | 30m | 33,9 | 236 | 0,70 [-0,32; 1,85] | <0,001 | 43 % | 5 % | -1,19 | 24,3 | 0,51 [-0,51; 1,66] |
| X19 BbandRsi | 1h | 24,4 | 122 | 0,25 [-0,65; 1,21] | <0,001 | 47 % | -10 % | -0,51 | 31,7 | 0,33 [-0,57; 1,30] |
| X19 BbandRsi | 2h | 86,9 | 65 (*) | 0,49 [-0,43; 1,50] | <0,001 | 42 % | -3 % | -0,61 | 94,2 | 0,53 [-0,39; 1,54] |
| X20 RSI(2) Connors | 30m | -8,3 | 1504 | -2,82 [-3,64; -1,90] | <0,001 | 73 % | -38 % | -4,61 | -2,0 | -0,81 [-1,75; 0,21] |
| X20 RSI(2) Connors | 1h | -9,3 | 702 | -1,54 [-2,38; -0,57] | <0,001 | 52 % | -21 % | -2,15 | -2,5 | -0,44 [-1,36; 0,65] |
| X20 RSI(2) Connors | 2h | -2,6 | 400 | -0,23 [-1,16; 0,77] | <0,001 | 26 % | -5 % | -1,70 | 2,6 | 0,25 [-0,77; 1,36] |
| X21 Strategy002 | 30m | -28,7 | 23 (*) | -0,34 [-1,22; 0,86] | <0,001 | 16 % | -3 % | 0,03 | -21,4 | -0,26 [-1,16; 0,94] |
| X21 Strategy002 | 1h | 135,3 | 16 (*) | 0,81 [-0,01; 1,83] | <0,001 | 10 % | 5 % | -0,96 | 142,7 | 0,85 [0,02; 1,87] |
| X21 Strategy002 | 2h | 101,9 | 9 (*) | 0,28 [-0,53; 1,03] | <0,001 | 13 % | 1 % | -0,33 | 109,2 | 0,30 [-0,52; 1,05] |
| X22 Strategy003 | 30m | 42,5 | 64 (*) | 0,73 [-0,28; 1,80] | <0,001 | 16 % | 6 % | -1,21 | 49,9 | 0,86 [-0,15; 1,93] |
| X22 Strategy003 | 1h | -12,5 | 33 (*) | -0,12 [-0,96; 0,84] | <0,001 | 29 % | -4 % | -0,10 | -5,1 | -0,06 [-0,90; 0,90] |
| X22 Strategy003 | 2h | 34,4 | 11 (*) | 0,09 [-0,73; 1,08] | <0,001 | 16 % | -1 % | -0,20 | 41,8 | 0,12 [-0,71; 1,10] |
| X23 Cluc | 30m | 50,8 | 33 (*) | 0,53 [-0,49; 1,60] | <0,001 | 13 % | 4 % | -0,83 | 58,2 | 0,61 [-0,41; 1,68] |
| X23 Cluc | 1h | 53,2 | 55 (*) | 0,64 [-0,20; 1,74] | <0,001 | 19 % | 6 % | -0,88 | 60,5 | 0,73 [-0,11; 1,84] |
| X23 Cluc | 2h | 104,9 | 42 (*) | 0,92 [0,07; 1,84] | <0,001 | 19 % | 9 % | -1,15 | 112,2 | 0,99 [0,13; 1,89] |
| X24 Squeeze Bollinger | 30m | -13,4 | 1030 | -1,85 [-3,01; -0,79] | <0,001 | 78 % | -40 % | -1,34 | -7,2 | -1,04 [-2,12; -0,02] |
| X24 Squeeze Bollinger | 1h | -11,8 | 562 | -0,95 [-2,05; 0,02] | <0,001 | 56 % | -19 % | -0,92 | -4,5 | -0,38 [-1,46; 0,57] |
| X24 Squeeze Bollinger | 2h | 16,5 | 214 | 0,48 [-0,68; 1,51] | <0,001 | 27 % | 10 % | -1,15 | 23,8 | 0,69 [-0,45; 1,70] |
| X25 Williams VBO | 30m | -12,4 | 7222 | -7,52 [-8,66; -6,45] | <0,001 | 100 % | -256 % | -6,64 | -5,1 | -3,15 [-4,17; -2,18] |
| X25 Williams VBO | 1h | -12,4 | 3493 | -3,56 [-4,58; -2,49] | <0,001 | 99 % | -124 % | -3,12 | -5,6 | -2,07 [-3,04; -1,09] |
| X25 Williams VBO | 2h | -7,4 | 1769 | -1,08 [-2,12; -0,13] | <0,001 | 80 % | -37 % | -2,34 | -0,2 | -0,06 [-1,03; 0,85] |
| X26 Vol. objetivo largo | 30m | 724,1 | 14 (*) | 0,72 [-0,30; 1,79] | <0,001 | 45 % | -2 % | -0,77 | 738,5 | 0,74 [-0,28; 1,80] |
| X26 Vol. objetivo largo | 1h | 703,5 | 14 (*) | 0,67 [-0,36; 1,73] | <0,001 | 47 % | -3 % | -0,71 | 718,4 | 0,69 [-0,34; 1,75] |
| X26 Vol. objetivo largo | 2h | 670,6 | 14 (*) | 0,65 [-0,38; 1,72] | <0,001 | 51 % | -4 % | -0,68 | 686,4 | 0,71 [-0,31; 1,78] |
| X27/X28 Funding z | 30m | -3,9 | 227 | -0,17 [-1,35; 0,96] | <0,001 | 29 % | -3 % | -0,82 | 3,4 | 0,15 [-1,04; 1,29] |
| X27/X28 Funding z | 1h | -3,4 | 224 | -0,17 [-1,32; 0,92] | <0,001 | 25 % | -2 % | -0,90 | 3,8 | 0,18 [-0,96; 1,27] |
| X27/X28 Funding z | 2h | 1,2 | 247 | 0,05 [-1,03; 1,10] | <0,001 | 24 % | 1 % | -1,19 | 8,5 | 0,42 [-0,66; 1,45] |
| X29 Pico de volumen | 30m | -11,0 | 3298 | -3,79 [-4,91; -2,69] | <0,001 | 98 % | -103 % | -4,28 | -3,6 | -1,28 [-2,30; -0,22] |
| X29 Pico de volumen | 1h | -11,8 | 1337 | -1,96 [-3,09; -0,90] | <0,001 | 82 % | -46 % | -1,87 | -5,2 | -1,05 [-2,15; 0,06] |
| X29 Pico de volumen | 2h | -11,7 | 668 | -0,84 [-1,91; 0,23] | <0,001 | 62 % | -22 % | -0,82 | -4,3 | -0,30 [-1,36; 0,76] |

**Lectura:**
- Taker, filas con >= 100 operaciones y Sharpe > 0 (14): X03 en los 3 marcos (NYSE cerrado, beta 0,6), X11 en los 3 (TSMOM), X16 2 h, X17 en los 3 (ADX/MACD), X19 en 30 m y 1 h, X24 2 h (squeeze) y X27 2 h (Sharpe 0,05). Las reglas con rendimiento más alto sobre el papel (X12, X14, X21-X23, X26) tienen menos de 100 operaciones o son beta. Sus alfas frente a comprar y mantener son todas indistinguibles de cero (IC siempre con 0) y sus Sharpe no superan el 0,86 de comprar y mantener salvo Cluc 2 h (0,92; 42 operaciones).
- El squeeze (X24) solo es positivo en 2 h (Sharpe 0,48) y negativo en 1 h (-0,95) y 30 m (-1,85): no es robusto entre marcos.
- La inversión de la señal gana a la señal original en 57 de 84 filas taker; en las de estacionalidad e intradía ambas direcciones pierden (costes), no hay dirección con ventaja.
- X26 (volatilidad objetivo sobre BTC largo) solo hace 14 operaciones (rebalanceos con banda); reduce el DD respecto a comprar y mantener solo marginalmente (45-51 % frente a 55 %) con Sharpe 0,65-0,72: es beta gestionada, no alfa (alfa -2 a -4 %/año).
- Con maker/maker el panorama mejora de forma uniforme (los costes bajan de ~12 a ~4 bp ida y vuelta), pero ni así aparece ninguna fila con alfa estadísticamente positivo ni DSR distinto de cero. Además, el supuesto maker ignora la no ejecución y la selección adversa, y D hoy solo simula fills taker.

## 5. Relación con A

El informe de A (`quant/informe-A-tendencia.md`) no existía al escribir esto; se usan sus resultados JSON (`quant/results/A_*.json`) y su salida agrupada OOS. A resume: las mejores filas de tendencia son TSMOM largo/plano de 336-720 h (Sharpe OOS 0,5-0,68, IC que incluyen 0, DSR < 0,003), esencialmente el mismo sesgo largo de este periodo alcista.

Método: se fija la señal de A más elegida en sus pliegues (TSMOM 720 h largo/plano, `strategies_A.tsmom`) y se mide, sobre los mismos días OOS, (a) la correlación de retornos diarios de cada estrategia C con los retornos OOS agrupados de A (`A_tsmom`), (b) la correlación de posiciones diarias medias con la señal fija de A, y (c) el Sharpe de la estrategia C en los días en que A está invertida frente a los días en que está plana.

| Estrategia (1 h) | Corr. retornos con A (tsmom) | Corr. posición con A (720h LF) | Sharpe días A activa | Sharpe días A plana | Sharpe OOS | Lectura |
|---|---|---|---|---|---|---|
| X01 Hora 21-23 UTC | 0,20 | 0,00 | -1,37 | -0,94 | -1,19 | ortogonal a A; no funciona en ningún estado |
| X02 21-23 UTC jue-dom | 0,11 | -0,01 | -1,58 | -0,18 | -0,96 | ortogonal a A; no funciona en ningún estado |
| X03 NYSE abierto/cerrado | 0,51 | -0,01 | 1,58 | -1,51 | 0,24 | solapa con A (beta); solo funciona con tendencia |
| X04 Día de semana | 0,34 | 0,01 | -0,01 | -0,46 | -0,24 | solapa con A (beta); no funciona en ningún estado |
| X05 Mejor ventana 2 h (WF) | 0,11 | 0,00 | -2,31 | -1,98 | -2,17 | ortogonal a A; no funciona en ningún estado |
| X06 1ª media hora -> última | 0,05 | 0,05 | -5,43 | -6,27 | -5,80 | ortogonal a A; no funciona en ningún estado |
| X07 Curva intradía | 0,13 | 0,09 | -1,10 | -0,35 | -0,77 | ortogonal a A; no funciona en ningún estado |
| X08 Shock: seguir | 0,12 | 0,10 | -1,65 | 0,23 | -0,83 | ortogonal a A |
| X09 Shock: contrarian | -0,09 | -0,10 | -1,17 | -2,61 | -1,84 | ortogonal a A; no funciona en ningún estado |
| X10 Comprar caídas | 0,11 | -0,07 | -1,06 | -1,87 | -1,46 | ortogonal a A; no funciona en ningún estado |
| X11 TSMOM | 0,86 | 0,87 | 0,80 | -1,87 | 0,02 | variante de A; solo funciona con tendencia |
| X12 Conjunto Donchian | 0,74 | 0,55 | 1,11 | -1,11 | 0,52 | variante de A; solo funciona con tendencia |
| X13 Turtle 20/10, 55/20 | 0,28 | 0,23 | -0,26 | -0,74 | -0,47 | ortogonal a A; no funciona en ningún estado |
| X14 EMA+Heikin-Ashi (Strategy001) | 0,63 | 0,00 | 1,75 | -1,02 | 0,53 | variante de A; solo funciona con tendencia |
| X15 ADXMomentum | 0,44 | 0,11 | 0,05 | -1,03 | -0,41 | solapa con A (beta) |
| X16 AdxSmas | 0,46 | -0,05 | 0,94 | -1,64 | -0,22 | solapa con A (beta); solo funciona con tendencia |
| X17 AwesomeMacd | 0,59 | 0,25 | 1,45 | -1,72 | 0,30 | solapa con A (beta); solo funciona con tendencia |
| X18 Supertrend | 0,16 | 0,15 | -1,50 | -0,02 | -0,84 | ortogonal a A; no funciona en ningún estado |
| X19 BbandRsi | 0,26 | -0,24 | 1,22 | -0,61 | 0,25 | ortogonal a A; solo funciona con tendencia |
| X20 RSI(2) Connors | 0,23 | 0,18 | -0,93 | -2,58 | -1,54 | ortogonal a A; no funciona en ningún estado |
| X21 Strategy002 | -0,02 | -0,05 | 1,24 | 0,54 | 0,81 | ortogonal a A |
| X22 Strategy003 | 0,16 | -0,00 | 0,22 | -0,61 | -0,12 | ortogonal a A |
| X23 Cluc | 0,06 | -0,13 | 1,17 | 0,33 | 0,64 | ortogonal a A |
| X24 Squeeze Bollinger | -0,01 | 0,09 | -2,09 | 0,31 | -0,95 | ortogonal a A |
| X25 Williams VBO | 0,09 | 0,07 | -4,44 | -2,49 | -3,56 | ortogonal a A; no funciona en ningún estado |
| X26 Vol. objetivo largo | 0,60 | 0,13 | 2,09 | -1,21 | 0,67 | solapa con A (beta); solo funciona con tendencia |
| X27/X28 Funding z | -0,01 | -0,04 | -0,27 | -0,10 | -0,17 | ortogonal a A; no funciona en ningún estado |
| X29 Pico de volumen | 0,09 | 0,06 | -1,91 | -2,02 | -1,96 | ortogonal a A; no funciona en ningún estado |

Conclusiones:
- **Variantes de A:** X11 TSMOM (correlación de retornos 0,86-0,90 y de posición 0,87) es A con otra rejilla; X12 Donchian por conjunto (0,72-0,74) también. No añaden información.
- **Solapan por beta y solo funcionan donde A funciona:** X14, X16, X17, X03, X26 y X19 tienen Sharpe positivo los días en que A está invertida (1-2) y negativo los días en que está plana. Es decir, son largos con filtro de tendencia en un mercado alcista; no son una segunda fuente de alfa.
- **Ortogonales a A pero sin ventaja:** X01/X02/X05/X06/X07/X08-X10/X24/X25/X27/X29 (correlación con A < 0,3). Su Sharpe taker es negativo o ~0 (X24 2 h 0,48 y Cluc 2 h 0,92 son excepciones con evidencia débil: 214 y 42 operaciones, IC con 0 el primero, alfa con 0 el segundo).
- **Mean reversion de pocas operaciones (X21, X22, X23):** correlación casi nula con A y Sharpe positivo, pero con 9-64 operaciones OOS por fila y exposición de 1-8 %: no concluyentes; son candidatas a seguir observando con más historia, no a implementar.

## 6. Combinaciones

Declaradas antes de ejecutarlas (pero después de ver la tabla principal, así que no son ciegas), contadas como pruebas: K1-K4 son filtros externos sobre la señal de A (TSMOM 720 h largo/plano); K0 es el control (A sola) ejecutado con la misma maquinaria; K5 es una cartera equiponderada de los flujos OOS diarios de los "supervivientes" (regla: Sharpe taker/maker OOS > 0, >= 100 operaciones, una sola versión por estrategia, correlación absoluta < 0,5 entre miembros, selección voraz por Sharpe).

| Combinación | TF | Neto bp/op taker | Ops | Sharpe taker [IC95 %] | DD | Sharpe maker [IC95 %] | DD maker |
|---|---|---|---|---|---|---|---|
| K0 control: A TSMOM 720 h largo/plano | 30m | 16,1 | 380 | 0,51 [-0,60; 1,61] | 50 % | 0,75 [-0,33; 1,83] | 43 % |
| K0 control: A TSMOM 720 h largo/plano | 1h | 26,9 | 275 | 0,63 [-0,46; 1,70] | 49 % | 0,80 [-0,26; 1,87] | 44 % |
| K0 control: A TSMOM 720 h largo/plano | 2h | 48,3 | 193 | 0,80 [-0,28; 1,86] | 40 % | 0,92 [-0,15; 1,97] | 36 % |
| K1 A y ADX>25 | 30m | 1,1 | 747 | 0,08 [-1,05; 1,14] | 52 % | 0,73 [-0,35; 1,74] | 33 % |
| K1 A y ADX>25 | 1h | 9,0 | 432 | 0,44 [-0,73; 1,51] | 42 % | 0,80 [-0,33; 1,86] | 32 % |
| K1 A y ADX>25 | 2h | 30,5 | 252 | 0,84 [-0,27; 1,91] | 40 % | 1,04 [-0,05; 2,10] | 38 % |
| K2 A y NYSE cerrado | 30m | 3,9 | 808 | 0,34 [-0,73; 1,37] | 43 % | 0,96 [-0,10; 1,95] | 25 % |
| K2 A y NYSE cerrado | 1h | 3,9 | 729 | 0,30 [-0,78; 1,30] | 44 % | 0,85 [-0,21; 1,86] | 29 % |
| K2 A y NYSE cerrado | 2h | 6,0 | 662 | 0,42 [-0,70; 1,47] | 38 % | 0,91 [-0,19; 1,97] | 24 % |
| K3 A sin funding saturado | 30m | 11,3 | 436 | 0,41 [-0,70; 1,52] | 53 % | 0,68 [-0,41; 1,76] | 44 % |
| K3 A sin funding saturado | 1h | 19,3 | 331 | 0,55 [-0,57; 1,63] | 51 % | 0,75 [-0,34; 1,82] | 44 % |
| K3 A sin funding saturado | 2h | 39,0 | 232 | 0,78 [-0,29; 1,84] | 40 % | 0,92 [-0,14; 1,98] | 36 % |
| K4 A con vol. objetivo 50 % | 30m | 15,0 | 380 | 0,54 [-0,57; 1,64] | 47 % | 0,78 [-0,28; 1,86] | 40 % |
| K4 A con vol. objetivo 50 % | 1h | 25,7 | 275 | 0,67 [-0,45; 1,76] | 45 % | 0,85 [-0,25; 1,91] | 40 % |
| K4 A con vol. objetivo 50 % | 2h | 45,6 | 193 | 0,80 [-0,32; 1,87] | 37 % | 0,92 [-0,16; 1,99] | 34 % |
| K5 cartera equiponderada (taker): X19_bband_rsi_30m, X24_bb_squeeze_2h, X11_tsmom_2h, X27_funding_z_2h | mixto | 18,1 | 958 | 0,84 [-0,20; 1,88] | 18 % | - | - |
| K5 cartera equiponderada (maker): 10 miembros | mixto | 8,4 | 6974 | - | - | 1,07 [0,12; 2,00] | 12 % |

Lectura: los filtros ADX > 25 (K1) y NYSE cerrado (K2) mejoran algo el Sharpe maker y el drawdown (K1 2 h maker 1,04 [-0,05; 2,10], K2 30 m maker 0,96 con DD 25 % frente a 43 % de K0), pero los IC se solapan por completo con los del control y bajo taker K2 empeora el Sharpe (0,30-0,42 frente a 0,51-0,80). K3 (funding saturado) casi no cambia nada: el filtro solo existe en el último año. K4 (volatilidad objetivo) es neutral. La cartera K5 tiene el menor drawdown (taker 18 %, maker 12 %) pero está formada con información OOS (los miembros se eligen mirando el mismo OOS) y su Sharpe taker 0,84 es igual al de comprar y mantener con IC que incluye 0; no es evidencia.

## 7. Conclusión honesta

1. De las 29 reglas externas probadas, **ninguna** muestra ventaja neta de costes, estadísticamente distinguible de cero, que no sea sesgo largo en un periodo alcista (BTC +181 % en el OOS). Con el DSR sobre 306 pruebas el resultado más favorable queda en prácticamente 0.
2. Los efectos documentados por la literatura (hora del día, día de la semana, momentum de la primera media hora, reversión a 1-4 h) o bien no se reproducen en estas barras de Kraken Futures 2022-2026, o bien aparecen en bruto con un tamaño (3-8 bp) muy inferior al coste taker (~12 bp ida y vuelta). El mejor ejemplo, la hora 21-23 UTC, tiene bruto +7 bp y neto positivo solo con maker, y se debilitó en 2026.
3. Los resultados de reglas con pocas operaciones (Cluc, Strategy002/003, vol. objetivo, Strategy001) son los más brillantes sobre el papel y los menos informativos: n de 9 a 64.
4. Los resultados de funding (X27) son de baja potencia: solo hay 1 año de datos de funding.
5. Esto no prueba que no exista edge en BTC; prueba que ninguna de estas reglas públicas, con datos OHLCV y funding, lo tiene a 30 m-2 h tras costes taker en este periodo. Consistente con el informe previo (1 m) y con A.
6. Riesgos de mi propio análisis: adaptaciones de reglas a partir de resúmenes (no he visto las tablas de los papers); rejillas pequeñas declaradas pero con parámetros de fuentes pensados para otras frecuencias; un único activo y un único proveedor; OOS dominado por un mercado alcista; DSR conservador por la inclusión de pruebas muy malas (ver sección 2).

## 8. Qué haría falta si se quisiera avanzar con algún candidato (no recomendado)

Se prioriza (si el usuario quiere un experimento paper) a: A TSMOM 720 h largo/plano; K2 (A solo con NYSE cerrado) como variante; y vigilar X01 y X03 con maker. Criterio de parada propuesto antes de empezar: al menos 100 operaciones paper, Sharpe maker o taker con IC95 % por encima de 0 y alfa frente a comprar y mantener positivo.

## 9. Implementación en el verdict service C y en la ejecución paper D

(He leído `odd/tasks/futures-process-split.md` y las cabeceras/estructura de `python/balancita_engine/futures_strategies.py`, `futures_runtime.py` y `futures_paper_execution.py`; no auditaría el código completo.)

- **C hoy:** evalúa propuestas de entrada C25-C28 sobre cada vela cerrada de 1 m con ventanas fijas de 200 barras de 1 m y 5 m, aritmética `Decimal`, veredictos en una base append-only con hash de configuración y régimen encadenado; las salidas las gestiona D con `propose` sobre la posición.
- **Para una estrategia lenta (por ejemplo A TSMOM 720 h):**
  1. Capturar o agregar velas de 30 m / 1 h / 2 h alineadas en UTC (hoy se captura 1 m y 5 m). Para un lookback de 720 h hacen falta ventanas de ~720 barras de 1 h (30 días) o series diarias, muy por encima de las 200 barras actuales; la ventana pasa a formar parte del hash de configuración.
  2. Reescribir la señal en `Decimal` puro y determinista (sin pandas) con pruebas TDD y doble replay idéntico; emitir el veredicto solo al cierre de la barra lenta, no cada minuto.
  3. Modelo de salidas en D: las estrategias lentas salen por señal o por horizonte, no por objetivo/stop ATR; D hoy comprueba `target_does_not_clear_cost_buffer` (14 bp); habría que definir cómo se aplica a una propuesta sin objetivo en precio.
  4. Funding: D ya lee funding en solo lectura; un filtro de funding (K3) sería directo, pero con solo 1 año de historia no se puede validar.
  5. Ejecución maker: D simula fills taker contra el top del ticker. Los escenarios maker de este informe no son verificables sin un modelo de fills pasivos (cola, no ejecución, selección adversa), y ese modelo exigiría datos de libro de órdenes que el ADR y el alcance excluyen.
  6. Mantener el límite de 1x y la separación del ADR 0001: sin órdenes reales, sin credenciales.
- **Esfuerzo estimado (orden de magnitud):** captura/agregación y ventanas: M; señal Decimal + pruebas + replay: M; adaptación de salidas y buffer de coste en D: M; modelo maker: L (y probablemente inviable con datos públicos).

## 10. Reproducibilidad

- `quant/C_signals.py` (señales y rejillas), `quant/C_run.py` (walk-forward taker y maker), `quant/C_combo.py` (K0-K5), `quant/C_final.py` (DSR global, alfa), `quant/C_rel.py` (relación con A), `quant/C_report.py` y `quant/C_write.py` (este informe).
- Resultados JSON en el esquema del harness: `quant/results/C_<id>_<tf>.json` y `..._maker.json` (168 + 32 de combinaciones).
- Catálogo: `quant/catalogo-C.md`.
