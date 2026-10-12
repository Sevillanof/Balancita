# Correlación y credibilidad de Qwen (2026-10-12)

Pedido de Fran tras el video de finanzas cuantitativas (parte 10, correlación). Sin llamar a Qwen, sin tocar código de Balancita.

## Lectura 1: credibilidad = correlación (IC) entre la señal de Qwen y el retorno posterior

- Medida: IC de Spearman y de Pearson entre `p(buy) − p(sell)` y el retorno bruto posterior, con IC 95 % por bootstrap de bloques de 1 día. Script listo: `ic_qwen.py` (se corre en la Mac sobre un run de replay guardado, no llama al modelo). Las decisiones de Qwen están en la Mac y desde la nube no se pueden leer, así que **no se calculó con datos reales**.
- Con lo ya medido en `odd/tasks/qwen-calibration.md` se puede anticipar el resultado: acierto +1 de 47,7 % (v4) y 36,8 % (segundo rango) contra "siempre hold" 49,8 % y 43,7 %; buys aciertan 20-30 %; tras recalibrar con T, Brier/log-loss al nivel del azar y peor que la tasa base. Eso implica un IC ≈ 0 o ligeramente negativo en el rango de confianza que usa.

## Lectura 2: la correlación entre activos como contexto

Datos: velas de 15 min de los 8 perpetuos, 2 años (548.115 observaciones, 727 días). Variables hasta el cierre de la barra, objetivo = retorno de las barras siguientes (15 y 60 min). Ridge hacia adelante: 180 días solo de entrenamiento, reentrenado cada 30 días, purga de 6 h, umbral del 10 % más seguro fijado con datos de entrenamiento, coste 10 pb ida y vuelta, t agrupado por día, Holm sobre 28 pruebas. Script: `study.py`, resultados: `res_correlacion.json`.

Qué se midió como "información de correlación": movimiento del resto de activos (m1, m4), residuo del activo contra el mercado con beta de 7 días (res1, res4), movimiento relativo (rel4), correlación móvil de 24 h con el resto (corr24), correlación media del mercado (mktcorr) y sus cruces con el propio movimiento.

Resultados:

1. **Confirma la intuición del video**: la correlación sube en caídas. Correlación media 0,716; tras el 10 % peor de las ventanas de 24 h, 0,775; tras el 10 % mejor, 0,694. Es una propiedad de los datos, no una señal de dirección.
2. **El nivel de correlación no predice nada**: `corr24` y `mktcorr` tienen IC ≈ 0 a 15 y 60 min (t entre −1,2 y 0,7; Holm p ≥ 0,9).
3. **Sí hay señal, pero es la misma reversión de siempre**: el residuo contra el mercado (`res1`, IC −0,046 a 15 min, t −30) y el movimiento propio (`z1`, −0,043) son lo mismo visto de otra forma. Negativo = tras subir, baja. La correlación solo cambia cuánto: la reversión de 60 min es algo mayor con correlación baja (IC −0,033, t −6,1) que alta (−0,048, t −0,9; poca muestra en alta).
4. **No añade nada al modelo con solo variables propias**. IC fuera de muestra a 15 min: 0,042 sin correlación contra 0,034 con ella (diferencia −0,0085, p = 0,018, es decir peor); a 60 min 0,030 contra 0,028 (p = 0,63).
5. **Ninguna versión gana tras costes**. Top 10 % de confianza, neto por operación: 15 min −8,6 pb (solo propias) y −6,8 pb (con correlación), t −7,5 y −19,6; 60 min −7,1 y −4,9 pb. El bruto es +1,4 a +5,1 pb contra ~10 pb de coste. La mejora de −8,6 a −6,8 viene de operar moves más grandes, no de más acierto (acierto 54,5 % → 52,0 % a 15 min).

## Conclusión y recomendación

- Más credibilidad para Qwen **no sale de darle la correlación**: la información entre activos no tiene señal neta de costes propia y no mejora lo que ya ve. **No proponer brazo A/B de Qwen con correlación** (la regla del plan: solo si el estudio sin modelo pasa Holm neto; no pasa).
- La correlación sí sirve como **medida de credibilidad** (Lectura 1): usar el IC de `p(buy) − p(sell)` con IC 95 % como métrica oficial de Qwen. Es más simple que Brier/log-loss y se interpreta rápido (IC ≈ 0,02-0,05 sería "algo", como el techo estadístico; Qwen hoy da la impresión de estar en ≈ 0 o negativo). Falta correr `ic_qwen.py` en la Mac sobre los runs de `server/data/replays-qc02/` (solo lectura, no recalienta).
- Uso práctico de la correlación para riesgo, no para predecir: 5 de los 8 perpetuos correlacionan 0,76-0,90 y suben en caídas, así que una cartera de varios perpetuos de Qwen no diversifica cuando más hace falta; limitar el riesgo agregado por grupo correlacionado.
