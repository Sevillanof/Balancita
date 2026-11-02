"""Unico modulo que importa pyarrow (opcional, fijado con hashes, entorno aparte). Sin pyarrow, usarlo lanza ``ParquetNoDisponible``.

Escribe un archivo por dia y tabla: zstd nivel 3, grupos de ~128k filas, ordenado por clave, estadisticas de grupo activas (el filtro salta
bloques), checksum de paginas, tiempos int64 ms y texto sin reinterpretar. Lee con verificacion de checksum de paginas.
"""
from __future__ import annotations

from typing import Iterator, List, Optional, Sequence

from .config import TablaConfig

try:  # pragma: no cover - depende del entorno
    import pyarrow as pa
    import pyarrow.dataset as ds
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq
except ImportError:  # pragma: no cover
    pa = ds = pq = pafs = None

FILAS_POR_GRUPO = 131_072
LOTE_LECTURA = 50_000
COMPRESION = "zstd"
NIVEL = 3


class ParquetNoDisponible(RuntimeError):
    """pyarrow no esta instalado en este interprete."""


def disponible() -> bool:
    return pq is not None


def version() -> str:
    return pa.__version__ if pa is not None else "no disponible"


def _necesita() -> None:
    if pq is None:
        raise ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")


def _esquema(cfg: TablaConfig):
    tipos = {"int": pa.int64(), "text": pa.string(), "real": pa.float64()}
    return pa.schema([pa.field(c.nombre, tipos[c.tipo], nullable=c.nullable) for c in cfg.columnas])


def escribir(ruta: str, cfg: TablaConfig, lotes: Iterator[List[tuple]], metadatos: dict) -> int:
    """Escribe ``ruta`` con las filas (ya ordenadas por clave) que entregan los lotes. Devuelve la cantidad de filas."""
    _necesita()
    esquema = _esquema(cfg).with_metadata({k: str(v) for k, v in metadatos.items()})
    total = 0
    pendiente: List[tuple] = []

    def vaciar(writer, filas):
        columnas = list(zip(*filas))
        tabla = pa.table({c.nombre: pa.array(columnas[i], esquema.field(i).type) for i, c in enumerate(cfg.columnas)}, schema=esquema)
        writer.write_table(tabla, row_group_size=FILAS_POR_GRUPO)

    with pq.ParquetWriter(ruta, esquema, compression=COMPRESION, compression_level=NIVEL, write_statistics=True,
                          write_page_checksum=True) as writer:
        for lote in lotes:
            pendiente.extend(lote)
            total += len(lote)
            while len(pendiente) >= FILAS_POR_GRUPO:
                vaciar(writer, pendiente[:FILAS_POR_GRUPO])
                del pendiente[:FILAS_POR_GRUPO]
        if pendiente:
            vaciar(writer, pendiente)
    return total


def leer_filas(ruta: str, cfg: TablaConfig) -> Iterator[List[tuple]]:
    """Relee el archivo entero por lotes con verificacion de checksum de paginas. Lanza si algo no es integro."""
    _necesita()
    pf = pq.ParquetFile(ruta, page_checksum_verification=True)
    if tuple(pf.schema_arrow.names) != cfg.nombres:
        raise ValueError("columnas inesperadas en %s" % ruta)
    for lote in pf.iter_batches(batch_size=LOTE_LECTURA):
        yield list(zip(*[col.to_pylist() for col in lote.columns]))


def metadatos(ruta: str) -> dict:
    _necesita()
    pf = pq.ParquetFile(ruta)
    meta = {k.decode(): v.decode() for k, v in (pf.schema_arrow.metadata or {}).items()}
    col = pf.metadata.row_group(0).column(0) if pf.metadata.num_row_groups else None
    return {"schema": meta, "filas": pf.metadata.num_rows, "grupos": pf.metadata.num_row_groups,
            "compresion": col.compression.lower() if col else None,
            "estadisticas": bool(col and col.statistics is not None and col.statistics.has_min_max)}


def _expresion(cfg: TablaConfig, desde_ms: int, hasta_ms: int, producto: Optional[str], donde: Optional[dict]):
    e = (ds.field(cfg.tiempo) >= desde_ms) & (ds.field(cfg.tiempo) < hasta_ms)
    if producto is not None:
        if not cfg.producto:
            raise ValueError("la tabla %s no tiene columna de producto" % cfg.nombre)
        e = e & (ds.field(cfg.producto) == producto)
    for col, valor in (donde or {}).items():
        e = e & (ds.field(col) == valor)
    return e


def buscar(rutas: Sequence[str], cfg: TablaConfig, desde_ms: int, hasta_ms: int, producto: Optional[str] = None,
           donde: Optional[dict] = None, columnas: Optional[Sequence[str]] = None, limite: Optional[int] = None):
    """Busca en esos archivos. Devuelve (tabla pyarrow, informe) con los grupos de filas que las estadisticas dejaron leer y sus bytes."""
    _necesita()
    cols = list(columnas) if columnas else list(cfg.nombres)
    for c in cols + list((donde or {}).keys()):
        if c not in cfg.nombres:
            raise ValueError("columna desconocida: %s" % c)
    esquema = _esquema(cfg)
    expr = _expresion(cfg, desde_ms, hasta_ms, producto, donde)
    # columnas que se tocan en disco: las pedidas mas las del filtro
    tocadas = set(cols) | {cfg.tiempo} | ({cfg.producto} if producto is not None else set()) | set((donde or {}).keys())
    informe = {"archivos": len(rutas), "grupos_total": 0, "grupos_leidos": 0, "bytes_leidos": 0, "filas_devueltas": 0}
    partes = []
    restante = limite
    for ruta in rutas:
        pf = pq.ParquetFile(ruta)
        informe["grupos_total"] += pf.metadata.num_row_groups
        if restante is not None and restante <= 0:
            continue
        frag = ds.ParquetFileFormat().make_fragment(ruta, filesystem=pafs.LocalFileSystem())
        for sub in frag.split_by_row_group(filter=expr, schema=esquema):
            if restante is not None and restante <= 0:
                break
            for rg in sub.row_groups:
                informe["grupos_leidos"] += 1
                meta = pf.metadata.row_group(rg.id)
                for j in range(meta.num_columns):
                    if meta.column(j).path_in_schema in tocadas:
                        informe["bytes_leidos"] += meta.column(j).total_compressed_size
            t = sub.to_table(schema=esquema, columns=cols, filter=expr)
            if restante is not None:
                t = t.slice(0, restante)
                restante -= t.num_rows
            if t.num_rows:
                partes.append(t)
    vacia = pa.table({c: pa.array([], esquema.field(c).type) for c in cols})
    tabla = pa.concat_tables(partes) if partes else vacia
    informe["filas_devueltas"] = tabla.num_rows
    return tabla, informe
