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
- Los módulos `paper_*.py` no importan nada de red (ni `urllib`, `http`, `socket`, `requests`, `ssl`) y no leen credenciales.
- Ya existe la política de datos tardíos: `max_quote_gap_ms` bloquea entradas sin cotización reciente
  (`entry_blocked_source_stale`) y #186 define la parada ordenada.

## 3. Propuesta

### 3.1 Separar el GATE (PR 5a)

- `real_session_gate` y `synthetic_marker` se reemplazan por un único chequeo de identidad de la fuente: la fuente es o bien el
  fixture sintético (solo pruebas) o bien la captura de Kraken Futuros, y cada una se reconoce por su propia marca, no por lo que
  diga la configuración. La marca de la captura real la confirma Captura (tabla o metadato que ya escribe); no la invento aquí.
- Una fuente real exige `causal_ingest` (ya existe: ninguna fila se lee antes de que el reloj la alcance) y `authorization_ref`
  (`BAL-DECISION-<n>-<n>`, ya validado por la configuración) que nombre la autorización de Fran para esa sesión.
- Sin `authorization_ref` válido, una fuente real sigue siendo `real_session_not_authorized`.

### 3.2 Órdenes reales ausentes, con prueba (PR 5a)

- Prueba de inventario: ningún módulo de `paper_live_*` y `paper_runner*` importa librerías de red o de firma, ni lee variables
  de entorno con nombres de credenciales de Kraken; la lista de módulos se recorre sola, así un módulo nuevo queda cubierto.
- Prueba de la superficie: la configuración no admite una clave de orden real (`config_invalid`), y el proceso no abre sockets
  (se verifica reemplazando `socket.socket` por una trampa durante una sesión completa de prueba).
- Se documenta que el endpoint privado y las credenciales siguen fuera del alcance (AGENTS.md y ADR).

### 3.3 Frenar ante datos tardíos o incompletos (PR 5b, reutiliza #186)

- Cotización tardía: ya bloquea entradas por producto (`max_quote_gap_ms`). Se agrega un umbral mayor que detiene la sesión en
  orden (la misma parada de #186, con `stop_reason` y código de salida propio) cuando falta cotización de cualquier producto
  más tiempo que ese umbral.
- Vela incompleta: la sesión usa la primera versión que llega (decisión de Fran, 17-oct 13:42Z) y cuenta cuántas llegaron
  incompletas; ese contador va al latido y al informe. Una vela incompleta en la ventana de decisión no frena por sí sola.
- Hueco de velas oficiales en la ventana de calentamiento o en la decisión: se trata como dato incompleto y frena entradas.
- Los tres umbrales (bloqueo de entradas, parada, tolerancia de velas) salen de la medición de 24 h de Captura (disponible
  ~12:41Z del 18-oct). Valores candidatos de la medición de 3 h: 15 s / 25 s / 45 s; no se fijan hasta tener las 24 h.

### 3.4 Reloj real (PR 5c, aparte)

- `WALL_CLOCK_GATE` solo se abre con un commit revisado que nombre la autorización (`BAL-DECISION`) de Fran. No se abre en 5a ni 5b.
- Hasta entonces, la sesión con datos reales se puede ensayar sobre la captura ya guardada con reloj simulado (lectura, sin red).

## 4. Orden y revisión

1. 5a: separar el GATE + pruebas de órdenes reales ausentes. CI 15/15 y revisión.
2. 5b: umbrales y parada ante datos tardíos o incompletos, con los valores de las 24 h.
3. 5c: reloj real, solo con autorización escrita de Fran, y recién entonces una sesión.

## 5. Fuera de alcance

Estrategias, costes, tamaño de operación, riesgo, forward, Kronos, Qwen, colectores, bases activas y el ADR 0001.

## 6. Qué necesito confirmar antes de implementar 5a

- De Captura: cómo se reconoce una captura real (marca de la base) y qué tablas lee la sesión.
- De Fran: que el reparto en 5a/5b/5c le sirve, y la autorización escrita por sesión cuando llegue 5c.
