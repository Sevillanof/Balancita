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
- [ ] PS-05 [L] Paper execution D consumes verdicts; retire per-delta driver, market-context transport, operative bridge, `futuresSourceFailed` latch; fix funding-pause bug (`python/balancita_engine/futures_runtime.py:2393-2404`).
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

## Next step

- PS-04: news process N wired into C, with Gemini as veto/confidence stored per item. Or PS-05 first: paper execution D consuming fresh verdicts (`knowledge_lag_ms` below a threshold). The order is the user's call.
- In the cloud container, Node's `fetch` and `WebSocket` need `NODE_USE_ENV_PROXY=1` to reach Kraken; this does not apply locally.
- Open follow-up: `paper-futures/futures-canonical.ts` `canonicalJson` still uses a key sort that allocates per comparison. The store-local `canonicalEvent` duplicates the fix; consolidate them later.
- Open follow-up: the `gateway.test.ts` candle-streaming timing flake (pre-existing).
- Handoff (2026-10-06): the 5 files that were already modified before the cloud session are still uncommitted locally and not pushed: `futures_runtime.py`, `test_futures_strategy_cadence.py`, `futures-replay-driver.ts` and its test, and the protected `futures-runtime.test.ts`.
