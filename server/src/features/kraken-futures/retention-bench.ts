import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { FuturesMarketStore } from './futures-market-store.ts'
import { createRetentionRunner } from './retention-runner.ts'
import { acquireWriterLock } from '../../platform/writer-lock.ts'

/**
 * Measures how long retention holds the event loop on a COPY of the market database, before
 * (`--mode legacy`: one call of 20 batches of 5 000 rows) and after (`--mode incremental`).
 * `--shift-minutes M` pretends M minutes have passed, so the rows that would expire in that time are
 * the workload (default 2: what the old 120 s timer found each time). Never point it at the live
 * database: it takes the writer lock and refuses while capture is running.
 *
 *   pnpm --dir server retention:bench --db <copy.sqlite> --mode legacy|incremental [--shift-minutes 2]
 */
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dbPath = flag('--db')
if (!dbPath || !existsSync(dbPath)) {
  console.error(
    'usage: retention:bench --db <copy of the market db> [--mode legacy|incremental] [--shift-minutes 2]',
  )
  process.exit(2)
}
const mode = flag('--mode') === 'legacy' ? 'legacy' : 'incremental'
const shiftMs = Number(flag('--shift-minutes') ?? 2) * 60_000
const H = 3_600_000
const count = (): number => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM paper_futures_market_events')
    .get() as { n: number }
  db.close()
  return Number(row.n)
}

const lock = acquireWriterLock(dbPath)
try {
  const rowsBefore = count()
  const store = new FuturesMarketStore(dbPath)
  // How late a 5 ms timer fires while retention runs: the stall the capture's own sockets would see.
  let last = performance.now()
  let maxStallMs = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    maxStallMs = Math.max(maxStallMs, now - last - 5)
    last = now
  }, 5)
  const runner = createRetentionRunner({
    store,
    mode,
    policy: {
      tickerRetentionMs: 24 * H,
      eventRetentionMs: 7 * 24 * H,
      rawKeepMs: 24 * H,
    },
    clock: () => Date.now() + shiftMs,
  })
  const started = performance.now()
  last = started
  const cycle = await runner.run()
  const wallMs = performance.now() - started
  // Let the sampler observe a stall that ended just now before it is switched off.
  await new Promise((resolve) => setTimeout(resolve, 30))
  clearInterval(ticker)
  store.close()
  console.log(
    JSON.stringify(
      {
        mode,
        shiftMinutes: shiftMs / 60_000,
        rowsBefore,
        rowsAfter: count(),
        wallMs: Math.round(wallMs),
        maxLoopStallMs: Math.round(maxStallMs),
        cycle,
      },
      null,
      2,
    ),
  )
} finally {
  lock.release()
}
