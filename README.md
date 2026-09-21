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

Start the Vite dev server:

```bash
pnpm dev
```

Open the printed local URL (default: <http://localhost:5173>). Vite automatically
picks the next free port when 5173 is already in use.

### Market data mode

The default mode is deterministic mock data for BTC-EUR, TTWO, and SPCX. To use
the Kraken read-only feed locally, start Vite with:

```bash
VITE_MARKET_DATA_PROVIDER=kraken pnpm dev
```

Kraken mode uses public, unauthenticated REST and WebSocket market-data
endpoints and exposes only BTC-EUR. TTWO and SPCX remain mock-only. This mode is
for local/internal personal use only, and Kraken market data is not redistributed
to third parties. Kraken's terms of use were last reviewed on 2026-09-21. Paper
trading always uses the deterministic mock feed and its existing local simulator
authority; Kraken prices are never used to execute or simulate orders.

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
