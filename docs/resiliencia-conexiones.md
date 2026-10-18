# Resiliencia de conexiones de la captura

Objetivo: que la captura siga funcionando, en paper y con datos públicos, aunque cambie la red (VPN que
se conecta o se desconecta, cambio de interfaz o de ruta, Kraken lento) y sin reiniciar nada a mano.
No depende del nombre de ninguna interfaz ni toca la configuración de la VPN.

## Qué hace cada mecanismo

| Situación                                                                     | Mecanismo                                                                                                                                                                                                                                                                                         | Dónde                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WebSocket abierto pero mudo (nunca llegó el primer mensaje, o dejó de llegar) | Vigilante propio, en un temporizador independiente de los mensajes: sin ninguna trama durante 30 s, cierra el socket y reconecta con espera progresiva                                                                                                                                            | `futures-market.ts`                                             |
| WebSocket que recibe latidos pero ya no entrega datos                         | Dos controles independientes: los latidos prueban el enlace; el ticker (y el libro, si se usa) prueban la suscripción. Sin ticker durante 45 s se reconecta (`feed_silent`). Las operaciones no cuentan: tienen silencios legítimos                                                               | `futures-market.ts`                                             |
| Conexión que no llega a abrirse                                               | Plazo de 15 s; se abandona y se reintenta                                                                                                                                                                                                                                                         | `futures-market.ts`                                             |
| Petición REST colgada                                                         | Se aborta al vencer el plazo del sondeo y el siguiente sondeo se arma de nuevo. El cliente de velas y el de analítica ya no quedan cerrados para siempre tras abortar                                                                                                                             | `live-capture.ts`, `official-candles.ts`, `market-analytics.ts` |
| Conexión HTTP muerta en el pool                                               | Tras un fallo, y mientras dure un problema general, las peticiones usan un transporte propio (`fresh-fetch.ts`, `node:http(s)` con `agent: false` y `Connection: close`): abre su conexión y la cierra, sin tocar el pool de `fetch`. Vuelve al transporte normal con la primera petición exitosa | `fresh-fetch.ts`, `ticker-poll.ts`, `official-candles.ts`       |
| Un producto lento bloquea a los demás                                         | Presupuesto de 45 s y rotación de series (#115)                                                                                                                                                                                                                                                   | `live-capture.ts`                                               |
| Fallo simultáneo de varias fuentes (3 o más en 60 s)                          | Se declara problema general. Solo si el WebSocket además lleva más de 10 s sin datos se reemplaza, como máximo una vez cada 5 s. Un WebSocket sano no se toca y no se reinicia ninguna otra conexión                                                                                              | `connection-health.ts`, `live-capture.ts`                       |
| Datos atrasados en el forward                                                 | Una vela conocida más de 15 s después de cerrar (`late_candle_tolerance_ms`) nunca da operaciones en vivo: se simula y queda `recovered`. La compuerta que bloquea entradas (apagada) usa la misma tolerancia                                                                                     | `futures_forward.py`                                            |
| Operaciones calculadas con velas recuperadas                                  | Siguen marcándose `recovered` y se informan aparte                                                                                                                                                                                                                                                | `futures_forward.py`                                            |

## Registro de incidentes

`resilience.jsonl`, junto a la base de mercado (`~/balancita-data.noindex/...`). Una línea JSON por evento:
`at`, `component` (`websocket`, `rest-tickers`, `rest-candles`, `rest-analytics`), `product`, `reason`
(`silent_socket`, `connect_timeout`, `poll_stuck`, `general_incident`, mensaje del error), `action` y
`result` (`recovering` o `recovered`). Se escribe también en el log de `pnpm dev`.

## Puerta de frescura del forward

- Se decide por producto y con el instante en que la vela estuvo realmente disponible (`known_at`), no con la
  hora de la vela.
- Una entrada nueva solo se permite si la vela de 1 minuto que la dispara **y la última vela de 5 minutos
  cerrada existen** y cada una se supo como máximo 15 s (`LATE_KNOWN_MS`, `late_candle_tolerance_ms`) después de cerrar. Si falta la
  de 5 minutos se bloquea aunque las de 1 minuto lleguen puntuales (el simulador arrastraría los últimos
  indicadores de 5 minutos).
- La puerta rige desde la primera pasada con este código (`forward_policy.stale_gate_from_ms`, se escribe una
  vez y no se mueve). Las operaciones guardadas antes conservan la regla anterior y su etiqueta `recovered`, así
  que no hay operaciones nuevas "divergentes".
- `stale_cycles` cuenta los ciclos con la puerta cerrada. `blocked_stale_entries` cuenta solo las señales que la
  estrategia habría abierto y se rechazaron; esas quedan en `forward_blocked` (solo se agrega).
- No se inventan ejecuciones: lo que no se pudo decidir con datos frescos no se decide después.

## Qué no cambia

Estrategias, parámetros, contabilidad, Qwen, Kronos, el ADR 0001 y el piloto del libro.
No hay una segunda infraestructura de conexiones: son cambios sobre los componentes existentes más un
registro compartido de incidentes (`connection-health.ts`) que no abre ni cierra conexiones por sí mismo.

## Pruebas

- Vigilante: socket mudo tras abrir, mudo sin ningún mensaje, que nunca abre, con latidos, parada limpia.
- Integración (`live-capture.test.ts`, "connectivity change"): la red cambia con los sockets abiertos, el
  WebSocket queda mudo y REST se cuelga; se detecta, se reconecta, se registra y todo se recupera solo.
  Además: un fallo general reemplaza un socket mudo; con solo REST roto no se toca un socket sano.
- Forward: la puerta bloquea solo velas atrasadas, no toca posiciones abiertas, no duplica al repetir la
  pasada y no actúa sobre lo anterior a su activación.

## Prueba controlada en la Mac (pendiente)

Con GlobalProtect conectado, desconectado, y conectándolo y desconectándolo mientras Balancita funciona,
mirando `resilience.jsonl`, `data_gaps` y `blocked_stale_entries`. El registrador `netwatch` ya anota los
cambios de ruta.

## Limitaciones declaradas

- Los 3 errores de Python (fixtures de noticias borrados en #86) y los 3 archivos de Vitest que no cargan aquí
  (`ws` y `fastify` ausentes en este entorno) ya existían: no se puede afirmar que toda la suite esté verde.
- Los 45 s de silencio de datos y los 30 s de silencio de tramas son valores iniciales para PF_XBTUSD, cuyo
  ticker llega varias veces por segundo; se revisan con `resilience.jsonl` tras la prueba controlada.
