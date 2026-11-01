"""Salida maker dinámica de paper: una orden límite que espera, sigue al mejor precio y cae a mercado a tiempo.

Máquina de estados pura (diccionarios JSON, sin reloj ni red): la usan igual la Terminal (libro público cada pocos
segundos) y Estrategias (velas de 5 minutos). Nunca envía una orden: solo decide qué haría una orden en papel.

Al decidir cerrar, la orden se deja pasiva en el mejor precio del lado propio (al ask para vender, al bid para comprar,
siempre como «solo maker»). Después, en cada paso:

1. se llena si el mercado llegó a su precio (en velas, solo si lo atraviesa: conservador);
2. sale a mercado si pasó el tiempo máximo;
3. sale a mercado si el precio se alejó en contra más que el tope desde que empezó la espera;
4. en modo ``sigue`` se corre al nuevo mejor precio si el mercado se alejó; en modo ``fija`` queda donde está.

Una emergencia (stop, noticia fuerte, cierre de seguridad, libro caído) la resuelve quien llama: cancela la espera y
sale a mercado de inmediato.
"""

from __future__ import annotations

import os
from decimal import Decimal, localcontext

SCHEMA = "balancita-maker-exit.v1"
MODES = ("fija", "sigue")
# motivos de cierre que pueden esperar como maker; los demás (stop, noticia, fin de bloque, cambio de versión) salen a mercado
ELIGIBLE = frozenset(("formula", "qwen", "tiempo"))
DEFAULT_TTL_MIN = 45
DEFAULT_TOPE_BP = 40
BOOK_GAP_MS = 60_000                 # libro sin respuesta más que esto: al volver, sale a mercado
TEN_THOUSAND = Decimal(10_000)
PRECISION = 28


class MakerExitError(ValueError):
    pass


def settings(cfg):
    """Ajustes de la salida maker de una configuración o ``None`` (salida a mercado como siempre)."""
    raw = (cfg.get("execution") or {}).get("exit") if isinstance(cfg.get("execution"), dict) else None
    raw = raw if raw is not None else cfg.get("salida_maker")
    if raw is None:
        return None
    return validate(raw)


def validate(raw):
    if not isinstance(raw, dict) or set(raw) != {"modo", "ttl_min", "tope_pb"}:
        raise MakerExitError("La salida maker lleva modo, ttl_min y tope_pb.")
    if raw["modo"] not in MODES:
        raise MakerExitError("El modo de la salida maker debe ser fija o sigue.")
    for name in ("ttl_min", "tope_pb"):
        value = raw[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 1000:
            raise MakerExitError("Valor inválido en la salida maker: " + name)
    if not 5 <= raw["ttl_min"] <= 240:
        raise MakerExitError("El tiempo de espera de la salida maker va de 5 a 240 minutos.")
    return {"modo": raw["modo"], "ttl_min": raw["ttl_min"], "tope_pb": raw["tope_pb"]}


ENV = "QWEN_SALIDA"
CHOICES = ("mercado", "fija", "sigue")
DEFAULT_CHOICE = "sigue"             # lo que opera paper


def choice(value=None):
    """Cómo sale una prueba: ``mercado`` (como antes), ``fija`` (orden que espera quieta) o ``sigue`` (paper)."""
    value = DEFAULT_CHOICE if value is None else value
    if value not in CHOICES:
        raise ValueError("La salida de la prueba debe ser mercado, fija o sigue.")
    return value


def env_for(value=None):
    return {ENV: choice(value)}


def apply_env(cfg, env=None):
    """Una salida explícita reemplaza la de la config; sin variable la config queda como está (a mercado en las pruebas)."""
    env = os.environ if env is None else env
    if ENV not in env:
        return cfg
    got = choice(env[ENV])
    out = {k: v for k, v in cfg.items() if k != "salida_maker"}
    if got != "mercado":
        out["salida_maker"] = default_settings(got)
    return out


def describe(cfg, trades):
    """What a test's exits did, for the result panel: how many left as maker, how many fell to market and why."""
    wanted = settings(cfg)
    out = {"modo": "mercado" if wanted is None else wanted["modo"],
           "ttl_min": None if wanted is None else wanted["ttl_min"],
           "tope_pb": None if wanted is None else wanted["tope_pb"],
           "maker": 0, "mercado_tiempo": 0, "mercado_tope": 0, "mercado_emergencia": 0, "mercado": 0,
           "comision_ahorrada_usd": "0"}
    saved = Decimal(0)
    for trade in trades:
        plan = trade.get("exit_plan")
        if plan is None:
            out["mercado"] += 1
        elif plan["outcome"] == "maker":
            out["maker"] += 1
            saved += Decimal(plan["fill_price"]) * Decimal(trade["qty"]) * (Decimal("0.0005") - Decimal("0.0002"))
        elif plan["outcome"].startswith("mercado:emergencia"):
            out["mercado_emergencia"] += 1
        elif plan["outcome"] == "mercado:tope":
            out["mercado_tope"] += 1
        else:
            out["mercado_tiempo"] += 1
    out["comision_ahorrada_usd"] = str(saved.quantize(Decimal("0.01")))
    return out


def default_settings(modo="sigue"):
    return {"modo": modo, "ttl_min": DEFAULT_TTL_MIN, "tope_pb": DEFAULT_TOPE_BP}


def _d(value):
    return value if isinstance(value, Decimal) else Decimal(str(value))


def passive_price(position_side, bid, ask):
    """Closing a LONG sells at the ask; closing a SHORT buys at the bid. Never crosses the spread."""
    bid, ask = _d(bid), _d(ask)
    if not 0 < bid <= ask:
        raise MakerExitError("Libro cruzado o sin precio: no se coloca la orden.")
    return ask if position_side == "LONG" else bid


def start(position_side, now_ms, bid, ask, cfg, *, closed_by, exit_reason, ref_ms=None):
    """A new waiting order. ``cfg`` are the validated settings."""
    if position_side not in ("LONG", "SHORT"):
        raise MakerExitError("Lado de posición inválido.")
    price = passive_price(position_side, bid, ask)
    mid = (_d(bid) + _d(ask)) / 2
    return {
        "schema": SCHEMA, "modo": cfg["modo"], "position_side": position_side,
        "started_ms": now_ms, "ttl_ms": int(cfg["ttl_min"] * 60_000), "tope_bp": str(cfg["tope_pb"]),
        "start_mid": str(mid), "limit": str(price), "placed_ms": now_ms, "last_ok_ms": now_ms,
        "orders": [{"at_ms": now_ms, "price": str(price)}],
        "closed_by": closed_by, "exit_reason": exit_reason,
    }


def adverse_bp(plan, mid):
    """How far the market moved against the position since the wait began, in basis points (negative: in favour)."""
    start = _d(plan["start_mid"])
    move = (start - _d(mid)) if plan["position_side"] == "LONG" else (_d(mid) - start)
    with localcontext() as ctx:
        ctx.prec = PRECISION
        return move / start * TEN_THOUSAND


def step(plan, now_ms, bid, ask, through, *, strict, gap_ms=BOOK_GAP_MS):
    """Advance one tick. Returns ``(plan, action)`` with ``action`` one of
    ``{"kind": "hold"}``, ``{"kind": "reprice", "price"}``, ``{"kind": "fill", "price"}``,
    ``{"kind": "market", "reason"}``.

    ``through`` is the best price the market reached against our side since the last step: the best bid (selling) or the
    best ask (buying) in a book, the candle's high (selling) or low (buying) in candles. ``strict`` asks for the market to
    go *past* the limit (candles) instead of touching it (book). ``gap_ms`` is how long the book may stay silent
    (``None`` in candles, which have no book)."""
    selling = plan["position_side"] == "LONG"
    limit = _d(plan["limit"])
    bid, ask, through = _d(bid), _d(ask), _d(through)
    if gap_ms is not None and now_ms - plan["last_ok_ms"] > gap_ms:
        return plan, {"kind": "market", "reason": "libro"}
    plan = dict(plan, last_ok_ms=now_ms)
    reached = (through > limit if strict else through >= limit) if selling else (
        through < limit if strict else through <= limit)
    if reached:
        return plan, {"kind": "fill", "price": limit}
    if now_ms - plan["started_ms"] >= plan["ttl_ms"]:
        return plan, {"kind": "market", "reason": "tiempo"}
    if adverse_bp(plan, (bid + ask) / 2) > _d(plan["tope_bp"]):
        return plan, {"kind": "market", "reason": "tope"}
    if plan["modo"] == "sigue":
        if selling and ask < limit and bid <= ask:
            return _moved(plan, now_ms, ask), {"kind": "reprice", "price": ask}
        if not selling and bid > limit and bid <= ask:
            return _moved(plan, now_ms, bid), {"kind": "reprice", "price": bid}
    return plan, {"kind": "hold"}


def _moved(plan, now_ms, price):
    return dict(plan, limit=str(price), placed_ms=now_ms,
                orders=plan["orders"] + [{"at_ms": now_ms, "price": str(price)}])


def summary(plan, outcome, at_ms, *, fill_price=None):
    """What the receipt and the screens keep of the wait."""
    out = {
        "schema": SCHEMA, "modo": plan["modo"], "started_ms": plan["started_ms"], "ttl_ms": plan["ttl_ms"],
        "tope_bp": plan["tope_bp"], "start_mid": plan["start_mid"], "orders": list(plan["orders"]),
        "reprices": len(plan["orders"]) - 1, "closed_by": plan["closed_by"], "exit_reason": plan["exit_reason"],
        "outcome": outcome, "ended_ms": at_ms, "waited_ms": at_ms - plan["started_ms"],
    }
    if fill_price is not None:
        out["fill_price"] = str(fill_price)
    return out
