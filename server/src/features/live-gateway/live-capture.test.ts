import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FuturesSocket } from '../kraken-futures/futures-market.ts'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { createLiveCapture } from './live-capture.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const catalog = {
  instruments: [
    {
      symbol: 'PF_XBTUSD',
      type: 'flexible_futures',
      pair: 'BTC:USD',
      base: 'BTC',
      quote: 'USD',
      contractSize: '1',
      contractValueTradePrecision: '4',
      tickSize: '1',
      tradeable: true,
      isExpired: false,
    },
  ],
}

function fakeSocket() {
  const sent: string[] = []
  const socket: FuturesSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (message) => sent.push(message),
    close: () => undefined,
  }
  return { socket, sent }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('live capture process core', () => {
  it('persists events and candles with no engine and no HTTP server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    const store = new FuturesMarketStore(path)
    const { socket } = fakeSocket()
    let now = 1_790_000_000_000
    const lines: string[] = []
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('funding offline in test')
      },
      candleTickMs: 5,
      log: (line) => lines.push(line),
    })
    await capture.start()
    socket.onopen!()
    const send = (value: unknown) =>
      socket.onmessage!({ data: JSON.stringify(value) })
    send({
      feed: 'ticker',
      product_id: 'PF_XBTUSD',
      time: now,
      seq: 1,
      bid: 90000,
      ask: 90001,
      last: 90000.5,
      markPrice: 90000,
      index: 89999,
      suspended: false,
    })
    send({
      feed: 'trade',
      product_id: 'PF_XBTUSD',
      uid: 'trade-1',
      side: 'buy',
      type: 'fill',
      seq: 2,
      time: now,
      qty: 0.01,
      price: 90000.5,
    })
    // Advance the process clock past the minute so the 1 s tick closes it.
    now += 120_000
    await wait(40)
    await capture.stop()
    store.close()

    const reader = new FuturesMarketStore(path, { readOnly: true })
    expect(reader.eventCount()).toBeGreaterThanOrEqual(2)
    expect(reader.qualityPolicies()).toHaveLength(1)
    expect(reader.instrumentVersions()).toHaveLength(1)
    const revisions = reader.candleRevisions() as Array<{
      interval_ms: number
      is_closed: number
    }>
    expect(revisions.some((row) => row.interval_ms === 60_000)).toBe(true)
    expect(revisions.some((row) => row.is_closed === 1)).toBe(true)
    reader.close()
    expect(lines.some((line) => line.includes('connecting'))).toBe(true)
  })

  it('keeps retrying the catalog instead of exiting when it is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    let attempts = 0
    const capture = createLiveCapture({
      store,
      clock: () => 1_790_000_000_000,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('catalog down')
        return catalog
      },
      fundingFetch: async () => {
        throw new Error('offline')
      },
      catalogRetryMs: 5,
      log: () => undefined,
    })
    await capture.start()
    await wait(60)
    await capture.stop()
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(store.instrumentVersions()).toHaveLength(1)
    store.close()
  })
})
