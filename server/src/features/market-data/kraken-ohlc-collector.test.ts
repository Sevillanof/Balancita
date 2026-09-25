import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketStore } from './market-store.ts'
import { KrakenOhlcCollector } from './kraken-ohlc-collector.ts'

const candle = (timestamp: number, open = '10') => [
  timestamp,
  open,
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

  afterEach(() => {
    vi.useRealTimers()
    store?.close()
  })

  it('ignores duplicates and excludes the open bar', async () => {
    store = new MarketStore({ path: ':memory:' })
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () =>
      response([candle(60), candle(120), candle(180)], 240),
    )
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      clock: () => 180_000,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
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

  it('pairs new live closes with only their contiguous next-minute opens, without replaying bootstrap candles', async () => {
    store = new MarketStore({ path: ':memory:' })
    let rows = [candle(60), candle(120), candle(180)]
    let now = 360_000
    const onClosedCandles = vi.fn()
    const info = vi.fn()
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch: async () => response(rows, 180),
      clock: () => now,
      logger: { info, debug: vi.fn(), warn: vi.fn() },
      onClosedCandles,
    })
    collector.start()
    await vi.waitFor(() =>
      expect(collector.getStatus().lastSuccessfulSync).toBe(360_000),
    )
    expect(store?.latestOhlcTimestamp()).toBe(120)
    expect(onClosedCandles).not.toHaveBeenCalled()
    rows = [
      candle(120),
      candle(180, '10.2'),
      candle(240, '10.3'),
      candle(300, '10.4'),
    ]
    await collector.syncOnce()
    expect(onClosedCandles).toHaveBeenCalledWith([
      {
        candle: {
          timestamp: 180,
          open: 10.2,
          high: 11,
          low: 9,
          close: 10,
          volume: 1,
        },
        nextOpen: 10.3,
      },
      {
        candle: {
          timestamp: 240,
          open: 10.3,
          high: 11,
          low: 9,
          close: 10,
          volume: 1,
        },
        nextOpen: 10.4,
      },
    ])
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining('Handing newly closed'),
    )
    now = 480_000
    rows = [candle(240), candle(300), candle(420, '10.5'), candle(480)]
    await collector.syncOnce()
    expect(onClosedCandles).toHaveBeenLastCalledWith([
      {
        candle: {
          timestamp: 300,
          open: 10,
          high: 11,
          low: 9,
          close: 10,
          volume: 1,
        },
      },
      {
        candle: {
          timestamp: 420,
          open: 10.5,
          high: 11,
          low: 9,
          close: 10,
          volume: 1,
        },
        nextOpen: 10,
      },
    ])
    await collector.stop()
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
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () =>
      response([candle(240), candle(360)], 420),
    )
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      clock: () => 500_000,
      logger: { info: vi.fn(), debug: vi.fn(), warn },
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
    const fetch = vi.fn<(url: string) => Promise<Response>>(
      () =>
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
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
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

  it('aborts a timed-out request and allows the next scheduled sync to run', async () => {
    vi.useFakeTimers()
    store = new MarketStore({ path: ':memory:' })
    let tick: (() => void) | undefined
    const warn = vi.fn()
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (fetch.mock.calls.length > 1) return Promise.resolve(response([], 0))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        )
      })
    })
    const collector = new KrakenOhlcCollector({
      store,
      baseUrl: 'https://fixture.invalid/0',
      fetch,
      timeoutMs: 15_000,
      timer: {
        setInterval: (callback) => {
          tick = callback
          return 1
        },
        clearInterval: vi.fn(),
      },
      logger: { info: vi.fn(), debug: vi.fn(), warn },
    })

    collector.start()
    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledOnce()
    tick?.()

    expect(fetch).toHaveBeenCalledTimes(2)
    await collector.stop()
    vi.useRealTimers()
  })

  it.each(['ENOTFOUND', 'ECONNRESET', 'SELF_SIGNED_CERT_IN_CHAIN'])(
    'logs safe cause code %s and a bounded sanitized error message',
    async (code) => {
      store = new MarketStore({ path: ':memory:' })
      const warn = vi.fn()
      const secretMessage = `Request to https://user:password@private.example/path?token=secret failed\u0000\u001b at /Users/franco/private.pem ${'x'.repeat(300)}`
      const failure = Object.assign(new TypeError(secretMessage), {
        cause: { code },
      })
      const collector = new KrakenOhlcCollector({
        store,
        baseUrl: 'https://fixture.invalid/0',
        fetch: async () => {
          throw failure
        },
        logger: { info: vi.fn(), debug: vi.fn(), warn },
      })

      await collector.syncOnce()

      const fields = warn.mock.calls[0]![0] as Record<string, unknown>
      expect(fields).toMatchObject({ causeCode: code, errorName: 'TypeError' })
      expect(fields.errorMessage).toEqual(expect.any(String))
      expect((fields.errorMessage as string).length).toBeLessThanOrEqual(160)
      expect(fields.errorMessage).not.toContain('private.example')
      expect(fields.errorMessage).not.toContain('password')
      expect(fields.errorMessage).not.toContain('/Users/franco')
      expect(fields.errorMessage).not.toContain('secret')
      expect(
        Array.from(fields.errorMessage as string).every((character) => {
          const code = character.codePointAt(0)!
          return code > 0x1f && code !== 0x7f
        }),
      ).toBe(true)
    },
  )
})
