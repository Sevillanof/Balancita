"""Reproducir: reconstruye DESDE EL PARQUET los conjuntos de datos que usan las pruebas de entradas y salidas del trader y los compara, por valor,
con lo que da SQLite (una COPIA, solo lectura) para el mismo rango.

Rango: solo los periodos (dia o mes) que el manifiesto confirma para la base. Lo que SQLite tiene y el manifiesto no, se clasifica igual que lo
hace ``exportar``: pendiente (periodo aun abierto o con filas que SQLite todavia puede cambiar: no es hueco), perdida aceptada
(``nocturno.PERIODOS_PERDIDOS_ACEPTADOS``: se informa, no es hueco) o HUECO (periodo cerrado y estable que el archivo no tiene).

Comparacion exacta: hash por fila de TODAS las columnas (``util.hash_fila``, el mismo del formato 2) de cada lado, por clave de la tabla. ``filas_distintas``
cuenta las claves presentes en un solo lado o con hash distinto. Para las velas oficiales se compara la serie FINAL por (producto, intervalo,
bucket_start): la ultima revision conocida (mayor ``known_at``) entre las filas de los periodos confirmados («as-of»).

Codigos de la CLI: 0 todo igual y sin huecos; 1 alguna FALLA o hueco; 2 uso incorrecto (copia invalida, conjunto desconocido, sin pyarrow).
"""
from __future__ import annotations

import datetime as dt
import time
import os
from typing import Callable, Dict, List, Optional, Tuple

from . import formato
from .config import TABLAS
from .exportar import _columnas_de, _consulta, _filas_que_pueden_cambiar, periodos_de_la_tabla
from .util import (ErrorArchivo, abrir_copia, desde_archivo, hash_fila, leer_manifiesto, periodo_cerrado, rango_periodo)

INTERVALOS_VELAS = (60_000, 300_000)

# Tablas cuyas filas SQLite RECORTA por retencion mientras el Parquet las conserva (es justo para lo que sirve el archivo). tabla del archivo ->
# (columna, valor) de las filas que se recortan. Una fila que solo esta en el Parquet, es de ese tipo y es MAS VIEJA que la fila mas vieja que la
# copia aun conserva de ese tipo, no es una diferencia: se informa aparte en ``filas_recortadas_por_retencion``. Todo lo demas (una fila ausente
# dentro del rango que SQLite aun tiene, o con otro valor) sigue contando.
RETENCION_SQLITE: Dict[str, Tuple[str, int]] = {
    "premium": ("interval_ms", 60_000),  # premium de 1 minuto: keep_days = 7
    "premium_1m": ("interval_ms", 60_000),
}

# conjunto -> tablas del archivo que lo forman (cada una se busca en la copia por el nombre de su tabla SQLite)
CONJUNTOS: Dict[str, Tuple[str, ...]] = {
    "velas_oficiales": ("official_candles",),
    "decisiones_maestro": ("qwen_decisions", "qwen_config_versions"),
    "operaciones": ("qwen_trades", "qwen_execution_receipts"),
    "auditor": ("auditor_miradas", "auditor_hechos", "auditor_flujo", "auditor_propuestas", "auditor_perdidas", "auditor_mirada_operaciones",
                "auditor_operaciones", "auditor_resultados", "auditor_sombra"),
    "funding": ("funding_periods",),
    "posicionamiento": ("positioning", "premium"),
    "noticias": ("news_items", "news_analysis", "news_cards", "qwen_news_actions"),
    "rebotes_skipped": ("qwen_rebotes", "qwen_skipped"),
    "mercado": ("analytics_points", "eth_minute_summary"),
}


def _perdidos_aceptados() -> dict:
    from .nocturno import PERIODOS_PERDIDOS_ACEPTADOS
    return PERIODOS_PERDIDOS_ACEPTADOS


def _filas_sqlite(con, cfg, d0: int, d1: int):
    cur = con.execute(_consulta(cfg), (d0, d1))
    while True:
        lote = cur.fetchmany(formato.lote_de(cfg))
        if not lote:
            return
        for f in lote:
            yield tuple(f)


def _filas_parquet(destino: str, entrada: dict, cfg):
    ruta = os.path.join(destino, entrada["ruta"])
    legado = not entrada.get("formato_version")
    for lote in formato.leer_filas(ruta, cfg, legado=legado):
        for f in lote:
            yield desde_archivo(cfg, f, legado=legado)


class _Mapa:
    """clave -> hash de la fila. ``repetidas`` cuenta las claves vistas mas de una vez (cada una cuenta como una diferencia)."""

    def __init__(self, cfg, velas: bool):
        nombres = cfg.nombres
        if velas:
            self.ik = [nombres.index(c) for c in ("product_id", "interval_ms", "bucket_start")]
            self.orden = [nombres.index(c) for c in ("known_at", "revision_hash")]
        else:
            self.ik = [nombres.index(c) for c in cfg.clave]
            self.orden = None
        self.datos: Dict[tuple, tuple] = {}
        self.tiempos: Dict[tuple, int] = {}
        self.i_tiempo = nombres.index(cfg.tiempo)
        ret = RETENCION_SQLITE.get(cfg.nombre)
        self.i_ret = (nombres.index(ret[0]), ret[1]) if ret else None
        self.repetidas = 0
        self.velas = velas
        self.it = nombres.index("interval_ms") if velas else None

    def agregar(self, fila: tuple) -> None:
        if self.velas and fila[self.it] not in INTERVALOS_VELAS:
            return
        k = tuple(fila[i] for i in self.ik)
        h = hash_fila(fila)
        if self.velas:
            o = tuple(fila[i] for i in self.orden)
            previa = self.datos.get(k)
            if previa is None or o > previa[0]:
                self.datos[k] = (o, h)
            return
        if k in self.datos:
            self.repetidas += 1
        self.datos[k] = h
        if self.i_ret and fila[self.i_ret[0]] == self.i_ret[1]:
            self.tiempos[k] = fila[self.i_tiempo]

    def valor(self, k):
        v = self.datos.get(k)
        return v[1] if self.velas and v is not None else v


def _comparar(a: _Mapa, b: _Mapa) -> Tuple[int, List[list]]:
    malas = [k for k in set(a.datos) | set(b.datos) if a.valor(k) != b.valor(k)]
    return len(malas) + a.repetidas + b.repetidas, [list(k) for k in sorted(malas)[:5]]


def _dia_texto(inicio) -> str:
    return inicio.isoformat()


def _tabla(con, destino: str, base: str, nombre: str, entradas: List[dict], ahora_ms: int, velas: bool) -> dict:
    cfg = TABLAS[nombre]
    en_manifiesto = {e["dia"]: e for e in entradas if e["base"] == base and e["tabla"] == nombre}
    sq, pq = _Mapa(cfg, velas), _Mapa(cfg, velas)
    faltantes: List[str] = []
    pendientes: List[str] = []
    aceptados: List[dict] = []
    problemas: List[str] = []
    perdidos = _perdidos_aceptados()
    for periodo in periodos_de_la_tabla(con, cfg):
        dia = _dia_texto(periodo)
        if dia in en_manifiesto:
            continue
        d0, d1 = rango_periodo(periodo, cfg.granularidad)
        if not periodo_cerrado(periodo, cfg.granularidad, ahora_ms, cfg.margen_cierre_ms) or _filas_que_pueden_cambiar(con, cfg, d0, d1):
            pendientes.append(dia)
        elif (base, nombre, dia) in perdidos:
            aceptados.append({"dia": dia, "motivo": perdidos[(base, nombre, dia)]})
        else:
            faltantes.append(dia)
    for dia, e in sorted(en_manifiesto.items()):
        d0, d1 = rango_periodo(dt.date.fromisoformat(dia), cfg.granularidad)
        for f in _filas_sqlite(con, cfg, d0, d1):
            sq.agregar(f)
        try:
            for f in _filas_parquet(destino, e, cfg):
                pq.agregar(f)
        except Exception as exc:  # noqa: BLE001 - un archivo ilegible es una falla del conjunto, no un error de uso
            problemas.append("%s: no se pudo leer %s: %s" % (dia, e["ruta"], exc))
    recortadas = 0
    if sq.i_ret and sq.tiempos:
        corte = min(sq.tiempos.values())  # la fila mas vieja de ese tipo que la copia todavia conserva
        viejas = [k for k, t in pq.tiempos.items() if t < corte and k not in sq.datos]
        for k in viejas:
            del pq.datos[k]
        recortadas = len(viejas)
    distintas, ejemplos = _comparar(sq, pq)
    return {"filas_recortadas_por_retencion": recortadas, "filas_sqlite": len(sq.datos), "filas_parquet": len(pq.datos), "filas_distintas": distintas, "ejemplos_claves_distintas": ejemplos,
            "dias_confirmados": len(en_manifiesto), "dias_faltantes": faltantes, "dias_pendientes": pendientes, "perdidos_aceptados": aceptados,
            "problemas": problemas}


def reproducir(copia: str, base: str, destino: str, conjuntos: Optional[List[str]] = None, copia_confirmada: bool = False,
               ahora_ms: Optional[int] = None, log: Callable[[str], None] = lambda m: None) -> dict:
    """Devuelve ``{"conjuntos": {nombre: {...}}, "ok": bool, "codigo": 0|1}``. Cada conjunto trae filas_sqlite, filas_parquet, filas_distintas,
    dias_faltantes, ``estado`` ("OK", "FALLA" o "no_aplica" si la copia no tiene ninguna de sus tablas) y el detalle por tabla."""
    if formato.pq is None:
        raise formato.ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")
    pedidos = conjuntos or list(CONJUNTOS)
    for c in pedidos:
        if c not in CONJUNTOS:
            raise ErrorArchivo("conjunto desconocido %r (soportados: %s)" % (c, ", ".join(CONJUNTOS)))
    if ahora_ms is None:
        ahora_ms = int(time.time() * 1000)
    con = abrir_copia(copia, copia_confirmada)
    entradas = leer_manifiesto(destino)
    salida: Dict[str, dict] = {}
    try:
        for nombre in pedidos:
            tablas: Dict[str, dict] = {}
            for t in CONJUNTOS[nombre]:
                if not _columnas_de(con, TABLAS[t].sqlite):
                    continue
                log("reproducir %s / %s" % (nombre, t))
                tablas[t] = _tabla(con, destino, base, t, entradas, ahora_ms, velas=(t == "official_candles"))
            if not tablas:
                salida[nombre] = {"estado": "no_aplica", "motivo": "la copia no tiene ninguna de sus tablas", "tablas": {}}
                continue
            tot = {k: sum(r[k] for r in tablas.values()) for k in ("filas_sqlite", "filas_parquet", "filas_distintas")}
            faltantes = sorted("%s:%s" % (t, d) for t, r in tablas.items() for d in r["dias_faltantes"])
            problemas = [p for r in tablas.values() for p in r["problemas"]]
            bien = tot["filas_distintas"] == 0 and not faltantes and not problemas
            salida[nombre] = dict(tot, dias_faltantes=faltantes, problemas=problemas, estado="OK" if bien else "FALLA", tablas=tablas)
    finally:
        con.close()
    ok = all(c["estado"] != "FALLA" for c in salida.values())
    return {"base": base, "conjuntos": salida, "ok": ok, "codigo": 0 if ok else 1}
