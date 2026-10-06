# Balancita

A local-first personal trading workspace. It renders a realtime watchlist and an
instrument detail view with a candlestick chart. Mock market data remains the
default; Kraken read-only mode is available for BTC-EUR only.

## Requirements

- **Node.js**: `^20.19.0 || >=22.12.0` — the version range required by Vite 8.3.0
  (see its `engines` field). Verified against Node v22.22.2.
- **pnpm**: >= 9 — the project's package manager; the lockfile is `pnpm-lock.yaml`.

## Install

```bash
pnpm install
```

## Development

Start everything (MOCK and real data) with one command:

```bash
pnpm run dev
```

Open <http://localhost:5173>. `pnpm run dev` starts seven processes, each with a
prefixed log:

| Process   | Port | What it is                                                                                                                                                                                                                    |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite`    | 5173 | Web app and proxy (`/api` -> 8787, `/api-mock` -> 8788, `/api-live` -> 8789, rewritten to `/api`)                                                                                                                             |
| `server`  | 8787 | Legacy backend (Gemini, spot collectors); `FUTURES_MODE` is forced unset, so `.env` cannot change it                                                                                                                          |
| `mock`    | 8788 | Scripted MOCK futures API (`futures-local-terminal.mjs --api-only`); fresh temporary database per start                                                                                                                       |
| `capture` | -    | Kraken public WebSocket -> `server/data/dev-live/futures-market.sqlite` (sole writer; no HTTP, no engine, no account DB; per-event commits)                                                                                   |
| `live`    | 8789 | Read-only gateway: serves `/api/terminal/*` by tailing that market DB by rowid; starts no collector and no engine (engine shown as off)                                                                                       |
| `verdict` | -    | Python verdict service C: reads the market DB read-only and writes entry verdicts to `server/data/dev-live/futures-verdicts.sqlite` (sole writer; needs `python3`)                                                            |
| `paper`   | -    | Python paper execution D: reads the market and verdicts DBs read-only and writes the paper account (hash-chained events plus snapshots) to `server/data/dev-live/futures-paper-account.sqlite` (sole writer; needs `python3`) |

### Switching between MOCK and real data

- **Futures terminal** (`/terminal`): choose "MOCK" or "Real (paper, Kraken
  público)" in the "Fuente de datos" switch. The choice is kept in
  `?source=mock|live` and in local storage; the default is MOCK. Switching
  remounts the terminal, so no stream state mixes. If the selected backend is
  unreachable the page says so and names the source; it never falls back to the
  other one. `?source=legacy` opens the previous terminal served by the legacy
  backend.
- **Spot dashboard** (`/`): choose "MOCK" or "Real (Kraken)". The
  `VITE_MARKET_DATA_PROVIDER` variable (`mock` or `kraken`, default `kraken`)
  only sets the initial choice. Switching recreates the provider and resets
  quotes and subscriptions.

### Offline behavior

Without network access the `capture` process (and the Real source) cannot reach
Kraken and report it; `vite`, `server` and `mock` keep running, so MOCK stays
usable. A failed `mock`, `capture`, `live`, `verdict` or `paper` process is logged and does not stop
the others. If `capture` stops, the `live` gateway keeps serving stored candles
and reports the feed as stale; restarting `live` does not affect `capture`.
Press Ctrl-C once to stop every process.

Rollback: `DEV_LIVE_SINGLE_PROCESS=1 pnpm run dev` runs the previous
single-process `live` child (`FUTURES_MODE=paper_live`: collector, engine and
HTTP together) instead of `capture` + gateway (no `verdict` or `paper` child).

### Market data mode

Kraken mode uses public, unauthenticated REST and WebSocket market-data
endpoints and exposes only BTC-EUR. TTWO and SPCX remain mock-only. This mode is
for local/internal personal use only, and Kraken market data is not redistributed
to third parties. Kraken's terms of use were last reviewed on 2026-09-21. Paper
trading always uses the deterministic mock feed and its existing local simulator
authority; Kraken prices are never used to execute or simulate orders.

### Local MOCK futures terminal: start, interrupt, recover

A reproducible, fully simulated BTC/USD perpetual scenario (no network market
data, no real orders, no credentials, funding fixed at zero). It needs Node
`>=22.12` (verified on v22.22.2) and `python3` on `PATH` (standard library only).
The UI is always labeled MOCK; nothing falls back silently to another mode.

Start (fresh run; the output directory must not exist):

```bash
node scripts/futures-local-terminal.mjs --api-port 8787 --ui-port 5174 \
  --output-dir /tmp/balancita-demo --interrupt-after-stage partial-fill
```

Open <http://127.0.0.1:5174/terminal>. The scenario starts when the page
subscribes. After `partial-fill` commits (stage 3 of 5; long 0.005 BTC open) the
status line reads "Escenario interrumpido ... (MOCK)", the process prints
`INTERRUPTED ...` plus a one-line `--resume` hint, and exits with code `75`
(check with `echo $?`). The UI server stops with it, so the open page cannot be
reloaded until `--resume` starts it again. All state stays in
`/tmp/balancita-demo/paper-futures.sqlite`. `--interrupt-after-stage` takes a
stage name (`warmup`, `entry-selection`, `partial-fill`,
`protective-stop-crossing`) or `1`-`4`. Without it the run just completes
(flat, equity `9999.21014`, fees `0.49986`, gross `-0.29`, two fills).

Recover (same ports and directory; reload the page):

```bash
node scripts/futures-local-terminal.mjs --api-port 8787 --ui-port 5174 \
  --output-dir /tmp/balancita-demo --resume
```

`--resume` only accepts a directory created by this launcher for this exact
scenario (`local-terminal-output.json` plus a verified SQLite run) and refuses a
missing, foreign, mismatched or corrupted one. It re-verifies the run, continues
at the first stage without a committed receipt (a stage that was accepted but
not committed is re-driven by its own work id, so there are no duplicate orders
or fills), restores any candles that were committed but not yet presented, and
shows "Escenario reanudado desde SQLite (MOCK) ...". A killed process (Ctrl-C,
`kill -9`) is recovered the same way.

Verify against a continuous run: the automated check is
`pnpm --dir server exec vitest run src/features/paper-futures/futures-local-scenario.test.ts`,
which compares the recovered run with a continuous one (orders, fills, fees,
position, P&L, analyses, durable events and head hash), including a `SIGKILL`
at a committed boundary and with a stage accepted but not committed. Manually,
the final account must equal the continuous values above.

Limits: single scripted scenario; funding is zero, so this does not verify
funding accrual; recovery is of the scripted MOCK run, not of any real feed;
pause/resume/new-run commands issued after a recovery replay a rebuilt copy
of the last scripted market; that path is not verified here.

## Scripts

| Command             | Description                             |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Start the Vite dev server with HMR      |
| `pnpm test`         | Run the test suite once (Vitest)        |
| `pnpm test:watch`   | Run tests in watch mode                 |
| `pnpm typecheck`    | Type-check the whole project (`tsc -b`) |
| `pnpm lint`         | Lint with ESLint                        |
| `pnpm format`       | Format all sources with Prettier        |
| `pnpm format:check` | Check formatting without writing        |
| `pnpm build`        | Build the production bundle             |
| `pnpm preview`      | Serve the production build locally      |

## Tests

Tests run on jsdom with Testing Library and user-event. Test files live next to the
code they verify (e.g. `src/App.test.tsx`).

## Product scope (Phases 4 and 9)

The default watchlist shows deterministic mock instruments with realtime mock
quotes, and selecting an instrument opens a detail view with its price summary
and a mock candlestick chart. In Kraken mode the catalog is filtered to the
public BTC-EUR pair and the same UI consumes read-only live/history data. A
workspace tab list switches between Watchlist and Portfolio. The portfolio keeps
manual positions (quantity and average cost) in localStorage behind a versioned
`PortfolioRepository`, subscribes to the selected market source for eligible
holdings and derives per-position cost, current value and profit/loss (absolute
and percentage) on render; quotes and totals are never persisted. Corrupt stored
data surfaces an explicit reset instead of being silently trusted. The screen
identifies the product ("Balancita") and never requests credentials. There is no
backend, no authentication and no global state.
The roadmap lives in `doc/personal-trading-app.md`, which is the single source of
truth and must not be edited by tooling.

## Chart attribution

The candlestick chart is rendered with [Lightweight Charts] by TradingView, which is
licensed under the Apache License 2.0 and requires attribution. The chart shows the
TradingView attribution logo in the corner by default
(`layout.attributionLogo`).

[Lightweight Charts]: https://www.tradingview.com/lightweight-charts/
