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
  decisión reciente queda como «Sin confirmar», no como actual, y la «Salud de
  la fuente» del producto también pasa a «Sin confirmar» (nunca «Correcto» con
  un reporte viejo, un refresco fallido, sin lectura o anterior a esta conexión;
  misma validación de frescura que protege AHORA: B1 ≤ 90 s, sin error, leído
  en esta conexión).
- `leyenda-marcadores.png`: leyenda visible del gráfico (propuesta LONG/SHORT,
  WAIT agrupados, EJEC. ejecución paper, salida).
- `seleccion-sincronizada.png`: selección entre gráfico, historial y decisiones.
- `marcadores-propuesta-wait-ejecutada.png`: flechas = propuestas LONG/SHORT
  (no son operaciones), círculos grises = WAIT agrupados, cuadrado «EJEC.» =
  un fill durable del gateway (un marcador por fill, con su cantidad). No se enlaza ninguna decisión con una
  operación.

- `marcadores-textos-cortos.png`: marcadores con textos cortos para que no se
  superpongan: propuesta `C25 LONG`, WAIT `W` / `W×n`, ejecución `EJ L` / `EJ S`.
  El texto completo (p. ej. «C25 EJEC. LONG 0.5 BTC», «C25 LONG propuesta»,
  «WAIT ×n») aparece en el gráfico al seleccionar el marcador.
- `hueco-de-velas.png`: hueco sintético en las velas (se quita la vela del
  minuto de una propuesta SHORT). El marcador no se dibuja sobre una vela
  anterior; la decisión sigue en el historial y su detalle dice «no hay vela de
  su minuto en el gráfico (hueco en las velas)». Un evento posterior a la
  última vela tampoco se pega a ella. Se usa el `bucket_start_ms` del veredicto
  (o el minuto de la hora de decisión); la hora real no se reescribe.

Todas las capturas son sintéticas y miden 1440×900 (proyecto desktop-1440x900).
