"""Forward incremental, PR 1: equivalencia entre el replay completo y el núcleo incremental por trozos.

Referencia: ``futures_replay.replay`` (la ruta del bucle horario actual). Contra ella, ``SeriesRunner.step`` alimentado
en trozos de tamaño aleatorio (incluido 1 vela), con ida y vuelta por JSON en cada corte y con interrupciones simuladas
(se pierde el resultado de un trozo y se rehace desde el último estado guardado). Se exigen trades idénticos (todas las
claves), la misma posición abierta, las mismas decisiones y contadores, y el mismo estado de ``IncrementalFeatures``.

Semillas: ``BALANCITA_EQUIV_SEEDS`` (por defecto 4; cada semilla hace decenas de cortes). Con 200 tarda unos minutos.

Mutantes comprobados a mano (cada uno rompe al menos un test de este archivo; ver el informe del PR):
M01 ``<=`` -> ``<`` al consumir la 5m pendiente; M02 ``previous`` no restaurado; M03 estado ``logvol`` no restaurado;
M04 semilla de RSI no restaurada; M05 decisión de la posición copiada en vez de enlazada; M06 Decimal de la posición
sin restaurar; M07 funding de la posición abierta podado de más; M09 el calentamiento abre posiciones; M10 una vela no
posterior al cursor se reprocesa; M11 checkpoint fuera de la transacción de los trades; M12 sin comprobación de ``seq``;
M13 cadena sin enlace; M14 blob sin verificar; M15 ``catalog_version`` sin comprobar; M16 ``_drain`` no vacía los trades;
M17 ``pending`` sin serializar; M18 ``fundpct`` admitida; M19 sin era; M20 sin trigger anti DELETE; M21 ``bucket`` del
libro no restaurado; M22 ``last_5m_ms`` no restaurado.
Revisión adversarial: N01 el cursor no espera a la 5m; N02 el cursor no espera a la 1m ausente; N03 el plazo nunca vence;
N04 blob borrable; N05 sin registro de cabezas; N06 recorte de la cola no detectado; N07 conflicto de trade en silencio;
N08 ``BLOCK_STALE_ENTRIES`` ignorada; N09 el funding provisional guardado manda; N10 el funding no pasa a final;
N11 huecos sin registrar; N12 el libro restaurado sin funding; N13 fila reescrita sin cotejar con su cabeza.
"""

import copy
import json
import os
import random
import sqlite3
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

import real_sample
from balancita_engine import futures_forward, futures_forward_incremental as inc
from balancita_engine.futures_forward_incremental import (
    CheckpointError,
    ConcurrentCycle,
    FrameStream,
    SeriesRunner,
    canonical_json,
    commit_cycle,
    ensure_schema,
    features_from_state,
    features_to_state,
    load_series,
    start_series,
    verify_chain,
)
from balancita_engine.futures_replay import replay
from balancita_engine.futures_simulator import DEFAULT_PERIODS, ONE_MINUTE_MS, FIVE_MINUTES_MS, IncrementalFeatures, frames, merge_periods
from balancita_engine.futures_spec_strategy import declared_indicators, load_specs, spec_hash

from test_futures_log_strategies import _calm_then_surge, _candles
from test_futures_spec_strategy import MINUTE, START, _official, _random_walk

SPECS = load_specs()
SEEDS = int(os.environ.get("BALANCITA_EQUIV_SEEDS", "4"))
PRODUCT, TICK = "PF_XBTUSD", "1"
C25, C27, C28, C30 = ("c25-pullback-perp-v1", "c27-breakout-perp-v1", "c28-adapter-perp-v1", "c30-momentum-12h-perp-v1")


def fast_spec():
    """C27 con horizonte de 7 min: casi todo cierra por tiempo (cubre ``time_stop``)."""
    spec = copy.deepcopy(SPECS[C27])
    spec["id"], spec["rules"]["horizon_minutes"] = "c27-h7", 7
    return spec


# ---- datos ----------------------------------------------------------------------------------------------------------

def fives_from(ones):
    """Las 5m alineadas cuyas cinco 1m están todas (una ventana con hueco no tiene 5m)."""
    windows = {}
    for candle in ones:
        windows.setdefault(candle["bucket_start"] // FIVE_MINUTES_MS, []).append(candle)
    fives = []
    for key in sorted(windows):
        chunk = windows[key]
        if len(chunk) != 5:
            continue
        candle = _official(FIVE_MINUTES_MS, chunk[0]["bucket_start"], Decimal(chunk[-1]["close"]),
                           sum(Decimal(c["volume_btc"]) for c in chunk))
        candle["open"] = chunk[0]["open"]
        candle["high"] = str(max(Decimal(c["high"]) for c in chunk))
        candle["low"] = str(min(Decimal(c["low"]) for c in chunk))
        fives.append(candle)
    return fives


def walk(minutes=1500, seed=11):
    ones, _ = _random_walk(random.Random(seed), minutes)
    return ones, fives_from(ones)


def real_sample_candles():
    rows = sorted(real_sample.rows("official_candles", real_sample.PARTIAL_DIR), key=lambda c: c["bucket_start"])
    ones = [{"interval_ms": MINUTE, "bucket_start": r["bucket_start"], "close_at": r["bucket_start"] + MINUTE,
             "known_at": r["known_at"], "open": r["open_price"], "high": r["high_price"], "low": r["low_price"],
             "close": r["close_price"], "volume_btc": r["volume_btc"], "revision_hash": r["revision_hash"]} for r in rows]
    return ones, fives_from(ones)


def with_hole(ones, first, last):
    """Quita los 1m con índice en [first, last] (hueco de captura que nunca se rellena) y recalcula las 5m."""
    kept = [c for i, c in enumerate(ones) if not first <= i <= last]
    return kept, fives_from(kept)


def funding_for(ones, rates, hole_hours=()):
    """Periodos horarios ``(inicio, fin, tasa)`` alineados a la hora que cubren las velas; ``hole_hours`` = horas sin dato."""
    first = ones[0]["bucket_start"] // 3_600_000 * 3_600_000
    last = ones[-1]["bucket_start"] + MINUTE
    periods, hour, index = [], first, 0
    while hour < last:
        if index not in hole_hours:
            periods.append((hour, hour + 3_600_000, rates[index % len(rates)]))
        hour, index = hour + 3_600_000, index + 1
    return periods


def spike_exit_candle(ones, trade):
    """Hace que la vela de salida de un trade por objetivo toque también el stop: debe ganar el stop."""
    patched = copy.deepcopy(ones)
    for candle in patched:
        if candle["bucket_start"] == trade["exit_bucket_ms"]:
            stop, target = Decimal(trade["stop_price"]), Decimal(trade["target_price"])
            low_end, high_end = min(stop, target) - Decimal(5), max(stop, target) + Decimal(5)
            candle["low"], candle["high"] = str(low_end), str(high_end)
    return patched, fives_from(patched)


# ---- referencia e incremental ---------------------------------------------------------------------------------------

def full_book(spec, ones, fives, start_ms, funding=()):
    (book,) = replay([spec], ones, fives, start_ms=start_ms, product_id=PRODUCT, tick_size=TICK, funding_periods=list(funding))
    return book


def _norm(position):
    if position is None:
        return None
    return {k: (str(v) if isinstance(v, Decimal) else v) for k, v in position.items() if k != "decision"}


FAR = 10 ** 15   # un reloj muy posterior: todo hueco pendiente queda declarado


def cuts(ones, fives, rng, max_chunk, early=False):
    """Trozos ``(1m, 5m, ahora)`` de tamaño aleatorio; las 5m llegan cuando cierran (o antes, si ``early``)."""
    index, delivered = 0, 0
    while index < len(ones):
        size = 1 if rng.random() < 0.25 else rng.randint(1, max_chunk)
        part = ones[index:index + size]
        index += size
        now = part[-1]["bucket_start"] + ONE_MINUTE_MS
        end = now + (rng.choice([0, 600_000]) if early else 0)
        start = delivered
        while delivered < len(fives) and fives[delivered]["bucket_start"] + FIVE_MINUTES_MS <= end:
            delivered += 1
        yield part, fives[start:delivered], now


def delayed_source(ones, fives, rng, *, tick_max=45, random_delays=True, late_ones=None, late_fives=None,
                   max_delay=12 * 60_000):
    """Simula el reloj: cada vela llega en ``cierre + retraso`` y el llamador corre en ticks de 1 a ``tick_max`` minutos.

    Retrasos aleatorios por debajo de ``GAP_GRACE`` (hasta 12 min, incluida la 5m que llega 5 min tarde, y 1m
    desordenadas); ``late_ones`` / ``late_fives`` fijan el retraso de velas concretas (``bucket -> ms``).
    """
    events = []
    for candle in ones:
        delay = (late_ones or {}).get(candle["bucket_start"])
        if delay is None:
            delay = (rng.randint(0, 30_000) if rng.random() < 0.85 else rng.randint(60_000, max_delay)) if random_delays else 0
        events.append((candle["bucket_start"] + ONE_MINUTE_MS + delay, 0, candle["bucket_start"], candle))
    for candle in fives:
        delay = (late_fives or {}).get(candle["bucket_start"])
        if delay is None:
            delay = (rng.randint(0, 30_000) if rng.random() < 0.5 else rng.choice([300_000, rng.randint(60_000, max_delay)])) \
                if random_delays else 0
        events.append((candle["bucket_start"] + FIVE_MINUTES_MS + delay, 1, candle["bucket_start"], candle))
    events.sort(key=lambda e: e[:3])
    now, index = events[0][0], 0
    while index < len(events):
        now += rng.choice([ONE_MINUTE_MS, rng.randint(1, tick_max) * ONE_MINUTE_MS])
        part_ones, part_fives = [], []
        while index < len(events) and events[index][0] <= now:
            (part_fives if events[index][1] else part_ones).append(events[index][3])
            index += 1
        yield part_ones, part_fives, now


def run_incremental(spec, ones, fives, start_ms, rng, *, funding=(), funding_mode="full", crash=0.0, early=False,
                    max_chunk=90, warm_start_ms=None, delayed=None):
    """``delayed``: ``None`` (trozos sin retraso) o los argumentos de ``delayed_source``."""
    runner = SeriesRunner(spec, product_id=PRODUCT, tick_size=TICK, start_ms=start_ms, warm_start_ms=warm_start_ms)
    out = {"trades": [], "decisions": [], "skipped": [], "blocked": [], "fills": [], "holes": []}
    saved, crashes, given = canonical_json(runner.to_state()), 0, 0
    source = cuts(ones, fives, rng, max_chunk, early) if delayed is None else delayed_source(ones, fives, rng, **delayed)
    for part, fives_part, now in list(source) + [([], [], FAR)]:   # el último paso declara lo que aún espera
        if funding_mode == "full":
            known = funding
        else:   # "arrival": cada periodo se entrega una vez, cuando ya empezó; el estado debe recordarlo
            new = [p for p in funding[given:] if p[0] < min(now, FAR // 2)]
            given += len(new)
            known = new
        if rng.random() < crash:
            runner.step(part, fives_part, known, now_ms=now)   # caída antes de guardar: este resultado se pierde
            runner = SeriesRunner.from_state(json.loads(saved))
            crashes += 1
        result = runner.step(part, fives_part, known, now_ms=now)
        for name in out:
            out[name].extend(result[name])
        saved = canonical_json(runner.to_state())
        runner = SeriesRunner.from_state(json.loads(saved))   # ida y vuelta por JSON en cada corte
    return runner, out, crashes


class Equivalence(unittest.TestCase):
    def assert_same(self, spec, ones, fives, start_ms, rng, *, funding=(), funding_mode="full", crash=0.3, early=False,
                    max_chunk=90, expect_trades=1, delayed=None, reference=None):
        """``reference``: ``(1m, 5m)`` que ve el replay completo cuando difiere de lo que se entrega (velas que no llegaron)."""
        ref_ones, ref_fives = reference or (ones, fives)
        book = full_book(spec, ref_ones, ref_fives, start_ms, funding)
        self.assertGreaterEqual(len(book.trades), expect_trades)
        runner, out, _ = run_incremental(spec, ones, fives, start_ms, rng, funding=funding, funding_mode=funding_mode,
                                         crash=crash, early=early, max_chunk=max_chunk, delayed=delayed)
        self.assertEqual((runner.stream.waiting_ones, runner.stream.pending), ({}, {}))
        self.assertEqual(book.trades, out["trades"])
        by_bucket = lambda ds: sorted(ds, key=lambda d: d["bucket_ms"])
        self.assertEqual(by_bucket(book.decisions), by_bucket(out["decisions"] + runner.book.decisions))
        self.assertEqual((book.skipped, book.blocked, book.fills), (out["skipped"], out["blocked"], out["fills"]))
        self.assertEqual((book.stale_cycles, book.bucket), (runner.book.stale_cycles, runner.book.bucket))
        self.assertEqual(_norm(book.position), _norm(runner.book.position))
        if book.position is not None:
            self.assertEqual(book.position["decision"], runner.book.position["decision"])
            mark = ref_ones[-1]["close"]
            self.assertEqual(book.open_position(mark), runner.open_view(mark))
        # El estado de los indicadores es el de una pasada continua, no una aproximación.
        periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
        reference_one = IncrementalFeatures(merge_periods(periods, {"ema": (9, 21), "atr": (14,)}))
        for candle in ref_ones:
            reference_one.update(candle)
        self.assertEqual(features_to_state(reference_one), features_to_state(runner.stream.one))
        return book, runner, out

    def test_random_walk_with_the_shipped_specs_and_funding_in_both_modes(self):
        ones, fives = walk()
        funding = funding_for(ones, ["0.00002", "-0.00001", "0.0000125", "0"], hole_hours={3})
        for spec_id in (C25, C27, C28):
            for seed in range(SEEDS):
                for mode in ("full", "arrival"):
                    with self.subTest(spec=spec_id, seed=seed, mode=mode):
                        self.assert_same(SPECS[spec_id], ones, fives, ones[0]["bucket_start"], random.Random(seed),
                                         funding=funding, funding_mode=mode, expect_trades=3)

    def test_time_stop_with_warmup_before_the_start_and_early_fives(self):
        ones, fives = walk(1800, seed=5)
        start = ones[400]["bucket_start"]
        funding = funding_for(ones, ["0.00001", "0.00003"])
        for seed in range(SEEDS):
            with self.subTest(seed=seed):
                book, _, _ = self.assert_same(fast_spec(), ones, fives, start, random.Random(100 + seed), funding=funding,
                                           funding_mode="arrival", early=True, max_chunk=40, expect_trades=10)
                self.assertIn("time_stop", {t["exit_reason"] for t in book.trades})

    def test_stop_and_target_in_the_same_candle_the_stop_wins(self):
        ones, fives = walk(1500, seed=11)
        reference = full_book(SPECS[C27], ones, fives, ones[0]["bucket_start"])
        target_trade = next(t for t in reference.trades if t["exit_reason"] == "target")
        ones2, fives2 = spike_exit_candle(ones, target_trade)
        book, _, _ = self.assert_same(SPECS[C27], ones2, fives2, ones2[0]["bucket_start"], random.Random(1))
        patched = next(t for t in book.trades if t["entry_bucket_ms"] == target_trade["entry_bucket_ms"])
        self.assertEqual((patched["exit_reason"], patched["exit_bucket_ms"]), ("stop", target_trade["exit_bucket_ms"]))
        for seed in range(SEEDS):
            with self.subTest(seed=seed):
                self.assert_same(SPECS[C27], ones2, fives2, ones2[0]["bucket_start"], random.Random(seed))

    def test_a_declared_hole_in_the_candles_is_crossed_the_same_way(self):
        ones, fives = walk(1500, seed=11)
        reference = full_book(SPECS[C27], ones, fives, ones[0]["bucket_start"])
        entry_index = next(i for i, c in enumerate(ones) if c["bucket_start"] == reference.trades[2]["entry_bucket_ms"])
        holed, holed_fives = with_hole(ones, entry_index - 3, entry_index + 40)   # hueco que cubre una entrada y su salida
        funding = funding_for(holed, ["0.00002"], hole_hours={1, 2})
        for seed in range(SEEDS):
            with self.subTest(seed=seed):
                self.assert_same(SPECS[C27], holed, holed_fives, holed[0]["bucket_start"], random.Random(seed),
                                 funding=funding, funding_mode="arrival", expect_trades=3)

    def test_slow_indicators_logvol_and_logret(self):
        ones, fives = _candles(_calm_then_surge())
        start = ones[2000]["bucket_start"]
        for seed in range(min(SEEDS, 3)):
            with self.subTest(seed=seed):
                book, _, _ = self.assert_same(SPECS[C30], ones, fives, start, random.Random(seed), max_chunk=700, crash=0.3,
                                           expect_trades=1)
                self.assertEqual(book.trades[0]["exit_reason"], "time_stop")

    def test_the_real_sample_from_the_start_and_with_warmup(self):
        ones, fives = real_sample_candles()
        self.assertEqual(len(ones), 1168)
        funding = funding_for(ones, ["0.0000125", "0.00001", "-0.000004"])
        for spec in (SPECS[C25], SPECS[C27], SPECS[C28], fast_spec()):
            for start in (ones[0]["bucket_start"], ones[500]["bucket_start"]):
                for seed in range(max(2, SEEDS // 2)):
                    with self.subTest(spec=spec["id"], start=start, seed=seed):
                        self.assert_same(spec, ones, fives, start, random.Random(seed), funding=funding,
                                         funding_mode="arrival" if seed % 2 else "full", expect_trades=1)

    def test_an_open_position_survives_every_cut_and_closes_afterwards_with_the_same_funding(self):
        ones, fives = walk(1500, seed=11)
        funding = funding_for(ones, ["0.00004", "0.00001"])
        reference = full_book(SPECS[C27], ones, fives, ones[0]["bucket_start"], funding)
        trade = reference.trades[4]
        # Cortamos con la posición abierta, cerramos el proceso y reanudamos solo con el estado guardado.
        cut = next(i for i, c in enumerate(ones) if c["bucket_start"] == trade["entry_bucket_ms"]) + 2
        runner = SeriesRunner(SPECS[C27], product_id=PRODUCT, tick_size=TICK, start_ms=ones[0]["bucket_start"])
        early = runner.step(ones[:cut], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS <= ones[cut - 1]["bucket_start"] + MINUTE],
                            funding_for(ones[:cut], ["0.00004", "0.00001"]), now_ms=ones[cut - 1]["bucket_start"] + MINUTE)
        self.assertIsNotNone(runner.book.position)
        saved = canonical_json(runner.to_state())
        self.assertTrue(json.loads(saved)["funding"])           # la posición abierta lleva sus periodos de funding
        restored = SeriesRunner.from_state(json.loads(saved))
        late = restored.step(ones[cut:], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS > ones[cut - 1]["bucket_start"] + MINUTE],
                             [p for p in funding if p[0] >= ones[cut - 1]["bucket_start"]],   # solo los periodos nuevos
                             now_ms=FAR)
        got = {t["entry_bucket_ms"]: t for t in early["trades"] + late["trades"]}
        self.assertEqual(got[trade["entry_bucket_ms"]], trade)
        self.assertEqual(reference.trades, early["trades"] + late["trades"])

    def test_late_and_reordered_candles_match_the_full_replay(self):
        """1m y 5m con retrasos de hasta 12 min (incluida la 5m 5 min tarde), 1m desordenadas, ticks de hasta 45 min."""
        ones, fives = walk(900, seed=21)
        funding = funding_for(ones, ["0.00002", "-0.00001"])
        for spec in (SPECS[C25], SPECS[C27], fast_spec()):
            for seed in range(SEEDS):
                with self.subTest(spec=spec["id"], seed=seed):
                    self.assert_same(spec, ones, fives, ones[0]["bucket_start"], random.Random(seed), funding=funding,
                                     funding_mode="arrival", delayed={}, expect_trades=1)

    def test_a_5m_five_minutes_late_is_waited_for_not_skipped(self):
        ones, fives = walk(900, seed=21)
        late = {f["bucket_start"]: 5 * ONE_MINUTE_MS for f in fives[3::2]}
        for seed in range(SEEDS):
            with self.subTest(seed=seed):
                _, _, out = self.assert_same(fast_spec(), ones, fives, ones[0]["bucket_start"], random.Random(seed),
                                             delayed={"random_delays": False, "late_fives": late, "tick_max": 3}, expect_trades=3)
                self.assertEqual(out["holes"], [])

    def test_late_and_reordered_candles_on_data_with_holes_and_on_the_real_sample(self):
        ones, fives = walk(1500, seed=11)
        reference = full_book(SPECS[C27], ones, fives, ones[0]["bucket_start"])
        index = next(i for i, c in enumerate(ones) if c["bucket_start"] == reference.trades[2]["entry_bucket_ms"])
        holed, holed_fives = with_hole(ones, index - 3, index + 40)
        sample, sample_fives = real_sample_candles()
        for name, (o, f, spec) in {"hueco": (holed, holed_fives, SPECS[C27]), "muestra": (sample, sample_fives, SPECS[C25]),
                                   "muestra-h7": (sample, sample_fives, fast_spec())}.items():
            for seed in range(max(2, SEEDS // 2)):
                with self.subTest(data=name, seed=seed):
                    _, _, out = self.assert_same(spec, o, f, o[0]["bucket_start"], random.Random(seed), delayed={}, expect_trades=1)
                    if name == "hueco":
                        self.assertTrue(any(h["kind"] == "1m" for h in out["holes"]))

    def test_a_candle_later_than_the_grace_is_a_declared_hole_and_the_late_arrival_is_ignored(self):
        ones, fives = walk(900, seed=21)
        start = ones[0]["bucket_start"]
        gone = fives[40]["bucket_start"]
        for seed in range(max(2, SEEDS // 2)):
            with self.subTest(kind="5m", seed=seed):
                reference = ([c for c in ones], [f for f in fives if f["bucket_start"] != gone])
                _, _, out = self.assert_same(fast_spec(), ones, fives, start, random.Random(seed), reference=reference,
                                             delayed={"random_delays": False, "late_fives": {gone: 20 * ONE_MINUTE_MS}, "tick_max": 4},
                                             expect_trades=3)
                self.assertEqual([h["first_ms"] for h in out["holes"] if h["kind"] == "5m"], [gone])
        missing = ones[300]["bucket_start"]
        for seed in range(max(2, SEEDS // 2)):
            with self.subTest(kind="1m", seed=seed):
                reference = ([c for c in ones if c["bucket_start"] != missing], fives)
                _, _, out = self.assert_same(fast_spec(), ones, fives, start, random.Random(seed), reference=reference,
                                             delayed={"random_delays": False, "late_ones": {missing: 20 * ONE_MINUTE_MS}, "tick_max": 4},
                                             expect_trades=3)
                self.assertEqual([(h["first_ms"], h["last_ms"]) for h in out["holes"] if h["kind"] == "1m"], [(missing, missing)])

    def test_the_cursor_does_not_pass_a_missing_5m_before_the_grace(self):
        ones, fives = walk(60, seed=21)
        runner = SeriesRunner(SPECS[C27], product_id=PRODUCT, tick_size=TICK, start_ms=ones[0]["bucket_start"])
        without = [f for f in fives if f["bucket_start"] != fives[4]["bucket_start"]]
        gone = fives[4]["bucket_start"]
        runner.step(ones, without, now_ms=gone + 10 * MINUTE)     # 5 min después de que cierre la 5m: aún dentro del plazo
        self.assertEqual(runner.cursor, gone + 3 * MINUTE)        # la 1m que cierra junto a la 5m ausente espera
        self.assertTrue(runner.stream.waiting_ones)
        runner.step([], [fives[4]], now_ms=gone + 11 * MINUTE)    # llega a tiempo: se reanuda
        self.assertEqual(runner.cursor, ones[-1]["bucket_start"])
        self.assertEqual(runner.stream.waiting_ones, {})


class StateRoundTrips(unittest.TestCase):
    def test_incremental_features_round_trip_at_every_cut(self):
        ones, _ = walk(700, seed=3)
        periods = {"ema": (9, 12, 21), "sma": (50,), "rsi": (7, 14), "atr": (14,), "bollinger": (20,), "donchian": (20,),
                   "logret": (6,), "logvol": (12,)}
        straight, resumed = IncrementalFeatures(periods), IncrementalFeatures(periods)
        rng = random.Random(7)
        for index, candle in enumerate(ones):
            want = straight.update(candle)
            self.assertEqual(resumed.update(candle), want)
            if rng.random() < 0.2 or index < 30:
                state = json.loads(canonical_json(features_to_state(resumed)))
                resumed = features_from_state(state)
                self.assertEqual(features_to_state(resumed), features_to_state(straight))

    def test_frame_stream_equals_frames_for_any_chunking(self):
        ones, fives = walk(900, seed=4)
        periods = merge_periods(DEFAULT_PERIODS, {"logvol": (12,), "logret": (6,)})
        want = list(frames(ones, fives, periods))
        for seed in range(SEEDS):
            rng = random.Random(seed)
            stream, got = FrameStream(periods), []
            for part, fives_part, now in cuts(ones, fives, rng, 50, early=bool(seed % 2)):
                got.extend(stream.feed(part, fives_part, now_ms=now))
                stream = FrameStream.from_state(json.loads(canonical_json(stream.to_state())))
            self.assertEqual(got, want, seed)

    def test_a_candle_not_after_the_cursor_changes_nothing(self):
        ones, fives = walk(400, seed=2)
        runner = SeriesRunner(SPECS[C27], product_id=PRODUCT, tick_size=TICK, start_ms=ones[0]["bucket_start"])
        runner.step(ones[:300], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS <= ones[299]["bucket_start"] + MINUTE],
                    now_ms=ones[299]["bucket_start"] + MINUTE)
        before = canonical_json(runner.to_state())
        runner = SeriesRunner.from_state(json.loads(before))      # también después de reanudar desde el estado guardado
        late = copy.deepcopy(ones[250])
        late["close"], late["high"] = "1", "999999"                 # una revisión distinta de una vela ya pasada
        revised_five = copy.deepcopy(fives[10])
        revised_five["close"] = "2"
        result = runner.step([late, ones[299]], [revised_five], now_ms=FAR)
        self.assertEqual(result, {"trades": [], "decisions": [], "skipped": [], "blocked": [], "fills": [], "holes": []})
        self.assertEqual(canonical_json(runner.to_state()), before)
        self.assertEqual(runner.stream.ignored, 3)

    def test_persisted_funding_wins_over_a_revision(self):
        ones, fives = walk(1500, seed=11)
        funding = funding_for(ones, ["0.00004", "0.00001"])
        reference = full_book(SPECS[C27], ones, fives, ones[0]["bucket_start"], funding)
        trade = reference.trades[4]
        cut = next(i for i, c in enumerate(ones) if c["bucket_start"] == trade["entry_bucket_ms"]) + 2
        runner = SeriesRunner(SPECS[C27], product_id=PRODUCT, tick_size=TICK, start_ms=ones[0]["bucket_start"])
        runner.step(ones[:cut], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS <= ones[cut - 1]["bucket_start"] + MINUTE],
                    funding_for(ones[:cut], ["0.00004", "0.00001"]), now_ms=ones[cut - 1]["bucket_start"] + MINUTE)
        edge = ones[cut - 1]["bucket_start"] + MINUTE
        revised = [(a, b, "0.5" if b <= edge else r) for a, b, r in funding]   # lo ya cerrado se "revisa"; lo nuevo no
        late = runner.step(ones[cut:], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS > ones[cut - 1]["bucket_start"] + MINUTE],
                           revised, now_ms=FAR)
        self.assertEqual(late["trades"][0]["funding_usd"], trade["funding_usd"])

    def test_provisional_funding_yields_to_the_value_seen_after_the_close(self):
        from balancita_engine.futures_forward_incremental import _funding_merge
        provisional = [(0, 10, Decimal("1"), False)]
        self.assertEqual(_funding_merge(provisional, [(0, 10, "2")]), [(0, 10, Decimal("2"), False)])
        self.assertEqual(_funding_merge([(0, 10, Decimal("1"), True)], [(0, 10, "2")]), [(0, 10, Decimal("1"), True)])
        ones, fives = walk(120, seed=3)
        runner = SeriesRunner(SPECS[C27], product_id=PRODUCT, tick_size=TICK, start_ms=ones[0]["bucket_start"])
        edge = ones[59]["bucket_start"] + MINUTE
        runner.step(ones[:60], [f for f in fives if f["bucket_start"] + FIVE_MINUTES_MS <= edge],
                    [(edge - 3_600_000, edge, "0.1"), (edge, edge + 3_600_000, "0.2")], now_ms=edge)
        flags = {(a, b): final for a, b, _, final in runner.funding}
        self.assertEqual(flags, {(edge - 3_600_000, edge): True, (edge, edge + 3_600_000): False})

    def test_fundpct_is_not_admitted(self):
        spec = copy.deepcopy(SPECS[C27])
        spec["rules"]["checks"][0]["node"] = {"all": [{"cmp": "x", "left": "5m.fundpct", "op": "<", "right": "10"}]}
        with self.assertRaises(ValueError):
            SeriesRunner(spec, product_id=PRODUCT, start_ms=0)
        with self.assertRaises(ValueError):
            SeriesRunner(SPECS["c32-funding-contrarian-24h-perp-v1"], product_id=PRODUCT, start_ms=0)


class Faulted(Exception):
    pass


class CheckpointStore(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = sqlite3.connect(os.path.join(self.dir.name, "forward.sqlite"))
        ensure_schema(self.db)
        self.ones, self.fives = walk(1500, seed=11)
        self.spec = SPECS[C27]
        self.start = self.ones[0]["bucket_start"]
        self.funding = funding_for(self.ones, ["0.00002", "-0.00001"])

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def _series(self):
        runner = SeriesRunner(self.spec, product_id=PRODUCT, tick_size=TICK, start_ms=self.start)
        key = start_series(self.db, runner, now_ms=1)
        return key

    def _chunk(self, runner, rng, size=80):
        cursor = runner.cursor
        part = [c for c in self.ones if cursor is None or c["bucket_start"] > cursor][:rng.randint(1, size)]
        if not part:
            return None
        end = part[-1]["bucket_start"] + ONE_MINUTE_MS
        seen = runner.stream.last_5m_ms
        fives = [f for f in self.fives if f["bucket_start"] + FIVE_MINUTES_MS <= end and (seen is None or f["bucket_start"] > seen)]
        return part, fives, [p for p in self.funding if p[0] < end]

    def _drive(self, key, rng, fault_rate=0.0, faults=("after_trades", "after_blob", "before_commit")):
        injected = 0
        for _ in range(10_000):
            runner, seq = load_series(self.db, key)
            chunk = self._chunk(runner, rng)
            if chunk is None:
                return injected
            before = (self.db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0],
                      self.db.execute("SELECT COUNT(*) FROM forward_checkpoint").fetchone()[0])
            result = runner.step(*chunk, now_ms=chunk[0][-1]["bucket_start"] + ONE_MINUTE_MS + 20 * ONE_MINUTE_MS)
            stage = rng.choice(faults) if rng.random() < fault_rate else None

            def fault(where, stage=stage):
                if where == stage:
                    raise Faulted(where)
            try:
                commit_cycle(self.db, runner, result, seq_read=seq, now_ms=2 + seq, fault=fault)
            except Faulted:
                injected += 1
                after = (self.db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0],
                         self.db.execute("SELECT COUNT(*) FROM forward_checkpoint").fetchone()[0])
                self.assertEqual(before, after, "una caída a mitad de ciclo no deja nada escrito")
        self.fail("no terminó")

    def _stored(self):
        return [json.loads(p) for (p,) in self.db.execute("SELECT payload FROM forward_trade ORDER BY entry_bucket_ms")]

    def test_crash_mid_cycle_resumes_without_duplicate_or_lost_trades(self):
        reference = full_book(self.spec, self.ones, self.fives, self.start, self.funding)
        want = [json.loads(json.dumps(t)) for t in reference.trades]
        for seed in range(max(2, SEEDS // 3)):
            with self.subTest(seed=seed):
                self.db.close()
                self.db = sqlite3.connect(os.path.join(self.dir.name, "s{}.sqlite".format(seed)))
                ensure_schema(self.db)
                key = self._series()
                injected = self._drive(key, random.Random(seed), fault_rate=0.4)
                self.assertGreater(injected, 0)
                self.assertEqual(self._stored(), want)
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0], len(want))
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM forward_era WHERE era=?", (inc.ERA_NOW,)).fetchone()[0], len(want))
                self.assertEqual(verify_chain(self.db, key), self.db.execute("SELECT COUNT(*) FROM forward_checkpoint").fetchone()[0])
                runner, _ = load_series(self.db, key)
                self.assertEqual(_norm(runner.book.position), _norm(reference.position))

    def test_the_checkpoint_chain_is_append_only_and_detects_tampering(self):
        key = self._series()
        self._drive(key, random.Random(1))
        count = verify_chain(self.db, key)
        self.assertGreater(count, 3)
        for statement in ("UPDATE forward_checkpoint SET created_ms=9 WHERE seq=1", "DELETE FROM forward_checkpoint WHERE seq=1",
                          "UPDATE forward_checkpoint_blob SET json='{}'", "DELETE FROM forward_checkpoint_blob",
                          "UPDATE forward_checkpoint_head SET row_sha256='x'", "DELETE FROM forward_checkpoint_head"):
            with self.assertRaises(sqlite3.DatabaseError, msg=statement):
                self.db.execute(statement)
            self.db.rollback()
        # Con los triggers fuera (alguien con el fichero en la mano) la cadena y los blobs lo delatan.
        original = self.db.execute("SELECT created_ms FROM forward_checkpoint WHERE seq=2").fetchone()[0]
        self.db.execute("DROP TRIGGER forward_checkpoint_no_update")
        self.db.execute("UPDATE forward_checkpoint SET created_ms=9 WHERE seq=2")
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            load_series(self.db, key)
        self.assertEqual(caught.exception.code, "chain_broken")
        self.db.execute("UPDATE forward_checkpoint SET created_ms=? WHERE seq=2", (original,))
        self.db.commit()
        verify_chain(self.db, key)
        self.db.execute("DROP TRIGGER forward_checkpoint_blob_no_update")
        digest = self.db.execute("SELECT state_sha256 FROM forward_checkpoint WHERE seq=?", (count - 1,)).fetchone()[0]
        self.db.execute("UPDATE forward_checkpoint_blob SET json=json || ' ' WHERE state_sha256=?", (digest,))
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            load_series(self.db, key)
        self.assertEqual(caught.exception.code, "blob_corrupt")
        self.db.execute("DROP TRIGGER forward_checkpoint_blob_no_delete")
        self.db.execute("DELETE FROM forward_checkpoint_blob WHERE state_sha256=?", (digest,))
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            load_series(self.db, key)
        self.assertEqual(caught.exception.code, "blob_missing")

    def test_a_missing_checkpoint_in_the_middle_is_a_gap(self):
        key = self._series()
        self._drive(key, random.Random(2))
        self.db.execute("DROP TRIGGER forward_checkpoint_no_delete")
        self.db.execute("DELETE FROM forward_checkpoint WHERE seq=2")
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            verify_chain(self.db, key)
        self.assertEqual(caught.exception.code, "chain_gap")

    def test_a_second_process_with_a_stale_seq_fails_and_writes_nothing(self):
        key = self._series()
        first, seq = load_series(self.db, key)
        second, seq2 = load_series(self.db, key)
        chunk = self._chunk(first, random.Random(0), 300)
        now = chunk[0][-1]["bucket_start"] + ONE_MINUTE_MS + 20 * ONE_MINUTE_MS
        result_a = first.step(*chunk, now_ms=now)
        result_b = second.step(*chunk, now_ms=now)
        commit_cycle(self.db, first, result_a["trades"], seq_read=seq, now_ms=5)
        before = self.db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0]
        with self.assertRaises(ConcurrentCycle):
            commit_cycle(self.db, second, result_b["trades"] + [dict(result_b["trades"][0], entry_bucket_ms=1)] if result_b["trades"] else [],
                         seq_read=seq2, now_ms=6)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0], before)
        self.assertEqual(verify_chain(self.db, key), 2)

    def test_a_tail_rollback_is_detected_by_the_head_log_but_a_full_rewrite_is_not(self):
        key = self._series()
        self._drive(key, random.Random(5))
        count = verify_chain(self.db, key)
        original = self.db.execute("SELECT created_ms FROM forward_checkpoint WHERE seq=?", (count - 1,)).fetchone()[0]
        self.db.execute("DROP TRIGGER forward_checkpoint_no_update")
        self.db.execute("UPDATE forward_checkpoint SET created_ms=7 WHERE seq=?", (count - 1,))     # la última fila no tiene sucesora
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            verify_chain(self.db, key)
        self.assertEqual(caught.exception.code, "head_mismatch")
        self.db.execute("UPDATE forward_checkpoint SET created_ms=? WHERE seq=?", (original, count - 1))
        self.db.commit()
        self.assertEqual(verify_chain(self.db, key), count)
        self.db.execute("DROP TRIGGER forward_checkpoint_no_delete")
        self.db.execute("DELETE FROM forward_checkpoint WHERE seq=?", (count - 1,))
        self.db.commit()
        with self.assertRaises(CheckpointError) as caught:
            verify_chain(self.db, key)
        self.assertEqual(caught.exception.code, "chain_truncated")
        with self.assertRaises(CheckpointError):
            load_series(self.db, key)
        # Limitación documentada: quien reescribe también el registro de cabezas no es detectable sin un ancla externa.
        self.db.execute("DROP TRIGGER forward_checkpoint_head_no_delete")
        self.db.execute("DELETE FROM forward_checkpoint_head WHERE seq=?", (count - 1,))
        self.db.commit()
        self.assertEqual(verify_chain(self.db, key), count - 1)

    def test_a_trade_that_already_exists_with_other_content_is_an_anomaly_not_silence(self):
        key = self._series()
        self._drive(key, random.Random(6))
        runner, seq = load_series(self.db, key)
        (payload,) = self.db.execute("SELECT payload FROM forward_trade ORDER BY entry_bucket_ms LIMIT 1").fetchone()
        stored = json.loads(payload)
        commit_cycle(self.db, runner, {"trades": [stored]}, seq_read=seq, now_ms=99)          # reintento idéntico: idempotente
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM forward_anomaly").fetchone()[0], 0)
        changed = dict(stored, net_bp=stored["net_bp"] + 1)
        commit_cycle(self.db, runner, {"trades": [changed]}, seq_read=seq + 1, now_ms=100)
        rows = self.db.execute("SELECT kind, bucket_ms FROM forward_anomaly").fetchall()
        self.assertEqual(rows, [("trade_conflict", stored["entry_bucket_ms"])])
        for statement in ("UPDATE forward_anomaly SET kind='x'", "DELETE FROM forward_anomaly"):
            with self.assertRaises(sqlite3.DatabaseError, msg=statement):
                self.db.execute(statement)
            self.db.rollback()
        self.assertEqual(self.db.execute("SELECT payload FROM forward_trade WHERE entry_bucket_ms=?",
                                         (stored["entry_bucket_ms"],)).fetchone()[0], payload)

    def test_holes_are_recorded_as_anomalies_in_the_cycle_that_declared_them(self):
        self.ones, self.fives = with_hole(self.ones, 200, 215)
        reference = full_book(self.spec, self.ones, self.fives, self.start, self.funding)
        key = self._series()
        self._drive(key, random.Random(7))
        kinds = {k for (k,) in self.db.execute("SELECT kind FROM forward_anomaly")}
        self.assertIn("hole_1m", kinds)
        self.assertEqual(self._stored(), [json.loads(json.dumps(t)) for t in reference.trades])

    def test_the_stale_entry_gate_is_refused_not_ignored(self):
        key = self._series()
        runner, seq = load_series(self.db, key)
        with mock.patch.object(futures_forward, "BLOCK_STALE_ENTRIES", True):
            with self.assertRaises(CheckpointError) as caught:
                SeriesRunner(self.spec, product_id=PRODUCT, start_ms=0)
            self.assertEqual(caught.exception.code, "unsupported_policy")
            with self.assertRaises(CheckpointError) as caught:
                load_series(self.db, key)
            self.assertEqual(caught.exception.code, "unsupported_policy")
            with self.assertRaises(CheckpointError):
                commit_cycle(self.db, runner, {"trades": []}, seq_read=seq)
        self.assertEqual(verify_chain(self.db, key), 1)

    def test_catalog_spec_and_version_changes_stop_the_series(self):
        key = self._series()
        self._drive(key, random.Random(3))
        with mock.patch.object(inc, "catalog_version", return_value="otro"):
            with self.assertRaises(CheckpointError) as caught:
                load_series(self.db, key)
        self.assertEqual(caught.exception.code, "catalog_changed")
        other = copy.deepcopy(self.spec)
        other["params"]["stop_atr"] = "9"
        with self.assertRaises(CheckpointError) as caught:
            load_series(self.db, key, spec=other)
        self.assertEqual(caught.exception.code, "spec_hash_mismatch")
        with self.assertRaises(CheckpointError) as caught:
            load_series(self.db, ("nope", PRODUCT, "0" * 64))
        self.assertEqual(caught.exception.code, "no_checkpoint")

    def test_checkpoint_zero_keeps_the_canonical_spec_and_the_warmup_start(self):
        key = self._series()
        runner, seq = load_series(self.db, key)
        self.assertEqual(seq, 0)
        state = json.loads(self.db.execute("SELECT json FROM forward_checkpoint_blob").fetchone()[0])
        self.assertEqual(spec_hash(state["meta"]["spec"]), spec_hash(self.spec))
        self.assertEqual((state["meta"]["start_ms"], state["meta"]["warm_start_ms"]), (self.start, self.start))
        with self.assertRaises(ConcurrentCycle):
            start_series(self.db, SeriesRunner(self.spec, product_id=PRODUCT, tick_size=TICK, start_ms=self.start))

    def test_the_live_loop_does_not_use_the_incremental_path_yet(self):
        with open(futures_forward.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn("futures_forward_incremental", source)


if __name__ == "__main__":
    unittest.main()
