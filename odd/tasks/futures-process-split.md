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

## Next step

PS-02 (capture hot path: CPU 15–45%), then PS-03.
