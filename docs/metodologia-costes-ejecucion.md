# Metodología: costes reales de ejecución (maker y taker)

Módulo: `python/balancita_engine/book_costs.py` (solo lectura de `futures-book.sqlite`). Pruebas: `python/tests/test_book_costs.py`. No toca el simulador forward, `futures_costs.py` ni ninguna base activa. No usa el holdout ni evalúa estrategias.

```
PYTHONPATH=python python3 -m balancita_engine.book_costs --book-db <copia de futures-book.sqlite> --product PF_XBTUSD --out <dir> [--signals señales.json]
```

## Qué mide y con qué categoría
| Concepto | Categoría | Cómo |
|---|---|---|
| Spread cotizado, por hora UTC | Observado | `best_ask − best_bid` de cada snapshot (p50/p90). |
| Liquidez | Observado | USD dentro de 5, 10, 25, 50, 100 pb del medio, por lado (p10 y p50: lo que importa es el momento fino). |
| Taker: medio spread, impacto, comisión | Simulado, determinista | Recorre los niveles guardados para 100, 1.000 y 10.000 USD. Si los 5 niveles no alcanzan, usa la banda de profundidad más estrecha que lo contiene (cota peor caso, marcada `bound`); si tampoco, `none` (se informa el % sin cubrir, no se inventa). |
| Maker: comisión, relleno, no ejecutadas | Estimado, con banda | Orden post-only en el mejor precio pasivo, TTL (60 s por defecto), latencia 100 ms. Siempre dos **escenarios hipotéticos**: optimista y conservador. Ninguno es un fill demostrado, una cota inferior de fills reales ni una probabilidad calibrada (se informa como `hypothetical_fill_rate`). |
| Slippage | Simulado | Diferencia entre el medio en la señal y el precio del recorrido (taker) o del límite (maker); en la política "perseguir", incluye la deriva durante la espera. |
| Coste total | Simulado + parámetro | `round_trip_cost_bp`: entrada + salida (taker) + comisiones + funding. Funding desconocido queda `None`, no 0. |
| Tabla estática vs medido | Control | `compare_with_cost_table` contrasta `futures_costs.side_impact_bps` con la mediana medida a 1.000 USD. |

## No se asume que el límite se ejecuta
Tres políticas sobre las mismas señales (todo en pb del medio de la señal, de la entrada a `hold` después, antes de la salida, que es igual en las tres y se cancela):
- **taker**: mercado de inmediato.
- **skip**: límite; si no se ejecuta, no hay operación (0).
- **chase**: límite; si no se ejecuta al terminar el TTL, mercado en ese momento, **pagando la deriva que esperó**.

Cifra principal: `chase − taker`, **emparejada** por señal (toda orden se ejecuta, no hay sesgo de selección). Cifras auxiliares, siguiendo el estudio archivado (PR #80-#83): ahorro si se rellena, `selección` (media taker de las rellenadas menos la de todas: negativa = selección adversa), `neto vs azar` (maker rellenado menos taker de todas) y markout del medio a 5, 10 y 60 s tras el fill.

## Escenarios de relleno (hipotéticos)
- **Con cinta de trades** (opcional, `TradeTape`): optimista = cualquier trade agresor opuesto en el precio o a través; conservadora = estrictamente a través, o en el precio una vez que lo negociado supera la cola delante más nuestro tamaño (requiere cantidades; la cinta pública histórica de `futures_tape` no las guarda, así que sin cantidades un toque nunca cuenta como fill conservador).
- **Solo libro** (por defecto): optimista = el mejor opuesto alcanzó nuestro precio, o el mejor propio se alejó (nivel comido *o cancelado*, indistinguible); conservadora = solo el mejor opuesto alcanzó nuestro precio. Hora del fill = snapshot posterior (hasta 5 s tarde).

## Estadística
- Las órdenes se colocan en rejilla (cada 5 min, ambos lados) o en las horas de señal reales (`--signals`). Órdenes consecutivas se solapan, así que los errores estándar se **agrupan por hora**; el veredicto exige ≥ 30 grupos y 2 errores estándar (`maker_helps`, `maker_hurts`, `inconclusive`, `insufficient_data`).
- **Huecos:** una orden se excluye (no cuenta como no ejecutada) si su ventana completa, desde el snapshot de referencia hasta el mayor entre `hold`, la persecución y el último markout, cruza un registro de `book_gap` **o** un tramo de snapshots separados más de 15 s, o si falta algún precio. Se informa cuántas y por qué (`excluded_reasons`: `logged_gap`, `snapshot_gap`, `data_ends`, `missing_price`). Un hueco registrado puede existir con snapshots separados menos de 15 s; por eso se usan ambos criterios.
- **Tiempo de la señal:** el precio de referencia es el último snapshot **anterior o igual** a la señal (lo conocido al emitirla, con edad máxima de 15 s); la ejecución usa el primer snapshot **posterior** a `señal + latencia`. Todos los costes se miden contra el medio de referencia, así que lo que se mueve el mercado entre ambos queda en el coste (`wait_signal_to_execution_bp`). Señal sin referencia reciente o sin snapshot de ejecución: no evaluable, se cuenta (`unevaluable_signals`) y no se estima.
- **Tamaños arbitrarios:** `--sizes 175,340,620,...` y `taker_curve_bp` del informe dan el coste taker mediano (con comisión) para cualquier nocional, como insumo futuro de la cartera compartida. No se conecta con ningún otro módulo.

## Límites declarados
- Snapshots de ~5 s con 5 niveles: no reconstruyen lo ocurrido entre fotos, ni la posición en la cola, ni el horizonte de 1 s (se informan 5, 10 y 60 s).
- La rejilla es incondicional. Las señales reales llegan cuando el mercado se mueve, justo cuando el relleno es más adverso: antes de usar cifras para C29/C30/C32/Kronos hay que repetir con sus horas de señal.
- Solo BTC y ETH (piloto). Los otros seis productos conservan la tabla estática.
- Comisiones: nivel 1 (maker 2 pb, taker 5 pb), como `futures_costs`. Impacto del propio orden en el libro no se simula más allá del recorrido.
- Salida: se modela como taker; los stops pagan además un spread completo (ya en `futures_costs`), no recalculado aquí.

## Cuándo ejecutar las mediciones reales
Cuando el piloto de 4 h termine y sus datos estén validados (cobertura, huecos). Trabajar sobre una copia en solo lectura. Cuatro horas con rejilla de 5 min dan ~48 observaciones por lado, pero solo **4 grupos horarios**; el veredicto exige 30, así que el piloto saldrá `insufficient_data` (una prueba lo garantiza). Es un ensayo del método, no una conclusión: no usar la banda maker para decidir hasta tener días de datos.
