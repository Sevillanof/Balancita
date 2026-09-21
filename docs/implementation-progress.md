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

| Phase | Result                                | Status                    | Tests           | Commits                   |
| ----- | ------------------------------------- | ------------------------- | --------------- | ------------------------- |
| 0     | Repo + quality gates                  | ✅ done                   | —               | de42f10, 964b9b3, 2eed4d9 |
| 1     | Domain + deterministic mock feed      | ✅ done                   | 20              | 1355606                   |
| 2     | Realtime watchlist                    | ✅ done                   | 36              | 80bced6, f0e11ed          |
| 3     | Detail + mock history chart           | ✅ done (first milestone) | 74              | 0291cc2…b435043 (11)      |
| 4     | Local portfolio + valuation           | ✅ done                   | 122             | 9f5622f…9598990 (7)       |
| 5     | Local alerts                          | ✅ done                   | 185             | 8234229…75c5f25 (5)       |
| 6     | Paper trading simulator               | ✅ done                   | 249             | 54ce740…8cd3a05 (6)       |
| 7     | Local deterministic analysis          | ✅ done                   | 291             | 38b3ffd…ee0c648 (6)       |
| 8     | Optional budgeted Gemini              | ✅ done                   | 322 + 61 server | 3b4006f…dddb7a8 (9)       |
| 9     | Read-only real data                   | ✅ done                   | 341             | 0df96b2…3a0b5fe (5)       |
| 9.1   | Recomendación educativa + UI ES       | ✅ done                   | 348 + 64 server | f1615d6…58f517d (4)       |
| 9.2   | Tokenized CSS foundation              | ✅ done                   | 348 + 64 server | c3007eb…8b0fcd2 (3)       |
| 9.3   | Dashboard BTC-EUR + paper real        | ✅ done                   | 352 + 64 server | 77c8db0…7a5f04a (4)       |
| B     | Durable BTC-EUR market ingestion      | ✅ done                   | 104 server      | 806abc6, 4641803, 9b3b994 |
| C     | Intraday candles + technical engine   | ✅ done                   | 118 server      | 7ea7107                   |
| D     | Immutable forecasts + deferred scorer | ✅ done                   | 133 server      | fd6a764…565f8d6 (4)       |
| E     | Reliable official RSS news evidence   | ✅ done                   | 146 server      | working tree              |
| 10    | Broker paper trading                  | ⏸ pending                 | —               | —                         |
| 11    | Real trading evaluation               | ⏸ pending                 | —               | —                         |
| 12    | Jev spike                             | ⏸ pending                 | —               | —                         |

All quality gates green at Phase 8 close: `pnpm test` (322), `pnpm test:server`
(61), `typecheck`, `lint`, `build`, `format:check`, and server typecheck.
Working tree clean after excluding the local `.atl/` tooling directory.

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
- Server package: Fastify 5.12.5, `@fastify/cors` 11.3.0, and official
  `@google/genai` 2.23.0; Node 22 runs the TypeScript gateway with native type
  stripping. Node 22.22.2 exposes the built-in experimental `node:sqlite`; no
  SQLite dependency was added.
- No global state library — React primitives only (hooks + props).

## 3. Non-negotiable conventions

1. `doc/personal-trading-app.md` is never edited by tooling (user preference
   overrides the doc's own "update the source of truth" step). `doc/` is read-only.
2. Strict TDD: RED → GREEN per work unit; tests first for domain decisions.
3. Conventional commits, English messages, no "Co-Authored-By", no AI
   attribution, no push/PR unless explicitly requested.
4. Close each phase with all gates green: `test`, `typecheck`, `lint`,
   `build`, `format:check`.
5. User conversation language is Rioplatense Spanish; all visible UI copy and
   explanatory analysis results use neutral, professional Spanish. Code,
   identifiers and technical comments may remain in English.
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
  without float conversion. Classification remains surveillance-only; the
  later approved recommendation field is separate and educational.
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

### Phase 8 — Optional budgeted Gemini

- Verified on 2026-09-20 against the official Google Gen AI JavaScript SDK and
  npm: `@google/genai` 2.23.0. The server uses `new GoogleGenAI({apiKey})`,
  `ai.models.generateContent({model, contents, config})`,
  `responseMimeType: 'application/json'`, `responseJsonSchema`,
  `maxOutputTokens`, and `abortSignal`. The legacy
  `@google/generative-ai` package is not used.
- Free-tier decision confirmed by the user: `gemini-3.5-flash-lite`, no linked
  billing, with observed limits of 15 RPM, 250K TPM and 500 RPD on 2026-09-20.
  Internal defaults are deliberately lower at 10 RPM and 300 RPD; both remain
  configurable through server environment variables.
- `server/` exposes `POST /api/analyze` and `/health`. `GEMINI_API_KEY` is read
  only by the server process and is never logged, sent to the browser, or used
  as a test value. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`.
- `GeminiAnalysisProvider` serializes `Money` with
  `moneyToDecimalString`; the wire format contains decimal strings and never
  serializes the `bigint` wrapper. It validates the response again in the
  browser before returning an `AnalysisResult`.
- The gateway enforces structured JSON, a maximum output size, an abort timeout,
  a SHA-256 input cache with a five-minute TTL, bounded candle history and
  sliding internal minute/day quotas. It enables no tools, grounding, files,
  audio, images, agents or order execution.
- The UI has a visible AI switch that is session-only and OFF by default.
  Toggling it never analyzes; only the existing manual `Analyze` action can
  call the selected provider. `MockAnalysisProvider` remains the local default
  and closed fallback. The panel labels Mock or Gemini and shows the
  gateway warning when quota, timeout, invalid JSON, missing key, network or
  server failures fall back. The source indicator is explicitly `Mock` or
  `Gemini`.
- Server tests use injected fake Gemini clients and Fastify `inject`; no real
  network or API key is required. Phase 8 added coverage for SDK request shape,
  endpoint envelopes, structured response validation, quotas, timeout, invalid
  JSON, missing key, fallback, toggle behavior and quote non-automation.

## Approved scope update — educational recommendation and Spanish UI

- Decision recorded on 2026-09-20: the complete visible application UI must be
  in neutral, professional Spanish. This includes navigation, labels, buttons,
  loading/empty/error states, validation, notifications, analysis output and
  paper-trading receipts. Instrument symbols, exchange names and proper names
  remain unchanged.
- `src/domain/analysis.ts` now exposes
  `EducationalRecommendation = 'buy' | 'sell' | 'hold'` as a field separate from
  `classification`. The existing surveillance classification remains exactly
  `watch | neutral | review`; it was not repurposed as a trading decision.
- The visible recommendation labels are `Comprar`, `Vender` and `Mantener`.
  They are educational and informational only. The result carries a visible
  disclaimer stating that it is not financial advice and never executes orders.
- `MockAnalysisProvider` remains stateless, deterministic and offline. It uses
  quote variation and candle variation for trend, ATR for volatility, and the
  decimal portfolio holding/P&L for context. Rules are: contradictory trend
  signals hold; high ATR volatility always degrades to hold with a warning;
  positive trend may recommend buy; negative trend recommends sell only when a
  holding exists; weak signals hold. Every result explains trend, volatility and
  portfolio context in Spanish. No `Date.now`, randomness, network or orders
  are used.
- The Gemini wire result and JSON Schema now require `recommendation` restricted
  to `buy | sell | hold` and a non-empty `disclaimer`. The prompt requests
  structured JSON and explanatory Spanish text, including the no-position rule.
  Browser validation remains closed-by-default; an invalid Gemini result fails
  and the existing frontend fallback displays the local Mock assessment.
- Analysis remains isolated from `OrderExecutionProvider`. Neither the Mock nor
  the Gemini path can preview, submit or execute orders. Paper simulator
  authority and contracts were not changed. Tests explicitly verify that
  clicking `Analizar` and rendering `Comprar` does not call execution methods.
- `doc/personal-trading-app.md` and `doc/guia-personal-trading-app.md` remain
  immutable; no file under `doc/` was edited.

## Approved scope update — tokenized CSS foundation

- Decision recorded on 2026-09-20: build the visual foundation in CSS without
  adding a UI library or new dependency. Balancita is a data-reading tool, so a
  small local token layer keeps the bundle and mental model small while allowing
  the watchlist, detail, portfolio, alerts and trading surfaces to stay coherent.
- `src/styles/ui.css` is the shared foundation. It defines light/dark theme
  tokens for surfaces, text, borders, accent, focus, success, danger and warning;
  spacing, content width, typography, radii, shadows and control heights; plus
  reusable button, surface/card, section header, field/form grid, badge/status,
  table-scroll/data-table and state primitives.
- Feature styles now consume the shared tokens instead of maintaining separate
  colors, control metrics, borders and focus treatments. Data tables use a
  semantic `.table-scroll` wrapper with a deliberate minimum width, preserving
  every critical column on small screens through horizontal scrolling.
- The dashboard shell no longer centers the whole application vertically. It uses
  fluid gutters, a bounded content width, consistent surfaces and an overflowing
  mobile tab strip. Forms, cards, feedback states, visible focus and reduced
  motion are covered by the foundation without changing domain or provider
  contracts.
- `PriceChart` reads the CSS theme variables at chart creation time and retains a
  jsdom-safe fallback. The existing Lightweight Charts setup and
  `layout.attributionLogo` remain unchanged, so TradingView attribution continues
  to work without a new dependency.

## 5. Architecture map (current)

```
src/
  domain/            analysis.ts, money.ts, market-data.ts, portfolio.ts, alerts.ts, orders.ts
  providers/         deterministic-mock-market-data.ts, coinbase-market-data.ts,
                     market-data-provider.ts, mock-analysis-provider.ts,
                     gemini-analysis-provider.ts
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
server/src/intelligence/market/
                     SQLite store, Coinbase WebSocket collector, normalized
                     payloads and market fixtures
```

UI depends on provider contracts (`MarketDataProvider`, `PortfolioRepository`,
`AlertRepository`, `OrderExecutionProvider`, `AnalysisProvider`), never on
concrete providers directly. React primitives only; no global state.

The optional Gemini path is `UI -> GeminiAnalysisProvider -> POST /api/analyze
-> AnalyzeService -> GoogleGenaiClient -> Gemini API`. The UI has no Gemini API
key and the analysis path never imports or invokes `OrderExecutionProvider`.

## 6. Persistence keys & schemas

| Key                         | Scheme                       | Shape                                                                                                                | Notes                                                                            |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `balancita:portfolio`       | v2 (legacy v1 auto-migrated) | `{version, holdings[]}`; holdings use decimal strings                                                                | v1 read → convert → rewrite v2; unsupported version → `PortfolioCorruptError`    |
| `balancita:alerts`          | versioned                    | `{version, alerts[]}`                                                                                                | strict validation on read                                                        |
| `balancita:simulator`       | v1                           | cash per currency, receipt history, usedKeys, consumedPreviews, counters                                             | append-only history; corrupt state → typed reset                                 |
| `server/data/market.sqlite` | SQLite v2                    | `market_observations`, `market_cursors`, `market_gaps`, `forecast_records`, `forecast_outcomes`, `schema_migrations` | append-only market/forecast/outcome records; path overridden by `MARKET_DB_PATH` |

The Gemini response cache is server-memory-only, keyed by SHA-256 of the
canonical input, bounded by entry count and expired after five minutes. It is
not user persistence and is discarded on server restart.

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

## 8. Phase 8 and Phase 9 (done)

Phase 7 (Prompt 7) is **implemented and verified**: contract,
`MockAnalysisProvider` with explicit deterministic surveillance rules, manual
"Analyze" button in the instrument detail (never triggered by arriving quotes),
loading/error/result states, and analysis/orders separation. The approved 9.1
scope adds a separate educational recommendation without changing the
classification. Full rule tables, reasons, warnings and test breakdown are in
§4 Phase 7 and the approved scope update above. Gates green at 348 frontend
tests and 64 server tests.

Phase 8 (Prompt 8) — optional budgeted Gemini — is implemented and verified.
The gateway, official SDK adapter, structured response validation, timeout,
output cap, temporary input-hash cache, conservative internal quotas, manual
provider selection, closed Mock fallback and required tests are complete.

### Phase 9 - Coinbase Exchange read-only market data (approved scope)

- Implemented `CoinbaseMarketDataProvider` behind `MarketDataProvider` for the
  exact public product `BTC-EUR` only. It uses the unauthenticated Exchange REST
  product and candles endpoints plus the public Exchange WebSocket ticker feed.
  It never sends credentials and has no order endpoint or
  `OrderExecutionProvider` surface.
- REST mapping preserves EUR, Coinbase product identity, `providerSymbols`, and
  the raw product fields in `providerMetadata`. Candles map from Coinbase's
  `[timestamp, low, high, open, close, volume]` tuples to ascending ISO
  `Candle` values. History is explicitly one `granularity=86400` request. The
  provider validates the response rows, then applies a client-side cap by
  retaining the first 300 entries from Coinbase's newest-first response before
  sorting them ascending; an oversized response is not rejected or paginated
  without a time range.
- WebSocket mapping uses the public `ticker` subscription for `BTC-EUR` and
  calculates `change` and `changePercent` from `open_24h`. Sequence numbers must
  be strictly increasing per connection. Gaps are accepted because the public
  ticker feed can legitimately skip sequence values; duplicate and out-of-order
  sequences are ignored without publishing a quote or closing the socket.
  Socket errors, closes, invalid JSON, and invalid ticker messages emit the last
  quote as `stale` when one exists and reconnect with bounded backoff. The
  contract has no error callback, so this is the explicit recovery behavior;
  `live` resumes after a valid tick on the active subscription.
- Quotes become `stale` after the configurable `staleAfterMs` threshold (15s by
  default). WebSocket errors, closes, invalid JSON, and incomplete ticker
  messages use bounded exponential reconnect backoff (1s to 30s by default).
  Unsubscribe clears stale/reconnect timers, detaches handlers, and closes the
  socket; no timer or socket is left behind.
- `VITE_MARKET_DATA_PROVIDER` is validated as `mock` or `coinbase`; absent or
  empty remains `mock` for development and tests. Coinbase mode filters the
  catalog to `BTC-EUR`. The application deliberately gives Trade a separate
  deterministic mock provider, so Coinbase prices never become paper-trading
  execution input. The local paper simulator remains the authority for orders,
  positions, and receipts.
- `TTWO` and `SPCX` remain in the deterministic mock catalog only. No exact,
  free, credential-free, real-time, and legally redistributable provider was
  verified for either equity. The current identity of `SPCX` was verified as
  Space Exploration Technologies Corp. Class A, but historical data under the
  prior use of the ticker must not be joined automatically.

#### Phase 9 evidence and restrictions

Research and source consultation date: **2026-09-20**.

Official Coinbase Exchange sources consulted:

- Product: https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproduct
- Candles: https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
- WebSocket channels and ticker schema:
  https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
- WebSocket overview and sequence guidance:
  https://docs.cdp.coinbase.com/exchange/websocket-feed/overview
- REST limits: https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits
- Market Data Terms of Use: https://www.coinbase.com/legal/market_data

Coinbase Exchange market data is publicly accessible for this use without an
API key or credentials. The documented public limits are 10 REST requests per
second per IP with a burst of 15, and 8 WebSocket messages per second per IP
with a burst of 20. Candles support the documented 1-minute through 1-day
granularities and a maximum of 300 candles per request. These limits are not a
license to redistribute the feed.

Coinbase's Market Data Terms restrict redistribution, display, or dissemination
of Market Data and derived works to third parties outside the organization
without prior written consent. This implementation is therefore intended for
local/internal use only; the restriction must be reviewed before exposing the
Coinbase mode to external users or publishing its prices, charts, or derived
analytics.

## Iteración recomendada — pantalla única BTC-EUR con paper trading realista

Implementada el 2026-09-20 sin avanzar a broker, dinero real, Revolut, Wise,
Trade Republic ni las fases 10, 11 o 12.

- **Dashboard único BTC-EUR**: `src/app/BtcEurDashboard.tsx` reemplaza la
  navegación principal por una composición vertical accesible. Al abrir, BTC-EUR
  ya está seleccionado y quedan visibles cotización, gráfico, análisis, ticket,
  situación de cartera, movimientos y alertas secundarias. TTWO y SPCX sólo
  aparecen en el laboratorio mock colapsable.
- **Provider de referencia compartido**: `App` entrega la misma instancia de
  `MarketDataProvider` al detalle y al ticket. `useTrading` ingiere la cotización
  desde esa suscripción antes de enviarla a `LocalPaperTradingProvider`; Coinbase
  sigue siendo lectura pública y nunca implementa `OrderExecutionProvider` ni
  endpoints de órdenes.
- **`FeePolicy`**: `src/domain/orders.ts` expresa porcentaje como `Money`
  fraccional (`0.001` = 0,1%), mínimo y moneda. El default documentado es
  `ZERO_FEE_POLICY` (`Desarrollo: comisión cero (no real)`); puede reemplazarse
  mediante `simulatorOptions.feePolicy`. Se conserva el escenario legacy de
  comisión fija para dobles existentes. El preview muestra precio, cantidad,
  subtotal, deslizamiento, comisión, total y política aplicada; la cantidad de
  BTC es el flujo implementado y el importe en EUR queda como extensión futura.
- **Ledger virtual**: `balancita:simulator` migra de v1 a v2 y agrega
  movimientos append-only `{id, type, currency, amount, timestamp, note, balance}`
  con reloj inyectable, depósitos/retiros positivos, moneda soportada, saldo
  suficiente, validación estricta de payload e idempotencia opcional. Las órdenes
  siguen aisladas en `history`, con preview, confirmación e idempotencia propios.
- **Análisis local continuo**: `useAnalysis` admite debounce configurable,
  deduplicación por entrada efectiva, cleanup, metadata de cotización/velas,
  antigüedad y estado stale. Sólo el provider local se actualiza automáticamente;
  Gemini sigue manual, opcional y apagado por defecto. Ningún resultado puede
  ejecutar órdenes.
- **UI y límites**: la interfaz permanece en español neutral, conserva estados
  loading/error/empty/stale y foco visible, y muestra persistentemente `Datos
reales`, `Datos simulados` y `Operación simulada`. No se agregó una librería
  visual ni una integración financiera.

### Criterios de esta iteración

- ✅ BTC-EUR aparece seleccionado y todas las superficies principales son
  accesibles sin pestañas.
- ✅ Detalle y preview consumen el mismo provider de referencia activo.
- ✅ Preview, confirmación humana, idempotencia, auditoría y aislamiento de
  ejecución permanecen activos.
- ✅ FeePolicy, ledger virtual, persistencia versionada y análisis local continuo
  tienen pruebas de dominio, integración y cleanup.
- ✅ La suite frontend, typecheck, lint, build y formato se mantienen como gates
  obligatorios; el servidor no fue modificado.
- ⏸ El importe en EUR para órdenes por valor queda preparado pero no implementado.
- ⏸ Revisión visual manual responsive y con Coinbase real sigue pendiente; no se
  considera cubierta por jsdom.

## Fase A — contratos, SLIs y política de fuentes

Implemented as pure, network-free server modules under `server/src/intelligence/`.
The 21 new server tests are included in the 85-test server gate.

- **Contracts**: `TimestampMs` is a branded epoch-milliseconds value. External
  inputs are accepted only through runtime validation; ISO strings and epoch
  numbers are not mixed. Market and news collector/normalizer contracts are
  generic and scoped to the first supported instrument, `BTC-EUR`.
- **Event/received/display semantics**: `eventTime` is the source-assigned
  instant, `receivedTime` is the local collector receipt instant, and
  `displayTime` is the UI snapshot instant. `DataFreshness.ageMs` is exactly
  `displayTime - eventTime`; a strict `ageMs > staleAfterMs` comparison marks a
  sample stale. Inverted clocks are rejected by default or explicitly clamped
  to zero when `clockSkewPolicy: clamp_to_zero` is selected.
- **Latency and percentiles**: receive latency is
  `receivedTime - eventTime`. `p50` and `p95` use deterministic nearest-rank
  percentiles: sort ascending and select the 1-indexed rank
  `ceil(percentile * n)`. Empty samples return `null` percentiles; one sample
  returns that sample for both percentiles. Samples must be finite and
  non-negative.
- **Stale and gap denominators**: stale rate is
  `stale snapshots / total snapshots`; no snapshots returns `null`. Gap rate is
  `gap transitions / expected messages in the window`, where one transition is
  a strictly increasing sequence jump larger than one. Without a sequence, the
  rate is `null` and the expected denominator must be zero.
- **Source policy**: only `official_primary` and `licensed_reporting` can enter
  the initial pipeline. Licensed reporting requires `licenseStatus: licensed`;
  official primary sources require `official_public`. `unverified_social` is
  excluded. Every accepted item requires an absolute HTTPS URL, non-empty
  source/hash, valid ordered timestamps, explicit license and correction states,
  and metadata-only, summary, or permitted excerpt content. Other instruments
  are rejected with structured reason codes.
- **Forecast validation**: `ForecastRecord` is readonly, versioned and
  content-hashed; probabilities must be finite, within `[0, 1]`, and sum to one
  within tolerance `1e-9`. Valid horizons are `15m`, `1h`, `4h`, and `24h`.
  Feature snapshots must be versioned and closed, and news evidence must have
  `ingestedAt <= eventCutoff`. Abstentions require a reason. `ForecastOutcome`
  validates its forecast id/version and appends a separate result without an
  update API for the original record.
- **Scope boundary**: this phase adds no SQLite, migrations, Coinbase or RSS
  collectors, SSE, runtime timers, intraday candles, technical indicators,
  Gemini/news calls, forecast persistence, backtesting, broker integration, or
  orders. The UI and immutable files under `doc/**` were not modified.

## Fase B — Durable Coinbase market ingestion

Phase B is implemented and verified as a server-only, read-only market stream.
The collector is disabled by default and does not affect the Gemini gateway or
the frontend.

- **SQLite schema and path**: Node 22.22.2's built-in `node:sqlite`
  (`DatabaseSync`) is used without a new dependency. Migration v1 creates
  `schema_migrations`, append-only `market_observations`, current
  `market_cursors`, and evidence-bearing `market_gaps`. The default path is
  `./data/market.sqlite`; `MARKET_DB_PATH` overrides it and local database files
  are ignored by Git.
- **Coinbase source and channels**: the unauthenticated public Exchange WebSocket
  at `COINBASE_WS_URL` subscribes only to `BTC-EUR` with `ticker` and
  `heartbeat`. The official Coinbase Exchange channel, sequence, rate-limit and
  Market Data Terms evidence recorded in the Phase 9 section remains the source
  policy. Use is local/internal; no credentials, order API, or execution provider
  is involved.
- **Sequence and gap policy**: ticker `sequence` is required to be strictly
  increasing within one connection, but a numeric jump is accepted and is never
  called a gap. Duplicate or out-of-order ticker/heartbeat sequences are
  rejected and observable through structured rejection callbacks. A gap is stored
  only when monotonic `trade_id` or `heartbeat.last_trade_id` jumps by more than
  one; `prevSequence`, `currentSequence`, channel, connection revision and
  detection time are retained. This avoids treating the ticker feed's non-
  contiguous message sequence as lost data.
- **SLIs and timestamps**: Coinbase's event timestamp becomes `eventTime`; the
  injected server clock supplies `receivedTime` and `displayTime`. Freshness is
  `displayTime - eventTime`, with strict `ageMs > staleAfterMs` semantics.
  `status` and freshness are persisted per observation and stream state can
  transition to stale and back to live after a valid fresh message.
- **Idempotency and restart**: the deterministic SHA-256 identity covers source,
  instrument, event time, sequence and normalized payload, excluding derived
  receipt/freshness state. Exact and delayed replays return explicit
  `inserted | duplicate` outcomes. Historical observations are never updated;
  cursor revisions, last sequence/trade id, and schema version survive a store
  restart.
- **Recovery and shutdown**: socket errors, closes, invalid JSON and invalid
  supported payloads trigger bounded exponential reconnect with injectable timer
  and jitter behavior. Every new connection resubscribes. Stale/reconnect timers
  and socket handlers are cleared by `stop`; Fastify `onReady`/`onClose` owns the
  enabled collector lifecycle.
- **Tests and boundaries**: 104 server tests cover migration, validation,
  idempotency, append-only history, cursor/gap persistence, sequence policy,
  heartbeat continuity, stale recovery, reconnect/backoff, malformed input,
  cleanup and disabled-by-default lifecycle. Tests use temporary SQLite files,
  fake clocks, fake sockets and recorded fixtures; no real network, secrets,
  previews, submits or order calls are used.
- **Limits**: Phase B does not add intraday candles or indicators (C), forecast
  persistence/evaluation (D), news/RSS (E), Gemini forecasts (F), comparison or
  SSE/UI observability (G/H), broker integration, money movement or automated
  orders. The next authorized implementation step is Phase C.

## Fase C — Intraday candles and deterministic technical features

Phase C is server-only and pure. It consumes persisted `StoredMarketObservation`
values from Fase B or equivalent deterministic fixtures; it does not write
`ForecastRecord`, change the collector, expose an endpoint, or touch paper
trading.

- **Candle intervals and cutoff**: supported intervals are `1m`, `5m`, `15m`,
  and `1h`. Buckets use UTC epoch milliseconds and the half-open rule
  `[bucketStart, bucketEnd)`: an exact boundary belongs to the next bucket. The
  caller supplies `asOfTimestamp`; no module reads the global clock. A bucket is
  closed when `bucketEnd <= asOfTimestamp`; the current bucket is returned
  separately as `provisional` and never enters technical evidence.
- **Observation policy**: ticker payloads are sorted by `eventTime`, then
  sequence, trade id, and stable identity. Exact identities are deduplicated;
  out-of-order inputs are accepted and counted. Invalid observations, including
  invalid event/received/display timestamps, are rejected with a structured
  reason. Observations after the cutoff are excluded as future evidence. A
  provisional candle is recomputed from the complete tick set on each call, so
  later ticks replace it rather than append a duplicate.
- **Candle provenance**: OHLCV plus event, received, and display start/end
  timestamps are retained. Freshness retains maximum age, stale state, and
  clock-inversion state. Candle status uses the conservative precedence
  `invalid > gap > stale > live`. Existing Fase B `GapMetrics` are passed through
  unchanged; the builder does not infer gaps from Coinbase ticker sequence
  jumps, because Fase B explicitly treats those jumps as non-evidence of loss.
- **Technical formulas**: SMA is the arithmetic mean of the latest `N` closes.
  EMA seeds with the first `N`-close SMA and then uses
  `EMA = alpha * close + (1 - alpha) * previous`, with `alpha = 2/(N+1)`.
  RSI uses Wilder-smoothed gains/losses; flat series return `50`, all-gain
  series `100`, and all-loss series `0`. MACD is fast EMA minus slow EMA, with
  a signal EMA over MACD values and histogram `line - signal`. ATR uses true
  range `max(high-low, abs(high-previousClose), abs(low-previousClose))`, a
  Wilder average, and requires a previous close. Structural slope is the
  least-squares slope of the latest close window; trend is `up`, `down`, or
  `flat` by the explicit threshold.
- **Warm-up and versioning**: no indicator value is fabricated before its
  required history. The result exposes per-indicator readiness, required and
  available candle counts, `technicalFeatureVersion = technical-features.v1`,
  and `paramSetVersion = technical-defaults.v1` by default. The
  `toTechnicalFeatureSnapshot` adapter refuses incomplete features and emits a
  closed, finite snapshot ready for Fase D. Indicators remain descriptive and
  are not summed into a hidden composite signal.
- **Dependency decision**: no `trading-signals` dependency was added. The
  formulas are small, auditable TypeScript implementations with deterministic
  fixtures, no network, and no global clock. This avoids introducing a streaming
  state model before the application needs it; adoption can be revisited only
  with a separate evidence and license review.
- **Tests and gates**: the new candle/feature fixtures cover exact bucket
  boundaries, rollover, provisional replacement, duplicates, out-of-order
  ticks, invalid/future timestamps, gap propagation, status/freshness, warm-up,
  no-look-ahead, known indicator values, flat-series division-by-zero behavior,
  finite outputs, versioning, and the closed snapshot adapter. The RED run
  failed on the missing modules; the GREEN run passed with 118 server tests.
- **Limits**: Fase C does not persist forecasts, evaluate outcomes, ingest news,
  call Gemini, combine technical/news evidence, add SSE/UI observability, or
  modify orders and paper-trading authority. Fase D remains pending.

## Fase D — Immutable forecasts and deferred scorer

Phase D is server-only and keeps forecast generation, evaluation, persistence, and
metrics separate from the existing UI, Gemini gateway, and paper-trading
authority. It does not ingest news; forecast news references are accepted only
when already versioned and ingested no later than the evidence cutoff.

- **Deterministic engine**: `generateForecast` uses only the explicit cutoff,
  closed candles, a versioned `TechnicalFeatureSnapshot`, freshness, gap metrics,
  and safe news references. It never reads a global clock, uses open/future
  candles, random values, Gemini, or order providers. The fixed versions are
  `deterministic-baseline.v1` and `technical-direction.v1`.
- **Feature quality gate**: the engine abstains with a mandatory reason for
  incomplete warm-up, stale/inverted freshness, any measured gap, unavailable
  sequence gap metrics, unreliable candle status, invalid reference price, or
  incomplete/non-finite required features. Abstention uses the explicit neutral
  probability policy `(1/3, 1/3, 1/3)` and remains distinct from UI educational
  recommendations.
- **Probability rule**: reliable evidence scores four independent directional
  checks (`referencePrice` vs `sma`, `rsi` outside 45/55, MACD histogram sign,
  and structural slope sign). A zero score emits `(0.3, 0.3, 0.4)`; a directional
  score maps linearly from winner/loser/flat `(0.45, 0.25, 0.30)` to
  `(0.55, 0.20, 0.25)`. Every output is finite, bounded, and sums to one.
- **Ledger migration**: SQLite schema v2 adds strict `forecast_records` and
  `forecast_outcomes` tables. Forecasts and outcomes are append-only, validated
  before insertion, and content-hashed from canonical JSON. Replaying the same
  id/version/hash returns `duplicate`; a conflicting hash is rejected. Public
  store methods expose insertion and read-only forecast queries by instrument,
  horizon, and creation-time bounds; no update/delete method exists.
- **No-look-ahead scorer**: `evaluateForecast` accepts only when injected `now`
  is at or after `asOfTimestamp + horizon`, and observed evidence has an event
  time at or after that exact boundary, a non-empty versioned data hash, and a
  closed-data flag. The outcome is a separate append-only record. Its id is tied
  to the forecast and observed snapshot, so replaying the same snapshot is
  idempotent.
- **Outcome semantics**: gross return is
  `observedPrice / referencePrice - 1`. If versioned cost parameters exist,
  estimated net return subtracts `commissionRate + slippageRate`; no real fees
  are inferred. The default neutral band is `±0.0015` (±0.15%), with exact
  boundaries classified as `flat` after decimal comparison normalization.
  Labels are `up` above the band and `down` below it.
- **Metrics**: pure functions prepare coverage/abstention, secondary
  directional accuracy, Brier score, guarded log loss, calibration bands,
  return/range MAE, and segmentation by horizon/regime. Empty aggregates return
  `null` where a rate is undefined, and invalid probabilities are rejected.
  These metrics are descriptive only; no performance, profitability, or
  superiority claim is made.
- **Tests and limits**: fixtures are offline and deterministic. Tests cover RED
  first/GREEN after implementation, probability invariants, deterministic replay,
  abstention gates, cutoff filtering, schema migration, immutable insert/conflict,
  deferred evaluation boundaries, open/future evidence rejection, exact labels,
  versioned costs, outcome replay, metric formulas, invalid probabilities, and
  empty inputs. No UI, news ingestion, Gemini call, order call, backtest, or
  random forecast was added. Phase E remains the next authorized step.

## Fase E — Reliable official RSS news evidence

Phase E is implemented as a server-only, read-only RSS/Atom ingestion pipeline.
It does not start periodic timers, expose an endpoint, call Gemini, combine news
with technical signals, or touch the paper-trading authority.

- **Official sources verified on 2026-09-21**: SEC RSS documentation and press
  releases feed (`https://www.sec.gov/about/rss-feeds`,
  `https://www.sec.gov/news/pressreleases.rss`), ECB press RSS
  (`https://www.ecb.europa.eu/rss/press.html` and the official RSS directory),
  and Federal Reserve all-press RSS
  (`https://www.federalreserve.gov/feeds/press_all.xml` and the official feed
  directory). CFTC remains pending because it was not verifiable in the prior
  consultation; it is not implemented and this does not claim that it is absent.
- **Terms, licence, robots, and quota evidence**: SEC Developer Resources
  documents declared user agents, efficient fetching, and a maximum of 10
  requests/second; the SEC RSS page identifies press releases as an official
  RSS source. Direct SEC requests returned HTTP 403 from this environment, so
  tests use fixtures and the adapter does not claim successful live retrieval.
  ECB's copyright page permits accurate free reproduction with source citation;
  its `robots.txt` specifies a 5-second crawl delay and does not disallow the
  press RSS path. The Federal Reserve RSS page documents the feed and its
  disclaimer states that Board website information is public domain unless
  otherwise indicated, with citation required; no Federal Reserve quota or
  robots directive was found in the official pages consulted. The implementation
  stores only metadata and links, not a redistribution of article bodies.
- **Dependency**: `fast-xml-parser@5.11.1` (MIT) is the only new dependency. It
  validates XML, removes namespace prefixes, handles attributes/text nodes, and
  is configured with bounded entity processing; regex is not used as the XML
  parser.
- **Collector/normalizer**: `server/src/intelligence/news/` exposes the
  `RssNewsCollector`/`NewsCollector` contract, source ids, injected HTTP fetcher,
  user-agent, clock, timeout and abort signal. RSS 2.0 and Atom entries support
  namespaces, missing fields, relative links, duplicate identities and malformed
  XML. `RssNewsNormalizer` emits HTTPS canonical URLs, publication/ingestion/
  retrieval timestamps, deterministic SHA-256 content hashes, explicit source
  item identity, metadata-only content, licence and correction status.
- **Source policy**: only official primary sources with `official_public`
  licence status are active. Social sources, unknown/permission-required
  licences, unsupported instruments and incomplete provenance are rejected.
  Corrections and retractions are accepted as historical evidence only when
  they reference the source item; they append a new version and never overwrite
  prior evidence. Retracted latest versions are excluded from usable evidence.
- **Relevance and taxonomy**: `news-relevance.v1` requires a BTC/Bitcoin token
  plus an EUR/Euro token for `relevant`; BTC without EUR is `uncertain`, and
  text without BTC is `not_relevant`. `news-taxonomy.v1` applies deterministic
  precedence for `security`, `market_structure`, `regulation`, `exchange`,
  `technology`, and `macro`; unmatched text uses `other` with an uncertain
  classification. Uncertain and non-relevant items are retained for audit but
  excluded from future signal queries.
- **SQLite v3**: `MarketStore` migration v3 adds append-only `news_evidence`
  with source/item/url/hash uniqueness, versioned correction references,
  provenance, relevance/taxonomy versions, bounded metadata/content JSON and
  full normalized record JSON. It exposes idempotent insertion plus read-only
  queries by source, publication window, relevance and latest usable version.
  Article descriptions are used transiently for classification and are never
  persisted; tests assert that full article text cannot enter stored evidence.
- **Tests and limits**: 13 new server tests use local SEC/ECB/Fed RSS/Atom
  fixtures and fake HTTP. They cover namespaces, missing fields, invalid XML/
  dates/URLs, relative and duplicate links, correction/retraction append-only
  behavior, policy rejection, relevance boundaries, taxonomy abstention,
  provenance/hash determinism, SQLite replay/restart/query, timeout/abort and
  no full-article persistence. No real network, secrets,
  `OrderExecutionProvider`, Gemini, UI, periodic scheduling, F/G/H/I work, or
  complete article storage was added.

## 9. How to resume

1. Read `doc/personal-trading-app.md` (read-only) for the exact prompt of the
   current phase.
2. Read this file for context, then Engram (`engine: mem_search "balancita"`)
   for worker reports.
3. Run `pnpm test` and `pnpm test:server` to confirm the current baseline
   (352 frontend, 146 server tests expected).
4. Execute the next phase with TDD work units; commit; verify gates; update this
   file's status table.
