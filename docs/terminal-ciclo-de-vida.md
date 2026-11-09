# Ciclo de vida de una operación de la Terminal: fecha de la entrada y miradas perdidas

Origen: S2 y S3 de `odd/tasks/operacion-mejoras.md`; evidencia en `analisis/ciclo-de-vida/informe.md` (B1: la entrada se fechaba al llenarse, unos 4 s después de la mirada; B3: 27 miradas seguidas sin evaluar con 3 posiciones abiertas). Código: `futures_qwen_trader.py` (`Trader._open`, `_finish_close`, `feed`), `futures_qwen_live.py` (`LiveOperator._process`, `_lost_look`), `futures_auditor.py` (`record_missed`).

## La entrada se fecha con la mirada (S3)

Con ejecución de libro, la mirada decide en `t` (el cierre de la vela) y el llenado llega unos segundos después. Antes la posición se fechaba al llenado; ahora:

| Qué                                                                                                      | Hora que usa                        | Dónde queda                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry_ms` (operación y posición guardada)                                                               | la mirada que la decidió            | `trades.entry_ms`, `position_json`, `decisions.position_json`, `operaciones.entry_ms` y `mirada_operaciones.entry_ms` del auditor                                                                     |
| Tiempo en posición (`maestro_agotado` a 1.440 min, tope de 36 h, cierre de 12 h de noticias, `hold_min`) | `entry_ms`                          | La mirada de las 24 h ve exactamente 1.440 min y «agotado» puede cerrar ahí (antes veía 1.439 y cerraba una mirada tarde)                                                                             |
| Enfriamiento tras un cierre                                                                              | la mirada que decidió el cierre     | `trader_state.cooldown_until` = mirada + 15 min: espera 15 min y la mirada +15 ya se hace, como en el backtest (antes caía dentro y el efectivo era de 30 min)                                        |
| Llenado real de la entrada                                                                               | `Position.fill_ms`                  | `position_json.fill_ms` y el recibo de entrada (`execution_receipts.evidence_json.executed_at_ms`, inmutable y con hash). `trades` **no** tiene columna nueva (no hay migración ni cambia el archivo) |
| Funding, recibos y su liquidación                                                                        | el llenado (`fill_ms_of(posición)`) | Igual que antes: el funding corre desde el llenado real; `settlement.entry_at_ms` del recibo de salida es el llenado                                                                                  |
| `exit_ms` de la salida                                                                                   | el llenado de la salida             | Igual que antes (evidencia). La salida decidida en la mirada `t` queda con `exit_ms` = `t` + unos segundos                                                                                            |

- **Operaciones ya guardadas:** siguen valiendo sin reescribirlas. Las anteriores tienen `entry_ms` = llenado y no tienen `fill_ms`; `fill_ms_of` devuelve `entry_ms` y el vínculo con el recibo (`0 <= llenado − entry_ms <= 2 velas`) se cumple con retraso 0. Una posición abierta al desplegar sigue con su fecha de llenado hasta que cierre.
- **Sin ejecución de libro** (replay, backtest, pruebas con velas): `entry_ms` ya era la mirada y `fill_ms` queda en `null`; la salida del replay es la misma byte a byte (comprobado con 30 días de velas y 508 operaciones).
- **Volver atrás** con una posición abierta guardada por esta versión: el código anterior rechaza su `position_json` (su recibo no coincide con `entry_ms`). Cerrar las posiciones antes de revertir.

## Mirada de recuperación (S2)

Si al arrancar, o al volver de un bloqueo, se saltaron miradas programadas (`proceso_detenido`: la vela llegó con más de `max_late_seconds` de retraso), la Terminal hace **una** mirada enseguida con los datos de ese momento en vez de esperar al próximo :00/:15/:30/:45:

- Es la vela cerrada más reciente del lote; se hace aunque no sea de :00/:15/:30/:45 (`wake_json` = `["recuperacion"]`, o `["cada_15_min", "recuperacion"]` si coincide con una programada). Evalúa las salidas de las posiciones abiertas y puede entrar, como una mirada normal (guardrails, enfriamiento y lugares incluidos).
- Solo con datos vigentes: la vela más reciente no puede tener más de una vela + `max_late_seconds`. Si la fuente de velas está atrasada, no hay mirada de recuperación (lo perdido igual se registra).
- Con ejecución de libro, la señal de ese libro es la hora de la mirada (ahora) y no el cierre de una vela de hace minutos: el límite de 15 s de la ejecución rige igual. `entry_ms` y el enfriamiento usan el cierre de la vela, como cualquier mirada.
- **Nunca opera hacia atrás:** las miradas pasadas que no se hicieron no abren ni cierran nada.
- Una mirada programada que llega tarde (más de `max_late_seconds`) sin haber perdido otras antes ya no se omite: es la mirada de recuperación si los datos siguen vigentes.

## Miradas perdidas (`miradas_perdidas`, auditor)

Cada mirada programada que no se hizo queda en `auditor.sqlite`, tabla `miradas_perdidas` (además de la fila `skipped` / `proceso_detenido` de la base viva, que no cambia). Una fila por producto y mirada, solo-agregar (`INSERT OR IGNORE`):

| Columna                               | Qué                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `product`, `bucket_ms`, `t_ms`        | producto y hora de la mirada (`bucket_ms` = `t_ms` − 15 min, como `miradas`)                                                    |
| `motivo`, `detalle`, `despertar_json` | motivo del evento (`proceso_detenido`), su texto y los motivos de despertar que tenía                                           |
| `estado`                              | `plana` o `en_posicion`, según lo que tenía el trader en esa mirada                                                             |
| `maestro`, `puntaje`                  | el veredicto y puntaje del maestro con las velas de esa mirada                                                                  |
| `entrada_dice`                        | lo que la fórmula habría dicho para entrar: `LARGO`, `CORTO` o `ESPERAR`                                                        |
| `salida_dice`                         | `CERRAR` si la regla de salida cerraría alguna posición abierta, `MANTENER` si no, `null` sin posición                          |
| `formula_json`                        | el detalle: entrada, cada posición (`trade_no`, `lado`, `horas`, `dice`, `motivo`), portero, volatilidad y la nota «hipotético» |
| `registrada_ms`, `version`            | cuándo se anotó y la versión del auditor                                                                                        |

Es **hipotético**: se calcula con las velas que el trader ya tiene (sin red) y el estado de las posiciones en esa mirada; esa mirada nunca operó. Si la lectura de la fórmula falla, la fila queda igual con hora y motivo (`formula_json` nulo) y el fallo va a `errors` (`auditor_entrenar`). Se archiva como `auditor_perdidas` (ver `docs/archivo-parquet.md`).

## Qué cambia en vivo

| Cambio                                                                                  | Antes                                        | Ahora                                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| «agotado» a las 24 h                                                                    | ve 1.439 min y cierra 15 min tarde           | ve 1.440 min y cierra en la mirada de las 24 h                             |
| Tope de 36 h, cierre de 12 h de noticias                                                | contados desde el llenado                    | contados desde la mirada que decidió                                       |
| Enfriamiento tras un cierre                                                             | 30 min efectivos (la mirada +15 caía dentro) | 15 min: se hace la mirada +15                                              |
| `trades.entry_ms` de operaciones nuevas con libro                                       | hora del llenado                             | hora de la mirada (el llenado, en `fill_ms` de la posición y en el recibo) |
| Arranque o vuelta tras un bloqueo con miradas perdidas                                  | espera a la próxima mirada programada        | una mirada de recuperación enseguida (entradas y salidas permitidas)       |
| Mirada programada que llega con más de `max_late_seconds` de retraso con datos vigentes | se omite (`proceso_detenido`)                | se hace como mirada de recuperación                                        |
| Miradas perdidas                                                                        | solo una fila `skipped` sin más              | además fila en `miradas_perdidas` con lo que la fórmula habría dicho       |
