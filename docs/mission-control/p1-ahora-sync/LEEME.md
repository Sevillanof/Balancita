# Capturas de AHORA y marcadores (1440×900)

Todas las capturas salen de `e2e/terminal-ahora-sync.pw.ts` contra el gateway
real con **datos sintéticos** sembrados por `e2e/support/seed-gateway-engine.ts`
(velas, veredictos y una operación ejecutada inventados para la prueba; no son
mercado ni cuenta reales). Se regeneran con `AHORA_SHOTS_DIR=<carpeta>`.

- `ahora-espera.png`, `ahora-propuesta.png`: AHORA con la última decisión del
  flujo en vivo (hora del servidor, B1 confirmando el veredicto).
- `seleccion-sincronizada.png`: selección entre gráfico, historial y decisiones.
- `marcadores-propuesta-wait-ejecutada.png`: flechas = propuestas LONG/SHORT
  (no son operaciones), círculos grises = WAIT agrupados, cuadrado «EJEC.» =
  operación realmente ejecutada en D. No se enlaza ninguna decisión con una
  operación.
