import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import {
  analyticsUrl,
  createAnalyticsClient,
  parseAnalytics,
} from './market-analytics.ts'

const M = 60_000
const T = 1_791_358_200_000
const BTC = 'PF_XBTUSD'

const dirs: string[] = []
function dbPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'balancita-analytics-'))
  dirs.push(path)
  return join(path, 'market.sqlite')
}
afterEach(() => {
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true })
})

const seconds = (ms: number) => ms / 1000
const cvd = (buy: string[], sell: string[], start = T) =>
  JSON.stringify({
    result: {
      timestamp: buy.map((_, index) => seconds(start + index * M)),
      data: {
        buy_volume: buy,
        sell_volume: sell,
        cvd: buy.map(() => '0'),
      },
      more: false,
    },
    errors: [],
  })
const parse = (raw: string, metric: 'cvd' | 'open-interest' = 'cvd') =>
  parseAnalytics(raw, {
    productId: BTC,
    metric,
    intervalMs: M,
    fromMs: T,
    receivedAtMs: T + 3 * M + 10_000,
  })

describe('Kraken futures analytics', () => {
  it('builds the public analytics URL in seconds', () => {
    expect(analyticsUrl(BTC, 'cvd', M, T)).toBe(
      `https://futures.kraken.com/api/charts/v1/analytics/PF_XBTUSD/cvd?since=${seconds(T)}&interval=60`,
    )
    expect(() => analyticsUrl(BTC, 'cvd', 5 * M, T)).toThrow(RangeError)
    expect(() => analyticsUrl('XBTUSD', 'cvd', M, T)).toThrow(TypeError)
  })

  it('flattens nested series and drops the bucket still filling', () => {
    const parsed = parse(cvd(['1.5', '2', '0.25'], ['0.5', '3', '1']))
    // Third bucket ends at T+3M; receipt is T+3M+10s, so it is settled.
    expect(parsed.points).toEqual([
      {
        bucketStart: T,
        values: { buy_volume: '1.5', sell_volume: '0.5', cvd: '0' },
      },
      {
        bucketStart: T + M,
        values: { buy_volume: '2', sell_volume: '3', cvd: '0' },
      },
      {
        bucketStart: T + 2 * M,
        values: { buy_volume: '0.25', sell_volume: '1', cvd: '0' },
      },
    ])
    const filling = parseAnalytics(cvd(['1', '2'], ['1', '2']), {
      productId: BTC,
      metric: 'cvd',
      intervalMs: M,
      fromMs: T,
      receivedAtMs: T + 2 * M,
    })
    expect(filling.points.map((point) => point.bucketStart)).toEqual([T])
  })

  it('names OHLC tuples and accepts JSON numbers', () => {
    const raw = JSON.stringify({
      result: {
        timestamp: [seconds(T)],
        data: [['2192.1466', 2193.8, '2192.1', '2193.7759']],
        more: true,
      },
      errors: [],
    })
    const parsed = parse(raw, 'open-interest')
    expect(parsed.more).toBe(true)
    expect(parsed.points[0]!.values).toEqual({
      open: '2192.1466',
      high: '2193.8',
      low: '2192.1',
      close: '2193.7759',
    })
  })

  it('leaves out the values Kraken reports as null', () => {
    const raw = JSON.stringify({
      result: {
        timestamp: [seconds(T)],
        data: { bid: { slippage1m: [null], bestPrice: ['0.61'] } },
        more: false,
      },
      errors: [],
    })
    expect(parse(raw).points[0]!.values).toEqual({ 'bid.bestPrice': '0.61' })
  })

  it('rejects misaligned or malformed responses', () => {
    const misaligned = JSON.stringify({
      result: {
        timestamp: [seconds(T) + 1],
        data: ['1'],
        more: false,
      },
      errors: [],
    })
    expect(() => parse(misaligned)).toThrow('interval-aligned')
    const short = JSON.stringify({
      result: { timestamp: [seconds(T)], data: { a: ['1'], b: [] } },
      errors: [],
    })
    expect(() => parse(short)).toThrow('aligned')
    const text = JSON.stringify({
      result: { timestamp: [seconds(T)], data: ['abc'] },
      errors: [],
    })
    expect(() => parse(text)).toThrow('decimal')
  })

  it('fetches through the injected client', async () => {
    const urls: string[] = []
    const client = createAnalyticsClient({
      clock: () => T + 3 * M + 10_000,
      fetch: async (url) => {
        urls.push(url)
        return new Response(cvd(['1'], ['2']))
      },
    })
    const result = await client.fetch(BTC, 'cvd', M, T)
    expect(urls).toHaveLength(1)
    expect(result.points).toHaveLength(1)
    client.close()
    await expect(client.fetch(BTC, 'cvd', M, T)).rejects.toThrow('closed')
  })
})

describe('FuturesMarketStore analytics', () => {
  it('stores only new knowledge and serves the latest revision per bucket', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(store.schemaVersion()).toBe(7)
    const first = parse(cvd(['1', '2'], ['1', '1']))
    expect(store.appendAnalytics(first)).toEqual({ inserted: 2 })
    // A re-fetch of the same history writes nothing.
    expect(store.appendAnalytics(parse(cvd(['1', '2'], ['1', '1'])))).toEqual({
      inserted: 0,
    })
    // A revised bucket and a new bucket are kept.
    const revised = parseAnalytics(cvd(['1', '2.5', '4'], ['1', '1', '1']), {
      productId: BTC,
      metric: 'cvd',
      intervalMs: M,
      fromMs: T,
      receivedAtMs: T + 3 * M + 20_000,
    })
    expect(store.appendAnalytics(revised)).toEqual({ inserted: 2 })
    expect(
      store
        .analyticsSince(BTC, 'cvd', M, T, 10)
        .map((point) => [point.bucketStart, point.values.buy_volume]),
    ).toEqual([
      [T, '1'],
      [T + M, '2.5'],
      [T + 2 * M, '4'],
    ])
    expect(store.analyticsSince(BTC, 'cvd', M, T + M, 1)).toHaveLength(1)
    expect(store.latestAnalyticsBucket(BTC, 'cvd', M)).toBe(T + 2 * M)
    expect(store.latestAnalyticsBucket(BTC, 'open-interest', M)).toBe(undefined)
    store.close()
  })

  it('keeps analytics evidence append-only and readable by followers', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.appendAnalytics(parse(cvd(['1'], ['1'])))
    expect(() =>
      (
        store as unknown as {
          db: { exec(sql: string): void }
        }
      ).db.exec('DELETE FROM paper_futures_analytics_points'),
    ).toThrow('immutable')
    const reader = new FuturesMarketStore(path, { readOnly: true })
    expect(reader.analyticsSince(BTC, 'cvd', M, 0, 10)).toHaveLength(1)
    expect(() => reader.appendAnalytics(parse(cvd(['1'], ['1'])))).toThrow(
      'read-only',
    )
    reader.close()
    store.close()
  })
})
