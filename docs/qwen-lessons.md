# Qwen aprende de sus propias decisiones

La naturaleza de Qwen no cambia: en cada momento decide `buy`, `hold` o `sell` con la pregunta `trade_action`, y cada decisión se puntúa +1 o -1 a los 30 minutos con las reglas y costes de `futures_llm_scores.py` (`buy` acierta si la posición larga gana tras costes, `sell` si gana la corta, `hold` si ninguna habría ganado).

## Qué es la pregunta

`trade_action` versión 3 tiene **el texto, las opciones y la regla +1 de la versión 1**, la original, sin ninguna instrucción sobre qué elegir ni qué categorías ignorar. Lo único que se añade al estado son dos líneas de contexto:

- `strategy_reliability`: lo que dice la tabla de fiabilidad medida de cada estrategia (ver [strategy-reliability.md](strategy-reliability.md)). Es un dato, no una regla.
- `lessons`: sus últimas decisiones **ya juzgadas**, para que ajuste cómo decide.

La versión 2 de la pregunta, que le decía que eligiera `hold` salvo ventaja medida, se retiró.

## Qué ve en `lessons`

```
lessons: your last 41 decisions, judged 30 minutes later (+1 when your action was the right one)
lessons_score: 29 right of 41 (71%); correct when you chose: buy 40%; hold 83%; sell 33%
lessons_right_action: buy=12% hold=68% sell=20%
lessons_example: saw trend b0.20 h0.70 s0.10 -> chose hold, right was buy (-1)
… (las 8 últimas)
```

Cada ejemplo dice qué vio (régimen y consenso de las estrategias), qué eligió y cuál era la acción correcta. Sirve para dos cosas: calibrar con qué frecuencia acierta cada una de sus elecciones y ver en qué contextos se equivocó.

**Sin fuga del futuro.** Una decisión tomada en el bucket `b` se juzga con el cierre de `b + 30 min`; solo aparece en `lessons` de decisiones en `n >= b + 30 min`, cuando ese cierre ya existe. Hay un test que lo comprueba sobre un replay entero. El estado sigue sin fechas, precios absolutos ni nombre de producto.

## Dónde corre

- **En vivo** (`DecisionService`): la memoria se reconstruye al arrancar desde las decisiones guardadas y los cierres de la base de veredictos; cada decisión nueva se suma después de guardarse.
- **Replay a ciegas** (`BlindQwen`): la misma memoria, alimentada con las velas del propio replay.

## Medirlo: tres brazos, mismas velas

`python -m balancita_engine.futures_replay … --qwen trade_action --qwen-arm <brazo>` pregunta lo mismo con distinto contexto:

| Brazo      | Contexto                                                    | Versión |
| ---------- | ----------------------------------------------------------- | ------- |
| `original` | exactamente la pregunta original (hash fijado en los tests) | 1       |
| `context`  | original + `strategy_reliability`                           | 2       |
| `learning` | lo anterior + `lessons` (lo que se entrega)                 | 3       |

Con la caché de respuestas (`--qwen-cache`) cada brazo se calcula una vez. Se compara la tasa de +1 de cada brazo en los mismos rangos; la memoria no tiene parámetros ajustados, así que el único ajuste posible sería el diseño del texto, que está fijado antes de ejecutar, y los dos rangos de 240 días son disjuntos.

## Qué se pudo medir sin el modelo

No hay modelo local en el entorno donde se escribió esto, así que la comparación real de los tres brazos queda por ejecutar. Lo que sí se midió son los techos de la tasa de +1 con reglas sin parámetros ajustados, sobre BTC en dos rangos disjuntos de 240 días, en los mismos cuadros donde se le preguntaría a Qwen (`entry`: alguna estrategia propone operar; `5min`: cada cinco minutos). «Mayoría de lo reciente» elige la acción que fue la correcta con más frecuencia en las últimas 60 decisiones ya juzgadas, que es la información que lleva `lessons_right_action`.

| Rango             | Cuadros | Siempre `hold` | Seguir el consenso | Mayoría de lo reciente |
| ----------------- | ------- | -------------- | ------------------ | ---------------------- |
| Reciente, `entry` | 46 130  | 37,3 %         | 37,4 %             | **40,6 %**             |
| Reciente, `5min`  | 67 114  | 40,6 %         | 40,6 %             | **41,7 %**             |
| Previo, `entry`   | 47 928  | 38,6 %         | 38,6 %             | **41,5 %**             |
| Previo, `5min`    | 67 114  | 41,0 %         | 41,0 %             | **43,1 %**             |

Lectura: en BTC a 30 minutos, tras costes, la acción correcta se reparte casi por tercios (compra 30 %, venta 30 %, `hold` 37 a 41 %), así que una regla fija ronda el 40 %. Usar el historial reciente suma entre 1 y 3 puntos en los cuatro casos, y en los dos rangos por separado, sin parámetros ajustados. Es el orden de magnitud del margen que tiene `lessons`: poco, pero consistente. Seguir el consenso de las estrategias no mejora siempre `hold`, coherente con que ninguna tiene ventaja. Qwen puede quedar por debajo o por encima de estas reglas; solo el replay con el modelo lo dice.

Para correrlo con el modelo local levantado: `python -m balancita_engine.futures_replay --market-db … --from … --to … --qwen trade_action --qwen-arm original|context|learning --qwen-cache cache.sqlite --out run-<brazo>.sqlite`, una vez por brazo y por rango.

Script: `analisis/research-estrategias-log/lessons_base.py`.
