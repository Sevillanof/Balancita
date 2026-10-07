import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import { createLiveCapture } from '../features/live-gateway/live-capture.ts'
import type { FuturesSocket } from '../features/kraken-futures/futures-market.ts'
import { resolveFuturesProducts } from '../features/kraken-futures/futures-products.ts'
import { CHART_CANDLE_INTERVALS } from '../features/kraken-futures/official-candles.ts'
import {
  ANALYTICS_INTERVALS,
  ANALYTICS_METRICS,
} from '../features/kraken-futures/market-analytics.ts'
import { serverConfigFrom } from '../platform/config.ts'
import { acquireWriterLock, WriterLockError } from '../platform/writer-lock.ts'

/** Public instrument catalog (no credentials); bounded by a 10 s timeout. */
async function fetchPublicCatalog(): Promise<unknown> {
  const response = await fetch(
    'https://futures.kraken.com/derivatives/api/v3/instruments',
    {
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/json',
        'user-agent': 'Balancita public futures market capture',
      },
    },
  )
  if (!response.ok)
    throw new Error(
      `Public futures instrument catalog HTTP ${response.status}.`,
    )
  return response.json()
}

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)
  if (typeof WebSocket === 'undefined')
    throw new Error('This Node runtime does not expose WebSocket.')
  // The sole writer of the live market database; no HTTP, engine or account DB.
  // Pinned list (config/futures-products.json or FUTURES_PRODUCTS): the same
  // one the Python services read, never chosen at runtime.
  const products = resolveFuturesProducts(process.env)
  // Refuse to start beside another live writer (duplicate rows, collisions);
  // readers (gateway, Python) never take this lock.
  const lock = acquireWriterLock(config.futuresMarketDbPath)
  process.once('exit', () => lock.release())
  const store = new FuturesMarketStore(config.futuresMarketDbPath)
  const log = (line: string) =>
    process.stderr.write(`${new Date().toISOString()} [capture] ${line}\n`)
  const capture = createLiveCapture({
    store,
    makeSocket: (url) => new WebSocket(url) as unknown as FuturesSocket,
    fetchCatalog: fetchPublicCatalog,
    products,
    // Terminal chart: 15m/1h/4h/1d candles and Kraken's public analytics.
    chartCandleIntervals: CHART_CANDLE_INTERVALS,
    // Order book depth and slippage of every pinned product: per-product costs.
    analytics: {
      metrics: ANALYTICS_METRICS,
      intervals: ANALYTICS_INTERVALS,
      allProductMetrics: ['orderbook'],
    },
    staleAfterMs: config.marketStaleAfterMs,
    reconnectMinMs: config.marketReconnectMinMs,
    reconnectMaxMs: config.marketReconnectMaxMs,
    log,
  })
  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    log(`received ${signal}, stopping`)
    void capture
      .stop()
      .then(() => store.close())
      .finally(() => {
        lock.release()
        process.exit(0)
      })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  await capture.start()
  log(
    `capturing into ${config.futuresMarketDbPath}; official candles for ${products
      .map((item) => `${item.productId} (tick ${item.tickSize})`)
      .join(', ')}`,
  )
}

main().catch((error) => {
  if (error instanceof WriterLockError) {
    console.error(`[capture] refusing to start: ${error.message}`)
    process.exitCode = 3
    return
  }
  console.error('[capture] failed to start', error)
  process.exitCode = 1
})
