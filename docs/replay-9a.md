# Etapa 9A: replay histórico aislado con ejecución modelada

Prueba de integración y reproducibilidad del motor existente contra velas y funding públicos de Kraken. **No es evidencia de rentabilidad independiente**: las velas ya se usaron en investigación previa y toda ejecución es `MODELLED_EXECUTION` (no existe bid/ask histórico).

## Qué hay

| Módulo | Qué hace |
| --- | --- |
| `replay_data.py` | Puerta de datos: `mode=ro`, `PRAGMA query_only=ON`, rango fijo `2025-10-13 <= t < 2026-08-02` (el periodo reservado no se lee), consultas acotadas, verificación de series |
| `replay_execution.py` | `ModelledExecutor`: llena órdenes con un precio de vela fechado en el instante del fill; nunca crea `QuoteWatch` ni cotizaciones |
| `replay_driver.py` | Genera los eventos (velas, funding, ciclos, precios modelados), corre el `PaperRunner` en `execution_mode="modelled"` y escribe `results.json` una sola vez |
| `paper_runner.py` | Solo agrega `execution_mode` (por defecto `quotes`, idéntico a 8A-8C), el evento `modelled_price` y el rechazo de `quote` en modo modelado |

No hay segundo motor: decisión, tamaño, costes, funding y contabilidad son `Portfolio`, `Book` y `futures_costs`, sin cambios.

## Reglas temporales (por regla, no por `known_at` del backfill)

- La vela 1 m `b` llega en `b + 60 s + 2 s`; el ciclo de la barra 5 m que cierra en `c` llega en `c + 2 s`, después de la vela.
- El funding de la hora `[s, s+1h)` llega en `s + 1 h + 10 min`. Una hora ausente es desconocida, no 0.
- Escenarios de ejecución (sensibilidad, no observaciones): `S0` apertura de la vela donde cierra la decisión; `S1` (base) apertura de la vela siguiente; `S2` extremo adverso de la vela de entrada (estrés, no causal); `S3` = `S1` más un impacto adicional del producto.
- La vela del minuto de entrada la resuelve el ejecutor: si su rango toca el stop, cierra en el stop con evidencia `assumed_stop_entry_minute` (estimada); un objetivo tocado se ignora.

## Uso

```
PYTHONPATH=python python3 -m balancita_engine.replay_driver \
  --candles-db <market.sqlite> --funding-db <market.sqlite> --products PF_XBTUSD \
  --decision-start 2026-03-01 --decision-end 2026-03-08 --scenario S1 --out <directorio-nuevo>
```

Solo lectura sobre las bases; escribe únicamente en `--out`. Se niega a arrancar si hay huecos de velas 1 m en la ventana de decisión (salvo `--allow-gaps`, que queda declarado en el manifest), revisiones conflictivas, OHLC inválido o una ventana fuera de rango.

## Limitaciones

Stop con evidencia OHLC (estimada); parámetros de ejecución, riesgo y sizing son hipótesis no aprobadas; "funding conocido al inicio de la hora" es una hipótesis no probada (por eso el retraso de 10 min); `S2` usa información posterior al fill.
