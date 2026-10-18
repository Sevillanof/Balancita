# Funding causal: solo cuenta lo que la captura ya había visto

Estado: código y pruebas con datos mínimos escritos a mano; **no se corrió sobre datos reales** (la captura vive en el Mac de Fran).

## Qué cambia (parte general)

- `futures_funding_context.load_periods(db, producto, since_ms=None)` devuelve `(inicio, tasa_relativa, known_at)` (`load_periods_detailed` añade banderas). **Época de avistamientos** (`paper_futures_funding_sightings`, #259): `known_at` es el primer avistamiento posterior al cierre y la tasa la de ese avistamiento (la relativa sale del extracto del intento, `paper_futures_funding_polls.extract_text`, o del cuerpo si se guardó). Si avistamientos posteriores muestran otra tasa se conserva la primera y se cuenta el conflicto (`conflicts`), sin elegir en silencio. **Respaldo, solo para horas anteriores a la tabla de avistamientos o bases sin ella**: filas de `paper_futures_funding_periods` con `known_at >= fin` (la tabla solo escribe una fila si `(inicio, tasa)` es nueva); una hora cuya única fila se vio con el período abierto usa `known_at = fin + 1 h` (siguiente consulta horaria, conservador) y queda marcada **aproximada** (`approximate`). Dentro de la época una hora sin avistamiento (consulta fallida) queda sin dato, no se adivina. `assess_detail(t)` expone las horas aproximadas y con conflicto de la ventana. Solo se leen y parsean las respuestas que aportan esas filas, una vez por proceso (cache), y `since_ms` acota el coste a las horas que se reproducen. Antes: solo la respuesta más antigua y las dos más nuevas, sin fecha de conocimiento.
- `FundingContext` usa `known_at` (nunca antes de `fin + 10 min`), exige que el período juzgado tenga a lo sumo `MAX_PERIOD_AGE_MS` de edad, y calcula el percentil sobre **30 días de tiempo** (no 720 entradas) con las horas ya conocidas. `assess(t)` devuelve el motivo si es desconocido: `no_history`, `stale`, `window_gaps`. `line()`/`percentile()` no cambian de formato (la línea de Q sigue siendo `funding: unknown` o `funding: nivel (pctl30d=N, ...)`; no cambia la versión del prompt).
- `futures_replay.load_range(..., max_lag_ms=None)`: opción para una vista en vivo (deja fuera velas aprendidas más de `max_lag_ms` después de cerrar). Por defecto no cambia nada: el forward depende de ver las velas rellenadas para etiquetarlas `recovered`.

## Valores provisionales (los aprueba Fran)

| Constante | Valor | Razón |
| --- | --- | --- |
| `MAX_PERIOD_AGE_MS` | 36 h | la publicación real tiene mediana ≈ 16,8 h (docs/captura-confirmacion-funding-184.md); 36 h es ≈ el doble. Un hueco de captura de 30 h supera el límite. |
| `MIN_WINDOW_COVERAGE` | 0,9 | porción de las 720 h previas que debe estar conocida; menos → `window_gaps`. |
| `PUBLICATION_LAG_MS` | 10 min | queda como piso (`fin + 10 min`), ya no como regla única. |

## Consumidores afectados

`FundingContext`/`load_periods`/`funding_for` los usan: C32 y todo el forward (`futures_forward`, también la contabilidad de funding de C30), la línea de funding de Q y su replay (`futures_replay.qwen_factory`, `futures_replay_qwen`), `futures_portfolio_risk`, `futures_maker`, `multi_experiment`, `kronos_lab/funding.py` y la auditoría `futures_forward_audit`. `paper_live_evaluator` y `replay_driver` construyen `FundingContext` con pares `(inicio, tasa)`: se les aplica el límite de edad y la ventana por tiempo. Sin cambio: el lector del replay 9a (`replay_data`, `replay_funding_parity`), que aún lee la respuesta más antigua y las dos más nuevas.
`funding_periods(contexto)` (contabilidad) ahora trae solo las horas que la tabla de períodos lista tras el cierre.

## Pausado por decisión de Fran (no implementado aquí)

Re-replay de C31/C32 desde 2026-10-12, marca «posible dato simulado» de los trades viejos, cambios de libro/clave, y los cambios propios de C31 (velas conocidas, compuerta de entrada, funding capturado con signo). Convención de signo, verificada en `funding_adapter` y `Book._funding`: tasa relativa positiva la paga el largo y la cobra el corto; no se contrastó con documentación de Kraken.

## 9A frente al forward: pendiente de decisión de Fran

El lector del replay 9A (`replay_data`, `replay_funding_parity`) sigue leyendo la respuesta más antigua y las dos más nuevas, sin `known_at`, mientras el forward ya usa el cargador causal; ambos pueden dar tasas y horas distintas. La prueba `test_replay_9a_audit.test_the_replay_reads_the_same_periods_as_the_forward` se relajó antes sin autorización (compara solo las horas que ambos listan); aquí no se debilita más. Si 9A debe reproducir el forward, o el forward a 9A, lo decide Fran.
