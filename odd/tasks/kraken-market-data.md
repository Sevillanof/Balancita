# Kraken Market Data

## Objective

Replace Coinbase with Kraken as Balancita's BTC-EUR market-data venue across
the frontend, live server collection, and historical replay path.

## Problem

Balancita currently reads live BTC-EUR data from Coinbase, while the selected
historical source is Kraken. Mixing venues would make historical and future
forecast evidence incomparable. Kraken must become the single market-data
venue without adding private credentials or order execution.

## Why

Kraken exposes one coherent public trade stream across downloadable history,
REST catch-up, and WebSocket live events. Using the same venue and trade schema
for past and future observations makes replay and prospective shadow evidence
comparable while preserving their separate evidence modes.

## Authorized scope

- Replace Coinbase with Kraken for BTC-EUR in the browser and server.
- Use public Kraken endpoints only; no API key or private endpoint.
- Add bounded historical trade backfill and deterministic replay support.
- Remove redundant completed planning documents from `docs/`.
- Preserve `docs/implementation-progress.md` and
  `docs/bitcoin-market-intelligence-roadmap.md` because repository instructions
  require them.
- Never edit `doc/**` or `server/data/market.sqlite`.
- Preserve the user's pre-existing `src/domain/analysis.ts` modification.

## Constraints

- Strict TDD: observe RED before implementation, then GREEN and refactor.
- BTC-EUR only.
- No automated or real orders.
- No Kraken credentials in source, environment templates, logs, fixtures, or
  tests.
- Closed candles only; no look-ahead.
- Historical replay and live shadow evidence remain separate.
- Tests use fixtures and temporary or in-memory storage, never real network
  calls or the live SQLite database.

## Delivery

- Strategy: `ask-on-risk`.
- Chain strategy: `stacked-to-main`.
- Forecast: more than 400 authored changed lines across four independent work
  units.
- Review slices: one commit per work unit; no push or pull request without
  separate user authorization.
- TDD mode: enabled by the repository's strict TDD instruction.
- Runners: `pnpm test` and `pnpm test:server`, plus focused Vitest commands.
- RDD mode: disabled for this clone by explicit user decision after the native
  provider failed before review authority mutation.

## Tasks

- [x] **KRA-1 — Consolidate pending Kraken documentation**
  - Delete redundant, unreferenced completed plans.
  - Replace the provider-agnostic replay handoff with one concise Kraken plan
    containing only remaining implementation work.
  - Check: Prettier and reference audit.
- [ ] **KRA-2 — Replace the browser market-data provider**
  - Add fixture-driven tests for Kraken REST OHLC and WebSocket v2 ticker.
  - Implement BTC-EUR history and live quote mapping behind
    `MarketDataProvider`.
  - Remove Coinbase selection and implementation after parity is proven.
  - Check: focused frontend tests, typecheck, and lint.
- [ ] **KRA-3 — Replace the live server collector**
  - Add fixture-driven tests for Kraken WebSocket v2 trades, deduplication,
    event/received time, reconnect, and persistence.
  - Wire Kraken config and remove the Coinbase collector after parity is proven.
  - Check: focused server tests and server typecheck.
- [ ] **KRA-4 — Add Kraken historical backfill and replay orchestration**
  - Add cursor-based REST trade backfill with bounded retries and gap evidence.
  - Persist frozen Kraken datasets without touching the live database.
  - Add source-mode isolation, virtual-time replay, outcomes, and run-scoped
    reporting.
  - Check: focused replay tests, deterministic double-run, and isolation tests.
- [ ] **KRA-5 — Run complete regression gates**
  - Run frontend/server tests, typechecks, lint, build, and formatting checks.
  - Confirm no credential, Coinbase runtime dependency, mixed evidence mode, or
    live database modification remains.

## Acceptance criteria

- Kraken is the only runtime BTC-EUR market-data venue.
- Browser and server consume public Kraken APIs without authentication.
- Historical catch-up and future collection use Kraken trade identifiers and
  preserve provider event time plus local received time.
- Historical and live reports cannot mix evidence modes.
- Existing paper trading remains local and cannot call Kraken order endpoints.
- All applicable checks pass without modifying the user's unrelated work.

## Progress and evidence

| Task  | Status   | Evidence                                                                  | Commit    | Review status      |
| ----- | -------- | ------------------------------------------------------------------------- | --------- | ------------------ |
| KRA-1 | Complete | Prettier passed; reference audit found only a preserved historical record | `e4a35ef` | disabled/unmanaged |
| KRA-2 | Pending  | —                                                                         | —         | disabled/unmanaged |
| KRA-3 | Pending  | —                                                                         | —         | disabled/unmanaged |
| KRA-4 | Pending  | —                                                                         | —         | disabled/unmanaged |
| KRA-5 | Pending  | —                                                                         | —         | disabled/unmanaged |

## Next step

Commit KRA-1 documentation, then start KRA-2 by observing failing Kraken
provider tests against fixtures.
