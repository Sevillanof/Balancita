# Cartera paper compartida de 1.000 USD con tamaño dinámico (prototipo aislado)

Estado: `python/balancita_engine/portfolio.py`, pruebas en `python/tests/test_portfolio.py`. **No está conectado al forward, a `capture`, a Kronos ni a ninguna base.** C29-C32 siguen con sus reglas y libros independientes. El ADR 0001 sigue intacto: la propuesta para permitir tamaños dinámicos está en [`docs/adr/propuesta-enmienda-dimensionamiento-dinamico.md`](adr/propuesta-enmienda-dimensionamiento-dinamico.md) y necesita la aprobación de Fran antes de conectar nada. Solo paper.

## Tres cifras distintas

| Concepto            | Qué es                                     | Ejemplo                  |
| ------------------- | ------------------------------------------ | ------------------------ |
| Capital             | Cuenta paper                               | 1.000 USD                |
| Nocional            | Exposición de la posición                  | 475,88 USD               |
| Pérdida planificada | Lo que cuesta ejecutar el stop, con costes | 10 USD (1 % del capital) |

## Qué reutiliza (sin segundo motor)

- **`Book` de `futures_simulator`**: cada posición es un `Book` con su nocional. Entrada con impacto por producto, comisión taker, funding, stop/objetivo/tiempo y P&L realizado/no realizado.
- **`futures_costs`**: `entry_fill`, `exit_fill` (motivo `stop`), `fee_rate`, `round_trip_rate`, `is_measured`.
- **`multi_risk.RiskPolicy.levels`**: `intent_from_signal` calcula el stop (2 ATR) y el objetivo (1,5 × stop) con las reglas existentes. Una intención también puede traer sus propios niveles.
- Lo único nuevo es la gestión del capital y del presupuesto de riesgo.

## Fórmulas

```
presupuesto_riesgo = riesgo_por_operación × capital_definitivo                 (1 %)
pérdida_por_USD    = (entrada − salida_stop)/entrada + comisión × (entrada + salida_stop)/entrada      [LONG; espejo en SHORT]
                     entrada = entry_fill(precio), salida_stop = exit_fill(stop, "stop") ± slippage_buffer
nocional           = presupuesto_riesgo / pérdida_por_USD
```

Después el nocional **solo se reduce** (nunca sube) por cada límite, y se redondea hacia abajo a centavos para que la pérdida planificada no pase del presupuesto:

| Límite                    | Valor inicial                                         | Qué recorta                                                                                                  |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Exposición bruta          | 100 % del capital definitivo (1x)                     | suma de nocionales abiertos                                                                                  |
| Exposición por producto   | 50 %                                                  | nocional de una posición                                                                                     |
| Exposición neta           | 100 %                                                 | \|largos − cortos\| (no vinculante con 1x; queda configurable)                                               |
| Margen disponible         | capital definitivo − reservado, × apalancamiento (1x) | nocional                                                                                                     |
| Riesgo agregado abierto   | **2 % del capital**                                   | suma de pérdidas planificadas de las posiciones abiertas                                                     |
| Posiciones abiertas       | 8                                                     | cantidad                                                                                                     |
| Nocional mínimo           | 10 USD                                                | por debajo se rechaza, no se redondea hacia arriba                                                           |
| Pérdida diaria / drawdown | 20 USD / 60 USD                                       | suspende nuevas entradas; además la pérdida diaria **descuenta** del riesgo que se puede agregar (ver abajo) |

**Regla del 30 %.** Si `pérdida_por_USD` supera 0,30 se rechaza (`stop_loss_exceeds_notional_limit`). No se aleja el stop ni se achica el stop para que "entre". El 30 % es un techo sobre la pérdida planificada respecto al nocional; no es la distancia del stop ni el capital en riesgo (eso es el 1 %).

**Por qué 2 % de riesgo agregado.** Es una hipótesis, no un valor optimizado ni calibrado con histórico ni con el holdout: iguala la pérdida diaria máxima de 20 USD, de modo que si todos los stops abiertos se ejecutan juntos el golpe es del orden del límite diario. Importa porque los perpetuos grandes se mueven juntos (en el reporte de cartera XBT/ETH/SOL/XRP/ADA correlacionan 0,76-0,90), así que dos posiciones de 1 % no son dos apuestas independientes. Con 1 % por operación equivale a unas dos posiciones con riesgo pleno a la vez; es el límite que más restringe y el primero a revisar. Si el 1 % o el 2 % resultan demasiado cortos o demasiado holgados se cambian en `PortfolioPolicy` sin tocar el motor.

El tamaño **no depende de la fuerza de la señal** (los puntajes no son probabilidades calibradas). La fuerza solo desempata: elige la señal más fuerte cuando hay varias del mismo lado en un producto y fija el orden de reparto cuando compiten por capital. Es un supuesto modificable.

**Pérdida diaria y riesgo abierto están coordinados.** El riesgo planificado que admite una entrada nueva es `límite_diario − pérdidas_realizadas_hoy − riesgo_planificado_de_las_posiciones_abiertas` (límite `daily_loss_budget`, además del 2 % agregado). Con 15 USD perdidos en la mañana quedan ~5 USD para posiciones nuevas, no 20 (prueba `test_realized_losses_of_the_day_reduce_the_risk_that_can_be_added`); con una posición abierta de 15 USD de riesgo, la siguiente recibe ~5 USD. Al llegar al límite sigue suspendiendo (`suspended_daily_loss`). Para las pérdidas diarias y el drawdown solo cuentan las ganancias verificadas: una ganancia con funding incompleto no compensa pérdidas del día. Sigue siendo una regla de admisión: no limita la pérdida real si un stop se ejecuta peor que el modelo.

## Ejemplos numéricos (política inicial, XBT/ETH/ADA, entrada a 100)

| Caso      | Stop  | Pérdida por USD de nocional | Nocional por riesgo | Nocional final | Pérdida planificada | Límite aplicado |
| --------- | ----- | --------------------------- | ------------------- | -------------- | ------------------- | --------------- |
| XBT LONG  | 0,5 % | 0,60 %                      | 1.660,75            | 500,00         | 3,01                | producto (50 %) |
| XBT LONG  | 1 %   | 1,10 %                      | 907,54              | 500,00         | 5,51                | producto (50 %) |
| XBT LONG  | 2 %   | 2,10 %                      | 475,88              | 475,88         | 10,00               | ninguno         |
| ETH SHORT | 3 %   | 3,11 %                      | 321,61              | 321,61         | 10,00               | ninguno         |
| ADA LONG  | 3 %   | 3,18 %                      | 314,24              | 314,24         | 10,00               | ninguno         |
| XBT LONG  | 10 %  | 10,10 %                     | 99,04               | 99,03          | 10,00               | ninguno         |
| XBT LONG  | 25 %  | 25,09 %                     | 39,86               | 39,85          | 10,00               | ninguno         |
| XBT LONG  | 32 %  | 32,09 %                     | —                   | rechazada      | —                   | regla del 30 %  |

Un stop más lejano da una posición más chica con el mismo riesgo; un stop muy cercano queda limitado por la exposición y arriesga menos que el presupuesto. Con la política inicial dos posiciones de ~475 USD llenan el 2 % de riesgo agregado: la tercera se recorta o se rechaza (`open_risk_limit`).

## Capital definitivo y provisional

- **Definitivo** = inicial + neto de las operaciones con funding completo + pérdidas de las operaciones con funding incompleto. Es lo único que fija el presupuesto de riesgo, el margen y los topes en %.
- **Provisional**: la ganancia de una operación con funding incompleto se informa (`provisional_gains_usd`) pero no suma capital ni presupuesto. Una pérdida con funding incompleto sí resta (conservador).
- Una operación con funding sin verificar queda `net_complete: false`, `net_usd: null` y el resultado parcial aparte (`partial_usd`). Su rentabilidad definitiva sigue desconocida.
- La pérdida diaria y el drawdown miden todo lo realizado (parcial incluido), también conservador.

## Resolución y orden

1. Una `intent_id` que ya abrió una posición nunca abre otra, ni dentro del mismo lote ni después de cerrada (`duplicate_intent`).
2. **Validación primero, intención por intención:** inválida o fuera de rango, retroactiva, con datos del futuro, obsoleta, producto sin costes, niveles inválidos, objetivo que no cubre costes, regla del 30 %, posición abierta, suspensión por pérdida diaria o drawdown. Todas las razones quedan listadas. Una señal rechazada no participa en lo que sigue, así que una señal obsoleta no bloquea una válida.
3. Entre las válidas: mismo producto y lado, gana la más fuerte (`duplicate_same_side`); lados opuestos, ninguna (`contradictory_signals`).
4. Las que quedan se reparten una a una (fuerza, producto, id) contra el capital y el riesgo que dejó la anterior.

**Orden temporal.** No se acepta una decisión anterior a la última (`retroactive_decision`), una intención de una vela anterior a la última procesada del producto (`retroactive_intent`), ni datos que cierran después de `now` (`future_data`). `on_candle` exige una vela estrictamente más nueva que la última usada del producto (`PortfolioError` si no): una posición nunca ve la vela en la que entró ni una vela dos veces. Orden por minuto: primero `on_candle` de todos los productos (liberan capital), después `decide`.

## Registro por intención

Cada intención deja un registro: `status` (`opened`/`rejected`), `reasons`, `notional_usd`, `limits_applied`, `risk_budget_used_usd`, `risk_notional_usd` (antes de los límites), `loss_fraction`, `planned_loss_usd`, `planned_loss_pct_of_capital`, `open_risk_before_usd`/`after`, capital definitivo y disponible. Los rechazos que alcanzaron a calcular el stop incluyen `loss_fraction`. `ledger_hash()` da el mismo hash con las mismas velas e intenciones.

## Identidad de señales

Una misma `signal_id` no puede abrir dos posiciones aunque llegue en una intención nueva con otro precio o ATR (el `intent_id` cambia, el `signal_id` no): `duplicate_signal`, con la posición abierta o ya cerrada, y dentro del mismo lote (queda una sola). Una copia inválida (por ejemplo obsoleta) no consume la señal.

**Versiones contradictorias de una misma señal.** Si dos intenciones válidas comparten `signal_id` pero difieren en producto, dirección, vela, precio, stop, objetivo u horizonte (por ejemplo otro ATR), se rechazan **todas** con `inconsistent_signal`: nada en el sistema dice cuál versión es la correcta y el hash del `intent_id` no debe decidirlo. El resultado no depende del orden de entrada y la señal no se consume, así que una versión única y limpia puede abrir después. Si coinciden en esos campos y solo difieren en metadatos (por ejemplo `data_close_ms`), es la misma propuesta vista dos veces: se conserva la observación más temprana y la otra queda `duplicate_signal`.

## Momento y precio de ejecución (pendiente para integrar)

> Resuelto en forma de prototipo aislado en [`ejecucion-temporal.md`](ejecucion-temporal.md) (`execution_timing.py`): señal persistida → decisión → primer precio ejecutable posterior → entrada, con el stop original. `Portfolio.decide` solo sigue abriendo al precio de referencia cuando se usa directamente, sin ese módulo.

El prototipo **abre al precio de referencia de la intención** (cierre de la vela de la señal) más el impacto del modelo de costes. Eso es válido para un prototipo determinista, pero una integración con datos reales deberá distinguir tres cosas que hoy se confunden: el precio conocido al generar la señal, el momento en que la señal está disponible y el **primer precio ejecutable posterior**. Si el precio se mueve entre la señal y la ejecución, cambia la pérdida real hasta el stop y el tamaño calculado. No es un bloqueo para este PR aislado; sí lo es para conectarlo al forward, que no se toca.

## Slippage

`slippage_buffer_bps` es configurable y vale **0 por defecto, una hipótesis optimista**: supone que el stop se ejecuta exactamente al precio del modelo de costes. Un buffer mayor achica la posición para que la pérdida planificada siga siendo el 1 % aunque el stop se ejecute peor. Las pruebas de sensibilidad (`SlippageSensitivity`) recorren buffers de 0, 5, 10, 25 y 50 pb con deslizamientos reales simulados: con buffer igual al deslizamiento real la pérdida queda en el 1 %; con buffer menor lo excede aproximadamente por la diferencia. Los valores de las pruebas son ilustrativos; no se eligió ninguno con datos históricos ni con el holdout. Cuál usar queda pendiente de medir el deslizamiento real de los stops con el libro (modelo de costes maker/taker).

## Qué NO garantiza

- La pérdida planificada es un cálculo con el modelo de costes. **No es un tope de pérdida real**: no incluye funding futuro, huecos de precio ni slippage mayor que el modelo. `slippage_buffer_bps` (0 por defecto) permite asumir un deslizamiento extra al dimensionar; una prueba muestra que con un deslizamiento real de 30 pb por encima del modelo la pérdida supera lo planificado, y que con un buffer de 30 pb no.
- Una posición por producto, sin pirámide ni inversión.
- Los parámetros son hipótesis iniciales, no resultados. No se usó ningún dato histórico ni el holdout para elegirlos.

## Uso (sin conexión a nada)

```python
p = Portfolio(PortfolioPolicy(), funding={"PF_XBTUSD": [(inicio_ms, fin_ms, "0.0001")]})
p.on_candle("PF_XBTUSD", bucket_ms, {"high": ..., "low": ..., "close": ...})   # primero las salidas
p.decide([intent_from_signal(signal, price=..., atr=...)], now_ms)             # luego las entradas
p.snapshot()
```

## Validación integral offline

`python/balancita_engine/portfolio_offline.py` ejecuta esta cartera con velas y señales sintéticas, un diario encadenado por hash, comprobaciones independientes de límites y contabilidad, y un reinicio desde un checkpoint persistido. Diseño, límites y capacidades de recuperación (existentes y faltantes): [`validacion-cartera-offline.md`](validacion-cartera-offline.md). Resultados: `analisis/validacion-cartera-offline/informe.md`.

## Saldo simulado publicado (#185, BAL-DECISION-185-CARTERA-SIMULADA-01)

El bloque de posiciones de la sesión lleva `account` (clase `simulated`), copiado de `Portfolio.snapshot()` sin recalcular: `total_simulated_usd` (1000 más todo lo realizado, neto de todos los costes), `definitive_usd` (igual, sin las ganancias aún provisionales; es el que dimensiona y limita), `committed_usd` (margen de las posiciones abiertas; las órdenes pendientes no reservan: tamaño y admisión se deciden al llenarse, BAL-DECISION-185-CARTERA-SIMULADA-02; se cuentan aparte en `pending_orders` con `pending_reservation: none`) y `free_usd` (`definitive_usd − committed_usd`). No cambia el dimensionado, el apalancamiento ni ningún saldo existente.
