# kronos_lab: Kronos-small as an independent paper strategy

Isolated on purpose: no module of `balancita_engine`, the server, the registry, the forward table or the Qwen
prompts imports it, and it writes only to its own `kronos.sqlite`. Delete the folder and nothing else changes.

Rule (fixed in `lab.py`, `kronos-small-1h-h4-v1`): hourly candles from the market DB, last 400 shown to
Kronos-small, 8 sampled paths, mean predicted 4 h ln-return; trade only if it exceeds 2x the product's round-trip
cost (`futures_costs`), long or short, 100 USD at the next open, exit after 4 h, one position per product,
taker fills. Funding is not modelled yet.

## Run (needs the Kronos weights, so on a machine that can reach huggingface.co)

    git clone https://github.com/shiyu-coder/Kronos ~/Kronos        # MIT
    python3 -m venv .venv-kronos && .venv-kronos/bin/pip install -r python/kronos_lab/requirements.txt
    export KRONOS_REPO=~/Kronos
    # live, out of sample: only hours closed after the first run count
    PYTHONPATH=python .venv-kronos/bin/python -m kronos_lab.lab --market-db server/data/market.sqlite \
        --out server/data/kronos --mode forward --loop-seconds 3600
    # plumbing check on the last 30 days (CONTAMINATED: Kronos was pre-trained on this history)
    PYTHONPATH=python .venv-kronos/bin/python -m kronos_lab.lab --market-db server/data/market.sqlite \
        --out server/data/kronos-backtest --mode backtest --days 30 --stride 4

`kronos-summary.json` reports `forward` and `backtest` separately with the same reliability figures as the other
strategies (hit rate with CI, mean net bp, t-stat, verdict). Only `forward` is evidence.
