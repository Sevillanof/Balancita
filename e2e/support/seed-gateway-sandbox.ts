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
} from '../../server/src/features/live-gateway/observability-health-fixtures.ts'
import {
  C25,
  seedSyntheticModelDecisions,
  seedSyntheticVerdicts,
} from '../../server/src/features/live-gateway/observability-decisions-fixtures.ts'

const now = Date.now()
const box = sandbox()
const ages = Object.fromEntries(PRODUCTS.map((p) => [p, 20_000]))
seedMarket(box.marketDb, {
  now,
  tickerAgeMs: ages,
  candleAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 90_000])),
})
const bucket = now - (now % MINUTE) - MINUTE
// SYNTHETIC verdicts (engine payload shape, invented numbers): the page shows
// them as example data. XBT has 120 minutes so the list needs a second page.
seedSyntheticVerdicts(
  box.verdictsDb,
  PRODUCTS.flatMap((product) =>
    Array.from({ length: product === 'PF_XBTUSD' ? 120 : 30 }, (_, i) => {
      const long = product === 'PF_XBTUSD' && i === 5
      return {
        product,
        bucket: bucket - i * MINUTE,
        action: long ? 'LONG' : 'WAIT',
        reason: long ? 'c25_long_pullback' : 'no_directional_proposal',
        ...(long ? { strategy: C25 } : {}),
      }
    }),
  ),
)
// One SYNTHETIC model row, for the minute of the synthetic LONG.
seedSyntheticModelDecisions(box.decisionsDb, [
  {
    product: 'PF_XBTUSD',
    bucket: bucket - 5 * MINUTE,
    chosen: 'LONG',
    confidence: 0.62,
  },
])
console.log(
  JSON.stringify({
    dir: box.dir,
    FUTURES_MARKET_DB_PATH: box.marketDb,
    FUTURES_VERDICTS_DB_PATH: box.verdictsDb,
    FUTURES_DECISIONS_DB_PATH: box.decisionsDb,
  }),
)
