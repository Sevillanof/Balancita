"""Historical compatibility subjects, never a fallback for production inventory.

The JSON snapshots are copied unchanged from config/strategies/ at 5c7046bc,
before the owner's C29/C30 deletion overlay. They preserve the original rules,
including legacy time stops; they do not authorize shipping or activating them.
"""

from pathlib import Path

from balancita_engine.futures_spec_strategy import load_spec

HISTORICAL_SPEC_DIR = Path(__file__).resolve().parent / "fixtures" / "strategies"
HISTORICAL_SPEC_IDS = ("c29-momentum-perp-v1", "c30-momentum-12h-perp-v1")


def historical_spec(strategy_id="c29-momentum-perp-v1"):
    """Load a validated, fresh snapshot so parameter mutations cannot leak."""
    if strategy_id not in HISTORICAL_SPEC_IDS:
        raise ValueError("not a historical test fixture: " + strategy_id)
    return load_spec(HISTORICAL_SPEC_DIR / (strategy_id + ".json"))
