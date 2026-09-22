# Balancita Architecture Paths

## Objective

Define one product-led implementation path for Balancita: reproduce the main
screen first, connect the chart to real market data second, and add real-time
news third.

## Problem

The architecture-first alternatives diluted the immediate product goal. The
user needs a phased path that validates the visible main screen before any
real market or news integration.

## Authorized scope

- Preserve the two previous planning documents as historical analysis.
- Use the wireframe and user-visible behavior from `doc/idea-balancita.md`.
- Preserve Kraken, BTC-EUR, local-first operation, and paper trading safety.
- Do not modify application code or any file under `doc/`.

### Accepted scope correction

- The two architecture-first alternatives are no longer candidate plans.
- Create one canonical three-phase roadmap under `docs/`.
- Phase 1 is exclusively the main-screen experience using deterministic data.
- Phase 2 connects the chart to measurable real BTC-EUR market data.
- Phase 3 connects the news panel to traceable real-time sources.
- Add a supersession notice to both previous alternatives; do not delete them.

## Constraints

- The rewrite uses Python, FastAPI, and a Leptos CSR frontend compiled to WASM.
- Analysis never executes or authorizes an order.
- Automatic strategies may produce signals or a separate shadow simulation,
  but cannot mutate the user's paper account without confirmation.
- Estimates assume one experienced engineer working full-time and include
  tests, migration, and parity verification.
- Documentation checks: Prettier, link/path audit, and `git diff --check`.

## Delivery

- Route: delegated direct; two non-trivial documents trigger one writer.
- TDD: not applicable to prose; structural checks replace runtime tests.
- Forecast: under 400 authored lines across the task record and both documents.
- No push or pull request is authorized.

## Tasks

- [x] **BAP-1 — Document the greenfield rewrite**
  - Architecture, phases, cost, risks, migration, and acceptance gates.
- [x] **BAP-2 — Document the incremental evolution**
  - Current-state changes, order, cost, tests, and acceptance gates.
- [x] **BAP-3 — Validate both handoffs**
  - Run formatting, path, and whitespace checks.
- [x] **BAP-4 — Define the main-screen-first roadmap**
  - Specify the three phases, boundaries, deliverables, and exit gates.
- [x] **BAP-5 — Retire the architecture-first alternatives**
  - Point both previous plans to the canonical roadmap.
- [x] **BAP-6 — Validate the corrected handoff**
  - Run formatting, path, scope, and whitespace checks.

## Acceptance criteria

- The two paths are separate and directly comparable.
- Both reproduce the target dashboard without real-order execution.
- Estimates state assumptions and uncertainty instead of promising dates.
- The rewrite does not silently discard existing behavioral contracts.

## Progress and evidence

| Task  | Status   | Evidence                                     | Commit  |
| ----- | -------- | -------------------------------------------- | ------- |
| BAP-1 | Complete | Rewrite plan created with sourced estimates  | 8789c84 |
| BAP-2 | Complete | Incremental plan created and cross-checked   | 8789c84 |
| BAP-3 | Complete | Prettier, links, and `git diff --check` pass | 8789c84 |
| BAP-4 | Complete | Canonical three-phase roadmap created        | 23fab1b |
| BAP-5 | Complete | Previous plans marked as superseded          | 23fab1b |
| BAP-6 | Complete | Scope, Prettier, and diff checks pass        | 23fab1b |

## Next step

Request separate authorization before implementing phase 1. Phases 2 and 3
remain blocked until their preceding exit gates pass.
