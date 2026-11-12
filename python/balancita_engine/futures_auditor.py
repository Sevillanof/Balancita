"""Auditor de decisiones del paper trader en vivo (Qwen en vivo, versión 9).

Cada 15 minutos el trader mira y decide con dos fórmulas: el maestro (puntaje, veredicto -2..2) y el portero (probabilidad contra
umbral), más las noticias. Aquí se anota, para CADA mirada, qué decidió y en qué condiciones, y más tarde (a las 12, 24 y 36 h)
si esa decisión fue acertada y cuánto costó equivocarse. No interfiere: nunca escribe en ``live.sqlite`` ni cambia una decisión.
Escribe su propia base, ``auditor.sqlite``, en la MISMA carpeta que ``live.sqlite`` (la lee también el servidor).

Tablas de ``auditor.sqlite`` (``balancita-auditor.v1``)

* ``miradas``: una fila por mirada (producto + balde de 15 min). Se inserta en vivo (``snapshot``) con el estado, la acción
  clasificada, lo que dijeron el maestro, el portero, las noticias y Qwen, la posición y una foto de las condiciones
  (``condiciones_json``). Más tarde ``resolve`` completa ``despues_json`` (qué hizo el precio) y los veredictos a 12 h (provisorio),
  24 h y 36 h (definitivo: ``resuelto_ms``).
* ``meta``: ``schema`` = ``balancita-auditor.v1`` (no cambia: lo que se sumó es aditivo) y ``direccion`` = ``v1``.
* ``operaciones``: una fila por operación de ``live.sqlite`` (producto + ``trade_no``) con la dirección y el MAE/MFE de la operación
  (ver «Dirección»). ``miradas`` suma ``direccion_json`` y ``direccion_ms``.

Dirección (S3 de ``odd/tasks/noticias-y-auditor.md``; aparte de los veredictos de «la operación pagó», que NO cambian)

* Por mirada, ``direccion_json`` = ``{"lado": ±1|null, "4h": {...}|null, "12h": ..., "24h": ...}``; cada horizonte trae ``mov_pb`` (el
  movimiento del precio sin signo de lado, desde el cierre de la mirada), ``a_favor_pb`` (lado x movimiento) y ``acerto`` (``true`` si el
  precio fue en el sentido del lado, ``false`` si fue en contra, ``null`` si no se movió ni un punto básico exacto). El lado es el de
  la mirada (``_reference_side``: posición, si no maestro, puntaje, noticias); sin lado todo queda ``null``. En un SALIR, ``acerto`` dice
  si el precio siguió a favor de la posición cerrada (o sea, que salir costó). Sin costo y sin salida: solo el signo del precio.
* Por operación, ``operaciones.direccion_json`` igual, medido desde la entrada (``entry_ms``) con el lado de la operación y sin
  importar cuándo cerró; ``mfe_pb`` / ``mae_pb`` = lo mejor / lo peor que el precio hizo a favor de la operación entre la entrada y la
  salida (o hasta ahora si sigue abierta; ``hasta_ms`` dice hasta qué cierre), sobre cierres de 5 min más el precio de salida real,
  con ``mfe_pb >= 0 >= mae_pb``. Se calcula para CADA operación aunque una mirada nombre solo la primera de varias abiertas.
* Un horizonte se mide solo cuando ya pasó entero (``ahora >= t_ms + horizonte``): sin mirar al futuro, aunque la caché de velas lo
  tenga. Mientras falte alguno, la fila se vuelve a mirar; ``direccion_ms`` / ``resuelto_ms`` quedan ``NULL`` hasta que estén los tres.
* Migración: ``_open`` agrega las dos columnas con ``ALTER TABLE ... ADD COLUMN`` y crea ``operaciones`` si faltan; las filas viejas
  quedan intactas con ``NULL`` y ``resolve`` las completa con las velas y operaciones que el auditor ya lee (incluso las ya resueltas a
  36 h). Se deshace con ``ALTER TABLE miradas DROP COLUMN direccion_json`` / ``direccion_ms`` y ``DROP TABLE operaciones``.

Para entrenar más adelante (S8 y T15 de ``odd/tasks/noticias-y-auditor.md``; ``docs/auditor-para-entrenar.md``). Solo TABLAS NUEVAS; nada de lo
anterior cambia y el trader no cambia ninguna decisión: lo único que expone es ``Trader.look_audit``, una nota de solo lectura.

* ``hechos_mirada`` (G1 + G4): por mirada, los hechos aplanados del maestro (``maestro.flat_facts``: los 15 direccionales y los 5 tamaños),
  su puntaje y veredicto, lo que hace falta para recalcular el voto del portero y la identidad del proponente (hash del maestro y del
  portero, hash y versión de la config, modelo de costos). ``version`` sigue siendo la del auditor.
* ``propuestas`` (G2): cada señal de entrada (maestro fuerte con el portero a favor), abierta o bloqueada, con el motivo del bloqueo
  (``lugares_ocupados``, ``mismo_episodio``, ``subida_30d`` y ``separacion_60min`` de las reglas del maestro, ``enfriamiento``, ``cierre_en_la_mirada``, ``otro``). La etiqueta contrafactual (neto con costos,
  motivo de salida y horas con las reglas oficiales: ``corta.formula_action`` y el tope de tiempo) la calcula DESPUÉS ``resolve``.
* ``mirada_operaciones`` (G3): una fila por posición abierta y mirada con lado, horas, neto ahora, puntaje del maestro contra el lado y lo que
  dice la regla de salida.
* ``resultados_operacion`` (G5): el resultado real de cada operación cerrada (neto de los recibos, motivos, precios y MFE/MAE con máximos y
  mínimos de las velas; ``operaciones`` con los cierres no cambia).
* ``reentrenos`` (G8): registro solo-agregar (``registrar_reentreno``, ``--registrar-reentreno``).
* ``sombra_maker`` (``odd/tasks/maker-sombra.md``, ``docs/maker-sombra.md``): una fila por tramo OFICIAL (entrada o salida, a mercado) con lo que habría pasado
  con una orden límite en el mejor precio sobre la cinta real capturada por el servidor (solo lectura): tipo de llenado (``maker`` /
  ``maker_mercado`` / ``sin_datos``), precio y hora, comisiones de cada punta y la diferencia contra el oficial en US$ y pb. La calcula ``resolve``
  (``market_db``) solo con 15 min de cinta ya capturada; acotada (3 tramos por pasada, configurable, y 1,5 s por llamada; el proceso en vivo la corre solo en un
  sondeo tranquilo, ``resolve_shadow``); nunca adivina (sin libro o cinta, ``sin_datos``).
* ``miradas_perdidas`` (``odd/tasks/operacion-mejoras.md`` S2, ``docs/terminal-ciclo-de-vida.md``): una fila por mirada programada que la Terminal no hizo
  (``record_missed``): hora, motivo (``proceso_detenido``), si había posición y lo que la fórmula habría dicho con las velas de esa mirada (hipotético: nunca operó).
* ``record_look`` y ``record_missed`` (en vivo) y los pasos nuevos de ``resolve`` NUNCA propagan una excepción: lo que falla queda en ``avisos`` y el proceso en
  vivo lo anota en su tabla ``errors``. Migración: ``_open`` crea las tablas (``CREATE TABLE IF NOT EXISTS``); se deshace con ``DROP TABLE``.
* ``duraciones_auditor`` (``odd/tasks/operacion-mejoras.md`` T9, ``docs/auditor-para-entrenar.md``): solo-agregar, una fila por mirada (y por pasada de la sombra) con lo que
  tardó cada paso en milisegundos y el total (``record_durations``). Es un diagnóstico de la operación: no entra en ningún archivo ni en ninguna decisión.

Acciones (``accion``)

    ENTRAR, ENTRAR_noticias (entró por noticias con el portero en contra), NO_ENTRAR_portero (maestro fuerte, portero no),
    NO_ENTRAR_maestro (el maestro no está fuerte), NO_ENTRAR_regla (cualquier otro motivo; el motivo crudo queda en
    ``condiciones_json["motivo"]``), MANTENER, SALIR_vuelta (el maestro se dio vuelta), SALIR_24h (pasaron las horas de agotamiento y
    el maestro perdió fuerza), SALIR_12h_noticias, SALIR_36h (tope de tiempo) y SALIR_otro (emergencia, maker, stop).

``lado_posicion`` es el lado (+1 largo / -1 corto) de la operación sobre la que decidió la mirada: la abierta en ENTRAR*, la que se
tenía en MANTENER y SALIR_*; 0 en NO_ENTRAR_* (``estado`` dice si antes de decidir estaba plana o en posición).

Reglas de acierto (A.3 del diseño; se miran a 12, 24 y 36 h desde la mirada)

* ENTRAR / ENTRAR_noticias: acierta si el neto de la operación real a esa hora es > 0 (``trades.net_bp`` si cerró antes; si no, marcado
  al precio de esa hora menos el costo de ida y vuelta). Costo del error = la pérdida.
* NO_ENTRAR_portero / NO_ENTRAR_maestro: acierta si la operación que no se abrió (la del lado del maestro, con la salida de la versión 8,
  ``futures_qwen_trader_exam._v8_exit``, truncada a esa hora) no ganaba (<= 0). Costo = lo que habría ganado. NO_ENTRAR_regla ídem con
  ``regla: "apagado"``.
* MANTENER: acierta si lo que quedó (lado x movimiento del precio desde la mirada hasta la salida real o hasta esa hora, lo que llegue
  antes) es >= 0. Costo = lo perdido desde ahí.
* SALIR_vuelta / SALIR_24h / SALIR_12h_noticias: acierta si aguantar no sumaba (lo que el precio hizo a favor de la posición cerrada
  hasta esa hora es <= 0). Costo = lo que sumaba.
* SALIR_36h y SALIR_otro no se juzgan (``{"acerto": null, "regla": "regla fija"}``).

Precios: todo sale de cierres de velas de 5 min (``{t_ms del cierre: cierre}``, como el ``closes_of`` de
``futures_qwen_aprende.resolve_live``), así que MFE/MAE y los marcados son sobre cierres, no sobre máximos y mínimos. ``mov_*`` es el
movimiento del precio SIN signo de lado (positivo = subió); ``mfe_36h`` / ``mae_36h`` y los resultados de los veredictos son del
lado de la posición (o del maestro). ``mfe_36h`` / ``mae_36h`` van corriendo hasta que pasan 36 h (``hasta_ms`` dice hasta qué cierre).

Condiciones (``condiciones_json``): todo opcional, ``null`` si no hay. Retornos, rangos y volúmenes vienen en las unidades de la ficha
(``futures_qwen_ficha.facts``: fracciones; ``since_diff`` en horas); ``oi`` es el ``top_open_interest`` del colector de
posicionamiento (por hora, solo se conoce a baldes cerrados). ``libro`` sale de la última foto del libro público que el trader ya
tiene en memoria (la de la valuación de la posición o la del recibo de entrada); sin libro (mirada sin posición, sin ejecución por libro)
queda ``null``: el auditor no hace ninguna llamada de red. En ``libro``, ``mejor_compra`` es la mejor oferta de compra (bid),
``mejor_venta`` la mejor de venta (ask) y ``desequilibrio`` = (cantidad en compra - cantidad en venta) / total en los 5 primeros niveles.
Las noticias traen lo que guarda la fórmula (identificador, fuente, prioridad, lado): los títulos no están en la base viva, solo
aparecen si la fórmula los trae.

    python -m balancita_engine.futures_auditor --db data/qwen-live/live.sqlite --rebuild --resolve --summary

``--rebuild`` crea las filas que falten desde la tabla ``decisions`` (sin trader: condiciones con lo que haya en ``formula_json``,
``position_json`` y ``wake_json``, ``"origen": "rebuild"``); ``--resolve`` resuelve con las velas de la caché del proceso en vivo
(``<carpeta de live.sqlite>/cache/candles-<producto>.sqlite``, solo lectura y sin red; ``--candles`` apunta a otra carpeta o a un
archivo de velas); ``--summary`` imprime el resumen en JSON. Es idempotente.
"""

import argparse
import bisect
import contextlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zoneinfo import ZoneInfo

from . import futures_maker_exit as maker_exit
from . import futures_qwen_corta as corta
from . import futures_qwen_ficha as ficha
from . import futures_qwen_maestro as maestro_formula
from . import futures_qwen_noticias as noticias
from . import futures_qwen_portero as portero_formula
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as ex
from .futures_costs import COST_MODEL_VERSION, entry_fill, exit_fill, fee_rate, round_trip_cost_bps

SCHEMA_NAME = "balancita-auditor.v1"
VERSION = "auditor.v1"
DB_NAME = "auditor.sqlite"
MINUTE_MS, HOUR_MS, DAY_MS = qt.MINUTE_MS, qt.HOUR_MS, qt.DAY_MS
BAR_MS = qt.BAR_MS
BUCKET_MS = 15 * MINUTE_MS                    # una mirada por producto y balde de 15 minutos (como ``futures_qwen_live``)
MADRID = ZoneInfo("Europe/Madrid")
MIN_SAMPLE = 30                               # con menos miradas que esto, un grupo se marca ``pocos_datos``
HORIZONS = (("12h", 12 * HOUR_MS), ("24h", 24 * HOUR_MS), ("36h", 36 * HOUR_MS))
MOVES = (("30m", 30 * MINUTE_MS), ("1h", HOUR_MS), ("4h", 4 * HOUR_MS), ("12h", 12 * HOUR_MS), ("24h", 24 * HOUR_MS),
         ("36h", 36 * HOUR_MS))
FINAL_MS = 36 * HOUR_MS
DIRECTION_HORIZONS = (("4h", 4 * HOUR_MS), ("12h", 12 * HOUR_MS), ("24h", 24 * HOUR_MS))

ENTRIES = ("ENTRAR", "ENTRAR_noticias")
SKIPS = ("NO_ENTRAR_portero", "NO_ENTRAR_maestro", "NO_ENTRAR_regla")
EXITS_JUDGED = ("SALIR_vuelta", "SALIR_24h", "SALIR_12h_noticias")
EXITS_FIXED = ("SALIR_36h", "SALIR_otro")
ACTIONS = ENTRIES + SKIPS + ("MANTENER",) + EXITS_JUDGED + EXITS_FIXED

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS miradas(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  estado TEXT NOT NULL,
  accion TEXT NOT NULL,
  maestro INTEGER, puntaje REAL, umbral_flojo REAL, umbral_fuerte REAL,
  portero_si INTEGER, portero_p REAL, portero_umbral REAL,
  noticias_si INTEGER, noticias_lado INTEGER,
  qwen TEXT, qwen_coincide INTEGER,
  lado_posicion INTEGER NOT NULL DEFAULT 0,
  horas_en_posicion REAL, neto_ahora_pb REAL, trade_no INTEGER,
  condiciones_json TEXT NOT NULL,
  despues_json TEXT,
  veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT,
  resuelto_ms INTEGER,
  version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operaciones(
  product TEXT NOT NULL, trade_no INTEGER NOT NULL, lado INTEGER NOT NULL, entry_ms INTEGER NOT NULL, exit_ms INTEGER,
  direccion_json TEXT, mfe_pb REAL, mae_pb REAL, hasta_ms INTEGER, resuelto_ms INTEGER,
  version TEXT NOT NULL,
  PRIMARY KEY(product, trade_no));
"""

# Columnas que se sumaron a ``miradas`` después de la primera versión (migración aditiva: ``_migrate``). Van siempre al final.
_ADDED_COLUMNS = (("direccion_json", "TEXT"), ("direccion_ms", "INTEGER"))

# Para entrenar más adelante (S8, T15): solo tablas NUEVAS (``_migrate_training``). Ninguna tabla ni columna de antes cambia.
_TRAINING_SQL = """
CREATE TABLE IF NOT EXISTS hechos_mirada(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  hechos_json TEXT NOT NULL, puntaje REAL, veredicto INTEGER, portero_json TEXT,
  maestro_hash TEXT, portero_hash TEXT, config_hash TEXT, config_version INTEGER, costos_id TEXT,
  version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS propuestas(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  lado INTEGER NOT NULL, inicio_episodio INTEGER NOT NULL, estado TEXT NOT NULL,
  motivo_bloqueo TEXT, detalle_bloqueo TEXT, trade_no INTEGER,
  maestro INTEGER, puntaje REAL, portero_p REAL, precio REAL,
  contrafactual_json TEXT, neto_pb REAL, motivo_salida TEXT, horas REAL, salida_ms INTEGER, resuelto_ms INTEGER,
  version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS mirada_operaciones(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, trade_no INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  lado INTEGER NOT NULL, evento TEXT NOT NULL, origen TEXT, entry_ms INTEGER, entry_px REAL,
  horas REAL, neto_ahora_pb REAL, puntaje REAL, maestro INTEGER, puntaje_lado REAL, maestro_lado INTEGER,
  salida_dice TEXT, salida_motivo TEXT,
  version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms, trade_no));
CREATE TABLE IF NOT EXISTS resultados_operacion(
  product TEXT NOT NULL, trade_no INTEGER NOT NULL, lado INTEGER NOT NULL, entry_ms INTEGER NOT NULL, exit_ms INTEGER NOT NULL,
  neto_pb REAL, neto_usd REAL, notional_usd REAL, motivo_entrada TEXT, motivo_cierre TEXT, motivo_salida TEXT,
  entry_px REAL, exit_px REAL, mfe_hl_pb REAL, mae_hl_pb REAL, hl_hasta_ms INTEGER, resultado_ms INTEGER,
  version TEXT NOT NULL,
  PRIMARY KEY(product, trade_no));
CREATE TABLE IF NOT EXISTS reentrenos(
  id INTEGER PRIMARY KEY, corte_ms INTEGER NOT NULL, dataset_hash TEXT NOT NULL, spec_json TEXT NOT NULL,
  metricas_fuera_de_muestra_json TEXT NOT NULL, creado_ms INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS reentrenos_no_update BEFORE UPDATE ON reentrenos
BEGIN SELECT RAISE(ABORT,'el registro de reentrenos es solo-agregar'); END;
CREATE TRIGGER IF NOT EXISTS reentrenos_no_delete BEFORE DELETE ON reentrenos
BEGIN SELECT RAISE(ABORT,'el registro de reentrenos es solo-agregar'); END;
CREATE TABLE IF NOT EXISTS sombra_maker(
  product TEXT NOT NULL, trade_no INTEGER NOT NULL, leg TEXT NOT NULL, motivo_salida TEXT,
  lado INTEGER NOT NULL, orden TEXT NOT NULL, t_oficial_ms INTEGER NOT NULL,
  precio_oficial REAL, comision_oficial_usd REAL, comision_oficial_tipo TEXT, cantidad REAL, notional_oficial_usd REAL,
  libro_ms INTEGER, limite_px REAL,
  estado TEXT NOT NULL, motivo_sin_datos TEXT,
  llenado_ms INTEGER, llenado_px REAL, cinta_px REAL, espera_ms INTEGER,
  comision_sombra_usd REAL, comision_sombra_tipo TEXT, delta_usd REAL, delta_pb REAL,
  modelo TEXT NOT NULL, costos_id TEXT, resuelto_ms INTEGER, version TEXT NOT NULL,
  PRIMARY KEY(product, trade_no, leg));
CREATE TABLE IF NOT EXISTS duraciones_auditor(
  id INTEGER PRIMARY KEY, product TEXT NOT NULL, t_ms INTEGER, origen TEXT NOT NULL,
  total_ms REAL NOT NULL, pasos_json TEXT NOT NULL, registrada_ms INTEGER NOT NULL, version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS miradas_perdidas(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  motivo TEXT NOT NULL, detalle TEXT, despertar_json TEXT, estado TEXT NOT NULL,
  maestro INTEGER, puntaje REAL, entrada_dice TEXT, salida_dice TEXT, formula_json TEXT,
  registrada_ms INTEGER NOT NULL, version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms));
"""

BLOCK_REASONS = ("lugares_ocupados", "mismo_episodio", "subida_30d", "separacion_60min", "enfriamiento", "cierre_en_la_mirada", "otro")
RESOLVE_LIMIT = 300                           # propuestas que ``resolve`` etiqueta por llamada (acota el CPU dentro del proceso en vivo)
def _int_env(name, default, env=None):
    """Un entero positivo del entorno (``env`` por defecto ``os.environ``); vacío, no numérico o ``<= 0`` deja ``default`` (un valor roto no apaga nada)."""
    env = os.environ if env is None else env
    try:
        value = int(str(env.get(name) or "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


TRAINING_LOCK_TIMEOUT_S = 2.0                # lo nuevo no espera más que esto una base ocupada (por otro proceso): falla con aviso, no detiene el sondeo
GIVE_UP_MS = 12 * HOUR_MS                     # pasado el tope de la operación más esto sin precios, la etiqueta queda ``sin_datos`` (no traba el archivo)

_COLUMNS = ("product", "bucket_ms", "t_ms", "estado", "accion", "maestro", "puntaje", "umbral_flojo", "umbral_fuerte",
            "portero_si", "portero_p", "portero_umbral", "noticias_si", "noticias_lado", "qwen", "qwen_coincide",
            "lado_posicion", "horas_en_posicion", "neto_ahora_pb", "trade_no", "condiciones_json", "version")


# --------------------------------------------------------------------------- the database


def auditor_path(live_db_path):
    """``auditor.sqlite`` en la misma carpeta que ``live.sqlite``."""
    return os.path.join(os.path.dirname(live_db_path), DB_NAME)


def _open(live_db_path, timeout=30):
    path = auditor_path(live_db_path)
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    db = sqlite3.connect(path, timeout=timeout)
    db.row_factory = sqlite3.Row
    db.executescript(_SCHEMA_SQL)
    _migrate(db)
    try:
        _migrate_training(db)
    except sqlite3.Error:                              # solo agrega: si no se pudo, lo de siempre sigue y el registro nuevo avisa solo
        pass
    if db.execute("SELECT 1 FROM meta WHERE key='schema'").fetchone() is None:
        with db:
            db.execute("INSERT OR IGNORE INTO meta VALUES('schema', ?)", (SCHEMA_NAME,))
    if db.execute("SELECT 1 FROM meta WHERE key='direccion'").fetchone() is None:
        with db:
            db.execute("INSERT OR IGNORE INTO meta VALUES('direccion', 'v1')")
    return db


def _migrate(db):
    """Suma a ``miradas`` las columnas de ``_ADDED_COLUMNS`` que falten. Solo agrega: no toca filas ni columnas existentes, así que una
    base vieja sigue siendo legible por el código y el servidor anteriores."""
    have = {row[1] for row in db.execute("PRAGMA table_info(miradas)")}
    for name, kind in _ADDED_COLUMNS:
        if name in have:
            continue
        try:
            with db:
                db.execute("ALTER TABLE miradas ADD COLUMN {} {}".format(name, kind))
        except sqlite3.OperationalError as error:
            if "duplicate column" not in str(error).lower():          # otro proceso (el vivo y la línea de comandos) la sumó antes
                raise


def _migrate_training(db):
    """Crea las tablas nuevas de ``_TRAINING_SQL`` si faltan. Solo agrega (``CREATE TABLE IF NOT EXISTS``): ninguna tabla ni columna vieja
    cambia, así que una base vieja sigue siendo legible por el código y el servidor anteriores. Se deshace con ``DROP TABLE``."""
    db.executescript(_TRAINING_SQL)


def _live_readonly(live_db_path):
    """``live.sqlite`` en solo lectura: el auditor nunca la escribe."""
    db = sqlite3.connect(Path(os.path.abspath(live_db_path)).as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    return db


_TRADE_COLUMNS = "trade_no, side, entry_ms, exit_ms, entry_px, exit_px, net_bp, status, closed_by, exit_reason, entry_reason"


def _trade(live_db_path, product, trade_no):
    """La operación ``trade_no`` de la base viva, o ``None`` (sin número, sin base o sin esa fila)."""
    if trade_no is None:
        return None
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            row = live.execute("SELECT {} FROM trades WHERE product=? AND trade_no=?".format(_TRADE_COLUMNS),
                               (product, trade_no)).fetchone()
        return None if row is None else dict(row)
    except sqlite3.Error:
        return None


# --------------------------------------------------------------------------- small pure helpers


def _num(value):
    """Un número finito como ``float`` o ``None`` (nada de NaN ni infinitos en el JSON que lee el servidor)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _flag(value):
    return None if value is None else int(bool(value))


def _sign(value):
    value = _num(value)
    return 0 if value is None or value == 0 else (1 if value > 0 else -1)


def _side_of(text):
    return 1 if text in ("LONG", "LARGO") else -1 if text in ("SHORT", "CORTO") else 0


def _clean(value):
    """Datos listos para ``json.dumps(allow_nan=False)``."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (bool, int, str)):
        return value
    number = _num(value)
    return number if number is not None else str(value)


def _dumps(value):
    return json.dumps(_clean(value), allow_nan=False, sort_keys=True, ensure_ascii=False)


def _loads(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _safe(function, *args):
    """Un pedazo de la foto que falla vale ``None``: la foto sigue."""
    try:
        return function(*args)
    except Exception:                                  # noqa: BLE001 - una condición que no se pudo leer nunca rompe la foto
        return None


def _pb(price, base):
    return None if price is None or not base else (price / base - 1) * 1e4


def _fmt_pb(value):
    return "{:+.0f} pb".format(value).replace("-", "−")


# --------------------------------------------------------------------------- classification


_AGOTADO = re.compile(r"pasaron (\d+) h")
_EXIT_REASONS = {"maestro_vuelta": "SALIR_vuelta", "maestro_agotado": "SALIR_24h", "noticia_12h": "SALIR_12h_noticias"}


def _exit_from_trade(trade):
    """La salida según cómo cerró la operación (``closed_by`` / ``exit_reason`` de ``trades``)."""
    if not trade:
        return "SALIR_otro"
    reason = _EXIT_REASONS.get(trade.get("exit_reason"))
    if reason is not None:
        return reason
    if trade.get("closed_by") == "tiempo":
        return "SALIR_24h" if trade.get("entry_reason") == "noticias" else "SALIR_36h"      # las de noticias duran 24 h
    return "SALIR_otro"


def _classify_entry(formula):
    if formula.get("authority") == "noticias":
        return "ENTRAR_noticias"
    if formula.get("noticias_si") and not formula.get("portero_si") and not formula.get("portero_autonomo"):
        return "ENTRAR_noticias"                        # misma regla del trader: maestro fuerte + noticias sin el portero
    return "ENTRAR"


def _classify_wait(formula):
    maestro = formula.get("maestro")
    if formula.get("authority") == "noticias" or not isinstance(maestro, (int, float)) or isinstance(maestro, bool):
        return "NO_ENTRAR_regla"
    if abs(maestro) < 2:
        return "NO_ENTRAR_maestro"
    vote = formula.get("portero_autonomo")
    against = isinstance(vote, dict) and _sign(vote.get("side")) * _sign(maestro) <= 0
    if not formula.get("portero_si") or against:
        return "NO_ENTRAR_portero"
    return "NO_ENTRAR_regla"                            # maestro fuerte y portero a favor, y aun así no entró: otra regla


def _classify_exit(formula, trade):
    motivo = formula.get("motivo") or ""
    if corta.NEWS_EXIT_WHY in motivo:
        return "SALIR_12h_noticias"
    if "se dio vuelta" in motivo:
        return "SALIR_vuelta"
    found = _AGOTADO.search(motivo)
    if found:
        return "SALIR_36h" if int(found.group(1)) >= 36 else "SALIR_24h"
    return _exit_from_trade(trade)


def classify(kind, action, formula, trade=None):
    """La acción del auditor de una mirada con decisión. ``kind``: ``flat`` / ``position``. ``action``: la de ``decisions.action``
    (ESPERAR, LARGO, CORTO, MANTENER, CERRAR). ``formula``: ``formula_json``. ``trade``: la fila de ``trades`` si se conoce
    (solo se usa para clasificar una salida cuyo motivo no se reconoce)."""
    formula = formula or {}
    if action in ("LARGO", "CORTO"):
        return _classify_entry(formula)
    if action == "CERRAR":
        return _classify_exit(formula, trade)
    if kind == "position":
        return "MANTENER"
    return _classify_wait(formula)


# --------------------------------------------------------------------------- conditions (the photo of the moment)


def _thresholds(cfg, t_ms):
    """``(flojo, fuerte, umbral del portero)`` de las fórmulas vigentes en ``t_ms``; ``None`` donde no se puedan leer."""
    try:
        teacher, keeper = corta.formulas(cfg, t_ms)
        weak, strong = teacher["umbrales"]["flojo"], teacher["umbrales"]["fuerte"]
    except Exception:                                  # noqa: BLE001
        return None, None, None
    return _num(weak), _num(strong), _num(None if keeper is None else keeper.get("umbral"))


def _news_side(formula):
    news = formula.get("noticias")
    if not isinstance(news, dict):
        return None
    signal = news.get("signal") or (news.get("priority") or {}).get("signal")
    if isinstance(signal, dict):
        return _sign(signal.get("side")) or None
    if news.get("disponible") and (news.get("n") or 0) > 0:
        return _sign(news.get("sentimiento")) or None
    return None


def _news_summary(formula):
    news = formula.get("noticias")
    if not isinstance(news, dict):
        return None
    signal = news.get("signal") or (news.get("priority") or {}).get("signal")
    priority = news.get("priority") if isinstance(news.get("priority"), dict) else {}
    if isinstance(signal, dict):
        title = signal.get("title") or signal.get("titulo")
        return {"ids": [signal.get("event_id")], "items": signal.get("item_hashes") or [signal.get("item_hash")],
                "titulos": [] if not title else [str(title)[:80]], "fuente": signal.get("source"),
                "prioridad": priority.get("status") or "fuerte", "lado": _sign(signal.get("side")) or None,
                "publicada_ms": signal.get("published_at")}
    return {"disponible": news.get("disponible"), "n": news.get("n"), "sentimiento": news.get("sentimiento"),
            "max_relevancia": news.get("max_relevancia"), "a_favor": news.get("a_favor"),
            "prioridad": priority.get("status"), "lado": _news_side(formula)}


def _madrid(t_ms):
    moment = datetime.fromtimestamp(t_ms / 1000, tz=MADRID)
    return moment.hour, moment.weekday()


def _index_of(trader, t_ms):
    """Posición de la vela que cierra en ``t_ms`` dentro de las velas del trader, o ``None``."""
    index = bisect.bisect_left(trader.t, t_ms - BAR_MS)
    return index if index < len(trader.t) and trader.t[index] == t_ms - BAR_MS else None


def _market(trader, t_ms, formula):
    """Mercado en el momento. Solo si la última vela del trader es la de la mirada (si no, no se mezclan momentos)."""
    if not trader.t or trader.t[-1] + BAR_MS != t_ms:
        return None
    f = ficha.facts(trader, t_ms)
    r24, r7 = float(f["range24"]), float(f["range7"])
    turbulence = _safe(lambda: None if trader.movement is None else trader.movement.active(t_ms))
    out = {"ret_1h": f["ret"]["1h"], "ret_4h": f["ret"]["4h"], "ret_24h": f["ret"]["24h"], "pos24": f["pos24"],
           "pos7": f["pos7"], "since_diff": f["since_lo"] - f["since_hi"],
           "sigma24": _safe(lambda: trader._sigma5() * math.sqrt(qt.H24)), "range24": r24, "range7": r7,
           "vol1h": f["vol1h"], "vol24": f["vol24"], "realized": f["realized"],
           "vol_ratio": r24 / r7 if r7 > 0 else 1.0, "volatilidad": formula.get("volatilidad"),
           "turbulencia": None if turbulence is None else int(bool(turbulence)),
           "strength": f.get("strength"), "strength_btc": f.get("strength_btc")}
    out.update(_safe(_day_levels, trader, t_ms) or {"max_ayer_roto": None, "min_ayer_roto": None,
                                                    "vwap_desde_00utc_pct": None})
    return out


def _day_levels(trader, t_ms):
    """Si hoy (desde las 00 UTC) ya se rompió el máximo / mínimo de ayer, y la distancia al VWAP desde las 00 UTC."""
    today = (t_ms - BAR_MS) // DAY_MS * DAY_MS
    start, before = bisect.bisect_left(trader.t, today), bisect.bisect_left(trader.t, today - DAY_MS)
    out = {"max_ayer_roto": None, "min_ayer_roto": None, "vwap_desde_00utc_pct": None}
    if start >= len(trader.t):
        return out
    if start - before == DAY_MS // BAR_MS and trader.t[before] == today - DAY_MS:
        out["max_ayer_roto"] = max(trader.h[start:]) > max(trader.h[before:start])
        out["min_ayer_roto"] = min(trader.l[start:]) < min(trader.l[before:start])
    volume = math.fsum(trader.v[start:])
    if volume > 0:
        vwap = math.fsum((h + l + c) / 3 * v for h, l, c, v in
                         zip(trader.h[start:], trader.l[start:], trader.c[start:], trader.v[start:])) / volume
        out["vwap_desde_00utc_pct"] = (trader.c[-1] / vwap - 1) * 100 if vwap > 0 else None
    return out


def _open_interest(feed, t_ms):
    """``(oi, cambio 4 h %, cambio 24 h %)`` del último balde cerrado del colector; ``None`` donde no haya."""
    from . import positioning_data
    rows, ends = feed.positioning, feed._ends_p

    def at(moment):
        index = bisect.bisect_right(ends, moment) - 1
        if index < 0 or moment - ends[index] > positioning_data.MAX_STALE_MS:
            return None
        return _num(rows[index][3])

    now = at(t_ms)

    def change(hours):
        old = at(t_ms - hours * HOUR_MS)
        return None if not now or not old else (now / old - 1) * 100

    return now, change(4), change(24)


def _positioning(trader, t_ms):
    if trader.t and trader.t[-1] + BAR_MS == t_ms:
        pos = ficha.facts(trader, t_ms).get("pos") or {}
        funding = ficha.facts(trader, t_ms).get("funding_rate")
    else:
        pos, funding = {}, None
    feed = getattr(trader, "positioning", None)
    oi, oi4, oi24 = (None, None, None) if feed is None or not getattr(feed, "available", False) else \
        (_safe(_open_interest, feed, t_ms) or (None, None, None))
    long_, top = _num(pos.get("long")), _num(pos.get("top"))
    out = {"oi": oi, "oi_4h_pct": oi4, "oi_24h_pct": oi24, "largos_pct": long_, "top_largos_pct": top,
           "premium_bp": _num(pos.get("premium")), "funding_bp": None if funding is None else funding * 1e4,
           "long_bias": None if long_ is None else long_ - 50.0, "top_long_bias": None if top is None else top - 50.0}
    return out if any(v is not None for v in out.values()) else None


def _book(trader, t_ms):
    """La última foto del libro público que el trader ya tiene en memoria (sin red). ``None`` si no hay."""
    quote = ((getattr(trader, "last_mark_execution", None) or {}).get("quote"))
    position = getattr(trader, "position", None)
    if not quote and position is not None and position.entry_ms == t_ms:
        quote = (position.entry_execution or {}).get("quote")
    if not quote or abs(quote.get("received_at_ms", 0) - t_ms) > 15 * MINUTE_MS:
        return None
    bids = [(float(p), float(q)) for p, q in quote["bids"]]
    asks = [(float(p), float(q)) for p, q in quote["asks"]]
    if not bids or not asks:
        return None
    mid = (bids[0][0] + asks[0][0]) / 2
    size_b, size_a = math.fsum(q for _, q in bids), math.fsum(q for _, q in asks)
    return {"spread_bp": (asks[0][0] - bids[0][0]) / mid * 1e4, "mejor_compra": bids[0][0], "mejor_venta": asks[0][0],
            "desequilibrio": (size_b - size_a) / (size_a + size_b) if size_a + size_b > 0 else None}


def conditions(trader, event, formula, t_ms, origin="vivo"):
    """La foto del momento (``condiciones_json``). Con ``trader=None`` (reconstrucción) solo lo que traiga la fórmula, la posición
    y el despertar."""
    hour, weekday = _madrid(t_ms)
    wake = event.get("wake")
    out = {"origen": origin, "motivo": formula.get("motivo"), "precio": None, "hora_madrid": hour, "dia": weekday,
           "fin_de_semana": weekday >= 5, "mercado": None, "posicionamiento": None, "libro": None,
           "noticias": _safe(_news_summary, formula),
           "despertar": [str(x) for x in wake][:8] if isinstance(wake, (list, tuple)) else None}
    if trader is not None:
        index = _safe(_index_of, trader, t_ms)
        out["precio"] = None if index is None else trader.c[index]
        out["mercado"] = _safe(_market, trader, t_ms, formula)
        out["posicionamiento"] = _safe(_positioning, trader, t_ms)
        out["libro"] = _safe(_book, trader, t_ms)
    elif formula.get("volatilidad") is not None:
        out["mercado"] = {"volatilidad": formula.get("volatilidad")}
    return out


# --------------------------------------------------------------------------- the row of one look


def build_row(product, event, *, trader=None, trade=None, cfg=None):
    """La fila de ``miradas`` de un evento ``decision`` (con ``formula``) o ``guardrail`` (cierre por tope de tiempo / stop).
    ``trader`` solo está en vivo; ``cfg`` es la config para leer los umbrales cuando no hay trader."""
    guardrail = event.get("type") == "guardrail"
    formula = {} if guardrail else dict(event.get("formula") or {})
    t_ms = int(event["t_ms"])
    kind = "position" if guardrail else event.get("kind")
    action = "CERRAR" if guardrail else event.get("action")
    position = event.get("position") if isinstance(event.get("position"), dict) else {}
    if guardrail:
        accion = _exit_from_trade(dict(trade or {}, closed_by=event.get("guardrail")))
        formula["motivo"] = "cierre de emergencia: " + str(event.get("guardrail"))
    else:
        accion = classify(kind, action, formula, trade)
    if accion in ENTRIES:
        lado = 1 if action == "LARGO" else -1
    elif kind == "position":
        lado = _side_of(position.get("side")) or _side_of((trade or {}).get("side"))
    else:
        lado = 0
    held = _num(position.get("entry_ms"))
    weak, strong, gate = _thresholds(cfg if cfg is not None else getattr(trader, "cfg", None), t_ms)
    opinion = event.get("opinion_agrees")
    row = {"product": product, "bucket_ms": t_ms - BUCKET_MS, "t_ms": t_ms,
           "estado": "en_posicion" if kind == "position" else "plana", "accion": accion,
           "maestro": formula.get("maestro") if isinstance(formula.get("maestro"), int) else None,
           "puntaje": _num(formula.get("puntaje")), "umbral_flojo": weak, "umbral_fuerte": strong,
           "portero_si": _flag(formula.get("portero_si")), "portero_p": _num(formula.get("portero_p")),
           "portero_umbral": gate, "noticias_si": _flag(formula.get("noticias_si")), "noticias_lado": _news_side(formula),
           "qwen": event.get("model_action"), "qwen_coincide": _flag(opinion), "lado_posicion": lado,
           "horas_en_posicion": None if kind != "position" or held is None else (t_ms - held) / HOUR_MS,
           "neto_ahora_pb": _num(event.get("net_bp_now")), "trade_no": event.get("trade_no"), "version": VERSION}
    row["condiciones_json"] = _dumps(conditions(trader, event, formula, t_ms, "vivo" if trader is not None else "rebuild"))
    return row


def _insert(db, row):
    cursor = db.execute("INSERT OR IGNORE INTO miradas({}) VALUES({})".format(
        ", ".join(_COLUMNS), ", ".join("?" * len(_COLUMNS))), tuple(row[c] for c in _COLUMNS))
    return cursor.rowcount == 1


def snapshot(live_db_path, product, trader, event, now_ms):
    """Anota la mirada de un evento de decisión (``type == "decision"`` con ``formula``) o de cierre por tope (``guardrail``) en
    ``auditor.sqlite``. Idempotente (``INSERT OR IGNORE`` por producto y balde). Devuelve ``True`` si creó la fila. Tarda
    milisegundos; no lee nada de la red y no escribe en ``live.sqlite``. ``now_ms`` queda por simetría con ``resolve``."""
    kind = event.get("type")
    if kind not in ("decision", "guardrail") or (kind == "decision" and not event.get("formula")):
        return False
    trade = None
    if kind == "guardrail" or event.get("action") == "CERRAR":
        trade = _trade(live_db_path, product, event.get("trade_no"))
    row = build_row(product, event, trader=trader, trade=trade)
    with contextlib.closing(_open(live_db_path)) as db:
        with db:
            return _insert(db, row)


# --------------------------------------------------------------------------- what happened afterwards


class _Prices:
    """Cierres de 5 min por hora de cierre. ``at`` da el cierre exacto, o el anterior si hay un hueco con velas después."""

    def __init__(self, closes):
        self.map = {}
        for at, close in closes.items():
            close = _num(close)
            if close is not None and close > 0:
                self.map[int(at)] = close
        self.keys = sorted(self.map)

    def at(self, moment):
        found = self.map.get(moment)
        if found is not None:
            return found
        index = bisect.bisect_right(self.keys, moment) - 1
        if index >= 0 and index + 1 < len(self.keys) and moment - self.keys[index] <= 3 * BAR_MS:
            return self.map[self.keys[index]]
        return None

    def between(self, low, high):
        """Los cierres con hora en ``(low, high]``."""
        start, end = bisect.bisect_right(self.keys, low), bisect.bisect_right(self.keys, high)
        return [(k, self.map[k]) for k in self.keys[start:end]]


def _score_series(live_db_path, product, from_ms):
    """``{t_ms: puntaje}`` de las miradas guardadas desde ``from_ms`` (el maestro de cada mirada, para saber cuándo se daba vuelta;
    como ``futures_qwen_aprende._scores_by_time`` pero sin romperse con miradas sin puntaje, las de noticias)."""
    out = {}
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            for t_ms, text in live.execute("SELECT t_ms, formula_json FROM decisions WHERE product=? AND t_ms>=? "
                                           "AND formula_json IS NOT NULL", (product, from_ms)):
                score = _num((_loads(text) or {}).get("puntaje"))
                if score is not None:
                    out[t_ms] = score
    except sqlite3.Error:
        pass
    return out


def _trades_of(live_db_path, product, numbers):
    if not numbers:
        return {}
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            return {r["trade_no"]: dict(r) for r in live.execute(
                "SELECT {} FROM trades WHERE product=? AND trade_no IN ({})".format(
                    _TRADE_COLUMNS, ",".join("?" * len(numbers))), (product,) + tuple(numbers))}
    except sqlite3.Error:
        return {}


def _reference_side(row):
    """El lado de la mirada: el de la posición, si no el del maestro, el del puntaje o el de las noticias."""
    for value in (row["lado_posicion"], row["maestro"], row["puntaje"], row["noticias_lado"]):
        if _sign(value):
            return _sign(value)
    return None


class _Look:
    """Todo lo que hace falta para resolver UNA mirada: precios, puntajes posteriores, la operación real y el costo."""

    def __init__(self, row, prices, scores, times, trade, cfg, now_ms, cost_bp):
        self.row, self.prices, self.trade, self.cfg, self.now, self.cost = row, prices, trade, cfg, now_ms, cost_bp
        self.t0 = row["t_ms"]
        self.p0 = prices.at(self.t0)
        self.side = _reference_side(row)
        lo = bisect.bisect_left(times, self.t0)
        hi = bisect.bisect_right(times, self.t0 + FINAL_MS + HOUR_MS)
        self.readings = {t: {"puntaje": scores[t]} for t in times[lo:hi]}
        self.weak = row["umbral_flojo"]
        if self.weak is None:
            self.weak = _thresholds(cfg, self.t0)[0]

    # ---- simulated operation of the version 8 (what the formulas would have done on one side)

    def simulate(self, side, horizon_ms):
        """Neto en pb de la operación simulada abierta en la mirada del lado ``side``, truncada a ``horizon_ms``: cierra con el
        maestro dado vuelta (o el tope de la config) y, si no cerró antes, se valora al precio del horizonte. ``None`` si todavía
        no se puede saber (o no hay umbral para simular la salida)."""
        if not side or self.weak is None or self.p0 is None:
            return None
        out = ex._v8_exit(self.cfg, self.t0, side, self.readings, self.prices.map, self.cost, self.weak)
        limit = self.t0 + horizon_ms
        if out is not None and out["salida_ms"] <= limit:
            return out["neto_bp"]
        if self.now >= limit:
            price = self.prices.at(limit)
            if price is not None:
                return side * _pb(price, self.p0) - self.cost
        return None

    # ---- the real operation

    def _closed_by(self, limit):
        trade = self.trade
        return (trade is not None and trade.get("status") == "closed" and trade.get("exit_ms") is not None
                and trade["exit_ms"] <= limit)

    def held_until(self, horizon_ms):
        """Lo que quedó de la posición sostenida: lado x (precio de salida real, o del horizonte, lo que llegue antes / precio de la
        mirada - 1). ``None`` si todavía no se sabe."""
        limit = self.t0 + horizon_ms
        side = self.row["lado_posicion"] or _side_of((self.trade or {}).get("side"))
        if not side or self.p0 is None:
            return None
        if self._closed_by(limit):
            price = _num(self.trade.get("exit_px")) or self.prices.at(self.trade["exit_ms"])
        else:
            price = self.prices.at(limit) if self.now >= limit else None
        return None if price is None else side * _pb(price, self.p0)

    def favor_until(self, horizon_ms):
        """Lo que el precio hizo a favor de la posición (cerrada) desde la mirada hasta el horizonte."""
        side, limit = self.row["lado_posicion"], self.t0 + horizon_ms
        price = self.prices.at(limit) if self.now >= limit else None
        return None if not side or price is None or self.p0 is None else side * _pb(price, self.p0)

    def entry_net(self, horizon_ms):
        """Neto de la operación real abierta en la mirada a ``horizon_ms``: el de ``trades`` si cerró antes, si no marcado."""
        trade, limit = self.trade, self.t0 + horizon_ms
        if trade is None or self.p0 is None:
            return None
        if self._closed_by(limit):
            return _num(trade.get("net_bp"))
        price = self.prices.at(limit) if self.now >= limit else None
        side = _side_of(trade.get("side")) or self.row["lado_posicion"]
        return None if price is None or not side else side * _pb(price, self.p0) - self.cost

    # ---- after-the-fact numbers

    def after(self):
        row, prices, p0 = self.row, self.prices, self.p0
        out = {"lado_ref": self.side}
        for name, span in MOVES:
            out["mov_" + name] = _pb(prices.at(self.t0 + span), p0) if self.now >= self.t0 + span else None
        end = min(self.now, self.t0 + FINAL_MS)
        run = [self.side * _pb(c, p0) for _, c in prices.between(self.t0, end)] if self.side and p0 else []
        out["mfe_36h"] = max(0.0, max(run)) if run else None
        out["mae_36h"] = min(0.0, min(run)) if run else None
        out["hasta_ms"] = max((k for k, _ in prices.between(self.t0, end)), default=None)
        out["si_entraba_maestro_pb"] = self.simulate(self.side, FINAL_MS)
        out["si_entraba_contrario_pb"] = None if not self.side else self.simulate(-self.side, FINAL_MS)
        out["queda_hasta_salida_pb"] = None
        out["queda_hasta_36h_pb"] = None
        trade = self.trade
        if row["estado"] == "en_posicion" and trade is not None and row["lado_posicion"] and p0:
            if trade.get("status") == "closed" and trade.get("exit_ms") is not None:
                price = _num(trade.get("exit_px")) or prices.at(trade["exit_ms"])
                out["queda_hasta_salida_pb"] = None if price is None else row["lado_posicion"] * _pb(price, p0)
            entry = trade.get("entry_ms")
            if entry is None and row["horas_en_posicion"] is not None:
                entry = self.t0 - row["horas_en_posicion"] * HOUR_MS
            if entry is not None and self.now >= entry + FINAL_MS:
                price = prices.at(int(entry + FINAL_MS))
                out["queda_hasta_36h_pb"] = None if price is None else row["lado_posicion"] * _pb(price, p0)
        return out


def _verdict(look, horizon_ms):
    """El veredicto de la mirada a ``horizon_ms`` (dict) o ``None`` si todavía no se puede dar."""
    row = look.row
    accion = row["accion"]
    if look.p0 is None or look.now < look.t0 + horizon_ms:
        return None
    if accion in EXITS_FIXED:
        return {"acerto": None, "costo_error_pb": 0.0, "regla": "regla fija", "texto": "no se juzga (regla fija)"}
    if accion in ENTRIES:
        value = look.entry_net(horizon_ms)
        if value is None:
            return None
        return _judged(value > 0, max(0.0, -value), "entrar acierta si el neto es positivo",
                       "{} {}".format("ganó" if value > 0 else "perdió", _fmt_pb(value)), value)
    if accion in SKIPS:
        regla = "apagado" if accion == "NO_ENTRAR_regla" else "no entrar acierta si la operación que no se abrió no ganaba"
        if not look.side:
            return {"acerto": None, "costo_error_pb": 0.0, "regla": regla, "texto": "sin lado para simular"}
        if look.weak is None:
            return {"acerto": None, "costo_error_pb": 0.0, "regla": regla, "texto": "sin umbral para simular la salida"}
        value = look.simulate(look.side, horizon_ms)
        if value is None:
            return None
        return _judged(value <= 0, max(0.0, value), regla, "si entraba: " + _fmt_pb(value), value)
    if accion == "MANTENER":
        value = look.held_until(horizon_ms)
        if value is None:
            return None
        return _judged(value >= 0, max(0.0, -value), "mantener acierta si lo que quedó es >= 0",
                       "quedó: " + _fmt_pb(value), value)
    value = look.favor_until(horizon_ms)                                            # SALIR_vuelta / 24h / 12h_noticias
    if value is None:
        return None
    return _judged(value <= 0, max(0.0, value), "salir acierta si aguantar no sumaba", "quedaba: " + _fmt_pb(value), value)


def _judged(hit, cost, rule, text, value):
    return {"acerto": bool(hit), "costo_error_pb": round(cost, 2), "regla": rule, "texto": text, "valor_pb": round(value, 2)}


def resolve(live_db_path, product, closes, cfg, now_ms, cost_bp, ranges=None, market_db=None, shadow=True):
    """Completa lo que ya se puede saber de cada mirada sin resolver: ``despues_json`` (movimientos, MFE/MAE, operaciones
    simuladas) y los veredictos a 12, 24 y 36 h cuando el horizonte ya pasó (12 h = provisorio; 36 h = definitivo, escribe
    ``resuelto_ms``). Después, la dirección a 4, 12 y 24 h de cada mirada y la dirección y el MAE/MFE de cada operación (aparte, sin
    tocar nada de lo anterior). ``closes``: ``{t_ms del cierre: cierre}`` de velas de 5 min. Solo lee ``live.sqlite``. Devuelve
    ``{"miradas", "actualizadas", "veredictos", "pendientes", "direcciones", "operaciones", "propuestas", "resultados", "avisos"}``.

    Para entrenar (S8): al final etiqueta las propuestas de entrada con el resultado contrafactual (``propuestas``) y completa el
    resultado real de cada operación (``resultados``; ``ranges`` = ``{t_ms del cierre: (máximo, mínimo)}`` de las velas de 5 min para
    el MFE/MAE con extremos). Esos pasos van aparte y protegidos: si uno falla, ``avisos`` lo cuenta y todo lo demás queda igual.

    Sombra maker (``odd/tasks/maker-sombra.md``): con ``market_db`` (la base de captura, solo lectura) calcula además ``sombra_maker`` de los tramos
    oficiales que ya tienen 15 min de cinta; ``sombra`` = filas escritas y ``sombra_estado`` = ``ok`` / ``sin_captura`` (hay tramos por
    calcular y el archivo no existe) / ``apagada`` (sin ``market_db``). Sin ``market_db`` no hace nada (como antes).
    Con ``shadow=False`` la sombra se deja para otro momento (``resolve_shadow``; ``sombra_estado`` = ``diferida``): así el proceso en vivo no la corre en el
    sondeo de una mirada.

    ``pasos_ms`` = lo que tardó cada paso (``veredictos``, ``direcciones``, ``operaciones``, ``propuestas``, ``resultados`` y ``sombra``)."""
    steps = {}
    began = time.monotonic()
    result = _resolve_verdicts(live_db_path, product, closes, cfg, now_ms, cost_bp)
    steps["veredictos"] = (time.monotonic() - began) * 1000.0
    prices = _Prices(closes)
    with contextlib.closing(_open(live_db_path)) as db:
        began = time.monotonic()
        result["direcciones"] = _resolve_look_directions(db, product, prices, now_ms)
        steps["direcciones"] = (time.monotonic() - began) * 1000.0
        began = time.monotonic()
        result["operaciones"] = _resolve_operations(live_db_path, db, product, prices, now_ms)
        steps["operaciones"] = (time.monotonic() - began) * 1000.0
    training = _resolve_training(live_db_path, product, prices, ranges, cfg, now_ms, cost_bp, market_db, shadow)
    steps.update(training.pop("pasos_ms"))
    result.update(training)
    result["pasos_ms"] = steps
    return result


def _resolve_verdicts(live_db_path, product, closes, cfg, now_ms, cost_bp):
    """Los veredictos y el ``despues_json`` de cada mirada sin resolver (lo de siempre, ver ``resolve``)."""
    prices = _Prices(closes)
    with contextlib.closing(_open(live_db_path)) as db:
        pending = [r for r in db.execute("SELECT * FROM miradas WHERE product=? AND resuelto_ms IS NULL AND t_ms<? ORDER BY t_ms",
                                         (product, now_ms))]
        pending = [r for r in pending if prices.at(r["t_ms"]) is not None]
        result = {"miradas": len(pending), "actualizadas": 0, "veredictos": 0, "pendientes": 0}
        if not pending:
            result["pendientes"] = db.execute("SELECT COUNT(*) FROM miradas WHERE product=? AND resuelto_ms IS NULL",
                                              (product,)).fetchone()[0]
            return result
        scores = _score_series(live_db_path, product, min(r["t_ms"] for r in pending))
        times = sorted(scores)
        trades = _trades_of(live_db_path, product, sorted({r["trade_no"] for r in pending if r["trade_no"] is not None}))
        with db:
            for row in pending:
                look = _Look(row, prices, scores, times, trades.get(row["trade_no"]), cfg, now_ms, float(cost_bp))
                after = _dumps(look.after())
                updates, made = {}, 0
                for name, span in HORIZONS:
                    if row["veredicto_" + name + "_json"] is None:
                        verdict = _verdict(look, span)
                        if verdict is not None:
                            updates["veredicto_" + name + "_json"] = _dumps(verdict)
                            made += 1
                if after != row["despues_json"]:
                    updates["despues_json"] = after
                if "veredicto_36h_json" in updates or row["veredicto_36h_json"] is not None:
                    updates["resuelto_ms"] = now_ms
                if updates:
                    db.execute("UPDATE miradas SET {} WHERE product=? AND bucket_ms=?".format(
                        ", ".join(k + "=?" for k in updates)), tuple(updates.values()) + (product, row["bucket_ms"]))
                    result["actualizadas"] += 1
                    result["veredictos"] += made
        result["pendientes"] = db.execute("SELECT COUNT(*) FROM miradas WHERE product=? AND resuelto_ms IS NULL",
                                          (product,)).fetchone()[0]
    return result


# --------------------------------------------------------------------------- direction and excursions (S3)


def _direction_at(prices, side, p0, t0, now_ms, span):
    """La dirección a ``span`` ms de ``t0`` o ``None`` si todavía no se puede dar: sin lado, sin precio, o antes de que el horizonte
    haya pasado entero (``now_ms``): jamás se usa un cierre posterior al horizonte ni se mira al futuro. ``acerto`` es el signo del
    movimiento contra el lado (``None`` si el precio no se movió)."""
    if not side or p0 is None or now_ms < t0 + span:
        return None
    price = prices.at(t0 + span)
    if price is None:
        return None
    move = _pb(price, p0)
    favor = side * move
    return {"mov_pb": move, "a_favor_pb": favor, "acerto": None if favor == 0 else favor > 0}


def _direction(prices, side, p0, t0, now_ms):
    """``(dict de la dirección, completa)``: completa cuando no queda horizonte por esperar (o no hay lado que juzgar)."""
    out = {"lado": side or None}
    for name, span in DIRECTION_HORIZONS:
        out[name] = _direction_at(prices, side, p0, t0, now_ms, span)
    return out, not side or all(out[name] is not None for name, _ in DIRECTION_HORIZONS)


def _resolve_look_directions(db, product, prices, now_ms):
    """``direccion_json`` de cada mirada con al menos 4 h cumplidas y la dirección sin completar (incluidas las ya resueltas a 36 h
    antes de este cambio). Devuelve cuántas filas escribió."""
    rows = db.execute("SELECT bucket_ms, t_ms, maestro, puntaje, noticias_lado, lado_posicion, direccion_json FROM miradas "
                      "WHERE product=? AND direccion_ms IS NULL AND t_ms<=? ORDER BY t_ms",
                      (product, now_ms - DIRECTION_HORIZONS[0][1])).fetchall()
    written = 0
    with db:
        for row in rows:
            p0 = prices.at(row["t_ms"])
            if p0 is None:
                continue
            done, complete = _direction(prices, _reference_side(row), p0, row["t_ms"], now_ms)
            text = _dumps(done)
            if text == row["direccion_json"] and not complete:
                continue
            db.execute("UPDATE miradas SET direccion_json=?, direccion_ms=? WHERE product=? AND bucket_ms=?",
                       (text, now_ms if complete else None, product, row["bucket_ms"]))
            written += 1
    return written


def _excursions(trade, prices, side, p0, now_ms):
    """``(mfe_pb, mae_pb, hasta_ms)`` de la operación entre su entrada y su salida (o ``now_ms`` si sigue abierta): lo mejor y lo peor a
    favor del lado sobre los cierres de 5 min y el precio de salida real. ``mfe >= 0 >= mae``; ``None`` sin ningún dato posterior."""
    entry = int(trade["entry_ms"])
    exit_ms = trade.get("exit_ms")
    closed = trade.get("status") == "closed" and exit_ms is not None and exit_ms <= now_ms
    end = min(int(exit_ms), now_ms) if closed else now_ms
    seen = prices.between(entry, end)
    run = [side * _pb(close, p0) for _, close in seen]
    if closed:
        price = _num(trade.get("exit_px"))
        if price is not None and price > 0:
            run.append(side * _pb(price, p0))
    if not run:
        return None, None, None
    return max(0.0, max(run)), min(0.0, min(run)), (seen[-1][0] if seen else None)


def _resolve_operations(live_db_path, db, product, prices, now_ms):
    """Una fila de ``operaciones`` por operación de ``live.sqlite`` (todas las del producto, también las que ninguna mirada nombra):
    dirección a 4, 12 y 24 h desde la entrada y MAE/MFE. Las ya resueltas (cerradas y con los tres horizontes) no se tocan. Una
    operación sin precio en su entrada no deja fila hasta que haya velas. Devuelve cuántas filas escribió."""
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            trades = [dict(r) for r in live.execute("SELECT {} FROM trades WHERE product=? AND entry_ms IS NOT NULL ORDER BY trade_no".format(
                _TRADE_COLUMNS), (product,))]
    except sqlite3.Error:
        return 0
    done = {r[0] for r in db.execute("SELECT trade_no FROM operaciones WHERE product=? AND resuelto_ms IS NOT NULL", (product,))}
    written = 0
    with db:
        for trade in trades:
            side = _side_of(trade.get("side"))
            if trade["trade_no"] in done or not side or trade["entry_ms"] > now_ms:
                continue
            entry = int(trade["entry_ms"])
            p0 = prices.at(entry)
            if p0 is None:
                continue
            direction, complete = _direction(prices, side, p0, entry, now_ms)
            mfe, mae, until = _excursions(trade, prices, side, p0, now_ms)
            finished = complete and trade.get("status") == "closed" and trade.get("exit_ms") is not None and trade["exit_ms"] <= now_ms
            before = db.execute("SELECT direccion_json, mfe_pb, mae_pb, hasta_ms, exit_ms FROM operaciones WHERE product=? AND trade_no=?",
                                (product, trade["trade_no"])).fetchone()
            values = (side, entry, trade.get("exit_ms"), _dumps(direction), mfe, mae, until)
            if before is not None and tuple(before) == (values[3], mfe, mae, until, trade.get("exit_ms")) and not finished:
                continue
            db.execute("INSERT OR REPLACE INTO operaciones(product, trade_no, lado, entry_ms, exit_ms, direccion_json, mfe_pb, mae_pb, "
                       "hasta_ms, resuelto_ms, version) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (product, trade["trade_no"]) + values + (now_ms if finished else None, VERSION))
            written += 1
    return written


# --------------------------------------------------------------------------- to train later (S8, T15): facts, proposals, positions


# La regla oficial de entrada y de salida del trader (``corta.formula_action``), enlazada al importar: el auditor aplica SIEMPRE esa función
# (no una copia) aunque otra cosa la reemplace durante la corrida (las pruebas del trader la sustituyen por respuestas en orden).
_official_action = corta.formula_action

_HASHES = {}                                           # id(objeto) -> (objeto, hash): el objeto vive en la caché de las fórmulas, no se recalcula por mirada
_VERSIONS = {}                                         # (carpeta, config_hash) -> id de config_versions (solo se guardan los encontrados)


def _cached_hash(obj, make):
    found = _HASHES.get(id(obj))
    if found is None or found[0] is not obj:
        found = _HASHES[id(obj)] = (obj, make(obj))
    return found[1]


def _config_version(live_db_path, config_hash):
    """El ``id`` de esa config en ``config_versions`` de la base viva (solo lectura), o ``None``."""
    key = (os.path.abspath(live_db_path), config_hash)
    if key in _VERSIONS:
        return _VERSIONS[key]
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            row = live.execute("SELECT id FROM config_versions WHERE config_hash=? ORDER BY id DESC LIMIT 1", (config_hash,)).fetchone()
    except sqlite3.Error:
        return None
    if row is not None:
        _VERSIONS[key] = int(row[0])
    return None if row is None else int(row[0])


def _identity(live_db_path, trader, t_ms, readings_, config_hash):
    """Quién propuso: hash del maestro y del portero (16 caracteres), hash y versión de la config y modelo de costos. Aparte de ``version``
    (la del auditor)."""
    teacher, keeper = _safe(corta.formulas, trader.cfg, t_ms) or (None, None)
    vote = readings_.get("portero_autonomo")
    config_hash = config_hash or _safe(_cached_hash, trader.cfg, qt.config_hash)
    keeper_hash = (str(vote["model_sha256"])[:16] if isinstance(vote, dict) and vote.get("model_sha256") else
                   None if keeper is None else _safe(_cached_hash, keeper, lambda k: portero_formula.portero_hash(k)[:16]))
    return {"maestro_hash": None if teacher is None else _safe(_cached_hash, teacher, lambda t: maestro_formula.teacher_hash(t)[:16]),
            "portero_hash": keeper_hash, "config_hash": config_hash,
            "config_version": None if config_hash is None else _config_version(live_db_path, config_hash),
            "costos_id": COST_MODEL_VERSION}


def _keeper_inputs(trader, t_ms, readings_):
    """Lo que hace falta para recalcular el veredicto del portero con los hechos guardados: su voto, su probabilidad o apoyo y su umbral."""
    vote = readings_.get("portero_autonomo")
    keeper = (_safe(corta.formulas, trader.cfg, t_ms) or (None, None))[1]
    return {"tipo": "autonomo" if isinstance(vote, dict) else ("legacy" if keeper is not None else None),
            "si": readings_.get("portero_si"), "p": _num(readings_.get("portero_p")),
            "umbral": None if keeper is None else _num(keeper.get("umbral")), "direccion": readings_.get("portero_direccion"),
            "autonomo": vote if isinstance(vote, dict) else None}


def _entry_side(trader, readings_):
    """El lado de la señal de entrada de la mirada (+1 / -1 / 0), con la misma función oficial que usa el trader."""
    if noticias.priority_enabled(trader.cfg):
        action, _ = qt.Trader._independent_formula_action(readings_)
    else:
        action, _ = _official_action(readings_, None)
    return 1 if action == "LARGO" else -1 if action == "CORTO" else 0


def _block_reason(look, events):
    """``(motivo, detalle)`` por el que una propuesta no abrió: ``motivo`` es uno de ``BLOCK_REASONS``, ``detalle`` el motivo crudo del trader
    cuando cae en ``otro``."""
    skip = look.get("skip")
    if skip == "cooldown":
        return "enfriamiento", None
    if skip == "eventos":
        return ("cierre_en_la_mirada", None) if any(e.get("type") in ("trade", "guardrail") for e in events) else ("otro", "eventos")
    if look.get("closed_here"):
        return "cierre_en_la_mirada", None
    kind = look.get("blocked")
    if kind in ("lugares_ocupados", "mismo_episodio", "cierre_en_la_mirada", "subida_30d", "separacion_60min"):
        return kind, None
    if kind:
        return "otro", str(kind)
    skipped = next((e for e in events if e.get("type") == "skipped"), None)
    if skipped is not None:
        return "otro", str(skipped.get("kind"))
    return "otro", "posicion_abierta" if look.get("open_ids") else "sin_apertura"


def _opened_trade(events, t_ms):
    """El ``trade_no`` de la posición que esta mirada abrió, o ``None``."""
    for e in events:
        if e.get("type") == "decision" and e.get("t_ms") == t_ms and e.get("action") in ("LARGO", "CORTO") and e.get("trade_no") is not None:
            return e["trade_no"]
    return None


def _record_facts(db, live_db_path, product, trader, readings_, t_ms, config_hash):
    """G1 + G4: los hechos aplanados del maestro, su puntaje y veredicto, lo del portero y la identidad del proponente. Escribe dentro de la
    transacción de ``record_look`` (no confirma)."""
    who = _identity(live_db_path, trader, t_ms, readings_, config_hash)
    cursor = db.execute(
        "INSERT OR IGNORE INTO hechos_mirada(product, bucket_ms, t_ms, hechos_json, puntaje, veredicto, portero_json, maestro_hash, "
        "portero_hash, config_hash, config_version, costos_id, version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (product, t_ms - BUCKET_MS, t_ms, _dumps(readings_["hechos"]), _num(readings_.get("puntaje")),
         readings_["veredicto"] if isinstance(readings_.get("veredicto"), int) else None,
         _dumps(_keeper_inputs(trader, t_ms, readings_)), who["maestro_hash"], who["portero_hash"], who["config_hash"],
         who["config_version"], who["costos_id"], VERSION))
    return cursor.rowcount == 1


def _record_proposal(db, product, trader, look, readings_, events, t_ms):
    """G2: la propuesta de entrada de la mirada (el maestro fuerte con el portero a favor), abierta o bloqueada, con su motivo. Sin etiqueta:
    ``resolve`` la calcula después. Devuelve ``"abierta"`` / ``"bloqueada"`` o ``None`` si no hubo señal. Escribe dentro de la transacción de
    ``record_look`` (no confirma)."""
    side = _entry_side(trader, readings_)
    if not side:
        return None
    previous = look.get("prev_entry_side")
    if previous is None:                                                 # modo de un solo lugar: el trader no lleva el borde; sale de la mirada anterior
        row = db.execute("SELECT lado FROM propuestas WHERE product=? AND bucket_ms=?", (product, t_ms - 2 * BUCKET_MS)).fetchone()
        previous = 0 if row is None else row[0]
    opened = _opened_trade(events, t_ms)
    reason, detail = (None, None) if opened is not None else _block_reason(look, events)
    index = _safe(_index_of, trader, t_ms)
    db.execute(
        "INSERT OR IGNORE INTO propuestas(product, bucket_ms, t_ms, lado, inicio_episodio, estado, motivo_bloqueo, detalle_bloqueo, "
        "trade_no, maestro, puntaje, portero_p, precio, version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (product, t_ms - BUCKET_MS, t_ms, side, int(previous != side), "abierta" if opened is not None else "bloqueada", reason, detail,
         opened, readings_["veredicto"], _num(readings_.get("puntaje")), _num(readings_.get("portero_p")),
         None if index is None else _num(trader.c[index]), VERSION))
    return "abierta" if opened is not None else "bloqueada"


def _record_positions(db, product, trader, look, readings_, events, marks, t_ms):
    """G3: una fila por posición abierta en la mirada (las que había al empezar, la que cerró en ella y la que abrió): lado, entrada, horas,
    neto ahora, el puntaje del maestro contra el lado y lo que dice la regla de salida. Devuelve cuántas filas escribió. Escribe dentro de la
    transacción de ``record_look`` (no confirma)."""
    closed = {e["trade"]["trade_no"]: e["trade"] for e in events if e.get("type") == "trade" and isinstance(e.get("trade"), dict)}
    held = {p.trade_no: p for p in trader.positions}
    opened = _opened_trade(events, t_ms)
    exits = look.get("exits") or {}
    ids = list(dict.fromkeys(list(look.get("open_ids") or []) + ([] if opened is None else [opened])))
    score, verdict = _num(readings_.get("puntaje")), readings_.get("veredicto")
    written = 0
    for number in ids:
        if number in closed:
            trade = closed[number]
            side, entry_ms, entry_px = _side_of(trade.get("side")), trade.get("entry_ms"), _num(trade.get("entry_px"))
            event, net, origin = "cierra", _num(trade.get("net_bp")), trade.get("entry_reason")
        elif number in held:
            position = held[number]
            side, entry_ms, entry_px = _side_of(position.side), position.entry_ms, _num(position.entry_px)
            event, origin = "abre" if number == opened else "mantiene", position.entry_reason
            net = _num(((marks or {}).get(number) or {}).get("net_bp"))
        else:
            continue
        if not side:
            continue
        says = "CERRAR" if number in exits or event == "cierra" else (None if event == "abre" else "MANTENER")
        db.execute(
            "INSERT OR IGNORE INTO mirada_operaciones(product, bucket_ms, trade_no, t_ms, lado, evento, origen, entry_ms, entry_px, horas, "
            "neto_ahora_pb, puntaje, maestro, puntaje_lado, maestro_lado, salida_dice, salida_motivo, version) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (product, t_ms - BUCKET_MS, number, t_ms, side, event, origin, entry_ms, entry_px,
             None if entry_ms is None else (t_ms - entry_ms) / HOUR_MS, net, score, verdict,
             None if score is None else side * score, side * verdict if isinstance(verdict, int) else None, says,
             exits.get(number), VERSION))
        written += 1
    return written


def record_look(live_db_path, product, trader, events, now_ms, marks=None, config_hash=None):
    """Lo que el auditor guarda además de la mirada, para entrenar más adelante (S8): los hechos del maestro y la identidad del proponente,
    la propuesta de entrada con su motivo de bloqueo y el estado de cada posición abierta. Lee solo lo que el trader dejó en
    ``trader.look_audit`` (o, en una mirada de enfriamiento, lo calcula con ``corta.readings``) y no hace ninguna llamada de red.

    Una sola transacción y un solo ``COMMIT`` por mirada (``odd/tasks/operacion-mejoras.md`` T9: cada confirmación son varios ``fsync``), con un
    ``SAVEPOINT`` por paso: un paso que falla deshace solo lo suyo y los otros quedan. Las filas son las mismas que con un ``COMMIT`` por paso.

    NUNCA propaga una excepción ni cambia nada del trader: cada pedazo va protegido y lo que falle queda en ``avisos`` (el proceso en vivo
    lo anota en su tabla ``errors``). ``marks``: ``{trade_no: valuación}`` que el proceso ya calculó. Devuelve
    ``{"hechos", "propuesta", "posiciones", "avisos", "ms", "pasos_ms"}``; ``pasos_ms`` = lo que tardó cada paso (``abrir``, ``hechos``,
    ``propuesta``, ``posiciones`` y ``commit``)."""
    started = time.monotonic()
    out = {"hechos": False, "propuesta": None, "posiciones": 0, "avisos": [], "ms": 0.0, "pasos_ms": {}}

    def lap(name, since):
        out["pasos_ms"][name] = (time.monotonic() - since) * 1000.0

    try:
        look = getattr(trader, "look_audit", None)
        if look and trader.t and look.get("t_ms") == trader.t[-1] + BAR_MS:
            t_ms = int(look["t_ms"])
            readings_ = look.get("readings")
            if readings_ is None and look.get("skip") and _safe(trader.wake_reasons, t_ms):
                readings_ = _safe(corta.readings, trader, t_ms)          # el trader no miró (enfriamiento, cierre): la mirada igual existía
            if readings_ is not None:
                events = list(events or ())
                step = time.monotonic()
                with contextlib.closing(_open(live_db_path, TRAINING_LOCK_TIMEOUT_S)) as db:
                    lap("abrir", step)

                    def guarded(name, function, *args):
                        began = time.monotonic()
                        db.execute("SAVEPOINT paso")
                        try:
                            result = function(db, *args)
                        except Exception as error:                     # noqa: BLE001 - el registro nuevo nunca rompe la operación
                            db.execute("ROLLBACK TO paso")             # solo lo de este paso
                            out["avisos"].append("{}: {}: {}".format(name, type(error).__name__, error))
                            result = None
                        db.execute("RELEASE paso")
                        lap(name, began)
                        return result

                    db.execute("BEGIN IMMEDIATE")                       # espera a lo sumo TRAINING_LOCK_TIMEOUT_S una base ocupada, como antes
                    out["hechos"] = bool(guarded("hechos", _record_facts, live_db_path, product, trader, readings_, t_ms, config_hash))
                    out["propuesta"] = guarded("propuesta", _record_proposal, product, trader, look, readings_, events, t_ms)
                    out["posiciones"] = guarded("posiciones", _record_positions, product, trader, look, readings_, events, marks, t_ms) or 0
                    step = time.monotonic()
                    try:
                        db.commit()
                    except Exception as error:                         # noqa: BLE001 - sin confirmar no queda nada de la mirada
                        out.update(hechos=False, propuesta=None, posiciones=0)
                        out["avisos"].append("registro: {}: {}".format(type(error).__name__, error))
                    lap("commit", step)
    except Exception as error:                                         # noqa: BLE001
        out["avisos"].append("registro: {}: {}".format(type(error).__name__, error))
    out["ms"] = (time.monotonic() - started) * 1000.0
    return out


def record_durations(live_db_path, product, t_ms, origen, total_ms, pasos, now_ms):
    """Una fila en ``duraciones_auditor`` (solo-agregar): ``origen`` = ``mirada`` (lo que tardó el auditor después de la decisión de la mirada
    ``t_ms``) o ``sombra`` (una pasada de la sombra maker en un sondeo tranquilo), ``total_ms`` y ``pasos`` = ``{paso: ms}``. Un solo ``INSERT`` y un
    ``COMMIT``. NUNCA propaga una excepción: devuelve la lista de avisos (vacía si se escribió)."""
    try:
        body = _dumps({str(name): round(float(value), 3) for name, value in dict(pasos).items()})
        with contextlib.closing(_open(live_db_path, TRAINING_LOCK_TIMEOUT_S)) as db:
            with db:
                db.execute("INSERT INTO duraciones_auditor(product, t_ms, origen, total_ms, pasos_json, registrada_ms, version) VALUES(?,?,?,?,?,?,?)",
                           (product, None if t_ms is None else int(t_ms), str(origen), round(float(total_ms), 3), body, int(now_ms), VERSION))
        return []
    except Exception as error:                                         # noqa: BLE001 - un diagnóstico nunca rompe la operación
        return ["duraciones: {}: {}".format(type(error).__name__, error)]


def record_missed(live_db_path, product, trader, event, now_ms):
    """Una mirada programada que la Terminal NO hizo (el proceso estaba apagado o trabado: evento ``skipped`` de motivo ``proceso_detenido``)
    queda en ``miradas_perdidas``: hora, motivo, si había posición y, calculado de las velas que ya tiene el trader, lo que la fórmula
    habría dicho (entrada, y salida de cada posición abierta). Es HIPOTÉTICO: esa mirada no operó nunca (la de recuperación opera con los datos
    de ahora). Idempotente (``INSERT OR IGNORE`` por producto y balde). Nunca propaga una excepción ni cambia nada del trader; lo que falle queda
    en ``avisos``. Devuelve ``{"perdida", "avisos", "ms"}``."""
    started = time.monotonic()
    out = {"perdida": False, "avisos": [], "ms": 0.0}
    try:
        t_ms = int(event["t_ms"])
        positions = list(trader.maestro_positions()) if hasattr(trader, "maestro_positions") else list(getattr(trader, "positions", ()))
        readings_ = _safe(corta.readings, trader, t_ms) if trader.t and trader.t[-1] + BAR_MS == t_ms else None
        if readings_ is None:
            out["avisos"].append("perdida: sin lectura de la fórmula en {}".format(t_ms))
        entry, exits, says_entry, says_exit = None, [], None, None
        if readings_ is not None:
            if noticias.priority_enabled(trader.cfg):
                entry = qt.Trader._independent_formula_action(readings_)
            else:
                entry = _official_action(readings_, None)
            says_entry = entry[0]
            exhaust_min = (trader.cfg.get("guardrails") or {}).get("exhaust_hold_min")
            for position in positions:
                side = _side_of(position.side)
                held_min = (t_ms - position.entry_ms) // MINUTE_MS
                action, why = _official_action(readings_, side, held_min=held_min, exhaust_min=exhaust_min)
                exits.append({"trade_no": position.trade_no, "lado": side, "horas": round(held_min / 60.0, 2), "dice": action, "motivo": why})
            if exits:
                says_exit = "CERRAR" if any(e["dice"] == "CERRAR" for e in exits) else "MANTENER"
        detail = None if readings_ is None else {
            "entrada": {"dice": entry[0], "motivo": entry[1]}, "posiciones": exits, "maestro": readings_.get("veredicto"),
            "puntaje": _num(readings_.get("puntaje")), "portero_si": _flag(readings_.get("portero_si")),
            "portero_p": _num(readings_.get("portero_p")), "volatilidad": readings_.get("volatilidad"),
            "nota": "hipotético: lo que la fórmula habría dicho con los datos de esa mirada; no se operó"}
        wake = event.get("wake")
        with contextlib.closing(_open(live_db_path, TRAINING_LOCK_TIMEOUT_S)) as db:
            with db:
                cursor = db.execute(
                    "INSERT OR IGNORE INTO miradas_perdidas(product, bucket_ms, t_ms, motivo, detalle, despertar_json, estado, maestro, puntaje, "
                    "entrada_dice, salida_dice, formula_json, registrada_ms, version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (product, t_ms - BUCKET_MS, t_ms, str(event.get("kind")), event.get("detail"),
                     _dumps([str(x) for x in wake][:8]) if isinstance(wake, (list, tuple)) else None,
                     "en_posicion" if positions else "plana",
                     None if readings_ is None or not isinstance(readings_.get("veredicto"), int) else readings_["veredicto"],
                     None if readings_ is None else _num(readings_.get("puntaje")), says_entry, says_exit,
                     None if detail is None else _dumps(detail), int(now_ms), VERSION))
                out["perdida"] = cursor.rowcount == 1
    except Exception as error:                                         # noqa: BLE001 - el registro nuevo nunca rompe la operación
        out["avisos"].append("perdida: {}: {}".format(type(error).__name__, error))
    out["ms"] = (time.monotonic() - started) * 1000.0
    return out


# --------------------------------------------------------------------------- to train later: labels and real results (resolve)


def _proposal_exit(side, t0, looks, now_ms, hold_ms, exhaust_min):
    """``(salida_ms, motivo, mirada)`` de una operación simulada abierta en ``t0`` del lado ``side`` con las reglas OFICIALES de salida:
    la fórmula del trader (``corta.formula_action``: el maestro se dio vuelta, o pasaron ``exhaust_min`` y perdió fuerza) mirada tras
    mirada, y el tope de tiempo (``max_hold_min``) que el trader revisa antes. Solo con miradas ya pasadas (``<= now_ms``). ``None`` si
    todavía no salió."""
    for t_ms, verdict, score in looks:
        if t_ms <= t0 or t_ms > now_ms:
            continue
        held = t_ms - t0
        if hold_ms and held >= hold_ms:
            return t0 + hold_ms, "tiempo", None
        action, why = _official_action({"veredicto": verdict, "puntaje": score}, side, held_min=held // MINUTE_MS, exhaust_min=exhaust_min)
        if action == "CERRAR":
            return t_ms, ("maestro_agotado" if "perdió fuerza" in why else "maestro_vuelta"), t_ms
    if hold_ms and now_ms >= t0 + hold_ms:
        return t0 + hold_ms, "tiempo", None
    return None


def _resolve_proposals(db, product, prices, cfg, now_ms, cost_bp):
    """Etiqueta contrafactual de cada propuesta sin resolver (abierta o bloqueada): neto después de costos, motivo de salida y horas de la
    operación que habría salido con las reglas oficiales (``_proposal_exit``), desde el cierre de la mirada y sin funding. Calculado aquí,
    nunca en la mirada. Una propuesta sin precios después del tope más ``GIVE_UP_MS`` queda ``sin_datos`` para no trabar el archivo.
    Devuelve cuántas etiquetó."""
    rows = db.execute("SELECT bucket_ms, t_ms, lado FROM propuestas WHERE product=? AND resuelto_ms IS NULL AND t_ms<? ORDER BY t_ms LIMIT ?",
                      (product, now_ms, RESOLVE_LIMIT)).fetchall()
    if not rows:
        return 0
    guard = (cfg or {}).get("guardrails") or {}
    hold_ms = (guard.get("max_hold_min") or 0) * MINUTE_MS or None
    exhaust = guard.get("exhaust_hold_min")
    horizon = hold_ms or 4 * DAY_MS
    looks = db.execute("SELECT t_ms, veredicto, puntaje FROM hechos_mirada WHERE product=? AND t_ms>? AND t_ms<=? ORDER BY t_ms",
                       (product, min(r["t_ms"] for r in rows), min(now_ms, max(r["t_ms"] for r in rows) + horizon))).fetchall()
    times = [r["t_ms"] for r in looks]
    done = 0
    with db:
        for row in rows:
            t0, side = row["t_ms"], row["lado"]
            p0 = prices.at(t0)
            found = None
            if p0 is not None:
                lo, hi = bisect.bisect_right(times, t0), bisect.bisect_right(times, min(now_ms, t0 + horizon))
                found = _proposal_exit(side, t0, [(r["t_ms"], r["veredicto"], r["puntaje"]) for r in looks[lo:hi]], now_ms, hold_ms, exhaust)
            exit_px = None if found is None else prices.at(found[0])
            if p0 is None or found is None or exit_px is None:
                if now_ms >= t0 + horizon + GIVE_UP_MS:
                    db.execute("UPDATE propuestas SET contrafactual_json=?, resuelto_ms=? WHERE product=? AND bucket_ms=?",
                               (_dumps({"estado": "sin_datos"}), now_ms, product, row["bucket_ms"]))
                    done += 1
                continue
            exit_ms, motive, look_ms = found
            gross = side * _pb(exit_px, p0)
            label = {"neto_pb": gross - cost_bp, "bruto_pb": gross, "costo_pb": float(cost_bp), "motivo": motive,
                     "horas": (exit_ms - t0) / HOUR_MS, "salida_ms": exit_ms, "mirada_salida_ms": look_ms, "entrada_px": p0,
                     "salida_px": exit_px, "regla": "formula_action + tope de tiempo; sin funding"}
            db.execute("UPDATE propuestas SET contrafactual_json=?, neto_pb=?, motivo_salida=?, horas=?, salida_ms=?, resuelto_ms=? "
                       "WHERE product=? AND bucket_ms=?",
                       (_dumps(label), label["neto_pb"], motive, label["horas"], exit_ms, now_ms, product, row["bucket_ms"]))
            done += 1
    return done


def _high_low_excursions(ranges, keys, side, p0, entry, end, exit_px):
    """``(mfe, mae, hasta_ms)`` de la operación sobre los máximos y mínimos de las velas con cierre en ``(entry, end]`` (más el precio de
    salida real): lo mejor y lo peor a favor del lado respecto de ``p0``. ``mfe >= 0 >= mae``. ``None`` sin ninguna vela."""
    start, stop = bisect.bisect_right(keys, entry), bisect.bisect_right(keys, end)
    seen = keys[start:stop]
    if not seen:
        return None, None, None
    run = [side * _pb(price, p0) for key in seen for price in ranges[key]]
    if exit_px is not None and exit_px > 0:
        run.append(side * _pb(exit_px, p0))
    return max(0.0, max(run)), min(0.0, min(run)), seen[-1]


def _resolve_trade_results(live_db_path, db, product, prices, ranges, now_ms):
    """G5: el resultado REAL de cada operación cerrada, en ``resultados_operacion`` (tabla nueva; ``operaciones`` y sus MFE/MAE sobre
    cierres no se tocan): neto después de costos tal como lo dejaron los recibos (``trades``), motivos, precios y MFE/MAE con máximos y
    mínimos de las velas. Queda final (``resultado_ms``) cuando la operación está cerrada, su funding completo y hay velas; mientras
    tanto se actualiza. Devuelve cuántas filas escribió."""
    final = {r[0] for r in db.execute("SELECT trade_no FROM resultados_operacion WHERE product=? AND resultado_ms IS NOT NULL", (product,))}
    try:
        with contextlib.closing(_live_readonly(live_db_path)) as live:
            trades = [dict(r) for r in live.execute(
                "SELECT trade_no, side, entry_ms, exit_ms, entry_px, exit_px, net_bp, net_usd, notional_usd, closed_by, exit_reason, "
                "entry_reason, funding_status FROM trades WHERE product=? AND status='closed' AND exit_ms IS NOT NULL AND exit_ms<=? "
                "ORDER BY trade_no", (product, now_ms))]
    except sqlite3.Error:
        return 0
    keys = sorted(ranges) if ranges else []
    written = 0
    with db:
        for trade in trades:
            side = _side_of(trade["side"])
            if trade["trade_no"] in final or not side:
                continue
            exit_px = _num(trade["exit_px"])
            p0 = prices.at(trade["entry_ms"])
            mfe = mae = until = None
            if p0 is not None and keys:
                mfe, mae, until = _high_low_excursions(ranges, keys, side, p0, trade["entry_ms"], trade["exit_ms"], exit_px)
            done = trade["funding_status"] == "complete" and until is not None
            values = (side, trade["entry_ms"], trade["exit_ms"], _num(trade["net_bp"]), _num(trade["net_usd"]), _num(trade["notional_usd"]),
                      trade["entry_reason"], trade["closed_by"], trade["exit_reason"], _num(trade["entry_px"]), exit_px, mfe, mae, until)
            before = db.execute("SELECT lado, entry_ms, exit_ms, neto_pb, neto_usd, notional_usd, motivo_entrada, motivo_cierre, motivo_salida, "
                                "entry_px, exit_px, mfe_hl_pb, mae_hl_pb, hl_hasta_ms FROM resultados_operacion WHERE product=? AND trade_no=?",
                                (product, trade["trade_no"])).fetchone()
            if before is not None and tuple(before) == values and not done:
                continue
            db.execute("INSERT OR REPLACE INTO resultados_operacion(product, trade_no, lado, entry_ms, exit_ms, neto_pb, neto_usd, notional_usd, "
                       "motivo_entrada, motivo_cierre, motivo_salida, entry_px, exit_px, mfe_hl_pb, mae_hl_pb, hl_hasta_ms, resultado_ms, "
                       "version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (product, trade["trade_no"]) + values + (now_ms if done else None, VERSION))
            written += 1
    return written


def _resolve_training(live_db_path, product, prices, ranges, cfg, now_ms, cost_bp, market_db=None, shadow=True):
    """Los pasos nuevos de ``resolve`` (etiquetas contrafactuales, resultados reales y, al final, la sombra maker), cada uno protegido: un fallo
    queda en ``avisos`` y no toca lo demás. ``ms`` = lo que tardaron las etiquetas y los resultados; ``sombra_ms`` = lo que tardó la sombra (0 si no
    corrió); ``pasos_ms`` = ``{propuestas, resultados, sombra}``. Con ``shadow=False`` la sombra no corre (``sombra_estado`` = ``diferida``)."""
    started = time.monotonic()
    state = "apagada" if not market_db else ("ok" if shadow else "diferida")
    out = {"propuestas": 0, "resultados": 0, "sombra": 0, "sombra_estado": state, "avisos": [], "pasos_ms": {"propuestas": 0.0, "resultados": 0.0, "sombra": 0.0}}
    shadow_ms = 0.0
    try:
        with contextlib.closing(_open(live_db_path, TRAINING_LOCK_TIMEOUT_S)) as db:
            for key, step in (("propuestas", lambda: _resolve_proposals(db, product, prices, cfg, now_ms, float(cost_bp))),
                              ("resultados", lambda: _resolve_trade_results(live_db_path, db, product, prices, ranges, now_ms))):
                began = time.monotonic()
                try:
                    out[key] = step()
                except Exception as error:                              # noqa: BLE001 - lo nuevo nunca cambia lo que ya se resolvió
                    out["avisos"].append("{}: {}: {}".format(key, type(error).__name__, error))
                out["pasos_ms"][key] = (time.monotonic() - began) * 1000.0
            out["ms"] = (time.monotonic() - started) * 1000.0
            if market_db and shadow:
                shadow_ms = _shadow_step(live_db_path, db, product, now_ms, market_db, out)
    except Exception as error:                                          # noqa: BLE001
        out["avisos"].append("abrir: {}: {}".format(type(error).__name__, error))
    out.setdefault("ms", (time.monotonic() - started) * 1000.0)
    out["sombra_ms"] = out["pasos_ms"]["sombra"] = shadow_ms
    return out


def _shadow_step(live_db_path, db, product, now_ms, market_db, out):
    """La sombra maker con su protección (``_resolve_shadow``): llena ``sombra``, ``sombra_estado``, ``sombra_pendientes`` y ``avisos`` de ``out``. Devuelve lo que
    tardó, en ms."""
    began = time.monotonic()
    try:
        state = {}
        out["sombra"] = _resolve_shadow(live_db_path, db, product, now_ms, market_db, out["avisos"], state)
        out["sombra_estado"] = state.get("estado", "ok")
        out["sombra_pendientes"] = state.get("pendientes", 0)
    except Exception as error:                                          # noqa: BLE001 - la sombra solo observa: si falla, un aviso y nada más
        out["avisos"].append("sombra: {}: {}".format(type(error).__name__, error))
    return (time.monotonic() - began) * 1000.0


def resolve_shadow(live_db_path, product, now_ms, market_db):
    """Solo la sombra maker (lo que ``resolve(..., shadow=False)`` deja): el proceso en vivo la corre en un sondeo tranquilo, nunca en el de una
    mirada. A lo sumo ``SHADOW_LEGS_PER_PASS`` tramos y ``SHADOW_BUDGET_S`` por llamada. NUNCA propaga una excepción. Devuelve
    ``{"sombra", "sombra_estado", "sombra_pendientes", "avisos", "sombra_ms"}``: ``sombra`` = filas escritas y ``sombra_pendientes`` = tramos maduros por calcular al
    empezar (los que no entraron en esta pasada siguen en la próxima). Sin ``market_db``: ``apagada`` y no hace nada."""
    out = {"sombra": 0, "sombra_estado": "apagada" if not market_db else "ok", "sombra_pendientes": 0, "avisos": [], "sombra_ms": 0.0}
    if not market_db:
        return out
    try:
        with contextlib.closing(_open(live_db_path, TRAINING_LOCK_TIMEOUT_S)) as db:
            out["sombra_ms"] = _shadow_step(live_db_path, db, product, now_ms, market_db, out)
    except Exception as error:                                          # noqa: BLE001
        out["avisos"].append("abrir: {}: {}".format(type(error).__name__, error))
    return out


# --------------------------------------------------------------------------- maker shadow (odd/tasks/maker-sombra.md)

# Para cada entrada y cada salida OFICIAL (a mercado), una orden límite en papel sobre la cinta real que captura el servidor
# (``futures-market.sqlite``, solo lectura). Variante V2 sellada en ``analisis/costo-maker/hipotesis.md``: orden en el mejor precio propio (compra
# en el mejor bid, venta en el mejor ask) de la última foto del libro de hasta 20 s antes de la hora oficial; se llena con la primera operación
# de la cinta que pasa el límite por al menos un tick (tocarlo no llena: la cola se desconoce); si no llena en 15 min, cruza a mercado al precio de
# la cinta del minuto 15 con el costo del modelo (impacto y comisión taker). Solo se calcula DESPUÉS (``resolve``), con 15 min de cinta ya
# capturada; nunca dentro de la mirada en vivo. Faltan libro o cinta: ``sin_datos`` (nunca se adivina).
SHADOW_MODEL = "sombra-maker.v1"
SHADOW_WINDOW_MS = 15 * MINUTE_MS                 # cuánto espera la orden antes de cruzar
SHADOW_BOOK_AGE_MS = 20_000                       # la foto del libro no puede ser más vieja que esto respecto de la hora oficial
SHADOW_SETTLE_MS = 60_000                         # margen después de los 15 min para que la captura haya escrito la cinta
SHADOW_LEGS_PER_PASS = _int_env("FUTURES_AUDITOR_SHADOW_LEGS_PER_PASS", 3)   # tramos que la sombra calcula por pasada (acota lo que dura un sondeo del proceso en vivo; 0,2-1 s cada uno)
SHADOW_BUDGET_S = 1.5                             # tiempo total de la captura por llamada; pasado esto se corta con un aviso y sigue en la próxima
SHADOW_CAPTURE_TIMEOUT_S = 1.0                    # espera máxima por una base de captura ocupada
SHADOW_TAPE_GAP_MS = 5 * MINUTE_MS                # más que esto sin ninguna operación = la captura estuvo caída (ETH opera ~1 por segundo)
SHADOW_TAPE_ROWS = 20_000                         # tope de filas de cinta por tramo (15 min de ETH son ~1 000)
SHADOW_TICKS = {"PF_ETHUSD": Decimal("0.1")}      # solo los productos con libro y cinta capturados (tick de la API pública /instruments)
MARKET_DB_ENV = "FUTURES_MARKET_DB_PATH"
DEFAULT_MARKET_DB = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "server", "data", "dev-live", "futures-market.sqlite"))
_SHADOW_MOTIVES = {"maestro_vuelta": "vuelta", "maestro_agotado": "agotado", "noticia_12h": "noticia"}

# Consultas a la captura. Todas por el índice ``paper_futures_market_received(product_id, received_at, seq)`` o por clave primaria: nunca un
# recorrido de la tabla (la base de producción pesa decenas de GB). Hay una prueba con ``EXPLAIN QUERY PLAN``.
_SHADOW_SQL_HIGH_WATER = "SELECT MAX(received_at) FROM paper_futures_market_events WHERE product_id=?"
_SHADOW_SQL_BOOK = ("SELECT event_id, received_at FROM paper_futures_market_events WHERE product_id=? AND received_at BETWEEN ? AND ? "
                    "AND feed=? ORDER BY received_at DESC, seq DESC LIMIT 1")
_SHADOW_SQL_SNAPSHOT = "SELECT bids_json, asks_json FROM paper_futures_book_snapshots WHERE event_id=?"
_SHADOW_SQL_TAPE = ("SELECT received_at, json_extract(raw_json, '$.price') FROM paper_futures_market_events WHERE product_id=? AND received_at>? "
                    "AND received_at<=? AND feed=? ORDER BY received_at, seq LIMIT ?")


def market_db_path(env=None):
    """La base de captura de esta máquina: ``$FUTURES_MARKET_DB_PATH`` o la que escribe ``pnpm dev`` (``server/data/dev-live``)."""
    env = os.environ if env is None else env
    return (env.get(MARKET_DB_ENV) or "").strip() or DEFAULT_MARKET_DB


class _Capture:
    """La base de captura abierta SOLO para leer, con un plazo total: pasado ``deadline`` la consulta en curso se interrumpe."""

    def __init__(self, db, deadline):
        self.db, self.deadline = db, deadline

    def _run(self, sql, args):
        if time.monotonic() > self.deadline:
            raise TimeoutError("la sombra agotó su tiempo ({:.1f} s)".format(SHADOW_BUDGET_S))
        return self.db.execute(sql, args)

    def high_water(self, product):
        return self._run(_SHADOW_SQL_HIGH_WATER, (product,)).fetchone()[0]

    def book(self, product, at_ms):
        """``(recibida_ms, mejor compra, mejor venta)`` de la última foto del libro de hasta ``SHADOW_BOOK_AGE_MS`` antes de ``at_ms``, o ``None``."""
        found = self._run(_SHADOW_SQL_BOOK, (product, at_ms - SHADOW_BOOK_AGE_MS, at_ms, "book")).fetchone()
        if found is None:
            return None
        body = self._run(_SHADOW_SQL_SNAPSHOT, (found[0],)).fetchone()
        if body is None:
            return None
        try:
            bids = [_dec(level["price"]) for level in json.loads(body[0])]
            asks = [_dec(level["price"]) for level in json.loads(body[1])]
        except (ValueError, TypeError, KeyError):
            return None
        bids, asks = [p for p in bids if p is not None], [p for p in asks if p is not None]
        return (int(found[1]), max(bids), min(asks)) if bids and asks else None

    def tape(self, product, after_ms, until_ms):
        """``[(recibida_ms, precio)]`` de las operaciones con ``after_ms < recibida <= until_ms``, en orden (a lo sumo el tope + 1)."""
        rows = self._run(_SHADOW_SQL_TAPE, (product, after_ms, until_ms, "trade", SHADOW_TAPE_ROWS + 1)).fetchall()
        priced = [(int(at), _dec(price)) for at, price in rows]
        return [(at, price) for at, price in priced if price is not None and price > 0]

    def close(self):
        self.db.close()


def _open_capture(path, deadline):
    """La captura en solo lectura (``mode=ro``): nunca la escribe, ni siquiera un diario. ``deadline``: ``time.monotonic()`` límite."""
    db = sqlite3.connect(Path(os.path.abspath(path)).as_uri() + "?mode=ro", uri=True, timeout=SHADOW_CAPTURE_TIMEOUT_S)
    db.execute("PRAGMA query_only=1")
    db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5_000)
    return _Capture(db, deadline)


def _dec(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        out = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return out if out.is_finite() else None


def _shadow_motive(trade):
    """Por qué salió la operación oficial: ``vuelta``, ``agotado``, ``tiempo``, ``rebote`` (el experto de rebotes), ``noticia`` u ``otro``."""
    if trade.get("entry_reason") == "rebote":
        return "rebote"
    motive = _SHADOW_MOTIVES.get(trade.get("exit_reason"))
    if motive is not None:
        return motive
    return "tiempo" if trade.get("closed_by") == "tiempo" else "otro"


def _official_leg(trade, leg, receipt):
    """El tramo oficial ``leg`` (``entry`` / ``exit``) de una fila de ``trades`` con su recibo (si lo hay), o ``None`` si todavía no existe o le falta
    algo para compararlo. Con recibo: hora, precio, cantidad y comisión son los del recibo; sin recibo (operaciones de antes de los recibos): los de
    la fila de ``trades`` y la comisión del modelo (taker, salvo una salida que el plan marca como maker)."""
    side = _side_of(trade.get("side"))
    at = trade.get(leg + "_ms")
    if not side or at is None or (leg == "exit" and trade.get("status") != "closed"):
        return None
    receipt = receipt or {}
    price = _dec(receipt.get("price")) or _dec(trade.get(leg + "_px"))
    qty = _dec(receipt.get("quantity")) or _dec(trade.get("qty"))
    if price is None or qty is None or price <= 0 or qty <= 0:
        return None
    kind = receipt.get("fee_kind")
    if kind not in ("maker", "taker"):
        plan = _loads(trade.get("exit_plan_json")) if leg == "exit" else None
        kind = "maker" if isinstance(plan, dict) and plan.get("outcome") == "maker" else "taker"
    fee = _dec(receipt.get("fee_usd"))
    if fee is None:
        fee = price * qty * fee_rate(kind)
    sells = (leg == "entry") == (side < 0)                         # abrir un corto vende; cerrar un largo vende
    return {"trade_no": trade["trade_no"], "leg": leg, "lado": side, "orden": "venta" if sells else "compra",
            "t_ms": int(receipt.get("executed_at_ms") or at), "price": price, "qty": qty, "fee": fee, "fee_kind": kind,
            "notional": _dec(receipt.get("notional_usd")) or price * qty,
            "motivo_salida": _shadow_motive(trade) if leg == "exit" else None}


def _shadow_pending(live_db_path, db, product, now_ms):
    """Los tramos oficiales con 15 min (más el margen) ya cumplidos y sin fila de sombra, del más viejo al más nuevo."""
    done = {(r[0], r[1]) for r in db.execute("SELECT trade_no, leg FROM sombra_maker WHERE product=?", (product,))}
    legs = []
    with contextlib.closing(_live_readonly(live_db_path)) as live:
        trades = [dict(r) for r in live.execute(
            "SELECT trade_no, status, side, entry_ms, exit_ms, entry_px, exit_px, qty, closed_by, exit_reason, entry_reason, exit_plan_json "
            "FROM trades WHERE product=? ORDER BY trade_no", (product,))]
        receipts = {}
        for number, purpose, evidence in live.execute(
                "SELECT trade_no, purpose, evidence_json FROM execution_receipts WHERE product=? AND purpose IN ('entry','exit')", (product,)):
            receipts[(number, purpose)] = _loads(evidence)
    for trade in trades:
        for leg in ("entry", "exit"):
            if (trade["trade_no"], leg) in done:
                continue
            found = _official_leg(trade, leg, receipts.get((trade["trade_no"], leg)))
            if found is not None and found["t_ms"] + SHADOW_WINDOW_MS + SHADOW_SETTLE_MS <= now_ms:
                legs.append(found)
    legs.sort(key=lambda found: (found["t_ms"], found["trade_no"], found["leg"]))
    return legs


def _shadow_row(product, leg, now_ms, **fields):
    """La fila de ``sombra_maker`` de un tramo: lo oficial más lo que dicen ``fields`` (el resto, ``NULL``)."""
    row = {"product": product, "trade_no": leg["trade_no"], "leg": leg["leg"], "motivo_salida": leg["motivo_salida"], "lado": leg["lado"],
           "orden": leg["orden"], "t_oficial_ms": leg["t_ms"], "precio_oficial": float(leg["price"]),
           "comision_oficial_usd": float(leg["fee"]), "comision_oficial_tipo": leg["fee_kind"], "cantidad": float(leg["qty"]),
           "notional_oficial_usd": float(leg["notional"]), "libro_ms": None, "limite_px": None, "estado": "sin_datos",
           "motivo_sin_datos": None, "llenado_ms": None, "llenado_px": None, "cinta_px": None, "espera_ms": None,
           "comision_sombra_usd": None, "comision_sombra_tipo": None, "delta_usd": None, "delta_pb": None, "modelo": SHADOW_MODEL,
           "costos_id": COST_MODEL_VERSION, "resuelto_ms": now_ms, "version": VERSION}
    row.update(fields)
    return row


def _shadow_resolve_leg(capture, product, leg, now_ms):
    """La sombra de UN tramo oficial, o ``None`` si todavía no se puede (la captura no llegó al minuto 15). Nunca adivina: sin libro o sin cinta
    completa devuelve ``sin_datos`` con el motivo."""
    start, end = leg["t_ms"], leg["t_ms"] + SHADOW_WINDOW_MS
    tick = SHADOW_TICKS.get(product)
    if tick is None:
        return _shadow_row(product, leg, now_ms, motivo_sin_datos="producto_sin_captura")
    high = capture.high_water(product)
    if high is None or high < end:                                        # la captura todavía no vio el minuto 15: esperar (o rendirse)
        return None if now_ms - end < GIVE_UP_MS else _shadow_row(product, leg, now_ms, motivo_sin_datos="cinta_incompleta")
    book = capture.book(product, start)
    if book is None:
        return _shadow_row(product, leg, now_ms, motivo_sin_datos="sin_libro")
    book_ms, bid, ask = book
    try:                                                                  # abrir un largo compra (al bid) y cerrarlo vende (al ask): la misma regla que la salida maker
        limit = maker_exit.passive_price("LONG" if leg["orden"] == "venta" else "SHORT", bid, ask)
    except maker_exit.MakerExitError:
        return _shadow_row(product, leg, now_ms, libro_ms=book_ms, motivo_sin_datos="libro_invalido")
    known = {"libro_ms": book_ms, "limite_px": float(limit)}
    tape = capture.tape(product, start, end)
    if len(tape) > SHADOW_TAPE_ROWS:
        return _shadow_row(product, leg, now_ms, motivo_sin_datos="cinta_truncada", **known)
    buying = leg["orden"] == "compra"
    filled, previous = None, start
    for at, price in tape:
        if at - previous > SHADOW_TAPE_GAP_MS:                            # hueco antes de esta operación: lo que pasó adentro no se sabe
            return _shadow_row(product, leg, now_ms, motivo_sin_datos="cinta_con_huecos", **known)
        previous = at
        if (price <= limit - tick) if buying else (price >= limit + tick):       # un tick más allá: llena; tocar el límite no (cola desconocida)
            filled = at
            break
    if filled is not None:
        fill_px, fill_ms, kind, tape_px = limit, filled, "maker", None
    else:
        if end - previous > SHADOW_TAPE_GAP_MS:
            return _shadow_row(product, leg, now_ms, motivo_sin_datos="cinta_con_huecos", **known)
        tape_px = tape[-1][1]
        side = "LONG" if leg["lado"] > 0 else "SHORT"
        fill_px = entry_fill(tape_px, side, product) if leg["leg"] == "entry" else exit_fill(tape_px, side, product, "strategy_exit")
        fill_ms, kind = end, "taker"
    fee = fill_px * leg["qty"] * fee_rate(kind)
    gain = (leg["price"] - fill_px) * leg["qty"] if buying else (fill_px - leg["price"]) * leg["qty"]
    delta = gain + leg["fee"] - fee                                       # + = la sombra habría salido mejor que la operación oficial
    return _shadow_row(product, leg, now_ms, estado="maker" if kind == "maker" else "maker_mercado", llenado_ms=fill_ms,
                       llenado_px=float(fill_px), cinta_px=None if tape_px is None else float(tape_px), espera_ms=fill_ms - start,
                       comision_sombra_usd=float(fee), comision_sombra_tipo=kind, delta_usd=float(delta),
                       delta_pb=float(delta / leg["notional"] * 10_000), **known)


_SHADOW_COLUMNS = ("product", "trade_no", "leg", "motivo_salida", "lado", "orden", "t_oficial_ms", "precio_oficial", "comision_oficial_usd",
                   "comision_oficial_tipo", "cantidad", "notional_oficial_usd", "libro_ms", "limite_px", "estado", "motivo_sin_datos",
                   "llenado_ms", "llenado_px", "cinta_px", "espera_ms", "comision_sombra_usd", "comision_sombra_tipo", "delta_usd",
                   "delta_pb", "modelo", "costos_id", "resuelto_ms", "version")


def _resolve_shadow(live_db_path, db, product, now_ms, market_db, avisos, state):
    """Calcula y guarda (una sola vez, ``INSERT OR IGNORE``) la sombra de los tramos oficiales ya maduros, a lo sumo ``SHADOW_LEGS_PER_PASS`` por
    llamada y dentro de ``SHADOW_BUDGET_S`` (``state["pendientes"]`` = cuántos estaban maduros por calcular). Lo que falla en un tramo queda en ``avisos`` y el tramo se reintenta en la próxima pasada. Con tramos
    por calcular pero sin el archivo de captura no escribe nada y deja ``state["estado"] = "sin_captura"`` (la ruta es de esta máquina, no un fallo).
    Devuelve cuántas filas escribió."""
    pending = _shadow_pending(live_db_path, db, product, now_ms)
    state["pendientes"] = len(pending)
    legs = pending[:SHADOW_LEGS_PER_PASS]
    if not legs:
        return 0
    if not os.path.isfile(market_db):                                      # no es un fallo de la sombra: no hay captura en esta máquina (o la ruta no es esa)
        state["estado"] = "sin_captura"
        return 0
    written = 0
    with contextlib.closing(_open_capture(market_db, time.monotonic() + SHADOW_BUDGET_S)) as capture:
        for leg in legs:
            try:
                row = _shadow_resolve_leg(capture, product, leg, now_ms)
                if row is None:
                    continue
                with db:
                    db.execute("INSERT OR IGNORE INTO sombra_maker({}) VALUES({})".format(
                        ", ".join(_SHADOW_COLUMNS), ", ".join("?" * len(_SHADOW_COLUMNS))), tuple(row[name] for name in _SHADOW_COLUMNS))
                written += 1
            except TimeoutError:
                raise
            except sqlite3.OperationalError as error:
                if "interrupted" in str(error):                            # el plazo se cumplió en medio de una consulta
                    raise TimeoutError("la sombra agotó su tiempo ({:.1f} s)".format(SHADOW_BUDGET_S)) from error
                avisos.append("sombra: {}: {}: {}".format(leg["leg"], type(error).__name__, error))
            except Exception as error:                                     # noqa: BLE001 - un tramo que falla no frena a los demás ni a lo oficial
                avisos.append("sombra: {} {}: {}: {}".format(leg["trade_no"], leg["leg"], type(error).__name__, error))
    return written


# --------------------------------------------------------------------------- registry of retrains (G8)


def _assert_finite(value, where):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("{}: hay un número no finito".format(where))
    if isinstance(value, dict):
        for item in value.values():
            _assert_finite(item, where)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _assert_finite(item, where)


def registrar_reentreno(live_db_path, *, corte_ms, dataset_hash, spec, metricas, creado_ms=None):
    """Anota UN reentreno en ``reentrenos`` (solo-agregar: ni se corrige ni se borra): ``corte_ms`` = hasta cuándo llegan los datos de
    entrenamiento (ms UTC), ``dataset_hash`` = hash del conjunto, ``spec`` = la especificación completa (dict), ``metricas`` = las
    métricas FUERA de muestra (dict). Sin alguno de los cuatro, ``ValueError`` y no queda nada. Devuelve el ``id`` de la fila."""
    if isinstance(corte_ms, bool) or not isinstance(corte_ms, int) or corte_ms <= 0:
        raise ValueError("corte_ms: tiene que ser un entero positivo (ms UTC)")
    if not isinstance(dataset_hash, str) or not dataset_hash.strip():
        raise ValueError("dataset_hash: hace falta el hash del conjunto de datos")
    for name, value in (("spec", spec), ("metricas", metricas)):
        if not isinstance(value, dict) or not value:
            raise ValueError("{}: tiene que ser un objeto con contenido".format(name))
        _assert_finite(value, name)
    created = int(time.time() * 1000) if creado_ms is None else int(creado_ms)
    with contextlib.closing(_open(live_db_path)) as db:
        with db:
            cursor = db.execute("INSERT INTO reentrenos(corte_ms, dataset_hash, spec_json, metricas_fuera_de_muestra_json, creado_ms) "
                                "VALUES(?,?,?,?,?)", (corte_ms, dataset_hash.strip(), _dumps(spec), _dumps(metricas), created))
            return cursor.lastrowid


# --------------------------------------------------------------------------- the summary


def _stats(rows):
    """Miradas, aciertos y costo del error de un grupo de filas (ya con su mejor veredicto)."""
    judged = [v for _, v in rows if v is not None and v.get("acerto") is not None]
    hits = sum(1 for v in judged if v["acerto"])
    costs = [v.get("costo_error_pb") or 0.0 for v in judged]
    wrong = len(judged) - hits
    return {"miradas": len(rows), "juzgadas": len(judged), "aciertos": hits, "errores": wrong,
            "acierto_pct": round(hits / len(judged) * 100, 2) if judged else None,
            "costo_total_pb": round(math.fsum(costs), 2),
            "costo_medio_pb": round(math.fsum(costs) / len(judged), 2) if judged else None,
            "costo_medio_por_error_pb": round(math.fsum(costs) / wrong, 2) if wrong else None,
            "pocos_datos": len(rows) < MIN_SAMPLE}


def _best_verdict(row):
    for name in ("36h", "24h", "12h"):
        verdict = _loads(row["veredicto_" + name + "_json"])
        if verdict is not None:
            return verdict
    return None


def _band(value, edges, labels):
    """``labels[i]`` si ``edges[i-1] <= value < edges[i]`` (``labels`` tiene un elemento más que ``edges``)."""
    return labels[bisect.bisect_right(edges, value)]


_SLOTS = ("00-04", "04-08", "08-12", "12-16", "16-20", "20-24")
_DAYS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
_PORTER = ("0-0,02", "0,02-0,05", "0,05-0,10", "≥0,10")


def _dimensions(row, conditions_):
    """El grupo de la mirada en cada condición (solo las que se pueden calcular)."""
    out = {}
    hour, day = conditions_.get("hora_madrid"), conditions_.get("dia")
    if isinstance(hour, int):
        out["franja_horaria_madrid"] = _SLOTS[hour // 4]
    if isinstance(day, int) and 0 <= day <= 6:
        out["dia_semana"] = _DAYS[day]
    turbulence = (conditions_.get("mercado") or {}).get("turbulencia")
    out["turbulencia"] = "sin dato" if turbulence is None else ("turbulento" if turbulence else "calmo")
    if row["puntaje"] is not None and row["umbral_fuerte"]:
        out["puntaje_sobre_umbral_fuerte"] = _band(abs(row["puntaje"]) / row["umbral_fuerte"], (1, 1.25, 1.5, 2),
                                                   ("<1", "1-1,25", "1,25-1,5", "1,5-2", "≥2"))
    if row["portero_p"] is not None and row["portero_umbral"] is not None:
        gap = row["portero_p"] - row["portero_umbral"]
        label = _band(abs(gap), (0.02, 0.05, 0.10), _PORTER)
        out["portero_p_menos_umbral"] = label if gap >= 0 else "neg " + label
    if row["horas_en_posicion"] is not None:
        out["horas_en_posicion"] = _band(row["horas_en_posicion"], (4, 12, 24), ("<4", "4-12", "12-24", "≥24"))
    if row["neto_ahora_pb"] is not None:
        out["neto_al_momento"] = _band(row["neto_ahora_pb"], (-100, 0, 100), ("<−100", "−100..0", "0..100", "≥100"))
    return out


def summary(live_db_path, product=None, since_ms=None):
    """Resumen de las miradas: por tipo de acción (miradas, % de acierto con el veredicto de 36 h si existe, si no el de 24 h o el
    de 12 h, costo medio y total del error) y por condición (franja horaria de 4 h en Madrid, día de la semana, turbulencia,
    puntaje / umbral fuerte, portero_p - umbral, horas en posición y neto al momento; cada grupo con el total y el detalle por
    acción). ``pendientes``: miradas sin veredicto y con solo el provisorio. Un grupo con menos de 30 miradas lleva ``pocos_datos``."""
    sql, args = "SELECT * FROM miradas WHERE 1=1", []
    if product is not None:
        sql, args = sql + " AND product=?", args + [product]
    if since_ms is not None:
        sql, args = sql + " AND t_ms>=?", args + [since_ms]
    out = {"schema": SCHEMA_NAME, "producto": product, "desde_ms": since_ms, "minimo_miradas": MIN_SAMPLE}
    path = auditor_path(live_db_path)
    if not os.path.isfile(path):
        rows = []
    else:
        with contextlib.closing(_open(live_db_path)) as db:
            rows = db.execute(sql + " ORDER BY t_ms", args).fetchall()
    graded = [(r, _best_verdict(r)) for r in rows]
    out["miradas"] = len(rows)
    out["pendientes"] = {"sin_veredicto": sum(1 for _, v in graded if v is None),
                         "provisorias": sum(1 for r, v in graded if v is not None and r["veredicto_36h_json"] is None)}
    by_action = {name: [(r, v) for r, v in graded if r["accion"] == name] for name in ACTIONS}
    out["por_accion"] = {name: _stats([(None, v) for _, v in items]) for name, items in by_action.items() if items}
    groups = {}
    for row, verdict in graded:
        for dimension, group in _dimensions(row, _loads(row["condiciones_json"]) or {}).items():
            groups.setdefault(dimension, {}).setdefault(group, []).append((row, verdict))
    out["por_condicion"] = {
        dimension: {group: {"total": _stats([(None, v) for _, v in items]),
                            "por_accion": {name: _stats([(None, v) for r, v in items if r["accion"] == name])
                                           for name in ACTIONS if any(r["accion"] == name for r, _ in items)}}
                    for group, items in sorted(buckets.items())}
        for dimension, buckets in groups.items()}
    return out


# --------------------------------------------------------------------------- rebuild from the live database


def _decision_event(row):
    """Una fila de ``decisions`` como el evento que el trader habría dado."""
    event = {"type": "decision", "kind": row["kind"], "t_ms": row["t_ms"], "action": row["action"],
             "model_action": row["model_action"], "opinion_agrees": row["opinion_agrees"], "net_bp_now": row["net_bp_now"],
             "trade_no": row["trade_no"], "override": row["override"], "formula": _loads(row["formula_json"]),
             "position": _loads(row["position_json"]), "wake": _loads(row["wake_json"])}
    return event


def rebuild(live_db_path, product=None, cfg=None):
    """Crea las filas de ``miradas`` que falten recorriendo toda la tabla ``decisions`` (y las operaciones cerradas por tope de
    tiempo, que no dejan decisión). Sin trader: ``condiciones_json`` solo trae lo que hay en la base (``"origen": "rebuild"``).
    Idempotente. Devuelve cuántas filas creó."""
    created = 0
    with contextlib.closing(_live_readonly(live_db_path)) as live, contextlib.closing(_open(live_db_path)) as db:
        products = [product] if product else [r[0] for r in live.execute("SELECT DISTINCT product FROM decisions")]
        for name in products:
            trades = {r["trade_no"]: dict(r) for r in live.execute(
                "SELECT {}, max_hold_ms FROM trades WHERE product=?".format(_TRADE_COLUMNS), (name,))}
            decisions = live.execute("SELECT * FROM decisions WHERE product=? AND formula_json IS NOT NULL ORDER BY t_ms", (name,))
            with db:
                for decision in decisions:
                    event = _decision_event(decision)
                    if not event["formula"]:
                        continue
                    row = build_row(name, event, trade=trades.get(decision["trade_no"]), cfg=cfg)
                    created += _insert(db, row)
                done = {r[0] for r in db.execute("SELECT trade_no FROM miradas WHERE product=? AND accion LIKE 'SALIR%' "
                                                 "AND trade_no IS NOT NULL", (name,))}
                for number, trade in sorted(trades.items()):
                    if trade["closed_by"] != "tiempo" or trade["status"] != "closed" or number in done \
                            or not trade["max_hold_ms"] or trade["entry_ms"] is None:
                        continue
                    t_ms = int(trade["entry_ms"] + trade["max_hold_ms"])
                    event = {"type": "guardrail", "t_ms": t_ms, "guardrail": "tiempo", "trade_no": number,
                             "net_bp_now": trade["net_bp"],
                             "position": {"side": trade["side"], "entry_ms": trade["entry_ms"], "trade_no": number}}
                    created += _insert(db, build_row(name, event, trade=trade, cfg=cfg))
    return created


# --------------------------------------------------------------------------- command line


def load_cache_closes(path, from_ms=0):
    """``{t_ms del cierre: cierre}`` de la caché de velas de 5 min del proceso en vivo (``futures_history.CandleCache``), en solo
    lectura y sin red. ``{}`` si el archivo no existe."""
    if not os.path.isfile(path):
        return {}
    db = sqlite3.connect(Path(os.path.abspath(path)).as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        return {int(t) + BAR_MS: float(c) for t, c in db.execute(
            "SELECT t, c FROM candles WHERE res='5m' AND t>=? ORDER BY t", (max(0, from_ms - BAR_MS),))}
    finally:
        db.close()


def load_cache_ranges(path, from_ms=0):
    """``{t_ms del cierre: (máximo, mínimo)}`` de la caché de velas de 5 min, en solo lectura y sin red (para el MFE/MAE con extremos).
    ``{}`` si el archivo no existe."""
    if not os.path.isfile(path):
        return {}
    db = sqlite3.connect(Path(os.path.abspath(path)).as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        return {int(t) + BAR_MS: (float(h), float(l)) for t, h, l in db.execute(
            "SELECT t, h, l FROM candles WHERE res='5m' AND t>=? ORDER BY t", (max(0, from_ms - BAR_MS),))}
    finally:
        db.close()


def _candles_file(args, product):
    where = args.candles or os.path.join(os.path.dirname(os.path.abspath(args.db)), "cache")
    return where if os.path.isfile(where) else os.path.join(where, "candles-{}.sqlite".format(product))


def _cli_config(args):
    if args.config:
        return qt.load_config(args.config)
    try:
        with contextlib.closing(_live_readonly(args.db)) as live:
            row = live.execute("SELECT config_json FROM config_versions ORDER BY id DESC LIMIT 1").fetchone()
        if row is not None:
            return json.loads(row[0])
    except sqlite3.Error:
        pass
    return qt.load_config(qt.CONFIG_PATH_LIVE)


def _parser():
    parser = argparse.ArgumentParser(prog="python -m balancita_engine.futures_auditor", description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", required=True, help="ruta de live.sqlite (auditor.sqlite queda en la misma carpeta)")
    parser.add_argument("--product", help="un solo producto (por defecto, todos)")
    parser.add_argument("--rebuild", action="store_true", help="crea las filas que falten desde la tabla decisions")
    parser.add_argument("--resolve", action="store_true", help="completa lo que pasó después y los veredictos de 12/24/36 h")
    parser.add_argument("--market-db", help="base de captura del servidor (solo lectura) para la sombra maker (por defecto $FUTURES_MARKET_DB_PATH o "
                                            "server/data/dev-live/futures-market.sqlite)")
    parser.add_argument("--summary", action="store_true", help="imprime el resumen en JSON")
    parser.add_argument("--candles", help="carpeta con candles-<producto>.sqlite, o un archivo de velas (por defecto <carpeta de live>/cache)")
    parser.add_argument("--config", help="config con la que se decidió (por defecto, la última guardada en la base viva)")
    parser.add_argument("--since-ms", type=int, help="el resumen solo mira desde este momento")
    parser.add_argument("--now-ms", type=int, help="la hora de 'ahora' al resolver (por defecto, el reloj)")
    parser.add_argument("--registrar-reentreno", metavar="ARCHIVO.json",
                        help="anota un reentreno (solo-agregar): JSON con corte_ms, dataset_hash, spec, metricas y, opcional, creado_ms")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    if not os.path.isfile(args.db):
        print("No existe {}".format(args.db), file=sys.stderr)
        return 2
    out = {}
    cfg = None
    if args.rebuild:
        cfg = _cli_config(args)
        out["rebuild"] = {"creadas": rebuild(args.db, args.product, cfg)}
    if args.resolve:
        cfg = cfg or _cli_config(args)
        now = int(time.time() * 1000) if args.now_ms is None else args.now_ms
        with contextlib.closing(_open(args.db)) as db:
            products = [args.product] if args.product else [r[0] for r in db.execute("SELECT DISTINCT product FROM miradas")]
            firsts = {p: db.execute("SELECT MIN(t_ms) FROM miradas WHERE product=? AND resuelto_ms IS NULL", (p,)).fetchone()[0]
                      for p in products}
        out["resolve"] = {}
        for name in products:
            if firsts[name] is None:
                out["resolve"][name] = {"miradas": 0, "actualizadas": 0, "veredictos": 0, "pendientes": 0}
                continue
            closes = load_cache_closes(_candles_file(args, name), firsts[name])
            ranges = load_cache_ranges(_candles_file(args, name), firsts[name])
            out["resolve"][name] = resolve(args.db, name, closes, dict(cfg, products=[name]), now,
                                           float(round_trip_cost_bps(name)), ranges=ranges,
                                           market_db=args.market_db or market_db_path())
    if args.registrar_reentreno:
        with open(args.registrar_reentreno, encoding="utf-8") as handle:
            body = json.load(handle)
        out["reentreno"] = {"id": registrar_reentreno(args.db, corte_ms=body.get("corte_ms"), dataset_hash=body.get("dataset_hash"),
                                                      spec=body.get("spec"), metricas=body.get("metricas"), creado_ms=body.get("creado_ms"))}
    if args.summary or not out:
        out["summary"] = summary(args.db, args.product, args.since_ms)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
