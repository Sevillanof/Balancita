# AGENTS.md

Project skills under `.github/skills/` are repo-local and take precedence over
generic guidance for matching triggers.

## Project skills

- **bitcoin-market-intelligence** — Trigger: BTC-EUR quotes, low-latency
  market data, realtime/trustworthy news, technical analysis, probabilistic
  forecasts, forecast history/backtesting/evaluation.
  Path: [.github/skills/bitcoin-market-intelligence/SKILL.md](.github/skills/bitcoin-market-intelligence/SKILL.md)

For the explicitly authorized, isolated Kraken Futures paper-futures feature
(the BTC/USD perpetual and, per its 2026-10-06 amendment, other public `PF_*`
perpetuals), `docs/adr/0001-isolated-paper-futures-accounting.md` overrides
that skill's BTC-EUR-only and long/flat-only scope and authorizes analysing and
improving C25-C28. It does not authorize real orders, private endpoints,
credentials, or changes to spot/history. The ADR is immutable and read-only:
consult it, never edit it, unless the user directly requests an amendment.
