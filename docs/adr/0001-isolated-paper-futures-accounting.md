# ADR 0001: Isolated paper-futures accounting

**Status:** Accepted for the authorized paper-futures increment.

## Decision

Add a separate linear BTC/USD perpetual paper laboratory. This scope overrides the older BTC-EUR-only and long/flat-only agent guidance only for this isolated feature. It does not authorize real orders, private Kraken access, credentials, model downloads, live UI wiring, or changes to spot behavior, historic results, or C25-C28.

Node/TypeScript is the sole SQLite writer and authoritative canonical-hash verifier. Python uses `Decimal` for financial calculation and communicates serializable decimal strings; no JavaScript `Number` participates in futures accounting. Durable acceptance and application are separate transaction boundaries: a command ACK follows its accepted-command plus acceptance-outbox commit; a worker's `committed` ACK follows the atomic applied-result/effects transaction.

## Accounting contract

The laboratory uses BTC quantity, USD/BTC prices, and USD settlement. USD cash is not spent on futures nominal. Equity is cash plus marked unrealized P&L; reserved margin is position notional divided by configured leverage, capped at 1x for this laboratory, and available margin is equity less reserved margin. Gross realized P&L is side-aware. Entry/exit fees use frozen cost identity `kraken-futures-eea-btcusd-base.v1` (maker `0.0002`, taker `0.0005`); these are laboratory assumptions, not account-tier or exchange-rounding guarantees. Funding uses observed absolute USD/BTC/hour rates, elapsed known intervals, and position quantity. Positive rates charge longs and credit shorts; negative rates reverse direction. Unknown rates or intervals keep complete net P&L null.

Partial close allocations are proportional, with exact residual assigned to the final close. Arithmetic uses an explicit high-precision local Decimal context; serialization uses normalized plain decimal strings. Display rounding is separate. Inputs reject floats, NaN/Infinity, negative quantities/prices, impossible reductions, look-ahead rates, and `live` mode.

## Identity and persistence

Canonical JSON is UTF-8, recursively key-sorted, array-order preserving, and encodes typed decimals as normalized plain strings (`-0` becomes `0`) and timestamps as UTC integer milliseconds. Arbitrary text strings are not decimal-normalized. Unsupported values, undefined, non-finite numbers, and unsafe integers are rejected. Node recomputes authoritative SHA-256 hashes. Hash chains are tamper-evident, not physically immutable against an owner controlling SQLite.

The futures store is namespaced and additive; it does not change the legacy market-store migration version or historical rows. Frozen run/work identity, results, financial events, projections, checkpoints, and outbox application are committed atomically. Stale work has no effects; exact retries return the stored receipt without duplicate accounting; conflicting identity reuse rejects. Records are append-only guarded, while projections are reconstructible. Tests use disposable databases exclusively.

## Scope boundary

FK-01 delivers offline accounting, canonical identity, and durable storage only. Feed ingestion, worker lifecycle, strategy/risk/execution, UI, and any real exchange adapter are separate deferred work. This ledger does not claim Kraken rounding parity or connect to application startup.
