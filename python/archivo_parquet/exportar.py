"""Exportador: dia UTC cerrado -> un Parquet verificado -> linea de manifiesto. Lee SOLO una copia; nunca escribe ni borra en SQLite."""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import time
from typing import Callable, Dict, List, Optional

from . import formato
from .config import DAY_MS, TABLAS, TablaConfig
from .util import (ErrorArchivo, Resumen, abrir_copia, agregar_al_manifiesto, dia_de, diferencias, leer_manifiesto, periodo_cerrado,
                   periodo_de, rango_periodo, ruta_relativa, sha256_archivo)

LOTE_ORIGEN = 50_000


def _consulta(cfg: TablaConfig) -> str:
    cols = ", ".join('"%s"' % c for c in cfg.nombres)
    orden = ", ".join('"%s"' % c for c in cfg.clave)
    return 'SELECT %s FROM "%s" WHERE "%s" >= ? AND "%s" < ? ORDER BY %s' % (cols, cfg.sqlite, cfg.tiempo, cfg.tiempo, orden)


def _lotes_origen(con: sqlite3.Connection, cfg: TablaConfig, d0: int, d1: int, resumen: Resumen):
    cur = con.execute(_consulta(cfg), (d0, d1))
    while True:
        lote = [tuple(f) for f in cur.fetchmany(LOTE_ORIGEN)]
        if not lote:
            return
        resumen.agregar(lote)
        yield lote


def _extremo_clave(con, cfg, d0, d1, desc: bool):
    cols = ", ".join('"%s"' % c for c in cfg.clave)
    orden = ", ".join('"%s" %s' % (c, "DESC" if desc else "ASC") for c in cfg.clave)
    f = con.execute('SELECT %s FROM "%s" WHERE "%s" >= ? AND "%s" < ? ORDER BY %s LIMIT 1' % (cols, cfg.sqlite, cfg.tiempo, cfg.tiempo, orden),
                    (d0, d1)).fetchone()
    return list(f) if f else None


def periodos_de_la_tabla(con: sqlite3.Connection, cfg: TablaConfig) -> List[dt.date]:
    """Primer dia de cada periodo (dia o mes, segun la granularidad de la tabla) que tiene filas, en orden."""
    filas = con.execute('SELECT DISTINCT "%s" / %d FROM "%s" ORDER BY 1' % (cfg.tiempo, DAY_MS, cfg.sqlite)).fetchall()
    return sorted({periodo_de(dia_de(int(n) * DAY_MS), cfg.granularidad) for (n,) in filas})


dias_de_la_tabla = periodos_de_la_tabla  # nombre de la fase 1


def _columnas_de(con, nombre: str) -> Optional[List[str]]:
    filas = con.execute('PRAGMA table_info("%s")' % nombre).fetchall()
    return [f[1] for f in filas] or None


def _exportar_dia(con, cfg: TablaConfig, base: str, destino: str, dia: dt.date) -> dict:
    d0, d1 = rango_periodo(dia, cfg.granularidad)
    carpeta = os.path.dirname(os.path.join(destino, ruta_relativa(base, cfg.nombre, dia, "x", cfg.granularidad)))
    os.makedirs(carpeta, exist_ok=True)
    tmp = os.path.join(carpeta, "part-%d.parquet.tmp" % os.getpid())
    try:
        esperado_filas = con.execute('SELECT COUNT(*) FROM "%s" WHERE "%s" >= ? AND "%s" < ?' % (cfg.sqlite, cfg.tiempo, cfg.tiempo),
                                     (d0, d1)).fetchone()[0]
        origen = Resumen(cfg)
        meta = {"schema_version": cfg.schema_version, "base": base, "tabla": cfg.nombre, "dia": dia.isoformat(), "granularidad": cfg.granularidad}
        formato.escribir(tmp, cfg, _lotes_origen(con, cfg, d0, d1, origen), meta)
        esperado = origen.como_dict()
        problemas = []
        if esperado_filas != origen.filas:
            problemas.append("COUNT(*) del rango %d, filas leidas %d (la copia cambio?)" % (esperado_filas, origen.filas))
        for clave, desc in (("clave_min", False), ("clave_max", True)):
            real = _extremo_clave(con, cfg, d0, d1, desc)
            if real != esperado[clave]:
                problemas.append("%s en la copia %r, leida %r" % (clave, real, esperado[clave]))
        # relectura completa del archivo, con checksum de paginas
        leido = Resumen(cfg)
        for lote in formato.leer_filas(tmp, cfg):
            leido.agregar(lote)
        if not leido.ordenado:
            problemas.append("el archivo no esta ordenado por clave")
        problemas += diferencias(esperado, leido.como_dict())
        info = formato.metadatos(tmp)
        if info["schema"].get("schema_version") != str(cfg.schema_version):
            problemas.append("schema_version ausente o distinto en el archivo")
        if problemas:
            raise ValueError("; ".join(problemas))
        sha = sha256_archivo(tmp)
        nombre = "part-%s.parquet" % sha[:8]
        final = os.path.join(carpeta, nombre)
        rel = ruta_relativa(base, cfg.nombre, dia, nombre, cfg.granularidad)
        # restos sin confirmar de intentos anteriores (no estan en el manifiesto): se descartan
        confirmadas = {e["ruta"] for e in leer_manifiesto(destino)}
        for f in os.listdir(carpeta):
            r = ruta_relativa(base, cfg.nombre, dia, f, cfg.granularidad)
            if f.endswith(".tmp") and os.path.join(carpeta, f) != tmp or (f.startswith("part-") and f.endswith(".parquet") and r not in confirmadas):
                os.remove(os.path.join(carpeta, f))
        os.replace(tmp, final)
        _fsync_dir(carpeta)
        entrada = {
            "base": base, "tabla": cfg.nombre, "dia": dia.isoformat(), "granularidad": cfg.granularidad, "ruta": rel, "filas": origen.filas, "grupos_filas": info["grupos"],
            "bytes": os.path.getsize(final), "sha256": sha, "schema_version": cfg.schema_version,
            "checksum_tipo": cfg.hash if cfg.hash else "hash_canonico_de_filas",
            "exportado_en": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        entrada.update(esperado)
        agregar_al_manifiesto(destino, entrada)
        return entrada
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _fsync_dir(carpeta: str) -> None:
    try:
        fd = os.open(carpeta, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:  # pragma: no cover - plataformas sin fsync de carpetas
        pass


def exportar(copia: str, base: str, destino: str, tablas: Optional[List[str]] = None, dry_run: bool = False,
             copia_confirmada: bool = False, ahora_ms: Optional[int] = None, log: Callable[[str], None] = lambda m: None,
             con: Optional[sqlite3.Connection] = None) -> dict:
    """Devuelve el reporte: exportados, ya_confirmados, no_confirmados, tablas_ausentes. ``no_confirmados`` no vacio => codigo 1."""
    if ahora_ms is None:
        ahora_ms = int(time.time() * 1000)
    pedidas = tablas or list(TABLAS)
    for t in pedidas:
        if t not in TABLAS:
            raise ErrorArchivo("tabla desconocida %r (soportadas: %s)" % (t, ", ".join(TABLAS)))
    # ``con``: conexion de solo lectura ya abierta y chequeada (la entrega ``nocturno`` para no repetir el quick_check); exportar la cierra.
    if con is None:
        con = abrir_copia(copia, copia_confirmada)
    reporte: Dict[str, list] = {"exportados": [], "ya_confirmados": [], "no_confirmados": [], "tablas_ausentes": [], "pendientes_por_abrir": [],
                                "dry_run": [] }
    try:
        if not dry_run:
            if formato.pq is None:
                raise formato.ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")
            os.makedirs(destino, exist_ok=True)
        hechos = {(e["base"], e["tabla"], e["dia"]) for e in leer_manifiesto(destino)} if os.path.isdir(destino) else set()
        for nombre in pedidas:
            cfg = TABLAS[nombre]
            columnas = _columnas_de(con, cfg.sqlite)
            if columnas is None:
                if tablas:
                    raise ErrorArchivo("la copia no tiene la tabla %s" % cfg.sqlite)
                reporte["tablas_ausentes"].append(nombre)
                continue
            faltan = [c for c in cfg.nombres if c not in columnas]
            if faltan:
                raise ErrorArchivo("a %s le faltan columnas %s (el esquema cambio: suba schema_version)" % (cfg.sqlite, faltan))
            for dia in periodos_de_la_tabla(con, cfg):
                clave = (base, nombre, dia.isoformat())
                if clave in hechos:
                    reporte["ya_confirmados"].append({"tabla": nombre, "dia": clave[2]})
                    continue
                if not periodo_cerrado(dia, cfg.granularidad, ahora_ms):
                    reporte["pendientes_por_abrir"].append({"tabla": nombre, "dia": clave[2]})
                    continue
                if dry_run:
                    d0, d1 = rango_periodo(dia, cfg.granularidad)
                    n = con.execute('SELECT COUNT(*) FROM "%s" WHERE "%s" >= ? AND "%s" < ?' % (cfg.sqlite, cfg.tiempo, cfg.tiempo),
                                    (d0, d1)).fetchone()[0]
                    reporte["dry_run"].append({"tabla": nombre, "dia": clave[2], "filas": n})
                    continue
                try:
                    e = _exportar_dia(con, cfg, base, destino, dia)
                except Exception as exc:  # noqa: BLE001 - cualquier fallo deja el dia sin confirmar
                    log("NO CONFIRMADO %s %s: %s" % (nombre, clave[2], exc))
                    reporte["no_confirmados"].append({"tabla": nombre, "dia": clave[2], "motivo": str(exc)})
                    continue
                log("confirmado %s %s: %d filas, %d bytes" % (nombre, clave[2], e["filas"], e["bytes"]))
                reporte["exportados"].append({"tabla": nombre, "dia": clave[2], "filas": e["filas"], "bytes": e["bytes"], "ruta": e["ruta"]})
    finally:
        con.close()
    return reporte
