# Cartera paper compartida de 1.000 USD con tamaño dinámico (prototipo aislado)

Estado: `python/balancita_engine/portfolio.py`, pruebas en `python/tests/test_portfolio.py`. **No está conectado al forward, a `capture`, a Kronos ni a ninguna base.** C29-C32 siguen con sus reglas y libros independientes. El ADR 0001 sigue intacto: la propuesta para permitir tamaños dinámicos está en [`docs/adr/propuesta-enmienda-dimensionamiento-dinamico.md`](adr/propuesta-enmienda-dimensionamiento-dinamico.md) y necesita la aprobación de Fran antes de conectar nada. Solo paper.

## Tres cifras distintas
| Concepto | Qué es | Ejemplo |
|---|---|---|
| Capital | Cuenta paper | 1.000 USD |
| Nocional | Exposición de la posición | 475,88 USD |
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

| Límite | Valor inicial | Qué recorta |
|---|---|---|
| Exposición bruta | 100 % del capital definitivo (1x) | suma de nocionales abiertos |
| Exposición por producto | 50 % | nocional de una posición |
| Exposición neta | 100 % | \|largos − cortos\| (no vinculante con 1x; queda configurable) |
| Margen disponible | capital definitivo − reservado, × apalancamiento (1x) | nocional |
| Riesgo agregado abierto | **2 % del capital** | suma de pérdidas planificadas de las posiciones abiertas |
| Posiciones abiertas | 8 | cantidad |
| Nocional mínimo | 10 USD | por debajo se rechaza, no se redondea hacia arriba |
| Pérdida diaria / drawdown | 20 USD / 60 USD | suspende nuevas entradas |

**Regla del 30 %.** Si `pérdida_por_USD` supera 0,30 se rechaza (`stop_loss_exceeds_notional_limit`). No se aleja el stop ni se achica el stop para que "entre". El 30 % es un techo sobre la pérdida planificada respecto al nocional; no es la distancia del stop ni el capital en riesgo (eso es el 1 %).

**Por qué 2 % de riesgo agregado.** Es una hipótesis, no un valor optimizado ni calibrado con histórico ni con el holdout: iguala la pérdida diaria máxima de 20 USD, de modo que si todos los stops abiertos se ejecutan juntos el golpe es del orden del límite diario. Importa porque los perpetuos grandes se mueven juntos (en el reporte de cartera XBT/ETH/SOL/XRP/ADA correlacionan 0,76-0,90), así que dos posiciones de 1 % no son dos apuestas independientes. Con 1 % por operación equivale a unas dos posiciones con riesgo pleno a la vez; es el límite que más restringe y el primero a revisar. Si el 1 % o el 2 % resultan demasiado cortos o demasiado holgados se cambian en `PortfolioPolicy` sin tocar el motor.

El tamaño **no depende de la fuerza de la señal** (los puntajes no son probabilidades calibradas). La fuerza solo desempata: elige la señal más fuerte cuando hay varias del mismo lado en un producto y fija el orden de reparto cuando compiten por capital. Es un supuesto modificable.

## Ejemplos numéricos (política inicial, XBT/ETH/ADA, entrada a 100)
| Caso | Stop | Pérdida por USD de nocional | Nocional por riesgo | Nocional final | Pérdida planificada | Límite aplicado |
|---|---|---|---|---|---|---|
| XBT LONG | 0,5 % | 0,60 % | 1.660,75 | 500,00 | 3,01 | producto (50 %) |
| XBT LONG | 1 % | 1,10 % | 907,54 | 500,00 | 5,51 | producto (50 %) |
| XBT LONG | 2 % | 2,10 % | 475,88 | 475,88 | 10,00 | ninguno |
| ETH SHORT | 3 % | 3,11 % | 321,61 | 321,61 | 10,00 | ninguno |
| ADA LONG | 3 % | 3,18 % | 314,24 | 314,24 | 10,00 | ninguno |
| XBT LONG | 10 % | 10,10 % | 99,04 | 99,03 | 10,00 | ninguno |
| XBT LONG | 25 % | 25,09 % | 39,86 | 39,85 | 10,00 | ninguno |
| XBT LONG | 32 % | 32,09 % | — | rechazada | — | regla del 30 % |

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
