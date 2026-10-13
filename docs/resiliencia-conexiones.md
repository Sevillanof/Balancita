# Resiliencia de conexiones de la captura

Objetivo: que la captura siga funcionando, en paper y con datos públicos, aunque cambie la red (VPN que
se conecta o se desconecta, cambio de interfaz o de ruta, Kraken lento) y sin reiniciar nada a mano.
No depende del nombre de ninguna interfaz ni toca la configuración de la VPN.

## Qué hace cada mecanismo

| Situación | Mecanismo | Dónde |
|---|---|---|
| WebSocket abierto pero mudo (nunca llegó el primer mensaje, o dejó de llegar) | Vigilante propio, en un temporizador independiente de los mensajes: sin ninguna trama (latidos incluidos) durante 30 s, cierra el socket y reconecta con espera progresiva | `futures-market.ts` |
| Conexión que no llega a abrirse | Plazo de 15 s; se abandona y se reintenta | `futures-market.ts` |
| Petición REST colgada | Se aborta al vencer el plazo del sondeo y el siguiente sondeo se arma de nuevo. El cliente de velas y el de analítica ya no quedan cerrados para siempre tras abortar | `live-capture.ts`, `official-candles.ts`, `market-analytics.ts` |
| Conexión HTTP muerta en el pool | Tras un fallo, las peticiones siguientes llevan `connection: close` hasta que una tiene éxito; también durante un problema general | `ticker-poll.ts`, `official-candles.ts` |
| Un producto lento bloquea a los demás | Presupuesto de 45 s y rotación de series (#115) | `live-capture.ts` |
| Fallo simultáneo de varias fuentes (3 o más en 60 s) | Se declara problema general. Solo si el WebSocket además lleva más de 10 s sin datos se reemplaza, como máximo una vez cada 5 s. Un WebSocket sano no se toca y no se reinicia ninguna otra conexión | `connection-health.ts`, `live-capture.ts` |
| Datos atrasados en el forward | Una vela conocida más de 3 min después de cerrar no abre entradas nuevas. Las posiciones abiertas se siguen gestionando | `futures_forward.py` |
| Operaciones calculadas con velas recuperadas | Siguen marcándose `recovered` y se informan aparte | `futures_forward.py` |

## Registro de incidentes

`resilience.jsonl`, junto a la base de mercado (`~/balancita-data.noindex/...`). Una línea JSON por evento:
`at`, `component` (`websocket`, `rest-tickers`, `rest-candles`, `rest-analytics`), `product`, `reason`
(`silent_socket`, `connect_timeout`, `poll_stuck`, `general_incident`, mensaje del error), `action` y
`result` (`recovering` o `recovered`). Se escribe también en el log de `pnpm dev`.

## Puerta de frescura del forward

- Se decide por producto y con el instante en que la vela estuvo realmente disponible (`known_at`), no con la
  hora de la vela.
- Una entrada nueva solo se bloquea si la vela de 1 minuto que la dispara, o la última de 5 minutos cerrada,
  se supo más de 3 minutos (`STALE_ENTRY_MS`) después de cerrar.
- La puerta rige desde la primera pasada con este código (`forward_policy.stale_gate_from_ms`, se escribe una
  vez y no se mueve). Las operaciones guardadas antes conservan la regla anterior y su etiqueta `recovered`, así
  que no hay operaciones nuevas "divergentes".
- Las entradas bloqueadas quedan en `forward_blocked` (solo se agrega) y cuentan en
  `blocked_stale_entries` del estado y del resumen.
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
