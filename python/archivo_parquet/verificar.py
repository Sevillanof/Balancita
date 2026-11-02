"""Revalida el manifiesto contra los archivos: existencia, sha256, relectura con checksum de paginas, filas, claves y control de contenido.

Lineas del formato 2: hash de cada fila (todas las columnas) releido y comparado con la lista guardada en ``.hashes`` y con ``hash_filas_sha256``
del manifiesto, columnas ``j_*`` contra su JSON, metadatos. Lineas del formato 1 (sin ``formato_version``): como antes (suma de control) y se
listan en ``formato_viejo``: la puerta de borrado no las acepta hasta que se reexporten.
"""
from __future__ import annotations

import os
from typing import List, Optional

from . import formato
from .config import TABLAS
from .util import Resumen, derivadas_distintas, desde_archivo, diferencias, diferencias_hashes, leer_manifiesto, sha256_archivo


def _revisar(e: dict, ruta: str, cfg, destino: str) -> List[str]:
    nuevo = bool(e.get("formato_version"))
    fallas: List[str] = []
    if sha256_archivo(ruta) != e["sha256"]:
        fallas.append("sha256 distinto")
    r = Resumen(cfg, legado=not nuevo)
    malas: List[str] = []
    for lote in formato.leer_filas(ruta, cfg, legado=not nuevo):
        originales = [desde_archivo(cfg, f, legado=not nuevo) for f in lote]
        if nuevo:
            for f, o in zip(lote, originales):
                if len(malas) < 3:
                    malas += ["%s (clave %r)" % (n, [o[cfg.nombres.index(c)] for c in cfg.clave]) for n in derivadas_distintas(cfg, f, o)]
        r.agregar(originales)
    if malas:
        fallas.append("columnas derivadas que no coinciden con su JSON: " + "; ".join(malas))
    if not r.ordenado:
        fallas.append("no esta ordenado por clave")
    esperado = {k: e[k] for k in ("filas", "clave_min", "clave_max", "tiempo_min", "tiempo_max", "producto_min", "producto_max", "checksum_contenido")}
    fallas += diferencias(esperado, r.como_dict())
    if nuevo:
        if r.hash_filas_sha256 != e.get("hash_filas_sha256"):
            fallas.append("hash_filas_sha256 distinto del manifiesto")
        lateral = os.path.join(destino, e["ruta_hashes"]) if e.get("ruta_hashes") else None
        if lateral and os.path.isfile(lateral):  # lo borrable: si falta, vale el hash del manifiesto
            with open(lateral, "rb") as fh:
                fallas += diferencias_hashes(fh.read(), bytes(r.hashes))
        sch = formato.metadatos(ruta)["schema"]
        if sch.get("formato_version") != str(e["formato_version"]) or sch.get("ddl_sha256") != e.get("ddl_sha256"):
            fallas.append("metadatos (formato_version / ddl_sha256) distintos del manifiesto")
    return fallas


def verificar(destino: str, base: Optional[str] = None, tabla: Optional[str] = None) -> dict:
    entradas = [e for e in leer_manifiesto(destino) if (base is None or e["base"] == base) and (tabla is None or e["tabla"] == tabla)]
    problemas: List[dict] = []
    viejos: List[str] = []
    vistos = set()
    for e in entradas:
        id_ = (e["base"], e["tabla"], e["dia"])
        if id_ in vistos:
            problemas.append({"ruta": e["ruta"], "problema": "dia repetido en el manifiesto"})
        vistos.add(id_)
        ruta = os.path.join(destino, e["ruta"])
        if e["tabla"] not in TABLAS:
            problemas.append({"ruta": e["ruta"], "problema": "tabla desconocida"})
            continue
        if not os.path.isfile(ruta):
            problemas.append({"ruta": e["ruta"], "problema": "el archivo no existe"})
            continue
        if not e.get("formato_version"):
            viejos.append(e["ruta"])
        try:
            fallas = _revisar(e, ruta, TABLAS[e["tabla"]], destino)
        except Exception as exc:  # noqa: BLE001
            fallas = ["no se pudo releer: %s" % exc]
        if fallas:
            problemas.append({"ruta": e["ruta"], "problema": "; ".join(fallas)})
    todas = leer_manifiesto(destino)
    conocidas = {e["ruta"] for e in todas} | {e["ruta_hashes"] for e in todas if e.get("ruta_hashes")}
    huerfanos = []
    for carpeta, _, archivos in os.walk(destino):
        for f in archivos:
            if f.startswith("part-"):
                rel = os.path.relpath(os.path.join(carpeta, f), destino).replace(os.sep, "/")
                if rel not in conocidas and (base is None or rel.startswith(base + "/")):
                    huerfanos.append(rel)
    return {"archivos": len(entradas), "problemas": problemas, "huerfanos_sin_confirmar": sorted(huerfanos), "formato_viejo": sorted(viejos)}
