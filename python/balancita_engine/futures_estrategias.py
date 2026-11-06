"""Estrategias del laboratorio: overlays inmutables de perillas sobre la config activa de la Terminal.

- ``config/terminal-activa.json``: snapshot congelado de ``config_versions.config_json`` (última versión activada de ``live.sqlite``)
  con su hash. El hash es el MISMO que calcula el trader (``futures_qwen_trader.config_hash``); si no coincide se falla.
- ``config/estrategias/<id>.json``: ``{id, nombre, descripcion, base_config_hash, cambios}``. Nunca se edita (otra versión = otro
  archivo). ``cambios`` solo puede tocar las perillas de ``PERILLAS_PERMITIDAS``; todo lo demás (expertos, fechas de ajuste, rutas de
  modelos, producto, cuenta, costos y TODAS las reglas de inversión: tamaño por posición, cupos, tamaño por volatilidad) se rechaza
  nombrando la clave: el backtest invierte siempre igual que la Terminal.

La mezcla reutiliza ``futures_qwen_live._apply_pending_changes`` (la de los traspasos de la Terminal); la validación de cupos, rebotes y
analista reutiliza ``futures_qwen_posiciones`` y ``futures_qwen_analista``. No lee ni escribe ninguna base.
"""

import copy
import hashlib
import json
import math
import os
import re

from . import futures_qwen_analista as analista
from . import futures_qwen_live as live
from . import futures_qwen_posiciones as posiciones
from . import futures_qwen_trader as qt

SNAPSHOT_SCHEMA = "balancita-terminal-activa.v1"
SNAPSHOT_PATH = os.path.join(qt.ROOT, "config", "terminal-activa.json")
ESTRATEGIAS_DIR = os.path.join(qt.ROOT, "config", "estrategias")
OVERLAY_KEYS = {"id", "nombre", "descripcion", "base_config_hash", "cambios"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# clave -> (tipo, mínimo, máximo). Evidencia de cada una: odd/tasks/estrategias-laboratorio.md §1.1.
PERILLAS_PERMITIDAS = {
    "guardrails.max_hold_min": ("int", 60, 10080),          # cierre obligatorio (36 h hoy)
    "guardrails.exhaust_hold_min": ("int", 60, 10080),      # cierre por agotamiento (24 h hoy)
    "guardrails.stop_sigma_24h": ("float?", 0, 10),         # stop por volatilidad (null = sin stop)
    "guardrails.min_stop_pct": ("float", 0, 1),
    "guardrails.max_stop_pct": ("float", 0, 1),
    "guardrails.cooldown_min": ("int", 0, 1440),
    "wake.flat_every_min": ("int5", 5, 1440),               # cada cuánto mira la fórmula sin posición
    "wake.position_every_min": ("int5", 5, 1440),           # ... y con posición
    "rebotes.caida_pct": ("float", 0, 100),
    "rebotes.ventana_min": ("int", 5, 1440),
    "rebotes.salida_min": ("int", 5, 2880),
    "rebotes.enfriamiento_min": ("int", 0, 2880),
}
# Reglas de inversión FIJAS (usuario, 2026-11-06: «El backtest debe invertir igual que la Terminal, esas reglas no cambian»): cuánto se
# invierte por posición (``posiciones.fraccion`` del saldo actual), cuántas a la vez (``posiciones.max``), la espera entre entradas, el
# tamaño por volatilidad (``analista.modo``), la cuenta, el nocional y el apalancamiento. Ninguna es perilla: el backtest dimensiona
# SIEMPRE como la Terminal activa (el snapshot) y una variante que las nombre se rechaza como cualquier clave no permitida.
REGLAS_DE_INVERSION_FIJAS = ("posiciones.max", "posiciones.fraccion", "posiciones.espera_entre_entradas_min", "analista.modo",
                             "cuenta", "notional_usd", "leverage")


class EstrategiaError(qt.TraderError):
    pass


def hash_config(cfg):
    """El hash de identidad del trader (``qt.config_hash``)."""
    return qt.config_hash(cfg)


def cargar_snapshot(ruta=None):
    """El snapshot de la Terminal activa (copia), verificado contra su hash; falla si el archivo o el hash no cuadran."""
    ruta = ruta or SNAPSHOT_PATH
    try:
        with open(ruta, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError) as error:
        raise EstrategiaError("Snapshot de la Terminal activa ilegible ({}): {}".format(ruta, error)) from error
    if not isinstance(doc, dict) or doc.get("schema") != SNAPSHOT_SCHEMA:
        raise EstrategiaError("Snapshot de la Terminal activa: esquema desconocido (se esperaba {}).".format(SNAPSHOT_SCHEMA))
    if not isinstance(doc.get("config"), dict) or not isinstance(doc.get("config_hash"), str):
        raise EstrategiaError("Snapshot de la Terminal activa: faltan config y config_hash.")
    try:
        got = hash_config(doc["config"])
    except (KeyError, TypeError, AttributeError) as error:
        raise EstrategiaError("Snapshot de la Terminal activa: la config no se puede hashear ({!r}).".format(error)) from error
    if got != doc["config_hash"]:
        raise EstrategiaError("Snapshot de la Terminal activa alterado: la config no coincide con su hash (declara {}, da {}).".format(
            doc["config_hash"], got))
    return copy.deepcopy(doc)


def _prohibida(clave, id):
    return EstrategiaError("Estrategia '{}': la clave '{}' no se puede cambiar; solo hay perillas permitidas: {}.".format(
        id, clave, ", ".join(sorted(PERILLAS_PERMITIDAS))))


def _hojas(valor, prefijo, id):
    """``{clave.con.puntos: valor}`` de ``cambios``; una clave que no es perilla (ni camino hacia una) se rechaza nombrándola."""
    out = {}
    for clave, hijo in valor.items():
        ruta = prefijo + clave
        if isinstance(hijo, dict) and any(p.startswith(ruta + ".") for p in PERILLAS_PERMITIDAS):
            out.update(_hojas(hijo, ruta + ".", id))
        elif ruta in PERILLAS_PERMITIDAS:
            out[ruta] = hijo
        elif isinstance(hijo, dict) and hijo:
            _hojas(hijo, ruta + ".", id)                 # nombra la hoja prohibida completa (p. ej. corta.maestro)
        else:
            raise _prohibida(ruta, id)
    return out


def _numero(valor):
    return not isinstance(valor, bool) and isinstance(valor, (int, float)) and math.isfinite(valor)


def _validar_valor(clave, valor, id):
    tipo, low, high = PERILLAS_PERMITIDAS[clave]
    malo = None
    if tipo in ("int", "int5"):
        if isinstance(valor, bool) or not isinstance(valor, int):
            malo = "tiene que ser un número entero"
        elif not low <= valor <= high:
            malo = "tiene que estar entre {} y {}".format(low, high)
        elif tipo == "int5" and valor % 5:
            malo = "tiene que ser múltiplo de 5 minutos"
    elif tipo in ("float", "float?"):
        if valor is None and tipo == "float?":
            return
        if not _numero(valor):
            malo = "tiene que ser un número" + (" o null" if tipo == "float?" else "")
        elif not low < valor <= high:
            malo = "tiene que ser mayor que {} y no más de {}".format(low, high)
    elif tipo == "enum" and valor not in analista.MODES:
        malo = "tiene que ser uno de: {}".format(", ".join(analista.MODES))
    if malo:
        raise EstrategiaError("Estrategia '{}': {} {} (valor: {!r}).".format(id, clave, malo, valor))


def _validar_config(cfg, id):
    """Las mismas validaciones que ya hace el trader para cupos, rebotes y analista, más las relaciones entre perillas."""
    guard = cfg["guardrails"]
    if guard["exhaust_hold_min"] > guard["max_hold_min"]:
        raise EstrategiaError("Estrategia '{}': guardrails.exhaust_hold_min ({}) no puede superar guardrails.max_hold_min ({}).".format(
            id, guard["exhaust_hold_min"], guard["max_hold_min"]))
    if guard["min_stop_pct"] > guard["max_stop_pct"]:
        raise EstrategiaError("Estrategia '{}': guardrails.min_stop_pct ({}) no puede superar guardrails.max_stop_pct ({}).".format(
            id, guard["min_stop_pct"], guard["max_stop_pct"]))
    try:
        posiciones.settings(cfg)
        posiciones.rebotes_of(cfg)
        analista.mode((cfg.get("analista") or {}).get("modo"), "analista.modo")
    except ValueError as error:
        raise EstrategiaError("Estrategia '{}': {}.".format(id, str(error).rstrip("."))) from error


def ruta_overlay(id, carpeta=None):
    """El archivo de la estrategia ``id`` (valida el id; no comprueba que exista)."""
    if not isinstance(id, str) or not ID_RE.match(id):
        raise EstrategiaError("Estrategia: id inválido {!r} (minúsculas, números y guiones).".format(id))
    return os.path.join(carpeta or ESTRATEGIAS_DIR, id + ".json")


def sha256_overlay(id, carpeta=None):
    """sha256 de los bytes del archivo del overlay: la huella que viaja con cada informe de backtest."""
    ruta = ruta_overlay(id, carpeta)
    try:
        with open(ruta, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError as error:
        raise EstrategiaError("Estrategia '{}': archivo ilegible ({}).".format(id, error)) from error


def cargar_estrategia(id, carpeta=None, snapshot=None):
    """La config COMPLETA de la estrategia ``id``: el snapshot con ``cambios`` aplicados. Su identidad es ``hash_config(config)``."""
    ruta = ruta_overlay(id, carpeta)
    try:
        with open(ruta, encoding="utf-8") as handle:
            overlay = json.load(handle)
    except FileNotFoundError:
        raise EstrategiaError("Estrategia '{}': no existe {}.".format(id, ruta)) from None
    except (OSError, ValueError) as error:
        raise EstrategiaError("Estrategia '{}': archivo ilegible ({}).".format(id, error)) from error
    return config_desde_overlay(overlay, id, snapshot)


def config_desde_overlay(overlay, id, snapshot=None):
    """La config COMPLETA de un overlay ya leído (o recién armado): valida todo lo que valida ``cargar_estrategia`` y devuelve el
    snapshot con ``cambios`` aplicados. No toca el disco (salvo leer el snapshot si no se pasa)."""
    if not isinstance(overlay, dict) or set(overlay) != OVERLAY_KEYS:
        raise EstrategiaError("Estrategia '{}': el archivo lleva exactamente {}.".format(id, ", ".join(sorted(OVERLAY_KEYS))))
    if overlay["id"] != id:
        raise EstrategiaError("Estrategia '{}': el id del archivo ({!r}) no coincide con su nombre.".format(id, overlay["id"]))
    for campo in ("nombre", "descripcion"):
        if not isinstance(overlay[campo], str) or not overlay[campo].strip():
            raise EstrategiaError("Estrategia '{}': {} tiene que ser un texto.".format(id, campo))
    base = snapshot or cargar_snapshot()
    if overlay["base_config_hash"] != base["config_hash"]:
        raise EstrategiaError("Estrategia '{}': base_config_hash ({}) no coincide con el hash del snapshot de la Terminal ({}).".format(
            id, overlay["base_config_hash"], base["config_hash"]))
    cambios = overlay["cambios"]
    if not isinstance(cambios, dict) or not cambios:
        raise EstrategiaError("Estrategia '{}': 'cambios' tiene que ser un objeto con al menos una perilla.".format(id))
    hojas = _hojas(cambios, "", id)
    for clave, valor in hojas.items():
        _validar_valor(clave, valor, id)
    target = copy.deepcopy(base["config"])
    for raiz in sorted({clave.split(".")[0] for clave in hojas}):
        merged = copy.deepcopy(target.get(raiz) or {})
        for clave, valor in hojas.items():
            if clave.split(".")[0] == raiz:
                merged[clave.split(".")[1]] = valor
        live._apply_pending_changes(target, {raiz: merged})     # la mezcla de los traspasos de la Terminal
    _validar_config(target, id)
    return target
