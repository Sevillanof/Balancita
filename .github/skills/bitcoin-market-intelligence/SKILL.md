---
name: bitcoin-market-intelligence
description: 'Trigger: Kraken Futures PF_* market data, realtime news, technical analysis, forecasts, backtesting. Govern market intelligence with evidence and no-order rules.'
license: Apache-2.0
metadata:
  author: franco-sevillano
  version: '2.0'
---

# Bitcoin Market Intelligence

## Activation Contract

Load this skill for: Kraken Futures (`PF_*`) quotes or low-latency market data;
realtime or trustworthy news requests; technical analysis or trend requests; probabilistic
price forecasts; forecast history, backtesting, or evaluation.

## Hard Rules

- Scope is the 8 products in `config/futures-products.json` (Kraken Futures
  perpetuals, paper only). Spot BTC-EUR is abandoned; reject requests that
  revive it and do not edit `docs/archive/`.
- Read `README.md` and `docs/adr/0001-isolated-paper-futures-accounting.md`
  (including the 2026-10-11 amendment) before proposing runtime work.
- Define event time, received time, and freshness as measurable fields; never
  claim "real time" without logged evidence for the specific data point.
- Before any external market-data or news integration, check official provider
  docs plus license, quota, and cost terms.
- News requires provenance: source, URL, publication time, ingestion time, and
  license status. Reject news claims without these fields.
- Forecasts are immutable once recorded and must be evaluated without
  look-ahead bias.
- Require a deterministic baseline analysis before any AI-assisted forecast.
- Gemini and any paid external LLM stay off unless separately authorized; the
  local Qwen/Kronos may be used only as the ADR amendment describes.
- Analysis never places, modifies, or authorizes trading orders.
- Any implementation follows strict TDD and existing repository gates.
- Never edit the ADR except to add an amendment the user requests directly.
- This skill governs agent workflow only; it is distinct from the runtime
  application orchestrator (`src/domain/**`, `server/**`).

## Decision Gates

| Situation                   | Action                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Research vs. implementation | Read-only exploration first; implement only with explicit authorization and TDD evidence. |
| Quote/market-data path      | Confirm product scope, measurable freshness, and provider terms before any change.        |
| News path                   | Require full provenance fields; reject unsourced or unlicensed claims.                    |
| Forecast/backtest path      | Require deterministic baseline, immutability, and no-look-ahead evaluation.               |
| Ambiguous requirement       | Ask exactly one product question and stop until answered.                                 |

## Execution Steps

1. Read the governing docs above.
2. Classify the request as quote, news, technical-analysis, forecast, or
   backtest/evaluation.
3. Apply the matching Hard Rules and Decision Gate.
4. If implementation is authorized, follow TDD and existing checks; otherwise
   stay read-only and report findings.
5. Keep runtime and agent-workflow concerns separate.

## Output Contract

Report: evidence used (files/sources), assumptions made, the freshness
definition applied, checks run (tests, structural, Prettier), and the next
step.

## References

- [README.md](../../../README.md)
- [docs/adr/0001-isolated-paper-futures-accounting.md](../../../docs/adr/0001-isolated-paper-futures-accounting.md)
- [docs/strategy-reliability.md](../../../docs/strategy-reliability.md)
- [docs/archive/](../../../docs/archive/README.md) (historial spot BTC-EUR, solo lectura)
