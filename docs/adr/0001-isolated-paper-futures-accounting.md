# ADR 0001: Isolated paper-futures accounting

**Status:** Accepted for the authorized paper-futures increment. Amended 2026-10-06 (see Amendment 2026-10-06). Immutable after that amendment: further changes need an explicit, user-authorized amendment, and `scripts/adr-immutable.node-test.mjs` pins this file's SHA-256.

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

## Amendment 2026-10-06: process split and extended research scope

Authorized explicitly by the user. Evidence: [odd/tasks/futures-process-split.md](../../odd/tasks/futures-process-split.md) and the studies in [odd/research/](../../odd/research/). Where this amendment conflicts with the text above (BTC/USD-only instrument, no changes to C25-C28, Node as sole writer, FK-01 scope boundary), this amendment prevails.

### Scope

The laboratory stays paper only. No real orders, no private Kraken endpoints, no credentials. Only public Kraken Futures data is used. Funding is never inferred: unknown rates keep complete net P&L null.

### Instruments

The BTC/USD perpetual is extended to other Kraken Futures public perpetuals (`PF_*`), selected by liquidity, for research, forecasting and paper execution. Multi-asset studies, such as cross-sectional momentum, are allowed.

### Strategies

C25-C28 may be analysed and improved. An improvement may modify C25-C28 or ship as a new id (C29+); the choice is recorded per change in the task file. Long and short are both allowed. Abstaining (flat) is a first-class decision, not a failure to decide.

### Architecture

Each process is the single writer of its own SQLite database; others open it read-only and tail append-only tables by rowid cursor. This supersedes "Node/TypeScript is the sole SQLite writer".

- A, capture: writes the market DB, with official Kraken candles as the canonical series and observed candles kept only for the low-latency chart and as a quality check. The order book is not persisted.
- B, gateway: read-only; serves HTTP and browser WebSocket.
- C, verdict service (Python): pure, replayable function over official candles; writes long, short or abstain verdicts on candle close to its own DB.
- D, paper execution (Python): consumes fresh verdicts; fills at the ticker top of book as taker, capped by the displayed bid/ask size; hash-chained append-only account DB.
- E, forecast scorer: scores stored predictions and decisions against realized outcomes; writes its own DB.

Determinism and replay equality are an invariant: a live run equals a replay of the same stored inputs. Market data capture is never dropped or lossily batched.

### Evaluation

Every prediction and decision is scored against realized outcomes, net of costs, and compared with buy and hold and with an inverse control. A result counts only when it is out of sample (walk-forward), corrected for the number of trials (deflated Sharpe) and backed by a minimum trade count. In-sample or uncorrected results do not justify promotion.

### Use of LLMs

LLMs are not a deciding component: they are non-deterministic, not replayable, and their training data leaks history. They may convert unstructured information (such as news) into stored, timestamped features that deterministic components then consume.

### Costs

Fees follow the Kraken Futures base schedule: taker `0.0005` and maker `0.0002` (cost identity `kraken-futures-eea-btcusd-base.v1` unless a new frozen identity is recorded). These remain laboratory assumptions.

### Retired

The legacy single-process engine (PS-05d) is retired. Code kept only for the protected `futures-runtime.test.ts` is marked as having no production caller and must not gain one.
