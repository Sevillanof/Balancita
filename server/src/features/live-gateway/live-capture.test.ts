import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    // Only 60 s candles are built; the 5 m/15 m/1 h series come from the official feed.
    expect(revisions.every((row) => row.interval_ms === 60_000)).toBe(true)
    expect(revisions.some((row) => row.is_closed === 1)).toBe(true)
    reader.close()
    expect(lines.some((line) => line.includes('connecting'))).toBe(true)
  })

  it('keeps committing market events when candle revisions fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    const store = new FuturesMarketStore(path)
    store.saveCandleRevision = () => {
      throw new Error('UNIQUE constraint failed: candle revisions')
    }
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
    for (let i = 1; i <= 3; i += 1)
      socket.onmessage!({
        data: JSON.stringify({
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: `trade-${i}`,
          side: 'buy',
          type: 'fill',
          seq: i,
          time: now + i,
          qty: 0.01,
          price: 90000.5,
        }),
      })
    now += 120_000
    await wait(40)
    await capture.stop()
    store.close()
    const reader = new FuturesMarketStore(path, { readOnly: true })
    expect(reader.eventCount()).toBeGreaterThanOrEqual(3)
    reader.close()
    expect(lines.some((line) => line.includes('degraded'))).toBe(false)
    expect(
      lines.filter((line) => line.includes('candle revision')),
    ).toHaveLength(1)
  })

  it('captures without subscribing to the book and writes no book rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    const store = new FuturesMarketStore(path)
    const { socket, sent } = fakeSocket()
    const now = 1_790_000_000_000
    const lines: string[] = []
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('funding offline in test')
      },
      log: (line) => lines.push(line),
    })
    await capture.start()
    socket.onopen!()
    expect(sent.map((m) => JSON.parse(m).feed)).toEqual(['trade', 'ticker'])
    socket.onmessage!({
      data: JSON.stringify({
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
      }),
    })
    expect(capture.collector!.status).toBe('live')
    expect(lines).toContain('live')
    expect(sent.some((m) => JSON.parse(m).event === 'unsubscribe')).toBe(false)
    await capture.stop()
    store.close()

    const db = new DatabaseSync(path, { readOnly: true })
    const feeds = db
      .prepare(
        'SELECT feed, COUNT(*) AS n FROM paper_futures_market_events GROUP BY feed',
      )
      .all() as Array<{ feed: string; n: number }>
    expect(feeds.map((r) => [r.feed, Number(r.n)])).toEqual([['ticker', 1]])
    const books = db
      .prepare('SELECT COUNT(*) AS n FROM paper_futures_book_snapshots')
      .get() as { n: number }
    expect(Number(books.n)).toBe(0)
    db.close()
  })

  it('stores repeated funding responses once and only new periods afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    const store = new FuturesMarketStore(path)
    const HOUR = 3_600_000
    const now = Math.floor(1_790_000_000_000 / HOUR) * HOUR + 120_000
    const hour = Math.floor(now / HOUR) * HOUR
    let periods = [hour - 3 * HOUR, hour - 2 * HOUR, hour - HOUR]
    let calls = 0
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        calls += 1
        return new Response(
          JSON.stringify({
            result: 'success',
            // Different bytes on every poll, same periods and rates.
            serverTime: new Date(now - 1_000 + calls).toISOString(),
            rates: periods.map((start) => ({
              timestamp: new Date(start).toISOString(),
              fundingRate: 0.5,
              relativeFundingRate: 0.00001,
            })),
          }),
        )
      },
      fundingPollMs: 5,
      log: () => undefined,
    })
    const rows = () => {
      const db = new DatabaseSync(path, { readOnly: true })
      const count = (table: string) =>
        Number(
          (
            db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
              n: number
            }
          ).n,
        )
      const result = [
        count('paper_futures_funding_responses'),
        count('paper_futures_funding_periods'),
      ]
      db.close()
      return result
    }
    await capture.start()
    await wait(60)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(rows()).toEqual([1, 3])
    periods = [...periods, hour]
    const before = calls
    await wait(60)
    await capture.stop()
    expect(calls).toBeGreaterThan(before)
    expect(rows()).toEqual([2, 4])
    store.close()
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
      officialRequestGapMs: 0,
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
    const lastMinute = store.latestOfficialBucket('PF_XBTUSD', M)!
    // Settled closed candles only: the open minute is never stored.
    expect(lastMinute + M).toBeLessThanOrEqual(now)
    now += 2 * M
    await wait(40)
    await capture.stop()
    const later = requests.filter((item) => item.interval === '1m').at(-1)!
    expect(later.from).toBe(lastMinute + M)
    expect(store.latestOfficialBucket('PF_XBTUSD', M)).toBeGreaterThan(
      lastMinute,
    )
    expect(store.latestOfficialBucket('PF_XBTUSD', 5 * M)).toBeDefined()
    store.close()
  })

  it('fetches the whole hole after a long stop, beyond the lookback, and records the gap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const M = 60_000
    const H = 60 * M
    let now = 1_791_281_220_000 + 10 * M + 5_000
    const run = async (repairMs?: number) => {
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
          const step = interval === '1m' ? M : 5 * M
          const candles = []
          for (
            let time = Math.ceil(from / step) * step;
            time <= to;
            time += step
          )
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
        // A 24 h lookback is what used to leave the hole after a 39 h stop.
        officialCandleLookbackMs: { 60_000: 24 * H, 300_000: 3 * 24 * H },
        officialPollMs: 60_000,
        officialRequestGapMs: 0,
        officialRepairMs: repairMs,
        log: () => undefined,
      })
      await capture.start()
      await wait(200)
      await capture.stop()
    }
    await run()
    const before = store.latestOfficialBucket('PF_XBTUSD', M)!
    now += 40 * H
    await run()
    const after = store.latestOfficialBucket('PF_XBTUSD', M)!
    expect(after).toBeGreaterThan(before + 39 * H)
    // No hole: every minute between the two runs is stored.
    expect(store.countOfficialBuckets('PF_XBTUSD', M, before, after)).toBe(
      (after - before) / M + 1,
    )
    const five = 5 * M
    const lastFive = store.latestOfficialBucket('PF_XBTUSD', five)!
    const firstFive = Math.ceil(before / five) * five
    expect(
      store.countOfficialBuckets('PF_XBTUSD', five, firstFive, lastFive),
    ).toBe((lastFive - firstFive) / five + 1)
    const gaps = store.gapsAsOf(now) as Array<{ feed: string; reason: string }>
    expect(gaps.map((gap) => gap.feed)).toEqual(
      expect.arrayContaining(['official_candles_1m', 'official_candles_5m']),
    )
    store.close()
  })

  it('repairs holes inside the stored series on start when asked to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const M = 60_000
    const now = 1_791_281_220_000 + 10 * M + 5_000
    const requests: string[] = []
    const fetchCandles = async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const interval = url.pathname.split('/').at(-1)!
      const from = Number(url.searchParams.get('from')) * 1000
      const to = Number(url.searchParams.get('to')) * 1000
      requests.push(`${interval} ${from}`)
      const step = interval === '1m' ? M : 5 * M
      const candles = []
      for (let time = Math.ceil(from / step) * step; time <= to; time += step)
        if (!(time > now - 8 * M && time < now - 4 * M && interval === '1m'))
          candles.push({
            time,
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: '1',
          })
      return new Response(JSON.stringify({ candles, more_candles: false }))
    }
    const first = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      officialCandlesFetch: fetchCandles,
      officialCandleLookbackMs: { 60_000: 30 * M, 300_000: 30 * M },
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      log: () => undefined,
    })
    await first.start()
    await wait(60)
    await first.stop()
    const countHole = () =>
      store.countOfficialBuckets('PF_XBTUSD', M, now - 8 * M, now - 4 * M)
    const holey = countHole()
    expect(holey).toBeLessThan(5)
    // The data source now has the candles (the first fetch was a partial answer).
    const full = createLiveCapture({
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
        const step = interval === '1m' ? M : 5 * M
        const candles = []
        for (let time = Math.ceil(from / step) * step; time <= to; time += step)
          candles.push({
            time,
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: '1',
          })
        return new Response(JSON.stringify({ candles, more_candles: false }))
      },
      officialCandleLookbackMs: { 60_000: 30 * M, 300_000: 30 * M },
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      officialRepairMs: 60 * M,
      log: () => undefined,
    })
    await full.start()
    await wait(150)
    await full.stop()
    expect(countHole()).toBeGreaterThan(holey)
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

  describe('several products', () => {
    const M = 60_000
    const T0 = 1_791_281_220_000
    const productsOf = [
      { productId: 'PF_XBTUSD', tickSize: '1' },
      { productId: 'PF_ETHUSD', tickSize: '0.1' },
      { productId: 'PF_SOLUSD', tickSize: '0.01' },
    ]
    function candleFetch(
      requests: Array<{ product: string; interval: string; at: number }>,
      failing: readonly string[] = [],
    ) {
      return async (input: string | URL | Request) => {
        const url = new URL(String(input))
        const [product, interval] = url.pathname.split('/').slice(-2) as [
          string,
          string,
        ]
        requests.push({ product, interval, at: performance.now() })
        if (failing.includes(product))
          return new Response('no', { status: 500 })
        const from = Number(url.searchParams.get('from')) * 1000
        const to = Number(url.searchParams.get('to')) * 1000
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
      }
    }
    function setup(
      extra: Partial<Parameters<typeof createLiveCapture>[0]> = {},
      failing: readonly string[] = [],
    ) {
      const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
      dirs.push(dir)
      const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
      const requests: Array<{ product: string; interval: string; at: number }> =
        []
      const lines: string[] = []
      let now = T0 + 10 * M + 5_000
      const capture = createLiveCapture({
        store,
        clock: () => now,
        makeSocket: () => fakeSocket().socket,
        fetchCatalog: async () => catalog,
        fundingFetch: async () => {
          throw new Error('offline')
        },
        products: productsOf,
        officialCandlesFetch: candleFetch(requests, failing),
        officialCandleLookbackMs: { 60_000: 5 * M, 300_000: 30 * M },
        officialPollMs: 5,
        officialRequestGapMs: 0,
        log: (line) => lines.push(line),
        ...extra,
      })
      return {
        store,
        capture,
        requests,
        lines,
        advance: (ms: number) => {
          now += ms
        },
        now: () => now,
      }
    }

    it('backfills and polls every product, 5m before 1m, one product after another', async () => {
      const { store, capture, requests, advance } = setup()
      await capture.start()
      await wait(40)
      const firstRound = requests
        .slice(0, 6)
        .map((item) => `${item.product} ${item.interval}`)
      expect(firstRound).toEqual([
        'PF_XBTUSD 5m',
        'PF_XBTUSD 1m',
        'PF_ETHUSD 5m',
        'PF_ETHUSD 1m',
        'PF_SOLUSD 5m',
        'PF_SOLUSD 1m',
      ])
      const lasts = productsOf.map(({ productId }) =>
        store.latestOfficialBucket(productId, M),
      )
      for (const last of lasts) expect(last).toBeDefined()
      expect(new Set(lasts).size).toBe(1)
      advance(2 * M)
      await wait(40)
      await capture.stop()
      for (const [index, { productId }] of productsOf.entries()) {
        expect(store.latestOfficialBucket(productId, M)).toBeGreaterThan(
          lasts[index]!,
        )
        expect(store.latestOfficialBucket(productId, 5 * M)).toBeDefined()
        // Each product resumes from its own latest bucket.
        const mine = requests.filter(
          (item) => item.product === productId && item.interval === '1m',
        )
        expect(mine.length).toBeGreaterThanOrEqual(2)
      }
      store.close()
    })

    it('staggers requests by the configured gap', async () => {
      const { store, capture, requests } = setup({ officialRequestGapMs: 20 })
      await capture.start()
      await wait(220)
      await capture.stop()
      expect(requests.length).toBeGreaterThanOrEqual(6)
      for (let index = 1; index < Math.min(requests.length, 6); index += 1)
        expect(requests[index]!.at - requests[index - 1]!.at).toBeGreaterThan(
          17,
        )
      store.close()
    })

    it('does not let one failing product block the others, and names it in the log', async () => {
      const { store, capture, lines } = setup({}, ['PF_ETHUSD'])
      await capture.start()
      await wait(40)
      await capture.stop()
      expect(store.latestOfficialBucket('PF_ETHUSD', M)).toBeUndefined()
      expect(store.latestOfficialBucket('PF_SOLUSD', M)).toBeDefined()
      expect(store.latestOfficialBucket('PF_XBTUSD', M)).toBeDefined()
      expect(
        lines.some(
          (line) =>
            line.includes('official candles unavailable') &&
            line.includes('PF_ETHUSD'),
        ),
      ).toBe(true)
      store.close()
    })

    it('stops promptly even while waiting between requests', async () => {
      const { store, capture, requests } = setup({
        officialRequestGapMs: 30_000,
      })
      await capture.start()
      await wait(30)
      const started = performance.now()
      await capture.stop()
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(requests.length).toBeLessThanOrEqual(2)
      store.close()
    })

    it('logs pinned products that disagree with the live catalog', async () => {
      const { store, capture, lines } = setup({
        fetchCatalog: async () => ({
          instruments: [
            ...catalog.instruments,
            {
              symbol: 'PF_ETHUSD',
              tickSize: 0.05,
              tradeable: true,
            },
          ],
        }),
      })
      await capture.start()
      await wait(20)
      await capture.stop()
      expect(lines).toContain(
        'catalog warning: PF_ETHUSD tick size 0.05 in the catalog differs from the pinned 0.1',
      )
      expect(lines).toContain(
        'catalog warning: PF_SOLUSD is missing from the catalog',
      )
      store.close()
    })
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

  it('captures chart timeframes and public analytics for the terminal product only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const M = 60_000
    const H = 60 * M
    let now = 1_791_356_400_000 + 3 * H + 10_000
    const candleRequests: string[] = []
    const analyticsRequests: Array<{ path: string; since: number }> = []
    const lines: string[] = []
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
        const resolution = url.pathname.split('/').at(-1)!
        candleRequests.push(`${url.pathname.split('/').at(-2)} ${resolution}`)
        const step = { '1m': M, '5m': 5 * M, '1h': H }[resolution]!
        const from = Number(url.searchParams.get('from')) * 1000
        const to = Number(url.searchParams.get('to')) * 1000
        const candles = []
        for (let time = Math.ceil(from / step) * step; time <= to; time += step)
          candles.push({
            time,
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: '1',
          })
        return new Response(JSON.stringify({ candles, more_candles: false }))
      },
      officialCandleLookbackMs: {
        60_000: 5 * M,
        300_000: 30 * M,
        3_600_000: 3 * H,
      },
      chartCandleIntervals: [H],
      officialPollMs: 5,
      officialRequestGapMs: 0,
      analytics: {
        metrics: ['cvd', 'open-interest'],
        intervals: [M],
        lookbackMs: { 60_000: 3 * M },
        pollMs: 5,
        fetch: async (input) => {
          const url = new URL(String(input))
          const since = Number(url.searchParams.get('since')) * 1000
          analyticsRequests.push({ path: url.pathname, since })
          if (url.pathname.endsWith('/open-interest'))
            return new Response('down', { status: 503 })
          const timestamp: number[] = []
          for (let time = Math.ceil(since / M) * M; time <= now; time += M)
            timestamp.push(time / 1000)
          return new Response(
            JSON.stringify({
              result: {
                timestamp,
                data: {
                  buy_volume: timestamp.map(() => '1'),
                  sell_volume: timestamp.map(() => '2'),
                },
                more: false,
              },
              errors: [],
            }),
          )
        },
      },
      log: (line) => lines.push(line),
    })
    await capture.start()
    await wait(40)
    // Verdict series first, then the chart-only timeframe of PF_XBTUSD.
    expect(candleRequests.slice(0, 3)).toEqual([
      'PF_XBTUSD 5m',
      'PF_XBTUSD 1m',
      'PF_XBTUSD 1h',
    ])
    expect(store.latestOfficialBucket('PF_XBTUSD', H)).toBe(now - 10_000 - H)
    const firstCvd = analyticsRequests.find((item) =>
      item.path.endsWith('/cvd'),
    )!
    expect(firstCvd.path).toBe('/api/charts/v1/analytics/PF_XBTUSD/cvd')
    expect(firstCvd.since).toBe(now - 3 * M)
    const latest = store.latestAnalyticsBucket('PF_XBTUSD', 'cvd', M)!
    // Settled buckets only: the minute still filling is never stored.
    expect(latest + M).toBeLessThanOrEqual(now)
    now += 2 * M
    await wait(40)
    await capture.stop()
    const cvdSince = analyticsRequests
      .filter((item) => item.path.endsWith('/cvd'))
      .map((item) => item.since)
    expect(cvdSince).toContain(latest + M)
    expect(store.latestAnalyticsBucket('PF_XBTUSD', 'cvd', M)).toBeGreaterThan(
      latest,
    )
    // A failing series only logs; the others keep going.
    expect(store.latestAnalyticsBucket('PF_XBTUSD', 'open-interest', M)).toBe(
      undefined,
    )
    expect(
      lines.some((line) =>
        line.includes('analytics unavailable (PF_XBTUSD open-interest'),
      ),
    ).toBe(true)
    expect(
      store.analyticsSince('PF_XBTUSD', 'cvd', M, 0, 10).at(-1)!.values,
    ).toEqual({ buy_volume: '1', sell_volume: '2' })
    store.close()
  })

  it('captures the order book series of every pinned product for trading costs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const M = 60_000
    const now = 1_791_356_400_000 + 10_000
    const paths: string[] = []
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      officialCandlesFetch: async () =>
        new Response(JSON.stringify({ candles: [], more_candles: false })),
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      analytics: {
        metrics: ['cvd'],
        intervals: [M],
        allProductMetrics: ['orderbook'],
        lookbackMs: { 60_000: 2 * M },
        pollMs: 60_000,
        fetch: async (input) => {
          const url = new URL(String(input))
          paths.push(url.pathname.replace('/api/charts/v1/analytics/', ''))
          const since = Number(url.searchParams.get('since')) * 1000
          const timestamp = [(Math.ceil(since / M) * M) / 1000]
          const data = url.pathname.endsWith('/orderbook')
            ? { bid: { bestPrice: ['99'] }, ask: { bestPrice: ['100'] } }
            : { buy_volume: ['1'], sell_volume: ['1'] }
          return new Response(
            JSON.stringify({
              result: { timestamp, data, more: false },
              errors: [],
            }),
          )
        },
      },
      log: () => undefined,
    })
    await capture.start()
    await wait(40)
    await capture.stop()
    expect(paths).toEqual([
      'PF_XBTUSD/cvd',
      'PF_ETHUSD/orderbook',
      'PF_XBTUSD/orderbook',
    ])
    expect(
      store.analyticsSince('PF_ETHUSD', 'orderbook', M, 0, 10)[0]!.values,
    ).toEqual({ 'ask.bestPrice': '100', 'bid.bestPrice': '99' })
    store.close()
  })

  it('polls the REST tickers of the non-BTC pinned products into the market store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const now = 1_791_356_400_000 + 10_000
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      officialCandlesFetch: async () =>
        new Response(JSON.stringify({ candles: [], more_candles: false })),
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      tickerPollMs: 5,
      tickerFetch: async () =>
        new Response(
          JSON.stringify({
            result: 'success',
            tickers: [
              {
                symbol: 'PF_XBTUSD',
                bid: 1,
                ask: 2,
                markPrice: 1.5,
                bidSize: 1,
                askSize: 1,
              },
              {
                symbol: 'PF_ETHUSD',
                bid: 2577.7,
                ask: 2577.8,
                markPrice: 2577.36834692919,
                bidSize: 2.097,
                askSize: 1.818,
                fundingRate: -0.005628493164,
                suspended: false,
              },
            ],
          }),
        ),
      log: () => undefined,
    })
    await capture.start()
    await wait(40)
    await capture.stop()
    const rows = store['db']
      .prepare(
        "SELECT product_id, normalized_json FROM paper_futures_market_events WHERE feed='ticker'",
      )
      .all() as Array<{ product_id: string; normalized_json: string }>
    expect(new Set(rows.map((r) => r.product_id))).toEqual(
      new Set(['PF_ETHUSD']),
    )
    const event = JSON.parse(rows[0]!.normalized_json)
    expect(event).toMatchObject({
      bid: '2577.7',
      ask: '2577.8',
      mark: '2577.36834692919',
      raw: { bid_size: '2.097', ask_size: '1.818' },
    })
    store.close()
  })

  it('keeps polling tickers after a request that never settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const now = 1_791_356_400_000 + 10_000
    const logs: string[] = []
    let calls = 0
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      officialCandlesFetch: async () =>
        new Response(JSON.stringify({ candles: [], more_candles: false })),
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      tickerPollMs: 5,
      pollDeadlineMs: 30,
      // The first request ignores the abort signal and never answers, like a stalled socket.
      tickerFetch: async () => {
        calls += 1
        if (calls === 1) return new Promise<Response>(() => undefined)
        return new Response(
          JSON.stringify({
            result: 'success',
            tickers: [
              {
                symbol: 'PF_ETHUSD',
                bid: 2577.7,
                ask: 2577.8,
                markPrice: 2577.3,
                bidSize: 1,
                askSize: 1,
              },
            ],
          }),
        )
      },
      log: (line) => logs.push(line),
    })
    await capture.start()
    await wait(200)
    await capture.stop()
    const count = (
      store['db']
        .prepare(
          "SELECT COUNT(*) AS n FROM paper_futures_market_events WHERE feed='ticker'",
        )
        .get() as { n: number }
    ).n
    expect(count).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes('ticker poll stuck'))).toBe(true)
    store.close()
  })

  it('hands the rest of a slow official-candles poll to the next one so no product is starved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const now = 1_791_356_400_000 + 10_000
    const seen = new Set<string>()
    const logs: string[] = []
    const capture = createLiveCapture({
      store,
      clock: () => now,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      officialCandlesFetch: async (input) => {
        seen.add(new URL(String(input)).pathname.split('/').at(-2)!)
        await wait(30)
        return new Response(
          JSON.stringify({ candles: [], more_candles: false }),
        )
      },
      officialPollMs: 5,
      officialPollBudgetMs: 40,
      officialRequestGapMs: 0,
      log: (line) => logs.push(line),
    })
    await capture.start()
    await wait(400)
    await capture.stop()
    expect(seen).toEqual(new Set(['PF_XBTUSD', 'PF_ETHUSD']))
    expect(logs.some((line) => line.includes('over its 40 ms budget'))).toBe(
      true,
    )
    store.close()
  })

  it('does not call a poll stuck when the process itself was blocked past its deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const logs: string[] = []
    const logFile = join(dir, 'resilience.jsonl')
    let calls = 0
    const capture = createLiveCapture({
      store,
      makeSocket: () => fakeSocket().socket,
      fetchCatalog: async () => catalog,
      fundingFetch: async () => {
        throw new Error('offline')
      },
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      officialCandlesFetch: async () =>
        new Response(JSON.stringify({ candles: [], more_candles: false })),
      officialPollMs: 60_000,
      officialRequestGapMs: 0,
      tickerPollMs: 5,
      pollDeadlineMs: 40,
      blockedProcessMs: 50,
      resilienceLogFile: logFile,
      // The first request blocks the whole process (like a synchronous delete) and answers right after.
      tickerFetch: async () => {
        calls += 1
        if (calls === 1) {
          await Promise.resolve() // let the poll's deadline timer start first
          const until = Date.now() + 200
          while (Date.now() < until) {
            // busy wait
          }
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        return new Response(JSON.stringify({ result: 'success', tickers: [] }))
      },
      log: (line) => logs.push(line),
    })
    await capture.start()
    await wait(150)
    await capture.stop()
    const events = existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { reason: string })
      : []
    expect(events.map((e) => e.reason)).toContain('process_blocked')
    expect(events.map((e) => e.reason)).not.toContain('poll_stuck')
    expect(logs.some((line) => line.includes('poll stuck'))).toBe(false)
    expect(capture.health.general()).toBe(false)
  })

  describe('connectivity change', () => {
    /** Frames keep flowing and REST answers until `broken` is set: the route changed under open sockets. */
    function network() {
      const state = { socketSilent: false, restBroken: false }
      const sockets: FuturesSocket[] = []
      const connectionHeaders: (string | undefined)[] = []
      let seq = 0
      const feeder = setInterval(() => {
        const socket = sockets[sockets.length - 1]
        if (state.socketSilent || !socket) return
        seq += 1
        socket.onmessage?.({
          data: JSON.stringify({
            feed: 'ticker',
            product_id: 'PF_XBTUSD',
            time: Date.now(),
            seq,
            bid: 90000,
            ask: 90001,
            last: 90000.5,
            markPrice: 90000,
            index: 89999,
            suspended: false,
          }),
        })
      }, 5)
      const rest = (body: string) => (_url: string, init?: RequestInit) => {
        connectionHeaders.push(
          (init?.headers as Record<string, string> | undefined)?.connection,
        )
        if (!state.restBroken) return Promise.resolve(new Response(body))
        // A pooled socket that died with the route: nothing answers until the request is aborted.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        )
      }
      return {
        state,
        cut: (on: boolean) => {
          state.socketSilent = on
          state.restBroken = on
        },
        sockets,
        connectionHeaders,
        stop: () => clearInterval(feeder),
        makeSocket: () => {
          const { socket } = fakeSocket()
          sockets.push(socket)
          setTimeout(() => socket.onopen?.(), 1)
          return socket
        },
        tickerFetch: rest(
          JSON.stringify({
            result: 'success',
            tickers: [
              {
                symbol: 'PF_ETHUSD',
                bid: 2577.7,
                ask: 2577.8,
                markPrice: 2577.3,
                bidSize: 1,
                askSize: 1,
              },
            ],
          }),
        ),
        officialFetch: rest(
          JSON.stringify({ candles: [], more_candles: false }),
        ),
      }
    }

    async function run(extra: {
      silenceMs: number
      generalIdleMs?: number
      withAnalytics?: boolean
    }) {
      const dir = mkdtempSync(join(tmpdir(), 'balancita-capture-'))
      dirs.push(dir)
      const logFile = join(dir, 'resilience.jsonl')
      const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
      const net = network()
      const logs: string[] = []
      const capture = createLiveCapture({
        store,
        makeSocket: net.makeSocket,
        fetchCatalog: async () => catalog,
        fundingFetch: async () => {
          throw new Error('offline')
        },
        products: [
          { productId: 'PF_XBTUSD', tickSize: '1' },
          { productId: 'PF_ETHUSD', tickSize: '0.1' },
        ],
        officialCandlesFetch: net.officialFetch,
        tickerFetch: net.tickerFetch,
        officialPollMs: 15,
        officialRequestGapMs: 0,
        tickerPollMs: 5,
        pollDeadlineMs: 40,
        connectTimeoutMs: 50,
        watchdogIntervalMs: 10,
        reconnectMinMs: 5,
        reconnectMaxMs: 20,
        resilienceLogFile: logFile,
        log: (line) => logs.push(line),
        silenceMs: extra.silenceMs,
        generalIdleMs: extra.generalIdleMs,
        // A third REST source: tickers, candles and analytics hanging together is a general failure.
        ...(extra.withAnalytics
          ? {
              analytics: {
                metrics: ['open-interest' as const],
                intervals: [60_000],
                pollMs: 15,
                fetch: (_url: string, init?: RequestInit) =>
                  net.state.restBroken
                    ? new Promise<Response>((_, reject) =>
                        init?.signal?.addEventListener('abort', () =>
                          reject(new DOMException('aborted', 'AbortError')),
                        ),
                      )
                    : Promise.reject(new Error('analytics offline')),
              },
            }
          : {}),
      })
      await capture.start()
      const events = () =>
        existsSync(logFile)
          ? readFileSync(logFile, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    component: string
                    reason: string
                    result: string
                  },
              )
          : []
      return { capture, store, net, logs, events }
    }

    it('detects a silent socket and hung REST, recovers by itself and keeps capturing', async () => {
      const { capture, store, net, logs, events } = await run({
        silenceMs: 80,
      })
      await wait(150)
      expect(events().filter((e) => e.result === 'recovering')).toEqual([])
      const before = store.eventCount()
      expect(before).toBeGreaterThan(0)

      net.cut(true) // route change: socket silent, REST hangs
      await wait(500)
      const during = events()
      expect(
        during.some(
          (e) => e.component === 'websocket' && e.reason === 'silent_socket',
        ),
      ).toBe(true)
      expect(
        during.some(
          (e) => e.component === 'rest-tickers' && e.result === 'recovering',
        ),
      ).toBe(true)
      expect(
        during.some(
          (e) => e.component === 'rest-candles' && e.result === 'recovering',
        ),
      ).toBe(true)
      expect(net.sockets.length).toBeGreaterThan(1)
      expect(capture.health.general()).toBe(true)

      net.cut(false) // new route works again; nobody restarts anything
      await wait(400)
      const after = events()
      for (const component of ['websocket', 'rest-tickers', 'rest-candles'])
        expect(
          after.some(
            (e) => e.component === component && e.result === 'recovered',
          ),
        ).toBe(true)
      // Requests after a failure ask for new connections instead of reusing a pooled one.
      expect(net.connectionHeaders).toContain('close')
      expect(store.eventCount()).toBeGreaterThan(before)
      // The aborted official poll must not have closed its client for good.
      expect(logs.some((line) => line.includes('is closed'))).toBe(false)
      await capture.stop()
      net.stop()
      store.close()
    })

    it('replaces a healthy-looking but silent socket when several sources fail together', async () => {
      // The socket watchdog is far away: only the general incident can replace the socket here.
      const { capture, store, net, events } = await run({
        silenceMs: 600_000,
        generalIdleMs: 30,
        withAnalytics: true,
      })
      await wait(150)
      net.cut(true)
      await wait(500)
      const reconnects = events().filter(
        (e) => e.component === 'websocket' && e.reason === 'general_incident',
      )
      expect(reconnects.length).toBeGreaterThanOrEqual(1)
      expect(net.sockets.length).toBeGreaterThan(1)
      await capture.stop()
      net.stop()
      store.close()
    })

    it('leaves a healthy socket alone when only REST fails', async () => {
      const { capture, store, net, events } = await run({
        silenceMs: 600_000,
        generalIdleMs: 30,
        withAnalytics: true,
      })
      await wait(150)
      const sockets = net.sockets.length
      net.state.restBroken = true // the socket keeps receiving frames
      await wait(400)
      expect(events().some((e) => e.component === 'rest-tickers')).toBe(true)
      expect(net.sockets.length).toBe(sockets)
      expect(events().filter((e) => e.component === 'websocket')).toEqual([])
      await capture.stop()
      net.stop()
      store.close()
    })
  })
})
