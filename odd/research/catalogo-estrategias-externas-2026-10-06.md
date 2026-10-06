# Catálogo C: estrategias externas candidatas (BTC / cripto) para barras 30 m, 1 h, 2 h

Fecha: 2026-10-06. Solo datos públicos, solo paper (ADR 0001). Datos disponibles: OHLCV 30 m / 1 h / 2 h de Kraken PF_XBTUSD (2022-03 a 2026-10) y funding horario (solo ~1 año, desde 2025-10-06).

## Limitaciones de esta búsqueda (honestidad)

- El proxy de red bloqueó `quantpedia.com`, `arxiv.org`, `concretumgroup.com`, `doaj.org` y la mayoría de editoriales. Para los papers y Quantpedia solo pude leer los resúmenes de la búsqueda web: las reglas de esos casos son las que el resumen declara más mi mejor adaptación a barras, marcada como "adaptación". No he visto las tablas completas de los papers.
- Las reglas de freqtrade-strategies se leyeron directamente del código fuente (raw.githubusercontent.com) y son exactas; sus parámetros originales son de 5 m / 1 h y de 2018-2020, así que su adaptación a 30 m/1 h/2 h es mía.
- "Rendimiento declarado" es lo que dice la fuente; casi todo es bruto o sin costes realistas y en periodos alcistas. Ninguna cifra se toma como evidencia.
- Puntuación de plausibilidad a priori (1 = casi seguro sobreajuste / sin ventaja tras costes; 5 = mecanismo creíble y robusto en la literatura). Con costes de 12 bp ida y vuelta (taker) en barras de 30 m-2 h, ninguna supera 3 sin una ventaja bruta grande por operación.

## Resumen

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

Entradas implementadas: 29 de 31 (X30, X31 descartadas por falta de datos); varias son variantes de una misma regla, así que el número de "reglas distintas" ronda 23.

## Fichas

### X01 Estacionalidad horaria 21-23 UTC
- Fuente: https://quantpedia.com/strategies/intraday-seasonality-in-bitcoin
- Reglas (según el resumen de búsqueda): comprar BTC a las 21:00 UTC y vender a las 23:00 UTC; las horas 03-04 UTC son las peores.
- Declarado: 33 % anual, volatilidad 20,9 %, DD máx. -22,45 %; en la versión extendida 40,6 % anual y Calmar 1,79; el viernes sería el mejor día, seguido de jueves, sábado y domingo; 22 y 23 h rinden más en tendencia alcista. Periodo: no confirmado (series de Bitstamp/Coinbase hasta ~2020-2021).
- Datos: OHLCV horario. Encaja con 1 h y 2 h (en 30 m/1 h se usa 21-23 exacto; la barra de 2 h se alinea en horas pares UTC, así que ahí se prueban 20-22 y 22-24).
- Plausibilidad 2: la ventana se eligió mirando datos (minería de horas); sin coste en la fuente (dos operaciones diarias ~10 bp de coste frente a ~30 bp/día declarados en bruto: no se descarta de entrada, pero el efecto se erosiona en las muestras posteriores).
- Cuadrícula: hora de inicio (0-23) fijada a la de la fuente primero; barrido 24 horas × duración 1-3 h como control de minería (cuenta como pruebas).

### X02 Estacionalidad + día de semana
- Fuente: Quantpedia (ver arriba, versión extendida). Regla: X01 solo jue-dom UTC. Plausibilidad 1-2 (dos filtros elegidos a posteriori).

### X03 Intradía vs. overnight (NYSE)
- Fuente: https://quantpedia.com/are-there-seasonal-intraday-or-overnight-anomalies-in-bitcoin/
- Reglas: cuando NYSE está cerrado BTC tiene un fuerte componente intradía y débil overnight, y a la inversa con NYSE abierto. Adaptación: estar largo solo durante las horas NYSE cerrado (21:00-14:30 UTC, ajustado a invierno/verano con la zona America/New_York) o solo con NYSE abierto; se prueban ambas.
- Declarado: diferencias significativas entre sesiones; sin cifras de Sharpe que verifiqué. Datos: OHLCV + calendario. Plausibilidad 2: mecanismo (sesión de renta variable) es creíble pero inestable entre regímenes; se opera 1 vez al día con coste alto relativo.

### X04 Efecto día de la semana / fin de semana
- Fuentes: Caporale-Plastun 2018 (efecto lunes), Aharon-Qadan 2019 (https://cris.haifa.ac.il/en/publications/bitcoin-and-the-day-of-the-week-effect/), estudio horario de Kraken 2016-2021 (https://journals.economic-research.pl/oc/article/view/2091).
- Reglas: largo solo el lunes UTC; o largo lun-vie y plano el fin de semana; o inverso. Declarado: lunes con retornos mayores, miércoles con mayor volatilidad (muestras 2010-2017 y 2016-2021). Plausibilidad 1-2: efectos de calendario diarios documentados en muestras donde BTC subió mucho; típicamente desaparecen.

### X05 Horas seleccionadas en entrenamiento (control)
- No es de una fuente: es la prueba honesta de X01. En cada pliegue de entrenamiento se eligen las k mejores horas UTC por retorno medio y se opera en test. Mide si la estacionalidad persiste. Plausibilidad 2.

### X06 Momentum intradía (primera media hora predice la última)
- Fuente: Shen, Urquhart, Wang (2022), Financial Review 57(2), DOI 10.1111/fire.12290; https://research.birmingham.ac.uk/en/publications/bitcoin-intraday-time-series-momentum/
- Reglas: signo del retorno de la primera media hora de la sesión (con alto volumen/volatilidad) predice el de la última media hora. Adaptación: primera media hora tras 00:00 UTC (y tras 13:30 UTC, apertura NYSE) -> posición en la última barra de 30 m del día; salida al cierre de ese día. Declarado: ganancias económicas "sustanciales" en market timing, sobre todo en mercados bajistas; atribuido a provisión de liquidez. Periodo: ~2013-2018 (a confirmar).
- Plausibilidad 2: muestra antigua, retorno esperado de media hora es < coste (12 bp); solo funcionaría con coste maker y señal fuerte.

### X07 Curva de retorno intradía acumulado
- Fuente: Bouri, Lau, Saeed, Wang, Zhao (2021) IRFA, https://research.tees.ac.uk/en/publications/on-the-intraday-return-curves-of-bitcoin-predictability-and-tradi/
- Regla (adaptación): retorno acumulado desde 00:00 UTC hasta la hora h predice el retorno de h al cierre del día. Plausibilidad 2.

### X08 Momentum/reversión tras retornos intradía grandes
- Fuente: Wen, Bouri, Xu, Zhao (2022), North American Journal of Economics and Finance vol. 62 (según RePEc), https://ideas.repec.org:443/a/eee/ecofin/v62y2022ics1062940822000833.html (solo resumen).
- Regla (adaptación): si el retorno de la barra supera k·sigma (sigma móvil), posicionarse a favor o en contra durante h barras. El signo exacto que encuentra el paper (momentum, reversión o ambos según el estado del mercado) no lo pude verificar, por eso se prueban ambos signos y se cuentan como pruebas. Plausibilidad 2.

### X09 Reversión a la media a 1-4 h
- Fuentes: Journal of Applied Economics, dic 2022 (resumen en búsqueda, https://doaj.org/article/889af1e55ca44d83bcb079580903b1b0 bloqueado); Asymmetric Mean Reversion of Bitcoin Price Returns, https://shura.shu.ac.uk/23470/1/Asymmetric_Mean_Reversion_of_Bitcoin_Price_Returns.pdf
- Declarado: a 1, 2 y 4 h hay autocorrelación de primer orden negativa significativa; movimientos mayores revierten más; sobrerreacción más clara tras caídas (liquidaciones en cascada).
- Regla: tras |r_t| > k·sigma, posición contraria durante h barras. Plausibilidad 2-3: el efecto es estadísticamente real a menudo por microestructura (bid-ask bounce en datos de trade), que NO se puede capturar pagando el spread; el informe previo ya vio bruto ~0 en 1 m.
### X10 Sobrerreacción asimétrica
- Misma fuente; regla: solo largo tras caídas grandes (k·sigma), sin cortos. Plausibilidad 2.

### X11 TSMOM (Liu-Tsyvinski-Wu)
- Fuente: Liu, Tsyvinski, Wu, "Common Risk Factors in Cryptocurrency", Journal of Finance 2022; https://papers.ssrn.com/abstract=3379131 ; resumen https://alphaarchitect.com/factors-investing-in-cryptocurrency/
- Regla: largo si el retorno de los últimos L periodos > 0, corto/plano si < 0. Declarado: fuerte momentum de serie temporal para BTC en frecuencia diaria/semanal (muestra 2011-2018). Adaptación: L en barras equivalente a 1, 3, 7, 14 días. Plausibilidad 3: documentado y simple; solapa con A.

### X12 Conjunto Donchian multi-ventana
- Fuente: Zarattini, Pagani, Barbon (2025), "Catching Crypto Trends", https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/ ; https://abarbon.com/papers/catching-crypto-trends (bloqueado: reglas por resumen)
- Regla: promedio de señales de canales Donchian de varias ventanas (de ~5 a ~360 días en el paper), tamaño por volatilidad. Declarado: Sharpe > 1,5 y alfa 10,8 % anual neto sobre BTC en cartera rotacional de 20 monedas (2015-2024); para BTC solo el efecto es menor. Adaptación: ventanas en barras escaladas (p. ej. 2, 5, 10, 20, 40 días). Plausibilidad 3: reglas simples y robustas por conjunto, pero la muestra es mayoritariamente alcista y a nuestra frecuencia no es la del paper (diaria).

### X13 Donchian 20/10 (Turtle)
- Fuente: clásico (Dennis/Faith, "Turtle rules"); variante en https://blog.bitfinex.com/?p=37073 . Regla: entrar al romper máximo/mínimo de N barras, salir al romper el mínimo/máximo de N/2. Plausibilidad 2-3.

### X14 Strategy001 (EMA 20/50 + Heikin-Ashi)
- Fuente: https://github.com/freqtrade/freqtrade-strategies (Strategy001.py, leído). Reglas: entrada EMA20 cruza sobre EMA50, cierre HA > EMA20 y vela HA verde; salida EMA50 cruza sobre EMA100, HA cierre < EMA20 y vela roja. ROI {0:5 %,20:4 %,30:3 %,60:1 %}, stop -10 % (se ignoran: las salidas con ROI/stop de 5 m no aplican a 30 m+; se simulan solo con las señales). Original 5 m. Declarado: ninguno fiable (README advierte). Plausibilidad 2.

### X15 ADXMomentum
- freqtrade-strategies (1 h). Entrada: ADX(14) > 25, MOM(14) > 0, +DI > 25 y +DI > -DI; salida: ADX > 25, MOM < 0, -DI > 25, +DI < -DI. Se implementa también como largo/corto reversible. Plausibilidad 2.

### X16 AdxSmas
- freqtrade-strategies (1 h). Entrada: ADX > 25 y cruce SMA3 sobre SMA6; salida: ADX < 25 y cruce inverso. Plausibilidad 2 (SMA 3/6 es ruido a 1 h).

### X17 AwesomeMacd
- freqtrade-strategies (1 h). Entrada: MACD > 0, AO > 0 y AO previo < 0; salida: MACD < 0, AO < 0, AO previo > 0. Plausibilidad 2.

### X18 Supertrend
- Fuente: indicador de práctica (ATR 10, multiplicador 3), implementaciones en TradingView/freqtrade. Regla: largo si cierre > banda inferior Supertrend, corto si < banda superior. Plausibilidad 2-3.

### X19 BbandRsi
- freqtrade-strategies/berlinguyinca (1 h, leído). Entrada: RSI(14) < 30 y cierre < banda inferior (20, 2); salida RSI > 70. Plausibilidad 2.

### X20 RSI(2) Connors
- Fuente: Connors-Alvarez, "Short Term Trading Strategies That Work" (2008). Regla: largo si RSI(2) < 10 y cierre > SMA200, salida RSI(2) > 70 o cierre > SMA5. Diseñado para acciones diarias. Plausibilidad 2.

### X21 Strategy002 / X22 Strategy003
- freqtrade-strategies (leídos). 002: RSI < 30, slowk < 20, cierre < banda inferior y martillo; salida SAR > cierre y Fisher-RSI > 0,3. 003: RSI 0-28, cierre < SMA40, Fisher < -0,94, MFI < 16, (EMA50 > EMA100 o EMA5 cruza EMA10), fastd > fastk; misma salida. Optimizadas con hyperopt (ROI para enero 2018). Plausibilidad 1: típico caso de sobreajuste; pocas señales a 1 h.

### X23 ClucMay72018
- freqtrade-strategies. Entrada: cierre < EMA50, cierre < 0,985 × banda inferior (precio típico) y volumen < 20 × media 30; salida: cierre > banda media. Plausibilidad 1: afinada para altcoins de 2018 a 5 m.

### X24 Squeeze de Bollinger
- Fuente: Carter (TTM Squeeze); https://www.cryptodatadownload.com/blog/posts/inside-contraction-historical-volatility-strategy/ . Regla: ancho de banda < percentil p de 120 barras, luego ruptura en dirección del momentum. Plausibilidad 2.

### X25 Breakout de volatilidad (Larry Williams)
- Fuente: Williams (práctica). Regla: largo si cierre > apertura + k × rango de la barra anterior (k=0,5), mantener h barras; simétrica para cortos. Plausibilidad 2.

### X26 Volatilidad objetivo sobre BTC largo
- Fuentes: Moreira-Muir (2017, acciones); https://www.wisdomtree.com/dk/insights/blog/enhancing-bitcoin-returns-using-momentum . Regla: exposición = min(cap, vol_objetivo / vol_realizada) con rebalanceo diario y banda de no-trade. Declarado (WisdomTree, ilustrativo): Sharpe 1,04 vs 0,84 de BTC. Plausibilidad 3: reduce drawdown, rara vez bate a comprar y mantener en neto.

### X27 Funding extremo contrarian
- Fuentes: K33 vía https://www.theblock.co/post/315831/perp-signal-bitcoin-bottom-bullish-year-end-k33 ; arXiv 2212.06888 (He-Manela-Ross-von Wachter). Regla: z-score del funding (ventana 7-30 días) > +k corto / < -k largo, mantener h barras. Declarado: tras funding mensual negativo, rendimientos medios a 90 días +79 % (descriptivo, horizonte distinto del nuestro). Limitación: **solo ~1 año de funding**: pocos pliegues OOS y menos operaciones; no podrá ser concluyente salvo muchas operaciones. Plausibilidad 2-3.

### X28 Funding a favor de la multitud
- Regla: largo cuando el funding es anormalmente alto (z > k) y corto cuando es anormalmente bajo, es decir, la dirección opuesta a X27. Corrección respecto al borrador inicial: "corto si funding alto" (carry) es lo mismo que X27 modo `fade`, así que X28 es el modo `follow`. Ambos modos se prueban y se cuentan como pruebas. Plausibilidad 2.

### X29 Pico de volumen
- Fuente: literatura volumen-retorno en BTC (p. ej. https://uis.brage.unit.no/uis-xmlui/handle/11250/2456812 ); regla propia: volumen > k × media 24 barras, seguir o contrariar la dirección de la barra. Plausibilidad 2.

### X30 Basis / cash-and-carry (NO ENCAJA)
- Fuente: He, Manela, Ross, von Wachter, "Fundamentals of Perpetual Futures", https://arxiv.org/html/2212.06888v5 . Declarado: Sharpe 1,92 con costes de minorista y 3,94 para creadores de mercado. Requiere largo spot + corto perp y datos de otro mercado: **fuera de alcance** (sin spot ni otros exchanges, y el ADR prohíbe operaciones reales).

### X31 Estrategias con libro de órdenes / on-chain (NO ENCAJAN)
- Reservas de exchanges (Quantpedia), desequilibrio del libro, flujos on-chain. Descartadas por datos.

## Notas de diseño de pruebas

- Los parámetros de la fuente se prueban primero; cada rejilla adicional se declara en el código y cuenta como pruebas para el DSR.
- Las reglas de salida de freqtrade (ROI y stop fijos de 5 m) se sustituyen por salidas por señal o por horizonte fijo, porque no son trasladables a barras de 30 m-2 h; se declara en el informe.
- Las estrategias "largo solo" se evalúan largo/plano; las simétricas largo/corto.

## Estado tras la Fase 2

- Implementadas y probadas: X01-X29 (29 entradas; X02 y X05 son variantes/controles de X01, X07 de X06, X10 de X09, X28 es el modo `follow` de X27). No implementadas: X30, X31 (datos).
- Código: `quant/C_signals.py` (señales), `quant/C_run.py` (walk-forward), `quant/C_combo.py` (combinaciones), `quant/C_final.py` (DSR global y alfa vs buy & hold).
- Resultados: `quant/results/C_<id>_<tf>[_maker].json`; informe en `quant/informe-C-externas.md`.
