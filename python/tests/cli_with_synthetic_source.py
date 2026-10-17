"""Test entry to the command line of the paper process with the synthetic fixture turned on (the product's command line refuses it).

Used as ``python cli_with_synthetic_source.py run ...`` by the tests that need a real process (signals, kill, restart)."""
import sys

from balancita_engine import paper_live_process as LP

if __name__ == "__main__":
    LP.SYNTHETIC_CLI = True
    sys.exit(LP.main())
