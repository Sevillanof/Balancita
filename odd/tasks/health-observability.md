# Trustworthy health observability

## Objective

Make the existing Salud inspector faithfully report resource usage, storage scope and evidence freshness without adding product modules or changing trading behavior.

## Authorization and isolation

- User authorized implementation on a separate branch and changing only gentle-ai-worker to OpenAI Sol 6.1/high.
- Branch: `feat/health-observability`.
- Worktree: `/Users/franco.sevillano/Documents/Projects/Balancita-worktrees/health-observability`.
- Base: `42f88559e22f5e7c9b63297b689361677be394dd`.
- Do not edit main or any Claude worktree. Preserve existing untracked files there.
- Original implementation preserved the existing dev. New explicit user authorization: stop current and try this worktree; user then confirmed they already stopped it and requested starting this version only. Do not stop unrelated processes or run concurrent dev instances. Runtime launch/readiness observation is authorized; live database tests, maintenance and experiment changes remain forbidden.
- No database maintenance, schema changes, order endpoints, strategy/accounting changes, ADR edits or frozen experiment changes.
- No commits, push, merge or PR without explicit user authorization. Work-unit commit identities remain pending under this delivery constraint.

## Problem and rationale

CPU/RSS/storage measurement exists but failed samples may look like zero, timestamps may look perpetually fresh, storage scope is incomplete, and monitoring performs history-wide work on cache misses. Unknown health must not be fabricated into healthy status. Utilization alone is not an optimization score.

## Acceptance criteria

- Measured zero is distinguishable from missing/failed/stale samples.
- CPU is identified as one-core percentage; RSS is summed resident memory, not unique physical or GPU memory.
- Overlapping resource memberships do not inflate total accounting.
- Resource response separates source sampling, response/cache and storage observation times.
- Storage inventory has explicit bounds, reports completeness and SQLite/WAL/log/other bytes, and declares scope/exclusions. No live table counts to estimate data used.
- No full-history decision aggregation in the periodic resource request path. Unsupported aggregates remain unavailable, not zero.
- Existing Salud reports visibly age; stale/retained/error reports are not represented as current healthy evidence.
- Existing unknown explanations remain honest; retain all six components and backend states.
- Deterministic tests use injected collectors, HTTP mocks and temporary fixture files only.

## Work units

- [x] H1 — Trustworthy resource sampling (functionally verified; commit/native review pending under delivery constraints).
  - Surfaces: `scripts/dev-resources.mjs`, `scripts/dev-resources.node-test.mjs`, sampling integration only in `scripts/dev.mjs`.
  - Checks: Node tests observe RED then GREEN for failed/empty samples, invalid records and overlapping groups; run existing dev-resources tests.
  - Preserve supervisor lifecycle and do not persist raw command lines.
- [x] H2 — Bounded resource endpoint and storage inventory (independently verified; commit/native review pending under delivery constraints).
  - Surfaces: `server/src/features/live-gateway/system-usage.ts`, its test; resource freshness guard and corresponding test only in `observability-health.ts` and its test.
  - Checks: endpoint tests for cache, backward time, failure/staleness, bounded inventory, no historical aggregation; server typecheck.
- [x] H3 — Faithful resource display in existing inspector (independently verified; commit/native review pending under delivery constraints).
  - Surfaces: `src/app/SystemUsageChip.tsx`, `src/app/system-usage.ts`, new corresponding test files.
  - Checks: HTTP errors, stale/missing versus zero, scope/completeness, request supersession/unmount, advancing freshness; frontend typecheck.
- [x] H4 — Advancing health age and understandable unknown states (independently verified after correction; commit/native review pending under delivery constraints).
  - Surfaces: `src/features/observability/presentation/HealthIndicator.tsx`, `health-view.ts`, `Observability.test.tsx`, `src/app/AppStatusChips.tsx`, its test, `docs/observabilidad-salud-api.md`; export existing `CLOCK_SKEW_MS` only in `latest-decision.ts` to share policy without changing B1 logic.
  - Checks: receipt/generation age, skew, stale previous reports, existing six components/unknown explanations; frontend regression tests/typecheck.

## Runtime validation follow-up

- [ ] H5a — Confirm launch prerequisites and free ports (in progress, read-only scout).
- [ ] H5b — Start this worktree only using verified project entry point (pending; no source/config/dependency/data linking changes without resolving prerequisites).
- [ ] H5c — Verify bounded readiness and report the exact UI URL and limitations (pending).
- User states the previous dev has already been stopped; do not issue stop commands automatically.

## Verification and delivery

- Prefer RED/GREEN/refactor with exact focused deterministic commands per work unit.
- Node-only command: `node --test scripts/dev-resources.node-test.mjs`.
- Server: `pnpm --dir server test src/features/live-gateway/system-usage.test.ts src/features/live-gateway/observability-health.test.ts`; `pnpm --dir server typecheck`.
- Frontend: `pnpm test src/app/SystemUsageChip.test.tsx src/app/system-usage.test.ts src/app/AppStatusChips.test.tsx src/features/observability/presentation/Observability.test.tsx src/features/observability/infrastructure/observability-api.test.ts src/features/observability/presentation/latest-decision.test.ts`; `pnpm exec tsc -p tsconfig.app.json --noEmit`.
- Root/server dependencies installed in this worktree with frozen lockfiles, an isolated store under its ignored node_modules tree, package import method copy and ignored scripts. No native build scripts were required. Parent confirmed manifests/lockfiles unchanged. No dependency links or mutations to other worktrees.
- No listening servers for tests. Browser verification of changed UI is pending an authorized non-listening approach; the existing dev serves another worktree and cannot validate these edits.
- Native review only if the user-owned RDD switch is enabled; no review has started for source changes yet.
- Review footprint heuristic: about 400 authored changed lines per unit, including tests; report coherent overage rather than compressing code or silently expanding scope.

## Evidence

- Initial exploration completed read-only (task `mvjjtei4-9-g4yp`).
- Worktree created and registered; main stayed on main with its existing untracked artifacts untouched.
- Worker configuration changed with human consent; other roles preserved.
- H1 worker `mvjk71gb-a-hy1u`: 300 authored diff lines (263 additions/37 deletions); no files outside its three allowed surfaces changed.
- H1 TDD: RED 3 passing/5 failing; final GREEN 11 passing, zero failing. Both syntax checks and diff whitespace check passed according to writer.
- Parent structural readback confirmed null/unavailable failure shape and two-line supervisor integration only.
- Independent verifier `mvjkg7s9-b-h176`: PASS, 11 tests/zero failures or skips, both syntax checks and diff check passed. No blocking H1 finding. Verifier directly observed GREEN; historical RED remains writer-reported. No runtime/UI/end-to-end claim.
- Node v22.22.2 and pnpm 11.3.0 verified. Root/server dependencies absent, separate v9 lockfiles, no workspace manifest.
- Native ASSESS initially unassessable due to intended-untracked declaration; high-risk independent verification requested.
- Native INSPECT with explicit task-document selection blocked on `managed_assets_outdated`. No lineage started, no sync/global managed-asset mutation performed. Native review is unavailable until assets are reconciled; independent functional verification remains required.
- H2 worker `mvjkjmsk-c-896r`: 387 authored lines (+321/-66); only four authorized server files. Total tracked diff H1+H2: 687 lines. Parent spot-check `git diff --check` passed and manifests/lockfiles unchanged.
- H2 writer-reported RED: 21 failures/35 passes; further cache regression RED: 1 failure/57 passes. Final GREEN: 58 server tests; server typecheck and 11 Node tests passed.
- H2 API: resource sample expires after 15 seconds, supervisor after 30 seconds. Response/source/storage timestamps separate; invalid/legacy sources unavailable. Streaming storage inventory 1000 entries/depth 3, partial totals lower bounds, no data-used claim. History-wide decision queries removed; aggregates remain unavailable without bounded source.
- H2 independent verifier `mvjkwasr-d-b2s0`: PASS. Directly observed 58 server tests, server typecheck, 11 Node tests and diff check. No blocking defect; no historical RED/runtime/UI/live/E2E claim. Confirmed unchanged manifests/locks and worktree-local dependency metadata. Native ASSESS again unassessable; no native approval claimed.
- H3 worker `mvjl0qjr-e-ezmd`: 317 authored lines (+268/-49), including new untracked tests; four authorized frontend surfaces only. Worker reported RED16 failures/70 passes, delayed-JSON RED1 failure/92 passes, final GREEN93 tests + frontend typecheck + diff check.
- H3 parent spot-check confirmed HTTP validation, receipt-clock guard before async decode, abort/sequence/unmount guards, advancing UI clock and removal of arbitrary CPU severity. Independent verifier `mvjlbqdr-f-7l4d`: PASS, directly observed 93 tests, frontend typecheck and diff check. No blocking defect; historical RED remains writer-reported; no browser/live/E2E claim. Native INSPECT with explicit untracked tests still blocked on managed_assets_outdated; no sync/approval.
- H4 map `mvjlc58x-g-0b9t` completed read-only. Report age compares generation to itself; evidence reference frozen at generation; receipt exists but is dropped. Parent approved minimal existing skew constant export; no B1 behavior change. Estimated 330–390 authored lines. Presentation freshness uses generation and receipt independently (90-second existing UI policy, 5-second skew tolerance), preserves six backend components/statuses and distinguishes missing evidence from known inactivity.
- H4 worker `mvjlgi21-h-9uu7`: 324 authored lines (+301/-23), seven mapped surfaces. Reported RED17 failures/93 passes, three intermediate 1 failure/109 passes, two final GREEN110 tests; frontend typecheck/diff check passed twice.
- H4 independent verifier `mvjlvy22-i-jkik` confirmed blocking evidence-age defect: `reference = generatedAt + receiptAge` omits generation-to-receipt delay and rewinds evidence ages on cached refresh. Observed aligned-clock reproduction displayed 1s/11s/1s where required ages were 61s/71s/71s. Existing test and docs incorrectly encode receipt anchoring.
- Independent final focused checks all passed: frontend110 + server58 + Node11 = 179 tests, both typechecks and diff check. No skips/failures, but H4 remains blocked on semantic defect. Correction limited to helper, regression assertions and docs; no new functional scope.
- Fresh H4 native INSPECT remains blocked on managed_assets_outdated; ASSESS unassessable/high; no sync, native approval or lineage.
- H4 correction worker `mvjm0klr-j-iwyd`: only helper, existing tests and docs edited. RED twice with 5 failures/109 passes, reproduced 1/11/1s against required 61/71/71s; fixed generation reference, corrected old assertions to 22/24s without fixture changes and added same-generation cache UI regression. Final writer GREEN114 frontend tests, typecheck, diff check. H4 cumulative357 authored lines (+334/-23), under400.
- Independent correction re-verifier `mvjm5982-k-nywh`: PASS. Directly observed 114 frontend + 58 server + 11 Node = 183 passing tests, no failures/skips; frontend/server typechecks and diff check passed. Identical helper reproduction now 61/71/71 seconds; no fixture workaround and no same-generation refresh rewind. All receipt/skew checks preserved. Git status unchanged; manifests/locks/staging empty. Fresh native inspect still blocked; no lineage/approval/sync.
- Functional implementation H1–H4 complete; not deployed or live-validated. Browser/E2E, broad suites/build/lint and actual runtime unknown-state diagnosis were not performed. Native approval unavailable pending managed-asset reconciliation. Existing dev remained untouched.
- Work-unit commits: pending explicit authorization.

## Next step

Complete H5 launch preflight, start only this worktree as newly authorized, then verify bounded readiness and provide the UI URL. User already stopped previous dev. No global sync, staging, commits, publishing or merging authorized. H1–H4 functional checks complete; native review remains unavailable and browser/live validation is not yet established.
