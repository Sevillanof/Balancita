import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { createObservabilityActivity } from './observability-activity.ts'
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  seedForward,
  seedForwardTrades,
  seedStrategies,
  seedVerdictRows,
  writeForwardConfig,
  type VerdictRow,
} from './observability-health-fixtures.ts'

/**
 * Cost of one uncached activity report on a synthetic copy of the live data
 * sizes (never run against the capture's real files):
 *   node --experimental-strip-types src/features/live-gateway/observability-activity-bench.ts [--days 14]
 * Verdicts: `--days` of one row per product and minute with 4 KB payloads;
 * forward: 3 strategies x 8 products, history grown to ~480 000 trades. It also
 * measures reads while another connection keeps inserting verdicts (WAL).
 */
const arg = process.argv.indexOf('--days')
const days = arg > 0 ? Number(process.argv[arg + 1]) : 14
const NOW = Date.now()
const TO = NOW - (NOW % MINUTE)
const box = sandbox()

const t0 = performance.now()
const rows: VerdictRow[] = []
for (const product of PRODUCTS)
  for (let i = 0; i < days * 1440; i += 1)
    rows.push({
      product,
      bucket: TO - (i + 1) * MINUTE,
      action: i % 97 === 0 ? 'LONG' : i % 11 === 0 ? 'ABSTAIN' : 'WAIT',
      reason:
        i % 97 === 0
          ? 'c25_long_pullback'
          : i % 11 === 0
            ? 'conflicting_signals'
            : 'no_directional_proposal',
    })
seedVerdictRows(box.verdictsDb, rows, 4096)
seedForward(box.forwardDb, {
  now: NOW,
  strategies: ['C29', 'C30', 'C32'],
  checkedAgeMs: 300_000,
})
const trades = []
for (const strategy of ['C29', 'C30', 'C32'])
  for (const product of PRODUCTS)
    for (let i = 0; i < 20_016; i += 1)
      trades.push({ strategy, product, entry: TO - (i + 1) * 3 * MINUTE })
seedForwardTrades(box.forwardDb, trades)
seedStrategies(
  box.strategiesDb,
  ['C29', 'C30', 'C32'].map((id) => ({
    id,
    state: id === 'C32' ? 'deleted' : 'active',
  })),
  NOW,
)
writeForwardConfig(box, [], [])
console.log(
  `fixture built in ${((performance.now() - t0) / 1000).toFixed(1)} s; ` +
    `verdicts ${(statSync(box.verdictsDb).size / 1_048_576).toFixed(0)} MB (${rows.length} rows), ` +
    `forward ${(statSync(box.forwardDb).size / 1_048_576).toFixed(0)} MB (${trades.length} trades)`,
)

function measure(window: '3h' | '24h', runs: number, between?: () => void) {
  const times: number[] = []
  let failed = 0
  let clock = NOW
  for (let i = 0; i < runs; i += 1) {
    clock += 60_000
    const api = createObservabilityActivity({
      products: PRODUCTS,
      verdictsDbPath: box.verdictsDb,
      forwardDbPath: box.forwardDb,
      strategiesDbPath: box.strategiesDb,
      forwardRegistrationPath: box.registration,
      strategySpecsDir: box.specsDir,
      clock: () => clock,
    })
    between?.()
    const t = performance.now()
    const report = api.report(window)
    times.push(performance.now() - t)
    if (report.evaluations.state !== 'ok' || report.operations.state !== 'ok')
      failed += 1
  }
  times.sort((a, b) => a - b)
  const at = (q: number) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))]!
  return { p50: at(0.5), p95: at(0.95), max: times[times.length - 1]!, failed }
}
const fmt = (m: ReturnType<typeof measure>) =>
  `p50 ${m.p50.toFixed(1)} ms / p95 ${m.p95.toFixed(1)} ms / max ${m.max.toFixed(1)} ms, failed reads ${m.failed}`

measure('24h', 3)
console.log('window 3h  :', fmt(measure('3h', 60)))
console.log('window 24h :', fmt(measure('24h', 60)))

const writer = new DatabaseSync(box.verdictsDb)
writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
const insert = writer.prepare(
  'INSERT OR IGNORE INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)',
)
let n = 0
console.log(
  'window 24h, a writer inserting between reads :',
  fmt(
    measure('24h', 60, () => {
      for (const product of PRODUCTS) {
        n += 1
        insert.run(
          product,
          TO + n * MINUTE,
          MINUTE,
          TO,
          'range',
          'WAIT',
          'x',
          `w${n}`,
          '{}',
          TO,
        )
      }
    }),
  ),
)
writer.close()
