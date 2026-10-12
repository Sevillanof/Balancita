# Fiabilidad medida de las estrategias

Cada estrategia se juzga solo por las operaciones que toma el simulador único (`futures_simulator`: modelo de costes por producto, 100 USD fijos, largo o corto, una posición a la vez) sobre velas oficiales de Kraken Futures. La tabla vive en [`config/strategy-reliability.json`](../config/strategy-reliability.json) y la calcula `python/balancita_engine/futures_strategy_reliability.py`.

## Qué mide

Por estrategia, con todos los productos juntos y por producto: operaciones, aciertos con su intervalo de Wilson al 95 %, ganancia neta media y mediana en bp después de costes, estadístico t con errores agrupados por día de entrada (las operaciones de distintos productos el mismo día comparten el movimiento del mercado), y en cuántos de 4 tramos de tiempo iguales la media es positiva (tramos purgados y con embargo, ver [validacion-sin-trampas.md](validacion-sin-trampas.md)).

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

- **Qwen**: el campo de estado `strategy_reliability` le da, por estrategia, veredicto, acierto, bp netos medios y número de operaciones, agregados sobre todos los productos para que su estado siga sin nombrar el producto. Es un dato más de contexto: la pregunta `trade_action` no dice qué hacer con él (ver [qwen-lessons.md](qwen-lessons.md)).
- **Registro** (`GET /api-strategies/strategies`): campo `reliability` por estrategia.

## Cómo se refresca

```
python3 scripts/fetch-kraken-charts.py --days 240 --out /tmp/charts
PYTHONPATH=python python3 -m balancita_engine.futures_strategy_reliability --charts-dir /tmp/charts
```

Tarda unos minutos por producto (aritmética Decimal). Hay que rehacerla cuando cambie un spec, el modelo de costes o cada cierto tiempo: es la única forma de ver si una ventaja sigue existiendo.

## Momentum logarítmico lento (C29 y C30): sin ventaja demostrada

C29 sigue movimientos extremos: retorno logarítmico de 6 h (72 velas de 5 m) por encima de 2,5 desviaciones de la volatilidad logarítmica diaria (`logvol288` sobre velas de 5 m), entrada a favor, stop a 2 sigmas diarias, objetivo 1,5 veces el stop o salida a las 24 h. C30 es lo mismo con 12 h (144 velas). Usan las features `logret<P>` y `logvol<P>` del simulador y el riesgo `risk.vol` / `risk.vol_minutes` del spec.

Validación (2026-10-07), con dos rangos de 240 días de los 8 productos:

|     | rango reciente (donde se buscó) | rango previo (nunca tocado)     | junto               |
| --- | ------------------------------- | ------------------------------- | ------------------- |
| C29 | 322 operaciones, +57 bp, t 1,38 | 405 operaciones, -2 bp, t -0,07 | 727, +24 bp, t 0,87 |
| C30 | 148 operaciones, +55 bp, t 1,10 | 140 operaciones, +62 bp, t 1,13 | 288, +58 bp, t 1,58 |

- C29 desaparece en el rango previo: lo que parecía ventaja era del tramo en que se buscó.
- C30 se comporta igual en los dos rangos, pero su lookback de 12 h se eligió después de ver el rango previo, así que ese rango ya no cuenta como independiente. Se registra para medirla hacia delante.
- Se buscó entre unas 1000 configuraciones. Con la corrección por búsqueda (Sharpe deflactado, `SELECTION_TRIALS`), la probabilidad de que cualquiera de las dos supere la suerte del mejor de 1000 intentos es prácticamente 0.
- El funding (tasas horarias reales de Kraken) cuesta 0,2 a 0,5 bp por operación a 24 h: no es lo que las limita.
- Reversión extrema a 5 y 15 minutos, a horizontes de 1 y 4 h: pierde 5 a 20 bp por operación en los dos rangos.

Hoy solo las ejecutan el backtest, el replay y Qwen en replay: los veredictos en vivo trabajan con ventanas de 200 velas y no alcanzan las 24 h de historia de 5 m que necesitan, y con estos resultados no se justifica moverlos.

## Medición hacia delante (paper)

Una estrategia que se encontró buscando en datos pasados no se promueve con esos datos. `config/forward-strategies.json` registra cada una con una hora de inicio (hoy solo C30, desde 2026-10-07 18:20 UTC; Kronos y C31 se miden aparte, ver `python/kronos_lab/README.md` y `docs/qwen-exit.md`). `python -m balancita_engine.futures_forward --market-db <market.sqlite> --out <dir> [--loop-seconds 3600]` la repasa sobre las velas oficiales de la DB de mercado (calentando indicadores con la semana anterior), se queda solo con las decisiones desde el inicio y guarda sus operaciones en `forward.sqlite` (solo se añaden, nunca se reescriben; cada una lleva el hash del spec). Escribe además `forward-reliability.json`.

Para que Qwen y el registro lo vean, exportar `STRATEGY_FORWARD_PATH=<dir>/forward-reliability.json`.

**Umbral explícito:** hasta que una estrategia registrada tenga **100 operaciones hacia delante** (`FORWARD_MIN_TRADES`), sigue valiendo su veredicto de backtest (como mucho `candidate_edge`) y Qwen ve `fwd=<hechas>/100`. Con 100 o más, deciden solo las operaciones hacia delante, con los umbrales normales (t ≥ 1,64 y 3 de 4 tramos positivos para `tentative_edge`, t ≥ 2,58 y 4 de 4 para `reliable_edge`; sin corrección por búsqueda, porque la estrategia está fijada de antemano) y puede subir o bajar el veredicto. Si no llega, `no_edge` o `negative_edge`.

Potencia: C30 hace unas 0,6 operaciones al día entre los 8 productos (288 en 480 días). Llegar a 100 lleva unos 5 meses, y con una media de +58 bp y una desviación de unos 400 bp por operación, distinguirla de cero con t ≥ 1,64 pide unas 130 operaciones.

Es un libro de paper aparte, alimentado por la misma DB de mercado que los veredictos. No pasa por los veredictos en vivo ni por D: C30 necesita unas 24 h de velas de 5 m y una volatilidad exponencial cuya semilla deja de importar tras una semana, y la ventana fija de 200 velas de los veredictos (parte de su identidad y de su config) no sirve para eso.

### Caídas de `pnpm dev`: los huecos no cambian el resultado

Mientras la captura está parada no entra la señal de nadie, pero el seguimiento hacia delante no depende de haber estado despierto: recalcula todo desde las velas oficiales de la DB. Por eso la recuperación consiste en llenar las velas que faltan y repasarlas en orden, como un replay corto:

- **Captura** (`capture-main`): al arrancar pide a Kraken (API pública de gráficos, sin credenciales) todas las velas de 1 m y 5 m desde la última guardada hasta ahora, por tramos de 1.800, sin el límite de profundidad que antes dejaba un hueco tras una caída de más de 24 h; cada vela se guarda con su hora real de conocimiento (`known_at`). Además repara huecos interiores de los últimos 10 días (solo pide las ventanas incompletas) y anota cada caída en `paper_futures_data_gaps` (feeds `official_candles_1m` y `official_candles_5m`).
- **Entradas:** una señal en una vela cerrada del hueco abre al cierre de esa vela (la apertura de la siguiente) y con su hora, no con la de hoy.
- **Salidas:** el stop y el objetivo se comprueban con el máximo y el mínimo de cada vela; si caen ambos en la misma, gana el stop (peor caso). La salida por tiempo cuenta desde la hora real de entrada. Una posición abierta al caer se cierra donde le tocó durante el hueco.
- **Costes y funding:** los mismos del modelo por producto, con el funding de ese periodo.
- **Etiqueta `recovered`:** una operación cuyo tramo de entrada a salida contiene una vela conocida más de 5 minutos después de cerrar se marca como recuperada. **Cuenta** para las 100 operaciones; `forward-reliability.json` trae `summary` (todas), `summary_without_recovered` y `recovered_trades` para reportar con y sin ellas.
- **Control:** `missing_candles_1m` cuenta los minutos que siguen sin vela y `diverged_trades` las operaciones guardadas antes de llenar un hueco que ya no se reproducen con las velas actuales (no se reescriben; `--rebuild` guarda `forward.sqlite` aparte y lo recalcula).
- **No se recupera** lo que depende de decisiones en vivo (C31 y Qwen) ni de datos que Kraken no sirve por rango: bid/ask del libro y trades de la captura. Kronos pide sus velas horarias a Kraken y ya no depende de la captura.

Una operación recuperada es una prueba algo menos limpia que una vista en vivo (el resultado se conoce después), por eso lleva la etiqueta.

## Tendencia diaria

Reglas estándar fijadas antes de mirar (sin barrido), sobre cierres diarios de futuros desde marzo de 2022 (1560 días útiles, 6 a 8 productos), largo y corto, costes de futuros y funding medio: ruptura Donchian de 50 días con salida a 20, cruce de medias 20/100 y signo del retorno a 90 días, con y sin tamaño por volatilidad. Cartera igual por producto: de +0,3 a +4,5 bp por día frente a +18 del buy and hold, Sharpe de -0,2 a 0,3, intervalos de bloques mensuales que cruzan cero y primera mitad negativa. No hay potencia: con un Sharpe verdadero de 0,2 harían falta del orden de cien años de datos para distinguirlo de cero; 4,3 años y un solo ciclo de mercado no bastan. Detalle en `analisis/estrategias-log-walkforward.md` (en la carpeta compartida del proyecto, no en el repo), sección 9.

## Estado a 2026-10-11

Ninguna regla de velas ni variante de Qwen ha mostrado ventaja neta tras costes. C25-C28 se dan por cerradas (ventaja bruta ≈ 0, pierden aproximadamente el coste). C29, C30, C31 y Kronos siguen en paper hasta 100 operaciones y no se modifican mientras tanto. La ejecución pasiva (maker) se simuló contra la cinta pública y no crea ventaja: queda archivada.

## Activa = opera

Con `--strategies-db` (en `pnpm dev` ya va puesto), el seguimiento forward mide además toda estrategia **activa** en el registro, desde el momento en que se activó (para una de fábrica que nadie encendió, como C29, desde la primera vez que el runner la vio; se anota una vez y no se mueve). C30 conserva su inicio de `config/forward-strategies.json` y sigue mientras el registro la tenga activa. Desactivar o borrar una estrategia deja de añadirle operaciones; las ya guardadas permanecen. El motor viejo D ya no corre: no hay otro sitio donde operen estrategias.

## Funding en el neto: desconocido no es cero (2026-10-12)

Hasta esta corrección `replay()` no pasaba los periodos de funding al `Book` (el argumento `funding` solo alimenta la característica `fundpct`), así que todas las operaciones forward salían con `funding_usd = 0.0` y `funding_complete = false`: el neto no incluía funding y nadie podía distinguir un cero observado de un dato que faltaba.

- **Libro:** cada operación lleva `funding_usd` (`null` si ningún periodo cubre el tiempo mantenido, una suma parcial si cubre parte, el valor completo si cubre todo), `funding_complete`, `funding_status` (`complete`, `partial` o `unknown`), `funding_covered_ms` y `funding_held_ms`. Un cero observado es `0.0` con `funding_complete = true`.
- **Forward:** `run_forward` pasa los periodos al libro. `forward_trade` sigue siendo solo de añadir: una operación guardada sin funding conserva su payload original. Cuando los periodos en disco cubren **todo** el tiempo mantenido se agrega una fila en `forward_trade_funding` (versión `funding-reconcile.v1`, hash de los periodos usados, funding, pnl y neto resultantes). Si falta cualquier tramo, no se escribe nada y la operación sigue incompleta. Es idempotente y las filas no se pueden modificar ni borrar.
- **Resumen:** `forward-reliability.json` usa la fila conciliada cuando existe y añade `funding_complete_trades`, `funding_incomplete_trades`, `net_is_definitive` y `mean_net_bp_funding_complete`. `mean_net_bp` y `pnl_usd` solo son el neto definitivo cuando `net_is_definitive` es `true`; si no, son parciales (sin el funding de las operaciones incompletas).
- **Divergencias:** `net_bp` ya no cuenta para `diverged_trades`: completar el funding no es un hueco de velas.
- **Backtests sin base de mercado** (`run_books`, `futures_strategy_backtest` sin `funding=`) siguen sin funding y ahora se muestran como no definitivos.
