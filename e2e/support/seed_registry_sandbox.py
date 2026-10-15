"""Seeds the databases the strategy registry S reads in the real-server e2e.

DATOS DE EJEMPLO: the candles are the synthetic random walk of the Python
tests (not market data) and the verdicts are computed from them with the real
verdict engine. Nothing here is a Kraken record or a real result. Usage:
`PYTHONPATH=python python3 e2e/support/seed_registry_sandbox.py <dir>`; prints
the two paths as JSON.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python", "tests"))

from balancita_engine.futures_verdicts import VERDICT_CONFIG, VerdictStore, product_config  # noqa: E402
from test_futures_strategy_registry import BTC, VERDICTS, _market_db  # noqa: E402


def main(directory):
    verdicts_db = os.path.join(directory, "registry-verdicts.sqlite")
    market_db = os.path.join(directory, "registry-market.sqlite")
    store = VerdictStore(verdicts_db, product_config(VERDICT_CONFIG, BTC, "1"))
    store.register_product(BTC, "1")
    for verdict in VERDICTS:
        store.append(verdict)
    store.close()
    _market_db(market_db)
    print(json.dumps({"verdicts_db": verdicts_db, "market_db": market_db, "label": "DATOS DE EJEMPLO"}))


if __name__ == "__main__":
    main(sys.argv[1])
