# Remaining Work and Evidence

This is the current, evidence-qualified list of work still open in Balancita. It
separates implemented behavior from runtime checks, evidence limits, and future
decisions. It is not a claim that the simulator is profitable or that market data
are fresh now. The product definition remains the read-only
[`doc/personal-trading-app.md`](../doc/personal-trading-app.md).

## Current state at a glance

| Area                | Established                                                                                                                                                                 | Still open                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Product and runtime | React/Vite TypeScript UI, Fastify TypeScript server, local SQLite market/intelligence store, Kraken BTC-EUR market sources, dashboard and strategy/simulation views         | Browser-level responsive and interaction review is not established by component tests                           |
| Simulation evidence | SIM-EVID-01 coverage/source distinctions and SIM-EVID-02 baselines, all-active comparisons, modeled costs and Fast Replay/PaperForward fee parity have implementation tests | SIM-EVID-03 novice-facing accessible presentation and SIM-EVID-04 distinct strategy families remain pending     |
| Dataset adequacy    | A dated local snapshot was measured; see below                                                                                                                              | No demonstrated 365-day OHLC history or 300 closed trades; no current freshness claim                           |
| Documentation       | Six legacy plans were consolidated into these two maintained documents; four legacy files were removed                                                                      | To verify publication, inspect Git history for changes to these paths; this document does not track push status |

## Next work

### 1. SIM-EVID-03 — Accessible novice evidence presentation

Pending in [`odd/tasks/simulation-evidence-usability.md`](../odd/tasks/simulation-evidence-usability.md).
Lead with the simulation result and progressively disclose source, coverage,
assumptions, costs, baselines, uncertainty, and insufficiency. Preserve visible
warnings and source attribution. Verify keyboard interaction, focus, narrow
viewports, and loading/empty/error/stale/insufficient states in an actual browser;
jsdom/component tests alone do not satisfy the runtime check.

### 2. SIM-EVID-04 — Distinct, evidence-gated strategy families

Pending in the same ODD task. Specify and validate each strategy and its
indicator/exit behavior independently before registering it. Show warm-up,
readiness, versions, costs, sample size, and comparative evidence. No strategy
gets a “viable” label without the declared evidence; do not reuse GPL code.

### 3. Establish adequate empirical evidence

The last recorded measurement is a local SQLite snapshot measured at
**2026-09-26 15:00:55 UTC**. It contained **3,766 contiguous Kraken REST OHLC
1-minute bars** from **2026-09-24 00:14Z** through **2026-09-26 14:59Z** (latest
bar 115 seconds old at measurement), and **42,471 Kraken market-observation
rows** with event times through **2026-09-24 14:05:56Z** (latest observation
176,099 seconds old at measurement). These are different evidence sources and
one historical snapshot, not current coverage or freshness. Neither establishes
365 days of OHLC history or 300 closed trades. Re-measure through approved
read-only paths before drawing adequacy conclusions; do not expose local database
paths or contents.

### 4. Keep cost assumptions honest

The simulation's Kraken Pro Spot Tier 1 taker fee (0.80% per side) plus 0.05%
slippage is a versioned model scenario, not the user's verified account tier,
actual fee, or actual fill cost. The account-specific fee remains unknown. Keep
historical reports without fee provenance labeled unknown; do not silently
reprice them.

### Documentation structure

The six former top-level planning documents were consolidated into this
remaining-work record and [`docs/bitcoin-market-intelligence-roadmap.md`](bitcoin-market-intelligence-roadmap.md),
with four superseded files removed. This is a description of the content
reorganization, not its publication status. Check Git history for these paths
to determine whether the documentation update has been published.

## Verification and review boundaries

- SIM-EVID-01 and SIM-EVID-02 implementation checklists are complete according
  to the recorded tests and independent functional verification. This does not
  establish empirical adequacy or profitability.
- Final focused implementation verification recorded in the ODD task:
  server simulation suite, 7 files / 84 tests passed; UI simulation panels,
  2 files / 19 tests passed; server and root typechecks passed; lint had zero
  errors and one existing warning in untouched `StrategyCards.tsx`; no live
  database/browser runtime adequacy check was performed.
- Native RDD status for the cited SIM-EVID work: assessment unclassifiable;
  `START` returned `pre_native` / `not_started`. There is no review receipt or
  native authority, and no PASS or approval is claimed.
- Engram mirror for `odd/simulation-evidence-usability/tasks` remains pending
  because session/project resolution was ambiguous. Do not fabricate a mirror.
- No real orders, broker access, real-money execution, or strategy-profitability
  claim is part of this work.

## Scope decisions

- The current product uses the existing React/Vite and Fastify/TypeScript stack.
  A FastAPI/Rust rewrite was an old proposal, not an accepted or scheduled task.
- Old screen-roadmap items are not automatically accepted work. The dashboard
  and its data surfaces exist; the remaining browser-level review is listed
  above rather than treating legacy wireframes as current requirements.
- Kraken trade observations and Kraken REST OHLC bars are distinct sources.
  Historical backfill/replay proposals in retired plans are not authorized by
  this status document; scope any such work separately.
- Product source `doc/**` remains read-only.

## Continue here

1. Read [`odd/tasks/simulation-evidence-usability.md`](../odd/tasks/simulation-evidence-usability.md)
   for stable task IDs, acceptance criteria, and implementation evidence.
2. Read [`docs/bitcoin-market-intelligence-roadmap.md`](bitcoin-market-intelligence-roadmap.md)
   for the product purpose and current architecture.
3. Obtain explicit authorization before implementation or external operations.
