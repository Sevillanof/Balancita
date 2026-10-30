"""El ANALISTA DE REBOTE: ETH cae 5 % o más en 1 hora → largo, salida a las 24 h. Solo para las pruebas de /Estrategias.

No usa el maestro, el portero ni Qwen, y no toca paper. Es la regla medida en ``analisis/caidas-fuertes/informe.md`` (sección 4.2):

* **Disparo**: al cierre de una vela de 5 min, el cierre es 5 % (o más) más bajo que el de 60 min antes.
* **Entrada**: largo a mercado al cierre del minuto siguiente (la vela de 1 min que empieza en el cierre de 5 min). Sin stop ni objetivo.
* **Salida**: 24 h exactas después de la entrada. Una posición por vez; tras salir, 60 min sin disparar.
* **Variante con filtro** (entrada ``rebote_btc``): además, ETH cayó al menos 2 puntos más que BTC en la misma hora (o sea, fue algo de ETH y no del
  mercado); sale a las 4 h.
* **Costos**: taker 5,19 pb por pata (comisión 0,05 % más impacto), 10,38 pb ida y vuelta. Sin funding, como en la medición.

El tamaño de la cuenta (100 USD fijos o toda la cuenta, 1.000 USD más lo ganado) lo pone la pantalla sobre estas mismas operaciones.

Honestidad: la regla se eligió mirando 2022-2026 (el mismo período en que se mide), así que nada de lo que se ve está fuera del ajuste:
el medidor sale rojo y cada variante mirada cuenta como un intento más. Lo único limpio es el holdout, que no se lee (``History`` lo rechaza).
"""

import json
import os
import time

from . import futures_history as hist
from . import futures_qwen_trader as qt

SCHEMA = "balancita-qwen-rebote.v1"
PRODUCT, BTC = "PF_ETHUSD", "PF_XBTUSD"
START = "2022-04-01"                     # primer día con velas del análisis (marzo 2022 es calentamiento)
MIN_MS, BAR_MS, HOUR_MS = 60_000, 300_000, 3_600_000
LOOK_BARS = 12                           # 60 min = 12 velas de 5 min
DROP_PCT = 5.0
COOLDOWN_MIN = 60
TAKER_BP = 5.19                          # por pata
NOTIONAL_USD = 100.0                     # el nominal de paper
ENV = "QWEN_ENTRADA"
ENTRADAS = ("formula", "formula_eth", "rebote", "rebote_btc")  # qué decide la entrada de la prueba; ``formula`` es el maestro con el portero (paper)
DEFAULT = "formula"
BEFORE_MS, AFTER_MS = 4 * HOUR_MS, 3 * HOUR_MS     # precios de 5 min que se guardan alrededor de cada operación (para el zoom)
REASON = "tiempo"
RULES = {
    "rebote": {"id": "principal", "label": "caída de 5 % en 1 h → largo 24 h", "hold_min": 1440, "gap_pct": None},
    "rebote_btc": {"id": "filtro_btc", "label": "caída de 5 % en 1 h y ETH 2 puntos peor que BTC → largo 4 h", "hold_min": 240,
                   "gap_pct": 2.0},
}
NOTE = ("Rebote de ETH, sin Qwen: cae 5 % o más en 1 h → largo, salida a las 24 h (con filtro: ETH 2 puntos peor que BTC, salida a las "
        "4 h). Costos taker de 10,38 pb ida y vuelta, sin funding. La regla se eligió mirando este mismo período, así que el medidor "
        "sale rojo: es para VER cada caída y cada rebote, no una prueba de que funciona.")


def entrada(value, name="entrada"):
    """Una entrada válida (``formula`` donde falta)."""
    if value in (None, ""):
        return DEFAULT
    if value not in ENTRADAS:
        raise ValueError("{}: tiene que ser {}".format(name, ", ".join(ENTRADAS)))
    return value


def is_rebote(value):
    """True cuando la entrada elegida es una de las variantes de rebote."""
    return entrada(value) in RULES


def from_env(env=None):
    env = os.environ if env is None else env
    return entrada(env.get(ENV))


def env_for(value=None):
    """La variable de entorno que le pasa la entrada elegida al proceso de la prueba."""
    return {ENV: entrada(value)}


class ReboteError(Exception):
    """Un fallo claro para la pantalla (falta de velas, Kraken sin responder)."""


# --------------------------------------------------------------------------- prices of 1 minute


class Minutes:
    """Cierre de la vela de 1 min que empieza en ``t_ms``; se baja de Kraken solo alrededor de cada operación y se guarda en disco."""

    def __init__(self, path, product=PRODUCT, *, offline=False, fetch=None):
        self.path, self.product, self.offline = path, product, offline
        self._fetch = fetch or hist.fetch_candles
        self.rows = {}
        try:
            with open(path, encoding="utf-8") as handle:
                self.rows = {int(t): float(c) for t, c in json.load(handle).items()}
        except (OSError, ValueError):
            pass
        self.dirty = False

    def close_at(self, t_ms):
        """El cierre del minuto que empieza en ``t_ms``; si Kraken no publicó ese minuto, el del último anterior (vela plana)."""
        if t_ms not in self.rows:
            self._load(t_ms)
        for back in range(0, 11):
            got = self.rows.get(t_ms - back * MIN_MS)
            if got is not None:
                return got
        raise ReboteError("no hay vela de 1 minuto de {} cerca de {}".format(self.product, qt.stamp(t_ms)))

    def _load(self, t_ms):
        if self.offline:
            raise ReboteError("falta la vela de 1 minuto de {} en {} y la prueba está sin red".format(self.product, qt.stamp(t_ms)))
        try:
            got = self._fetch(self.product, "1m", t_ms - 10 * MIN_MS, t_ms + 2 * MIN_MS)
        except hist.HistoryError as error:
            raise ReboteError(str(error)) from error
        for candle in got:
            self.rows[int(candle["bucket_start"])] = float(candle["close"])
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({str(t): c for t, c in sorted(self.rows.items())}, handle)
        os.replace(tmp, self.path)
        self.dirty = False


# --------------------------------------------------------------------------- the rule


def find_drops(eth, btc, variant, start_ms, end_ms):
    """Las caídas que disparan la regla, una posición por vez.

    ``eth`` / ``btc``: velas de 5 min sin huecos (``bucket_start``, ``close``). ``end_ms``: el último cierre de decisión que sirve.
    Devuelve ``[{"t_ms": cierre de la vela que dispara, "desde_px", "hasta_px", "pct", "btc_pct"}]`` por tiempo.
    """
    btc_close = {int(b["bucket_start"]): float(b["close"]) for b in btc or ()}
    out, free_ms = [], None
    for k in range(LOOK_BARS, len(eth)):
        bar, ref = eth[k], eth[k - LOOK_BARS]
        if int(bar["bucket_start"]) - int(ref["bucket_start"]) != LOOK_BARS * BAR_MS:
            continue
        t_ms = int(bar["bucket_start"]) + BAR_MS
        if t_ms < start_ms or t_ms > end_ms:
            continue
        close, before = float(bar["close"]), float(ref["close"])
        if not close > 0 or not before > 0:
            continue
        ret = close / before - 1
        if ret > -DROP_PCT / 100:
            continue
        btc_ret = None
        if variant["gap_pct"] is not None:
            now_b, then_b = btc_close.get(int(bar["bucket_start"])), btc_close.get(int(ref["bucket_start"]))
            if not now_b or not then_b:
                continue
            btc_ret = now_b / then_b - 1
            if ret - btc_ret > -variant["gap_pct"] / 100:
                continue
        if free_ms is not None and t_ms - MIN_MS < free_ms:
            continue                                     # ya hay una operación abierta (o en los 60 min de espera)
        free_ms = t_ms + (variant["hold_min"] + COOLDOWN_MIN) * MIN_MS
        out.append({"t_ms": t_ms, "desde_ms": t_ms - HOUR_MS, "desde_px": before, "hasta_px": close,
                    "pct": round(ret * 100, 2), "btc_pct": None if btc_ret is None else round(btc_ret * 100, 2)})
    return out


def trade_of(drop, variant, minutes, eth_by_start):
    """La operación de una caída: entra al cierre del minuto siguiente, sale ``hold_min`` después. Neto en pb tras costos."""
    hold_ms = variant["hold_min"] * MIN_MS
    p_in = minutes.close_at(drop["t_ms"])
    p_out = minutes.close_at(drop["t_ms"] + hold_ms)
    net = (p_out / p_in - 1) * 1e4 - 2 * TAKER_BP
    entry_ms, exit_ms = drop["t_ms"] + MIN_MS, drop["t_ms"] + hold_ms + MIN_MS
    lo, hi = entry_ms - BEFORE_MS, exit_ms + AFTER_MS
    prices, t = [], -(-lo // BAR_MS) * BAR_MS
    while t <= hi:
        bar = eth_by_start.get(t - BAR_MS)               # la vela que cierra en ``t``
        if bar is not None:
            prices.append([t, round(float(bar["close"]), 2)])
        t += BAR_MS
    return {"producto": PRODUCT, "lado": 1, "entrada_ms": entry_ms, "salida_ms": exit_ms, "neto_bp": round(net, 2), "motivo": REASON,
            "entrada_px": p_in, "salida_px": p_out, "tamano": 1.0, "movimiento": None,
            "caida": {"desde_ms": drop["desde_ms"], "hasta_ms": drop["t_ms"], "desde_px": drop["desde_px"],
                      "hasta_px": drop["hasta_px"], "pct": drop["pct"], "btc_pct": drop["btc_pct"]},
            "velas": prices}


def stats(trades, hold_min):
    """Las cifras de una forma de operar en el formato de ``QuickOperationStats`` (la pantalla ya lo lee)."""
    from . import futures_walkforward as wf
    nets = [t["neto_bp"] for t in trades]
    n = len(nets)
    if not n:
        return {"n": 0, "neto_bp": None, "ganadoras": None, "ic": [None, None], "total_bp": None, "por_vuelta": 0, "por_tiempo": 0,
                "horas": None}
    rows = [{"t_in": t["entrada_ms"], "t_out": t["salida_ms"], "net": t["neto_bp"]} for t in trades]
    return {"n": n, "neto_bp": sum(nets) / n, "ganadoras": sum(1 for v in nets if v > 0) / n, "ic": wf.bootstrap_ic(rows),
            "total_bp": sum(nets), "por_vuelta": 0, "por_tiempo": n, "horas": hold_min / 60.0}


def honesty(rule, trades):
    """Registra el intento y juzga el resultado: la regla se eligió con este período, así que nada queda fuera del ajuste."""
    from . import futures_walkforward as wf
    spec = {"analista": "rebote", "producto": PRODUCT, "caida_pct": DROP_PCT, "ventana_min": LOOK_BARS * 5,
            "salida_min": rule["hold_min"], "filtro_btc_pct": rule["gap_pct"]}
    wf.register(spec, medicion="vigente")
    rows = [{"t_in": t["entrada_ms"], "t_out": t["salida_ms"], "net": t["neto_bp"]} for t in trades]
    return wf.meter(rows, medicion="vigente", trial_count=wf.trials(), fit_end_ms=qt.load_holdout_ms())


# --------------------------------------------------------------------------- the run


def build(history, holdout_ms, minutes, choice, *, start_ms=None, log=print):
    """El resultado de la entrada ``choice`` (``rebote`` o ``rebote_btc``) con el mismo formato que la prueba de la fórmula."""
    rule = RULES[choice]
    start_ms = qt.date_ms(START) if start_ms is None else start_ms
    log("rebote: leyendo las velas de 5 min de ETH y BTC (sin modelo)…")
    eth = history.bars(PRODUCT, start_ms - 2 * HOUR_MS, holdout_ms)
    btc = history.bars(BTC, start_ms - 2 * HOUR_MS, holdout_ms) if rule["gap_pct"] is not None else []
    if len(eth) < LOOK_BARS + 2:
        raise ReboteError("no hay velas guardadas de {} para el período".format(PRODUCT))
    eth_by_start = {int(b["bucket_start"]): b for b in eth}
    last_ms = int(eth[-1]["bucket_start"]) + BAR_MS
    # una operación necesita su salida (y los precios que se guardan después) antes del holdout y de la última vela
    end_ms = min(holdout_ms, last_ms) - (rule["hold_min"] * MIN_MS + AFTER_MS + 2 * MIN_MS)
    drops = find_drops(eth, btc, rule, start_ms, end_ms)
    log("rebote {}: {} caídas; bajando los precios de 1 minuto…".format(rule["id"], len(drops)))
    trades = [trade_of(d, rule, minutes, eth_by_start) for d in drops]
    minutes.save()
    hourly = [[int(b["bucket_start"]) + BAR_MS, round(float(b["close"]), 2)] for b in eth
              if (int(b["bucket_start"]) + BAR_MS) % HOUR_MS == 0 and start_ms <= int(b["bucket_start"]) + BAR_MS < holdout_ms]
    weeks = (last_ms - start_ms) / (7 * 86_400_000)
    main = stats(trades, rule["hold_min"])
    main["por_semana"] = main["n"] / weeks if weeks >= 1 else None
    empty = stats([], rule["hold_min"])
    return {"entrada": choice, "regla": rule["label"], "fotos": len(eth), "desde_ms": start_ms, "hasta_ms": last_ms,
            "max_horas": rule["hold_min"] / 60.0, "nocional_usd": NOTIONAL_USD, "productos": [PRODUCT], "exigencia": None,
            "analista": None, "mercado": {PRODUCT: hourly}, "formula": main, "maestro_fuerte": empty, "siempre_largo": empty,
            "siempre_corto": empty, "honestidad": honesty(rule, trades),
            "curvas": {"formula": trades, "maestro_fuerte": [], "siempre_largo": [], "siempre_corto": []}}


def prefetch(history, holdout_ms, choice, log=print):
    """Baja a la caché las velas de 5 min de ETH (y de BTC con el filtro) del período: solo lo que falta."""
    if history.offline:
        return
    for product in (PRODUCT, BTC) if RULES[choice]["gap_pct"] is not None else (PRODUCT,):
        log("candles {}: {} a {}".format(product, START, qt.stamp(holdout_ms)))
        cache = history._cache(product)
        try:
            cache.ensure(product, "5m", qt.date_ms(START) - 2 * HOUR_MS, holdout_ms)
        finally:
            cache.close()


def run_rebote(history, holdout_ms, state_path, variant, *, choice=None, minutes=None, log=print):
    """La prueba del rebote: deja ``{state, summary}`` en ``state_path`` con el mismo formato que la prueba de la fórmula."""
    from . import futures_qwen_trader_exam as exam
    choice = choice or from_env()
    started = int(time.time() * 1000)
    state = {"state": "running", "pid": os.getpid(), "started_ms": started, "answered": 0, "total": 2, "phase": "fotos",
             "updated_ms": started, "summary": None, "error": None, "variant": variant["id"]}
    exam._write_state(state_path, state)
    try:
        if choice not in RULES:
            raise ReboteError("la entrada {!r} no es un rebote".format(choice))
        prefetch(history, holdout_ms, choice, log)
        state.update(answered=1, updated_ms=int(time.time() * 1000))
        exam._write_state(state_path, state)
        minutes = minutes or Minutes(os.path.join(history.cache_dir, "rebote-1m-{}.json".format(PRODUCT)), offline=history.offline)
        op = build(history, holdout_ms, minutes, choice, log=log)
        state.update(state="done", answered=2, summary={
            "photos": op["fotos"], "horizon_min": RULES[choice]["hold_min"], "spearman": None, "spearman_ci": [None, None],
            "extremes_net_bp": None, "extremes_ci": [None, None], "vs_random_pct": None,
            "signals": {"extremes": None, "random": None, "spearman": None}, "note": NOTE, "formula": op})
    except Exception as error:  # noqa: BLE001 - whatever went wrong must reach the screen
        state.update(state="failed", error=str(error))
    state["finished_ms"] = int(time.time() * 1000)
    exam._write_state(state_path, state)
    return state
