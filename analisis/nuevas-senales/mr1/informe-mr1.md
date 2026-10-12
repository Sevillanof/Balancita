# MR-1: Momentum Relativo semanal. Resultado

Solo paper. Especificación única congelada y subida antes de calcular retornos (`mr1_spec.json`): cada lunes 00:00 UTC, retorno de 28 días, LONG los 2 mayores y SHORT los 2 menores de 8 (k = n/4), neutral en dólares, entrada en t+2 h, cierre y reapertura semanal con ida y vuelta completa de costes. Universo dinámico (HYPE entra 28 días después de existir). Datos hasta 2026-08-01; lo reservado no se usó y `holdout` no se ejecutó.

**Veredicto: ventaja no demostrada** (173 semanas, no supera el umbral). Es el resultado más favorable de esta línea, pero no concluyente.

| | Principal | Sin HYPE y ZEC | Espejo |
|---|---|---|---|
| Semanas | 173 | 173 | 173 |
| Bruto medio / semana | +154 pb (IC90 −4 a +316) | +117 pb (IC90 −0,3 a +239) | −154 pb |
| Coste medio / semana | 27 pb | 27 pb | 27 pb |
| Neto medio / semana | **+127 pb** | +90 pb | −181 pb |
| Umbral exigido (bruto) | 285 pb | 240 pb | 285 pb |
| Tercios cronológicos (neto) | +90 / +130 / +159 | +130 / +124 / +20 | negativo |
| Desv. semanal | 1.131 pb | 936 pb | |
| Drawdown máximo neto | 10.285 pb | 8.606 pb | 38.347 pb |

Otros controles:
- **Selección aleatoria (mismas semanas, mismo k):** neto medio −26,7 pb; MR-1 supera al 98,5 % de los sorteos (p ≈ 0,015 sin corregir).
- **Exposición al mercado:** beta −0,006, alfa bruto +154 pb (IC90 +13 a +296): el resultado no se explica por estar largo del mercado.
- **Costes solo en patas que cambian:** neto +148 pb/semana.
- **Funding (solo 41 semanas con datos desde oct-2025):** neto −9,8 pb con funding y −16,0 sin él en esa ventana; evidencia insuficiente.

## Por qué no lo llamo ventaja
1. **No supera el umbral** fijado antes de correr (IC90 inferior −4 pb frente a 285 pb).
2. **El ranking no predice.** El IC de Spearman medio entre momentum y retorno de la semana siguiente es 0,019 (t = 0,57). La ganancia viene de los extremos (2 largos y 2 cortos), no de una relación ordenada, y eso es una lectura post hoc.
3. **Concentración.** SOL (+12.076 pb), ZEC (+10.710 pb) y ADA (+9.512 pb) suman más que el total (+26.661 pb); NEAR y XRP restan.
4. **Sesgo de supervivencia.** Los 8 productos son los vigentes hoy; ZEC y HYPE son ganadores recientes. Sin ellos el último tercio cae a +20 pb.
5. **Riesgo.** Desviación semanal de ~11 % de la pata y drawdown acumulado de unos 10.000 pb.
6. **Pruebas múltiples.** Corregida por las 7 pruebas de esta línea (FO-1 ×4, RE-1 ×2, MR-1 ×1), la significación frente al azar pasa de ≈ 0,015 a ≈ 0,10.

## Qué sí dice
Es la primera hipótesis de esta línea con neto positivo, tercios positivos y alfa distinto de cero después de quitar el mercado, y con espejo claramente negativo. No alcanza para implementarla, pero justifica una prueba más potente: el cuello de botella es la muestra (8 productos, 173 semanas), no el costo.

Archivos: `mr1_spec.json`, `mr1_run.py`, `mr1_test.py` (4 tests de causalidad y universo), `mr1_resultados.json`, `../registro-pruebas.json`.
