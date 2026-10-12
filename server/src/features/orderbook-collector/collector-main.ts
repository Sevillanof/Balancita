import { acquireWriterLock } from '../../platform/writer-lock.ts'
import { OrderBookCollector, type BookSocket } from './collector.ts'
import { BookStore } from './store.ts'

// Usage: pnpm --dir server book:collect [--out p] [--products PF_XBTUSD,PF_ETHUSD] [--snapshot-s 5]
//        [--max-days 14] [--max-mb 400] [--min-free-gb 5]
// Public feed, no credentials. Own database and lock. Stops cleanly on SIGINT/SIGTERM.
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
if (typeof WebSocket === 'undefined')
  throw new Error('This Node runtime does not expose WebSocket.')
const out = flag('--out') ?? './data/book/book.sqlite'
const products = (flag('--products') ?? 'PF_XBTUSD,PF_ETHUSD').split(',')
const lock = acquireWriterLock(out)
const store = new BookStore(out)
const collector = new OrderBookCollector({
  store,
  products,
  makeSocket: (url) => new WebSocket(url) as unknown as BookSocket,
  snapshotMs: Number(flag('--snapshot-s') ?? 5) * 1000,
  maxDays: Number(flag('--max-days') ?? 14),
  maxBytes: Number(flag('--max-mb') ?? 400) * 1_048_576,
  minFreeBytes: Number(flag('--min-free-gb') ?? 5) * 1_073_741_824,
  onStop: () => shutdown(2),
})
function shutdown(code: number) {
  collector.stop('signal or limit')
  store.close()
  lock.release()
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => shutdown(0))
collector.start()
