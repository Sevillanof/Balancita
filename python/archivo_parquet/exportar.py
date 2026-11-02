"""Exportador: dia UTC cerrado -> un Parquet verificado -> linea de manifiesto. Lee SOLO una copia; nunca escribe ni borra en SQLite."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
import time
from typing import Callable, Dict, List, Optional

from . import formato
from .config import DAY_MS, FORMATO_VERSION, TABLAS, TablaConfig
from .util import (ErrorArchivo, Resumen, a_archivo, abrir_copia, agregar_al_manifiesto, desde_archivo, derivadas_distintas, dia_de, diferencias,
                   diferencias_hashes, leer_manifiesto, periodo_cerrado, periodo_de, rango_periodo, reemplazar_en_manifiesto, ruta_relativa,
                   sha256_archivo, validar_tipos)


def _donde(cfg: TablaConfig) -> str:
    """Condicion SQL del periodo: rango de tiempo y, si la configuracion lo pide, su filtro fijo (premium_1m)."""
    f = ' AND (%s)' % cfg.filtro_sql if cfg.filtro_sql else ""
    return '"%s" >= ? AND "%s" < ?%s' % (cfg.tiempo, cfg.tiempo, f)


def _consulta(cfg: TablaConfig) -> str:
    cols = ", ".join('"%s"' % c for c in cfg.nombres)
    orden = ", ".join('"%s"' % c for c in cfg.clave)
    return 'SELECT %s FROM "%s" WHERE %s ORDER BY %s' % (cols, cfg.sqlite, _donde(cfg), orden)


def _lotes_origen(con: sqlite3.Connection, cfg: TablaConfig, d0: int, d1: int, resumen: Resumen):
    """Lotes de filas de la copia ya convertidas a filas del archivo. El resumen (hash por fila de TODAS las columnas) se toma de lo leido."""
    cur = con.execute(_consulta(cfg), (d0, d1))
    n = 0
    while True:
        lote = [tuple(f) for f in cur.fetchmany(formato.lote_de(cfg))]
        if not lote:
            return
        for f in lote:
            n += 1
            validar_tipos(cfg, f, n)
        resumen.agregar(lote)
        yield [a_archivo(cfg, f) for f in lote]


def _extremo_clave(con, cfg, d0, d1, desc: bool):
    cols = ", ".join('"%s"' % c for c in cfg.clave)
    orden = ", ".join('"%s" %s' % (c, "DESC" if desc else "ASC") for c in cfg.clave)
    f = con.execute('SELECT %s FROM "%s" WHERE %s ORDER BY %s LIMIT 1' % (cols, cfg.sqlite, _donde(cfg), orden), (d0, d1)).fetchone()
    return list(f) if f else None


def _contar(con, cfg: TablaConfig, d0: int, d1: int) -> int:
    return con.execute('SELECT COUNT(*) FROM "%s" WHERE %s' % (cfg.sqlite, _donde(cfg)), (d0, d1)).fetchone()[0]


def periodos_de_la_tabla(con: sqlite3.Connection, cfg: TablaConfig) -> List[dt.date]:
    """Primer dia de cada periodo (dia o mes, segun la granularidad de la tabla) que tiene filas, en orden."""
    f = ' WHERE %s' % cfg.filtro_sql if cfg.filtro_sql else ""
    filas = con.execute('SELECT DISTINCT "%s" / %d FROM "%s"%s ORDER BY 1' % (cfg.tiempo, DAY_MS, cfg.sqlite, f)).fetchall()
    return sorted({periodo_de(dia_de(int(n) * DAY_MS), cfg.granularidad) for (n,) in filas})


dias_de_la_tabla = periodos_de_la_tabla  # nombre de la fase 1


def _columnas_de(con, nombre: str) -> Optional[List[str]]:
    filas = con.execute('PRAGMA table_info("%s")' % nombre).fetchall()
    return [f[1] for f in filas] or None


def _ddl_de(con, nombre: str) -> str:
    f = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (nombre,)).fetchone()
    return f[0] if f and f[0] else ""


class Omitido(Exception):
    """El periodo NO se exporta y no es un fallo (se informa aparte): su inicio ya lo recorto la retencion, la copia es anterior a su fin, o el reemplazo perderia filas."""

    def __init__(self, clave: str, motivo: str):
        super().__init__(motivo)
        self.clave = clave


def _hashes_ruta(final: str) -> str:
    return final[:-len(".parquet")] + ".hashes"


def _exportar_dia(con, cfg: TablaConfig, base: str, destino: str, dia: dt.date, copia: Optional[str] = None,
                  reemplaza: Optional[dict] = None) -> dict:
    """Exporta un periodo: escribe, relee y compara fila a fila; solo entonces promueve el archivo y confirma la linea del manifiesto.

    ``reemplaza``: la linea vieja (formato anterior) de ese mismo periodo; el archivo nuevo la sustituye de forma atomica solo si no pierde filas.
    """
    d0, d1 = rango_periodo(dia, cfg.granularidad)
    carpeta = os.path.dirname(os.path.join(destino, ruta_relativa(base, cfg.nombre, dia, "x", cfg.granularidad)))
    os.makedirs(carpeta, exist_ok=True)
    tmp = os.path.join(carpeta, "part-%d.parquet.tmp" % os.getpid())
    try:
        esperado_filas = _contar(con, cfg, d0, d1)
        if reemplaza is not None and esperado_filas < reemplaza["filas"]:
            raise Omitido("reemplazo", "la copia tiene %d filas del periodo y el archivo viejo %d: no se reemplaza (se perderian filas)" % (
                esperado_filas, reemplaza["filas"]))
        if cfg.exigir_inicio_completo and esperado_filas:
            primero = con.execute('SELECT MIN("%s") FROM "%s" WHERE %s' % (cfg.tiempo, cfg.sqlite, _donde(cfg)), (d0, d1)).fetchone()[0]
            if primero is not None and primero > d0 + cfg.tolerancia_inicio_ms:
                raise Omitido("retencion", "la copia ya no tiene el inicio del periodo (primera fila %d ms despues del inicio): la retencion de la "
                              "captura lo recorto; archivarlo lo certificaria como dia completo" % (primero - d0))
            ultimo = con.execute('SELECT MAX("%s") FROM "%s"' % (cfg.tiempo, cfg.sqlite)).fetchone()[0]
            if ultimo is None or ultimo < d1 - cfg.tolerancia_fin_ms:
                raise Omitido("copia_anterior", "la copia no llega al fin del periodo (su fila mas nueva esta a %d ms del fin): se tomo antes de que "
                              "terminara; se exporta con una copia mas nueva" % (d1 - (ultimo or 0)))
        ddl = _ddl_de(con, cfg.sqlite)
        origen = Resumen(cfg)
        meta = {"schema_version": cfg.schema_version, "formato_version": FORMATO_VERSION, "base": base, "tabla": cfg.nombre, "dia": dia.isoformat(),
                "granularidad": cfg.granularidad, "sqlite_ddl": ddl, "ddl_sha256": hashlib.sha256(ddl.encode("utf-8")).hexdigest(),
                "clave": json.dumps(list(cfg.clave)), "grupo_por": json.dumps(list(cfg.grupo_por)),
                "columnas_sqlite": json.dumps(list(cfg.nombres)),
                "derivadas": json.dumps([[d.nombre, d.origen, list(d.ruta), d.tipo, d.op] for d in cfg.derivadas])}
        formato.escribir(tmp, cfg, _lotes_origen(con, cfg, d0, d1, origen), meta)
        esperado = origen.como_dict()
        problemas = []
        if esperado_filas != origen.filas:
            problemas.append("COUNT(*) del rango %d, filas leidas %d (la copia cambio?)" % (esperado_filas, origen.filas))
        for clave, desc in (("clave_min", False), ("clave_max", True)):
            real = _extremo_clave(con, cfg, d0, d1, desc)
            if real != esperado[clave]:
                problemas.append("%s en la copia %r, leida %r" % (clave, real, esperado[clave]))
        # relectura completa del archivo (checksum de paginas): hash de cada fila releida, comparado posicion a posicion con el de la copia
        leido = Resumen(cfg)
        malas: List[str] = []
        for lote in formato.leer_filas(tmp, cfg):
            originales = [desde_archivo(cfg, f) for f in lote]
            for f, o in zip(lote, originales):
                if len(malas) < 5:
                    malas += ["%s en la fila con clave %r" % (n, [o[cfg.nombres.index(c)] for c in cfg.clave]) for n in derivadas_distintas(cfg, f, o)]
            leido.agregar(originales)
        if malas:
            problemas.append("columnas derivadas que no coinciden con su JSON: " + "; ".join(malas[:5]))
        if not leido.ordenado:
            problemas.append("el archivo no esta ordenado por clave")
        problemas += diferencias(esperado, leido.como_dict())
        problemas += diferencias_hashes(bytes(origen.hashes), bytes(leido.hashes))
        info = formato.metadatos(tmp)
        sch = info["schema"]
        for k, v in (("schema_version", cfg.schema_version), ("formato_version", FORMATO_VERSION), ("sqlite_ddl", ddl), ("clave", json.dumps(list(cfg.clave)))):
            if sch.get(k) != str(v):
                problemas.append("%s ausente o distinto en los metadatos del archivo" % k)
        if info["filas"] != origen.filas:
            problemas.append("el pie del archivo dice %d filas y se escribieron %d" % (info["filas"], origen.filas))
        if not info["indice_paginas"] and origen.filas:
            problemas.append("el archivo no tiene indice de paginas")
        if reemplaza is not None and (esperado["clave_min"] > reemplaza["clave_min"] or esperado["clave_max"] < reemplaza["clave_max"]):
            raise Omitido("reemplazo", "el rango de claves de la copia no cubre el del archivo viejo: no se reemplaza (se perderian filas)")
        if problemas:
            raise ValueError("; ".join(problemas))
        sha = sha256_archivo(tmp)
        nombre = "part-%s.parquet" % sha[:8]
        final = os.path.join(carpeta, nombre)
        rel = ruta_relativa(base, cfg.nombre, dia, nombre, cfg.granularidad)
        # restos sin confirmar de intentos anteriores (no estan en el manifiesto): se descartan
        confirmadas = {e["ruta"] for e in leer_manifiesto(destino)} | {e["ruta_hashes"] for e in leer_manifiesto(destino) if e.get("ruta_hashes")}
        for f in os.listdir(carpeta):
            r = ruta_relativa(base, cfg.nombre, dia, f, cfg.granularidad)
            if f.endswith(".tmp") and os.path.join(carpeta, f) != tmp or (f.startswith("part-") and f.endswith((".parquet", ".hashes")) and r not in confirmadas):
                os.remove(os.path.join(carpeta, f))
        os.replace(tmp, final)
        # lista de hashes de fila (32 B por fila): sirve para repetir la comparacion contra la base viva justo antes de borrar
        ruta_h = _hashes_ruta(final)
        with open(ruta_h + ".tmp", "wb") as fh:
            fh.write(bytes(origen.hashes))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(ruta_h + ".tmp", ruta_h)
        _fsync_dir(carpeta)
        entrada = {
            "base": base, "tabla": cfg.nombre, "dia": dia.isoformat(), "granularidad": cfg.granularidad, "ruta": rel, "filas": origen.filas, "grupos_filas": info["grupos"],
            "bytes": os.path.getsize(final), "sha256": sha, "schema_version": cfg.schema_version,
            "checksum_tipo": "hash_fila_canonico_v2_todas_las_columnas",
            "exportado_en": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            # Se escriben SOLO despues de pasar la comparacion completa de arriba (la puerta de borrado de TypeScript los exige)
            "formato_version": FORMATO_VERSION, "verificacion_ida_vuelta": True,
            "hash_filas_sha256": origen.hash_filas_sha256, "ruta_hashes": os.path.relpath(ruta_h, destino).replace(os.sep, "/"),
            "ddl_sha256": meta["ddl_sha256"], "derivadas": [d.nombre for d in cfg.derivadas],
        }
        if origen.nulos:
            entrada["avisos"] = {"nulos_en_columnas_not_null": origen.nulos}
        if copia and os.path.exists(copia):
            entrada["tiempo_copia"] = dt.datetime.fromtimestamp(os.path.getmtime(copia), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entrada.update(esperado)
        if reemplaza is not None:
            entrada["reemplaza"] = reemplaza["ruta"]
            reemplazar_en_manifiesto(destino, entrada)
            # la linea vieja ya no esta en el manifiesto: su archivo es un huerfano y se descarta
            for viejo in (reemplaza["ruta"], reemplaza.get("ruta_hashes")):
                if viejo and os.path.join(destino, viejo) != final and os.path.exists(os.path.join(destino, viejo)):
                    os.remove(os.path.join(destino, viejo))
        else:
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
    """Devuelve el reporte: exportados, reemplazados (formato viejo -> nuevo), ya_confirmados, no_confirmados, omitidos_por_retencion, tablas_ausentes.
    ``no_confirmados`` no vacio => codigo 1; los omitidos (retencion, reemplazo que perderia filas) se informan pero no son fallo."""
    if ahora_ms is None:
        ahora_ms = int(time.time() * 1000)
    pedidas = tablas or list(TABLAS)
    for t in pedidas:
        if t not in TABLAS:
            raise ErrorArchivo("tabla desconocida %r (soportadas: %s)" % (t, ", ".join(TABLAS)))
    # ``con``: conexion de solo lectura ya abierta y chequeada (la entrega ``nocturno`` para no repetir el quick_check); exportar la cierra.
    if con is None:
        con = abrir_copia(copia, copia_confirmada)
    reporte: Dict[str, list] = {"exportados": [], "reemplazados": [], "ya_confirmados": [], "no_confirmados": [], "tablas_ausentes": [],
                                "pendientes_por_abrir": [], "omitidos_por_retencion": [], "reemplazos_omitidos": [], "dry_run": []}
    try:
        if not dry_run:
            if formato.pq is None:
                raise formato.ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")
            os.makedirs(destino, exist_ok=True)
        # (base, tabla, dia) -> linea del manifiesto. Una linea del formato viejo (sin formato_version) NO esta "hecha": se reexporta y reemplaza.
        hechos = {(e["base"], e["tabla"], e["dia"]): e for e in leer_manifiesto(destino)} if os.path.isdir(destino) else {}
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
            extra = [c for c in columnas if c not in cfg.nombres]
            if extra:  # columnas nuevas en SQLite: no se archivan hasta sumarlas a la configuracion (subir schema_version), pero tampoco se falla
                log("AVISO %s: columnas de SQLite fuera de la configuracion (no se archivan): %s" % (nombre, ", ".join(extra)))
                reporte.setdefault("avisos", []).append({"tabla": nombre, "columnas_sin_configurar": extra})
            for dia in periodos_de_la_tabla(con, cfg):
                clave = (base, nombre, dia.isoformat())
                previa = hechos.get(clave)
                if previa is not None and (previa.get("formato_version") or 0) >= FORMATO_VERSION:
                    reporte["ya_confirmados"].append({"tabla": nombre, "dia": clave[2]})
                    continue
                if not periodo_cerrado(dia, cfg.granularidad, ahora_ms, cfg.margen_cierre_ms):
                    reporte["pendientes_por_abrir"].append({"tabla": nombre, "dia": clave[2]})
                    continue
                if dry_run:
                    d0, d1 = rango_periodo(dia, cfg.granularidad)
                    reporte["dry_run"].append({"tabla": nombre, "dia": clave[2], "filas": _contar(con, cfg, d0, d1), "reemplaza_formato_viejo": previa is not None})
                    continue
                try:
                    e = _exportar_dia(con, cfg, base, destino, dia, copia, reemplaza=previa)
                except Omitido as om:
                    log("OMITIDO %s %s: %s" % (nombre, clave[2], om))
                    destino_om = {"retencion": "omitidos_por_retencion", "copia_anterior": "pendientes_por_abrir"}.get(om.clave, "reemplazos_omitidos")
                    reporte[destino_om].append({"tabla": nombre, "dia": clave[2], "motivo": str(om)})
                    continue
                except Exception as exc:  # noqa: BLE001 - cualquier fallo deja el dia sin confirmar
                    log("NO CONFIRMADO %s %s: %s" % (nombre, clave[2], exc))
                    reporte["no_confirmados"].append({"tabla": nombre, "dia": clave[2], "motivo": str(exc)})
                    continue
                log("confirmado %s %s: %d filas, %d bytes" % (nombre, clave[2], e["filas"], e["bytes"]))
                item = {"tabla": nombre, "dia": clave[2], "filas": e["filas"], "bytes": e["bytes"], "ruta": e["ruta"]}
                reporte["reemplazados" if previa is not None else "exportados"].append(item)
    finally:
        con.close()
    return reporte
