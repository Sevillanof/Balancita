"""Per-product trading lots for the pinned PF_* perpetuals.

``contractValueTradePrecision`` of each instrument (Kraken ``/instruments``,
2026-10-07, see ``analisis/costes-reales-kraken.md``): the smallest quantity step
in base units. Tick sizes live in ``config/futures-products.json``.
"""

from decimal import Decimal

LOT_SIZES = {
    "PF_XBTUSD": "0.0001",
    "PF_ETHUSD": "0.001",
    "PF_SOLUSD": "0.01",
    "PF_ZECUSD": "0.01",
    "PF_HYPEUSD": "0.1",
    "PF_XRPUSD": "1",
    "PF_NEARUSD": "1",
    "PF_ADAUSD": "1",
}


def lot_size(product_id):
    """Quantity step (and minimum) of a product; unknown products are refused, not guessed."""
    try:
        return LOT_SIZES[product_id]
    except KeyError:
        raise ValueError("no lot size pinned for {}".format(product_id)) from None


def lot_decimal(product_id):
    return Decimal(lot_size(product_id))
