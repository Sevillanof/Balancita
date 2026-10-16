# Etapa 10: ciclo de vida de la sesión paper (Issue #185)

Solo código y pruebas fuera de línea con datos inventados. No autoriza una sesión con datos reales, procesos persistentes ni otra
cartera. El GATE de sesión paper real sigue en NO-GO.

## Qué hay

`python/balancita_engine/paper_live_process.py`:

| Pieza                                                               | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuración versionada (`balancita-paper-live-process-config.v1`) | Productos, ventana de decisión, brecha máxima de cotización, modo de funding, parámetros del ingestor. Claves desconocidas se rechazan; su `digest` se guarda en `process-config.json` y otro digest no puede continuar el directorio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `preflight`                                                         | Solo lectura. Compuerta de sesión real, configuración contra directorio, directorio libre y sin otro escritor, disco libre, fuente legible, calentamiento completo por producto. Corre todos los chequeos y los lista.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Fases                                                               | `INIT → WARMUP → LIVE → STOPPING → STOPPED`, o `HALTED`. Se derivan de lo que tiene la sesión; el `heartbeat.json` (escritura atómica tras cada paso) las informa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Parada ordenada                                                     | SIGTERM/SIGINT solo levantan una bandera; el bucle termina el paso en curso y llama `LiveSession.stop` (D-186-1: cancela pendientes con `operator_stop`) y escribe `report.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Reinicio                                                            | Todo corte exige `--restart` explícito (BAL-DECISION-185-01): kill, corte de energía, disco lleno, `HALTED` o `REFUSED`. No se mira ninguna marca (`halt.json`, latido, audit): son solo el motivo que se le muestra al operador, porque un doble fallo de escritura no deja ninguna y la ausencia de marca no es permiso. Antes de la solicitud no se abre, recupera ni avanza nada; con ella siguen los controles de identidad, exclusión de escritores y recuperación coherente, y la solicitud queda en `operator-restarts.json`. Cada aparición de la divergencia de funding deja su propia línea en el audit (`occurrence`). Una parada ordenada es terminal (`session_stopped`), también si falta el latido (lo dice `report.json`). |

## Reproducir (todo local, reloj simulado)

```
cd python/tests
PYTHONPATH=..:. python3 -m unittest test_paper_live_process_185
PYTHONPATH=.. python3 -m balancita_engine.paper_live_process preflight --config C.json --directory D --source S.sqlite
PYTHONPATH=.. python3 -m balancita_engine.paper_live_process run --config C.json --directory D --source S.sqlite --clock-from-ms T --max-steps N
```

La línea de comandos rechaza `--wall-clock` y toda fuente que no se identifique como la fixture sintética: la configuración debe decir
`source_id: synthetic` y el SQLite debe llevar la tabla marcador `balancita_synthetic_fixture`. Una captura real no tiene ninguna de las
dos y se rechaza con `real_session_not_authorized`, diga lo que diga la configuración. Es una protección contra un error, no contra
quien falsifique el marcador a propósito. Habilitar datos reales exige una autorización escrita de Fran y un cambio de código revisado.

## Conexión con #186

- Arranque: el pre-vuelo y el calentamiento completo van antes de evaluar señales como vigentes. La fase `LIVE` empieza cuando todos
  los productos tienen vela hasta el primer instante de decisión y fuera de la supresión por hueco.
- Divergencia interna de funding (BAL-DECISION-184-01): la sesión se para (`HALTED`), la evidencia queda en la auditoría y el P&L se marca no verificado; se reinicia solo con `--restart`, como después de cualquier corte.
- Falla de disco o de un paso (también la del latido o del reporte): la instancia pasa a `HALTED`, se escribe `halt.json` primero (P3 `Mantener`, D-186-2 `Toda`), escribe el reporte y sale con estado 3.
  La recuperación equivale a un corte de energía en esa escritura.
- Corte (SIGKILL): sin reporte; el latido queda en `WARMUP`/`LIVE`; `start` recupera con el tramo sin observar declarado
  (`observation_gap`), sin cancelaciones retroactivas.
- Posición abierta al parar: no se cierra ni se modifica. Con el proceso parado nadie evalúa sus stops ni objetivos; el reporte la
  lista en `positions.open_at_end` con esa advertencia.
- Órdenes pendientes al parar de forma ordenada: se cancelan con el motivo `operator_stop`; `pending_at_end` queda en 0.

## Capital

El reporte lleva `capital_policy: adr-0001-fixed-100-usd`, `policy_status: experimental` y `evidence_class: not_forward_evidence`.
La configuración no admite otro dimensionamiento: `capital_policy` distinto se rechaza. `experimental` no sustituye al ADR.

## Plan de sesión supervisada (propuesta para decisión del propietario; no autoriza nada)

Todo son hipótesis. Un operador presente, BTC y ETH, unas 2 h después del calentamiento, reloj y fuente que Fran autorice por escrito,
estrategias congeladas sin cambios, cartera etiquetada experimental, sin proceso persistente: el operador lanza `run`, mira el
`heartbeat.json`, y termina con SIGTERM. Se verifica el ciclo de vida (arranque, calentamiento, parada, reinicio), no la rentabilidad.
Antes de proponerla hace falta: #182 integrado, #184 verificado, #186 con verificación independiente y la autorización separada de
Fran con fuente, productos, intervalo y condiciones.

## Monitoreo de recursos (opcional, apagado por defecto)

Si la configuración trae `resource_limits`, el proceso mide cada `check_every_steps` pasos (30 por defecto, y en el primer paso) el tamaño
del directorio de la sesión y su memoria residente. Claves aceptadas: `disk_warn_bytes`, `disk_stop_bytes`, `memory_warn_bytes`,
`memory_stop_bytes` (enteros positivos, aviso < parada, al menos una). Un aviso se registra una vez por recurso; una parada pide la
misma parada ordenada que SIGTERM (informe con `stop_reason`, estado final STOPPED, salida 4). Los límites son inclusivos (valor igual al límite ya cuenta). Si la medición falla, o una carpeta del directorio no se puede leer, también para en
orden (nunca cuenta 0 bytes). Si un SIGTERM llegó en el mismo paso, la parada igual queda registrada con su `stop_reason` y la salida es 4. Las lecturas y los eventos van al `heartbeat.json` y al `report.json` (`resources`). Sin `resource_limits` no se mide ni se escribe
nada y el digest de la configuración no cambia. **No hay valores aprobados**: los números de las Issues (disco 100/150 MB, memoria
400/600 MB) siguen siendo propuestas diferidas; el código solo da el mecanismo. Pruebas: `python/tests/test_paper_live_resources_185.py`.

## Guarda de reloj y hora de pared (opcional, apagada por defecto)

Con `clock_guard: {"max_forward_jump_ms": n}` (sin valor por defecto: lo nombra el operador) el proceso compara cada instante con el anterior
**antes** de dar el paso. Si el reloj retrocede o salta más que `n`, hace un **halt durable** (`halt.json`, estado HALTED, salida 3; reanudar
exige `--restart` del operador, sin reinicio automático). Es una insuficiencia de continuidad (regla 10D), no una caída de Kraken: no se
tocan posiciones, stops ni riesgo y nada se reordena. Con la guarda el latido suma `wall_ms` (hora de pared, solo observabilidad: no entra
en decisiones ni en el digest; hay prueba con dos horas distintas). Sin la guarda no se lee la hora de pared. `--wall-clock` sigue
rechazado y el GATE no se toca. `authorization_ref` (`BAL-DECISION-<issue>-<n>`) es solo rastro de auditoría: se valida el formato, no
abre nada y no entra en el digest. Pruebas: `python/tests/test_paper_live_clock_185.py`. El tope de salto no tiene valor aprobado. La guarda no conserva su instante anterior entre reinicios (D-217-03): el retroceso lo frena la recuperación del runner (`recovery_clock_behind`) y el salto durante una caída lo cubren las reglas de reinicio.

## Identidad de la fuente y causalidad (D-185-R4)

- **Identidad:** el archivo de una captura viva se escribe todo el tiempo, así que tamaño y fecha no sirven. La identidad es el archivo
  mismo (dispositivo e inodo, archivo regular). El proceso la toma al arrancar y la comprueba justo antes de cada paso que lee: si la ruta
  pasa a nombrar otro archivo, o ninguno, hace un halt durable (`source_replaced` / `source_unreadable`).
- **Causalidad (opcional):** el ingestor se guía por el tiempo de la fuente, así que un archivo que ya contiene el futuro se lee por
  delante del reloj (hay una prueba que lo documenta). Con `ingest_kw: {"causal_until_clock": true}` no se leen filas cuya llegada
  (`max(persisted_at, received_at)` en tickers, `max(known_at, bucket + 60 s)` en velas) es posterior al reloj del proceso; quedan retenidas y se cuentan en
  `held_after_clock`. El pre-vuelo exige esta opción a toda fuente que no sea la fixture sintética (`causal_ingest`, D-185-R4-01), aunque esa fuente igual sigue rechazada. Apagado por defecto en la fixture (un replay de un archivo completo depende del comportamiento actual). El desfase entre el reloj
  de la captura y el del proceso (D-188-24) no se corrige aquí: queda como dato a registrar antes de cualquier sesión real.
- El tipo de fuente real sigue rechazado (`real_session_not_authorized`); nada de esto abre una base real. Pruebas:
  `python/tests/test_paper_live_source_185.py`.

## Límites

- No hay reloj de pared ni fuente real (rechazados); el reloj simulado avanza por paso.
- El tiempo de calentamiento de la fixture se baja con `warmup_minutes`; por defecto es el que piden los indicadores declarados.
- El latido no tiene hora de pared: lleva el tiempo de observación inyectado. Un supervisor real necesitará su propia hora al leerlo.
