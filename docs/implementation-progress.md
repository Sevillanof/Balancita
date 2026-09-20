# Balancita — Implementation Progress & Recovery Context

> **Purpose**: durable registry of everything implemented so far, plus the context
> that can disappear when a session is compacted. Re-read this file after any
> compaction or before starting a new phase.
>
> **Product source of truth**: `doc/personal-trading-app.md` — **IMMUTABLE**. The
> user explicitly decided that tooling never edits that file, even though the doc
> protocol says to update it. The same applies to `doc/guia-personal-trading-app.md`
> (private user guide, never handed to AI). Progress lives in this file, in commits,
> and in Engram.

## 1. Project status

| Phase | Result                           | Status                    | Tests | Commits                   |
| ----- | -------------------------------- | ------------------------- | ----- | ------------------------- |
| 0     | Repo + quality gates             | ✅ done                   | —     | de42f10, 964b9b3, 2eed4d9 |
| 1     | Domain + deterministic mock feed | ✅ done                   | 20    | 1355606                   |
| 2     | Realtime watchlist               | ✅ done                   | 36    | 80bced6, f0e11ed          |
| 3     | Detail + mock history chart      | ✅ done (first milestone) | 74    | 0291cc2…b435043 (11)      |
| 4     | Local portfolio + valuation      | ✅ done                   | 122   | 9f5622f…9598990 (7)       |
| 5     | Local alerts                     | ✅ done                   | 185   | 8234229…75c5f25 (5)       |
| 6     | Paper trading simulator          | ✅ done                   | 249   | 54ce740…8cd3a05 (6)       |
| 7     | Local deterministic analysis     | ✅ done                   | 291   | 38b3ffd…ee0c648 (6)       |
| 8     | Optional budgeted Gemini         | ⏭️ **next**               | —     | —                         |
| 9     | Read-only real data              | ⏸ pending                 | —     | —                         |
| 10    | Broker paper trading             | ⏸ pending                 | —     | —                         |
| 11    | Real trading evaluation          | ⏸ pending                 | —     | —                         |
| 12    | Jev spike                        | ⏸ pending                 | —     | —                         |

All quality gates green at Phase 7 close: `pnpm test` (291), `typecheck`,
`lint`, `build`, `format:check`. Working tree clean.

## 2. Stack and tooling

- pnpm 11.3.0 (package manager; lockfile `pnpm-lock.yaml`), Node v22.22.2
  (engines: `^20.19.0 || >=22.12.0`).
- Vite 8.3.0 + `@vitejs/plugin-react` + `@rolldown/plugin-babel`
  - `babel-plugin-react-compiler`.
- React 19.2.8, TypeScript ~6.0.2 (`strict: true`), ESLint 10 flat config
  - typescript-eslint + react-hooks + react-refresh, Prettier 3.9.8.
- Vitest 5 + jsdom 30 + Testing Library + user-event + jest-dom;
  setup `src/test/setup.ts`.
- Runtime dep: `lightweight-charts@^5.2.1` only.
- No global state library — React primitives only (hooks + props).

## 3. Non-negotiable conventions

1. `doc/personal-trading-app.md` is never edited by tooling (user preference
   overrides the doc's own "update the source of truth" step). `doc/` is read-only.
2. Strict TDD: RED → GREEN per work unit; tests first for domain decisions.
3. Conventional commits, English messages, no "Co-Authored-By", no AI
   attribution, no push/PR unless explicitly requested.
4. Close each phase with all gates green: `test`, `typecheck`, `lint`,
   `build`, `format:check`.
5. User conversation language is Rioplatense Spanish; generated technical
   artifacts (code, comments, UI copy, docs, commits) default to neutral
   English.
6. Product visible name: **Balancita**. Mock-only, local-first, USD 0 cost
   during development.
7. No brokers / Gemini / auto-execution before their roadmap phases.
8. Numbers are acceptable for mock _display_; **monetary arithmetic must be
   explicit decimal** (`Money`, fixed-scale bigint) — never float for money.

## 4. What each phase actually built

### Phase 0 — Bootstrap

- Migrated npm → pnpm; Vitest/Testing Library/user-event/jest-dom/jsdom/setup;
  Prettier; ESLint flat; scripts `dev / test / test:watch / typecheck / lint /
format / format:check / build / preview`; minimal "Balancita" screen + render
  test; git init on `main`; README with setup, scripts, Node range.

### Phase 1 — Domain + deterministic mock market data

- `src/domain/market-data.ts`: `Instrument`, `Quote`, `Candle`,
  `MarketDataProvider` contract. Enabled `strict: true`.
- `src/providers/deterministic-mock-market-data.ts`: catalog BTC-EUR (EUR),
  TTWO (USD), SPCX (USD). Mulberry32 PRNG; deterministic seed per instrument
  (`seed ^ FNV-1a(id)`); injectable clock; candle history anchored to
  `Date.UTC(2024, 0, 1)`; rejects unknown instrument ids.

### Phase 2 — Realtime watchlist

- `src/app/watchlist/useWatchlist.ts`: state machine loading / ready / empty /
  error, quotes in `Map<InstrumentId, Quote>`, subscription cleanup on unmount.
- `src/app/watchlist/WatchlistScreen.tsx`: semantic table (caption, `th scope`),
  accessible states, stable layout, no empty flash.
- Test double `src/test/fake-market-data-provider.ts` with manual `emit()`.

### Phase 3 — Detail + mock history chart (first milestone)

- Instrument selection from the watchlist with keyboard support (`aria-pressed`,
  `aria-current`), keyed detail view.
- `src/app/detail/`: `useLatestQuote`, `useCandleHistory` (race-safe, no
  synchronous setState in effects), `InstrumentDetail` with price summary and
  placeholder states before first quote.
- `src/app/chart/PriceChart.tsx`: lightweight-charts v5.2.1 — verified API:
  `createChart(container, opts)`, `chart.addSeries(CandlestickSeries, opts)`,
  `series.setData(data)`, `autoSize: true`, `layout.attributionLogo: true`,
  `chart.remove()` cleanup. Tests mock the lib (jsdom has no canvas).
- Bundle after P3 ≈ 136 kB gzip JS.

### Phase 4 — Local portfolio + valuation

- `src/domain/portfolio.ts`: `Holding`, `PortfolioRepository` contract,
  `PortfolioCorruptError`, `isHolding` guard.
- `src/portfolio/local-storage-portfolio-repository.ts`: single namespaced key
  `balancita:portfolio` with versioned payload `{version, holdings}` (decision:
  NOT per-version keys, so "no data" ≠ "corrupt"); strict validation on read;
  missing key → empty list; corrupt → typed error with reset.
- `src/portfolio/valuation.ts`: pure `costOf / valueOf / profitLossOf /
profitLossPercentOf`; persists only config/holdings, never quotes/totals.
- `src/app/portfolio/`: `usePortfolio` (quote subscription per holding),
  `PortfolioScreen` (manual add/edit/delete table), workspace tabs
  Watchlist/Portfolio wired in `App`.

### Phase 5 — Local alerts

- `src/alerts/alert-evaluator.ts`: pure crossing semantics — trigger only on a
  genuine crossing; price **equal** to the threshold counts as the non-trigger
  side; cold start (null previous zone) never fires; acknowledge → active with
  zone reset → only the next real crossing fires.
- `src/alerts/local-storage-alert-repository.ts`: key `balancita:alerts`,
  versioned, strict validation, `AlertCorruptError`.
- `src/app/alerts/`: `useAlerts`, `AlertsScreen`, in-app
  `AlertNotificationCenter`.
- ⚠️ Incident (keep for future runs): the first delegated run left the work
  uncommitted with `TS2345` (`PriceSide | null` vs `Map<AlertId, PriceSide>`
  zone ref) and 2 react-hooks lint errors; a **bounded corrective pass**
  (override zone ref type to `Map<AlertId, PriceSide | null>`, move
  `syncFromRepository` under `useCallback`) fixed it — implementation was NOT
  redone.

### Phase 6 — Paper trading simulator (decimal migration first)

- `src/domain/money.ts`: fixed-scale decimal over native `bigint`, scale 8,
  rounding half-away-from-zero; `moneyFromString` strict, `moneyFromNumber` at
  the data frontier, `moneyToNumber` **display-only**; `MoneyParseError`,
  `MoneyDivideByZeroError`. Decision: internal wrapper over `decimal.js`
  (local-first, dependency-minimal, swappable behind `Money`).
- Portfolio migrated to decimal: `Holding.quantity/averageCost` are `Money`;
  storage schema **v1 (numbers) → v2 (decimal strings)** with automatic
  migration + best-effort rewrite on v1 read; unsupported versions rejected.
- `src/domain/orders.ts`: `OrderIntent`, `OrderPreview`, `ConfirmedOrder`,
  `OrderReceipt`, `OrderExecutionProvider` contract, `OrderSimulatorConfig`
  (slippage 0, commission 0, previewTolerance 0.005, initialCash EUR/USD
  10_000), pure math `estimatePreview`, `averageCostAfterBuy`,
  `driftWithinTolerance`; typed errors: `IdempotencyConflictError`,
  `MissingOrUnknownPreviewError`, `PreviewOutdatedError`,
  `SimulatorCorruptStateError`, `UnknownInstrumentError`,
  `UnavailablePriceError`.
- `src/orders/local-paper-trading-provider.ts`: `balancita:simulator` v1
  (cash per currency, append-only receipt history, usedKeys, consumedPreviews,
  P/R counters). **Preview mandatory** → human confirmation (binds to
  `previewReference`) → **idempotent receipt** (same idempotencyKey + same
  preview → same receipt; new preview with same key → conflict). Drift > 0.5%
  from preview → `PreviewOutdatedError` forces re-preview. Sell without
  position / buy without funds → rejected with typed receipts. Slippage and
  commission mock are configurable and **shown in the preview**, zero by
  default.
- `src/app/trade/`: `useTrading` (cash, positions, preview/submit states,
  recent history), `TradeScreen` (account summary, order form
  Buy/Sell + quantity, preview → Confirm enabled only after a live preview,
  receipt feedback, auditable history table), tab wired in `App`.
- Simulator is the authority for positions and writes through the shared
  `PortfolioRepository`; manual add/edit remains as seeding.
- Bundle ≈ 144.87 kB gzip JS after P6.

### Phase 7 — Local deterministic analysis

- `src/domain/analysis.ts`: `AnalysisProvider` contract (`analyze(input:
AnalysisInput): Promise<AnalysisResult>`), `AnalysisInput` (instrument id,
  symbol, assetClass, currency, `quote`, `candles`, `holding: AnalysisHolding |
null`), `AnalysisResult` (instrumentId, `classification: 'watch' | 'neutral' |
'review'`, `reasons`, `warnings`, `volatility`), and `analysisInputFrom`
  builder that attaches the matching portfolio holding (decimal `Money`)
  without float conversion. Classifications may never be buy/sell.
- `src/providers/mock-analysis-provider.ts`: stateless, deterministic — same
  input always yields the same output, no PRNG, no clock, no network.
  Explicit rules (all thresholds inclusive): variation severity from
  `quote.changePercent` (≥2% → watch, ≥5% → review); volatility severity from a
  simple average true range (ATR) as % of latest close (≥3% → moderate/watch,
  ≥8% → high/review); portfolio severity from |unrealized P/L%| computed in
  decimal `Money` (≥10% → watch, ≥30% → review). Aggregation: review if any
  signal reaches severity 2 OR the three watch-level signals sum ≥ 3; watch if
  the sum ≥ 1; else neutral. Reasons name every contributing signal; warnings
  flag data-quality/context caveats (no candle history, unknown asset class
  identity, stale quote, no position held, high volatility, single-quote move).
- `src/app/detail/useAnalysis.ts`: application-layer hook, strictly manual —
  `analyze()` is the only entry point; nothing runs on mount and quotes/candles
  never trigger it. Reads the portfolio fresh from `PortfolioRepository` at
  request time, race-safe across instrument changes. States: idle/loading/ready
  /error.
- `src/app/detail/AnalysisPanel.tsx`: "Analyze" button (disabled until the first
  quote), loading/error/result states; verdict badge with reasons + warnings,
  ATR metric line. Rendered by `InstrumentDetail` only when both
  `analysis` and `portfolioRepository` are wired (App defaults to
  `MockAnalysisProvider`).
- Decision: **no persistence** for Phase 7 — analysis is stateless and
  deterministic; history is not stored (no `balancita:analysis*` key added).
  Volatility/variation are measurements over display data (numbers),
  consistent with quotes/candles; only portfolio P/L uses decimal `Money`.
- Separation analysis/orders: analysis never imports, references or calls the
  orders domain (`OrderExecutionProvider`, preview/submit) — enforced by tests
  at the domain, provider and panel source level, by a surface test (no
  subscribe/preview/submit members), and by an App-level test where clicking
  the Analyze button never touches the Trade tab or submits orders.
- New tests: 42 (domain contract 8, provider rules 17, hook 8, panel 6, detail
  integration 2, app integration 1 …); total 291.

## 5. Architecture map (current)

```
src/
  domain/            analysis.ts, money.ts, market-data.ts, portfolio.ts, alerts.ts, orders.ts
  providers/         deterministic-mock-market-data.ts, mock-analysis-provider.ts
  portfolio/         local-storage-portfolio-repository.ts (+ valuation.ts)
  alerts/            alert-evaluator.ts, local-storage-alert-repository.ts
  orders/            local-paper-trading-provider.ts
  app/               App.tsx (Watchlist | Portfolio | Trade | Alerts tabs)
    watchlist/       useWatchlist, WatchlistScreen
    detail/          useLatestQuote, useCandleHistory, InstrumentDetail,
                     useAnalysis, AnalysisPanel
    chart/           candlestick-data, PriceChart
    portfolio/       usePortfolio, PortfolioScreen
    trade/           useTrading, TradeScreen
    alerts/          useAlerts, AlertsScreen, AlertNotificationCenter
  test/              setup.ts, fake-market-data-provider.ts
```

UI depends on provider contracts (`MarketDataProvider`, `PortfolioRepository`,
`AlertRepository`, `OrderExecutionProvider`, `AnalysisProvider`), never on
concrete providers directly. React primitives only; no global state.

## 6. Persistence keys & schemas

| Key                   | Scheme                       | Shape                                                                    | Notes                                                                         |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `balancita:portfolio` | v2 (legacy v1 auto-migrated) | `{version, holdings[]}`; holdings use decimal strings                    | v1 read → convert → rewrite v2; unsupported version → `PortfolioCorruptError` |
| `balancita:alerts`    | versioned                    | `{version, alerts[]}`                                                    | strict validation on read                                                     |
| `balancita:simulator` | v1                           | cash per currency, receipt history, usedKeys, consumedPreviews, counters | append-only history; corrupt state → typed reset                              |

Phase 7 adds **no** persistence key: analysis is stateless and deterministic
(decision documented in §4).

Rule: single namespaced key + versioned payload; missing key = empty;
corrupt ≠ empty (typed error + reset UI). Persist config/minimal state only,
never quotes or derived totals.

## 7. Recovery notes (context that did get lost)

- a11y testing gotcha: roles `status` and `alert` are **name-from-author**;
  `getByRole("status", { name: ... })` can fail on empty accessible name even
  with text inside. Inspect accessible names via DOM dump before asserting.
- lightweight-charts v5 API: `addSeries(CandlestickSeries, opts)` (not
  `addCandlestickSeries`), `autoSize`, attribution logo default true.
- Mock provider determinism: `seed ^ FNV-1a(id)`; SPCX has no exchange,
  `assetClass: "unknown"`, USD; do not treat SPCX as a real tradable identity —
  Phase 9 must re-verify before any real-data work.
- Decimal boundary rule: quotes stay `number` for display; convert with
  `moneyFromNumber` only at the order/analysis frontier; `moneyToNumber` must
  never feed back into arithmetic.
- Commits are work-unit-sized per phase; keep them that way in future phases.

## 8. Phase 7 (done) and Phase 8 scope (next)

Phase 7 (Prompt 7) is **implemented and verified**: contract,
`MockAnalysisProvider` with explicit deterministic rules, manual "Analyze"
button in the instrument detail (never triggered by arriving quotes), loading/
error/result states, and analysis/orders separation. Full rule tables, reasons,
warnings and test breakdown are in §4 Phase 7. Gates green at 291 tests.

Phase 8 (Prompt 8) — optional budgeted Gemini — is next, but only after explicit
user authorization and a fresh decision about the free tier. Requirements from
the source-of-truth doc: Fastify server (key never reaches the browser),
`GeminiAnalysisProvider` behind `AnalysisProvider` keeping `MockAnalysisProvider`
as default/fallback, runtime-validated JSON output, timeout, length cap, hash
cache and internal per-minute/per-day limits. Human-only invocation; never call
`OrderExecutionProvider`. Verify the free-tier model and limits in Google AI
Studio before implementing.

## 9. How to resume

1. Read `doc/personal-trading-app.md` (read-only) for the exact prompt of the
   current phase.
2. Read this file for context, then Engram (`engine: mem_search "balancita"`)
   for worker reports.
3. Run `pnpm test` to confirm the baseline (291 expected).
4. Execute the phase with TDD work units; commit; verify gates;
   update this file's status table.
