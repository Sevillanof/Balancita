# kronos_lab: Kronos-small as an independent paper strategy

Isolated on purpose: no module of `balancita_engine`, the server, the registry, the forward table or the Qwen
prompts imports it, and it writes only to its own `kronos.sqlite`. Delete the folder and nothing else changes.

Rule (fixed in `lab.py`, `kronos-small-1h-h4-v1`): closed official 1h trade candles, last 400 shown to
Kronos-small, 8 sampled paths averaged by Kronos, ln-return of that mean path over 4 h; trade only if it exceeds 2x the product's round-trip
cost (`futures_costs`), long or short, 100 USD at the next open, exit after 4 h, one position per product,
taker fills. Funding is not charged in the lab itself; the funding series now exists (`futures_funding.py`, `funding:backfill`) and the summary should be read with that in mind.

Candles come by default from Kraken Futures' public charts API (`--source kraken`, no credentials): the market DB
keeps only about two days of 1m candles, far less than the 200 h of context required, so building hours from it
(`--source market-db --market-db server/data/dev-live/futures-market.sqlite`) never reaches a first decision.

Status 2026-10-11: forward since 2026-10-08 07:10 UTC, judged at about 100 trades together with C30 (53 trades, 54.7 % hit, +6.6 bp net, t=0.81, verdict `no_edge` at the last check). Not modified until then. See ADR 0001, Amendment 2026-10-11.

## Run (needs the Kronos weights, downloaded once from huggingface.co; they run locally afterwards)

    git clone https://github.com/shiyu-coder/Kronos ~/Kronos        # MIT
    python3 -m venv .venv-kronos && .venv-kronos/bin/pip install -r python/kronos_lab/requirements.txt
    export KRONOS_REPO=~/Kronos
    # live, out of sample: only hours closed after the first run count
    PYTHONPATH=python .venv-kronos/bin/python -m kronos_lab.lab \
        --out server/data/kronos --mode forward --loop-seconds 3600
    # plumbing check on the last 30 days (CONTAMINATED: Kronos was pre-trained on this history)
    PYTHONPATH=python .venv-kronos/bin/python -m kronos_lab.lab \
        --out server/data/kronos-backtest --mode backtest --days 30 --stride 4

`kronos-summary.json` reports `forward` and `backtest` separately with the same reliability figures as the other
strategies (hit rate with CI, mean net bp, t-stat, verdict). Only `forward` is evidence.

## Funding (accounting correction, 2026-10-13)

`kronos.sqlite` stays as written: its trades carry the taker fees but no funding. `kronos_lab/funding.py` opens it
read-only and writes, for every trade whose whole holding time is covered by the stored Kraken funding periods, the
funding and the net it implies into a separate, append-only `kronos-funding.sqlite` (same accounting as the
forward's `forward_trade_funding`: unknown funding is never zero, a hole gives no row, the periods used are hashed).
`kronos-funding-summary.json` (written atomically) reports forward trades only, in three groups (all, without the positions held through a recorded interruption, and those apart), each with `before_funding` (stored nets), `after_funding_all` and `funding_verified_only`. While any trade of a group is pending its verdict reads `provisional_funding_pending`. It never touches `kronos.sqlite`, `kronos-summary.json`
or the running process:

    PYTHONPATH=python python3 -m kronos_lab.funding --out server/data/kronos --market-db <futures-market.sqlite>
