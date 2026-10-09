import { readFileSync } from 'node:fs'
import { FuturesMarketStore } from './futures-market-store.ts'
import { createHistoricalFundingClient } from './historical-funding.ts'

// Usage: pnpm --dir server funding:backfill [--db path] [--products PF_XBTUSD,PF_ETHUSD]
// Kraken lists about one year of hourly funding per perpetual in one public response.
// Stores it for the pinned products (config/futures-products.json); a re-run only adds
// the periods not yet known. Use a run's own DB, or stop capture first (single writer).
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dbPath =
  flag('--db') ??
  process.env.FUTURES_MARKET_DB_PATH ??
  './data/dev-live/futures-market.sqlite'
const pinned = JSON.parse(
  readFileSync(
    new URL('../../../../config/futures-products.json', import.meta.url),
    'utf8',
  ),
) as { products: { product_id: string }[] }
const products =
  flag('--products')?.split(',') ?? pinned.products.map((p) => p.product_id)
const store = new FuturesMarketStore(dbPath)
const client = createHistoricalFundingClient({
  clock: () => Date.now(),
  timeoutMs: 30_000,
})
try {
  for (const productId of products) {
    const response = await client.fetch(undefined, productId)
    const { newPeriods } = store.appendNewFundingKnowledge(response, productId)
    const first = response.records[0]?.startMs
    const last = response.records.at(-1)?.startMs
    console.log(
      `[funding:backfill] ${productId}: ${response.records.length} periods listed (${first === undefined ? '-' : new Date(first).toISOString()} .. ${last === undefined ? '-' : new Date(last).toISOString()}), ${newPeriods} new`,
    )
  }
} finally {
  client.close()
  store.close()
}
