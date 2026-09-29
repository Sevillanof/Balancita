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
- Python-only implementation includes the already-implemented synthetic SHORT 1x alongside LONG/FLAT, with its tests and documented limitations. TypeScript is a read-only oracle/reference for already-supported LONG/FLAT behavior. No funding, liquidation, Binance integration, orders, push, or PR. Preserve pre-existing untracked files; do not start PY-SIM-02 or FastReplay/PaperForward work. A local work-unit commit is authorized only after verification is rerun and native review is completed; commit identity and review evidence remain pending until observed by the parent.
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

- [ ] **PY-SIM-01 — Inert Python LONG/FLAT plus synthetic SHORT ledger.** Continue the existing stdlib Python engine; retain deterministic TS-oracle coverage for supported LONG/FLAT behavior and add synthetic SHORT with restricted proceeds and locked collateral. Prove next-open transitions, cost accounting, explicit equity/metrics, empty and terminal-open behavior, and safe unvalued insufficient-collateral handling. This is not Binance Futures validation. Keep isolated from production. Rollback boundary: remove only this Python package/tests/fixtures and this task's plan/tracker evidence.
- [ ] **PY-SIM-02 — FastReplay + PaperForward shared semantics.** Separately specify and test both existing paths before any shared implementation; reconcile their seconds/closed-resampling and persisted-history constraints. No wiring or migration before explicit bounded scope and parity evidence.
- [ ] **PY-SIM-03 — Controlled engine benchmark.** Only after representative frozen local inputs and interpretable trade-log parity exist, compare identical semantics, costs, runtime, memory and maintenance/setup burden. No external data fetch as part of this task.
- [ ] **PY-SIM-04 — Explicit opt-in boundary.** If justified, define an inert, explicit opt-in integration boundary with rollback and historical-report compatibility; production remains TypeScript-default until separately gated.
- [ ] **PY-SIM-05 — Default-switch decision.** Consider switching only after parity, rollback, scope reconciliation, benchmark evidence, and explicit authorization. Retain TypeScript if Python's user-relevant superiority is not demonstrated.

## Workload and delivery

Forecast authored changed lines for the whole feature: approximately **700–1,200** across incremental units (estimate, not a cap). The current first unit is expected to be approximately 150–300 authored lines; reassess at each unit, and do not code-golf to fit an advisory. Delivery strategy is `ask-on-risk`, default. The selected route is delegated direct per task: implement one cohesive unit with its tests/docs; trigger evidence is the cross-language behavior surface. Ask before scope expansion or slicing/review changes when risk or workload justifies it. Initial review candidate boundary is the branchpoint above. For this unit, a local work-unit commit is authorized after verification is reruns and native review is completed; no push, PR, or remote action is authorized. Parent observes and records the commit identity and review evidence; until then they remain pending.

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
- Commit identity: pending (not checked off until parent supplies commit evidence).
- Engram mirror: pending.

### Python SHORT extension evidence (2026-09-28)

- TDD RED: after adding four short-focused cases, the exact Python runner failed in the two short-entry tests because the existing validator rejected `directTarget: "short"`; the next-open LONG abstention regression already passed.
- GREEN: after implementation, the exact runner passed all 12 tests, including LONG oracle fixtures, next-open abstention exit, direct synthetic short entry/mark/cover, both-leg costs, closed metrics, terminal short accounting, invalid targets, and insufficient collateral without liquidation.
- REFACTOR: removed the now-unreachable duplicate LONG close branch; exact Python runner passed all 12 tests again after the behavior-preserving cleanup.
- Short equity is marked as `freeCash + lockedCollateral + restrictedProceeds - liability`; the short equity points expose those components. Existing LONG oracle fixtures remain the only cross-language parity claim; there is no TS SHORT oracle.
- Final verification: `PYTHONPATH=python python3 -m unittest discover -s python/tests -v` — 12 tests passed; `pnpm --dir server exec vitest run src/features/simulations/trade-simulation.test.ts` — 1 file / 13 tests passed (baseline only); `pnpm --dir server typecheck` — passed; `node_modules/.bin/prettier --check plans/btc-eur-simulation-implementation.md odd/tasks/python-simulation-engine.md python/fixtures/long-flat-parity.json python/fixtures/long-flat-default-costs.json` — passed; `git diff --check` plus direct trailing-whitespace scan of all six new files — no findings. Prettier was not run on Python.
- Product/model caveat: this is a synthetic 1x collateral ledger, not Binance Futures valuation. Funding, maintenance margin and liquidation are not modeled; no viability conclusion follows. PY-SIM-02 and FastReplay/PaperForward remain untouched.
- Engram mirror: pending; no mirror write is claimed. Commit identity remains pending and the task stays unchecked.

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
- The Python engine remains independently callable with the standard library; there is no runtime wiring, source acquisition or production-default change. The rollback boundary additionally includes `python/fixtures/long-flat-default-costs.json` and this follow-up evidence. Commit identity remains pending; do not mark PY-SIM-01 complete without review/commit evidence.

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
