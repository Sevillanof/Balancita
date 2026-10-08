# Validación sin trampas

Cuidados para que la prueba de una estrategia (o de Qwen) no mienta. Auditoría de 2026-10-08 sobre `main` @ d6f00d3, con 240 días de velas oficiales de 1 min y 5 min de los 8 productos `PF_*` (Kraken Futures, trade candles).

## Qué se auditó y qué se encontró

| Zona | Hallazgo | Estado |
| ---- | -------- | ------ |
| Indicadores (`futures_simulator.IncrementalFeatures`, `frames`) | Solo velas cerradas: Donchian usa las barras previas, la tendencia de 5 min entra cuando su vela ya cerró. Paridad con `calculate_features` fijada por test. Sin fuga. | ✅ sin cambios |
| Simulador (`Book`) | Decide al cierre de la vela y llena en ese cierre más el coste; si en una vela tocan stop y objetivo, gana el stop (pesimista). Sin fuga; el llenado "en el cierre que dio la señal" se probó con entrada una barra tarde (abajo). | ✅ medido |
| Corte 70/30 del Laboratorio | Cortaba por hora de entrada: una operación abierta antes del corte y cerrada después alimentaba los dos lados, y la primera después del corte dependía del estado anterior. | 🔧 purgado + embargo |
| Tramos de fiabilidad (4 tramos) | Igual: asignaba por hora de entrada. | 🔧 purgado + embargo |
| Puertas de promoción | Usaban el backtest más reciente de cualquier ventana (7, 30 o 90 días): se podía elegir la ventana más favorable sin que contara como intento. | 🔧 usa la ventana más larga |
| Replay a ciegas de Qwen | El campo `strategy_reliability` leía la tabla guardada (y el resumen forward), medidos con velas que incluyen el rango reproducido: Qwen veía el resultado de las estrategias antes de decidir. | 🔧 tabla "a la fecha" |
| Memoria de lecciones de Qwen | Solo entran decisiones cuyo cierre a 30 min ya existe. Nuevo test: los prompts de un replay no cambian aunque se quiten las velas posteriores. | ✅ test centinela |
| Kronos, C30, C31 (`qwenexit`) | Se miden solo hacia delante, con spec registrado por hash y operaciones cerradas append-only. Es la prueba más limpia. | ✅ sin cambios |
| Contaminación del propio modelo | Qwen/Kronos pudieron ver precios históricos al entrenarse. El STATE de Qwen no lleva fechas, precios ni producto; las velas disponibles (desde 2025-06) son posteriores a su corte. El riesgo real queda en el replay de rangos anteriores al corte de un modelo nuevo: anotarlo al cambiar de modelo. | ⚠️ vigilar |
| Ajuste repetido sobre el mismo OOS | El Laboratorio siempre mira el último 30 % de la ventana; tras varias ediciones ya no es "fuera de muestra". El deflated Sharpe lo corrige contando variantes, pero la salvaguarda real es la prueba hacia delante. | ⚠️ ver "Pendientes" |

## Qué se agregó

`python/balancita_engine/futures_purged.py`:

- **Purga**: una operación pertenece a un bloque solo si entra y sale dentro de él; las que cruzan un límite no cuentan en ninguno.
- **Embargo**: se salta el comienzo de cada bloque (menos el primero) tanto como duró la operación más larga (tope: 25 % del ancho del bloque).
- **Bloques purgados** (6 en el Laboratorio): media neta por bloque en lugar de un único corte 70/30. Un bloque con menos de 5 operaciones no se juzga.
- **PBO** (probabilidad de sobreajuste, CSCV de Bailey y López de Prado) entre las estrategias del ranking: aparece como `overfitting` en `/ranking`. Deja fuera a las variantes con menos de 30 operaciones, que ganarían "no haciendo nada".
- **Estrés**: las mismas operaciones con +50 % del coste de ida y vuelta, y con la entrada una barra tarde; más el "colchón" (bp extra por operación que anulan la media).
- **Centinela anti-fuga** (`lookahead_leaks`): quita las velas posteriores a un corte y exige que las operaciones ya cerradas salgan idénticas. Test sobre C25-C30 y sobre el replay de Qwen.

En el Laboratorio, el resultado del backtest trae ahora `purged_folds`, `split_purge`, `out_of_sample_unpurged` (el corte viejo, para comparar) y `stress`. Las puertas a `active` suman `purged_folds_positive` (media positiva en al menos el 60 % de al menos 3 bloques) y `survives_late_entry` (media neta > 0 con la entrada una barra tarde), y leen siempre la ventana más larga probada. "Operar en paper ya" sigue saltándose las puertas.

## Qué cambia en los veredictos

Medido con las operaciones de las 6 estrategias sobre 240 días y 8 productos (método viejo contra purgado, mismas operaciones):

- **Veredictos: ninguno cambia.** C25-C28 siguen en `negative_edge` (media neta de -13,6 a -14,4 bp, casi exactamente el coste de ida y vuelta: antes de costes no hay ventaja). C29 `candidate_edge`; C30 `no_edge` (2 de 4 tramos positivos en estos 240 días; la tabla guardada, de 16 meses, la tiene en `candidate_edge`).
- **Corte 70/30 purgado**: en las estrategias rápidas descarta de 0 a 3 operaciones de unas 1.500-2.100 y mueve la media fuera de muestra menos de 0,1 bp. En C29/C30 (operaciones de horas, embargo de 24 h) hay solo 1 a 5 operaciones fuera de muestra por producto en 90 días, y la media oscila entre -232 y +775 bp: **el OOS de un producto no sirve para juzgar estrategias lentas**, con o sin purga.
- **Estrés**: con +50 % de coste todas las medias empeoran de 5 a 9 bp; las pocas positivas (C29/C30 en algunos productos) siguen positivas, así que el coste no las mata. La entrada una barra tarde cambia la media menos de 0,1 bp: llenar en el cierre de la señal no está inflando nada.
- **PBO** entre las 6 variantes: de 0,03 a 0,87 según el producto. Con variantes casi todas perdedoras es ruido; empieza a servir cuando haya muchas variantes plausibles (las que Fran crea con "crear nueva").
- **Centinela sobre velas reales** (BTC y ETH, últimos 30 000 min, corte al 70 %, las 6 estrategias): 0 operaciones distintas, es decir, ninguna fuga de futuro.

Conclusión práctica: la validación purgada es barata y correcta, pero **no mejora la rentabilidad ni cambia hoy ningún veredicto**; protege contra el día en que una estrategia lenta o una edición del Laboratorio parezca buena por un corte afortunado. Lo que más separa suerte de ventaja es lo que ya se hace: costes reales y medir hacia delante.

## Pendientes (por orden de rendimiento)

1. **Juzgar C29/C30 con todos los productos juntos** en el Laboratorio (ahora es por producto, con 1-5 operaciones fuera de muestra).
2. **Reserva ciega**: apartar los últimos N días y no mostrarlos en el Laboratorio hasta decidir; hoy el único OOS realmente limpio es el forward.
3. **Contar intentos entre productos y entre ventanas** en el deflated Sharpe (hoy cuenta variantes distintas por producto).
4. **Llenado por libro real**: el coste usa una tabla medida (2026-10-07); refrescarla con `measured_spread_bps` de nuestros datos.
5. **Replay de Qwen**: guardar en la meta el corte de entrenamiento del modelo y avisar si el rango lo precede.
6. **Funding** en todos los backtests (hoy `funding_complete=false` salvo que se pasen periodos).
