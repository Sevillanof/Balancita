# MR-1X: Momentum Relativo con universo histórico ampliado (prueba 8)

Solo paper. Se conservó la especificación MR-1 (28 días, lunes 00:00 UTC, largos los más fuertes y cortos los más débiles, neutral en dólares, entrada t+2 h, cierre y reapertura semanal). Reglas del universo y de costes congeladas y subidas antes de calcular retornos (`mr1x_spec.json`); la auditoría previa solo miró cobertura, fechas, huecos y volumen. Datos hasta 2026-08-01; lo reservado no se usó y `holdout` no se ejecutó. Una sola evaluación.

**Veredicto: ventaja no demostrada, y mucho más débil con el universo ampliado. Recomiendo congelar MR-1.**

## Auditoría del universo
- 692 símbolos de trade en el servicio de gráficos, 497 `PF_*`; 477 con velas de 1 h en la ventana (20 salieron después del corte). 204 están vivos hoy y 293 ya no figuran como instrumentos, con velas hasta distintas fechas (muchos con la última vela en 2025-03, 2025-11 o al corte). Huecos de velas: casi nulos (mediana 0, máximo 2).
- Liquidez muy desigual: la mediana de volumen diario por símbolo es de unos 3.000 USD. Con el filtro de 1M USD/día quedan entre 8 y 45 productos por semana (mediana 25); los 8 originales superan 8,8M USD/día.
- No hay bid/ask histórico: los costes de todos los productos fuera de los 8 originales son una estimación por tramos de liquidez (17,1 y 24,2 pb de ida y vuelta, 40 pb de coste semanal medio con ambas patas) y son la mayor incertidumbre. Los retirados no tienen categoría ni funding, así que se incluyen sin clasificar y sin funding.
- Excluidos por no ser cripto: 14 instrumentos vivos con `tradfi` o categoría xStocks.

## Resultados (154 semanas con al menos 8 productos)
| | Ampliado | 8 originales, mismas semanas | 8 originales, sus 173 semanas |
|---|---|---|---|
| Neto medio / semana | **+57,9 pb** | +114,8 pb | +126,9 pb (reproduce MR-1) |
| Bruto medio (IC90) | +98 pb (−38 a +244) | +142 pb (−29 a +322) | +154 pb |
| Umbral exigido | 266 pb | 307 pb | 285 pb |
| Tercios (neto) | +61 / +238 / −122 | +141 / +32 / +170 | +90 / +130 / +159 |
| Drawdown máximo neto | 11.380 pb | 10.285 pb | 10.285 pb |
| IC de Spearman (t) | 0,006 (0,24) | 0,020 (0,58) | 0,019 (0,57) |
| Alfa sobre el mercado (IC90) | +94 pb (−29 a +218) | +141 pb (−12 a +294) | +154 pb |
| Concentración | 71 productos aportan; el mayor pesa 11 % | 8 productos; los 3 primeros 56 % | |

## Controles y sensibilidades
- **Azar (200 selecciones con el mismo k y semanas):** neto medio −38 pb; el ampliado supera al 95,5 % (p ≈ 0,045). **Corregido por 8 pruebas (Bonferroni): p ≈ 0,36.**
- **Costes de impacto ×2 en los no medidos:** neto +38,9 pb.
- **Solo productos vivos hoy (140 semanas):** neto +39,6 pb. Los no listados hoy aportan 1.682 pb de 15.119 pb, es decir, el sesgo de supervivencia no explica el resultado.
- **Sin los 3 mayores aportantes (MOODENG, FARTCOIN, POPCAT, diagnóstico post hoc):** neto **−5,8 pb**. Sin ellos no queda ventaja.
- **Liquidez ≥ 5M USD/día (93 semanas):** neto **−49,5 pb**, IC de Spearman negativo; evidencia insuficiente.
- **Espejo:** −138 pb.

## Lectura
1. Al ampliar el universo, el neto cae a la mitad y el alfa pierde significación; el resultado de MR-1 con 8 productos no se confirma como señal general.
2. Lo que queda depende de memecoins de poca liquidez (los 3 mayores aportantes) y desaparece al exigir más liquidez o quitarlos.
3. El ranking de momentum no predice (IC ≈ 0) en ninguna versión.
4. Los costes de los productos ilíquidos son estimados, no medidos, así que incluso el resultado ampliado es optimista o pesimista según esa suposición.
5. El tercio final es negativo (−122 pb) en el universo ampliado.

Conclusión según el criterio que fijaste: la ventaja desaparece al ampliar y diversificar, y depende de pocos productos. MR-1 queda congelada. Registro: 8 pruebas nuevas en esta línea (FO-1 ×4, RE-1 ×2, MR-1 y MR-1X).

Archivos: `mr1x_spec.json`, `mr1x_data.py`, `mr1x_audit.py`, `cobertura_universo.json`, `mr1x_run.py`, `mr1x_test.py` (5 tests), `mr1x_resultados.json`, `../registro-pruebas.json`.
