# Incremental Python Simulation Engine Migration

**Status:** Migration is explicitly authorized to start incrementally. Python's long-term superiority is a hypothesis, not an established result. The current TypeScript simulator remains the production path and default.
**Branch:** `feat/python-simulation-engine`.
**Initial review boundary:** `1739f9cb2a05721c76ccda9a94854d29c7694bb1` (branch point/HEAD before this work unit).
**Delivery strategy:** `ask-on-risk`; selected route: delegated direct, one bounded implementation unit at a time. Trigger evidence: simulation ledger behavior spans the TypeScript engine/tests and a new standard-library Python package, while the full feature includes later parity, FastReplay/PaperForward semantics, benchmark, and a separately gated default decision. Ask before expanding a unit or if risk/workload changes materially.
**Engram mirror:** PENDING. The prior session/project resolution was reported ambiguous/unregistered; do not claim a mirror until a write succeeds under an authoritative session identity.

### User-authorized bounded ledger scope (2026-09-28)

- Extend only the existing Python ledger with LONG/FLAT transitions (including abstention closing an open position at the next candle OPEN) and a synthetic SHORT at 1x with locked collateral.
- Account explicitly for short entry, equity/mark-to-market, and buy-to-cover exit. Short-sale proceeds remain restricted and are never free cash. Represent free cash separately.
- If collateral is insufficient to value the case coherently, report it as unvalued; do not invent liquidation or a forced fill.
- Model assumptions: explicit `directTarget` takes priority. With no explicit target, FLAT enters SHORT when `probabilityDown >= entryThreshold`; if both probabilities meet the entry threshold, remain FLAT conservatively. SHORT exits to FLAT on abstention, `probabilityDown < exitUpThreshold`, or `probabilityUp >= exitDownThreshold` (the inverse of the LONG exit rules). These decisions fill at the next candle OPEN. An explicit opposite-side target closes the current position and opens the requested side at the same next open; short entry uses available free cash as 1x locked collateral, commission is paid from that cash, proceeds are separately restricted, and cover losses consume collateral. Insufficient equity/collateral raises a clear unvalued-case error. These are synthetic ledger conventions, not venue rules.
- This synthetic model is not Binance Futures and supports no economic-validity/viability conclusion. Funding, maintenance margin, and liquidation require a separate future unit before any viability conclusion.
- **Dated/superseded PY-SIM-01 checkpoint (2026-09-28):** Python-only implementation includes the synthetic SHORT 1x alongside LONG/FLAT, with its tests and documented limitations. TypeScript is a read-only oracle/reference for already-supported LONG/FLAT behavior. No funding, liquidation, Binance integration, orders, push, or PR. Preserve pre-existing untracked files; do not start PY-SIM-02 or FastReplay/PaperForward work. User authorized a local work-unit commit after rerunning verification; commit `a25ac12a73555b8140c170cae3c779a88be7b446` exists. Native review did not yield a receipt; the documented high-tier fallback was used, not a native PASS. No push was authorized. The no-PY-SIM-02 instruction records that checkpoint only; subsequent authorized offline replay work is documented under PY-SIM-02 below.
- TDD remains strict RED → GREEN → REFACTOR. Record explicit model assumptions and return unresolved business behavior as a gap rather than inventing it. Engram mirror remains pending unless an authorized write succeeds.

## Objective and problem

Establish a safe, evidence-driven path for evaluating Python as Balancita's future primary simulation engine without interrupting the working TypeScript production path. Begin with an inert, deterministic Python LONG/FLAT ledger that can be compared to TypeScript using shared fixtures. No engine switch, real orders, production integration, or profitability conclusion follows from this first unit.

## Scope and constraints

- Authorized roots: `python/**`, `plans/btc-eur-simulation-implementation.md`, and this tracker only. No `doc/**` edits; do not change the docs/ Markdown file count.
- No production API/CLI/default switch, source integration, real orders, network/remote access, credential use, or package installation.
- Python 3.9.6, standard library only; use `unittest`, not pytest. FastReplay's one-minute seconds and separate 15-minute closed resampling are not the ledger's UTC millisecond bars and must not be conflated or wired in yet.
- Existing TypeScript simulation remains the production baseline. Preserve historical results and cost identities; the focused ledger default commission is 0.10% plus 0.05% slippage. The versioned 0.80% tier fee must only be an explicit override, never a silent repricing.
- Closed-bar decisions fill at the next candle OPEN; mark-to-market uses the current candle CLOSE. Terminal open positions count toward equity/exposure but not closed-trade metrics; empty series keep starting cash and nullable exposure/win rate as in the established TS behavior.

## Acceptance criteria

- Python LONG/FLAT and synthetic SHORT 1x behavior is independently callable and inert, with finite input validation and UTC millisecond timestamps. SHORT behavior and its limitations are covered by tests and documentation; it is not venue-valid and adds no funding, liquidation, Binance integration, or order capability.
- Deterministic shared fixture(s) exercise varied/missing/abstaining/direct-target signals, costs and explicit overrides, empty/terminal/unclosed cases. TS-produced expected outputs are compared with stated numeric tolerance; do not claim ledger-hash equivalence unless implemented and verified.
- TDD evidence shows focused RED before implementation, then GREEN, then behavior-preserving REFACTOR. Keep tests with the unit.
- Exact Python runner: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v`.
- Exact TS baseline runner: `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` (plus any new parity test).
- Final applicable checks: `pnpm --dir server typecheck`; exact Python runner; `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md` and changed TS/JSON; `git diff --check`.
- Record each executed command and observed result. No strategy performance/superiority conclusion absent an appropriately controlled benchmark.

## Stable task IDs and sequence

- [x] **PY-SIM-01 — Inert Python LONG/FLAT plus synthetic SHORT ledger.** Complete in `a25ac12a73555b8140c170cae3c779a88be7b446` (`feat(simulations): add isolated Python directional ledger`). Python unittest: 16 passed; existing TS LONG/FLAT baseline: 13 passed (no TS files edited); server typecheck passed; current TS oracle matched both LONG/FLAT fixtures exactly; Markdown/JSON Prettier check passed; whitespace clean across six files. Independent read-only verifier reported no blocking defects. Native assessment returned high risk/unassessable because the git-provider diff command failed; native START returned `invalid_request`, `mutation_outcome: not_started`, target-evidence/target mismatch. No native review receipt/acknowledgement exists; this completion records writer self-verification plus independent-verifier fallback, not a native PASS. Synthetic model is not Binance Futures validation. Rollback boundary: remove only this Python package/tests/fixtures and this task's plan/tracker evidence.
- [x] **PY-SIM-02 — Offline Python replay on frozen inputs (implementation complete).** Implemented and locally committed as `1f36028e8320a93979d24df790d65ecfab57a690` (`feat(simulations): add offline Python replay`). Verification is recorded below. Native review was unavailable; completion is implementation status supported by self-verification and a separate read-only verifier, not native approval. FastReplay comparator is `not_comparable`; no parity or superiority claim. PaperForward persistence/restart remains separate future work, and TypeScript remains the production default.
- [x] **PY-SIM-02-TRACE — Test-only FastReplay decision trace.** Implemented in local work-unit commit `500d54b4573b298349bab5a9a3571824ed663ef4`. Focused and adjacent tests, typecheck, and formatting passed; independent read-only verification found no blocking defect. Native review failed before starting and produced no receipt or approval. Python comparison remains `not_comparable`; see the scoped evidence below.
- [ ] **PY-SIM-03 — Controlled engine benchmark.** Only after representative frozen local inputs and interpretable trade-log parity exist, compare identical semantics, costs, runtime, memory and maintenance/setup burden. No external data fetch as part of this task.
- [ ] **PY-SIM-04 — Explicit opt-in boundary.** If justified, define an inert, explicit opt-in integration boundary with rollback and historical-report compatibility; production remains TypeScript-default until separately gated.
- [ ] **PY-SIM-05 — Default-switch decision.** Consider switching only after parity, rollback, scope reconciliation, benchmark evidence, and explicit authorization. Retain TypeScript if Python's user-relevant superiority is not demonstrated.

- [x] **PY-SIM-02-EXEC-TIME — Audit modeled replay execution time (implementation complete).** Implemented in work-unit commit `9ae315fc54eded25a774462e2012fcfa35857059` (`feat(simulations): audit Python replay execution times`), exactly the two authorized Python files plus this tracker. Authorization: user explicitly authorized this bounded delegated-direct unit; roots are `python/balancita_replay.py`, `python/tests/test_replay.py`, and this tracker only. Route: delegated direct, one unit; trigger evidence: replay consumes close-labeled bars and `simulate_long_flat` fills at the next bar's OPEN while legacy fill `time` is the next bar's CLOSE. Purpose: expose versioned, additive execution-time audit without changing ledger economics, source decision rules, comparator status, or native TypeScript behavior. Contract: distinguish source decision-candle close, modeled `decisionAvailableAt` (earliest modeled availability, not measured arrival), modeled next-open `executionAt`, and unchanged legacy ledger time; derive from actual ledger transitions/signals. Keep audit schema keys consistent when no ledger exists, with explicit `unavailable_no_ledger` comparability and no invented timing. Missing/abstaining/direct-target signals, same-bar reversals, repeated scans, terminal bars, cutoff, seconds conversion, and irregular/gapped bars are represented without fabricating causality. For gaps/irregular intervals affected legacy fills are timing-ambiguous; no gap execution policy is selected. Preserve legacy fills, equity and metrics exactly. Comparator remains `not_comparable`; no economic policy, strategy, or parity conclusion changes. Strict TDD RED → GREEN → REFACTOR; exact source-repo Python runner: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v`. Required checks: that Python runner; `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts src/features/simulations/fast-replay-engine.test.ts`; `pnpm --dir server typecheck`; `node_modules/.bin/prettier --check odd/tasks/python-simulation-engine.md` (Markdown only); `git diff --check`; direct Python trailing-whitespace scan; `git status --short`. Rollback boundary: remove only this task's execution-audit additions from the two Python files and this tracker block/evidence; legacy ledger behavior and all unrelated work remain intact.

- [x] **PY-SIM-02-TIME — Shared frozen synthetic candle time-contract proof.** Completed in local commit `88eff50edfef074a96895a32f8783138ed2a467b`. One cohesive test-only unit routed delegated direct; scope is the shared synthetic fixture, focused FastReplay/Python adapter tests, and this tracker only. Acceptance: both tests consume the exact same frozen 1m source, verify explicit closed 15m `[start,end)` intervals and independently specified membership/OHLCV, check cutoff/boundary/missing-minute behavior, and verify epoch-seconds to close-milliseconds conversion once through `run_replay` with external FLAT signals. Invalid shifted mapping must fail validation. Strict TDD with observed RED → GREEN → REFACTOR; use the exact Python runner, focused FastReplay runner, server typecheck, Prettier on tracker/test/fixture, `git diff --check`, direct Python whitespace scan if changed, and `git status --short`. Forecast: approximately 200–350 authored lines, advisory only. Explicit limits: test-only Python interval adapter does not prove its native resampler parity; no signals/fills/economic parity; Python ledger records next-bar close label although its fill uses next-bar open. No production rewrites or legacy behavior changes.

  - **TDD evidence:** Initial RED — focused TS contract assertion found the initial synthetic source's first timestamp was not UTC-aligned, producing one rather than two complete buckets; fixture timestamps/expected boundaries were corrected. Python RED — first adapter replay raised `KeyError: probabilityUp` because the established ledger signal contract requires probability fields even with external FLAT; supplied explicit neutral FLAT signals. Bounded correction RED — shifted-minute validation raised the expected `ValueError`; a mistaken follow-up aggregation then errored rather than asserting that failure. Replaced it with direct comparison of the mutated interval membership against the canonical sequence. GREEN/REFACTOR results below apply to the corrected full tests.
  - **Final verification:** exact Python runner — 21 passed; focused FastReplay runner — 1 file, 17 tests passed; `pnpm --dir server typecheck` — passed; requested Prettier check — passed; `git diff --check` — passed; Python test whitespace scan — clean. Worktree remains uncommitted for parent review.
  - **Proof limits:** The same frozen synthetic 1m source drives both tests. TypeScript invokes its actual existing resampler; shifting copied source minute 5 by +60 seconds removes its affected canonical bucket while preserving the following bucket, and leaves the original fixture unchanged. Python's test-only `[start,end)` adapter validates UTC-aligned 900-second windows and exactly 15 consecutive timestamps; omitted or shifted minutes raise `ValueError` in that adapter before already-aggregated bars reach `run_replay` (the production replay accepts close-labeled bars, not raw 1m source). Through actual `run_replay`, cutoff at first close minus 1 ms admits no bars, source timestamps, signals, or ledger; cutoff at exact first close admits only that first close label and its signal. Expected close labels are passed in epoch seconds and verified as exact millisecond labels/provenance. This is not Python native-resampler parity, native raw-minute validation, native signals, fill-time/economic parity, or strategy parity. `run_replay`'s ledger retains the next-bar close label even though the fill uses the next-bar open; no fill timestamps or production ledger semantics were changed. Comparator remains `not_comparable`.
  - **Rollback boundary:** Remove only `python/fixtures/shared-time-contract.json`, the added cases in `python/tests/test_replay.py` and `server/src/features/simulations/fast-replay-engine.test.ts`, and this evidence block/task. Production source is unchanged.

### PY-SIM-02 implementation handoff

PY-SIM-02-TIME completion evidence: `88eff50` added the shared fixture and tests without production-source changes. Python suite: 21 passed; FastReplay: 17 passed; typecheck, Prettier and whitespace checks passed. An independent verifier confirmed the corrected replay cutoff assertions on committed bytes and reran all five replay tests successfully. Committed-range native assessment was high/unassessable; exact STATUS-returned START failed pre-native with `git_command_failed`, `mutation_outcome: not_started`, `retry_safe: false`, and `next_action: stop` because its required Git diff command was unavailable. No native receipt or approval exists; no retry or push was performed. Engram mirror remains pending.

This is one cohesive, offline Python replay unit over frozen local fixture inputs. It reuses the existing Python ledger/target and its established cost contract; it does not introduce a second accounting path or silently reprice costs. Implementation and verification evidence are recorded below. Completion means implementation only; it does not claim a native review receipt or approval.

- **Input/time contract:** Replay only closed candles available at each decision time. Make the source interval and cutoff explicit; never use a bar before it is closed or bridge a gap as though data were continuous. Define how stale data and scans with no new closed hourly bar behave. At the FastReplay boundary, convert its epoch-seconds timestamps to the Python ledger's UTC epoch-milliseconds explicitly and exactly once; retain the source timestamps/provenance in replay outputs.
- **Replay/fill contract:** Decisions are deterministic and causal. A signal derived from a closed bar may fill only at the next eligible candle OPEN, never that bar's open or close. Preserve state across replay steps and expose enough outputs to audit decisions, fills, equity/metrics, input window, gaps/cutoff, strategy/config identity, and cost identity. Repeated 15-minute scans over unchanged hourly data add no new hourly evidence and must not manufacture a new bar or repeated transition.
- **Boundary to legacy FastReplay:** FastReplay accepts contiguous one-minute epoch-second bars, resamples complete 15-minute buckets, evaluates the TS micro-strategy and fills next open. Compare only shared LONG/FLAT semantics, using identical frozen inputs, identical complete 1m-to-15m resampling and costs when applicable. Report gaps or unsupported differences; if a shared contract cannot be established, mark the comparator not comparable. The proposed new 1h/15m LONG/SHORT strategy is different behavior, not parity evidence. Keep its comparison separate and make no Python-superiority claim.
- **Unspecified behavior:** Do not invent ADX threshold choices in the 20–25 band, intrahour triggers/signals, funding, or exchange/venue semantics. Defer those features and identify the missing product/strategy decision rather than approximating it. Synthetic SHORT ledger behavior remains subject to PY-SIM-01's limitations; no funding, liquidation, venue validity, or economic viability claim follows.
- **Out of scope:** No production wiring, API/CLI/default switch, live inputs/orders, TypeScript production changes, or PaperForward persistence/restart migration. PaperForward consumes streaming closed candles and persists/rebuilds state; its restart semantics require a separately bounded unit after this offline replay is proven.

**Acceptance and verification:** Use strict focused Python RED → GREEN → REFACTOR with frozen fixtures covering complete and incomplete bars, gaps/cutoffs, stale input and no new hourly bar at 15-minute scans, next-open fills, null/missing/abstaining signals, preserved deterministic state/reproducibility, and identity of the existing cost contract. Compare with the legacy TS baseline only for real shared LONG/FLAT behavior and record exactly which contract was compared; otherwise explicitly report not comparable. Run the exact existing Python runner `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` and, when the shared comparator applies, the exact TS baseline `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts`. The implementing session must record actual commands/results and any applicable formatting/type checks; do not claim tests or parity have run before they do.

## Workload and delivery

Forecast authored changed lines for the whole feature: approximately **700–1,200** across incremental units (estimate, not a cap). The first unit is complete; reassess at each future unit, and do not code-golf to fit an advisory. Delivery strategy is `ask-on-risk`, default. The selected route is delegated direct per task: implement one cohesive unit with its tests/docs; trigger evidence is the cross-language behavior surface. Ask before scope expansion or slicing/review changes when risk or workload justifies it. Initial review candidate boundary is the branchpoint above. PY-SIM-01 was locally committed after verification was rerun; native review did not yield a receipt, so the documented high-tier fallback was used rather than claiming native PASS. No push or PR is authorized. Commit identity is recorded above.

## PY-SIM-01 evidence

- TDD mode: strict RED → GREEN → REFACTOR for source and focused runner.
- RED: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — expected failure before implementation: `ModuleNotFoundError: No module named 'balancita_simulation'`.
- GREEN/REFACTOR (earlier checkpoint): same Python command — 4 tests passed (shared TS oracle parity, empty-window metrics, non-finite input rejection, and caller-input immutability).
- TypeScript baseline: `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` — 1 file, 13 tests passed.
- Typecheck: `pnpm --dir server typecheck` — passed.
- Formatting: `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md` — passed.
- Whitespace: `git diff --check` — passed (untracked additions are not included by Git's diff check; inspect those files directly before commit).
- Oracle confirmation: Node v22.22.2 `--experimental-strip-types` invoked the existing TS `simulateLongFlat`; fixture's fills, equity curve, and metrics match within relative tolerance `1e-12` / absolute tolerance `1e-10`. The oracle case uses explicit 0.80% commission + 0.05% slippage; it has three fills, one closed round trip, and one terminal open position. Hashes are recorded from TS but deliberately not asserted for cross-language equivalence.
- Refactor: normalized signal values are copied instead of mutating caller input; the immutability regression and full four-test Python suite passed after the change.
- Runtime harness: deterministic local fixture only; no production harness is applicable because this unit is inert and not integrated.
- Rollback boundary: remove only `python/balancita_simulation.py`, `python/tests/test_long_flat.py`, `python/fixtures/long-flat-parity.json`, and the PY-SIM-01 evidence in this tracker and plan updates; no production behavior changes.
- Commit identity: `a25ac12a73555b8140c170cae3c779a88be7b446` (`feat(simulations): add isolated Python directional ledger`).
- Engram mirror: pending.

### Python SHORT extension evidence (2026-09-28)

- TDD RED: after adding four short-focused cases, the exact Python runner failed in the two short-entry tests because the existing validator rejected `directTarget: "short"`; the next-open LONG abstention regression already passed.
- GREEN: after implementation, the exact runner passed all 12 tests, including LONG oracle fixtures, next-open abstention exit, direct synthetic short entry/mark/cover, both-leg costs, closed metrics, terminal short accounting, invalid targets, and insufficient collateral without liquidation.
- REFACTOR: removed the now-unreachable duplicate LONG close branch; exact Python runner passed all 12 tests again after the behavior-preserving cleanup.
- Short equity is marked as `freeCash + lockedCollateral + restrictedProceeds - liability`; the short equity points expose those components. Existing LONG oracle fixtures remain the only cross-language parity claim; there is no TS SHORT oracle.
- Final verification: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — 12 tests passed; `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` — 1 file / 13 tests passed (baseline only); `pnpm --dir server typecheck` — passed; `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md python/fixtures/long-flat-parity.json python/fixtures/long-flat-default-costs.json` — passed; `git diff --check` plus direct trailing-whitespace scan of all six new files — no findings. Prettier was not run on Python.
- Product/model caveat (2026-09-28 PY-SIM-01 checkpoint): this is a synthetic 1x collateral ledger, not Binance Futures valuation. Funding, maintenance margin and liquidation are not modeled; no viability conclusion follows. At that checkpoint PY-SIM-02 and FastReplay/PaperForward remained untouched; subsequent PY-SIM-02 offline replay work is recorded in the later implementation evidence below. FastReplay/PaperForward remain untouched.
- Historical checkpoint (2026-09-28): at that point the Engram mirror was pending and the commit identity had not yet been observed, so the task remained unchecked. This checkpoint was superseded by the later completion evidence recorded above. Engram mirror remains pending; no mirror write is claimed.

### Probability-driven SHORT correction (2026-09-28)

- User clarified that SHORT must be reachable from probability rules, not only an explicit `directTarget`. Add RED/GREEN evidence for FLAT `probabilityDown >= entryThreshold` entry and SHORT abstention exit at next candle OPEN.
- Preserve direct-target priority and existing LONG/FLAT oracle behavior. If both directional probabilities meet entry threshold while FLAT, conservatively remain flat; do not infer a side from ambiguous evidence.
- For an open SHORT, inverse LONG exit conditions are abstention, `probabilityDown < exitUpThreshold`, or `probabilityUp >= exitDownThreshold`; no short-specific TS parity claim.
- RED: after adding tests for probability-down entry, abstention cover, and conflicting entry probabilities, the exact Python runner ran 15 tests and errored in the two SHORT tests because no probability-driven SHORT fills were produced (the conservative ambiguity test passed).
- GREEN: after adding FLAT entry on `probabilityDown >= entryThreshold`, inverse SHORT exit rules, direct-target precedence, and conservative no-entry behavior when both probabilities meet entry threshold, the exact runner passed all 15 tests. Added a separate opposite-direction threshold cover test; the exact runner then passed all 16 tests.
- LONG's existing probability target logic is unchanged when already LONG; pre-existing LONG oracle fixtures remain passing. No TypeScript SHORT oracle was added or used.
- Final checks: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — 16 passed; `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` — 1 file / 13 tests passed (baseline only); `pnpm --dir server typecheck` — passed; `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md python/fixtures/long-flat-parity.json python/fixtures/long-flat-default-costs.json` — passed (Python not checked with Prettier); `git diff --check` plus direct trailing-whitespace scan of all six new files — no findings.
- Existing LONG/FLAT oracle-only check: Node `--experimental-strip-types` ran current TS `simulateLongFlat` against `long-flat-parity.json` and `long-flat-default-costs.json`; both matched fills, equity, and metrics within relative tolerance `1e-12` / absolute tolerance `1e-10`. No SHORT oracle was run or claimed.

### PY-SIM-01 follow-up verification (2026-09-28)

- In the existing untracked first unit, RED: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` failed in two timestamp subcases because the Python port accepted `2**53`, an integer that the TypeScript number representation cannot preserve exactly. GREEN: the same runner passed after validating UTC epoch milliseconds within JavaScript's safe-integer range.
- RED: the same runner failed because `10**400` starting cash raised `OverflowError` rather than a consistent finite-input `ValueError`. GREEN: explicit numeric conversion now rejects it with `ValueError`.
- RED: the same runner failed when the additional TS-oracle fixture was absent. GREEN: with the default-cost fixture checked in, six Python tests passed; it covers effective direct-flat exits while long, default 0.10% commission / 0.05% slippage, profitable and losing closes, and a terminal long position. The original fixture retains the explicit 0.80% commission override.
- Node v22.22.2 `--experimental-strip-types` compared the checked-in expected outputs of both fixtures against `simulateLongFlat` from the existing TypeScript implementation; fills, equity, metrics and recorded hashes matched exactly on these inputs. Python comparisons use relative tolerance `1e-12` / absolute tolerance `1e-10` for numeric results and do not assert hash equivalence.
- The Python engine remains independently callable with the standard library; there is no runtime wiring, source acquisition or production-default change. The rollback boundary additionally includes `python/fixtures/long-flat-default-costs.json` and this follow-up evidence.

## Product direction update — user-approved proposal; reconciliation pending

The user approved exploration of a directional futures strategy, but this tracker
does not authorize production integration, broker/API access, or real orders. The
existing TypeScript production simulator remains LONG/FLAT; the separate inert
Python ledger has bounded synthetic SHORT behavior under the explicitly recorded
rules and limitations above. The product definition in
`doc/personal-trading-app.md` still governs and conflicts with futures/backtesting
work. Reconcile through an explicitly authorized owner-led source-of-truth update;
this tracker records the conflict and does not amend `doc/**`.

### Accepted direction and proposed design (not implemented)

- Use a versioned, configurable strategy/plugin boundary and versioned configuration;
  requested global variables are a proposal, not an established architecture.
- A healthy-data directional decision is strict consensus: LONG only at final
  score >= +2, SHORT only at <= -2. Scores -1, 0, or +1 mean remain flat and scan
  again; do not force a tie-break. Missing, stale, or unhealthy inputs block new
  entries. Unknown order status requires reconciliation and is not evidence that
  the account is flat.
- Proposed votes are Bollinger, EMA, and grid, with ADX(14) as a regime filter:
  ADX > 25 prioritizes EMA x2 and ignores grid; ADX < 20 prioritizes Bollinger/grid.
  ADX exactly 20/25 and the intermediate band need explicit behavior. Formulas,
  warm-up, readiness and thresholds remain hypotheses, not validated edge; votes
  may be correlated. Grid may imply multiple orders, conflicting with one position.
- The scan cadence is described as every 15 minutes, while technical OHLCV input is
  proposed as the last fully closed 1-hour candles; both intervals are intended to
  be configurable. Repeated scans over unchanged hourly candles add no indicator
  evidence and must not force repeated orders. Each newly fully closed 1-hour bar
  triggers one mandatory consensus revalidation; this supersedes the earlier rule
  requiring position closure at every hourly boundary. The 15-minute scan does not
  imply a new hourly candle at minutes 15/30/45, and a pre-close observation (such
  as 59:59) cannot use the next bar. Revalidation and any resulting execution have
  real processing/venue latency; they are not guaranteed at the exact boundary.
  The one-hour maximum validity applies to an unreviewed decision, not to a position
  that is continuously ratified by subsequent hourly reviews.
- Exit triggers are indicator-based; no fixed-percentage stop is accepted. A scan
  every 15 minutes using closed 1-hour bars cannot observe an intrahour indicator
  cross. Protection/exit timing therefore needs a defined data/signal path. A stop
  trigger is not a guaranteed fill or maximum-loss cap. Entry orders may be
  postOnly maker-only to avoid taking liquidity when accepted, but may never fill;
  postOnly is not a zero-fee or execution guarantee. Ordinary close limits need not
  insist on postOnly, and a non-postOnly limit may execute as taker. Slippage
  tolerance cannot promise both prompt closure and postOnly.
- A proposed two-rate design separates strategic analysis (closed 1-hour candles,
  scanned every configurable 15 minutes for entries and exit-level updates) from
  a fast exit watcher (market-data stream, with a bounded fallback under evaluation,
  potentially observing updates as often as every 2 seconds). The 2-second figure
  is a proposal, not a latency or execution guarantee; REST polling at that rate
  is not presumed safe under provider limits. The watcher may request an early exit
  on a defined price move or anomaly; any re-entry still requires fresh strategic
  analysis. Intrahour price ticks cannot recompute hourly indicators without an
  explicitly specified intrabar model. A local watcher is not equivalent to a
  venue-hosted protective order, and neither guarantees delivery, trigger timing,
  fill, or price. Before any live-use consideration, select and test the protective
  mechanism and emergency path; a maker-only limit cannot guarantee urgent closure.
  Both modules must share one authoritative position/order lifecycle and serialize
  transitions to prevent duplicate closes or entries. Reconcile partial fills,
  unknown state, and stream reconnects before submitting another order. Define the
  trigger price source (mark, last, or index), event/receive timestamps, freshness
  limits, and trigger calculation. On feed loss, suspend new orders; do not report
  an existing position as closed. Binance's official USDⓈ-M stream documentation
  notes 24-hour connection rotation and does not promise absolute delivery; Freqtrade
  distinguishes on-exchange from off-exchange stops and warns that fills/prices are
  not guaranteed. These references inform design only; no integration is authorized.
- At each mandatory hourly revalidation, healthy consensus that ratifies the open
  LONG/SHORT retains that same position and renews its decision validity for another
  hour, avoiding unnecessary close/reopen costs. Neutral or opposite consensus
  requests an exit; early triggers/emergencies may also request exit. After cancel,
  reconcile order state and partial fills, then submit a separate suitable reducing
  order only for the remaining verified position size. Unknown cancellation/order
  state forbids duplicate or new orders; any protection for remaining exposure must
  use a pre-validated recovery path, not assume the account is flat. Verify whether
  `reduceOnly` or close-position mode applies to the exact contract before design or
  implementation. Confirm the full close before any opposite entry; it requires a
  new valid decision and must never overlap the prior position. A fast-watcher exit
  may be followed by fresh analysis/re-entry within the hour only with fresh data
  and known order/position state. User intent resolves the order-type preference:
  entry may be postOnly; ordinary closes need not be, and taker market is authorized
  as a prospective fallback when urgency or an unfilled close limit warrants
  prioritizing exposure reduction over commission. A market order does not guarantee
  fill, latency (including milliseconds), price, complete exit, or capital
  preservation. Model fees for crossing limits and market fallbacks in backtests;
  the claimed zero maker fee and BNB discount remain unverified. USDⓈ-M BTC/USDC
  would settle in USDC, not EUR, and does not protect or convert capital to EUR.
  These are user-directed design requirements, not implemented behavior.
- Proposed research stack: Python with `pandas_ta` and CCXT; Freqtrade remains a
  separate research option. None is installed, approved for live orders, or proven
  suitable. `defaultType=future`, rate limiting, isolated margin and 1x leverage
  are proposals to verify per exact contract; rate limits do not prevent all bans,
  and 1x is not liquidation-proof.
- Proposed instrument is BTC/USDC USDⓈ-M settled in USDC. Exact Binance symbol and
  contract, Spain/account eligibility, and the claimed 0.00% maker / 0.04% taker
  rates are unverified; rates may be promotional and do not replace prior recorded
  scenarios or establish economic viability. BNB fee discount versus collateral
  use remains unresolved. Do not silently reprice reports.
- Proposed local CSV records should preserve event/receive timestamps, side,
  quantity, fill price, immutable fill IDs, actual fees and fee asset (including
  BNB only when actually charged), plus EUR valuation source/provenance at the
  observed or nearest timestamp. CSV sufficiency for Spanish tax reporting is
  unverified and this is not legal advice. `try/except` alone is not recovery.

### Open decision and evidence gates

- [ ] Hourly revalidation policy is resolved: once per newly fully closed 1-hour
      bar, re-evaluate consensus; retain and renew a ratified position, request close
      on neutral/opposite, and require confirmed full close plus a fresh valid decision
      before an opposite entry. The earlier mandatory close at every hourly boundary
      is superseded. Still define processing/execution latency and the intrahour signal
      model; 15-minute scans and the fast watcher do not guarantee a new hourly bar or
      exact-boundary execution.
- [ ] Define the strategic/fast-watcher boundary, event-stream and bounded-fallback
      behavior, acceptable freshness/latency and provider limits; specify shared
      serialized lifecycle, partial-fill and reconnect reconciliation, trigger source,
      and the venue-hosted/local emergency protection path. No absolute protection,
      latency, or fill-price claim is permitted.
- [ ] Order-type intent is resolved: postOnly may be used for entries; ordinary
      close limits need not be postOnly; an urgent taker market fallback is authorized
      when warranted. Execution design remains gated: validate cancel/partial-fill and
      unknown-state transitions, exact-contract `reduceOnly`/close-position semantics,
      fees, and relevant fill/latency/risk evidence. No guaranteed execution or flat
      state may be claimed.
- [ ] Specify behavior for ADX 20, 25 and between; indicator formulas/parameters,
      warm-up, vote weights, grid/order cardinality, one-position invariant, flat
      thresholds, and strategy/config versioning. Validate against baselines and
      temporally sound evidence; no predictive claim is established.
- [ ] Specify order lifecycle and safeguards: partial fills, timeouts, unknown
      status reconciliation, close confirmation before re-entry, no infinite retry,
      and a safe response when position state cannot be established. Do not assume
      native atomic OCO. Define trigger versus fill semantics and protection path.
- [ ] Verify exact contract, account/geographic eligibility, funding/settlement,
      fees and BNB treatment from authoritative applicable evidence. Preserve prior
      fee assumptions and provenance; do not treat a screenshot or promotional rate
      as personal entitlement.
- [ ] Resolve product-definition conflict before any production integration.
      Maintain TypeScript as default and keep all orders hypothetical absent separate
      explicit authorization. Kraken XBTEUR spot data cannot stand in for futures
      execution; preserve contiguous data windows and never fabricate fills.
- [ ] Define CSV correction/audit and EUR valuation provenance, and obtain
      appropriate jurisdiction-specific review before asserting tax sufficiency.

### PY-SIM-02 implementation evidence (2026-09-29)

- Implemented an inert `python/balancita_replay.py::run_replay` wrapper over
  `simulate_long_flat`; it does not duplicate ledger accounting. Source candle
  timestamps denote candle close, the source interval/cutoff/scan/max-age are
  explicit, bars after cutoff are excluded, missing interval steps are reported,
  and an explicit max-age policy distinguishes stale input from a scan with no
  newly closed bar. Repeated scans rebuild the same ledger deterministically
  from the frozen prefix; no persisted/restart state is introduced.
- Audit output includes signal inputs, source timestamp provenance, converted
  UTC epoch milliseconds, input window, cutoff, gaps, strategy/config IDs,
  parameters, resolved existing cost rates, and the reused ledger's fills,
  equity curve, and metrics. The optional epoch-seconds boundary multiplies
  timestamps by 1,000 once; source values/units are retained.
- Comparator outcome: `not_comparable`. No identical frozen FastReplay 1m input,
  complete-bucket resampling, strategy contract, and costs were provided as a
  common replay input; no TS FastReplay oracle or parity claim was added. The
  distinct proposed 1h/15m LONG/SHORT strategy remains unsupported here.
- TDD: RED — exact Python runner failed to import the not-yet-implemented
  `balancita_replay` module (16 existing tests passed). GREEN — new replay tests
  passed after implementation; two initial assertions exposed float exactness
  and cutoff-relative status expectations, and a further assertion confirmed
  excluded post-cutoff bars do not fabricate a reported gap. Corrected tests
  pass. REFACTOR — consolidated both replay statuses through one call to the
  existing ledger; exact Python runner passed all 20 tests after cleanup.
- Cutoff-provenance regression: RED — extended the deterministic cutoff case
  with a future bar and signal, then ran the exact Python command; all existing
  cases passed but the new assertion failed because future time `14400000`
  appeared in `sourceTimestamps`. GREEN — only append bar/signal provenance
  after its converted timestamp passes the cutoff; the same runner passed all
  20 tests. The case also asserts that future values are absent from
  `signalTimestampProvenance`, `decisionInputs`, and ledger equity/window output.
- Verification: Python runner — `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — 20 passed; TS baseline — `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` — 1 file / 13 tests passed; `pnpm --dir server typecheck` — passed.
- Formatting/whitespace: `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md` — passed; `git diff --check` — passed; direct whitespace scan of both Python files and this tracker — no trailing whitespace. Python syntax compilation — passed. No production runtime harness applies; no Python dependency or TypeScript source change was made.
- Rollback boundary: remove `python/balancita_replay.py`,
  `python/tests/test_replay.py`, and this PY-SIM-02 evidence block only; the
  established ledger and PY-SIM-01 artifacts remain intact.
- Open gaps: replay is LONG/FLAT only through the existing target contract;
  no ADX threshold, intrahour trigger, funding, venue, or exchange semantics
  were selected. FastReplay parity remains unsupported/not comparable, and no
  strategy validity, exchange validity, viability, or superiority is claimed.
- Engram mirror remains pending; no mirror write is claimed.
- Work-unit commit: `1f36028e8320a93979d24df790d65ecfab57a690` (`feat(simulations): add offline Python replay`), exactly four files. Independent read-only verification reread that scope and reran the Python suite (20 passed), TS baseline (13 passed), server typecheck, Markdown Prettier, `git diff --check`, and direct Python whitespace scan; all passed. The parent session also reran the Python suite (20 passed) on committed bytes. These are verification facts, not native review authority.
- RDD assessment: `gentle-ai review assess --agent opencode --base-ref 1739f9cb2a05721c76ccda9a94854d29c7694bb1 --committed-only --json` returned high/unassessable (exit 1) because the required Git diff command failed: provider binary unavailable and no `git-og` fallback. Scoped native STATUS with that base reference and committed-only projection returned START. The corrected exact START returned `gentle-ai.review-integration.failure/v2`, `code: git_command_failed`, `phase: pre_native`, `mutation_outcome: not_started`, `retry_safe: false`, `next_action: stop`. No native review authority, receipt, acknowledgement, or PASS exists. The initial mistyped START returned `invalid_request`/`not_started`; it was a request error, not a provider failure. The documented high-tier fallback is self-verification plus independent read-only verification, not native approval; no workaround or retry was attempted.

### Bounded FastReplay comparator assessment (2026-09-29)

- Scope was limited to assessing whether the existing Python replay can be compared with legacy FastReplay using a common contract. No FastReplay or PaperForward source changes, Binance work, network access, or benchmark were in scope.
- FastReplay accepts a strategy ID, contiguous one-minute candles timestamped in epoch seconds, and a fixed `ticketEur`. It resamples complete 15-minute buckets, starts its decision loop after 50 resampled candles, derives decisions internally through its features, micro-strategy evaluator, and entry gate, and reports trades/aggregate metrics. Its result exposes no per-candle signal trace or equity curve. The published cost scenario is 0.80% commission and 0.05% slippage.
- Python `run_replay` consumes already-resampled bars and externally supplied probability/direct-target signals; its ledger sizes LONG positions from all available cash and provides an equity curve. Its default costs are 0.10% commission and 0.05% slippage; explicit costs can be supplied, but matching rates alone does not align decisions or sizing with FastReplay's fixed-ticket behavior.
- Identical input candles and complete-bucket resampling could be prepared, but identical native signals and position sizing are not exposed through an authorized no-TypeScript-edit path. A valid comparison would need a FastReplay decision-trace/reference seam or a port/reproduction of its features, strategy and gate, plus aligned ticket-sizing and cost semantics. Those requirements exceed this bounded Python-only unit; no such seam or strategy port is authorized here, so work stops at this assessment.
- **Comparator remains `not_comparable`.** No shared fixture or parity assertion was produced; externally supplied synthetic signals must not be labeled FastReplay signals. The separate proposed 1h/LONG/SHORT strategy remains outside this comparison. No benchmark or performance conclusion is made. Any follow-on requires an explicit scope decision authorizing the missing comparator seam or strategy port and the associated semantic alignment.

### PY-SIM-02-TRACE — Test-only FastReplay decision trace (2026-09-29)

- **Authorization and roots:** Explicitly authorized, bounded diagnostic seam in `server/src/features/simulations/fast-replay-engine.ts`, its focused `fast-replay-engine.test.ts`, and this tracker only. This supersedes the earlier FastReplay prohibition only for this seam. No PaperForward, Python ledger/replay, app/API response, production default, strategies, position sizing, costs, live trading, Kraken data, install/network, `doc/**`, historical result, push, or SDD state changes. A local work-unit commit and applicable review remain separate orchestration steps.
- **Acceptance:** Optional observer receives immutable deterministic snapshots from the actual replay loop only when supplied. Each evaluated closed candle records epoch-second timestamp, prior regime/exposure where applicable, raw target/abstention, entry gate outcome with non-proprietary category, effective target, next-open fill scheduling/performance timestamp and side, and post-step exposure. No mutable state references, `performance.now`, production logging, public result fields, parallel signal computation, or decision/economic changes. Without observer, normal result/API and app path remain unchanged.
- **Tests:** Strict TDD RED → GREEN → REFACTOR. Focused coverage records loop-start warm-up boundary/order/count, accepted and rejected entry gates, C27 stop-loss exit from prior-long state at next open, last-bar no-fill while preserving exposure, normal invocation compatibility (excluding `executionTimeMs`), deterministic repeated trace, and frozen snapshots. Existing application callers omit the optional observer; no Python parity/economic-equivalence claim.
- **Exact verification:** `pnpm --dir server exec vitest run src/features/simulations/fast-replay-engine.test.ts`; `pnpm --dir server exec vitest run src/features/simulations/paper-forward.test.ts`; `pnpm --dir server typecheck`; `node_modules/.bin/prettier --check server/src/features/simulations/fast-replay-engine.ts server/src/features/simulations/fast-replay-engine.test.ts odd/tasks/python-simulation-engine.md`; `git diff --check`; `git status --short` and diff readback. Record observed output for every command. Normalize changed files before final verification; no source mutation afterward.
- **Comparator and authority:** Python/FastReplay comparator remains `not_comparable`; this trace enables auditability only and asserts no parity or economic equivalence. No native receipt/approval is created or implied; existing tracker authority status remains unchanged.
- **Rollback boundary:** Remove only the optional observer seam, its focused tests, and this task block. No decision logic, public result shape, production path, or prior PY-SIM-02 evidence is in the rollback set.
- **TDD evidence:** Initial observer seam RED — focused runner failed because expected trace length 2 was 0 (13 pre-seam tests passed); GREEN — focused runner passed 14 tests with actual-loop snapshots. Follow-up coverage: added native-path rejected-gate and C27 stop-loss fixtures; focused runner passed all 16 tests against existing decision/fill behavior before the allocation-only source cleanup (no artificial failing assertion was introduced). The same assertions verify no-observer result compatibility, including economics/trades with `executionTimeMs` excluded. REFACTOR — create snapshot and fill-detail objects only inside the observer-present branch; trace-only bookkeeping on the default path is scalar locals, with no strategy/decision or trade execution changes. Final verification recorded below.
- **Verification:** `pnpm --dir server exec vitest run src/features/simulations/fast-replay-engine.test.ts` — 1 file, 16 tests passed; `pnpm --dir server exec vitest run src/features/simulations/paper-forward.test.ts` — 1 file, 21 tests passed; `pnpm --dir server typecheck` — passed; `node_modules/.bin/prettier --check server/src/features/simulations/fast-replay-engine.ts server/src/features/simulations/fast-replay-engine.test.ts odd/tasks/python-simulation-engine.md` — passed; `git diff --check` — passed. No runtime harness applies: the observer is an optional in-process test seam and normal app callers do not supply it.
- **Commit and independent check:** `500d54b4573b298349bab5a9a3571824ed663ef4` (`feat(simulations): expose FastReplay decision trace for tests`) changed only the authorized three files. A separate read-only verifier inspected the committed diff, ran 16 focused tests and server typecheck successfully, and found no candidate-caused blocking issue. The trace's `fill.scheduled` and `fill.performed` coincide in this synchronous simulator; they are not separate exchange execution evidence.
- **Native review outcome:** RDD remained on. Committed-only assessment from the branch point returned high/unassessable because the required Git diff command failed (`provider binary unavailable and no git-og fallback found`). Scoped STATUS returned a new START binding for this committed range; its exact START failed pre-native with `code: git_command_failed`, `mutation_outcome: not_started`, `retry_safe: false`, and `next_action: stop`. No native authority, receipt, acknowledgement, or PASS exists. The documented high-tier fallback is self-verification plus independent read-only verification, not a replacement native approval. No blind retry or push was performed.
- **Engram mirror:** Pending; no mirror write claimed.

### PY-SIM-02-EXEC-TIME evidence (2026-09-30)

- Strict TDD RED: focused Python replay tests failed in four cases because `run_replay` had no `executionAudit`; one terminal-case assertion also initially used a stale scan cutoff and errored before its intended assertion. Corrected that test input to keep the single-bar replay fresh before implementation.
- Bounded schema correction: independent verification found stale/no-ledger results exposed only `version` and `fills`, unlike populated audits. RED: `PYTHONPATH=python python3 -m unittest discover -s python/tests -p 'test_replay.py' -v` failed with `KeyError: 'availabilityBasis'` in a new exact-key regression covering stale data, no closed data, and a valid empty-fill ledger. GREEN: the same focused command passed all 11 tests after initializing all audit keys consistently; no timing is fabricated and no-ledger comparability is `unavailable_no_ledger`.
- GREEN: `PYTHONPATH=python python3 -m unittest discover -s python/tests -p 'test_replay.py' -v` — 10 tests passed. New tests cover contiguous entry, abstention exit, same-bar close/reversal ordered as two actual ledger fills, terminal/cutoff no-fill, gap ambiguity, deterministic scans, and seconds conversion once. A behavior-preserving cleanup precomputes signal timestamps for audit attribution; the final full suite below passed after this REFACTOR.
- Contract: additive `python-replay-execution.v1` metadata keeps `ledger.fills[*].time` unchanged, identifies fill side/index and legacy timestamp, source decision candle close and exact supplied signal timestamp (or null), modeled `decisionAvailableAtMs` equal to candle close but explicitly not measured arrival, and `executionAtMs` equal to that close only for exactly contiguous next intervals. A gap/irregular interval gives `executionAtMs: null`, `timingStatus: ambiguous_gap_or_irregular_interval`, and `comparability: unavailable_for_ambiguous_fills`; no gap fill policy is selected. Legacy execution remains the ledger's next-available-bar-open economic model with close-labeled `time`.
- Scope/limits: Python replay and tests plus this tracker only; no strategy/economic/accounting, live-latency, TypeScript, comparator (`not_comparable`), or production behavior claims. Same-bar reversal metadata is attached to both actual ordered fill rows from that ledger transition. Rollback boundary is exactly the two Python files' additive metadata/tests and this task evidence/block.
- Independent verifier initially passed 26 Python tests and found one low-severity issue: stale/no-ledger audit output omitted basis/comparability keys. The bounded correction recorded above added the RED exact-schema regression and GREEN implementation; final Python suite passed 27 tests. Parent spot-check also passed all 27 Python tests.
- Final checks after correction: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — 27 passed; `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts src/features/simulations/fast-replay-engine.test.ts` — 2 files / 30 passed; `pnpm --dir server typecheck` — passed; `node_modules/.bin/prettier --check odd/tasks/python-simulation-engine.md` — passed; `git diff --check` — passed; direct trailing-whitespace scan of both Python files — none. The 2026-09-30 writer pre-commit checkpoint showed only the three authorized files modified.
- Native review outcome for committed range: assessment from branchpoint `1739f9cb2a05721c76ccda9a94854d29c7694bb1` was high/unassessable because the required Git diff command was unavailable. Exact STATUS returned a new bound START; exact START failed pre-native with `git_command_failed`, `mutation_outcome: not_started`, `retry_safe: false`, `next_action: stop`. No native approval or receipt exists. No retry or push was performed.
- Engram mirror: Pending; no mirror write claimed.
- Engram mirror: pending unless a write succeeds under the authoritative runtime session identity.
