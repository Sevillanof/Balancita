import { fileURLToPath } from 'node:url'
import { acquireWriterLock } from '../../platform/writer-lock.ts'
import { resolveFuturesProducts } from '../kraken-futures/futures-products.ts'
import { DEFAULT_CATALOG_URL, loadCatalog } from './catalog.ts'
import { PositioningCollector } from './collector.ts'
import { createPositioningSource } from './source.ts'
import { PositioningStore } from './store.ts'

// Usage: pnpm --dir server positioning:collect [--out ./data/positioning/positioning.sqlite]
// Public Kraken Futures charts only (no credentials). Own database and writer lock.
// First pass downloads the history; then it polls every minute. Stops cleanly on SIGINT/SIGTERM.
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const out =
  flag('--out') ??
  process.env.POSITIONING_DB_PATH ??
  './data/positioning/positioning.sqlite'
const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} [positioning] ${line}\n`)
}
const lock = acquireWriterLock(out)
const store = new PositioningStore(out)
store.startRun(Date.now())
const collector = new PositioningCollector({
  store,
  source: createPositioningSource(),
  catalog: loadCatalog(
    process.env.INDICATORS_CATALOG_PATH ?? fileURLToPath(DEFAULT_CATALOG_URL),
    resolveFuturesProducts(process.env).map((p) => p.productId),
  ),
  log,
})
let timer: ReturnType<typeof setTimeout> | undefined
let running: Promise<void> = Promise.resolve()
let closing = false
const tick = (): void => {
  running = collector
    .syncOnce()
    .then((failures) => {
      if (failures > 0) log(`${failures} series failed; retrying next minute`)
    })
    .catch((error: unknown) => log(`pass failed: ${String(error)}`))
    .finally(() => {
      if (closing) return
      const now = Date.now()
      timer = setTimeout(tick, 60_000 - (now % 60_000) + 10_000)
    })
}
async function shutdown(reason: string): Promise<void> {
  if (closing) return
  closing = true
  if (timer) clearTimeout(timer)
  collector.stop()
  await running
  store.stopRun(Date.now(), reason)
  store.close()
  lock.release()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void shutdown(`signal ${signal}`))
log(`writing ${out}`)
tick()
