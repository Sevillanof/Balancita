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

| Verificación | Regla                                                                                                                                                                                                                                      | Código si falla                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Producto     | solo `PF_<BASE>USD`; la unidad es `USD/<BASE>/hour` (`XBT` es `BTC`)                                                                                                                                                                       | `unsupported_product`                                                 |
| Unidades     | el runner devenga `relativeFundingRate` (fracción del nocional por hora). El `fundingRate` absoluto (`USD/<BASE>/hour`) nunca se convierte ni se emite. Con un precio de referencia, `absoluto / relativo` debe estar a menos de 5 % de él | `unit_mismatch`                                                       |
| Signo        | positivo: paga el largo y cobra el corto (`Book._funding`). El adaptador no invierte signos                                                                                                                                                | (prueba: 100 USD x 0,0001 = 0,01 USD pagado por un largo)             |
| Período      | una hora, inicio en hora exacta, UTC, no posterior a `serverTime`                                                                                                                                                                          | `period_not_hour_aligned`, `timestamp_not_utc`, `period_future_dated` |
| Magnitud     | `abs(relativo) <= 0,01` por hora (hipótesis); se rechaza, no se recorta                                                                                                                                                                    | `rate_out_of_bounds`                                                  |
| Formato      | números JSON, decimales exactos (nunca pasan por float)                                                                                                                                                                                    | `rate_not_a_number`                                                   |
| Publicación  | solo es definitivo un período que terminó al menos 10 minutos antes de `serverTime` (hipótesis, el mismo `FUNDING_LAG_MS` del replay); la hora en curso es provisional y no se emite                                                       | `not_settled_at_server_time`, `not_settled_at_receipt`                |
| Conciliación | primero visto gana. Misma tasa: duplicado. Otra tasa para un período ya conocido, o dos tasas para un período dentro de una respuesta: cuarentena, no se aplica ninguna y queda la evidencia                                               | `revision_conflict`, `conflict_inside_response`                       |

Una respuesta que no es de funding (JSON inválido, `result` distinto de `success`, `serverTime` ilegible) lanza
`FundingAdapterError` con su código.

## 3. Cómo llega al runner

`FundingBook.add(parse_response(...))` devuelve un evento `funding` por producto y respuesta, con los períodos ordenados. El
tiempo del evento es la llegada de la respuesta (`received_at`), nunca anterior al fin del período, porque
`ingest_funding` rechaza un período que termina en el futuro (`not_settled`). El runner decide, como siempre: un período idéntico
es duplicado, uno contradictorio entra en cuarentena y marca los trades afectados, y `reconcile_funding` recalcula siempre
desde los períodos, sin acumular.

`compare_with_portfolio(book, portfolio.funding)` devuelve `missing`, `extra` y `rate_differs`. Con los tres vacíos, lo que el
adaptador aceptó y lo que el portafolio tiene como funding conocido coinciden. Las pruebas lo verifican con un `PaperRunner`
real, incluyendo la redelivery (el runner responde `duplicate` y el digest financiero no cambia) y una revisión contradictoria
que llegara por otro camino (el runner la pone en cuarentena y el primer valor sigue).

`FundingBook` es durable (`state` y `from_state` en JSON): tras un reinicio no repite un evento ni olvida una cuarentena.

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
