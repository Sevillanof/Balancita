# Funding causal: solo cuenta lo que la captura ya había visto

Estado: código y pruebas con datos mínimos escritos a mano; **no se corrió sobre datos reales** (la captura vive en el Mac de Fran).

## Qué cambia (parte general)

- `futures_funding_context.load_periods(db, producto, since_ms=None)` devuelve `(inicio, tasa_relativa, known_at)` (`load_periods_detailed` añade banderas). **Época de avistamientos** (`paper_futures_funding_sightings`, #259): `known_at` es el primer avistamiento posterior al cierre y la tasa la de ese avistamiento (la relativa sale del extracto del intento, `paper_futures_funding_polls.extract_text`, o del cuerpo si se guardó). Si avistamientos posteriores muestran otra tasa se conserva la primera y se cuenta el conflicto (`conflicts`), sin elegir en silencio. **Respaldo, solo para horas anteriores a la tabla de avistamientos o bases sin ella**: filas de `paper_futures_funding_periods` con `known_at >= fin` (la tabla solo escribe una fila si `(inicio, tasa)` es nueva); una hora cuya única fila se vio con el período abierto usa `known_at = fin + 1 h` (siguiente consulta horaria, conservador) y queda marcada **aproximada** (`approximate`). Dentro de la época una hora sin avistamiento (consulta fallida) queda sin dato, no se adivina. `assess_detail(t)` expone las horas aproximadas y con conflicto de la ventana. Solo se leen y parsean las respuestas que aportan esas filas, una vez por proceso (cache), y `since_ms` acota el coste a las horas que se reproducen. Antes: solo la respuesta más antigua y las dos más nuevas, sin fecha de conocimiento.
- `FundingContext` usa `known_at` tal cual lo vio la captura (**sin piso de 10 min**; un par `(inicio, tasa)` sin `known_at` cuenta desde su cierre; quien modela una espera propia —replay 9A, paridad, evaluador en vivo— usa `with_publication_wait`). Exige que la última tasa conocida haya cerrado hace a lo sumo `MAX_PERIOD_AGE_MS` y calcula el percentil sobre **30 días de tiempo** con la ventana **completa al 100 %**: una hora tardía rellenada desde el historial de Kraken vale si su `known_at` <= t; si aún falta alguna, el funding es inutilizable. `assess(t)` devuelve `(resultado, código, motivo)`; nunca «desconocido» a secas. Códigos estables y texto en español con datos concretos: `no_history` («sin ninguna tasa de funding conocida todavía»), `stale` («la hora 14:00Z no llegó: 12 min por encima del límite de 71 min (…)»), `insufficient_history` («sin historia suficiente: 12 de 30 días»), `window_gaps` («faltan 3 horas de funding entre 2026-10-18T02:00Z y 2026-10-18T05:00Z (captura apagada o sin relleno)»). `line()`/`percentile()` no cambian de formato (la línea de Q sigue siendo `funding: unknown`; la línea de funding de la pregunta de Q pasa de `trade_action@5` a `trade_action@6` (ver «Versión de la pregunta»); el motivo llega por `assess` y por el resumen del forward, no al prompt).
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

## Versión de la pregunta de Q: `trade_action@6` (2026-10-18)

`FUNDING_QUESTION_VERSION` pasa de 5 a 6 porque el contenido de la línea `funding:` cambió con el cargador causal (`known_at`, ventana completa, límite de antigüedad). Todo lo que se indexa por esa versión queda separado, sin mezclar v5 y v6:

- **Replay** (`futures_replay.qwen_factory` -> `funding_question`): produce `trade_action@6`; el texto de ayuda de `--funding` lo dice. Los resultados de v5 son del cargador anterior y no se comparan con v6.
- **Decisiones y lecciones de Q** (`paper_futures_llm_decisions`, `Lessons`): la clave incluye `question_version`; la memoria de lecciones se arma por `(producto, pregunta, versión)`, así que v6 empieza sin lecciones de v5.
- **Calibración** (`config/decision-calibration.json`, clave `id@versión`): no tiene entrada para `trade_action@5` ni `@6`; ambas usan T=1 por defecto. Una calibración futura de v6 tendrá que ajustarse con filas v6.
- **Scorer E** (`futures_llm_scores.load_decisions`): filtra por versión exacta; sin `version` toma la más nueva guardada, es decir v6 en cuanto existan filas v6. Las filas v5 siguen en la base y se leen pasando `version=5` explícito.

## Q no pierde un tramo en silencio

Q guarda una fila por cada tramo+pregunta que **no** decidió, en la tabla append-only `paper_futures_llm_skips` (sin UPDATE ni DELETE) de la base de decisiones: `skip_id`, `product_id`, `bucket_start`, `question_id`, `question_version`, `code`, `reason` (texto en español), `written_at`. Códigos: `model_down` («modelo local caído (llama-server no responde)», con el detalle si lo hubo), `state_error` («estado no disponible: …»), `calm_skip` (filtro de calma) y `stale_verdict` (veredicto fuera de `max_verdict_lag_ms` o demasiado viejo). Los tramos saltados siguen sin reintentarse tras la recuperación; lo nuevo es el registro. Aún no hay API que los lea: se consultan en la base (`SELECT code, COUNT(*) FROM paper_futures_llm_skips GROUP BY code`). Los errores de respuesta del modelo siguen en `paper_futures_llm_errors`.

## C31 apagada (decisión del propietario, 2026-10-18)

C31 (`qwenexit`, `futures_qwen_exit.py`) queda **apagada**: usa un funding constante inventado (contradice el ADR «funding real y observado»), ignora `known_at` y no separa en vivo de recuperado. No se borra código ni datos. El interruptor único es el bloque `off` de `config/qwen-exit.json` (`since` y `reason`); borrarlo la reactiva. Con él: el lanzador (`scripts/dev-provider-env.mjs`) no arranca el proceso y pasa `QWEN_EXIT_OFF_REASON/SINCE` al servidor; el inventario la lista con estado `off` («Apagada») y el motivo; la salud la muestra como «apagada: motivo (desde fecha)» con estado `unknown`, nunca desaparece.

## Sesiones paper y registros creados con el código anterior no se reanudan

Este cambio modifica el código de `futures_funding_context.FundingContext`, que entra en `pipeline_hash()` (`signal_continuity.py`) y en el manifiesto del runner. Consecuencia: las sesiones paper y los registros durables de señales (congelado `strategy_frozen` de `signal_continuity`) creados con el código anterior **no se pueden reanudar**; el runner los rechaza con `config_incompatible` / `engine_behavior_changed` (`paper_runner.py`, comparación del manifiesto) y la continuidad con `pipeline_changed` (`signal_continuity.py`, `freeze`). Hace falta una sesión nueva. Los documentos de ejemplo de `docs/mission-control/b3/` se regeneraron: solo cambian `entry_hash` y `session_id`, derivados del manifiesto.
