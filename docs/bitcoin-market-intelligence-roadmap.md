# Balancita: Product, Architecture, and Goals

Balancita is a local-first personal workspace for observing BTC-EUR, reviewing
market evidence, and practicing decisions with simulated trades. Its purpose is
to make data sources, uncertainty, and assumptions visible—not to promise
returns. The product definition is [`doc/personal-trading-app.md`](../doc/personal-trading-app.md);
this guide explains the implemented application and its direction without
replacing that source.

## What Balancita is for

Balancita helps one person:

- observe BTC-EUR market data and inspect its source and status;
- understand a local simulated account and review hypothetical orders;
- compare strategy simulations against simple baselines using explicit costs;
- study deterministic technical and news evidence without treating it as
  certainty or financial advice.

The simulator is not a broker. Its simulated buy/sell controls and paper ledger
do not place real orders, move money, or connect to a private Kraken order API.
Analysis does not authorize orders. No profitable or predictive strategy is
established by the existence of a simulator.

## How the application is built

| Part              | Technology and responsibility                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser UI        | React, TypeScript, and Vite. The BTC-EUR dashboard presents market, strategy, paper-trading, and simulation views.                                      |
| Server            | Fastify on Node.js with TypeScript. It owns server API routes, collectors, and intelligence workflows.                                                  |
| Durable evidence  | Local SQLite stores market/intelligence records and simulation-related server data. Browser portfolio/simulator state also has local persistence.       |
| Market sources    | Kraken public market-data paths include trade observations and REST OHLC candles. They are distinct datasets with different meanings and coverage.      |
| Optional analysis | Deterministic local rules are the baseline. Gemini is an optional server-mediated capability; it is not required to simulate and does not place orders. |

The browser and server are separate runtime processes during development. The
root development script starts Vite and the Node server together. The market
provider defaults to Kraken when `VITE_MARKET_DATA_PROVIDER` is absent; `mock`
selects deterministic offline data. A quote or an old measurement must not be
called fresh without a timestamped observation that supports the claim.

## Data and simulation, in plain language

- **Market observations** are individual market events captured by a collector.
  They are not one-minute OHLC bars.
- **REST OHLC** records open, high, low, and close values for time buckets. The
  current collector is bounded; a successful request does not imply a year of
  history.
- **Simulations** use historical inputs and modeled execution costs to estimate
  hypothetical outcomes. They are not actual account fills or proof of future
  returns.
- **Fee scenario**: the current strategy comparison uses a modeled Kraken Pro
  Spot Tier 1 taker commission of 0.80% per side plus separate 0.05% slippage.
  The user's actual account tier and fees are unknown. Historical reports without
  fee provenance remain unknown rather than being silently repriced.
- **Evaluation** must preserve time order, use only evidence available at the
  evaluation cutoff, disclose sample size, and include simple baselines. An
  insufficient sample is not evidence of viability.

For the dated local coverage snapshot and open evidence tasks, see
[`implementation-progress.md`](implementation-progress.md). That measurement is
historical evidence, not a live status report.

## Product direction

The goal is a clear, auditable BTC-EUR workspace where users can see what the
application knows, what it does not know, and how a hypothetical strategy was
evaluated. Improvements should strengthen source provenance, freshness and
coverage disclosure, accessible novice-facing explanations, and fair
comparisons. Keep the working React/Vite and Fastify/TypeScript architecture;
an old FastAPI/Rust rewrite proposal is not an accepted plan.

The next explicitly tracked work is SIM-EVID-03 (accessible presentation) and
SIM-EVID-04 (distinct, evidence-gated strategy families), recorded in
[`odd/tasks/simulation-evidence-usability.md`](../odd/tasks/simulation-evidence-usability.md).
Other ideas—including broader historical backfill/replay—need separate scoping
and authorization before they become work.

## Run locally

The following commands are present in the root `package.json`:

```bash
pnpm dev
pnpm test
pnpm test:server
pnpm run typecheck
pnpm run build
```

`pnpm dev` starts the Vite UI and local Fastify server. It does not turn the
paper ledger into a real account or place orders. Tests use local deterministic
fixtures; they are not a live-market freshness check. `pnpm run build` builds the
frontend and type-checks it; server typechecking is separately available as
`pnpm run typecheck:server`.

## Safety boundaries

- No real orders, deposits, withdrawals, custody, or broker execution.
- No claim of profitability, predictive power, current freshness, verified
  account fees, or sufficient data unless supported by explicit measured
  evidence.
- Keep market event time, local receive time, and display/measurement time
  distinct; do not merge trade observations with OHLC candles.
- Treat news as evidence only when source, URL, publication/ingestion timing,
  and licensing/provenance are available. Optional AI does not replace the
  deterministic baseline or provenance checks.
- `doc/**` is the immutable product source and must not be edited by tooling.
