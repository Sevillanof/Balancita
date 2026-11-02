"""Utilidades puras (sin pyarrow): dias UTC, resumen de contenido, manifiesto y guardas de la copia."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
import struct
from typing import Iterable, List, Optional, Tuple

from .config import DAY_MS, Derivada, TablaConfig

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


def periodo_de(dia: dt.date, granularidad: str) -> dt.date:
    """Primer dia del periodo que contiene ``dia``: el mismo dia (granularidad "dia") o el 1 del mes ("mes")."""
    return dia.replace(day=1) if granularidad == "mes" else dia


def rango_periodo(inicio: dt.date, granularidad: str) -> tuple:
    """(desde_ms, hasta_ms) del periodo que empieza en ``inicio``; hasta excluido."""
    d0 = inicio_dia_ms(inicio)
    if granularidad == "mes":
        sig = dt.date(inicio.year + (inicio.month == 12), inicio.month % 12 + 1, 1)
        return d0, inicio_dia_ms(sig)
    return d0, d0 + DAY_MS


def periodo_cerrado(inicio: dt.date, granularidad: str, ahora_ms: int, margen_ms: int = DAY_MS) -> bool:
    """Periodo terminado hace al menos ``margen_ms`` (por defecto 24 h: cerrado + 1 dia de margen). Para "dia" coincide con ``dia_cerrado``."""
    return rango_periodo(inicio, granularidad)[1] + margen_ms <= ahora_ms


def ruta_relativa(base: str, tabla: str, dia: dt.date, nombre: str, granularidad: str = "dia") -> str:
    if granularidad == "mes":
        return "%s/%s/anio=%04d/mes=%02d/%s" % (base, tabla, dia.year, dia.month, nombre)
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


# ---------- representacion canonica y hash por fila (formato 2) ----------
class ErrorTipo(ErrorArchivo):
    """Una celda de SQLite no tiene el tipo (typeof) que declara la configuracion: se informa fila y columna y el periodo no se confirma."""


def canonica(valor) -> bytes:
    """Bytes canonicos de un valor segun su typeof() de SQLite (== tipo de Python al leer): N nulo; I entero decimal; R los 8 bytes IEEE-754
    big-endian en hex (distingue 0.0, inf y cualquier bit; no usa repr); T/B longitud en bytes + ':' + bytes tal cual. '' (T0:) != NULL (N)."""
    if valor is None:
        return b"N"
    if isinstance(valor, bool):
        raise ErrorTipo("un booleano no es un valor de SQLite")
    if isinstance(valor, int):
        return b"I" + str(valor).encode("ascii")
    if isinstance(valor, float):
        return b"R" + struct.pack(">d", valor).hex().encode("ascii")
    if isinstance(valor, str):
        b = valor.encode("utf-8")  # un surrogate suelto no es UTF-8 valido: lanza y el periodo no se confirma
        return b"T%d:" % len(b) + b
    if isinstance(valor, (bytes, bytearray, memoryview)):
        b = bytes(valor)
        return b"B%d:" % len(b) + b
    raise ErrorTipo("tipo no soportado %s" % type(valor).__name__)


def hash_fila(fila: tuple) -> bytes:
    """SHA-256 (32 bytes) de las canonicas de TODAS las columnas separadas por 0x1f. Las longitudes de T/B hacen la lectura sin ambiguedad."""
    return hashlib.sha256(b"\x1f".join(canonica(v) for v in fila)).digest()


_TIPO_PY = {"int": int, "real": float, "text": str, "blob": (bytes, bytearray, memoryview)}
_NOMBRE_TIPO = {"int": "integer", "real": "real", "text": "text", "blob": "blob"}


def validar_tipos(cfg: TablaConfig, fila: tuple, n: int) -> None:
    """El tipo real de cada celda (typeof) debe ser el que declara la configuracion, salvo NULL y las columnas "mixto". Lanza con fila y columna."""
    for c, v in zip(cfg.columnas, fila):
        if v is None or c.tipo == "mixto":
            continue
        esperado = _TIPO_PY[c.tipo]
        if isinstance(v, bool) or not isinstance(v, esperado):
            clave = [fila[cfg.nombres.index(k)] for k in cfg.clave]
            raise ErrorTipo("fila %d (clave %r), columna %s: se esperaba %s y SQLite trae %s" % (
                n, clave, c.nombre, _NOMBRE_TIPO[c.tipo], type(v).__name__))


def _typeof(v) -> str:
    if v is None:
        return "null"
    return {int: "integer", float: "real", str: "text"}.get(type(v), "blob")


def a_archivo_mixto(v) -> Tuple[Optional[str], str]:
    """Valor de una columna "mixto" -> (texto, typeof). real con repr (ida y vuelta exacta), blob en hex."""
    t = _typeof(v)
    if t == "null":
        return None, t
    if t == "integer":
        return str(v), t
    if t == "real":
        return repr(v), t
    if t == "text":
        return v, t
    return bytes(v).hex(), t


def desde_mixto(texto: Optional[str], tipo: Optional[str]):
    if tipo == "null":
        return None
    if tipo is None or texto is None:
        raise ErrorTipo("columna mixta sin typeof o sin valor (archivo inconsistente)")
    if tipo == "integer":
        return int(texto)
    if tipo == "real":
        return float(texto)
    if tipo == "text":
        return texto
    if tipo == "blob":
        return bytes.fromhex(texto)
    raise ErrorTipo("typeof desconocido %r" % tipo)


def derivar(d: Derivada, texto):
    """Valor de una columna ``j_*`` a partir del JSON original; None si el JSON no es valido o la ruta no existe o no es del tipo esperado."""
    if not isinstance(texto, str):
        return None
    try:
        obj = json.loads(texto)
    except ValueError:
        return None
    for k in d.ruta:
        if not isinstance(obj, dict) or k not in obj:
            return None
        obj = obj[k]
    if d.op == "len":
        return len(obj) if isinstance(obj, list) else None
    if d.tipo == "int":
        return obj if isinstance(obj, int) and not isinstance(obj, bool) else None
    return obj if isinstance(obj, str) else None


def a_archivo(cfg: TablaConfig, fila: tuple) -> tuple:
    """Fila de SQLite -> fila del archivo: las columnas de SQLite (las "mixto" como texto), sus ``tipo_*`` y las derivadas ``j_*``."""
    vals = list(fila)
    tipos = []
    for i, c in enumerate(cfg.columnas):
        if c.tipo == "mixto":
            vals[i], t = a_archivo_mixto(fila[i])
            tipos.append(t)
    der = [derivar(d, fila[cfg.nombres.index(d.origen)]) for d in cfg.derivadas]
    return tuple(vals) + tuple(tipos) + tuple(der)


def desde_archivo(cfg: TablaConfig, fila: tuple, legado: bool = False) -> tuple:
    """Fila releida del archivo -> los valores originales de SQLite (para hashear igual que en el origen)."""
    n = len(cfg.columnas)
    if legado or not cfg.nombres_tipo:
        return tuple(fila[:n])
    vals = list(fila[:n])
    tipos = iter(fila[n:n + len(cfg.nombres_tipo)])
    for i, c in enumerate(cfg.columnas):
        if c.tipo == "mixto":
            vals[i] = desde_mixto(vals[i], next(tipos))
    return tuple(vals)


def derivadas_distintas(cfg: TablaConfig, fila_archivo: tuple, originales: tuple) -> List[str]:
    """Nombres de las columnas ``j_*`` del archivo que no coinciden con lo que sale del JSON releido de esa misma fila."""
    base = len(cfg.nombres) + len(cfg.nombres_tipo)
    return [d.nombre for k, d in enumerate(cfg.derivadas)
            if fila_archivo[base + k] != derivar(d, originales[cfg.nombres.index(d.origen)])]


# ---------- resumen de contenido ----------
def _hash_fila_v1(fila: tuple, idx_hash: Optional[int]) -> int:
    """Formato 1 (fases 1 y 2): con columna hash se hasheaba SOLO esa columna. Se conserva para revalidar archivos viejos."""
    if idx_hash is not None:
        data = str(fila[idx_hash]).encode("utf-8")
    else:
        data = json.dumps(fila, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return int.from_bytes(hashlib.sha256(data).digest()[:16], "big")


class Resumen:
    """Acumula (en memoria acotada) lo que se compara entre la copia y el archivo: filas, claves, tiempos, producto y control de contenido.

    Formato 2 (``legado=False``): hash por fila de TODAS las columnas (canonica por typeof, ver ``canonica``), la lista completa de hashes
    en orden (32 B por fila) para compararla posicion a posicion, y la suma modulo 2^128 (no depende del orden: se mantiene por compatibilidad).
    Formato 1 (``legado=True``): solo la suma; con columna hash se usaba solo esa columna (punto debil que el formato 2 corrige).
    """

    def __init__(self, cfg: TablaConfig, legado: bool = False):
        self.cfg = cfg
        self.legado = legado
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
        self.hashes = bytearray()
        # NULL en columnas que SQLite declara NOT NULL: no tira el dia (el archivo es nullable), se informa en el manifiesto
        self._no_nulas = [(i, c.nombre) for i, c in enumerate(cfg.columnas) if not c.nullable]
        self.nulos: dict = {}

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
            if self.legado:
                self.suma = (self.suma + _hash_fila_v1(f, self.ih)) & M128
            else:
                h = hash_fila(f)
                self.hashes += h
                self.suma = (self.suma + int.from_bytes(h[:16], "big")) & M128
                for i, nombre in self._no_nulas:
                    if f[i] is None:
                        self.nulos[nombre] = self.nulos.get(nombre, 0) + 1

    @property
    def hash_filas_sha256(self) -> str:
        return hashlib.sha256(bytes(self.hashes)).hexdigest()

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


def diferencias_hashes(esperado: bytes, obtenido: bytes) -> List[str]:
    """Compara las listas de hashes de fila POSICION A POSICION (la suma no ve filas cambiadas de lugar, duplicadas o intercambiadas)."""
    if esperado == obtenido:
        return []
    n_e, n_o = len(esperado) // 32, len(obtenido) // 32
    for i in range(min(n_e, n_o)):
        if esperado[i * 32:(i + 1) * 32] != obtenido[i * 32:(i + 1) * 32]:
            return ["la fila en la posicion %d (desde 0) difiere (hash de fila distinto en la copia y en el archivo); %d filas esperadas, %d leidas" % (i, n_e, n_o)]
    return ["la lista de hashes de fila tiene %d filas y se esperaban %d" % (n_o, n_e)]


def sha256_archivo(ruta: str) -> str:
    h = hashlib.sha256()
    with open(ruta, "rb") as fh:
        for bloque in iter(lambda: fh.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


# ---------- manifiesto ----------
NOMBRE_MANIFIESTO = "manifiesto.jsonl"
NOMBRE_REEMPLAZADAS = "manifiesto-reemplazadas.jsonl"


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


def reemplazar_en_manifiesto(destino: str, entrada: dict) -> List[dict]:
    """Reemplaza la linea del manifiesto de ese (base, tabla, dia) por ``entrada``, de forma atomica (archivo temporal + fsync + rename).

    La linea vieja se anota ANTES en ``manifiesto-reemplazadas.jsonl`` (auditoria). Devuelve las lineas quitadas. Se llama solo cuando el
    archivo nuevo ya esta verificado y en su sitio: si el proceso muere antes del rename, el manifiesto viejo sigue valido y el nuevo es un huerfano.
    """
    ruta = os.path.join(destino, NOMBRE_MANIFIESTO)
    viejas, quedan = [], []
    if os.path.exists(ruta):
        with open(ruta, "r", encoding="utf-8") as fh:
            for linea in fh:
                if not linea.strip():
                    continue
                e = json.loads(linea)
                (viejas if (e["base"], e["tabla"], e["dia"]) == (entrada["base"], entrada["tabla"], entrada["dia"]) else quedan).append(e)
    if viejas:
        dest_h = os.path.join(destino, NOMBRE_REEMPLAZADAS)
        fd = os.open(dest_h, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, "".join(json.dumps(v, sort_keys=True, ensure_ascii=False) + "\n" for v in viejas).encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
    quedan.append(entrada)
    tmp = ruta + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, "".join(json.dumps(e, sort_keys=True, ensure_ascii=False) + "\n" for e in quedan).encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, ruta)
    return viejas


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
