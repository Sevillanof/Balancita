import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarketStore } from './market-store.ts'
import {
  CoinbaseMarketCollector,
  type CoinbaseSocket,
} from './coinbase-market-collector.ts'

const directories: string[] = []

class FakeSocket implements CoinbaseSocket {
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
}

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-collector-'))
  directories.push(directory)
  return join(directory, 'market.sqlite')
}

function ticker(input: {
  sequence: number
  tradeId: number
  time?: string
  price?: string
}): string {
  return JSON.stringify({
    type: 'ticker',
    product_id: 'BTC-EUR',
    sequence: input.sequence,
    trade_id: input.tradeId,
    time: input.time ?? '2026-09-21T10:00:00.000Z',
    price: input.price ?? '60000.00',
  })
}

function heartbeat(sequence: number, lastTradeId: number): string {
  return JSON.stringify({
    type: 'heartbeat',
    product_id: 'BTC-EUR',
    sequence,
    last_trade_id: lastTradeId,
    time: '2026-09-21T10:00:01.000Z',
  })
}

function makeCollector(options: {
  sockets: FakeSocket[]
  now: () => number
  scheduler?: FakeScheduler
  onRejected?: (rejection: { code: string }) => void
}) {
  const store = new MarketStore({ path: makePath() })
  const scheduler = options.scheduler ?? new FakeScheduler()
  const collector = new CoinbaseMarketCollector({
    store,
    wsUrl: 'wss://example.invalid',
    staleAfterMs: 15_000,
    reconnectMinMs: 100,
    reconnectMaxMs: 250,
    clock: options.now,
    websocketFactory: () => {
      const socket = options.sockets.shift()
      if (socket === undefined) throw new Error('No fake socket available')
      return socket
    },
    setTimeout: scheduler.set,
    clearTimeout: scheduler.clear,
    onRejected: options.onRejected,
  })
  return { collector, scheduler, store }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CoinbaseMarketCollector', () => {
  it('rejects another instrument before opening a socket', () => {
    const sockets: FakeSocket[] = []
    const { collector, store } = makeCollector({ sockets, now: () => 1_000 })

    expect(() => collector.start('ETH-EUR')).toThrow(
      'Only BTC-EUR is supported',
    )
    expect(sockets).toHaveLength(0)

    collector.stop()
    store.close()
  })

  it('subscribes to ticker and heartbeat and accepts ticker sequence jumps', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(ticker({ sequence: 10, tradeId: 20 }))
    socket.message(ticker({ sequence: 12, tradeId: 21 }))

    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'subscribe',
      product_ids: ['BTC-EUR'],
      channels: ['ticker', 'heartbeat'],
    })
    expect(store.observationCount()).toBe(2)
    expect(store.listGaps()).toHaveLength(0)

    collector.stop()
    store.close()
  })

  it('records a gap only when heartbeat trade continuity proves one', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(ticker({ sequence: 10, tradeId: 20 }))
    socket.message(heartbeat(11, 20))
    socket.message(heartbeat(12, 22))

    expect(store.listGaps()).toMatchObject([
      {
        prevSequence: 20,
        currentSequence: 22,
        evidence: { kind: 'trade_id', channel: 'heartbeat' },
      },
    ])

    collector.stop()
    store.close()
  })

  it('records a ticker trade-id gap but never treats a ticker sequence jump as one', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(ticker({ sequence: 10, tradeId: 20 }))
    socket.message(ticker({ sequence: 12, tradeId: 22 }))

    expect(store.listGaps()).toMatchObject([
      {
        prevSequence: 20,
        currentSequence: 22,
        evidence: { kind: 'trade_id', channel: 'ticker' },
      },
    ])

    collector.stop()
    store.close()
  })

  it('ignores duplicate and out-of-order ticker messages', () => {
    const socket = new FakeSocket()
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(ticker({ sequence: 10, tradeId: 20 }))
    socket.message(ticker({ sequence: 10, tradeId: 20, price: '60001' }))
    socket.message(ticker({ sequence: 9, tradeId: 19 }))

    expect(store.observationCount()).toBe(1)

    collector.stop()
    store.close()
  })

  it('marks stale only after the strict threshold and recovers to live', () => {
    const socket = new FakeSocket()
    let now = Date.parse('2026-09-21T10:00:02.000Z')
    const { collector, store } = makeCollector({
      sockets: [socket],
      now: () => now,
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(ticker({ sequence: 10, tradeId: 20 }))
    now = Date.parse('2026-09-21T10:00:15.000Z')
    collector.refreshStale()
    expect(store.getCursor('coinbase_exchange', 'BTC-EUR')?.status).toBe('live')
    now += 1
    collector.refreshStale()
    expect(store.getCursor('coinbase_exchange', 'BTC-EUR')?.status).toBe(
      'stale',
    )

    now = Date.parse('2026-09-21T10:00:17.001Z')
    socket.message(
      ticker({
        sequence: 11,
        tradeId: 21,
        time: '2026-09-21T10:00:17.001Z',
      }),
    )
    expect(store.getCursor('coinbase_exchange', 'BTC-EUR')?.status).toBe('live')

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
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    first.open()
    first.onclose?.()
    expect([...scheduler.timers.values()][0]?.delay).toBe(100)
    scheduler.runNext()
    second.open()

    expect(JSON.parse(second.sent[0] ?? '{}')).toMatchObject({
      type: 'subscribe',
      product_ids: ['BTC-EUR'],
    })
    collector.stop()
    expect(scheduler.timers.size).toBe(0)
    expect(second.closed).toBe(true)
    store.close()
  })

  it('uses exponential reconnect delays and caps them at the configured maximum', () => {
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [],
      scheduler,
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
    })

    collector.start('BTC-EUR')
    expect([...scheduler.timers.values()][0]?.delay).toBe(100)
    scheduler.runNext()
    expect([...scheduler.timers.values()][0]?.delay).toBe(200)
    scheduler.runNext()
    expect([...scheduler.timers.values()][0]?.delay).toBe(250)

    collector.stop()
    store.close()
  })

  it('rejects invalid JSON and malformed heartbeats without breaking future types', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [socket],
      scheduler,
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
      onRejected: (rejection) => rejections.push(rejection),
    })

    collector.start('BTC-EUR')
    socket.open()
    socket.message(JSON.stringify({ type: 'subscriptions', channels: [] }))
    socket.message(
      JSON.stringify({ type: 'future_channel_v2', value: 'ignored' }),
    )
    socket.message(JSON.stringify({ type: 'heartbeat', product_id: 'BTC-EUR' }))
    expect(rejections[0]?.code).toBe('invalid_payload')
    collector.stop()
    expect(scheduler.timers.size).toBe(0)
    store.close()
  })

  it('rejects invalid JSON as a reconnectable input failure', () => {
    const socket = new FakeSocket()
    const rejections: { code: string }[] = []
    const scheduler = new FakeScheduler()
    const { collector, store } = makeCollector({
      sockets: [socket],
      scheduler,
      now: () => Date.parse('2026-09-21T10:00:02.000Z'),
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
