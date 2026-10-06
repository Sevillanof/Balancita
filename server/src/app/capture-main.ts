import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import { createLiveCapture } from '../features/live-gateway/live-capture.ts'
import type { FuturesSocket } from '../features/kraken-futures/futures-market.ts'
import { serverConfigFrom } from '../platform/config.ts'

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
  const store = new FuturesMarketStore(config.futuresMarketDbPath)
  const log = (line: string) =>
    process.stderr.write(`${new Date().toISOString()} [capture] ${line}\n`)
  const capture = createLiveCapture({
    store,
    makeSocket: (url) => new WebSocket(url) as unknown as FuturesSocket,
    fetchCatalog: fetchPublicCatalog,
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
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  await capture.start()
  log(`capturing into ${config.futuresMarketDbPath}`)
}

main().catch((error) => {
  console.error('[capture] failed to start', error)
  process.exitCode = 1
})
