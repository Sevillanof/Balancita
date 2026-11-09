"""The funding cache file ``funding-{product}.json`` and where its directory comes from.

Two small, side-effect-free pieces so that the cache directory can be injected and the file is never seen half written:

* ``default_cache_dir(fallback)``: the directory named by ``BALANCITA_QWEN_CACHE_DIR`` when it is set and not empty, else
  ``fallback``. ``scripts/ci_python_run.py`` sets it to a fresh temp directory per worker so that unittest processes that run
  side by side never share ``data/qwen-trader/cache``. Production never sets it, so nothing changes there.
* ``write_rows_atomic(path, rows)``: temp file in the same directory + ``os.replace``; same JSON (a list of ``[start_ms, rate]``)
  as ``json.dump`` of the rows into the final path, but a concurrent reader sees the old file or the new one, never a truncated one.

``futures_qwen_trader`` does not import this module yet; wiring it is two lines there (``DEFAULT_CACHE`` and ``History.funding``).
"""
import json
import os
import tempfile

CACHE_DIR_ENV = "BALANCITA_QWEN_CACHE_DIR"


def default_cache_dir(fallback, environ=None):
    """``$BALANCITA_QWEN_CACHE_DIR`` if set and not empty, else ``fallback``."""
    value = (os.environ if environ is None else environ).get(CACHE_DIR_ENV)
    return value if value else fallback


def read_rows(path):
    """The rows of a funding cache file, or ``None`` when the file does not exist."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_rows_atomic(path, rows):
    """Write ``rows`` to ``path`` so that no reader ever sees a partial file; creates the directory."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=directory, prefix=".funding-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(rows, out)
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
