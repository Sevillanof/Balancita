"""Read-only: the event-by-event export of the signal analyzer (``GET /analyzer/events``).

The file ``<data_dir>/analyzer/events.json`` is written by the lab (``research/vectorbt/event_trades.py``, schema
``balancita.analyzer-events.v1``), never by this module. If it does not exist or is not valid, the answer says why and
gives the exact command to create it. Stdlib only.
"""

import json
import os

SCHEMA = "balancita.analyzer-events.v1"
RELATIVE = os.path.join("analyzer", "events.json")


def events_path(data_dir):
    return os.path.join(data_dir, RELATIVE)


def command(python, data_dir):
    practice = os.path.join(data_dir, "practice")
    return ("{python} -m research.vectorbt.event_trades --datasets {p}/PF_XBTUSD {p}/PF_ETHUSD {p}/PF_SOLUSD --out {out}"
            .format(python=python, p=practice, out=events_path(data_dir)))


def read_events(data_dir, python):
    """``{"available": True, "data": {...}}`` or ``{"available": False, "reason": ..., "command": ...}``."""
    path = events_path(data_dir)
    cmd = command(python, data_dir)

    def missing(reason):
        return {"available": False, "reason": reason, "command": cmd}

    if not os.path.exists(path):
        return missing("Todavía no se generó el detalle de eventos del analizador.")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return missing("El archivo de eventos está roto o no se puede leer; generalo de nuevo.")
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        return missing("El archivo de eventos no tiene el esquema esperado ({}); generalo de nuevo.".format(SCHEMA))
    if not isinstance(data.get("cells"), list) or not isinstance(data.get("events"), dict):
        return missing("El archivo de eventos está incompleto (faltan celdas o eventos); generalo de nuevo.")
    return {"available": True, "data": data}
