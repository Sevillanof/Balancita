# FO-1: desarme por Open Interest y liquidaciones. Resultado

Solo paper. Especificación congelada y subida antes de calcular retornos (`fo1_spec.json`). Datos 2023-03 a 2026-08-01; desde 2026-08-02 no se descargó ni usó nada y `holdout` no se ejecutó. No se tocaron Funding, Momentum, Mean Reversion, combinador ni Qwen.

**Veredicto: evidencia desfavorable.** Con 354 clusters independientes (muestra de sobra) el neto es negativo y el bruto no se distingue de cero ni del azar.

| | 4 h | 24 h |
|---|---|---|
| Episodios / clusters | 758 / 354 | 758 / 354 |
| Bruto medio | −3,3 pb (IC90 −26 a +19) | +5,5 pb (IC90 −40 a +52) |
| Neto medio | −16,4 pb | −7,6 pb |
| Umbral exigido (coste + 3σ/√N) | 41,4 pb | 81,3 pb |
| Sin HYPE ni ZEC (bruto / neto) | +2,6 / −10,2 pb | +14,8 / +1,9 pb (no demostrada) |
| Control aleatorio (neto medio) | −12,4 pb; el 71 % de los sorteos iguala o supera a FO-1 | −9,1 pb; el 48 % |
| Espejo (continuación) | bruto +3,3 pb, neto −9,8 pb | bruto −5,5 pb, neto −18,6 pb |
| Tercios cronológicos (neto) | −15,3 / +0,6 / −34,4 | +15,7 / +30,0 / −68,0 |

Lectura: el desarme no anticipa movimientos posteriores (bruto ≈ 0), así que no hay nada que superar los costes. Los tercios son inestables y por producto el signo cambia (NEAR +27 pb y XRP +15 pb a 4 h, ZEC −35 pb). Ni la dirección contraria ni la de continuación funcionan.

## Corrida paralela de la sesión de la Mac
Esa sesión implementó y ejecutó por su cuenta otra versión de FO-1 (percentiles 95/99 sobre 720 h, clusters a 6 h, velas de 1 min, solo desde febrero de 2026): evidencia insuficiente (49 clusters) con bruto negativo. Fue una corrida no coordinada; se cuenta como una prueba aparte (4 pruebas FO-1 acumuladas: 2 especificaciones × 2 horizontes). Su resultado lo conocí cuando mi corrida ya estaba lanzada; mi especificación estaba congelada antes. La ventana larga de esta corrida resuelve su falta de muestra, y no apunta a una ventaja.

## Observación que NO es un resultado
La referencia solo precio (entrar contra los mayores movimientos de 4 h, sin OI ni liquidaciones) dio bruto +28,7 pb a 4 h y +93,4 pb a 24 h con 259 clusters, positiva en los tres tercios. Es post hoc: el corte por ranking global usa toda la muestra, es una referencia y no una hipótesis, y mx-meanrev (reversión a 5 min) falló. No es una ventaja demostrada. Solo justificaría una hipótesis nueva con umbral causal preregistrado, que requiere tu decisión.

## Limitaciones
Sin funding en el coste (cobertura de un año). La publicación del bucket se asume cerrada una hora antes de la entrada, no se midió latencia histórica. La dirección usa el signo del precio, como se declaró. SOL puede tener huecos de OI.

Archivos: `fo1_spec.json`, `fo1_data.py`, `fo1_run.py`, `fo1_test.py` (4 tests de temporalidad), `fo1_resultados.json`, `../registro-pruebas.json`.
