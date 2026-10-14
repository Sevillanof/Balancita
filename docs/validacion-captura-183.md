# Validación de la captura como fuente paper (Issue #183): diseño y validadores offline

Estado: **parcial**. Hay validadores y pruebas con fixtures sintéticos. No se leyó ninguna captura ni base real, así que la fuente **no está validada**.

Código: `python/balancita_engine/capture_validation.py`. Pruebas: `python/tests/test_capture_validation.py`.
Base: `main`. No importa el ingestor (#166) ni modifica `quote-archive.ts`, colectores ni `paper_live_ingest.py`: los validadores reciben filas ya cargadas, con la forma de las tablas de la captura en main (`paper_futures_funding_periods`, eventos de ticker, velas). Quien cargue una muestra autorizada hace de adaptador.

## Tres tipos de resultado (nunca se mezclan)

| Tipo              | Significa                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `ABSENT`          | la captura no tiene el dato donde corresponde                                                    |
| `DISCREPANCY`     | el dato existe pero se contradice o difiere de la referencia                                     |
| `VALIDATOR_ERROR` | la entrada no se pudo juzgar (registro mal formado, producto fuera de los 8, parámetro inválido) |

Aptitud del informe (`build_report`): `no_apta` si hay alguna `DISCREPANCY`; `bloqueada` si no, pero hay `ABSENT` o `VALIDATOR_ERROR`; `sin_hallazgos` si no hay nada (solo sobre lo medido, no es aval general). El informe lleva `validator_version`, la muestra (fuente, versión, intervalo, productos) y una huella SHA-256 estable.

## Criterio de #183 → validador → prueba

| Criterio                                  | Validador                                                                                                                                        | Pruebas (`test_capture_validation.py`)                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| Funding: unidades absolutas/relativas     | `validate_funding`: unidad `USD/<BASE>/hour`; relativo × precio = absoluto                                                                       | `test_unit_mismatch…`, `test_relative_vs_absolute…`                                                                                           |
| Funding: precio de referencia             | precio del proveedor en o antes del período; sin precio → `ABSENT`                                                                               | `test_relative_without_price_is_absent`                                                                                                       |
| Funding: períodos                         | hora UTC alineada y de 1 h                                                                                                                       | `test_period_must_be_one_aligned_hour`                                                                                                        |
| Funding: publicación                      | `known_at >= fin` (causal); retraso solo en períodos vistos en vivo                                                                              | `test_known_before_period_end…`, `test_late_live_publication…`                                                                                |
| Funding: cobertura                        | horas faltantes por producto                                                                                                                     | `test_missing_hours_are_absent…`                                                                                                              |
| Funding: revisiones contradictorias       | misma (producto, inicio) con tasas distintas                                                                                                     | `test_contradictory_revisions`, `test_identical_revisions…`                                                                                   |
| Cotizaciones: bid/ask, identidad          | falta, no positivo o cruzado; producto fuera de los 8                                                                                            | `test_missing_bid_or_ask…`, `test_identity…`                                                                                                  |
| Cotizaciones: timestamps y orden          |                                                                                                                                                  | recepción − evento                                                                                                                            | ; recepción hacia atrás | `test_timestamp_skew`, `test_arrival_order_backwards` |
| Cotizaciones: frescura, reconexiones      | silencio > límite (interior y final); cambio de epoch; salto de secuencia                                                                        | `test_freshness…`, `test_sequence_gap_and_reconnect`, `test_product_with_no_quotes…`                                                          |
| Velas: agregación 5 min vs fuente oficial | `aggregate_to_five_minutes` + `validate_candles` (UTC, `[inicio, inicio+5 min)`, tolerancias explícitas, exactas por defecto)                    | `test_aggregation_math`, `test_match_is_clean`, `test_field_discrepancies_and_tolerance`, `test_missing_minute…`, `test_official_misaligned…` |
| Umbrales 15/25/45 s                       | `calibrate_thresholds`: cuantiles y tasa de falsa alarma por candidato; `rechazado` / `no_rechazado` / `sin_evidencia`; `adopted` siempre `None` | `test_never_adopts…`, `test_small_sample…`                                                                                                    |
| Ausente vs discrepancia vs error          | tipo de `Finding`                                                                                                                                | `test_malformed_*`, `test_fitness_ladder`                                                                                                     |
| Holdout preservado                        | `assert_range_allowed` en cada validador y en el informe (rechaza rangos que lleguen a 2026-08-02 UTC)                                           | `RangeGuardTests`, `test_sample_must_be_identified…`                                                                                          |
| Reproducible                              | huella determinista                                                                                                                              | `test_fingerprint…`, `test_end_to_end_synthetic_run…`                                                                                         |

## Lo que estas pruebas NO demuestran

- Nada sobre datos reales: los fixtures son inventados. No se afirma que la captura cumpla ningún criterio.
- La comparación de velas contra la fuente oficial exige que alguien aporte la serie oficial; los validadores no llaman a Kraken. Hasta que Fran lo autorice, es solo el comparador.
- `known_at` en el almacén de funding es la hora de recepción. Un período traído por backfill tiene `known_at` muy posterior a su fin, así que su retraso de publicación **no se puede medir**; solo se juzga lo visto casi en vivo. Hay que decidir con la muestra real si eso alcanza.
- Las cotizaciones del archivo son tope de libro (mejor bid/ask y tamaños), sin profundidad. Cualquier conclusión de ejecución es modelada.
- Los umbrales de la calibración (`max_false_alarm_rate=0.001`, `min_samples=1000`) son parámetros del validador, no criterios aprobados; el informe real debe declararlos.
- Si la tasa de falsa alarma sirve como criterio de rechazo depende de que las brechas de entrada provengan de intervalos sin caída; esa clasificación la aporta el ingestor (#166), no este módulo.

## Pedido de autorización de lectura (borrador, para que Fran responda en la PR)

- Fuente: solo lectura de la base de mercado de la captura (`dev-live`) y, para velas, de `paper_futures_official_candles` ya almacenada (sin llamadas nuevas a Kraken).
- Productos: los 8 `PF_*`, o un subconjunto que Fran indique (propuesta mínima: `PF_XBTUSD` y `PF_ETHUSD`).
- Intervalo: propuesta de 48 h consecutivas dentro de 2025-10-13→2026-08-01 (rango ya autorizado para lectura en otras tareas); el rango exacto lo fija Fran. Nunca desde 2026-08-02 (holdout).
- Volumen: unas 48 h de tickers (retención 24 h en el archivo de mercado: puede que el rango real quede limitado por esa retención), 2 880 velas de 1 m y 576 de 5 m por producto, y los períodos de funding del rango.
- Propósito: ejecutar estos validadores y producir el informe reproducible de #183. Sin escritura, sin otra captura, sin sesión.
