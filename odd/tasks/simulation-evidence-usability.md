# BTC-EUR Simulator Evidence and Usability

**Status:** SIM-EVID-01 checked; SIM-EVID-02 through SIM-EVID-04 remain pending.
**Branch:** `fix-graph-panel` (non-default; preserve the existing user changes).
**Review mode:** on.
**Git branch point / merge-base:** `a79ec1facac6c917c9da918c9f4e3fdc5c4e8902` (15 pre-existing commits on this branch since this point).
**Initial work-unit review boundary for this feature:** `369a85b947d0757fbbc640d13544028290ab026a` (HEAD before this work unit).
**Native review candidate:** one new work-unit commit for this feature, reviewed against the initial work-unit boundary above; not the accumulated feature branch.
**Delivery strategy:** `feature-branch-chain` (selected by user); no PR, push, or merge authorized.
**Engram mirror:** pending; mirror the full document to project `balancita`, topic `odd/simulation-evidence-usability/tasks`, with this repo-relative locator and `capture_prompt: false`. Do not invent a session ID. If Engram is unavailable or session/project resolution is ambiguous, leave pending and report it.

## Stable task checklist

- [x] SIM-EVID-01
- [ ] SIM-EVID-02
- [ ] SIM-EVID-03
- [ ] SIM-EVID-04

## Objective and problem

Make the local BTC-EUR automatic simulator easier for a novice to understand and audit by exposing what data it actually has, what it does not have, and how measured strategies compare under defensible validation. Current evidence stores distinct Kraken market observations and Kraken REST OHLC candles; existing simulation paths consume different sources. Users must not confuse trade observations with OHLC candle coverage or infer confidence, suitability, or profitability from an opaque result.

### Why now: observed coverage, not a claim of current market health

At **2026-09-26 15:00:55 UTC**, an existing local database was opened read-only with `query_only` enabled. At that measurement:

- Kraken REST OHLC had **3,766 contiguous 1-minute bars**, from **2026-09-24 00:14Z** through **2026-09-26 14:59Z**; the latest bar was **115 seconds old**.
- Kraken market observations had **42,471 rows**, event times from **2026-09-21 19:00:23Z** through **2026-09-24 14:05:56Z**; the latest observation was **176,099 seconds old**.
- These measurements prove neither 365 days of coverage nor 300 closed trades. Do not imply either is available. They describe one local snapshot only, not current freshness.
- Do not put private/local database paths or contents into UI, fixtures, reports, or this task. Report the sampled source, measurement/as-of time, age, counts, coverage interval, gaps, and missing/insufficient evidence without exposing a path.

Structural evidence: `server/src/features/simulations/simulations-runner.ts` imports `readKrakenObservationRows` and builds replay from market observations; Fast Replay consumes REST OHLC data. Treat those as separate evidence sources and disclose which path produced each result.

## Scope

Three coordinated implementation parts, decomposed into four stable work-unit task IDs below:

1. Read-only dataset coverage UI/API distinguishes market trade observations from REST OHLC 1-minute bars; exposes event and receive timestamps, coverage range, gaps, freshness/age, and missing/insufficient evidence.
2. Honest candidate selection and validation evidence, with flat/no-trade and buy-and-hold baselines alongside every candidate, explicit costs, adequacy/sufficiency, and anti-cherry-picking controls.
3. Minimal accessible novice-facing simulation UI with progressive disclosure: a clear summary first, then source/coverage, assumptions, validation, costs, and detailed metrics. Preserve unrelated dirty work.
4. Bounded, distinct strategy families with visible viability evidence. Independently implement concepts; e.g. Supertrend only after indicator validation, an hourly control, and dynamic PSAR exits, each as testable/versioned hypotheses. Do not copy GPL code. No unsupported “viable” label.

## Explicit exclusions and authorization boundaries

- No real orders, broker integration, real-money execution, or action that submits/modifies/authorizes an order. Simulator remains hypothetical/local.
- No remote fetch, clone, install, code import, or other remote operation is authorized by this local-only scope. Use existing local dependencies and source only; ask separately before any remote operation.
- Keep `doc/**` immutable. Changes under `docs/**` are allowed when appropriate to explain behavior alongside its implementation; the governing docs read for this task remain read-only.
- No claim that any strategy is profitable, predictive, superior, or viable without the declared evidence and acceptance gates. Past simulation is not a profit guarantee.
- No alteration/reversion/staging of unrelated user changes. No `git add` or commit as part of this task document; later implementation commits require explicit work-unit evidence and the delivery-strategy gate.
- BTC-EUR only. Do not turn database observations into claims that data are fresh now.

## Acceptance criteria

- Source identity is explicit and observation rows are never counted or labeled as REST OHLC bars (or vice versa).
- Every displayed coverage/freshness statement is derived from the actual read-only dataset snapshot and carries its measurement/as-of time; event time and receive time remain separately visible or available in detail. Missing data, stale samples, unresolved gaps, and inadequate sample size are explicit, not silently omitted.
- Validation compares all registered candidates plus flat/no-trade and buy-and-hold over the same disclosed eligible window, with identical stated cost assumptions where applicable. Selection and holdout are time-ordered; no random temporal split, look-ahead, post-hoc candidate hiding, or cherry-picked period. Show sample/trade count and why a result is insufficient when it is.
- Report returns net of disclosed commission and slippage; show unclosed position/exposure and baseline semantics. Do not call a strategy viable based solely on positive P&L or an inadequate sample.
- UI uses semantic accessible controls, keyboard navigation, visible focus, and accessible loading/empty/error/stale/insufficient states; progressive disclosure does not hide warnings or source attribution.
- Strategy additions are genuinely distinct and versioned, with independently specified formulas, warm-up/readiness, timing, costs and exit semantics. Supertrend requires validated indicator behavior before strategy use. No borrowed GPL implementation/code.
- Implement each task strict **TDD RED → GREEN → REFACTOR**, showing a focused failing test first, minimum passing change second, behavior-preserving refactor third. Use `pnpm` commands below. No network-dependent tests.
- Forecast workload advisory: approximately **600–1,000 authored changed lines** total; this is an estimate, not a cap. Work-unit planning is around 400 lines/task but not a hard limit and never a reason to code-golf. If risk/size implies chaining, honor `ask-on-risk` and ask before the first feature commit.

## Work units

For every task, record focused test exact result, applicable typecheck/lint/format result, runtime harness scenario and exact result (or `N/A` plus why), rollback boundary, and Conventional Commit identity **only when observed** (otherwise `pending`). The commands are focused minimums; run applicable repository gates for touched packages before closing. Do not claim they passed until run.

### SIM-EVID-01 — Read-only source coverage and freshness

**Deliverable:** API/domain output and UI evidence panel separately summarize observation and REST OHLC coverage; preserve source, event/receive times, measured age/as-of, coverage interval, continuity/gaps, and absent/insufficient conditions. Read-only access only.

**Delegated-direct route:** delegate one bounded implementation unit directly, with its worker reading and changing the source-contract, read adapter, API/presentation, and associated tests as needed. Trigger evidence: the relevant source surface spans at least four files (`simulations-runner.ts`, `kraken-observation-import.ts`, market-store/source contracts, and replay/API wiring), and the read adapter plus UI/API contract are separate nontrivial changes. Start with failing contract tests for source distinction and coverage semantics. Trigger a reassessment (stop and ask before expanding scope) if this requires a schema migration, live fetch, or persistent writes.

**Focused RED/GREEN/REFACTOR command:** `pnpm --dir server exec vitest run src/features/simulations/simulations-runner.test.ts src/features/replay/kraken-observation-import.test.ts`

**Other checks:** `pnpm --dir server run typecheck`; `pnpm run lint`; `pnpm exec prettier --check <each-touched-file>`.

**Runtime harness:** invoke the local coverage read path against an isolated temporary fixture/database in read-only mode; verify source labels, coverage endpoints, gaps, and ages with injected clock. No private DB path in recorded evidence. If no runnable UI/API harness exists, record `N/A` and why.

**Rollback boundary:** revert only SIM-EVID-01 coverage contract/adapter/presentation changes and their tests; do not revert existing local DB, unrelated dirty UI, or other simulator work.

**Evidence:** RED: `pnpm --dir server exec vitest run src/features/replay/market-data-coverage.test.ts src/features/simulations/simulations-runner.test.ts` — 3 expected failures: a year-long OHLC span with an internal gap was called adequate, a long observation span implied adequate completeness, and legacy cached reports were rewritten/replayed to add coverage. UI RED: `pnpm exec vitest run src/features/simulations/presentation/SimulationsPanel.test.tsx` — failed the explicit at-measurement-time label. GREEN: `pnpm --dir server exec vitest run src/features/simulations/simulations-runner.test.ts src/features/replay/kraken-observation-import.test.ts src/features/replay/market-data-coverage.test.ts` — 3 files, 25 tests passed. UI GREEN: `pnpm exec vitest run src/features/simulations/presentation/SimulationsPanel.test.tsx` — 1 file, 12 tests passed, including historical reports without coverage. REFACTOR: restored the unrelated micro-diagnostics table formatting using a narrow Prettier ignore so the panel diff stays focused; final Prettier checks passed. `pnpm --dir server run typecheck` and `pnpm run typecheck` passed. `pnpm run lint` passed with one warning in untouched `src/features/strategy-analytics/StrategyCards.tsx:126` and zero errors. Runtime: 6 isolated in-memory SQLite fixtures used `PRAGMA query_only=ON` before coverage reads and injected measurement/freshness clocks; they cover irregular trade observations, received-time maxima, OHLC gap spans, stale/future timestamps, short spans, and absent legacy tables. No live database was opened or modified. Rollback: above; commit identity: pending (parent owns commit). Observation completeness remains explicitly unknown; OHLC adequacy requires the configured span and zero internal gaps. Final bounded status correction: RED added assertions that long-span OHLC with gaps is `insufficient` and fresh long-span observations are `unverified`; `pnpm --dir server exec vitest run src/features/replay/market-data-coverage.test.ts` failed both assertions before the implementation change. GREEN reran the required focused server command (3 files, 25 tests passed) and panel command (1 file, 12 tests passed); both typechecks, root lint, and Prettier check passed again. Root status is now adequacy-aware while `freshnessStatus` remains independent. Final freeze correction RED: focused coverage test failed on two new status assertions (`available` for gapped year-long OHLC and fresh observations with unknown continuity); after the fix it passed as part of the exact server command above (25/25 tests). A follow-up RED assertion caught a misleading span-only explanation for OHLC gaps; the final reason now names internal gaps. Final root/panel typechecks, lint, and Prettier checks all passed; lint retains the single unrelated StrategyCards warning. Persisted coverage is a historical measurement snapshot; legacy cache hits are not rewritten, while runner results carry a fresh current measurement.

**Verifier correction and close evidence:** Independent verification found that full-database coverage could be mistaken for evaluation-window coverage. The correction labels the scope as global database coverage at measurement time. Work-unit commit `f1c6f2defe7290925b5df5c05df8f90a58b16b71` contains the initial work; corrective commit `ad66d474e2282688648351d04948bf2dca65d5b6` applies the scope correction. The first work-unit diff was 883 lines, exceeding the approximately 400-line advisory; it was not compressed for size. Future PR slices remain human-owned; no automatic publication. Delivery strategy is `feature-branch-chain`; no PR or push.

Writer RED/GREEN evidence: server focused tests, 25 passed; panel tests, 12 passed. Parent spotcheck: coverage tests, 6 passed; panel tests, 12 passed. Independent verifier: requested server command ran all 74 server test files, 583 tests passed; panel tests, 12 passed. Server and root typechecks passed. Lint reported zero errors and one warning in untouched `StrategyCards.tsx:126`. Prettier check passed. Independent verifier returned PASS on corrected committed diff `369a85b..ad66d47` for both window and global scope.

Native RDD assessment: unavailable. Assessment failed as unclassifiable; exact `START` returned `pre_native git_command_failed` with `mutation_outcome: not_started`. No review receipt or native authority exists; this is not a PASS. SIM-EVID-01 closed on functional proof plus independent verifier evidence, not a fabricated native result. No real orders were placed. Engram mirror remains pending because session resolution is ambiguous.

### SIM-EVID-02 — Fair baselines, selection, and validation

**Deliverable:** flat/no-trade and buy-and-hold accompany every candidate on the same disclosed window; cost treatment, time-ordered selection/validation, sample sufficiency, and non-cherry-picked candidate set are explicit and machine-tested.

**Delegated-direct route:** delegate one bounded implementation unit directly through the existing comparison/report flow, with its worker reading and changing runner, comparison/baseline logic, and focused tests together. Trigger evidence: the flow spans at least four files (`simulations-runner.ts`, `comparison-report.ts`, baseline/profitability calculation, and runner/profitability tests); same-window baselines and selection/validation behavior cross multiple nontrivial modules. First add failing tests proving same-window comparisons, time order, costs, and insufficient-sample behavior. Trigger reassessment if the available stored evidence cannot support the requested split or comparable cost semantics; report insufficiency rather than fabricate or broaden data acquisition.

**Focused RED/GREEN/REFACTOR command:** `pnpm --dir server exec vitest run src/features/simulations/simulations-profitability.test.ts src/features/simulations/simulations-runner.test.ts`

**Other checks:** `pnpm --dir server run typecheck`; `pnpm run lint`; `pnpm exec prettier --check <each-touched-file>`.

**Runtime harness:** run a deterministic, closed-bar fixture with all candidate and baseline legs and non-zero explicit costs; inspect same-window outputs and insufficient-data behavior. No real network.

**Rollback boundary:** revert only SIM-EVID-02 comparison/validation changes and associated tests/reports; retain SIM-EVID-01 source coverage and unrelated candidate implementation.

**Evidence:** Flat-cash baseline subunit RED: `pnpm --dir server exec vitest run src/features/simulations/simulations-profitability.test.ts src/features/simulations/simulations-runner.test.ts` — failed as expected because `baselines.flatCash` was absent (1 failing assertion; 15 passed). UI adequacy RED: `pnpm exec vitest run src/features/simulations/presentation/SimulationsPanel.test.tsx` — failed the new explicit evaluated-window assertion (1 failed; 13 passed). GREEN: `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts src/features/simulations/simulations-profitability.test.ts src/features/simulations/simulations-runner.test.ts` — 3 files, 29 tests passed; `pnpm exec vitest run src/features/simulations/presentation/SimulationsPanel.test.tsx` — 1 file, 14 tests passed. Refactor: formatted only the touched implementation/test files after GREEN; behavior preserved and final checks rerun. The new baseline uses the exact selection/validation bars passed to every candidate and buy-and-hold, holds starting cash constant, records zero fills/trades/exposure and zero return, and applies no costs because it trades no legs. Its ledger hash distinguishes it from buy-and-hold; both slices receive the existing `assessBacktestReadiness` result. UI presents it separately from the existing no-change/buy-and-hold alias, shows measured validation-window days with insufficiency reasons, and historical reports without the field remain readable without fabricated data. Comparison/report schema versions were bumped so older cache identities are not reused. Runtime scenario: deterministic two-bar selection and two-bar validation fixture with €30 starting cash and 0.80% commission + 0.05% slippage; verified matching timestamps, constant €30 cash curve, zero fills/cost, separate two-fill buy-and-hold, and insufficient readiness. Runner integration fixture additionally verified flat and candidate curves align on both slices and its roughly 3.3-hour-scale data remains insufficient. `pnpm --dir server run typecheck` and `pnpm run typecheck` passed. `pnpm run lint` had zero errors and the existing warning in untouched `src/features/strategy-analytics/StrategyCards.tsx:126`. Prettier check passed for every touched file; `git diff --check` passed. Rollback: above; commit identity: pending (no staging/commit performed by this delegated worker). SIM-EVID-02 remains pending: Fast Replay/PaperForward fee-policy parity has not been changed or verified and remains an explicit separate follow-up; no viability claim is made.

**Accepted bounded subunit — source-backed comparison fee scenario:** SIM-EVID-02 includes a versioned, default Kraken Pro Spot BTC-EUR Tier1 taker _model scenario_: 0.80% commission per side, separate from the existing 0.05% slippage assumption. Primary source verified publicly without authentication on 2026-09-26: https://www.kraken.com/features/fee-schedule (Tier1 0+ USD qualifying 30-day volume; 0.40% maker / 0.80% taker per side; fees are quote-currency percentages). The scenario is conservative and is not a claim about the user's account, actual fills, or actual fees; account tier is unknown. Any override must remain explicitly labeled user-provided. Report/cache identity must include policy version and rates; historical reports lacking provenance remain historical and must not be rewritten or silently repriced. €30 equal-notional entry and exit illustrates €0.24 commission each side (€0.48 total) plus about €0.03 slippage; calculations use rates against actual quote notional, not rounded illustrative amounts. This subunit does not complete SIM-EVID-02: proving a flat/no-trade baseline on the same window remains pending. Fast Replay and PaperForward retain their existing 0.10% commission + 0.05% slippage defaults and historical ledgers; their parity with this scenario is explicitly pending and must not be implied.

**Subunit evidence:** strict TDD RED: the updated runner test failed because it received the previous 0.10% commission rather than the declared 0.80% Tier1 taker rate. GREEN: the runner fixture produced the versioned source provenance and 0.80%/0.05% distinct rate fields, the persisted request identity carried policy version and rates, and a deterministic €30 buy-and-hold fixture verified commission against each actual fill notional (both about €0.24). The comparison's candidates and existing uniform/buy-and-hold/momentum profitability baselines share the same costs object. UI displays the source URL, verification date, venue/pair/tier/taker role, rate, and unknown-account/non-actual-fill caveat; legacy fee blocks without metadata are labeled unprovenanced and are not rewritten. Focused server tests: 3 files, 28 tests passed; panel: 1 file, 13 passed. Server and root typechecks passed. Lint: zero errors and one warning in untouched `src/features/strategy-analytics/StrategyCards.tsx:126`. Prettier and `git diff --check` passed. Runtime harness: isolated synthetic Kraken-observation fixture, no network; same policy identity recorded with cost rates. Rollback boundary: only the seven fee-scenario/task/test files modified for this unit. No commit/staging performed by this delegated worker. Flat/no-trade same-window baseline proof remains absent; SIM-EVID-02 stays pending.

### SIM-EVID-03 — Accessible novice evidence presentation

**Deliverable:** minimal progressive-disclosure simulator UI that leads with result state and makes source, freshness, coverage, assumptions, costs, baselines, uncertainty, and insufficiency discoverable without obscuring warnings. Keep controls keyboard-usable and semantic.

**Delegated-direct route:** delegate one bounded presentation unit directly, with its worker reading and changing the simulations section/panel, evidence components/styles, and interaction tests together. Trigger evidence: at least four presentation/test files participate (`SimulationsSection`, `SimulationsPanel`, `EquityCurveChart`, navigation/interaction tests), and component behavior plus accessible progressive disclosure require changes across at least two nontrivial UI modules. Begin with failing interaction/accessibility tests. Inspect and preserve the existing dirty files; if the implementation would need to overwrite or entangle those changes, stop and ask for a safe boundary rather than taking ownership of them.

**Focused RED/GREEN/REFACTOR command:** `pnpm exec vitest run src/features/simulations/presentation/SimulationsNavigation.test.tsx src/features/simulations/presentation/EquityCurveChart.test.tsx`

**Other checks:** `pnpm run typecheck`; `pnpm run lint`; `pnpm exec prettier --check <each-touched-file>`.

**Runtime harness:** run the local app against deterministic fixtures; manually verify keyboard-only disclosure, focus visibility, narrow viewport, and loading/empty/error/stale/insufficient states. Record actual scenario/result; browser review is not inferred from jsdom.

**Rollback boundary:** revert only SIM-EVID-03 simulations presentation changes and tests; do not reset or restore `src/app/App*`, `BtcEurDashboard*`, `dashboard.css`, market-data-provider files, or `SimulationsNavigation.test.tsx` user modifications. Resolve overlap by preserving their exact pre-existing diff.

**Evidence:** focused test/result: pending; typecheck/lint/format: pending; runtime scenario/result: pending; rollback: above; commit identity: pending until observed.

### SIM-EVID-04 — Distinct, evidence-gated strategy families

**Deliverable:** a bounded set of independently specified families (possible examples: validated Supertrend, hourly control, dynamic PSAR exits) with visible readiness, warm-up, rule/parameter versions, sample sufficiency, and comparative evidence. No unearned viability label.

**Delegated-direct route:** delegate one bounded strategy-family unit directly, with its worker reading and changing candidate definitions, indicator/exit logic, shared simulation wiring, and focused tests. Trigger evidence: candidate manifest, indicator/strategy implementations, replay engine, and strategy tests span at least four files and at least two nontrivial computational modules; each family must be understood and validated end-to-end. Add one concept at a time with failing indicator/strategy tests first; prove formula and closed-bar timing independently before registering it as a candidate. Supertrend must not be used until indicator validation is green. Trigger stop/ask if licensing provenance is unclear, the proposed implementation would reuse GPL code, or the strategy concept cannot be specified and tested independently.

**Focused RED/GREEN/REFACTOR command:** `pnpm --dir server exec vitest run src/features/simulations/candidate-manifest.test.ts src/features/simulations/simulations-profitability.test.ts src/features/simulations/fast-replay-engine.test.ts`

**Other checks:** `pnpm --dir server run typecheck`; `pnpm run lint`; `pnpm exec prettier --check <each-touched-file>`.

**Runtime harness:** run deterministic closed-bar fixtures for each added family and its baselines, including warm-up, gap/insufficient input, costs, and exit behavior. No network or live-market claim.

**Rollback boundary:** remove only SIM-EVID-04 families, indicator/exit modules, registry entries, and tests introduced by this unit; do not remove shared evidence/baseline infrastructure or existing unrelated strategies.

**Evidence:** focused test/result: pending; typecheck/lint/format: pending; runtime scenario/result: pending; rollback: above; commit identity: pending until observed.

## Task close record

SIM-EVID-01 is complete with the commits and evidence recorded above. SIM-EVID-02 through SIM-EVID-04 are pending. The initial review boundary was `369a85b947d0757fbbc640d13544028290ab026a`; the independent verifier's corrected-diff comparison used `369a85b..ad66d47`. The selected delivery strategy is feature-branch-chain, with no PR or push. This document does not authorize remote operations.
