import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FuturesSocket } from '../kraken-futures/futures-market.ts'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { createLiveCapture } from '../live-gateway/live-capture.ts'
import type { ExtraMarketFeedOptions } from '../live-gateway/live-capture.ts'
import {
  ETH_BOOK_SAMPLE_ENV,
  ethExtraMarketFeed,
} from '../kraken-futures/capture-book-sample.ts'
import { wireEthMinuteSummary } from './eth-summary-wiring.ts'
import { createEthMinuteSummary, SUMMARY_TABLE } from './eth-minute-summary.ts'

const MIN = 60_000
// A multiple of one minute.
const T0 = 28_333_334 * MIN
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmpPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-eth-wiring-'))
  dirs.push(dir)
  return join(dir, 'market.sqlite')
}

describe('wireEthMinuteSummary (capture wiring)', () => {
  it('creates the summary with the gate and the db path, starts it, and stops it on stop()', () => {
    const calls: string[] = []
    let received: Parameters<typeof createEthMinuteSummary>[0] | undefined
    const canRun = () => true
    const wiring = wireEthMinuteSummary({
      dbPath: '/some/market.sqlite',
      canRun,
      log: () => undefined,
      create: (options) => {
        received = options
        return {
          runOnce: () => ({ written: 0, pending: false }),
          start: () => void calls.push('start'),
          stop: () => void calls.push('stop'),
        }
      },
    })
    expect(received?.dbPath).toBe('/some/market.sqlite')
    expect(received?.canRun).toBe(canRun)
    // Created, not yet running: the capture starts first.
    expect(calls).toEqual([])
    expect(wiring.running).toBe(true)
    wiring.start()
    expect(calls).toEqual(['start'])
    wiring.stop()
    wiring.stop() // idempotent
    expect(calls).toEqual(['start', 'stop'])
    expect(wiring.running).toBe(false)
  })

  it('logs a failure to open (and a failing stop) instead of throwing into the capture', () => {
    const lines: string[] = []
    const failing = wireEthMinuteSummary({
      dbPath: '/nope',
      canRun: () => true,
      log: (line) => lines.push(line),
      create: () => {
        throw new Error('database is locked')
      },
    })
    expect(failing.running).toBe(false)
    expect(() => failing.start()).not.toThrow()
    expect(() => failing.stop()).not.toThrow()
    expect(lines).toEqual([
      'eth minute summary not started: database is locked',
    ])
    const stopFails = wireEthMinuteSummary({
      dbPath: '/nope',
      canRun: () => true,
      log: (line) => lines.push(line),
      create: () => ({
        runOnce: () => ({ written: 0, pending: false }),
        start: () => undefined,
        stop: () => {
          throw new Error('already closed')
        },
      }),
    })
    expect(() => stopFails.stop()).not.toThrow()
    expect(lines.at(-1)).toBe('eth minute summary stop failed: already closed')
  })

  it('logs run errors once per distinct message through onError', () => {
    const lines: string[] = []
    let onError!: (error: unknown) => void
    wireEthMinuteSummary({
      dbPath: '/nope',
      canRun: () => true,
      log: (line) => lines.push(line),
      create: (options) => {
        onError = options.onError!
        return {
          runOnce: () => ({ written: 0, pending: false }),
          start: () => undefined,
          stop: () => undefined,
        }
      },
    })
    onError(new Error('busy'))
    onError(new Error('busy'))
    onError(new Error('disk'))
    expect(lines).toEqual([
      'eth minute summary failed: busy',
      'eth minute summary failed: disk',
    ])
  })

  it('does not block the capture: events keep being stored while the summary runs, and it stops cleanly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const path = tmpPath()
      const store = new FuturesMarketStore(path)
      const lines: string[] = []
      const wiring = wireEthMinuteSummary({
        dbPath: path,
        canRun: () => true,
        log: (line) => lines.push(line),
        clock: () => T0 + 10 * MIN,
      })
      expect(wiring.running).toBe(true)
      wiring.start()
      // The capture's own writer keeps committing next to the summary's connection.
      expect(
        store.append({
          type: 'trade',
          productId: 'PF_ETHUSD',
          seq: 1,
          epoch: 1,
          eventTime: T0,
          receivedAt: T0,
          persistedAt: T0,
          uid: 'x1',
          side: 'buy',
          tradeType: 'fill',
          quantityBtc: '1',
          priceUsd: '2500',
          raw: {},
        }),
      ).toBe('inserted')
      await vi.advanceTimersByTimeAsync(1)
      wiring.stop()
      expect(lines).toEqual([])
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ETH capture + summary, end to end', () => {
  const T = T0 + 5_000
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
  const offline = async (): Promise<Response> => {
    throw new Error('offline in test')
  }

  it('fills every column of the minute summary from ETH trades, book and tickers', async () => {
    const path = tmpPath()
    const store = new FuturesMarketStore(path)
    const sockets: FuturesSocket[] = []
    const clock = { now: T }
    const capture = createLiveCapture({
      store,
      clock: () => clock.now,
      makeSocket: () => {
        const socket: FuturesSocket = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: () => undefined,
          close: () => undefined,
        }
        sockets.push(socket)
        return socket
      },
      fetchCatalog: async () => catalog,
      fundingFetch: offline,
      officialCandlesFetch: offline,
      tickerFetch: offline,
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      extraMarketFeed: {
        productId: 'PF_ETHUSD',
        bookSampleMs: 20_000,
        tickMs: 5,
      },
    })
    await capture.start()
    const eth = sockets[1]!
    eth.onopen!()
    const send = (value: unknown) =>
      eth.onmessage!({ data: JSON.stringify(value) })
    const book = (
      seq: number,
      bid: number,
      bidQty: number,
      askQty: number,
    ) => ({
      feed: 'book_snapshot',
      product_id: 'PF_ETHUSD',
      seq,
      timestamp: clock.now,
      bids: [
        { price: bid, qty: bidQty },
        { price: bid - 1, qty: 100 }, // inside +-0.1 % of 2500 (2.5 USD)
        { price: bid - 10, qty: 999 }, // far outside the band
      ],
      asks: [
        { price: bid + 1, qty: askQty },
        { price: bid + 2, qty: 50 },
        { price: bid + 40, qty: 888 },
      ],
    })
    // 00:05: the first book sample (depth bid 3+100, ask 2+50), two trades and one REST-style ticker.
    send(book(1, 2499.5, 3, 2))
    send({
      feed: 'trade',
      product_id: 'PF_ETHUSD',
      uid: 'a',
      side: 'buy',
      type: 'fill',
      seq: 1,
      time: clock.now,
      qty: 2,
      price: 2500,
    })
    send({
      feed: 'trade',
      product_id: 'PF_ETHUSD',
      uid: 'b',
      side: 'sell',
      type: 'fill',
      seq: 2,
      time: clock.now,
      qty: 1,
      price: 2503,
    })
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5_000
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
    const books = () =>
      Number(
        (
          new DatabaseSync(path, { readOnly: true })
            .prepare(
              "SELECT COUNT(*) AS n FROM paper_futures_market_events WHERE feed='book'",
            )
            .get() as { n: number }
        ).n,
      )
    await until(() => books() === 1)
    // The REST poller stores the ticker (it is not offline in production).
    store.append({
      type: 'ticker',
      productId: 'PF_ETHUSD',
      seq: 1,
      epoch: 1,
      eventTime: clock.now,
      receivedAt: clock.now,
      persistedAt: clock.now,
      last: '2501',
      bid: '2499.5',
      ask: '2500.5',
      mark: '2500',
      suspended: false,
      funding: { status: 'unknown' },
      raw: { bid_size: 10, ask_size: 20 },
    })
    // 00:30: a second book sample, a bigger book, one more trade.
    clock.now = T + 25_000
    send(book(2, 2499.5, 7, 6))
    send({
      feed: 'trade',
      product_id: 'PF_ETHUSD',
      uid: 'c',
      side: 'buy',
      type: 'fill',
      seq: 3,
      time: clock.now,
      qty: 1,
      price: 2504,
    })
    await until(() => books() === 2)
    await capture.stop()

    clock.now = T0 + 2 * MIN
    const summary = createEthMinuteSummary({
      dbPath: path,
      clock: () => clock.now,
    })
    expect(summary.runOnce().written).toBe(1)
    summary.stop()
    store.close()

    const db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare(`SELECT * FROM ${SUMMARY_TABLE}`).get() as Record<
      string,
      number | string | null
    >
    db.close()
    expect(row.minute_start_ms).toBe(T0)
    expect(row.trade_count).toBe(3)
    expect(row.buy_volume).toBe(3)
    expect(row.sell_volume).toBe(1)
    expect(row.vwap).toBeCloseTo((2 * 2500 + 2503 + 2504) / 4, 6)
    expect(row.last_price).toBe(2504)
    expect(row.spread_bp).toBeCloseTo((1 / 2500) * 10_000, 6)
    expect(row.top_bid_size).toBe(10)
    expect(row.top_ask_size).toBe(20)
    // Depth: average of the two samples, only the levels inside the band.
    expect(row.depth_bid).toBeCloseTo((103 + 107) / 2, 6)
    expect(row.depth_ask).toBeCloseTo((52 + 56) / 2, 6)
    // 3 trades + 2 book samples + 1 ticker.
    expect(row.events_seen).toBe(6)
    for (const [column, value] of Object.entries(row))
      expect(value, column).not.toBeNull()
  })
})

describe('ETH book snapshot cadence through the capture (operacion-mejoras S1)', () => {
  const T = T0 + 5_000
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
  const offline = async (): Promise<Response> => {
    throw new Error('offline in test')
  }

  /** A capture whose clock the test moves; books are fed to the ETH socket (index 1) or the BTC one (index 0). */
  async function harness(feed: ExtraMarketFeedOptions) {
    const path = tmpPath()
    const store = new FuturesMarketStore(path)
    const sockets: FuturesSocket[] = []
    const sent: string[][] = []
    const clock = { now: T }
    const capture = createLiveCapture({
      store,
      clock: () => clock.now,
      makeSocket: () => {
        const messages: string[] = []
        sent.push(messages)
        const socket: FuturesSocket = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: (message: string) => void messages.push(message),
          close: () => undefined,
        }
        sockets.push(socket)
        return socket
      },
      fetchCatalog: async () => catalog,
      fundingFetch: offline,
      officialCandlesFetch: offline,
      tickerFetch: offline,
      products: [
        { productId: 'PF_XBTUSD', tickSize: '1' },
        { productId: 'PF_ETHUSD', tickSize: '0.1' },
      ],
      extraMarketFeed: { ...feed, tickMs: 5 },
    })
    await capture.start()
    sockets[0]!.onopen!()
    sockets[1]!.onopen!()
    const send = (index: number, product: string, seq: number) =>
      sockets[index]!.onmessage!({
        data: JSON.stringify({
          feed: 'book_snapshot',
          product_id: product,
          seq,
          timestamp: clock.now,
          bids: [
            { price: 2499.5, qty: 3 },
            { price: 2498.5, qty: 100 }, // inside +-0.1 % of 2500 (2.5 USD)
            { price: 2489.5, qty: 999 }, // far outside the band
          ],
          asks: [
            { price: 2500.5, qty: 2 },
            { price: 2501.5, qty: 50 },
            { price: 2540.5, qty: 888 },
          ],
        }),
      })
    const count = () => {
      const db = new DatabaseSync(path, { readOnly: true })
      const n = db
        .prepare(
          "SELECT COUNT(*) AS n FROM paper_futures_market_events WHERE feed='book'",
        )
        .get() as { n: number }
      db.close()
      return n.n
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
    /** Moves the clock and feeds the ETH socket a fresh book, so the sampler decides on cadence alone. */
    const at = async (offsetMs: number, seq: number) => {
      clock.now = T + offsetMs
      send(1, 'PF_ETHUSD', seq)
      await settle()
    }
    return { path, store, capture, sockets, sent, send, count, at, settle }
  }

  it('stores one ETH snapshot every 10 s with the default configuration', async () => {
    const h = await harness(ethExtraMarketFeed({}))
    await h.at(0, 1)
    expect(h.count()).toBe(1)
    await h.at(5_000, 2)
    expect(h.count()).toBe(1)
    await h.at(9_999, 3)
    expect(h.count()).toBe(1)
    await h.at(10_000, 4)
    expect(h.count()).toBe(2)
    await h.at(20_000, 5)
    expect(h.count()).toBe(3)
    await h.capture.stop()
    h.store.close()
  })

  it('keeps the same range (+-0.1 %) and format as before at the new cadence', async () => {
    const h = await harness(ethExtraMarketFeed({}))
    await h.at(0, 1)
    await h.capture.stop()
    h.store.close()
    const db = new DatabaseSync(h.path, { readOnly: true })
    const row = db
      .prepare(
        "SELECT product_id, raw_json, normalized_json FROM paper_futures_market_events WHERE feed='book'",
      )
      .get() as {
      product_id: string
      raw_json: string
      normalized_json: string
    }
    db.close()
    expect(row.product_id).toBe('PF_ETHUSD')
    expect(JSON.parse(row.raw_json)).toEqual({
      feed: 'book_sample',
      product_id: 'PF_ETHUSD',
      source_seq: 1,
    })
    const normalized = JSON.parse(row.normalized_json)
    expect(normalized.snapshot).toBe(true)
    expect(normalized.sampled).toEqual({
      band: '0.001',
      maxLevelsPerSide: 100,
      source: 'reconstructed_book',
    })
    expect(normalized.bids.map((l: { price: string }) => l.price)).toEqual([
      '2499.5',
      '2498.5',
    ])
    expect(normalized.asks.map((l: { price: string }) => l.price)).toEqual([
      '2500.5',
      '2501.5',
    ])
  })

  it('follows FUTURES_ETH_BOOK_SAMPLE_MS', async () => {
    const h = await harness(
      ethExtraMarketFeed({ [ETH_BOOK_SAMPLE_ENV]: '20000' }),
    )
    await h.at(0, 1)
    await h.at(10_000, 2)
    expect(h.count()).toBe(1)
    await h.at(20_000, 3)
    expect(h.count()).toBe(2)
    await h.capture.stop()
    h.store.close()
  })

  it('PRESERVE: a feed with no explicit cadence still samples every 30 s', async () => {
    const h = await harness({ productId: 'PF_ETHUSD' })
    await h.at(0, 1)
    await h.at(10_000, 2)
    await h.at(29_999, 3)
    expect(h.count()).toBe(1)
    await h.at(30_000, 4)
    expect(h.count()).toBe(2)
    await h.capture.stop()
    h.store.close()
  })

  it('PRESERVE: BTC keeps its own trades-and-ticker socket, with no book subscription', async () => {
    const h = await harness(ethExtraMarketFeed({}))
    const feeds = (index: number): [string | undefined, string][] =>
      h.sent[index]!.map((message) => {
        const { feed, product_ids: ids } = JSON.parse(message) as {
          feed?: string
          product_ids?: string[]
        }
        return [feed, (ids ?? []).join()]
      })
    expect(
      feeds(0)
        .map(([feed]) => feed)
        .sort(),
    ).toEqual(['ticker', 'trade'])
    expect(feeds(0).every(([, ids]) => ids === 'PF_XBTUSD')).toBe(true)
    expect(feeds(1).map(([feed]) => feed)).toContain('book')
    expect(feeds(1).every(([, ids]) => ids === 'PF_ETHUSD')).toBe(true)
    await h.capture.stop()
    h.store.close()
  })
})
