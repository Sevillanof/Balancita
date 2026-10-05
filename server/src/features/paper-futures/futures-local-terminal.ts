import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerTerminalStream } from '../terminal-stream/terminal-stream.js'
import { FuturesCommandRunner } from './futures-command-runner.js'
import { FuturesStore } from './futures-store.js'
import { runLocalFuturesScenario } from './futures-local-scenario.js'

const fixturePath = new URL(
  './fixtures/local-protection.v1.json',
  import.meta.url,
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  unknown
>
const instrumentId = 'kraken-futures:PF_XBTUSD'
type TerminalEventInput = Parameters<
  FuturesStore['appendTerminalEvents']
>[1][number]

type LocalTerminalOptions = {
  port?: number
  outputDirectory?: string
  uiOrigin?: string
  pacingMs?: number
  wait?: (milliseconds: number) => Promise<void>
  onLog?: (line: string) => void
}

export type LocalTerminalHandle = {
  readonly apiUrl: string
  readonly outputDirectory: string
  readonly databasePath: string
  readonly runId: string
  readonly app: FastifyInstance
  close(): Promise<void>
}

export async function startLocalFuturesTerminal(
  options: LocalTerminalOptions = {},
): Promise<LocalTerminalHandle> {
  const port = options.port ?? 8787
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error('API port must be an integer between 0 and 65535.')
  const outputDirectory = options.outputDirectory
    ? resolve(options.outputDirectory)
    : mkdtempSync(join(tmpdir(), 'balancita-local-terminal-'))
  if (options.outputDirectory) {
    if (existsSync(outputDirectory))
      throw new Error(
        `Refusing existing terminal output path: ${outputDirectory}`,
      )
    mkdirSync(outputDirectory, { recursive: true })
  }
  const databasePath = join(outputDirectory, 'paper-futures.sqlite')
  const store = new FuturesStore(databasePath)
  const runner = new FuturesCommandRunner(store)
  const app = Fastify({ logger: false })
  const runId = String(fixture.run_id)
  const uiOrigin = options.uiOrigin ?? 'http://127.0.0.1:5174'
  let status = 'Escenario iniciado'
  let subscribed = false
  let closing = false
  let releaseSubscription: (() => void) | undefined
  let releaseClosing: (() => void) | undefined
  const subscription = new Promise<void>((resolveSubscription) => {
    releaseSubscription = resolveSubscription
  })
  const closingSignal = new Promise<void>((resolveClosing) => {
    releaseClosing = resolveClosing
  })
  const emitStatus = (scenarioStatus: string, message: string) => {
    status = message
    store.appendTerminalEvents(runId, [
      {
        type: 'engine.status',
        eventTime: Date.now(),
        data: { scenario_status: scenarioStatus, message },
      },
    ])
  }

  app.get('/api/terminal/bootstrap', async () => {
    store.getTerminalSnapshot(runId)
    const page = store.listTerminalEvents(runId, { afterSeq: 0, limit: 500 })
    const candles = new Map<number, Record<string, unknown>>()
    for (const event of page.events) {
      if (event.type !== 'market.updated') continue
      const candle = event.data.candle
      if (typeof candle !== 'object' || candle === null) continue
      const value = candle as Record<string, unknown>
      if (!Number.isSafeInteger(value.bucket_start_ms)) continue
      candles.set(Number(value.bucket_start_ms), {
        time_ms: value.bucket_start_ms,
        open: value.open,
        high: value.high,
        low: value.low,
        close: value.close,
        volume_btc: value.volume_btc,
        closed: value.closed,
      })
    }
    const latestMarket = [...page.events]
      .reverse()
      .find((event) => event.type === 'market.updated')
    return {
      schema_version: 1,
      mode: 'mock',
      source: 'local-protection.v1',
      active_run_id: runId,
      instrument_id: instrumentId,
      source_manifest: { source: 'local-protection.v1' },
      terminal_market: {
        schema_version: 'mock-terminal-market.v1',
        as_of_ms: latestMarket?.event_time ?? 0,
        interval_ms: 60_000,
        candles: [...candles.values()]
          .sort((left, right) => Number(left.time_ms) - Number(right.time_ms))
          .slice(-500),
      },
      market: latestMarket?.data ?? {},
      engine: { status: 'ready', scenario_status: status },
    }
  })

  registerTerminalStream(app, {
    store,
    runner,
    allowedOrigins: [uiOrigin],
    commandFactory: () => {
      throw new Error('local_demo_read_only')
    },
    afterSnapshot: async () => {
      if (subscribed) return
      subscribed = true
      setImmediate(() => {
        emitStatus('running', 'Escenario ejecutándose')
        releaseSubscription?.()
      })
    },
  })

  try {
    await app.listen({ host: '127.0.0.1', port })
  } catch (error) {
    await app.close()
    await runner.close()
    store.close()
    throw error
  }
  const address = app.server.address()
  if (!address || typeof address === 'string')
    throw new Error('API bind failed.')
  const actualPort = address.port

  const scenarioPromise = runLocalFuturesScenario(fixture as never, {
    outputDirectory,
    store,
    runner,
    onStage: async (stage) => {
      if (stage.kind === 'started') {
        await Promise.race([subscription, closingSignal])
        if (closing && !subscribed)
          throw new Error('local_terminal_closed_before_subscribe')
        return
      }
      if (stage.kind === 'committed') {
        if (closing) throw new Error('local_terminal_closed_during_scenario')
        const inputEvents = (stage.marketSnapshot?.events ?? []) as Record<
          string,
          unknown
        >[]
        const candleInputs = inputEvents.filter(
          (event) => event.type === 'candle' && event.interval_ms === 60_000,
        )
        const selectedCandles =
          stage.index === 0 ? candleInputs : candleInputs.slice(-1)
        const entries: TerminalEventInput[] = selectedCandles.map((candle) => ({
          type: 'market.updated',
          eventTime: Number(candle.event_time_ms),
          data: {
            market_status: 'open',
            last_received_at: Number(candle.received_at_ms),
            candle: {
              bucket_start_ms: candle.bucket_start_ms,
              interval_ms: candle.interval_ms,
              known_at_ms: candle.known_at_ms,
              closed: candle.closed,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume_btc: candle.volume_btc,
            },
          },
        }))
        if (entries.length) store.appendTerminalEvents(runId, entries)
        if (
          stage.index !== undefined &&
          stage.index < 4 &&
          (options.pacingMs ?? 3_500) > 0
        )
          await (options.wait ?? delay)(options.pacingMs ?? 3_500)
      }
      if (stage.kind === 'completed')
        emitStatus('completed', 'Escenario finalizado')
    },
  })
  void scenarioPromise.catch((error: unknown) => {
    if (closing) return
    const message = error instanceof Error ? error.message : String(error)
    try {
      emitStatus('failed', `Escenario fallido: ${message}`)
    } catch {
      options.onLog?.(`Scenario failed: ${message}`)
    }
  })

  options.onLog?.(
    `API http://127.0.0.1:${actualPort} · DB ${databasePath} · source local-protection.v1 · funding=0 fixture only`,
  )
  return {
    apiUrl: `http://127.0.0.1:${actualPort}`,
    outputDirectory,
    databasePath,
    runId,
    app,
    async close() {
      closing = true
      releaseClosing?.()
      await scenarioPromise.catch(() => undefined)
      await app.close()
      await runner.close()
      store.close()
    },
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
