"""La EXIGENCIA del maestro y del portero, de 0 a 10, solo para las pruebas de /Estrategias.

0 = lo menos exigente (entran más operaciones), 10 = lo más exigente. El nivel 5 es EXACTAMENTE lo que opera en paper (los
archivos ``qwen-lora-maestro.json`` y ``qwen-portero.json``): con 5 y 5 no cambia nada, ni los números ni la identidad de la
base de la prueba. Otro nivel mueve un solo número de la fórmula, solo dentro de la prueba:

- MAESTRO: desde qué puntaje una señal cuenta como FUERTE (``umbrales.fuerte``). Se mueve en proporción a la parte de las señales
  que quedan como fuertes (cola de una normal de la mitad: 50 % en el 0, 20 % en el 5 que es la de paper, 2 % en el 10). Nunca baja
  del umbral de «flojo». La salida (el maestro se da vuelta, al menos flojo) no cambia.
- PORTERO: desde qué probabilidad «conviene entrar» (``umbral``). El 0 dice siempre que sí; del 1 al 10 sube desde el de paper en pasos
  medidos sobre las señales fuertes de ETH y BTC de la práctica (2025-10-01 a 2026-04-18): dice que sí al 70, 55, 40, 28 %, al ~19 %
  (el 5, paper), y al 13, 8, 4, 2 y 0,7 % de ellas. Sus probabilidades están muy juntas (entre 0,62 y 0,74 el 80 % de las veces), así que
  una escala lineal dejaría los niveles altos sin una sola operación.

Nada de esto toca lo que opera en vivo ni los parámetros de riesgo: ``formulas`` solo lo aplica si la config trae ``exigencia``.
"""

import copy
import math
import os
from statistics import NormalDist

ENV_MAESTRO, ENV_PORTERO = "QWEN_EXIGENCIA_MAESTRO", "QWEN_EXIGENCIA_PORTERO"
DEFAULT = 5                                               # el nivel de lo que opera en paper
MAX = 10
STRONG_SHARE = [0.50, 0.40, 0.33, 0.28, 0.24, 0.20, 0.16, 0.12, 0.08, 0.05, 0.02]   # parte de señales fuertes por nivel
# Corrimiento del umbral del portero respecto del de paper, en logit, por nivel (el 0 no usa umbral: dice siempre que sí).
PORTERO_LOGIT = [None, -0.228, -0.178, -0.122, -0.059, 0.0, 0.064, 0.152, 0.263, 0.367, 0.525]
SCHEMA = "balancita-qwen-exigencia.v1"


def level(value, name="exigencia"):
    """Un nivel entero de 0 a 10."""
    try:
        out = int(value)
    except (TypeError, ValueError):
        raise ValueError("{}: tiene que ser un número entero de 0 a {}".format(name, MAX)) from None
    if not 0 <= out <= MAX or (isinstance(value, float) and value != out):
        raise ValueError("{}: tiene que ser un número entero de 0 a {}".format(name, MAX))
    return out


def levels(maestro=None, portero=None):
    """``{"maestro": n, "portero": n}`` con el 5 donde falta."""
    return {"maestro": DEFAULT if maestro in (None, "") else level(maestro, "maestro"),
            "portero": DEFAULT if portero in (None, "") else level(portero, "portero")}


def from_env(env=None):
    env = os.environ if env is None else env
    return levels(env.get(ENV_MAESTRO), env.get(ENV_PORTERO))


def env_for(maestro=None, portero=None):
    """Las variables de entorno que le pasan los niveles al proceso de la prueba."""
    got = levels(maestro, portero)
    return {ENV_MAESTRO: str(got["maestro"]), ENV_PORTERO: str(got["portero"])}


def is_default(got):
    return got["maestro"] == DEFAULT and got["portero"] == DEFAULT


def apply_env(cfg, env=None):
    """La config con ``exigencia`` si las variables piden otro nivel que el de paper (si no, la misma: misma identidad)."""
    got = from_env(env)
    return cfg if is_default(got) else dict(cfg, exigencia=got)


def _z(share):
    return NormalDist().inv_cdf(1.0 - share / 2.0)


def maestro_fuerte(teacher, lvl):
    """El umbral de «fuerte» del maestro en el nivel ``lvl`` (5 = el del archivo; nunca por debajo de «flojo»)."""
    base, weak = teacher["umbrales"]["fuerte"], teacher["umbrales"]["flojo"]
    return max(weak, base * _z(STRONG_SHARE[lvl]) / _z(STRONG_SHARE[DEFAULT]))


def portero_umbral(keeper, lvl):
    """El umbral del portero en el nivel ``lvl`` (5 = el del archivo; 0 = dice siempre que sí)."""
    if lvl == 0:
        return 0.0
    base = keeper["umbral"]
    z = math.log(base / (1.0 - base)) + PORTERO_LOGIT[lvl]
    return 1.0 / (1.0 + math.exp(-z))


def apply(teacher, keeper, got):
    """Copias del maestro y del portero con los umbrales de esos niveles (los originales no se tocan)."""
    teacher, keeper = copy.deepcopy(teacher), copy.deepcopy(keeper)
    teacher["umbrales"]["fuerte"] = round(maestro_fuerte(teacher, got["maestro"]), 6)
    keeper["umbral"] = round(portero_umbral(keeper, got["portero"]), 6)
    return teacher, keeper


def describe(teacher, keeper, got):
    """Lo que usó la prueba, para mostrarlo con el resultado: niveles, umbrales y la marca del nivel de paper."""
    return {"schema": SCHEMA, "maestro": got["maestro"], "portero": got["portero"], "actual": DEFAULT,
            "maestro_fuerte": round(maestro_fuerte(teacher, got["maestro"]), 4),
            "maestro_fuerte_paper": teacher["umbrales"]["fuerte"],
            "maestro_partes_fuertes": STRONG_SHARE[got["maestro"]],
            "portero_umbral": round(portero_umbral(keeper, got["portero"]), 4), "portero_umbral_paper": keeper["umbral"]}


def scale(teacher, keeper):
    """Los 11 niveles de cada uno, para dibujar el control con la marca del nivel de paper."""
    return {"actual": DEFAULT,
            "maestro": [{"nivel": n, "fuerte": round(maestro_fuerte(teacher, n), 4), "partes_fuertes": STRONG_SHARE[n]}
                        for n in range(MAX + 1)],
            "portero": [{"nivel": n, "umbral": round(portero_umbral(keeper, n), 4)} for n in range(MAX + 1)]}

