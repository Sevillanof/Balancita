# Approved Lovable Frontend — Delivery A

## Objective

Deliver the approved Balancita Trader View as a complete, navigable Spanish-language demo, faithfully adapted to Balancita's existing React/Vite architecture. The mock provider supplies deterministic, clearly simulated behavior; this delivery does not connect to a backend, change strategies, enable real trading, or replace the existing real TypeScript/Python UI by default.

## Why

The approved guide explicitly prioritizes a complete visual implementation with useful mocks while backend integration remains a later delivery. Balancita already has a frontend and simulation/replay paths; replacing global configuration or silently routing users into demo would be unsafe and contrary to the guide.

## Authority and source

- Product source: `/Users/franco.sevillano/Downloads/Balancita-guia-implementacion.md`, dated 2026-09-30; Delivery A and its acceptance criteria govern this task.
- Visual/code reference: read-only extracted project at `/private/var/folders/0r/0k2jr77n7c300wtsh1g1f_j40000gp/T/opencode/balancita-lovable-d594766c-reference/proyecto`, representing Lovable commit `d594766c480fb8f0fbc0544ea0476ad20332cd60` (project `d56b9882-65b9-4b39-ab1a-aa16943996db`). Provenance is the supplied export manifest and extraction directory; this tracker does not independently verify hashes or assert browser validation. Do not edit the reference.
- Target baseline: Balancita branch `feat/python-simulation-engine`, starting HEAD `01768c6`; initial worktree was clean. Reconfirm before implementation and preserve any intervening user changes.
- Existing policy: `.github/skills/bitcoin-market-intelligence/SKILL.md` applies strict TDD and prohibits edits under `doc/**`; loaded for this task. Existing task trackers remain intact.

## Scope boundaries

- Authorized roots: `src/**`, focused `src/**/*.test.ts` / `src/**/*.test.tsx`, `public/**` only for frontend assets, and this task document `odd/tasks/approved-lovable-frontend.md`. Touch root package/config files only if a verified existing frontend requirement cannot be met otherwise; stop and request authorization before dependencies, global toolchain/config replacement, or other roots.
- Do not edit `server/**`, `python/**`, `doc/**`, `docs/**`, existing unrelated task trackers, or the extracted reference. Do not modify simulation strategy/economics, backend contracts, order behavior, or existing TypeScript/Python UI default behavior.
- Keep the existing real simulation/replay UI reachable at its current route. Introduce an explicit, reversible demo entry/route; no silent default switch, error fallback, or automatic mode transition. Demo state and labeling must make simulated output unmistakable.
- No real API/network integration, secrets, deployment, push, PR, merge, or remote operation. Local implementation commits only, under the parent session's authorization; no commit is authorized by this planning task.
- UI copy is Spanish, neutral/professional Spanish; code, identifiers, comments, and technical documentation are English.

## Delivery strategy and workload

- Strategy: **feature-branch-chain**, selected for this delivery; one cohesive local work-unit commit per task, with potential review slices mapped to those commits. The feature branch is the rollout boundary; keep the current real UI as an explicit fallback/route.
- Default risk posture: **ask-on-risk**. The prior user-selected local chain decision is sufficient to split cohesive implementation units without another question. Pause for user/parent direction on material scope, route/default changes, backend or strategy coupling, dependency/global config changes, or inability to keep rollback independent. Do not reinterpret this as authority to publish or merge.
- Forecast: approximately **900–1,600 authored additions plus deletions** across Delivery A source/tests/docs, excluding generated artifacts. This is an honest early estimate from the broad terminal, deterministic provider, and historical-form scope; revise after inspection. The ~400 changed-line review guideline is advisory task-sizing guidance, not a cap or code-golf target. Split by the five tasks below; if a cohesive task is larger, report it honestly. No size exception is authorized for any future public PR.
- Rollout: demo is accessible only through an explicit route/navigation choice; preserve the current route as the existing real UI. Rollback removes the new route/entry, demo view/provider/assets/tests and any task-specific wiring, leaving existing routes and simulation behavior unchanged. Do not change the default route as part of rollout.

## Task units

### FE-A-01 — Port the approved shell, tokens, and explicit route

- **Objective:** Establish the visual foundation and an explicitly reachable demo route in the existing frontend without replacing the existing UI.
- **Scope / roots:** `src/**` shell/router/navigation/style/assets and focused tests only; adapt existing project conventions rather than importing Lovable's TanStack Start/Tailwind/shadcn configuration wholesale.
- **Why:** The reference's hierarchy, dark palette, typography, compact terminal header, and separate Terminal/Pruebas históricas navigation define the approved visual identity.
- **Acceptance:** Match the reference's Spanish dark terminal shell and effective tokens; include visible focus and responsive container foundations; demo is visibly labeled simulated; existing real TS/Python UI route remains reachable and remains the default; navigation does not silently change modes.
- **Checks:** Add focused route/shell tests; planned `pnpm exec vitest run <new FE-A-01 focused test paths>`; run changed-file Prettier and `git diff --check`.
- **Route / triggers:** Add a distinct explicit demo route and navigation entry; preserve the current landing route. Triggered when user explicitly opens the demo route or selects its navigation item.
- **Rollout / rollback:** Local branch only. Revert this unit's new route/shell/nav/styles independently; preserve the old entry point.

### FE-A-02 — Build terminal layout and deterministic demo provider

- **Objective:** Render a useful demo terminal from one isolated, reproducible mock source with coordinated market, decision, position, and trade state.
- **Scope / roots:** `src/**` demo domain/provider, terminal view/components and focused tests; no production simulator or server edits.
- **Why:** The reference prototype directly constructs demo data in its page and lacks a complete event flow; the guide requires a complete functional demo rather than inert controls or API-dependent blanks.
- **Acceptance:** Deterministic seeded/fixed-clock scenario; clearly simulated long and short examples; stable related IDs; decisions distinguished from confirmed illustrative executions; coherent quantities/PnL/fees and explicit illustrative disclaimers; useful initial data, plus testable empty/error states. Keep provider separate from presentation and selectable only via explicit demo route/configuration.
- **Checks:** Strict RED/GREEN/REFACTOR tests for deterministic fixtures and demo data contracts; `pnpm exec vitest run <new FE-A-02 focused test paths>`; changed-file Prettier and `git diff --check`.
- **Route / triggers:** Demo terminal route, entered explicitly. Provider initializes on route entry; deterministic simulation clock advances only when the user invokes supported play/pause/reset controls.
- **Rollout / rollback:** Remove this unit's new demo provider/domain/view and tests without affecting existing real UI or Python/TS execution.

### FE-A-03 — Complete terminal interactions and responsive data views

- **Objective:** Complete chart, decisions, selection, filters, interval controls, positions, closed trades, and results as one coherent terminal experience.
- **Scope / roots:** `src/**` terminal components, selection/view state, accessible chart/list alternatives, and focused tests; do not change underlying strategy logic.
- **Why:** The guide requires bidirectional selection, shared filters, interval regrouping over the same history, responsive tables, and readable event timestamps; these correct known prototype limitations.
- **Acceptance:** Chart/decision selection stays synchronized and selected panel rows become visible; multiple events in one candle are selectable; filters agree between chart and panel; interval changes regroup the same event history without changing strategy/events; small-screen tables scroll internally; demo play/pause/reset has no duplicate subscriptions/events; times and simulated statuses are explicit and accessible without color alone.
- **Checks:** Strict RED/GREEN/REFACTOR for selection, filtering, deterministic interval regrouping and lifecycle cleanup; `pnpm exec vitest run <new FE-A-03 focused test paths>`; changed-file Prettier and `git diff --check`.
- **Route / triggers:** Same explicit demo terminal route. User actions on interval, filters, event rows/markers, and simulation controls are the triggers; no action reaches the real engine.
- **Rollout / rollback:** Revert the interaction/components/tests as a unit; FE-A-02 demo remains independently understandable, and existing UI is untouched.

### FE-A-04 — Complete deterministic historical-demo workflow

- **Objective:** Implement the reference's historical form and results as a parameter-responsive, deterministic demo, not a claim of real backtesting.
- **Scope / roots:** `src/**` historical demo route/view, mock calculation/provider and focused tests; no backend/backtest endpoint or Python replay integration.
- **Why:** Delivery A explicitly requires useful historical results derived from selected parameters, with empty/loading/error states, without waiting for backend.
- **Acceptance:** Separate Spanish navigation tab; asset, dates, interval, strategy label and capital inputs validated; results bind to submitted parameters despite later form edits; reproducible illustrative equity/drawdown/win-rate/trade results vary deterministically with inputs and are derived from the example trades; clearly label simulated example and avoid strategy validity/profitability claims; provide test fixtures for empty/loading/error without polluting normal demo.
- **Checks:** Strict RED/GREEN/REFACTOR for validation, parameter binding, deterministic output and state cases; `pnpm exec vitest run <new FE-A-04 focused test paths>`; changed-file Prettier and `git diff --check`.
- **Route / triggers:** Explicit demo historical tab/route; submitting valid parameters runs only the local mock provider.
- **Rollout / rollback:** Remove this route/view/mock calculation/tests independently; no effect on live backend or existing historical functionality.

### FE-A-05 — Delivery-A regression, visual, and route-boundary verification

- **Objective:** Verify the complete demo and existing UI boundary, accessibility/responsiveness, and project regression gates; record exact evidence before delivery.
- **Scope / roots:** Focused `src/**` regression tests and this tracker evidence; fix only authorized frontend/test issues. No scope expansion into backend integration.
- **Why:** A visually faithful standalone demo must coexist safely with established Balancita behavior and be honestly verified at desktop and mobile sizes.
- **Acceptance:** Review 1440×900, 1280×800, and 390×844; verify both demo routes/flows and existing real route; keyboard/focus and non-color labels; no console/runtime errors, dead controls, hidden default switch, or simulated data presented as real. Record exact results; separate unimplemented backend/reconnection requirements as Delivery B, not Delivery-A blockers.
- **Checks:** Run focused Vitest tests and exact existing project gates: `pnpm typecheck`, `pnpm lint`, `pnpm build`, changed-file Prettier (`pnpm exec prettier --check <changed files>`), `git diff --check`. Browser automation availability is unverified: inspect existing Playwright/browser tooling/version during implementation. The user has separately authorized installing Playwright for testing if needed; this does not authorize app-wide dependencies or global toolchain/config replacement. If browser tooling remains unavailable, record browser QA as not run and use the available authorized browser/manual harness honestly.
- **Route / triggers:** Verify explicit demo navigation and original default route after a clean reload; test window sizes and user interaction sequence. No real backend connection required or permitted in A.
- **Rollout / rollback:** Release only on the local feature branch after checks; revert individual work-unit commits or the complete demo branch while retaining the original real UI. No deployment, push, PR, or merge.

## TDD and checks

Strict TDD applies to new demo/provider behavior: first add a focused failing assertion and capture the exact RED result, implement the smallest behavior to pass (GREEN), then refactor with the focused suite still passing. Existing UI shell/layout work with no new behavior may use a focused characterization/route regression rather than inventing brittle tests. Do not claim RED unless observed. Existing runner is Vitest via `pnpm exec vitest run <new focused paths>`; do not install a different runner. Planned project gates are `pnpm typecheck`, `pnpm lint`, and `pnpm build`; formatting/whitespace checks are changed-file `pnpm exec prettier --check <changed files>` and `git diff --check`. Exact test paths and outputs must be recorded by implementation, not fabricated here.

## Explicitly deferred to Delivery B

Real backend/provider transport, streaming/reconnection, backend observability, real historical service, API contract assumptions, real PnL authority, and any live/paper engine control. The names/routes in the Lovable adapter are unverified proposals. No mock fallback on real-provider failure and no strategy or execution changes are allowed in this delivery.

## Status

- [x] FE-A-01 — shell and explicit route (implementation and listed checks complete; visual browser QA remains in FE-A-05)
- [ ] FE-A-02 — terminal and deterministic provider
- [ ] FE-A-03 — terminal interactions and responsive views
- [ ] FE-A-04 — historical demo
- [ ] FE-A-05 — regression and visual verification
- Mirror note: full tracker mirror via Engram remains pending because multi-session project/session association is ambiguous; no unrelated project/session will be guessed.

## FE-A-01 implementation evidence

- **Implemented:** `src/app/DemoShell.tsx` and scoped `DemoShell.css` port the reference's compact brand/navigation/status header, simulated-data badge, disclaimer, dark effective `:root` palette values, 0.375rem panel radius, mono numeric/eyebrow fallback stack, focus-visible link outline, and responsive wrapping/container foundations. No supplied local reference font assets were present, so system fallback stacks are used without network font loading.
- **Entry and trigger:** `/demo` explicitly enters the demo Terminal shell; `/demo/historicas` enters its Pruebas históricas shell. Navigation links trigger standard same-origin route loads and preserve active-page state. `App` checks the explicit `/demo` path boundary before mounting the existing dashboard/provider hooks; `/` remains the unchanged existing app. The shell includes an “Aplicación actual” link back to `/`. This avoids router dependencies and prevents demo visits from starting existing app data hooks.
- **Deliberately incomplete:** FE-A-01 is only visual foundation/navigation. The terminal and historical page clearly state their pending delivery units; no market data, provider, charts, history results, APIs, or pretend controls were added. FE-A-02 through FE-A-05 remain pending.
- **TDD evidence:** `pnpm exec vitest run src/app/DemoShell.test.tsx` first failed RED because `./DemoShell.tsx` did not yet exist (suite failed to resolve the import; no tests ran). After implementation, GREEN: 1 file, 3 tests passed. Regression `pnpm exec vitest run src/app/FastReplaySection.test.tsx`: 1 file, 11 tests passed.
- **Project checks:** `pnpm typecheck` passed; `pnpm lint` passed with one pre-existing warning at `src/features/strategy-analytics/StrategyCards.tsx:126` (`react-hooks/incompatible-library`); `pnpm build` passed with Vite's existing >500 kB chunk advisory. `pnpm exec prettier --check src/app/App.tsx src/app/DemoShell.tsx src/app/DemoShell.css src/app/DemoShell.test.tsx odd/tasks/approved-lovable-frontend.md` passed. `git diff --check` passed. Formatting was applied before checks. No browser visual QA was run; that is reserved for FE-A-05.
- **Scope and rollback:** only `src/app/App.tsx`, the three new `src/app/DemoShell*` files, and this tracker are in scope. Rollback removes the `App` wrapper route/import and the three DemoShell files, restoring the prior default app without changing data owners or behavior. No dependency/config, backend, strategy, global style, commit, remote action, or Playwright install was performed.
- **Actual work size:** approximately 443 authored changed lines including this evidence update (about 413 frontend additions/deletions and 30 tracker lines); the ~400-line sizing guidance remains advisory, not a reason to compress the shell or tests.
