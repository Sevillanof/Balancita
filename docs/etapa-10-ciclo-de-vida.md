# Etapa 10: ciclo de vida de la sesión paper (Issue #185)

Solo código y pruebas fuera de línea con datos inventados. No autoriza una sesión con datos reales, procesos persistentes ni otra
cartera. El GATE de sesión paper real sigue en NO-GO.

## Qué hay

`python/balancita_engine/paper_live_process.py`:

| Pieza | Qué hace |
|---|---|
| Configuración versionada (`balancita-paper-live-process-config.v1`) | Productos, ventana de decisión, brecha máxima de cotización, modo de funding, parámetros del ingestor. Claves desconocidas se rechazan; su `digest` se guarda en `process-config.json` y otro digest no puede continuar el directorio. |
| `preflight` | Solo lectura. Compuerta de sesión real, configuración contra directorio, directorio libre y sin otro escritor, disco libre, fuente legible, calentamiento completo por producto. Corre todos los chequeos y los lista. |
| Fases | `INIT → WARMUP → LIVE → STOPPING → STOPPED`, o `HALTED`. Se derivan de lo que tiene la sesión; el `heartbeat.json` (escritura atómica tras cada paso) las informa. |
| Parada ordenada | SIGTERM/SIGINT solo levantan una bandera; el bucle termina el paso en curso y llama `LiveSession.stop` (D-186-1: cancela pendientes con `operator_stop`) y escribe `report.json`. |
| Reinicio | Tras un corte (kill, energía) `start` recupera solo, con el reloj del reinicio. Tras `HALTED`/`REFUSED` exige `--restart` explícito. Tras una parada ordenada no reinicia (`session_stopped`). |

## Reproducir (todo local, reloj simulado)

```
cd python/tests
PYTHONPATH=..:. python3 -m unittest test_paper_live_process_185
PYTHONPATH=.. python3 -m balancita_engine.paper_live_process preflight --config C.json --directory D --source S.sqlite
PYTHONPATH=.. python3 -m balancita_engine.paper_live_process run --config C.json --directory D --source S.sqlite --clock-from-ms T --max-steps N
```

La línea de comandos rechaza `--wall-clock` y cualquier `source_id` distinto de `synthetic`. Habilitar datos reales exige una
autorización escrita de Fran y un cambio de código revisado, no una opción.

## Conexión con #186

- Arranque: el pre-vuelo y el calentamiento completo van antes de evaluar señales como vigentes. La fase `LIVE` empieza cuando todos
  los productos tienen vela hasta el primer instante de decisión y fuera de la supresión por hueco.
- Falla de disco o de un paso: la instancia pasa a `HALTED` (P3 `Mantener`, D-186-2 `Toda`), escribe el reporte y sale con estado 3.
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

## Límites

- No hay reloj de pared ni fuente real (rechazados); el reloj simulado avanza por paso.
- El tiempo de calentamiento de la fixture se baja con `warmup_minutes`; por defecto es el que piden los indicadores declarados.
- El latido no tiene hora de pared: lleva el tiempo de observación inyectado. Un supervisor real necesitará su propia hora al leerlo.
