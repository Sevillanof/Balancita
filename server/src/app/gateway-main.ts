import { buildLiveGateway } from '../features/live-gateway/gateway.ts'
import {
  createQwenScores,
  qwenScoresOff,
} from '../features/live-gateway/qwen-scores.ts'
import { serverConfigFrom } from '../platform/config.ts'

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

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)
  // Read-only: opens the capture process's market DB, starts no collector/engine.
  const app = await buildLiveGateway({
    marketDbPath: config.futuresMarketDbPath,
    // Optional read-only views of C's verdicts and D's account (unset: engine off).
    accountDbPath: process.env.FUTURES_PAPER_ACCOUNT_DB_PATH || undefined,
    verdictsDbPath: process.env.FUTURES_VERDICTS_DB_PATH || undefined,
    // `pnpm run dev` found no usable Python: C and D are not running.
    engineUnavailableReason: pythonUnavailableReason(
      process.env.BALANCITA_PYTHON_STATUS,
    ),
    qwenScores: qwenScoresFrom(process.env),
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
