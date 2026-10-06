# Informe A — tendencia / time-series momentum en 30 m, 1 h y 2 h (resumen)

Fecha: 2026-10-06. Análisis en scratch, sin cambios al repo. Datos y motor compartidos con el informe C.

**Datos y protocolo**
- Velas oficiales de Kraken PF_XBTUSD, de 2022-03-23 a 2026-10-06: 30 m, 1 h y 4 h nativos, 2 h agregado.
- Funding publicado solo desde 2025-10. Antes de esa fecha se imputa con la media observada (3,1 % anual).
- Ejecución: señal al cierre de la barra, operación en la apertura de la siguiente, con un test de no-lookahead.
- Costos: taker 5 bp más 0,5 bp más 1 tick por lado. El escenario maker de 2 bp se reporta aparte.
- Walk-forward: 14 folds de 91 días. Fuera de muestra (OOS) de 2023-03 a 2026-09, 1.274 días.
- Se probaron 375 configuraciones: TSMOM, cruce de medias, Donchian con ATR, TSMOM con volatilidad escalada, TSMOM con filtro de régimen y un conjunto de horizontes. El DSR está corregido por las 375 pruebas.

**Resultados (OOS, taker, neto de funding)**

| Estrategia | Neto anual | Sharpe [IC95 %] | Trades | bp/trade | MaxDD |
|---|---|---|---|---|---|
| TSMOM 2 h (la mejor) | 19,5 % | 0,68 [-0,37; 1,67] | 236 | 35 | 40 % |
| TSMOM 1 h | 12,3 % | 0,50 [-0,57; 1,53] | 328 | 19 | 49 % |
| TSMOM 30 m | 6,3 % | 0,35 [-0,74; 1,39] | 453 | 10 | 50 % |
| Donchian 1 h | 10,6 % | 0,52 [-0,59; 1,57] | 95 (no concluyente) | 48 | 26 % |
| Buy & hold | 30,0 % | 0,80 [-0,15; 1,81] | — | — | 55 % |

- Cruce de medias, TSMOM con filtro de régimen y el conjunto de horizontes dan entre cero y negativo. El conjunto en 30 m y 1 h da Sharpe −2,6 y −1,8.

**Conclusión**
- Ningún resultado tiene el IC95 % del Sharpe por encima de 0, ninguno tiene un DSR relevante y ninguno supera al buy & hold.
- Lo que "funciona" es ir largo o quedarse afuera con una mirada de unos 30 días. Equivale a una beta de alrededor de 0,47 a BTC, con alfa nula (t de 0,4), y la ganancia se concentra en 2023H2.
- Todas las variantes largo/corto con horizonte de 96 h o menos pierden.
- Los costos se comen entre el 23 % (2 h) y el 51 % (30 m) del retorno bruto.
- Con maker 2 bp el mejor Sharpe es 0,82, y tampoco es significativo.
- Para validar un Sharpe de alrededor de 0,7 harían falta unos 10 años de datos fuera de muestra.
- Recomendación: no implementar ninguna de estas estrategias como fuente de alfa.
