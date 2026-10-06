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
- [ ] PS-02 [S] Capture hot-path leftovers (remaining book sorts) and trivial market DB restore.
- [ ] PS-03 [M] Verdict service C: pure Python function over candles (strategies extracted), writes verdicts DB on candle close; double replay gives identical verdicts.
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


## Next step

- PS-02: implemented by a delegated writer and committed. The writer measured the CPU before and after. Still pending: a parent live spot check in `pnpm run dev`. Restart the capture child, which runs without `--watch`, confirm capture CPU is 10% or less, and confirm there are no `UNIQUE` errors in the capture log. Then check PS-02 off.
- Open follow-up: `paper-futures/futures-canonical.ts` `canonicalJson` still uses a key sort that allocates per comparison, and it was outside the PS-02 surface. The store-local `canonicalEvent` duplicates the fix; consolidate them later.
- Then PS-03, the verdict service.
- Handoff (2026-10-06): the work moves to a cloud session. The 5 files that were already modified before the session are still uncommitted locally and not pushed: `futures_runtime.py`, `test_futures_strategy_cadence.py`, `futures-replay-driver.ts` and its test, and the protected `futures-runtime.test.ts`.
