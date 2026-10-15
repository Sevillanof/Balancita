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
  // The base fixture's candle gets a price of the same order as the chart's.
  candlePrices: { open: '100.2', high: '100.9', low: '99.9', close: '100.5' },
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
// SYNTHETIC 1 m official candles of PF_XBTUSD for the decision context chart:
// the newest two minutes have none (a recent verdict has no candle yet), and
// four more minutes are holes. Invented numbers, drawn as example data.
const minuteHoles = [10, 11, 12, 50]
const shape = (i: number) => {
  const open = 100 + 0.8 * Math.sin((i + 1) / 4)
  const close = 100 + 0.8 * Math.sin(i / 4)
  return {
    open: open.toFixed(2),
    high: (Math.max(open, close) + 0.12 + 0.1 * (i % 4)).toFixed(2),
    low: (Math.min(open, close) - 0.12 - 0.1 * ((i + 2) % 4)).toFixed(2),
    close: close.toFixed(2),
  }
}
seedOfficialCandles(
  box.marketDb,
  Array.from({ length: 99 }, (_, i) => i + 2)
    .filter((i) => !minuteHoles.includes(i))
    .map((i) => ({
      product: 'PF_XBTUSD',
      intervalMs: MINUTE,
      bucket: bucket - i * MINUTE,
      ...shape(i),
    })),
)
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
    candlesLastBucket: lastQuarter,
    candlesHoles: candleHoles,
  }),
)
