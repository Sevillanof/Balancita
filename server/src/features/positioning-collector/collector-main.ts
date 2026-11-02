import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serverConfigFrom } from '../../platform/config.ts'
import { defaultBackupDir } from '../../platform/sqlite-safety.ts'
import {
  archiveDirFromEnv,
  archiveModeFromEnv,
  requireOffsiteFromEnv,
} from '../archive-prune/archive-env.ts'
import {
  createArchivePruner,
  makeBackupGuard,
  recentWakeFromState,
  runArchiveCycle,
} from '../archive-prune/archive-pruner.ts'
import { POSITIONING_TABLES } from '../archive-prune/archive-tables.ts'
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
// Borrado de lo ya archivado en Parquet (solo posicionamiento y premium; este proceso es el dueño de esta base).
// APAGADO salvo FUTURES_ARCHIVE_DELETE=1 (o =dry-run). Copia diaria buena y despertar se leen de db-health-state.json de la captura.
const archiveMode = archiveModeFromEnv(process.env)
const marketDbPath = serverConfigFrom(process.env).futuresMarketDbPath
const healthStatePath = join(dirname(marketDbPath), 'db-health-state.json')
const archivePruner = createArchivePruner({
  db: store.db,
  archiveDir: archiveDirFromEnv(process.env),
  specs: POSITIONING_TABLES,
  mode: archiveMode,
  requireOffsite: requireOffsiteFromEnv(process.env),
  backupOk: makeBackupGuard({
    backupDir:
      process.env.FUTURES_DB_BACKUP_DIR ?? defaultBackupDir(marketDbPath),
    name: 'positioning',
    statePath: healthStatePath,
  }),
  record: (entry) => {
    try {
      appendFileSync(
        join(dirname(out), 'retention.jsonl'),
        `${JSON.stringify({ db: 'positioning', ...entry })}\n`,
      )
    } catch {
      // Diagnostics never take the collector down.
    }
  },
})
let archiveRunning = false
if (archiveMode !== 'off') {
  log(`archive delete: ${archiveMode}`)
  const archiveTimer = setInterval(() => {
    if (archiveRunning || closing) return
    archiveRunning = true
    void runArchiveCycle(archivePruner, {
      canRun: () =>
        !closing && !recentWakeFromState(healthStatePath, Date.now()),
    })
      .catch((error: unknown) => log(`archive delete failed: ${String(error)}`))
      .finally(() => {
        archiveRunning = false
      })
  }, 30_000)
  archiveTimer.unref()
}
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
