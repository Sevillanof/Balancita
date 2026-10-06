import {
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
  readonly fundingPollMs?: number
  readonly catalogRetryMs?: number
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
  let fundingTimer: ReturnType<typeof setInterval> | undefined
  let catalogTimer: ReturnType<typeof setTimeout> | undefined
  let fundingClient:
    ReturnType<typeof createHistoricalFundingClient> | undefined
  let stopped = true
  let fundingPoll: Promise<void> = Promise.resolve()

  const startCollecting = (): void => {
    const candles = new FuturesCandleBuilder(store)
    candleTimer = setInterval(() => {
      try {
        candles.advanceClock(clock())
      } catch (error) {
        log(`candle clock failed: ${describe(error)}`)
      }
    }, options.candleTickMs ?? 1_000)
    fundingClient = createHistoricalFundingClient({
      fetch: options.fundingFetch,
      clock,
    })
    const pollFunding = async (): Promise<void> => {
      try {
        store.appendFundingResponse(await fundingClient!.fetch())
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError'))
          log(`funding unavailable: ${describe(error)}`)
      }
    }
    fundingPoll = pollFunding()
    fundingTimer = setInterval(() => {
      fundingPoll = pollFunding()
    }, options.fundingPollMs ?? 300_000)
    collector = new KrakenFuturesMarketCollector({
      clock,
      random: Math.random,
      makeSocket: options.makeSocket,
      setTimeout,
      clearTimeout,
      staleAfterMs: options.staleAfterMs,
      reconnectMinMs: options.reconnectMinMs,
      reconnectMaxMs: options.reconnectMaxMs,
      // Every event is its own committed transaction: never batched or dropped.
      persist: (event) => {
        const inserted = store.append(event)
        if (inserted === 'inserted' && event.type === 'trade')
          candles.addTrade(event, event.receivedAt)
        return inserted
      },
      persistGap: (gap) => store.appendGap(gap),
      onState: (state, reason) => log(`${state}${reason ? ` ${reason}` : ''}`),
    })
    collector.start()
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
      if (fundingTimer !== undefined) clearInterval(fundingTimer)
      collector?.stop()
      fundingClient?.close()
      catalogTimer = candleTimer = fundingTimer = undefined
      await fundingPoll.catch(() => undefined)
    },
    get collector(): KrakenFuturesMarketCollector | undefined {
      return collector
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
