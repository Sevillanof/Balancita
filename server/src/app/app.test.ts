import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalysisCache } from '../platform/cache.ts'
import { serverConfigFrom } from '../platform/config.ts'
import type {
  GeminiClient,
  GeminiGenerateParams,
} from '../platform/gemini/gemini-client.ts'
import { AnalysisRateLimiter } from '../platform/limits.ts'
import { buildApp } from './app.ts'
import type {
  FuturesSourceQueueEvent,
  ForecastLoopScheduler,
  MarketCollectorLifecycle,
  OhlcCollectorLifecycle,
  MarketRestFetch,
} from './app.ts'
import type { SupportedInstrumentId } from '../domain/contracts.ts'
import type { NewsHttpFetcher } from '../features/news/rss-collector.ts'
import { MarketStore } from '../features/market-data/market-store.ts'
import { createShadowRunStart } from '../features/shadow-runs/shadow-run.ts'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { FuturesStore } from '../features/paper-futures/futures-store.ts'
import { createMockMarketSnapshot } from '../features/paper-futures/futures-session-runtime.ts'
import type { FuturesSocket } from '../features/kraken-futures/futures-market.ts'
import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import {
  PAPER_MARKET_QUALITY_POLICY,
  parseTickerMessage,
  validateInstrumentCatalog,
} from '../features/kraken-futures/futures-market.ts'

const resultText = JSON.stringify({
  instrumentId: 'BTC-EUR',
  classification: 'watch',
  recommendation: 'hold',
  reasons: ['Latest quote moved up 0.50%; noteworthy move.'],
  warnings: [],
  volatility: { lookbackCandles: 1, averageTrueRangePercent: 2, level: 'low' },
  disclaimer:
    'Recomendación educativa e informativa: no es asesoramiento financiero y no ejecuta órdenes.',
})

function validBody() {
  return {
    instrumentId: 'BTC-EUR',
    symbol: 'BTC-EUR',
    assetClass: 'crypto',
    currency: 'EUR',
    quote: {
      price: 60_000,
      change: 300,
      changePercent: 0.5,
      timestamp: '2026-09-20T12:00:00.000Z',
      status: 'mock',
    },
    candles: [
      {
        time: '2024-01-01T00:00:00.000Z',
        open: 50_000,
        high: 51_000,
        low: 49_000,
        close: 50_500,
        volume: 1000,
      },
    ],
    holding: { quantity: '0.5', averageCost: '50000' },
  }
}

class FakeGeminiClient implements GeminiClient {
  calls: GeminiGenerateParams[] = []
  text = resultText
  error?: unknown

  async generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    this.calls.push(params)
    if (this.error !== undefined) {
      throw this.error
    }
    return this.text
  }
}

describe('app test configuration', () => {
  it('observes paired futures close phases without letting observer errors interrupt shutdown', async () => {
    const phases: Array<{
      phase: string
      state: string
      monotonic_ms: number
    }> = []
    const app = await buildApp({
      config: testConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: ':memory:',
        FUTURES_MARKET_DB_PATH: ':memory:',
      }),
      overrides: {
        futuresLifecycleObserver: (event) => {
          phases.push({
            phase: event.phase,
            state: event.state,
            monotonic_ms: event.monotonic_ms,
          })
        },
        futuresPublicCatalog: async () => ({
          instruments: [
            {
              symbol: 'PF_XBTUSD',
              type: 'flexible_futures',
              pair: 'BTC:USD',
              base: 'BTC',
              quote: 'USD',
              contractSize: '1',
              tickSize: '1',
              contractValueTradePrecision: 4,
              tradeable: true,
              isExpired: false,
            },
          ],
        }),
        futuresFundingFetch: async () =>
          new Response(
            JSON.stringify({
              result: 'success',
              serverTime: new Date(1_800_000_000_000).toISOString(),
              rates: [],
            }),
            { status: 200 },
          ),
        futuresSocketFactory: () => ({
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: () => undefined,
          close: () => undefined,
        }),
        futuresClock: () => 1_800_000_000_000,
      },
    })
    await app.ready()
    await app.close()
    const phaseNames = [...new Set(phases.map(({ phase }) => phase))]
    expect(phaseNames).toEqual([
      'futures-collector-stop',
      'futures-candle-timer-stop',
      'futures-funding-timer-stop',
      'futures-funding-client-close-and-poll-wait',
      'futures-ui-flush',
      'futures-market-tail-drain',
      'futures-market-store-close',
      'futures-runtime-close',
    ])
    for (const phase of phaseNames)
      expect(
        phases
          .filter((event) => event.phase === phase)
          .map((event) => event.state),
      ).toEqual(['begin', 'end'])
    expect(phases.map((event) => event.monotonic_ms)).toEqual(
      [...phases.map((event) => event.monotonic_ms)].sort((a, b) => a - b),
    )

    const throwingApp = await buildApp({
      config: testConfigFrom({
        FUTURES_MODE: 'mock',
        FUTURES_DB_PATH: ':memory:',
      }),
      overrides: {
        futuresLifecycleObserver: () => {
          throw new Error('observer failed')
        },
      },
    })
    await expect(throwingApp.close()).resolves.toBeUndefined()
  })

  it('keeps futures disabled by default and parses only explicit run modes', () => {
    expect(testConfigFrom({}).futuresMode).toBeUndefined()
    expect(testConfigFrom({ FUTURES_MODE: 'mock' }).futuresMode).toBe('mock')
    expect(testConfigFrom({ FUTURES_MODE: 'paper_live' }).futuresMode).toBe(
      'paper_live',
    )
    expect(
      testConfigFrom({
        FUTURES_MODE: 'replay',
        FUTURES_REPLAY_SOURCE_DB_PATH: 'frozen.sqlite',
      }).futuresMode,
    ).toBe('replay')
    expect(() => testConfigFrom({ FUTURES_MODE: 'live' })).toThrow(
      'FUTURES_MODE must be mock, paper_live, or replay when specified.',
    )
  })

  it('registers an explicitly selected offline futures runtime during buildApp startup', async () => {
    const app = await buildApp({
      config: testConfigFrom({
        FUTURES_MODE: 'mock',
        FUTURES_DB_PATH: ':memory:',
      }),
    })
    try {
      await app.ready()
      const response = await app.inject({
        method: 'GET',
        url: '/api/terminal/stream',
      })
      expect(response.statusCode).toBe(426)
      expect(response.json()).toEqual({
        error: { code: 'websocket_required' },
      })
    } finally {
      await app.close()
    }
  })

  it('does not open the legacy market database in explicit mock mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-mode-isolation-'))
    const marketPath = join(directory, 'legacy-market.sqlite')
    const futuresPath = join(directory, 'futures.sqlite')
    const config = serverConfigFrom({
      FUTURES_MODE: 'mock',
      FUTURES_DB_PATH: futuresPath,
      MARKET_DB_PATH: marketPath,
    })
    const app = await buildApp({
      config,
      overrides: {
        ohlcCollector: new FakeOhlcCollector(),
        marketCollector: new FakeMarketCollector(),
      },
    })
    try {
      await app.ready()
      expect(existsSync(marketPath)).toBe(false)
      expect(existsSync(futuresPath)).toBe(true)
    } finally {
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('starts REPLAY from a frozen market source without modifying it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-futures-replay-'))
    const sourcePath = join(directory, 'source.sqlite')
    const accountPath = join(directory, 'account.sqlite')
    const writer = new FuturesMarketStore(sourcePath)
    const catalog = {
      instruments: [
        {
          symbol: 'PF_XBTUSD',
          type: 'flexible_futures',
          pair: 'BTC:USD',
          base: 'BTC',
          quote: 'USD',
          contractSize: '1',
          tickSize: '1',
          contractValueTradePrecision: 4,
          tradeable: true,
          isExpired: false,
        },
      ],
    }
    const instrument = validateInstrumentCatalog(catalog, {
      source: 'fixture',
      retrievedAt: 1,
    })
    writer.saveInstrument(instrument, catalog)
    writer.saveQualityPolicy(PAPER_MARKET_QUALITY_POLICY, 1)
    const knownAt = 21_600_000
    for (const intervalMs of [60_000, 300_000]) {
      const count = intervalMs === 60_000 ? 60 : 12
      for (let index = 0; index < count; index += 1) {
        const bucketStart = knownAt - (count - index) * intervalMs
        writer.saveCandleRevision({
          id: `${intervalMs}:${bucketStart}`,
          intervalMs,
          bucketStart,
          revision: 1,
          knownAt,
          closeAt: bucketStart + intervalMs,
          isClosed: true,
          coverage: 'complete',
          open: '100000',
          high: '100050',
          low: '99950',
          close: '100000',
          volumeBtc: '1',
          tradeCount: 1,
          sourceHash: `fixture-${intervalMs}-${index}`,
        })
      }
    }
    writer.append({
      type: 'book',
      productId: 'PF_XBTUSD',
      epoch: 1,
      seq: 1,
      eventTime: knownAt,
      receivedAt: knownAt,
      persistedAt: knownAt,
      snapshot: true,
      contiguous: true,
      valid: true,
      bids: [{ price: '100000', quantity: '1' }],
      asks: [{ price: '100001', quantity: '1' }],
      rawJson: '{}',
    })
    writer.append({
      type: 'ticker',
      productId: 'PF_XBTUSD',
      epoch: 1,
      seq: 2,
      eventTime: knownAt,
      receivedAt: knownAt,
      persistedAt: knownAt,
      mark: '100000.5',
      last: '100000.5',
      rawJson: '{}',
    })
    writer.close()
    const sourceHash = () =>
      createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
    const sourceBytes = readFileSync(sourcePath)
    const before = sourceHash()
    const replayConfig = (accountDbPath: string, cutoff?: number) =>
      testConfigFrom({
        FUTURES_MODE: 'replay',
        FUTURES_DB_PATH: accountDbPath,
        FUTURES_REPLAY_SOURCE_DB_PATH: sourcePath,
        ...(cutoff === undefined
          ? {}
          : { FUTURES_REPLAY_CUTOFF_MS: String(cutoff) }),
      })
    const symlinkPath = join(directory, 'source-symlink.sqlite')
    const hardlinkPath = join(directory, 'source-hardlink.sqlite')
    symlinkSync(sourcePath, symlinkPath)
    linkSync(sourcePath, hardlinkPath)
    expect(() => replayConfig(sourcePath)).toThrow(
      'FUTURES_REPLAY_SOURCE_DB_PATH and FUTURES_DB_PATH must differ.',
    )
    for (const accountAlias of [symlinkPath, hardlinkPath])
      await expect(
        buildApp({ config: replayConfig(accountAlias) }),
      ).rejects.toThrow('Futures account database must be distinct')
    expect(sourceHash()).toBe(before)
    let app = await buildApp({
      config: replayConfig(accountPath),
    })
    try {
      await app.ready()
      const response = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        mode: 'replay',
        source: 'frozen-kraken-futures-market.v1',
        market: { status: 'ready' },
        source_manifest: { received_cursor: 2 },
        instrument_id: 'kraken-futures:PF_XBTUSD',
      })
      const exported = await app.inject({
        method: 'GET',
        url: '/api/terminal/export',
      })
      expect(exported.statusCode).toBe(200)
      expect(exported.json()).toMatchObject({
        schema_version: 'futures-replay-export.v1',
        verified: true,
        source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        economic_export: { schema_version: 'futures-replay-export.v1' },
      })
      expect(exported.json().economic_export.manifest).toMatchObject({
        source_file_hash: before,
        replay_cutoff_ms: knownAt,
      })
      expect(
        exported.json().economic_export.manifest.source_metadata_hash,
      ).toMatch(/^[a-f0-9]{64}$/)
      expect(
        exported.json().economic_export.manifest.source_quality_hash,
      ).toMatch(/^[a-f0-9]{64}$/)
      expect(existsSync(accountPath)).toBe(true)
      const firstExport = exported.json()
      await app.close()
      app = await buildApp({ config: replayConfig(accountPath) })
      await app.ready()
      const restoredBootstrap = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      const restoredExport = await app.inject({
        method: 'GET',
        url: '/api/terminal/export',
      })
      expect(restoredBootstrap.json().active_run_id).toBe(firstExport.run_id)
      expect(restoredExport.json().economic_export.semantic_hash).toBe(
        firstExport.economic_export.semantic_hash,
      )
      expect(restoredExport.json().economic_export.inputs).toEqual(
        firstExport.economic_export.inputs,
      )
      appendFileSync(sourcePath, Buffer.from('changed source bytes'))
      const changedSourceExport = await app.inject({
        method: 'GET',
        url: '/api/terminal/export',
      })
      expect(changedSourceExport.statusCode).toBe(409)
      expect(changedSourceExport.json().error.message).toContain(
        'source database bytes changed',
      )
      writeFileSync(sourcePath, sourceBytes)
      const limitedApp = await buildApp({
        config: replayConfig(
          join(directory, 'cutoff-account.sqlite'),
          knownAt - 1,
        ),
      })
      try {
        await limitedApp.ready()
        const limitedBootstrap = await limitedApp.inject({
          method: 'GET',
          url: '/api/terminal/bootstrap',
        })
        expect(limitedBootstrap.json()).toMatchObject({
          source_manifest: { replay_cutoff_ms: knownAt - 1 },
          market: { status: 'insufficient_history', candles: [] },
        })
        const limitedExport = await limitedApp.inject({
          method: 'GET',
          url: '/api/terminal/export',
        })
        expect(limitedExport.json().economic_export.inputs).toHaveLength(0)
      } finally {
        await limitedApp.close()
      }
    } finally {
      await app.close()
      expect(sourceHash()).toBe(before)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('shares one offline Python/SQLite runtime across two WebSocket subscribers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-futures-app-'))
    const dbPath = join(directory, 'futures.sqlite')
    const config = testConfigFrom({
      FUTURES_MODE: 'mock',
      FUTURES_DB_PATH: dbPath,
      GEMINI_SERVER_CORS_ORIGIN: 'http://127.0.0.1:15173',
    })
    let app = await buildApp({
      config,
    })
    let first: WebSocket | undefined
    let second: WebSocket | undefined
    try {
      await app.ready()
      const bootstrap = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      const { active_run_id: runId } = bootstrap.json() as {
        active_run_id: string
      }
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const connect = async () => {
        const socket = new WebSocket(
          address.replace('http:', 'ws:') + '/api/terminal/stream',
          { origin: config.corsOrigin },
        )
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        const received: Record<string, unknown>[] = []
        socket.on('message', (raw) => {
          received.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        })
        return { socket, received }
      }
      const one = await connect()
      first = one.socket
      const two = await connect()
      second = two.socket
      const waitFor = async (
        received: Record<string, unknown>[],
        predicate: (item: Record<string, unknown>) => boolean,
      ) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const match = received.find(predicate)
          if (match) return match
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error(
          `Timed out waiting for terminal event: ${JSON.stringify(received)}`,
        )
      }
      for (const socket of [one.socket, two.socket])
        socket.send(
          JSON.stringify({
            schema_version: 1,
            type: 'subscribe',
            run_id: runId,
          }),
        )
      await Promise.all([
        waitFor(one.received, (item) => item.type === 'snapshot'),
        waitFor(two.received, (item) => item.type === 'snapshot'),
      ])
      const initialSnapshot = one.received.find(
        (item) => item.type === 'snapshot',
      )!
      const initialSnapshotData = initialSnapshot.data as Record<
        string,
        unknown
      >
      expect(initialSnapshotData.market).toMatchObject({
        schema_version: 'mock-terminal-market.v1',
        interval_ms: 60_000,
      })
      expect(
        (initialSnapshotData.market as { candles: unknown[] }).candles,
      ).toHaveLength(60)
      const initialState = initialSnapshotData.state as Record<string, unknown>
      expect(initialState.account).toMatchObject({
        cash_usd: '10000',
        equity_usd: '10000',
        funding_complete: false,
        net_usd: null,
      })
      const commandId = randomUUID()
      one.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'paper.command',
          run_id: runId,
          command_id: commandId,
          expected_state_version: 0,
          action: 'paper.start',
        }),
      )
      const analysis = await Promise.all([
        waitFor(one.received, (item) => item.type === 'analysis.completed'),
        waitFor(two.received, (item) => item.type === 'analysis.completed'),
      ])
      expect(analysis[0]?.event_id).toBe(analysis[1]?.event_id)
      expect(analysis[0]?.seq).toBe(analysis[1]?.seq)
      const [acknowledgement, result] = await Promise.all([
        waitFor(one.received, (item) => item.type === 'command.ack'),
        waitFor(one.received, (item) => item.type === 'command.result'),
      ])
      expect(acknowledgement.data).toMatchObject({
        command_id: commandId,
        status: 'accepted',
      })
      expect(result.data).toMatchObject({
        command_id: commandId,
        result: {
          result: { status: 'committed' },
        },
      })
      expect(Number(acknowledgement.seq)).toBeLessThan(Number(result.seq))
      const startedFill = await waitFor(
        one.received,
        (item) => item.type === 'fill.created',
      )
      expect((startedFill.data as Record<string, unknown>).fill).toMatchObject({
        event_time_ms: 21_600_200,
      })
      const sendCommand = async (
        action: 'paper.pause' | 'paper.close',
        expectedStateVersion: number,
      ) => {
        const id = randomUUID()
        const completion = waitFor(
          one.received,
          (item) =>
            item.type === 'command.result' &&
            (item.data as Record<string, unknown>).command_id === id,
        )
        one.socket.send(
          JSON.stringify({
            schema_version: 1,
            type: 'paper.command',
            run_id: runId,
            command_id: id,
            expected_state_version: expectedStateVersion,
            action,
          }),
        )
        return completion
      }
      const fillFromLaterMockBook = await sendCommand('paper.pause', 2)
      expect(one.received.some((item) => item.type === 'fill.created')).toBe(
        true,
      )
      expect(
        fillFromLaterMockBook.data as Record<string, unknown>,
      ).toMatchObject({ command_id: expect.any(String) })
      await sendCommand('paper.close', 3)
      const closedFill = await waitFor(
        one.received,
        (item) =>
          item.type === 'fill.created' &&
          item.event_id !== startedFill.event_id,
      )
      expect((closedFill.data as Record<string, unknown>).fill).toMatchObject({
        event_time_ms: 21_600_500,
      })
      const firstFills = one.received.filter(
        (item) => item.type === 'fill.created',
      )
      const secondFills = two.received.filter(
        (item) => item.type === 'fill.created',
      )
      expect(firstFills).toHaveLength(2)
      expect(firstFills.map((item) => item.event_id)).toEqual(
        secondFills.map((item) => item.event_id),
      )
      expect(
        firstFills
          .map(
            (item) =>
              (item.data as Record<string, unknown>).fill as Record<
                string,
                unknown
              >,
          )
          .map((fill) => fill.event_time_ms),
      ).toEqual([21_600_200, 21_600_500])
      const snapshot = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      expect(snapshot.json()).toMatchObject({
        mode: 'mock',
        source: 'versioned-mock-fixture.v1',
      })
      expect(bootstrap.statusCode).toBe(200)

      const runCursor = Number(result.seq)
      first.close()
      second.close()
      first = undefined
      second = undefined
      await app.close()
      app = await buildApp({ config })
      await app.ready()
      const restartedAddress = await app.listen({ port: 0, host: '127.0.0.1' })
      const restarted = await connectAt(restartedAddress, runId)
      first = restarted.socket
      const restoredSnapshot = await waitFor(
        restarted.received,
        (item) => item.type === 'snapshot',
      )
      expect(restoredSnapshot.run_id).toBe(runId)
      expect(Number(restoredSnapshot.seq)).toBeGreaterThanOrEqual(runCursor)
      const restoredState = (restoredSnapshot.data as Record<string, unknown>)
        .state as Record<string, unknown>
      expect(restoredState.currency).toBe('USD')
      expect(restoredState.quantity_unit).toBe('BTC')
      expect(restoredState.position).toBeNull()
      expect(restoredState.account).toMatchObject({
        cash_usd: '10000',
        realized_gross_usd: '-0.0099',
        fees_usd: '0.99000495',
        net_usd: null,
      })
      expect(
        (restoredState.account as Record<string, unknown>).funding_complete,
      ).toBe(false)
      expect(
        (restoredState.account as Record<string, unknown>).net_usd,
      ).toBeNull()
      const postRestartCommand = randomUUID()
      const postRestartResult = waitFor(
        restarted.received,
        (item) =>
          item.type === 'command.result' &&
          (item.data as Record<string, unknown>).command_id ===
            postRestartCommand,
      )
      restarted.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'paper.command',
          run_id: runId,
          command_id: postRestartCommand,
          expected_state_version: 5,
          action: 'paper.pause',
        }),
      )
      await postRestartResult
      expect(
        restarted.received.some(
          (item) =>
            item.type === 'analysis.completed' &&
            (item.data as Record<string, unknown>).command_id ===
              postRestartCommand,
        ),
      ).toBe(true)
      const newRunCommand = randomUUID()
      const childSnapshot = waitFor(
        restarted.received,
        (item) => item.type === 'snapshot' && item.run_id !== runId,
      )
      restarted.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'paper.command',
          run_id: runId,
          command_id: newRunCommand,
          expected_state_version: 6,
          action: 'paper.new_run',
        }),
      )
      const child = await childSnapshot
      expect(child.run_id).not.toBe(runId)
      expect(
        Number((child.data as Record<string, unknown>).watermark),
      ).toBeGreaterThan(0)
      const activeRun = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      expect(activeRun.json()).toMatchObject({ active_run_id: child.run_id })
    } finally {
      first?.close()
      second?.close()
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }

    async function connectAt(address: string, runId: string) {
      const socket = new WebSocket(
        address.replace('http:', 'ws:') + '/api/terminal/stream',
        { origin: 'http://localhost' },
      )
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      const received: Record<string, unknown>[] = []
      socket.on('message', (raw) => {
        const item = JSON.parse(raw.toString()) as Record<string, unknown>
        received.push(item)
      })
      socket.send(
        JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
      )
      return { socket, received }
    }
  }, 20_000)

  it('recovers a durably accepted futures command during actual app startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-pending-startup-'))
    const dbPath = join(directory, 'futures.sqlite')
    const config = testConfigFrom({
      FUTURES_MODE: 'mock',
      FUTURES_DB_PATH: dbPath,
    })
    let app = await buildApp({ config })
    let socket: WebSocket | undefined
    try {
      await app.ready()
      await app.close()
      const store = new FuturesStore(dbPath)
      const runId = 'futures-session:primary'
      const definition = store.getRunDefinition(runId)
      const binding = definition.runtime as {
        runtime_config: Record<string, unknown>
        instrument_spec: Record<string, unknown>
      }
      const commandId = randomUUID()
      const request = {
        request_id: commandId,
        run_id: runId,
        work_id: commandId,
        expected_state_version: 0,
        payload: {
          operation: 'futures_runtime.v3',
          runtime_config: binding.runtime_config,
          instrument: binding.instrument_spec,
          market_snapshot: createMockMarketSnapshot(21_600_000, false),
        },
      }
      store.acceptCommand(commandId, request, undefined, null, {
        command_id: commandId,
        action: 'paper.start',
        stream_run_id: runId,
        expected_state_version: 0,
      })
      store.close()

      app = await buildApp({ config })
      await app.ready()
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      socket = new WebSocket(
        address.replace('http:', 'ws:') + '/api/terminal/stream',
        { origin: 'http://localhost' },
      )
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve)
        socket!.once('error', reject)
      })
      const messages: Record<string, unknown>[] = []
      socket.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)
      })
      socket.send(
        JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
      )
      const deadline = Date.now() + 10_000
      let snapshot: Record<string, unknown> | undefined
      while (Date.now() < deadline) {
        snapshot = messages.find((item) => item.type === 'snapshot')
        if (snapshot) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(snapshot).toBeDefined()
      const state = (snapshot!.data as Record<string, unknown>).state as Record<
        string,
        unknown
      >
      expect(state.state_version).toBe(1)
      expect(state.analyses).toHaveLength(1)
      expect((state.analyses as Record<string, unknown>[])[0]?.action).toBe(
        'WAIT',
      )
    } finally {
      socket?.close()
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('opts out of live paper and REST workers by default while preserving explicit environment overrides', () => {
    expect(testConfigFrom({})).toMatchObject({
      krakenPaperTradingEnabled: false,
      krakenRestOhlcWorkerEnabled: false,
    })
    expect(
      testConfigFrom({
        KRAKEN_PAPER_TRADING_ENABLED: 'true',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'true',
      }),
    ).toMatchObject({
      krakenPaperTradingEnabled: true,
      krakenRestOhlcWorkerEnabled: true,
    })
    expect(
      testConfigFrom({
        KRAKEN_PAPER_TRADING_ENABLED: 'true',
        PAPER_TRADING_ENABLED: 'false',
      }).krakenPaperTradingEnabled,
    ).toBe(false)
  })
})

function testConfigFrom(env: Record<string, string | undefined> = {}) {
  return serverConfigFrom({
    KRAKEN_WS_COLLECTOR_ENABLED:
      env.KRAKEN_WS_COLLECTOR_ENABLED ??
      env.MARKET_COLLECTOR_ENABLED ??
      'false',
    KRAKEN_REST_OHLC_WORKER_ENABLED:
      env.KRAKEN_REST_OHLC_WORKER_ENABLED ??
      env.MARKET_COLLECTOR_ENABLED ??
      'false',
    PAPER_TRADING_ENABLED:
      env.PAPER_TRADING_ENABLED ?? env.KRAKEN_PAPER_TRADING_ENABLED ?? 'false',
    ...env,
  })
}

describe('PAPER_LIVE startup integration', () => {
  it('restores the latest persisted public quote in bootstrap before new socket events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'balancita-paper-live-restore-'))
    const marketPath = join(root, 'market.sqlite')
    const persisted = new FuturesMarketStore(marketPath)
    const ticker = parseTickerMessage(
      {
        feed: 'ticker',
        product_id: 'PF_XBTUSD',
        seq: 417,
        time: 1_790_949_999_900,
        last: '68123.45',
        markPrice: '68120.5',
        suspended: false,
      },
      {
        receivedAt: 1_790_950_000_000,
        persistedAt: 1_790_950_000_001,
        epoch: 4,
      },
    )
    persisted.append(ticker)
    persisted.close()

    const app = await buildApp({
      config: testConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: join(root, 'account.sqlite'),
        FUTURES_MARKET_DB_PATH: marketPath,
      }),
      overrides: {
        futuresFundingFetch: async () =>
          new Response(
            JSON.stringify({
              result: 'success',
              serverTime: '2026-10-04T00:00:00.000Z',
              rates: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        futuresPublicCatalog: async () => ({
          instruments: [
            {
              symbol: 'PF_XBTUSD',
              type: 'flexible_futures',
              pair: 'BTC:USD',
              base: 'BTC',
              quote: 'USD',
              contractSize: '1',
              tickSize: '1',
              contractValueTradePrecision: 4,
              tradeable: true,
              isExpired: false,
            },
          ],
        }),
        futuresSocketFactory: () => ({
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: () => undefined,
          close: () => undefined,
        }),
        futuresClock: () => 1_790_950_000_010,
      } as never,
    })
    try {
      await app.ready()
      const bootstrap = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      expect(bootstrap.json().market.latest_quote).toMatchObject({
        last: '68123.45',
        mark: '68120.5',
        event_time: 1_790_949_999_900,
        received_at: 1_790_950_000_000,
        persisted_at: 1_790_950_000_001,
        epoch: 4,
        sequence: 417,
        received_sequence: 1,
      })
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts the selected public-feed mode with an injected recorded catalog and socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'balancita-paper-live-'))
    const fakeSocket: FuturesSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: () => undefined,
      close: () => undefined,
    }
    const sourceQueueEvents: FuturesSourceQueueEvent[] = []
    const app = await buildApp({
      config: testConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: join(root, 'account.sqlite'),
        FUTURES_MARKET_DB_PATH: join(root, 'market.sqlite'),
      }),
      overrides: {
        futuresSourceQueueObserver: (event: FuturesSourceQueueEvent) => {
          sourceQueueEvents.push(event)
          throw new Error('source queue observer failed')
        },
        futuresFundingFetch: async () =>
          new Response(
            JSON.stringify({
              result: 'success',
              serverTime: '2026-10-04T00:00:00.000Z',
              rates: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        futuresPublicCatalog: async () => ({
          instruments: [
            {
              symbol: 'PF_XBTUSD',
              type: 'flexible_futures',
              pair: 'BTC:USD',
              base: 'BTC',
              quote: 'USD',
              contractSize: '1',
              tickSize: '1',
              contractValueTradePrecision: 4,
              tradeable: true,
              isExpired: false,
            },
          ],
        }),
        futuresSocketFactory: () => fakeSocket,
        futuresClock: () => 1_790_950_000_000,
      } as never,
    })
    const runtimeErrors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    try {
      await app.ready()
      const response = await app.inject({
        method: 'GET',
        url: '/api/terminal/bootstrap',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        mode: 'paper_live',
        instrument_id: 'kraken-futures:PF_XBTUSD',
        product_id: 'PF_XBTUSD',
        market: {
          status: 'connecting',
          book_status: 'unavailable',
          last_received_at: null,
        },
        engine: { status: 'warming' },
      })
      fakeSocket.onopen?.()
      fakeSocket.onmessage?.({
        data: JSON.stringify({
          feed: 'book_snapshot',
          product_id: 'PF_XBTUSD',
          seq: 10,
          timestamp: 1_790_950_000_000,
          bids: [{ price: '90000', qty: '0.5' }],
          asks: [{ price: '90001', qty: '0.5' }],
        }),
      })
      fakeSocket.onmessage?.({
        data: JSON.stringify({
          feed: 'ticker',
          product_id: 'PF_XBTUSD',
          seq: 20,
          time: 1_790_950_000_000,
          last: '90000.5',
          markPrice: '90000',
          suspended: false,
        }),
      })
      fakeSocket.onmessage?.({
        data: JSON.stringify({
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: 'recorded-public-trade-1',
          side: 'buy',
          type: 'fill',
          seq: 30,
          time: 1_790_950_000_000,
          qty: '0.0001',
          price: '90000.5',
        }),
      })
      fakeSocket.onmessage?.({
        data: JSON.stringify({
          feed: 'book',
          product_id: 'PF_XBTUSD',
          seq: 11,
          timestamp: 1_790_950_000_100,
          side: 'buy',
          price: '90000',
          qty: '0.6',
        }),
      })
      fakeSocket.onmessage?.({
        data: JSON.stringify({
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: 'recorded-public-trade-2',
          side: 'sell',
          type: 'fill',
          seq: 31,
          time: 1_790_950_000_100,
          qty: '0.0002',
          price: '90000',
        }),
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
    } finally {
      await app.close()
      expect(sourceQueueEvents.map((event) => event.phase)).toContain('enqueue')
      expect(sourceQueueEvents.map((event) => event.phase)).toContain('start')
      expect(
        sourceQueueEvents.some((event) =>
          ['end', 'error'].includes(String(event.phase)),
        ),
      ).toBe(true)
      expect(
        Math.max(
          ...sourceQueueEvents.map((event) => Number(event.pending_count)),
        ),
      ).toBeGreaterThan(0)
      expect(
        sourceQueueEvents.every(
          (event) => typeof event.source_received_seq === 'number',
        ),
      ).toBe(true)
      expect(
        sourceQueueEvents.every((event) => event.oldest_job_age_ms >= 0),
      ).toBe(true)
      expect(sourceQueueEvents.at(-1)).toMatchObject({
        pending_count: 0,
        running_count: 0,
        queue_count: 0,
      })
      const account = new FuturesStore(join(root, 'account.sqlite'))
      const source = new (
        await import('../features/kraken-futures/futures-market-store.ts')
      ).FuturesMarketStore(join(root, 'market.sqlite'))
      const marketEvents = source.eventsAsOf(Number.MAX_SAFE_INTEGER) as Record<
        string,
        unknown
      >[]
      expect(marketEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining(['book', 'ticker', 'trade']),
      )
      const book = marketEvents.find((event) => event.type === 'book')
      expect(book?.marketQuality).toMatchObject({
        schema_version: 'futures-market-quality-attestation.v1',
        policy_version: 'snapshot-contiguous-observed.v1',
        source_guarantee: 'undocumented',
        book_valid: true,
        book_sequence_integrity: 'observed_contiguous',
      })
      source.close()
      const events = account.listTerminalEvents('futures-session:primary', {
        afterSeq: 0,
        limit: 100,
      }).events
      expect(events.some((event) => event.type === 'market.updated')).toBe(true)
      const marketUpdate = events.find(
        (event) =>
          event.type === 'market.updated' &&
          (event.data as Record<string, unknown>).feed === 'trade',
      )
      expect(marketUpdate?.data).toMatchObject({
        market_status: 'live',
        last_received_at: 1_790_950_000_000,
        book_quality: {
          schema_version: 'futures-market-quality-attestation.v1',
          policy_version: 'snapshot-contiguous-observed.v1',
          source_guarantee: 'undocumented',
          book_valid: true,
        },
        candle: {
          interval_ms: 60_000,
          closed: false,
          close: '90000',
          volume_btc: '0.0003',
        },
      })
      expect(events.some((event) => event.type === 'analysis.completed')).toBe(
        true,
      )
      expect(runtimeErrors).not.toHaveBeenCalledWith(
        'futures runtime evidence processing failed',
        expect.anything(),
      )
      account.close()
      rmSync(root, { recursive: true, force: true })
    }
    runtimeErrors.mockRestore()
  })

  it.skipIf(!process.env.FUTURES_PERF_RAW_EVIDENCE_PATH)(
    'drains a bounded recorded public-frame burst without rescanning source history',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'balancita-paper-live-burst-'))
      const marketPath = join(root, 'market.sqlite')
      const accountPath = join(root, 'account.sqlite')
      const rawRows = readFileSync(
        process.env.FUTURES_PERF_RAW_EVIDENCE_PATH!,
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const frames = rawRows.flatMap((row) => {
        if (row.kind !== 'websocket_frame' || typeof row.raw !== 'string')
          return []
        let message: Record<string, unknown>
        try {
          message = JSON.parse(row.raw)
        } catch {
          return []
        }
        return message.feed === 'book_snapshot' ||
          message.feed === 'book' ||
          message.feed === 'ticker' ||
          message.feed === 'trade'
          ? [{ receivedAt: Number(row.received_at), raw: row.raw }]
          : []
      })
      const snapshotIndex = frames.findIndex((frame) => {
        const message = JSON.parse(frame.raw) as Record<string, unknown>
        return message.feed === 'book_snapshot'
      })
      expect(snapshotIndex).toBeGreaterThanOrEqual(0)
      const burst = frames.slice(snapshotIndex, snapshotIndex + 6)
      expect(
        burst.some((frame) => JSON.parse(frame.raw).feed === 'ticker'),
      ).toBe(true)

      let socketClosed = false
      const fakeSocket: FuturesSocket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => {
          socketClosed = true
        },
      }
      let receivedAt = burst[0]!.receivedAt
      const app = await buildApp({
        config: testConfigFrom({
          FUTURES_MODE: 'paper_live',
          FUTURES_DB_PATH: accountPath,
          FUTURES_MARKET_DB_PATH: marketPath,
        }),
        overrides: {
          futuresSourceQueueObserver: (event: FuturesSourceQueueEvent) => {
            sourceQueueEvents.push(event)
          },
          futuresFundingFetch: async () =>
            new Response(
              JSON.stringify({
                result: 'success',
                serverTime: new Date(receivedAt).toISOString(),
                rates: [],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          futuresPublicCatalog: async () => ({
            instruments: [
              {
                symbol: 'PF_XBTUSD',
                type: 'flexible_futures',
                pair: 'BTC:USD',
                base: 'BTC',
                quote: 'USD',
                contractSize: '1',
                tickSize: '1',
                contractValueTradePrecision: 4,
                tradeable: true,
                isExpired: false,
              },
            ],
          }),
          futuresSocketFactory: () => fakeSocket,
          futuresClock: () => receivedAt,
        } as never,
      })
      const originalEventsAsOf = FuturesMarketStore.prototype.eventsAsOf
      const originalEventsAfter = FuturesMarketStore.prototype.eventsAfter
      let eventQueryCount = 0
      let eventRowsReturned = 0
      let tailQueryRowsReturned = 0
      vi.spyOn(FuturesMarketStore.prototype, 'eventsAsOf').mockImplementation(
        function (this: FuturesMarketStore, cutoff: number) {
          const rows = originalEventsAsOf.call(this, cutoff)
          if (cutoff === Number.MAX_SAFE_INTEGER) {
            eventQueryCount += 1
            eventRowsReturned += rows.length
          }
          return rows
        },
      )
      vi.spyOn(FuturesMarketStore.prototype, 'eventsAfter').mockImplementation(
        function (this: FuturesMarketStore, sequence: number) {
          const rows = originalEventsAfter.call(this, sequence)
          tailQueryRowsReturned += rows.length
          return rows
        },
      )
      const runtimeErrors = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const accountProbe = new FuturesStore(accountPath)
      let closeCompleted = false
      let observedEventQueryCount: number
      let observedEventRowsReturned: number
      let observedTailQueryRowsReturned: number
      let observedRuntimeErrorCount: number
      let closeElapsedMs: number
      const sourceQueueEvents: FuturesSourceQueueEvent[] = []
      try {
        await app.ready()
        fakeSocket.onopen?.()
        for (const frame of burst.slice(0, 2)) {
          receivedAt = frame.receivedAt
          fakeSocket.onmessage?.({ data: frame.raw })
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
        const binding = accountProbe.getReplaySessionBinding(
          'futures-session:primary',
        )
        expect(
          binding
            ? accountProbe.loadReplaySession('futures-session:primary', binding)
                .works.length
            : 0,
        ).toBe(1)
        for (const frame of burst.slice(2)) {
          receivedAt = frame.receivedAt
          fakeSocket.onmessage?.({ data: frame.raw })
        }
        const closeStartedAt = performance.now()
        await app.close()
        closeElapsedMs = performance.now() - closeStartedAt
        closeCompleted = true
        observedEventQueryCount = eventQueryCount
        observedEventRowsReturned = eventRowsReturned
        observedTailQueryRowsReturned = tailQueryRowsReturned
        observedRuntimeErrorCount = runtimeErrors.mock.calls.length
      } finally {
        if (!closeCompleted) await app.close()
        accountProbe.close()
        runtimeErrors.mockRestore()
        vi.restoreAllMocks()
      }

      const source = new FuturesMarketStore(marketPath)
      const persistedRows = source.eventsAsOf(
        Number.MAX_SAFE_INTEGER,
      ) as Record<string, unknown>[]
      source.close()
      expect(persistedRows.map((event) => event.receivedSequence)).toEqual(
        [...persistedRows]
          .map((event) => event.receivedSequence)
          .sort((a, b) => Number(a) - Number(b)),
      )
      expect(
        persistedRows.map((event) => JSON.parse(String(event.rawJson))),
      ).toEqual(burst.map((frame) => JSON.parse(frame.raw)))
      const capturedBook = JSON.parse(burst[0]!.raw) as Record<string, unknown>
      const persistedBook = persistedRows.find(
        (event) => event.type === 'book' && event.snapshot === true,
      )
      expect(persistedBook?.bids).toHaveLength(
        (capturedBook.bids as unknown[]).length,
      )
      expect(persistedBook?.asks).toHaveLength(
        (capturedBook.asks as unknown[]).length,
      )
      const account = new FuturesStore(accountPath)
      const binding = account.getReplaySessionBinding('futures-session:primary')
      const works = binding
        ? account.loadReplaySession('futures-session:primary', binding).works
        : []
      expect(account.verifyRun('futures-session:primary')).toBe(true)
      account.close()
      expect(persistedRows.length).toBeGreaterThanOrEqual(6)
      expect(works.length).toBe(persistedRows.length - 1)
      expect(
        works.map(
          (work) => (work as { input: { sequence: number } }).input.sequence,
        ),
      ).toEqual(persistedRows.slice(1).map((event) => event.receivedSequence))
      console.info('PAPER_LIVE bounded burst work counts', {
        frames: burst.length,
        snapshotBidLevels: (capturedBook.bids as unknown[]).length,
        snapshotAskLevels: (capturedBook.asks as unknown[]).length,
        storedEvents: persistedRows.length,
        durableWorks: works.length,
        fullHistoryQueries: observedEventQueryCount,
        sourceRowsReturned: observedEventRowsReturned,
        tailRowsReturned: observedTailQueryRowsReturned,
        closeElapsedMs: Math.round(closeElapsedMs),
      })
      expect(observedEventQueryCount).toBeLessThanOrEqual(2)
      expect(observedEventRowsReturned).toBeLessThanOrEqual(2)
      expect(observedTailQueryRowsReturned).toBe(persistedRows.length - 2)
      expect(observedRuntimeErrorCount).toBe(0)
      expect(sourceQueueEvents.at(-1)).toMatchObject({
        pending_notifications: 0,
        durable_source_backlog: 0,
        source_watermark: persistedRows.length,
      })
      expect(
        Math.max(...sourceQueueEvents.map((event) => event.pending_count)),
      ).toBeLessThanOrEqual(1)
      expect(closeCompleted).toBe(true)
      expect(socketClosed).toBe(true)
      rmSync(root, { recursive: true, force: true })
    },
  )
})

async function makeApp(options: {
  env?: Record<string, string | undefined>
  client?: FakeGeminiClient
  limiter?: AnalysisRateLimiter
  saturateLimiter?: boolean
  maxCandles?: number
  marketFetch?: MarketRestFetch
  marketStore?: MarketStore
  enabled?: boolean
  ohlcCollector?: OhlcCollectorLifecycle
  marketCollector?: MarketCollectorLifecycle
}) {
  const config = testConfigFrom({
    GEMINI_MAX_CANDLES: String(options.maxCandles ?? 500),
    KRAKEN_WS_COLLECTOR_ENABLED:
      options.env?.KRAKEN_WS_COLLECTOR_ENABLED ??
      options.env?.MARKET_COLLECTOR_ENABLED ??
      'false',
    KRAKEN_REST_OHLC_WORKER_ENABLED:
      options.env?.KRAKEN_REST_OHLC_WORKER_ENABLED ??
      options.env?.MARKET_COLLECTOR_ENABLED ??
      'false',
    ...options.env,
  })
  if (config.krakenWsCollectorEnabled && options.marketCollector === undefined)
    throw new Error(
      'Enabled market collector tests must inject a fake collector.',
    )
  if (
    config.krakenRestOhlcWorkerEnabled &&
    options.ohlcCollector === undefined &&
    options.marketFetch === undefined
  )
    throw new Error(
      'Enabled OHLC worker tests must inject a fake or fixture fetch.',
    )
  const overrides: {
    client?: GeminiClient
    limiter?: AnalysisRateLimiter
    cache?: AnalysisCache
    marketFetch?: MarketRestFetch
    ohlcCollector?: OhlcCollectorLifecycle
    marketCollector?: MarketCollectorLifecycle
    marketStore?: MarketStore
  } = {}
  if (options.client !== undefined) {
    overrides.client = options.client
  }
  if (options.limiter !== undefined) {
    overrides.limiter = options.limiter
  } else if (options.saturateLimiter === true) {
    overrides.client = overrides.client ?? new FakeGeminiClient()
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 1,
      maxPerDay: 1,
      now: () => 0,
    })
    limiter.tryConsume()
    overrides.limiter = limiter
  }
  if (options.marketFetch !== undefined) {
    overrides.marketFetch = options.marketFetch
  }
  if (options.ohlcCollector !== undefined)
    overrides.ohlcCollector = options.ohlcCollector
  if (options.marketCollector !== undefined)
    overrides.marketCollector = options.marketCollector
  if (options.marketStore !== undefined) {
    overrides.marketStore = options.marketStore
  } else if (
    config.krakenWsCollectorEnabled ||
    config.krakenRestOhlcWorkerEnabled ||
    config.krakenPaperTradingEnabled
  ) {
    overrides.marketStore = new MarketStore({ path: ':memory:' })
  }
  const app = await buildApp({ config, overrides })
  if (options.enabled !== false && overrides.client !== undefined)
    await app.inject({
      method: 'PUT',
      url: '/api/gemini/status',
      payload: { enabled: true },
    })
  return app
}

class FakeMarketCollector implements MarketCollectorLifecycle {
  readonly starts: string[] = []
  stopCount = 0

  start(instrumentId: string): void {
    this.starts.push(instrumentId)
  }

  stop(): void {
    this.stopCount += 1
  }
}

class FakeOhlcCollector implements OhlcCollectorLifecycle {
  starts = 0
  stops = 0
  start(): void {
    this.starts += 1
  }
  stop(): void {
    this.stops += 1
  }
  getStatus() {
    return {
      running: this.starts > this.stops,
      lastSuccessfulSync: 123_000,
      candleCount: 2,
      minTimestamp: '1970-01-01T00:01:00.000Z',
      maxTimestamp: '1970-01-01T00:02:00.000Z',
      coverageHours: 1 / 60,
      gapCount: 0,
    }
  }
}

describe('analysis gateway API', () => {
  it('starts and reports the REST OHLC worker independently of WebSocket collection', async () => {
    const collector = new FakeOhlcCollector()
    const app = await makeApp({
      env: {
        KRAKEN_WS_COLLECTOR_ENABLED: 'false',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'true',
      },
      ohlcCollector: collector,
      marketCollector: new FakeMarketCollector(),
    })
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/collector/status',
    })
    expect(collector.starts).toBe(1)
    expect(response.json()).toEqual({
      enabled: true,
      running: true,
      total_candles: 2,
      oldest_candle_iso: '1970-01-01T00:01:00.000Z',
      newest_candle_iso: '1970-01-01T00:02:00.000Z',
      coverage_hours: 1 / 60,
      gaps_detected: 0,
      last_sync_timestamp: 123_000,
    })
    await app.close()
    expect(collector.stops).toBe(1)
  })

  it('reports empty metrics and does not start OHLC collection while disabled', async () => {
    const collector = new FakeOhlcCollector()
    const app = await makeApp({ ohlcCollector: collector })
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/collector/status',
    })
    const paperStatus = await app.inject({
      method: 'GET',
      url: '/api/paper-trading/status',
    })
    expect(response.json()).toEqual({
      enabled: false,
      running: false,
      total_candles: 0,
      oldest_candle_iso: null,
      newest_candle_iso: null,
      coverage_hours: 0,
      gaps_detected: 0,
      last_sync_timestamp: 0,
    })
    await app.close()
    expect(collector.starts).toBe(0)
    expect(collector.stops).toBe(0)
    expect(paperStatus.json()).toMatchObject({
      enabled: false,
      running: false,
    })
  })
  it('reports health', async () => {
    const app = await makeApp({})
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('reports Gemini readiness without exposing the API key and enables it only on request', async () => {
    const app = await makeApp({ env: { GEMINI_API_KEY: 'never-return-this' } })
    const initial = await app.inject({
      method: 'GET',
      url: '/api/gemini/status',
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toEqual({ enabled: false, apiKeyConfigured: true })
    expect(initial.body).not.toContain('never-return-this')

    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/gemini/status',
      payload: { enabled: true },
    })
    expect(enabled.json()).toEqual({ enabled: true, apiKeyConfigured: true })
  })

  it('blocks analyze calls by default and allows them only after explicit enable', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client, enabled: false })
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })
    expect(blocked.statusCode).toBe(503)
    expect(client.calls).toHaveLength(0)

    await app.inject({
      method: 'PUT',
      url: '/api/gemini/status',
      payload: { enabled: true },
    })
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })
    expect(allowed.statusCode).toBe(200)
    expect(client.calls).toHaveLength(1)
  })

  it('returns a validated result for a well-formed request', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.error).toBeUndefined()
    expect(body.cached).toBe(false)
    expect(body.result.classification).toBe('watch')
    expect(body.result.recommendation).toBe('hold')
    expect(body.result.volatility.level).toBe('low')
    expect(client.calls).toHaveLength(1)
  })

  it('serves an identical request from the cache', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client })

    const first = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(first.json().cached).toBe(false)
    expect(second.statusCode).toBe(200)
    expect(second.json().cached).toBe(true)
    expect(client.calls).toHaveLength(1)
  })

  it('rejects a body with a non-decimal holding with 400 invalid_request', async () => {
    const app = await makeApp({})
    const payload = validBody()
    payload.holding = { quantity: '0,5', averageCost: '50000' }

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it('rejects a malformed JSON body with the same envelope', async () => {
    const app = await makeApp({})
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it('fails with 503 missing_key when no API key is configured', async () => {
    const app = await makeApp({ env: { GEMINI_API_KEY: '' } })
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'missing_key' } })
  })

  it('fails with 429 quota_exceeded when the internal budget is spent', async () => {
    const app = await makeApp({ saturateLimiter: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })

  it('maps an upstream 429 into quota_exceeded', async () => {
    const client = new FakeGeminiClient()
    client.error = { status: 429 }
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })

  it('maps a timeout into 504 timeout', async () => {
    const client = new FakeGeminiClient()
    client.error = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(504)
    expect(response.json()).toMatchObject({ error: { code: 'timeout' } })
  })

  it('maps non-JSON model output into 502 invalid_response', async () => {
    const client = new FakeGeminiClient()
    client.text = 'not json at all'
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_response' },
    })
  })

  it('truncates candle history to maxCandles before prompting', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client, maxCandles: 2 })
    const payload = validBody()
    payload.candles = [1, 2, 3, 4].map((index) => ({
      time: `2024-01-0${index}T00:00:00.000Z`,
      open: 50_000,
      high: 51_000,
      low: 49_000,
      close: 50_500,
      volume: 1000,
    }))

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload,
    })

    expect(response.statusCode).toBe(200)
    expect(client.calls).toHaveLength(1)
    const prompt = client.calls[0]!.prompt
    expect(prompt).toContain('2024-01-03T')
    expect(prompt).toContain('2024-01-04T')
    expect(prompt).not.toContain('2024-01-01T')
  })
})

describe('market collector lifecycle', () => {
  it('forwards the OHLC collector AbortSignal through the injected market fetch', async () => {
    let request: { input: string; init?: RequestInit } | undefined
    const app = await makeApp({
      env: { KRAKEN_REST_OHLC_WORKER_ENABLED: 'true' },
      marketFetch: async (input, init) => {
        request = { input, init }
        return new Response(
          JSON.stringify({ error: [], result: { XBTEUR: [], last: 0 } }),
        )
      },
    })

    await app.ready()

    expect(request?.input).toBe(
      'https://api.kraken.com/0/public/OHLC?pair=XBTEUR&interval=1',
    )
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(request?.init?.headers).get('accept')).toBe(
      'application/json',
    )
    await app.close()
  })

  it('rejects non-BTC-EUR intelligence streams before opening a connection', async () => {
    const app = await makeApp({})
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/stream?instrumentId=ETH-EUR',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'unsupported_instrument' },
    })

    const missingInstrument = await app.inject({
      method: 'GET',
      url: '/api/intelligence/stream',
    })
    expect(missingInstrument.statusCode).toBe(400)
  })

  it('does not start a collector when market ingestion is disabled by default', async () => {
    const collector = new FakeMarketCollector()
    const app = await buildApp({
      config: testConfigFrom({
        KRAKEN_WS_COLLECTOR_ENABLED: 'false',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
        PAPER_TRADING_ENABLED: 'false',
      }),
      overrides: { marketCollector: collector },
    })

    await app.ready()
    await app.close()

    expect(collector.starts).toEqual([])
    expect(collector.stopCount).toBe(0)
  })

  it('starts and stops an enabled collector through Fastify lifecycle hooks', async () => {
    const collector = new FakeMarketCollector()
    const store = new MarketStore({ path: ':memory:' })
    const app = await buildApp({
      config: testConfigFrom({
        KRAKEN_WS_COLLECTOR_ENABLED: 'true',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
        PAPER_TRADING_ENABLED: 'false',
      }),
      overrides: { marketCollector: collector, marketStore: store },
    })

    await app.ready()
    expect(collector.starts).toEqual(['BTC-EUR'])
    await app.close()

    expect(collector.stopCount).toBe(1)
  })
})

describe('browser market REST proxy', () => {
  const assetPairs = {
    error: [],
    result: { XBTEUR: { altname: 'XBTEUR', wsname: 'BTC/EUR' } },
  }
  const ohlc = {
    error: [],
    result: { XBTEUR: [[1_700_000_000, '1', '2', '0.5', '1.5', '1', '2']] },
  }

  function response(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: async () => body } as Response
  }

  it('forwards AssetPairs and OHLC to the configured public Kraken REST base', async () => {
    const calls: string[] = []
    const bodies = [assetPairs, ohlc]
    const marketFetch: MarketRestFetch = async (input) => {
      calls.push(input)
      return response(bodies[calls.length - 1])
    }
    const app = await makeApp({
      env: { KRAKEN_REST_URL: 'https://kraken.test/0/' },
      marketFetch,
    })

    const instruments = await app.inject({
      method: 'GET',
      url: '/api/market/instruments',
    })
    const history = await app.inject({
      method: 'GET',
      url: '/api/market/history?instrumentId=BTC-EUR',
    })

    expect(instruments.statusCode).toBe(200)
    expect(instruments.json()).toEqual(assetPairs)
    expect(history.statusCode).toBe(200)
    expect(history.json()).toEqual(ohlc)
    expect(calls).toEqual([
      'https://kraken.test/0/public/AssetPairs?pair=XBTEUR',
      'https://kraken.test/0/public/OHLC?pair=XBTEUR&interval=1',
    ])
  })

  it('rejects unsupported market history instruments with the existing 400 envelope', async () => {
    const marketFetch = async () => response({ error: [], result: {} })
    const app = await makeApp({ marketFetch })

    const responseForUnsupported = await app.inject({
      method: 'GET',
      url: '/api/market/history?instrumentId=ETH-EUR',
    })

    expect(responseForUnsupported.statusCode).toBe(400)
    expect(responseForUnsupported.json()).toEqual({
      error: {
        code: 'unsupported_instrument',
        message: 'Only BTC-EUR market history is supported.',
      },
    })
  })

  it('preserves an upstream HTTP status and JSON error body', async () => {
    const upstream = { error: ['EAPI:Rate limit exceeded'], result: {} }
    const app = await makeApp({
      marketFetch: async () => response(upstream, false, 429),
    })

    const result = await app.inject({
      method: 'GET',
      url: '/api/market/instruments',
    })

    expect(result.statusCode).toBe(429)
    expect(result.json()).toEqual(upstream)
  })

  it('maps a network failure from Kraken to a 502 upstream error', async () => {
    const app = await makeApp({
      marketFetch: async () => {
        throw new Error('network unavailable')
      },
    })

    const result = await app.inject({
      method: 'GET',
      url: '/api/market/instruments',
    })

    expect(result.statusCode).toBe(502)
    expect(result.json()).toEqual({
      error: {
        code: 'upstream_error',
        message: 'The Kraken market data service could not be reached.',
      },
    })
  })
})

describe('shadow run lifecycle and status endpoint', () => {
  const shadowDirectory = mkdtempSync(join(tmpdir(), 'balancita-app-shadow-'))

  afterEach(() => {
    rmSync(shadowDirectory, { recursive: true, force: true })
  })

  function storePath(): string {
    return join(
      shadowDirectory,
      `shadow-${Math.random().toString(36).slice(2)}.db`,
    )
  }

  async function makeAppWithStore(options: {
    enabled: boolean
    store: MarketStore
    env?: Record<string, string | undefined>
    marketFetch?: MarketRestFetch
    ohlcCollector?: OhlcCollectorLifecycle
  }) {
    const config = testConfigFrom({
      KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      PAPER_TRADING_ENABLED: 'false',
      ...(options.enabled ? { MARKET_COLLECTOR_ENABLED: 'true' } : {}),
      ...options.env,
    })
    if (
      config.krakenRestOhlcWorkerEnabled &&
      options.ohlcCollector === undefined &&
      options.marketFetch === undefined
    )
      throw new Error(
        'Enabled OHLC worker tests must inject a fake or fixture fetch.',
      )
    const app = await buildApp({
      config,
      overrides: {
        marketCollector: new FakeMarketCollector(),
        marketStore: options.store,
        ...(options.marketFetch === undefined
          ? {}
          : { marketFetch: options.marketFetch }),
        ...(options.ohlcCollector === undefined
          ? {}
          : { ohlcCollector: options.ohlcCollector }),
      },
    })
    return app
  }

  it('creates the canonical shadow run idempotently across onReady boots', async () => {
    const path = storePath()
    const firstCollector = new FakeMarketCollector()
    const firstStore = new MarketStore({ path })
    const firstApp = await buildApp({
      config: testConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'true',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: {
        marketCollector: firstCollector,
        marketStore: firstStore,
      },
    })

    await firstApp.ready()
    expect(firstCollector.starts).toEqual(['BTC-EUR'])
    expect(firstStore.shadowRunCount()).toBe(1)
    const run = firstStore.getShadowRun('shadow:BTC-EUR')
    expect(run?.id).toBe('shadow:BTC-EUR')
    expect(run?.status).toBe('collecting')
    expect(run?.plannedEndAt).toBe(run!.startedAt + 30 * 24 * 3_600_000)
    await firstApp.close()

    const againCollector = new FakeMarketCollector()
    const secondStore = new MarketStore({ path })
    const secondApp = await buildApp({
      config: testConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'true',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: {
        marketCollector: againCollector,
        marketStore: secondStore,
      },
    })

    await secondApp.ready()
    expect(againCollector.starts).toEqual(['BTC-EUR'])
    expect(secondStore.shadowRunCount()).toBe(1)
    expect(secondStore.getShadowRun('shadow:BTC-EUR')?.startedAt).toBe(
      run?.startedAt,
    )
    await secondApp.close()
  })

  it('creates the shadow run id configured through SHADOW_RUN_ID', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({
      enabled: true,
      store,
      env: { SHADOW_RUN_ID: 'shadow:BTC-EUR:kraken-1' },
    })

    await app.ready()
    expect(store.shadowRunCount()).toBe(1)
    const run = store.getShadowRun('shadow:BTC-EUR:kraken-1')
    expect(run?.id).toBe('shadow:BTC-EUR:kraken-1')
    expect(run?.status).toBe('collecting')
    expect(store.getShadowRun('shadow:BTC-EUR')).toBeUndefined()
    await app.close()
  })

  it('does not create a shadow run when the collector is disabled', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: false, store })

    await app.ready()
    expect(store.shadowRunCount()).toBe(0)
    expect(store.getShadowRun('shadow:BTC-EUR')).toBeUndefined()
    const [paperStatus, ohlcStatus] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/paper-trading/status' }),
      app.inject({ method: 'GET', url: '/api/market/collector/status' }),
    ])
    expect(paperStatus.json()).toMatchObject({
      enabled: false,
      running: false,
    })
    expect(ohlcStatus.json()).toMatchObject({
      enabled: false,
      running: false,
    })
    await app.close()
  })

  it('reports active collecting status before the 30-day window completes', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: true, store })

    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=BTC-EUR',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.error).toBeUndefined()
    expect(body.instrumentId).toBe('BTC-EUR')
    expect(body.state.kind).toBe('active')
    expect(body.state.view.computedStatus).toBe('collecting')
    expect(body.state.view.status).toBe('collecting')
    expect(body.state.view.run.id).toBe('shadow:BTC-EUR')
    expect(body.state.view.evaluatedOutcomeCount).toBe(0)
    expect(body.state.view.minimumEvidence).toBe(10)
    expect(typeof body.state.view.now).toBe('number')
    await app.close()
  })

  it('reports disabled when the collector is off and never invents run data', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: false, store })

    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=BTC-EUR',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.state.kind).toBe('disabled')
    expect(body.state.reason).toBe('collector_disabled')
    expect(body.state.view).toBeUndefined()
    await app.close()
  })

  it('rejects a non-BTC-EUR instrument with 400', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: true, store })

    const other = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=ETH-EUR',
    })
    expect(other.statusCode).toBe(400)
    expect(other.json()).toMatchObject({
      error: { code: 'unsupported_instrument' },
    })

    const missing = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status',
    })
    expect(missing.statusCode).toBe(400)
    await app.close()
  })

  it('reuses an existing run without mutating its start, end or policy', async () => {
    const path = storePath()
    const startedAt = 1_500_000_000_000
    const seededStore = new MarketStore({ path })
    const run = createShadowRunStart(
      startedAt,
      'BTC-EUR' as SupportedInstrumentId,
    )
    seededStore.createShadowRun(run, startedAt)
    expect(seededStore.shadowRunCount()).toBe(1)
    seededStore.close()

    const store = new MarketStore({ path })
    const app = await makeAppWithStore({ enabled: true, store })

    await app.ready()
    expect(store.shadowRunCount()).toBe(1)
    const existing = store.getShadowRun('shadow:BTC-EUR')
    expect(existing?.startedAt).toBe(startedAt)
    expect(existing?.plannedEndAt).toBe(startedAt + 30 * 24 * 3_600_000)
    expect(existing?.status).toBe('collecting')
    expect(existing?.versions.policyVersion).toBe('shadow-policy.v1')
    expect(store.listShadowStatuses('shadow:BTC-EUR')).toHaveLength(1)
    await app.close()
  })
})

describe('forecast loop lifecycle', () => {
  class FakeForecastScheduler implements ForecastLoopScheduler {
    readonly callbacks: Array<() => void> = []
    readonly intervals: number[] = []
    readonly cleared: unknown[] = []

    setInterval(callback: () => void, intervalMs: number): unknown {
      this.callbacks.push(callback)
      this.intervals.push(intervalMs)
      return this.callbacks.length
    }

    clearInterval(handle: unknown): void {
      this.cleared.push(handle)
    }
  }

  async function makeLoopApp(options: {
    enabled: boolean
    scheduler: FakeForecastScheduler
    runs: string[]
    failFirst?: boolean
  }) {
    const app = await buildApp({
      config: testConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'true',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
        ...(options.enabled
          ? { FORECAST_LOOP_ENABLED: 'true', FORECAST_LOOP_INTERVAL_MS: '2500' }
          : {}),
      }),
      overrides: {
        marketCollector: new FakeMarketCollector(),
        marketStore: new MarketStore({ path: ':memory:' }),
        forecastScheduler: options.scheduler,
        liveForecastService: {
          runOnce: () => {
            options.runs.push('tick')
            if (options.failFirst === true && options.runs.length === 1)
              throw new Error('tick failed')
            return null
          },
        },
      },
    })
    return app
  }

  it('starts the loop on ready and clears it on close when enabled', async () => {
    const scheduler = new FakeForecastScheduler()
    const runs: string[] = []
    const app = await makeLoopApp({ enabled: true, scheduler, runs })

    await app.ready()
    expect(scheduler.intervals).toEqual([2500])
    expect(scheduler.callbacks).toHaveLength(1)

    scheduler.callbacks[0]!()
    expect(runs).toEqual(['tick'])

    await app.close()
    expect(scheduler.cleared).toEqual([1])
  })

  it('does not start a loop when the flag is off', async () => {
    const scheduler = new FakeForecastScheduler()
    const runs: string[] = []
    const app = await makeLoopApp({ enabled: false, scheduler, runs })

    await app.ready()
    expect(scheduler.intervals).toEqual([])

    await app.close()
    expect(scheduler.cleared).toEqual([])
  })

  it('never lets a failing tick crash the server', async () => {
    const scheduler = new FakeForecastScheduler()
    const runs: string[] = []
    const app = await makeLoopApp({
      enabled: true,
      scheduler,
      runs,
      failFirst: true,
    })

    await app.ready()
    expect(() => scheduler.callbacks[0]!()).not.toThrow()
    expect(runs).toEqual(['tick'])
    await app.close()
  })
})

describe('news polling lifecycle', () => {
  class FakeNewsScheduler implements ForecastLoopScheduler {
    readonly callbacks: Array<() => void> = []
    readonly intervals: number[] = []
    readonly cleared: unknown[] = []

    setInterval(callback: () => void, intervalMs: number): unknown {
      this.callbacks.push(callback)
      this.intervals.push(intervalMs)
      return this.callbacks.length
    }

    clearInterval(handle: unknown): void {
      this.cleared.push(handle)
    }
  }

  it('starts opt-in polling at the configured interval with injected feed I/O', async () => {
    const scheduler = new FakeNewsScheduler()
    const store = new MarketStore({ path: ':memory:' })
    const body = readFileSync(
      new URL('../features/news/__fixtures__/sec.rss', import.meta.url),
      'utf8',
    )
    const calls: string[] = []
    const newsFetch: NewsHttpFetcher = async (url) => {
      calls.push(url)
      return { status: 200, body }
    }
    const app = await buildApp({
      config: testConfigFrom({
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
        PAPER_TRADING_ENABLED: 'false',
        NEWS_POLLING_ENABLED: 'true',
        NEWS_POLL_INTERVAL_MS: '2500',
        NEWS_STALE_AFTER_MS: '5000',
      }),
      overrides: {
        marketStore: store,
        newsFetch,
        newsScheduler: scheduler,
        newsClock: () => Date.parse('2026-09-22T00:00:00.000Z') as never,
      },
    })

    await app.ready()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scheduler.intervals).toEqual([2500])
    expect(calls).toContain('https://www.sec.gov/news/pressreleases.rss')
    expect(store.newsEvidenceCount()).toBe(3)

    await app.close()
    expect(scheduler.cleared).toEqual([1])
  })
})
