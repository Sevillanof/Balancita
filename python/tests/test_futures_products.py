import json
import os
import unittest

from balancita_engine.futures_products import (
    PINNED_PRODUCTS_PATH,
    load_pinned_products,
    resolve_products,
)


class PinnedProductsTests(unittest.TestCase):
    def test_pins_eight_perpetuals_with_btc_first_and_eth_included(self):
        products = load_pinned_products()
        self.assertEqual(len(products), 8)
        self.assertEqual(products[0], ("PF_XBTUSD", "1"))
        ids = [product_id for product_id, _ in products]
        self.assertIn("PF_ETHUSD", ids)
        self.assertEqual(len(set(ids)), 8)
        self.assertEqual(dict(products)["PF_ADAUSD"], "0.00001")
        for product_id, tick in products:
            self.assertRegex(product_id, r"^PF_[A-Z0-9]+$")
            self.assertRegex(tick, r"^\d+(\.\d+)?$")

    def test_reads_the_same_file_as_the_server(self):
        self.assertTrue(PINNED_PRODUCTS_PATH.endswith(os.path.join("config", "futures-products.json")))
        with open(PINNED_PRODUCTS_PATH) as handle:
            body = json.load(handle)
        self.assertEqual(
            [(item["product_id"], item["tick_size"]) for item in body["products"]], load_pinned_products()
        )

    def test_defaults_to_the_pinned_list(self):
        self.assertEqual(resolve_products(None, {}), load_pinned_products())
        self.assertEqual(resolve_products("  ", {}), load_pinned_products())
        self.assertEqual(resolve_products(None, {"FUTURES_PRODUCTS": ""}), load_pinned_products())

    def test_selects_a_subset_and_accepts_unpinned_products_with_a_tick(self):
        self.assertEqual(
            resolve_products("PF_XBTUSD, PF_SOLUSD", {}), [("PF_XBTUSD", "1"), ("PF_SOLUSD", "0.01")]
        )
        self.assertEqual(
            resolve_products(None, {"FUTURES_PRODUCTS": "PF_XBTUSD,PF_LINKUSD:0.0010"}),
            [("PF_XBTUSD", "1"), ("PF_LINKUSD", "0.001")],
        )
        # An explicit argument wins over the environment.
        self.assertEqual(resolve_products("PF_XBTUSD", {"FUTURES_PRODUCTS": "PF_XBTUSD,PF_ETHUSD"}),
                         [("PF_XBTUSD", "1")])

    def test_rejects_unusable_lists(self):
        for spec, pattern in (
            ("PF_ETHUSD", "PF_XBTUSD"),
            ("PF_XBTUSD,PF_XBTUSD", "duplicate"),
            ("PF_XBTUSD,PF_LINKUSD", "tick size"),
            ("PF_XBTUSD,pf_ethusd", "invalid"),
            ("PF_XBTUSD,FI_XBTUSD_261225:1", "invalid"),
            ("PF_XBTUSD,PF_LINKUSD:0", "tick size"),
            ("PF_XBTUSD,PF_ETHUSD:0.5", "pinned"),
        ):
            with self.assertRaisesRegex(ValueError, "(?i)" + pattern, msg=spec):
                resolve_products(spec, {})


if __name__ == "__main__":
    unittest.main()
