"""Linea de comandos: exportar | verificar | buscar | medir. Salida JSON. Codigos: 0 ok, 1 hay dias/archivos sin confirmar, 2 uso o copia invalida."""
from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .config import TABLAS
from .util import ErrorArchivo, parse_tiempo

NO_MAX = 1 << 62


def _tablas(valor: Optional[str]) -> Optional[List[str]]:
    return [t.strip() for t in valor.split(",") if t.strip()] if valor else None


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m archivo_parquet", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("exportar", help="exporta a Parquet los dias UTC cerrados de una COPIA de SQLite")
    e.add_argument("--copia", required=True)
    e.add_argument("--base", required=True)
    e.add_argument("--destino", required=True)
    e.add_argument("--tablas", help="lista separada por comas (%s); por defecto, las que tenga la copia" % ",".join(TABLAS))
    e.add_argument("--dry-run", action="store_true", help="solo lista que se exportaria; no escribe nada")
    e.add_argument("--copia-confirmada", action="store_true", help="la ruta no esta en snapshots/ o backups/ pero ES una copia")
    v = sub.add_parser("verificar", help="revalida el manifiesto contra los archivos")
    v.add_argument("--destino", required=True)
    v.add_argument("--base")
    v.add_argument("--tabla")
    b = sub.add_parser("buscar", help="busca filas: el catalogo elige los archivos y las estadisticas de grupo saltan bloques")
    b.add_argument("--destino", required=True)
    b.add_argument("--base", required=True)
    b.add_argument("--tabla", required=True)
    b.add_argument("--producto")
    b.add_argument("--desde", default="0", help="ms UTC o ISO 8601 (incluido)")
    b.add_argument("--hasta", default=str(NO_MAX), help="ms UTC o ISO 8601 (excluido)")
    b.add_argument("--donde", action="append", default=[], metavar="COLUMNA=VALOR", help="igualdad; se puede repetir (action=LONG)")
    b.add_argument("--columnas", help="lista separada por comas")
    b.add_argument("--limite", type=int, default=100)
    b.add_argument("--duckdb", action="store_true", help="imprime la consulta DuckDB equivalente y no busca")
    m = sub.add_parser("medir", help="tamano SQLite vs Parquet y tiempos de busquedas tipicas")
    m.add_argument("--destino", default="")
    m.add_argument("--base", required=True)
    m.add_argument("--copia")
    m.add_argument("--copia-confirmada", action="store_true")
    m.add_argument("--tablas")
    m.add_argument("--sintetico-dias", type=int, help="crea datos sinteticos (copia y archivo temporales) de N dias y los mide")
    m.add_argument("--productos", type=int, default=4, help="productos sinteticos")
    m.add_argument("--paso-s", type=int, default=60, help="segundos entre filas sinteticas")
    m.add_argument("--repeticiones", type=int, default=3)
    return p


def _imprimir(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def main(argv: Optional[List[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.cmd == "exportar":
            from .exportar import exportar
            rep = exportar(args.copia, args.base, args.destino, _tablas(args.tablas), args.dry_run, args.copia_confirmada,
                           log=lambda m: print(m, file=sys.stderr))
            _imprimir(rep)
            return 1 if rep["no_confirmados"] else 0
        if args.cmd == "verificar":
            from .verificar import verificar
            rep = verificar(args.destino, args.base, args.tabla)
            _imprimir(rep)
            return 1 if rep["problemas"] else 0
        if args.cmd == "buscar":
            from .leer import buscar_archivo, consulta_duckdb
            donde = {}
            for item in args.donde:
                if "=" not in item:
                    raise ErrorArchivo("--donde espera COLUMNA=VALOR, recibio %r" % item)
                c, v = item.split("=", 1)
                donde[c] = v
            desde, hasta = parse_tiempo(args.desde), parse_tiempo(args.hasta)
            cols = [c.strip() for c in args.columnas.split(",")] if args.columnas else None
            if args.duckdb:
                print(consulta_duckdb(args.destino, args.base, args.tabla, desde, hasta, cols, args.producto, donde))
                return 0
            tabla, informe = buscar_archivo(args.destino, args.base, args.tabla, desde, hasta, args.producto, donde, cols, args.limite)
            _imprimir({"informe": informe, "filas": tabla.to_pylist()})
            return 0
        if args.cmd == "medir":
            from .medir import medir
            if not args.sintetico_dias and not args.copia:
                raise ErrorArchivo("medir necesita --copia y --destino, o --sintetico-dias N")
            _imprimir(medir(args.destino, args.base, args.copia, args.copia_confirmada, _tablas(args.tablas), args.sintetico_dias,
                            args.productos, args.paso_s, args.repeticiones))
            return 0
    except ErrorArchivo as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        from .formato import ParquetNoDisponible
        if isinstance(exc, ParquetNoDisponible):
            print("error: %s" % exc, file=sys.stderr)
            return 2
        raise
    return 2
