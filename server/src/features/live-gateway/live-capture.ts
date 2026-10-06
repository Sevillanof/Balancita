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
import {
  createOfficialCandlesClient,
  OFFICIAL_CANDLE_INTERVALS,
  OFFICIAL_CANDLES_PER_REQUEST,
} from '../kraken-futures/official-candles.ts'

/** Backfill depth per interval: enough history for 5m indicator warm-up. */
const OFFICIAL_LOOKBACK_MS: Readonly<Record<number, number>> = {
  60_000: 24 * 3_600_000,
  300_000: 3 * 24 * 3_600_000,
}
/** Poll this long after each minute boundary so the closed candle settled. */
const OFFICIAL_POLL_OFFSET_MS = 3_000
/**
 * Pause between two official-candle requests. 8 products x 2 intervals is 16
 * requests a minute at most (about 3 a minute per product on average, since 5m
 * is polled every fifth minute): spacing them keeps the public charts API far
 * from any rate limit and spreads the load instead of bursting it.
 */
const OFFICIAL_REQUEST_GAP_MS = 250
const HOUR_MS = 3_600_000
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
  readonly log?: (line: string) => void
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
  let collector: KrakenFuturesMarketCollector | undefined
  let candleTimer: ReturnType<typeof setInterval> | undefined
  let fundingTimer: ReturnType<typeof setTimeout> | undefined
  let catalogTimer: ReturnType<typeof setTimeout> | undefined
  let fundingClient:
    ReturnType<typeof createHistoricalFundingClient> | undefined
  let officialTimer: ReturnType<typeof setTimeout> | undefined
  let officialClient: ReturnType<typeof createOfficialCandlesClient> | undefined
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
    ...options.officialCandleLookbackMs,
  }

  // Official Kraken candles are the canonical series for verdicts: backfill
  // on start, then fetch each newly closed bucket.
  const pollOfficialCandles = async (): Promise<void> => {
    let requested = false
    // One product after another, 5m before 1m within each (OFFICIAL_CANDLE_INTERVALS).
    for (const { productId } of products)
      for (const interval of OFFICIAL_CANDLE_INTERVALS) {
        if (stopped || officialClient === undefined) return
        const due = (): number | undefined => {
          const now = clock()
          const latest = store.latestOfficialBucket(productId, interval)
          // The bucket after the latest stored one has not closed yet.
          if (latest !== undefined && latest + 2 * interval > now)
            return undefined
          return Math.max(
            latest === undefined ? 0 : latest + interval,
            now - (lookbacks[interval] ?? OFFICIAL_LOOKBACK_MS[interval]!),
            now - OFFICIAL_CANDLES_PER_REQUEST * interval,
          )
        }
        if (due() === undefined) continue
        if (requested) await pause(requestGapMs)
        if (stopped || officialClient === undefined) return
        // Recomputed after the pause: the clock and the stored data moved on.
        const from = due()
        if (from === undefined) continue
        requested = true
        try {
          store.appendOfficialCandles(
            await officialClient.fetch(productId, interval, from, clock()),
          )
        } catch (error) {
          if (stopped) return
          log(
            `official candles unavailable (${productId} ${interval} ms): ${describe(error)}`,
          )
        }
      }
  }
  const scheduleOfficialPoll = (): void => {
    if (stopped) return
    const now = clock()
    const delay =
      options.officialPollMs ??
      60_000 - (now % 60_000) + OFFICIAL_POLL_OFFSET_MS
    officialTimer = setTimeout(() => {
      officialPoll = pollOfficialCandles().finally(scheduleOfficialPoll)
    }, delay)
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
    })
    officialPoll = pollOfficialCandles().finally(scheduleOfficialPoll)
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
      for (const wake of [...sleepers]) wake()
      collector?.stop()
      fundingClient?.close()
      officialClient?.close()
      catalogTimer = candleTimer = fundingTimer = officialTimer = undefined
      await fundingPoll.catch(() => undefined)
      await officialPoll.catch(() => undefined)
    },
    get collector(): KrakenFuturesMarketCollector | undefined {
      return collector
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
