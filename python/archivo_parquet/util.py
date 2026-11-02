"""Utilidades puras (sin pyarrow): dias UTC, resumen de contenido, manifiesto y guardas de la copia."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
from typing import Iterable, List, Optional

from .config import DAY_MS, TablaConfig

UTC = dt.timezone.utc
M128 = (1 << 128) - 1


class ErrorArchivo(Exception):
    """Error de uso o de la copia: el programa sale con codigo 2 y no exporta nada."""


# ---------- dias ----------
def dia_de(ms: int) -> dt.date:
    return dt.datetime.fromtimestamp(ms // 1000, tz=UTC).date()


def inicio_dia_ms(dia: dt.date) -> int:
    return int(dt.datetime(dia.year, dia.month, dia.day, tzinfo=UTC).timestamp()) * 1000


def dia_cerrado(dia: dt.date, ahora_ms: int) -> bool:
    """Cerrado + 1 dia de margen: el dia termino hace al menos 24 h."""
    return inicio_dia_ms(dia) + 2 * DAY_MS <= ahora_ms


def ruta_relativa(base: str, tabla: str, dia: dt.date, nombre: str) -> str:
    return "%s/%s/anio=%04d/mes=%02d/dia=%02d/%s" % (base, tabla, dia.year, dia.month, dia.day, nombre)


def parse_tiempo(texto: str) -> int:
    """Milisegundos UTC: entero, o fecha/fecha-hora ISO (sin zona = UTC)."""
    texto = texto.strip()
    if texto.lstrip("-").isdigit():
        return int(texto)
    try:
        valor = dt.datetime.fromisoformat(texto)
    except ValueError as exc:
        raise ErrorArchivo("tiempo no valido: %r (use ms UTC o ISO 8601)" % texto) from exc
    if valor.tzinfo is None:
        valor = valor.replace(tzinfo=UTC)
    return int(valor.timestamp() * 1000)


# ---------- resumen de contenido ----------
def _hash_fila(cfg: TablaConfig, fila: tuple, idx_hash: Optional[int]) -> int:
    if idx_hash is not None:
        data = str(fila[idx_hash]).encode("utf-8")
    else:
        data = json.dumps(fila, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return int.from_bytes(hashlib.sha256(data).digest()[:16], "big")


class Resumen:
    """Acumula (en memoria acotada) lo que se compara entre la copia y el archivo: filas, claves, tiempos, producto y suma de control.

    La suma de control es la suma modulo 2^128 de un hash por fila: no depende del orden y cuenta los duplicados.
    Con columna de hash (verdict_hash...) se usa ese hash; sin ella, el hash canonico de la fila.
    """

    def __init__(self, cfg: TablaConfig):
        self.cfg = cfg
        nombres = cfg.nombres
        self.ik = [nombres.index(c) for c in cfg.clave]
        self.it = nombres.index(cfg.tiempo)
        self.ip = nombres.index(cfg.producto) if cfg.producto else None
        self.ih = nombres.index(cfg.hash) if cfg.hash else None
        self.filas = 0
        self.clave_min = self.clave_max = None
        self.tiempo_min = self.tiempo_max = None
        self.producto_min = self.producto_max = None
        self.suma = 0
        self.ordenado = True
        self._previa = None

    def agregar(self, filas: Iterable[tuple]) -> None:
        for f in filas:
            self.filas += 1
            k = tuple(f[i] for i in self.ik)
            if self._previa is not None and k < self._previa:
                self.ordenado = False
            self._previa = k
            if self.clave_min is None or k < self.clave_min:
                self.clave_min = k
            if self.clave_max is None or k > self.clave_max:
                self.clave_max = k
            t = f[self.it]
            if self.tiempo_min is None or t < self.tiempo_min:
                self.tiempo_min = t
            if self.tiempo_max is None or t > self.tiempo_max:
                self.tiempo_max = t
            if self.ip is not None:
                p = f[self.ip]
                if self.producto_min is None or p < self.producto_min:
                    self.producto_min = p
                if self.producto_max is None or p > self.producto_max:
                    self.producto_max = p
            self.suma = (self.suma + _hash_fila(self.cfg, f, self.ih)) & M128

    def como_dict(self) -> dict:
        return {
            "filas": self.filas,
            "clave_min": list(self.clave_min) if self.clave_min is not None else None,
            "clave_max": list(self.clave_max) if self.clave_max is not None else None,
            "tiempo_min": self.tiempo_min, "tiempo_max": self.tiempo_max,
            "producto_min": self.producto_min, "producto_max": self.producto_max,
            "checksum_contenido": "%032x" % self.suma,
        }


def diferencias(esperado: dict, obtenido: dict) -> List[str]:
    return ["%s: esperado %r, obtenido %r" % (k, esperado[k], obtenido.get(k)) for k in esperado if esperado[k] != obtenido.get(k)]


def sha256_archivo(ruta: str) -> str:
    h = hashlib.sha256()
    with open(ruta, "rb") as fh:
        for bloque in iter(lambda: fh.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


# ---------- manifiesto ----------
NOMBRE_MANIFIESTO = "manifiesto.jsonl"


def leer_manifiesto(destino: str) -> List[dict]:
    ruta = os.path.join(destino, NOMBRE_MANIFIESTO)
    if not os.path.exists(ruta):
        return []
    out = []
    with open(ruta, "r", encoding="utf-8") as fh:
        for n, linea in enumerate(fh, 1):
            if not linea.strip():
                continue
            try:
                out.append(json.loads(linea))
            except ValueError as exc:
                raise ErrorArchivo("manifiesto danado en la linea %d: %s" % (n, exc)) from exc
    return out


def agregar_al_manifiesto(destino: str, entrada: dict) -> None:
    """Una sola escritura con fsync: la linea es lo que CONFIRMA el archivo."""
    ruta = os.path.join(destino, NOMBRE_MANIFIESTO)
    datos = (json.dumps(entrada, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(ruta, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, datos)
        os.fsync(fd)
    finally:
        os.close(fd)


def seleccionar(entradas: List[dict], base: str, tabla: str, desde_ms: int, hasta_ms: int, producto: Optional[str] = None) -> List[dict]:
    """Catalogo: solo los archivos cuyo rango de tiempo (y de producto) puede contener lo pedido. Rango [desde, hasta)."""
    out = []
    for e in entradas:
        if e["base"] != base or e["tabla"] != tabla:
            continue
        if e["tiempo_max"] is None or e["tiempo_max"] < desde_ms or e["tiempo_min"] >= hasta_ms:
            continue
        if producto is not None and e.get("producto_min") is not None and not (e["producto_min"] <= producto <= e["producto_max"]):
            continue
        out.append(e)
    return sorted(out, key=lambda e: (e["dia"], e["ruta"]))


# ---------- guardas de la copia ----------
def validar_ruta_copia(ruta: str, copia_confirmada: bool) -> str:
    real = os.path.realpath(ruta)
    partes = real.split(os.sep)
    if "dev-live" in partes:
        raise ErrorArchivo("se rechaza %s: es la base viva (dev-live). Use una copia de snapshots/ o backups/." % ruta)
    if not copia_confirmada and "snapshots" not in partes and "backups" not in partes:
        raise ErrorArchivo("la ruta %s no esta en una carpeta snapshots/ o backups/; si es una copia, pase --copia-confirmada." % ruta)
    if not os.path.isfile(real):
        raise ErrorArchivo("no existe la copia %s" % ruta)
    return real


def abrir_copia(ruta: str, copia_confirmada: bool = False) -> sqlite3.Connection:
    """Abre SOLO LECTURA una copia (nunca la base viva) y exige quick_check ok."""
    real = validar_ruta_copia(ruta, copia_confirmada)
    uri = "file:%s?mode=ro&immutable=0" % real.replace("?", "%3f").replace("#", "%23")
    con = sqlite3.connect(uri, uri=True)
    try:
        resultado = [r[0] for r in con.execute("PRAGMA quick_check")]
    except sqlite3.DatabaseError as exc:
        con.close()
        raise ErrorArchivo("la copia no pasa quick_check: %s" % exc) from exc
    if resultado != ["ok"]:
        con.close()
        raise ErrorArchivo("la copia no pasa quick_check: %s" % "; ".join(map(str, resultado[:5])))
    return con
