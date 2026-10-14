/**
 * Seeds a throwaway sandbox where the REAL gateway engine follower emits
 * analyses: market DB (real schema, SYNTHETIC candles/ticker), a verdicts DB
 * with a known sequence of verdicts per product and a paper account DB with
 * no orders. Prints the environment the gateway needs plus the facts the
 * test checks, as JSON. Every number here is synthetic fixture data.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { FuturesMarketStore } from '../../server/src/features/kraken-futures/futures-market-store.ts'
import { loadPinnedProducts } from '../../server/src/features/kraken-futures/futures-products.ts'
import {
  MINUTE,
  sandbox,
} from '../../server/src/features/live-gateway/observability-health-fixtures.ts'
import {
  AccountDb,
  VerdictsDb,
} from '../../server/src/features/live-gateway/paper-engine-fixtures.ts'

const PRODUCTS = loadPinnedProducts().map((p) => p.productId)
const now = Date.now()
const box = sandbox()
const CANDLES = 120
const BASE_PRICE: Record<string, number> = {
  PF_XBTUSD: 100_000,
  PF_ETHUSD: 3_500,
}

// Candles: a smooth synthetic walk, ending at the last closed minute.
new FuturesMarketStore(box.marketDb).close()
const market = new DatabaseSync(box.marketDb)
const addResponse = market.prepare(
  `INSERT OR IGNORE INTO paper_futures_official_candle_responses
   (product_id,sha256,interval_ms,from_ms,to_ms,received_at,raw_response) VALUES(?,?,?,?,?,?,?)`,
)
const addCandle = market.prepare(
  `INSERT INTO paper_futures_official_candles
   (product_id,interval_ms,bucket_start,revision_hash,known_at,open_price,high_price,low_price,close_price,volume_btc,response_sha256)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
)
const lastClose = now - (now % MINUTE)
const last: Record<string, number> = {}
market.exec('BEGIN')
for (const product of PRODUCTS) {
  const base = BASE_PRICE[product] ?? 100
  for (let i = 0; i < CANDLES; i += 1) {
    const bucket = lastClose - (CANDLES - i) * MINUTE
    const sha = `${product}-${bucket}`
    const mid = base * (1 + 0.004 * Math.sin(i / 9) + 0.0004 * i)
    const open = mid * (1 - 0.0004)
    const close = mid * (1 + 0.0004)
    addResponse.run(
      product,
      sha,
      MINUTE,
      bucket,
      bucket + MINUTE,
      bucket + MINUTE + 3000,
      '{}',
    )
    addCandle.run(
      product,
      MINUTE,
      bucket,
      `r${bucket}`,
      bucket + MINUTE + 3000,
      open.toFixed(2),
      (Math.max(open, close) * 1.0006).toFixed(2),
      (Math.min(open, close) * 0.9994).toFixed(2),
      close.toFixed(2),
      '5',
      sha,
    )
    last[product] = close
  }
}
market.exec('COMMIT')
market.close()
const store = new FuturesMarketStore(box.marketDb)
for (const product of ['PF_XBTUSD', 'PF_ETHUSD']) {
  const price = (last[product] ?? 0).toFixed(2)
  store.append({
    type: 'ticker',
    productId: product,
    seq: 1,
    epoch: 7,
    eventTime: now - 2_000,
    receivedAt: now - 1_500,
    persistedAt: now - 1_500,
    last: price,
    mark: price,
    suspended: false,
    funding: { status: 'unknown' },
    raw: { feed: 'ticker' },
  })
}
store.close()

// Verdicts: the newest closed bucket is `latest`; `i` counts minutes back.
const closers: Array<() => void> = []
const verdicts = new VerdictsDb(box.dir, closers)
const account = new AccountDb(box.dir, closers)
const latest = now - (now % MINUTE) - 3 * MINUTE
const STOPPED_MINUTES: Record<string, number> = { PF_ZECUSD: 30 }
const bucketAt = (i: number) => latest - i * MINUTE
/** Planned non-WAIT verdicts by product (minutes back from the latest). */
const PLAN: Record<string, Record<number, 'LONG' | 'SHORT'>> = {
  PF_XBTUSD: { 7: 'LONG', 22: 'SHORT', 41: 'LONG' },
  PF_ETHUSD: { 0: 'SHORT', 15: 'LONG' },
  PF_ZECUSD: { 0: 'LONG' },
}
const facts: Record<string, unknown> = {}
for (const product of PRODUCTS) {
  const plan = PLAN[product] ?? {}
  // A product whose engine stopped long ago: its newest verdict is history.
  const at = (i: number) => bucketAt(i + (STOPPED_MINUTES[product] ?? 0))
  const summary: unknown[] = []
  for (let i = 89; i >= 0; i -= 1) {
    const action = plan[i] ?? 'WAIT'
    const reason =
      action === 'WAIT'
        ? 'no_directional_proposal'
        : action === 'LONG'
          ? 'c25_long_pullback'
          : 'c26_short_reversion'
    verdicts.add(
      at(i),
      action,
      {
        regime: product === 'PF_ETHUSD' ? 'range' : 'trend',
        reason_code: reason,
        selected: {
          action,
          strategy_id:
            action === 'WAIT'
              ? null
              : action === 'LONG'
                ? 'c25-pullback-perp-v1'
                : 'c26-reversion-perp-v1',
          reason_code: reason,
        },
        verdict_hash: `${product}-${at(i)}`,
      },
      product,
    )
    if (action !== 'WAIT' || i === 0)
      summary.push({
        action,
        reason,
        bucket: at(i),
        decisionTimeMs: at(i) + 63_000,
        analysisId: `${product}-${at(i)}`,
      })
  }
  facts[product] = summary
}
// A fresh snapshot makes the engine «running» without inventing any order.
account.snapshot(now - 5_000)
for (const close of closers) close()

console.log(
  JSON.stringify({
    dir: box.dir,
    FUTURES_MARKET_DB_PATH: box.marketDb,
    FUTURES_VERDICTS_DB_PATH: verdicts.path,
    FUTURES_PAPER_ACCOUNT_DB_PATH: join(box.dir, 'account.sqlite'),
    facts,
  }),
)
