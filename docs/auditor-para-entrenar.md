# El auditor guarda lo que hace falta para entrenar más adelante

Origen: S8 y T15 de `odd/tasks/noticias-y-auditor.md` (L19). Huecos G1-G6 y G8 de `analisis/ciclo-recursivo/informe.md` §5 (G7 ya estaba arreglado). Un reentreno confiable pide ≈ 1.600 propuestas cerradas con etiqueta: este registro las junta sin tocar lo que el trader decide.

## Reglas

- **Solo agrega.** Tablas nuevas en `auditor.sqlite` (la que ya lee el servidor). Ninguna tabla ni columna anterior cambia; los veredictos y valores de siempre son los mismos (comprobado con una corrida guionada contra el commit base).
- **No toca decisiones.** Se escribe después de que la decisión está tomada y guardada, solo en `auditor.sqlite`, sin red. Lo único que el trader expone es `Trader.look_audit`, una nota de solo lectura de la última mirada que nada del trader lee.
- **Si falla, se anota y la Terminal sigue.** Un fallo (o un registro de más de 500 ms) queda en la tabla `errors` de la base viva (`auditor_entrenar` / `auditor_entrenar_lento`) y en el log; no cambia una decisión, una operación, una fila vieja del auditor ni el ritmo del sondeo.
- **La etiqueta se calcula aparte.** El resultado contrafactual lo da `resolve` (como los veredictos), nunca la mirada en vivo.

## Qué se guarda

| Hueco | Tabla                  | Una fila por                                | Qué trae                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1+G4 | `hechos_mirada`        | mirada                                      | `hechos_json` (los hechos aplanados del maestro: los 15 direccionales y los 5 tamaños), `puntaje`, `veredicto`, `portero_json` (voto, probabilidad o apoyo, umbral) e identidad: `maestro_hash`, `portero_hash`, `config_hash`, `config_version`, `costos_id`. `version` sigue siendo la del auditor |
| G2    | `propuestas`           | señal de entrada (maestro fuerte + portero) | `lado`, `inicio_episodio`, `estado` (`abierta` / `bloqueada`), `motivo_bloqueo` (`lugares_ocupados`, `mismo_episodio`, `enfriamiento`, `cierre_en_la_mirada`, `otro` + `detalle_bloqueo`), `trade_no`; más tarde `contrafactual_json`, `neto_pb`, `motivo_salida`, `horas`                           |
| G3    | `mirada_operaciones`   | posición abierta × mirada                   | lado, entrada, horas, neto ahora, puntaje del maestro contra el lado, lo que dice la regla de salida (`salida_dice`, `salida_motivo`) y `evento` (`mantiene`, `abre`, `cierra`)                                                                                                                      |
| G5    | `resultados_operacion` | operación cerrada                           | neto con costos de los recibos (`neto_pb`, `neto_usd`), motivos de entrada/cierre/salida, precios, MFE/MAE con máximos y mínimos de las velas (`mfe_hl_pb`, `mae_hl_pb`). `operaciones` (cierres de 5 min) no cambia                                                                                 |
| G8    | `reentrenos`           | reentreno                                   | `corte_ms`, `dataset_hash`, `spec_json`, `metricas_fuera_de_muestra_json`, `creado_ms`. Triggers de solo-agregar                                                                                                                                                                                     |
| —     | `sombra_maker`         | tramo oficial (entrada o salida)            | lo que habría pasado con una orden límite en el mejor precio sobre la cinta real, y la diferencia contra el oficial (`delta_usd`, `delta_pb`). Se calcula después, con 15 min de cinta. Ver `docs/maker-sombra.md`                                                                                   |
| G6    | `miradas_perdidas`     | mirada programada que no se hizo            | `motivo`, `detalle`, `estado` (`plana` / `en_posicion`), `maestro`, `puntaje`, `entrada_dice` (`LARGO` / `CORTO` / `ESPERAR`), `salida_dice` (`CERRAR` / `MANTENER`) y `formula_json` con el detalle por posición. Hipotético: no se operó                                                           |

G6 (miradas perdidas con el proceso caído): `hechos_mirada` y `propuestas` solo tienen las miradas que el proceso vio; los episodios exigen miradas contiguas. Las que no se hicieron quedan en `miradas_perdidas` (`odd/tasks/operacion-mejoras.md` S2, ver `docs/terminal-ciclo-de-vida.md`): una fila por mirada programada perdida, con su hora, el motivo (`proceso_detenido`), si había posición y lo que la fórmula habría dicho (hipotético: esa mirada no operó; la mirada de recuperación del arranque sí opera, con los datos de ese momento).

## La etiqueta contrafactual

`resolve` toma cada propuesta (abierta o bloqueada) y simula la operación que habría corrido desde el cierre de la mirada con las **reglas oficiales de salida**: la misma función del trader (`futures_qwen_corta.formula_action`: el maestro se dio vuelta, o pasaron `exhaust_hold_min` y perdió fuerza) mirada tras mirada con los puntajes de `hechos_mirada`, y el tope de `max_hold_min`. Neto = lado × movimiento − costo de ida y vuelta, sin funding (≈ 0,4 % del bruto) y a precio de cierre de la mirada. Solo usa miradas ya pasadas. Si pasan el tope más 12 h sin precios, queda `{"estado": "sin_datos"}` para no trabar el archivo.

## Reentrenos

`futures_auditor.registrar_reentreno(live_db_path, corte_ms=…, dataset_hash=…, spec={…}, metricas={…})` o, desde la línea de comandos, `python -m balancita_engine.futures_auditor --db <live.sqlite> --registrar-reentreno archivo.json` (JSON con esas cuatro claves y, opcional, `creado_ms`). Sin alguna de las cuatro, `ValueError` y no queda nada. No hay reentreno automático.

## Migración y archivo

- Aditiva: `_open` crea las tablas con `CREATE TABLE IF NOT EXISTS`. Una base vieja queda intacta; el servidor viejo la sigue leyendo y el nuevo lee una base sin migrar (campos `null`). Se deshace con `DROP TABLE hechos_mirada, propuestas, mirada_operaciones, resultados_operacion, reentrenos, sombra_maker, miradas_perdidas` (un test lo comprueba).
- Archivo Parquet: todas se archivan (`auditor_hechos`, `auditor_propuestas`, `auditor_mirada_operaciones`, `auditor_resultados`, `auditor_reentrenos`, `auditor_sombra`, `auditor_perdidas`); también `operaciones` (`auditor_operaciones`), que estaba sin cubrir. Ver `docs/archivo-parquet.md`.
- Servidor: `auditor-verdicts.ts` suma `auditoria.propuesta` (por mirada), `auditoria.resultado` y `auditoria.sombra` (por operación); `null` si falta la tabla.

## Costo (medido en la Mac, un producto)

- Disco: ≈ 0,9 KB por mirada en `hechos_mirada` (96 al día) más las propuestas, los estados de posición y los resultados: ≈ 100-250 KB al día en SQLite.
- CPU: ≈ 2 ms por mirada para anotar (máximo 5 ms) y ≈ 1-8 ms por mirada en `resolve` para etiquetar y completar resultados.
