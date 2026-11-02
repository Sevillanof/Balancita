"""Lector y busqueda: primero el catalogo (manifiesto) elige los archivos; luego las estadisticas de grupo saltan bloques."""
from __future__ import annotations

import datetime as dt
import os
from typing import Optional, Sequence

from . import formato
from .config import TABLAS
from .util import ErrorArchivo, dia_de, leer_manifiesto, seleccionar


def _valor(cfg, columna: str, texto):
    tipo = cfg.tipo_de(columna)
    if tipo == "int":
        return int(texto)
    if tipo == "real":
        return float(texto)
    return str(texto)


def buscar_archivo(destino: str, base: str, tabla: str, desde_ms: int, hasta_ms: int, producto: Optional[str] = None,
                   donde: Optional[dict] = None, columnas: Optional[Sequence[str]] = None, limite: Optional[int] = None):
    """Rango de tiempo [desde_ms, hasta_ms). Devuelve (tabla pyarrow, informe con archivos elegidos/leidos y bytes)."""
    if tabla not in TABLAS:
        raise ErrorArchivo("tabla desconocida %r" % tabla)
    cfg = TABLAS[tabla]
    try:
        donde = {c: _valor(cfg, c, v) for c, v in (donde or {}).items()}
    except KeyError as exc:
        raise ErrorArchivo("columna desconocida: %s" % exc) from exc
    entradas = leer_manifiesto(destino)
    en_tabla = [e for e in entradas if e["base"] == base and e["tabla"] == tabla]
    elegidas = seleccionar(entradas, base, tabla, desde_ms, hasta_ms, producto)
    rutas = [os.path.join(destino, e["ruta"]) for e in elegidas]
    tabla_pa, informe = formato.buscar(rutas, cfg, desde_ms, hasta_ms, producto, donde, columnas, limite)
    informe["archivos_en_catalogo"] = len(en_tabla)
    informe["archivos_elegidos"] = len(elegidas)
    informe["bytes_archivos_elegidos"] = sum(e["bytes"] for e in elegidas)
    return tabla_pa, informe


def leer_archivo(destino: str, base: str, tabla: str, desde_ms: int, hasta_ms: int, columnas: Optional[Sequence[str]] = None):
    """Filas con tiempo en [desde_ms, hasta_ms) como tabla pyarrow. Solo toca los archivos confirmados en el manifiesto."""
    return buscar_archivo(destino, base, tabla, desde_ms, hasta_ms, columnas=columnas)[0]


def _sql(valor) -> str:
    return "'%s'" % str(valor).replace("'", "''") if isinstance(valor, str) else repr(valor)


def _desde_particion(campo_a: str, d: dt.date, signo: str) -> str:
    # comparacion lexicografica (anio, mes, dia) con comparaciones simples, que DuckDB sabe usar para saltar carpetas
    estricto = ">" if signo == ">=" else "<"
    return ("(anio %s %d OR (anio = %d AND (mes %s %d OR (mes = %d AND dia %s %d))))"
            % (estricto, d.year, d.year, estricto, d.month, d.month, signo, d.day))


def consulta_duckdb(destino: str, base: str, tabla: str, desde_ms: int, hasta_ms: int, columnas: Optional[Sequence[str]] = None,
                    producto: Optional[str] = None, donde: Optional[dict] = None) -> str:
    """Texto de la consulta DuckDB equivalente a ``buscar_archivo`` (no necesita duckdb instalado; no se ejecuta aqui)."""
    cfg = TABLAS[tabla]
    d_ini, d_fin = dia_de(desde_ms), dia_de(max(desde_ms, hasta_ms - 1))
    ruta = "%s/%s/%s/anio=*/mes=*/dia=*/part-*.parquet" % (destino.rstrip("/"), base, tabla)
    cols = ", ".join(columnas) if columnas else "*"
    if cfg.granularidad == "mes":  # sin carpeta dia=: se filtra por (anio, mes)
        ruta = "%s/%s/%s/anio=*/mes=*/part-*.parquet" % (destino.rstrip("/"), base, tabla)
        cond = ["(anio > %d OR (anio = %d AND mes >= %d))" % (d_ini.year, d_ini.year, d_ini.month),
                "(anio < %d OR (anio = %d AND mes <= %d))" % (d_fin.year, d_fin.year, d_fin.month)]
    else:
        cond = [_desde_particion("", d_ini, ">="), _desde_particion("", d_fin, "<=")]
    cond += [
            "%s >= %d" % (cfg.tiempo, desde_ms), "%s < %d" % (cfg.tiempo, hasta_ms)]
    if producto is not None and cfg.producto:
        cond.append("%s = %s" % (cfg.producto, _sql(producto)))
    for c, v in (donde or {}).items():
        cond.append("%s = %s" % (c, _sql(v)))
    return "SELECT %s\nFROM read_parquet(%s, hive_partitioning = true)\nWHERE %s\nORDER BY %s;" % (
        cols, _sql(ruta), "\n  AND ".join(cond), ", ".join(cfg.clave))
