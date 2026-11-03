"""Exportacion nocturna automatica (fase 3): usa la ultima copia buena de cada base, exporta, verifica y deja un resumen JSONL.

Reglas:
- Lee SOLO copias de ``server/data/backups`` (las que deja la captura); nunca la base viva. Por base elige la copia MAS RECIENTE que pase
  ``quick_check``; una copia con menos de ``EDAD_MINIMA_COPIA_S`` de vida, o con un ``.tmp`` en curso, se deja para otra noche.
- Idempotente (``exportar`` salta lo ya confirmado) y un solo proceso a la vez (``flock`` sobre ``.nocturno.lock``).
- Baja prioridad (``os.nice``). No corre en los 10 min posteriores a un despertar (macOS: ``sysctl kern.waketime``; en otros sistemas no hay
  forma simple de saberlo y no se aplica): en vez de salir, ESPERA (tramos de ``TRAMO_ESPERA_S``, ya con el candado y el nice) hasta que
  pasen esos 10 min, con tope ``TOPE_ESPERA_S`` de espera total; un nuevo despertar durante la espera recalcula. Solo si el tope no alcanza
  sale con codigo 3, y launchd lo reintenta (``StartInterval``). En ``--dry-run`` no espera.
- Una corrida sin novedad es barata: si hoy (UTC) ya hubo una corrida ``ok`` sobre la misma copia de una base, no se repite su ``quick_check``.
- Codigos: 0 todo confirmado; 1 algo quedo SIN confirmar (dia, base sin copia buena, o ``verificar`` con problemas); 2 uso o pyarrow ausente;
  3 no corrio a proposito (otra corrida en curso, o despertar reciente): no es un fallo, la proxima noche lo recupera.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from typing import Callable, Dict, List, Optional

from . import formato
from .exportar import exportar
from .util import ErrorArchivo, abrir_copia
from .verificar import verificar

BASES = ("futures-market", "futures-verdicts", "futures-llm-decisions", "futures-forecast-scores", "positioning", "futures-news")
EDAD_MINIMA_COPIA_S = 300
TMP_RECIENTE_S = 2 * 3600
PAUSA_DESPERTAR_S = 600
TOPE_ESPERA_S = 900
TRAMO_ESPERA_S = 30
NOMBRE_LOG = "nocturno.jsonl"
NOMBRE_LOCK = ".nocturno.lock"
VARIABLE_DESTINO = "BALANCITA_ARCHIVO_DESTINO"
VARIABLE_RESPALDOS = "BALANCITA_RESPALDOS_DIR"
_SELLO = re.compile(r"^(?P<base>.+)-(?P<sello>\d{8}-\d{6})\.sqlite$")


def destino_por_defecto() -> str:
    return os.environ.get(VARIABLE_DESTINO) or os.path.expanduser("~/balancita-data.noindex/archivo-parquet")


def respaldos_por_defecto() -> str:
    if os.environ.get(VARIABLE_RESPALDOS):
        return os.environ[VARIABLE_RESPALDOS]
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(repo, "server", "data", "backups")


class OtraCorridaEnCurso(Exception):
    pass


class Candado:
    """flock no bloqueante: si otra corrida lo tiene, falla enseguida. Se libera solo si el proceso muere."""

    def __init__(self, ruta: str):
        self.ruta, self.fd = ruta, None

    def __enter__(self):
        import fcntl
        self.fd = os.open(self.ruta, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(self.fd)
            self.fd = None
            raise OtraCorridaEnCurso(self.ruta) from exc
        os.ftruncate(self.fd, 0)
        os.write(self.fd, ("%d\n" % os.getpid()).encode())
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)  # cerrar libera el flock
            self.fd = None


def ultimo_despertar_s() -> Optional[float]:
    """Instante (s UNIX) del ultimo despertar segun macOS (``kern.waketime``); ``None`` si no se sabe."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["sysctl", "-n", "kern.waketime"], capture_output=True, text=True, timeout=5, check=False).stdout
        m = re.search(r"sec\s*=\s*(\d+)", out)
        return float(m.group(1)) if m else None
    except (OSError, subprocess.SubprocessError):
        return None


def copias_de(respaldos: str, base: str) -> List[str]:
    """Copias ``<base>-AAAAMMDD-HHMMSS.sqlite`` (nunca ``.tmp``), la mas reciente primero."""
    if not os.path.isdir(respaldos):
        return []
    out = []
    for f in os.listdir(respaldos):
        m = _SELLO.match(f)
        if m and m.group("base") == base:
            out.append((m.group("sello"), os.path.join(respaldos, f)))
    return [r for _, r in sorted(out, reverse=True)]


def _hay_tmp_reciente(respaldos: str, base: str, ahora_s: float) -> bool:
    for f in os.listdir(respaldos):
        if f.startswith(base + "-") and f.endswith(".tmp"):
            try:
                if ahora_s - os.path.getmtime(os.path.join(respaldos, f)) < TMP_RECIENTE_S:
                    return True
            except OSError:
                return True
    return False


def _log_reciente(destino: str, ahora_s: float) -> List[dict]:
    """Lineas de ``nocturno.jsonl`` de hoy (UTC), leyendo solo el final del archivo."""
    ruta = os.path.join(destino, NOMBRE_LOG)
    try:
        with open(ruta, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - 262144))
            texto = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    hoy, out = _iso(ahora_s)[:10], []
    for linea in texto.splitlines():
        try:
            r = json.loads(linea)
        except ValueError:
            continue
        if isinstance(r, dict) and str(r.get("inicio", ""))[:10] == hoy:
            out.append(r)
    return out


def _copias_ya_exportadas(destino: str, ahora_s: float) -> set:
    """(base, nombre de copia) con una corrida ``ok`` hoy (UTC): sin novedad, no hace falta repetir su quick_check."""
    hechas = set()
    for r in _log_reciente(destino, ahora_s):
        if r.get("dry_run") or r.get("codigo") != 0:
            continue
        for base, info in (r.get("bases") or {}).items():
            if isinstance(info, dict) and info.get("estado") in ("ok", "sin_novedad") and info.get("copia"):
                hechas.add((base, info["copia"]))
    return hechas


def elegir_copia(respaldos: str, base: str, ahora_s: float, ya_hechas=frozenset()):
    """(con, ruta, motivo). ``con`` es la conexion ya chequeada de la copia elegida; si no hay, ``con`` es None y ``motivo`` dice por que."""
    if not os.path.isdir(respaldos):
        return None, None, "sin_carpeta_de_copias"
    candidatas = copias_de(respaldos, base)
    if not candidatas:
        return None, None, "sin_copias"
    if _hay_tmp_reciente(respaldos, base, ahora_s):
        return None, None, "copia_en_curso"
    rechazadas = []
    for ruta in candidatas:
        try:
            if ahora_s - os.path.getmtime(ruta) < EDAD_MINIMA_COPIA_S:
                rechazadas.append("%s: muy nueva" % os.path.basename(ruta))
                continue
            if (base, os.path.basename(ruta)) in ya_hechas:
                return None, ruta, "sin_novedad"
            return abrir_copia(ruta, copia_confirmada=True), ruta, None
        except (ErrorArchivo, OSError) as exc:
            rechazadas.append("%s: %s" % (os.path.basename(ruta), exc))
    return None, None, "ninguna_copia_valida: " + "; ".join(rechazadas)[:400]


def _tablas_presentes(con) -> List[str]:
    from .config import TABLAS
    return [n for n, c in TABLAS.items() if con.execute("PRAGMA table_info(\"%s\")" % c.sqlite).fetchall()]


def nocturno(destino: str, respaldos: str, bases=BASES, dry_run: bool = False, ahora_s: Optional[float] = None,
             log: Callable[[str], None] = lambda m: None, despertar: Callable[[], Optional[float]] = ultimo_despertar_s,
             aplicar_nice: bool = True, dormir: Callable[[float], None] = time.sleep, reloj: Callable[[], float] = time.time) -> dict:
    """Devuelve el resumen con ``codigo`` (ver docstring del modulo). Lanza ``OtraCorridaEnCurso`` si el candado esta tomado."""
    ahora_s = reloj() if ahora_s is None else ahora_s
    resumen: dict = {"inicio": _iso(ahora_s), "destino": destino, "respaldos": respaldos, "dry_run": dry_run, "bases": {}}
    if aplicar_nice and not dry_run:
        try:
            os.nice(10)  # antes de esperar: la espera tambien es de baja prioridad
        except (OSError, AttributeError):
            pass
        aplicar_nice = False
    inicio_espera, esperado = reloj(), 0.0
    while True:
        w = despertar()  # se vuelve a leer en cada vuelta: un nuevo despertar durante la espera reinicia los 10 min
        faltan = PAUSA_DESPERTAR_S - (ahora_s - w) if w is not None and ahora_s >= w else 0
        if faltan <= 0:
            break
        if dry_run or esperado >= TOPE_ESPERA_S:
            resumen.update(estado="pospuesta_por_despertar", codigo=3, esperado_s=int(esperado))
            return resumen
        pausa = min(faltan + 1, TRAMO_ESPERA_S)
        dormir(pausa)
        t = reloj()
        pasado = max(t - inicio_espera, pausa)  # un sleep nunca es mas corto que lo pedido
        esperado += pasado
        ahora_s += pasado
        inicio_espera = t
    if esperado:
        resumen["esperado_s"] = int(esperado)
    if not dry_run and formato.pq is None:
        raise formato.ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")
    if aplicar_nice:
        try:
            os.nice(10)
        except (OSError, AttributeError):
            pass
    sin_confirmar = 0
    ya_hechas = _copias_ya_exportadas(destino, ahora_s) if not dry_run else frozenset()
    for base in bases:
        info: dict = {}
        resumen["bases"][base] = info
        con, ruta, motivo = elegir_copia(respaldos, base, ahora_s, ya_hechas)
        if motivo == "sin_novedad":
            info.update(estado="sin_novedad", copia=os.path.basename(ruta))
            log("%s: sin novedad (%s ya exportada hoy)" % (base, info["copia"]))
            continue
        if con is None:
            info["estado"] = "omitida"
            info["motivo"] = motivo
            # Sin ninguna copia (base que no se usa) no es un fallo; una copia ilegible o con quick_check malo si lo es.
            if motivo.startswith("ninguna_copia_valida"):
                sin_confirmar += 1
            log("%s: omitida (%s)" % (base, motivo))
            continue
        info["copia"] = os.path.basename(ruta)
        try:
            tablas = _tablas_presentes(con)
            if not tablas:
                info["estado"] = "sin_tablas_del_archivo"
                con.close()
                continue
            rep = exportar(ruta, base, destino, tablas, dry_run, True, int(ahora_s * 1000), log, con=con)
        except ErrorArchivo as exc:
            info.update(estado="error", motivo=str(exc))
            sin_confirmar += 1
            log("%s: error: %s" % (base, exc))
            continue
        info["estado"] = "ok" if not rep["no_confirmados"] else "con_no_confirmados"
        info["exportados"] = len(rep["exportados"])
        info["reemplazados"] = len(rep["reemplazados"])  # formato viejo -> formato 2
        info["omitidos_por_retencion"] = rep["omitidos_por_retencion"]  # informado, no es fallo (ver docs/archivo-parquet.md, retencion de 48 h)
        info["reemplazos_omitidos"] = rep["reemplazos_omitidos"]
        info["ya_confirmados"] = len(rep["ya_confirmados"])
        info["no_confirmados"] = rep["no_confirmados"]
        if dry_run:
            info["dry_run"] = rep["dry_run"]
        sin_confirmar += len(rep["no_confirmados"])
    if not dry_run and os.path.isdir(destino):
        ver = verificar(destino)
        resumen["verificacion"] = {"archivos": ver["archivos"], "problemas": ver["problemas"], "huerfanos_sin_confirmar": ver["huerfanos_sin_confirmar"]}
        sin_confirmar += len(ver["problemas"])
    resumen["sin_confirmar"] = sin_confirmar
    resumen["estado"] = "ok" if not sin_confirmar else "con_pendientes"
    resumen["codigo"] = 1 if sin_confirmar else 0
    return resumen


def _iso(s: float) -> str:
    return dt.datetime.fromtimestamp(s, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def correr(destino: str, respaldos: str, dry_run: bool = False, bases=BASES, log: Callable[[str], None] = lambda m: None,
           despertar: Callable[[], Optional[float]] = ultimo_despertar_s, ahora_s: Optional[float] = None, aplicar_nice: bool = True,
           dormir: Callable[[float], None] = time.sleep, reloj: Callable[[], float] = time.time) -> dict:
    """Candado + corrida + linea en ``nocturno.jsonl`` (esta no se escribe en dry-run). Sin candado en dry-run: solo lee."""
    if dry_run:
        return nocturno(destino, respaldos, bases, True, ahora_s, log, despertar, aplicar_nice, dormir, reloj)
    os.makedirs(destino, exist_ok=True)
    try:
        with Candado(os.path.join(destino, NOMBRE_LOCK)):
            res = nocturno(destino, respaldos, bases, False, ahora_s, log, despertar, aplicar_nice, dormir, reloj)
    except OtraCorridaEnCurso:
        res = {"inicio": _iso(time.time() if ahora_s is None else ahora_s), "estado": "otra_corrida_en_curso", "codigo": 3, "destino": destino}
    res["fin"] = _iso(time.time() if ahora_s is None else ahora_s)
    try:
        with open(os.path.join(destino, NOMBRE_LOG), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(res, sort_keys=True, ensure_ascii=False) + "\n")
    except OSError as exc:
        log("no se pudo escribir %s: %s" % (NOMBRE_LOG, exc))
    return res
