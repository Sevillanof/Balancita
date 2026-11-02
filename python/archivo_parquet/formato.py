"""Unico modulo que importa pyarrow (opcional, fijado con hashes, entorno aparte). Sin pyarrow, usarlo lanza ``ParquetNoDisponible``.

Formato 2: un archivo por periodo y tabla, ordenado por clave (declarado en ``sorting_columns``), un grupo de filas por valor de ``grupo_por``
(el producto) con tope por tabla, zstd con el nivel de la tabla, diccionario SOLO en las columnas que lo piden, estadisticas desactivadas en
JSON/texto largo, indice de paginas y checksum de paginas, tiempos int64 ms y texto sin reinterpretar. Todas las columnas son nullable en el archivo
(un NULL inesperado no tira el dia; el exportador lo avisa). Metadatos: ``sqlite_ddl``, ``schema_version``, ``formato_version``, ``clave``, derivadas.
pyarrow 21 no tiene bloom filters. Lee con verificacion de checksum de paginas.
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


class ParquetNoDisponible(RuntimeError):
    """pyarrow no esta instalado en este interprete."""


def disponible() -> bool:
    return pq is not None


def version() -> str:
    return pa.__version__ if pa is not None else "no disponible"


def _necesita() -> None:
    if pq is None:
        raise ParquetNoDisponible("pyarrow no esta instalado; use el entorno aparte (ver docs/archivo-parquet.md)")


def _tipo_arrow(tipo: str):
    return {"int": pa.int64(), "text": pa.string(), "real": pa.float64(), "blob": pa.binary(), "mixto": pa.string()}[tipo]


def _campos(cfg: TablaConfig, legado: bool = False):
    """(nombre, tipo Arrow, diccionario, estadisticas, byte_stream_split) de cada columna del archivo, en orden."""
    out = [(c.nombre, _tipo_arrow(c.tipo), c.diccionario, c.estadisticas, c.byte_stream_split) for c in cfg.columnas]
    if legado:
        return out
    out += [("tipo_" + c.nombre, pa.string(), True, True, False) for c in cfg.columnas if c.tipo == "mixto"]
    out += [(d.nombre, pa.int64() if d.tipo == "int" else pa.string(), d.diccionario, True, False) for d in cfg.derivadas]
    return out


def _esquema(cfg: TablaConfig, legado: bool = False):
    """Todas las columnas nullable, aunque SQLite diga NOT NULL: un NULL inesperado se guarda y se avisa, no tira el periodo."""
    return pa.schema([pa.field(n, t, nullable=True) for n, t, *_ in _campos(cfg, legado)])


def filas_por_grupo(cfg: TablaConfig) -> int:
    """Tope de filas por grupo de esa tabla: el de su configuracion (chico si las filas son pesadas) o el general."""
    return cfg.filas_por_grupo or FILAS_POR_GRUPO


def lote_de(cfg: TablaConfig) -> int:
    """Filas por lote al leer SQLite o releer el archivo: nunca mas que un grupo (con filas de 1 MB, 50.000 filas serian 50 GB)."""
    return min(LOTE_LECTURA, filas_por_grupo(cfg))


def _opciones_escritura(cfg: TablaConfig) -> dict:
    campos = _campos(cfg)
    dicc = [n for n, _, d, _, _ in campos if d]
    stats = [n for n, _, _, s, _ in campos if s]
    bss = [n for n, _, _, _, b in campos if b]
    nombres = [n for n, *_ in campos]
    op = {
        "compression": COMPRESION, "compression_level": cfg.nivel_zstd,
        "use_dictionary": dicc if dicc else False,
        "write_statistics": True if len(stats) == len(nombres) else (stats if stats else False),
        "write_page_index": True, "write_page_checksum": True,
        "sorting_columns": [pq.SortingColumn(nombres.index(c)) for c in cfg.clave],
    }
    if bss:
        op["use_byte_stream_split"] = bss
    if cfg.pagina_bytes:
        op["data_page_size"] = cfg.pagina_bytes
    return op


def escribir(ruta: str, cfg: TablaConfig, lotes: Iterator[List[tuple]], metadatos: dict) -> int:
    """Escribe ``ruta`` con las filas del archivo (ya ordenadas por clave; ver ``util.a_archivo``). Devuelve la cantidad de filas.

    Un grupo de filas por cambio de ``grupo_por`` (un producto), partido en trozos de ``filas_por_grupo`` si hace falta.
    """
    _necesita()
    esquema = _esquema(cfg).with_metadata({k: str(v) for k, v in metadatos.items()})
    idx_grupo = [cfg.nombres.index(c) for c in cfg.grupo_por]
    tope = filas_por_grupo(cfg)
    campos = _campos(cfg)
    total = 0
    pendiente: List[tuple] = []
    clave_actual = None

    def vaciar(writer, filas):
        columnas = list(zip(*filas))
        tabla = pa.table({n: pa.array(columnas[i], t) for i, (n, t, *_) in enumerate(campos)}, schema=esquema)
        writer.write_table(tabla, row_group_size=len(filas))

    with pq.ParquetWriter(ruta, esquema, **_opciones_escritura(cfg)) as writer:
        for lote in lotes:
            for fila in lote:
                total += 1
                k = tuple(fila[i] for i in idx_grupo)
                if pendiente and (k != clave_actual or len(pendiente) >= tope):
                    vaciar(writer, pendiente)
                    pendiente = []
                clave_actual = k
                pendiente.append(fila)
        if pendiente:
            vaciar(writer, pendiente)
    return total


def leer_filas(ruta: str, cfg: TablaConfig, legado: bool = False) -> Iterator[List[tuple]]:
    """Relee el archivo entero por lotes con verificacion de checksum de paginas. Lanza si algo no es integro.

    Devuelve filas del archivo (columnas de SQLite, ``tipo_*``, ``j_*``); ``legado=True`` para los archivos del formato 1 (solo las de SQLite).
    """
    _necesita()
    pf = pq.ParquetFile(ruta, page_checksum_verification=True)
    esperado = cfg.nombres if legado else cfg.nombres_archivo
    if tuple(pf.schema_arrow.names) != esperado:
        raise ValueError("columnas inesperadas en %s" % ruta)
    for lote in pf.iter_batches(batch_size=lote_de(cfg)):
        yield list(zip(*[col.to_pylist() for col in lote.columns]))


def metadatos(ruta: str) -> dict:
    _necesita()
    pf = pq.ParquetFile(ruta)
    meta = {k.decode(): v.decode() for k, v in (pf.schema_arrow.metadata or {}).items()}
    rg = pf.metadata.row_group(0) if pf.metadata.num_row_groups else None
    col = rg.column(0) if rg else None
    orden = None
    if rg is not None:
        try:
            orden = [(sc.column_index, sc.descending) for sc in rg.sorting_columns]
        except Exception:  # noqa: BLE001 - versiones sin sorting_columns
            orden = None
    return {"schema": meta, "filas": pf.metadata.num_rows, "grupos": pf.metadata.num_row_groups,
            "compresion": col.compression.lower() if col else None,
            "estadisticas": bool(col and col.statistics is not None and col.statistics.has_min_max),
            # indice de paginas: offset index en todas las columnas (permite saltar paginas) y column index (min/max) en las que tienen estadisticas
            "indice_paginas": bool(rg is not None and all(rg.column(j).has_offset_index for j in range(rg.num_columns))
                                   and any(rg.column(j).has_column_index for j in range(rg.num_columns))),
            "sorting_columns": orden,
            "columnas": list(pf.schema_arrow.names)}


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
    """Busca en esos archivos. Devuelve (tabla pyarrow, informe) con los grupos de filas que las estadisticas dejaron leer y sus bytes.

    Los archivos del formato 1 no tienen las columnas ``j_*``: se piden como nulas, y filtrar por ellas en esos archivos da error claro.
    """
    _necesita()
    todas = list(cfg.nombres_archivo)
    cols = list(columnas) if columnas else list(cfg.nombres) + [d.nombre for d in cfg.derivadas]
    for c in cols + list((donde or {}).keys()):
        if c not in todas:
            raise ValueError("columna desconocida: %s" % c)
    esquema_completo = _esquema(cfg)
    expr = _expresion(cfg, desde_ms, hasta_ms, producto, donde)
    informe = {"archivos": len(rutas), "grupos_total": 0, "grupos_leidos": 0, "bytes_leidos": 0, "filas_devueltas": 0}
    partes = []
    restante = limite
    tipos_salida = pa.schema([esquema_completo.field(c) for c in cols])
    for ruta in rutas:
        pf = pq.ParquetFile(ruta)
        informe["grupos_total"] += pf.metadata.num_row_groups
        if restante is not None and restante <= 0:
            continue
        propias = pf.schema_arrow
        for c in (donde or {}):
            if c not in propias.names:
                raise ValueError("%s es de un formato anterior y no tiene la columna %s (re-exportarlo la agrega)" % (ruta, c))
        presentes = [c for c in cols if c in propias.names]
        tocadas = set(presentes) | {cfg.tiempo} | ({cfg.producto} if producto is not None else set()) | set((donde or {}).keys())
        frag = ds.ParquetFileFormat().make_fragment(ruta, filesystem=pafs.LocalFileSystem())
        for sub in frag.split_by_row_group(filter=expr, schema=propias):
            if restante is not None and restante <= 0:
                break
            for rg in sub.row_groups:
                informe["grupos_leidos"] += 1
                meta = pf.metadata.row_group(rg.id)
                for j in range(meta.num_columns):
                    if meta.column(j).path_in_schema in tocadas:
                        informe["bytes_leidos"] += meta.column(j).total_compressed_size
            t = sub.to_table(schema=propias, columns=presentes, filter=expr)
            if restante is not None:
                t = t.slice(0, restante)
                restante -= t.num_rows
            if t.num_rows:
                for c in cols:  # columnas que este archivo no tiene (j_* de un archivo viejo): nulas
                    if c not in t.column_names:
                        t = t.append_column(tipos_salida.field(c), pa.nulls(t.num_rows, tipos_salida.field(c).type))
                partes.append(t.select(cols).cast(tipos_salida))
    vacia = pa.table({c: pa.array([], tipos_salida.field(c).type) for c in cols})
    tabla = pa.concat_tables(partes) if partes else vacia
    informe["filas_devueltas"] = tabla.num_rows
    return tabla, informe
