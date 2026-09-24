import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketStore } from './market-store.ts'
import { KrakenOhlcCollector } from './kraken-ohlc-collector.ts'

const candle = (timestamp: number) => [
  timestamp,
  '10',
  '11',
  '9',
  '10',
  '10',
  '1',
]
const response = (rows: unknown[], last: number) =>
  new Response(JSON.stringify({ error: [], result: { XBTEUR: rows, last } }))

describe('KrakenOhlcCollector', () => {
  let store: MarketStore | undefined

  afterEach(() => store?.close())

  it('ignores duplicates and excludes the open bar', async () => {
    store = new MarketStore({ path: ':memory:' })
    const fetch = vi.fn(async (_url: string) =>
      response([candle(60), candle(120), candle(180)], 240),
    )
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      clock: () => 180_000,
      logger: { warn: vi.fn() },
    })

    await collector.syncOnce()
    await collector.syncOnce()

    expect(
      store.listOhlcCandles(0, 200_000).map((item) => item.timestamp),
    ).toEqual([60, 120])
    expect(
      fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('since')),
    ).toEqual([null, '240'])
    expect(collector.getStatus().lastSuccessfulSync).toBe(180_000)
  })

  it('resumes from the latest closed stored timestamp and warns about gaps', async () => {
    store = new MarketStore({ path: ':memory:' })
    store.insertOhlcCandles(
      [60, 120].map((timestamp) => ({
        timestamp,
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 1,
      })),
    )
    const warn = vi.fn()
    const fetch = vi.fn(async (_url: string) =>
      response([candle(240), candle(360)], 420),
    )
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      clock: () => 500_000,
      logger: { warn },
    })

    await collector.syncOnce()

    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get('since')).toBe(
      '120',
    )
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ start: 180, end: 180 }),
      expect.stringMatching(/gap/i),
    )
  })

  it('skips overlapping sync and clears polling timer on stop', async () => {
    store = new MarketStore({ path: ':memory:' })
    let resolve!: (value: Response) => void
    const fetch = vi.fn(
      (_url: string) =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    let tick: (() => void) | undefined
    const clear = vi.fn()
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      timer: {
        setInterval: (callback) => {
          tick = callback
          return 1
        },
        clearInterval: clear,
      },
      logger: { warn: vi.fn() },
    })

    collector.start()
    tick?.()
    expect(fetch).toHaveBeenCalledTimes(1)
    const stopping = collector.stop()
    resolve(response([], 0))
    await stopping
    expect(clear).toHaveBeenCalledOnce()
    expect(collector.getStatus().running).toBe(false)
  })
})
