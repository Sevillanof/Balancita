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
  }),
)
