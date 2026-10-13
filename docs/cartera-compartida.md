# Cartera paper compartida de 1.000 USD (prototipo aislado)

Estado: módulo `python/balancita_engine/portfolio.py` con pruebas en `python/tests/test_portfolio.py`. **No está conectado al forward, a `capture`, a Kronos ni a ninguna base.** C29-C32 siguen con sus reglas y sus libros independientes. Conectarlo exige una enmienda del ADR 0001 (hoy fija 100 USD por operación y libros independientes) y revisión de Fran.

## Qué hace
Una cuenta única de 1.000 USD que comparten todas las estrategias. Una *intención* (estrategia, combinador o Qwen) se convierte en posición solo si pasa los límites de capital y riesgo. Cada posición es un `Book` del simulador compartido (`futures_simulator`): mismas entradas con impacto por producto, mismas comisiones taker, mismo funding, mismas salidas (stop, objetivo, tiempo). El módulo solo agrega la gestión del capital; costes salen de `futures_costs`. No hay segundo motor.

## Capital
- `equity` = 1.000 + P&L neto realizado de operaciones cerradas. El no realizado se informa, no se puede gastar.
- `reservado` = suma de nocional / apalancamiento (por defecto 1) de las posiciones abiertas.
- `disponible` = equity − reservado.

## Tamaño por riesgo
`nocional = (equity × 1 %) / pérdida_si_toca_stop`, donde la pérdida incluye la distancia al stop, el coste de ejecutar el stop, el impacto de entrada y las dos comisiones taker. Después se recorta por: tope por posición (**100 USD**, el nocional fijo del ADR: el riesgo solo puede achicar la operación, nunca agrandarla), tope por producto, exposición bruta total (400), exposición neta |largos − cortos| (300) y margen disponible. Por debajo de 10 USD se rechaza, no se redondea hacia arriba. Cada recorte queda anotado en `limits_applied`.

## Señales simultáneas y contradictorias (determinista, no depende del orden de entrada)
1. Mismo producto y mismo lado: gana la más fuerte; las demás se rechazan `duplicate_same_side`.
2. Mismo producto y lados opuestos: se rechazan todas, `contradictory_signals`. No operar no es pérdida; adivinar sí.
3. Las que quedan se ordenan por fuerza, luego producto e id, y se asignan una a una contra el capital que dejó la anterior: un límite rechaza (o recorta) a la más débil.
4. Un producto con posición abierta no admite otra: `position_already_open` / `opposite_position_open` (no hay inversión; la posición sale por stop, objetivo o tiempo).

## Rechazos
Cada intención deja un registro `opened` o `rejected` con **todas** las razones que fallaron: `stale_data`, `cost_data_missing`, `levels_unavailable`, `target_does_not_clear_cost`, `max_open_positions`, `insufficient_margin`, `global_exposure_limit`, `net_exposure_limit`, `product_exposure_limit`, `size_below_minimum`, `suspended_daily_loss`, `suspended_drawdown`.

## Funding y resultados
Funding de la tabla horaria relativa del producto, pagado por largos y cobrado por cortos, en proporción al tiempo mantenido. Funding sin cobertura **no es cero**: la operación queda `net_complete: false`, `net_usd: null` y la cifra parcial aparte (`partial_usd`); el parcial sí mueve el capital (conservador), el neto completo no lo incluye. `snapshot()` separa comisiones, funding, neto completo y parcial. `ledger_hash()` da el mismo hash con las mismas velas e intenciones.

## Uso (sin conexión a nada)
```python
p = Portfolio(PortfolioPolicy(), funding={"PF_XBTUSD": [(inicio_ms, fin_ms, "0.0001")]})
p.decide([make_intent(...), intent_from_signal(signal, price=..., atr=...)], now_ms)  # decide y abre
p.on_candle("PF_XBTUSD", bucket_ms, {"high": ..., "low": ..., "close": ...})            # gestiona salidas
p.snapshot()
```
Orden por vela 1m: primero `on_candle` de todos los productos (liberan capital), después `decide`.

## Límites conocidos
- Una posición por producto; sin pirámide ni inversión.
- Las intenciones traen precio de cierre de la vela; la entrada se simula con el mismo impacto del simulador.
- Los parámetros (1 % de riesgo, 400/300 USD, pérdida diaria 20, caída 60) son valores iniciales, no resultados de una prueba.
