# Estrategias: comparación de experimentos (capturas)

Capturas de la app React a 1440x900 (Playwright `desktop-1440x900`), generadas por
`e2e/estrategias-comparacion.pw.ts` contra el registro S real (proceso Python) con una
base temporal y una copia de solo lectura de `config/`. Llevan el rótulo
«DATOS DE EJEMPLO · SANDBOX»: los estados de registro están sembrados, no son los de la Mac.
Ninguna base real, proceso de captura, estrategia ni WebSocket se tocó.

- `1-comparacion.png`: comparación con el gateway apagado; Kronos queda «Estado no verificado».
- `2-comparacion-kronos-verificado.png`: `/api-live/system` y `/api-live/kronos/scores`
  respondidos con cifras sintéticas en la prueba (resumen de hace 10 min, scores `ok`):
  Kronos pasa a «Actividad verificada» con operaciones, decisiones y hora del resumen.
- `comparacion-stitch-vs-react.png`: Stitch v5 (izquierda) y React (derecha).
- `solicitudes.json`: llamadas `/api-*` de la prueba.

## Regla de Kronos (solo lectura)

«Actividad verificada» solo si `kronos.updated_ms` de `/api/system` tiene ≤ 90 min (regla de B1) y
`/api/kronos/scores` responde con datos (no `off`). Si falta `updated_ms`, el resumen es viejo,
`/api/system` no responde o Kronos no está configurado: «Estado no verificado». Nunca se infiere
de la configuración ni de `running`.

## Diferencias con Stitch que quedan

- Sin cartera consolidada, sin drawdown ni Sharpe (no existen en la fuente) y sin gráfico de equity
  (figura «No disponible», B5).
- «Brazos A/B/C» no se muestran: no hay definición registrada que los respalde.
- La columna de unidad es por experimento: «pb por operación (neto)» solo donde hay backtest neto;
  «No disponible» en el resto.
- Stitch muestra PnL y muestra forward por estrategia: son B5 y figuran «No disponible (B5)».
- La app incluye C31, Kronos, Carry y las cerradas, con estado no verificado donde no hay fuente.
