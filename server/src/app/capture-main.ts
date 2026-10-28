import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDbHealth } from '../features/kraken-futures/db-health.ts'
import { createRetentionRunner } from '../features/kraken-futures/retention-runner.ts'
import { createLoopMonitor } from '../features/live-gateway/loop-monitor.ts'
import { createLiveCapture } from '../features/live-gateway/live-capture.ts'
import type { FuturesSocket } from '../features/kraken-futures/futures-market.ts'
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
  const store = new FuturesMarketStore(config.futuresMarketDbPath)
  const log = (line: string) =>
    process.stderr.write(`${new Date().toISOString()} [capture] ${line}\n`)
  const capture = createLiveCapture({
    store,
    makeSocket: (url) => new WebSocket(url) as unknown as FuturesSocket,
    fetchCatalog: fetchPublicCatalog,
    products,
    // Quote, sizes and funding of the other pinned products (paper execution trades them).
    tickerPollMs: 1_000,
    // Terminal chart: 15m/1h/4h/1d candles and Kraken's public analytics.
    chartCandleIntervals: CHART_CANDLE_INTERVALS,
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
  const retention = {
    tickerRetentionMs: envNumber('FUTURES_TICKER_RETENTION_HOURS', 24) * HOUR,
    eventRetentionMs: envNumber('FUTURES_EVENT_RETENTION_DAYS', 7) * 24 * HOUR,
    rawKeepMs: envNumber('FUTURES_RAW_COPY_KEEP_HOURS', 24) * HOUR,
  }
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
  const retentionRunner = createRetentionRunner({
    store,
    policy: retention,
    mode: legacyRetention ? 'legacy' : 'incremental',
    onCycle: (cycle) => {
      appendJson('retention.jsonl', cycle)
      if (cycle.deleted > 0 || cycle.slimmed > 0)
        log(
          `retention: ${cycle.deleted} old events removed, ${cycle.slimmed} compacted in ${cycle.steps} step(s), longest ${Math.round(cycle.maxStepMs)} ms${cycle.done ? '' : ' (more pending)'}`,
        )
    },
  })
  const trim = () => {
    void retentionRunner.run().catch((error: unknown) => {
      log(
        `retention failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
  const trimTimer = setInterval(trim, legacyRetention ? 120_000 : 15_000)
  trimTimer.unref()
  // WAL folded back every 5 min, integrity check daily (own process); optional backups
  // (FUTURES_DB_BACKUP_DAYS > 0 keeps the last FUTURES_DB_BACKUP_KEEP in FUTURES_DB_BACKUP_DIR).
  const backupDays = envNumber('FUTURES_DB_BACKUP_DAYS', 0)
  const dbHealth = createDbHealth({
    store,
    dbPath: config.futuresMarketDbPath,
    log,
    record: (entry) => appendJson('health.jsonl', entry),
    backupMs: backupDays * 24 * HOUR,
    backupDir:
      process.env.FUTURES_DB_BACKUP_DIR ??
      join(diagnosticsDir, 'market-backups'),
    backupKeep: envNumber('FUTURES_DB_BACKUP_KEEP', 2),
  })
  dbHealth.start()
  setTimeout(() => void dbHealth.integrityNow(), 10 * 60_000).unref()
  // Worst timer delay per minute: tells a blocked or sleeping process from a network problem.
  const loopMonitor = createLoopMonitor({
    file: join(diagnosticsDir, 'eventloop.jsonl'),
    log,
  })
  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    log(`received ${signal}, stopping`)
    retentionRunner.stop()
    dbHealth.stop()
    loopMonitor.stop()
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
