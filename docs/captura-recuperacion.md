# Captura: una sola regla de recuperación (velas y funding)

**Regla.** Al (re)arrancar la captura o al volver la conexión, lo último ya registrado es el punto de partida. Todo lo que falta desde ahí hasta ahora se pide a Kraken por REST y se **registra con la hora real en que Balancita lo recibió**. Nunca se altera lo que Kraken envió: solo se anota qué llegó y cuándo. Todo es append-only (disparadores existentes), con el cerrojo de escritor único y sin reescribir filas ni cuerpos guardados.

Ayudante común: `server/src/features/kraken-futures/recovery-cursor.ts` (`recoveryFrom(últimoRegistrado, ahora, retroceso)`: el último registrado manda, y nunca se retrocede más que el tope; `needsFundingSighting`: la regla pura de qué período se avista).

## Velas

`live-capture.ts` (velas oficiales): el punto de partida es el último `bucket_start` guardado por producto e intervalo; sin registro, el retroceso propio de cada intervalo. Se piden ventanas hasta llegar a ahora (`known_at` = recepción) y la reparación de 10 días de `capture-main.ts` sigue igual. Sin cambios de comportamiento.

## Funding

`FuturesMarketStore.recordFundingPoll`, en cada sondeo correcto de cada producto:

- **Punto de partida (cursor):** el último período del producto con un avistamiento posterior a su cierre (consulta indexada por la clave primaria de `paper_futures_funding_sightings`, recorrida desde el más reciente; sin índice nuevo). Cada sondeo avista los períodos cerrados **posteriores al cursor**: normalmente solo la hora que acaba de cerrar; tras apagar el Mac, solo las horas apagadas, incluida la que estaba abierta al apagar (ya listada con la misma tasa, por lo que `periods` no escribe fila nueva), con la hora de ese arranque.
- **Revisiones:** las últimas 2 h se avistan de nuevo en cada sondeo (una revisión de tasa aparece como otro avistamiento del mismo período). Está acotado a 2 h: el coste es proporcional a lo que falta, no a la ventana de 32 días.
- **Carga atrasada, una sola vez por producto y base:** la primera vez que esta versión sondea un producto se hace un único barrido acotado de los huecos antiguos dentro del tope. Queda anotado en `paper_futures_funding_backlog(product_id, done_at)` (tabla aditiva, append-only con disparadores; no es una migración numerada). Nunca se repite, ni en sondeos posteriores ni tras reiniciar. Un sondeo fallido no la consume. Los huecos anteriores al cursor no se vuelven a barrer después.
- **Tope:** 32 días (`FUNDING_RECOVERY_LOOKBACK_MS`: ventana de 30 días del cargador + 2 de margen) y, de hecho, lo que Kraken devuelva. La carga atrasada registra con la hora real de esa ejecución (es cuando Balancita la verificó).
- No se guardan cuerpos extra: `extract_text` contiene solo los períodos realmente avistados en ese sondeo.
- Por producto: cada producto tiene sus propios avistamientos y su propio punto de partida. El período abierto nunca se avista.
- Un sondeo fallido no escribe avistamientos; el siguiente sondeo correcto recupera el hueco (desconexión sin reinicio).

El cargador (`futures_funding_context.load_periods_detailed`) no cambia: toma el primer avistamiento posterior al cierre como `known_at`. Ver `docs/funding-causal.md`.
