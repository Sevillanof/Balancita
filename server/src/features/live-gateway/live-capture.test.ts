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

  it('backfills and then polls official 1m and 5m candles incrementally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const M = 60_000
    let now = 1_791_281_220_000 + 10 * M + 5_000
    const requests: Array<{ interval: string; from: number; to: number }> = []
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      officialCandlesFetch: async (input) => {
        const url = new URL(String(input))
        const interval = url.pathname.split('/').at(-1)!
        const from = Number(url.searchParams.get('from')) * 1000
        const to = Number(url.searchParams.get('to')) * 1000
        requests.push({ interval, from, to })
        const step = interval === '1m' ? M : 5 * M
        const candles = []
        for (let time = Math.ceil(from / step) * step; time <= to; time += step)
          candles.push({
            time,
            open: '100',
            high: '101',
            low: '99',
            close: '100',
            volume: '1',
          })
        return new Response(JSON.stringify({ candles, more_candles: false }))
      },
      officialCandleLookbackMs: { 60_000: 5 * M, 300_000: 30 * M },
      officialPollMs: 5,
      log: () => undefined,
    })
    await capture.start()
    await wait(30)
    // 5m first: on a 5 minute boundary the closed 5m candle is known before
    // the 1m candle that closes with it, so verdicts see the fresh trend bar.
    const backfill = requests.slice(0, 2)
    expect(backfill).toEqual([
      { interval: '5m', from: now - 30 * M, to: now },
      { interval: '1m', from: now - 5 * M, to: now },
    ])
    const lastMinute = store.latestOfficialBucket(M)!
    // Settled closed candles only: the open minute is never stored.
    expect(lastMinute + M).toBeLessThanOrEqual(now)
    now += 2 * M
    await wait(40)
    await capture.stop()
    const later = requests.filter((item) => item.interval === '1m').at(-1)!
    expect(later.from).toBe(lastMinute + M)
    expect(store.latestOfficialBucket(M)).toBeGreaterThan(lastMinute)
    expect(store.latestOfficialBucket(5 * M)).toBeDefined()
    store.close()
  })

  it('keeps capturing when the official candle API fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const lines: string[] = []
    const capture = createLiveCapture({
      store,
      clock: () => 1_791_281_220_000,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      officialCandlesFetch: async () => new Response('down', { status: 503 }),
      officialPollMs: 5,
      log: (line) => lines.push(line),
    })
    await capture.start()
    await wait(30)
    expect(capture.collector?.status).not.toBe('stopped')
    await capture.stop()
    expect(
      lines.some((line) => line.includes('official candles unavailable')),
    ).toBe(true)
    store.close()
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
