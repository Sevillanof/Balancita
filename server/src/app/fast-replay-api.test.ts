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
    for (let index = 0; index < 80; index += 1) {
      const timestamp = now - 10_000 + index * 60
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
    const start = (now - 10_000) * 1000
    const end = (now - 10_000 + 79 * 60) * 1000
    const run = await app.inject({
      method: 'POST',
      url: '/api/replay/fast-run',
      payload: {
        strategy_id: 'donchian-volume-breakout',
        start_time: start,
        end_time: end,
      },
    })
    expect(run.statusCode).toBe(200)
    expect(run.json().strategyId).toBe('micro-donchian-breakout')
    expect(run.json().id).toMatch(/^fast-/)
    expect(Number.isSafeInteger(run.json().raw_signals_count)).toBe(true)
    expect(Number.isSafeInteger(run.json().gate_rejections_count)).toBe(true)
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
    expect(history.json().runs).toHaveLength(1)
    expect(history.json().runs[0]).toMatchObject({
      id: run.json().id,
      strategyId: 'micro-donchian-breakout',
      trades: run.json().trades,
      netPnlEur: run.json().netPnlEur,
      candlesEvaluated: 80,
      raw_signals_count: run.json().raw_signals_count,
      gate_rejections_count: run.json().gate_rejections_count,
      window: { start_time: start, end_time: end },
      datasetHash: expect.any(String),
      contentHash: expect.any(String),
      createdAt: expect.any(Number),
      request: { strategy_id: 'micro-donchian-breakout' },
    })
    expect(history.json().runs[0]).not.toHaveProperty('result')
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

  it('runs and persists only the latest contiguous segment, and rejects a short latest segment', async () => {
    const store = temporaryStore()
    const now = Math.floor(Date.now() / 1000)
    const candle = (timestamp: number) => ({
      timestamp,
      open: 30_000,
      high: 30_002,
      low: 29_999,
      close: 30_001,
      volume: 10,
    })
    const older = Array.from({ length: 60 }, (_, i) =>
      candle(now - 10_000 + i * 60),
    )
    const recent = Array.from({ length: 55 }, (_, i) =>
      candle(now - 5_000 + i * 60),
    )
    store.insertOhlcCandles([...older, ...recent])
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
        start_time: older[0]!.timestamp * 1000,
        end_time: recent.at(-1)!.timestamp * 1000,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      candlesEvaluated: 55,
      window: {
        start_time: recent[0]!.timestamp * 1000,
        end_time: recent.at(-1)!.timestamp * 1000,
      },
    })
    const saved = store.listFastReplayRuns()[0] as {
      request: { start_time: number; end_time: number }
      result: { candlesEvaluated: number }
    }
    expect(saved.request).toEqual({
      strategy_id: 'micro-trend-pullback',
      start_time: recent[0]!.timestamp * 1000,
      end_time: recent.at(-1)!.timestamp * 1000,
      ticket_eur: 30,
    })
    expect(saved.result.candlesEvaluated).toBe(55)
    await app.close()

    const shortStore = temporaryStore()
    shortStore.insertOhlcCandles([...older, ...recent.slice(0, 50)])
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
        start_time: older[0]!.timestamp * 1000,
        end_time: recent[49]!.timestamp * 1000,
      },
    })
    expect(short.statusCode).toBe(422)
    expect(short.json().error.code).toBe('insufficient_ohlc')
    await shortApp.close()
  })
})
