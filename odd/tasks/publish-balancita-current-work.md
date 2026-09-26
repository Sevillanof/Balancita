# Publish Balancita Current Work

## Objective

Safely publish the existing user dashboard/provider work to `origin/main`, then
consolidate the six existing top-level `docs/*.md` files into exactly two
focused Markdown documents: fully rewrite the remaining-work plan and the
Balancita architecture-and-vision document at their existing paths, and delete
the other four files. Publish the documentation update in a second, non-forced
push.

## Authorized scope

- The user explicitly authorized publishing **all existing work**, including
  the eight pre-existing dirty files, to `origin/main` using the current
  authenticated Git session; no force push is authorized.
- After the first push succeeds, consolidate the six top-level `docs/*.md`
  files into exactly two maintained documents: fully rewrite the existing
  `docs/implementation-progress.md` and
  `docs/bitcoin-market-intelligence-roadmap.md`, then delete the other four.
  The documentation work may be delegated
  for broad reading and synthesis; this task record is the sole task-tracking
  artifact created by this work unit.
- Push that documentation update to `main` using a normal non-force push.
- Do not stage or commit as part of this task record's creation. Later execution
  of the authorized publishing work must preserve the documented push-before-docs
  order and create coherent commits for the code work and documentation work.

## Constraints

- Never delete or modify `README.md`, `AGENTS.md`, files under `doc/**`, any
  other `odd/tasks/*.md`, skill or registry files, or files outside the stated
  scope. The repository skill explicitly forbids editing `doc/**`.
- Do not modify the eight dirty application files while creating this record.
- Preserve existing native review evidence; do not replace or fabricate it.
  No receipt is required or claimed by this task.
- Use English, neutral/professional wording in the authored documentation.
- If a push is rejected, stop immediately. Do not force, rebase, or blindly
  retry; report the rejection and ask for direction.
- Rollback only the files created/changed by this task's authorized work unit;
  do not revert the user's pre-existing work or published commits.

## Starting state

Verified before authoring this task record:

- `HEAD`: `a25ac78` on branch `fix-graph-panel`.
- Exactly eight pre-existing dirty files:
  `src/app/App.test.tsx`, `src/app/App.tsx`,
  `src/app/BtcEurDashboard.test.tsx`, `src/app/BtcEurDashboard.tsx`,
  `src/app/dashboard.css`,
  `src/features/market-data/infrastructure/market-data-provider.test.ts`,
  `src/features/market-data/infrastructure/market-data-provider.ts`, and
  `src/features/simulations/presentation/SimulationsNavigation.test.tsx`.
- Local `main` is an ancestor of `HEAD` by 24 commits.
- Configured `origin` URL is
  `git@github-sevillanof:Sevillanof/Balancita.git`, matching the expected URL.
- The six existing top-level Markdown files are
  `docs/balancita-current-stack-evolution.md`,
  `docs/balancita-main-screen-roadmap.md`,
  `docs/balancita-rewrite-fastapi-rust.md`,
  `docs/bitcoin-market-intelligence-roadmap.md`,
  `docs/implementation-progress.md`, and
  `docs/kraken-market-data-implementation-plan.md`.

## Delivery

- Route: delegated for broad documentation reading and synthesis; retain one
  coherent code checkpoint, followed by one documentation replacement unit.
- Tests: run focused tests for the dashboard/provider code in the corresponding
  code checkpoint and record exact commands/results. Documentation is prose;
  validate formatting, paths/links, scope, and whitespace instead.
- Push policy: preserve the user's order: checkpoint and push existing work
  first; only after that succeeds, consolidate the six docs into exactly two
  maintained documents (two rewrites and four deletions); then push the docs
  update. Both pushes are non-force.
- Review: preserve pending native review evidence. No receipt is produced.

## Tasks

- [x] **PBCW-1 — Checkpoint existing dashboard/provider work**
  - Keep related tests with the behavior, run focused tests, and create a
    separate coherent commit for the existing user changes. Do not absorb this
    task record or unrelated files into that code commit.
  - Observed commits: `5616e69d1387b8f3a7ff61ef07212486401cd89e` (six
    dashboard paths) and `d61fbe4f24de59b61aecfa693e26c662a3dbb319` (two
    provider paths).
  - Verification: focused four UI tests — 32 passed; `pnpm run typecheck` —
    passed; `pnpm run lint` — zero errors and one warning in untouched
    `StrategyCards.tsx`; `pnpm exec prettier --check` on the exact eight paths
    — passed; `git diff --check` — passed.
  - The Kraken default no longer uses the offline mock by default; this is a
    pre-existing user-authored change. No live database or application-browser
    test is claimed.
- [x] **PBCW-2 — Push the current work to `origin/main`**
  - First push succeeded; observed `origin/main` move from
    `a79ec1facac6c917c9da918c9f4e3fdc5c4e8902` to
    `486fd75d31087b58946ee481de06b853acceb049`. Current HEAD and local
    `origin/main` both resolve to the latter commit.
- [x] **PBCW-3 — Consolidate six planning documents into two focused documents**
  - Completed after the successful first push. Fully rewrote
    `docs/implementation-progress.md` as remaining work and
    `docs/bitcoin-market-intelligence-roadmap.md` as the product/architecture
    guide; deleted the other four top-level Markdown files listed above. Target
    inventory: exactly those two Markdown files. Preserve all other Markdown
    and restricted paths. Prettier check passed for both rewritten docs and this task
    file; `git diff --check` passed; `docs/` contains exactly the two retained
    Markdown paths. An outside-scope stale link remains in
    `odd/tasks/kraken-market-data.md:113`; it was not edited.
- [ ] **PBCW-4 — Push the documentation update to `main`**
  - Commit the documentation replacement as its own coherent work unit and
    push non-force. On rejection, stop and report; do not retry blindly.

## Acceptance criteria

- The initial code checkpoint contains only the user's eight existing dirty
  application files, grouped coherently with relevant tests; this task record
  does not alter those files.
- The first non-force push is attempted and succeeds before any of the six
  existing `docs/*.md` files are replaced.
- After consolidation, the top-level `docs/` directory contains exactly two
  Markdown files: the two retained paths have been fully rewritten and the
  other four legacy files deleted.
- All explicitly protected files and directories remain unchanged.
- The second documentation push is non-force and follows the successful first
  push; any rejection stops execution without force or blind retry.
- Native review evidence is preserved, no receipt is claimed, and exact test
  and documentation-check results are recorded.

## Verification and rollback

- Before each commit/push, inspect the intended diff and confirm the work-unit
  boundary; run focused dashboard/provider tests with the code checkpoint.
- For the docs consolidation, run Prettier check on the two rewritten docs,
  audit links and paths, confirm four legacy files were deleted and the two
  retained paths modified, and run `git diff --check`.
- If an unpublished unit fails verification, revert only that unit's scoped
  changes. After a successful push, do not rewrite published history; stop and
  request direction if correction or rollback is needed.

### Current delegated docs unit evidence

- First push completion was observed locally through the supplied branch/HEAD
  and `origin/main` refs before documentation edits; no remote operation was
  performed by this docs unit.
- Authorized paths for this unit: this tracking file, full rewrites of the two
  retained documents, and deletion of the four other `docs/*.md` files. No
  other path is within the rollback boundary.
- Rollback before publication: restore only those six top-level `docs/*.md`
  paths and this task record to their pre-doc-unit contents. After publication,
  do not rewrite history; ask the parent for direction.
- Docs verification: `pnpm exec prettier --check docs/implementation-progress.md
docs/bitcoin-market-intelligence-roadmap.md
odd/tasks/publish-balancita-current-work.md` passed; `git diff --check`
  passed; the targeted top-level Markdown inventory returned exactly
  `implementation-progress.md` and `bitcoin-market-intelligence-roadmap.md`.
  PBCW-4 remains pending until the parent creates the docs commit and performs
  the second push.

## Engram mirror

Mirror target: project `balancita`, topic key
`odd/publish-balancita-current-work/tasks`. Mirror status: pending. Previous
attempts reported `unknown_session` and ambiguous project resolution; do not
invent or substitute a session ID. Retry only if the current runtime session
is unambiguous, otherwise leave this status pending.
