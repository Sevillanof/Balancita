# Etapa 10B: ingestor offline sobre una base sintética

Estado: **implementado, offline y aislado**. Código nuevo: `python/balancita_engine/paper_live_ingest.py`, `paper_live_publish.py`, `paper_live_probe.py`; pruebas: `python/tests/test_paper_live_ingest.py`. Diseño de referencia: [etapa-10-integracion-paper-tiempo-real.md](etapa-10-integracion-paper-tiempo-real.md) (PR #150).

Alcance respetado: solo bases **sintéticas** con el esquema que escribe la captura; no se lee la captura real ni ninguna base de la Mac; no hay conexión a Kraken, proceso persistente, reloj de pared dentro de los eventos, ni credenciales. No se modifica `paper_runner.py` (ni ningún módulo existente), no hay evaluador paralelo, no se tocan forward, captura, Kronos, Qwen, estrategias, riesgo, ADR ni frontend.

## 1. Qué hace el ingestor

`Ingestor(SourceReader(ruta)).poll(observed_now_ms)` lee filas nuevas (solo lectura: `mode=ro` + `query_only`) y devuelve eventos en el sobre de `make_event` más el estado de la fuente.

| Origen en la base de la captura                                                  | Evento   | `source_offset`             | `t_ms`                                             |
| -------------------------------------------------------------------------------- | -------- | --------------------------- | -------------------------------------------------- |
| `paper_futures_market_events`, `feed='ticker'`                                   | `quote`  | **`None`**                  | `persisted_at`                                     |
| `paper_futures_official_candles`, 1 min, **primera revisión** (menor `known_at`) | `candle` | `bucket // 60 s` (contiguo) | `max(known_at, bucket + 60 s)`                     |
| generado                                                                         | `clock`  | `None`                      | múltiplo de 5 s, solo con evidencia de fuente viva |

No genera `cycle`: el evaluador de estrategias pertenece a 9A. En las pruebas, los `cycle` los inyecta el propio test con `ScriptedStrategy` (el mismo recurso de las pruebas de 8B). Tampoco genera `funding` todavía: la tabla `paper_futures_funding_periods` no tiene columna de producto (se resuelve con la respuesta que la origina), así que queda para la etapa siguiente.

### Correcciones tras la revisión de Fran (2026-10-14)

1. **Marca de agua y velas tardías.** La marca de agua ya no es solo `max_seen_ms - hold_ms`: mientras la vela de 1 min de un producto esté vencida (su siguiente bucket cerró hace menos de `candle_lag_ms`, 120 s, hipótesis), las cotizaciones no se liberan más allá de ese punto, para que una vela escrita tarde no quede atrás y se descarte como tardía. No retrocede nunca, y una vela que no llega no frena las cotizaciones más allá de `candle_lag_ms`. Límites: solo protege después de ver la primera vela de un producto, y no cubre retrasos mayores que `candle_lag_ms` (esa vela se cuenta como tardía). Pruebas: la vela escrita tarde se conserva; con `candle_lag_ms=0` el mismo caso se pierde (se cuenta tardía); una vela que nunca llega no detiene las cotizaciones.
2. **Primera revisión.** Entre las revisiones leídas antes de la liberación gana la de menor `(known_at, revision_hash)`, sin importar el `rowid`. Si una revisión anterior aparece cuando otra posterior ya salió, no se cambia: se cuenta en `candle_earlier_revision_after_emit`.
3. **Filas ilegibles.** Una fila de ticker que no se puede interpretar no se emite, pero `rejected_sample` guarda `rowid`, `event_id`, producto, `persisted_at`, `content_hash` y un código de motivo (`json_invalid`, `missing_bid_or_ask`, `price_not_decimal`); el conteo es exacto y la muestra está acotada (50).
4. **B3 parcial.** `balancita-paper-session-intervals.v1` declara `contract.complete = false` y `stages_missing = ["signal"]`; cada fila trae `signal: not_available` con la `signal_key`. La etapa `signal` depende del evaluador de 9A.
5. **B5.** `verified` exige `accounting_verified` (cadena, auditoría, informe fresco) **y** evidencia de protección (`observed` u `observed_by_candles`). Una posición con `not_yet_observed` o `unobserved` no es `verified`; los dos campos se publican por separado (`accounting_verified`, `protection_evidence`).

Reglas verificadas por prueba: la vela nunca llega antes de cerrar; la primera revisión gana y las posteriores solo se cuentan (`candle_revisions_seen` / `candle_revisions_differing`); los eventos salen ordenados por `t_ms` aunque vengan de varios productos y tablas, así el runner no registra `out_of_order_event`; una fila que llega por debajo de lo ya liberado **se cuenta y no se emite** (`late_source_rows`, con muestra); releer desde cero es seguro (el runner deduplica); la misma base da los mismos `event_id`; la base fuente no cambia (hash, tamaño y fecha) y no se puede escribir a través del lector.

## 2. Contigüidad de `seq` en tickers (medida)

Medida **sobre el código** y sobre una base sintética escrita como lo hace `ticker-poll.ts`, no sobre la captura real:

- `ticker-poll.ts` escribe `seq = receivedAtMs`, `persistedAt = receivedAtMs` y `epoch = 1 000 000`. Es una marca de tiempo, no un contador: entre filas consecutivas de un producto la diferencia es el intervalo de sondeo (1 000 ms en la prueba), nunca 1.
- El WebSocket declara `sequenceIntegrity: 'monotonic_only_unproven'`.

Conclusión: un `OffsetLedger` basado en `seq` marcaría huecos falsos o ninguno. Los tickers van con `source_offset = None` y se detectan los silencios por tiempo; las velas usan el índice de bucket, contiguo por construcción. Prueba: `test_ticker_seq_is_a_timestamp_not_a_contiguous_counter`.

## 3. Caída de la captura frente a mercado mudo (C5)

Distinción implementada: la fuente está **caída** solo si ningún ticker de ningún producto avanza durante `dead_after_ms` (45 s, el umbral de silencio del vigilante de la captura). Si un producto calla y otros avanzan, es **mercado mudo** de ese producto. La decisión depende solo de las filas y de `observed_now_ms` (lo que pasa quien llama), nunca del reloj de pared dentro de los eventos.

| Escenario (datos sintéticos)                                 | Reloj (`clock`)                                                                                           | Orden pendiente de ETH (decidida a +105 s, ventana hasta +165 s; en el corte corto, a +100 s)                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Caída de la captura de +100 s a +300 s (BTC y ETH sin filas) | solo hasta +145 s (último ticker + 45 s); ningún tick durante la caída; se registra el intervalo de caída | sigue **pendiente** durante la caída; el primer ticker posterior (+300 s) la vence como `no_quote_in_window` |
| ETH callado de +60 s a +300 s con BTC activo                 | sin interrupción, cada 5 s                                                                                | **vence** por `no_quote_in_window` con el reloj en marcha                                                    |
| Corte corto de 26 s (menor que `dead_after_ms`)              | sin interrupción                                                                                          | se llena con el primer ticker posterior al corte, **precio posterior al corte**, dentro de su ventana        |

`classify_expiry(orden, caidas)` rotula, solo por lectura, `expired_during_source_outage` o `no_market_quote` según si la ventana de ejecución se superpone con una caída registrada. El motivo propio del runner (`no_quote_in_window`) no cambia: es la brecha G1 del diseño y su arreglo en el runner (una cancelación `source_stale`) queda a cargo de 9A.

**Decisión de Fran (2026-10-14): D-10-01 = opción B** (cancelar las órdenes pendientes afectadas con `source_stale`), **sin implementar todavía**: requiere definir y probar cómo se detecta la interrupción y un cambio en el runner que coordina únicamente 9A (no se introduce otra vía de cancelación). No afecta posiciones abiertas. El corte de 26 s de la prueba **no** supera `dead_after_ms` (45 s): el ingestor no lo reconoce como caída, así que elegir B no lo resuelve; ese caso sigue siendo una prueba obligatoria y hace falta una señal de frescura y continuidad que no dependa solo de 45 s sin tickers.

**Hallazgo del revisor independiente (D-10-01), confirmado por la prueba del tercer escenario:** con el reloj parado, una orden decidida antes de la caída puede llenarse después con un precio que la decisión no vio. La ventana está acotada en tiempo de cotización (60 s), de modo que nunca se llena más allá de su `deadline`, pero un fill posterior a una interrupción es posible. Por eso «reloj parado» **no es una regla**: es una decisión pendiente de Fran con tres opciones (A reloj parado, B cancelar con `source_stale`, C etiquetar `post_outage` en la capa de informe); ver la §3.3 del documento de diseño.

## 4. Journal de cotizaciones: medido, sin recomendar (C4)

`paper_live_probe.py` mide con una caminata aleatoria sembrada (precios sintéticos, no de Kraken), en este contenedor (disco de CI/nube, no el de la Mac; `fsync` real):

| Política                              | Cotizaciones por día (8 productos) | Bytes por cotización | Journal por día | Replay (recuperación) por día               |
| ------------------------------------- | ---------------------------------- | -------------------- | --------------- | ------------------------------------------- |
| Todas (1 por segundo y producto)      | 691 200                            | 523                  | **≈ 361 MB**    | **≈ 40 s** (1,68 s por hora medida, lineal) |
| Una cada 30 s (solo medida de tamaño) | 23 040                             | 568                  | ≈ 13 MB         | ≈ 2 s                                       |

La recuperación reproduce el estado idéntico (`replay_matches_continuous: true`) en ambas políticas. Las cifras de tiempo de escritura (11,5 s por 28 800 cotizaciones) no se extrapolan a la Mac. **Decisión de Fran: se mantienen todas las cotizaciones en la validación inicial; no se aprueba muestreo cada 5, 10, 30 ni 60 s ni compactación destructiva.** Las cifras son de un entorno de nube con datos sintéticos, no de la Mac: antes de una sesión persistente hay que medir tamaño, recuperación y disco en el entorno previsto. **No se propone muestreo ni compactación**: lo medido es el costo de no reducir (≈ 361 MB por día, replay de decenas de segundos por día de sesión) y, abajo, qué cambia una política más rala.

### Qué cambia una política más rala (fidelidad, 40 caminatas sembradas, 2 h cada una)

Mismas cotizaciones de BTC, volatilidad 2,5 pb/s (para que se alcancen stops y objetivos), una orden de compra a mercado decidida al inicio; «rala» = una cotización cada N segundos (con fase distinta por caminata). Se compara contra la política completa (una por segundo).

| Una cada | Entradas distintas en hora | Entradas con otro precio | Operaciones cerradas en ambas | Motivo de salida distinto | Salida en otra hora | Retraso medio de la salida (s) |
| -------- | -------------------------- | ------------------------ | ----------------------------- | ------------------------- | ------------------- | ------------------------------ |
| 5 s      | 32 de 40                   | 14 de 18                 | 18                            | 0                         | 16 de 18            | 55,8                           |
| 10 s     | 36 de 40                   | 16 de 18                 | 18                            | 0                         | 18 de 18            | 77,7                           |
| 30 s     | 38 de 40                   | 16 de 18                 | 18                            | 0                         | 18 de 18            | 91,1                           |
| 60 s     | 39 de 40                   | 16 de 17                 | 17                            | 0                         | 17 de 17            | 180,7                          |

Lectura, sin recomendar: en este camino sintético el motivo de salida no cambió en ningún caso, pero **la hora de la entrada y casi siempre la de la salida sí cambian incluso con una cotización cada 5 s**, y el retraso medio de la salida crece con el intervalo. El retraso es una media sobre 17-18 pares, sensible a valores extremos (no se calculó la mediana). Esto es lo que habría que pesar frente al ahorro de tamaño de la tabla anterior, con datos reales y una política condicionada (solo con orden pendiente o posición abierta), que no se midió.

Limitaciones de esta medición: precios sintéticos con volatilidad constante; una sola posición BTC; una política «solo con orden pendiente o posición abierta» requiere que el runner avise al ingestor y no se midió aquí; no se midió el tamaño del journal con cotizaciones rechazadas por spread o antigüedad.

## 5. Contratos B3 y B5 (C6), sin tocar el frontend

`paper_live_publish.py` construye, **solo leyendo** el runner (`paper_runner_report.protection`, `decisions`, `integrated_audit`):

- `positions(runner, report_age_ms, max_age_ms)` → `balancita-paper-session-positions.v1`: por posición abierta, lado, estrategia, precio de entrada, stop, objetivo, cobertura del stop, `accounting_verified`, `protection_evidence` y `verified`. `accounting_verified` exige runner procesando, informe fresco, sin obligaciones abiertas y auditoría integrada sin violaciones; `verified` exige además que el stop haya sido vigilado después de la entrada (`observed` u `observed_by_candles`). El P&L no realizado es `estimated`; la posición, `simulated`.
- `intervals(runner, from_ms, to_ms, product)` → `balancita-paper-session-intervals.v1`: decisión → orden → operación por producto e intervalo (contrato **parcial**: la etapa `signal` figura como `not_available`); una etapa inexistente es `none`.
- Ambos llevan `mode = integration`, `evidence_class = not_forward_evidence` y `execution_class = observed_quotes` (nunca `MODELLED_EXECUTION`, que es del replay de 9A).
- B1 (Riesgo): sigue en «sin datos»; solo cambia con una sesión autorizada (ver el documento de diseño, §5.9). No se tocó el gateway.

## 6. Límites y dependencias

- Datos sintéticos y esquema reconstruido a partir del código de la captura: no se verificó contra la base real (no autorizado). La tabla `paper_futures_official_candles` tiene columna de producto desde la migración 5; una base anterior no la tendría.
- Marca de agua de 2 s (`hold_ms`) y 45 s (`dead_after_ms`): hipótesis a probar, no valores aprobados.
- **No es todavía un ingestor funcional completo**: sin `cycle` ni `funding`, que dependen del evaluador y las implementaciones aprobadas de 9A (no se crea un segundo evaluador) y de la correspondencia producto-respuesta de funding.
- Cursores: en esta etapa los pasa quien llama; el ingestor no guarda estado durable. Releer desde cero es seguro.
- Sin proceso persistente ni lectura de la captura real (decisiones 10 y 12 de la auditoría).
