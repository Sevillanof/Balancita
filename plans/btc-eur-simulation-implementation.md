# BTC-EUR Simulation: Outcome-First Implementation Plan

**Status:** Incremental Python simulation-engine migration is explicitly authorized to start on a bounded, inert parity unit. This does not authorize production integration, a default switch, or a claim that Python is superior; no implementation is claimed by this plan text alone.

**Decision:** Keep Balancita's React/Vite + TypeScript and Fastify/TypeScript + SQLite architecture and TypeScript production simulator. Begin an incremental Python migration with independently testable, inert units so parity and maintenance evidence can be gathered before integration. Python may be a better long-term fit, but that expectation is unproven; production remains TypeScript-default unless parity, rollback, scope reconciliation, a controlled benchmark, and a separate explicit decision support changing it. Do not adopt Freqtrade or replace the stack by implication.

## Executive decision

The primary problem is not the absence of a backtesting framework. It is the need to provide trustworthy, sufficiently broad BTC-EUR history and comparable, reproducible simulation evidence without hiding uncertainty. Kraken REST OHLC is bounded to 720 recent entries, so repeated `since` requests are not a historical pagination strategy. First verify the available licensed BTC-EUR historical source and its coverage; then design a provenance-preserving local dataset and improve the existing simulator. A framework choice follows that evidence, not the other way around.

Keep the current runtime and business logic as the production path for now. The authorized first Python unit is an inert standard-library LONG/FLAT ledger with deterministic TypeScript-oracle parity tests; it does not connect to production APIs or change defaults. Subsequent units must separately establish FastReplay and PaperForward semantics, then controlled parity/performance evidence on identical frozen local inputs before any explicit opt-in integration or default-switch decision. Treat Freqtrade as an isolated reference, not an adopted dependency. Parquet/DuckDB, Polars lazy evaluation and Rust are conditional optimizations, not prerequisites.

**Evidence goals, not promises:** 365 days of usable 1-minute BTC-EUR candles and at least 300 closed trades per candidate are adequacy targets. They are not a guarantee that a source can supply this evidence, that every strategy will trade that often, or that a strategy is viable. Until coverage and sample criteria are met, show insufficiency rather than extrapolating.

## What is known and what remains to verify

| Statement                                                                                                                                        | Evidence status                                                                                                                                                                       | Planning consequence                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser app uses React/Vite/TypeScript; server uses Fastify/TypeScript and local SQLite.                                                         | Established in the product roadmap.                                                                                                                                                   | Preserve existing architecture unless measured evidence justifies a change.                                                                                                                                         |
| REST OHLC and market trade observations are distinct sources and existing simulation paths use different evidence.                               | Established in the roadmap and ODD record.                                                                                                                                            | Never combine their counts, label trades as candles, or imply equal coverage.                                                                                                                                       |
| Kraken REST OHLC returns at most 720 recent entries regardless of `since`.                                                                       | Verified in Kraken documentation: [Get OHLC Data](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/).                                                                          | Do not implement repeated `since` pagination as if it yields full history. Confirm behavior against current endpoint limits in a bounded local fixture/test.                                                        |
| Kraken documents downloadable historical time-and-sales CSVs.                                                                                    | Source exists: [Downloadable historical market data (time and sales)](https://support.kraken.com/hc/en-us/articles/360047543791-Downloadable-historical-market-data-time-and-sales-). | Investigate BTC-EUR inclusion, period coverage, schema, revisions, redistribution/usage terms, availability and gaps before selecting it. No local availability, terms, continuity or 365-day coverage is proven.   |
| Dated local snapshot: 3,766 contiguous one-minute REST OHLC bars; 42,471 separate market observations.                                           | Measurement at 2026-09-26 15:00:55 UTC, recorded in [implementation progress](../docs/implementation-progress.md) and [ODD task](../odd/tasks/simulation-evidence-usability.md).      | Historical snapshot only; neither current freshness nor one-year history nor 300 closed trades is established. Re-measure via approved read-only paths.                                                             |
| Four active strategies and 24 archived replay-only versions.                                                                                     | Reported at the ODD checkpoint; verify current manifest/registry before each implementation that relies on the exact count.                                                           | Compare all currently registered active strategies, including losers. Archived versions support historical replay, not selection into new active comparisons.                                                       |
| Fee scenario: Kraken Pro Spot Tier 1 taker 0.80% per side plus separate 0.05% slippage.                                                          | Existing versioned model assumption; user account tier and actual fees are unknown.                                                                                                   | Do not silently reprice historical results. Include policy version/rates in new run identity and disclose model-vs-account distinction.                                                                             |
| Existing product-definition text says advanced quantitative backtesting is initially out of scope and describes Coinbase as the observed source. | Still present in [`doc/personal-trading-app.md`](../doc/personal-trading-app.md); later roadmap and implementation describe Kraken BTC-EUR simulation.                                | This is a governance/documentation conflict. Resolve with the product owner by reconciling the source-of-truth decision before treating this plan as accepted scope. This plan does not supersede or edit `doc/**`. |

## Intended outcome and boundaries

Deliver a local, deterministic BTC-EUR simulation workflow whose reports answer: what data and time window were used, what was missing, what strategy/version/cost rules ran, how candidates compare on equal evidence, and whether the sample is adequate to support any conclusion. Preserve the ability to replay historical outputs under their original identity and rules.

### In scope

- Verify and document legal/practical availability of an appropriate BTC-EUR historical source; distinguish source evidence from derived bars.
- Define normalized, immutable, time-aware dataset and simulation-run contracts with coverage and gaps explicit.
- Import/read data locally in bounded, restartable and auditable steps only after source terms and operational constraints are approved.
- Keep fair active-candidate comparison, flat/no-trade and buy-and-hold baselines, versioned cost policy, temporal holdout and explicit insufficiency.
- Accessible novice-facing presentation (SIM-EVID-03) and distinct, evidence-gated strategy families (SIM-EVID-04) remain planned, outstanding work—not completed by this document.
- Benchmark an isolated reference engine only if there is a concrete decision question and a frozen local dataset.

### Explicit non-goals

- No exchange private order API, broker integration, live execution, deposits, withdrawals or real-money operations.
- No profitability, predictive-power, account-fee, freshness or data-availability claim unsupported by measured evidence.
- No automatic adoption of Freqtrade or rewrite to Python, Rust, FastAPI, or a new production framework. Incremental inert Python parity work is authorized, but production remains TypeScript-default pending the gates above.
- No unapproved external fetch, download, install or dataset transfer as part of this plan. Source and rights investigation precedes any integration; obtain separate authorization for remote operations and specify destination, operation and credential/session if relevant.
- No change to `doc/**`; no SDD state or ODD task tracker creation/update in this plan-only deliverable.
- No requirement to introduce Parquet, DuckDB or Polars before profiling demonstrates a need.

## Target architecture and data flow

```text
Approved historical source
  -> source-specific acquisition/import (bounded, resumable, audited)
  -> immutable raw artifact + checksum + source/rights metadata
  -> validation and normalized BTC-EUR bars/events (UTC; gaps retained)
  -> frozen dataset snapshot / content identity
  -> deterministic simulator + registered strategy versions + cost policy
  -> common-window candidate and baseline evaluation
  -> immutable run/report with provenance, adequacy and warnings
  -> accessible UI: outcome first, evidence and details progressively disclosed
```

The existing TS/Fastify/SQLite stack remains the baseline. Keep acquisition separate from simulation and avoid a second source-of-truth dataset. An import must be idempotent or safely resumable, validate before publication, and preserve raw-source identity. A failed or incomplete import cannot be presented as a complete history. Exact storage layout is a later design decision informed by measured volume, query patterns, local disk constraints and recovery needs.

### Data and run contract requirements

Each dataset/run needs, at minimum:

- Instrument/pair identity `BTC-EUR`, provider-native pair when known, source type (REST OHLC, historical trade CSV, or derived bars), interval and schema/normalization version.
- Source URL or documented origin, retrieval/import timestamp, source coverage, artifact checksum/content identity, licensing/terms decision and any quota/cost/retention limits.
- UTC event interval boundaries and separate local receive/import/measurement timestamps. Candle start time, interval, and closed status must be unambiguous.
- Expected versus observed timestamps, explicit gaps/duplicates/out-of-order or invalid-row counts, and validation outcome. Do not synthesize flat candles over missing intervals or treat missing bars as no-trade evidence without a declared policy.
- For derived candles: aggregation rule, event-time ordering, tie behavior, interval boundary convention, input dataset identity, and whether zero-trade intervals are omitted or represented. Preserve source events separately from derived OHLC.
- Simulator/engine version, strategy ID and rule/parameter version, warm-up/readiness behavior, execution timing, and cost-policy ID/version/rates.
- Evaluation windows and exact eligible timestamps/bars shared by all candidates and applicable baselines; selection/validation/held-out partition boundaries, embargo, trade count, exposure/open position, costs and adequacy reasons.
- Deterministic run identity sufficient to replay without mutating old results. Historical reports lacking provenance remain explicitly unknown; never fill metadata by assuming today's policy.

## Evaluation rules

1. Use closed bars only. A signal computed from a candle may not execute at a price or time that was not available after that candle closed. Specify the earliest eligible execution point and model spread/slippage consistently.
2. Enforce strict chronological evaluation: training/selection precedes validation/held-out periods; any walk-forward folds advance in time. No random temporal split, future-derived feature, future label leakage, or use of information after the evaluation cutoff.
3. Run every active registered candidate, including losing and abstaining candidates, on the same eligible data cut. Do not narrow to score-ranked winners or hide candidates after seeing results. Archived rules are replay-only unless explicitly re-registered as active under a reviewed decision.
4. Include flat/no-trade and buy-and-hold baselines on the same disclosed window. Explain their semantics and cost treatment. A no-trade baseline incurs no trading fees; buy-and-hold costs apply to its actual modeled fills.
5. Disclose per-side commission and separate slippage. For current new-run scenario, use the versioned 0.80% taker commission plus 0.05% slippage only where the accepted product policy calls for it. Do not change old run economics retroactively.
6. Report gross/net performance, fills and closed trades, open exposure, drawdown/risk metrics as defined, and the dataset/window/cost context. Missing denominators or incomplete periods must remain visible.
7. Apply eligibility and adequacy gates uniformly. The recorded targets of 365 days and 300 closed trades are evidence thresholds to test against actual data, not guarantees of strategy viability. A short history, gapped series, too few trades, or unverified source continuity is `insufficient`/`unverified`, not a positive result.
8. Use common eligibility across all active candidates for comparative diagnostics; distinguish computational comparability from statistical adequacy. Preserve shared eligible timestamps/counts and do not infer comparability from each candidate's separate sample.
9. Add lookahead/leakage regression tests and adversarial fixtures (gaps, open candle, future timestamp, missing candidate rows, uneven readiness, zero trades, nonzero costs, old provenance). Where practical compare outputs against a simple independently specified reference calculation.
10. Paper-forward observation is a separate prospective check. It does not replace held-out historical evaluation, and it must not trigger real orders.

## Sequenced work and acceptance gates

Tasks below are planning units. SIM-EVID-03 and SIM-EVID-04 retain their stable identifiers in the existing ODD tracker and are not marked complete here. Sequence data/source feasibility before architecture extensions; presentation and strategy work can proceed independently where they do not assume unavailable history.

### Phase 0 — Reconcile product scope and evidence question

**Work:** Product owner reconciles the legacy product definition's backtesting exclusion/Coinbase wording with the later Kraken simulation roadmap and current implementation. Specify intended analysis questions, acceptable cost, local disk/network constraints and whether historical data import is in scope.

**Acceptance:** Written product decision identifies the authoritative scope/source direction; `doc/**` remains unchanged until separately authorized. Record unresolved constraints rather than silently treating this implementation plan as authorization.

### Phase 1 — Historical-source feasibility and rights gate

**Work:** Assess Kraken historical time-and-sales CSV for BTC-EUR specifically: pair coverage, available dates, file shape/precision, time zone, duplicates/corrections, gaps, download size, refresh/update policy, usage/redistribution terms, retention and any account/access requirements. Compare with the bounded REST OHLC endpoint and the locally measured dataset. No source is selected solely because a support page describes downloadable data.

**Acceptance:** Evidence-backed source decision, coverage sample and terms/rights review recorded; acquisition method/limits and checksum plan defined; local 365-day continuity and BTC-EUR availability either demonstrated or explicitly unknown. If absent/unacceptable, stop and return a source/options decision—do not invent history or silently switch providers.

### Phase 2 — Dataset contract and deterministic import design

**Work:** Specify raw artifact manifest, normalized records, UTC boundary and closed-candle rules, gap/duplicate handling, provenance identity, validation, restart/rollback behavior and read-only coverage reporting. Prototype validation against checked-in synthetic fixtures; defer actual download until separately approved.

**Acceptance:** Contract tests reject malformed, duplicate or out-of-order inputs per policy, detect gaps and incomplete ranges, preserve source-vs-derived distinction, and produce stable identities. Import can fail without publishing a partial dataset as complete. Resource bounds and recovery procedure are documented.

### Phase 3 — Local history integration and coverage evidence

**Work:** After source, rights and remote-operation approval, implement a bounded acquisition/import path in existing TS server architecture unless a benchmark decision gate passes. Keep raw files/checksums and derived data traceable; make coverage measurement read-only and timestamped. Test restart, duplicate rerun, partial download, corrupt artifact and gap cases offline.

**Acceptance:** A measured BTC-EUR dataset report gives source/as-of, UTC start/end, count, interval, gaps, duplicates, age and validation state without disclosing private local paths. No coverage claim exceeds validated inputs; no real order capability exists. Demonstrate locally whether the 365-day goal is met; otherwise report exact shortfall and next evidence needed.

### Phase 4 — Simulator parity and evidence hardening

**Work:** Preserve TS implementation as baseline. Make replay deterministic and immutable; verify closed-bar timing, common candidate eligibility, baselines, fees, archived replay, report provenance and lookahead tests. Add walk-forward/held-out evidence only when input coverage can support declared splits; do not relax thresholds to manufacture a result.

**Acceptance:** Frozen fixture replays produce identical trades, timestamps and report identity. All active candidates and baselines use comparable windows; costs and source versions are attached. Adversarial tests rule out known future-data leakage and historical-run repricing. Explicitly mark underpowered cases insufficient.

### Phase 5 — SIM-EVID-03 accessible evidence presentation (outstanding)

**Work:** Lead with result status and plain-language interpretation, then disclose dataset source/coverage/freshness, cost assumptions, baseline comparison, validation split, trade count, uncertainty and limitations. Use progressive disclosure without concealing warnings. Preserve historical unknowns.

**Acceptance:** Semantic and keyboard-usable UI, visible focus, narrow viewport review, and actual-browser checks for loading, empty, error, stale, gaps and insufficient states. Component tests alone do not complete browser verification. User can distinguish market observations from OHLC and modeled outcomes from actual performance.

### Phase 6 — SIM-EVID-04 distinct strategy families (outstanding)

**Work:** Add only independently specified and meaningfully distinct hypotheses, one at a time. Define formulas, parameters/version, warm-up, closed-bar timing, readiness, exits and cost behavior before registration. Candidate examples in the ODD task (validated Supertrend, hourly control, dynamic PSAR exits) are examples, not a commitment. Independently verify indicator behavior; do not copy GPL code.

**Acceptance:** Each strategy has formula-level unit tests, warm-up/gap/exit fixtures, deterministic replay and comparative results on common windows. Register no unvalidated indicator/strategy. Insufficient evidence stays visible; do not label viability based only on positive P&L or strategy count.

### Phase 7 — Incremental Python parity, then measured engine/storage benchmark and decision

**Work:** Start with isolated, inert Python ledger parity against the existing TS behavior using checked-in deterministic fixtures. Keep later FastReplay/PaperForward semantics and any production opt-in as separately tracked units. Once representative parity fixtures exist, benchmark TS against Python (and only if useful an isolated Freqtrade reference). Freeze identical local data, strategy semantics, fee/slippage, starting capital, signal/execution rules and output scope. Compare trade logs before aggregate performance. Record machine/runtime/dependency versions, wall time, peak memory and setup/maintenance cost. No remote benchmark data or production dependency adoption is authorized by this step.

**Acceptance:** Explain any behavioral mismatches; parity must be established or deviations understood before speed comparisons count. Publish repeatable commands and raw results; choose “retain TS” unless a measured user-relevant benefit offsets integration, operational, licensing and maintenance cost. No arbitrary speed threshold; define one from the actual workload and user need before running the benchmark.

### Phase 8 — Storage optimization decision (conditional)

**Work:** Profile the actual validated workload. Consider columnar Parquet plus DuckDB for efficient local analytical scans, or Polars lazy execution for query optimization/streaming, only if current SQLite/TypeScript approach misses measured latency, memory, storage or workflow needs. Consider Rust only if profiling identifies a CPU-bound kernel whose interop/build burden is justified. Avoid adopting multiple engines at once.

**Acceptance:** Re-run equivalent correctness/parity and resource measurements on the same frozen dataset. Retain current storage/engine if there is no demonstrated problem. Any migration has explicit compatibility, provenance, backup, rollback and historical-report behavior; no old outputs are rewritten.

## Framework and storage decision table

| Candidate                                      | Role in this plan                          | Benefits to test                                                                                                                                                  | Costs/risks and decision gate                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing TypeScript simulator + Fastify/SQLite | Production baseline; continue.             | One primary language/runtime, existing contracts and tests, local persistence and UI already integrated.                                                          | May have throughput or large-history scan limits; profile before extending or replacing.                                                                                                                      |
| Freqtrade                                      | Isolated reference/benchmark, not adopted. | Documented backtesting, data download/import, per-side fee setting, strategy listing and lookahead analysis. Useful checklist/reference for validation workflows. | Python/runtime and data semantics differ; parity and local BTC-EUR source suitability are not established. Benchmark identical frozen data/trade logs first. No adoption based on feature count.              |
| Backtrader                                     | Not selected.                              | Potential reference for event-driven strategy simulation.                                                                                                         | No demonstrated advantage in this product's data, integration or workload. Do not add another framework absent a concrete parity/performance question.                                                        |
| VectorBT                                       | Not selected.                              | Potential vectorized research and batch comparison reference.                                                                                                     | Different execution/portfolio semantics may complicate trade-level parity. Require a specific benchmark and explicit semantic mapping before reconsidering.                                                   |
| LEAN                                           | Not selected.                              | Potential broader research engine and market-data workflow reference.                                                                                             | Added platform/integration scope is not justified by a measured Balancita requirement. No unsupported licensing conclusion is made here; verify applicable license and deployment terms if ever reconsidered. |
| Polars lazy                                    | Optional benchmark/optimization.           | Lazy query plans can optimize and stream supported operations; useful if measured transformation workload benefits.                                               | New runtime/library and data conversion; not a source of historical data and not inherently required for current scale. Add only against a measured bottleneck.                                               |
| DuckDB + Parquet                               | Optional analytical storage/query path.    | Columnar files and analytical scans may suit large immutable history and ad hoc analysis.                                                                         | New format/engine, lifecycle and provenance integration; more complexity than SQLite if workloads remain small. Benchmark representative queries and storage.                                                 |
| Rust                                           | Conditional kernel optimization only.      | Potential for a measured CPU-bound hot path and explicit low-level control.                                                                                       | Cross-language build, binding, testing and maintenance burden; no evidence currently establishes it as needed. Benchmark a focused kernel only after profiling.                                               |

## Go/no-go rules for Freqtrade or Python

**Start the bounded inert parity migration** is authorized now; this is not production adoption. **Go to a comparative benchmark** only when all are true:

- The product/source/rights gate is resolved and a frozen, local BTC-EUR dataset is available; no remote data acquisition is bundled into the benchmark.
- The question is stated in advance (e.g. correctness cross-check or measured throughput bottleneck), with representative size and success metric agreed before results.
- A mapping document defines bar boundaries, closed-candle timing, warm-up, order execution, fees per side, slippage, starting capital and output semantics.
- Identical inputs are runnable on both implementations and trade logs can be compared by timestamp, side, size, price and costs.

**No-go / retain current TS path** if parity cannot be interpreted, source terms/coverage are unresolved, a comparison needs a different dataset, or no concrete bottleneck/use case exists. A faster result with different trades is not evidence of a better implementation. If benchmark parity is incomplete, record the differences and stop short of an adoption conclusion.

Benchmark report must include repeat count and variance, wall time, peak memory, output/log parity, setup and data conversion overhead, operational packaging, dependency/licensing review, and future maintenance ownership. Freqtrade's documentation is evidence of capabilities, not proof that it supports Balancita's exact BTC-EUR history, matches its simulator semantics, or should become a production dependency.

## Risks, controls and stop conditions

- **History unavailable or rights unclear:** stop acquisition; report what is verified and what requires a source decision. Do not scrape, redistribute, or infer permission.
- **Endpoint cap mistaken for pagination:** REST result is recent and bounded; repeated `since` requests must not be assumed to recover older candles. Validate endpoint behavior and use an approved alternate source if appropriate.
- **Gaps or changed historical files:** retain original artifact identity/checksum, detect revisions, and version derived datasets. Never silently rewrite prior run inputs.
- **Lookahead, survivorship or selection bias:** closed-bar causal tests, time-ordered partitions, common candidate eligibility, all-active registration and immutable report identity are release gates.
- **Cost drift:** new rates require a policy version; old runs stay under original/unknown provenance, not repriced.
- **False confidence from sample size:** 365 days/300 closed trades are not guaranteed by source coverage or candidate behavior; insufficient is a valid outcome.
- **Storage/engine sprawl:** no format, language or framework change without parity and measured need. Avoid parallel production paths.
- **Scope conflict:** reconcile `doc/personal-trading-app.md` with later roadmap before claiming accepted product scope; this plan is not an amendment.
- **Safety boundary:** simulations stay hypothetical. Private exchange order APIs and real-money operations remain out of scope.

## References

### Local governing/project evidence

- [Product definition and source-of-truth](../doc/personal-trading-app.md) — includes legacy scope/source language that conflicts with later simulation direction; reconcile rather than silently override.
- [Implementation progress](../docs/implementation-progress.md) — dated evidence snapshot, current open SIM-EVID-03/04, and architecture/safety boundaries.
- [Bitcoin market intelligence roadmap](../docs/bitcoin-market-intelligence-roadmap.md) — current React/Vite, Fastify/TypeScript and SQLite description and product intent.
- [Simulation evidence/usability ODD task](../odd/tasks/simulation-evidence-usability.md) — detailed SIM-EVID acceptance criteria, current recorded tests and checkpoint evidence.

### Official/external technical references (supplied and verified for this comparison)

- Kraken REST [Get OHLC Data](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/) — 720 most recent entries cap; does not establish that REST can backfill arbitrary history through `since`.
- Kraken Support [Downloadable historical market data (time and sales)](https://support.kraken.com/hc/en-us/articles/360047543791-Downloadable-historical-market-data-time-and-sales-) — source feasibility, BTC-EUR coverage and terms remain to validate.
- Freqtrade [Backtesting](https://docs.freqtrade.io/en/stable/backtesting/) — reference workflow and explicit fee configuration.
- Freqtrade [Data download](https://docs.freqtrade.io/en/stable/data-download/) — historical import/download capability; not proof of a specific pair's availability or licensing suitability.
- Freqtrade [Lookahead analysis](https://docs.freqtrade.io/en/stable/lookahead-analysis/) — useful leakage-analysis reference, not a substitute for Balancita's own tests.
- Polars [Lazy API](https://docs.pola.rs/user-guide/concepts/lazy-api/) — optional query-planning/streaming reference.
- DuckDB [Parquet overview](https://duckdb.org/docs/current/data/parquet/overview.html) — optional local analytical storage/query reference.

## Implementation handoff checklist

### Incremental migration status (2026-09-28)

The decision above authorizes isolated Python ledger work, now extended by the user's bounded approval to LONG/FLAT plus a synthetic 1x SHORT ledger. This does not authorize production wiring, Binance Futures claims, or switching the default. The exact scope, assumptions, TDD evidence, and limitations are tracked in [`odd/tasks/python-simulation-engine.md`](../odd/tasks/python-simulation-engine.md) under PY-SIM-01. The task remains unchecked until review/commit evidence is supplied. Python's superiority remains unproven; FastReplay/PaperForward semantics, funding/margin/liquidation modeling, representative benchmarking, any opt-in boundary, and any default decision remain separate follow-ups.

- [ ] Product owner reconciles the product-definition conflict before production integration/default migration; current explicit authorization is limited to incremental, inert parity work.
- [ ] BTC-EUR source coverage, rights, quota/cost, continuity and data lifecycle are verified before integration.
- [ ] Dataset/time/cost/version contracts and immutable replay behavior are reviewed before implementation.
- [ ] Exact current active strategy manifest is verified; all active candidates, including losers, remain in common-window comparisons.
- [ ] SIM-EVID-03 browser accessibility and SIM-EVID-04 distinct strategy work remain tracked as pending until their own evidence is complete.
- [ ] Tests cover UTC closed candles, gaps, cost parity, historical provenance, common eligibility, holdout and lookahead/adversarial cases.
- [ ] Any engine/storage benchmark uses identical frozen local data and interpretable trade-log parity; production remains TypeScript-default until a separate evidence-backed decision.
- [ ] User-facing claims remain bounded by actual measured coverage, freshness and adequacy; no real-order path is added.
