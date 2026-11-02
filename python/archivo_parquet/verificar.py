"""Revalida el manifiesto contra los archivos: existencia, sha256, relectura con checksum de paginas, filas, claves y suma de control."""
from __future__ import annotations

import os
from typing import List, Optional

from . import formato
from .config import TABLAS
from .util import Resumen, diferencias, leer_manifiesto, sha256_archivo


def verificar(destino: str, base: Optional[str] = None, tabla: Optional[str] = None) -> dict:
    entradas = [e for e in leer_manifiesto(destino) if (base is None or e["base"] == base) and (tabla is None or e["tabla"] == tabla)]
    problemas: List[dict] = []
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
        cfg = TABLAS[e["tabla"]]
        try:
            fallas = []
            if sha256_archivo(ruta) != e["sha256"]:
                fallas.append("sha256 distinto")
            r = Resumen(cfg)
            for lote in formato.leer_filas(ruta, cfg):
                r.agregar(lote)
            if not r.ordenado:
                fallas.append("no esta ordenado por clave")
            esperado = {k: e[k] for k in ("filas", "clave_min", "clave_max", "tiempo_min", "tiempo_max", "producto_min", "producto_max",
                                          "checksum_contenido")}
            fallas += diferencias(esperado, r.como_dict())
        except Exception as exc:  # noqa: BLE001
            fallas = ["no se pudo releer: %s" % exc]
        if fallas:
            problemas.append({"ruta": e["ruta"], "problema": "; ".join(fallas)})
    conocidas = {e["ruta"] for e in leer_manifiesto(destino)}
    huerfanos = []
    for carpeta, _, archivos in os.walk(destino):
        for f in archivos:
            if f.startswith("part-"):
                rel = os.path.relpath(os.path.join(carpeta, f), destino).replace(os.sep, "/")
                if rel not in conocidas and (base is None or rel.startswith(base + "/")):
                    huerfanos.append(rel)
    return {"archivos": len(entradas), "problemas": problemas, "huerfanos_sin_confirmar": sorted(huerfanos)}
