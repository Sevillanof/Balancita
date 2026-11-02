"""``medir``: (1) tamano SQLite vs Parquet por tabla y dia; (2) tiempos de busquedas tipicas con archivos/bytes leidos."""
from __future__ import annotations

import datetime as dt
import os
import statistics
import tempfile
import time
from typing import Dict, List, Optional

from . import sintetico
from .config import DAY_MS, TABLAS
from .exportar import exportar
from .leer import buscar_archivo
from .util import abrir_copia, dia_de, inicio_dia_ms, leer_manifiesto, rango_periodo


def _bytes_logicos(con, cfg, d0: int, d1: int) -> int:
    """Bytes de contenido de las filas del dia (texto = su largo en bytes, numeros = 8). No incluye indices ni paginas de SQLite."""
    partes = ["LENGTH(CAST(\"%s\" AS BLOB))" % c.nombre if c.tipo == "text" else "8" for c in cfg.columnas]
    sql = 'SELECT COALESCE(SUM(%s), 0) FROM "%s" WHERE "%s" >= ? AND "%s" < ?' % (" + ".join("COALESCE(%s,0)" % p for p in partes),
                                                                                  cfg.sqlite, cfg.tiempo, cfg.tiempo)
    return int(con.execute(sql, (d0, d1)).fetchone()[0])


def _bytes_dbstat(con, cfg) -> Optional[int]:
    try:
        r = con.execute("SELECT SUM(pgsize) FROM dbstat WHERE name IN (?)", (cfg.sqlite,)).fetchone()
        return int(r[0]) if r and r[0] is not None else None
    except Exception:  # noqa: BLE001 - dbstat puede no estar compilado
        return None


def tamanos(copia: str, destino: str, base: str, copia_confirmada: bool = False) -> dict:
    con = abrir_copia(copia, copia_confirmada)
    try:
        por_tabla: Dict[str, dict] = {}
        for e in leer_manifiesto(destino):
            if e["base"] != base:
                continue
            cfg = TABLAS[e["tabla"]]
            dia = dt.date.fromisoformat(e["dia"])
            d0, d1 = rango_periodo(dia, cfg.granularidad)
            logico = _bytes_logicos(con, cfg, d0, d1)
            t = por_tabla.setdefault(e["tabla"], {"dias": [], "sqlite_bytes_logicos": 0, "parquet_bytes": 0})
            t["dias"].append({"dia": e["dia"], "filas": e["filas"], "sqlite_bytes_logicos": logico, "parquet_bytes": e["bytes"],
                              "razon": round(logico / e["bytes"], 2) if e["bytes"] else None})
            t["sqlite_bytes_logicos"] += logico
            t["parquet_bytes"] += e["bytes"]
        for nombre, t in por_tabla.items():
            t["razon"] = round(t["sqlite_bytes_logicos"] / t["parquet_bytes"], 2) if t["parquet_bytes"] else None
            t["sqlite_bytes_tabla_dbstat"] = _bytes_dbstat(con, TABLAS[nombre])
        return {"archivo_sqlite_bytes": os.path.getsize(copia), "tablas": por_tabla,
                "nota": "sqlite_bytes_logicos = contenido de las filas del dia; no incluye indices ni espacio libre"}
    finally:
        con.close()


def _cronometrar(fn, repeticiones: int = 3) -> dict:
    tiempos = []
    informe = {}
    for _ in range(repeticiones):
        t0 = time.perf_counter()
        tabla, informe = fn()
        tiempos.append((time.perf_counter() - t0) * 1000)
    return {"ms_mediana": round(statistics.median(tiempos), 2), "ms_min": round(min(tiempos), 2), "filas": tabla.num_rows,
            "archivos_elegidos": informe["archivos_elegidos"], "archivos_en_catalogo": informe["archivos_en_catalogo"],
            "grupos_leidos": informe["grupos_leidos"], "grupos_total_en_elegidos": informe["grupos_total"],
            "bytes_leidos": informe["bytes_leidos"]}


def busquedas(destino: str, base: str, tabla: str, repeticiones: int = 3) -> dict:
    """Cuatro busquedas tipicas sobre lo ya exportado: un producto en 1 hora, un dia completo, una semana filtrando por columna, una clave."""
    cfg = TABLAS[tabla]
    entradas = [e for e in leer_manifiesto(destino) if e["base"] == base and e["tabla"] == tabla]
    if not entradas:
        return {"error": "no hay archivos confirmados de %s en el manifiesto" % tabla}
    ultimo = max(entradas, key=lambda e: e["dia"])
    producto = ultimo["producto_min"]
    t_ini = ultimo["tiempo_min"]
    d0 = inicio_dia_ms(dia_de(t_ini))
    semana_ini = max(min(e["tiempo_min"] for e in entradas), d0 - 6 * DAY_MS)
    semana_ini = inicio_dia_ms(dia_de(semana_ini))
    # una fila real para sacar un valor de filtro y una clave que existan
    fila, _ = buscar_archivo(destino, base, tabla, d0, d0 + DAY_MS, producto=producto, limite=1)
    fila = fila.to_pylist()[0]
    out: Dict[str, dict] = {}
    hora = d0 + 12 * 3_600_000
    out["producto_1_hora"] = _cronometrar(lambda: buscar_archivo(destino, base, tabla, hora, hora + 3_600_000, producto=producto), repeticiones)
    out["dia_completo"] = _cronometrar(lambda: buscar_archivo(destino, base, tabla, d0, d0 + DAY_MS), repeticiones)
    if cfg.filtro_tipico:
        donde = {cfg.filtro_tipico: fila[cfg.filtro_tipico]}
        r = _cronometrar(lambda: buscar_archivo(destino, base, tabla, semana_ini, d0 + DAY_MS, donde=donde), repeticiones)
        r["filtro"] = {cfg.filtro_tipico: fila[cfg.filtro_tipico]}
        out["semana_filtrando_columna"] = r
    t_fila = fila[cfg.tiempo]
    out["una_fila_por_clave"] = _cronometrar(lambda: buscar_archivo(destino, base, tabla, t_fila, t_fila + 1, producto=producto, limite=1),
                                             repeticiones)
    out["producto_usado"] = producto
    return out


def medir(destino: str, base: str, copia: Optional[str] = None, copia_confirmada: bool = False, tablas: Optional[List[str]] = None,
          sintetico_dias: Optional[int] = None, productos: int = 4, paso_s: int = 60, repeticiones: int = 3) -> dict:
    """Con ``sintetico_dias`` crea una copia y un archivo sinteticos en una carpeta temporal (``destino`` se ignora) y los mide."""
    tablas = tablas or ["verdicts"]
    if sintetico_dias:
        with tempfile.TemporaryDirectory(prefix="archivo-sintetico-") as tmp:
            snap = os.path.join(tmp, "snapshots")
            os.makedirs(snap)
            copia = os.path.join(snap, "sintetico.sqlite")
            dia0 = inicio_dia_ms(dia_de(1_700_000_000_000))
            prods = ["PF_SYN%02d" % i for i in range(productos)]
            filas = sintetico.crear_copia(copia, dia0, sintetico_dias, prods, paso_s * 1000, tablas)
            dest = os.path.join(tmp, "archivo")
            t0 = time.perf_counter()
            rep = exportar(copia, base, dest, tablas, ahora_ms=dia0 + (sintetico_dias + 3) * DAY_MS)
            segs = round(time.perf_counter() - t0, 2)
            res = _medir_en(dest, base, copia, tablas, repeticiones)
            res["sintetico"] = {"dias": sintetico_dias, "productos": productos, "paso_s": paso_s, "filas": filas, "segundos_exportar": segs,
                                "no_confirmados": rep["no_confirmados"]}
            return res
    if not copia:
        raise ValueError("medir necesita --copia (y --destino) o --sintetico-dias")
    return _medir_en(destino, base, copia, tablas, repeticiones, copia_confirmada)


def _medir_en(destino, base, copia, tablas, repeticiones, copia_confirmada=True) -> dict:
    res = {"tamanos": tamanos(copia, destino, base, copia_confirmada), "busquedas": {}}
    for t in tablas:
        res["busquedas"][t] = busquedas(destino, base, t, repeticiones)
    return res
