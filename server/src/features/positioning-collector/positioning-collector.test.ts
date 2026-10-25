import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCatalog } from './catalog.ts'
import { PositioningCollector } from './collector.ts'
import { createPositioningSource, parseCloses, premiumRows } from './source.ts'
import { HOUR_MS, PositioningStore } from './store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'positioning-'))
  dirs.push(dir)
  return new PositioningStore(join(dir, 'p.sqlite'))
}

// 2026-01-01T10:30Z: hours up to 09:00 are closed.
const NOW = Date.UTC(2026, 0, 1, 10, 30, 30)
const FROM = Date.UTC(2025, 11, 31, 20)

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function fakeFetch(options: { fail?: string } = {}) {
  const urls: string[] = []
  const fetch = async (input: string) => {
    urls.push(input)
    if (options.fail && input.includes(options.fail))
      return new Response('nope', { status: 500 })
    const url = new URL(input)
    if (url.pathname.includes('/analytics/')) {
      const since = Number(url.searchParams.get('since')) * 1000
      const start = Math.max(since, FROM)
      const stamps: number[] = []
      for (let t = start; t <= NOW; t += HOUR_MS) stamps.push(t / 1000)
      const top = url.pathname.endsWith('top-traders')
      const data = top
        ? {
            top20Percent: {
              openInterest: stamps.map(() => '100.5'),
              longCount: stamps.map(() => 80),
              shortCount: stamps.map(() => 20),
              longPercent: stamps.map(() => '80.00'),
              shortPercent: stamps.map(() => '20.00'),
              ratio: stamps.map(() => '4.00'),
            },
          }
        : {
            longCount: stamps.map(() => 60),
            shortCount: stamps.map(() => 40),
            longPercent: stamps.map(() => '60.00'),
            shortPercent: stamps.map(() => '40.00'),
            ratio: stamps.map(() => '1.50'),
          }
      return json({ result: { timestamp: stamps, data, more: false } })
    }
    const kind = url.pathname.split('/')[4]
    const step = url.pathname.endsWith('1m') ? 60_000 : HOUR_MS
    const from = Math.max(Number(url.searchParams.get('from')) * 1000, FROM)
    const to = Number(url.searchParams.get('to')) * 1000
    const candles = []
    for (let t = Math.ceil(from / step) * step; t <= to; t += step)
      candles.push({
        time: t,
        open: '1',
        high: '1',
        low: '1',
        close: kind === 'mark' ? '101' : '100',
        volume: '0',
      })
    return json({ candles })
  }
  return { fetch, urls }
}

const card = (extra: Record<string, unknown>) => ({
  products: 'pinned',
  consumers: [{ kind: 'chart', id: 'terminal' }],
  state: 'active',
  ...extra,
})
export const FULL_CATALOG = JSON.stringify({
  version: 'indicators.v1',
  purge_after_days: 14,
  indicators: [
    card({
      id: 'pos',
      series: 'positioning',
      resolution: '1h',
      history_from: '2025-12-31',
    }),
    card({
      id: 'prima-h',
      series: 'premium',
      resolution: '1h',
      history_from: '2025-12-31',
    }),
    card({ id: 'prima-m', series: 'premium', resolution: '1m', keep_days: 7 }),
  ],
})

const collector = (
  store: PositioningStore,
  fetched: ReturnType<typeof fakeFetch>,
  catalog = parseCatalog(FULL_CATALOG, ['PF_XBTUSD']),
) =>
  new PositioningCollector({
    store,
    source: createPositioningSource({ fetch: fetched.fetch, clock: () => NOW }),
    catalog,
    clock: () => NOW,
    pause: async () => undefined,
  })

describe('positioning collector', () => {
  it('stores closed hours only, with both sides of the account split', async () => {
    const store = open()
    expect(await collector(store, fakeFetch()).syncOnce()).toBe(0)
    const rows = store.positioningSince('PF_XBTUSD', 0)
    expect(rows.at(-1)?.bucketMs).toBe(Date.UTC(2026, 0, 1, 9))
    expect(rows.at(-1)).toMatchObject({
      longPercent: 60,
      longCount: 60,
      shortCount: 40,
      topLongPercent: 80,
      topOpenInterest: 100.5,
    })
    store.close()
  })

  it('computes premium in basis points and keeps minutes for a week', async () => {
    const store = open()
    await collector(store, fakeFetch()).syncOnce()
    const hours = store.premiumSince('PF_XBTUSD', HOUR_MS, 0)
    expect(hours.length).toBeGreaterThan(5)
    expect(hours[0]?.premiumBp).toBeCloseTo(100, 6)
    const minutes = store.premiumSince('PF_XBTUSD', 60_000, 0)
    expect(minutes.at(-1)?.bucketMs).toBeLessThan(NOW)
    expect(minutes.at(-1)?.bucketMs).toBeGreaterThan(NOW - 120_000)
    store.close()
  })

  it('a second pass asks for nothing new and keeps the rows', async () => {
    const store = open()
    await collector(store, fakeFetch()).syncOnce()
    const before = store.positioningSince('PF_XBTUSD', 0).length
    const second = fakeFetch()
    await collector(store, second).syncOnce()
    expect(second.urls).toHaveLength(0)
    expect(store.positioningSince('PF_XBTUSD', 0)).toHaveLength(before)
    store.close()
  })

  it('a failing series does not stop the others', async () => {
    const store = open()
    const failures = await collector(
      store,
      fakeFetch({ fail: 'top-traders' }),
    ).syncOnce()
    expect(failures).toBe(1)
    expect(store.latestPositioning('PF_XBTUSD', 'all')).toBeDefined()
    expect(store.latestPositioning('PF_XBTUSD', 'top')).toBeUndefined()
    expect(store.latestPremium('PF_XBTUSD', HOUR_MS)).toBeDefined()
    store.close()
  })

  it('reads the database read-only', async () => {
    const store = open()
    store.putAll('PF_XBTUSD', HOUR_MS, {
      percent: 55,
      longCount: 5,
      shortCount: 4,
    })
    const reader = new PositioningStore(store.db.location() as string, {
      readOnly: true,
    })
    expect(reader.positioningSince('PF_XBTUSD', 0)[0]?.longPercent).toBe(55)
    expect(() => reader.putPremium([])).not.toThrow()
    expect(() =>
      reader.putAll('PF_XBTUSD', 2 * HOUR_MS, {
        percent: 1,
        longCount: 1,
        shortCount: 1,
      }),
    ).toThrow()
    reader.close()
    store.close()
  })
})

describe('premium parsing', () => {
  it('drops open candles and joins mark with spot', () => {
    const raw = JSON.stringify({
      candles: [
        { time: 0, close: '101' },
        { time: HOUR_MS, close: '102' },
      ],
    })
    const closes = parseCloses(raw, {
      intervalMs: HOUR_MS,
      receivedAtMs: HOUR_MS + 10_000,
      settleMs: 5_000,
    })
    expect([...closes.keys()]).toEqual([0])
    const rows = premiumRows('PF_XBTUSD', HOUR_MS, closes, new Map([[0, 100]]))
    expect(rows[0]?.premiumBp).toBeCloseTo(100, 6)
    expect(premiumRows('PF_XBTUSD', HOUR_MS, closes, new Map())).toEqual([])
  })

  it('rejects malformed candles', () => {
    expect(() =>
      parseCloses('{"candles":[{"time":1,"close":"x"}]}', {
        intervalMs: HOUR_MS,
        receivedAtMs: 0,
        settleMs: 0,
      }),
    ).toThrow()
  })
})

describe('terminal chart', () => {
  it('folds positioning and premium into the chart buckets', async () => {
    const { chartFlow } = await import('../live-gateway/terminal-chart.ts')
    const { FuturesMarketStore } =
      await import('../kraken-futures/futures-market-store.ts')
    const dir = mkdtempSync(join(tmpdir(), 'positioning-chart-'))
    dirs.push(dir)
    const market = new FuturesMarketStore(join(dir, 'm.sqlite'))
    const positioning = open()
    const base = Date.UTC(2026, 0, 1)
    positioning.putAll('PF_ETHUSD', base, {
      percent: 61,
      longCount: 6,
      shortCount: 4,
    })
    positioning.putTop('PF_ETHUSD', base, {
      percent: 72,
      longCount: 7,
      shortCount: 3,
      openInterest: 10,
    })
    positioning.putPremium([
      {
        productId: 'PF_ETHUSD',
        intervalMs: HOUR_MS,
        bucketMs: base,
        mark: 101,
        spot: 100,
        premiumBp: 100,
      },
    ])
    const flow = chartFlow(market, HOUR_MS, base, 'PF_ETHUSD', positioning)
    expect(flow).toMatchObject([
      {
        time_ms: base,
        long_percent: 61,
        top_long_percent: 72,
        premium_bp: 100,
      },
    ])
    expect(chartFlow(market, HOUR_MS, base, 'PF_SOLUSD', positioning)).toEqual(
      [],
    )
    market.close()
    positioning.close()
  })
})

describe('indicator cards', () => {
  const pinned = ['PF_XBTUSD']
  const catalog = (indicators: unknown[], purge = 14) =>
    parseCatalog(
      JSON.stringify({
        version: 'indicators.v1',
        purge_after_days: purge,
        indicators,
      }),
      pinned,
    )

  it('rejects an active card nobody uses and unknown products', () => {
    expect(() =>
      catalog([
        card({
          id: 'a',
          series: 'premium',
          resolution: '1h',
          history_from: '2024-01-01',
          consumers: [],
        }),
      ]),
    ).toThrow(/needs a user/)
    expect(() =>
      catalog([
        card({
          id: 'a',
          series: 'premium',
          resolution: '1h',
          history_from: '2024-01-01',
          products: ['PF_DOGEUSD'],
        }),
      ]),
    ).toThrow(/not a pinned/)
    expect(() =>
      catalog([
        card({
          id: 'a',
          series: 'positioning',
          resolution: '1m',
          keep_days: 1,
        }),
      ]),
    ).toThrow(/hourly only/)
  })

  it('downloads only what active cards declare, with the longest history', async () => {
    const store = open()
    const fetched = fakeFetch()
    await collector(
      store,
      fetched,
      catalog([
        card({
          id: 'p',
          series: 'premium',
          resolution: '1h',
          history_from: '2026-01-01',
        }),
        card({
          id: 'q',
          series: 'premium',
          resolution: '1h',
          history_from: '2025-12-31',
        }),
        card({
          id: 'old',
          series: 'positioning',
          resolution: '1h',
          history_from: '2025-12-31',
          state: 'archived',
          archived_since: '2025-12-30',
          consumers: [],
        }),
      ]),
    ).syncOnce()
    expect(fetched.urls.some((url) => url.includes('/analytics/'))).toBe(false)
    expect(store.premiumSince('PF_XBTUSD', HOUR_MS, 0)[0]?.bucketMs).toBe(FROM)
    expect(store.premiumSince('PF_XBTUSD', 60_000, 0)).toHaveLength(0)
    store.close()
  })

  it('deletes an archived series 14 days after, never earlier or if another card needs it', async () => {
    const store = open()
    await collector(store, fakeFetch()).syncOnce()
    expect(store.latestPositioning('PF_XBTUSD', 'all')).toBeDefined()
    const archived = (since: string) => [
      card({
        id: 'pos',
        series: 'positioning',
        resolution: '1h',
        history_from: '2025-12-31',
        state: 'archived',
        archived_since: since,
        consumers: [],
      }),
      card({
        id: 'prima',
        series: 'premium',
        resolution: '1h',
        history_from: '2025-12-31',
      }),
    ]
    await collector(
      store,
      fakeFetch(),
      catalog(archived('2025-12-25')),
    ).syncOnce()
    expect(store.latestPositioning('PF_XBTUSD', 'all')).toBeDefined()
    await collector(
      store,
      fakeFetch(),
      catalog(archived('2025-12-18')),
    ).syncOnce()
    expect(store.latestPositioning('PF_XBTUSD', 'all')).toBeUndefined()
    expect(store.latestPositioning('PF_XBTUSD', 'top')).toBeUndefined()
    expect(store.latestPremium('PF_XBTUSD', HOUR_MS)).toBeDefined()
    store.close()
  })
})

describe('repository catalog', () => {
  it('config/indicators.json is valid for the pinned products', async () => {
    const { DEFAULT_CATALOG_URL, loadCatalog, plan } =
      await import('./catalog.ts')
    const { loadPinnedProducts } =
      await import('../kraken-futures/futures-products.ts')
    const pinned = loadPinnedProducts().map((p) => p.productId)
    const catalog = loadCatalog(fileURLToPath(DEFAULT_CATALOG_URL), pinned)
    expect(catalog.purgeAfterDays).toBe(14)
    // 8 products x (all, top, hour, minute)
    expect(plan(catalog, Date.now())).toHaveLength(pinned.length * 4)
  })
})
