# Laboratorio VectorBT (research/vectorbt)

Laboratorio offline para probar hipótesis sobre las señales de Balancita con VectorBT. Vive en `research/vectorbt/` y usa su propio entorno Python.

## Qué es y qué NO es

**Es:**

- Una herramienta de investigación para probar hipótesis, por ejemplo qué pasa después de una señal.
- Un exportador de velas oficiales de Kraken, del período de práctica, a archivos Parquet sellados con manifiesto y SHA-256.
- Una prueba de paridad: compara señales y operaciones de VectorBT contra el motor de Balancita sobre las mismas velas.

**No es:**

- Un segundo simulador oficial. El P&L oficial lo sigue dando `futures_simulator.Book`.
- Algo que corre en la sesión paper o en el Python del motor. Tiene su propio entorno y sus propias dependencias.
- Un activador de estrategias. Nada de esto pasa a paper, forward ni captura.
- Una fuente de verdad. VectorBT calcula en float64 y el motor usa Decimal. Un resultado del laboratorio es una **hipótesis**; la compuerta (Strategy Gate) es la que decide.

## Instalación

Hace falta Python 3.12 y [uv](https://docs.astral.sh/uv/). El entorno queda en `.venv-vectorbt/`, que git ignora.

```bash
uv venv --python 3.12 .venv-vectorbt
uv pip install --python .venv-vectorbt/bin/python -r research/vectorbt/requirements.lock
uv pip check --python .venv-vectorbt/bin/python
```

- `requirements.txt` lista las dependencias directas (`vectorbt==1.2.0`, `pyarrow`, `pytest`).
- `requirements.lock` fija todas las versiones, también las indirectas. Es el que se instala.
- `uv pip check` cumple el papel de `pip check`: confirma que no haya dependencias rotas.
- Si cambia `requirements.txt`, hay que actualizar el lock también.

## Exportar datos de práctica

Ejemplo con la ventana 2025-11-01 a 2026-01-01:

```bash
.venv-vectorbt/bin/python -m research.vectorbt.export_practice --product PF_XBTUSD \
  --from 2025-11-01 --to 2026-01-01 --fetch --out data/research-vectorbt/practice
```

(Escribilo en una línea, o sin la barra invertida.)

Opciones principales:

- `--from` y `--to` en formato `YYYY-MM-DD`. `--to` no se incluye. Si se omiten, `--from` toma `default_from` de `config/strategy-gate.json` (2025-01-01) y `--to` toma el holdout (2026-04-19).
- `--fetch` llena primero la caché del laboratorio (`--cache-dir`, por defecto `data/research-vectorbt/cache`) desde la API pública de Kraken. Sin `--fetch`, se usa lo que ya haya en esa caché.
- `--resolutions` (por defecto `1m,5m`) y `--no-funding`.

Si la ventana toca el holdout, el exportador se niega. No la recorta.

Qué queda en `data/research-vectorbt/practice/PF_XBTUSD/`:

- `PF_XBTUSD_1m.parquet` y `PF_XBTUSD_5m.parquet`: las velas. Las columnas `open`, `high`, `low`, `close` y `volume_btc` son float64 para el laboratorio. Las columnas `*_text` guardan el texto original de Kraken. `filled` marca los minutos sin operaciones que se completaron con una vela plana, igual que hace el motor.
- `PF_XBTUSD_funding.parquet`: las tasas de funding por hora (no se genera con `--no-funding`).
- `manifest.json`: la ventana, el holdout, el SHA-256 de la configuración de la compuerta, el SHA-256 de cada archivo, un `dataset_sha256` que resume el conjunto y la cantidad de filas (y de filas rellenadas).

La carpeta queda **sellada**:

- Los archivos son de solo lectura.
- Si volvés a exportar la misma ventana y los datos dan el mismo `dataset_sha256`, se devuelve el manifiesto que ya existe.
- Si los datos cambian, se rechaza. Usá otra carpeta de salida.
- Antes de leer cada Parquet, la prueba de paridad verifica su SHA-256 contra el manifiesto. Un archivo modificado se rechaza.

## Prueba de paridad

```bash
.venv-vectorbt/bin/python -m research.vectorbt.parity --dataset data/research-vectorbt/practice/PF_XBTUSD \
  --json data/research-vectorbt/parity-PF_XBTUSD.json
```

Hace dos niveles sobre las mismas velas:

1. **Señales.** Compara, barra por barra, la regla C27 escrita a mano en numpy con `propose_spec` del motor.
2. **Operaciones.** Pasa las mismas entradas por `vectorbt.Portfolio.from_signals` y por `Book`, y empareja las operaciones por barra de entrada. VectorBT no conoce el funding, así que a sus operaciones se les descuenta aparte, con las tasas reales de Kraken.

**Cómo leer el resultado:**

- **Señales: se exigen 0 diferencias.** Es el único criterio que decide el código de salida: `0` si no hay diferencias, `1` si hay. Las primeras 20 diferencias aparecen en `signals.first_differences`. No se tolera ninguna.
- **Operaciones: no hay criterio de cero.** Se reportan y se explican. Campos principales en `trades`:
  - `engine`, `vectorbt` y `matched_by_entry`: cantidad de operaciones de cada lado y pares emparejados.
  - `only_engine` y `only_vectorbt`: operaciones que aparecen solo de un lado.
  - `different_exit`: misma entrada, salida distinta. En `first_exit_differences`, `engine_exit_candle_only_touches_level` indica si la vela de salida del motor solo tocó el nivel.
  - `same_exit_max_abs_residual_bp`: diferencia máxima de resultado neto entre operaciones con la misma salida, después de descontar la causa conocida. Tiene que quedar cerca de cero.
  - `by_exit_reason`: cantidad y diferencias por motivo de salida (por ejemplo `stop`).

**Causas conocidas de diferencia en operaciones:**

1. **Costo del stop.** En un stop, el motor cobra el impacto de un lado más un spread completo. Para BTC (`PF_XBTUSD`) son 0,06 + 0,12 = **0,18 bp**. VectorBT no lo modela. El reporte lo informa en `stop_cost_bp_not_in_vectorbt` y lo descuenta del residual.
2. **Toque exacto del nivel.** Si la vela de salida del motor solo toca el nivel del stop o del objetivo (máximo o mínimo justo en ese precio), el motor cuenta la salida y VectorBT no.

Una diferencia que no se explique con estas dos causas es un hallazgo para investigar. No se ajusta en silencio.

## Barridos y estudios (F5)

Tres herramientas sobre datos de práctica. Todas dejan la misma advertencia: lo que sale es una **hipótesis**, no una aprobación.

### Barrido acotado (`optimize`)

```bash
.venv-vectorbt/bin/python -m research.vectorbt.optimize --dataset data/research-vectorbt/practice/PF_XBTUSD \
  --experiment-id c27-exploracion-001 --budget 9 --seed 20261021
```

(Escribilo en una línea, o sin la barra invertida.)

- Recorre una grilla fija de C27: período Donchian 15, 20 y 25 por multiplicador de volumen 1,25, 1,5 y 1,75. Son 9 variantes.
- `--budget` es un tope. Si la grilla no entra, el comando se niega (código de salida 2) y no escribe nada. No amplía la grilla por su cuenta.
- Cada corrida va al registro de intentos (`data/research-vectorbt/ledger.sqlite`) antes de escribir el informe, incluidas las que fallan o no operan. Repetir el comando suma corridas, no variantes.
- Escribe `data/research-vectorbt/reports/c27-exploracion-001.md` y `.json`. El orden es por estabilidad del vecindario (cuántas vecinas de la grilla tienen media neta positiva), no por P&L.
- Neto por operación = resultado de VectorBT menos funding real de Kraken menos el costo de ejecución del stop, que VectorBT no modela.
- El resultado es una **hipótesis** sobre datos de práctica, nunca un PASA. El paso siguiente es `strategy_gate evaluate` sobre la reserva.

### Estudio de señales (`feature_study`)

```bash
.venv-vectorbt/bin/python -m research.vectorbt.feature_study --dataset data/research-vectorbt/practice/PF_XBTUSD \
  --horizons 5,15,30,60
```

- Describe qué hace el precio después de cada señal de C27 a 5, 15, 30 y 60 minutos. No simula operaciones.
- Política causal: la señal se lee al cierre de la vela `i`; la entrada es el **OPEN de la vela `i+1`**; el retorno a `h` minutos es el cierre de la vela `i+h` contra esa entrada.
- Eventos sin solape: un evento nuevo del mismo lado no empieza hasta pasado el mayor horizonte del anterior.
- MFE y MAE usan máximos y mínimos de esas mismas velas. Describen el recorrido del precio. **No prueban que una orden se hubiera ejecutado a esos precios.**
- Informe en `data/research-vectorbt/reports/feature-study-<estrategia>-PF_XBTUSD.md` y `.json`. Compara el retorno medio con el costo de ida y vuelta del producto.

### Tarjeta de candidatas (`summarize`)

```bash
.venv-vectorbt/bin/python -m research.vectorbt.summarize --experiment-id c27-exploracion-001
```

- Lee el registro de intentos en solo lectura y resume cada variante distinta con su última corrida, la cantidad de corridas y las vecinas positivas. Imprime la tarjeta; no escribe nada.
- Criterio **«prometedora en práctica»**: simple y declarado, no es un veredicto. Hace falta al menos 100 operaciones, media neta mayor que 0 y que más de la mitad de las vecinas de la grilla también tengan media neta mayor que 0.
- Ninguna variante queda aprobada por esta tarjeta. La decisión es de la compuerta.

## Explorar cualquier estrategia (`explore`)

El laboratorio ya no es solo de C27. `explore` corre **cualquier** estrategia de reglas (`balancita-strategy.v1`, `kind: rules` o `regime_adapter`) sobre los datasets de práctica y deja un reporte en lenguaje simple: qué funciona y qué falla. El formato completo, para el front, está en [`docs/vectorbt-exploration-api.md`](../../docs/vectorbt-exploration-api.md).

```bash
.venv-vectorbt/bin/python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode diagnostic
.venv-vectorbt/bin/python -m research.vectorbt.explore --strategy c27-breakout-perp-v1 --mode variants --vary stop_atr --values 1,1.5,2,2.5
```

(Cada comando va en una línea.) Hace falta tener exportados los datasets de práctica de los productos de `config/strategy-gate.json` (ver «Exportar datos de práctica»).

- **`diagnostic`**: la estrategia tal cual, sobre los productos y la ventana de la compuerta (nunca velas desde `holdout_from`). El reporte trae totales, desglose por producto, por forma de salida (objetivo, stop, regla propia, tiempo) y por lado, y las listas `works` y `fails` con frases simples generadas a partir de los números.
- **`variants`**: varía **una sola cosa** (un parámetro de `params`, o una constante numérica de una condición por su ruta) sobre una lista de **hasta 12 valores**. Cada corrida, también las fallidas, queda en el registro de intentos **antes** de escribir el informe, y el reporte incluye el ranking (por resultado neto, con empate por entradas por día) y el contador de intentos de la familia.
- **Progreso**: una línea JSON por avance en stdout, `{"progress": 0-100, "phase": "...", "detail": "..."}`. Avanza con el trabajo hecho.
- **Salida**: `data/research-vectorbt/explorations/<id>/report.json` y `report.md`. Todo es una **hipótesis**; el aviso estándar va en el reporte.

Cómo está armado:

| Módulo                  | Qué hace                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generic_signals.py`    | Evaluador vectorizado (numpy / Numba, float64) de una spec: `evaluate_spec(spec, market)` devuelve un `Plan` con las señales, los niveles de stop y objetivo, los niveles congelados y la regla de salida compilada. `Market.from_dataset(...)` / `Market.from_candles(...)`. Lo que no puede reproducir lanza `UnsupportedSpec` con un mensaje en español. |
| `generic_sim.py`        | `simulate_plan(plan, market)`: las operaciones con `vectorbt.Portfolio.from_signals`, con motivo de salida, bp bruto y bp neto (comisiones y costos del motor, funding real, costo del stop).                                                                                                                                                               |
| `exploration_report.py` | Números del reporte y reglas de las frases en lenguaje simple.                                                                                                                                                                                                                                                                                              |
| `explore.py`            | La línea de comandos y `run_exploration(...)`.                                                                                                                                                                                                                                                                                                              |

**Qué soporta.** Todos los nodos y operandos del lenguaje cerrado de specs (`cmp`, `available`, `regime_in`, `not`, `all`, `any`, `and`; `1m.`, `1m_previous.`, `5m.`, `position.` + parámetros y `mul`), los indicadores `ema`, `sma`, `rsi`, `atr`, `bollinger_*`, `donchian_*`, `prior_volume_mean`, `logret` y `logvol` con los períodos declarados, el régimen con histéresis, las puertas, los niveles `risk` (también `vol` en escala logarítmica), el filtro de costo mínimo y las salidas con niveles congelados. Paridad con el motor probada en C25, C26, C27, C28, C29 y C30. **No soporta** C32 (`5m.fundpct`, el percentil de funding): el reporte sale con `status: "unsupported"` y el motivo. Detalle en el documento de formato.

**Paridad.** `tests/test_generic_parity.py`: 0 diferencias de señal y de niveles contra `propose_spec`, barra por barra, y las operaciones contra `Book`. La única diferencia de operaciones es la conocida (una vela que solo toca el nivel). Las entradas son siempre el cierre de la vela de la señal, como en el motor.

**Tiempos.** Un año de velas 1m sintéticas (525.600 velas) con C28, un producto: unos 17 a 19 segundos, de los cuales unos 12 son la compilación del simulador, que se paga una vez por proceso.

## Ciclo de vida

Esta tabla resume los estados del **ciclo de investigación**. No son los estados del registro S (`draft`, `shadow`, `active`, `retired`).

| Estado                | Qué significa                                                                               | Quién decide                     |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| BORRADOR              | Hipótesis o variante escrita, todavía sin medir.                                            | Usuario / diseñador              |
| INVESTIGACIÓN         | Se estudia en el laboratorio (barridos, estudios de señales). Los resultados son hipótesis. | Laboratorio                      |
| CANDIDATA             | Cumple el criterio «prometedora en práctica» de `summarize`. No es aprobación.              | Criterio automático y declarado  |
| PARIDAD               | El motor y VectorBT coinciden en señales, y las operaciones tienen causa explicada.         | Prueba de paridad                |
| PRÁCTICA              | Corrida sobre la ventana de práctica con funding.                                           | Compuerta (antes del corte)      |
| CONGELADA             | Spec y criterio fijados antes de mirar la reserva.                                          | Registro S (spec, hash, dataset) |
| EXAMEN                | La compuerta evalúa sobre la reserva.                                                       | `strategy_gate evaluate`         |
| APROBADA              | La compuerta la aprueba.                                                                    | `strategy_gate evaluate`         |
| INCONCLUSA            | La compuerta no alcanza para decidir.                                                       | `strategy_gate evaluate`         |
| SHADOW                | Fase posterior a la compuerta, fuera de este laboratorio.                                   | Sistema / usuario                |
| FORWARD               | Fase posterior a la compuerta, fuera de este laboratorio.                                   | Usuario (solo paper)             |
| SEGUIMIENTO           | Seguimiento posterior a la puesta en marcha.                                                | Operación                        |
| DESCARTADA / RETIRADA | Sale del ciclo; queda en el registro.                                                       | Protocolo / usuario              |

## Cómo correr las pruebas

```bash
.venv-vectorbt/bin/python -m pytest research/vectorbt/tests
```

- Ejecutalo desde la raíz del repo y con `-m`. Así la carpeta actual entra en el path y se importa el paquete `research`.
- No uses `-I` (modo aislado): ignora la carpeta actual y las pruebas no encuentran `research`.
- Las pruebas usan velas sintéticas. Cubren el aislamiento del holdout, la repetibilidad del exportador y la paridad de señales.

## Reglas de aislamiento

- **Nada desde el holdout (2026-04-19).** El exportador no exporta velas que cierren después del corte, y valida cada vela antes de sellar. Una ventana que lo toque se rechaza.
- **La fuente se abre en solo lectura.** La caché se abre con `mode=ro`.
- **No se escribe en ninguna base de Balancita.** Lo que se genera va a `data/research-vectorbt/` (ignorado por git) y a `.venv-vectorbt/`. `--fetch` llena la caché del laboratorio, no la de Balancita.
- **El motor no depende del laboratorio.** El laboratorio lee el motor; el motor sigue usando solo la biblioteca estándar.

## Pendiente

- **Registro de intentos conectado a la compuerta (F4): hecho.** Está en `research/vectorbt/trial_ledger.py` y guarda en `data/research-vectorbt/ledger.sqlite` (ruta por defecto, parámetro `path`).
  - **Append-only.** La tabla `trials` tiene triggers que abortan `UPDATE` y `DELETE`. Un solo escritor: la clase `Ledger` del laboratorio. La compuerta solo lo lee (`mode=ro`) y el laboratorio nunca escribe en `gate.sqlite`.
  - **Corrida vs. variante.** `Ledger.record_run(...)` agrega siempre una fila nueva (una corrida). La variante es la hipótesis: `variant_key` = SHA-256 del JSON canónico `{familia, parámetros ordenados}`. Repetir una configuración suma una corrida pero no una variante. Solo las variantes cuentan como intentos.
  - **Familia.** Es el id sin el sufijo `-vN` (`family_of` de la compuerta), así que renombrar `c27-breakout-perp-v2` no cambia la familia ni borra historia.
  - **Selección.** Elegir una corrida para la compuerta (`Ledger.record_selection`) agrega una fila nueva con estado `selection`; la fila elegida no se toca.
  - **Conexión.** `strategy_gate.evaluate` suma a `attempts` las variantes distintas de la familia (`research_trials`, solo `sqlite3`). El Sharpe desinflado usa esa suma y el informe dice «intentos: N (de la compuerta) + M (variantes del laboratorio)». Opción `--research-ledger`; con la carpeta de datos por defecto lee `data/research-vectorbt/ledger.sqlite`, y si no existe suma 0.
  - **Obligación para F5.** Todo barrido tiene que registrar cada corrida con `record_run`, incluso las que fallan o no operan. `optimize` la cumple.
- **Botón «Investigar con VectorBT» en `/estrategias`** (opcional). El laboratorio ya tiene el contrato para el front (`explore`, ver arriba); falta la pantalla.
- **Corrida real sobre toda la ventana de práctica con funding.** Las pruebas usan velas sintéticas. Falta exportar `PF_XBTUSD` con funding (sin `--no-funding`) y correr `optimize`, `feature_study` y `summarize` sobre `data/research-vectorbt/practice/PF_XBTUSD`.

## Detalle de eventos del analizador (`event_trades`)

Para simular apalancamiento y tamaños de entrada en la app hacen falta los eventos uno por uno, no solo promedios. `python -m research.vectorbt.event_trades --datasets DIR_BTC DIR_ETH DIR_SOL --out data/research-vectorbt/analyzer/events.json` reusa `event_study` (sin modificarlo) y escribe `balancita.analyzer-events.v1`: las mismas 78 celdas del informe más, por producto, tipo y ventana, cada evento con retorno de largo, máximo y mínimo del precio y funding para los horizontes 5, 15, 30 y 60. Solo datos de práctica; no toca el registro de intentos ni los informes. El engine lo sirve de solo lectura en `GET /analyzer/events`.
