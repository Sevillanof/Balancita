# Validación de la captura como fuente paper (Issue #183): diseño y validadores offline

Estado: **parcial**. Hay validadores y pruebas con fixtures sintéticos. No se leyó ninguna captura ni base real, así que la fuente **no está validada**.

Código: `python/balancita_engine/capture_validation.py` (versión `capture-validation.v2`). Pruebas: `python/tests/test_capture_validation.py`.
Base: `main`. No importa el ingestor (#166) ni modifica `quote-archive.ts`, colectores ni `paper_live_ingest.py`: los validadores reciben filas ya cargadas, con la forma de las tablas de la captura en main. Quien cargue una muestra autorizada hace de adaptador y debe sacar `relative_rate` (el `relativeFundingRate` del proveedor) y `product_id` de `raw_response` y de la fila de período; el `funding_rate` guardado solo no muestra la unidad relativa.

## Tres tipos de resultado (nunca se mezclan)

| Tipo              | Significa                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABSENT`          | la captura no tiene el dato donde corresponde, o la muestra no permite medir el criterio (`not_measurable`: no se juzgó ningún registro)       |
| `DISCREPANCY`     | el dato existe pero se contradice o difiere de la referencia                                                                                   |
| `VALIDATOR_ERROR` | la entrada no se pudo juzgar (registro mal formado, producto inesperado, fila que llega al holdout, fila oficial desalineada o contradictoria) |

Cada validador devuelve un `Result` con `findings`, `coverage` (cuántos registros juzgó cada chequeo, por producto esperado) y `events` (hechos que no son defectos, como las reconexiones). Un chequeo que juzgó cero registros de un producto esperado queda como `ABSENT` / `not_measurable`; nunca como éxito silencioso.

## Informe y aptitud

`build_report(sample, results, required)` exige la lista de familias que debieron correr (`funding`, `quotes`, `candles`) y los productos esperados salen de `sample.products`. Una familia o un producto sin cobertura reportada se agrega como `ABSENT` / `validator_not_run`. Aptitud:

- `no_apta`: hay alguna `DISCREPANCY`.
- `bloqueada`: no hay discrepancias, pero hay `ABSENT` o `VALIDATOR_ERROR` (incluye lo no medible y lo no corrido).
- `sin_hallazgos`: todo lo requerido se juzgó y no se encontró nada. No es un aval más allá de los criterios medidos.

El informe lleva la versión del validador, la muestra (fuente, versión, intervalo, productos), la cobertura, los eventos y una huella SHA-256 estable.

## Criterio de #183 → validador → prueba

| Criterio                                | Validador                                                                                                                                                                                            | Pruebas (`test_capture_validation.py`)                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Funding: unidades absolutas y relativas | `validate_funding`: unidad `USD/<BASE>/hour`; relativo × precio contra absoluto con tolerancia relativa (escala con el precio)                                                                       | `test_unit_mismatch…`, `test_relative_vs_absolute…`, `test_tolerance_scales…`                                                            |
| Funding: precio de referencia           | precio del proveedor en o antes del período y no más viejo que `max_reference_age_ms` (2 h por defecto); si no hay, `ABSENT`                                                                         | `test_stale_reference_price…`, `test_future_reference_price…`                                                                            |
| Funding: períodos                       | hora UTC alineada y de 1 h                                                                                                                                                                           | `test_period_must_be_one_aligned_hour`                                                                                                   |
| Funding: publicación                    | con las respuestas del colector: a tiempo si la primera respuesta que lo trae llegó antes de fin + `max_lag_ms`; tarde solo si una respuesta posterior al plazo no lo traía; si no, `not_measurable` | `test_publication_late_is_proven…`, `test_collector_down…`, `test_known_before_period_end…`, `test_backfill_only…`                       |
| Funding: cobertura                      | horas faltantes por cada producto esperado, también si no tiene filas                                                                                                                                | `test_missing_hours…`, `test_no_rows_is_not_measurable…`, `test_expected_product_without_rows…`                                          |
| Funding: revisiones contradictorias     | misma (producto, inicio) con tasas distintas                                                                                                                                                         | `test_contradictory_revisions`, `test_identical_revisions…`                                                                              |
| Cotizaciones: bid/ask e identidad       | falta, no positivo o cruzado; producto fuera de lo esperado                                                                                                                                          | `test_missing_bid_or_ask…`, `test_unexpected_product…`                                                                                   |
| Cotizaciones: timestamps y orden        | diferencia entre recepción y evento; recepción hacia atrás; `seq` que no crece dentro de un epoch (no se exige contigüidad: el ticker REST guarda `seq = received_at`)                               | `test_timestamp_skew_and_order`, `test_seq_must_increase…`, `test_clean_rest_feed…`, `test_contiguous_seq_is_opt_in`                     |
| Cotizaciones: frescura y reconexiones   | silencio inicial, interior y final por encima del límite; un cambio de epoch es un evento de reconexión, no un defecto                                                                               | `test_initial_interior_and_final_silence`, `test_reconnect_is_an_event…`, `test_one_quote_per_product…`, `test_product_with_no_quotes…`  |
| Velas: 5 min contra fuente oficial      | `aggregate_to_five_minutes` + `validate_candles` (UTC, `[inicio, inicio + 5 min)`, tolerancias explícitas y exactas por defecto, revisiones que se pisan reportadas)                                 | `test_aggregation_math`, `test_match_is_clean…`, `test_field_discrepancies…`, `test_conflicting_revisions…`, `test_misaligned_official…` |
| Umbrales 15/25/45 s                     | `calibrate_thresholds`: cuantiles y tasa de falsa alarma por candidato; `rechazado` / `no_rechazado` / `sin_evidencia`; `adopted` siempre `None`                                                     | `test_never_adopts…`, `test_small_sample…`                                                                                               |
| Ausente vs discrepancia vs error        | tipo de `Finding`                                                                                                                                                                                    | `test_malformed_*`, `test_fitness_ladder`                                                                                                |
| Holdout preservado                      | rango rechazado en cada validador y en el informe; filas y velas desde 2026-08-02 UTC se descartan como `VALIDATOR_ERROR` sin copiar sus valores                                                     | `RangeGuardTests`, `test_holdout_rows_and_references…`, `test_holdout_candles_are_dropped`                                               |
| Sin éxito por falta de evidencia        | cobertura por chequeo y producto; informe con lista de familias requeridas                                                                                                                           | `test_report_without_validators…`, `test_required_family…`, `test_expected_product_missing…`, `test_backfill_only…`                      |
| Reproducible                            | huella determinista                                                                                                                                                                                  | `test_fingerprint_is_deterministic…`                                                                                                     |

## Qué mide la publicación del funding y qué no

`known_at` en el almacén es la hora en que **nuestro** colector recibió la respuesta, no la hora en que Kraken publicó. Por eso el retraso se juzga con las respuestas del colector (`responses`), nunca con `known_at`. Además, aparecer en una respuesta no prueba que el período esté terminado: Kraken puede listar la hora abierta (valor provisional, como admite `historical-funding.ts` y distingue #167). Cada respuesta debe traer `final_starts`, los períodos que muestra como definitivos; el adaptador lo toma del proveedor o de #167.

- A tiempo: la primera respuesta que lo muestra **definitivo** llegó antes de `fin + max_lag_ms`.
- Tarde: llegó después del plazo **y** existe una respuesta con evidencia de finalidad, posterior al plazo y anterior a esa, que aún no lo traía definitivo. Un listado provisional no cuenta como publicación.
- Contradictorio: una respuesta tomada antes del fin del período ya lo marca definitivo.
- Provisional: un listado del período sin marcarlo definitivo, o una fila con `provisional: true`, es un evento (`provisional_observation` / `provisional_row`), no un hallazgo ni un conflicto de revisión. Una fila definitiva con `known_at` anterior al fin sigue siendo no causal (falla cerrado si el adaptador no marcó la fila como provisional).
- No medible: el colector no consultó entre el plazo y la primera respuesta definitiva, o las respuestas no traen `final_starts`. No se infiere finalidad por la hora de la respuesta ni se le atribuye nada a Kraken; el informe lo cuenta como `ABSENT` / `not_measurable` con cantidad, primer y último período.
- Un período traído por backfill no es medible.

`max_lag_ms` (1 h por defecto) es un parámetro del validador, no un valor aprobado. Debe declararse en el informe real junto con la cadencia efectiva del colector.

## Cobertura exigida al informe

- Cada `Result` guarda el rango y los parámetros con que corrió. `build_report` compara el rango con el de la muestra: un validador que cubrió menos (por ejemplo 2 h dentro de una muestra de 48 h) agrega `ABSENT` / `partial_range` y el informe sale `bloqueada`. El informe lista los parámetros de cada resultado (familia, productos y valores) y entran a la huella; no se funden entre productos.
- Una fila de funding sin `relative_rate` da `ABSENT` en `funding.relative` (con la cantidad), no se saltea.
- Las respuestas del colector y las cotizaciones que caen en el holdout se descartan como `VALIDATOR_ERROR`; un período que solo se podría probar con ellas queda `not_measurable`. Una respuesta tomada antes del fin del período que ya lo trae es no causal y es `DISCREPANCY`.
- Si la serie oficial trae filas contradictorias para un bucket, ese bucket no se compara (no se culpa a la captura).

## Límite: instante del precio de referencia

No está establecido a qué instante corresponde el precio que Kraken usó para pasar de tasa relativa a absoluta (pendiente abierto de #167). Por eso la tolerancia de `funding.relative_vs_absolute` es `rel_tolerance` más `max_price_drift_per_hour` (1 % por hora, parámetro del validador) por cada hora de antigüedad de la referencia contada hasta el fin del período. Esa comprobación solo detecta desvíos grandes: por debajo de 1 a 3 % no detecta nada. Un factor de unidad como ×8, ×100 o ×1/8 la supera y se marca, pero un precio o una base equivocados que dejen la diferencia dentro de la tolerancia pasan sin hallazgo. En productos de precio muy volátil (por ejemplo HYPE y ZEC) puede dar falsos `no_apta` (falla cerrado); esos casos se leen a mano, no se toman como defecto de la captura. Las tolerancias son fracciones de la magnitud y se rechaza cualquier tolerancia efectiva máxima de 0,5 o más (también las de velas). Un hallazgo ahí no debe leerse como defecto de captura hasta fijar el instante con datos autorizados.

## Lo que estas pruebas NO demuestran

- Nada sobre datos reales: los fixtures son inventados. No se afirma que la captura cumpla ningún criterio.
- La comparación de velas contra la fuente oficial exige que alguien aporte la serie oficial; los validadores no llaman a Kraken. Hasta que Fran lo autorice, es solo el comparador.
- Las cotizaciones del archivo son tope de libro (mejor bid/ask y tamaños), sin profundidad. Cualquier conclusión de ejecución es modelada.
- Los parámetros de los validadores (`max_lag_ms`, `rel_tolerance=0.0001`, `max_price_drift_per_hour=0.01`, `max_reference_age_ms`, `stale_ms`, `skew_ms`, `max_false_alarm_rate=0.001`, `min_samples=1000`) no son criterios aprobados; el informe real debe declararlos y justificarlos.
- La calibración de umbrales supone que las brechas de entrada vienen de intervalos sin caída; esa clasificación la aporta el ingestor (#166), no este módulo.

## Pedido de autorización de lectura (borrador, para que Fran responda en la PR)

- Fuente: solo lectura de la base de mercado de la captura (`dev-live`) y, para velas, de `paper_futures_official_candles` ya almacenada (sin llamadas nuevas a Kraken). Para publicar el funding hacen falta además las respuestas guardadas (`paper_futures_funding_responses`) con su hora de recepción y los períodos que contiene cada una.
- Productos: los 8 `PF_*`, o un subconjunto que Fran indique (propuesta mínima: `PF_XBTUSD` y `PF_ETHUSD`).
- Intervalo: propuesta de 48 h consecutivas dentro de 2025-10-13 → 2026-08-01 (rango ya autorizado para lectura en otras tareas); el rango exacto lo fija Fran. Nunca desde 2026-08-02 (holdout).
- Volumen: unas 48 h de tickers (retención 24 h en el archivo de mercado: puede que el rango real quede limitado por esa retención), 2 880 velas de 1 m y 576 de 5 m por producto, y los períodos y respuestas de funding del rango.
- Propósito: ejecutar estos validadores y producir el informe reproducible de #183. Sin escritura, sin otra captura, sin sesión.
