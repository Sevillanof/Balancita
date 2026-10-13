import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { createObservabilityHealth } from './observability-health.ts'
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  seedDecisions,
  seedForward,
  seedMarket,
  seedStrategies,
  seedVerdicts,
  writeForwardConfig,
  writeHealthFile,
} from './observability-health-fixtures.ts'

/**
 * Cost of one uncached health report on a synthetic copy of the live data
 * sizes (never run against the capture's real files):
 *   node --experimental-strip-types src/features/live-gateway/observability-health-bench.ts [--scale 1]
 * `--scale 1`: 24 h of 1 s tickers for 8 products, 7 d of PF_XBTUSD trades,
 * 10 d of 1 min candles and 30 d of verdicts. It also reports reads that run
 * while another connection keeps writing (WAL), counting any failed read.
 */
const arg = process.argv.indexOf('--scale')
const scale = arg > 0 ? Number(process.argv[arg + 1]) : 1
const NOW = Date.now()
const box = sandbox()

const t0 = performance.now()
seedMarket(box.marketDb, {
  now: NOW,
  tickerAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 1_000])),
  candleAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 20_000])),
  historyTickersPerProduct: Math.round(86_400 * scale),
  historyTradesXbt: Math.round(300_000 * scale),
  historyCandlesPerProduct: Math.round(14_400 * scale),
  payloadBytes: 900,
  gaps: [{ product: 'PF_ETHUSD', ageMs: 5 * 3_600_000 }],
})
seedVerdicts(box.verdictsDb, {
  now: NOW,
  newestAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 20_000])),
  perProduct: Math.round(43_200 * scale),
})
seedForward(box.forwardDb, {
  now: NOW,
  strategies: ['C29', 'C30', 'C32'],
  checkedAgeMs: 300_000,
  trades: 200,
})
seedStrategies(
  box.strategiesDb,
  [
    { id: 'C29', state: 'active' },
    { id: 'C30', state: 'active' },
    { id: 'C32', state: 'active' },
  ],
  NOW,
)
writeForwardConfig(box, [], [])
seedDecisions(box.decisionsDb, [60_000, 120_000], NOW)
writeHealthFile(box.healthFile, NOW, {
  capture: 'running',
  verdict: 'running',
  forward: 'running',
  strategies: 'running',
})
const marketMb =
  (await import('node:fs')).statSync(box.marketDb).size / 1_048_576
console.log(
  `fixture built in ${((performance.now() - t0) / 1000).toFixed(1)} s; market DB ${marketMb.toFixed(0)} MB`,
)

function measure(runs: number, between?: () => void) {
  const times: number[] = []
  let failed = 0
  let clock = NOW
  for (let i = 0; i < runs; i += 1) {
    between?.()
    clock += 20_000 // past the 15 s cache: every call computes
    const health = createObservabilityHealth({
      products: PRODUCTS,
      marketDbPath: box.marketDb,
      verdictsDbPath: box.verdictsDb,
      decisionsDbPath: box.decisionsDb,
      forwardDbPath: box.forwardDb,
      strategiesDbPath: box.strategiesDb,
      forwardRegistrationPath: box.registration,
      strategySpecsDir: box.specsDir,
      processHealthPath: box.healthFile,
      clock: () => clock,
    })
    const start = performance.now()
    const report = health.report()
    times.push(performance.now() - start)
    if (
      report.components.some((c) =>
        c.evidence.some((e) => e.state === 'unreadable'),
      )
    )
      failed += 1
  }
  times.sort((a, b) => a - b)
  const at = (q: number) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))]!
  return { runs, p50: at(0.5), p95: at(0.95), max: times.at(-1)!, failed }
}

const row = (label: string, r: ReturnType<typeof measure>) =>
  console.log(
    `${label.padEnd(34)} runs=${r.runs} p50=${r.p50.toFixed(1)} ms p95=${r.p95.toFixed(1)} ms max=${r.max.toFixed(1)} ms unreadable=${r.failed}`,
  )

measure(3) // warm the page cache like a running gateway would
row('uncached report (idle writer)', measure(40))

const writer = new DatabaseSync(box.marketDb)
writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL')
const insert = writer.prepare(
  `INSERT INTO paper_futures_market_events (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,raw_json,normalized_json,content_hash)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
)
let n = 0
row(
  'uncached report (writer inserting)',
  measure(40, () => {
    writer.exec('BEGIN')
    for (let i = 0; i < 2_000; i += 1) {
      n += 1
      insert.run(
        `w${n}`,
        'ticker',
        PRODUCTS[n % 8]!,
        1_000_000,
        10_000_000 + n,
        NOW,
        NOW,
        NOW,
        null,
        '{}',
        '{}',
        `wh${n}`,
      )
    }
    writer.exec('COMMIT')
  }),
)
writer.close()

// The trade history must not move the latency: grow forward_trade to ~480 000 rows.
const history = new DatabaseSync(box.forwardDb)
const before = (
  history.prepare('SELECT COUNT(*) AS n FROM forward_trade').get() as {
    n: number
  }
).n
history.exec('BEGIN')
const trade = history.prepare(
  'INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)',
)
for (const strategy of ['C29', 'C30', 'C32'])
  for (const product of PRODUCTS)
    for (let i = 0; i < 20_000; i += 1)
      trade.run(
        strategy,
        product,
        NOW - (i + 1000) * MINUTE,
        'h',
        '{"net_bp":1.5,"pnl_usd":0.01}',
      )
history.exec('COMMIT')
const after = (
  history.prepare('SELECT COUNT(*) AS n FROM forward_trade').get() as {
    n: number
  }
).n
history.close()
console.log(`forward_trade grown from ${before} to ${after} rows`)
row(
  'uncached report (trade history x' +
    Math.round(after / Math.max(before, 1)) +
    ')',
  measure(40),
)
console.log(
  `cache: one report per ${15} s at most, i.e. ≤ ${(3600 / 15).toFixed(0)} computations/hour regardless of clients; interval ${MINUTE / 1000} s verdict cadence`,
)
rmSync(box.dir, { recursive: true, force: true })
