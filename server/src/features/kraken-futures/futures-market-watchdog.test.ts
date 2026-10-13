import { describe, expect, it } from 'vitest'
import {
  KrakenFuturesMarketCollector,
  type FuturesSocket,
} from './futures-market.ts'

/** Manual clock and timers so a "silent" socket can be left silent for minutes in a millisecond. */
function rig(options: { silenceMs?: number; connectTimeoutMs?: number } = {}) {
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
    connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
    onResilience: (event) => events.push(event),
  })
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
  return { collector, sockets, events, advance }
}

const heartbeat = JSON.stringify({ feed: 'heartbeat', time: 1 })

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

  it('does not reconnect while any frame, heartbeats included, keeps arriving', () => {
    const { collector, sockets, events, advance } = rig()
    collector.start()
    sockets[0]!.onopen!()
    for (let i = 0; i < 30; i += 1) {
      advance(5_000)
      sockets[0]!.onmessage!({ data: heartbeat })
    }
    expect(events).toHaveLength(0)
    expect(sockets).toHaveLength(1)
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
