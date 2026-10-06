# dev-mode-switch

## Objective

`pnpm run dev` starts MOCK and real (paper, public Kraken) data side by side; the app switches between them at runtime.

## Parent decisions

1. `scripts/dev.mjs` spawns 4 children: `vite` 5173; `server` 8787 (legacy, FUTURES_MODE forced unset); `mock` 8788 (scripted local MOCK terminal API, `--api-only`, fresh temp DB per start); `live` 8789 (main server, `FUTURES_MODE=paper_live`, dev-specific DB paths under `data/dev-live/`). A failing child is logged and never kills the others; coordinated shutdown kept.
2. Vite proxy: `/api` -> 8787 (ws), `/api-mock` -> 8788 (ws, rewrite to `/api`), `/api-live` -> 8789 (ws, rewrite to `/api`).
3. `/terminal`: switch MOCK / Real (paper, Kraken publico); `?source=mock|live` (+ localStorage, try/catch); bootstrap + WS use selected base; `key={source}` remount; unreachable backend -> explicit error naming the source, never auto-fallback; default mock.
4. Spot `/`: runtime switch MOCK <-> Real (kraken); env var gives initial default; remount on switch (provider-bound state reset); label via `dataMode`.
5. README dev docs.

## Scope

scripts/dev*.mjs, scripts/futures-local-terminal.mjs, vite.config.ts, App/TerminalEntry/FuturesTerminal, terminal-stream-client, market-data-provider, README. No engine/financial/Python/runtime changes.

## Constraints

No new deps, no secrets, no real orders, no silent mock substitution, protected file `futures-runtime.test.ts` untouched.

## Checklist

- [x] DEV-01 startup (4 children, env, DB paths, `--api-only`)
- [x] DEV-02 vite proxy
- [x] DEV-03 terminal switch (browser-verified 2026-10-06 with capture + gateway; see futures-process-split PS-01)
- [~] DEV-04 spot switch — obsolete (2026-10-06, user): the app keeps only two screens, terminal and history; spot `/` is no longer a target.
- [x] DEV-06 live terminal shows Kraken candles (closed 2026-10-06; final fix via futures-process-split PS-01): unblock live server event loop (per-event full-book sort in `futures-market.ts` book getter + per-event SQLite commit pin the process at ~97% CPU, so `/api/terminal/bootstrap` and `/api/health` never answer) and backfill closed 60 s candles in the paper_live bootstrap.
- [x] DEV-05 docs

## Acceptance

Pure child-spec builder tested; proxy config tested; terminal base-URL selection, remount and no-fallback error tested; spot switch resets state and labels; README documents ports/switch/offline behavior; real smoke of bootstrap endpoints.

## Route

Delegated Sonnet writer (2+ non-trivial files). Delivery strategy: `ask-on-risk`.

## Evidence

- RED: `node --test scripts/dev.node-test.mjs` failed (missing `devChildSpecs`/`devProxyConfig` exports); `--api-only` vitest failed (usage error); TerminalEntry/terminal-stream-client tests 9 failing; App spot-switch 2 failing. GREEN: node:test 15/15, client vitest 631/631 (81 files). FuturesTerminal apiBase test added after the prop (no RED).
- Smoke (pnpm run dev; 5173/8787 were held by a pre-existing dev run, so Vite fell to 5174 and the legacy child hit EADDRINUSE): `/api-mock/terminal/bootstrap` 200 mode=mock source=local-protection.v1; `/api-live/terminal/bootstrap` 200 mode=paper_live source=kraken-public-live-stream.v1; WS handshakes through the proxy open for both. Live child logged `Generated market context transport is invalid` during evidence processing (server-side, unchanged code).
- Decisions added: Origin header normalised to `http://localhost` on proxied WS (backends check exact origin); `?source=legacy` keeps the legacy terminal reachable; spot switch remounts `AppContent` by key.
- Design correction (post-critique): terminal switch moved into the dark terminal header (status slot via `sourceSwitch` prop; dark `SwitchBar` fallback for loading/unavailable/legacy), native hidden-radio segmented control with checked marker + weight + focus ring, 44px targets at <=480px; spot switch restyled with the Tiempo real/Estrategias pill styles (dashboard.css); group names unified "Fuente de datos"; bootstrap 8 s AbortController timeout (no fallback); `/terminal` URL reflects applied source; neutral Spanish copy; polite live-region announcement. RED: timeout, replaceState, radiogroup/class, announcement, voseo, spot group name tests failed first. Parent browser recheck of DEV-03/DEV-04 still pending (kept unchecked).
- Pending: browser journey for DEV-03 / DEV-04.
- DEV-06 (writer): added O(1) `bookQuality` getter (book reuses it; per-event persist path and both app.ts UI updates use one scalar read, no level copy/sort), store `PRAGMA synchronous=NORMAL` after WAL (one committed transaction per event kept), `closedCandlesTail` (bounded, latest closed revision per bucket, index `paper_futures_candle_revisions_bucket` on interval_ms,bucket_start) and paper_live bootstrap `terminal_market` (`createLiveTerminalMarket`, schema `futures-terminal-market.v1`). RED (`pnpm exec vitest run` in server): `bookQuality` test failed (`expected undefined to deeply equal {...}`); synchronous test failed (`expected 2 to be 1`, pragma removed); `closedCandlesTail`/bootstrap `terminal_market` tests failed before implementation. GREEN: focused files 79 passed; `pnpm typecheck` (server) clean; full server suite 809 passed / 10 failed, baseline without my changes 805 passed / 11 failed (same pre-existing Python/futures-runtime/profitability failures). OPEN: the client (`src/app/FuturesTerminal.tsx` ~338-346) only adopts `bootstrap.terminal_market` when schema is `mock-terminal-market.v1`, so the new payload is ignored until that condition also accepts `futures-terminal-market.v1` (outside writer surfaces). Browser verification still pending; DEV-06 kept unchecked.
