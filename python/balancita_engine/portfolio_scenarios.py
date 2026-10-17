"""Synthetic, deterministic scenarios for ``portfolio_offline`` (the report generator and its committed output were deleted).

Everything here is invented data: scripted price paths with hash-derived noise (no ``random``), scripted strategies
that subclass the existing ``multi_signals.Strategy`` (so signals come out of ``make_signal`` exactly as in production),
and funding tables that are deliberately complete, partial or absent. Nothing is read from the market, the forward,
Kronos, Qwen, ``capture`` or any database, and no holdout data is involved.
"""

import hashlib
import json
import os
import sys
import tempfile
from decimal import Decimal

from .multi_signals import SignalContext, Strategy, stable_hash
from .portfolio_offline import ONE_MINUTE_MS, approved_policy, run_scenario

D = Decimal
HOUR = 3_600_000
START_MS = 1_791_230_400_000  # 2026-10-05 20:00:00 UTC; midnight falls 240 minutes later
PRODUCTS = {  # product -> (opening price, decimals)
    "PF_XBTUSD": ("100000", 1), "PF_ETHUSD": ("3500", 2), "PF_SOLUSD": ("180", 2),
    "PF_XRPUSD": ("2.5", 4), "PF_ADAUSD": ("0.8", 4)}
FULL_FUNDING_RATE = "0.00002"  # relative per hour, longs pay


# ---- synthetic prices ---------------------------------------------------------------------------------------------
def _unit(seed, product, index, salt):
    digest = hashlib.sha256("{}:{}:{}:{}".format(seed, product, index, salt).encode()).hexdigest()
    return D(int(digest[:8], 16)) / D(2 ** 32) - D("0.5")  # exact, in [-0.5, 0.5)


def candle_series(start_ms, minutes, waypoints, *, product, decimals, seed, noise_bps="2"):
    """1-minute candles following ``waypoints`` ``[(minute, price), ...]`` linearly, plus deterministic noise."""
    points = sorted((int(m), D(str(p))) for m, p in waypoints)
    quantum = D(1).scaleb(-decimals)
    candles, previous = {}, points[0][1]
    for i in range(minutes):
        left = max((pt for pt in points if pt[0] <= i), key=lambda pt: pt[0], default=points[0])
        right = min((pt for pt in points if pt[0] >= i), key=lambda pt: pt[0], default=points[-1])
        base = left[1] if right[0] == left[0] else left[1] + (right[1] - left[1]) * D(i - left[0]) / D(right[0] - left[0])
        close = base * (1 + _unit(seed, product, i, "c") * D(noise_bps) / 5_000)
        wick = abs(_unit(seed, product, i, "w")) * D(noise_bps) / 5_000
        open_ = previous
        high = max(open_, close) * (1 + wick)
        low = min(open_, close) * (1 - wick)
        q = lambda x: str(x.quantize(quantum))
        candles[i] = {"open": q(open_), "high": q(high), "low": q(low), "close": q(close)}
        previous = D(candles[i]["close"])
    return candles


class ScriptedStrategy(Strategy):
    """Emits what the script says for ``(product, bucket)``; otherwise WAIT. Goes through ``make_signal``."""

    def __init__(self, strategy_id, script, horizon=60):
        self.id, self.version, self.horizon_minutes, self.script = strategy_id, 1, horizon, script

    def decide(self, ctx):
        entry = self.script.get((ctx.product_id, ctx.bucket_ms))
        if entry is None:
            return "WAIT", D(0), {"scripted": "no entry"}, "scripted wait"
        return entry["action"], D(entry["strength"]), {"scripted": "yes", "price": ctx.price}, "scripted " + entry["action"]


class Builder:
    """Collects candles, signals and delivery quirks of one scenario and turns them into ordered events."""

    def __init__(self, name, description, *, seed, minutes, paths, noise_bps="2", start_ms=START_MS):
        self.name, self.description, self.seed, self.minutes, self.start_ms = name, description, seed, minutes, start_ms
        self.candles = {p: candle_series(start_ms, minutes, paths[p], product=p, decimals=PRODUCTS[p][1], seed=seed,
                                         noise_bps=noise_bps) for p in paths}
        self.funding, self.signals, self.extra_events, self.removed = {}, [], [], set()
        self.restart = None

    def bucket(self, minute):
        return self.start_ms + minute * ONE_MINUTE_MS

    def full_funding(self, *products, rate=FULL_FUNDING_RATE):
        for p in products:
            self.funding[p] = [(self.start_ms - 2 * HOUR, self.start_ms + (self.minutes + 600) * ONE_MINUTE_MS, rate)]

    def partial_funding(self, product, until_minute, rate=FULL_FUNDING_RATE):
        self.funding[product] = [(self.start_ms - 2 * HOUR, self.bucket(until_minute), rate)]

    def signal(self, minute, product, action, strength, atr, *, strategy="scripted-a", horizon=60, delay=0, price=None,
               deliveries=()):
        """``deliveries``: extra copies: ``("same_event", +min)`` redelivers the identical event, ``("new_event", +min)``
        re-sends the same signal under a new event id, ``("other_atr", +min, atr)`` the same signal with another ATR."""
        self.signals.append(dict(minute=minute, product=product, action=action, strength=str(strength), atr=str(atr),
                                 strategy=strategy, horizon=horizon, delay=delay, price=price, deliveries=list(deliveries)))

    def drop_candle(self, product, minute):
        self.removed.add((product, minute))

    def event_candle(self, product, minute, candle, suffix=""):
        bucket = self.bucket(minute)
        return {"event_id": "candle:{}:{}{}".format(product, bucket, suffix), "kind": "candle", "product_id": product,
                "bucket_ms": bucket, "arrival_ms": bucket + ONE_MINUTE_MS, "candle": candle}

    def build(self):
        events = []
        for product, series in self.candles.items():
            for minute, candle in series.items():
                if (product, minute) not in self.removed:
                    events.append(self.event_candle(product, minute, candle))
        scripts = {}
        for s in self.signals:
            scripts.setdefault(s["strategy"], {})[(s["product"], self.bucket(s["minute"]))] = s
        strategies = {sid: ScriptedStrategy(sid, script) for sid, script in scripts.items()}
        for s in self.signals:
            strategy = strategies[s["strategy"]]
            strategy.horizon_minutes = s["horizon"]
            price = s["price"] or self.candles[s["product"]][s["minute"]]["close"]
            signal = strategy.evaluate(SignalContext(s["product"], self.bucket(s["minute"]), price, None, None, None))
            arrival = self.bucket(s["minute"]) + ONE_MINUTE_MS + s["delay"] * ONE_MINUTE_MS
            base = {"kind": "signal", "signal": signal, "price": str(price), "atr": s["atr"]}
            first = dict(base, event_id="signal:{}:1".format(signal["signal_id"]), arrival_ms=arrival)
            events.append(first)
            for n, copy in enumerate(s["deliveries"], start=2):
                how, extra = copy[0], copy[1]
                at = arrival + extra * ONE_MINUTE_MS
                if how == "same_event":
                    events.append(dict(first, arrival_ms=at))
                elif how == "new_event":
                    events.append(dict(base, event_id="signal:{}:{}".format(signal["signal_id"], n), arrival_ms=at))
                elif how == "other_atr":
                    events.append(dict(base, event_id="signal:{}:{}".format(signal["signal_id"], n), arrival_ms=at, atr=str(copy[2])))
                elif how == "tampered":  # same id, altered content: must fail validation
                    forged = dict(signal, strength="1.00")
                    events.append(dict(base, signal=forged, event_id="signal:{}:{}".format(signal["signal_id"], n), arrival_ms=at))
                else:
                    raise ValueError(how)
        events.extend(self.extra_events)
        events.sort(key=lambda e: (e["arrival_ms"], e["kind"], e["event_id"]))
        scenario = {
            "name": self.name, "description": self.description, "seed": self.seed, "start_ms": self.start_ms,
            "minutes": self.minutes, "products": sorted(self.candles), "events": events,
            "funding": {p: [[int(a), int(b), str(r)] for a, b, r in rows] for p, rows in sorted(self.funding.items())},
            "restart": self.restart, "policy_hash": approved_policy().policy_hash()}
        scenario["scenario_hash"] = stable_hash(scenario)
        return scenario


def _p(*pairs):
    return [(m, p) for m, p in pairs]


# ---- scenarios -----------------------------------------------------------------------------------------------------
def s1_simultaneous():
    b = Builder("s1_posiciones_simultaneas",
                "Cinco productos, tres estrategias, LONG y SHORT a la vez; los límites recortan o rechazan lo que sobra.",
                seed="s1", minutes=130, paths={
                    "PF_XBTUSD": _p((0, 100000), (6, 100000), (45, 100700), (130, 100700)),
                    "PF_ETHUSD": _p((0, 3500), (6, 3500), (55, 3330), (130, 3330)),
                    "PF_SOLUSD": _p((0, 180), (6, 180), (30, 168), (130, 168)),
                    "PF_XRPUSD": _p((0, 2.5), (130, 2.55)),
                    "PF_ADAUSD": _p((0, 0.8), (130, 0.8))})
    b.full_funding(*PRODUCTS)
    b.signal(5, "PF_XBTUSD", "BUY", "0.90", 150, strategy="scripted-a", horizon=90)
    b.signal(5, "PF_ETHUSD", "SELL", "0.80", 35, strategy="scripted-b", horizon=90)
    b.signal(5, "PF_SOLUSD", "BUY", "0.70", 3.6, strategy="scripted-c", horizon=90)
    b.signal(5, "PF_XRPUSD", "SELL", "0.60", 0.05, strategy="scripted-a", horizon=90)
    b.signal(5, "PF_ADAUSD", "BUY", "0.55", 0.016, strategy="scripted-b", horizon=90)
    b.signal(5, "PF_ADAUSD", "SELL", "0.50", 0.016, strategy="scripted-c", horizon=90)  # contradicts the BUY
    b.signal(70, "PF_XBTUSD", "SELL", "0.60", 200, strategy="scripted-c", horizon=40)  # after the first XBT closed
    b.signal(70, "PF_XRPUSD", "BUY", "0.40", 0.0, strategy="scripted-a", horizon=40)  # ATR 0: no valid levels
    return b.build()


def s2_consecutive_losses():
    b = Builder("s2_perdidas_consecutivas",
                "Cuatro stops seguidos: el capital baja, el presupuesto de 1 % baja con él y la pérdida diaria suspende nuevas entradas.",
                seed="s2", minutes=200, paths={
                    "PF_XBTUSD": _p((0, 100000), (6, 100000), (25, 98000), (60, 98000), (66, 98000), (90, 100200), (200, 100200)),
                    "PF_ETHUSD": _p((0, 3500), (36, 3500), (60, 3380), (200, 3380)),
                    "PF_SOLUSD": _p((0, 180), (66, 180), (90, 172), (200, 172)),
                    "PF_XRPUSD": _p((0, 2.5), (200, 2.5))})
    b.full_funding(*PRODUCTS)
    b.signal(5, "PF_XBTUSD", "BUY", "0.80", 400, horizon=120)        # stop 800 below: hit by the slide to 98 000
    b.signal(35, "PF_ETHUSD", "BUY", "0.70", 40, horizon=120)         # stop -80 (2.3 %): hit by 3 380
    b.signal(65, "PF_XBTUSD", "SELL", "0.75", 300, horizon=120)       # after the slide: rejected if daily loss is spent
    b.signal(65, "PF_SOLUSD", "BUY", "0.65", 3.0, horizon=120)
    b.signal(100, "PF_XRPUSD", "BUY", "0.60", 0.04, horizon=60)       # still suspended or room-limited
    return b.build()


def s3_duplicates_and_order():
    b = Builder("s3_duplicados_y_orden",
                "Eventos repetidos, versiones contradictorias de una señal, señal vencida y falsificada, vela duplicada, "
                "conflictiva, tardía y faltante.",
                seed="s3", minutes=120, paths={
                    "PF_XBTUSD": _p((0, 100000), (60, 100800), (120, 100800)),
                    "PF_ETHUSD": _p((0, 3500), (120, 3500)),
                    "PF_SOLUSD": _p((0, 180), (120, 181))})
    b.full_funding(*PRODUCTS)
    b.signal(5, "PF_XBTUSD", "BUY", "0.80", 200, horizon=60,
             deliveries=[("same_event", 0), ("new_event", 1), ("other_atr", 3, 250)])
    # two versions of one signal in the same minute: inconsistent, both rejected, nothing opens
    b.signal(8, "PF_ETHUSD", "BUY", "0.70", 30, strategy="scripted-b", horizon=60, deliveries=[("other_atr", 0, 45)])
    # a stale signal (arrives 25 minutes late) and a forged one
    b.signal(10, "PF_SOLUSD", "BUY", "0.60", 2.0, strategy="scripted-c", horizon=60, delay=25)
    b.signal(12, "PF_SOLUSD", "BUY", "0.55", 2.0, strategy="scripted-c", horizon=60, deliveries=[("tampered", 0)])
    # a candle delivered twice (same id), re-sent under another id, with conflicting content, and one that never arrives
    candle = b.candles["PF_XBTUSD"][20]
    b.extra_events.append(b.event_candle("PF_XBTUSD", 20, candle))
    b.extra_events.append(b.event_candle("PF_XBTUSD", 20, candle, suffix=":resent"))
    b.extra_events.append(b.event_candle("PF_XBTUSD", 21, dict(b.candles["PF_XBTUSD"][21], close="1.0", high="1.0", low="1.0"), suffix=":conflict"))
    b.drop_candle("PF_XBTUSD", 30)
    b.extra_events.append(dict(b.event_candle("PF_XBTUSD", 30, b.candles["PF_XBTUSD"][30], suffix=":late"), arrival_ms=b.bucket(50)))
    return b.build()


def s4_incomplete_funding():
    b = Builder("s4_funding_incompleto",
                "Funding completo, parcial y ausente en tres operaciones: lo verificado se separa de lo provisional.",
                seed="s4", minutes=180, paths={
                    "PF_XBTUSD": _p((0, 100000), (6, 100000), (40, 101500), (180, 101500)),
                    "PF_ETHUSD": _p((0, 3500), (6, 3500), (40, 3300), (180, 3300)),
                    "PF_SOLUSD": _p((0, 180), (6, 180), (50, 168), (180, 168)),
                    "PF_XRPUSD": _p((0, 2.5), (6, 2.5), (70, 2.75), (180, 2.75))})
    b.full_funding("PF_XBTUSD")                  # complete
    b.partial_funding("PF_ETHUSD", 20)           # stops covering the position half-way: partial
    b.partial_funding("PF_XRPUSD", 30)           # partial; a winner whose gain must stay provisional
    # PF_SOLUSD has no funding table at all: unknown
    b.signal(5, "PF_XBTUSD", "BUY", "0.80", 250, horizon=120)    # target hit, funding complete: verified gain
    b.signal(5, "PF_ETHUSD", "SELL", "0.70", 40, horizon=120)    # target hit, funding partial: provisional gain
    b.signal(5, "PF_SOLUSD", "BUY", "0.60", 3.0, horizon=120)    # stop hit, no funding: loss that still reduces capital
    b.signal(35, "PF_XRPUSD", "BUY", "0.50", 0.04, horizon=120)  # after the first exits free capital; target hit later, funding partial
    return b.build()


def s5_integral(mode=None):
    """Everything at once, over midnight: simultaneous positions, consecutive losses, incomplete funding, duplicated
    signals and events, a stale signal, and a crash with a restart from a persisted checkpoint."""
    name = "s5_integral_reinicio_" + (mode or "sin")
    b = Builder(name,
                "Varias posiciones a la vez, pérdidas seguidas, funding incompleto, señales y eventos duplicados, "
                "señal vencida y un reinicio desde un checkpoint persistido ({}).".format(mode or "sin reinicio"),
                seed="s5", minutes=420, paths={
                    "PF_XBTUSD": _p((0, 100000), (6, 100000), (40, 101200), (76, 101200), (100, 99800), (150, 99800),
                                    (200, 100900), (260, 100900), (300, 100100), (420, 100100)),
                    "PF_ETHUSD": _p((0, 3500), (6, 3500), (50, 3290), (130, 3290), (140, 3290), (170, 3420), (420, 3420)),
                    "PF_SOLUSD": _p((0, 180), (6, 180), (26, 170), (190, 170), (200, 174), (420, 176)),
                    "PF_XRPUSD": _p((0, 2.5), (6, 2.5), (90, 2.5), (110, 2.4), (150, 2.4), (420, 2.45)),
                    "PF_ADAUSD": _p((0, 0.8), (60, 0.8), (90, 0.84), (420, 0.84))})
    b.full_funding("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")
    b.partial_funding("PF_XRPUSD", 100)
    # PF_ADAUSD: no funding table
    # wave 1 (m=5): simultaneous, mixed sides, duplicated deliveries and a contradictory pair
    b.signal(5, "PF_XBTUSD", "BUY", "0.90", 150, strategy="scripted-a", horizon=120, deliveries=[("same_event", 0), ("new_event", 2)])
    b.signal(5, "PF_ETHUSD", "SELL", "0.80", 35, strategy="scripted-b", horizon=150)
    b.signal(5, "PF_SOLUSD", "BUY", "0.70", 3.6, strategy="scripted-c", horizon=180, deliveries=[("other_atr", 4, 4.4)])
    b.signal(5, "PF_XRPUSD", "SELL", "0.60", 0.05, strategy="scripted-a", horizon=120)
    b.signal(5, "PF_ADAUSD", "BUY", "0.55", 0.016, strategy="scripted-b", horizon=120)
    b.signal(5, "PF_ADAUSD", "SELL", "0.50", 0.016, strategy="scripted-c", horizon=120)
    # wave 2 (m=75): after the first exits, a new XBT trade into a slide (loss), ADA long (winner without funding)
    b.signal(75, "PF_XBTUSD", "BUY", "0.70", 300, strategy="scripted-a", horizon=120)
    b.signal(75, "PF_ADAUSD", "BUY", "0.65", 0.016, strategy="scripted-b", horizon=120, delay=30)  # arrives stale
    # wave 3 (m=95..): consecutive losses
    b.signal(95, "PF_XRPUSD", "BUY", "0.60", 0.04, strategy="scripted-c", horizon=90)
    b.signal(150, "PF_ETHUSD", "SELL", "0.55", 40, strategy="scripted-b", horizon=90)
    # wave 4: after the restart
    b.signal(200, "PF_XBTUSD", "SELL", "0.60", 250, strategy="scripted-a", horizon=100)
    b.signal(260, "PF_SOLUSD", "BUY", "0.55", 3.0, strategy="scripted-c", horizon=100)
    b.signal(300, "PF_XBTUSD", "BUY", "0.60", 250, strategy="scripted-b", horizon=60)
    if mode:
        b.restart = {"checkpoint_every_min": 45, "crash_after_min": 163, "restart_at_min": 172, "mode": mode, "overlap_min": 8}
    return b.build()


def all_scenarios():
    return [s1_simultaneous(), s2_consecutive_losses(), s3_duplicates_and_order(), s4_incomplete_funding(),
            s5_integral("replay_log"), s5_integral("live_gap")]
