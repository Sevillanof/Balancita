# Contabilidad y riesgo ante condiciones adversas (etapa 7)

Estado: aislado, solo offline. No está conectado al forward, a `capture`, a los colectores, a Kronos ni a Qwen. No toca C29-C32, bases activas, holdout, los parámetros de riesgo aprobados (`PortfolioPolicy`, hash `8c22a0c0143c697c`, fijado en una prueba) ni el ADR 0001. Sin órdenes reales, sin credenciales, sin reloj de pared ni red. La rentabilidad de las estrategias queda fuera de alcance.

Objetivo: que la cartera compartida represente y contabilice bien una pérdida mayor que la prevista, un movimiento brusco y un ajuste tardío de funding. Se mejora la fidelidad del simulador y la seguridad contable, no las estrategias.

## Auditoría inicial: qué existía y qué se hizo

| Requisito                                          | Qué había en `main` (fbe3651)                                                                                                                                                                                | Qué hace la etapa 7                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Un solo motor                                      | `Book` (fills, comisiones, funding, stop/objetivo/tiempo), `Portfolio` (capital, tamaño, límites), `futures_costs` (único modelo de costes)                                                                  | Se extienden esos tres; no hay segundo simulador ni segunda contabilidad                                                                                                                                     |
| Stop atravesado por un gap                         | `Book` salía **siempre al nivel del stop** más el coste del modelo; la pérdida de un stop era, por construcción, la planificada                                                                              | Opción `stop_policy` en `Book`/`Portfolio` (`level` por defecto = comportamiento anterior; `gap_open`, `gap_worst`) y registro del nivel, precio de referencia, precio ejecutable, deslizamiento y evidencia |
| Vigilar el minuto de entrada                       | Límite documentado en `docs/ejecucion-temporal.md`: la posición no ve la vela del minuto de entrada                                                                                                          | `portfolio_watch.QuoteWatch`, activable en `TimedExecutor(watch=WatchPolicy())`; sin `watch` todo igual                                                                                                      |
| Pérdida mayor que la planificada                   | El portafolio ya sumaba el P&L real de `Book` al capital, recalculaba el presupuesto (1 % del capital definitivo), el drawdown y las suspensiones diaria y por drawdown; faltaba poder _producir_ la pérdida | Se reutiliza tal cual y se demuestra con pruebas; la regla de suspensión se extrae a `suspension_state` sin cambiarla                                                                                        |
| Funding incompleto                                 | `Book` marca `funding_complete` y `Portfolio` separa provisional de definitivo; la conciliación existente (#107, #118) trabaja sobre tablas del forward y de Kronos, no sobre la cartera                     | `portfolio_funding`: ingreso verificado de periodos y conciliación idempotente con historial; no toca ni reemplaza las del forward y Kronos                                                                  |
| Identidades contables independientes (#122)        | `_check_*` dentro de `OfflineExecutor`, atadas a ese ejecutor                                                                                                                                                | `portfolio_audit.audit(portfolio)`: mismo enfoque (recalcular desde datos crudos) para cualquier `Portfolio`; sin falsos positivos en los seis escenarios de #122 (prueba)                                   |
| Registro durable de señales (#124), entrada (#131) | `signal_continuity`, `execution_timing`                                                                                                                                                                      | Reutilizados sin tocar la lógica (solo la opción `watch`)                                                                                                                                                    |

## Piezas

- `futures_simulator.Book`: parámetro `stop_policy`, método `close_on_quote` (cierre a un precio demostrado por una cotización), lista paralela `fills` (precio de referencia y evidencia de cada salida) y `entry_ms` opcional en la posición (el funding corre desde la entrada real). Con los valores por defecto los resultados son idénticos; una prueba lo compara con `simulate`.
- `portfolio.Portfolio`: `stop_policy`, `close_on_quote`, `capital_log` (cada cambio del capital definitivo, encadenado por hash), `trade_details` (referencias y estado «al cerrar» de cada operación), `suspension_state`, y los registros `adjustments`, `reclassifications`, `funding_log`, `funding_conflicts`, `funding_disputes`, `review_flags`. El drawdown y el resultado diario se leen del `capital_log`; sin conciliaciones dan exactamente lo de antes.
- `portfolio_watch`: vigilancia con cotizaciones (abajo).
- `portfolio_funding`: `ingest_funding` y `reconcile_funding`.
- `portfolio_audit`: `audit`, `trade_reconstruction`, `planned_vs_realized`, `accounting_digest`, `intake_digest`.
- `portfolio_stage7`: 17 escenarios sintéticos (el informe generado se borró al sacar los datos inventados).

## Stops ante gaps

| Política              | Precio de referencia de un stop que el mercado cruzó                                                           | Evidencia                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `level` (por defecto) | el nivel del stop                                                                                              | sin registro nuevo (comportamiento de todo lo anterior)                 |
| `gap_open`            | la apertura de la vela si abrió más allá del stop; si no, el nivel. Sin apertura en la vela: la cota pesimista | `ohlc_open_gap`, `ohlc_stop_level`, `ohlc_worst_bound_open_unavailable` |
| `gap_worst`           | el extremo de la vela (mínimo para un LONG, máximo para un SHORT)                                              | `ohlc_worst_bound`                                                      |
| cotización            | el peor de tres: modelo de costes sobre el mid, el touch visible (bid/ask) y la salida planificada del stop    | `quote_breach` (respaldado por cotización)                              |

Después se aplica siempre el coste del modelo (impacto y spread completo de un stop, `futures_costs.exit_fill`) y las comisiones. **Nunca** se mejora el precio para respetar el presupuesto: el validador `exit_not_better_than_plan` falla si una salida de stop es mejor que la planificada, y la pérdida completa entra en el capital. `trade["stop_exit"]` (solo con la opción activa) guarda `stop_level`, `reference_price`, `executable_price`, `gap_bps`, `slippage_bps`, `evidence`, `quote_backed` y `estimated`. Con solo velas **no hay precio demostrado**: todo lo que sale de OHLC se marca `estimated`, y solo una cotización posterior a la entrada lo respalda.

## Vigilancia durante el minuto de entrada

`QuoteWatch` recibe las cotizaciones y las velas de una `Portfolio`:

- Solo se usan cotizaciones con `time_ms` **estrictamente posterior** a la entrada real (`entry_ms`); la cotización que llenó la orden no sirve para el stop.
- Una cotización se procesa una vez: `time_ms` debe crecer por producto (duplicadas y antiguas se ignoran y se anotan) y una cotización de un minuto cuya vela ya se procesó se ignora (`covered_by_candle`).
- El stop se considera cruzado cuando el lado ejecutable (bid para LONG, ask para SHORT) llega al stop. El cierre ocurre una vez y pasa por `Book`/`Portfolio` (mismas comisiones, funding y contabilidad); la hora de salida es la de recepción de la cotización.
- La vela del minuto de entrada **no evalúa el stop** (contiene precios anteriores a la entrada). Solo sirve para decir si su rango tocó el stop. Si lo tocó y las cotizaciones no cubrieron la ventana (`unwatched`, o `partially_watched` si hubo huecos de más de `max_watch_gap_ms` = 10 s), el resultado queda marcado `entry_minute_unresolved` (política `flag`, por defecto) o la posición se cierra en el stop con evidencia `assumed_stop_entry_minute`, siempre `estimated` (política `stop`).
- Una posición cerrada por una cotización ya no existe: la vela posterior no la cierra otra vez.

Los eventos deben llegar en orden de tiempo; no se reordena nada. Una cotización de un minuto ya cubierto por una vela no se «recupera»: si la vela del minuto de entrada tocó el stop, la marca de incertidumbre ya lo dice.

## Pérdida mayor que la planificada y suspensiones

La pérdida planificada es una cifra del modelo, no una cota. Con un gap la pérdida real puede ser mayor (en el escenario `s06`: 10,00 planificada, 14,99 realizada) y se contabiliza entera: reduce el capital definitivo, el presupuesto de las operaciones siguientes (1 % del capital nuevo), el riesgo diario disponible y alimenta el drawdown. Las suspensiones (pérdida diaria 20 USD por día UTC, drawdown 60 USD, sin cambios) impiden **nuevas entradas** y nada más: cierres (por vela, por cotización), contabilización y conciliaciones siguen funcionando. Como antes, la suspensión por drawdown se calcula sobre el máximo histórico y no se levanta sola.

## Conciliación de funding tardío

`ingest_funding(portfolio, producto, periodos, received_ms)` decide cada periodo `(inicio, fin, tasa por hora)`:

| Resultado   | Cuándo                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`  | bien formado, ya liquidado (`fin <= received_ms`) y sin contradicción; llega también a las posiciones abiertas                                                                                                     |
| `duplicate` | idéntico a uno aceptado (también dentro de un mismo lote): no cambia nada                                                                                                                                          |
| `conflict`  | se solapa con otra versión (aceptada, en cuarentena o del mismo lote): **se pone en cuarentena y no se usa**, y las operaciones afectadas se marcan `funding_conflict`. El resultado no depende del orden del lote |
| `rejected`  | malformado o todavía no liquidado                                                                                                                                                                                  |

`reconcile_funding(portfolio, now_ms)` recorre las operaciones cerradas con funding incompleto y **recalcula** su funding desde los periodos aceptados (nunca acumula, así que no puede aplicarse dos veces). Solo actúa si el tiempo cubierto creció. Cada cambio es un `adjustment` encadenado por hash con el estado antes y después, la cobertura (`partial`/`complete`), la transición (`provisional_more_covered`, `provisional_to_definitive`), capital, presupuesto de riesgo y drawdown antes y después, el hash de los periodos usados y las decisiones tomadas entre el cierre y la conciliación (`decisions_not_revised`: no se revisan, solo se listan). La regla anterior se conserva: una ganancia provisional nunca aumenta el capital disponible; una pérdida provisional siempre lo reduce.

Decisión aprobada por Fran (2026-10-13): el efecto de una conciliación se anota en el día UTC y en el punto del drawdown **en que se conoce**, no se reescribe el pasado. Por eso la pérdida diaria y el drawdown no cambian retroactivamente por un dato tardío, y una conciliación que profundiza una pérdida puede activar una suspensión hacia adelante. `OfflineExecutor` (#122) recalcula el drawdown desde las operaciones por su día de salida; si algún día se usan conciliaciones con ese ejecutor, esa comprobación deberá leer el `capital_log`.

## Capital utilizable: tres dimensiones independientes

El resultado simulado de una operación (`pnl_usd`, precio de salida, cierre) nunca se altera por incertidumbre. Lo que cambia es la parte considerada fiable para nuevas decisiones (`Portfolio.contribution`). Una ganancia solo aumenta el capital definitivo si cumple **las tres** condiciones, independientes entre sí (`Portfolio.reliable`); una pérdida siempre se contabiliza entera:

| Dimensión            | Dónde se ve                                                           | Cuándo retiene la ganancia                                                                                                      |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cobertura de funding | `net_complete`                                                        | el funding aceptado no cubre toda la tenencia                                                                                   |
| Ejecución            | `execution_unresolved` (solo con `QuoteWatch`)                        | el rango del minuto de entrada tocó el stop y ninguna cotización cubrió la ventana                                              |
| Disputa de funding   | `funding_disputes` (trade_id → periodos en cuarentena que se solapan) | un periodo contradictorio en cuarentena se solapa con la tenencia; mientras exista, nada lo resuelve (no hay política aprobada) |

Completar una dimensión no libera las otras: una conciliación que pasa a `provisional_to_definitive` no mueve el capital si la ejecución sigue sin resolver o el funding sigue disputado.

**Disputa antes del cierre (A).** Una posición con funding aceptado que cubre toda su tenencia recibe un periodo contradictorio; queda en cuarentena. Al cerrar con ganancia, `Portfolio` compara la tenencia con la cuarentena y la operación nace disputada: el resultado simulado queda intacto y aporta 0 al capital.

**Disputa después del cierre (B).** La ganancia ya entró al capital. Al llegar la contradicción, `Portfolio.dispute_funding` anota en el momento en que se conoce un evento `funding_dispute_reclassified` en el `capital_log` y un registro encadenado en `reclassifications` (resultado simulado, aporte antes y después, capital, presupuesto de riesgo y drawdown antes y después, decisiones posteriores no revisadas). No se reescribe el cierre ni `as_closed`, ni los periodos aceptados, ni las decisiones; el eventual drawdown se registra en el punto en que se conoce (misma regla de las conciliaciones). Es idempotente: repetir la entrega o la conciliación, o reiniciar desde un checkpoint, no crea otra reclasificación; un segundo periodo disputado del mismo trade se lista sin reclasificar de nuevo. Una pérdida disputada se anota (reclasificación con delta 0, sin evento de capital). Ni una suspensión ni nada del estado de la cuenta bloquean la disputa.

La auditoría compara con los periodos en cuarentena, no solo con las marcas: `funding_dispute_omitted` (periodo en cuarentena solapado sin disputa registrada), `funding_dispute_mismatch`, `disputed_gain_counted`, `reclassification_chain` y `reclassification_without_capital_event`; avisos `funding_disputed` y `economically_unresolved_execution` listan los resultados económicamente no resueltos.

## Contabilidad verificable

`trade_reconstruction(portfolio, trade)` reconstruye por operación: precio y momento de entrada (y su referencia y coste), stop y objetivo originales, precio y momento de salida, motivo, base del precio de salida (`quote_backed`, `estimated_from_candles`, `estimated_assumed_stop`, `modelled_at_stop_level`), pérdida planificada y realizada, bruto, comisiones, funding con estado y cobertura, spread e impacto modelados, neto, capital antes y después, los cambios posteriores por conciliación y las marcas de revisión. `planned_vs_realized` descompone `realizada − planificada = efecto precio + efecto comisiones + funding`.

`audit(portfolio)` recalcula sin fiarse de las sumas del portafolio: identidad `bruto − comisiones − funding = P&L`, comisiones cobradas una vez, precio de entrada del modelo, salida de stop nunca mejor que la planificada, descomposición de la pérdida, campos de `stop_exit`, capital definitivo = inicial + resultados verificados + pérdidas provisionales (y = inicial + suma del `capital_log`), continuidad y hash del log, suma de eventos por operación, ganancias provisionales fuera del capital, cadena de ajustes, transición explícita a definitivo, funding recalculado desde los periodos, presupuesto de riesgo y suspensiones en cada decisión abierta, y cadena del registro de funding. Las pruebas introducen a propósito 26 errores contables y comprueban que salta la regla correspondiente.

## Cómo ejecutar

```
PYTHONPATH=python python3 -m unittest python/tests/test_portfolio_stage7.py
PYTHONPATH=python python3 -m unittest discover -s python/tests
```

El informe y `resultados.json` no llevan fecha ni nada del entorno; una prueba los regenera y exige que coincidan con lo versionado, y otra comprueba los mismos hashes con distintas semillas de hash de Python.

## Limitaciones declaradas

- Todo es sintético. Que `gap_open` o `gap_worst` reflejen lo que habría pasado en Kraken **no está medido**: son estimaciones desde velas. Los 10 s de hueco máximo, la política `flag`/`stop` y el coste del modelo en un gap son hipótesis iniciales, no valores medidos ni aprobados.
- El stop se ejecuta en la primera cotización que lo cruza, sin latencia propia ni profundidad de libro; el objetivo y el stop por tiempo siguen dependiendo de velas. Entre una cotización que no cruza y la vela siguiente puede haber un cruce no observado.
- Los eventos deben llegar en orden. Una cotización tardía de un minuto ya cubierto se ignora (no se reordena).
- Una versión contradictoria del funding se pone en cuarentena para siempre: no hay aún un procedimiento aprobado para que una persona la resuelva, y mientras tanto las ganancias afectadas siguen retenidas (igual que las de ejecución sin resolver: tampoco hay mecanismo para resolverlas después). Retener es una política conservadora de esta etapa, no una medición.
- El día UTC de una conciliación es el del conocimiento del dato (ver arriba). Las posiciones abiertas reciben el funding aceptado antes de cerrar, pero no se re-dimensionan.
- Los checkpoints de prueba usan `pickle` como el resto del prototipo; no es persistencia de producción.
- Sigue valiendo que un `Portfolio` con producto sin fila de costes medida nunca llega a resultado definitivo.

## Para conectarlo al forward (nada de esto está hecho)

1. Fuente real de cotizaciones posteriores a la entrada y medición de su retraso (ya listado en `ejecucion-temporal.md`).
2. Elegir y aprobar la política de stop (`gap_open` o `gap_worst`) y de ventana no resuelta (`flag` o `stop`) con datos medidos; hoy el valor por defecto sigue siendo el comportamiento anterior.
3. Persistir `capital_log`, `adjustments` y `funding_log` con la durabilidad del registro de señales, y decidir su relación con `forward_trade_funding` y con la conciliación de Kronos.
4. Procedimiento humano para resolver periodos de funding en cuarentena.
5. La enmienda del ADR (dimensionamiento dinámico) sigue pendiente de aprobación de Fran; las decisiones de esta etapa (política de stop con gaps, regla de suspensión sin cambios, conciliación de funding) deberían incorporarse a esa enmienda. Este cambio no edita el ADR vigente.
