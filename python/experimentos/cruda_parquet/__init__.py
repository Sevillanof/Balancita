"""Issue #248: OFFLINE experiment on preserving original Kraken messages. Synthetic data only.

Nothing here reads a real database or capture, connects to Kraken, or is imported by the engine or the capture.
Only this package may ever import ``pyarrow`` or ``duckdb`` (guarded by python/tests/test_cruda_aislamiento.py).
"""
