# Etapa 10E: camino paper con datos reales (diseño, PR 5 de BAL-DECISION-184-05)

Estado: borrador de diseño. No cambia código, no inicia ninguna sesión y no toca el ADR 0001, forward, C29-C32, Kronos ni Qwen.
Ninguna sesión paper arranca sin la aprobación escrita de Fran.

## 1. Qué se decidió (Fran, 17-oct)

- El GATE actual mezcla dos cosas: usar precios reales de Kraken en una sesión paper y enviar órdenes reales. Se separan.
- Órdenes reales: siguen bloqueadas, y no solo apagadas: no existe ruta, módulo ni credencial que las pueda mandar.
- Sesión paper: precios reales de futuros `PF_*`, operaciones simuladas (100 USD fijos por operación, ADR 0001).
- Datos inventados: solo en pruebas chicas de casos concretos, nunca como modo de operación.

## 2. Qué hay hoy

- `paper_live_process.preflight` rechaza todo lo que no sea la fuente sintética con dos chequeos: `real_session_gate`
  (`source_id == "synthetic"`) y `synthetic_marker` (la tabla `balancita_synthetic_fixture`). Después de #262/#263/#265 la fuente
  ya es obligatoria y no hay sonda ni modo mock; con #266 tampoco hay valores por defecto en la sesión.
- El reloj real está detrás de `WALL_CLOCK_GATE = False`; la línea de comandos solo corre con reloj simulado (`--clock-from-ms`).
- Los archivos `paper_*.py` no importan red, pero el proceso sí la carga: `paper_live_process` arrastra `urllib.request`,
  `http.client`, `socket` y `ssl` a través de `futures_llm_decisions.py` (Qwen, que no se toca). Por eso la prueba de órdenes
  reales no puede mirar nombres de archivo (3.2). Las credenciales de Kraken no se leen en ningún módulo `paper_*`.
- `authorization_ref` es hoy solo un texto de auditoría (`paper_live_process.py`, «audit trail only»): se valida el formato y no
  abre nada. Cualquiera puede escribirlo, así que no puede ser la barrera (3.1).
- Ya existe la política de datos tardíos: `max_quote_gap_ms` bloquea entradas sin cotización reciente
  (`entry_blocked_source_stale`) y #186 define la parada ordenada.

## 3. Propuesta

### 3.1 Separar el GATE (PR 5a)

- `real_session_gate` y `synthetic_marker` se reemplazan por un único chequeo de identidad de la fuente. En el producto la fuente
  es la captura de Kraken Futuros, reconocida por su propia marca y no por lo que diga la configuración (la marca la confirma
  Captura; no la invento aquí). Mientras se borran los datos inventados (7.2) el fixture sintético sigue aceptado por una costura
  solo para pruebas, que se quita al cerrar la etapa 3.
- Una fuente real exige `causal_ingest` (ninguna fila se lee antes de que el reloj la alcance).
- La barrera de autorización vive en el código revisado, no en la configuración: una lista versionada de autorizaciones
  (`BAL-DECISION-<n>-<n>`, cada una con la sesión que autoriza) que solo cambia con un commit revisado. `authorization_ref` de la
  configuración debe figurar en esa lista; si no, la fuente real sigue siendo `real_session_not_authorized`.
- Un ensayo sobre la captura guardada con reloj simulado cuenta como sesión en los términos de BAL-DECISION-184-06 («no se inicia
  ninguna sesión» hasta que el camino esté aprobado e implementado): cada ensayo necesita la palabra de Fran y su entrada en esa
  lista. No hay ensayos antes de que 5a y 5b estén revisados.
- Holdout (desde 2026-08-02, «no probar estrategias»): todo lo capturado en octubre cae dentro. Un ensayo no informa rendimiento de
  estrategias ni se usa para elegirlas; la muestra real versionada de 7.3 sirve solo para pruebas de reglas. Si Fran quiere otro uso,
  lo decide él por escrito.

### 3.2 Órdenes reales ausentes, con prueba (PR 5a)

- Lista explícita de los módulos que pueden importar red: hoy solo `futures_llm_decisions` (Qwen), con su motivo. Una prueba recorre
  los módulos importados por el proceso paper y falla ante cualquier otro, también por importación transitiva.
- Trampa de la sesión completa, instalada antes de importar el motor: cubre `socket.socket.connect` y `connect_ex`,
  `socket.create_connection`, `socket.getaddrinfo` y `ssl.SSLContext.wrap_socket`; reemplazar solo `socket.socket` deja pasar a quien
  ya tiene la clase o resuelve nombres. Cubre también `subprocess.Popen`, `os.system` y `os.exec*`, porque un proceso hijo escapa
  a cualquier trampa del proceso (`paper_runner_demo` lanza subprocesos y se borra en la etapa 2 de 7.2). Si el runner de CI lo
  permite, la prueba corre además sin red (`unshare -rn`).
- La configuración ya es de esquema cerrado (rechaza claves desconocidas con `config_invalid`): se prueba eso, que cubre cualquier
  nombre, y no se prohíbe una clave en particular.
- Inventario del servidor TS (`server/`), que es quien habla con Kraken junto con la captura: solo hosts y rutas públicas (gráficos,
  tickers, WebSocket público); ninguna ruta privada (`sendorder`, `editorder`, `cancelorder`, `accounts`, `openpositions`) ni cabecera
  de firma (`APIKey`, `Authent`); ninguna ruta del gateway acepta órdenes (los comandos siguen `unavailable`, PS-06).
- Las credenciales y el endpoint privado siguen fuera del alcance (AGENTS.md y ADR).

### 3.3 Frenar ante datos tardíos o incompletos (PR 5b, reutiliza #186)

- Reloj: «tardío» se mide con la hora de Kraken que trae cada cotización (la captura ya la guarda desde #264), no con la hora de
  recepción; se informa también la diferencia entre ambas.
- Cotización tardía: ya bloquea entradas por producto (`max_quote_gap_ms`). Se agrega un umbral mayor que detiene la sesión en
  orden (la misma parada de #186, con `stop_reason` y código de salida propio) cuando falta cotización de cualquier producto más
  tiempo que ese umbral. Que un solo producto tardío (de 8) frene toda la sesión es a propósito, porque la sesión comparte una
  cartera; se revisa con la medición de 24 h.
- Posiciones abiertas mientras la cotización está tardía: no se cierran ni se valúan con datos viejos. Las salidas que dependen de
  la cotización quedan pendientes y la valuación se marca no verificada; en la parada de #186 la posición queda abierta y registrada
  tal cual, sin cerrarla con un precio inventado. Los detalles (liquidación, margen) se fijan en 5b con pruebas.
- Vela incompleta: la que cumple `fin + settle_lag ≤ server_ms` según el adaptador es completa; si todavía no cumple, es incompleta.
  La sesión usa la primera versión que llega (decisión de Fran, 17-oct 13:42Z), cuenta cuántas llegaron incompletas y ese contador va
  al latido y al informe. Una vela incompleta no frena por sí sola.
- Hueco de velas: en Kraken un minuto sin trades es una vela plana con volumen 0 y no es un hueco. Hueco es solo una vela oficial que
  falta; nunca se rellena. Un hueco en la ventana de calentamiento o en la de decisión frena entradas.
- Hecho (mecanismo): `stale_stop.stop_quote_gap_ms` en la configuración, opcional y apagado, parada ordenada con salida 5
  (`docs/etapa-10-ciclo-de-vida.md`). Hecho: contador de velas incompletas (`candles_incomplete`, en el latido y en el informe). Hecho: tolerancia de velas (`evaluator_kw.candle_tolerance_ms`; una sesión real la exige igual a `late_candle_tolerance_ms` de `config/forward-strategies.json`, 15 s, la misma del forward, en el chequeo previo `candle_tolerance_named`): una vela que llega más de 15 s después de cerrar su minuto (`llegada − cierre > 15 s`; exactamente 15 s es válida) sigue alimentando los indicadores pero no genera ciclo ni orden: queda en `suppressed` con motivo `candle_late`, `recovered: true` y su atraso (`lag_ms`), el equivalente en papel de la operación `recovered` del forward. Antes eran 45 s (commit 61f3e64). No frena la sesión por sí sola. El hueco (vela que falta) ya suspende los ciclos durante el calentamiento (`gap_warmup`).
- Los tres umbrales salen de la medición de 24 h de Captura (18-oct-2026, 1.450 velas de 1 minuto por producto, 0 cotizaciones cruzadas o
  incompletas; mediana entre cotizaciones del WebSocket de BTC 0,4 s y del REST 1,07 s; el peor hueco real fue de 12,1 s, en todos los
  productos a la vez): **bloqueo de entradas 15 s** (`max_quote_gap_ms`, por encima del peor hueco real), **parada de la sesión 25 s**
  (`stale_stop.stop_quote_gap_ms`, tiene que ser mayor que el bloqueo) y **tolerancia de velas 15 s** (`evaluator_kw.candle_tolerance_ms`, medida en 1228 velas de 1 m reales: p50 3,1 s, p99,9 8,1 s, máx. 8,2 s; fuente única `late_candle_tolerance_ms` en `config/forward-strategies.json`). Siguen siendo parámetros que nombra el operador, no valores por
  defecto del código; `python/tests/test_paper_live_thresholds_184.py` corre el proceso con esos valores sobre el mercado real de BTC.
  Aprobar la sesión no es parte de esto: sigue necesitando la palabra de Fran (3.1).
- Desfase de relojes (D-289-03): en la muestra real de BTC, 11.269 de 125.589 cotizaciones (9 %) llegaron hasta 149 ms **antes** de su hora
  de Kraken. `parse_quote` las acepta si llegan hasta `CLOCK_SKEW_TOLERANCE_MS` = 500 ms antes (más de 3 veces lo medido) y les pone como
  recepción la hora de Kraken (nunca una hora anterior a la real); más atrás sigue siendo cotización inválida. Sin esto el mayor tramo sin
  cotización útil era de 8,0 s en vez de 3,7 s. Es un parámetro a revisar, no un límite medido (`test_quote_clock_skew_184.py`).

### 3.4 Reloj real (PR 5c, aparte)

- `WALL_CLOCK_GATE` solo se abre con un commit revisado que nombre la autorización (`BAL-DECISION`) de Fran. No se abre en 5a ni 5b.
- Un ensayo sobre la captura guardada con reloj simulado es una sesión (3.1): necesita la palabra de Fran y su entrada en la lista versionada.

## 4. Orden y revisión

1. 5a: separar el GATE + pruebas de órdenes reales ausentes. CI 15/15 y revisión.
2. 5b: umbrales y parada ante datos tardíos o incompletos, con los valores de las 24 h.
3. 5c: reloj real, solo con autorización escrita de Fran, y recién entonces una sesión.

## 5. Fuera de alcance

Estrategias, costes, tamaño de operación, riesgo, forward, Kronos, Qwen, colectores, bases activas y el ADR 0001.

## 6. Qué necesito confirmar antes de implementar 5a

- De Captura: cómo se reconoce una captura real (marca de la base) y qué tablas lee la sesión.
- De Fran: que el reparto en 5a/5b/5c le sirve, y la autorización escrita por sesión cuando llegue 5c.

## 7. Borrar los datos inventados (Fran, 17-oct 17:37Z)

Decisión: ya no se usan datos inventados y la idea es borrarlos. Criterio del coordinador: se borra todo generador, fixture grande,
modo o valor por defecto con datos inventados, en código y en pruebas. En las pruebas solo queda lo mínimo escrito a mano para
comprobar una regla puntual (un par de velas o una cotización armados en el mismo test) o muestras reales capturadas. Una prueba
que solo existe para ejercitar datos inventados se borra.

### 7.1 Tamaño real (contado en el repo, 17-oct)

De 2.230 pruebas de Python, unas 1.000 en 30 archivos se apoyan en datos inventados: el mundo de la sesión (`live_world.py`, 21
archivos), la fixture 9A (`make_db`, `fixture_db`), los escenarios (`portfolio_scenarios`, `portfolio_stage7`, `portfolio_offline`)
y las demos (`paper_runner_demo`, `signal_continuity_demo`). Las más pesadas: `test_portfolio_stage7` (120), `test_paper_live_ingest`
(75), `test_paper_live_integration` (68), `test_paper_runner_financial` (59), `test_paper_runner_recovery` (57),
`test_replay_9a_audit` (45), `test_paper_live_process_185` (42).

Esas pruebas son hoy la red de seguridad de reglas de dinero (costes, funding, liquidación, recuperación). Borrarlas sin reemplazo
deja esas reglas sin prueba, así que el borrado va por etapas y cada archivo se decide por separado.

Avance (18-oct): el circuito completo de `test_paper_live_integration` (circuito financiero, caídas en cada frontera, reloj, muerte real
del proceso, identidad y checkpoints; 27 pruebas) pasó a `test_paper_live_circuit_184.py`, sobre las velas, cotizaciones y respuestas
de funding reales de BTC. Se perdieron a propósito dos pruebas que solo existían con el mundo inventado: la del oráculo independiente
(necesita 24 h de funding real para el percentil, trabajo de «Balancita en la Nube») y las de las dos tablas de funding (el camino real
tiene una sola). Siguen en el archivo viejo, sobre el mundo inventado, adaptador/evidencia, cancelación por fuente caída, silencio y
dos productos (esperan datos reales de un segundo producto).

Segunda entrega (19-oct): la cancelación de la orden que espera en un hueco de la fuente (hueco de 39,5 s y corte literal de 26 s, con y sin
el límite) pasó a `test_paper_source_stale_184.py`, con huecos hechos quitando cotizaciones reales. Cobertura que se pierde a propósito:
la muerte del proceso en cada frontera de la sesión durante esa cancelación (la cubren `test_paper_kill_session_186` en el diario y
`TestRealProcessTermination` en las fronteras de la sesión).

Tercera entrega (19-oct): los plazos de la orden contra el límite de silencio (límite justo debajo, igual y justo encima del plazo, y muerte
entre la pérdida y su vencimiento) pasaron a `test_paper_order_deadline_184.py`, con un hueco de 135 s de cotizaciones reales.

Cuarta entrega (19-oct): se sacó el modo de funding sintético del motor (`funding_mode: synthetic`, las tablas `synthetic_accrual`
y el devengo inventado). El único modo es `observed`: el devengo sale de las respuestas de funding de la captura. Un `funding_mode`
`synthetic` ahora se rechaza al validar la configuración. Las pruebas viejas que corrían con ese modo (`live_world.py`, las de
dos productos y las de contenido del reporte) pasaron a `observed` con las tablas de respuestas vacías: no tienen funding, y
lo que dejan de cubrir es el devengo inventado de posiciones abiertas, que ya lo cubren las pruebas de funding observado sobre las
20 respuestas reales. Siguen en pie, a propósito, la etiqueta `source_id: synthetic` y la marca `balancita_synthetic_fixture`: son
el costado por el que se repite la muestra real sin fuente autorizada, y se van cuando haya sesión real autorizada.

### 7.2 Etapas

El orden importa: el camino sintético sostiene hoy unas 1.000 pruebas y no se saca antes de que exista su reemplazo.

1. Informes y demos que no corren en producción (hecho en #269 para los informes): después `paper_runner_demo`,
   `signal_continuity_demo`, `portfolio_two_process`. Por archivo: si la prueba comprueba una regla, se reescribe con datos mínimos
   escritos a mano dentro del mismo test; si solo ejercita el generador, se borra con el generador.
2. Muestra real chica de la captura (7.3), versionada, y reemplazo del mundo de la sesión (`live_world.py`) y de la fixture 9A
   (`make_db`, `fixture_db`) en las pruebas de reglas, más casos mínimos a mano.
3. Recién entonces, el camino operativo sintético: fuera `source_id: synthetic`, la marca `balancita_synthetic_fixture`, el modo de
   funding sintético y sus canales, y la costura solo para pruebas de 3.1. Hasta ahí, 5a deja la CLI y la configuración del
   producto aceptando solo la fuente real, y el fixture queda detrás de la costura.

### 7.3 Qué hace falta para la etapa 2

Una muestra real de la captura (unas horas de velas oficiales, cotizaciones y funding de uno o dos productos), solo para pruebas de
reglas y nunca para medir estrategias (holdout, 3.1). La captura vive en la Mac, así que la extracción la hace una sesión de la Mac
(pedida a Validación de captura Kraken); esta sesión no la tiene. Hasta tenerla se avanza con el paso 1 de 7.2 y con 5a; el reemplazo
del mundo de la sesión y el paso 3 esperan esa muestra.

### 7.4 Criterio por archivo antes de borrar

Cada archivo que se borra o se reescribe deja escrito, en la PR: las reglas de dinero que cubre (costes, funding, liquidación,
recuperación), la prueba que reemplaza a cada una y los mutantes que seguían muriendo sobre esas reglas. Si una regla no tiene
reemplazo, el archivo no se borra.

### 7.5 Exclusiones

El borrado no toca las pruebas de estrategias congeladas (C25-C31, C29/C30/C32), forward ni Kronos o Qwen (AGENTS.md: no se
modifican antes de 100 operaciones forward). `test_replay_9a_audit` y la fixture 9A sostienen la reproducibilidad de un veredicto
ya registrado (9A): su borrado queda a decisión de Fran.
