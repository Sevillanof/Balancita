"""Archivo Parquet a largo plazo (fase 1): exportador OFFLINE desde una COPIA de SQLite, manifiesto, verificacion, lector y busqueda.

No borra nada en SQLite, no toca la captura ni ninguna lectura existente. Solo ``formato.py`` importa ``pyarrow`` (opcional, fijado con
hashes en un entorno aparte; ver docs/archivo-parquet.md). Guardado por python/tests/test_archivo_parquet_aislamiento.py.
"""
