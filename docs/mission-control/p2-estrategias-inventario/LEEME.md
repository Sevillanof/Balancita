# Estrategias: inventario (capturas)

Capturas de la app React a 1440x900 (Playwright `desktop-1440x900`), generadas por
`e2e/estrategias-inventario.pw.ts` contra el registro S real (proceso Python) con una
base temporal y una copia de solo lectura de `config/`. Llevan el rótulo
«DATOS DE EJEMPLO · SANDBOX»: los estados de registro están sembrados, no son los de la Mac.
Ninguna base real, proceso de captura, estrategia ni WebSocket se tocó.

- `1-inventario.png`: inventario de modelos (vista por defecto de Estrategias).
- `2-auditoria-cerrada.png`: auditoría de una estrategia cerrada.
- `3-laboratorio-c29.png`: «Detalle» abre el Laboratorio sobre C29.
- `comparacion-stitch-vs-react.png`: Stitch v5 (izquierda) y React (derecha).

## Diferencias con Stitch que quedan

- Stitch muestra PnL neto paper, muestra forward y P&L por estrategia: esos datos son B5
  y hoy figuran «forward: B5» / «No disponible» (no se inventan).
- Stitch dice «Validada», «Alfas desplegados en paper»: la app usa «Activa en el registro»
  (el registro no prueba que el proceso corra) y solo «Evidencia preliminar» para candidate_edge o mejor.
- Chips de AUM, Sharpe, fricción y modo L2 de Stitch: sin fuente verificable, no se muestran.
- Botón «Ver Matriz Comparativa»: entra al apilar la vista de comparación (#158/#159).
- La app agrega filas de C31, Kronos y Carry (estado no verificado) y las cerradas, que Stitch no muestra.
