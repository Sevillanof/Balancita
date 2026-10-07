# futures-process-split

## Objective

Split the single paper_live Node process into isolated processes, each the single writer of its own SQLite file and connected by append-only tables plus rowid cursors, so that market capture and live visualization never depend on engine health.

## Problem / why

Every sustained live run of the single process surfaced a new engine defect: the per-event full-book sort, a per-event fsync, O(history) `verifyRun`, a dev DB restore failure (`frontier is discontinuous`), the funding-pause overwrite, and the permanent `futuresSourceFailed` latch. Because everything shares one event loop, each defect stopped capture, HTTP and the chart. Terminal events are also stored in the engine account DB (`server/src/app/app.ts:1006`).

## Target (approved 2026-10-06)

| Process | Role | Writes |
|---|---|---|
| A capture | Kraken WS → raw events + candles | market DB |
| B gateway | HTTP + browser WS; opens other DBs read-only, tails rows | nothing |
| N news | news ingestion + stored Gemini analysis | news DB |
| C verdict (Python) | candles + news → long/short/abstain on candle close; pure, replayable | verdicts DB |
| D paper execution | verdicts → risk, fills, ledger, hash chain | engine account DB |

## Constraints

- Paper only; no real orders, private endpoints or credentials (ADR 0001).
- Never drop captured market data. Keep per-event commits with `synchronous=NORMAL`; no lossy batching.
- One writer per SQLite file.
- Protected file `server/src/features/paper-futures/futures-runtime.test.ts` stays untouched.
- No new dependencies unless approved.

## Delivery strategy

`ask-on-risk`.

## Checklist

- [x] PS-01 [M] Live candles without the engine: capture process A + gateway B; terminal works with the engine off; `pnpm run dev` runs A + B for live.
- [x] PS-02 [S] Capture hot-path leftovers (remaining book sorts) and trivial market DB restore.
- [x] PS-03a [M] Official Kraken candles as the canonical series: capture backfills and polls closed 1 m / 5 m candles from the public charts API into append-only market DB tables (raw response + hash, `known_at` for as-of reads); observed-vs-official quality report.
- [x] PS-03b [M] Verdict service C: pure Python function over official candles (C25-C28 entry proposals only; exits stay with D), regime chained in the verdicts DB, writes verdicts on candle close; double replay gives identical verdicts.
- [x] PS-04 [M] News process N wired into C (Gemini as veto/confidence, stored per item).
- [x] PS-05a [L] Paper execution D (Python, own account DB, single writer): consumes fresh verdicts, ticker and funding read-only; top-of-ticker taker fills; exits via `propose` with the position; append-only hash-chained events plus snapshots; live run equals replay.
- [x] PS-05b [M] Gateway serves D's account, position, fills and verdict analyses read-only, so the terminal shows the engine instead of "engine off".
- [x] PS-05c [S] Fix the funding-pause overwrite in the legacy runtime (`python/balancita_engine/futures_runtime.py:2393-2404`), with a test. The legacy runtime is still used by the MOCK local terminal.
- [x] PS-05d [L] Retire the legacy live engine once D is proven: per-delta driver, market-context transport, operative bridge, `futuresSourceFailed` latch, `FUTURES_MODE=mock/replay` in `app.ts`, and the `DEV_LIVE_SINGLE_PROCESS` rollback. The dev MOCK child, which uses the local terminal, stays.
- [x] PS-06 [S] Process supervision + per-process health in UI.
- [x] PS-08a [M] Strategy spec `balancita-strategy.v1` (declarative JSON with `params`, no code) and its Python interpreter in C; C25-C28 rewritten as specs, with a parity test giving identical proposals over stored history.
- [ ] PS-08b [M] Strategy registry S: own SQLite DB, single writer; append-only spec versions (canonical hash) and lifecycle events with `known_at`; C reads it read-only and records the active spec hashes in each verdict; JSON import/export.
- [ ] PS-08c [L] Independent strategies: each active strategy has its own isolated paper book in D (position, fills, P&L); no cross-strategy selection; all are shown against the same terminal chart, with per-strategy markers. The backtest, D and the forecast scorer share one cost model and one definition of a hit, so the same strategy reports the same return everywhere.
- [ ] PS-08d [L] Front: strategies page, rule and parameter editor, configurable indicator periods, walk-forward backtest with a trial counter. When confirming an edit the user chooses: a new version of the same strategy, or a new strategy with the changes that leaves the existing one as it is.
- [ ] PS-08e [S] Lifecycle draft -> shadow -> active, gated by the ADR evaluation (out of sample, deflated Sharpe, minimum trade count).
- [ ] PS-08f [M] Import from Pine Script or freqtrade: an LLM translates the text into a draft spec that the user reviews; imported code never runs.
- [ ] PS-08g [M] Every strategy also returns buy/hold/sell probabilities, like Q; Q sees all strategies' probabilities and answers buy, hold or sell, stored as a timestamped decision that D can consume. Owned by the "Qwen decide sobre estrategias" thread on top of the PS-08 spec contract.
- [x] PS-09 [M] Everything useful Kraken publishes, captured and on the terminal chart: public analytics (buy/sell aggressor volume, open interest, liquidations, long/short and top-trader positioning, order book depth and slippage, rolling volatility), official 15m/1h/4h/1d candles, the full ticker (24 h stats, mark/index/premium, bid/ask sizes, funding now and next); per-product order book depth for all pinned products (trading costs). Chart: timeframes, EMA/Bollinger/Donchian/VWAP, flow/OI/liquidations/long-short/RSI panes, entry/stop/target lines, exit markers.

## Acceptance (PS-01)

- [x] Capture runs as its own process and is the only writer of the live market DB.
- [x] Gateway opens the market DB read-only, starts no collector and no engine, and serves bootstrap with closed candles plus a live stream of candle and ticker updates by tailing rowids.
- [x] `/terminal?source=live` shows candles in the browser with the engine off; CPU stays low; bootstrap stays under 500 ms.
- [x] If capture stops, the gateway still serves stored history and reports capture as stale. If the gateway restarts, capture is unaffected.

## Progress / evidence

See [futures-process-split.log.md](futures-process-split.log.md).

## Next step

- PS-06 (process supervision + per-process health) was delivered as SS-14 of `strategy-simulation.md`.
- PS-08b (registry S as the only source of specs for C), PS-08c (one book per strategy, SS-05) and PS-08d..g follow `odd/tasks/strategy-simulation.md`, which is the live plan for simulation work.
- In the cloud container, Node's `fetch` and `WebSocket` need `NODE_USE_ENV_PROXY=1` to reach Kraken; this does not apply locally.
- Open follow-up: `paper-futures/futures-canonical.ts` `canonicalJson` still uses a key sort that allocates per comparison; the store-local `canonicalEvent` duplicates the fix. Consolidate them later.
- Open follow-up: the `gateway.test.ts` candle-streaming timing flake (pre-existing).
