# Validación integral offline de la cartera compartida

Estado: aislado. Sin forward, Kronos, Qwen, `capture`, colectores, bases activas ni holdout; sin órdenes reales ni credenciales; sin cambiar parámetros de riesgo ni el ADR 0001. No modifica C29-C32.

## Qué es

Un ejecutor determinista que procesa **cronológicamente** velas de 1 minuto y señales `balancita-signal.v1` sintéticas de varios productos y estrategias, y las pasa por lo que ya existe:

| Pieza                                                                              | De dónde sale                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Señal → intención con stop/objetivo                                                | `multi_signals.Strategy.evaluate` / `make_signal` y `portfolio.intent_from_signal` (`multi_risk.RiskPolicy.levels`) |
| Capital, tamaño dinámico, límites, idempotencia, resolución de señales simultáneas | `portfolio.Portfolio` (sin cambios)                                                                                 |
| Entrada, comisiones, funding, stop/objetivo/tiempo, P&L                            | `futures_simulator.Book` (sin cambios)                                                                              |
| Costes                                                                             | `futures_costs` (sin cambios)                                                                                       |

No hay otro motor ni otra contabilidad. Lo nuevo es lo que una integración necesita alrededor:

1. **Orden e idempotencia de eventos**: por minuto, primero las velas (liberan capital) y luego las señales. Un evento ya visto (`event_id`) se descarta; una vela repetida se ignora; una vela con otro contenido para el mismo minuto se rechaza (gana la primera); una vela anterior a la última se rechaza; un hueco de velas queda anotado. La idempotencia de intenciones y señales sigue siendo la de `Portfolio`.
2. **Diario** (en memoria o en archivo) (`Journal`): una entrada por hecho (señal recibida, intención construida, decisión con motivos, tamaño, límites aplicados, precio de entrada, stop, objetivo, cierre con bruto/comisiones/funding/impacto de entrada, estado del capital antes y después). Cada entrada lleva el hash de la anterior; `verify()` detecta cualquier edición.
3. **Comprobaciones independientes** (`_check_*`): recalculan desde operaciones y posiciones crudas el riesgo por operación (1 %), el riesgo agregado (2 %), la exposición bruta/neta/por producto, el margen, la regla del 30 %, el nocional mínimo, el máximo de posiciones, la pérdida diaria y el drawdown como suspensión, la identidad `bruto − comisiones − funding = P&L`, que un stop pierda lo planificado, y que el capital definitivo nunca cuente ganancias provisionales. Hay pruebas que rompen la cartera a propósito para demostrar que el comprobador salta.
4. **Checkpoint y reinicio**: `checkpoint()` guarda el estado con digest, huella de configuración (escenario, política, modelo de costes), vínculo con el diario y digest canónico del estado. `restore()` construye un ejecutor **nuevo** o falla (`no_checkpoint`, `corrupt_checkpoint`, `configuration_changed`, `journal_mismatch`, `journal_chain_broken`, `unreadable_checkpoint`, `state_mismatch`). No existe un camino «si no hay estado, empezar de nuevo».

## Recuperación entre dos procesos (tres niveles, por separado)

1. **Desde checkpoint persistido** — demostrado: `portfolio_two_process first` escribe checkpoint y diario y termina; `second`, un intérprete nuevo, restaura solo desde esos archivos y completa el escenario con libro, capital, estado, posiciones y hashes iguales a una ejecución ininterrumpida.
2. **Del diario desde disco** — demostrado: `Journal` escribe JSONL con fsync por entrada; `Journal.load` verifica la cadena y que el diario pertenece al escenario. Ausente, vacío, alterado, con basura, con la cola cortada, reordenado, truncado o ajeno: el segundo proceso termina con código 3, motivo explícito y sin escribir resultado.
3. **Reproducción de señales desde una fuente durable** — **pendiente para el forward**. En la prueba ambos procesos reconstruyen las entradas desde la definición del escenario (un sustituto). `live_gap` conserva el contraste: si las señales de la caída no existen, el resultado difiere.

No es un sistema de persistencia de producción: no decide dónde viven los archivos ni quién los escribe, y un diario con la cola cortada se rechaza entero en vez de repararse.

## Cómo se ejecuta

```
PYTHONPATH=python python3 -m unittest python/tests/test_portfolio_offline.py
PYTHONPATH=python python3 -m balancita_engine.portfolio_two_process first|second --scenario s5_integral_reinicio_replay_log --dir /tmp/x   # dos procesos, a mano
```

Los archivos generados (`informe.md`, `resultados.json`, `journals/*.jsonl`) no llevan fecha ni nada dependiente del entorno; una prueba regenera todo y exige que coincida con lo versionado. Si cambian a propósito los costes o la cartera, hay que regenerar y revisar la diferencia.

## Escenarios

| Escenario                         | Qué ejercita                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `s1_posiciones_simultaneas`       | 5 productos, 3 estrategias, LONG y SHORT a la vez, recorte por exposición/margen, señales contradictorias, ATR inválido               |
| `s2_perdidas_consecutivas`        | 4 stops seguidos, presupuesto del 1 % que baja con el capital, la pérdida diaria descuenta del riesgo admisible                       |
| `s3_duplicados_y_orden`           | misma señal entregada varias veces, versiones contradictorias, señal vencida, falsificada, vela duplicada/conflictiva/tardía/faltante |
| `s4_funding_incompleto`           | funding completo, parcial y ausente; ganancia provisional que no suma capital, pérdida provisional que sí resta                       |
| `s5_integral_reinicio_replay_log` | todo lo anterior, cruzando la medianoche UTC, más caída del proceso con posiciones abiertas y restauración desde un archivo           |
| `s5_integral_reinicio_live_gap`   | mismas entradas, pero las señales emitidas durante la caída no existen para el proceso reiniciado                                     |

## Recuperación: qué existe y qué falta

La tabla completa está en el informe. En resumen:

- **Existe**: idempotencia de intenciones/señales y orden temporal en `Portfolio` (solo en memoria); checkpoints de libros del experimento multiestrategia (`multi_experiment`/`multi_store`); relleno de huecos de velas y reconciliación de funding en el forward.
- **Nuevo, solo en este ejecutor offline**: idempotencia de eventos, checkpoint/restauración de `Portfolio`, escritura atómica, diario encadenado.
- **Falta**: persistencia de `Portfolio` fuera de este ejecutor; un registro **durable de señales** (prototipo offline en [continuidad-senales.md](continuidad-senales.md); sin él, lo emitido durante una caída se pierde y el sistema no puede detectarlo: escenario `live_gap`); reclasificar una operación `net_complete=false` cuando llega el funding (hecho en la etapa 7, aislado: [contabilidad-condiciones-adversas.md](contabilidad-condiciones-adversas.md)); el **primer precio ejecutable posterior a la señal** (prototipo aislado en [ejecucion-temporal.md](ejecucion-temporal.md), sin conectar); huecos de precio sobre el stop (`Book` sale por defecto al precio del stop; la etapa 7 añade la opción `stop_policy`, también aislada).

`replay_log` demuestra que, **si** existiera ese registro durable, restaurar + reproducir desde el checkpoint da exactamente el mismo libro y estado que no haber caído. No demuestra que hoy exista.

## Qué no demuestra

Que haya ventaja de trading (todo es sintético), que el simulador refleje el mercado real, ni que el prototipo esté listo para el forward: antes hacen falta la decisión sobre el precio ejecutable, la persistencia y el registro de señales, y una enmienda aprobada por Fran.
