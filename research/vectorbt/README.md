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

- **Registro de intentos conectado a la compuerta (F4).** Todavía no existe. Cada barrido de VectorBT tiene que quedar anotado en un registro append-only que cuente para el Sharpe desinflado de la compuerta. Hasta que exista, un barrido no suma intentos y puede inflar un falso hallazgo.
- **Barridos de parámetros (F5).** Todavía no existen. Hoy el laboratorio solo exporta datos y verifica señales y operaciones.
