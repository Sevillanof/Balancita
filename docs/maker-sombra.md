# Entrada y salida con orden límite, en sombra

Origen: `odd/tasks/maker-sombra.md` (S1-S5, T1) y el estudio T17 de `odd/tasks/estrategias-laboratorio.md` (`analisis/costo-maker/informe.md`, variante V2 sellada en `hipotesis.md`).

**La Terminal oficial no cambia**: sigue entrando y saliendo a mercado (taker). En sombra, para cada entrada y cada salida oficial, el auditor simula DESPUÉS una orden límite (maker) sobre la cinta real de Kraken que captura el servidor y anota cuánto se habría pagado, señal por señal. No envía ninguna orden (el ADR 0001 no lo autoriza).

## Qué se simula (variante V2)

1. **Orden**: en el mejor precio propio de la última foto del libro de hasta **20 s antes** de la hora oficial del tramo: compra en el mejor bid, venta en el mejor ask (abrir un largo compra; cerrarlo vende; con corto al revés). Es la misma regla que `futures_maker_exit.passive_price`.
2. **Llenado**: la primera operación de la cinta, dentro de **15 min**, que pasa el límite **al menos un tick** (compra: precio ≤ límite − tick; venta: precio ≥ límite + tick). Tocar el límite NO llena: la posición en la cola se desconoce. Tick de `PF_ETHUSD` = 0,1 US$. Estado `maker`: precio = límite, comisión **2 pb**, sin impacto.
3. **Si no llena**: cruza a mercado en el minuto 15 al precio de la última operación de la cinta, con el costo del modelo (`futures_costs.entry_fill` / `exit_fill`: 0,19 pb en contra en ETH) y comisión **5 pb**. Estado `maker_mercado`.
4. **Tamaño** = el oficial. Funding y la otra punta no se tocan: solo se comparan los costos del tramo.
5. **Nunca se adivina**: sin foto del libro ≤ 20 s, con un hueco de cinta de más de 5 min antes del llenado o antes del minuto 15, con la captura sin llegar al minuto 15 (pasadas 12 h) o con un producto sin libro capturado, la fila queda `sin_datos` con su motivo y sin números.

## Tabla `sombra_maker` (`auditor.sqlite`, aditiva)

Una fila por tramo oficial: clave `(product, trade_no, leg)` con `leg` = `entry` | `exit`. Se escribe una sola vez, final (`INSERT OR IGNORE`).

| Columna                                             | Qué es                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motivo_salida`                                     | solo salidas: `vuelta`, `agotado`, `tiempo`, `rebote` (experto de rebotes), `noticia`, `otro`                                                                     |
| `lado`, `orden`                                     | lado de la posición (+1 largo / −1 corto) y lo que hace el tramo en el libro (`compra` / `venta`)                                                                 |
| `t_oficial_ms`, `precio_oficial`                    | hora y precio del tramo oficial (del recibo; sin recibo, de `trades`)                                                                                             |
| `comision_oficial_usd`, `comision_oficial_tipo`     | comisión que pagó el oficial y cómo (`taker`, o `maker` si la salida oficial ya fue límite)                                                                       |
| `cantidad`, `notional_oficial_usd`                  | tamaño oficial (el mismo que usa la sombra)                                                                                                                       |
| `libro_ms`, `limite_px`                             | foto del libro usada y precio al que descansó la orden                                                                                                            |
| `estado`, `motivo_sin_datos`                        | `maker` / `maker_mercado` / `sin_datos`; motivos: `sin_libro`, `libro_invalido`, `cinta_con_huecos`, `cinta_incompleta`, `cinta_truncada`, `producto_sin_captura` |
| `llenado_ms`, `llenado_px`, `cinta_px`, `espera_ms` | cuándo y a qué precio se llenó (o cruzó); `cinta_px` = precio crudo de la cinta del minuto 15 cuando cruzó                                                        |
| `comision_sombra_usd`, `comision_sombra_tipo`       | comisión de la sombra (`maker` 2 pb o `taker` 5 pb)                                                                                                               |
| `delta_usd`, `delta_pb`                             | **positivo = la sombra habría salido mejor que el oficial**: (mejora de precio × cantidad) + comisión oficial − comisión sombra; en pb del nocional oficial       |
| `modelo`, `costos_id`, `resuelto_ms`, `version`     | `sombra-maker.v1`, modelo de costos (`kraken-futures-costs.v2`), cuándo se calculó, versión del auditor                                                           |

## Cuándo se calcula, y cuánto cuesta

- Solo en `resolve` (como las etiquetas de `propuestas`), nunca en la mirada en vivo, y solo cuando el tramo tiene **15 min + 60 s** y la captura ya vio el minuto 15 (`MAX(received_at)`).
- Lee la captura (`FUTURES_MARKET_DB_PATH`, o `--market-db`, o `server/data/dev-live/futures-market.sqlite`) **solo lectura** (`mode=ro`, `query_only`), con consultas por el índice `paper_futures_market_received(product_id, received_at, seq)` o por clave primaria (hay una prueba con `EXPLAIN QUERY PLAN`).
- Acotado: a lo sumo **8 tramos por llamada** (los más viejos primero) y **1,5 s** en total; pasado el plazo se corta con un aviso y sigue en la próxima pasada. Lo que ya se escribió queda.
- Sin el archivo de captura (otra máquina, otra ruta) no escribe nada, no avisa como fallo y deja una línea en el log (`sombra_estado = sin_captura`); cuando aparece, se pone al día solo.
- Si algo falla, queda en `avisos` (`sombra: …`) y el proceso en vivo lo anota en `errors` (`auditor_entrenar`); no cambia ninguna decisión, orden, cuenta ni fila del auditor (hay pruebas y una corrida guionada contra el commit base).

## Cómo leerlo

Por operación en la API del auditor: `auditoria.sombra = { entrada, salida }` (cada una con los campos de arriba, `null` mientras no esté resuelta o si falta la tabla). Se archiva en Parquet como `auditor_sombra` (día de `t_oficial_ms`).

Para decidir algo (S6 de T17): ≈ 70-100 entradas con foto y cinta completas, Δ medio ≥ +1 pb con IC95 > 0, tasa de llenado 90 ± 5 %, cruces ≤ 10 % y costo medio por cruce ≥ −30 pb. Solo se cuentan filas con `estado <> 'sin_datos'`; con foto del libro ≤ 20 s se espera perder ≈ un tercio de los tramos. La sombra mide el modelo contra el mercado real, **no la cola ni los rechazos post-only**: la fiabilidad del maker real no se puede comprobar bajo el ADR (supuesto declarado).

## Reversible

`DROP TABLE sombra_maker` en `auditor.sqlite`. Sin captura configurada, el código nuevo no hace nada.
