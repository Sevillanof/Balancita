# Etapa 10: adaptador de funding contable (D-10C-4)

Estado: diseño con un adaptador puro y probado con respuestas sintéticas. No conecta endpoints, no lee la captura ni
ninguna base, no modifica `paper_runner.py` ni el mecanismo contable. Los umbrales son hipótesis a validar.

## 1. Dos canales que no se mezclan

| Canal                | Qué es                                              | Quién lo consume                                         | Por dónde entra              |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| Funding para señales | La serie que C32 usa para su percentil              | `LiveEvaluator.feed_funding`                             | no pasa por este módulo      |
| Funding devengado    | Las tasas definitivas que una posición paga o cobra | `portfolio_funding.ingest_funding` y `reconcile_funding` | eventos `funding` del runner |

El adaptador solo produce eventos `funding` (fuente `kraken-funding-definitive`, flujo `funding:<producto>`). No importa el
evaluador y no tiene forma de alimentar el percentil. En la sesión de integración (10D) cada canal tiene su tabla y su
cursor, y esa separación sigue igual.

## 2. Qué se verifica, y con qué código

| Verificación | Regla                                                                                                                                                                                                                                                                                                                                                                                                                        | Código si falla                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Producto     | solo `PF_<BASE>USD`; la unidad es `USD/<BASE>/hour` (`XBT` es `BTC`)                                                                                                                                                                                                                                                                                                                                                         | `unsupported_product`                                                 |
| Unidades     | el runner devenga `relativeFundingRate` (fracción del nocional por hora). El `fundingRate` absoluto (`USD/<BASE>/hour`) nunca se convierte ni se emite. Con un precio de referencia, `absoluto / relativo` debe estar a menos de 5 % de él                                                                                                                                                                                   | `unit_mismatch`                                                       |
| Signo        | positivo: paga el largo y cobra el corto (`Book._funding`). El adaptador no invierte signos                                                                                                                                                                                                                                                                                                                                  | (prueba: 100 USD x 0,0001 = 0,01 USD pagado por un largo)             |
| Período      | una hora, inicio en hora exacta, UTC, no posterior a `serverTime`                                                                                                                                                                                                                                                                                                                                                            | `period_not_hour_aligned`, `timestamp_not_utc`, `period_future_dated` |
| Magnitud     | `abs(relativo) <= 0,01` por hora (hipótesis); se rechaza, no se recorta                                                                                                                                                                                                                                                                                                                                                      | `rate_out_of_bounds`                                                  |
| Formato      | números JSON, decimales exactos (nunca pasan por float)                                                                                                                                                                                                                                                                                                                                                                      | `rate_not_a_number`                                                   |
| Publicación  | solo es definitivo un período que terminó al menos 10 minutos antes de `serverTime` (hipótesis, el mismo `FUNDING_LAG_MS` del replay); la hora en curso es provisional y no se emite                                                                                                                                                                                                                                         | `not_settled_at_server_time`, `not_settled_at_receipt`                |
| Conciliación | el primero visto sigue en uso. Misma tasa: duplicado. Otra tasa para un período ya conocido, o dos tasas para un período dentro de una respuesta: el período contradictorio también se entrega al runner, cuyo `ingest_funding` lo pone en cuarentena (`portfolio.funding_conflicts`) y marca los trades que solapa; el adaptador no acepta ninguna tasa de una contradicción dentro de una respuesta y no cambia una en uso | `revision_conflict`, `conflict_inside_response`                       |

Una respuesta que no es de funding (JSON inválido, `result` distinto de `success`, `serverTime` ilegible) lanza
`FundingAdapterError` con su código.

## 3. Cómo llega al runner

`FundingBook.add(parse_response(...))` devuelve un evento `funding` por producto y respuesta, con los períodos ordenados. El
tiempo del evento es la llegada de la respuesta (`received_at`), nunca anterior al fin del período, porque
`ingest_funding` rechaza un período que termina en el futuro (`not_settled`). El runner decide, como siempre: un período idéntico
es duplicado, uno contradictorio entra en cuarentena y marca los trades afectados (el adaptador se lo entrega para que pase), y `reconcile_funding` recalcula siempre
desde los períodos, sin acumular.

`compare_with_portfolio(book, portfolio.funding)` devuelve `missing`, `extra` y `rate_differs`. Con los tres vacíos, lo que el
adaptador aceptó y lo que el portafolio tiene como funding conocido coinciden. Las pruebas lo verifican con un `PaperRunner`
real, incluyendo la redelivery (el runner responde `duplicate` y el digest financiero no cambia) una revisión contradictoria
(el runner la pone en cuarentena, marca el conflicto en el portafolio y el primer valor sigue en uso) y una contradicción dentro de
una respuesta (el runner no usa ninguna de las dos).

`FundingBook` es durable (`state` y `from_state` en JSON): tras un reinicio no repite un evento ni olvida una cuarentena.

## 3 bis. Modo estricto para datos reales

`parse_response(..., reference_price=f, stored_product_id=p)` es estricto por defecto (D-10F-06) y lo exige con datos reales (D-10F-02). Las pruebas sintéticas lo desactivan con `strict=False`.
El producto no figura en el cuerpo de la respuesta: lo declara la fila guardada (`paper_futures_funding_periods.product_id` de
ese `sha256`) y debe coincidir con el pedido (`product_mismatch`). Cada hora necesita un precio de referencia
(`reference_price_required`, `reference_price_missing`), porque `absoluto / relativo` cercano al precio es lo que detecta un producto o
una unidad cruzados; una tasa relativa cero con tasa absoluta distinta de cero también se rechaza (`unit_mismatch`). Las
tolerancias (5 %, 1 % por hora) y el desfase de 10 minutos son hipótesis sin validar con datos reales.

La publicación se decide antes de buscar contradicciones (D-10F-05): una hora todavía en curso con dos tasas es provisional, no se pone en cuarentena para siempre y no genera un evento fechado después de su llegada. Solo las horas definitivas pueden contradecirse.

Las contradicciones dentro de una respuesta se cuentan aparte (`conflict_inside_response`) y no en `rejected` (D-10F-03).

## 4. Lo que el adaptador no resuelve (a validar antes de usar datos reales)

1. **Dos columnas distintas en la captura.** La tabla `paper_futures_funding_periods` guarda `funding_rate`, el valor
   **absoluto** (`USD/<BASE>/hour`), mientras el lado Python (`futures_funding_context.periods_from_responses`, `replay_data`)
   lee `relativeFundingRate` del cuerpo de la respuesta. Cualquier lector de esa tabla que tome `funding_rate` como fracción
   por hora se equivocaría por el precio. Este adaptador lee solo el cuerpo y verifica la relación con un precio.
2. **Relación absoluto/relativo.** Se asume `relativo = absoluto / precio de referencia` (la verificación de unidades depende de
   eso). Falta confirmarlo contra respuestas reales y decidir qué precio de referencia se usa por hora (propuesta: el cierre
   de la vela de 1 minuto de la hora, ya presente en la integración).
3. **Qué tan rápido se vuelve definitivo un período** y si Kraken revisa tasas ya publicadas. Hoy: 10 minutos y primero visto
   gana, ambos hipótesis. La captura puede traer la misma hora en respuestas distintas con distinta tasa; eso queda como
   `revision_conflict`, no se resuelve en silencio.
4. **Cobertura.** Una hora sin respuesta definitiva no tiene funding. El runner ya trata el tiempo sin cubrir como incompleto
   (`reconcile_funding` solo actúa cuando la cobertura crece); esto no lo cambia.
5. **Fuente de las respuestas.** Se propone leer `paper_futures_funding_responses` (`sha256`, `received_at`, `raw_response`)
   con el lector incremental de 9A, nunca con `load_periods` ni `json_each`, y solo con una autorización explícita para leer
   esa base. Este PR no la lee.

## 5. Integración propuesta con 10D (no incluida)

La tabla sintética `synthetic_accrual` de la sesión de integración se reemplazaría por una fuente que entregue
`(received_at, raw_response, product_id)`; la sesión llamaría a `parse_response` y `FundingBook.add` y entregaría los eventos al
runner, guardando `FundingBook.state()` en su checkpoint y cada elemento de `evidence` en el diario de auditoría. Hasta que
Fran autorice leer datos reales, la fuente sigue siendo sintética.

## Divergencia interna entre el libro y la cartera (BAL-DECISION-184-01)

Si el libro de funding que aceptó el adaptador y el funding que la cartera tiene como conocido difieren sin explicación, la sesión
**se para** (`HALTED`, motivo `funding_book_diverged`): es la conducta por defecto. La evidencia (`funding_book_diverged` en
`audit.jsonl`, con lo que falta, sobra o difiere) queda escrita antes de parar. `funding_report()` marca el P&L como no verificado
(`pnl_verified: false`, `unverified_reasons`) y lo sigue marcando tras recuperar, porque la evidencia es durable. Se recupera el
directorio desde su último checkpoint, a mano; nada reinicia solo y ningún período se cobra dos veces. No se reescribe ni se cuadra
ningún diario ni se elige qué registro es el correcto. `alert` (seguir) queda solo como opción de biblioteca para pruebas.
Esto no cierra #184: depende de la verificación independiente.
