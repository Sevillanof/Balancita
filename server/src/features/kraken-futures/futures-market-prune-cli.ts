import {
  DEFAULT_RETENTION_DAYS,
  pruneMarketEvents,
  trimMarketDb,
  vacuumMarketDb,
} from './futures-market-prune.ts'

// Usage: pnpm --dir server market:prune [--days 7] [--db path] [--vacuum] (capture stopped)
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dbPath =
  flag('--db') ??
  process.env.FUTURES_MARKET_DB_PATH ??
  './data/dev-live/futures-market.sqlite'
const days = Number(flag('--days') ?? DEFAULT_RETENTION_DAYS)
const result = pruneMarketEvents(dbPath, { days })
console.log(
  `[market:prune] ${dbPath}: removed ${result.events} events (${result.bookSnapshots} book, ${result.tickerSnapshots} ticker snapshots) received before ${new Date(result.cutoffMs).toISOString()}`,
)
if (args.includes('--vacuum')) {
  const trimmed = trimMarketDb(dbPath)
  console.log(
    `[market:prune] retention: ${trimmed.deleted} old events removed, ${trimmed.slimmed} compacted`,
  )
  const { before, after } = vacuumMarketDb(dbPath)
  console.log(
    `[market:prune] vacuum: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB`,
  )
}
