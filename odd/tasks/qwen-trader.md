# qwen-trader

## Operaciones visuales de Terminal (2026-10-31)

**El gráfico lee las operaciones reales del libro, sin operar ni modificar la cuenta.**
La ficha, las etiquetas y el historial de operaciones comparten una única lectura.
La selección de una operación es independiente de la selección de una señal del motor.

| Elemento                   | Significado                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ▲ LONG / ▼ SHORT           | Dirección registrada, con una etiqueta visible y un punto en el precio ejecutado. No se sustituye el fill por el cierre de una vela.                                         |
| Línea azul                 | Precio de entrada fijo; termina en el último dato de mercado mientras está abierta y se congela en la hora exacta de cierre después.                                         |
| × / ● y neto               | Cierre ejecutado o marca registrada. El color del resultado usa `net_usd`, no la dirección ni una cuenta de PnL en JavaScript. La ficha muestra la hora UTC de la marca.     |
| Incompleto / sin confirmar | Funding incompleto es provisional; un fallo de lectura conserva el último dato, gris y sin confirmar. Nunca se transforma en una posición cerrada o una ganancia confirmada. |
| Entrada anterior           | La entrada queda fuera del tramo visible; no se inventa un fill en la primera vela. «Centrar operación» permite ver su período, si hay historia disponible.                  |
| Noticias                   | La columna muestra importancia Baja, Media o Alta, con fechas, procedencia, vigencia y permisos. El conteo de análisis pendientes/incompletos permanece visible.             |

El layout usa las utilidades y los tokens de Tailwind existentes. La altura del gráfico
no depende del espacio que dejan los controles en una ventana baja. Los intervalos,
paneles e indicadores anteriores siguen disponibles; las señales se consultan en
«Historial de señales». Las etiquetas de un giro se separan sin mover sus puntos de ejecución.

La API de lectura `terminal/chart` conserva el límite normal de 500 velas y acepta
`limit` entero entre 1 y 5.000. Terminal solicita historia pública local suficiente para
las operaciones cargadas, mezcla las velas oficiales con el tramo vivo y mantiene los
huecos como huecos. No agrega velas ficticias ni consulta otra cuenta. Al recargar el
servidor de lectura se cierran sus sockets antes del HTTP; el operador paper es otro
proceso y no se reinicia. Cambiar el gráfico, centrar o seleccionar no cambia cantidad,
capital, comisiones, funding, modelos ni reglas.

## Mantenimiento de calidad (Sonar)

La simplificación de validadores, noticias, cuenta y replay no cambia reglas,
coeficientes, comisiones, modelos de funding ni configuraciones activas. Los
tests de opiniones de velas habilitan explícitamente su modo legacy; los tests
del modo noticias siguen comprobando que no hay consultas de precios al modelo.

La caché identifica el producto por su archivo: `CandleCache.read` recibe solo
resolución y fechas. `book_trades` devuelve siempre operaciones, cantidad de
posiciones abiertas y detalle de traza (o `None`), sin alterar su liquidación.
Las fixtures de la API comparten una base explícita, no métodos copiados que
ocultan sus atributos al comprobador de tipos.

El azar de `random_entries_means` sigue siendo determinista y exclusivo de la
comparación estadística. No genera claves, tokens ni identificadores de seguridad.
Se conserva su semilla y distribución; su hotspot de Sonar requiere revisión,
no cambiar las simulaciones para ocultar el aviso.

## Ciclo de vida corregido (2026-10-31)

**Qwen solo analiza noticias. La cuenta no se reinicia y el flujo nuevo espera el cierre normal
de la posición abierta.** La recarga controlada conservó la operación SHORT #2, sus
cantidades y entrada, el saldo realizado de 1.011,580721517012049534635019 USD,
las 137 decisiones anteriores y cero errores nuevos del operador.

| Superficie             | Comportamiento comprobado                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opiniones de velas     | El interruptor `runtime.opinion_enabled = false` no altera el hash de las reglas activas. No hay consultas de salud, opiniones ni ejemplos de aprendizaje de precios. El trabajador genérico existente queda inactivo; un supervisor nuevo ya no lo inicia.                                        |
| Noticias en pantalla   | El color expresa alcista/bajista, no ganancias. El `✓` significa aval de la señal. Relevancia no se presenta como probabilidad de éxito. Se muestran pendientes, análisis incompletos, fallidos, descartados, vencidos y datos sin confirmar. Las fechas se etiquetan UTC.                         |
| Procedencia y vigencia | La API solo usa clasificaciones ETH v2, informa tiempos de recepción y análisis y no inventa licencias `public_rss`. La vigencia y habilitación vienen de la política publicada por el operador, no de otra regla de entrada escrita en JavaScript.                                                |
| Colector N             | Registra cada fuente y descarga en tablas append-only, incluidas respuestas sin novedades y fallos. La recepción se toma después de recibir el cuerpo HTTP; no al comenzar el poll. Las 1.438 clasificaciones anteriores quedaron intactas.                                                        |
| Mercado                | Los huecos internos de caché se vuelven a pedir con reparaciones acotadas. Las velas generadas se marcan como no observadas: no abren, cierran ni marcan posiciones. Las velas reales siguen aplicando las salidas de seguridad. Los expertos esperan la reparación y reconstrucción de sus datos. |
| Salud                  | Un latido no confirma precios. El operador publica último dato observado, huecos, retrasos y errores; la Terminal los muestra explícitamente.                                                                                                                                                      |
| Estrategia             | Las pruebas nuevas de fórmula usan el mismo `Trader`, fills, comisiones, funding y límite de exposición. El modo de cuenta se envía al servidor; el navegador dibuja USD y precios ejecutados, sin volver a multiplicar los pb. Los resultados anteriores siguen identificados como aproximados.   |

### Funding: importe exacto, no otra bolsa

Las entradas nuevas del flujo pendiente usan `kraken-absolute-quantity.v2`: tasa absoluta
de Kraken en USD por unidad del activo por hora, multiplicada por la cantidad y el tiempo
real de tenencia. No se usa tasa relativa por nocional de entrada. Las operaciones
heredadas mantienen `kraken-relative-entry-notional.v1`, sin recotizar resultados
cerrados ni redimensionar la posición actual. Cada posición y operación guarda su modelo.
Un resultado sin cobertura completa lleva `net_complete_usd = null`.

El archivo público local de Kraken permite recuperar etiquetas desde 2025-10-29.
Los 8.835 ejemplos del nuevo par tienen funding cubierto; sus 27.360 velas del período
2025-10-29 a 2026-02-01 están observadas, sin huecos. Los intervalos anteriores sin
tasa absoluta quedan explícitamente sin cobertura. Binance ETHUSDT es otro contrato:
su funding no sustituye pagos de Kraken.

Fuentes primarias: [API histórica de Kraken](https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates)
y [ejemplos oficiales](https://support.mtf.kraken.com/hc/en-us/articles/29694821654685-Funding-Rate-Examples).

### Traspaso pendiente, sobre la misma cuenta

[qwen-live-next.json](../../config/qwen-live-next.json) es una superposición aprobada por
SHA-256 sobre el hash de origen, no otra cuenta. Apunta al
[Maestro funding-v2](../../config/candidates/maestro-eth-cold-funding-v2-20261031.json)
y al [Portero funding-v2](../../config/candidates/portero-eth-cold-funding-v2-20261031.json).
Ambos se entrenaron desde cero con corte exclusivo 2026-02-01; no se usó la reserva de
2026-04-19. Los candidatos anteriores se conservan, pero no son los activables con
funding-v2. Este historial ya se exploró: no es validación nueva a ciegas ni garantía de ganancias.

El operador no permite otra entrada del flujo anterior mientras espera. Solo conmuta
cuando no hay posiciones en memoria, operaciones ni estado guardado. La transición
conserva saldo, génesis, historial y contadores, y registra la versión completa en
`config_versions`. Tras reiniciar recupera esa versión comprometida si desciende del
origen conocido; una configuración ajena o un archivo modificado produce un error visible.
Una configuración pendiente inválida no fuerza el cierre ni permite reabrir silenciosamente
con el flujo anterior.

La prueba histórica del flujo mide **solo los expertos y la ejecución**: no inventa
noticias, escudo ni giros del período reservado. La protección de capital tras pérdidas,
la recuperación de estado corrupto y la ejecución con precios más recientes siguen
fuera de este cambio, como acordó el usuario.

## Contrato preparado para Terminal (2026-10-30)

**Cuenta permanente y reparaciones cargadas; candidatos entrenados, flujo nuevo aún no activado.** Por petición
del usuario se recargó solo el operador, con la misma configuración y modelos. Se verificaron
la posición abierta sin cambios, las decisiones anteriores intactas y los demás servicios
sin reinicios. No se redimensionaron posiciones ni se reescribieron sus identificadores o
hashes. Tras la autorización posterior del usuario se entrenaron los dos candidatos en frío
con 10.183 ejemplos financiados de 2025-10-15 a 2026-01-31, corte exclusivo 2026-02-01.
No se usó la reserva desde 2026-04-19 ni se reemplazaron los modelos que operan la posición actual.
Las secciones posteriores conservan las decisiones de versiones anteriores; este contrato
describe el nuevo modo opt-in, no el comportamiento ya cargado en el proceso actual.

### Decisión y cuenta

| Pieza            | Contrato                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maestro          | Conserva su predicción propia sobre hechos de mercado. No recibe el voto del Portero.                                                                                                                                                                                              |
| Portero autónomo | Clasifica LARGO / CORTO / ESPERAR a 12 h con sus propios coeficientes y solo variables de mercado. No recibe puntaje, claridad ni predicciones del Maestro.                                                                                                                        |
| Coordinador      | Una noticia fuerte verificada tiene prioridad. Sin ella, exige Maestro fuerte y voto autónomo en el mismo lado. Sin modelo autónomo no inventa un voto ni consulta el Portero viejo.                                                                                               |
| Cuenta entera    | El nocional nuevo no supera `saldo_disponible / (1 + comisión_de_entrada)`. Con 1.000 USD y taker de 0,05 %, el máximo es aproximadamente 999,50 USD. El pedido de movimiento de 1,5x se satura en ese límite; 0,5x en calma sigue usando 500 USD. Lo abierto no cambia de tamaño. |
| Otros márgenes   | Se descuentan los márgenes de otras posiciones y se incluyen sus resultados marcados. Un saldo inválido, no finito o no positivo produce un error/rechazo explícito.                                                                                                               |
| Resultados       | Los pb de cada operación usan su nocional guardado, no el capital inicial del libro. La conciliación de funding mantiene esa unidad. `unknown` y `partial` no significan financiación gratuita.                                                                                    |

Autonomía del flujo de información **no** significa errores estadísticamente independientes.
Que dos expertos coincidan tampoco demuestra que la operación vaya a ganar.
El límite de tamaño rige para entradas nuevas: la operación heredada conserva su cantidad,
incluso si se abrió con una asignación superior a ese límite.

### El dinero pertenece a la cuenta, no a la configuración

La tabla `account` guarda una sola vez el capital inicial, protegido contra cambios,
borrados y reemplazos. El operador migra una cuenta legacy bajo su configuración vigente
antes de permitir cambiarla: un importe nuevo del entorno o del flujo no se usa para
redefinir el dinero anterior.

- **Saldo realizado** = capital inicial guardado + resultados netos de operaciones cerradas.
- **Valor con posiciones abiertas** = saldo realizado + su resultado provisional.
- Reservar margen reduce lo disponible para abrir, pero no gasta el nominal de un futuro.

Comisiones y funding forman parte del resultado de cada operación. Una conciliación de
funding observado puede corregir ese resultado; cambiar modelos, tamaños, analistas,
versiones, pantallas o reiniciar procesos no mueve dinero.

El gateway lee el capital guardado e ignora cambios de `QWEN_ACCOUNT_START_USD` en cuentas
ya inicializadas. Suma importes decimales exactamente y solo convierte a números para la
presentación. Un importe dañado se informa como error, no se omite ni se reemplaza por cero.
La migración real verificó el mismo saldo realizado antes/después, la misma posición y
todas las decisiones anteriores intactas.

### Noticias: entrada, giro y salida propia

El modo requiere `noticias.policy = "priority_v2"`, `opinion_enabled = false`,
`cuenta = "entera"`, apalancamiento 1 y solo `PF_ETHUSD`. Qwen queda para las noticias:
el supervisor no inicia el proceso genérico `q` de opiniones sobre velas, y el operador
determinista puede arrancar aunque el servidor del modelo no esté disponible. No se
modifican C25-C31 ni Kronos.

La evidencia debe cumplir todos estos requisitos:

- Clasificación v2 de relevancia alta y dirección alcista/bajista, con distribuciones
  finitas y normalizadas y apoyo de al menos 0,75 en ambas preguntas. Ese apoyo **no es
  una probabilidad calibrada de ganar dinero**.
- Catalizador de Ethereum o macro, no un resumen de precios. Fuente y URL HTTPS
  verificadas contra el dominio permitido, sin credenciales en la URL.
- Publicación, recepción y ambos análisis con orden temporal válido. El evento solo
  existe cuando todos se conocen; vence 15 minutos después de su publicación. Se vuelve
  a comprobar el vencimiento antes del cierre/giro y antes de abrir.
- Licencia explícita en `noticias.source_licenses`, con `status` (`licensed` o
  `public_domain`), `url` de las condiciones y `host`. Sin esa habilitación la fuente se
  rechaza; no se atribuyen licencias a los medios comerciales por defecto.

Los feeds existentes de la Reserva Federal son `fed` y `fed_monetary`; sus textos producidos
por el Board se contrastan con su [disclaimer](https://www.federalreserve.gov/disclaimer.htm).
La excepción para materiales de terceros sigue aplicando. No se agregó una fuente nueva
ni se habilitó una lista de licencias en la configuración activa.

Se comprueba el mercado al menos cada 5 s; las decisiones usan velas cerradas de 5 min,
con demora máxima de ejecución de 15 s:

1. Sin posición, una noticia habilitada puede abrir largo o corto.
2. Con posición del mismo lado, mantiene: no suma tamaño ni reinicia el reloj.
3. Con posición contraria, primero cierra; solo reabre con el saldo posterior y si siguen
   vigentes la noticia y la ventana de ejecución. Si la reapertura falla, el cierre y el
   rechazo quedan guardados, sin una posición ficticia.
4. Cada posición originada por noticias tiene un máximo de **24 h desde su propia
   entrada**, incluso después de reiniciar. No consulta al Maestro ni al Portero para
   mantenerla o cerrarla por tiempo. Otra noticia fuerte vigente puede girarla antes.
5. Noticias fuertes contradictorias frenan una entrada nueva; no frenan la gestión de
   salida de una posición existente.

Se conservan fuente, URL, licencia, hashes, horas, modelos y prompts de los análisis.
`news_actions` registra cada evento/resultado en la misma transacción que decisiones,
operaciones y estado. Un reinicio no repite eventos consumidos; un fallo de escritura no
consume el evento sin guardar sus efectos. Las horas de finalización/consumo se toman
después de decidir, no al empezar el poll. Los descartes tampoco revelan análisis futuros.
La agrupación de titulares sindicados es heurística: no promete reconocer duplicados
semánticos perfectamente. Si desaparece la base de noticias se vacía la evidencia
en caché y se informa que no está disponible.

### Volver a aprender sin usar la reserva

Los dos expertos se preparan juntos con
[`futures_qwen_independent_gate`](../../python/balancita_engine/futures_qwen_independent_gate.py).
El comando usa el ajuste en frío del Maestro y el nuevo ajuste del Portero. No carga
pesos anteriores y los dos reciben las mismas filas purgadas, sin compartir predicciones.
El Portero exige convergencia. Se requiere NumPy solo para entrenar, no para votar en vivo.

El procedimiento honesto es:

1. Fijar primero el corte y las reglas. Un corte posible de desarrollo es 2026-02-01;
   nada usa la reserva desde 2026-04-19.
2. Preparar archivos nuevos para ambos expertos. Purgar cualquier ejemplo cuyo resultado
   a 12 h alcance o supere el corte, también para el Maestro; filtrar solo por la fecha
   de entrada no alcanza. El Portero exige además financiación observada completa y neto
   tras costos para sus etiquetas de LARGO / CORTO / ESPERAR.
3. Mantener el tramo posterior anterior a la reserva separado del ajuste. Como ese
   historial ya se exploró, su comparación sigue siendo exploratoria, no un examen
   nuevo a ciegas. Empezar de cero no borra los intentos ni convierte datos vistos en
   datos nuevos.
4. Registrar el candidato y sus hashes, sin sobrescribir los archivos vigentes ni
   reiniciar el contador de variantes. Comparar después hacia adelante en paper.

Comando para entrenar ambos candidatos (se ejecutó con el corte indicado, sin activar):

```bash
PYTHONPATH=python .venv-vectorbt/bin/python -m balancita_engine.futures_qwen_independent_gate \
  --facts data/qwen-trader/walkforward-eth/hechos-eth-PF_ETHUSD.jsonl \
  --cache-dir data/qwen-trader/cache --until 2026-02-01 \
  --out config/candidates/portero-eth-cold-20261030.json \
  --maestro-out config/candidates/maestro-eth-cold-20261030.json
```

Los candidatos generados son:

- [Maestro en frío](../../config/candidates/maestro-eth-cold-20261030.json).
- [Portero autónomo en frío](../../config/candidates/portero-eth-cold-20261030.json).

Esos archivos ya existen: repetir el comando no los sobrescribe. Otro entrenamiento
necesita nombres nuevos y sigue contando como intento; este historial ya fue explorado.

La herramienta usa caché local, rechaza sobrescribir cualquiera de las dos salidas y registra
el par como ajuste fijo/exploratorio (`vigente`); no activa nada. Informa el hash canónico
del Maestro para `corta.maestro_hash` y el SHA-256 completo del Portero para
`corta.portero_autonomo` (`path` y `sha256`). Un modelo ajustado después de la fecha de
una decisión se rechaza. La prueba histórica identifica explícitamente las noticias
como no evaluadas: no debe afirmar que simuló noticias y giros cuando solo midió velas.

### Activación sin perder una operación

El nuevo comportamiento no se habilita cambiando hashes históricos a mano. Con otra
configuración ajena a la línea registrada, el arranque normal rechaza el cambio. `--activate-flat-config` permite
una transición explícita solo si no hay posiciones abiertas, ni en operaciones ni en el
estado guardado. Para el flujo nuevo también exige los dos candidatos en frío válidos.

La transición ocurre dentro de la misma base, conserva cuenta, operaciones y contadores,
y agrega un registro en `config_versions` con la versión anterior, la nueva y el saldo.
Cambiar el puntero de configuración y guardar ese registro es una sola transacción:
un fallo revierte ambos. Las versiones son append-only. `--archive-flat-book` queda
obsoleto y ya no permite sustituir una cuenta por un libro vacío.

Los candidatos ya están entrenados y comprobados técnicamente. La activación queda
pendiente hasta que cierre la operación actual. No crea una cuenta nueva ni fija otro
saldo de arranque. El historial intervenido anteriormente no se convierte en evidencia
limpia por cambiar de versión. Las regresiones usan mercados inventados y bases temporales;
el ajuste histórico de los candidatos tampoco demuestra mejora de rentabilidad.

## Objective

"Qwen operador": the local Qwen decides by itself WHEN to enter and WHEN to exit, on BTC (`PF_XBTUSD`) and ETH (`PF_ETHUSD`) only for now. This task ships the engine, the historical practice, the report and the learning-data export. It changes no live process.

## Decisions from the owner (2026-10-19)

- Products: BTC and ETH only, for now.
- Unlimited trades: no maximum per day. The only brakes are the cooldown after a close and the costs themselves.
- Qwen learns by OFFLINE retraining cycles, not online (see "Learning data" below).
- Q (`trade_action`) and C31 (`futures_qwen_exit`) are to be switched off in the NEXT PR, together with the live wiring. This PR does not touch `dev.mjs`, does not stop Q or C31 and does not add a live process.
- Practice on history first, paper (live) afterwards.
- ADR 0001 (immutable) already covers this: 100 USD fixed per trade, long and short, one cost model per product, Qwen allowed to decide. Nothing here needs an amendment.

## Design

`python/balancita_engine/futures_qwen_trader.py`, config `config/qwen-trader.json` (versioned; every parameter, threshold grid, product list, wake rule and prompt text; hashed into the practice DB).

- One class, `Trader`, fed CLOSED 5m candles one at a time. It has no other input, so it cannot look ahead; the practice and the future live process run the same class (live == replay). The model is reached through a `decider` (`LlmDecider` over `futures_llm_decisions.ask_model`: llama-server on loopback, grammar over letters, `max_tokens` 1, logprobs, confidence). A replay answers from stored calls, so nothing is asked twice.
- **Wake rules** (deterministic; Qwen is asked only when one fires):
  - flat: every closed 1 h candle; strong move (|log return| over 15 or 30 min above 2 x its normal size; normal = 5m log-volatility of the last 288 bars scaled by sqrt of the window); a funding publication that is extreme (`|rate| >= 5e-5` per hour) or jumps (`|change| >= 3e-5`).
  - in position: every 15 min; the same strong move; an adverse move beyond 75 % of the stop distance; funding as above.
  - extra wakes (strong move, near stop) are at least 10 min apart. `WAKE_HOOKS` is the empty extension point for later strategy signals and news.
- **Actions**: flat LARGO / CORTO / ESPERAR; in a position MANTENER / CERRAR. One grammar-constrained letter, asked in two option orders (3 options: written order and a rotation in which every option changes letter; 2 options: swapped), probabilities averaged, confidence `1 - H/ln(n)` as in `llm_decisions`; ties go to ESPERAR / MANTENER. Only when the action is LARGO, CORTO or CERRAR a second 1-token call asks the reason (`movimiento_exagerado`, `tendencia`, `funding_extremo`, `sin_ventaja`, `proteger_ganancia`, `cortar_perdida`, `otro`).
- **Entry threshold**: an entry needs p(action) >= threshold. The practice enters at the lowest value of the predeclared grid `[0.5, 0.6, 0.7, 0.8]` and records p; the report picks the threshold on the calibration fold (largest total net bp among thresholds with >= 30 calibration trades; if none is positive, the strictest one) and records it (`practice_meta.threshold_selection`, and in the report). Approximation, stated in the report: the trades of the practice are filtered afterwards; an entry that the stricter threshold would have skipped would have left the slot free for another one.
- **Guardrails, not overridable**: hard stop at `1.5 x` the 24 h sigma measured at entry (clamped to 0.5 %..20 %; gaps fill at the candle open, never better than the stop), forced close after 24 h, 15 min cooldown after any close, 100 USD per trade, one position per product, no limit of trades per day. Every forced close is a `guardrail` event in the data.
- **State shown** (Spanish, no dates, no absolute prices, no product name, never its own performance): returns 1h / 4h / 24h / 7d, trend as return over normal noise, daily volatility 24 h and 7 d, last 15 min vs normal, distance to the 24 h and 7 d high and low, volume vs mean, funding (last rate and 30-day percentile when Kraken's public history covers it), the round-trip cost, the fixed rules and, in a position, side, open time, unrealized result after costs, distance to the stop and time to the limit. The cost sentence is in the question: "entrar y salir cuesta ~0,10 %; solo vale la pena operar si esperás un movimiento claramente mayor".
- Prompt `qwen-trader` v1. Any text change needs a new `prompt.version` (a test pins the text hash).
- Accounting: `futures_costs` fills, taker fees on both legs, Kraken's public funding of the holding time (`settle`, the same formula as `Book._settle`); a trade with no funding data is flagged (`funding_status`), not charged zero silently. Coverage depends on the public provider's rolling history and the local cache; there is no universal fixed first date.

## Historical practice

`python -m balancita_engine.futures_qwen_trader practice` (needs llama-server on loopback; `--llama-url` other than 127.0.0.1 / localhost / ::1 is refused).

- Random contiguous **blocks** of 3 days in `[2025-01-01, holdout_from)` (`holdout_from` 2026-04-19 from `config/strategy-gate.json`), seeded, stratified: the period is cut in 157 slots per product, grouped in 10 time bins; strata are (product, bin), shuffled and interleaved so that any prefix of the plan is balanced across time and products. Default plan: 60 blocks (30 BTC, 30 ETH; 180 days each). Every block starts flat after 8 days of warm-up candles (read, never traded) and runs end to end; a position still open at the end of a block is closed at the last price with costs and marked `fin_de_bloque`.
- Folds: blocks that start in the older 60 % of the period (before 2025-10-11) are calibration, the rest validation. The verdict uses validation only, with the threshold chosen on calibration.
- The holdout is never read: `History` raises `HoldoutError` for any request that reaches it, the plan ends before it, funding periods that end after it are dropped.
- Resumable (`data/qwen-trader/practice.sqlite`, single writer): every call is stored (state hash, prompt version and hash, served model from `GET /v1/models`, probabilities of both orders, latency); a block cut by `--max-minutes` is replayed next time from the stored calls (no repeated model call), and committed in one transaction when it ends. A DB made with another config / seed / period is refused.
- Progress: per block (blocks done / total, calls, ETA) and every 200 calls (rate and remaining budget).
- `prefetch` downloads Kraken's public 5m candles and funding into `data/qwen-trader/cache`; `practice --offline` uses the cache only.

Expected load (BTC / ETH 2025, synthetic Qwen, this container): flat about 24 hourly + 10-15 strong-move wakes a day, about 75 calls a day; in a position about 96 + 10-15 wakes, about 220 calls a day; measured blend about 130 calls a day, about 390 calls per 3-day block. At 0.5 s per call: a block is about 3-4 min, a 55-minute batch (about 6,600 calls) is about 15-17 blocks (about 45-50 days), the 60-block plan is about 3.3 h, four batches.

## Report

`report --out data/qwen-trader/informe.md`, Spanish Markdown in the gate's style (title, ✅/❌/⚠️ verdict, "En pocas palabras", "Qué revisamos", short tables, "Glosario", "Detalles técnicos"). Per product and total: trades, trades per day, hit rate, mean net %, total USD (100 USD fixed), profit factor, max drawdown, average holding, share closed by Qwen / stop / 24 h limit / end of block. Baselines on the same blocks: do not trade (0), random entries (same count, side, holding, inside the same block, 1000 draws, percentile), Kronos `n/d` (its historical forecasts need the time-series model run candle by candle; not cheap). Calibration (predicted vs best action over the next hour), order agreement, reasons with outcomes, calibration vs validation, days evaluated and coverage.

Predeclared verdict rules (validation fold, `config/qwen-trader.json` `rules`, thresholds reused from the gate): n >= 100 · mean net > 0 with the 95 % bootstrap CI lower bound > 0 · percentile >= 95 against random entries · positive in >= 60 % of the time groups (the stratification bins) · positive in >= half of the products · positive with costs x1.5. Fewer than 100 trades: NO PASA "(pocas operaciones)" if another rule fails, INCONCLUSO otherwise. The gate's deflated Sharpe is left out on purpose: there is a single configuration and a single attempt so far; when prompt versions multiply, add the attempts counter.

## Learning data

`export --out data/qwen-trader/dataset.jsonl`: one line per decision (schema `balancita-qwen-trader-dataset.v1`): the state text exactly as prompted, the wake reasons, probabilities per order and merged, the action the model chose and the action taken, `guardrail` (`override`: `bajo_umbral`, `sin_respuesta`, ...; `forced` for stop / time / end-of-block closes), the reason with its probabilities, the position, and the realized outcome:

- entries: the trade (net bp, who closed it, holding) plus the 60-minute long / short nets;
- ESPERAR: net bp of a long and of a short held 60 min, round-trip cost included;
- MANTENER / CERRAR: net bp now, net bp after 60 min (or the realized result if the trade ended first) and `hold_better_bp = after - now`.

Also `fold` and `source` (`practice` now, `live` when the live process writes the same rows).

How it feeds a future offline LoRA fine-tune (no training code in this PR): each cycle exports `practice` + `live` rows; the supervised target of a flat row is the best of {LARGO, CORTO, ESPERAR} by its 60-minute net (ESPERAR = 0) and of a position row MANTENER / CERRAR by `hold_better_bp`, optionally weighted by the size of the difference so that near-ties teach little; the prompt is `state_text` plus the question of that prompt version, so a new training set is tied to `prompt_version`. Train only on the `calibration` fold and on live rows older than the evaluation window; the `validation` fold and later live data stay out and judge the new adapter with the same report (and the holdout is touched only by the strategy-gate exam, once). The adapter is a new model reference, never an in-place update, and a new `config_hash` makes the practice DB start from scratch.

## Version 2 (owner decision, 2026-10-19): only Qwen exits

First real v1 practice (Qwen3-4B, 11 of 60 blocks, 28 trades): 26 of 28 trades closed by Qwen with reason `sin_ventaja`, 0 % win, mean -0.32 %, about 2 h holding; the 2 trades closed at the block end were the winners; the reason call was degenerate (always `tendencia` on entry, `sin_ventaja` on exit). "Qwen tiene que lograr decidir bien cuando salir, no que alguien salga por él": v2 removes the safety nets to test that.

- Files: `config/qwen-trader-v2.json` (version 2, `prompt.version` 2) and `data/qwen-trader/practice-v2.sqlite`. v1 (`config/qwen-trader.json`, `practice.sqlite`) is untouched and stays reproducible (its config hash is pinned in the tests). Same `practice` section (seed, period, block days, bins), so v2 plays the SAME seeded blocks as v1; the candle cache is shared.
- No stop and no 24 h limit (`guardrails.stop_sigma_24h` and `max_hold_min` are `null`). A position closes only by Qwen's CERRAR or, in the practice, at the block end (`closed_by = fin_de_bloque`, not a Qwen decision). Kept: 15 min cooldown after a close, fixed 100 USD, one position per product. The `cerca_del_stop` wake is gone; `movimiento_grande_en_posicion` wakes Qwen (at most once an hour between the 15 min boundaries) when the price is at least one daily volatility away from the entry, in either direction. It only asks; nothing is forced.
- Exit information (state text, facts only): result if closing now after all costs (% and USD), a note that the entry fee is already paid and in that result and that closing only adds the exit fee, time open, typical move over the next 1 h / 4 h from the current volatility (`sigma5 * sqrt(bars)`) and the move already made in the position's favour (gross). The position question says the same and that there is no stop or time limit.
- Reason call: asked in two option orders (`prompt.reason_orders = "both"`, 7 options rotated by 4, so no option keeps its letter), both stored, probabilities averaged. If it is still degenerate the report says so ("motivo degenerado", more than 90 % the same option); nothing more is done about it.
- CLI: `practice --version 2` is the default and prints which version runs; `--version 1` still works. `report` (default `--version all`) writes `informe.md` (v1) and `informe-v2.md` (v2, with a v1 vs v2 section over the blocks both finished, plus the counterfactual-exit section: with no stop the "guardrails only" case is "hold to the block end"). `export --version 2` adds `exit_labels` to every MANTENER / CERRAR line: `close_now_net_bp`, `hold_1h/4h/block_end_net_bp` (marked from the stored block candles, funding included when the cache is given by `--cache-dir`; a v1 stop / 24 h close that came first is used as it happened; `null` past the block end), `hold_better_*_bp` and `best_*` (`MANTENER` or `CERRAR`), so exits can be trained later from either choice.

Report-only additions (also for v1 databases, no model calls): counterfactual exits ("¿Qué habría pasado si no cerraba?": guardrails only / 4 h / 8 h / 24 h; the block-end rule never reads past the block, fixed horizons may cross it but never reach the holdout), entry quality (gross move at 4 h / 24 h against the round-trip cost), reason diversity and letter bias, and measured latency with the estimated remaining batches.

## Speed and prompt layout (v2 runtime options, v2.1)

Decisions must not change; only the time per call. Measured on the Mac before: about 1.08 s per call, about 506 calls per 3-day block.

- **Concurrent option orders** (`runtime.concurrent_orders`, default on in v2 / v2.1, off in v1; `practice --sequential` turns it off). The two orders of one question are sent at the same time (llama-server must run with `-np 2`). `pnpm dev` lo levanta con prioridad de fondo en macOS y `LLAMA_THREADS` hilos (2 por defecto: con Metal la velocidad es la misma con 2, 4 o 6). Only the HTTP calls run in threads; the answers are consumed, stored and merged in the fixed variant order by the calling thread, and the first failing order stops the question exactly like the sequential path, so the stored rows are the same. Test: sequential and concurrent practice runs store identical decisions, trades and calls. **Caveat**: llama.cpp batching two sequences can change logits in the last digits (and a cached prefix can too). Measure it on the Mac: `practice --version 2 --check-determinism 200` replays 200 stored decisions (both orders), one by one and at once, and prints the largest probability difference to the stored call, between the two ways, the average and how many decisions would change their final choice, plus how many re-computed prompt hashes differ from the stored ones (a wrong version or config). A difference of about 1e-3 or less that flips nothing is harmless; if choices flip, use `--sequential`.
- **Prompt caching**: `futures_llm_decisions.request_body` already sends `cache_prompt: true`; the option orders of one question share almost the whole prompt. The v2 text starts with the STATE, so nothing before the first changed number can be reused. **v2.1** (`config/qwen-trader-v2.1.json`, `prompt.version` 2.1, `state_last: true`; "solo orden/rendimiento") puts `QUESTION`, options and answer line first and the `STATE` last (same layout as prompt v4 of `llm_decisions`; the layout is implemented locally in `qt.build_prompt`, `futures_llm_decisions` is untouched). This changes the prompt TEXT (order, and «el estado de arriba» became «de abajo»), so it is a new version: v2 stays reproducible (config hash `1e7cfac1...` and prompt text pinned in the tests), v2.1 has its own database `practice-v2.1.sqlite`, the same seed and blocks, and the same state text (same `state_hash`). Did the decisions change? `compare-prompts --from-version 2 --version 2.1 --n 200` asks 200 stored v2 decisions again under the v2.1 text (same states, no trajectory divergence) and prints agreement, flips and probability differences; the v2.1 report also compares both runs on the decisions that had an identical state.
- **Entry reason skipped** (`runtime.skip_entry_reason`, on in v2 / v2.1; `practice --ask-entry-reason` brings it back): the entry reason was degenerate (95 % «tendencia»). The exit reason is still asked in both orders. Entries have `entry_reason = NULL` (the report shows «sin motivo»). Continuing a v2 database with the flag on mixes entries with and without reason, which is harmless for decisions.
- `runtime` is excluded from `config_hash`: turning these options on or off never invalidates an existing practice database.
- The end of every batch prints `rendimiento:` (new calls, calls per second, wall seconds per call, latency of one call, blocks per hour and, when the server reports it, the share of prompt tokens served from the cache).
- Expected effect: calls per wake drop from 3 (2 + reason) to 2 on entries; the two orders overlap, so the wall time per question is about one latency instead of two; with the fixed prefix cached only the state (a few hundred tokens) is processed. Expect roughly 2x from concurrency, 1.1-1.3x from fewer entry reasons and some extra from the cache; measure with the `rendimiento:` line.

## Report additions (no model calls, any practice database)

- **Long or short** (`¿Prefiere comprar o vender?`): per product and fold, long and short entries (count, share, mean result) next to the market's buy-and-hold return over the same blocks, with one plain sentence.
- **Exit decisions one by one** (`Decisiones de salida, una por una`): for every MANTENER and CERRAR the other choice over the next 1 h, 4 h and to the block end, with costs and funding, from the closes stored with the block (same function as the export labels, so nothing past the block end is read); % where the choice was better and the average gain over the alternative, by unrealized result in σ of 4 h (daily volatility / sqrt 6; buckets at -1σ, 0, +1σ) and by time open (<1 h, 1-4 h, 4-12 h, >12 h), and a plain conclusion on where it exits or holds well or badly.
- **Does confidence rank outcomes?** AUC with a 95 % block bootstrap interval, rank correlation and top-vs-bottom quintile for three signals (probability of the choice, logit margin between the top two options averaged over both orders, agreement of the two orders) against entries (net result) and exits (gain over the alternative at 1 h / 4 h, also split by action). Isotonic calibration fitted on the calibration fold only and shown against validation. If every AUC interval includes 0.5 the report says that confidence carries no information and must not be used as a filter.
- **Why it decides what it decides** (`modelo que lo imita`): a depth-3 tree and a standardized logistic regression (pure Python) fitted on the calibration fold from the numbers in the stored state text, judged on validation against always saying the most common action; rules and top features in plain Spanish. It describes Qwen's behaviour, not the market.

## Probes (`probe`)

`python -m balancita_engine.futures_qwen_trader probe --version 2 --sample 200 --max-minutes 55` re-asks a seeded sample of stored decisions (stratified by kind, product and chosen action, interleaved so any prefix is balanced) with the same prompt and ONE number of the state changed at a time. Resumable (own table `probe_calls` in the practice database, the practice's `calls` statistics are untouched), budgeted, loopback only, never reads candles or the holdout.

Perturbations (value set to the 10th and 90th percentile of that number among the stored decisions of the same product and kind, so values are realistic; a level that would print the same as now is skipped; everything else in the text is identical): `retorno_1h/4h/24h/7d` (the return and its «tendencia», recomputed from the 15 min normal band shown in the same text), `volatilidad` (24 h), `movimiento_15min`, `distancia_maximo_24h`, `distancia_minimo_24h`, `volumen_1h`, `funding` (rate), and in a position `resultado_actual` (% and USD) and `tiempo_abierto`. A «repetir sin cambiar nada» control gives the noise floor. The report section `¿Qué datos mira de verdad?` lists per number the share of decisions that flip and the probability shift. Cost: about 21-25 questions per decision x 2 orders; `--sample 200` is about 9,000-10,000 calls, about 1.1 s per pair of orders at the same time, so roughly 80-90 minutes (two 55-minute batches); `--sample 100` fits one batch.

## En vivo

El proceso de Terminal opera en papel con velas reales: `python -m balancita_engine.futures_qwen_live`.
`pnpm dev` conserva el arranque legacy con el modelo; el modo nuevo de noticias puede levantar
el operador sin él. Usa la clase `Trader` de la práctica, pero una prueba solo de fórmulas no
reproduce la nueva política de noticias. Sin claves, cuenta privada ni órdenes reales.

### Detector de movimiento: igualdad entre carga inicial y actualización

El detector de [movimiento](../../python/balancita_engine/futures_qwen_analista.py) consolida una hora
solo cuando recibió su última vela cerrada de 5 minutos. Arrancar a mitad de hora no fija un
percentil incompleto, y consultar una hora futura devuelve `None` hasta tener sus velas.

El [operador en vivo](../../python/balancita_engine/futures_qwen_live.py) carga en el detector
solo la historia anterior al calentamiento. Las velas de calentamiento y las nuevas entran una
sola vez mediante `Trader.feed`, sin sumar de nuevo datos ya precargados.

No cambian las ventanas de 24 h / 90 días, los multiplicadores ni el tamaño de posiciones abiertas.
La corrección no recalcula operaciones guardadas. Se verifica con velas sintéticas, incluidos
arranques a mitad de hora, consultas sin futuro y reinicio con una posición abierta:

```bash
PYTHONPATH=python:python/tests python3 -m unittest test_futures_qwen_analista test_futures_qwen_live.RestartTests
```

### Historial de versiones y operación

- **Config**: `config/qwen-live.json` (versión `live`, `prompt.version` 5 desde la ficha de factores —antes 4—, `state_variant` 3; las configs 1, 2, 2.1 y 3 y sus hashes no se tocaron). Parte de la v3 con el espejo. Consulta SOLO cada 15 minutos, con o sin posición, y `wake.extra_wakes = false` apaga todo despertar extra (movimiento fuerte, cerca del stop, funding, movimiento grande, ganchos); las configs viejas, sin esa clave, no cambian. Guardrails de explorador: stop 1,5 x sigma 24 h entre 0,5 % y 3 %, cierre a las 4 h, espera de 15 min. El texto del estado y de la pregunta dice que hay stop y límite de tiempo (en la v3 decía que no había).
- **Tamaño, apalancamiento, productos**: `notional_usd` (100), `leverage` (1) y `products` (BTC y ETH) de la config, o `QWEN_LIVE_NOTIONAL_USD`, `QWEN_LIVE_LEVERAGE`, `QWEN_LIVE_PRODUCTS` (separados por coma) en el entorno de `pnpm dev`. Solo se valida que sean números positivos y ids de producto; no hay topes. La contabilidad usa el nocional (costos y funding sobre el nocional); el margen guardado es nocional / apalancamiento. No se simula liquidación. Cambiar cualquiera cambia la identidad de la config: hace falta otra base.
- **Datos**: velas públicas de 5 min de Kraken Futures por `futures_history.CandleCache` (caché en `cache/` junto a la base) y funding público (se relee cada 30 min; un cierre con el último tramo de funding sin publicar queda `partial`/`unknown` y se vuelve a liquidar con la misma fórmula de `settle` cuando aparece). Al arrancar calienta con ~8 días sin operar y después sigue cada vela cerrada nueva (poll cada 30 s). No usa `History` porque esa capa se niega a leer pasado el holdout.
- **Modelo caído o lento**: el despertar se guarda en `skipped` con el motivo (`modelo_caido`, `modelo_lento`, `sin_respuesta`, `proceso_detenido`) y no se reintenta; sin respuesta no se abre ni se cierra nada. Un despertar más viejo que 4 min (proceso apagado) tampoco se pregunta; los stops y el límite de tiempo sí se aplican vela por vela.
- **Base** (`data/qwen-live/live.sqlite` o `QWEN_LIVE_DB`; en `pnpm dev`, `server/data/dev-live/qwen-live/live.sqlite`): `decisions` (clave producto + ventana de 15 min, acción LARGO/CORTO/ESPERAR/MANTENER/CERRAR, probabilidades de ambos órdenes, confianza, motivo, latencia, texto del estado), `skipped`, `trades` (abiertas y cerradas, costos, funding y neto en USD exactos), `trader_state` (posición abierta y contadores para reiniciar sin duplicar). Todo lo de una vela se escribe en una transacción. Un solo proceso por base: candado de archivo `<base>.lock`; el segundo sale con código 2 y un mensaje claro.
- **Para reentrenar**: `python -m balancita_engine.futures_qwen_live --export salida.jsonl` escribe una línea por decisión con el esquema del `export` de la práctica y `source = live`; las etiquetas a 60 min (`outcome` de ESPERAR, `exit_labels`) se calculan offline con las velas.
- **Gateway / Terminal**: `/api/qwen/decisions` (LARGO→LONG, CORTO→SHORT, ESPERAR y MANTENER→WAIT, CERRAR→CLOSE, más los despertares omitidos) y `/api/qwen/trades` leen esa base solo lectura (`QWEN_LIVE_DB_PATH`); sin base responden `off` con el motivo.
- **Ventana de oportunidad** (exploración, siempre activa): sin posición y fuera de espera, cada despertar de 15 min hace SIEMPRE la pregunta de dos opciones `live.force_question` (solo LARGO y CORTO, sin ESPERAR) sobre los números reales y sobre el estado espejado. `lean = p(LARGO) - p(CORTO)` (promedio de los dos órdenes); `lean_num = (lean - lean_m) / 2`; `score = |lean_num|`; lado = signo de `lean_num`. Es candidata solo si el espejo NO repite el mismo lado, es decir `lean_eff * lean_m_eff <= 0`, donde cada lean cuenta como 0 si `|lean| < live.force_neutral_lean` (0,05; `QWEN_LIVE_FORCE_NEUTRAL_LEAN`): un 50/50 es ruido, no un lado, tanto en el estado real como en el espejo. Además `score >= live.force_min_score` (0,15; `QWEN_LIVE_FORCE_MIN_SCORE`). Así un real neutro con el espejo casi seguro en LARGO es candidata CORTO, y un real casi seguro en LARGO con el espejo neutro es candidata LARGO; dos lados extremos iguales (hábito) o dos neutros no lo son. Ambos umbrales están fuera de `config_hash`. La ventana empieza apenas el producto está sin posición y fuera de espera (arranque, después de cerrar, etc.); `live.force_side_after_h` (0 por defecto; `QWEN_LIVE_FORCE_SIDE_AFTER_H`) es un retraso de arranque opcional. Entra solo si es candidata, su puntaje alcanza el récord (`score >= mejor puntaje de las miradas CANDIDATAS de la ventana - live.force_record_tol`, 0,03; `QWEN_LIVE_FORCE_RECORD_TOL`; el puntaje se satura cerca de 0,5 y un récord estricto casi nunca se cumple, así que un empate o casi-empate entra; el puntaje de una mirada no candidata se registra pero no sube la vara) y hubo al menos `live.force_min_looks` miradas antes (6; `QWEN_LIVE_FORCE_MIN_LOOKS`). Pasadas `live.force_window_h` horas de ventana (12; `QWEN_LIVE_FORCE_WINDOW_H`; 0 apaga todo) entra en la primera candidata sin exigir récord. Nunca entra con el espejo contradictorio, aunque sea récord o venza la ventana. Al abrir se reinicia el contador; tras cerrar y pasar la espera arranca otra ventana (hasta 2 entradas por día y producto). Cada mirada queda como decisión ESPERAR con `override = ventana_mirando` y `lean, lean_m, lean_num, score, best_score, look_n, mirror_ok`; la entrada con `override = reason = entrada_ventana` y la operación con `entry_reason = ventana`. Las columnas nuevas se agregan con ALTER TABLE al abrir la base para escribir (las bases viejas se leen igual), el estado de la ventana se guarda en `trader_state.window_json` y la sección `live` está fuera de `config_hash`. Huecos conocidos: un récord temprano muy alto puede bloquear entradas hasta que venza la ventana; con pocos datos (6 miradas) la noción de «récord» es estadísticamente débil.
- **Versión 5 (la ficha de 8 factores con datos reales)**: `config/qwen-live.json` con `prompt.version` 5, `state_ficha` y `factors.question` (la de la variante `ficha` de la Prueba rápida, sin pista de reversión). El estado es la ficha F1 a F8 (`futures_qwen_ficha`); la pregunta de posición (MANTENER / CERRAR) sigue siendo una letra sobre ese estado con la cola de reglas de `_state_v3`. En la ventana de oportunidad, `Trader._decide_window` hace UNA llamada por factores (`futures_qwen_factors`, gradiente de -2 a +2 por renglón) con el estado real y UNA con el espejo, en vez de las preguntas de letras: `lean = suma de F1 a F7 del real / 14`, `lean_m` lo mismo del espejo, `lean_num = (lean - lean_m) / 2`, `score = |lean_num|`; candidata, umbral neutro, puntaje mínimo, récord, miradas mínimas y 12 h son EXACTAMENTE los de siempre (mismos valores: la escala del gradiente es otra y se recalibran con el primer día de datos). `live.force_question` ya no se usa en la ventana (queda para una config sin `factors`). Cada mirada guarda los gradientes en `decisions.factors_json` (`{"real": [8], "mirror": [8], "lectura": [8]}`; columna agregada con ALTER TABLE) y `/api/qwen/decisions` los entrega como `factors`; la Terminal los muestra en el motivo de la mirada («Lectura por renglón: F1 +1,2 · F2 −0,4 · …»). Datos en vivo: velas de 5 min de los otros activos de `state_context` (el producto nunca es su propio contexto: BTC ve ETH y SOL, ETH ve BTC y SOL) y la base del colector de posicionamiento abierta SOLO lectura (`--positioning-db`, `POSITIONING_DB_PATH` o `server/data/dev-live/positioning.sqlite`, la de `pnpm dev`), que se relee cada 10 minutos; sin base, F6 dice n/d y el log lo dice una vez.
- **Versión 6 (la pregunta sin ejemplo copiable)**: `prompt.version` 6 en `config/qwen-live.json` y variantes `ficha` 6.2 / `ficha-pista` 6.3 de la Prueba rápida. La Prueba rápida «Actual» con 150 fotos mostró que Qwen contestaba EXACTAMENTE la línea de ejemplo de la pregunta (`F1:+1 F2:-2 F3:0 …`) en 127 de 150: la copiaba. Como la gramática GBNF ya obliga el formato `F1:v … F8:v`, el ejemplo se sacó y la pregunta pide voto en todo renglón con datos (0 solo para n/d o números en el medio). F5 (un tamaño sin signo que el espejo no da vuelta) deja de votar, igual que F8: `VOTING` = F1, F2, F3, F4, F6, F7 y `lean = suma de esos seis / 12` (se suma por la posición de cada votante en la ficha, no por los primeros N). Cambia el `config_hash`, así que la base en vivo de la versión 5 se archiva sola y arranca una nueva. La tabla «Lectura por renglón» separa votar de leer: por renglón `vote_share`/`vote_n` (fotos con |gradiente real| >= 0,25; F4 solo cuenta fotos con el precio fuera del área, y con menos de 5 dice «sin fotos fuera del área»), `flip_share`/`flip_n` (entre las que votó, el signo se da vuelta en el espejo), `habit` (media de (real + espejo) / 2) y `corr`/`corr_n` (Spearman con el número del renglón). Veredicto, en este orden: «no vota» (vota en menos de 20 % de las fotos o en menos de 5), «lee» (vuelta >= 80 % y |corr| >= 0,5), «sesgado» (|corr| >= 0,5 pero vuelta < 80 %: lee el tamaño y el hábito manda el signo), «no lee» (|corr| < 0,2 o vuelta < 60 %), si no «a medias».
- **Versión 8 (la FICHA CORTA, 27-oct-2026, decisión de Fran: «me gusta, armémoslo así»)**: `config/qwen-live.json` con `prompt.version` 7, `state_corta` y `corta` (los archivos de las dos fórmulas y sus hashes). Qwen ya no lee los ocho renglones: dos fórmulas fijas en CPU los leen por él (`futures_qwen_corta`). 1) El **maestro** de dirección (`futures_qwen_maestro`, `config/qwen-lora-maestro.json`: logística sin intercepto sobre los 15 números direccionales de la ficha, plazo 12 h): SUBE/BAJA FUERTE/FLOJO o NADA CLARO, con su puntaje y los umbrales. 2) El **portero** (`futures_qwen_portero`, `config/qwen-portero.json`: logística con intercepto sobre los mismos números orientados hacia el lado del maestro, los tamaños y la claridad; etiqueta = «la operación en el lado del maestro ganó tras costos saliendo cuando el maestro se da vuelta o a las 48 h»): CONVIENE ENTRAR / NO CONVIENE, con la probabilidad y el umbral del archivo (el 20 % de señales fuertes más confiables del ajuste). Es exactamente igual en el espejo porque orientar por el lado deja los números iguales. 3) **Volatilidad** ALTA / NORMAL / BAJA (rango de 24 h contra el promedio de 7 días: ≥ 1,25 / ≤ 0,8) y el movimiento esperable en 24 h. 4) **Posición**: lado, horas, resultado con todos los costos, si el maestro ahora va a favor o en contra y cuánto falta para el cierre obligatorio. Preguntas de letras: sin posición LARGO / CORTO / ESPERAR con la prueba del espejo (en el espejo se da vuelta solo el maestro; el portero y la volatilidad quedan iguales); con posición MANTENER / CERRAR. Sin ventana de oportunidad (`live.force_window_h` 0), sin pregunta por factores y SIN adaptador LoRA (aprendió la ficha de 8 factores). Guardrails: sin stop (medido: los stops convierten ruido en pérdidas), cierre obligatorio a las 48 h (`max_hold_min` 2880; la salida es de Qwen, cuando el maestro se da vuelta), espera de 15 min. **Datos viejos o incompletos no se le muestran**: si faltan los otros activos (fuerza relativa), el área de valor o la volatilidad de la semana, `Trader._decide` levanta `WakeSkipped(datos_incompletos)` y el despertar queda en `skipped` con el motivo, sin pregunta (los despertares tarde ya se omitían). Cambia el `config_hash`: la base de la v7 se archiva sola; los resultados de la v8 se miran aparte, revisión a las 30 operaciones. La v7 (ficha de 8 factores, pregunta por factores, adaptador) queda congelada en `config/qwen-live-v7.json` (`qt.CONFIG_PATH_LIVE_V7`): es la config por defecto de `futures_qwen_lora` y la que prueban `test_futures_qwen_live_ficha` y `test_futures_qwen_lora`. Medición hacia adelante del portero (2024, 2025 y práctica, entrenando solo con años anteriores) en `analisis/qwen-v8/informe.md` (archivos del proyecto). Probar sin modelo: `test_futures_qwen_live_corta`, `test_futures_qwen_portero`.
- **Por operación en el Examen y la Prueba rápida (versión 8)**: con `state_corta`, `make_photos` guarda por foto `operacion` (tabla `exam_operacion`): el maestro, el portero y la volatilidad en ese momento y, para cada lado, el resultado de la operación de la versión 8 mirada hacia atrás (entrar al cierre de la foto; salir en el primer despertar posterior donde el maestro dice al menos flojo en contra, o a las `guardrails.max_hold_min`; neto en pb con el costo de ida y vuelta; `motivo` vuelta / tiempo; un despertar omitido por datos incompletos no cierra nada). Los despertares con datos incompletos no son fotos (el operador en vivo no pregunta). `analyse_operation` mide las entradas que Qwen haría en vivo (LARGO / CORTO sobre el umbral y confirmadas por el espejo) con esa salida fija: neto medio, ganadoras, rango del 95 % por día, total, salidas por vuelta / por tiempo, horas, acuerdo con el maestro y el portero, percentil contra el azar (una moneda por día); y en las mismas fotos la fórmula sola (maestro fuerte con portero a favor), el maestro fuerte sin portero y siempre largo / siempre corto. La salida es la regla fija, no lo que Qwen habría contestado con la posición abierta (eso cuesta 192 llamadas por operación). Sale en `exam-report` («Por operación»), en el resumen de la Prueba rápida (`operacion`) y en /Estrategias (tabla «Por operación»). `exam.from` (2025-10-01, después del último día con que se ajustaron las dos fórmulas) es el primer día de las fotos de la v8, nunca antes de `practice.from` (`--exam-from`); `exam.products` son los dos productos en vivo (BTC y ETH); ninguno de los dos cambia la identidad en vivo. La Prueba rápida «Actual» con la v8 pregunta por letras (real y espejo, dos órdenes): 150 fotos son 600 llamadas.
- **Cambio de configuración**: el arranque normal rechaza otra configuración sin cerrar ni renombrar nada. `--activate-flat-config` cambia la versión sobre la misma cuenta solo con el libro plano y registra la transición. No vacía operaciones, contadores ni saldo. `--archive-flat-book` ya no permite reiniciar la cuenta.
- **Examen de la config en vivo**: `python -m balancita_engine.futures_qwen_trader exam --version live` (2000 fotos, pregunta por factores real y espejo, ficha, otros activos y posicionamiento; las fotos salen con las reglas de despertar de la config en vivo: una cada 15 minutos) en su propia base, `data/qwen-trader/exam-live.sqlite`. /Estrategias («Qwen en vivo», etapas antes del corte) lee de ahí el `lean_num` de cada foto, solo si la base se hizo con la misma configuración que la de la base en vivo. El Examen de la v3 (`exam-v3.sqlite`) no cambia. La Prueba rápida «Actual (Qwen en vivo)» corre `--version live`; las demás variantes siguen sobre la v3.
- **Real y espejo juntas en el Examen con factores**: con la ficha (`state_ficha`) el `exam` (y la Prueba rápida) manda por foto el estado real y el espejo a la vez, un hilo por llamada, porque llama-server corre con `-np 2` (dos slots); `exam --sequential` las manda una detrás de otra, como antes. Solo la llamada HTTP corre en hilos: contadores, guardado en SQLite y errores los maneja el hilo principal, y las filas guardadas son las mismas en los dos modos. El `s por llamada` del progreso es tiempo de pared (la pareja cuenta una vez), así que baja a cerca de la mitad. `exam --check-parallel N` (con el examen parado: comparten los dos slots) pide las primeras N fotos de la base en serie y en paralelo (N x 4 llamadas, unos N x 4 x 2,5 s), no guarda nada y dice «sirve» si la línea `F1…F8` sale idéntica en al menos 95 % de las fotos, ningún gradiente se mueve 0,05 o más y el signo de `lean_num` no cambia nunca; si no, «revisar».
- Probar sin modelo: `PYTHONPATH=python:python/tests python3 -m unittest test_futures_qwen_live`.

## Constraints

- No network except the loopback llama-server and Kraken's public candle / funding endpoints through the existing cache (`futures_history`). No credentials, no orders.
- `futures-runtime.test.ts`, ADR 0001 and the strategy-lifecycle files (registry, forward, health, UI) are not touched.

## Tasks

- [x] Engine, config, wake rules, guardrails, both option orders, reason call.
- [x] Practice runner (blocks, folds, resumable, budget, progress), holdout guard, loopback only.
- [x] Report with predeclared verdict rules and baselines.
- [x] Export of learning data.
- [x] Tests: `PYTHONPATH=python:python/tests python3 -m unittest test_futures_qwen_trader` (fake llama provider).
- [x] v2 (no stop, no limit, richer exit state, two-order reason, v1 vs v2 report, exit labels).
- [x] Speed (concurrent orders, v2.1 layout, entry reason skipped, determinism check, compare-prompts), report additions, surrogate and probes.
- [ ] Mac: `prefetch`, `practice` in 55-minute batches until the 60 blocks are done, `report`; note the verdict and the measured seconds per call here.
- [x] Live process (same `Trader`), paper accounting, `source = live` rows: `futures_qwen_live` (see "En vivo"). Switching off Q and C31 is not part of it.
