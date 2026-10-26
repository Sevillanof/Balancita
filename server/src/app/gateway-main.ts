import { dirname, join } from 'node:path'
import { createSystemUsage } from '../features/live-gateway/system-usage.ts'
import { buildLiveGateway } from '../features/live-gateway/gateway.ts'
import {
  createQwenScores,
  qwenScoresOff,
} from '../features/live-gateway/qwen-scores.ts'
import { createQwenDecisions } from '../features/live-gateway/qwen-decisions.ts'
import { createKronosScores } from '../features/live-gateway/kronos-scores.ts'
import { createObservabilityHealth } from '../features/live-gateway/observability-health.ts'
import { createObservabilityActivity } from '../features/live-gateway/observability-activity.ts'
import { loadPinnedProducts } from '../features/kraken-futures/futures-products.ts'
import { serverConfigFrom } from '../platform/config.ts'
import { createMovements } from '../features/live-gateway/movements.ts'
import { qwenExitOffFromEnv } from '../features/live-gateway/qwen-exit-off.ts'

function pythonUnavailableReason(status: string | undefined) {
  if (status === 'sqlite_too_old') return 'python_sqlite_too_old'
  return status === 'unavailable' ? 'python_unavailable' : undefined
}

/** Qwen's scores need Python plus Q's decisions DB and C's verdicts DB. */
function qwenScoresFrom(env: NodeJS.ProcessEnv) {
  const decisionsDbPath = env.FUTURES_DECISIONS_DB_PATH
  const verdictsDbPath = env.FUTURES_VERDICTS_DB_PATH
  if (!decisionsDbPath || !verdictsDbPath)
    return qwenScoresOff('decisions_not_configured')
  let python: unknown
  try {
    python = JSON.parse(env.BALANCITA_PYTHON_COMMAND ?? 'null')
  } catch {
    python = null
  }
  if (
    !Array.isArray(python) ||
    python.length === 0 ||
    !python.every((part) => typeof part === 'string')
  )
    return qwenScoresOff('python_unavailable')
  return createQwenScores({
    python: python as string[],
    decisionsDbPath,
    verdictsDbPath,
    env,
  })
}

/** Kronos' DB sits next to its summary unless `KRONOS_DB_PATH` says otherwise. */
function kronosScoresFrom(env: NodeJS.ProcessEnv) {
  const dbPath =
    env.KRONOS_DB_PATH?.trim() ||
    (env.KRONOS_SUMMARY_PATH?.trim()
      ? join(dirname(env.KRONOS_SUMMARY_PATH.trim()), 'kronos.sqlite')
      : '')
  return dbPath
    ? createKronosScores({ dbPath })
    : qwenScoresOff('kronos_not_configured')
}

/** Both models' own DBs, read-only, for the movements list. */
function movementsFrom(env: NodeJS.ProcessEnv) {
  const beside = (summary: string | undefined, file: string) =>
    summary?.trim() ? join(dirname(summary.trim()), file) : undefined
  return createMovements({
    qwenExitDbPath:
      env.QWEN_EXIT_DB_PATH?.trim() ||
      beside(env.QWEN_EXIT_SUMMARY_PATH, 'qwen-exit.sqlite'),
    kronosDbPath:
      env.KRONOS_DB_PATH?.trim() ||
      beside(env.KRONOS_SUMMARY_PATH, 'kronos.sqlite'),
  })
}

/** Product ids the forward runner iterates: `FUTURES_PRODUCTS`, else the pinned list. */
function forwardProducts(env: NodeJS.ProcessEnv): string[] {
  const listed = (env.FUTURES_PRODUCTS ?? '')
    .split(',')
    .map((entry) => entry.trim().split(':')[0] ?? '')
    .filter(Boolean)
  return listed.length > 0
    ? listed
    : loadPinnedProducts().map((p) => p.productId)
}

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)
  // Read-only: opens the capture process's market DB, starts no collector/engine.
  const app = await buildLiveGateway({
    marketDbPath: config.futuresMarketDbPath,
    positioningDbPath: process.env.POSITIONING_DB_PATH?.trim() || undefined,
    // Optional read-only views of C's verdicts and D's account (unset: engine off).
    accountDbPath: process.env.FUTURES_PAPER_ACCOUNT_DB_PATH || undefined,
    verdictsDbPath: process.env.FUTURES_VERDICTS_DB_PATH || undefined,
    // `pnpm run dev` found no usable Python: C and D are not running.
    engineUnavailableReason: pythonUnavailableReason(
      process.env.BALANCITA_PYTHON_STATUS,
    ),
    qwenScores: qwenScoresFrom(process.env),
    qwenDecisions: createQwenDecisions({
      liveDbPath: process.env.QWEN_LIVE_DB_PATH || undefined,
    }),
    kronosScores: kronosScoresFrom(process.env),
    movements: movementsFrom(process.env),
    processHealthPath: process.env.DEV_HEALTH_FILE || undefined,
    // Read-only health of six components: every source is optional and a
    // missing one is reported as «Sin datos», never as healthy.
    observabilityHealth: createObservabilityHealth({
      products: loadPinnedProducts().map((p) => p.productId),
      marketDbPath: config.futuresMarketDbPath,
      verdictsDbPath: process.env.FUTURES_VERDICTS_DB_PATH || undefined,
      decisionsDbPath: process.env.FUTURES_DECISIONS_DB_PATH || undefined,
      forwardDbPath: process.env.FUTURES_FORWARD_DB_PATH || undefined,
      strategiesDbPath: process.env.FUTURES_STRATEGIES_DB_PATH || undefined,
      forwardRegistrationPath:
        process.env.FUTURES_FORWARD_REGISTRATION_PATH || undefined,
      strategySpecsDir: process.env.FUTURES_STRATEGY_SPECS_DIR || undefined,
      // The forward runner iterates FUTURES_PRODUCTS, else the pinned list.
      forwardProducts: forwardProducts(process.env),
      processHealthPath: process.env.DEV_HEALTH_FILE || undefined,
      qwenExitSummaryPath: process.env.QWEN_EXIT_SUMMARY_PATH || undefined,
      qwenExitOff: qwenExitOffFromEnv(process.env),
      kronosSummaryPath: process.env.KRONOS_SUMMARY_PATH || undefined,
      resilienceLogPath: join(
        dirname(config.futuresMarketDbPath),
        'resilience.jsonl',
      ),
      staleAfterMs: config.marketStaleAfterMs,
    }),
    // Same read-only sources as the health report, counted over 3 h / 24 h.
    observabilityActivity: createObservabilityActivity({
      products: loadPinnedProducts().map((p) => p.productId),
      verdictsDbPath: process.env.FUTURES_VERDICTS_DB_PATH || undefined,
      forwardDbPath: process.env.FUTURES_FORWARD_DB_PATH || undefined,
      strategiesDbPath: process.env.FUTURES_STRATEGIES_DB_PATH || undefined,
      forwardRegistrationPath:
        process.env.FUTURES_FORWARD_REGISTRATION_PATH || undefined,
      strategySpecsDir: process.env.FUTURES_STRATEGY_SPECS_DIR || undefined,
      forwardProducts: forwardProducts(process.env),
    }),
    systemUsage: createSystemUsage({
      healthPath: process.env.DEV_HEALTH_FILE || undefined,
      dataDir: process.env.DEV_DATA_DIR || undefined,
      decisionsDbPath: process.env.FUTURES_DECISIONS_DB_PATH || undefined,
      qwenExitSummaryPath: process.env.QWEN_EXIT_SUMMARY_PATH || undefined,
      kronosSummaryPath: process.env.KRONOS_SUMMARY_PATH || undefined,
    }),
    staleAfterMs: config.marketStaleAfterMs,
    allowedOrigins: [
      config.corsOrigin,
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
    ],
  })
  const shutdown = (signal: string) => {
    console.log(`[live-gateway] received ${signal}, shutting down...`)
    void app.close().then(() => process.exit(0))
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  await app.listen({ host: config.host, port: config.port })
  console.log(
    `[live-gateway] listening on http://${config.host}:${config.port} (read-only ${config.futuresMarketDbPath})`,
  )
}

main().catch((error) => {
  console.error('[live-gateway] failed to start', error)
  process.exitCode = 1
})
