# Capturas de AHORA y marcadores (1440×900)

Todas las capturas salen de `e2e/terminal-ahora-sync.pw.ts` contra el gateway
real con **datos sintéticos** sembrados por `e2e/support/seed-gateway-engine.ts`
(velas, veredictos y una operación ejecutada inventados para la prueba; no son
mercado ni cuenta reales). Se regeneran con `AHORA_SHOTS_DIR=<carpeta>`.

- `ahora-espera.png`, `ahora-propuesta.png`: AHORA con la última decisión del
  flujo en vivo. Solo se presenta como actual con el WebSocket conectado, el
  reloj del gateway válido y B1 (leído en esta conexión) confirmando el mismo
  veredicto; la «Salud de la fuente» es la del producto en pantalla.
- `ahora-sin-confirmar.png`: B1 sin lectura (503 simulado en la prueba): la
  decisión reciente queda como «Sin confirmar», no como actual.
- `leyenda-marcadores.png`: leyenda visible del gráfico (propuesta LONG/SHORT,
  WAIT agrupados, EJEC. ejecución paper, salida).
- `seleccion-sincronizada.png`: selección entre gráfico, historial y decisiones.
- `marcadores-propuesta-wait-ejecutada.png`: flechas = propuestas LONG/SHORT
  (no son operaciones), círculos grises = WAIT agrupados, cuadrado «EJEC.» =
  un fill durable del gateway (un marcador por fill, con su cantidad). No se enlaza ninguna decisión con una
  operación.

Todas las capturas son sintéticas y miden 1440×900 (proyecto desktop-1440x900).
