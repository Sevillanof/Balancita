import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrderBookCollector, type BookSocket } from './collector.ts'
import { BookStore } from './store.ts'

// Usage: pnpm --dir server book:loadtest [--rate 2000] [--seconds 60] [--levels 1000]
// Synthetic feed through the real collector code (no network): reports throughput headroom,
// per-message and per-snapshot cost, memory and the database growth projected to 24 h.
const args = process.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const index = args.indexOf(name)
  return index >= 0 ? Number(args[index + 1]) : fallback
}
const rate = flag('--rate', 2000)
const seconds = flag('--seconds', 60)
const levels = flag('--levels', 1000)
const products = ['PF_XBTUSD', 'PF_ETHUSD']

const dir = mkdtempSync(join(tmpdir(), 'book-loadtest-'))
const path = join(dir, 'book.sqlite')
let clock = 1_800_000_000_000
const store = new BookStore(path)
const sent: string[] = []
const socket: BookSocket = {
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  send: (m) => void sent.push(m),
  close: () => {},
}
const collector = new OrderBookCollector({
  store,
  products,
  makeSocket: () => socket,
  now: () => clock,
  log: () => {},
  minFreeBytes: 0,
})
collector.start()
socket.onopen?.()

const seq = new Map<string, number>()
const base: Record<string, number> = { PF_XBTUSD: 90_000, PF_ETHUSD: 3_000 }
for (const product of products) {
  const mid = base[product]!
  const bids = Array.from({ length: levels }, (_, i) => ({
    price: mid - 0.5 - i * 0.5,
    qty: 1 + (i % 7),
  }))
  const asks = Array.from({ length: levels }, (_, i) => ({
    price: mid + 0.5 + i * 0.5,
    qty: 1 + (i % 5),
  }))
  seq.set(product, 1)
  collector.handleRaw(
    JSON.stringify({
      feed: 'book_snapshot',
      product_id: product,
      seq: 1,
      timestamp: clock,
      bids,
      asks,
    }),
  )
}

const total = rate * seconds
const started = performance.now()
let snapshots = 0
let snapshotMs = 0
for (let i = 0; i < total; i += 1) {
  const product = products[i % 2]!
  const n = seq.get(product)! + 1
  seq.set(product, n)
  const buy = i % 2 === 0
  const price =
    base[product]! +
    (buy ? -0.5 - (i % levels) * 0.5 : 0.5 + (i % levels) * 0.5)
  collector.handleRaw(
    JSON.stringify({
      feed: 'book',
      product_id: product,
      seq: n,
      side: buy ? 'buy' : 'sell',
      price,
      qty: i % 9 === 0 ? 0 : 1 + (i % 4),
      timestamp: clock,
    }),
  )
  if (i % rate === rate - 1) clock += 1000
  if (i % (rate * 5) === rate * 5 - 1) {
    const t = performance.now()
    collector.snapshotNow()
    snapshotMs += performance.now() - t
    snapshots += 1
  }
}
const elapsedS = (performance.now() - started) / 1000
collector.housekeeping()
const rows = (
  store.db.prepare('SELECT COUNT(*) AS n FROM book_depth').get() as {
    n: number
  }
).n
const bytes = statSync(path).size
const perDay = (bytes / Math.max(1, rows)) * (86_400 / 5) * products.length
console.log(
  JSON.stringify(
    {
      messages: total,
      processed_per_second: Math.round(total / elapsedS),
      cpu_share_at_rate: Number((rate / (total / elapsedS)).toFixed(3)),
      snapshot_ms_mean: Number(
        (snapshotMs / Math.max(1, snapshots)).toFixed(2),
      ),
      rss_mb: Math.round(process.memoryUsage().rss / 1_048_576),
      rows_stored: rows,
      db_mb: Number((bytes / 1_048_576).toFixed(2)),
      projected_mb_per_day: Number((perDay / 1_048_576).toFixed(1)),
      resubscribes: sent.length - 1,
    },
    null,
    2,
  ),
)
collector.stop('loadtest done')
store.close()
rmSync(dir, { recursive: true, force: true })
