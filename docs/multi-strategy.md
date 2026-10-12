# Multi-strategy experiment (PR 100)

Every 5 minutes, for each of the 8 products, strategies emit `balancita-signal.v1` signals; three arms trade them in
independent paper books of the shared simulator (same candles, per-product costs, 100 USD notional, risk policy and
exit rules). Governing decision: ADR 0001, amendment 2026-10-12.

| Arm | Chooses | Book key |
|---|---|---|
| A | each strategy trades its own signals | `(A, strategy, product)` |
| B | deterministic combiner (net strength ≥ 0.6, 2× dominance) | `(B, combined, product)` |
| C | Qwen picks BUY / WAIT / SELL, only among sides a signal backs | `(C, qwen, product)` |

Flow: strategies → selector → **risk engine** (authorizes or rejects with reasons) → **executor** (opens only by
redeeming a single-use authorization) → `Book` manages stop / target / time stop without Qwen.

- `multi_signals.py` contract and the 3 experimental strategies (`mx-funding-v1`, `mx-momentum-v1`, `mx-meanrev-v1`; they
  prove the path, nothing says they are profitable). Adding a strategy = one `Strategy` subclass.
- `multi_risk.py` checks: backing signal, data integrity and age, measured costs, product/global exposure, margin, open
  position, daily-loss and drawdown suspension, target clears costs. Levels: stop 2 ATR(5m), target 1.5× stop, horizon
  from the signal capped at 24 h.
- `multi_executor.py` / `multi_store.py` / `multi_select.py` / `multi_experiment.py`.
- Missing funding history or an unmeasured product ⇒ `net_complete: false`, `net_usd: null`, partial figure apart.
- Every candidate is stored, rejected ones included, with a shadow outcome (same levels and costs, no exposure limits) to
  measure false rejections of Qwen and the combiner.
- Replay: same candles + same store ⇒ same ledger hash (`Experiment.ledger_hash`) without asking Qwen. A new
  `--experiment-id` starts fresh decisions.

Run (Mac, `pnpm dev` capture running; Qwen server on `LLAMA_PORT`, default 8088):

```
PYTHONPATH=python python3 -m balancita_engine.multi_experiment --market-db <market.sqlite> --out ~/balancita-data.noindex/multi \
    --qwen llama --loop-seconds 300
# without Qwen (arm C waits): --qwen off
```

Checkpoint: at the end of each pass the whole state (books, open positions, indicator state, risk engine, shadows) is
saved in `multi.sqlite` (`checkpoints`, one per `--experiment-id`, with a SHA-256 and a fingerprint of the configuration).
The next pass restores it and processes only the new candles (6000 minutes: 3.3 s the first time, 0.16 s for the next
100). A checkpoint that is missing, corrupt, unreadable or made for another configuration (policy, strategies and
versions, cost model, selectors, products, start) is never used: the pass rebuilds from the start and says why.
`--rebuild` forces that (use it after the capture filled a hole in the candles); `--verify` additionally rebuilds
everything in memory from the stored selections and fails loudly (`verification` in the report) unless the ledger and
open positions are identical. `test_multi_strategy.CheckpointTests` pins that equivalence at several split points,
including with a position open. Funding tables are not stored in the checkpoint; they are reloaded from the market DB.
Calm-skip is not applied here; results are not comparable 1:1 with replays that use it.

**Shadow outcomes are not executable profitability.** They say what a rejected candidate would have done alone, with
the same levels and costs, but ignore simultaneous positions and capital limits. Use them to see what a filter rejects,
never as a P&L.

Not done yet (in this order): real-Qwen run on the Mac (latency, answers, resources), historical validation (walk-forward,
CPCV, Holm, DSR, PBO), better strategies (the three `mx-*` are experimental and not believed profitable), front-end view,
forward freezing. Tests: `python/tests/test_multi_strategy.py` (the 9 criteria).
