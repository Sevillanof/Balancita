import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDbHealth } from '../features/kraken-futures/db-health.ts'
import {
  backupTargetsFromEnv,
  integrityFromEnv,
} from '../features/kraken-futures/db-health-env.ts'
import {
  createRetentionRunner,
  RETENTION_CYCLE_BUDGET_MS,
  RETENTION_INTERVAL_MS,
} from '../features/kraken-futures/retention-runner.ts'
import {
  captureSavingsFromEnv,
  retentionFromEnv,
} from '../features/kraken-futures/capture-savings.ts'
import { archiveModeFromEnv } from '../features/archive-prune/archive-env.ts'
import { createWakeGuard } from '../features/kraken-futures/wake-guard.ts'
import { retryWithBackoff } from '../features/kraken-futures/retry-backoff.ts'
import {
  defaultBackupDir,
  isMalformedError,
} from '../platform/sqlite-safety.ts'
import { createWakeDetector } from '../platform/wake-detector.ts'
import { createLoopMonitor } from '../features/live-gateway/loop-monitor.ts'
import { createLiveCapture } from '../features/live-gateway/live-capture.ts'
import { wireEthMinuteSummary } from '../features/market-summary/eth-summary-wiring.ts'
import {
  MARKET_EVENT_PRODUCTS,
  type FuturesSocket,
} from '../features/kraken-futures/futures-market.ts'
import { resolveFuturesProducts } from '../features/kraken-futures/futures-products.ts'
import { CHART_CANDLE_INTERVALS } from '../features/kraken-futures/official-candles.ts'
import {
  ANALYTICS_INTERVALS,
  ANALYTICS_METRICS,
} from '../features/kraken-futures/market-analytics.ts'
import { serverConfigFrom } from '../platform/config.ts'
import { acquireWriterLock, WriterLockError } from '../platform/writer-lock.ts'

/** Public instrument catalog (no credentials); bounded by a 10 s timeout. */
async function fetchPublicCatalog(): Promise<unknown> {
  const response = await fetch(
    'https://futures.kraken.com/derivatives/api/v3/instruments',
    {
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/json',
        'user-agent': 'Balancita public futures market capture',
      },
    },
  )
  if (!response.ok)
    throw new Error(
      `Public futures instrument catalog HTTP ${response.status}.`,
    )
  return response.json()
}

const HOUR_MS = 3_600_000

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)
  if (typeof WebSocket === 'undefined')
    throw new Error('This Node runtime does not expose WebSocket.')
  // The sole writer of the live market database; no HTTP, engine or account DB.
  // Pinned list (config/futures-products.json or FUTURES_PRODUCTS): the same
  // one the Python services read, never chosen at runtime.
  const products = resolveFuturesProducts(process.env)
  // Refuse to start beside another live writer (duplicate rows, collisions);
  // readers (gateway, Python) never take this lock.
  const lock = acquireWriterLock(config.futuresMarketDbPath)
  process.once('exit', () => lock.release())
  // "Save less" switches, OFF unless their variable is set, except the funding body, which defaults to
  // FUTURES_FUNDING_BODY=none (short body; capture-savings.ts, docs/funding-cuerpo-respuestas.md).
  const savings = captureSavingsFromEnv(process.env)
  // docs/operacion-base-de-datos.md: NORMAL by default; FUTURES_DB_SYNCHRONOUS=full fsyncs every commit.
  const store = new FuturesMarketStore(config.futuresMarketDbPath, {
    savings,
    synchronous:
      process.env.FUTURES_DB_SYNCHRONOUS?.toLowerCase() === 'full'
        ? 'FULL'
        : 'NORMAL',
  })
  // Set once the health keeper exists: a log line that says "malformed" marks the database as damaged.
  const hooks: { onMalformed?: (line: string) => void } = {}
  const log = (line: string) => {
    process.stderr.write(`${new Date().toISOString()} [capture] ${line}\n`)
    if (isMalformedError(line) && !/database health/i.test(line))
      hooks.onMalformed?.(line)
  }
  const capture = createLiveCapture({
    store,
    makeSocket: (url) => new WebSocket(url) as unknown as FuturesSocket,
    // Kraken answers badly for a while after the machine wakes up: retry with backoff.
    fetchCatalog: () =>
      retryWithBackoff(fetchPublicCatalog, {
        attempts: 4,
        onRetry: (attempt, delayMs, error) =>
          log(
            `catalog query failed (try ${attempt}), retrying in ${delayMs} ms: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
    products,
    // Raw market events (tickers, trades, books) only for the products in MARKET_EVENT_PRODUCTS (datos-utiles S5):
    // PF_ETHUSD (operated) and PF_XBTUSD (default terminal product, observed candles). The other pinned products
    // keep official candles, funding and analytics below.
    eventProducts: MARKET_EVENT_PRODUCTS,
    // ETH over its own WebSocket: every trade stored, the book as a trimmed snapshot every 30 s
    // (never the deltas), both read by the per-minute summary (docs/resumen-minuto-eth.md).
    // BTC keeps its trades-and-ticker socket exactly as before.
    extraMarketFeed: { productId: 'PF_ETHUSD' },
    // Quote, sizes and funding by REST of the captured products other than BTC (today: ETH).
    tickerPollMs: 1_000,
    // Terminal chart: 15m/1h/4h/1d candles and Kraken's public analytics (ETH and BTC).
    chartCandleIntervals: CHART_CANDLE_INTERVALS,
    chartCandleProducts: ['PF_ETHUSD'],
    // Order book depth and slippage of every pinned product: per-product costs.
    analytics: {
      metrics: ANALYTICS_METRICS,
      intervals: ANALYTICS_INTERVALS,
      // ETH gets the same flow, open interest, liquidations and positioning as BTC.
      alsoProducts: ['PF_ETHUSD'],
      allProductMetrics: ['orderbook'],
    },
    // After a stop the hole is fetched from the last stored bucket; this also repairs holes a
    // longer stop left behind (the forward measurement replays these candles).
    officialRepairMs: 10 * 24 * HOUR_MS,
    staleAfterMs: config.marketStaleAfterMs,
    reconnectMinMs: config.marketReconnectMinMs,
    reconnectMaxMs: config.marketReconnectMaxMs,
    // Connection incidents and recoveries (reason, source, time, result), one JSON per line.
    resilienceLogFile: join(
      dirname(config.futuresMarketDbPath),
      'resilience.jsonl',
    ),
    log,
  })
  // Online retention (the capture is the sole writer): see trimRawEvents.
  const HOUR = 3_600_000
  const envNumber = (name: string, fallback: number): number => {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  // Tickers and the raw copy: 48 h by default (capture-savings.ts), so one daily copy holds the whole day.
  const retention = retentionFromEnv(process.env)
  const diagnosticsDir = dirname(config.futuresMarketDbPath)
  const appendJson = (file: string, value: unknown): void => {
    try {
      appendFileSync(join(diagnosticsDir, file), `${JSON.stringify(value)}\n`)
    } catch {
      // Diagnostics never take the capture down.
    }
  }
  // The delete is synchronous (node:sqlite): it runs in small steps with the event loop free in between.
  // FUTURES_RETENTION_MODE=legacy restores the former single call, only to measure before/after.
  const legacyRetention = process.env.FUTURES_RETENTION_MODE === 'legacy'
  // Cleanup also waits while a backup is being made, while the database is known damaged
  // and for ten minutes after a wake-up (see wake-guard.ts).
  const retentionRunner = createRetentionRunner({
    store,
    policy: retention,
    checkpoint: () => store.checkpoint(),
    canRun: () => dbHealth.writesAllowed() && !dbHealth.backupBusy(),
    cycleBudgetMs: RETENTION_CYCLE_BUDGET_MS,
    mode: legacyRetention ? 'legacy' : 'incremental',
    // Switch FUTURES_CANDLE_REVISIONS_COMPACT (off by default): settled candles keep first, last and closed revisions.
    ...(savings.candleCompaction && !legacyRetention
      ? {
          candles: {
            step: () =>
              store.compactCandleRevisions({
                now: Date.now(),
                settleMs: savings.candleCompaction!.settleMs,
              }),
          },
        }
      : {}),
    onCycle: (cycle) => {
      appendJson('retention.jsonl', cycle)
      if ((cycle.candleRevisionsCompacted ?? 0) > 0)
        log(
          `retention: ${cycle.candleRevisionsCompacted} intermediate candle revisions removed`,
        )
      if (cycle.deleted > 0 || cycle.slimmed > 0)
        log(
          `retention: ${cycle.deleted} old events removed, ${cycle.slimmed} compacted in ${cycle.steps} step(s), longest ${Math.round(cycle.maxStepMs)} ms${cycle.done ? '' : ' (more pending)'}`,
        )
    },
  })
  // Borrado de lo ya archivado (features/archive-prune): la captura es dueña SOLO de futures-market.sqlite, y su única tabla
  // archivada (market_events) ya la recorta la retención de arriba y tiene triggers; el resto de las tablas archivadas
  // las escriben otros procesos (Python, el recolector de posicionamiento) y se borran, si corresponde, desde ellos.
  // Por eso aquí no se engancha ningún borrado por archivo; el hook `archive` del runner queda listo para cuando haya una tabla.
  if (archiveModeFromEnv(process.env) !== 'off')
    log(
      'archive delete: la captura no es dueña de ninguna tabla borrable por archivo (market_events ya tiene su retención); ver docs/operacion-base-de-datos.md',
    )
  const trim = () => {
    void retentionRunner.run().catch((error: unknown) => {
      log(
        `retention failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
  const trimTimer = setInterval(
    trim,
    legacyRetention ? 120_000 : RETENTION_INTERVAL_MS,
  )
  trimTimer.unref()
  // WAL folded back every 5 min, integrity check every 6 h (own process, FUTURES_DB_INTEGRITY_MINUTES and
  // _TIMEOUT_MINUTES), one backup a day of the paper's small databases (FUTURES_DB_BACKUP_DAYS, _KEEP, _DIR).
  // futures-market is NOT copied here unless FUTURES_DB_BACKUP_MARKET=1: ops/vps copies it every night.
  const backupDays = envNumber('FUTURES_DB_BACKUP_DAYS', 1)
  const backupTargets = backupTargetsFromEnv({
    env: process.env,
    marketDbPath: config.futuresMarketDbPath,
  })
  const dbHealth = createDbHealth({
    store,
    dbPath: config.futuresMarketDbPath,
    log,
    record: (entry) => appendJson('health.jsonl', entry),
    statePath: join(diagnosticsDir, 'db-health-state.json'),
    ...integrityFromEnv(process.env),
    backupTargets,
    backupMs: backupDays * 24 * HOUR,
    backupDir:
      process.env.FUTURES_DB_BACKUP_DIR ??
      defaultBackupDir(config.futuresMarketDbPath),
    backupKeep: envNumber('FUTURES_DB_BACKUP_KEEP', 3),
    isRetentionBusy: () => retentionRunner.running,
  })
  hooks.onMalformed = (line) => dbHealth.reportMalformed(line)
  dbHealth.start()
  setTimeout(() => void dbHealth.integrityNow(), 2 * 60_000).unref()
  // One row per closed minute of PF_ETHUSD (datos-utiles S4), derived from the events above. Started
  // after the capture; it waits while a backup runs or the database is known damaged, and its failures only log.
  const ethSummary = wireEthMinuteSummary({
    dbPath: config.futuresMarketDbPath,
    canRun: () => dbHealth.writesAllowed() && !dbHealth.backupBusy(),
    log,
  })
  // Worst timer delay per minute: tells a blocked or sleeping process from a network problem.
  const loopMonitor = createLoopMonitor({
    file: join(diagnosticsDir, 'eventloop.jsonl'),
    log,
  })
  // The Mac sleeps now and then: when it wakes, pause the cleanup, truncate the WAL and check the
  // database before heavy writes resume, and log a «despertar» in resilience.jsonl.
  const wakeGuard = createWakeGuard({
    retention: retentionRunner,
    dbHealth,
    connections: capture.health,
    log,
  })
  const wakeDetector = createWakeDetector({
    onWake: (event) => void wakeGuard.onWake(event),
  })
  wakeDetector.start()
  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    log(`received ${signal}, stopping`)
    retentionRunner.stop()
    dbHealth.stop()
    wakeDetector.stop()
    loopMonitor.stop()
    ethSummary.stop()
    void capture
      .stop()
      .then(() => store.close())
      .finally(() => {
        lock.release()
        process.exit(0)
      })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  await capture.start()
  ethSummary.start()
  setTimeout(trim, 30_000).unref()
  log(
    `capturing into ${config.futuresMarketDbPath}; official candles for ${products
      .map((item) => `${item.productId} (tick ${item.tickSize})`)
      .join(', ')}`,
  )
}

main().catch((error) => {
  if (error instanceof WriterLockError) {
    console.error(`[capture] refusing to start: ${error.message}`)
    process.exitCode = 3
    return
  }
  console.error('[capture] failed to start', error)
  process.exitCode = 1
})
