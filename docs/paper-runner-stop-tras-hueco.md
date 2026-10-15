# Stop cruzado durante un hueco de observación (#186)

Decisión de Fran: BAL-DECISION-186-05. Solo cambia un caso; todo lo demás queda igual.

## Qué cambia

Una posición está abierta y el runner declaró una interrupción real (caída). La primera vela
válida que llega después del hueco ya abre más allá del stop. Antes, la salida se registraba al nivel del stop, un precio
que el runner nunca observó. Ahora la referencia de la salida es la apertura de esa vela, con el modelo de costes que ya existe.

- La opción es `RunnerConfig.stop_after_hole`: `gap_open` (por defecto) o `level` (el comportamiento anterior).
- Entra en la identidad de la corrida. Un diario escrito con otra opción se rechaza al recuperar (`config_incompatible`); no se reinterpreta.

## Qué no es

- **No es un fill real ni liquidez verificada.** Es una referencia SIMULADA a partir de una vela. El trade lo dice:
  `stop_exit.evidence = "ohlc_open_gap_after_hole_simulated"`, `estimated = true`, `quote_backed = false`.
- No mueve el tiempo de salida hacia el hueco: la salida es siempre de la vela posterior.
- No afirma que el nivel del stop no existió en el mercado: lo que falta es la observación de ese período por el runner. El hueco sigue declarado.
- Con el motor detenido nadie evalúa stops ni objetivos; esto no es protección activa.

## Qué no cambia

- La vela que cierra justo cuando termina el hueco (su minuto cae dentro del tiempo no observado, pero es lo primero que ve el runner después) también es «la primera»: usa su apertura como referencia simulada, no el nivel del stop (D-206-01).
- Solo cuenta una interrupción real del runner (`runner_interrupted`). Un silencio de cotizaciones de más de `coverage_gap_ms` (120 s, hipótesis sin aprobar) sin caída (`quote_gap`) NO activa la regla: la salida queda como antes (BAL-DECISION-186-06, Fran: No).
- Las cotizaciones después de un hueco se tratan igual que antes (prueba: mismo resultado con `gap_open` y con `level`).
- La identidad de la corrida incluye siempre `stop_after_hole`: un directorio de runner creado antes de este cambio no se recupera (`config_incompatible`), falla cerrado y no se reinterpreta (D-206-04).
- Sin hueco declarado, o con una vela que abre antes del stop, o si no es la primera vela después del hueco: se aplica `stop_policy` como siempre (por defecto `level`).
- Las cotizaciones se tratan igual. `stop_policy` (`level`, `gap_open`, `gap_worst`) no cambia para ningún libro.
- Una vela con una apertura inválida se rechaza antes de llegar al diario; no se inventa una apertura. A nivel de `Book`, sin apertura se conserva el nivel del stop y se declara (`post_hole_open_unavailable_stop_level`).

Pruebas: `python/tests/test_paper_post_hole_stop_186.py`.
