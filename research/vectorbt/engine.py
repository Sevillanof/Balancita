"""Puts Balancita's engine (stdlib only) on the import path and re-exports what the lab reads from it."""

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_ENGINE_PATH = os.path.join(ROOT, "python")
if _ENGINE_PATH not in sys.path:
    sys.path.insert(0, _ENGINE_PATH)

from balancita_engine import futures_costs  # noqa: E402
from balancita_engine.futures_history import CandleCache, fetch_funding, fill_gaps  # noqa: E402,F401
from balancita_engine.futures_simulator import Book, DEFAULT_PERIODS, frames, merge_periods  # noqa: E402,F401
from balancita_engine.futures_spec_strategy import declared_indicators, load_spec, propose_spec  # noqa: E402,F401
