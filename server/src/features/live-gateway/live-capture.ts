import { ConnectionHealth, type ResilienceEvent } from './connection-health.ts'
import {
  FUTURES_PRODUCT,
  KrakenFuturesMarketCollector,
  PAPER_MARKET_QUALITY_POLICY,
  validateInstrumentCatalog,
  type FuturesSocket,
} from '../kraken-futures/futures-market.ts'
import { FuturesCandleBuilder } from '../kraken-futures/futures-candles.ts'
import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import {
  createHistoricalFundingClient,
  type HistoricalFundingFetch,
} from '../kraken-futures/historical-funding.ts'
import {
  catalogProductWarnings,
  type FuturesProduct,
} from '../kraken-futures/futures-products.ts'
import { createTickerPollClient } from '../kraken-futures/ticker-poll.ts'
import { backfillOfficialCandles } from '../kraken-futures/official-candles-backfill.ts'
import {
  createOfficialCandlesClient,
  OFFICIAL_CANDLE_INTERVALS,
  OFFICIAL_CANDLES_PER_REQUEST,
} from '../kraken-futures/official-candles.ts'
import {
  ANALYTICS_POINTS_PER_REQUEST,
  createAnalyticsClient,
  type AnalyticsMetric,
} from '../kraken-futures/market-analytics.ts'

/** Backfill depth per interval: enough history for 5m indicator warm-up. */
const OFFICIAL_LOOKBACK_MS: Readonly<Record<number, number>> = {
  60_000: 24 * 3_600_000,
  300_000: 3 * 24 * 3_600_000,
}
/** Chart-only timeframes: about 500 candles of history each. */
const CHART_LOOKBACK_MS: Readonly<Record<number, number>> = {
  900_000: 7 * 24 * 3_600_000,
  3_600_000: 60 * 24 * 3_600_000,
  14_400_000: 180 * 24 * 3_600_000,
  86_400_000: 730 * 24 * 3_600_000,
}
/** Analytics history: one day of minutes, sixty days of hours. */
const ANALYTICS_LOOKBACK_MS: Readonly<Record<number, number>> = {
  60_000: 24 * 3_600_000,
  3_600_000: 60 * 24 * 3_600_000,
}
/** Analytics buckets settle a few seconds after the minute: poll at :08. */
const ANALYTICS_POLL_OFFSET_MS = 8_000
/** At most this many `more` pages per series per poll (backfill catch-up). */
const ANALYTICS_MAX_PAGES = 3
/** Poll this long after each minute boundary so the closed candle settled. */
const OFFICIAL_POLL_OFFSET_MS = 3_000
/** Windows of candles one poll fetches per series while catching up after a stop. */
const OFFICIAL_MAX_WINDOWS = 6
/** A hole shorter than this is an ordinary missed poll, not a recorded gap. */
const OFFICIAL_GAP_MIN_MS = 10 * 60_000
/**
 * Pause between two official-candle requests. 8 products x 2 intervals is 16
 * requests a minute at most (about 3 a minute per product on average, since 5m
 * is polled every fifth minute): spacing them keeps the public charts API far
 * from any rate limit and spreads the load instead of bursting it.
 */
const OFFICIAL_REQUEST_GAP_MS = 250
const HOUR_MS = 3_600_000
/** A timer this late means the process itself was not running (blocked or asleep). */
const BLOCKED_PROCESS_MS = 2_000
const CAPTURE_CANDLE_INTERVAL_MS = 60_000
/**
 * Kraken lists the funding period starting at hh:00 (hourly cadence) at or
 * shortly after the boundary; a response only adds knowledge when a new hour
 * appeared. So poll once at start, then 30 s after each hour boundary, and
 * retry every minute (up to 10 times) while that new period is not listed yet.
 */
const FUNDING_POLL_OFFSET_MS = 30_000
const FUNDING_RETRY_MS = 60_000
const FUNDING_MAX_RETRIES = 10

export interface LiveCaptureOptions {
  readonly store: FuturesMarketStore
  readonly makeSocket: (url: string) => FuturesSocket
  readonly fetchCatalog: () => Promise<unknown>
  readonly fundingFetch?: HistoricalFundingFetch
  readonly clock?: () => number
  readonly staleAfterMs?: number
  readonly reconnectMinMs?: number
  readonly reconnectMaxMs?: number
  readonly candleTickMs?: number
  /** Fixed funding poll period; by default aligned to just after each hour. */
  readonly fundingPollMs?: number
  readonly catalogRetryMs?: number
  /**
   * Ticker poll (REST, all pinned products except PF_XBTUSD, whose ticker comes
   * from the WebSocket): quote, sizes and funding for paper execution.
   * Off by default (`0`); the capture process polls every second.
   */
  readonly tickerPollMs?: number
  readonly tickerFetch?: HistoricalFundingFetch
  /**
   * A REST poll (tickers, official candles, analytics) that has not settled after this long is
   * abandoned so the next one is scheduled (default: tickers 30 s, analytics 5 min, official
   * candles 10 min). Without it one request that never settles stops its chain for good.
   */
  readonly pollDeadlineMs?: number
  /** Time budget of one official-candles poll before it hands the rest to the next one (default 45 s). */
  readonly officialPollBudgetMs?: number
  /**
   * Products whose official candles are captured (pinned config, never chosen
   * at runtime). The WebSocket feeds stay PF_XBTUSD only. Default: PF_XBTUSD.
   */
  readonly products?: readonly FuturesProduct[]
  /** Pause between official-candle requests (default 250 ms). */
  readonly officialRequestGapMs?: number
  readonly officialCandlesFetch?: HistoricalFundingFetch
  readonly officialCandleLookbackMs?: Readonly<Record<number, number>>
  /** Fixed poll period; by default polls 3 s after every minute boundary. */
  readonly officialPollMs?: number
  /**
   * On start, fill interior holes of the 1m/5m series over this span (0: off). Resumable and
   * cheap when complete: windows already stored are skipped.
   */
  readonly officialRepairMs?: number
  /**
   * Extra official timeframes captured for the terminal product only (chart
   * use; no verdict reads them). Default: none.
   */
  readonly chartCandleIntervals?: readonly number[]
  /**
   * Public Kraken analytics series captured for the terminal product (order
   * flow, open interest, liquidations, positioning, depth). Default: none.
   */
  readonly analytics?: {
    /** Series of the terminal product (PF_XBTUSD). */
    readonly metrics: readonly AnalyticsMetric[]
    readonly intervals: readonly number[]
    /**
     * Series captured for every pinned product at 1m (e.g. `orderbook`: best
     * bid/ask, depth bands and slippage, for per-product trading costs).
     */
    readonly allProductMetrics?: readonly AnalyticsMetric[]
    readonly fetch?: HistoricalFundingFetch
    /** Fixed poll period; by default 8 s after every minute boundary. */
    readonly pollMs?: number
    readonly lookbackMs?: Readonly<Record<number, number>>
  }
  readonly log?: (line: string) => void
  /** Shared incident record; by default one is created with `resilienceLogFile`. */
  readonly health?: ConnectionHealth
  /** JSON-lines log of connection incidents and recoveries (reason, source, time, result). */
  readonly resilienceLogFile?: string
  /** WebSocket watchdog: silence on an open socket, and time allowed to connect (defaults 30 s / 15 s). */
  readonly silenceMs?: number
  readonly dataSilenceMs?: number
  readonly connectTimeoutMs?: number
  readonly watchdogIntervalMs?: number
  /** A general incident replaces the WebSocket only if it has delivered nothing for this long (default 10 s). */
  readonly generalIdleMs?: number
  /** A deadline timer this late means the process was blocked or asleep, not the network (default 2 s). */
  readonly blockedProcessMs?: number
}

/**
 * Capture-process core: the only writer of the live market database. Public
 * Kraken futures WebSocket -> per-event commits + candle revisions + funding
 * evidence. No engine, no HTTP, no Python, no account store.
 */
export function createLiveCapture(options: LiveCaptureOptions) {
  const clock = options.clock ?? Date.now
  const log = options.log ?? (() => undefined)
  const { store } = options
  const health =
    options.health ??
    new ConnectionHealth({
      clock,
      log,
      logFile: options.resilienceLogFile,
      // Three independent sources failing inside a minute is a connectivity problem, not one slow product.
      generalThreshold: 3,
    })
  const replaceSilentSocket = (): void => {
    const age = collector?.metrics.tickerAgeMs
    if (
      collector !== undefined &&
      (age === null ||
        age === undefined ||
        age > (options.generalIdleMs ?? 10_000)) &&
      health.allowRecovery('websocket-general')
    )
      collector.reconnect('general_incident')
  }
  /**
   * Records an incident. When it makes the failure general and the WebSocket is silent too, that
   * socket is replaced at once (rate limited); a healthy WebSocket is never touched, and neither is
   * any other connection: each REST client recovers by itself with a new connection.
   */
  const note = (event: Omit<ResilienceEvent, 'at'>): void => {
    health.report(event)
    if (event.component === 'websocket' || !health.general()) return
    // The incident is noted from a timer callback. If the process was not running for a while, the
    // frames that arrived meanwhile are still queued behind it, so judging the ticker age now would
    // replace a healthy socket (the same case the collector's watchdog skips). Look once the loop has
    // delivered what it had: the timers phase and the sockets run before the check phase.
    setImmediate(replaceSilentSocket)
  }
  let collector: KrakenFuturesMarketCollector | undefined
  let candleTimer: ReturnType<typeof setInterval> | undefined
  let fundingTimer: ReturnType<typeof setTimeout> | undefined
  let catalogTimer: ReturnType<typeof setTimeout> | undefined
  let fundingClient:
    ReturnType<typeof createHistoricalFundingClient> | undefined
  let officialTimer: ReturnType<typeof setTimeout> | undefined
  let officialClient: ReturnType<typeof createOfficialCandlesClient> | undefined
  let analyticsTimer: ReturnType<typeof setTimeout> | undefined
  let analyticsClient: ReturnType<typeof createAnalyticsClient> | undefined
  let analyticsPoll: Promise<void> = Promise.resolve()
  let tickerTimer: ReturnType<typeof setTimeout> | undefined
  let tickerClient: ReturnType<typeof createTickerPollClient> | undefined
  let tickerPoll: Promise<void> = Promise.resolve()
  let stopped = true
  let fundingPoll: Promise<void> = Promise.resolve()
  let officialPoll: Promise<void> = Promise.resolve()
  const products = options.products ?? [
    { productId: FUTURES_PRODUCT, tickSize: '1' },
  ]
  const requestGapMs = options.officialRequestGapMs ?? OFFICIAL_REQUEST_GAP_MS
  const sleepers = new Set<() => void>()
  /** Waits `ms`; resolves early when capture stops. */
  const pause = (ms: number): Promise<void> =>
    ms <= 0 || stopped
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            sleepers.delete(done)
            resolve()
          }
          const timer = setTimeout(done, ms)
          sleepers.add(done)
        })
  const lookbacks = {
    ...OFFICIAL_LOOKBACK_MS,
    ...CHART_LOOKBACK_MS,
    ...options.officialCandleLookbackMs,
  }
  // Verdict series for every product, then the chart-only timeframes of the
  // terminal product (largest first: they are due least often).
  const officialSeries = [
    ...products.flatMap(({ productId }) =>
      OFFICIAL_CANDLE_INTERVALS.map((interval) => ({ productId, interval })),
    ),
    ...(options.chartCandleIntervals ?? []).map((interval) => ({
      productId: FUTURES_PRODUCT,
      interval,
    })),
  ]

  // Official Kraken candles are the canonical series for verdicts: backfill
  // on start, then fetch each newly closed bucket. After a stop (the process
  // down for hours) the whole hole is fetched, window by window, from the last
  // stored bucket: a lookback only bounds an empty series.
  let holesRepaired = (options.officialRepairMs ?? 0) <= 0
  // A poll that runs long (slow or throttled API) stops after its time budget and the next one
  // starts from the series it left off, so no product is starved behind a slow one.
  let seriesCursor = 0
  const pollOfficialCandles = async (): Promise<void> => {
    let requested = false
    const pollStartedAt = Date.now()
    const budgetMs = options.officialPollBudgetMs ?? 45_000
    const begin = seriesCursor
    let budgetHit = false
    // One product after another, 5m before 1m within each (OFFICIAL_CANDLE_INTERVALS).
    for (let k = 0; k < officialSeries.length; k += 1) {
      const index = (begin + k) % officialSeries.length
      if (k > 0 && Date.now() - pollStartedAt > budgetMs) {
        seriesCursor = index
        budgetHit = true
        log(
          `official candles poll over its ${budgetMs} ms budget after ${k} of ${officialSeries.length} series; continues next poll`,
        )
        break
      }
      const { productId, interval } = officialSeries[index]!
      if (stopped || officialClient === undefined) return
      const window = OFFICIAL_CANDLES_PER_REQUEST * interval
      const due = (): number | undefined => {
        const now = clock()
        const latest = store.latestOfficialBucket(productId, interval)
        // The bucket after the latest stored one has not closed yet.
        if (latest !== undefined && latest + 2 * interval > now)
          return undefined
        if (latest !== undefined) return latest + interval
        return Math.max(
          now - (lookbacks[interval] ?? 500 * interval),
          now - window,
        )
      }
      let from = due()
      if (from === undefined) continue
      const gapStart = store.latestOfficialBucket(productId, interval)
      const gapFrom = gapStart === undefined ? undefined : from
      let stored = 0
      for (
        let step = 0;
        from !== undefined && step < OFFICIAL_MAX_WINDOWS;
        step += 1
      ) {
        if (requested) await pause(requestGapMs)
        if (stopped || officialClient === undefined) return
        // Recomputed after the pause: the clock and the stored data moved on.
        const now = clock()
        const to = Math.min(from + window, now)
        requested = true
        const requestStartedAt = Date.now()
        try {
          const candles = await officialClient.fetch(
            productId,
            interval,
            from,
            to,
          )
          const took = Date.now() - requestStartedAt
          if (took > 5_000)
            log(
              `slow official candles request (${productId} ${interval / 60_000}m): ${took} ms`,
            )
          stored += store.appendOfficialCandles(candles).inserted
        } catch (error) {
          if (stopped) return
          log(
            `official candles unavailable (${productId} ${interval} ms, after ${Date.now() - requestStartedAt} ms): ${describe(error)}`,
          )
          break
        }
        // Still behind by more than a window: continue from where this one ended
        // (also past a window Kraken had nothing for).
        const latest = store.latestOfficialBucket(productId, interval)
        from =
          to >= now || (latest !== undefined && latest + 2 * interval > now)
            ? undefined
            : Math.max(to, latest === undefined ? to : latest + interval)
      }
      if (
        gapFrom !== undefined &&
        gapStart !== undefined &&
        stored > 0 &&
        clock() - gapFrom > Math.max(OFFICIAL_GAP_MIN_MS, 3 * interval)
      ) {
        const filledTo =
          store.latestOfficialBucket(productId, interval) ?? gapFrom
        log(
          `official candles ${productId} ${interval / 60_000}m: filled ${stored} missing from ${new Date(gapFrom).toISOString()}`,
        )
        try {
          store.appendGap({
            feed: `official_candles_${interval / 60_000}m`,
            productId,
            epoch: 0,
            expectedSeq: gapFrom,
            actualSeq: filledTo,
            detectedAt: clock(),
            reason: `capture was down from ${new Date(gapFrom).toISOString()}; ${stored} candles recovered from the public charts API`,
            policyVersion: 'official-candles-catchup.v1',
          })
        } catch (error) {
          log(`could not record the candle gap: ${describe(error)}`)
        }
      }
    }
    if (!budgetHit) seriesCursor = 0
    if (!holesRepaired && officialClient !== undefined && !stopped) {
      holesRepaired = true
      const toMs = clock() - 2 * 60_000
      const fromMs = toMs - (options.officialRepairMs ?? 0)
      for (const { productId } of products)
        for (const interval of OFFICIAL_CANDLE_INTERVALS) {
          if (stopped) return
          try {
            const result = await backfillOfficialCandles({
              store,
              client: officialClient,
              productId,
              intervalMs: interval,
              fromMs,
              toMs,
              requestGapMs,
              pause,
            })
            if (result.inserted > 0)
              log(
                `official candles ${productId} ${interval / 60_000}m: repaired ${result.inserted} holes in the last ${Math.round((options.officialRepairMs ?? 0) / 86_400_000)} days`,
              )
          } catch (error) {
            if (stopped) return
            log(
              `candle repair unavailable (${productId} ${interval} ms): ${describe(error)}`,
            )
          }
        }
    }
  }
  // A poll that never settles must not stop its chain: after the deadline the chain re-arms (the
  // stuck request is aborted through the client) and the stall is logged once per occurrence.
  const settleWithin = (
    work: Promise<void>,
    deadlineMs: number,
    label: string,
    component: string,
    abort: () => void,
  ): Promise<void> =>
    new Promise<void>((resolve) => {
      const startedAt = Date.now()
      let extended = false
      const onDeadline = (): void => {
        // A timer that fires far later than asked means this process was not running (blocked by a
        // synchronous call, or the machine slept), not that the request hung: the request gets one more
        // full period before it is called stuck, and nothing is counted as a network incident.
        const lateBy = Date.now() - startedAt - deadlineMs
        if (
          !extended &&
          lateBy > (options.blockedProcessMs ?? BLOCKED_PROCESS_MS)
        ) {
          extended = true
          if (!stopped) {
            log(
              `${label} poll deadline ran ${lateBy} ms late; process was blocked, not the network`,
            )
            health.report({
              component,
              product: null,
              reason: 'process_blocked',
              action: 'extend_deadline',
              result: 'info',
              detail: `${lateBy} ms late`,
            })
          }
          timer = setTimeout(onDeadline, deadlineMs)
          return
        }
        if (!stopped) {
          log(`${label} poll stuck for ${deadlineMs} ms; re-arming`)
          note({
            component,
            product: null,
            reason: 'poll_stuck',
            action: 'abort_and_rearm',
            result: 'recovering',
            detail: `${deadlineMs} ms`,
          })
        }
        try {
          abort()
        } catch {
          // The client is already closed.
        }
        resolve()
      }
      let timer = setTimeout(onDeadline, deadlineMs)
      work
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          clearTimeout(timer)
          resolve()
        })
    })
  // The first poll may be a long catch-up after downtime; later ones are short and bounded.
  let officialPolls = 0
  const guardedOfficial = (): Promise<void> =>
    settleWithin(
      pollOfficialCandles(),
      options.pollDeadlineMs ?? (officialPolls++ === 0 ? 600_000 : 90_000),
      'official candles',
      'rest-candles',
      () => officialClient?.abortInFlight(),
    )
  const guardedTicker = (): Promise<void> =>
    settleWithin(
      pollTickers(),
      options.pollDeadlineMs ?? 30_000,
      'ticker',
      'rest-tickers',
      () => tickerClient?.close(),
    )
  const guardedAnalytics = (): Promise<void> =>
    settleWithin(
      pollAnalytics(),
      options.pollDeadlineMs ?? 300_000,
      'analytics',
      'rest-analytics',
      () => analyticsClient?.abortInFlight(),
    )
  const scheduleOfficialPoll = (): void => {
    if (stopped) return
    const now = clock()
    const delay =
      options.officialPollMs ??
      60_000 - (now % 60_000) + OFFICIAL_POLL_OFFSET_MS
    officialTimer = setTimeout(() => {
      officialPoll = guardedOfficial().finally(scheduleOfficialPoll)
    }, delay)
  }

  // Public analytics of the terminal product: order flow, open interest,
  // liquidations, positioning and depth. Same rules as official candles:
  // backfill on start, then each newly settled bucket; failures only log.
  const analytics = options.analytics
  // Terminal product: every metric at every interval; then the per-product
  // metrics (1m) of the other pinned products.
  const analyticsSeries = analytics
    ? [
        ...analytics.intervals.flatMap((interval) =>
          analytics.metrics.map((metric) => ({
            productId: FUTURES_PRODUCT,
            metric,
            interval,
          })),
        ),
        ...products
          .filter(({ productId }) => productId !== FUTURES_PRODUCT)
          .flatMap(({ productId }) =>
            (analytics.allProductMetrics ?? []).map((metric) => ({
              productId,
              metric,
              interval: 60_000,
            })),
          ),
        ...(analytics.allProductMetrics ?? [])
          .filter(
            (metric) =>
              !analytics.metrics.includes(metric) ||
              !analytics.intervals.includes(60_000),
          )
          .map((metric) => ({
            productId: FUTURES_PRODUCT,
            metric,
            interval: 60_000,
          })),
      ]
    : []
  const pollAnalytics = async (): Promise<void> => {
    if (!analytics) return
    let requested = false
    for (const { productId, metric, interval } of analyticsSeries)
      for (let page = 0; page < ANALYTICS_MAX_PAGES; page += 1) {
        if (stopped || analyticsClient === undefined) return
        const now = clock()
        const latest = store.latestAnalyticsBucket(productId, metric, interval)
        if (latest !== undefined && latest + 2 * interval > now) break
        const from = Math.max(
          latest === undefined ? 0 : latest + interval,
          now -
            (analytics.lookbackMs?.[interval] ??
              ANALYTICS_LOOKBACK_MS[interval] ??
              500 * interval),
          now - ANALYTICS_POINTS_PER_REQUEST * interval,
        )
        if (requested) await pause(requestGapMs)
        if (stopped || analyticsClient === undefined) return
        requested = true
        try {
          const response = await analyticsClient.fetch(
            productId,
            metric,
            interval,
            from,
          )
          store.appendAnalytics(response)
          // Kraken caps a response; fetch the next page only while it says so
          // and this page actually moved the stored series forward.
          const moved = store.latestAnalyticsBucket(productId, metric, interval)
          if (!response.more || moved === undefined || moved === latest) break
        } catch (error) {
          if (stopped) return
          log(
            `analytics unavailable (${productId} ${metric} ${interval} ms): ${describe(error)}`,
          )
          break
        }
      }
  }
  const scheduleAnalyticsPoll = (): void => {
    if (stopped || !analytics) return
    const now = clock()
    const delay =
      analytics.pollMs ?? 60_000 - (now % 60_000) + ANALYTICS_POLL_OFFSET_MS
    analyticsTimer = setTimeout(() => {
      analyticsPoll = guardedAnalytics().finally(scheduleAnalyticsPoll)
    }, delay)
  }

  const tickerProducts = products
    .map(({ productId }) => productId)
    .filter((productId) => productId !== FUTURES_PRODUCT)
  const tickerPeriodMs = options.tickerPollMs ?? 0
  let lastTickerError: string | undefined
  const pollTickers = async (): Promise<void> => {
    if (stopped || tickerClient === undefined) return
    try {
      for (const event of await tickerClient.fetch(tickerProducts)) {
        if (stopped) return
        store.append(event)
      }
      lastTickerError = undefined
    } catch (error) {
      if (stopped) return
      const text = describe(error)
      if (text !== lastTickerError) log(`tickers unavailable: ${text}`)
      lastTickerError = text
    }
  }
  const scheduleTickerPoll = (): void => {
    if (stopped || tickerPeriodMs <= 0) return
    tickerTimer = setTimeout(() => {
      tickerPoll = guardedTicker().finally(scheduleTickerPoll)
    }, tickerPeriodMs)
  }

  const startCollecting = (): void => {
    // The terminal only draws 60 s candles; verdicts read the official series.
    const candles = new FuturesCandleBuilder(store, [
      CAPTURE_CANDLE_INTERVAL_MS,
    ])
    // Candle errors are logged once per distinct message, not per trade.
    let lastCandleError: string | undefined
    const logCandleError = (label: string, error: unknown): void => {
      const text = `${label}: ${describe(error)}`
      if (text === lastCandleError) return
      lastCandleError = text
      log(text)
    }
    // Resume candles a previous capture process left open on this database.
    candles.restoreOpenCandles(clock())
    candleTimer = setInterval(() => {
      try {
        candles.advanceClock(clock())
      } catch (error) {
        logCandleError('candle clock failed', error)
      }
    }, options.candleTickMs ?? 1_000)
    fundingClient = createHistoricalFundingClient({
      fetch: options.fundingFetch,
      clock,
    })
    // Newest period start Kraken has listed so far (drives the post-boundary retry).
    let latestFundingStart = 0
    const pollFunding = async (): Promise<void> => {
      try {
        const response = await fundingClient!.fetch()
        const { newPeriods } = store.appendNewFundingKnowledge(response)
        if (newPeriods > 0) log(`funding +${newPeriods} period(s)`)
        for (const record of response.records)
          latestFundingStart = Math.max(latestFundingStart, record.startMs)
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError'))
          log(`funding unavailable: ${describe(error)}`)
      }
      // The other pinned perpetuals: each one is best effort and never blocks BTC.
      for (const { productId } of products) {
        if (productId === FUTURES_PRODUCT || stopped) continue
        try {
          const response = await fundingClient!.fetch(undefined, productId)
          const { newPeriods } = store.appendNewFundingKnowledge(
            response,
            productId,
          )
          if (newPeriods > 0)
            log(`funding ${productId} +${newPeriods} period(s)`)
        } catch (error) {
          if (!(error instanceof Error && error.name === 'AbortError'))
            log(`funding ${productId} unavailable: ${describe(error)}`)
        }
      }
    }
    let fundingRetries = 0
    const scheduleFundingPoll = (): void => {
      if (stopped) return
      const now = clock()
      const currentHour = now - (now % HOUR_MS)
      let delay: number
      if (options.fundingPollMs !== undefined) delay = options.fundingPollMs
      else if (
        latestFundingStart < currentHour &&
        now - currentHour < 10 * 60_000 &&
        fundingRetries < FUNDING_MAX_RETRIES
      ) {
        // Just after a boundary and the new hour is not listed yet.
        fundingRetries += 1
        delay = FUNDING_RETRY_MS
      } else {
        fundingRetries = 0
        delay = HOUR_MS - (now % HOUR_MS) + FUNDING_POLL_OFFSET_MS
      }
      fundingTimer = setTimeout(() => {
        fundingPoll = pollFunding().then(scheduleFundingPoll)
      }, delay)
    }
    fundingPoll = pollFunding().then(scheduleFundingPoll)
    collector = new KrakenFuturesMarketCollector({
      clock,
      random: Math.random,
      makeSocket: options.makeSocket,
      setTimeout,
      clearTimeout,
      // Nothing downstream consumes the order book (execution fills from the
      // ticker, verdicts from official candles): do not subscribe to it.
      bookFeed: false,
      staleAfterMs: options.staleAfterMs,
      reconnectMinMs: options.reconnectMinMs,
      reconnectMaxMs: options.reconnectMaxMs,
      silenceMs: options.silenceMs,
      dataSilenceMs: options.dataSilenceMs,
      connectTimeoutMs: options.connectTimeoutMs,
      watchdogIntervalMs: options.watchdogIntervalMs,
      onResilience: (event) =>
        note({
          component: 'websocket',
          product: FUTURES_PRODUCT,
          ...event,
        }),
      // Every event is its own committed transaction: never batched or dropped.
      persist: (event) => {
        const inserted = store.append(event)
        // The event is already committed. A candle revision failure must
        // never fail the market event, or the collector would stop capturing.
        if (inserted === 'inserted' && event.type === 'trade') {
          try {
            candles.addTrade(event, event.receivedAt)
          } catch (error) {
            logCandleError('candle revision failed', error)
          }
        }
        return inserted
      },
      persistGap: (gap) => store.appendGap(gap),
      onState: (state, reason) => log(`${state}${reason ? ` ${reason}` : ''}`),
    })
    collector.start()
    officialClient = createOfficialCandlesClient({
      fetch: options.officialCandlesFetch,
      clock,
      freshConnections: () => health.freshConnections(),
      onRecovered: (productId) =>
        note({
          component: 'rest-candles',
          product: productId,
          reason: 'request_ok',
          action: 'new_connection_next_request',
          result: 'recovered',
        }),
      onFailure: (reason, productId) =>
        note({
          component: 'rest-candles',
          product: productId,
          reason,
          action: 'new_connection_next_request',
          result: 'recovering',
        }),
    })
    officialPoll = guardedOfficial().finally(scheduleOfficialPoll)
    if (tickerProducts.length > 0 && tickerPeriodMs > 0) {
      tickerClient = createTickerPollClient({
        fetch: options.tickerFetch,
        clock,
        freshConnections: () => health.freshConnections(),
        onRecovered: () =>
          note({
            component: 'rest-tickers',
            product: null,
            reason: 'request_ok',
            action: 'new_connection_next_request',
            result: 'recovered',
          }),
        onFailure: (reason) =>
          note({
            component: 'rest-tickers',
            product: null,
            reason,
            action: 'new_connection_next_request',
            result: 'recovering',
          }),
      })
      tickerPoll = guardedTicker().finally(scheduleTickerPoll)
    }
    if (analytics) {
      analyticsClient = createAnalyticsClient({ fetch: analytics.fetch, clock })
      analyticsPoll = guardedAnalytics().finally(scheduleAnalyticsPoll)
    }
  }

  const attemptCatalog = async (): Promise<void> => {
    catalogTimer = undefined
    if (stopped) return
    try {
      const raw = await options.fetchCatalog()
      const spec = validateInstrumentCatalog(raw, {
        source: 'live',
        retrievedAt: clock(),
      })
      if (stopped) return
      store.saveInstrument(spec, raw)
      if (spec.entryEligibility !== 'eligible') {
        log(`catalog ${spec.entryEligibility}; retrying`)
        scheduleCatalogRetry()
        return
      }
      log(`catalog eligible metadata_hash=${spec.metadataHash}`)
      for (const warning of catalogProductWarnings(raw, products))
        log(`catalog warning: ${warning}`)
      startCollecting()
    } catch (error) {
      log(`catalog unavailable: ${describe(error)}; retrying`)
      scheduleCatalogRetry()
    }
  }
  const scheduleCatalogRetry = (): void => {
    if (stopped) return
    catalogTimer = setTimeout(
      () => void attemptCatalog(),
      options.catalogRetryMs ?? 10_000,
    )
  }

  return {
    async start(): Promise<void> {
      if (!stopped) return
      stopped = false
      store.saveQualityPolicy(PAPER_MARKET_QUALITY_POLICY, clock())
      await attemptCatalog()
    },
    async stop(): Promise<void> {
      stopped = true
      if (catalogTimer !== undefined) clearTimeout(catalogTimer)
      if (candleTimer !== undefined) clearInterval(candleTimer)
      if (fundingTimer !== undefined) clearTimeout(fundingTimer)
      if (officialTimer !== undefined) clearTimeout(officialTimer)
      if (analyticsTimer !== undefined) clearTimeout(analyticsTimer)
      if (tickerTimer !== undefined) clearTimeout(tickerTimer)
      for (const wake of [...sleepers]) wake()
      collector?.stop()
      fundingClient?.close()
      officialClient?.close()
      analyticsClient?.close()
      tickerClient?.close()
      catalogTimer =
        candleTimer =
        fundingTimer =
        officialTimer =
        analyticsTimer =
        tickerTimer =
          undefined
      await fundingPoll.catch(() => undefined)
      await officialPoll.catch(() => undefined)
      await analyticsPoll.catch(() => undefined)
      await tickerPoll.catch(() => undefined)
    },
    get collector(): KrakenFuturesMarketCollector | undefined {
      return collector
    },
    get health(): ConnectionHealth {
      return health
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
