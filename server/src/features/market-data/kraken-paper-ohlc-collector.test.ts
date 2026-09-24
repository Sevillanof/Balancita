import { describe, expect, it, vi } from 'vitest'
import { MarketStore } from './market-store.ts'
import {
  KrakenPaperOhlcCollector,
  type PaperOhlcSocket,
} from './kraken-paper-ohlc-collector.ts'
import { PaperForwardService } from '../simulations/paper-forward.ts'

class Socket implements PaperOhlcSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event?: { type?: string }) => void) | null = null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

const bar = (minute: number, close = 20_000) => ({
  symbol: 'BTC/EUR',
  interval_begin: new Date(1_700_000_000_000 + minute * 60_000).toISOString(),
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1,
})

describe('KrakenPaperOhlcCollector', () => {
  it('subscribes to v2 OHLC, treats snapshot as warm-up, and closes only on rollover', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const socket = new Socket()
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => socket,
      clock: () => 100,
    })
    collector.start()
    socket.onopen?.()
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      method: 'subscribe',
      params: {
        channel: 'ohlc',
        symbol: ['BTC/EUR'],
        interval: 1,
        snapshot: true,
      },
    })
    socket.emit({ channel: 'ohlc', type: 'snapshot', data: [bar(0)] })
    expect(store.listPaperOrders()).toHaveLength(0)
    socket.emit({ channel: 'ohlc', type: 'update', data: [bar(0, 20_002)] })
    expect(store.ohlcCandleCount()).toBe(0)
    socket.emit({ channel: 'ohlc', type: 'update', data: [bar(1, 20_010)] })
    expect(store.ohlcCandleCount()).toBe(1)
    expect(store.listOhlcCandles(0, Number.MAX_SAFE_INTEGER)[0]?.close).toBe(
      20_002,
    )
    collector.stop()
    expect(socket.closed).toBe(true)
    store.close()
  })

  it.each([
    ['at minute start', Date.UTC(2024, 0, 1, 12, 0, 0), 5_000],
    ['before second five', Date.UTC(2024, 0, 1, 12, 0, 4, 999), 1],
    ['at second five', Date.UTC(2024, 0, 1, 12, 0, 5), 60_000],
    ['after second five', Date.UTC(2024, 0, 1, 12, 0, 59), 6_000],
  ])('aligns fallback polling to UTC :05 %s', async (_label, now, delay) => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    let poll: (() => void) | undefined
    const timer = vi.fn((callback: () => void, wait: number) => {
      poll = callback
      return wait as unknown as ReturnType<typeof setTimeout>
    })
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => new Socket(),
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: vi.fn(async () => Response.json({ error: [], result: {} })),
      clock: () => now,
      setTimeout: timer as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    ;(collector as unknown as { socket: Socket }).socket.onerror?.()
    expect(timer).toHaveBeenNthCalledWith(2, expect.any(Function), delay)
    poll?.()
    collector.stop()
    store.close()
  })

  it('polls Kraken REST with the persisted cursor and consumes only closed adjacent rows', async () => {
    const store = new MarketStore({ path: ':memory:' })
    store.insertOhlcCandles([
      {
        timestamp: 1_700_000_000,
        open: 20_000,
        high: 20_001,
        low: 19_999,
        close: 20_000,
        volume: 1,
      },
    ])
    const service = new PaperForwardService({ store })
    const process = vi.spyOn(service, 'processClosedCandle')
    const socket = new Socket()
    const now = Date.UTC(2024, 0, 1, 12, 0, 0)
    const rows = [
      [1_700_000_040, '20000', '20010', '19990', '20005', '2', 10],
      [1_700_000_100, '20005', '20020', '20000', '20015', '3', 11],
      [1_700_000_160, '20015', '20030', '20010', '20025', '4', 12],
    ]
    let poll: (() => void) | undefined
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({
        error: [],
        result: { XXBTZEUR: rows, last: 'ignored' },
      }),
    )
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => socket,
      restBaseUrl: 'https://rest.fixture/0/',
      marketFetch: fetch,
      clock: () => now,
      setTimeout: ((callback: () => void) => {
        poll = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    socket.onclose?.()
    poll?.()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(store.ohlcCandleCount()).toBe(3))
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 1_700_000_040 }),
      20_005,
    )
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 1_700_000_100 }),
      20_015,
    )
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://rest.fixture/0/public/OHLC?pair=XBTEUR&interval=1&since=1700000000',
    )
    expect(store.ohlcCandleCount()).toBe(3)
    expect(
      store.listOhlcCandles(0, Number.MAX_SAFE_INTEGER).map((c) => c.timestamp),
    ).toEqual([1_700_000_000, 1_700_000_040, 1_700_000_100])
    collector.stop()
    store.close()
  })

  it('does not persist or consume Kraken REST final current/open candle', async () => {
    const store = new MarketStore({ path: ':memory:' })
    const now = Date.UTC(2024, 0, 1, 12, 0, 0)
    const cursor = now / 1000 - 120
    store.insertOhlcCandles([
      {
        timestamp: cursor,
        open: 20_000,
        high: 20_001,
        low: 19_999,
        close: 20_000,
        volume: 1,
      },
    ])
    const service = new PaperForwardService({ store })
    const process = vi.spyOn(service, 'processClosedCandle')
    const rows = [
      [cursor, '20000', '20001', '19999', '20000', '1', '1'],
      [cursor + 60, '20000', '20010', '19990', '20005', '2', '10'],
      [cursor + 120, '20005', '20020', '20000', '20015', '3', '11'],
    ]
    let poll: (() => void) | undefined
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => new Socket(),
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: vi.fn(async () =>
        Response.json({ error: [], result: { XXBTZEUR: rows } }),
      ),
      clock: () => now,
      setTimeout: ((callback: () => void) => {
        poll = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    ;(collector as unknown as { socket: Socket }).socket.onclose?.()
    poll?.()
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce())

    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: cursor + 60 }),
      20_005,
    )
    expect(process).not.toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: cursor + 120 }),
      expect.anything(),
    )
    expect(
      store
        .listOhlcCandles(0, Number.MAX_SAFE_INTEGER)
        .map((candle) => candle.timestamp),
    ).toEqual([cursor, cursor + 60])
    collector.stop()
    store.close()
  })

  it('skips the seeded REST overlap but consumes the next closed candle', async () => {
    const store = new MarketStore({ path: ':memory:' })
    const seed = Array.from({ length: 821 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
      open: 20_000,
      high: 20_001,
      low: 19_999,
      close: 20_000,
      volume: 1,
    }))
    store.insertOhlcCandles(seed)
    const service = new PaperForwardService({ store })
    const process = vi.spyOn(service, 'processClosedCandle')
    const rows = seed
      .slice(-2)
      .map((candle) => [
        candle.timestamp,
        String(candle.open),
        String(candle.high),
        String(candle.low),
        String(candle.close),
        '1',
        '1',
      ])
    for (const offset of [60, 120])
      rows.push([
        seed.at(-1)!.timestamp + offset,
        '20000',
        '20001',
        '19999',
        '20000',
        '1',
        '1',
      ])
    const fetch = vi.fn(async (_input: string) =>
      Response.json({ error: [], result: { XBTEUR: rows } }),
    )
    const socket = new Socket()
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => socket,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: fetch,
      clock: () => Date.UTC(2024, 0, 1, 12),
    })
    collector.start()
    socket.onclose?.()
    await (collector as unknown as { pollRest(): Promise<void> }).pollRest()
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toContain(
      `&since=${seed.at(-1)!.timestamp}`,
    )
    expect(store.ohlcCandleCount()).toBe(822)
    expect(process).toHaveBeenCalledOnce()
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: seed.at(-1)!.timestamp + 60 }),
      20_000,
    )
    expect(store.listPaperOrders()).toHaveLength(0)
    collector.stop()
    store.close()
  })

  it('logs safe close/error metadata, arms healthy fallback, and cancels it on reconnect', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const sockets = [new Socket(), new Socket()]
    let socketIndex = 0
    const logger = { error: vi.fn() }
    const clearTimeout = vi.fn()
    const scheduled: (() => void)[] = []
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => sockets[socketIndex++]!,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: vi.fn(),
      logger,
      clock: () => Date.UTC(2024, 0, 1, 12),
      setTimeout: ((callback: () => void) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout,
    })
    collector.start()
    sockets[0]!.onclose?.({ code: 1006, reason: 'network\nclosed' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'close',
        code: 1006,
        reason: 'network closed',
      }),
      expect.any(String),
    )
    expect(collector.getStatus()).toEqual({
      running: true,
      state: 'rest_polling_1m',
    })
    scheduled[0]?.()
    sockets[1]!.onopen?.()
    expect(clearTimeout).toHaveBeenCalled()
    expect(collector.getStatus()).toEqual({ running: true, state: 'connected' })
    collector.stop()
    store.close()
  })

  it('does not rearm REST polling when WebSocket reconnects during an in-flight poll', async () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const sockets = [new Socket(), new Socket()]
    let socketIndex = 0
    const scheduled: (() => void)[] = []
    let completeFetch: ((response: Response) => void) | undefined
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => sockets[socketIndex++]!,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: () =>
        new Promise<Response>((resolve) => {
          completeFetch = resolve
        }),
      clock: () => Date.UTC(2024, 0, 1, 12),
      setTimeout: ((callback: () => void) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    sockets[0]!.onerror?.()
    scheduled[0]!()
    scheduled[1]!()
    await Promise.resolve()
    sockets[1]!.onopen?.()
    completeFetch?.(Response.json({ error: [], result: {} }))
    await vi.waitFor(() =>
      expect((collector as unknown as { polling: boolean }).polling).toBe(
        false,
      ),
    )
    expect(collector.getStatus().state).toBe('connected')
    expect(scheduled).toHaveLength(2)
    collector.stop()
    store.close()
  })

  it('treats synchronous subscribe send failures and rejected subscribe acknowledgements as WS failures', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const sockets = [new Socket(), new Socket()]
    sockets[0]!.send = () => {
      throw new Error('send failed\nsecret')
    }
    let index = 0
    const logger = { error: vi.fn() }
    const scheduled: (() => void)[] = []
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => sockets[index++]!,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: vi.fn(),
      logger,
      setTimeout: ((callback: () => void) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    sockets[0]!.onopen?.()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'send',
        code: 'send_failed',
        reason: 'send failed secret',
      }),
      expect.any(String),
    )
    expect(collector.getStatus().state).toBe('rest_polling_1m')
    scheduled[0]!()
    sockets[1]!.onmessage?.({
      data: JSON.stringify({
        method: 'subscribe',
        success: false,
        error: 'denied',
      }),
    })
    expect(logger.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'subscribe',
        code: 'subscription_rejected',
      }),
      expect.any(String),
    )
    expect(collector.getStatus().state).toBe('rest_polling_1m')
    collector.stop()
    store.close()
  })

  it('does not bridge a REST candle gap with a later open', async () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const process = vi.spyOn(service, 'processClosedCandle')
    const socket = new Socket()
    const rows = [
      [1_700_000_040, '20000', '20010', '19990', '20005', '2', 10],
      [1_700_000_160, '20015', '20030', '20010', '20025', '4', 12],
      [1_700_000_220, '20025', '20040', '20020', '20035', '4', 13],
    ]
    let poll: (() => void) | undefined
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => socket,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: vi.fn(async () =>
        Response.json({ error: [], result: { XBTZEUR: rows } }),
      ),
      clock: () => Date.UTC(2024, 0, 1, 12),
      setTimeout: ((callback: () => void) => {
        poll = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    socket.onclose?.()
    poll?.()
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2))
    expect(process).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ timestamp: 1_700_000_040 }),
      undefined,
    )
    expect(process).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ timestamp: 1_700_000_160 }),
      20_025,
    )
    collector.stop()
    store.close()
  })

  it('prevents overlapping polls and logs sanitized REST status before the next tick', async () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    const socket = new Socket()
    const logger = { error: vi.fn() }
    const scheduled: (() => void)[] = []
    let completeFetch: ((response: Response) => void) | undefined
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          completeFetch = resolve
        }),
    )
    const collector = new KrakenPaperOhlcCollector({
      service,
      url: 'wss://fixture',
      webSocketFactory: () => socket,
      restBaseUrl: 'https://rest.fixture/0',
      marketFetch: fetch,
      logger,
      clock: () => Date.UTC(2024, 0, 1, 12),
      setTimeout: ((callback: () => void) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    })
    collector.start()
    socket.onerror?.({ type: 'error' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'error', code: 'error' }),
      expect.any(String),
    )
    scheduled[1]!()
    await Promise.resolve()
    await (collector as unknown as { pollRest(): Promise<void> }).pollRest()
    expect(fetch).toHaveBeenCalledTimes(1)
    completeFetch?.(Response.json({ error: [], result: {} }, { status: 503 }))
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'rest_poll',
          code: 'request_failed',
          status: 503,
        }),
        expect.any(String),
      ),
    )
    expect(scheduled).toHaveLength(3)
    collector.stop()
    store.close()
  })
})
