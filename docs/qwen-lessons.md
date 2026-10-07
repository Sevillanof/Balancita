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
