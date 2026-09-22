# Balancita Architecture Paths

## Objective

Document two implementation paths for the Balancita dashboard: a greenfield
rewrite with FastAPI and a Rust/WASM frontend, and an incremental evolution of
the current React, Fastify, SQLite, and Kraken application.

## Problem

The target experience is clear, but `doc/idea-balancita.md` combines that
product vision with technical choices that conflict with the current system.
The user needs separate, executable plans with realistic cost and risk.

## Authorized scope

- Create two new planning documents under `docs/`.
- Use the wireframe and user-visible behavior from `doc/idea-balancita.md`.
- Preserve Kraken, BTC-EUR, local-first operation, and paper trading safety.
- Do not modify application code or any file under `doc/`.

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

## Next step

Choose one path before authorizing implementation. The recommended default is
the incremental evolution in `docs/balancita-current-stack-evolution.md`.
Recommended path: incremental evolution.
