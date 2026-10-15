/**
 * Seeds a throwaway sandbox for the real-gateway integration test: a market
 * DB with the real schema plus verdict rows, all under a temp folder. Prints
 * the environment the gateway needs as JSON. Synthetic fixture data.
 */
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  seedMarket,
  seedOfficialCandles,
  seedVerdictRows,
} from '../../server/src/features/live-gateway/observability-health-fixtures.ts'

const now = Date.now()
const box = sandbox()
const ages = Object.fromEntries(PRODUCTS.map((p) => [p, 20_000]))
seedMarket(box.marketDb, {
  now,
  tickerAgeMs: ages,
  candleAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 90_000])),
})
// B6: 40 synthetic closed 15 m official candles of PF_XBTUSD with two holes.
const QUARTER = 15 * MINUTE
const lastQuarter = now - (now % QUARTER) - QUARTER
const candleHoles = [5, 6, 20]
seedOfficialCandles(
  box.marketDb,
  Array.from({ length: 40 }, (_, i) => i)
    .filter((i) => !candleHoles.includes(i))
    .map((i) => ({
      product: 'PF_XBTUSD',
      intervalMs: QUARTER,
      bucket: lastQuarter - i * QUARTER,
      close: String(100 + i),
    })),
)
const bucket = now - (now % MINUTE) - MINUTE
seedVerdictRows(
  box.verdictsDb,
  PRODUCTS.flatMap((product) =>
    Array.from({ length: 30 }, (_, i) => ({
      product,
      bucket: bucket - i * MINUTE,
      action: product === 'PF_XBTUSD' && i === 5 ? 'LONG' : 'WAIT',
      reason:
        product === 'PF_XBTUSD' && i === 5
          ? 'c25_long_pullback'
          : 'no_directional_proposal',
    })),
  ),
)
console.log(
  JSON.stringify({
    dir: box.dir,
    FUTURES_MARKET_DB_PATH: box.marketDb,
    FUTURES_VERDICTS_DB_PATH: box.verdictsDb,
    candlesLastBucket: lastQuarter,
    candlesHoles: candleHoles,
  }),
)
