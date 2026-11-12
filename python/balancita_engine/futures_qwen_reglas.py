"""DOS REGLAS DE ENTRADA DEL MAESTRO (Fran, 12-nov-2026; ``analisis/maestro-paso-a-paso-12nov``). Solo ETH, solo paper, apagadas por defecto.

* ``no_vender_subida_30d`` (regla A): el maestro no abre ventas (entradas CORTO) cuando el cierre de la última vela cerrada está
  ``SUBIDA_MIN`` (10 %) o más por encima del cierre de la vela que cerró 30 días antes. No toca compras, salidas, rebotes ni noticias.
  Sin 30 días de historia no bloquea. La historia sale de ``analista.Movement`` (la lee desde 100 días antes del calentamiento).
* ``sumar_lugares_60min`` (regla B): con alguna posición del maestro abierta, otra del mismo lado entra aunque la señal no se haya apagado
  (se quita el bloqueo ``mismo_episodio``), pero solo si la posición más reciente de ese lado entró hace ``SEPARACION_MIN`` (60) minutos o más.

Sin la clave ``reglas_maestro`` (o con las dos en ``apagado``) todo funciona EXACTAMENTE como antes. Valores fijos: no son perillas.
Los motivos de bloqueo nuevos son ``subida_30d`` y ``separacion_60min`` (los registra el auditor).
"""

DAY_MS = 86_400_000
MINUTE_MS = 60_000
SUBIDA_DIAS = 30
SUBIDA_MIN = 0.10
SEPARACION_MIN = 60
CLAVES = ("no_vender_subida_30d", "sumar_lugares_60min")
ESTADOS = ("apagado", "prendido")
KIND_SUBIDA, KIND_SEPARACION = "subida_30d", "separacion_60min"


def settings(cfg):
    """``{"A": bool, "B": bool}`` de una config; sin la clave, las dos apagadas."""
    raw = (cfg or {}).get("reglas_maestro")
    if raw is None:
        return {"A": False, "B": False}
    if not isinstance(raw, dict) or set(raw) - set(CLAVES):
        raise ValueError("reglas_maestro: lleva {}".format(", ".join(CLAVES)))
    for clave, valor in raw.items():
        if valor not in ESTADOS:
            raise ValueError("reglas_maestro.{}: tiene que ser {}".format(clave, " o ".join(ESTADOS)))
    return {"A": raw.get("no_vender_subida_30d") == "prendido", "B": raw.get("sumar_lugares_60min") == "prendido"}


def subida_30d(last_close, past_close):
    """``cierre / cierre de hace 30 días - 1``, o ``None`` sin los dos precios."""
    if not last_close or not past_close or past_close <= 0:
        return None
    return last_close / past_close - 1.0


def vende_bloqueada(rise):
    """True cuando la subida de 30 días alcanza el 10 % (la regla A veta la venta)."""
    return rise is not None and rise >= SUBIDA_MIN - 1e-12


def lugar_reciente(positions, side_name, t_ms):
    """True cuando alguna posición abierta del maestro de ese lado entró hace menos de ``SEPARACION_MIN`` minutos (regla B)."""
    return any(p.side == side_name and t_ms - p.entry_ms < SEPARACION_MIN * MINUTE_MS for p in positions)
