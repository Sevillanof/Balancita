"""Public ETH depth pricing for paper fills. Never submits an exchange order."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext, ROUND_DOWN, ROUND_HALF_EVEN
import hashlib
import json
import time
from typing import Callable
import urllib.error
import urllib.request

from .canonical import canonical_hash
from .futures_costs import TAKER_RATE
from . import system_trust

MODEL = "kraken-futures-book.v1"
MAX_QUOTE_AGE_MS = 3000
MAX_SIGNAL_AGE_MS = 15000
PRECISION = 28
URL = "https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_ETHUSD"


class BookError(ValueError):
    def __init__(self, kind: str, detail: str):
        super().__init__(detail)
        self.kind, self.detail = kind, detail


def utc_text(at_ms: int) -> str:
    return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=at_ms)).isoformat().replace("+00:00", "Z")


def _decimal(value) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise BookError("libro_invalido", "El libro requiere números decimales exactos.")
    number = Decimal(value)
    if not number.is_finite():
        raise BookError("libro_invalido", "El libro contiene un número no finito.")
    return number


def _levels(raw, *, reverse: bool) -> tuple[tuple[Decimal, Decimal], ...]:
    if not isinstance(raw, list):
        raise BookError("libro_invalido", "Faltan los niveles del libro.")
    out = {}
    for pair in raw:
        if not isinstance(pair, list) or len(pair) != 2:
            raise BookError("libro_invalido", "Nivel de libro inválido.")
        price, quantity = (_decimal(value) for value in pair)
        if price <= 0 or quantity < 0:
            raise BookError("libro_invalido", "Precio o cantidad del libro inválidos.")
        if quantity > 0:
            with localcontext() as ctx:
                ctx.prec = PRECISION
                out[price] = quantity if price not in out else out[price] + quantity
    return tuple(sorted(out.items(), reverse=reverse))


@dataclass(frozen=True)
class BookSnapshot:
    product: str
    bids: tuple[tuple[Decimal, Decimal], ...]
    asks: tuple[tuple[Decimal, Decimal], ...]
    requested_at_ms: int
    received_at_ms: int
    server_at_ms: int
    response_sha256: str

    @property
    def mid(self) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            ctx.rounding = ROUND_HALF_EVEN
            return (self.bids[0][0] + self.asks[0][0]) / 2

    @classmethod
    def from_response(cls, raw: bytes, product: str, *, requested_at_ms: int, received_at_ms: int):
        if product != "PF_ETHUSD":
            raise BookError("libro_invalido", "Este modelo de ejecución solo acepta PF_ETHUSD.")
        if (type(requested_at_ms) is not int or type(received_at_ms) is not int
                or not 0 < requested_at_ms <= received_at_ms):
            raise BookError("libro_invalido", "Faltan tiempos de solicitud y recepción válidos.")
        try:
            body = json.loads(raw, parse_float=Decimal)
            if not isinstance(body, dict) or body.get("result") != "success":
                raise BookError("libro_no_disponible", "Kraken no devolvió un libro válido.")
            server = datetime.fromisoformat(body["serverTime"].replace("Z", "+00:00"))
            if server.tzinfo is None:
                raise BookError("libro_invalido", "El tiempo del servidor no tiene zona horaria.")
            bids = _levels(body["orderBook"]["bids"], reverse=True)
            asks = _levels(body["orderBook"]["asks"], reverse=False)
        except BookError:
            raise
        except (KeyError, TypeError, ArithmeticError, ValueError) as error:
            raise BookError("libro_invalido", "No se pudo interpretar el libro público: " + str(error)) from error
        if not bids or not asks or bids[0][0] >= asks[0][0]:
            raise BookError("libro_invalido", "Libro vacío o cruzado.")
        elapsed = server - datetime(1970, 1, 1, tzinfo=timezone.utc)
        server_ms = elapsed.days * 86_400_000 + elapsed.seconds * 1000 + elapsed.microseconds // 1000
        return cls(product, bids, asks, requested_at_ms, received_at_ms,
                   server_ms, hashlib.sha256(raw).hexdigest())

    def evidence(self) -> dict:
        return {
            "product": self.product, "source": URL, "response_sha256": self.response_sha256,
            "requested_at_ms": self.requested_at_ms, "received_at_ms": self.received_at_ms,
            "server_at_ms": self.server_at_ms,
            "server_time_kind": "response_generation_not_book_event",
            "bids": [[str(p), str(q)] for p, q in self.bids[:5]],
            "asks": [[str(p), str(q)] for p, q in self.asks[:5]],
        }


def fetch_snapshot(product: str) -> BookSnapshot:
    if product != "PF_ETHUSD":
        raise BookError("libro_invalido", "Solo se consulta el contrato público PF_ETHUSD.")
    system_trust.install()
    requested = int(time.time() * 1000)
    try:
        request = urllib.request.Request(URL, headers={"User-Agent": "balancita-paper-execution"})
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read(4_000_001)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise BookError("libro_no_disponible", "No se pudo recibir el libro público: " + str(error)) from error
    received = int(time.time() * 1000)
    if len(raw) > 4_000_000:
        raise BookError("libro_invalido", "La respuesta del libro excede el límite de tamaño.")
    return BookSnapshot.from_response(raw, product, requested_at_ms=requested, received_at_ms=received)


@dataclass(frozen=True)
class BookFill:
    quote: BookSnapshot
    side: str
    quantity: Decimal
    price: Decimal
    notional: Decimal
    fee_rate: Decimal
    levels: tuple[tuple[Decimal, Decimal], ...]
    requested_amount: Decimal
    signal_at_ms: int
    decision_at_ms: int
    executed_at_ms: int
    purpose: str

    @property
    def fee(self) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            ctx.rounding = ROUND_HALF_EVEN
            return self.notional * self.fee_rate

    def evidence(self) -> dict:
        profile = {"model": MODEL, "product": self.quote.product, "taker_rate": str(self.fee_rate),
                   "decimal_precision": PRECISION, "static_impact_applied": False,
                   "walk_rounding": "ROUND_DOWN", "fee_rounding": "ROUND_HALF_EVEN"}
        return {
            **profile, "cost_model_hash": canonical_hash(profile), "fee_kind": "taker",
            "quantity": str(self.quantity), "price": str(self.price), "notional_usd": str(self.notional),
            "requested_amount": str(self.requested_amount),
            "size_kind": "notional" if self.purpose == "entry" else "quantity",
            "fee_usd": str(self.fee), "side": self.side, "purpose": self.purpose,
            "signal_at_ms": self.signal_at_ms,
            "decision_at_ms": self.decision_at_ms, "executed_at_ms": self.executed_at_ms,
            "quote": self.quote.evidence(), "reference_mid": str(self.quote.mid),
            "consumed_levels": [[str(p), str(q)] for p, q in self.levels],
            "classification": "paper_simulated_from_displayed_depth",
        }


class BookExecution:
    def __init__(self, snapshot_for: Callable[[str], BookSnapshot], now_ms: Callable[[], int]):
        self.snapshot_for, self.now_ms = snapshot_for, now_ms
        self.fee_rate = Decimal(TAKER_RATE)

    def _quote(self, product: str, signal_ms: int, purpose: str):
        if product != "PF_ETHUSD" or type(signal_ms) is not int or signal_ms <= 0:
            raise BookError("libro_invalido", "Producto o tiempo de decisión inválidos.")
        decision_at = now = self.now_ms()
        if purpose != "mark" and not 0 <= now - signal_ms <= MAX_SIGNAL_AGE_MS:
            raise BookError("ejecucion_tarde", "La decisión excedió los 15 segundos permitidos.")
        quote = self.snapshot_for(product)
        now = self.now_ms()
        if purpose != "mark" and not 0 <= now - signal_ms <= MAX_SIGNAL_AGE_MS:
            raise BookError("ejecucion_tarde", "La decisión venció durante la recepción del libro.")
        if quote.product != product:
            raise BookError("libro_invalido", "El libro pertenece a otro producto.")
        if (not 0 <= now - quote.received_at_ms <= MAX_QUOTE_AGE_MS
                or abs(now - quote.server_at_ms) > MAX_QUOTE_AGE_MS):
            raise BookError("libro_obsoleto", "El libro supera los 3 segundos de vigencia.")
        return quote, now, decision_at

    def _fill(self, product, side, amount, signal_ms, *, by_quantity, purpose):
        if side not in ("LONG", "SHORT"):
            raise BookError("libro_invalido", "Lado de ejecución inválido.")
        amount = _decimal(amount)
        if amount <= 0:
            raise BookError("liquidez_insuficiente", "El tamaño solicitado debe ser positivo.")
        quote, now, decision_at = self._quote(product, signal_ms, purpose)
        levels = quote.asks if side == "LONG" else quote.bids
        with localcontext() as ctx:
            ctx.prec = PRECISION
            ctx.rounding = ROUND_DOWN
            remaining, quantity, value, consumed = amount, Decimal(0), Decimal(0), []
            for price, available in levels:
                capacity = available if by_quantity else available * price
                complete = capacity >= remaining
                take = min(available, remaining if by_quantity else remaining / price)
                quantity += take
                value += take * price
                consumed.append((price, available))
                remaining -= take if by_quantity else take * price
                if complete:
                    average = consumed[0][0] if len(consumed) == 1 else value / quantity
                    return BookFill(quote, side, quantity, average, value,
                                    self.fee_rate, tuple(consumed), amount, signal_ms, decision_at, now, purpose)
        raise BookError("liquidez_insuficiente", "La profundidad publicada no cubre toda la operación.")

    def entry(self, product, side, notional, signal_ms):
        return self._fill(product, side, notional, signal_ms, by_quantity=False, purpose="entry")

    def exit(self, product, position_side, quantity, signal_ms, *, purpose="exit"):
        if position_side not in ("LONG", "SHORT"):
            raise BookError("libro_invalido", "Lado de posición inválido.")
        return self._fill(product, "SHORT" if position_side == "LONG" else "LONG",
                          quantity, signal_ms, by_quantity=True, purpose=purpose)


def replay_fill(evidence: dict) -> BookFill:
    """Recompute a recorded fill with its own depth, clock and fee, never today's market."""
    try:
        profile_keys = ("model", "product", "taker_rate", "decimal_precision",
                        "static_impact_applied", "walk_rounding", "fee_rounding")
        profile = {key: evidence[key] for key in profile_keys}
        if (evidence["model"] != MODEL or evidence["product"] != "PF_ETHUSD"
                or evidence["fee_kind"] != "taker" or evidence["decimal_precision"] != PRECISION
                or evidence["static_impact_applied"] is not False
                or evidence["walk_rounding"] != "ROUND_DOWN" or evidence["fee_rounding"] != "ROUND_HALF_EVEN"
                or canonical_hash(profile) != evidence["cost_model_hash"]
                or evidence["classification"] != "paper_simulated_from_displayed_depth"):
            raise BookError("recibo_invalido", "El recibo no declara un modelo de costes válido.")
        purpose, side = evidence["purpose"], evidence["side"]
        if purpose not in ("entry", "exit", "mark", "funding") or side not in ("LONG", "SHORT"):
            raise BookError("recibo_invalido", "Acción de recibo inválida.")
        q = evidence["quote"]
        times = [evidence[key] for key in ("signal_at_ms", "decision_at_ms", "executed_at_ms")]
        if (any(type(value) is not int or value <= 0 for value in times)
                or not times[0] <= times[1] <= times[2]
                or q["source"] != URL or q["product"] != evidence["product"]
                or q["server_time_kind"] != "response_generation_not_book_event"
                or not 0 < q["requested_at_ms"] <= q["received_at_ms"] <= times[2]
                or len(bytes.fromhex(q["response_sha256"])) != 32):
            raise BookError("recibo_invalido", "Tiempos o procedencia del recibo inválidos.")
        bids, asks = dict(_levels(q["bids"], reverse=True)), dict(_levels(q["asks"], reverse=False))
        destination = asks if side == "LONG" else bids
        for price, quantity in _levels(evidence["consumed_levels"], reverse=side == "SHORT"):
            if price in destination and destination[price] != quantity:
                raise BookError("recibo_invalido", "La profundidad consumida contradice la cotización.")
            destination[price] = quantity
        snapshot = BookSnapshot(
            evidence["product"], tuple(sorted(bids.items(), reverse=True)), tuple(sorted(asks.items())),
            q["requested_at_ms"], q["received_at_ms"], q["server_at_ms"], q["response_sha256"],
        )
        if not snapshot.bids or not snapshot.asks or snapshot.bids[0][0] >= snapshot.asks[0][0]:
            raise BookError("recibo_invalido", "El recibo contiene un libro vacío o cruzado.")
        clock = [times[1]]
        def recorded(product):
            if product != snapshot.product:
                raise BookError("recibo_invalido", "El recibo no pertenece al producto solicitado.")
            clock[0] = times[2]
            return snapshot
        execution = BookExecution(recorded, lambda: clock[0])
        execution.fee_rate = _decimal(evidence["taker_rate"])
        if not 0 <= execution.fee_rate < 1:
            raise BookError("recibo_invalido", "Comisión del recibo inválida.")
        expected_kind = "notional" if purpose == "entry" else "quantity"
        if evidence["size_kind"] != expected_kind:
            raise BookError("recibo_invalido", "Unidad del tamaño del recibo inválida.")
        fill = execution._fill(evidence["product"], side, evidence["requested_amount"], times[0],
                               by_quantity=expected_kind == "quantity",
                               purpose="exit" if purpose == "funding" else purpose)
        recalculated = fill.evidence()
        for key in ("price", "quantity", "notional_usd", "fee_usd", "cost_model_hash"):
            if recalculated[key] != evidence[key]:
                raise BookError("recibo_invalido", "El cálculo del recibo no coincide: " + key)
        return fill
    except BookError:
        raise
    except (KeyError, TypeError, ValueError, ArithmeticError) as error:
        raise BookError("recibo_invalido", "No se puede reproducir el recibo: " + str(error)) from error
