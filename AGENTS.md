# AGENTS.md

Project skills under `.github/skills/` are repo-local and take precedence over
generic guidance for matching triggers.

## Project skills

- **bitcoin-market-intelligence** — Trigger: BTC-EUR quotes, low-latency
  market data, realtime/trustworthy news, technical analysis, probabilistic
  forecasts, forecast history/backtesting/evaluation.
  Path: [.github/skills/bitcoin-market-intelligence/SKILL.md](.github/skills/bitcoin-market-intelligence/SKILL.md)

For the explicitly authorized, isolated Kraken BTC/USD perpetual paper-futures
feature only, `docs/adr/0001-isolated-paper-futures-accounting.md` overrides
that skill's BTC-EUR-only and long/flat-only scope. It does not authorize real
orders, private endpoints, credentials, or changes to spot/history/C25-C28.
