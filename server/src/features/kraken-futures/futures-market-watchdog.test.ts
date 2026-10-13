import { describe, expect, it } from 'vitest'
import {
  KrakenFuturesMarketCollector,
  type FuturesSocket,
} from './futures-market.ts'

/** Manual clock and timers so a "silent" socket can be left silent for minutes in a millisecond. */
function rig(
  options: {
    silenceMs?: number
    dataSilenceMs?: number
    connectTimeoutMs?: number
  } = {},
) {
  let now = 1_000_000
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const sockets: (FuturesSocket & { closed: boolean })[] = []
  const events: { reason: string; result: string }[] = []
  const collector = new KrakenFuturesMarketCollector({
    clock: () => now,
    random: () => 0.5,
    makeSocket: () => {
      const socket = {
        closed: false,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => {},
        close() {
          this.closed = true
        },
      } as FuturesSocket & { closed: boolean }
      sockets.push(socket)
      return socket
    },
    setTimeout: (fn, delay) => {
      const id = next++
      timers.set(id, { at: now + delay, fn })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id) => {
      timers.delete(id as unknown as number)
    },
    persist: () => 'inserted',
    persistGap: () => {},
    bookFeed: false,
    staleAfterMs: 3_000,
    reconnectMinMs: 500,
    watchdogIntervalMs: 1_000,
    silenceMs: options.silenceMs ?? 10_000,
    dataSilenceMs: options.dataSilenceMs ?? 600_000,
    connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
    onResilience: (event) => events.push(event),
  })
  /** The process does not run for `ms` (blocked, or the machine sleeps): the clock moves, no timer fires. */
  const freeze = (ms: number) => {
    now += ms
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].fn()
    }
    now = end
  }
  return { collector, sockets, events, advance, freeze }
}

const heartbeat = JSON.stringify({ feed: 'heartbeat', time: 1 })
const ticker = (seq: number) =>
  JSON.stringify({
    feed: 'ticker',
    product_id: 'PF_XBTUSD',
    time: 1_000_000 + seq,
    seq,
    bid: 90000,
    ask: 90001,
    last: 90000.5,
    markPrice: 90000,
    index: 89999,
    suspended: false,
  })

describe('websocket watchdog', () => {
  it('reconnects a socket that opened and then went silent without ever closing', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    sockets[0]!.onopen!()
    advance(9_000)
    expect(sockets).toHaveLength(1)
    advance(3_000)
    expect(sockets[0]!.closed).toBe(true)
    expect(events[0]).toMatchObject({
      reason: 'silent_socket',
      result: 'recovering',
    })
    advance(2_000)
    expect(sockets).toHaveLength(2)
  })

  it('catches silence even when not a single message ever arrived', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    sockets[0]!.onopen!()
    advance(60_000)
    expect(events.some((e) => e.reason === 'silent_socket')).toBe(true)
    expect(sockets.length).toBeGreaterThan(1)
  })

  it('abandons a connection that never opens', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    advance(6_000)
    expect(events[0]).toMatchObject({ reason: 'connect_timeout' })
    expect(sockets[0]!.closed).toBe(true)
    advance(2_000)
    expect(sockets).toHaveLength(2)
  })

  it('does not reconnect while heartbeats and market data keep arriving', () => {
    const { collector, sockets, events, advance } = rig({
      dataSilenceMs: 20_000,
    })
    collector.start()
    sockets[0]!.onopen!()
    for (let i = 0; i < 30; i += 1) {
      advance(5_000)
      sockets[0]!.onmessage!({ data: heartbeat })
      sockets[0]!.onmessage!({ data: ticker(i + 1) })
    }
    expect(events).toHaveLength(0)
    expect(sockets).toHaveLength(1)
  })

  it('reconnects when only heartbeats arrive and the subscription stops delivering data', () => {
    const { collector, sockets, events, advance } = rig({
      dataSilenceMs: 20_000,
    })
    collector.start()
    sockets[0]!.onopen!()
    sockets[0]!.onmessage!({ data: ticker(1) })
    for (let i = 0; i < 8; i += 1) {
      advance(5_000)
      sockets[0]!.onmessage!({ data: heartbeat })
    }
    expect(events[0]).toMatchObject({
      reason: 'feed_silent',
      result: 'recovering',
    })
    expect(sockets[0]!.closed).toBe(true)
  })

  it('quiet trades are not a reason to reconnect while the ticker flows', () => {
    const { collector, sockets, events, advance } = rig({
      dataSilenceMs: 20_000,
    })
    collector.start()
    sockets[0]!.onopen!()
    for (let i = 0; i < 40; i += 1) {
      advance(5_000)
      sockets[0]!.onmessage!({ data: ticker(i + 1) })
    }
    expect(events).toHaveLength(0)
  })

  it('reports the recovery when the new socket delivers its first frame', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    sockets[0]!.onopen!()
    advance(12_000)
    advance(2_000)
    sockets[1]!.onopen!()
    sockets[1]!.onmessage!({ data: heartbeat })
    expect(events.map((e) => e.result)).toEqual(['recovering', 'recovered'])
  })

  it('a second forced reconnect while one is already scheduled is ignored', () => {
    const { collector, sockets, events } = rig()
    collector.start()
    sockets[0]!.onopen!()
    collector.reconnect('general_incident')
    collector.reconnect('general_incident')
    expect(events).toHaveLength(1)
  })

  it('does not judge silence right after the process itself was not running', () => {
    const { collector, sockets, events, advance, freeze } = rig({
      dataSilenceMs: 20_000,
    })
    collector.start()
    sockets[0]!.onopen!()
    sockets[0]!.onmessage!({ data: ticker(1) })
    freeze(32_000) // a 32 s synchronous call: frames wait in the socket buffer
    advance(0) // the late watchdog check runs
    expect(events.map((e) => e.reason)).toEqual(['process_blocked'])
    expect(sockets[0]!.closed).toBe(false)
    sockets[0]!.onmessage!({ data: ticker(2) }) // the queued frames are delivered
    advance(5_000)
    sockets[0]!.onmessage!({ data: ticker(3) })
    advance(5_000)
    expect(events.filter((e) => e.result === 'recovering')).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  it('still reconnects when the socket is really silent after the process resumed', () => {
    const { collector, sockets, events, advance, freeze } = rig({
      dataSilenceMs: 20_000,
    })
    collector.start()
    sockets[0]!.onopen!()
    sockets[0]!.onmessage!({ data: ticker(1) })
    freeze(32_000)
    advance(0)
    advance(30_000) // nothing arrives after resuming
    expect(events.some((e) => e.result === 'recovering')).toBe(true)
  })

  it('stops watching once the collector is stopped', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    sockets[0]!.onopen!()
    collector.stop()
    advance(120_000)
    expect(events).toHaveLength(0)
    expect(sockets).toHaveLength(1)
  })
})
