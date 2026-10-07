# C31: Qwen decide cuándo cierra

Pedido de Fran (2026-10-08): una estrategia para probar un tiempo en la que Qwen decide cuándo se cierra la operación y asume la ganancia o la pérdida, sin cambiar su naturaleza: solo decide y aprende.

## Qué hace

- **Entrada**: la dan las estrategias deterministas ya medidas (`config/qwen-exit.json`: C25, C26, C27 y C30). Si dos discrepan en el mismo minuto no se entra. Es un libro de paper aparte, 100 USD por operación, largo o corto, en los 8 productos, una posición por producto.
- **Salida**: ninguna regla. Sin stop loss, sin take profit y sin límite de tiempo. Mientras la posición está abierta, Qwen responde `hold` o `close` a la pregunta `exit_decision`. Si responde `close`, se cierra al cierre de esa vela con los costes del proyecto (0,05 % taker en cada lado más impacto) y el resultado queda registrado para siempre.
- **Cuándo se le pregunta**: cada 5 min la primera hora, cada 15 min hasta las 6 h y cada hora después. Solo se llama al modelo si hay una posición abierta.
- **Qwen no cambia**: mismo modelo, misma plantilla y mismas probabilidades leídas de los logprobs. `trade_action` (buy/hold/sell, versión 3) no se toca y su hash sigue fijado en los tests. `exit_decision` es una pregunta nueva con `scope: "exit"`, por eso el proceso Q en vivo nunca la hace.

## Qué ve Qwen y cómo aprende

El estado lleva el régimen y los indicadores normalizados de siempre (sin precios, fechas ni nombre del producto) más dos líneas nuevas:

```
position: side=long held_min=145 net_bp=-32.4 best_bp=+12.0 worst_bp=-61.2 cost_to_close_bp=5.1
exit_lessons: your last 40 exit decisions, judged 30 minutes later (...): 22 right of 40 (55%); correct when you chose: hold 70%; close 40%
exit_example: at -21.0bp after 90min you chose hold, 30min later it stood at -40.2bp, right was close (-1)
exit_trades: your last 5 closed trades (net bp, minutes held, worst point): +14.1 after 95min (worst -3.0); ...
```

- `net_bp` es lo que ganaría o perdería si cerrara ahora, ya con entrada, salida y funding.
- Una decisión se juzga a los 30 minutos con el precio de entonces: `hold` acierta si la posición está mejor que cuando decidió; si no, acertaba `close`. Entra en `exit_lessons` solo cuando ese cierre ya existe (sin fuga del futuro; hay test).
- Sus últimas operaciones cerradas aparecen con su resultado y su peor momento, para que asuma lo que costó aguantar.

## Límites que conviene tener presentes

1. **Sin stop, la cola no está acotada por la estrategia.** En una medición propia (90 días, 5 min, entradas aleatorias y de reversión) mantener hasta ganar acertaba el 96-99 % y aun así perdía de media entre 70 y 270 pb por operación, porque las pocas posiciones que no vuelven pierden mucho más que lo que ganan las demás. Qwen tiene que demostrar que corta antes; esta estrategia existe para medir eso.
2. **Las posiciones son de 100 USD sin apalancamiento.** Un largo no puede perder más de 100 USD; un corto se liquida si el precio se duplica (`liquidation`). Es contabilidad, no gestión de riesgo. Con el margen real de Kraken (1-2 %) la liquidación llegaría mucho antes.
3. **Funding conservador**: se cobra siempre a ambos lados al valor absoluto medio por hora de cada producto (`analisis/costes-reales-kraken.md`), nunca se recibe.
4. **El mismo modelo, la misma pregunta y la misma configuración**: el runner se niega a seguir sobre una base escrita con otro modelo, otra versión de la pregunta o otro conjunto de entradas. Para cambiar algo se usa un `--out` nuevo.

## Cómo se usa

```
pnpm dev                 # arranca el modelo local y el hijo qwenexit (cada 30 min)
python -m balancita_engine.futures_qwen_exit --market-db server/data/dev-live/futures-market.sqlite \
    --out server/data/dev-live/qwen-exit [--loop-seconds 1800]
```

Escribe `qwen-exit.sqlite` (operaciones y decisiones, solo se añade; posiciones abiertas) y `qwen-exit-summary.json` (operaciones cerradas, acierto, media y peor en pb, tiempo mantenido, posiciones abiertas valoradas al último cierre y reparto hold/close). Cada vuelta repite el historial desde `start_ms` con la caché de respuestas (`answers.sqlite`), así que no vuelve a preguntar lo ya respondido. Si el modelo no está, se detiene ese producto, conserva lo ya cerrado y reintenta en la vuelta siguiente.

## Cuándo juzgarla

Con 100 operaciones cerradas o 7 días, lo que llegue antes: media neta en pb, % de acierto, peor operación, y el valor de las posiciones aún abiertas junto con las cerradas (una estrategia que solo cierra las ganadoras debe contar también las que sigue aguantando). Referencia para comparar: las mismas entradas con la salida de sus propias reglas (C25/C27 en el simulador).

Código: `python/balancita_engine/futures_qwen_exit.py`. Tests: `python/tests/test_futures_qwen_exit.py`.
