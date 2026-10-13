# Ejecución paper temporalmente correcta (offline, aislada)

Estado: `python/balancita_engine/execution_timing.py`, pruebas en `python/tests/test_execution_timing.py` (34 pruebas, datos sintéticos). **No está conectada al forward, a `capture`, a Kronos, a Qwen ni a ninguna base.** No toca C29-C32, ni los parámetros de riesgo aprobados (`PortfolioPolicy`), ni el holdout, ni el ADR 0001. Sin red, sin reloj de pared (todo tiempo entra como argumento), sin aleatoriedad. Solo paper.

## Problema

La cartera (`portfolio.py`) abría al **precio de referencia de la intención**: el cierre de la vela con la que se calculó la señal. Ese precio se conoce al generar la señal, pero nada se puede comprar a ese precio después. Si el precio se mueve entre la señal y la ejecución, cambian el precio de entrada, el tamaño y la pérdida real hasta el stop.

## Secuencia

```
vela cerrada → señal generada → señal persistida → decisión → primer precio ejecutable posterior → entrada paper
 candle_close   generated_ms     persisted_ms      decided_ms   earliest_fill ≤ cotización       entry_ms
```

`TimedExecutor` (reutiliza `Portfolio`, `Book`, `futures_costs` y `SignalLog.guard_entry`; no es un segundo motor):

| Paso                                                             | Qué hace                                                                                                                                                                                                                                            | Si falla                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit(entrada_del_registro, reference_price, atr, decided_ms)` | exige una entrada del `SignalLog` original y vigente (`guard_entry`), con `cierre ≤ generada ≤ persistida ≤ decisión` y reloj sin retroceso. Fija **una vez** stop y objetivo con las reglas de `multi_risk` desde el precio de referencia y el ATR | rechazo con motivo: `reconstructed_signal`, `signal_expired`, `candle_not_closed`, `generated_*`, `persisted_before_generated`, `decision_before_persistence`, `time_went_backwards`, `levels_unavailable` |
| `on_quote(cotización)`                                           | la orden decidida en D solo puede llenarse con una cotización **observada** desde `D + latency_ms` y **recibida** a más tardar en `D + max_execution_delay_ms`. Se usa la **primera utilizable**; una posterior mejor no se elige después           | las no utilizables se descartan y se cuentan: `before_latency`, `stale_quote`, `wide_spread`, `invalid_quote` (mal formada o cruzada), `out_of_order_quote`                                                |
| comprobaciones de precio                                         | con el precio ejecutable frente al stop y objetivo **originales**                                                                                                                                                                                   | `executable_price_beyond_stop`, `adverse_move_consumed_stop_distance`, `executable_price_beyond_target`, `favorable_move_consumed_target_distance`                                                         |
| `Portfolio.decide`                                               | dimensiona con su regla de siempre (presupuesto de riesgo / pérdida planificada por USD), pero con el precio ejecutable y el stop original; aplica todos los límites                                                                                | motivos del portafolio, sin cambios                                                                                                                                                                        |
| `advance(ahora)`                                                 | cierra órdenes cuya ventana venció sin cotización                                                                                                                                                                                                   | `no_quote_in_window` (no llegó ninguna) o `no_valid_quote_in_window` (llegaron, ninguna utilizable)                                                                                                        |

Reglas que no se negocian:

- **El precio de referencia nunca sustituye a un precio ejecutable.** Sin cotización válida la señal se rechaza.
- **El stop no se mueve.** La pérdida planificada se recalcula contra el stop original desde el precio ejecutable: más cerca del stop da un nominal mayor (sigue acotado por todos los límites de la cartera); más lejos, uno menor. La pérdida planificada sigue siendo el presupuesto de riesgo. Una prueba lo comprueba hasta el stop ejecutado: la pérdida realizada coincide con la planificada.
- Si el movimiento adverso ya consumió más de `max_stop_distance_consumed` (0,5) de la distancia al stop original, se rechaza: el modelo de tamaño saldría de límites razonables (un stop casi encima daría un nominal enorme) y la señal ya perdió su sentido. Lo mismo, simétrico, para el movimiento favorable (`max_target_distance_consumed`, 0,5): no se persigue el precio.
- Precio pagado: `entry_fill` del modelo de costes sobre el **mid** de la cotización, pero **nunca mejor que el touch visible** (ask en LONG, bid en SHORT). El impacto del modelo ya incluye medio spread, por eso el touch solo se usa cuando es peor que el modelo.
- Una misma cotización que llena varias órdenes del mismo producto las decide en un solo lote del portafolio (se aplican `contradictory_signals`, `duplicate_same_side`, etc.).
- Idempotencia: la misma entrada enviada dos veces no abre nada (`duplicate`), además de las protecciones de `Portfolio` (`intent_id`, `signal_id`).

Cada orden deja **un registro terminal** (`records`) con la línea de tiempo completa, la cotización usada, precio de referencia y ejecutable, el movimiento adverso en pb, la distancia al stop/objetivo consumida, `loss_fraction` y nominal con el precio ejecutable y con el de referencia, y `stop_unchanged`. `ledger_hash()` es determinista.

### Cambio en `portfolio.py`

Una intención puede traer `entry_bucket_ms` (opcional; sin él, todo igual que antes: las 941 pruebas de Python pasan). Es el minuto en que se abre la posición cuando la entrada es posterior a la vela de la señal; `Portfolio` también rechaza (`retroactive_intent`) una entrada en un minuto anterior al último procesado del producto.

### Convenciones de tiempo

- En el registro durable, `signal.bucket_ms` = **cierre** de la vela (`cycle_ms`). Las intenciones de `Portfolio` usan el **inicio** de la última vela de 1 min. `submit` convierte (`inicio = cierre − 60 s`).
- `entry_ms` es el instante de recepción de la cotización. El `Book` trabaja con velas de 1 min: la posición se abre en el primer límite de minuto ≥ `entry_ms` (`opened_at_ms`) y **no ve la vela del minuto de entrada**.

## Qué se validó (datos sintéticos)

Latencia (0 / 1 / 10 s dan precios de entrada distintos y ordenados; cotización anterior a la latencia no se usa); movimientos adversos y favorables en LONG y SHORT (rechazo por distancia consumida, por stop o por objetivo atravesado; el límite es política, no constante); cotizaciones ausentes (ninguna, de otro producto, solo viejas, anchas, cruzadas, basura o fuera de orden; una cotización posterior al plazo no llena); cambio de precio entre señal y ejecución (se usa la primera utilizable, una posterior distinta no cambia nada); tamaño recalculado desde el precio ejecutable con el stop original sin tocar (más lejos → menor nominal, más cerca → mayor, y con la política aprobada el límite por producto sigue mandando); pérdida realizada al tocar el stop igual a la planificada; causalidad (reconstruida, vencida, vela sin cerrar, decisión antes de persistir, cotización previa a la decisión, eventos hacia atrás); idempotencia; lote de órdenes contradictorias; determinismo; y que el módulo no importa nada de la pila viva.

```
PYTHONPATH=python python3 -m unittest python/tests/test_execution_timing.py
```

## Límites declarados

- Las cotizaciones y la latencia son sintéticas. Que `latency_ms` (1 s), el plazo (60 s), la edad máxima (5 s), el spread máximo (30 pb) y las dos fracciones (0,5) sean razonables **no está medido**: son hipótesis iniciales, no valores optimizados ni aprobados. No son parámetros de riesgo aprobados.
- Ventana sin vigilar: entre `entry_ms` y el siguiente minuto (hasta 59,999 s; cero si la entrada cae en límite de minuto) el stop no se evalúa, porque el `Book` solo ve velas cerradas. Una versión conectada debería vigilar con las cotizaciones de ese tramo.
- El stop sale siempre al precio del stop con el impacto del modelo (sin huecos de precio), como antes.
- Las órdenes de productos distintos se deciden con cada cotización, no en un lote global: se pierde la prioridad por fuerza entre productos que tenía un lote simultáneo. Es lo realista, pero cambia la asignación de capital frente al prototipo.
- Una cotización que llega fuera de orden de tiempo de recepción se ignora; no hay reordenamiento.

## Qué falta para conectarlo al forward (nada de esto está hecho)

1. Fuente real de cotizaciones: el archivador de bid/ask (`quotes:archive`) retiene bid/ask hacia adelante; hace falta un lector solo-lectura con `time_ms` de Kraken y `received_ms` propio, y medir el retraso real entre ambos.
2. Medir latencia y deslizamiento reales con esos datos antes de fijar `ExecutionPolicy`; hoy los números son hipótesis.
3. Alimentar `submit` con el `SignalLog` del forward (hoy es un prototipo aislado) y con el ATR de la instantánea de ese ciclo; decidir qué reloj es `decided_ms`.
4. Vigilar el stop durante el minuto de entrada (ver límites).
5. Persistir `records` y el estado de órdenes pendientes con el mismo criterio de durabilidad del registro de señales (hoy es memoria).
6. Decidir cómo se miden C29-C32 (libros independientes, sin mezclar) frente a la cartera, y la aprobación de parámetros.
7. La enmienda de dimensionamiento dinámico sigue **pendiente de aprobación de Fran**.

## ADR

Este cambio no necesita una enmienda propia: la propuesta pendiente ([`adr/propuesta-enmienda-dimensionamiento-dinamico.md`](adr/propuesta-enmienda-dimensionamiento-dinamico.md)) ya lista «definir el primer precio ejecutable posterior a la señal» como decisión de Fran. Si lo aprueba, conviene añadir a esa propuesta una línea que remita a este documento; el ADR vigente no se toca.
