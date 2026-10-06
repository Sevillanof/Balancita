"""Pinned set of Kraken public ``PF_*`` perpetuals (ADR 0001, amendment 2026-10-06).

The list lives in ``config/futures-products.json``, shared with the Node
capture, and is never chosen at runtime, so a replay sees the same products and
tick sizes. ``FUTURES_PRODUCTS`` (or an explicit spec) is a comma-separated list
of ``PF_X`` or ``PF_X:tickSize``; a pinned product may omit its tick size.
"""

import json
import os
import re
from decimal import Decimal, InvalidOperation

BTC_PRODUCT = "PF_XBTUSD"
MAX_PRODUCTS = 20
PINNED_PRODUCTS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "config", "futures-products.json",
)
_PRODUCT_ID = re.compile(r"^PF_[A-Z0-9]{2,20}$")
_DECIMAL = re.compile(r"^\d+(\.\d+)?$")


def is_product_id(value):
    return isinstance(value, str) and _PRODUCT_ID.match(value) is not None


def _plain_decimal(value):
    """Plain decimal text without exponent or trailing zeros, or None."""
    if not isinstance(value, str) or not _DECIMAL.match(value.strip()):
        return None
    text = value.strip().lstrip("0") or "0"
    if text.startswith("."):
        text = "0" + text
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def _product(product_id, tick_size):
    if not is_product_id(product_id):
        raise ValueError("invalid futures product {!r}".format(product_id))
    tick = _plain_decimal(tick_size)
    try:
        positive = tick is not None and Decimal(tick) > 0
    except InvalidOperation:
        positive = False
    if not positive:
        raise ValueError("invalid tick size {!r} for {}".format(tick_size, product_id))
    return (product_id, tick)


def _assert_unique(products):
    if len(set(product_id for product_id, _ in products)) != len(products):
        raise ValueError("duplicate futures product in the list")


def load_pinned_products(path=None):
    with open(path or PINNED_PRODUCTS_PATH) as handle:
        body = json.load(handle)
    products = [_product(item["product_id"], item["tick_size"]) for item in body["products"]]
    if not products:
        raise ValueError("pinned futures products file has no products")
    _assert_unique(products)
    return products


def resolve_products(spec=None, env=None):
    """Ordered ``[(product_id, tick_size)]``: ``spec``, else ``FUTURES_PRODUCTS``, else the pinned list."""
    env = os.environ if env is None else env
    pinned = load_pinned_products()
    text = (spec if spec is not None else env.get("FUTURES_PRODUCTS", "")).strip()
    if not text:
        return pinned
    known = dict(pinned)
    products = []
    for entry in text.split(","):
        parts = entry.strip().split(":")
        if len(parts) > 2 or not is_product_id(parts[0]):
            raise ValueError("invalid futures product {!r}".format(entry))
        product_id = parts[0]
        if len(parts) == 1:
            if product_id not in known:
                raise ValueError("product {} needs a tick size ({}:0.01)".format(product_id, product_id))
            products.append((product_id, known[product_id]))
            continue
        given = _product(product_id, parts[1])
        if product_id in known and known[product_id] != given[1]:
            raise ValueError("tick size {} of {} differs from the pinned {}".format(
                given[1], product_id, known[product_id]))
        products.append(given)
    _assert_unique(products)
    if len(products) > MAX_PRODUCTS:
        raise ValueError("at most {} futures products are allowed".format(MAX_PRODUCTS))
    if BTC_PRODUCT not in [product_id for product_id, _ in products]:
        raise ValueError("the product list must include {}".format(BTC_PRODUCT))
    return products
