import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarketStore } from './market-store.ts'
import {
  createKrakenCatchUpClient,
  KrakenMarketCollector,
  type KrakenCatchUpClient,
  type KrakenCatchUpRequest,
  type KrakenCatchUpResult,
  type KrakenSocket,
} from './kraken-market-collector.ts'

const directories: string[] = []

class FakeSocket implements KrakenSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: string[] = []
  closed = false

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }

  message(message: string): void {
    this.onmessage?.({ data: message })
  }

  error(): void {
    this.onerror?.()
  }
}

class FakeScheduler {
  readonly timers = new Map<number, { callback: () => void; delay: number }>()
  private nextId = 1

  set = (callback: () => void, delay: number): number => {
    const id = this.nextId++
    this.timers.set(id, { callback, delay })
    return id
  }

  clear = (id: number): void => {
    this.timers.delete(id)
  }

  runNext(): void {
    const first = this.timers.entries().next().value as
      [number, { callback: () => void; delay: number }] | undefined
    if (first === undefined) return
    this.timers.delete(first[0])
    first[1].callback()
  }

  runLast(): void {
    const entries = [...this.timers.entries()]
    const last = entries.at(-1)
    if (last === undefined) return
    this.timers.delete(last[0])
    last[1].callback()
  }

  delays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delay)
  }
}

class FakeCatchUpClient implements KrakenCatchUpClient {
  readonly requests: KrakenCatchUpRequest[] = []
  readonly responses: Array<KrakenCatchUpResult | Error> = []

  async fetchTrades(
    request: KrakenCatchUpRequest,
  ): Promise<KrakenCatchUpResult> {
    this.requests.push(request)
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    return next ?? { trades: [] }
  }
}

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-kraken-collector-'))
  directories.push(directory)
  return join(directory, 'market.sqlite')
}

const WALL_CLOCK = Date.parse('2026-09-21T10:00:02.000Z')

function trade(input: {
  tradeId: number
  time?: string
  symbol?: string
  price?: number
  qty?: number
  side?: string
  type?: string
}): string {
  return JSON.stringify({
    channel: 'trade',
    type: input.type ?? 'update',
    data: [
      {
        symbol: input.symbol ?? 'BTC/EUR',
        side: input.side ?? 'buy',
        price: input.price ?? 60_000,
        qty: input.qty ?? 0.5,
        ord_type: 'limit',
        trade_id: input.tradeId,
        timestamp: input.time ?? '2026-09-21T10:00:00.000000Z',
      },
    ],
  })
}

function tradeBatch(input: {
  type?: string
  trades: ReadonlyArray<{
    tradeId: number
    time: string
    price?: number
    qty?: number
    side?: string
  }>
}): string {
  return JSON.stringify({
    channel: 'trade',
    type: input.type ?? 'update',
    data: input.trades.map((entry) => ({
      symbol: 'BTC/EUR',
      side: entry.side ?? 'buy',
      price: entry.price ?? 60_000,
      qty: entry.qty ?? 0.5,
      ord_type: 'limit',
      trade_id: entry.tradeId,
      timestamp: entry.time,
    })),
  })
}

function makeCollector(options: {
  sockets: FakeSocket[]
  now?: () => number
  scheduler?: FakeScheduler
  catchUpClient?: KrakenCatchUpClient
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  restBaseUrl?: string
  catchUpMaxAttempts?: number
  catchUpBackoffMs?: number
  random?: () => number
  jitterRatio?: number
  onRejected?: (rejection: { code: string; message: string }) => void
}) {
  const store = new MarketStore({ path: makePath() })
  const scheduler = options.scheduler ?? new FakeScheduler()
  const collector = new KrakenMarketCollector({
    store,
    wsUrl: 'wss://example.invalid/v2',
    staleAfterMs: 15_000,
    reconnectMinMs: 100,
    reconnectMaxMs: 250,
    clock: options.now ?? (() => WALL_CLOCK),
    websocketFactory: () => {
      const socket = options.sockets.shift()
      if (socket === undefined) throw new Error('No fake socket available')
      return socket
    },
    setTimeout: scheduler.set,
    clearTimeout: scheduler.clear,
    catchUpClient: options.catchUpClient,
    fetch: options.fetch,
    restBaseUrl: options.restBaseUrl,
    catchUpMaxAttempts: options.catchUpMaxAttempts,
    catchUpBackoffMs: options.catchUpBackoffMs,
    random: options.random,
    jitterRatio: options.jitterRatio,
    onRejected: options.onRejected,
  })
  return { collector, scheduler, store }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('KrakenMarketCollector', () => {
  it('exposes lifecycle status changes to the intelligence stream observer', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({ sockets: [socket] })
    const statuses: string[] = []
    const unsubscribe = collector.subscribe(() =>
      statuses.push(collector.getStatus()),
    )

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100 }))
    socket.error()
    collector.stop()
    unsubscribe()

    expect(statuses).toContain('connecting')
    expect(statuses).toContain('connected')
    expect(statuses).toContain('reconnecting')
    expect(statuses.at(-1)).toBe('stopped')
    store.close()
  })

  it('rejects another instrument before opening a socket', () => {
    const sockets: FakeSocket[] = []
    const { collector, store } = makeCollector({ sockets })

    expect(() => collector.start('ETH-EUR')).toThrow(
      'Only BTC-EUR is supported',
    )
    expect(sockets).toHaveLength(0)

    collector.stop()
    store.close()
  })

  it('subscribes to the trade channel and appends trades to the store', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({ sockets: [socket] })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100 }))
    socket.message(trade({ tradeId: 101, time: '2026-09-21T10:00:01.000000Z' }))

    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      method: 'subscribe',
      params: { channel: 'trade', symbol: ['BTC/EUR'], snapshot: true },
    })
    expect(collector.source).toBe('kraken')
    expect(collector.instrumentId).toBe('BTC-EUR')
    const observations = store.listObservations()
    expect(observations).toHaveLength(2)
    expect(observations.map((entry) => entry.payload)).toMatchObject([
      { type: 'trade', tradeId: 100, qty: 0.5, side: 'buy' },
      { type: 'trade', tradeId: 101, qty: 0.5, side: 'buy' },
    ])

    collector.stop()
    store.close()
  })

  it('preserves Kraken event time and local received/display time', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => WALL_CLOCK,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:00.925533Z' }))

    const [observation] = store.listObservations()
    expect(observation?.eventTime).toBe(Date.parse('2026-09-21T10:00:00.925Z'))
    expect(observation?.receivedTime).toBe(WALL_CLOCK)
    expect(observation?.displayTime).toBe(WALL_CLOCK)

    collector.stop()
    store.close()
  })

  it('accepts live trades timestamped slightly ahead of the local clock', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => WALL_CLOCK,
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    // Kraken timestamps trades with the exchange clock. A sub-second lead over
    // the local clock is normal and must not be rejected as invalid, otherwise
    // every live trade would be dropped and the venue would look stale.
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:02.045000Z' }))

    expect(store.observationCount()).toBe(1)
    expect(rejections).toEqual([])
    const [observation] = store.listObservations()
    // The exchange event time is preserved verbatim, and the local receive
    // instant is clamped up so it never precedes the event.
    expect(observation?.eventTime).toBe(Date.parse('2026-09-21T10:00:02.045Z'))
    expect(observation?.receivedTime).toBe(
      Date.parse('2026-09-21T10:00:02.045Z'),
    )
    expect(observation?.displayTime).toBe(
      Date.parse('2026-09-21T10:00:02.045Z'),
    )

    collector.stop()
    store.close()
  })

  it('rejects trades timestamped implausibly far ahead of the local clock', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => WALL_CLOCK,
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:30.000000Z' }))

    expect(store.observationCount()).toBe(0)
    expect(rejections.map((rejection) => rejection.code)).toEqual([
      'invalid_time',
    ])

    collector.stop()
    store.close()
  })

  it('drops duplicate and out-of-order trade ids without persisting twice', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100 }))
    socket.message(trade({ tradeId: 100, price: 60_001 }))
    socket.message(trade({ tradeId: 99, time: '2026-09-21T09:59:59.000000Z' }))

    expect(store.observationCount()).toBe(1)
    expect(rejections.map((rejection) => rejection.code)).toEqual([
      'trade_out_of_order',
      'trade_out_of_order',
    ])

    collector.stop()
    store.close()
  })

  it('rejects non-BTC-EUR instruments from the trade stream', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, symbol: 'ETH/EUR' }))

    expect(store.observationCount()).toBe(0)
    expect(rejections.map((rejection) => rejection.code)).toContain(
      'unsupported_instrument',
    )

    collector.stop()
    store.close()
  })

  it('ignores subscription acknowledgements and heartbeat frames', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(
      JSON.stringify({
        method: 'subscribe',
        result: { channel: 'trade', symbol: 'BTC/EUR' },
        success: true,
      }),
    )
    socket.message(JSON.stringify({ channel: 'heartbeat' }))
    socket.message(trade({ tradeId: 100, type: 'snapshot' }))

    expect(store.observationCount()).toBe(1)
    expect(rejections).toHaveLength(0)

    collector.stop()
    store.close()
  })

  it('marks stale only after the strict threshold and recovers to live', () => {
    const socket = new FakeSocket()
    let now = WALL_CLOCK
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => now,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100 }))
    now = Date.parse('2026-09-21T10:00:15.000Z')
    collector.refreshStale()
    expect(store.getCursor('kraken', 'BTC-EUR')?.status).toBe('live')
    now += 1
    collector.refreshStale()
    expect(store.getCursor('kraken', 'BTC-EUR')?.status).toBe('stale')

    now = Date.parse('2026-09-21T10:00:17.001Z')
    socket.message(
      trade({
        tradeId: 101,
        time: '2026-09-21T10:00:17.001000Z',
      }),
    )
    expect(store.getCursor('kraken', 'BTC-EUR')?.status).toBe('live')

    collector.stop()
    store.close()
  })

  it('reconnects with bounded backoff and resubscribes after close', () => {
    const first = new FakeSocket()
    const second = new FakeSocket()
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [first, second],
      scheduler,
    })

    collector.start('BTC-EUR')
    first.open()
    first.onclose?.()
    expect(scheduler.delays()[0]).toBe(100)
    scheduler.runNext()
    second.open()

    expect(JSON.parse(second.sent[0] ?? '{}')).toMatchObject({
      method: 'subscribe',
      params: { channel: 'trade', symbol: ['BTC/EUR'] },
    })
    collector.stop()
    expect(scheduler.timers.size).toBe(0)
    expect(second.closed).toBe(true)
    store.close()
  })

  it('caps exponential reconnect delays at the configured maximum', () => {
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({ sockets: [], scheduler })

    collector.start('BTC-EUR')
    expect(scheduler.delays()[0]).toBe(100)
    scheduler.runNext()
    expect(scheduler.delays()[0]).toBe(200)
    scheduler.runNext()
    expect(scheduler.delays()[0]).toBe(250)

    collector.stop()
    store.close()
  })

  it('applies bounded jitter to reconnect delays', () => {
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [],
      scheduler,
      random: () => 1,
      jitterRatio: 0.5,
    })

    collector.start('BTC-EUR')
    expect(scheduler.delays()[0]).toBe(150)

    collector.stop()
    store.close()
  })

  it('records a gap and triggers a bounded REST catch-up for the missing range', async () => {
    const socket = new FakeSocket()
    const catchUp = new FakeCatchUpClient()
    catchUp.responses.push({
      trades: [
        {
          tradeId: 101,
          price: 60_001,
          qty: 0.25,
          side: 'sell',
          eventTime: Date.parse('2026-09-21T10:00:01.000Z') as never,
        },
      ],
    })
    const { collector, store } = makeCollector({
      sockets: [socket],
      catchUpClient: catchUp,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:00.000Z' }))
    socket.message(trade({ tradeId: 102, time: '2026-09-21T10:00:02.000Z' }))
    await flush()

    expect(catchUp.requests).toHaveLength(1)
    expect(catchUp.requests[0]).toMatchObject({
      pair: 'XBTEUR',
      since: Date.parse('2026-09-21T10:00:00.000Z'),
      until: Date.parse('2026-09-21T10:00:02.000Z'),
      fromTradeId: 100,
      toTradeId: 102,
    })
    expect(store.listGaps()).toMatchObject([
      {
        source: 'kraken',
        prevSequence: 100,
        currentSequence: 102,
        evidence: { kind: 'trade_id', channel: 'trade' },
      },
    ])
    const tradeIds = store
      .listObservations()
      .flatMap((observation) =>
        observation.payload.type === 'trade'
          ? [observation.payload.tradeId]
          : [],
      )
    expect(tradeIds).toEqual([100, 102, 101])

    collector.stop()
    store.close()
  })

  it('rejects catch-up entries outside the requested gap range', async () => {
    const socket = new FakeSocket()
    const catchUp = new FakeCatchUpClient()
    catchUp.responses.push({
      trades: [
        {
          tradeId: 101,
          price: 60_001,
          qty: 0.25,
          side: 'buy',
          eventTime: Date.parse('2026-09-21T10:00:01.000Z') as never,
        },
        {
          tradeId: 102,
          price: 60_002,
          qty: 0.5,
          side: 'buy',
          eventTime: Date.parse('2026-09-21T10:00:02.000Z') as never,
        },
        {
          tradeId: 200,
          price: 60_003,
          qty: 0.5,
          side: 'buy',
          eventTime: Date.parse('2026-09-21T11:00:00.000Z') as never,
        },
      ],
    })
    const { collector, store } = makeCollector({
      sockets: [socket],
      catchUpClient: catchUp,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:00.000Z' }))
    socket.message(trade({ tradeId: 102, time: '2026-09-21T10:00:02.000Z' }))
    await flush()

    const tradeIds = store
      .listObservations()
      .flatMap((observation) =>
        observation.payload.type === 'trade'
          ? [observation.payload.tradeId]
          : [],
      )
    expect(tradeIds).toEqual([100, 102, 101])

    collector.stop()
    store.close()
  })

  it('retries the catch-up with bounded backoff and reports an unresolved gap', async () => {
    const socket = new FakeSocket()
    const scheduler = new FakeScheduler()
    const catchUp = new FakeCatchUpClient()
    catchUp.responses.push(
      new Error('rest unavailable'),
      new Error('rest unavailable'),
      new Error('rest unavailable'),
    )
    const rejections: { code: string }[] = []
    const { collector, store } = makeCollector({
      sockets: [socket],
      scheduler,
      catchUpClient: catchUp,
      catchUpMaxAttempts: 3,
      catchUpBackoffMs: 100,
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:00.000Z' }))
    socket.message(trade({ tradeId: 102, time: '2026-09-21T10:00:02.000Z' }))
    await flush()

    expect(catchUp.requests).toHaveLength(1)
    expect(scheduler.delays()).toContain(100)
    scheduler.runLast()
    await flush()
    expect(catchUp.requests).toHaveLength(2)
    expect(scheduler.delays()).toContain(200)
    scheduler.runLast()
    await flush()
    expect(catchUp.requests).toHaveLength(3)
    expect(scheduler.delays()).not.toContain(400)

    expect(store.observationCount()).toBe(2)
    expect(store.listGaps()).toHaveLength(1)
    expect(rejections.map((rejection) => rejection.code)).toContain(
      'catch_up_unresolved',
    )

    collector.stop()
    store.close()
  })

  it('never calls a private or order endpoint through the default catch-up client', async () => {
    const socket = new FakeSocket()
    const calls: string[] = []
    const catchUp = createKrakenCatchUpClient({
      restBaseUrl: 'https://api.kraken.com/0',
      fetch: async (input) => {
        calls.push(String(input))
        return new Response(
          JSON.stringify({ error: [], result: { XBTEUR: [], last: '1' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const { collector, store } = makeCollector({
      sockets: [socket],
      catchUpClient: catchUp,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(trade({ tradeId: 100, time: '2026-09-21T10:00:00.000Z' }))
    socket.message(trade({ tradeId: 102, time: '2026-09-21T10:00:02.000Z' }))
    await flush()

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0] ?? '')
    expect(url.origin).toBe('https://api.kraken.com')
    expect(url.pathname).toBe('/0/public/Trades')
    expect(url.searchParams.get('pair')).toBe('XBTEUR')
    expect(url.searchParams.get('since')).toBe(
      String(Math.floor(Date.parse('2026-09-21T10:00:00.000Z') / 1000)),
    )
    expect(calls.join(' ')).not.toMatch(/private|AddOrder|Balance/i)

    collector.stop()
    store.close()
  })

  it('parses Kraken REST trade rows into bounded catch-up trades', async () => {
    const catchUp = createKrakenCatchUpClient({
      restBaseUrl: 'https://api.kraken.com/0',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: [],
            result: {
              XBTEUR: [
                ['60000.00000', '0.5', 1758448800.5, 'b', 'l', '', 100],
                ['60001.00000', '0.25', 1758448801.0, 's', 'm', '', 101],
              ],
              last: '1758448801000000000',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })

    const result = await catchUp.fetchTrades({
      pair: 'XBTEUR',
      since: Date.parse('2026-09-21T10:00:00.000Z'),
      until: Date.parse('2026-09-21T10:00:02.000Z'),
      fromTradeId: 99,
      toTradeId: 102,
    })

    expect(result.trades).toEqual([
      {
        tradeId: 100,
        price: 60_000,
        qty: 0.5,
        side: 'buy',
        orderType: 'limit',
        eventTime: 1_758_448_800_500,
      },
      {
        tradeId: 101,
        price: 60_001,
        qty: 0.25,
        side: 'sell',
        orderType: 'market',
        eventTime: 1_758_448_801_000,
      },
    ])
  })

  it('surfaces Kraken REST errors instead of fabricating trades', async () => {
    const catchUp = createKrakenCatchUpClient({
      restBaseUrl: 'https://api.kraken.com/0',
      fetch: async () =>
        new Response(
          JSON.stringify({ error: ['EAPI:Rate limit'], result: {} }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    })

    await expect(
      catchUp.fetchTrades({
        pair: 'XBTEUR',
        since: 1,
        until: 2,
        fromTradeId: 1,
        toTradeId: 2,
      }),
    ).rejects.toThrow('Kraken')
  })

  it('skips a stale snapshot backlog without persisting, gapping, or catching up', async () => {
    const socket = new FakeSocket()
    const scheduler = new FakeScheduler()
    const catchUp = new FakeCatchUpClient()
    const { collector, store } = makeCollector({
      sockets: [socket],
      scheduler,
      catchUpClient: catchUp,
      now: () => WALL_CLOCK,
    })

    collector.start('BTC-EUR')
    socket.open()
    // Kraken replays up to ~104 minutes of old trades in the subscription
    // snapshot. The live stream is the real-time shadow source; the backlog
    // belongs to the historical backfill path and must not be persisted.
    const staleBase = WALL_CLOCK - 200_000
    socket.message(
      tradeBatch({
        type: 'snapshot',
        trades: [
          { tradeId: 100, time: new Date(staleBase).toISOString() },
          { tradeId: 101, time: new Date(staleBase + 1_000).toISOString() },
          { tradeId: 105, time: new Date(staleBase + 2_000).toISOString() },
        ],
      }),
    )
    await flush()

    expect(store.observationCount()).toBe(0)
    const cursor = store.getCursor('kraken', 'BTC-EUR')
    expect(cursor?.lastTradeId).toBe(105)
    expect(cursor?.lastEventTime).toBe(staleBase + 2_000)
    expect(cursor?.status).toBe('stale')
    expect(store.listGaps()).toHaveLength(0)
    expect(catchUp.requests).toHaveLength(0)

    collector.stop()
    store.close()
  })

  it('persists a fresh trade after a skipped stale backlog without reporting a gap', async () => {
    const socket = new FakeSocket()
    const catchUp = new FakeCatchUpClient()
    const { collector, store } = makeCollector({
      sockets: [socket],
      catchUpClient: catchUp,
      now: () => WALL_CLOCK,
    })

    collector.start('BTC-EUR')
    socket.open()
    const staleBase = WALL_CLOCK - 200_000
    socket.message(
      tradeBatch({
        type: 'snapshot',
        trades: [
          { tradeId: 100, time: new Date(staleBase).toISOString() },
          { tradeId: 101, time: new Date(staleBase + 1_000).toISOString() },
        ],
      }),
    )
    socket.message(trade({ tradeId: 102, time: '2026-09-21T10:00:02.000000Z' }))
    await flush()

    expect(store.observationCount()).toBe(1)
    const [observation] = store.listObservations()
    expect(observation?.payload).toMatchObject({ type: 'trade', tradeId: 102 })
    expect(store.listGaps()).toHaveLength(0)
    expect(catchUp.requests).toHaveLength(0)
    expect(store.getCursor('kraken', 'BTC-EUR')?.lastTradeId).toBe(102)

    collector.stop()
    store.close()
  })

  it('skips a stale catch-up trade while persisting a fresh one', async () => {
    const socket = new FakeSocket()
    const catchUp = new FakeCatchUpClient()
    const rejections: { code: string }[] = []
    const staleBase = WALL_CLOCK - 200_000
    catchUp.responses.push({
      trades: [
        {
          tradeId: 101,
          price: 60_001,
          qty: 0.25,
          side: 'sell',
          eventTime: (staleBase + 1_000) as never,
        },
        {
          tradeId: 102,
          price: 60_002,
          qty: 0.5,
          side: 'buy',
          eventTime: (WALL_CLOCK - 1_000) as never,
        },
      ],
    })
    const { collector, store } = makeCollector({
      sockets: [socket],
      catchUpClient: catchUp,
      now: () => WALL_CLOCK,
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(
      tradeBatch({
        type: 'snapshot',
        trades: [{ tradeId: 100, time: new Date(staleBase).toISOString() }],
      }),
    )
    socket.message(trade({ tradeId: 103, time: '2026-09-21T10:00:02.000000Z' }))
    await flush()

    expect(catchUp.requests).toHaveLength(1)
    const tradeIds = store
      .listObservations()
      .flatMap((observation) =>
        observation.payload.type === 'trade'
          ? [observation.payload.tradeId]
          : [],
      )
    // Trade 101 is stale and must not be fabricated; trade 102 is fresh.
    expect(tradeIds).toEqual([103, 102])
    expect(rejections.map((rejection) => rejection.code)).toContain(
      'catch_up_unresolved',
    )

    collector.stop()
    store.close()
  })

  it('rejects invalid JSON as a reconnectable input failure', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [socket],
      scheduler,
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message('{broken')
    expect(rejections[0]?.code).toBe('invalid_json')
    expect(scheduler.timers.size).toBe(1)

    collector.stop()
    store.close()
  })
})
