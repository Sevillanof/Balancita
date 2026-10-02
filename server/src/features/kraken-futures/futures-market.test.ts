import { describe, expect, it } from 'vitest'
import {
  decodeProviderJson,
  KrakenFuturesMarketCollector,
  marketSubscriptions,
  parseBookMessage,
  parseTickerMessage,
  parseTradeMessage,
  parseTradeSnapshot,
  validateInstrumentCatalog,
} from './futures-market.ts'
import { FuturesCandleBuilder } from './futures-candles.ts'
import { FuturesMarketStore } from './futures-market-store.ts'

const instrument = {
  symbol: 'PF_XBTUSD',
  type: 'flexible_futures',
  pair: 'BTC:USD',
  base: 'BTC',
  quote: 'USD',
  contractSize: 1,
  contractValueTradePrecision: 4,
  tickSize: 1,
  tradeable: true,
  isExpired: false,
}

describe('Kraken Futures market decoding', () => {
  it('preserves the provider numeric lexeme before JavaScript rounding', () => {
    const parsed = decodeProviderJson('{"price":9007199254740993.12345}') as {
      price: unknown
    }
    expect(parsed.price).toBe('9007199254740993.12345')
    const catalogSized = `${' '.repeat(300_000)}{}`
    expect(() => decodeProviderJson(catalogSized)).toThrow(/size bound/)
    expect(decodeProviderJson(catalogSized, 5_000_000)).toEqual({})
  })

  it('validates live catalog semantics and explicit EEA rules', () => {
    const spec = validateInstrumentCatalog(
      { instruments: [instrument] },
      { source: 'live', retrievedAt: 1_800_000_000_000 },
    )
    expect(spec.entryEligibility).toBe('eligible')
    expect(spec.quantityUnit).toBe('BTC')
    expect(spec.minimumQuantity).toBe('0.0001')
    expect(spec.tickSize).toBe('1')
    expect(
      validateInstrumentCatalog(
        { instruments: [{ ...instrument, tickSize: 0.5 }] },
        { source: 'live', retrievedAt: 1_800_000_000_000 },
      ).entryEligibility,
    ).toBe('metadata_invalid')
    expect(
      validateInstrumentCatalog(
        {
          instruments: [
            { ...instrument, contractValueTradePrecision: undefined },
          ],
        },
        { source: 'live', retrievedAt: 1_800_000_000_000 },
      ).entryEligibility,
    ).toBe('metadata_invalid')
  })

  it('serializes one protocol-correct public subscription per feed', () => {
    expect(marketSubscriptions()).toEqual([
      '{"event":"subscribe","feed":"trade","product_ids":["PF_XBTUSD"]}',
      '{"event":"subscribe","feed":"book","product_ids":["PF_XBTUSD"]}',
      '{"event":"subscribe","feed":"ticker","product_ids":["PF_XBTUSD"]}',
    ])
  })

  it('parses exact trade/book/ticker decimals and distinguishes unknown funding', () => {
    expect(
      parseTradeMessage(
        decodeProviderJson(
          '{"feed":"trade","product_id":"PF_XBTUSD","uid":"u1","side":"buy","type":"fill","seq":2,"time":1800000000000,"qty":0.0001,"price":9007199254740993.125}',
        ),
        { receivedAt: 1_800_000_000_001, epoch: 1 },
      ).priceUsd,
    ).toBe('9007199254740993.125')
    expect(
      parseBookMessage(
        decodeProviderJson(
          '{"feed":"book_snapshot","product_id":"PF_XBTUSD","seq":1,"timestamp":1800000000000,"bids":[{"price":100,"qty":0.01}],"asks":[{"price":101,"qty":0.02}]}',
        ),
        { receivedAt: 1_800_000_000_001, epoch: 1 },
      ).snapshot,
    ).toBe(true)
    const ticker = parseTickerMessage(
      decodeProviderJson(
        '{"feed":"ticker","product_id":"PF_XBTUSD","time":1800000000000,"bid":100,"ask":101,"last":100.5,"markPrice":100.25,"index":100.2,"suspended":false}',
      ),
      { receivedAt: 1_800_000_000_001, epoch: 1 },
    )
    expect(ticker.funding).toEqual({ status: 'unknown' })
    const observedZero = parseTickerMessage(
      {
        feed: 'ticker',
        product_id: 'PF_XBTUSD',
        time: 1,
        suspended: false,
        funding_rate: '0',
      },
      { receivedAt: 2, epoch: 1 },
    )
    expect(observedZero.funding).toEqual({
      status: 'observed',
      rate: '0',
      unit: 'provider-unresolved',
    })
    const recovered = parseTradeSnapshot(
      decodeProviderJson(
        '{"feed":"trade_snapshot","product_id":"PF_XBTUSD","trades":[{"feed":"trade","product_id":"PF_XBTUSD","uid":"old","side":"sell","type":"fill","seq":7,"time":1700000000000,"qty":0.0001,"price":1}]}',
      ),
      { receivedAt: 1_800_000_000_002, epoch: 1 },
    )
    expect(recovered[0]?.recovered).toBe(true)
    expect(recovered[0]?.receivedAt).toBe(1_800_000_000_002)
    expect(() =>
      parseTradeMessage(
        {
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: 'bad',
          side: 'buy',
          type: 'fill',
          seq: '9007199254740993',
          time: 1,
          qty: 1,
          price: 1,
        },
        { receivedAt: 1, epoch: 1 },
      ),
    ).toThrow(/seq/)
  })

  it('invalidates a book gap, ignores heartbeats for freshness, and recovers only on a new snapshot', () => {
    let now = 100_000
    let socket: {
      onopen: (() => void) | null
      onmessage: ((event: { data: unknown }) => void) | null
      onerror: (() => void) | null
      onclose: (() => void) | null
      send: (message: string) => void
      close: () => void
    }
    const messages: string[] = []
    const gaps: unknown[] = []
    const persisted: unknown[] = []
    const liveTradeCalls: unknown[] = []
    const states: string[] = []
    const callbacks: Array<{
      id: number
      callback: () => void
      delay: number
      active: boolean
    }> = []
    let timerId = 0
    const collector = new KrakenFuturesMarketCollector({
      clock: () => now,
      random: () => 0.5,
      makeSocket: () =>
        (socket = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: (message) => messages.push(message),
          close: () => {},
        }),
      setTimeout: (callback, delay) => {
        timerId += 1
        callbacks.push({ id: timerId, callback, delay, active: true })
        return timerId as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (id) => {
        const timer = callbacks.find((candidate) => candidate.id === Number(id))
        if (timer) timer.active = false
      },
      persist: (event) => {
        persisted.push(event)
      },
      onTrade: (trade) => {
        liveTradeCalls.push(trade)
      },
      onState: (state, reason) => states.push(`${state}:${reason ?? ''}`),
      persistGap: (gap) => {
        gaps.push(gap)
      },
      staleAfterMs: 3000,
    })
    collector.start()
    socket!.onopen!()
    expect(messages).toHaveLength(3)
    const send = (value: unknown) =>
      socket!.onmessage!({ data: JSON.stringify(value) })
    const book = (
      feed: string,
      seq: number,
      extra: Record<string, unknown> = {},
    ) => ({
      feed,
      product_id: 'PF_XBTUSD',
      seq,
      timestamp: now,
      bids: [{ price: 100, qty: 1 }],
      asks: [
        { price: 101, qty: 1 },
        { price: 102, qty: 1 },
      ],
      ...extra,
    })
    send(book('book_snapshot', 10))
    send({
      feed: 'ticker',
      product_id: 'PF_XBTUSD',
      time: now,
      seq: 1,
      bid: 100,
      ask: 101,
      last: 100,
      markPrice: 100,
      index: 100,
      suspended: false,
    })
    send({
      feed: 'trade_snapshot',
      product_id: 'PF_XBTUSD',
      trades: [
        {
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: 'warmup',
          side: 'buy',
          type: 'fill',
          seq: 900,
          time: now - 60_000,
          qty: 0.1,
          price: 100,
        },
      ],
    })
    expect(liveTradeCalls).toHaveLength(0)
    expect(collector.status, states.join(',')).toBe('live')
    now += 2_000
    send({ feed: 'heartbeat' })
    expect(collector.tick()).toBe('live')
    send(book('book', 11, { side: 'sell', price: 101, qty: 0 }))
    expect(collector.book.asks).toEqual([{ price: '102', quantity: '1' }])
    expect(collector.book.executableEligible).toBe(true)
    send(book('book', 13, { side: 'sell', price: 103, qty: 1 }))
    expect(collector.status).toBe('degraded')
    expect(collector.metrics.sequenceDiscontinuityCount).toBe(1)
    expect(collector.book.executableEligible).toBe(false)
    send(book('book', 12, { side: 'sell', price: 104, qty: 1 }))
    expect(collector.status).toBe('degraded')
    expect(gaps).toHaveLength(1)
    expect(messages).toHaveLength(5)
    expect(collector.metrics.bookValid).toBe(false)
    send(book('book_snapshot', 20))
    expect(collector.metrics.bookValid).toBe(true)
    expect(collector.book.executableEligible).toBe(true)
    expect(collector.book.qualityPolicy).toBe('snapshot-contiguous-observed.v1')
    expect(collector.book.sourceGuarantee).toBe('undocumented')
    send(book('book_snapshot', 21, { bids: [] }))
    expect(collector.book.valid).toBe(false)
    expect(collector.book.executableEligible).toBe(false)
    send(book('book_snapshot', 22))
    expect(collector.book.executableEligible).toBe(true)
    const ticker = (seq: number, suspended: boolean, includeMark = true) => ({
      feed: 'ticker',
      product_id: 'PF_XBTUSD',
      time: now,
      seq,
      bid: 100,
      ask: 101,
      last: 100,
      ...(includeMark ? { markPrice: 100 } : {}),
      index: 100,
      suspended,
    })
    send(ticker(2, true))
    expect(collector.book.executableEligible).toBe(false)
    send(ticker(3, false))
    expect(collector.book.executableEligible).toBe(true)
    send(ticker(4, false, false))
    expect(collector.book.executableEligible).toBe(false)
    send(ticker(5, false))
    expect(collector.book.executableEligible).toBe(true)
    now += 3001
    callbacks
      .filter((timer) => timer.active && timer.delay === 3001)
      .at(-1)!
      .callback()
    expect(collector.status).toBe('stale')
    expect(collector.book.executableEligible).toBe(false)
    expect(messages).toHaveLength(9)
    expect(persisted).toHaveLength(11)
    socket!.onclose!()
    callbacks.find((timer) => timer.active && timer.delay === 500)!.callback()
    socket!.onopen!()
    expect(collector.metrics.epoch).toBe(2)
    expect(collector.book.valid).toBe(false)
    collector.stop()
    expect(collector.status).toBe('stopped')
  })

  it('closes candles by clock and appends a late correction without replacing prior revisions', () => {
    const store = new FuturesMarketStore(':memory:')
    const builder = new FuturesCandleBuilder(store, [60_000])
    const trade = (
      uid: string,
      time: number,
      seq: number,
      price: string,
      qty: string,
    ) => ({
      type: 'trade' as const,
      productId: 'PF_XBTUSD' as const,
      seq,
      eventTime: time,
      receivedAt: time + 10,
      persistedAt: time + 11,
      epoch: 1,
      uid,
      side: 'buy' as const,
      tradeType: 'fill' as const,
      quantityBtc: qty,
      priceUsd: price,
      recovered: false as const,
      raw: {},
    })
    builder.addTrade(trade('t1', 60_001, 1, '100', '0.0001'), 60_020)
    builder.advanceClock(120_000)
    builder.addTrade(trade('late', 60_500, 2, '101', '0.0002'), 120_100)
    const revisions = store.candleRevisions() as Array<Record<string, unknown>>
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3])
    expect(revisions[0]?.volume_btc).toBe('0.0001')
    expect(revisions[1]?.is_closed).toBe(1)
    expect(revisions[2]?.volume_btc).toBe('0.0003')
    expect(revisions[2]?.coverage).toBe(
      'observed_trades_only_no_gap_certification',
    )
    store.close()
  })

  it('halts on persistence failure, closes the socket, and leaves an explicit degraded reason', () => {
    let socket: {
      onopen: (() => void) | null
      onmessage: ((event: { data: unknown }) => void) | null
      onerror: (() => void) | null
      onclose: (() => void) | null
      send: (message: string) => void
      close: () => void
    }
    let closes = 0
    const states: string[] = []
    const collector = new KrakenFuturesMarketCollector({
      clock: () => 180_000,
      random: () => 0.5,
      makeSocket: () =>
        (socket = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: () => {},
          close: () => {
            closes += 1
          },
        }),
      setTimeout: (callback) => setTimeout(callback, 10_000),
      clearTimeout,
      persist: () => {
        throw new Error('disk full')
      },
      persistGap: () => {},
      onState: (state, reason) => states.push(`${state}:${reason ?? ''}`),
    })
    collector.start()
    socket!.onopen!()
    socket!.onmessage!({
      data: JSON.stringify({
        feed: 'book_snapshot',
        product_id: 'PF_XBTUSD',
        seq: 1,
        timestamp: 180_000,
        bids: [{ price: 100, qty: 1 }],
        asks: [{ price: 101, qty: 1 }],
      }),
    })
    expect(collector.status).toBe('degraded')
    expect(collector.metrics.persistenceErrorCount).toBe(1)
    expect(closes).toBe(1)
    expect(states.at(-1)).toMatch(/market_persistence_failed:disk full/)
  })
})
