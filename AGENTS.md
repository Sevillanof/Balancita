# AGENTS.md

Project skills under `.github/skills/` are repo-local and take precedence over
generic guidance for matching triggers.

## Project skills

- **bitcoin-market-intelligence** — Trigger: Kraken Futures (`PF_*`) market
  data, realtime/trustworthy news, technical analysis, probabilistic forecasts,
  forecast history/backtesting/evaluation.
  Path: [.github/skills/bitcoin-market-intelligence/SKILL.md](.github/skills/bitcoin-market-intelligence/SKILL.md)

## Scope

Balancita is futures-only paper trading on the 8 public Kraken `PF_*`
perpetuals. Spot BTC-EUR is abandoned; its docs and plans live in
`docs/archive/`. `docs/adr/0001-isolated-paper-futures-accounting.md` (with its
2026-10-06 and 2026-10-11 amendments) is the governing decision record: long
and short, 100 USD fixed per trade, one cost model per product, Qwen and Kronos
allowed as described in the 2026-10-11 amendment. It does not authorize real
orders, private endpoints or credentials. C25-C31 and Kronos are not modified
until they reach 100 forward trades. The ADR is immutable and read-only:
consult it, never edit it, unless the user directly requests an amendment.
