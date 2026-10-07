import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildLiveGateway } from '../features/live-gateway/gateway.ts'
import { seedMockMarket } from '../features/kraken-futures/mock-market.ts'

/**
 * Dev MOCK terminal: seeds a recorded-looking market into its own DBs, runs the
 * real verdict service C and paper execution D over it (`--once`) and serves the
 * same read-only gateway as live, frozen at the end of the seeded data. No
 * legacy engine and no network.
 */
function pythonFrom(env: NodeJS.ProcessEnv): string[] | null {
  try {
    const parsed: unknown = JSON.parse(env.BALANCITA_PYTHON_COMMAND ?? 'null')
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((part) => typeof part === 'string')
      ? (parsed as string[])
      : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const directory = process.env.MOCK_DATA_DIR ?? './data/dev-mock'
  const port = Number(process.env.PORT ?? 8788)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  const marketDb = join(directory, 'market.sqlite')
  const verdictsDb = join(directory, 'verdicts.sqlite')
  const accountDb = join(directory, 'account.sqlite')
  const endMs = Date.now()
  const seeded = seedMockMarket(marketDb, { endMs })
  const python = pythonFrom(process.env)
  if (python) {
    const [command, ...prefix] = python
    const run = (module: string, args: string[]) =>
      execFileSync(command!, [...prefix, '-m', module, ...args], {
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
      })
    run('balancita_engine.futures_verdicts', [
      '--market-db',
      marketDb,
      '--verdicts-db',
      verdictsDb,
      '--products',
      'PF_XBTUSD',
      '--once',
    ])
    run('balancita_engine.futures_paper_execution', [
      '--market-db',
      marketDb,
      '--verdicts-db',
      verdictsDb,
      '--account-db',
      accountDb,
      '--once',
    ])
  }
  const frozenNow = seeded.lastBucket + 60_000 + 3_000
  const app = await buildLiveGateway({
    marketDbPath: marketDb,
    ...(python ? { accountDbPath: accountDb, verdictsDbPath: verdictsDb } : {}),
    engineUnavailableReason: python ? undefined : 'python_unavailable',
    mode: 'mock',
    // Frozen at the end of the seeded market so it never reads as stale.
    clock: () => frozenNow,
    allowedOrigins: [
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
      process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    ],
  })
  const shutdown = () => void app.close().then(() => process.exit(0))
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port })
  console.log(
    `[mock] listening on http://127.0.0.1:${port} (${seeded.bars} seeded minutes${python ? ', C and D replayed' : ', engine off'})`,
  )
}

main().catch((error) => {
  console.error('[mock] failed to start', error)
  process.exitCode = 1
})
