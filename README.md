# Balancita

A local-first, mock-only personal trading workspace. Phase 0 provides the minimal
project shell: no market data, no backend and no API keys are involved.

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

## Scripts

| Command              | Description                         |
| -------------------- | ----------------------------------- |
| `pnpm dev`           | Start the Vite dev server with HMR  |
| `pnpm test`          | Run the test suite once (Vitest)    |
| `pnpm test:watch`    | Run tests in watch mode             |
| `pnpm typecheck`     | Type-check the whole project (`tsc -b`) |
| `pnpm lint`          | Lint with ESLint                    |
| `pnpm format`        | Format all sources with Prettier    |
| `pnpm format:check`  | Check formatting without writing    |
| `pnpm build`         | Build the production bundle         |
| `pnpm preview`       | Serve the production build locally  |

## Tests

Tests run on jsdom with Testing Library and user-event. Test files live next to the
code they verify (e.g. `src/App.test.tsx`).

## Product scope (Phase 0)

The screen identifies the product ("Balancita") and never requests credentials. There
is no backend, no market data, no authentication and no global state in this phase.
Future phases add deterministic mock market data, a watchlist and charts, as defined
in `doc/personal-trading-app.md`, which is the single source of truth and must not be
edited by tooling.