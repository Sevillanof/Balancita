"""VARIAS POSICIONES EN PARALELO y EXPERTO REBOTES (Fran, 2-nov-2026; ``analisis/mejorar-maestro/dos-operaciones`` parte B y
``analisis/mejorar-maestro/rebotes-tabla``).

Hasta ``max`` (3) posiciones abiertas a la vez en ETH. Cada una usa ``fraccion`` (33 %) del saldo de la cuenta en el momento de abrir,
limitada por el saldo libre (saldo menos lo ya comprometido por las abiertas, con la comisión de entrada reservada): la exposición total
nunca supera el saldo, nunca se apuesta el doble y no hay apalancamiento. El analista de movimiento solo puede ACHICAR una posición (flojo ×0,5): el «fuerte»
×1,5 queda topado en UN lugar (saldo × ``fraccion``), así ``max`` × ``fraccion`` ≤ 1 alcanza siempre (tope-por-lugar, ``Trader._open``). Los cupos los COMPARTEN dos orígenes:

* el MAESTRO (maestro fuerte + portero sí, o noticia habilitada: igual que siempre). Sin posiciones del maestro abiertas entra como hoy;
  con alguna abierta, solo abre otra en un EPISODIO NUEVO de la señal (la mirada anterior no tenía señal de entrada de ese lado), nunca
  más de una entrada por mirada, y nunca del lado contrario a una posición del maestro abierta;
* el EXPERTO REBOTES (solo ETH, solo largo): al cerrar una vela de 5 min el cierre está ``caida_pct`` (5 %) o más por debajo del máximo
  de los cierres de la ventana (60 min), y la vela anterior todavía no lo estaba (borde de subida) → compra a mercado, sin consultar al
  maestro ni al portero, salida a las ``salida_min`` (240) sin stop ni toma de ganancia, y ``enfriamiento_min`` (240) entre disparos.
  Es la definición del ``analizador.py`` de ``rebotes-tabla`` (máximo → cierre dentro de la ventana, evento al cerrar la vela).

Decisión: una posición larga del rebote y una corta del maestro PUEDEN convivir (el lado contrario solo se bloquea entre posiciones del
mismo origen: el rebote es una apuesta corta en el tiempo que no depende del maestro). Lo único que comparten es el cupo y el saldo.

Con ``max`` = 1 y sin ``rebotes`` todo funciona EXACTAMENTE como antes y la config conserva su identidad (``config_hash``). El mismo código
lo usan el paper vivo y las pruebas de /Estrategias; la opción de la prueba viaja por ``QWEN_POSICIONES`` y ``QWEN_REBOTES``.
"""

import os

ENV, ENV_REBOTES = "QWEN_POSICIONES", "QWEN_REBOTES"
DEFAULT_MAX = 1
LIMIT = 3
DEFAULT_FRACTION = 0.33
DEFAULT_REBOTES = {"caida_pct": 5.0, "ventana_min": 60, "salida_min": 240, "enfriamiento_min": 240}
REBOTE_REASON = "rebote"
REBOTE_PRODUCT = "PF_ETHUSD"


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("{}: tiene que ser un número entero".format(name))
    try:
        out = int(value)
    except ValueError:
        raise ValueError("{}: tiene que ser un número entero".format(name)) from None
    if not low <= out <= high:
        raise ValueError("{}: tiene que estar entre {} y {}".format(name, low, high))
    return out


def count(value, name="posiciones"):
    """Cantidad máxima de posiciones: entero de 1 a 3 (1 donde falta)."""
    return DEFAULT_MAX if value in (None, "") else _integer(value, name, 1, LIMIT)


def settings(cfg):
    """``{"max", "fraccion", "espera_min"}`` de una config. Sin la clave (o con max 1): una sola posición con todo el saldo."""
    raw = (cfg or {}).get("posiciones")
    if raw is None:
        return {"max": 1, "fraccion": 1.0, "espera_min": 0}
    if not isinstance(raw, dict) or set(raw) - {"max", "fraccion", "espera_entre_entradas_min"}:
        raise ValueError("posiciones: lleva 'max' y 'fraccion'")
    maximum = count(raw.get("max", DEFAULT_MAX), "posiciones.max")
    if maximum == 1:
        return {"max": 1, "fraccion": 1.0, "espera_min": 0}
    fraction = raw.get("fraccion", DEFAULT_FRACTION)
    if isinstance(fraction, bool) or not isinstance(fraction, (int, float)) or not 0 < fraction <= 1 / 1:
        raise ValueError("posiciones.fraccion: tiene que ser mayor que 0 y no más de 1")
    if fraction * maximum > 1.0 + 1e-9:
        raise ValueError("posiciones.fraccion: {} lugares de {} superan el saldo".format(maximum, fraction))
    return {"max": maximum, "fraccion": float(fraction), "espera_min": _integer(raw.get("espera_entre_entradas_min", 0),
                                                                              "posiciones.espera_entre_entradas_min", 0, 1440)}


def rebotes_of(cfg):
    """Los parámetros del experto rebotes, o ``None`` si no está encendido."""
    raw = (cfg or {}).get("rebotes")
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) - set(DEFAULT_REBOTES):
        raise ValueError("rebotes: lleva {}".format(", ".join(DEFAULT_REBOTES)))
    out = dict(DEFAULT_REBOTES, **raw)
    if not 0 < float(out["caida_pct"]) < 100:
        raise ValueError("rebotes.caida_pct: tiene que estar entre 0 y 100")
    out["ventana_min"] = _integer(out["ventana_min"], "rebotes.ventana_min", 5, 24 * 60)
    out["salida_min"] = _integer(out["salida_min"], "rebotes.salida_min", 5, 48 * 60)
    out["enfriamiento_min"] = _integer(out["enfriamiento_min"], "rebotes.enfriamiento_min", 0, 48 * 60)
    if out["ventana_min"] % 5:
        raise ValueError("rebotes.ventana_min: múltiplo de 5 minutos")
    out["caida_pct"] = float(out["caida_pct"])
    return out


def with_positions(cfg, maximum, rebotes=None):
    """La misma config con ``maximum`` posiciones (1 la deja sin la clave) y, si ``rebotes`` es verdadero, el experto rebotes."""
    out = dict(cfg)
    maximum = count(maximum)
    if maximum == 1:
        out.pop("posiciones", None)
    else:
        out["posiciones"] = {"max": maximum, "fraccion": DEFAULT_FRACTION if maximum == 3 else round(1 / maximum, 4),
                             "espera_entre_entradas_min": 0}
    if rebotes is not None:
        if rebotes:
            out["rebotes"] = dict(DEFAULT_REBOTES)
        else:
            out.pop("rebotes", None)
    return out


def from_env(env=None):
    env = os.environ if env is None else env
    return count(env.get(ENV))


def rebotes_from_env(env=None):
    env = os.environ if env is None else env
    value = env.get(ENV_REBOTES)
    if value in (None, ""):
        return None
    if value not in ("0", "1"):
        raise ValueError("rebotes: tiene que ser 0 o 1")
    return value == "1"


def env_for(posiciones=None, rebotes=None):
    """Las variables de entorno que le pasan la cantidad y el rebote al proceso de la prueba."""
    if posiciones is None and rebotes is None:      # nada pedido: la prueba usa lo que dice la config
        return {}
    return {ENV: str(count(posiciones)), ENV_REBOTES: "1" if rebotes in (True, 1, "1", "encendido") else "0"}


def apply_env(cfg, env=None):
    """Lo que pide el entorno de la prueba reemplaza lo de la config; sin variables se conserva la de la config."""
    env = os.environ if env is None else env
    if ENV not in env and ENV_REBOTES not in env:
        return cfg
    maximum = from_env(env) if ENV in env else settings(cfg)["max"]
    return with_positions(cfg, maximum, rebotes_from_env(env))


def describe(cfg):
    """Lo que usó la prueba, para mostrarlo con el resultado (``None`` con una sola posición y sin rebotes)."""
    got, rebotes = settings(cfg), rebotes_of(cfg)
    if got["max"] == 1 and rebotes is None:
        return None
    return {"max": got["max"], "fraccion": got["fraccion"], "rebotes": rebotes}
