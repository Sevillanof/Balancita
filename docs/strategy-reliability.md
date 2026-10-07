# Fiabilidad medida de las estrategias

Cada estrategia se juzga solo por las operaciones que toma el simulador único (`futures_simulator`: modelo de costes por producto, 100 USD fijos, largo o corto, una posición a la vez) sobre velas oficiales de Kraken Futures. La tabla vive en [`config/strategy-reliability.json`](../config/strategy-reliability.json) y la calcula `python/balancita_engine/futures_strategy_reliability.py`.

## Qué mide

Por estrategia, con todos los productos juntos y por producto: operaciones, aciertos con su intervalo de Wilson al 95 %, ganancia neta media y mediana en bp después de costes, estadístico t con errores agrupados por día de entrada (las operaciones de distintos productos el mismo día comparten el movimiento del mercado), y en cuántos de 4 tramos de tiempo iguales la media es positiva.

| Veredicto           | Significa                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| `insufficient_data` | menos de 30 operaciones                                                   |
| `negative_edge`     | media negativa con t ≤ -1,64: pierde después de costes                    |
| `no_edge`           | media no positiva, o positiva en menos de 3 de 4 tramos                   |
| `candidate_edge`    | media positiva en al menos 3 de 4 tramos, pero t < 1,64: puede ser suerte |
| `tentative_edge`    | además t ≥ 1,64                                                           |
| `reliable_edge`     | t ≥ 2,58, 4 de 4 tramos positivos y al menos 100 operaciones              |

Una entrada está atada al hash del spec con el que se midió: si el spec cambia, deja de contar (`unmeasured`).

## Quién la lee

- **Qwen**: el campo de estado `strategy_reliability` (pregunta `trade_action` v2) le da, por estrategia, veredicto, acierto, bp netos medios y número de operaciones, agregados sobre todos los productos para que su estado siga sin nombrar el producto. La pregunta le dice que ignore `negative_edge` y `no_edge`, pese poco `candidate_edge` y elija `hold` salvo que una estrategia con ventaja medida señale una operación.
- **Registro** (`GET /api-strategies/strategies`): campo `reliability` por estrategia.

## Cómo se refresca

```
python3 scripts/fetch-kraken-charts.py --days 240 --out /tmp/charts
PYTHONPATH=python python3 -m balancita_engine.futures_strategy_reliability --charts-dir /tmp/charts
```

Tarda unos minutos por producto (aritmética Decimal). Hay que rehacerla cuando cambie un spec, el modelo de costes o cada cierto tiempo: es la única forma de ver si una ventaja sigue existiendo.

## C29, la única con señal

C29 sigue movimientos extremos: retorno logarítmico de 6 h (72 velas de 5 m) por encima de 2,5 desviaciones de la volatilidad logarítmica diaria (`logvol288` sobre velas de 5 m), entrada a favor, stop a 2 sigmas diarias, objetivo 1,5 veces el stop o salida a las 24 h. Usa las funciones de log que se añadieron al simulador (`logret<P>`, `logvol<P>`) y el riesgo `risk.vol` / `risk.vol_minutes` del spec. Hoy solo la ejecutan el backtest, el replay y Qwen en replay: los veredictos en vivo trabajan con ventanas de 200 velas y no alcanzan las 24 h de historia de 5 m que necesita.
