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
- [ ] PS-04 [M] News process N wired into C (Gemini as veto/confidence, stored per item).
- [x] PS-05a [L] Paper execution D (Python, own account DB, single writer): consumes fresh verdicts, ticker and funding read-only; top-of-ticker taker fills; exits via `propose` with the position; append-only hash-chained events plus snapshots; live run equals replay.
- [x] PS-05b [M] Gateway serves D's account, position, fills and verdict analyses read-only, so the terminal shows the engine instead of "engine off".
- [x] PS-05c [S] Fix the funding-pause overwrite in the legacy runtime (`python/balancita_engine/futures_runtime.py:2393-2404`), with a test. The legacy runtime is still used by the MOCK local terminal.
- [ ] PS-05d [L] Retire the legacy live engine once D is proven: per-delta driver, market-context transport, operative bridge, `futuresSourceFailed` latch, `FUTURES_MODE=mock/replay` in `app.ts`, and the `DEV_LIVE_SINGLE_PROCESS` rollback. The dev MOCK child, which uses the local terminal, stays.
- [ ] PS-06 [S] Process supervision + per-process health in UI.

## Acceptance (PS-01)

- [x] Capture runs as its own process and is the only writer of the live market DB.
- [x] Gateway opens the market DB read-only, starts no collector and no engine, and serves bootstrap with closed candles plus a live stream of candle and ticker updates by tailing rowids.
- [x] `/terminal?source=live` shows candles in the browser with the engine off; CPU stays low; bootstrap stays under 500 ms.
- [x] If capture stops, the gateway still serves stored history and reports capture as stale. If the gateway restarts, capture is unaffected.

## Progress / evidence

- 2026-10-06: plan approved by the user. Prior same-day work reused: `bookQuality` getter, `synchronous=NORMAL`, live bootstrap `terminal_market`, client accepting `futures-terminal-market.v1`, incremental verification (BP-03d in `odd/tasks/futures-bounded-processing.md`).
- 2026-10-06 PS-01 (route: delegated writer; triggers: 2+ non-trivial files, mapping reads prepare the write). Implemented, not yet browser-verified (parent owns that; PS-01 stays unchecked).
  - Design: capture = `server/src/app/capture-main.ts` over `features/live-gateway/live-capture.ts` (collector + per-event `FuturesMarketStore.append` + `FuturesCandleBuilder` 1 s clock + 5 min funding poll, catalog retry; no HTTP/engine). Gateway = `server/src/app/gateway-main.ts` over `features/live-gateway/gateway.ts` + `market-follower.ts` (read-only `FuturesMarketStore`, tails ticker/trade events and 60 s candle revisions by rowid every 250 ms, in-memory ring + resync, engine reported `off`). Dev children: `capture` + `live` gateway; `DEV_LIVE_SINGLE_PROCESS=1` keeps the old single-process child. Client: engine-off notice, no engine-owned sections.
  - RED: `pnpm exec vitest run src/features/live-gateway` in `server/` failed before implementation (modules `./gateway.ts`, `./live-capture.ts` not found); `node --test scripts/dev.node-test.mjs` failed 3 (child names, capture and gateway specs); client `-t "engine off"` failed at "Motor de decisiones apagado".
  - GREEN: live-gateway 7/7; dev.node-test 10/10; `src/app src/features/connected-trading` 131/131; server `src/features/kraken-futures src/features/live-gateway src/app` 99 passed, 1 known pre-existing failure (app.test.ts two-subscriber Python/SQLite); `pnpm typecheck` (server and root `tsc -b`) clean.
  - Smoke (real Kraken, gateway on 8797, fresh DB under scratchpad): bootstrap 1-8 ms, 3 candles after ~90 s, 14 `market.updated` in 6 s, gateway CPU ~0.1-0.3%, capture CPU ~24% (book-event hot path; PS-02), capture killed -> gateway reports `stale`/`capture_stale` and keeps 3 candles.

  - Parent browser verification (2026-10-06, `pnpm run dev` on the existing dev-live market DB): capture + gateway start; `/terminal?source=live` shows the Kraken price, 37→39 stored candles plus new live candles without reload, and the "Motor de decisiones apagado" notice; no console errors; MOCK ↔ Real switch works both ways (also closes DEV-03). Bootstrap 55–74 ms; gateway CPU 0.1–0.3%; capture CPU 15–45%, so the low-CPU goal is met for the gateway only. Capture CPU moves to PS-02. History shows gaps from earlier periods when the old single process was starved.

- Commits on `feat/futures-process-split` (branched from frozen `fix/futures-bounded-processing` @ 94bfa4e): 10df50d dev-mode-switch + DEV-06; bfc5212 BP-03d incremental verification; e23dbfe PS-01 capture + gateway. Pre-session uncommitted changes are left out on purpose: `futures_runtime.py`, `test_futures_strategy_cadence.py`, `futures-replay-driver.ts` and its test, and the protected `futures-runtime.test.ts`.

- 2026-10-06 PS-02 (route: delegated writer; triggers: mapping + 2+ non-trivial files). Implemented, not committed; PS-02 stays unchecked.
  - Profile before (live Kraken, ~90 s, fresh DB, `--cpu-prof`, busy 44.6% of wall time, ps CPU 17-98% decayed, steady ~25%): `accept` (inlined per-delta `[...keys()].sort` x2) 28.5%, `FuturesMarketStore.append` 18.3% (native sqlite + re-prepare), `compareUnicodeScalars` (canonicalJson key sort via `Array.from` per comparison, called twice per event) 17.8%, `compareDecimals` 16.0%, sort comparator 6.3%.
  - After (same method, ~100 s): busy 8.4%, ps CPU 5-9% steady (4.2% on a 75 s restart run); remaining self time is `append` native sqlite (64% of busy, per-event BEGIN/INSERT/COMMIT) plus `canonicalEvent` 7%, `decodeProviderJson` 6%.
  - Changes: collector tracks best bid/ask incrementally (rescan only when the best level is removed; no per-delta sort); store caches prepared statements, canonicalises a non-trade event once (hash = sha256 of the stored normalized JSON) with an output-identical `canonicalEvent` that avoids per-comparison allocation; `FuturesCandleBuilder` resumes candles from their latest stored revision (`restoreOpenCandles` + lazy `candleHeadById`), called by live-capture at start.
  - Restore finding: a capture restart on an existing market DB used to fail with `UNIQUE constraint failed: paper_futures_candle_revisions` (builder restarted at revision 1) and degraded persistence. Fixed and verified live on a DB from a previous capture run; no frontier/engine checks are involved.
  - RED: `futures-market.test.ts` "never sorts book levels while applying a delta" (790 sorts vs <=8); `futures-market-store.test.ts` "reuses prepared statements" (120 prepares vs 2); `futures-candles.test.ts` both restart tests (UNIQUE collision; `restoreOpenCandles` missing). Golden equivalence (book state per message + persisted rows/gaps digests over 400 deltas with best-level deletes, crossing, gap, snapshots) and canonical-JSON equivalence were GREEN on the old code first and stay GREEN.
  - GREEN: kraken-futures + live-gateway 48/48; `src/features/kraken-futures src/features/live-gateway src/features/paper-futures src/app` 274 passed, 3 known pre-existing failures; `pnpm typecheck` clean.
  - Note: `canonicalJson` in `paper-futures/futures-canonical.ts` (outside this task's surface) has the same per-comparison `Array.from` key sort; fixing it there would drop the store-local `canonicalEvent`.
  - Parent live spot check (2026-10-06, cloud container, 4 vCPU; capture child alone, `NODE_USE_ENV_PROXY=1` because Node `fetch`/`WebSocket` ignore `HTTPS_PROXY` there; fresh market DB under scratchpad):
    - Run 1, 180 s: 101,800 events (~565/s), 0 gaps, 0 errors. CPU from `/proc` ticks per 10 s window was 7.6-15%; steady average 100-180 s was 11.2%.
    - Run 2, restart on the same DB, 150 s: 0 `UNIQUE` errors, no degraded state. Open candles resumed from their stored revision; 15 m and 1 h candles continued to revision 807 across the restart. Steady CPU was about 11-13%.
    - Restart acceptance is met. CPU is just above the 10% target on this machine, which is slower than the local one where the writer measured 5-9%. The remaining cost is the mandated per-event commit.


- 2026-10-06 PS-03 design (cloud session; user decisions):
  - C emits entry proposals only (LONG/SHORT/WAIT/ABSTAIN, stop/target, features, conditions). Exits, owner and consumed-signal filtering stay with D, which owns position state.
  - The regime hysteresis is chained in the verdicts DB. A full replay starts at `unknown` from the first candle.
  - Finding: live candles could never feed `calculate_features`. The capture writes `coverage: observed_trades_only_no_gap_certification`, while the indicators require `complete`. A minute without trades has no candle, and the capture records no trade-feed gaps or disconnects. The old engine therefore never produced a live signal; only MOCK did.
  - Evidence from observed vs official candles (same minutes, 2026-10-06):
    - One observed minute missed 0.0008 BTC of volume, together with a trade `seq` jump of 3.
    - Kraken's convention is open = previous close, with high/low including that open; observed candles open at the first trade. Open, high or low differed in 5 of 6 minutes; closes matched.
    - Official closed candles were stable across fetches. They are gapless: 12 of 360 minutes were flat with zero volume. Up to 1800 candles per request; the last candle is the open one.
  - Decision: official Kraken candles (`https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/{1m,5m}`) are the canonical series for C, in vivo and for backtests. Observed candles stay for the low-latency chart and as a quality check. Connection-window certification is dropped. Trade `seq` jumps are not written to `paper_futures_data_gaps`, because `gapStatusAsOf` would halt the legacy engine; the volume comparison exposes missed trades instead.

- 2026-10-06 PS-03a (cloud session, implemented in the parent).
  - Design:
    - `kraken-futures/official-candles.ts` builds the charts URL, validates responses and keeps settled closed candles only. A candle is settled when it closed at least 2 s before receipt. Values are normalized decimal strings. Validation rejects misaligned or duplicate buckets, non-decimal values and inconsistent OHLC. A bounded client handles timeout and HTTP errors.
    - Market store migration 4 adds append-only `paper_futures_official_candle_responses` (raw body + sha256 + range + `received_at`) and `paper_futures_official_candles`, keyed by interval, bucket and revision hash, with `known_at`. Both have no-update and no-delete triggers.
    - New store reads: `officialCandlesAsOf` returns the first-known revision per bucket by cutoff. `latestOfficialBucket` supports incremental polling. `officialCandleQuality` compares final observed closed candles with official ones on close and volume only, and lists observed-missing buckets and official revisions.
    - The read-only gateway accepts schema 3 or 4.
    - Capture backfills on start (1 m: 24 h, 5 m: 3 d, capped at 1800 per request). It then polls 3 s after each minute boundary from the latest stored bucket, skipping an interval whose next bucket has not closed. Failures are logged and never stop capture.
    - `readBoundedBody` is now exported from `historical-funding.ts` with a label; the funding error text is unchanged.
  - RED: `official-candles.test.ts` failed on a missing module. The 6 new store tests failed (`appendOfficialCandles` missing; schema 3 instead of 4). The 2 new capture tests failed (no requests; no failure log).
  - GREEN:
    - kraken-futures + live-gateway: 53/53. `gateway.test.ts` "streams a candle revision appended later by the writer" is a pre-existing timing flake; it failed 2 of 5 runs on unmodified code.
    - `src/features/kraken-futures src/features/live-gateway src/features/paper-futures src/app`: 269 passed. The same 7 failures occur on unmodified code in this container, including the two suites that need the local-only `playwright-artifacts` fixtures.
    - `pnpm typecheck` (server) and root `tsc -b` are clean.
  - Live smoke (real Kraken, fresh market DB, 240 s):
    - Backfill stored 1439 1 m and 863 5 m candles in one response each. Every minute at :03 one new 1 m candle was stored; the 5 m candle arrived on its boundary.
    - No errors; capture CPU about 9.4%.
    - Quality over the last 10 minutes: 4 compared, 3 matched exactly. The one volume mismatch is the partial first minute, as capture started at 10:38:34. Buckets before capture are reported as observed-missing.
  - Follow-up (PS-06): surface `officialCandleQuality` and official-candle freshness in per-process health.

- 2026-10-06 PS-03b (cloud session). Verdict core written by the parent; capture order, dev wiring and the poll fix written by a delegated writer (Sonnet) and reviewed by the parent.
  - Design: `python/balancita_engine/futures_verdicts.py`.
    - `evaluate_verdict` evaluates C25-C28 flat-position proposals per closed 1 m bucket over fixed 200-bar 1 m and 5 m windows of official candles. It uses only candles that closed by the bucket close and were known by its `known_at`, so backfills have no lookahead. `knowledge_lag_ms` marks verdicts rebuilt from a backfill; D should act only on fresh ones.
    - `VerdictStore` is an append-only verdicts DB with a config-hash guard. The regime is chained from the last verdict.
    - `VerdictService` keeps one read-only market connection. An idle poll is a single `MAX(bucket_start)` probe. It survives a missing, locked or recreated market DB.
    - A CLI `--once` mode does replays.
  - Capture now fetches 5 m before 1 m, so the 5 m bar closing on a boundary is in that minute's verdict.
  - `pnpm run dev` starts the `verdict` child (`python3`, `PYTHONPATH=python/`). It is absent with `DEV_LIVE_SINGLE_PROCESS=1`.
  - RED/GREEN:
    - Verdict tests: module missing, then 8/8. A mutation that removed the close-time filter, and one that ignored the chained regime, were each caught.
    - Service tests: missing `VerdictService`, then 12/12. They cover one idle statement, PK-bounded query plans, a missing/recreated DB and a locked DB.
    - Python verdicts + strategies + indicators: 26 OK.
    - `scripts/dev.node-test.mjs`: 9 pass / 2 fail, then 11/11.
    - Capture-order test RED, then GREEN.
  - Live smoke (real Kraken, fresh DBs):
    - Backfill 1440 1 m + 863 5 m; catch-up 1440 verdicts in about 30 s, compute-bound at about 20 ms per verdict.
    - Then one verdict per minute, with official candles about 3.5 s after close.
    - Write latency after `known_at` was 31-407 ms. It is the phase of the 1 s poll; per-verdict compute was flat at 1x vs 10x synthetic history.
    - Idle CPU was about 0.02% of a core after the fix. It was about 0.17% before; a first report of 17% was a units misreading.
    - Actions over 1448 verdicts: WAIT 1273; LONG 96 (C25 45, C27 43, C26 4, ...); SHORT 79. Regime: trend 907, range 537.
  - Double replay: the live run and two `--once` replays from the same market DB were identical on `(bucket_start, verdict_hash, payload_json)` for every bucket, after the fix too (1445/1445).
  - Note: 1 m features become ready at 50 candles, but the window is pinned at 200; the first 199 verdicts after an empty DB use a shorter window. The official backfill covers this in practice.

- 2026-10-06 PS-05 design (user decisions; engine map from a read-only explore agent):
  - Reuse the pure blocks: `FuturesLedger`, `PaperExecutionAdapter` semantics, `futures_funding`, the sizing rule of `_risk_plan`, and exits through `futures_strategies.propose` with `position_side`, using the next verdicts' features.
  - Do not reuse the TS store validators (about 2000 lines), the identity bridge or the market-context transport.
  - Fills: taker at the best bid/ask of the first ticker with `received_at >= decision + latency`, capped by the displayed `bid_size`/`ask_size`. The ticker carries bid/ask/sizes/mark at about 3/s. Rebuilding the book from deltas was rejected as too costly for at most 1000 USD orders.
  - Account DB: new, written only by D. Hash-chained append-only events plus append-only snapshots, so a restart never replays all history.
  - The funding-pause bug class is avoided by design: entry gates are recomputed from independent causes, with no shared `entry_paused` flag.
  - D acts only on fresh verdicts (`knowledge_lag_ms` within a threshold); a verdict becomes available at its stored `written_at`.
  - Pause/resume/close controls need a command channel to D; they are deferred to PS-06.
  - Retirement (PS-05d) is approved for the end, once D is proven live.

- 2026-10-06 PS-05c (delegated writer, Sonnet; reviewed by the parent). The user's unpushed local edits to the legacy files were discarded by user decision; the fix applies to the committed version.
  - Root cause: in `_update_risk_day`, `can_clear_funding_pause` wrote `entry_paused = False` after the invalid-mark branch had set it. Entries then passed the gate on a bad mark, and `_restore` rejected the checkpoint ("risk mark pause checkpoint disagrees").
  - Fix: on clear, `entry_paused = bool(_risk_mark_pause_active or _funding_entry_causes)`, both recomputed earlier in the same cycle. These are the same inputs the restore check reads.
  - Tests in `test_futures_runtime_risk.py`:
    - the funding clear keeps the pause while the risk mark is unavailable: no entry, and the checkpoint restores;
    - the funding clear lifts the pause when the mark is valid.
    - RED on the first test, then GREEN 15/15. A mutation back to `False` was caught.
  - Suites:
    - Python runtime suite: 87, then 89 OK. It needs `PYTHONPATH=python:python/tests`.
    - TS paper-futures + app: 7 failures, identical to the baseline. The `futures-runtime.test.ts` l.3227 `funding_complete` failure is unrelated and unchanged.

- 2026-10-06 PS-05a (delegated writer, Sonnet; reviewed and spot-checked by the parent).
  - `python/balancita_engine/futures_paper_execution.py` (D) is the single writer of `futures-paper-account.sqlite`.
    - Hash-chained append-only events: the hash covers `{kind, time_ms, body}`.
    - Append-only snapshots: a restart restores the latest snapshot, re-derives the later events and compares them byte for byte. A mismatch raises `ReplayDivergence`.
    - Inputs are merged in time order: funding, then verdict at `written_at`, then ticker, with per-source rowid/PK cursors.
    - Entry gate is pure, from independent causes: latch by UTC day, `funding_unresolved`, pending order.
    - Exits on the mark (stop/target), via `propose` with the position on fresh verdicts only, by time stop, or by daily-loss latch. Exits are not spread-capped.
    - Taker fills at the ticker bid/ask, capped by displayed size.
  - `pnpm run dev` starts the optional `paper` child.
  - Tests: 43 in `test_futures_paper_execution.py`; RED was a missing module. Mutations caught: long filling at bid, horizon ignored, funding sign flipped, tie order (a test was added for it). Combined Python run: 94 OK. `dev.node-test`: 12/12.
  - Live smoke (real Kraken, about 17 min):
    - D considered 174 LONG/SHORT verdicts: 171 `verdict_stale` (backfill), 3 fresh C25 LONG.
    - All 3 were rejected as `target_does_not_clear_cost_buffer`. Measured from the fill price, target distances were 109-113 USD against a cost-plus-buffer threshold of about 120 USD (0.12% + 0.02% of about 86,300). This is the legacy `_risk_plan` rule, reproduced faithfully.
    - Idle CPU 0.13%; per poll median 1.2 ms, p95 3 ms; catch-up 44 µs per input item.
    - Restart from a snapshot: no divergence.
  - Injected check on a DB copy with real tickers: a LONG filled at ask 86282 for 0.0068 BTC, capped by displayed size. It exited via C25 `propose` at bid 86283; net -0.58 USD after fees. A SHORT was rejected as `invalid_stop`.
  - Replay: the live account (180 events, two process runs) equals two `--once` replays row for row, head hash `dcb35c352e8bd307...`. The parent re-checked this.
  - Known limits:
    - Live equals replay assuming each source commits within `horizon_margin_ms` (2 s) of its row time.
    - Kraken publishes an hour's funding only after the hour ends. A position closed earlier accrues nothing for that hour and reports `funding_complete: false`. It is never inferred, so funding cost is understated for short trades.
    - At current volatility, C25 targets (about 3 ATR) do not clear taker round-trip costs. That is a strategy and economics question for the user.

- 2026-10-06 PS-05b (delegated writer, Sonnet; reviewed by the parent, including the screenshots).
  - D: `order_filled`, `position_opened`, `position_closed` and `funding_accrued` carry an `account` block. It holds running cash, realized, fees, funding, `funding_complete` and the position. `net_usd` is null while funding is incomplete. The config moves to `futures-paper-execution-config.v2`, so older account DBs are refused.
  - Gateway, read-only: the new `paper-engine-follower.ts` reads `FUTURES_PAPER_ACCOUNT_DB_PATH` and `FUTURES_VERDICTS_DB_PATH`, which are wired for the `live` child.
    - Bounded tails: the last 500 events by `seq`, one probe for the latest account block, and the last 100 verdicts.
    - Fixed poll order: analyses, then events, then the equity mark (at most every 2 s with a position), then the engine status.
    - It serves `paper-futures-terminal-state.v1` and the existing stream events. A replaced account DB triggers `resync.required`.
    - Engine status: `off` (not configured), `starting`, `unavailable`, `running` (activity within 10 min) or `idle`. `commands: unavailable`; `paper.command` is rejected.
  - Client: live shows the account, position, orders/fills and analyses. Verdict markers appear on the live chart for fresh LONG/SHORT verdicts only. Pause, resume and close are disabled, with a Spanish PS-06 notice.
  - Tests:
    - D account-block tests RED, then GREEN. Python paper + verdicts: OK.
    - Gateway follower, engine and decimal tests: written before the modules existed. live-gateway + kraken-futures: 79/79.
    - Root `src/app src/features/paper-futures`: 116 (baseline 108).
    - `dev.node-test`: 13/13. Server and root typecheck clean.
    - Mutations caught: the short sign, poll order, the equity throttle, the cash formula, `funding_complete` gating, and re-enabled controls.
  - Browser (real `pnpm run dev` against Kraken, plus the PS-05a DBs with an injected trade):
    - Engine running; account 9999.71 cash / 9999.78 equity with the long 0.0068 BTC open.
    - Orders filled and rejected with reasons; fills at 86282/86283; LONG markers on their candles.
    - Controls disabled with the notice. No console errors.
  - Known: a fresh account DB shows `starting` until D's first event or 5-minute snapshot. Rejected entries show no quantity, because it is only known at fill.

- 2026-10-06 Dev Python resolution and live chart history (delegated writer, Sonnet; reviewed by the parent). Context: the user saw empty "Análisis recientes". The root cause was a stale local checkout at 7934368 (with the discarded legacy edits) that lacked the verdict and paper children; the fixes below harden what the investigation exposed.
  - `scripts/dev-provider-env.mjs` `resolvePython` tries `BALANCITA_PYTHON`, then `python3`, `python`, and `py -3` on win32. It requires Python 3.9+ and SQLite 3.37+ (STRICT tables). C and D tests pass on CPython 3.9.25.
  - Without a usable Python, `verdict` and `paper` are not spawned, and `live` gets `BALANCITA_PYTHON_STATUS`. The terminal then shows `python_unavailable` / `python_sqlite_too_old` notices in Spanish, and "Esperando el primer veredicto…" while starting.
  - The live chart's closed history comes from official candles (newest 500; official wins per bucket; observed fills only buckets without one). A late official candle streams as a closed update for its bucket, and observed closed revisions of official buckets are suppressed. Store reads `maxOfficialRowid` / `officialCandlesAfter` are rowid-bounded and fall back on schema 3.
  - Evidence: `dev.node-test` 27/27; live-gateway + kraken-futures 89; root `src/app src/features/paper-futures` 120 (needs `--exclude '**/.claude/**'` while agent worktrees exist).
  - Mutations caught: observed-wins precedence and disabled suppression.
  - Browser: 500 contiguous 1 m candles (about 6 h) on bootstrap; the no-Python notice rendered.

- 2026-10-06 Dev startup hardening (delegated writer, Sonnet; reviewed by the parent). On the user's macOS machine the terminal showed no analyses because:
  - an orphaned pre-PS-05b gateway still held port 8789 (health reported `engine_not_running`);
  - the new gateway then could not start without `server/.env`, because `--env-file-if-exists=.env` plus `--watch` dies with `ENOENT ... watch '.../server/.env'` on Node 22.
  - Fixes in `scripts/dev-provider-env.mjs` and `scripts/dev.mjs`:
    - The env-file flag is only added when `server/.env` exists.
    - `planStartup` refuses to start, exit 1 with per-port `lsof` hints, when 5173/8787/8788/8789 are busy.
    - Children run in their own process groups on POSIX, and shutdown signals the group, so Ctrl+C leaves no orphans.
    - A child that hits `EADDRINUSE` gets a loud message.
  - Evidence: `scripts/*.node-test.mjs` 45/45. Real runs: without `.env`, health returned `running` from `paper-execution-d`; with 8789 occupied, dev refused to start; SIGINT left no ports or children behind.
  - Limits: a SIGKILL of `dev.mjs` itself still orphans its children.

- 2026-10-06 Market DB growth cut (delegated writer, Sonnet, isolated worktree; cherry-picked and re-verified by the parent).
  - Measured before: about 2.7 GB/h, of which book events were 463k per 17 min (445 MB of JSON). A full historical-funding response (about 1 MB and 8.75k rows) was stored every 5 min.
  - Consumer map: nothing in the split reads book events. D reads tickers, C reads candles, and the gateway tails ticker and trade only. Legacy and replay readers act only when book rows exist and are unchanged.
  - Changes:
    - The collector has a `bookFeed` option, default true. Capture alone sets it false: no book subscription, live/stale driven by the ticker, and ticker attestations report `book_valid: null` / `not_observed`.
    - `appendNewFundingKnowledge` stores a response only if it adds a period or a changed rate, and writes rows for the new periods only. Funding is polled at start and 30 s after each hour, retrying each minute up to 10 times.
    - Legacy `appendFundingResponse` and the default collector are untouched.
  - Live (22 min, real Kraken):
    - About 204 MB/h, 13x less. Capture CPU about 1.5%, down from 10-12%.
    - Funding: +1 period at the 14:00 poll. Official candles and D kept running.
  - Remaining growth comes from `paper_futures_ticker_snapshots` (an unread duplicate of each ticker) and per-trade candle revisions.
  - Tests:
    - 7 new tests went RED, then GREEN. A Python test covers D following hour-by-hour funding responses.
    - Merged suites: the 7 baseline failures, plus the pre-existing `gateway.test.ts` flake, which also failed 2 of 4 runs on 0ff9aab.

## Next step

- PS-04: news process N wired into C, with Gemini as veto/confidence stored per item. Or PS-05 first: paper execution D consuming fresh verdicts (`knowledge_lag_ms` below a threshold). The order is the user's call.
- In the cloud container, Node's `fetch` and `WebSocket` need `NODE_USE_ENV_PROXY=1` to reach Kraken; this does not apply locally.
- Open follow-up: `paper-futures/futures-canonical.ts` `canonicalJson` still uses a key sort that allocates per comparison. The store-local `canonicalEvent` duplicates the fix; consolidate them later.
- Open follow-up: the `gateway.test.ts` candle-streaming timing flake (pre-existing).
- Handoff (2026-10-06): the 5 files that were already modified before the cloud session are still uncommitted locally and not pushed: `futures_runtime.py`, `test_futures_strategy_cadence.py`, `futures-replay-driver.ts` and its test, and the protected `futures-runtime.test.ts`.
