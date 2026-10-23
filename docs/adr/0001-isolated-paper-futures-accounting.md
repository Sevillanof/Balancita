# ADR 0001: Isolated paper-futures accounting

**Status:** Accepted for the authorized paper-futures increment. Amended 2026-10-06, 2026-10-11, 2026-10-12, 2026-10-16, 2026-10-18, 2026-10-19 and 2026-10-23 (see the amendments below). Immutable and read-only: it is consulted, never edited, except for an amendment the user requests directly.

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
- N, news: ingests public news, stores each item with its received time, and stores the LLM analysis of each item as timestamped features (for example a veto or confidence) in its own DB; C may consume these features, never the LLM directly.

Determinism and replay equality are an invariant: a live run equals a replay of the same stored inputs. Market data capture is never dropped or lossily batched.

### Evaluation

Every prediction and decision is scored against realized outcomes, net of costs, and compared with buy and hold and with an inverse control. A result counts only when it is out of sample (walk-forward), corrected for the number of trials (deflated Sharpe) and backed by a minimum trade count. In-sample or uncorrected results do not justify promotion.

### Use of LLMs

LLMs are not a deciding component: they are non-deterministic, not replayable, and their training data leaks history. They may convert unstructured information (such as news) into stored, timestamped features that deterministic components then consume.

### Costs

Fees follow the Kraken Futures base schedule: taker `0.0005` and maker `0.0002` (cost identity `kraken-futures-eea-btcusd-base.v1` unless a new frozen identity is recorded). These remain laboratory assumptions.

### Retired

The legacy single-process engine (PS-05d) is retired. Code kept only for the protected `futures-runtime.test.ts` is marked as having no production caller and must not gain one.

## Amendment 2026-10-11: current scope, Qwen/Kronos exception and focus

Requested directly by the user (Fran) on 2026-10-11. Where it conflicts with the text above, this amendment prevails. Everything remains paper only: no real orders, no private Kraken endpoints, no credentials.

### Supersedes

- "LLMs are not a deciding component" (Amendment 2026-10-06, Use of LLMs) is relaxed as set out under Qwen and Kronos below.
- "Costs": the single frozen identity `kraken-futures-eea-btcusd-base.v1` is replaced by one cost model per product (`python/balancita_engine/futures_costs.py`, version `kraken-futures-costs.v2`): Kraken Futures level-1 fees (maker `0.0002`, taker `0.0005`) plus a measured spread/impact table for each of the 8 pinned products. Paper execution, backtest, replay and scorers share it.
- "Instruments": the 8 products in `config/futures-products.json` are the set (`PF_XBTUSD`, `PF_ETHUSD`, `PF_SOLUSD`, `PF_ZECUSD`, `PF_XRPUSD`, `PF_NEARUSD`, `PF_HYPEUSD`, `PF_ADAUSD`). The legacy spot BTC-EUR product is abandoned; its code and plans are archived under `docs/archive/`.

### Sizing and books

Every strategy trades its own independent paper book, long or short, with a fixed 100 USD notional per trade (no compounding, no risk-based sizing). Funding is real and observed, never inferred.

### Qwen and Kronos (exception to "LLMs do not decide")

A local Qwen (llama-server, offline, constrained A/B/C answer with probabilities, no free-form reasoning) may decide in two places: (a) as an A/B arm in replays (`futures_replay_*`), and (b) as the exit decider of strategy C31 (entries from the C25/C26/C27/C30 consensus, Qwen decides hold/close; process `qwenexit`). Kronos-small (`python/kronos_lab`, 1h candles, 4 h horizon) runs as an isolated paper strategy. Rules: local weights only, no paid external LLM APIs; a decision on historical data proves nothing about skill, so only forward results count; a model never changes its own weights, it learns only through stored in-context lessons. Qwen's answer is always stored with its inputs so a run can be audited.

### Evidence status (2026-10-11)

No candle rule and no Qwen variant has shown net edge after costs (see `docs/strategy-reliability.md`, `docs/validacion-sin-trampas.md`, `odd/tasks/qwen-calibration.md`). Passive (maker) execution was simulated against the public trade tape and does not create edge; it is archived. C25-C28 are closed (gross edge about zero, they lose roughly the cost). C29, C30 and Kronos stay in paper until at least 100 forward trades, then are judged with the promotion rule in `config/forward-strategies.json`. C25-C31 and Kronos are not modified until then.

### Processes

Besides A, B, C, D, E and N of Amendment 2026-10-06 there are: S (strategy registry, port 8790), `forward` (forward paper book of C30), `qwenexit` (C31), `llm`/`q` (local Qwen decisions) and the isolated Kronos lab. `DEV_ONLY=name,name pnpm dev` runs only the named children (for example `vite,capture,live,forward,strategies`).

### Unchanged

Canonical hashing, Decimal accounting, append-only hash-chained books, replay equality, no look-ahead and the Evaluation rules (walk-forward, deflated Sharpe, minimum trade count) remain in force.

## Amendment 2026-10-11 (evening): one engine for every strategy

Requested directly by the user (Fran) on 2026-10-11 ("el ADR vigente hay que actualizarlo"; "si operan en el otro motor, borralos, todo va a estar en el nuevo motor"). Where it conflicts with the text above, including the amendment of the same day, this one prevails. Everything remains paper only.

### Supersedes

- Process D (paper execution, `futures_paper_execution`) is retired: `pnpm dev` no longer starts it. Its account database (`futures-paper-account.sqlite`) is kept as read-only history. The "one independent book per strategy and product in D" of Amendment 2026-10-06 is now provided by the forward measurement (`futures_forward`), which runs the shared simulator (`futures_simulator`, one cost model per product, 100 USD per trade, long or short) over the official candles.
- C25-C28 are deleted from the strategy registry at startup (`config/strategy-closed.json`, reason `closed_with_engine_d`); the history stays because the registry is append-only. Their specs remain in `config/strategies/` only because C31 uses them as entries.
- "Active" in the registry now means "trades in paper": every active strategy is measured forward from the moment it was activated (shipped ones nobody switched on, such as C29, from the first run that saw them; C30 keeps its start in `config/forward-strategies.json`). Switching a strategy off or deleting it stops new trades and keeps its trades. The front can activate, deactivate and delete any strategy (deleting asks for two confirmations and the id).
- Every new strategy runs in this engine. Qwen and Kronos are models, not rule strategies, and are kept apart (see the Qwen and Kronos section above).

### Unchanged

The verdict service (C) still computes the C25-C28 proposals because Qwen reads them as context. C29, C30, C31 and Kronos are not modified until 100 forward trades. Canonical hashing, Decimal accounting, append-only storage, replay equality, no look-ahead and the Evaluation rules remain in force.

## Amendment 2026-10-12: multi-strategy decisions with Qwen as opportunity selector

Requested directly by the user (Fran) on 2026-10-12 as PR 100 ("Arquitectura de decisiones multiestrategia con Qwen y control de riesgo"), with the explicit instruction that widening Qwen's role needs an explicit amendment, not a silent change. Where it conflicts with the text above, including the Qwen and Kronos section, this amendment prevails for the `multi_*` modules only. Everything remains paper only: no real orders, no private endpoints, no credentials.

### What Qwen may do now

In the multi-strategy experiment (`python/balancita_engine/multi_experiment.py`) the local Qwen may **select entries**: every 5 minutes, per product, it receives the signals of the rule strategies and answers one letter (BUY / WAIT / SELL, constrained grammar, no thinking, option order rotated, probabilities averaged, same client as before). That is a third place where it decides, besides the replay A/B arm and the exit decider of C31.

### Limits (enforced in code and tests)

1. Qwen cannot create a trade without a strategy signal behind the same side (`no_backing_signal` becomes WAIT).
2. It cannot change indicators, signals, protective levels or the fixed 100 USD notional.
3. It cannot execute or modify open positions: stops, targets and time stops belong to the paper executor and run with Qwen down.
4. Any failure, malformed answer or timeout is WAIT. Its answer is stored with its context, signals, versions, prompt hash and model.
5. Every selection goes through a deterministic risk engine that issues a single-use authorization; the executor opens positions only by redeeming one. Rejections store their reasons.

### Architecture

One signal contract (`balancita-signal.v1`, BUY/SELL/WAIT scores that are **not** calibrated probabilities, strength, horizon, evidence, strategy id and version, record and sample size); risk engine (`multi_risk`); executor on the shared simulator `Book`, with the single per-product cost model (`multi_executor`: no second engine); durable decision log with idempotent ids (`multi_store`); three independent arms over the same data, costs, notional, risk policy and exit rules: A strategies, B deterministic combiner, C Qwen. Every candidate is stored, rejected ones included, with a shadow outcome. The accounting is a pure function of candles and stored selections, so a stored run replays identically without asking Qwen.

### Unchanged

C25-C31 and Kronos are not modified until 100 forward trades; the three experimental strategies (`mx-funding-v1`, `mx-momentum-v1`, `mx-meanrev-v1`) have new ids, live outside the strategy registry and `config/strategies/`, and exist to exercise the path, not because they are believed to earn money. There is no minimum number of trades per day. Funding is never inferred: a trade without funding history keeps its complete net P&L null. Historical validation (walk-forward, CPCV, Holm, DSR, PBO) and any forward freezing are later increments with criteria fixed before looking at results; 100 forward trades do not by themselves prove an edge. If Qwen does not beat the deterministic combiner after costs, the combiner stays.

## Amendment 2026-10-16: provisional operation size of the simulated paper session

Authorized by the user (Fran) through BAL-DECISION-185-TEXTO-ADR-04 (issue #185, comment 6225435845), which approves the text below; Fran also asked for this amendment directly in the project chat on 2026-10-16. The functional change is BAL-DECISION-185-DIMENSIONAMIENTO-03 (comment 6223371484), where the user said the 100 USD per operation must not stay fixed permanently. Everything remains paper only: no real orders, no private endpoints, no credentials. This amendment is limited to the simulated paper session and removes nothing from the text above.

### Text approved

«Para la sesión de papel simulada, el tamaño de una operación es un nocional provisional de 100 USD, configurable por sesión, separado del saldo simulado compartido de 1000 USD. No es pérdida máxima ni capital independiente. Cambiarlo afecta solo operaciones futuras de una sesión nueva. La política forward congelada y su evidencia no cambian»

### What it means

- The simulated paper session (`paper_live_process`) opens each operation with a notional of 100 USD (`notional_per_trade_usd`, `fixed_notional` mode of `PortfolioPolicy`), apart from the shared simulated balance of 1000 USD. The value is provisional and set in the session configuration.
- 100 USD is a notional: not a maximum loss and not independent capital. An operation is rejected, never shrunk, when the free capital or a limit leaves less; all costs still count once.
- Changing the value is another session configuration. It affects only operations of a new session and moves no balance, position or order that already exists.

### Unchanged

The fixed 100 USD per trade of the frozen forward policy (C29-C31, Kronos and the forward measurement), its evidence and its 100-trade rule stay as written above. A future rule that varies the size by operation type is expressly **undefined**: this amendment does not define it and does not make a permanent fixed size an obligation. It does not authorize strategy or forward changes, additional sizing, leverage, migration or reinterpretation of existing balances, real sessions or money.

## Amendment 2026-10-18: one indicator catalog, Qwen at every open, auditable decisions, no time-based close

Requested directly by the user (Fran) on 2026-10-18 (decisions on `docs/diseno-indicadores-y-qwen.md`). Where it conflicts with the text above, including the amendments of 2026-10-11 and 2026-10-12, this one prevails for strategies created after this date. Everything remains paper only: no real orders, no private endpoints, no credentials.

### Decisions

1. **One indicator catalog** for all of Balancita (candle verdicts, forward, backtest, Qwen state, scorer, paper session, multi-strategy experiment). The late-data criterion is the forward's for everyone: late data is used and the result is marked `recovered`; only live results count toward the minimum number of forward trades.
2. **Qwen is consulted at every strategy OPEN** to confirm or veto the strategy's own signal (same side only; it creates no trade and changes no level). If Qwen is down or times out, the position is not opened; the skip is recorded with a code and a reason.
3. **Qwen decisions are auditable.** Each decision carries a concrete, gradable expectation (for example "+30 bp before <time>"), stored with the decision and later compared with what actually happened.
4. **Closing.** A position closes only when (a) its target is hit, (b) its protective stop is hit, or (c) a closing rule fires. The stop is always executed and never goes through Qwen. Closing rules are **not defined yet**; a Qwen-proposed close may become one such rule later, which requires its own definition. There is **no time-based close** (no horizon exit) for new strategies.
5. **Frozen history.** C25-C32 history stays as evidence and is not modified. C31 is switched off and C32 is retired.
6. **Funding** counts as a cost for every strategy. The comparison of the current rate against the 24 h (option b) is the general funding feature.

### Unchanged

Fixed notional, per-product cost model, append-only storage, replay equality, no look-ahead, the Evaluation rules and the 100-forward-trade rule for frozen strategies remain in force. Strategies without defined closing rules must not go live (see the design document, open questions).

### Further owner decisions (2026-10-18)

7. **Review threshold.** A strategy is reviewed after **15 LIVE forward trades**. This replaces the 100-trade rule for new strategies. 15 is a review checkpoint to decide whether to keep the strategy; it is not statistical proof of profitability.
8. **Only live trades count.** Trades whose live/recovered status is unknown are "unclassified" and never count (for example trades stored before #283, and open positions stored before entry classification).
9. **Capture recovery.** After the capture was off, funding and candles are recorded from the last recorded point up to now, with the real arrival time. The cost is proportional to the gap, with a one-time backlog on the first run.
10. **Funding retention target.** 7 days of funding in operational SQLite is enough for funding as a cost and for the 24 h comparison. Not yet implemented: it requires an incremental forward so that old trades are not recomputed without their data.
11. **Historical archive (planned, not implemented).** A monthly Parquet archive of the full data; SQLite stays the operational store. Nothing is deleted from SQLite before the archive is verified (row counts and hashes).

12. **Single late-candle tolerance.** The forward and the paper session share ONE late-candle tolerance of **15 s** (`late_candle_tolerance_ms` in `config/forward-strategies.json`; measured on 1228 real 1m candles: p50 3.1 s, p99.9 8.1 s, max 8.2 s). A candle learned more than 15 s after its bucket closed never produces a live trade: in the forward the trade is simulated and marked `recovered` (it does not count); in the paper session the order is not executed and the would-be decision is recorded as recovered/suppressed with reason `candle_late` and its lag. This replaces the forward's former 5-minute late threshold and the paper session's 45 s.

## Amendment 2026-10-19 — borrado completo de estrategias, pedido explícito del usuario

Requested directly by the user (Fran) on 2026-10-19 ("El ADR esta mal. Que no conserve nada"): deleting a strategy from the front must remove everything about it, including its paper trades. Everything remains paper only. This amendment adds to the text above and does not rewrite it.

### Supersedes

- The sentence of Amendment 2026-10-11 (evening) "Switching a strategy off or deleting it stops new trades and keeps its trades." Switching a strategy off still stops new trades and keeps its trades. **Deleting it**, when the user asks for it explicitly in the front, deletes its trades too.
- "The history stays because the registry is append-only" (same amendment) and the append-only rules for records ("Records are append-only guarded", "hash-chained append-only account DB", forward trades and their funding reconciliation, strategy registry rows), **only with respect to a user-initiated deletion of that one strategy**. In normal operation every one of those records stays append-only and guarded.

### Rules

1. **Scope.** A user-initiated delete removes the strategy's registry versions, events and backtests, its forward status and trades (and funding reconciliation), its rows in D's account DB, its replay rows, its gate runs, attempts, reports and logs, its configuration file when it is a shipped one, and its Qwen practice rows. Qwen and Kronos cannot be deleted from the front.
2. **Single writer.** Each process deletes only the rows of its own database (a request file is consumed by the owning process on its next loop); the append-only guards of a table are lifted for that one transaction and restored afterwards.
3. **D's hash chain stays valid.** The owning tool removes the deleted strategy's events, renumbers the remaining ones and recomputes the chain from the first affected event, rewrites the snapshots (the deleted book's state is dropped, heads re-pointed) and the config stored in the DB, and verifies the chain before committing; the other strategies' events and book balances are unchanged (every strategy has an independent book). The deletion leaves no trace of the strategy in the DB.
4. **Two anonymous exceptions in the strategy gate**, neither naming the strategy: an exam tombstone (hash of the exam'd content, date, verdict), so an identical re-created version cannot retake the final exam, and a counter of practice attempts per family keyed by the SHA-256 of the family name, so deleting and re-creating a family does not reset the deflated-Sharpe trial count.
5. Deleting a shipped strategy removes its file in `config/strategies/`.

## Amendment 2026-10-23: exploring is separated from declaring a winner

Requested directly by the user (Fran) on 2026-10-23: the limits of the earlier amendments are too conservative to find a winning opportunity. Where it conflicts with the text above, including the amendments of 2026-10-11, 2026-10-12, 2026-10-16 and 2026-10-18, this one prevails. Everything remains paper only: no real orders, no private endpoints, no credentials.

### Principle

Two different things were mixed. **Exploring** (trying ideas in paper) must be cheap and free. **Declaring a winner** (trusting a result) stays strict. Limits belong to the second, not the first.

### Exploring (paper)

1. Size and leverage are **free and configurable per strategy**. This replaces the fixed 100 USD notional, the 1x leverage cap of the laboratory and the provisional-size wording of the 2026-10-16 amendment. Each strategy keeps its own book; the notional and leverage used are stored with every trade so results stay auditable. Losses are still capped by the simulated balance: a position that would leave less than zero equity is rejected, never shrunk.
2. **Closing by time is allowed** (horizon exit). This replaces "no time-based close" of 2026-10-18. Strategies still need at least one defined closing rule before going live; a time exit counts as one.
3. **Qwen may open and close** positions, in addition to confirming or vetoing entries. It operates and is shown in the Terminal view, where it trains constantly, always in paper. This relaxes "Qwen creates no trade" (2026-10-12, limit 1; 2026-10-18, decision 2). There is no separate experiments area any more. Every Qwen answer is still stored with its inputs, prompt hash and model.
4. The shared-portfolio proposal with dynamic sizing (`docs/adr/propuesta-enmienda-dimensionamiento-dinamico.md`) stays as a reference design for one possible sizing rule. It is not adopted by this amendment.

### Review at 30 live trades

Every strategy is **reviewed after 30 LIVE forward trades**. This replaces the review at 15 live trades (2026-10-18) and the 100-forward-trade rule of the earlier amendments, including the "not modified until 100 forward trades" freeze, which now lasts until 30 live trades. A review is a checkpoint to keep, change or stop a strategy; it is not proof of profitability. Only live trades count (rule 8 of 2026-10-18 stands).

### Declaring a winner

A strategy or model is declared a winner only if it **wins after real costs on out-of-sample data**, corrected for the number of trials and with the evaluation rules of the Evaluation section, and the **exam reserve stays untouched** (never used to tune, select or explore). Free sizing, leverage, time exits or Qwen-driven trades never relax this bar. A result obtained with a different size or leverage is compared net of costs and funding, and with the same sizing in the control.

### Unchanged

Paper only without keys; exact Decimal accounting, canonical hashing and append-only storage; real per-product costs and observed funding (never inferred); each process writes only its own database; and no live trade on a late candle (15 s tolerance, `candle_late`). The complete-delete rule of 2026-10-19 stays.
