---
name: bitcoin-market-intelligence
description: 'Trigger: Bitcoin/BTC-EUR quotes, low-latency market data, realtime or trustworthy news, technical analysis/trends, probabilistic forecasts, forecast history/backtesting/evaluation. Govern BTC-EUR intelligence work with evidence, freshness, and no-order rules.'
license: Apache-2.0
metadata:
  author: franco-sevillano
  version: '1.0'
---

# Bitcoin Market Intelligence

## Activation Contract

Load this skill for: BTC-EUR quotes or low-latency market data; realtime or
trustworthy news requests; technical analysis or trend requests; probabilistic
price forecasts; forecast history, backtesting, or evaluation.

## Hard Rules

- BTC-EUR is the only pair for the first intelligence pipeline; reject or scope
  down requests for other pairs until BTC-EUR is covered.
- Read `doc/personal-trading-app.md`, `docs/implementation-progress.md`, and
  `docs/bitcoin-market-intelligence-roadmap.md` before proposing runtime work.
- Define event time, received time, and freshness as measurable fields; never
  claim "real time" without logged evidence for the specific data point.
- Before any external market-data or news integration, check official provider
  docs plus license, quota, and cost terms.
- News requires provenance: source, URL, publication time, ingestion time, and
  license status. Reject news claims without these fields.
- Forecasts are immutable once recorded and must be evaluated without
  look-ahead bias.
- Require a deterministic baseline analysis before any AI-assisted forecast.
- Gemini-based analysis stays manual/opt-in unless separately authorized.
- Analysis never places, modifies, or authorizes trading orders.
- Any implementation follows strict TDD and existing repository gates.
- Never edit files under `doc/**`.
- This skill governs agent workflow only; it is distinct from the runtime
  application orchestrator (`src/domain/**`, `server/**`).

## Decision Gates

| Situation                   | Action                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Research vs. implementation | Read-only exploration first; implement only with explicit authorization and TDD evidence. |
| Quote/market-data path      | Confirm BTC-EUR scope, measurable freshness, and provider terms before any change.        |
| News path                   | Require full provenance fields; reject unsourced or unlicensed claims.                    |
| Forecast/backtest path      | Require deterministic baseline, immutability, and no-look-ahead evaluation.               |
| Ambiguous requirement       | Ask exactly one product question and stop until answered.                                 |

## Execution Steps

1. Read the three governing docs above; the roadmap may not exist yet during
   BI-1 and is a forward local reference.
2. Classify the request as quote, news, technical-analysis, forecast, or
   backtest/evaluation.
3. Apply the matching Hard Rules and Decision Gate.
4. If implementation is authorized, follow TDD and existing checks; otherwise
   stay read-only and report findings.
5. Never touch `doc/**`; keep runtime and agent-workflow concerns separate.

## Output Contract

Report: evidence used (files/sources), assumptions made, the freshness
definition applied, checks run (tests, structural, Prettier), and the next
step.

## References

- [doc/personal-trading-app.md](../../../doc/personal-trading-app.md)
- [docs/implementation-progress.md](../../../docs/implementation-progress.md)
- [docs/bitcoin-market-intelligence-roadmap.md](../../../docs/bitcoin-market-intelligence-roadmap.md)
- [odd/tasks/bitcoin-intelligence-skill.md](../../../odd/tasks/bitcoin-intelligence-skill.md)
