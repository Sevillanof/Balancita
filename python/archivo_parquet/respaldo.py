"""Respaldo fuera del VPS (fase 2): envuelve ``rclone``; sin pyarrow y sin dependencias de Python.

Sube SOLO archivos confirmados en el manifiesto que aun no estan (o estan danados) en el remoto, el manifiesto al final, y despues verifica
tamano y sha256 contra el remoto. Escribe ``respaldo-estado.jsonl`` con ``confirmado_fuera`` por archivo para que una fase futura de borrado
sepa que algo ya esta fuera del VPS.

Reglas duras (hay pruebas que lo exigen):
- Nunca borra: ni en el origen ni en el remoto. Solo se permiten los subcomandos ``lsjson``, ``copyto`` y ``check`` de rclone (nada de
  sync, delete, move, purge...). Si un archivo del remoto esta corrupto se SOBRESCRIBE con el bueno (copyto), no se borra.
- Nunca guarda credenciales: el remoto se configura con ``rclone config`` fuera del repo; aqui solo se acepta ``nombre:ruta`` (no cadenas de
  conexion con opciones) y el nombre del remoto no se escribe en el estado ni en los mensajes.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Dict, List, Optional, Tuple

from .util import NOMBRE_MANIFIESTO, ErrorArchivo, sha256_archivo

NOMBRE_ESTADO = "respaldo-estado.jsonl"
SUBCOMANDOS_PERMITIDOS = frozenset({"lsjson", "copyto", "check"})
RC_NO_EXISTE = 3  # rclone: "directory not found" (el remoto aun esta vacio)

# Runner: recibe los argumentos DESPUES de "rclone" y devuelve (codigo, stdout, stderr).
Runner = Callable[[List[str]], Tuple[int, str, str]]


def runner_rclone(binario: str = "rclone") -> Runner:
    """Runner real: ejecuta rclone. Si no esta instalado, falla con un mensaje claro (sin instalar nada)."""
    ruta = shutil.which(binario)
    if ruta is None:
        raise ErrorArchivo("no se encontro 'rclone' en el PATH. Instalelo (https://rclone.org/install/) y configure un remoto con 'rclone config' "
                           "(recomendado: un remoto 'crypt' encima del almacenamiento); ver docs/archivo-parquet.md")

    def correr(args: List[str]) -> Tuple[int, str, str]:
        p = subprocess.run([ruta] + args, capture_output=True, text=True, check=False)
        return p.returncode, p.stdout, p.stderr

    return correr


def validar_remoto(remoto: str) -> str:
    """Acepta ``nombre:ruta`` de un remoto ya configurado en rclone. Rechaza cadenas de conexion (``:sftp,pass=...:``), que llevarian credenciales."""
    if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.\- ]*:[^\x00]*$", remoto or ""):
        raise ErrorArchivo("--remoto debe ser 'nombre:ruta' de un remoto configurado con 'rclone config' (no se aceptan cadenas de conexion "
                           "ni credenciales en la linea de comandos)")
    return remoto


def _en_remoto(remoto: str, rel: str) -> str:
    return remoto + rel if remoto.endswith(":") or remoto.endswith("/") else remoto + "/" + rel


class Rclone:
    """Capa fina sobre el runner: solo lsjson / copyto / check, y errores sin el nombre del remoto."""

    def __init__(self, runner: Runner, remoto: str):
        self.runner = runner
        self.remoto = remoto

    def _correr(self, args: List[str]) -> Tuple[int, str, str]:
        if args[0] not in SUBCOMANDOS_PERMITIDOS:
            raise ErrorArchivo("subcomando de rclone no permitido: %s" % args[0])
        return self.runner(args)

    def limpio(self, texto: str) -> str:
        texto = (texto or "").replace(self.remoto, "<remoto>")
        return " ".join(texto.split())[:300]

    def listar(self) -> Dict[str, dict]:
        """{ruta: {"size": n, "sha256": hex o None}} de todos los archivos del remoto. Remoto inexistente = vacio."""
        rc, out, err = self._correr(["lsjson", "--recursive", "--files-only", "--hash", self.remoto])
        if rc == RC_NO_EXISTE:
            return {}
        if rc != 0:
            raise ErrorArchivo("rclone lsjson fallo (codigo %d): %s" % (rc, self.limpio(err)))
        try:
            filas = json.loads(out or "[]")
        except ValueError as exc:
            raise ErrorArchivo("rclone lsjson devolvio algo que no es JSON") from exc
        res = {}
        for f in filas:
            hashes = {k.lower(): v for k, v in (f.get("Hashes") or {}).items()}
            res[f["Path"]] = {"size": f.get("Size"), "sha256": (hashes.get("sha256") or "").lower() or None}
        return res

    def subir(self, local: str, rel: str) -> Tuple[bool, str]:
        rc, _, err = self._correr(["copyto", "--checksum", local, _en_remoto(self.remoto, rel)])
        return rc == 0, ("" if rc == 0 else "rclone copyto fallo (codigo %d): %s" % (rc, self.limpio(err)))

    def bajar(self, rel: str, local: str) -> Tuple[bool, str]:
        rc, _, err = self._correr(["copyto", "--checksum", _en_remoto(self.remoto, rel), local])
        return rc == 0, ("" if rc == 0 else "rclone copyto fallo (codigo %d): %s" % (rc, self.limpio(err)))

    def comprobar(self, raiz: str, rels: List[str]) -> bool:
        """``rclone check --download``: compara el contenido real (sirve cuando el remoto no da sha256, p. ej. crypt). Solo lee."""
        if not rels:
            return True
        with tempfile.TemporaryDirectory(prefix="respaldo-lista-") as tmp:
            lista = os.path.join(tmp, "lista.txt")
            with open(lista, "w", encoding="utf-8") as fh:
                fh.write("\n".join(rels) + "\n")
            rc, _, _ = self._correr(["check", raiz, self.remoto, "--one-way", "--download", "--files-from-raw", lista])
        return rc == 0


# ---------- estado ----------
def leer_estado(destino: str) -> Dict[str, dict]:
    """Ultima linea de ``respaldo-estado.jsonl`` por archivo."""
    ruta = os.path.join(destino, NOMBRE_ESTADO)
    out: Dict[str, dict] = {}
    if not os.path.exists(ruta):
        return out
    with open(ruta, "r", encoding="utf-8") as fh:
        for linea in fh:
            if linea.strip():
                f = json.loads(linea)
                out[f["archivo"]] = f
    return out


def confirmados_fuera(destino: str) -> set:
    """Archivos cuyo ULTIMO estado es confirmado-fuera. Es lo que debe leer una fase futura de borrado (que ademas debera reverificar)."""
    return {a for a, f in leer_estado(destino).items() if f.get("confirmado_fuera") is True}


def _agregar_estado(destino: str, lineas: List[dict]) -> None:
    if not lineas:
        return
    datos = "".join(json.dumps(l, sort_keys=True, ensure_ascii=False) + "\n" for l in lineas).encode("utf-8")
    fd = os.open(os.path.join(destino, NOMBRE_ESTADO), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, datos)
        os.fsync(fd)
    finally:
        os.close(fd)


def _leer_manifiesto_crudo(destino: str) -> List[Tuple[bytes, dict]]:
    ruta = os.path.join(destino, NOMBRE_MANIFIESTO)
    if not os.path.isfile(ruta):
        raise ErrorArchivo("no hay %s en %s: nada que respaldar" % (NOMBRE_MANIFIESTO, destino))
    with open(ruta, "rb") as fh:
        crudo = fh.read()
    out = []
    for n, linea in enumerate(crudo.split(b"\n"), 1):
        if not linea.strip():
            continue
        try:
            out.append((linea, json.loads(linea.decode("utf-8"))))
        except ValueError as exc:
            raise ErrorArchivo("manifiesto danado en la linea %d: %s" % (n, exc)) from exc
    return out


def _ahora_iso(ahora: Optional[dt.datetime]) -> str:
    return (ahora or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- respaldar ----------
def respaldar(destino: str, remoto: str, dry_run: bool = False, runner: Optional[Runner] = None, ahora: Optional[dt.datetime] = None,
              log: Callable[[str], None] = lambda m: None) -> dict:
    """Devuelve el reporte. ``fallidos`` o ``no_confirmados`` no vacios => codigo de salida 1."""
    validar_remoto(remoto)
    if not os.path.isdir(destino):
        raise ErrorArchivo("no existe la carpeta del archivo: %s" % destino)
    lineas = _leer_manifiesto_crudo(destino)
    rc = Rclone(runner or runner_rclone(), remoto)
    estado = leer_estado(destino)
    fecha = _ahora_iso(ahora)
    rep: Dict[str, object] = {"en_manifiesto": len(lineas), "ya_en_remoto": 0, "subidos": [], "fallidos": [], "no_confirmados": [],
                              "problemas_locales": [], "manifiesto_subido": False, "dry_run": dry_run}

    antes = rc.listar()
    por_subir = []
    for crudo, e in lineas:
        info = antes.get(e["ruta"])
        bien = info is not None and info["size"] == e["bytes"] and (info["sha256"] is None or info["sha256"] == e["sha256"])
        if bien:
            rep["ya_en_remoto"] += 1
        else:
            por_subir.append(e)
    rep["por_subir"] = [e["ruta"] for e in por_subir]
    if dry_run:
        return rep

    # 1. archivos de datos (cada uno aparte: un fallo no frena a los demas)
    subidos = set()
    for e in por_subir:
        local = os.path.join(destino, e["ruta"])
        if not os.path.isfile(local) or os.path.getsize(local) != e["bytes"] or sha256_archivo(local) != e["sha256"]:
            rep["problemas_locales"].append({"ruta": e["ruta"], "problema": "el archivo local falta o no coincide con el manifiesto; no se sube"})
            continue
        ok, motivo = rc.subir(local, e["ruta"])
        if ok:
            subidos.add(e["ruta"])
            rep["subidos"].append(e["ruta"])
            log("subido %s" % e["ruta"])
        else:
            rep["fallidos"].append({"ruta": e["ruta"], "motivo": motivo})
            log("FALLO %s: %s" % (e["ruta"], motivo))

    # 2. verificacion de los archivos de datos contra el manifiesto
    despues = rc.listar()
    resultado: Dict[str, Tuple[bool, str]] = {}
    sin_hash = []
    for _, e in lineas:
        info = despues.get(e["ruta"])
        if info is None:
            resultado[e["ruta"]] = (False, "no esta en el remoto")
        elif info["size"] != e["bytes"]:
            resultado[e["ruta"]] = (False, "tamano distinto en el remoto")
        elif info["sha256"] is not None:
            resultado[e["ruta"]] = (info["sha256"] == e["sha256"], "" if info["sha256"] == e["sha256"] else "sha256 distinto en el remoto")
        elif e["ruta"] not in subidos and (estado.get(e["ruta"]) or {}).get("confirmado_fuera") is True:
            resultado[e["ruta"]] = (True, "")  # el remoto no da sha256 y ya se habia comprobado el contenido; mismo tamano
        else:
            sin_hash.append(e["ruta"])
    if sin_hash:  # remoto sin sha256 (crypt, algunos S3...): se compara el contenido bajandolo (solo lo nuevo)
        if rc.comprobar(destino, sin_hash):
            resultado.update({r: (True, "") for r in sin_hash})
        else:  # no se sabe cual: se revisa uno por uno
            for r in sin_hash:
                ok = rc.comprobar(destino, [r])
                resultado[r] = (ok, "" if ok else "el contenido del remoto no coincide (rclone check)")

    # 3. manifiesto al final: solo con las lineas confirmadas (el remoto nunca lista algo que no tiene)
    confirmadas = [(c, e) for c, e in lineas if resultado[e["ruta"]][0]]
    instantanea = b"".join(c + b"\n" for c, _ in confirmadas)
    sha_man = _sha256_bytes(instantanea)
    man_remoto = despues.get(NOMBRE_MANIFIESTO)
    man_ok, man_motivo = False, "no se subio"
    with tempfile.TemporaryDirectory(prefix="respaldo-manifiesto-") as tmp:
        local_man = os.path.join(tmp, NOMBRE_MANIFIESTO)
        with open(local_man, "wb") as fh:
            fh.write(instantanea)
        previo_man = estado.get(NOMBRE_MANIFIESTO) or {}
        if man_remoto is not None and man_remoto["size"] == len(instantanea) and (
                man_remoto["sha256"] == sha_man or (man_remoto["sha256"] is None and previo_man.get("sha256") == sha_man
                                                    and previo_man.get("confirmado_fuera") is True)):
            man_ok, man_motivo = True, ""
        else:
            ok, man_motivo = rc.subir(local_man, NOMBRE_MANIFIESTO)
            if ok:
                rep["manifiesto_subido"] = True
                nuevo = rc.listar().get(NOMBRE_MANIFIESTO)
                if nuevo is None or nuevo["size"] != len(instantanea):
                    man_ok, man_motivo = False, "el manifiesto del remoto no coincide en tamano"
                elif nuevo["sha256"] is not None:
                    man_ok, man_motivo = nuevo["sha256"] == sha_man, "" if nuevo["sha256"] == sha_man else "sha256 distinto en el remoto"
                else:
                    man_ok = rc.comprobar(tmp, [NOMBRE_MANIFIESTO])
                    man_motivo = "" if man_ok else "el contenido del manifiesto en el remoto no coincide"
            else:
                rep["fallidos"].append({"ruta": NOMBRE_MANIFIESTO, "motivo": man_motivo})
    resultado[NOMBRE_MANIFIESTO] = (man_ok, man_motivo)

    # 4. estado: solo se agrega una linea cuando cambia lo conocido de ese archivo
    nuevas = []
    sha_por_ruta = {e["ruta"]: e["sha256"] for _, e in lineas}
    sha_por_ruta[NOMBRE_MANIFIESTO] = sha_man
    for ruta, (ok, motivo) in resultado.items():
        previo = estado.get(ruta)
        if previo is None or previo.get("confirmado_fuera") != ok or previo.get("sha256") != sha_por_ruta[ruta]:
            nuevas.append({"archivo": ruta, "fecha": fecha, "confirmado_fuera": ok, "sha256": sha_por_ruta[ruta]})
        if not ok and ruta != NOMBRE_MANIFIESTO and not any(f["ruta"] == ruta for f in rep["fallidos"]):
            rep["no_confirmados"].append({"ruta": ruta, "motivo": motivo})
    _agregar_estado(destino, nuevas)
    rep["confirmados_fuera"] = sum(1 for r, (ok, _) in resultado.items() if ok and r != NOMBRE_MANIFIESTO)
    rep["manifiesto_confirmado_fuera"] = man_ok
    if not man_ok and not any(f["ruta"] == NOMBRE_MANIFIESTO for f in rep["fallidos"]):
        rep["no_confirmados"].append({"ruta": NOMBRE_MANIFIESTO, "motivo": man_motivo})
    return rep


def _sha256_bytes(datos: bytes) -> str:
    return hashlib.sha256(datos).hexdigest()


def codigo_salida(rep: dict) -> int:
    return 1 if rep["fallidos"] or rep["no_confirmados"] or rep["problemas_locales"] else 0


# ---------- restaurar-prueba ----------
def restaurar_prueba(destino: str, remoto: str, dia: Optional[str] = None, base: Optional[str] = None, tabla: Optional[str] = None,
                     semilla: Optional[int] = None, runner: Optional[Runner] = None) -> dict:
    """Baja un dia (el indicado o uno al azar del manifiesto) a una carpeta temporal y lo verifica contra el manifiesto. No toca ``destino``."""
    validar_remoto(remoto)
    lineas = _leer_manifiesto_crudo(destino)
    entradas = [(c, e) for c, e in lineas if (base is None or e["base"] == base) and (tabla is None or e["tabla"] == tabla)]
    dias = sorted({e["dia"] for _, e in entradas})
    if not dias:
        raise ErrorArchivo("el manifiesto no tiene archivos para esa base/tabla")
    if dia is not None and dia not in dias:
        raise ErrorArchivo("el dia %s no esta en el manifiesto" % dia)
    elegido = dia or random.Random(semilla).choice(dias)
    sel = [(c, e) for c, e in entradas if e["dia"] == elegido]
    rc = Rclone(runner or runner_rclone(), remoto)
    problemas: List[dict] = []
    rep: Dict[str, object] = {"dia": elegido, "archivos": [], "problemas": problemas}
    with tempfile.TemporaryDirectory(prefix="restaurar-prueba-") as tmp:
        for _, e in sel:
            local = os.path.join(tmp, e["ruta"])
            os.makedirs(os.path.dirname(local), exist_ok=True)
            ok, motivo = rc.bajar(e["ruta"], local)
            if not ok:
                problemas.append({"ruta": e["ruta"], "problema": motivo})
                continue
            if os.path.getsize(local) != e["bytes"]:
                problemas.append({"ruta": e["ruta"], "problema": "tamano distinto al del manifiesto"})
            elif sha256_archivo(local) != e["sha256"]:
                problemas.append({"ruta": e["ruta"], "problema": "sha256 distinto al del manifiesto"})
            else:
                rep["archivos"].append({"ruta": e["ruta"], "filas": e["filas"], "bytes": e["bytes"]})
        # relectura completa (checksum de paginas, filas, claves, suma de control) si hay pyarrow
        from . import formato
        bajados = [c for c, e in sel if any(a["ruta"] == e["ruta"] for a in rep["archivos"])]
        if not bajados:
            rep["relectura"] = "no hubo archivos bajados"
        elif formato.disponible():
            with open(os.path.join(tmp, NOMBRE_MANIFIESTO), "wb") as fh:
                fh.write(b"".join(c + b"\n" for c in bajados))
            from .verificar import verificar
            problemas.extend(verificar(tmp)["problemas"])
            rep["relectura"] = "completa"
        else:
            rep["relectura"] = "omitida: pyarrow no esta instalado (solo se comprobo tamano y sha256)"
    return rep
