"""El ANALISTA DE MOVIMIENTO: regula el TAMAÑO de cada operación del maestro y el portero, solo en las pruebas de /Estrategias.

No decide, no abre la puerta del portero y no cambia salidas: las mismas operaciones, con más peso cuando el mercado se mueve.
«Con movimiento» = la volatilidad realizada de las últimas 24 h (raíz de la suma de los cuadrados de los retornos de 5 min) está
en o por encima de la MEDIANA de sus últimos 90 días (percentil >= 0,5, medido hora a hora con lo que ya estaba publicado).

- ``apagado``: tamaño 1 siempre. Es lo que opera en paper (``DEFAULT``): sin el modo, nada cambia, ni los números ni la identidad.
- ``suave``: tamaño 1,25 con movimiento y 0,75 en calma.
- ``fuerte``: tamaño 1,5 con movimiento y 0,5 en calma.

Medido en 4 años de ETH (informe ``analisis/analista-movimientos/acelerador/informe.md``): +14.146 pb la base, +19.247 con suave y
+24.349 con fuerte. Sin dato suficiente de los 90 días la operación entra con tamaño 1 (y se marca «sin dato»).
"""

import bisect
import math
import os

ENV = "QWEN_ANALISTA"
DEFAULT = "apagado"
# modo -> (tamaño con movimiento, tamaño en calma); el 1,0 / 1,0 del apagado no se declara en la config
MODES = {"apagado": (1.0, 1.0), "suave": (1.25, 0.75), "fuerte": (1.5, 0.5)}
HOUR_MS = 3_600_000
BAR_MS = 5 * 60_000
LOOKBACK_H = 2160                      # 90 días de horas
MIN_H = 1080                           # con menos de 45 días de historia no hay percentil
RV_H = 24
THRESHOLD = 0.5                        # percentil 0,5 = la mediana de 90 días
EXTRA_DAYS = 100                       # historia que hay que leer antes del calentamiento para tener los 90 días
SCHEMA = "balancita-qwen-analista.v1"


def mode(value, name="analista"):
    """Un modo válido (``apagado`` donde falta)."""
    if value in (None, ""):
        return DEFAULT
    if value not in MODES:
        raise ValueError("{}: tiene que ser {}".format(name, ", ".join(MODES)))
    return value


def from_env(env=None):
    env = os.environ if env is None else env
    return mode(env.get(ENV))


def env_for(value=None):
    """La variable de entorno que le pasa el modo al proceso de la prueba (vacía cuando es el de paper)."""
    return {ENV: mode(value)}


def apply_env(cfg, env=None):
    """La config con ``analista`` si la variable pide otro modo que el de paper (si no, la misma: misma identidad)."""
    got = from_env(env)
    return cfg if got == DEFAULT else dict(cfg, analista={"modo": got})


def sizes_of(cfg):
    """``(con movimiento, en calma)`` de la config, o ``None`` cuando el analista está apagado."""
    got = mode((cfg.get("analista") or {}).get("modo"))
    return None if got == DEFAULT else MODES[got]


def extra_days(cfg):
    """Días de historia que hay que leer antes del calentamiento (0 apagado)."""
    return 0 if sizes_of(cfg) is None else EXTRA_DAYS


def describe(cfg):
    """Lo que usó la prueba, para mostrarlo con el resultado."""
    got = mode((cfg.get("analista") or {}).get("modo"))
    big, small = MODES[got]
    return {"schema": SCHEMA, "modo": got, "actual": DEFAULT, "tamano_con_movimiento": big, "tamano_en_calma": small,
            "regla": "volatilidad de 24 h en o sobre su mediana de 90 días"}


class Movement:
    """Para cada hora completa: ¿la volatilidad de 24 h está en o sobre su mediana de 90 días? (``None``: sin historia)."""

    def __init__(self, bars=()):
        self.by_hour = {}
        self._prev = None
        self.first_hour = None
        self.last_hour = None
        self._cursor_hour = None
        self._window = []
        self._order = []
        self._sums = []
        self.percentile = {}
        for bar in bars:
            self.add_bar(bar)
        if self.last_hour is not None:
            self._advance(self.last_hour)

    def add_bar(self, bar):
        """Agrega una vela cerrada de 5 min a la serie horaria."""
        close = float(bar["close"])
        if self._prev is not None and self._prev > 0 and close > 0:
            hour = int(bar["bucket_start"]) // HOUR_MS
            self.by_hour[hour] = self.by_hour.get(hour, 0.0) + math.log(close / self._prev) ** 2
            if self.first_hour is None or hour < self.first_hour:
                self.first_hour = hour
            if self.last_hour is None or hour > self.last_hour:
                self.last_hour = hour
        self._prev = close

    def _advance(self, target_hour):
        if self.first_hour is None or self.last_hour is None:
            return
        limit = min(target_hour, self.last_hour)
        start = self.first_hour if self._cursor_hour is None else self._cursor_hour + 1
        for hour in range(start, limit + 1):
            self._sums.append(self.by_hour.get(hour, 0.0))
            self._cursor_hour = hour
            if len(self._sums) < RV_H // 2:
                continue
            rv = math.sqrt(math.fsum(self._sums[-RV_H:]))
            if len(self._order) == LOOKBACK_H:
                old = self._order.pop(0)
                del self._window[bisect.bisect_left(self._window, old)]
            self._order.append(rv)
            bisect.insort(self._window, rv)
            if len(self._window) >= MIN_H:
                below = bisect.bisect_left(self._window, rv)
                equal = bisect.bisect_right(self._window, rv) - below
                self.percentile[hour] = (below + (equal + 1) / 2.0) / len(self._window)

    def at(self, t_ms):
        """El percentil de la última hora completa antes de ``t_ms`` (``None`` sin historia)."""
        target = t_ms // HOUR_MS - 1
        if self._cursor_hour is None or target > self._cursor_hour:
            self._advance(target)
        return self.percentile.get(target)

    def active(self, t_ms):
        pct = self.at(t_ms)
        return None if pct is None else pct >= THRESHOLD


def multiplier(cfg, movement, t_ms):
    """El multiplicador de tamaño en ``t_ms`` (``1.0`` cuando el analista está apagado o no hay historia suficiente)."""
    sizes = sizes_of(cfg)
    if sizes is None or movement is None:
        return 1.0
    active = movement.active(t_ms)
    if active is None:
        return 1.0
    return sizes[0] if active else sizes[1]


def sized(cfg, operation, movement, t_ms):
    """La operación con el tamaño del analista: ``neto_bp`` de cada lado pesa por el tamaño (``neto_bp_propio`` es el sin pesar)."""
    sizes = sizes_of(cfg)
    if sizes is None or operation is None:
        return operation
    active = movement.active(t_ms) if movement is not None else None
    mult = multiplier(cfg, movement, t_ms)
    out = dict(operation, movimiento=active, tamano=mult)
    for side in ("largo", "corto"):
        inner = dict(operation[side])
        inner["neto_bp_propio"] = inner["neto_bp"]
        inner["neto_bp"] = inner["neto_bp"] * mult
        out[side] = inner
    return out


def split(items, side_of):
    """Operaciones y neto SIN pesar de las entradas con movimiento y en calma: ``{"con": .., "calma": .., "sin_dato": ..}``."""
    out = {key: {"n": 0, "neto_propio_bp": 0.0} for key in ("con", "calma", "sin_dato")}
    for row, side in items:
        moving = (row.get("operacion") or {}).get("movimiento")
        if moving is None:
            key = "sin_dato"
        else:
            key = "con" if moving else "calma"
        inner = side_of(row, side)
        out[key]["n"] += 1
        out[key]["neto_propio_bp"] += inner.get("neto_bp_propio", inner["neto_bp"])
    return out
