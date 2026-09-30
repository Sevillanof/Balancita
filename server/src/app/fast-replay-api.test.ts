import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { MarketStore } from '../features/market-data/market-store.ts'
import { serverConfigFrom } from '../platform/config.ts'
import type { TimestampMs } from '../domain/contracts.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-fast-api-'))
  directories.push(directory)
  return new MarketStore({ path: join(directory, 'market.sqlite') })
}

describe('Fast Replay API', () => {
  it('marks open holds and C27 time-stop distance through the latest closed 15m bucket end', async () => {
    const store = temporaryStore()
    const bucketEnd = Math.floor(Date.now() / 900_000) * 900
    const firstTimestamp = bucketEnd - 51 * 900
    store.insertOhlcCandles(
      Array.from({ length: 51 * 15 }, (_, index) => ({
        timestamp: firstTimestamp + index * 60,
        open: 100,
        high: 105,
        low: 85,
        close: 100,
        volume: 10,
      })),
    )
    store.insertPaperOrder({
      strategyId: 'micro-donchian-breakout',
      signalTimestamp: bucketEnd - 8 * 900,
      action: 'BUY',
      gatePassed: true,
      price: 100,
      executionTimestamp: bucketEnd - 8 * 900,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0,
    })
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: { marketStore: store },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/paper-trading/positions?status=open',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({
      status: 'OPEN',
      holding_bars_15m: 8,
      exit_distance_label: 'Distancia al nivel de salida',
    })
    expect(response.json()[0].exit_distance_pct).toBeCloseTo(0.5)
    await app.close()
  })

  it('exposes all live strategy metrics and causal positions separately from Fast Replay', async () => {
    const store = temporaryStore()
    store.insertPaperOrder({
      strategyId: 'micro-trend-pullback',
      signalTimestamp: 900,
      action: 'BUY',
      gatePassed: true,
      price: 100,
      executionTimestamp: 900,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0,
    })
    store.insertPaperOrder({
      strategyId: 'micro-trend-pullback',
      signalTimestamp: 1800,
      action: 'SELL',
      gatePassed: true,
      price: 110,
      executionTimestamp: 1800,
      amountEur: 30,
      feeEur: 0.033,
      pnlEur: 2.9,
      targetPct: 0,
    })
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: { marketStore: store },
    })
    const summary = await app.inject({
      method: 'GET',
      url: '/api/paper-trading/strategies-summary',
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toHaveLength(4)
    expect(summary.json()[0]).toMatchObject({
      strategy_id: 'micro-trend-pullback',
      name: 'C25: Trend Pullback',
      total_signals: 1,
      approval_rate_pct: 100,
      executed_buys: 1,
      executed_sells: 1,
      open_positions_count: 0,
      closed_trades: 1,
      net_pnl_eur: 2.9,
      brier_score: null,
      avg_target_pct: 0,
    })
    const positions = await app.inject({
      method: 'GET',
      url: '/api/paper-trading/positions?status=closed&limit=50',
    })
    expect(positions.json()).toMatchObject([
      {
        id: 1,
        status: 'CLOSED',
        entry_time: new Date(900_000).toISOString(),
        exit_time: new Date(1_800_000).toISOString(),
        holding_bars_15m: 1,
        net_pnl_eur: 2.9,
      },
    ])
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/paper-trading/positions?status=pending',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/paper-trading/positions?limit=201',
        })
      ).statusCode,
    ).toBe(400)
    await app.close()
  })

  it('lists active strategy candidates only and rejects archived candidate ids', async () => {
    const store = temporaryStore()
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: { marketStore: store },
    })
    const response = await app.inject({ method: 'GET', url: '/api/strategies' })
    expect(response.statusCode).toBe(200)
    expect(response.json().strategies).toEqual([
      {
        id: 'micro-trend-pullback',
        status: 'active',
        name: 'micro-trend-pullback',
      },
      {
        id: 'micro-bollinger-reversion',
        status: 'active',
        name: 'micro-bollinger-reversion',
      },
      {
        id: 'micro-donchian-breakout',
        status: 'active',
        name: 'micro-donchian-breakout',
      },
      {
        id: 'micro-regime-adapter',
        status: 'active',
        name: 'micro-regime-adapter',
      },
    ])
    const archived = await app.inject({
      method: 'POST',
      url: '/api/replay/fast-run',
      payload: { strategy_id: 'technical-default' },
    })
    expect(archived.statusCode).toBe(400)
    await app.close()
  })

  it('serves bounded chronological paper audit events and validates the requested limit', async () => {
    const store = temporaryStore()
    store.insertPaperOrder({
      strategyId: 'micro-test',
      signalTimestamp: 120,
      action: 'BUY',
      gatePassed: false,
      price: 10,
      executionTimestamp: null,
      amountEur: 30,
      feeEur: 0,
      pnlEur: null,
      targetPct: 0,
    })
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: { marketStore: store },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/paper-trading/orders?limit=1',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      orders: [
        {
          id: 1,
          strategyId: 'micro-test',
          signalTimestamp: 120,
          action: 'BUY',
          gatePassed: false,
          executionTimestamp: null,
          amountEur: 30,
        },
      ],
    })
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/paper-trading/orders?limit=1.5',
        })
      ).statusCode,
    ).toBe(400)
    await app.close()
  })

  it('syncs closed fixture candles, serves bounded persisted OHLC, canonicalizes legacy strategy ids, and appends run history', async () => {
    const store = temporaryStore()
    const now = Math.floor(Date.now() / 1000)
    const fixture = {
      error: [],
      result: {
        XBTEUR: [
          [now - 300, '30000', '30002', '29999', '30001', '30000', '2', 5],
          [now - 240, '30001', '30003', '30000', '30002', '30001', '2', 5],
        ],
        last: now,
      },
    }
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: {
        marketStore: store,
        marketFetch: async () => new Response(JSON.stringify(fixture)),
      },
    })
    const sync = await app.inject({
      method: 'POST',
      url: '/api/market/sync-ohlc',
      payload: { hours: 1 },
    })
    expect(sync.statusCode).toBe(200)
    expect(sync.json()).toEqual({
      inserted: 2,
      gaps_detected: 0,
      requested_hours: 1,
      maximum_candles: 720,
      coverage: {
        candle_count: 2,
        first_candle_time: (now - 300) * 1000,
        last_candle_time: (now - 240) * 1000,
      },
    })
    const ohlc = await app.inject({
      method: 'GET',
      url: `/api/market/ohlc?start_time=${(now - 300) * 1000}&end_time=${now * 1000}`,
    })
    expect(ohlc.json().candles[0].timestamp).toBe((now - 300) * 1000)
    const replayStart = Math.ceil((now + 60) / 900) * 900
    for (let index = 0; index < 80; index += 1) {
      const timestamp = replayStart + index * 60
      store.upsertOhlcCandles([
        {
          timestamp,
          open: 30_000 + index,
          high: 30_002 + index,
          low: 29_999 + index,
          close: 30_001 + index,
          volume: 10,
        },
      ])
    }
    const start = replayStart * 1000
    const end = (replayStart + 79 * 60) * 1000
    const run = await app.inject({
      method: 'POST',
      url: '/api/replay/fast-run',
      payload: {
        strategy_id: 'donchian-volume-breakout',
        start_time: start,
        end_time: end,
        ticket_eur: 47,
      },
    })
    expect(run.statusCode).toBe(200)
    expect(run.json().strategyId).toBe('micro-donchian-breakout')
    expect(run.json().artifact).toMatchObject({
      schema: 'fast-replay-artifact.v1',
      timestampUnit: 'unix-seconds',
      candleIntervalSeconds: 60,
      candles: expect.any(Array),
    })
    expect(run.json().artifact.candles).toHaveLength(80)
    expect(run.json().artifact.datasetHash).toBe(run.json().datasetHash)
    expect(run.json().artifact.initialCashEur).toBe(47)
    expect(run.json().sizingModel).toBe('cash-all-in.v1')
    expect(run.json().initialCashEur).toBe(47)
    expect(run.json().id).toMatch(/^fast-/)
    expect(Number.isSafeInteger(run.json().raw_signals_count)).toBe(true)
    expect(Number.isSafeInteger(run.json().gate_rejections_count)).toBe(true)
    const persistedLegacyResult = {
      ...(run.json() as Record<string, unknown>),
    }
    delete persistedLegacyResult.feeScenario
    delete persistedLegacyResult.costCaveat
    delete persistedLegacyResult.sizingModel
    delete persistedLegacyResult.initialCashEur
    delete persistedLegacyResult.availableCashEur
    delete persistedLegacyResult.finalEquityEur
    delete persistedLegacyResult.artifact
    store.saveFastReplayRun(
      'fast-legacy-fees',
      {},
      persistedLegacyResult,
      'legacy-dataset',
      'legacy-content',
      2 as TimestampMs,
    )
    store.saveFastReplayRun(
      'fast-malformed-fees',
      {},
      {
        ...(run.json() as Record<string, unknown>),
        feeScenario: { version: 'unknown', commissionRate: 0.008 },
      },
      'malformed-dataset',
      'malformed-content',
      3 as TimestampMs,
    )
    store.saveFastReplayRun(
      'fast-corrupt',
      {},
      { strategyId: 'micro-donchian-breakout' },
      'bad-dataset-hash',
      'bad-content-hash',
      1 as TimestampMs,
    )
    const history = await app.inject({
      method: 'GET',
      url: '/api/replay/fast-run/history?limit=10',
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().runs).toHaveLength(3)
    const returnedRuns = history.json().runs as Record<string, unknown>[]
    const legacy = returnedRuns.find(({ id }) => id === 'fast-legacy-fees')
    const malformed = returnedRuns.find(
      ({ id }) => id === 'fast-malformed-fees',
    )
    const fresh = returnedRuns.find(({ id }) => id === run.json().id)
    expect(legacy).toMatchObject({
      feeScenario: null,
      costCaveat: expect.stringMatching(/provenance is unknown/i),
      artifactStatus: 'unavailable',
    })
    expect(legacy).not.toHaveProperty('sizingModel')
    expect(malformed).toMatchObject({
      feeScenario: null,
      costCaveat: expect.stringMatching(/provenance is unknown/i),
    })
    expect(fresh).toMatchObject({
      feeScenario: run.json().feeScenario,
      costCaveat: expect.stringMatching(/historical recorded fees/i),
      sizingModel: 'cash-all-in.v1',
      initialCashEur: 47,
    })
    expect(fresh).toMatchObject({
      id: run.json().id,
      strategyId: 'micro-donchian-breakout',
      trades: run.json().trades,
      netPnlEur: run.json().netPnlEur,
      candlesEvaluated: 5,
      raw_signals_count: run.json().raw_signals_count,
      gate_rejections_count: run.json().gate_rejections_count,
      window: { start_time: start, end_time: end },
      datasetHash: expect.any(String),
      contentHash: expect.any(String),
      createdAt: expect.any(Number),
      request: { strategy_id: 'micro-donchian-breakout' },
    })
    expect(legacy).not.toHaveProperty('result')
    expect(legacy).not.toHaveProperty('sizingModel')
    expect(fresh).not.toHaveProperty('result')
    expect(fresh).not.toHaveProperty('artifact')
    const runRecord = run.json() as {
      id: string
      datasetHash: string
      artifact: {
        runId: string
        candles: {
          timestamp: number
          open: number
          high: number
          low: number
          close: number
          volume: number
        }[]
      }
    }
    const frozenBeforeMutation = runRecord.artifact.candles
    store.upsertOhlcCandles([
      {
        timestamp: replayStart,
        open: 999,
        high: 1000,
        low: 998,
        close: 999,
        volume: 1,
      },
    ])
    const artifactResponse = await app.inject({
      method: 'GET',
      url: `/api/replay/fast-run/history/${runRecord.id}/artifact`,
    })
    expect(artifactResponse.statusCode).toBe(200)
    expect(artifactResponse.json()).toMatchObject({
      artifactStatus: 'verified',
      artifact: { runId: runRecord.id, candles: frozenBeforeMutation },
    })
    expect(artifactResponse.json().artifact.candles[0].open).toBe(30_000)
    const invalidArtifact = runRecord.artifact
    store.saveFastReplayRun(
      'fast-invalid-artifact',
      {},
      {
        ...runRecord,
        id: 'fast-invalid-artifact',
        artifact: {
          ...invalidArtifact,
          runId: 'fast-invalid-artifact',
          candles: invalidArtifact.candles.map((candle, index) =>
            index === 0 ? { ...candle, close: candle.close + 1 } : candle,
          ),
        },
      },
      runRecord.datasetHash,
      'invalid-artifact-content',
    )
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/replay/fast-run/history/fast-invalid-artifact/artifact',
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/replay/fast-run/history/fast-legacy-fees/artifact',
        })
      ).statusCode,
    ).toBe(404)
    const persistedAfterRead = store
      .listFastReplayRuns()
      .find(
        (stored) => (stored as { id: string }).id === 'fast-legacy-fees',
      ) as {
      result: Record<string, unknown>
    }
    expect(persistedAfterRead.result).not.toHaveProperty('feeScenario')
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/replay/fast-run',
          payload: { strategy_id: 'technical-default' },
        })
      ).statusCode,
    ).toBe(400)
    await app.close()
  })

  it('defaults to the provider maximum and rejects larger lookbacks without fetching', async () => {
    const store = temporaryStore()
    const requestedUrls: URL[] = []
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: {
        marketStore: store,
        marketFetch: async (input) => {
          requestedUrls.push(new URL(input))
          return new Response(
            JSON.stringify({ error: [], result: { XBTEUR: [], last: 1000 } }),
          )
        },
      },
    })
    const excessive = await app.inject({
      method: 'POST',
      url: '/api/market/sync-ohlc',
      payload: { hours: 24 },
    })
    expect(excessive.statusCode).toBe(400)
    expect(requestedUrls).toHaveLength(0)

    const defaultRequest = await app.inject({
      method: 'POST',
      url: '/api/market/sync-ohlc',
    })
    expect(defaultRequest.statusCode).toBe(200)
    expect(requestedUrls).toHaveLength(1)
    const since = Number(requestedUrls[0]?.searchParams.get('since'))
    const expectedSince = Math.floor(Date.now() / 1000) - 12 * 60 * 60
    expect(since).toBeGreaterThanOrEqual(expectedSince - 1)
    expect(since).toBeLessThanOrEqual(expectedSince + 1)
    expect(defaultRequest.json()).toMatchObject({
      requested_hours: 12,
      maximum_candles: 720,
      coverage: {
        candle_count: 0,
        first_candle_time: null,
        last_candle_time: null,
      },
    })
    await app.close()
  })

  it('runs the frozen TypeScript decision trace through the Python ledger and persists its distinct identity', async () => {
    const store = temporaryStore()
    const now = Math.floor(Date.now() / 1000)
    const start = Math.ceil((now + 120) / 900) * 900
    const candles = Array.from({ length: 780 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 30_000 + index,
      high: 30_002 + index,
      low: 29_999 + index,
      close: 30_001 + index,
      volume: 10,
    }))
    store.insertOhlcCandles(candles)
    const app = await buildApp({
      config: serverConfigFrom({
        KRAKEN_WS_COLLECTOR_ENABLED: 'false',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: { marketStore: store },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/replay/python-ledger-run',
      payload: {
        strategy_id: 'micro-trend-pullback',
        start_time: candles[0]!.timestamp * 1000,
        end_time: candles.at(-1)!.timestamp * 1000,
        ticket_eur: 47,
      },
    })

    expect(response.statusCode).toBe(200)
    const run = response.json()
    expect(run).toMatchObject({
      strategyOwner: 'typescript-native',
      ledgerOwner: 'python-ledger',
      comparator: { status: 'not_comparable' },
      artifact: {
        schema: 'fast-replay-artifact.v1',
        engineOwner: 'typescript',
        candles: expect.any(Array),
      },
      pythonLedger: {
        status: 'replayed',
        parameters: { startingCash: 47 },
        costIdentity: { commissionRate: 0.008, slippageRate: 0.0005 },
        inputWindow: {
          barCount: 52,
          barTimesMs: expect.any(Array),
        },
        decisionInputs: expect.any(Array),
        ledger: {
          metrics: { finalEquity: expect.any(Number) },
          fills: expect.any(Array),
        },
        executionAudit: {
          version: 'python-replay-execution.v1',
          executionBasis: 'next_bar_open_model_only',
        },
      },
    })
    expect(run.artifact.candles).toHaveLength(780)
    expect(run.pythonLedger.inputWindow.barTimesMs[0]).toBe(
      (start + 900) * 1000,
    )
    expect(run.pythonLedger.decisionInputs).toHaveLength(3)
    expect(
      run.pythonLedger.decisionInputs.every(
        (signal: { directTarget: string; time: number }) =>
          (signal.directTarget === 'flat' || signal.directTarget === 'long') &&
          signal.time % 900_000 === 0,
      ),
    ).toBe(true)

    const history = await app.inject({
      method: 'GET',
      url: '/api/replay/fast-run/history?limit=10',
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().runs).toContainEqual(
      expect.objectContaining({
        id: run.id,
        strategyOwner: 'typescript-native',
        ledgerOwner: 'python-ledger',
        pythonLedger: expect.objectContaining({
          ledger: expect.objectContaining({ metrics: expect.any(Object) }),
        }),
      }),
    )
    const storedArtifact = await app.inject({
      method: 'GET',
      url: `/api/replay/fast-run/history/${encodeURIComponent(run.id)}/artifact`,
    })
    expect(storedArtifact.statusCode).toBe(200)
    expect(storedArtifact.json()).toMatchObject({
      artifactStatus: 'verified',
      artifact: {
        runId: run.id,
        datasetHash: run.datasetHash,
        candles: run.artifact.candles,
      },
    })
    await app.close()
  })

  it('replays the full persisted contiguous history and rejects short 1m history', async () => {
    const store = temporaryStore()
    const now = Math.floor(Date.now() / 1000)
    const start = Math.ceil((now + 60) / 900) * 900
    const candle = (timestamp: number) => ({
      timestamp,
      open: 30_000,
      high: 30_002,
      low: 29_999,
      close: 30_001,
      volume: 10,
    })
    const history = Array.from({ length: 780 }, (_, i) =>
      candle(start + i * 60),
    )
    store.insertOhlcCandles(history)
    const app = await buildApp({
      config: serverConfigFrom({
        KRAKEN_WS_COLLECTOR_ENABLED: 'false',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: { marketStore: store },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/replay/fast-run',
      payload: {
        strategy_id: 'micro-trend-pullback',
        start_time: history[0]!.timestamp * 1000,
        end_time: history.at(-1)!.timestamp * 1000,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().artifact).toMatchObject({
      schema: 'fast-replay-artifact.v1',
      engineOwner: 'typescript',
      timestampUnit: 'unix-seconds',
      candleIntervalSeconds: 60,
      candleTimestampSemantics: 'bucket-start',
      candles: expect.any(Array),
    })
    expect(response.json().artifact.candles).toHaveLength(780)
    expect(Buffer.byteLength(JSON.stringify(response.json().artifact))).toBe(
      70_315,
    )
    expect(response.json()).toMatchObject({
      candlesEvaluated: 52,
      window: {
        start_time: history[0]!.timestamp * 1000,
        end_time: history.at(-1)!.timestamp * 1000,
      },
    })
    const saved = store.listFastReplayRuns()[0] as {
      request: { start_time: number; end_time: number }
      result: { candlesEvaluated: number }
    }
    expect(saved.request).toEqual({
      strategy_id: 'micro-trend-pullback',
      start_time: history[0]!.timestamp * 1000,
      end_time: history.at(-1)!.timestamp * 1000,
      ticket_eur: 30,
    })
    expect(saved.result.candlesEvaluated).toBe(52)
    await app.close()

    const shortStore = temporaryStore()
    shortStore.insertOhlcCandles(history.slice(0, 50))
    const shortApp = await buildApp({
      config: serverConfigFrom({
        KRAKEN_WS_COLLECTOR_ENABLED: 'false',
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: { marketStore: shortStore },
    })
    const short = await shortApp.inject({
      method: 'POST',
      url: '/api/replay/fast-run',
      payload: {
        strategy_id: 'micro-trend-pullback',
        start_time: history[0]!.timestamp * 1000,
        end_time: history[49]!.timestamp * 1000,
      },
    })
    expect(short.statusCode).toBe(422)
    expect(short.json().error.code).toBe('insufficient_ohlc')
    await shortApp.close()
  })
})
