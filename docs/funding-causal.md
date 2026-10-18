# Funding causal: solo cuenta lo que la captura ya había visto

Estado: código y pruebas con datos mínimos escritos a mano; **no se corrió sobre datos reales** (la captura vive en el Mac de Fran).

## Qué cambia (parte general)

- `futures_funding_context.load_periods(db, producto, since_ms=None)` devuelve `(inicio, tasa_relativa, known_at)` (`load_periods_detailed` añade banderas). **Época de avistamientos** (`paper_futures_funding_sightings`, #259): `known_at` es el primer avistamiento posterior al cierre y la tasa la de ese avistamiento (la relativa sale del extracto del intento, `paper_futures_funding_polls.extract_text`, o del cuerpo si se guardó). Si avistamientos posteriores muestran otra tasa se conserva la primera y se cuenta el conflicto (`conflicts`), sin elegir en silencio. **Respaldo, solo para horas anteriores a la tabla de avistamientos o bases sin ella**: filas de `paper_futures_funding_periods` con `known_at >= fin` (la tabla solo escribe una fila si `(inicio, tasa)` es nueva); una hora cuya única fila se vio con el período abierto usa `known_at = fin + 1 h` (siguiente consulta horaria, conservador) y queda marcada **aproximada** (`approximate`). Dentro de la época una hora sin avistamiento (consulta fallida) queda sin dato, no se adivina. `assess_detail(t)` expone las horas aproximadas y con conflicto de la ventana. Solo se leen y parsean las respuestas que aportan esas filas, una vez por proceso (cache), y `since_ms` acota el coste a las horas que se reproducen. Antes: solo la respuesta más antigua y las dos más nuevas, sin fecha de conocimiento.
- `FundingContext` usa `known_at` tal cual lo vio la captura (**sin piso de 10 min**; un par `(inicio, tasa)` sin `known_at` cuenta desde su cierre; quien modela una espera propia —replay 9A, paridad, evaluador en vivo— usa `with_publication_wait`). Exige que la última tasa conocida haya cerrado hace a lo sumo `MAX_PERIOD_AGE_MS` y calcula el percentil sobre **30 días de tiempo** con la ventana **completa al 100 %**: una hora tardía rellenada desde el historial de Kraken vale si su `known_at` <= t; si aún falta alguna, el funding es inutilizable. `assess(t)` devuelve `(resultado, código, motivo)`; nunca «desconocido» a secas. Códigos estables y texto en español con datos concretos: `no_history` («sin ninguna tasa de funding conocida todavía»), `stale` («la hora 14:00Z no llegó: 12 min por encima del límite de 71 min (…)»), `insufficient_history` («sin historia suficiente: 12 de 30 días»), `window_gaps` («faltan 3 horas de funding entre 2026-10-18T02:00Z y 2026-10-18T05:00Z (captura apagada o sin relleno)»). `line()`/`percentile()` no cambian de formato (la línea de Q sigue siendo `funding: unknown`; no cambia la versión del prompt; el motivo llega por `assess` y por el resumen del forward, no al prompt).
- `futures_replay.load_range(..., max_lag_ms=None)`: opción para una vista en vivo (deja fuera velas aprendidas más de `max_lag_ms` después de cerrar). Por defecto no cambia nada: el forward depende de ver las velas rellenadas para etiquetarlas `recovered`.

## Valores provisionales (decididos por Fran, a revisar con el WebSocket)

| Constante | Valor | Razón |
| --- | --- | --- |
| `MAX_PERIOD_AGE_MS` | 71 min | medido desde el **fin** de la última tasa conocida. El funding es horario y el período recién cerrado se conoce normalmente entre 30 s y 11 min después de su fin (reintentos REST y sondeo de asentamiento de la captura, `live-capture.ts`), así que en operación normal la última conocida cerró hace ≤ ~60 min; pasados 71 min la hora recién cerrada no llegó. Con funding por WebSocket bajaría a ~61 min. |
| ventana | 720 h, 100 % | sin tolerancia (antes 0,9). |
| piso de publicación | ninguno | se usa la hora real en que la captura vio el dato. |

**No reutilizar la «mediana ≈ 16,8 h» de `docs/captura-confirmacion-funding-184.md`**: era un artefacto de la deduplicación del almacén (hora en que se guardó, no en que se publicó).

## Recuperación del tiempo apagado (forward)

Con el Mac apagado la captura rellena velas (REST, hasta 10 días) y funding al arrancar. El forward evalúa todo el tramo apagado una vez rellenado y **simula** las entradas sobre datos tardíos, marcándolas `recovered`: entrada sobre velas rellenadas, salida sobre velas rellenadas (`is_recovered`) o decisión apoyada en funding que la captura supo después (`FundingContext(recover_until_ms=ahora)`: si el instante no era utilizable entonces pero sí con lo conocido hoy, se juzga así y se anota en `late_at`; `funding_recovered`). La compuerta de entradas obsoletas **ya no bloquea** (`BLOCK_STALE_ENTRIES = False`; el código sigue disponible). El resumen trae `summary_without_recovered` (en vivo), `summary_recovered`, `live_trades`, `recovered_trades` y `counts_toward_min_trades: "live"`: **solo las operaciones en vivo cuentan para el mínimo de 100 y deciden el veredicto** (`effective_reliability`). Además `funding_state` por producto: `usable`, `code` y `reason` del funding ahora (estricto, sin recuperación).

## Consumidores afectados

`FundingContext`/`load_periods`/`funding_for` los usan: C32 y todo el forward (`futures_forward`, también la contabilidad de funding de C30), la línea de funding de Q y su replay (`futures_replay.qwen_factory`, `futures_replay_qwen`), `futures_portfolio_risk`, `futures_maker`, `multi_experiment`, `kronos_lab/funding.py` y la auditoría `futures_forward_audit`. `paper_live_evaluator` y `replay_driver` construyen `FundingContext` con pares `(inicio, tasa)`: se les aplica el límite de edad y la ventana por tiempo. Sin cambio: el lector del replay 9a (`replay_data`, `replay_funding_parity`), que aún lee la respuesta más antigua y las dos más nuevas.
`funding_periods(contexto)` (contabilidad) ahora trae solo las horas que la tabla de períodos lista tras el cierre.

## Pausado por decisión de Fran (no implementado aquí)

Re-replay de C31/C32 desde 2026-10-12, marca «posible dato simulado» de los trades viejos, cambios de libro/clave, y los cambios propios de C31 (velas conocidas, compuerta de entrada, funding capturado con signo). Convención de signo, verificada en `funding_adapter` y `Book._funding`: tasa relativa positiva la paga el largo y la cobra el corto; no se contrastó con documentación de Kraken.

## 9A frente al forward: pendiente de decisión de Fran

El lector del replay 9A (`replay_data`, `replay_funding_parity`) sigue leyendo la respuesta más antigua y las dos más nuevas, sin `known_at`, mientras el forward ya usa el cargador causal; ambos pueden dar tasas y horas distintas. La prueba `test_replay_9a_audit.test_the_replay_reads_the_same_periods_as_the_forward` se relajó antes sin autorización (compara solo las horas que ambos listan); aquí no se debilita más. Si 9A debe reproducir el forward, o el forward a 9A, lo decide Fran.
