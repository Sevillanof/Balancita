# strategy-gate

## Objective

An automatic, fixed test that judges a strategy with rules declared before looking at any result, so that "this strategy works" stops depending on who ran which backtest and how many times.

## Problem / why

Every backtest of a strategy we are fond of is another draw from the same lottery. Without a fixed split of the data, a fixed list of rules and a count of the attempts, a lucky C2x passes by repetition. The gate keeps the last ~6 months out of reach until a version is final, and lets that version take its final exam once.

## Command

`python3 -m balancita_engine.strategy_gate ...` (module `python/balancita_engine/strategy_gate.py`, config `config/strategy-gate.json`, versioned).

- `evaluate --strategy <id> [--from YYYY-MM-DD] [--products PF_XBTUSD,...] [--exam] [--json-progress] [--sin-vecinos] [--jobs N]` runs the test, writes `data/strategy-gate/reports/<run_id>.md` (Spanish) and records the run.
- `runs [--strategy <id>]` lists the runs, one JSON line each.
- `cancel --run N` asks a running evaluation to stop.
- Verdicts: `PASA`, `NO PASA`, `INCONCLUSO` (fewer than 100 trades).

## Data split

- `holdout_from = 2026-04-19` (config).
- Practice (default): walk-forward folds over `[from, holdout_from)`, 5 folds by entry time; per-fold report. Candles, funding and outcomes are only requested below `holdout_from` and filtered again inside the worker. A trade still open at the cut is discarded (never closed with later prices) and counted as "abiertas al corte". No parameter is fitted; the folds measure stability.
- Exam (`--exam`): evaluates only `[holdout_from, now)` (3 folds); earlier candles only warm the indicators up. `--from` is refused.

## Exam lock

- `version_key = <strategy_id>:<sha256 of the whole spec>` (the registry S digest, `futures_spec_strategy.spec_hash`): id with its `-vN`, rules, params and indicators. The Python interpreter is shared and is not part of the hash.
- One exam per strategy id. A second one is refused: "El examen final de esta versión ya se rindió el <fecha>: <veredicto>. Para volver a rendirlo, creá una versión nueva."
- Same id with another hash (after an exam, or after any earlier run with a different hash) is refused: bump the version.
- The lock is taken after every download and right before the first outcome is computed. A failure or cancellation before that (network, Kraken down) keeps it free; from that point it is consumed (lock status `cancelled`/`failed`, verdict text says so).
- Attempts: every practice run increments the counter of the family (id without `-vN`); the report shows "intentos: N" and the deflated Sharpe uses N as trials. Exams do not count.

## Rules (predeclared, printed in each report)

PASA only if all hold: n >= 100 · mean net bp > 0 and the 95 % bootstrap CI lower bound > 0 · percentile >= 95 against 1000 random-entry draws (same count, product, side and holding time; compared before funding because the draws do not model it) · deflated Sharpe probability >= 0.95 with the attempts as trials · positive in >= 60 % of the folds and in >= half of the products · still positive with fees and impact x1.5. Reported too: hit rate, profit factor, max drawdown, per product / side / fold, parameter neighbours (+-20 %, informative only, `n/d` without numeric params).

## Progress and cancellation

`data/strategy-gate/gate.sqlite`, table `runs`: `status` (running/done/failed/cancelled), `phase` ("generando señales", "simulando", "sorteos al azar", "informe", at the end "terminada"/"cancelada"/"falló"), `detail`, `progress` (0-100), `eta_s`, `started_at`, `updated_at`, `finished_at`, `pid`. `--json-progress` prints the same as JSON lines. Cancellation: create `data/strategy-gate/cancel/<run_id>` or send SIGTERM/SIGINT to `runs.pid` (checked between chunks of 4000 candles); the run ends `cancelled`. The canceller never writes the DB (single writer).

## Controls

- Negative: a losing synthetic strategy gets NO PASA; C25-C32 on a driftless synthetic walk never get PASA (`python/tests/test_strategy_gate.py`). No real-shaped Kraken data was available offline when this was written (no network): run the real negative control once on the Mac and note the result below.
- Positive: a test-only strategy that peeks 60 minutes ahead gets PASA. It lives only in the tests, not in the registry.
- Lock, hash, attempts, split (poisoned post-cutoff candles change nothing), progress and cancel tests.

## Reuse

`futures_history.py` (new) holds the Kraken candle/funding fetch and cache that `futures_qwen_practice.py` used to carry; the Qwen practice imports it, behaviour unchanged. Statistics (`metrics`, `bootstrap_ci`) come from `futures_qwen_practice_report.py`, the deflated Sharpe from `futures_strategy_reliability.py`, costs from `futures_costs.py`, trades from `futures_simulator.Book`.

## Progress / evidence

- 2026-10-19: implemented on top of `feat/qwen-practice` (PR #316).
  - Unit tests: `PYTHONPATH=python:python/tests python3 -m unittest test_strategy_gate` and the Qwen practice tests (unchanged) pass.
  - Speed (synthetic, this container): about 0.18 ms per 1 m candle per strategy pass, so BTC from 2025-01-01 to the cut (about 690 k candles) is about 2-3 minutes per pass; the neighbour passes run in a process pool. Real run on the Mac: pending.

## Next step

Run `evaluate` for C25-C32 on the Mac (negative control on real data), note the verdicts here, then decide which versions deserve an exam.
