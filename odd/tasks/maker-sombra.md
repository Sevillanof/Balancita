# Entrada y salida con orden límite, en sombra

La Terminal oficial sigue operando a mercado (taker). En sombra, para cada entrada y cada salida
oficial, se simula una orden límite (maker) sobre la cinta real de Kraken capturada y se registra
cuánto se habría pagado, para comparar señal por señal. Origen: T17 de
`odd/tasks/estrategias-laboratorio.md` (L37-L38, `analisis/costo-maker/informe.md`).

## Specs

- **S1** — «Si, implementalo en sombra tanto las entradas como las salidas.» (a: «¿Vamos con la opción A, midiendo entradas y también salidas en sombra?»). Opción A: la Terminal oficial no cambia (cuenta, decisiones, órdenes, costos); la sombra solo observa y registra.
- **S2** — Entradas en sombra, variante V2 sellada en T17: orden post-only en el mejor precio (compra en el mejor bid para LONG, venta en el mejor ask para SHORT) en el momento de la entrada oficial; se llena si una operación real de la cinta cruza el precio al menos un tick dentro de 15 min; si no se llena, se cruza a mercado al minuto 15 al precio de la cinta. Se registra: tipo de llenado (maker / maker → mercado), precio pedido y obtenido, tiempo de llenado, comisión (2 pb maker, 5 pb taker) y la diferencia en US$ y pb contra la entrada oficial de la misma señal.
- **S3** — Salidas en sombra: lo mismo para cada salida oficial (orden límite del lado contrario, 15 min, cruzar si no llena), separadas por motivo de salida (vuelta, agotado, tiempo, rebote). No cambia ninguna salida real.
- **S4** — «estamos teniendo en cuenta los costos que usamos ahora por operacion? Como diferenciariamos cuando entramos con uno u otro?»: un solo modelo de costos coherente (hoy `round_trip_cost_bps(exit_kind="maker")` da 7,38 pb y `settle` 7,19); cada registro de sombra dice cómo habría entrado/salido y qué comisión pagó cada lado.
- **S5** — La sombra se calcula después (como las etiquetas del auditor), nunca dentro de la mirada en vivo; si falla, se registra y la Terminal sigue. Se archiva en Parquet y se expone en la API del auditor. Despliegue en la VPS solo con OK del usuario.

## Tasks

| ID  | Specs | Ruta                                                                                           | Estado   | Commit |
| --- | ----- | ---------------------------------------------------------------------------------------------- | -------- | ------ |
| T1  | S1-S5 | worker: costo coherente + sombra maker de entradas y salidas en el auditor, Parquet, API, docs | en curso | —      |

## Log

- **L1** (usuario, 2026-11-09): «Hagamoslo. Quiero que analicemos como seria la integracion con la terminal actual, estamos teniendo en cuenta los costos que usamos ahora por operacion? Como diferenciariamos cuando entramos con uno u otro? Para las salidas lo podemos implementar tambien?»
- **L2** (usuario): «Si, implementalo en sombra tanto las entradas como las salidas.»
