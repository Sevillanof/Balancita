# Captura: una sola regla de recuperación (velas y funding)

**Regla.** Al (re)arrancar la captura o al volver la conexión, lo último ya registrado es el punto de partida. Todo lo que falta desde ahí hasta ahora se pide a Kraken por REST y se **registra con la hora real en que Balancita lo recibió**. Nunca se altera lo que Kraken envió: solo se anota qué llegó y cuándo. Todo es append-only (disparadores existentes), con el cerrojo de escritor único y sin reescribir filas ni cuerpos guardados.

Ayudante común: `server/src/features/kraken-futures/recovery-cursor.ts` (`recoveryFrom(últimoRegistrado, ahora, retroceso)`: el último registrado manda, y nunca se retrocede más que el tope).

## Velas

`live-capture.ts` (velas oficiales): el punto de partida es el último `bucket_start` guardado por producto e intervalo; sin registro, el retroceso propio de cada intervalo. Se piden ventanas hasta llegar a ahora (`known_at` = recepción) y la reparación de 10 días de `capture-main.ts` sigue igual. Sin cambios de comportamiento.

## Funding

`FuturesMarketStore.recordFundingPoll`, en cada sondeo correcto de cada producto:

- Se escribe un avistamiento (`received_at` = hora real de recepción de ese sondeo) por **cada período cerrado** de la respuesta que **no tenga aún un avistamiento posterior a su cierre**, no solo los de las últimas 2 h. Así la hora que estaba abierta al apagar (ya listada con la misma tasa, por lo que `periods` no escribe fila nueva) y todas las apagadas quedan vistas al volver, con la hora de ese arranque.
- Las últimas 2 h se siguen avistando en cada sondeo (una revisión de tasa aparece como otro avistamiento del mismo período); las más antiguas se avistan una sola vez.
- **Tope:** 32 días (`FUNDING_RECOVERY_LOOKBACK_MS`: ventana de 30 días del cargador + 2 de margen) y, de hecho, lo que Kraken devuelva. Una primera ejecución sobre una base antigua registra la carga pendiente una vez, con la hora real de esa ejecución (es cuando Balancita la verificó).
- Por producto: cada producto tiene sus propios avistamientos y su propio punto de partida. El período abierto nunca se avista.
- Un sondeo fallido no escribe avistamientos; el siguiente sondeo correcto recupera el hueco (desconexión sin reinicio).

El cargador (`futures_funding_context.load_periods_detailed`) no cambia: toma el primer avistamiento posterior al cierre como `known_at`. Ver `docs/funding-causal.md`.
