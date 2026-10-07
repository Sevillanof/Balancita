import { readFileSync } from 'node:fs'
import { FuturesMarketStore } from './futures-market-store.ts'
import { backfillOfficialCandles } from './official-candles-backfill.ts'
import { createOfficialCandlesClient } from './official-candles.ts'

// Usage: pnpm --dir server candles:backfill --days 90 [--db path] [--products PF_XBTUSD,PF_ETHUSD]
// Fills official 1m and 5m candles for the pinned products (config/futures-products.json).
// Resumable; use a run's own DB, or stop capture first (single writer).
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dbPath =
  flag('--db') ??
  process.env.FUTURES_MARKET_DB_PATH ??
  './data/dev-live/futures-market.sqlite'
const days = Number(flag('--days') ?? 90)
const toMs = flag('--to') ? Date.parse(flag('--to')!) : Date.now() - 120_000
const fromMs = flag('--from') ? Date.parse(flag('--from')!) : toMs - days * 86_400_000
const pinned = JSON.parse(
  readFileSync(
    new URL('../../../../config/futures-products.json', import.meta.url),
    'utf8',
  ),
) as { products: { product_id: string }[] }
const products = (flag('--products')?.split(',') ??
  pinned.products.map((p) => p.product_id))
const store = new FuturesMarketStore(dbPath)
const client = createOfficialCandlesClient({ timeoutMs: 30_000 })
try {
  for (const productId of products)
    for (const intervalMs of [300_000, 60_000]) {
      const result = await backfillOfficialCandles({
        store,
        client,
        productId,
        intervalMs,
        fromMs,
        toMs,
        onProgress: (line) => console.log(`[candles:backfill] ${line}`),
      })
      console.log(
        `[candles:backfill] ${productId} ${intervalMs / 60_000}m: ${result.inserted} inserted, ${result.requests} requests, ${result.skippedWindows} windows already complete`,
      )
    }
} finally {
  client.close()
  store.close()
}
