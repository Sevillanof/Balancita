"""Sombra maker del auditor (odd/tasks/maker-sombra.md, S1-S5): para cada entrada y cada salida OFICIAL (a mercado) se simula, después y
sobre la cinta real capturada, una orden límite en el mejor precio (variante V2 sellada: se llena si la cinta cruza el precio al menos un
tick dentro de 15 min; si no, cruza a mercado al precio de la cinta del minuto 15). Solo registra: no cambia ninguna decisión, orden ni
cuenta, y si falla queda en ``avisos``. Sin red, sin modelo; la captura es una base SQLite de juguete con el esquema real."""
import contextlib
import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import time
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_costs as costs
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt

from test_futures_auditor import CFG, COST, HOUR, MIN, PRODUCT, T0, AuditorCase
from test_futures_qwen_live import Policy, make

# el esquema REAL de la captura (server/src/features/live-gateway/live-capture.ts): eventos con su índice por tiempo de llegada y fotos del libro
MARKET_DDL = """
CREATE TABLE paper_futures_market_events (
  event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
  raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX paper_futures_market_trade_uid ON paper_futures_market_events(feed, product_id, uid) WHERE uid IS NOT NULL;
CREATE INDEX paper_futures_market_received ON paper_futures_market_events(product_id, received_at, seq);
CREATE TABLE paper_futures_book_snapshots (
  event_id TEXT PRIMARY KEY REFERENCES paper_futures_market_events(event_id),
  product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
  event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, bids_json TEXT NOT NULL, asks_json TEXT NOT NULL
) STRICT;
"""
W = 15 * MIN
E = T0 + 4_000                      # la hora oficial de la entrada (cuando se ejecutó)
X = T0 + 3 * HOUR + 4_000           # la de la salida
SHADOW_COLUMNS = ("product", "trade_no", "leg", "motivo_salida", "lado", "orden", "t_oficial_ms", "precio_oficial", "comision_oficial_usd",
                  "comision_oficial_tipo", "cantidad", "notional_oficial_usd", "libro_ms", "limite_px", "estado", "motivo_sin_datos",
                  "llenado_ms", "llenado_px", "cinta_px", "espera_ms", "comision_sombra_usd", "comision_sombra_tipo", "delta_usd",
                  "delta_pb", "modelo", "costos_id", "resuelto_ms", "version")


class Capture:
    """Una captura de juguete: fotos del libro y operaciones de la cinta en ``paper_futures_market_events`` (esquema real)."""

    def __init__(self, path):
        self.path = path
        self.n = 0
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.executescript(MARKET_DDL)

    def _event(self, db, feed, at, raw, product=PRODUCT):
        self.n += 1
        db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("{}:{}:{}".format(feed, product, self.n), feed, product, 1, self.n, at, at, at, None if feed == "book" else "u%d" % self.n,
                    json.dumps(raw), "{}", "h%d" % self.n))
        return "{}:{}:{}".format(feed, product, self.n)

    def book(self, at, bid, ask, product=PRODUCT):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            event_id = self._event(db, "book", at, {"feed": "book_sample"}, product)
            bids = [{"price": str(bid), "quantity": "1.5"}, {"price": str(round(bid - 0.1, 1)), "quantity": "2"}]
            asks = [{"price": str(ask), "quantity": "1.5"}, {"price": str(round(ask + 0.1, 1)), "quantity": "2"}]
            db.execute("INSERT INTO paper_futures_book_snapshots VALUES(?,?,?,?,?,?,?,?)",
                       (event_id, product, 1, self.n, at, at, json.dumps(bids), json.dumps(asks)))

    def trades(self, rows, product=PRODUCT):
        """``rows``: ``[(received_at, price)]``."""
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            for at, price in rows:
                self._event(db, "trade", at, {"product_id": product, "feed": "trade", "type": "fill", "time": at, "qty": 0.1,
                                              "price": price, "side": "sell"}, product)

    def ticker(self, at, product=PRODUCT):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            self._event(db, "ticker", at, {"feed": "ticker"}, product)

    def steady(self, start, end, price, every=20_000):
        """Una operación cada ``every`` ms a ``price`` (sin cruzar nada): la cinta existe y no hay huecos."""
        self.trades([(t, price) for t in range(start, end + 1, every)])
        self.ticker(end + 1_000)                                                      # la captura ya vio el final de la ventana (otro evento)


def shadow_rows(path, where="1=1"):
    con = sqlite3.connect(aud.auditor_path(path))
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute("SELECT * FROM sombra_maker WHERE {} ORDER BY t_oficial_ms, leg".format(where))]
    except sqlite3.OperationalError:                                                  # la base todavía no existe (nadie la abrió)
        return []
    finally:
        con.close()


class ShadowCase(AuditorCase):
    def setUp(self):
        super().setUp()
        self.market = os.path.join(self.tmp, "futures-market.sqlite")
        self.cap = Capture(self.market)

    def receipt(self, number, purpose, price, qty, executed_ms, fee_kind="taker", signal_ms=None):
        notional = Decimal(str(price)) * Decimal(str(qty))
        rate = costs.fee_rate(fee_kind)
        evidence = {"price": str(price), "quantity": str(qty), "executed_at_ms": executed_ms, "fee_kind": fee_kind,
                    "fee_usd": str(notional * rate), "notional_usd": str(notional), "side": "LONG", "purpose": purpose}
        with self.store.db:
            self.store.db.execute("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?,?)",
                                  ("r-%d-%s" % (number, purpose), PRODUCT, number, purpose, signal_ms or executed_ms - 4000, executed_ms,
                                   "h", json.dumps(evidence)))

    def trade(self, number=1, side="LONG", entry=(2250.1, E), exit=None, qty=0.2, receipts=True, closed_by="formula",
              exit_reason="maestro_vuelta", entry_reason="formula", exit_kind="taker"):
        """Una operación oficial: entrada (precio, hora) y, si hay ``exit``, su cierre; con recibos como los de la Terminal."""
        fields = dict(status="open", side=side, entry_ms=entry[1], entry_px=str(entry[0]), qty=str(qty),
                      notional_usd=str(round(entry[0] * qty, 6)), entry_reason=entry_reason)
        if exit is not None:
            fields.update(status="closed", exit_ms=exit[1], exit_px=str(exit[0]), closed_by=closed_by, exit_reason=exit_reason,
                          net_bp=0.0, funding_status="complete")
        self.put_trade(number, **fields)
        if receipts:
            self.receipt(number, "entry", entry[0], qty, entry[1])
            if exit is not None:
                self.receipt(number, "exit", exit[0], qty, exit[1], fee_kind=exit_kind)

    def resolve_shadow(self, now_ms, **kwargs):
        return aud.resolve(self.path, PRODUCT, {}, CFG, now_ms, COST, market_db=self.market, **kwargs)

    def clear(self):
        """Borra las filas de sombra (para repetir un caso con otra captura)."""
        if shadow_rows(self.path):
            self.sql("DELETE FROM sombra_maker")

    def only(self, **where):
        rows = shadow_rows(self.path)
        for key, value in where.items():
            rows = [r for r in rows if r[key] == value]
        self.assertEqual(len(rows), 1, rows)
        return rows[0]


def delta_usd(order, official, shadow, qty, fee_official, fee_shadow):
    gain = (official - shadow) * qty if order == "compra" else (shadow - official) * qty
    return gain + fee_official - fee_shadow


# --------------------------------------------------------------------------- S2: entradas


class EntryShadowTests(ShadowCase):
    def test_a_long_entry_rests_at_the_best_bid_and_fills_as_maker_when_the_tape_goes_one_tick_through(self):
        self.cap.book(E - 5_000, 2250.0, 2250.1)
        self.cap.trades([(E + 20_000, 2250.1), (E + 40_000, 2250.0), (E + 90_000, 2249.9)])           # tocar el límite NO llena; 1 tick más abajo sí
        self.cap.steady(E + 100_000, E + W, 2250.0)
        self.trade()
        result = self.resolve_shadow(E + W + 2 * MIN)
        self.assertEqual((result["sombra"], result["avisos"]), (1, []))
        row = self.only(leg="entry")
        self.assertEqual((row["product"], row["trade_no"], row["lado"], row["orden"], row["motivo_salida"]), (PRODUCT, 1, 1, "compra", None))
        self.assertEqual((row["estado"], row["motivo_sin_datos"]), ("maker", None))
        self.assertEqual((row["t_oficial_ms"], row["precio_oficial"], row["cantidad"]), (E, 2250.1, 0.2))
        self.assertEqual((row["libro_ms"], row["limite_px"]), (E - 5_000, 2250.0))
        self.assertEqual((row["llenado_ms"], row["llenado_px"], row["espera_ms"]), (E + 90_000, 2250.0, 90_000))
        self.assertEqual((row["comision_oficial_tipo"], row["comision_sombra_tipo"]), ("taker", "maker"))
        self.assertAlmostEqual(row["comision_oficial_usd"], 2250.1 * 0.2 * 0.0005, places=9)           # 5 pb
        self.assertAlmostEqual(row["comision_sombra_usd"], 2250.0 * 0.2 * 0.0002, places=9)            # 2 pb
        want = delta_usd("compra", 2250.1, 2250.0, 0.2, 2250.1 * 0.2 * 0.0005, 2250.0 * 0.2 * 0.0002)
        self.assertAlmostEqual(row["delta_usd"], want, places=9)
        self.assertAlmostEqual(row["delta_pb"], want / (2250.1 * 0.2) * 1e4, places=6)
        self.assertGreater(row["delta_pb"], 3.0)                                                         # 3 pb de comisión + el precio
        self.assertEqual((row["modelo"], row["costos_id"], row["version"]), (aud.SHADOW_MODEL, costs.COST_MODEL_VERSION, aud.VERSION))
        self.assertEqual(row["resuelto_ms"], E + W + 2 * MIN)

    def test_a_short_entry_rests_at_the_best_ask_and_fills_when_the_tape_trades_one_tick_above(self):
        self.cap.book(E - 3_000, 2250.0, 2250.1)
        self.cap.trades([(E + 30_000, 2250.1), (E + 60_000, 2250.2)])
        self.cap.steady(E + 80_000, E + W, 2250.1)
        self.trade(side="SHORT", entry=(2250.0, E))
        self.resolve_shadow(E + W + 2 * MIN)
        row = self.only(leg="entry")
        self.assertEqual((row["lado"], row["orden"], row["estado"]), (-1, "venta", "maker"))
        self.assertEqual((row["limite_px"], row["llenado_px"], row["llenado_ms"]), (2250.1, 2250.1, E + 60_000))
        want = delta_usd("venta", 2250.0, 2250.1, 0.2, 2250.0 * 0.2 * 0.0005, 2250.1 * 0.2 * 0.0002)
        self.assertAlmostEqual(row["delta_usd"], want, places=9)

    def test_an_order_the_tape_never_goes_through_crosses_at_the_tape_price_of_minute_15_as_taker(self):
        self.cap.book(E - 5_000, 2250.0, 2250.1)
        self.cap.steady(E + 10_000, E + W - 30_000, 2250.0)                                              # solo toca el límite: no llena
        self.cap.trades([(E + W - 10_000, 2250.4), (E + W + 30_000, 2260.0)])                            # la última del minuto 15 y una DESPUÉS (no cuenta)
        self.trade()
        self.resolve_shadow(E + W + 2 * MIN)
        row = self.only(leg="entry")
        self.assertEqual((row["estado"], row["limite_px"], row["llenado_ms"], row["espera_ms"]), ("maker_mercado", 2250.0, E + W, W))
        self.assertEqual(row["cinta_px"], 2250.4)
        cross = float(costs.entry_fill(Decimal("2250.4"), "LONG", PRODUCT))                             # 0,19 pb contra, como todo cruce del modelo de costos
        self.assertAlmostEqual(row["llenado_px"], cross, places=6)
        self.assertEqual(row["comision_sombra_tipo"], "taker")
        self.assertAlmostEqual(row["comision_sombra_usd"], cross * 0.2 * 0.0005, places=9)
        self.assertAlmostEqual(row["delta_usd"], delta_usd("compra", 2250.1, cross, 0.2, 2250.1 * 0.2 * 0.0005, cross * 0.2 * 0.0005), places=9)
        self.assertLess(row["delta_pb"], 0)                                                              # el precio se fue: entrar más caro

    def test_a_cross_of_a_short_entry_sells_below_the_tape(self):
        self.cap.book(E - 5_000, 2250.0, 2250.1)
        self.cap.steady(E + 10_000, E + W, 2250.1)
        self.trade(side="SHORT", entry=(2250.0, E))
        self.resolve_shadow(E + W + 2 * MIN)
        row = self.only(leg="entry")
        self.assertEqual(row["estado"], "maker_mercado")
        self.assertAlmostEqual(row["llenado_px"], float(costs.entry_fill(Decimal("2250.1"), "SHORT", PRODUCT)), places=6)
        self.assertLess(row["llenado_px"], 2250.1)


# --------------------------------------------------------------------------- S3: salidas


class ExitShadowTests(ShadowCase):
    def test_a_long_exit_rests_at_the_best_ask_and_a_short_exit_at_the_best_bid_by_motive(self):
        cases = (("vuelta", dict(closed_by="formula", exit_reason="maestro_vuelta")),
                 ("agotado", dict(closed_by="formula", exit_reason="maestro_agotado")),
                 ("tiempo", dict(closed_by="tiempo", exit_reason=None)),
                 ("rebote", dict(closed_by="tiempo", exit_reason=None, entry_reason="rebote")))
        for number, (motive, fields) in enumerate(cases, start=1):
            side = "LONG" if number % 2 else "SHORT"
            at = X + number * 2 * HOUR
            with self.subTest(motive=motive):
                self.cap.book(at - 4_000, 2300.0, 2300.1)
                # LARGO vende en el ask 2300,1 (llena si la cinta sube a 2300,2); CORTO compra en el bid 2300,0 (llena si baja a 2299,9)
                self.cap.trades([(at + 30_000, 2300.2 if side == "LONG" else 2299.9)])
                self.cap.steady(at + 40_000, at + W, 2300.05)
                self.trade(number, side=side, entry=(2250.0, at - 2 * HOUR), exit=(2300.0, at), **fields)
        with mock.patch.object(aud, "SHADOW_LEGS_PER_PASS", 100):                                           # (este caso es de los motivos, no del tope por pasada)
            self.resolve_shadow(X + 20 * HOUR)
        rows = {r["trade_no"]: r for r in shadow_rows(self.path, "leg='exit'")}
        self.assertEqual({n: r["motivo_salida"] for n, r in rows.items()}, {1: "vuelta", 2: "agotado", 3: "tiempo", 4: "rebote"})
        for number, row in rows.items():
            long = number % 2 == 1
            self.assertEqual((row["estado"], row["orden"], row["lado"]), ("maker", "venta" if long else "compra", 1 if long else -1))
            self.assertEqual(row["limite_px"], 2300.1 if long else 2300.0)
            self.assertEqual(row["llenado_ms"], row["t_oficial_ms"] + 30_000)
            self.assertEqual(row["comision_sombra_tipo"], "maker")
            sell = long
            want = delta_usd("venta" if sell else "compra", 2300.0, row["limite_px"], 0.2, 2300.0 * 0.2 * 0.0005, row["limite_px"] * 0.2 * 0.0002)
            self.assertAlmostEqual(row["delta_usd"], want, places=9)

    def test_an_exit_the_tape_does_not_reach_crosses_at_the_tape_price_with_the_exit_impact(self):
        self.cap.book(X - 4_000, 2300.0, 2300.1)
        self.cap.steady(X + 10_000, X + W, 2300.0)
        self.trade(exit=(2299.0, X))
        self.resolve_shadow(X + W + 2 * MIN)
        row = self.only(leg="exit")
        self.assertEqual((row["estado"], row["motivo_salida"], row["orden"]), ("maker_mercado", "vuelta", "venta"))
        self.assertAlmostEqual(row["llenado_px"], float(costs.exit_fill(Decimal("2300.0"), "LONG", PRODUCT)), places=6)
        self.assertLess(row["llenado_px"], 2300.0)

    def test_an_official_exit_that_was_already_maker_keeps_its_own_fee_kind_and_price(self):
        self.cap.book(X - 4_000, 2300.0, 2300.1)
        self.cap.steady(X + 10_000, X + W, 2300.05)
        self.trade(exit=(2300.1, X), exit_kind="maker")
        self.resolve_shadow(X + W + 2 * MIN)
        row = self.only(leg="exit")
        self.assertEqual((row["comision_oficial_tipo"], row["precio_oficial"]), ("maker", 2300.1))
        self.assertAlmostEqual(row["comision_oficial_usd"], 2300.1 * 0.2 * 0.0002, places=9)

    def test_an_entry_of_the_same_trade_is_resolved_apart_from_its_exit(self):
        self.cap.book(E - 4_000, 2250.0, 2250.1)
        self.cap.steady(E + 10_000, E + W, 2250.0)
        self.trade(exit=(2300.0, X))                                      # la salida todavía no tiene 15 min de cinta
        self.resolve_shadow(E + W + 2 * MIN)
        self.assertEqual([r["leg"] for r in shadow_rows(self.path)], ["entry"])


# --------------------------------------------------------------------------- cuándo se calcula y qué no se adivina


class WhenAndNoGuessTests(ShadowCase):
    def setUp(self):
        super().setUp()
        self.cap.book(E - 5_000, 2250.0, 2250.1)
        self.cap.steady(E + 10_000, E + W + 5 * MIN, 2250.0)
        self.trade()

    def test_nothing_is_computed_until_15_minutes_of_tape_after_the_official_time_exist(self):
        for now in (E, E + 5 * MIN, E + W, E + W + 59_000):
            self.assertEqual(self.resolve_shadow(now)["sombra"], 0, now)
        self.assertEqual(shadow_rows(self.path), [])
        self.assertEqual(self.resolve_shadow(E + W + 60_000)["sombra"], 1)

    def test_a_capture_that_has_not_reached_minute_15_yet_leaves_the_leg_pending_not_guessed(self):
        other = Capture(os.path.join(self.tmp, "atrasada.sqlite"))
        other.book(E - 5_000, 2250.0, 2250.1)
        other.steady(E + 10_000, E + 9 * MIN, 2250.0)                                                       # la captura llega hasta el minuto 9
        result = aud.resolve(self.path, PRODUCT, {}, CFG, E + 2 * HOUR, COST, market_db=other.path)
        self.assertEqual((result["sombra"], shadow_rows(self.path)), (0, []))
        # pasadas 12 h sin que la cinta llegue, queda sin datos (no traba)
        result = aud.resolve(self.path, PRODUCT, {}, CFG, E + W + aud.GIVE_UP_MS + MIN, COST, market_db=other.path)
        row = self.only(leg="entry")
        self.assertEqual((row["estado"], row["motivo_sin_datos"]), ("sin_datos", "cinta_incompleta"))
        self.assertTrue(all(row[k] is None for k in ("llenado_px", "llenado_ms", "delta_usd", "delta_pb", "comision_sombra_usd")))

    def test_without_a_book_snapshot_up_to_20_seconds_before_the_official_time_it_is_sin_datos(self):
        for age, state in ((20_000, "maker_mercado"), (20_001, "sin_datos")):
            with self.subTest(age=age):
                self.clear()
                cap = Capture(os.path.join(self.tmp, "libro-%d.sqlite" % age))
                cap.book(E - age, 2250.0, 2250.1)
                cap.steady(E + 10_000, E + W + 5 * MIN, 2250.0)
                aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
                row = self.only(leg="entry")
                self.assertEqual(row["estado"], state)
                if state == "sin_datos":
                    self.assertEqual(row["motivo_sin_datos"], "sin_libro")
                    self.assertIsNone(row["limite_px"])
                    self.assertIsNone(row["delta_pb"])

    def test_a_book_snapshot_from_after_the_official_time_is_never_used(self):
        cap = Capture(os.path.join(self.tmp, "libro-futuro.sqlite"))
        cap.book(E + 1_000, 2250.0, 2250.1)
        cap.steady(E + 10_000, E + W + 5 * MIN, 2250.0)
        aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
        self.assertEqual(self.only(leg="entry")["motivo_sin_datos"], "sin_libro")

    def test_a_tape_with_a_hole_before_the_fill_or_before_minute_15_is_sin_datos(self):
        hole = aud.SHADOW_TAPE_GAP_MS + 1
        cases = {"hueco_antes_de_cruzar": [(E + 10_000, 2250.0), (E + 10_000 + hole, 2250.0), (E + W, 2250.0)],
                 "hueco_al_inicio": [(E + 10_000 + hole, 2249.9), (E + W, 2250.0)],
                 "hueco_final": [(E + 10_000, 2250.0), (E + W - hole, 2250.0)]}
        for name, tape in cases.items():
            with self.subTest(name):
                cap = Capture(os.path.join(self.tmp, name + ".sqlite"))
                cap.book(E - 5_000, 2250.0, 2250.1)
                cap.trades(tape)
                cap.ticker(E + W + 5 * MIN)                                                                  # la captura sí llegó (otro evento)
                self.clear()
                aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
                row = self.only(leg="entry")
                self.assertEqual((row["estado"], row["motivo_sin_datos"]), ("sin_datos", "cinta_con_huecos"))
                self.assertEqual(row["limite_px"], 2250.0)                                                   # lo que sí se sabía queda

    def test_a_fill_after_a_quiet_but_covered_stretch_is_still_a_fill(self):
        cap = Capture(os.path.join(self.tmp, "quieta.sqlite"))
        cap.book(E - 5_000, 2250.0, 2250.1)
        cap.trades([(E + 100_000, 2250.0), (E + 100_000 + aud.SHADOW_TAPE_GAP_MS, 2249.9), (E + W, 2250.0)])    # el hueco es justo el máximo permitido
        aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
        self.assertEqual(self.only(leg="entry")["estado"], "maker")

    def test_no_trades_at_all_in_the_window_is_sin_datos(self):
        cap = Capture(os.path.join(self.tmp, "vacia.sqlite"))
        cap.book(E - 5_000, 2250.0, 2250.1)
        cap.ticker(E + W + 5 * MIN)
        aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
        self.assertEqual(self.only(leg="entry")["motivo_sin_datos"], "cinta_con_huecos")

    def test_a_crossed_or_empty_book_is_sin_datos(self):
        cap = Capture(os.path.join(self.tmp, "cruzado.sqlite"))
        cap.book(E - 5_000, 2250.2, 2250.1)
        cap.steady(E + 10_000, E + W + 5 * MIN, 2250.0)
        aud.resolve(self.path, PRODUCT, {}, CFG, E + HOUR, COST, market_db=cap.path)
        self.assertEqual(self.only(leg="entry")["motivo_sin_datos"], "libro_invalido")

    def test_a_product_the_capture_does_not_store_a_book_for_is_sin_datos_not_guessed(self):
        with self.store.db:
            self.store.put_trade("PF_XBTUSD", 50, status="open", side="LONG", entry_ms=E, entry_px="60000", qty="0.005",
                                 notional_usd="300", entry_reason="formula")
        aud.resolve(self.path, "PF_XBTUSD", {}, CFG, E + HOUR, COST, market_db=self.market)
        row, = shadow_rows(self.path, "product='PF_XBTUSD'")
        self.assertEqual((row["estado"], row["motivo_sin_datos"], row["trade_no"]), ("sin_datos", "producto_sin_captura", 50))

    def test_a_row_is_final_resolving_again_changes_nothing_and_adds_nothing(self):
        self.resolve_shadow(E + HOUR)
        first = shadow_rows(self.path)
        again = self.resolve_shadow(E + 5 * HOUR)
        self.assertEqual((again["sombra"], shadow_rows(self.path)), (0, first))

    def test_without_receipts_the_official_price_time_and_taker_fee_come_from_the_trade_row(self):
        self.put_trade(2, status="open", side="LONG", entry_ms=E + 2 * HOUR, entry_px="2250.1", qty="0.2", notional_usd="450.02",
                       entry_reason="formula")
        cap = Capture(os.path.join(self.tmp, "sin-recibos.sqlite"))
        cap.book(E + 2 * HOUR - 5_000, 2250.0, 2250.1)
        cap.steady(E + 2 * HOUR + 10_000, E + 2 * HOUR + W + 5 * MIN, 2250.0)
        aud.resolve(self.path, PRODUCT, {}, CFG, E + 4 * HOUR, COST, market_db=cap.path)
        row = shadow_rows(self.path, "trade_no=2")[0]
        self.assertEqual((row["t_oficial_ms"], row["precio_oficial"], row["comision_oficial_tipo"]), (E + 2 * HOUR, 2250.1, "taker"))
        self.assertAlmostEqual(row["comision_oficial_usd"], 2250.1 * 0.2 * 0.0005, places=9)


# --------------------------------------------------------------------------- acotado, solo lectura, nunca rompe


class BoundedAndSafeTests(ShadowCase):
    def build(self, legs=3):
        for k in range(legs):
            at = E + k * 2 * HOUR
            self.cap.book(at - 5_000, 2250.0, 2250.1)
            self.cap.steady(at + 10_000, at + W + 5 * MIN, 2250.0)
            self.trade(k + 1, entry=(2250.1, at))

    def test_at_most_a_fixed_number_of_legs_is_resolved_per_pass_oldest_first(self):
        self.build(3)
        with mock.patch.object(aud, "SHADOW_LEGS_PER_PASS", 2):
            self.assertEqual(self.resolve_shadow(E + 10 * HOUR)["sombra"], 2)
            self.assertEqual([r["trade_no"] for r in shadow_rows(self.path)], [1, 2])
            self.assertEqual(self.resolve_shadow(E + 10 * HOUR)["sombra"], 1)
        self.assertEqual([r["trade_no"] for r in shadow_rows(self.path)], [1, 2, 3])

    def test_three_legs_per_pass_by_default_and_the_number_comes_from_the_environment(self):
        name = "FUTURES_AUDITOR_SHADOW_LEGS_PER_PASS"
        self.assertEqual(aud.SHADOW_LEGS_PER_PASS, 3)
        self.assertEqual(aud._int_env(name, 3, {}), 3)
        self.assertEqual(aud._int_env(name, 3, {name: "5"}), 5)
        for bad in ("0", "-2", "tres", "", "2.5"):
            self.assertEqual(aud._int_env(name, 3, {name: bad}), 3, bad)                                   # un valor inválido no apaga nada: queda el de siempre

    def test_resolve_can_leave_the_shadow_for_a_quiet_poll_and_changes_nothing_else(self):
        self.build(3)
        result = aud.resolve(self.path, PRODUCT, {}, CFG, E + 10 * HOUR, COST, market_db=self.market, shadow=False)
        self.assertEqual((result["sombra"], result["sombra_estado"], result["avisos"], result["sombra_ms"]), (0, "diferida", [], 0.0))
        self.assertEqual(shadow_rows(self.path), [])
        self.assertEqual(self.resolve_shadow(E + 10 * HOUR)["sombra"], 3)                                  # y por defecto sigue calculándola

    def test_resolve_shadow_alone_does_only_the_shadow_and_says_how_many_legs_were_waiting(self):
        self.build(3)
        with mock.patch.object(aud, "SHADOW_LEGS_PER_PASS", 2):
            first = aud.resolve_shadow(self.path, PRODUCT, E + 10 * HOUR, self.market)
            second = aud.resolve_shadow(self.path, PRODUCT, E + 10 * HOUR, self.market)
        self.assertEqual((first["sombra"], first["sombra_pendientes"], first["sombra_estado"], first["avisos"]), (2, 3, "ok", []))
        self.assertEqual((second["sombra"], second["sombra_pendientes"]), (1, 1))
        self.assertEqual([r["trade_no"] for r in shadow_rows(self.path)], [1, 2, 3])
        self.assertGreaterEqual(first["sombra_ms"], 0.0)
        self.assertEqual((aud.resolve_shadow(self.path, PRODUCT, E + 10 * HOUR, None)["sombra_estado"]), "apagada")

    def test_resolve_shadow_never_raises_a_busy_database_is_a_warning(self):
        self.build(1)
        aud._open(self.path).close()
        blocker = sqlite3.connect(aud.auditor_path(self.path), isolation_level=None)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN EXCLUSIVE")
        with mock.patch.object(aud, "TRAINING_LOCK_TIMEOUT_S", 0.05):
            result = aud.resolve_shadow(self.path, PRODUCT, E + 10 * HOUR, self.market)
        self.assertEqual(result["sombra"], 0)
        self.assertTrue(result["avisos"])
        blocker.execute("ROLLBACK")

    def test_the_time_budget_stops_the_work_with_a_warning_and_writes_nothing_half_done(self):
        self.build(1)
        with mock.patch.object(aud, "SHADOW_BUDGET_S", -1.0):
            result = self.resolve_shadow(E + 10 * HOUR)
        self.assertEqual(shadow_rows(self.path), [])
        self.assertEqual(result["sombra"], 0)
        self.assertTrue(any(a.startswith("sombra:") for a in result["avisos"]), result["avisos"])
        self.assertEqual(self.resolve_shadow(E + 10 * HOUR)["sombra"], 1)                                   # y en la próxima pasada se hace

    def test_the_capture_is_only_read_never_written(self):
        self.build(2)
        before = hashlib.sha256(open(self.market, "rb").read()).hexdigest()
        self.resolve_shadow(E + 10 * HOUR)
        self.assertEqual(hashlib.sha256(open(self.market, "rb").read()).hexdigest(), before)
        self.assertFalse([f for f in os.listdir(self.tmp) if f.startswith("futures-market.sqlite-")])      # ni diario ni WAL
        with contextlib.closing(aud._open_capture(self.market, time.monotonic() + 5)) as capture:
            with self.assertRaises(sqlite3.OperationalError):
                capture.db.execute("DELETE FROM paper_futures_market_events")

    def test_every_capture_query_uses_the_time_index_never_a_scan(self):
        self.build(1)
        with contextlib.closing(sqlite3.connect(self.market)) as db:
            for name, sql, args in ((n, getattr(aud, n), a) for n, a in (
                    ("_SHADOW_SQL_HIGH_WATER", (PRODUCT,)), ("_SHADOW_SQL_BOOK", (PRODUCT, E - 20_000, E, "book")),
                    ("_SHADOW_SQL_SNAPSHOT", ("x",)), ("_SHADOW_SQL_TAPE", (PRODUCT, E, E + W, "trade", 100)))):
                plan = " | ".join(r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, args))
                self.assertNotIn("SCAN", plan.replace("SCAN CONSTANT", ""), (name, plan))
                self.assertTrue("paper_futures_market_received" in plan or "autoindex" in plan, (name, plan))

    def test_a_missing_capture_file_writes_nothing_creates_nothing_and_says_so_only_when_there_is_something_to_resolve(self):
        missing = os.path.join(self.tmp, "no-existe.sqlite")
        quiet = aud.resolve(self.path, PRODUCT, {}, CFG, E + 10 * HOUR, COST, market_db=missing)              # sin operaciones: nada que decir
        self.assertEqual((quiet["sombra"], quiet["sombra_estado"], quiet["avisos"]), (0, "ok", []))
        self.build(1)
        loud = aud.resolve(self.path, PRODUCT, {}, CFG, E + 10 * HOUR, COST, market_db=missing)
        self.assertEqual((loud["sombra"], loud["sombra_estado"], loud["avisos"]), (0, "sin_captura", []))     # esta máquina no tiene captura: no es un fallo
        self.assertEqual(shadow_rows(self.path), [])
        self.assertFalse(os.path.exists(missing))                                                           # no la crea
        self.assertEqual(self.resolve_shadow(E + 10 * HOUR)["sombra_estado"], "ok")                          # cuando aparece, se calcula

    def test_with_no_capture_configured_the_shadow_does_not_run_at_all(self):
        self.build(1)
        result = aud.resolve(self.path, PRODUCT, {}, CFG, E + 10 * HOUR, COST)                               # como antes de la sombra
        self.assertEqual((result["sombra"], result["sombra_estado"], result["avisos"]), (0, "apagada", []))
        self.assertEqual(shadow_rows(self.path), [])

    def test_a_failing_shadow_is_a_warning_and_leaves_every_other_result_and_row_identical(self):
        self.build(2)
        self.put_trade(9, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 2 * HOUR, entry_px="100", exit_px="101", net_bp=80.0,
                       closed_by="formula", exit_reason="maestro_vuelta", entry_reason="formula", funding_status="complete",
                       net_usd="0.8", notional_usd="100")
        closes = {t: 100.0 for t in range(T0 - HOUR, T0 + 40 * HOUR, qt.BAR_MS)}
        tables = ("miradas", "operaciones", "propuestas", "resultados_operacion", "hechos_mirada", "mirada_operaciones")

        def snapshot():
            con = sqlite3.connect(aud.auditor_path(self.path))
            try:
                return {t: con.execute("SELECT * FROM {} ORDER BY 1, 2".format(t)).fetchall() for t in tables}
            finally:
                con.close()

        aud.resolve(self.path, PRODUCT, closes, CFG, E + 40 * HOUR, COST)                                   # sin sombra: lo de siempre
        clean_none = aud.resolve(self.path, PRODUCT, closes, CFG, E + 40 * HOUR, COST)                      # (idempotente: la segunda pasada es la base)
        base = snapshot()
        for failure in (RuntimeError("roto"), OSError("disco"), sqlite3.DatabaseError("corrupta")):
            with self.subTest(failure=type(failure).__name__), mock.patch.object(aud, "_shadow_resolve_leg", side_effect=failure):
                broken = aud.resolve(self.path, PRODUCT, closes, CFG, E + 40 * HOUR, COST, market_db=self.market)
            same = ("miradas", "actualizadas", "veredictos", "pendientes", "direcciones", "operaciones", "propuestas", "resultados")
            self.assertEqual({k: broken[k] for k in same}, {k: clean_none[k] for k in same})
            self.assertEqual(snapshot(), base)
            self.assertEqual(broken["sombra"], 0)
            self.assertTrue(broken["avisos"] and all(a.startswith("sombra: ") for a in broken["avisos"]), broken["avisos"])
            self.assertEqual(shadow_rows(self.path), [])

    def test_a_busy_auditor_database_is_a_warning_not_a_stall(self):
        self.build(1)
        aud._open(self.path).close()
        blocker = sqlite3.connect(aud.auditor_path(self.path), isolation_level=None)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN EXCLUSIVE")
        with mock.patch.object(aud, "TRAINING_LOCK_TIMEOUT_S", 0.05):
            started = time.monotonic()
            result = aud._resolve_training(self.path, PRODUCT, aud._Prices({}), None, CFG, E + 10 * HOUR, COST, self.market)
            self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(result["avisos"])
        blocker.execute("ROLLBACK")


class SchemaTests(ShadowCase):
    def test_the_new_table_is_additive_with_the_agreed_columns_and_one_row_per_official_leg(self):
        aud._open(self.path).close()
        con = sqlite3.connect(aud.auditor_path(self.path))
        self.addCleanup(con.close)
        info = list(con.execute("PRAGMA table_info(sombra_maker)"))
        self.assertEqual(tuple(r[1] for r in info), SHADOW_COLUMNS)
        self.assertEqual([r[1] for r in info if r[5]], ["product", "trade_no", "leg"])                      # clave: una fila por tramo oficial
        notnull = {r[1] for r in info if r[3]}
        self.assertTrue({"product", "trade_no", "leg", "t_oficial_ms", "estado", "modelo", "version"} <= notnull)
        with self.assertRaises(sqlite3.IntegrityError):
            row = ("PF_ETHUSD", 1, "salida", None, 1, "venta", 1, 1.0, 0.1, "taker", 1.0, 1.0, None, None, "sin_datos", "sin_libro", None,
                   None, None, None, None, None, None, None, "m", "c", 1, "v")
            con.execute("INSERT INTO sombra_maker VALUES({})".format(",".join("?" * len(row))), row)
            con.execute("INSERT INTO sombra_maker VALUES({})".format(",".join("?" * len(row))), row)

    def test_an_old_auditor_database_only_gains_the_new_table(self):
        aud._open(self.path).close()
        con = sqlite3.connect(aud.auditor_path(self.path))
        self.addCleanup(con.close)
        old = {n: [tuple(r[1:3]) for r in con.execute("PRAGMA table_info({})".format(n))] for (n,) in
               con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sombra_maker'")}
        con.execute("DROP TABLE sombra_maker")
        con.commit()
        aud._open(self.path).close()                                                      # abre con el código nuevo
        new = {n: [tuple(r[1:3]) for r in con.execute("PRAGMA table_info({})".format(n))] for (n,) in
               con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sombra_maker'")}
        self.assertEqual(new, old)
        self.assertTrue(con.execute("PRAGMA table_info(sombra_maker)").fetchall())


# --------------------------------------------------------------------------- el proceso en vivo: ninguna diferencia oficial


class LiveShadowTests(unittest.TestCase):
    """El operador en vivo con un maestro guionado: con la sombra encendida (y con la sombra rota) lo oficial queda idéntico."""

    SCRIPT = {1: 2, 2: 2, 3: 0, 4: 2, 5: 2, 6: -2, 7: -2, 8: -2}          # veredicto por mirada (k = 15 min desde BASE), como en LiveTrainingTests
    TABLES = ("decisions", "trades", "execution_receipts", "trader_state", "errors", "examples", "skipped", "news_actions")
    AUDITOR = ("miradas", "operaciones", "hechos_mirada", "propuestas", "mirada_operaciones", "resultados_operacion", "reentrenos")

    @staticmethod
    def rows(env, sql):
        con = sqlite3.connect(os.path.join(env.tmp, "auditor.sqlite"))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql)]
        finally:
            con.close()

    def run_live(self, *, market=None, shadow_fails=False, minutes=180, quiet=True):
        cfg = copy.deepcopy(CFG)
        cfg["products"] = [PRODUCT]
        cfg["runtime"].pop("pending_config", None)
        cfg["posiciones"] = {"max": 2, "fraccion": 0.5, "espera_entre_entradas_min": 0}
        cfg["guardrails"]["cooldown_min"] = 30
        if market is not None:
            cfg["market_db"] = market
        env = make(self, cfg=cfg, policy=Policy(flat="ESPERAR", position="MANTENER"), formula=True)
        real = corta.readings
        base = qt.date_ms("2026-10-20")

        def scripted(trader, t_ms, f=None):
            out = real(trader, t_ms, f)
            v = self.SCRIPT.get((t_ms - base) // (15 * MIN), 0)
            return dict(out, veredicto=v, puntaje=v * 2.0, portero_si=bool(v), portero_direccion=None, portero_autonomo=None)

        patches = [mock.patch.object(corta, "readings", scripted)]
        if shadow_fails:
            patches.append(mock.patch.object(aud, "_shadow_resolve_leg", side_effect=RuntimeError("sombra rota")))
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            env.op.start()
            env.advance(minutes, quiet=quiet)
        return env

    def capture_for(self, trades):
        """Una captura con libro y cinta alrededor de CADA tramo oficial de ``trades`` (la mitad de los tramos llenan, la otra cruzan)."""
        path = os.path.join(tempfile.mkdtemp(), "futures-market.sqlite")
        cap = Capture(path)
        for k, leg in enumerate(sorted(trades, key=lambda leg: leg[0])):
            at, price = leg
            cap.book(at - 5_000, round(price - 0.05, 1), round(price + 0.05, 1))
            cap.steady(at + 10_000, at + W + 3 * MIN, round(price - 0.05, 1) if k % 2 else round(price, 1))
            if k % 2 == 0:
                cap.trades([(at + 60_000, round(price - 0.3, 1))])
        return path

    def legs_of(self, env):
        out = []
        for t in env.rows("SELECT * FROM trades ORDER BY trade_no"):
            out.append((int(t["entry_ms"]), float(t["entry_px"])))
            if t["exit_ms"] is not None:
                out.append((int(t["exit_ms"]), float(t["exit_px"])))
        return out

    def official(self, env):
        out = {name: env.rows("SELECT * FROM {} ORDER BY 1, 2".format(name)) for name in self.TABLES}
        out.update({name: self.rows(env, "SELECT * FROM {} ORDER BY 1, 2".format(name)) for name in self.AUDITOR})
        return out

    def test_the_official_terminal_is_identical_with_the_shadow_on_off_or_broken_and_each_leg_gets_its_row(self):
        base = self.run_live()
        legs = self.legs_of(base)
        self.assertGreaterEqual(len(legs), 4)                                                               # hubo entradas y salidas
        market = self.capture_for(legs)
        with_shadow = self.run_live(market=market)
        broken = self.run_live(market=market, shadow_fails=True)
        off = self.official(base)
        for name, rows in off.items():
            if name == "errors":
                continue
            self.assertEqual(self.official(with_shadow)[name], rows, name)
            self.assertEqual(self.official(broken)[name], rows, name)
        self.assertEqual(self.rows(base, "SELECT name FROM sqlite_master WHERE name='sombra_maker'"), [{"name": "sombra_maker"}])
        self.assertEqual(self.rows(base, "SELECT * FROM sombra_maker"), [])                                  # sin el archivo de captura: nada
        self.assertEqual(len([line for line in base.logs if "base de captura" in line]), 1)                  # y se dice una sola vez, no en cada ciclo
        self.assertEqual(base.rows("SELECT * FROM errors"), [])                                              # no es un fallo
        rows = self.rows(with_shadow, "SELECT * FROM sombra_maker ORDER BY t_oficial_ms, leg")
        self.assertEqual(len(rows), len(legs))
        self.assertEqual({r["estado"] for r in rows}, {"maker", "maker_mercado"})
        self.assertEqual({r["leg"] for r in rows}, {"entry", "exit"})
        self.assertEqual(with_shadow.rows("SELECT * FROM errors"), [])
        # la sombra rota: ninguna fila, un aviso y el sondeo sigue (no es un ciclo fallido)
        self.assertEqual(self.rows(broken, "SELECT * FROM sombra_maker"), [])
        errors = broken.rows("SELECT place, kind FROM errors")
        self.assertTrue(errors and all(e == {"place": "auditor_entrenar", "kind": "RuntimeError"} for e in errors), errors)
        self.assertFalse(broken.op.failed_cycle)
        # y solo cambia ``errors`` (y la tabla nueva)
        self.assertNotEqual(self.official(broken)["errors"], off["errors"])

    def quiet_poll(self, env):
        env.now[0] += 5_000
        env.op.poll()
        return len(self.rows(env, "SELECT * FROM sombra_maker"))

    def test_the_look_poll_never_runs_the_shadow_and_pending_legs_are_resolved_three_per_later_quiet_poll(self):
        base = self.run_live()
        market = self.capture_for(self.legs_of(base))
        everything = len(self.rows(self.run_live(market=market), "SELECT * FROM sombra_maker"))             # lo que da la sombra con sondeos tranquilos
        self.assertGreater(everything, 3)
        calls = []
        real = aud._resolve_shadow
        with mock.patch.object(aud, "_resolve_shadow", lambda *args, **kwargs: calls.append(1) or real(*args, **kwargs)):
            env = self.run_live(market=market, quiet=False)                                                  # solo sondeos con vela nueva (las miradas)
            self.assertEqual((calls, self.rows(env, "SELECT * FROM sombra_maker")), ([], []))                # ninguno corrió la sombra
            counts = [self.quiet_poll(env) for _ in range(everything // 3 + 1)]
        self.assertEqual(counts, [min(3 * (k + 1), everything) for k in range(len(counts))])                 # tres tramos por sondeo tranquilo, los más viejos primero
        self.assertEqual(counts[-1], everything)                                                             # y al final se resolvieron todos
        self.assertEqual(env.rows("SELECT * FROM errors"), [])
        without_clock = lambda rows: [{k: v for k, v in r.items() if k != "resuelto_ms"} for r in rows]          # (cuándo se calculó cambia; lo calculado no)
        self.assertEqual(without_clock(self.rows(env, "SELECT * FROM sombra_maker ORDER BY t_oficial_ms, leg")),
                         without_clock(self.rows(self.run_live(market=market), "SELECT * FROM sombra_maker ORDER BY t_oficial_ms, leg")))

    def test_a_quiet_poll_with_nothing_pending_does_not_look_again_for_30_seconds(self):
        base = self.run_live()
        env = self.run_live(market=self.capture_for(self.legs_of(base)))
        for _ in range(6):
            self.quiet_poll(env)                                                                              # se vacía lo que quedaba
        with mock.patch.object(aud, "_shadow_pending", wraps=aud._shadow_pending) as spy:
            env.now[0] += 30_000
            env.op.poll()
            looked = spy.call_count
            self.assertEqual(looked, 1)                                                                       # mira y no hay nada
            for _ in range(5):
                self.quiet_poll(env)
            self.assertEqual(spy.call_count, looked)                                                          # 25 s después: sigue sin mirar
            env.now[0] += 30_000
            env.op.poll()
            self.assertEqual(spy.call_count, looked + 1)

    def test_the_live_poll_with_the_shadow_stays_fast(self):
        base = self.run_live()
        market = self.capture_for(self.legs_of(base))
        started = time.monotonic()
        self.run_live(market=market)
        self.assertLess(time.monotonic() - started, 120)


if __name__ == "__main__":
    unittest.main()
