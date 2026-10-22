# Exploración con VectorBT: formato del reporte

Contrato entre el laboratorio (`research/vectorbt/explore.py`) y el front. El laboratorio corre con **cualquier** estrategia de reglas (`balancita-strategy.v1`, `kind: rules` o `regime_adapter`), no solo con C27, y deja un reporte JSON en lenguaje simple.

Todo lo que sale de acá es una **hipótesis** sobre datos de práctica. No aprueba nada, no activa nada y no toca paper, forward ni captura. El único veredicto es la compuerta (`strategy_gate evaluate`) sobre la reserva.

## Cómo se lanza

```bash
.venv-vectorbt/bin/python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode diagnostic
.venv-vectorbt/bin/python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode variants --vary stop_atr --values 1,1.5,2,2.5
```

(Se escribe en una línea.) Desde Python: `research.vectorbt.explore.run_exploration(...)`.

| Opción             | Qué es                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--strategy`       | Id de una spec de `config/strategies/` o ruta a un archivo de spec. Desde Python también un `dict`.                                                            |
| `--mode`           | `diagnostic` (la estrategia tal cual) o `variants` (varía una sola cosa).                                                                                      |
| `--vary`           | Solo `variants`. Un nombre de `params` (`stop_atr`) o la ruta a una constante numérica de una condición (ver abajo).                                           |
| `--values`         | Solo `variants`. Valores separados por coma. **Máximo 12**; con más, el comando se niega (código 2) y no escribe nada. Nunca se amplía solo.                   |
| `--products`       | Productos separados por coma. Por defecto `default_products` de `config/strategy-gate.json`.                                                                   |
| `--datasets-dir`   | Carpeta con un dataset sellado por producto (`<dir>/<PRODUCTO>/manifest.json`). Por defecto `data/research-vectorbt/practice`. Se crean con `export_practice`. |
| `--exploration-id` | Id de la exploración (letras, números, `.`, `-`, `_`). Por defecto `<strategy_id>-<AAAAMMDD-HHMMSS>`. Si ya existe, se niega.                                  |
| `--out-dir`        | Por defecto `data/research-vectorbt/explorations`.                                                                                                             |
| `--ledger`         | Registro de intentos. Por defecto `data/research-vectorbt/ledger.sqlite`.                                                                                      |
| `--gate-config`    | Por defecto `config/strategy-gate.json`.                                                                                                                       |

**Ventana de datos.** Es la de los datasets de práctica; el laboratorio nunca lee velas desde `holdout_from` (2026-04-19). `lab_common.check_dataset` rechaza un dataset que llegue a la reserva, o cuyos archivos no coincidan con su manifiesto, antes de leer nada.

**Código de salida.** `0`: terminó (también cuando la estrategia no se puede evaluar: eso es un reporte con `status: "unsupported"`). `2`: pedido rechazado (dataset faltante o modificado, ventana que toca la reserva, más de 12 valores, algo que variar que no existe, id repetido). Los errores van a stderr con el prefijo `ERROR:`.

## Progreso (stdout)

Una línea JSON por avance:

```json
{
  "progress": 37.5,
  "phase": "Probando variantes",
  "detail": "stop_atr = 2 en PF_XBTUSD"
}
```

- `progress`: 0 a 100, nunca baja. Avanza con el trabajo hecho (cada corrida de cada producto es una parte de la barra), no por tiempos fijos.
- `phase` y `detail`: texto en español para mostrar. Fases: `Preparando`, `Cargando datos`, `Probando la estrategia`, `Preparando el simulador`, `Probando variantes`, `Armando el informe`, `Listo`.
- La primera simulación de cada proceso compila el simulador (unos 10 a 30 segundos, una sola vez): lo anuncia la fase `Preparando el simulador`.
- La última línea es `{"progress": 100, "phase": "Listo", "detail": "<ruta de report.json>"}`. Si el pedido se rechaza, la última línea es `{"progress": 0, "phase": "Error", "detail": "<motivo>"}`.

## Archivos

`data/research-vectorbt/explorations/<exploration_id>/report.json` (el contrato) y `report.md` (la misma información legible). Se escriben **después** de registrar todas las corridas en el registro de intentos.

## `report.json`

Esquema `balancita.vectorbt-exploration.v1`. Los números son `float` (pb = puntos básicos, 1 pb = 0,01 % de lo operado); un dato que no existe es `null`.

| Campo                                    | Qué es                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                 | `"balancita.vectorbt-exploration.v1"`                                                                                                                                                              |
| `exploration_id`, `mode`                 | Id y modo (`diagnostic` / `variants`).                                                                                                                                                             |
| `status`                                 | `"ok"` o `"unsupported"`.                                                                                                                                                                          |
| `strategy_id`, `strategy_name`, `family` | La estrategia y su familia (el id sin `-vN`).                                                                                                                                                      |
| `spec_hash`                              | Hash canónico de la spec corrida.                                                                                                                                                                  |
| `window`                                 | `{from, to}`: del inicio al fin (exclusivo) de los datos, UTC. Con varios productos, el más temprano y el más tardío.                                                                              |
| `products`                               | Productos corridos.                                                                                                                                                                                |
| `dataset_sha256`                         | Hash de los datos (con varios productos, el hash de los hashes). `datasets[]` trae cada uno: `{product, dataset_sha256, from, to}`.                                                                |
| `generated_at`                           | Fecha y hora UTC de la corrida.                                                                                                                                                                    |
| `cost_model_version`                     | Versión del modelo de costos del motor.                                                                                                                                                            |
| `warning`                                | Aviso estándar: son hipótesis, no un PASA. **Mostralo siempre.**                                                                                                                                   |
| `glossary`                               | `{pb, neto, bruto}`: qué significa cada palabra.                                                                                                                                                   |
| `unsupported`                            | `null`, o `{reason}` con el motivo en español si la estrategia usa algo que el laboratorio no reproduce.                                                                                           |
| `diagnostic`                             | Ver abajo. `null` si `status` es `unsupported`.                                                                                                                                                    |
| `vary`                                   | Solo `variants`: `{kind: "param" \| "condition", name, label, base_value}`.                                                                                                                        |
| `variants`                               | Solo `variants`: lista ordenada (ver abajo).                                                                                                                                                       |
| `variants_headline`                      | Solo `variants`: una o dos frases simples sobre el conjunto.                                                                                                                                       |
| `attempts_in_family`                     | Variantes distintas de la familia en el registro de intentos (`ledger.distinct_variants(family_of(id))`), contando las de esta corrida. En `diagnostic` es una lectura del registro, sin escribir. |

### `diagnostic`

La estrategia **tal cual**, sobre todos los productos.

- `totals`: `{trades, entries_per_day, gross_bp_mean, net_bp_mean, hit_rate, funding_complete_share}`.
  - `entries_per_day`: operaciones por día sumadas entre productos (cada producto sobre los días de su ventana).
  - `gross_bp_mean`: movimiento del precio entre la entrada (cierre de la vela de la señal) y la salida (nivel del stop u objetivo, o cierre de la vela), antes de cualquier costo.
  - `net_bp_mean`: resultado de VectorBT (comisión taker de ida y vuelta y costo de ejecución del motor) menos el funding real de Kraken, menos el costo de ejecución del stop, que VectorBT no modela. Es comparable con el `net_bp` del motor.
  - `hit_rate`: parte de operaciones con resultado neto mayor que 0.
  - `funding_complete_share`: parte de operaciones cuyo tiempo abierto está cubierto por funding conocido. Si los datos no traen funding es `0` y hay un aviso en `notes`.
- `by_product[]`: `{product, days, trades, entries_per_day, gross_bp_mean, net_bp_mean, hit_rate, funding_complete_share}`.
- `by_exit[]`: `{reason, label, trades, share, gross_bp_mean, net_bp_mean, hit_rate, funding_complete_share}`. `reason` es `target`, `stop`, `rule` (la regla de salida propia de la estrategia) o `time` (venció `horizon_minutes`); `unknown` si una salida no se pudo clasificar (no debería pasar). `label` es el texto en español para mostrar. Una vela que toca stop y objetivo cuenta como stop, igual que el motor.
- `by_side[]`: `{side: "LONG" | "SHORT", label, trades, share, ...}`.
- `signals`: `{raw, skipped_by_cost}`: entradas que la estrategia propone y cuántas descarta el motor porque el objetivo no cubre el costo de ida y vuelta más un colchón de 2 pb.
- `open_at_end`: posiciones que quedaron abiertas al final de los datos (no cuentan como operaciones).
- `works[]`, `fails[]`, `notes[]`: frases en lenguaje simple (ver reglas). `notes` son avisos sobre los datos.

### `variants[]`

Ordenadas por `net_bp_mean` de mayor a menor y, en empate, por `entries_per_day` de mayor a menor (más operaciones es más evidencia). Las que no operaron o fallaron van al final.

`{rank, value, label, is_base, trades, entries_per_day, net_bp_mean, gross_bp_mean, hit_rate, status, error, trial_id}`

- `value`: el valor probado, como texto (`"2"`, `"1.5"`). `label`: `"stop_atr = 2"`. `is_base`: es el valor que la spec ya tiene (esa corrida reutiliza el diagnóstico).
- Solo en las filas `ok`, para la comparación con el simulador: `funding_bp_mean` (funding real medio, pb; positivo resta), `funding_complete_share`, `stop_share` (parte de operaciones cerradas por stop) y `signals` (`{raw, skipped_by_cost}`). `diagnostic.totals` y cada `by_*` traen también `funding_bp_mean`.
- `status`: `ok`, `no_trades` (no operó) o `error` (falló: el motivo está en `error`; un valor que la spec no admite cuenta como error).
- `trial_id`: id de la corrida en el registro de intentos. **Cada** valor, también los fallidos, tiene su fila antes de escribirse el reporte.

### Qué variar (`--vary`)

- **Un parámetro**: el nombre en `params` de la spec (`stop_atr`, `target_stop_ratio`, `volume_multiplier`, `z_min`...).
- **Una constante numérica de una condición**: su ruta en la spec, con puntos y corchetes. El corchete lleva el número de posición o, en `checks`, el nombre del chequeo: `rules.checks[2].node.right`, `rules.checks[volume_ok].node.right.mul[1]`, `branches.trend.rules.checks[long].node.all[5].and[0].right`. Tiene que apuntar a un texto numérico de la spec (no a `$parametro` ni a un dato como `1m.rsi14`; para un parámetro se usa su nombre). El motor solo admite constantes sin punto decimal en las condiciones (`"0"`, `"-1"`, `"50"`); para decimales la spec usa un parámetro.

La identidad de cada variante en el registro es `{spec_hash, vary, value}`: repetir la misma exploración suma corridas, no variantes. Cambiar la spec (otro hash) sí crea variantes nuevas.

### Reglas de las frases (`works[]` / `fails[]`)

Cada frase sale de una regla con un umbral escrito en `exploration_report.py`; se puede comprobar contra los números del mismo reporte. No usan jerga.

| Regla                                         | Frase                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resultado total                               | «En total gana +X pb por operación después de costos, en N operaciones.» o «En total pierde X pb…»                                                                                                                                                         |
| Costos                                        | Si pierde pero antes de costos gana: «Antes de costos gana X pb por operación, pero las comisiones, el costo de ejecución y el funding se llevan Y pb: queda Z pb.» Si ni antes de costos gana: «Ni antes de costos gana…»                                 |
| Frecuencia                                    | Pierde y entra 5 o más veces por día: «Entra N veces por día y cada entrada paga costos…»                                                                                                                                                                  |
| Cada forma de salida con 10 o más operaciones | «Los cierres por objetivo ganan +70 pb en promedio (son el 24 % de las operaciones).» · «Los cierres por stop pierden…» · «La salida por regla propia (cruce de la media del canal) cierra el 53 % de las operaciones y siempre pierde.» (si ninguna gana) |
| Lados                                         | Con 30 o más operaciones por lado y signos opuestos: «Compras (LONG) ganan… / Ventas en corto (SHORT) pierden…»                                                                                                                                            |
| Productos                                     | Con 30 o más operaciones por producto: una frase por producto; si gana en unos y en otros no: «No funciona en todos los productos…»                                                                                                                        |
| Entradas descartadas                          | 30 % o más de las señales: «El X % de las entradas que detecta se descartan porque el objetivo no alcanza a cubrir el costo de operar.»                                                                                                                    |
| Pocas operaciones                             | Menos que `rules.min_trades` de la compuerta (100): «Con solo N operaciones no alcanza para sacar conclusiones…»                                                                                                                                           |
| Sin operaciones                               | «No operó nunca…» o «Detecta N entradas pero todas se descartan…»                                                                                                                                                                                          |

## Qué estrategias soporta

`research/vectorbt/generic_signals.py` reproduce, barra por barra, lo que hace `propose_spec` del motor con la misma alineación de velas que `futures_simulator.frames`.

**Soportado** (spec `kind: rules` y `kind: regime_adapter`, con las ramas de `trend` / `range`):

- Nodos: `cmp` (`>`, `>=`, `<`, `<=`), `available`, `regime_in`, `not`, `all`, `any`, `and`.
- Operandos: constantes y `$parametros`, `{"mul": [a, b]}` (anidable), y `1m.`, `1m_previous.`, `5m.` + `candidate_close`, `candidate_high`, `candidate_low`, `candidate_volume`, `ema<P>`, `sma<P>`, `rsi<P>`, `atr<P>`, `logret<P>`, `logvol<P>`, `bollinger_{mid,variance,stddev,lower,upper}<P>`, `donchian_{high,low,mid}<P>`, `prior_volume_mean<P>`, con los períodos que la spec declara en `indicators` (más los que trae el motor por defecto). `position.frozen_target` y `position.frozen_invalidation` en las reglas de salida.
- Régimen `unknown` / `trend` / `range` con histéresis (EMA 9 y 21 y ATR 14 de 5 m), puertas `previous` / `trend`, `ready` (50 velas de calentamiento, ATR positivo, ventanas Donchian completas), `sides.requires` (gana LONG en un empate), `invalidation` con nivel congelado (`...@{operando}`), `target` por operando, `risk` con `stop_atr` y `target_stop_ratio` (también `vol` en escala logarítmica), redondeo al tick del producto (`config/futures-products.json`), el filtro de costo mínimo del motor, y el stop de tiempo (`horizon_minutes`).
- Salidas: stop, objetivo, regla de salida propia con los niveles congelados al entrar, y tiempo; en el mismo orden que el motor dentro de una vela (stop, objetivo, regla, tiempo).

**No soportado** (el reporte sale con `status: "unsupported"` y el motivo; no se ignora nada en silencio):

- `5m.fundpct` (C32): la posición del funding frente a los 30 días anteriores depende del historial de funding tal como lo conocía la captura en cada instante; el laboratorio no lo reproduce.
- Cualquier dato fuera del catálogo (`candidate_open`, `ready`, etc.), `available` sobre `position.*`, una spec que el motor no valida, o una regla de salida demasiado profunda.

**Paridad.** `tests/test_generic_parity.py` compara las señales y los niveles de stop y objetivo con `propose_spec` barra por barra (C25, C26, C27, C28, C29, C30 y dos specs propias que usan Bollinger, SMA, RSI, EMA, ATR, `logret`, `logvol`, `any`, `not`, `regime_in`, `available`, `target` por operando, `risk.vol` en 1 m y `position.*` dentro de `mul`) con 0 diferencias, y las operaciones con el `Book` del motor. La única diferencia de operaciones que aparece es la conocida: una vela que solo **toca** el nivel (el motor cierra, VectorBT necesita cruzarlo).

## Límites

- El laboratorio calcula en float64 y el motor en Decimal. Una vela con los dos lados de una comparación iguales hasta el último dígito podría diferir; la prueba de paridad cuenta esos casos (hoy 0).
- El resultado neto de VectorBT no es el oficial: el oficial lo da `futures_simulator.Book` y el veredicto lo da la compuerta.
- Elegir lo mejor de varias variantes infla el resultado. Por eso `attempts_in_family` va en el reporte y alimenta el contador de intentos de la compuerta.
