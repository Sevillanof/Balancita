"""Estado del archivo para la alerta: la ultima corrida real de ``nocturno`` tiene que ser reciente y completa.

``problema(destino, ahora_s)`` devuelve ``None`` si esta bien, o una frase corta para la alerta. Una corrida pospuesta
(codigo 3), un dry-run o una linea ilegible no cuentan como corrida.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from typing import Optional

MAX_HORAS = 26
_ESTADOS_BIEN = ("ok", "sin_novedad")


def _corridas(ruta: str):
    with open(ruta, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - 1_048_576))
        texto = fh.read().decode("utf-8", "replace")
    for linea in texto.splitlines():
        try:
            r = json.loads(linea)
        except ValueError:
            continue
        if isinstance(r, dict) and not r.get("dry_run") and r.get("codigo") in (0, 1) and r.get("inicio"):
            yield r


def _segundos(iso: str) -> float:
    return dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp()


def problema(destino: str, ahora_s: float, max_horas: int = MAX_HORAS) -> Optional[str]:
    ruta = os.path.join(destino, "nocturno.jsonl")
    if not os.path.isfile(ruta):
        return "parquet: no hay nocturno.jsonl"
    ultima = None
    for ultima in _corridas(ruta):
        pass
    if ultima is None:
        return "parquet: ninguna corrida real en nocturno.jsonl"
    horas = int((ahora_s - _segundos(ultima["inicio"])) // 3600)
    if horas >= max_horas:
        return "parquet: ultima corrida hace %d h (maximo %d h)" % (horas, max_horas)
    if ultima["codigo"] == 0:
        return None
    if ultima.get("estado") == "error":
        return "parquet incompleto (%s): %s" % (ultima["inicio"], ultima.get("motivo", "error"))
    partes = ["%s %s" % (b, i.get("estado")) for b, i in sorted((ultima.get("bases") or {}).items())
              if isinstance(i, dict) and i.get("estado") not in _ESTADOS_BIEN]
    if ultima.get("bases_sin_cubrir"):
        partes.append("bases sin cubrir: " + ", ".join(ultima["bases_sin_cubrir"]))
    problemas = (ultima.get("verificacion") or {}).get("problemas") or []
    if problemas:
        partes.append("verificar: %d problemas" % len(problemas))
    return "parquet incompleto (%s, %s sin confirmar): %s" % (
        ultima["inicio"], ultima.get("sin_confirmar", "?"), ", ".join(partes) or "ver nocturno.jsonl")
