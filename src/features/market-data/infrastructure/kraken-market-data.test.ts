import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KrakenFetch,
  KrakenMarketDataProviderOptions,
  KrakenWebSocket,
} from './kraken-market-data.ts'
import { KrakenMarketDataProvider } from './kraken-market-data.ts'
import type {
  Instrument,
  MarketDataProvider,
  Quote,
} from '../domain/market-data.ts'

const ASSET_PAIR = {
  altname: 'XBTEUR',
  wsname: 'BTC/EUR',
  aclass_base: 'currency',
  base: 'XXBT',
  aclass_quote: 'currency',
  quote: 'ZEUR',
  lot: 'unit',
  pair_decimals: 1,
  cost_decimals: 8,
  lot_decimals: 8,
  lot_multiplier: 1,
  fees: [],
  fees_maker: [],
  fee_volume_currency: 'ZEUR',
  margin_call: 80,
  margin_stop: 40,
  ordermin: '0.0001',
  costmin: '5',
  tick_size: '0.1',
  status: 'online',
}

const ASSET_PAIRS = { error: [], result: { XBTEUR: ASSET_PAIR } }

const TICKER_BASE = {
  channel: 'ticker',
  type: 'snapshot',
  data: [
    {
      symbol: 'BTC/EUR',
      bid: 62_000,
      bid_qty: 1.5,
      ask: 62_002,
      ask_qty: 2,
      last: 62_000.5,
      volume: 100.5,
      vwap: 61_500.25,
      low: 60_000,
      high: 63_000,
      change: 1000.5,
      change_pct: 1.63,
      timestamp: '2026-09-20T12:00:00.000Z',
    },
  ],
}

const TRADE_BASE = {
  channel: 'trade',
  type: 'snapshot',
  data: [
    {
      symbol: 'BTC/EUR',
      side: 'buy',
      price: 62_001.5,
      qty: 0.01,
      ord_type: 'market',
      trade_id: 1001,
      timestamp: '2026-09-20T12:00:00.500Z',
    },
  ],
}

class FakeWebSocket implements KrakenWebSocket {
  readonly send = vi.fn<(data: string) => void>()
  readonly close = vi.fn<(code?: number, reason?: string) => void>()
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  open(): void {
    this.onopen?.()
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  invalidMessage(): void {
    this.onmessage?.({ data: '{invalid json' })
  }

  serverClose(): void {
    this.onclose?.()
  }

  serverError(): void {
    this.onerror?.()
  }
}

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function makeFetch(responses: readonly Response[]): {
  fetch: KrakenFetch
  calls: string[]
} {
  const calls: string[] = []
  let index = 0
  const fetch: KrakenFetch = async (input) => {
    calls.push(input)
    return responses[index++] ?? makeResponse({}, false, 500)
  }
  return { fetch, calls }
}

function makeProvider(
  overrides: Partial<KrakenMarketDataProviderOptions> = {},
): {
  provider: KrakenMarketDataProvider
  sockets: FakeWebSocket[]
  fetchCalls: string[]
} {
  const { fetch, calls } = makeFetch([makeResponse(ASSET_PAIRS)])
  const sockets: FakeWebSocket[] = []
  const provider = new KrakenMarketDataProvider({
    fetch,
    webSocketFactory: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { provider, sockets, fetchCalls: calls }
}

describe('KrakenMarketDataProvider REST contract', () => {
  it('maps the AssetPairs response for XBTEUR to the BTC-EUR domain instrument', async () => {
    const { fetch, calls } = makeFetch([makeResponse(ASSET_PAIRS)])
    const provider = new KrakenMarketDataProvider({ fetch })

    const instruments: Instrument[] = await provider.getInstruments()

    expect(instruments).toEqual([
      expect.objectContaining({
        id: 'BTC-EUR',
        symbol: 'BTC-EUR',
        displayName: 'BTC-EUR',
        assetClass: 'crypto',
        currency: 'EUR',
        exchange: 'Kraken',
        providerSymbols: { kraken: 'XBTEUR' },
        providerMetadata: ASSET_PAIR,
      }),
    ])
    expect(calls).toEqual(['/api/market/instruments'])
  })

  it('keeps direct Kraken REST paths when an explicit REST base is provided', async () => {
    const { fetch, calls } = makeFetch([makeResponse(ASSET_PAIRS)])
    const provider = new KrakenMarketDataProvider({
      fetch,
      restBaseUrl: 'https://api.kraken.com/0',
    })

    await provider.getInstruments()

    expect(calls).toEqual([
      'https://api.kraken.com/0/public/AssetPairs?pair=XBTEUR',
    ])
  })

  it('resolves the pair entry through altname even when the response uses the internal pair key', async () => {
    const internalKey = makeFetch([
      makeResponse({ error: [], result: { XXBTZEUR: ASSET_PAIR } }),
    ])
    const provider = new KrakenMarketDataProvider({ fetch: internalKey.fetch })

    const instruments = await provider.getInstruments()

    expect(instruments[0]).toMatchObject({ id: 'BTC-EUR', currency: 'EUR' })
    expect(instruments[0]?.providerSymbols).toEqual({ kraken: 'XBTEUR' })
  })

  it('maps closed OHLC rows and includes the still-open last candle', async () => {
    const ohlc = {
      error: [],
      result: {
        XBTEUR: [
          [
            1_699_900_000,
            '60000.0',
            '62000.0',
            '59500.0',
            '61500.0',
            '61000.0',
            '12.5',
            24,
          ],
          [
            1_700_000_000,
            '61500.0',
            '63000.0',
            '61000.0',
            '62500.0',
            '62000.0',
            '13.0',
            25,
          ],
          [
            1_700_100_000,
            '62500.0',
            '63200.0',
            '62100.0',
            '63100.0',
            '63000.0',
            '14.1',
            26,
          ],
        ],
        last: 1_700_100_000,
      },
    }
    const { fetch, calls } = makeFetch([makeResponse(ohlc)])
    const provider = new KrakenMarketDataProvider({ fetch })

    const history = await provider.getHistory('BTC-EUR')

    expect(history).toEqual([
      {
        time: new Date(1_699_900_000 * 1000).toISOString(),
        open: 60_000,
        high: 62_000,
        low: 59_500,
        close: 61_500,
        volume: 12.5,
        isClosed: true,
      },
      {
        time: new Date(1_700_000_000 * 1000).toISOString(),
        open: 61_500,
        high: 63_000,
        low: 61_000,
        close: 62_500,
        volume: 13,
        isClosed: true,
      },
      {
        time: new Date(1_700_100_000 * 1000).toISOString(),
        open: 62_500,
        high: 63_200,
        low: 62_100,
        close: 63_100,
        volume: 14.1,
        isClosed: false,
      },
    ])
    expect(history.at(-1)?.isClosed).toBe(false)
    expect(history.slice(0, -1).every((candle) => candle.isClosed)).toBe(true)
    expect(history[0]?.time < history[1]!.time).toBe(true)
    expect(history[1]?.time < history[2]!.time).toBe(true)
    expect(calls).toEqual(['/api/market/history?instrumentId=BTC-EUR'])
  })

  it('returns an empty history during warm-up without inventing candles', async () => {
    const { fetch } = makeFetch([
      makeResponse({ error: [], result: { XBTEUR: [], last: 1_700_000_000 } }),
    ])
    const provider = new KrakenMarketDataProvider({ fetch })

    await expect(provider.getHistory('BTC-EUR')).resolves.toEqual([])
  })

  it('preserves real gaps between valid ascending 1m candles', async () => {
    const { fetch } = makeFetch([
      makeResponse({
        error: [],
        result: {
          XBTEUR: [
            [
              1_699_900_000,
              '60000',
              '62000',
              '59500',
              '61500',
              '61000',
              '12.5',
            ],
            [1_699_900_120, '61500', '63000', '61000', '62500', '62000', '13'],
            [
              1_699_900_180,
              '62500',
              '63200',
              '62100',
              '63100',
              '63000',
              '14.1',
            ],
          ],
          last: 1_699_900_180,
        },
      }),
    ])
    const provider = new KrakenMarketDataProvider({ fetch })

    const history = await provider.getHistory('BTC-EUR')

    expect(history.map(({ time }) => time)).toEqual([
      new Date(1_699_900_000 * 1000).toISOString(),
      new Date(1_699_900_120 * 1000).toISOString(),
      new Date(1_699_900_180 * 1000).toISOString(),
    ])
    expect(history.at(-1)?.isClosed).toBe(false)
  })

  it('surfaces Kraken REST errors and malformed OHLC rows', async () => {
    const apiError = makeFetch([
      makeResponse({ error: ['EQuery:Unknown asset pair'], result: {} }),
    ])
    const errorProvider = new KrakenMarketDataProvider({
      fetch: apiError.fetch,
    })
    await expect(errorProvider.getHistory('BTC-EUR')).rejects.toThrow(
      /Kraken API error: EQuery:Unknown asset pair/i,
    )

    const incomplete = makeFetch([
      makeResponse({
        error: [],
        result: { XBTEUR: [[1_699_900_000, '1', '2']], last: 1 },
      }),
    ])
    const incompleteProvider = new KrakenMarketDataProvider({
      fetch: incomplete.fetch,
    })
    await expect(incompleteProvider.getHistory('BTC-EUR')).rejects.toThrow(
      /invalid kraken ohlc candle/i,
    )

    const impossibleEnvelope = makeFetch([
      makeResponse({
        error: [],
        result: {
          XBTEUR: [
            [
              1_699_900_000,
              '60000.0',
              '62000.0',
              '60500.0',
              '61500.0',
              '61000.0',
              '12.5',
              24,
            ],
            [
              1_700_000_000,
              '61500.0',
              '63000.0',
              '61000.0',
              '62500.0',
              '62000.0',
              '13.0',
              25,
            ],
          ],
          last: 1_700_000_000,
        },
      }),
    ])
    const envelopeProvider = new KrakenMarketDataProvider({
      fetch: impossibleEnvelope.fetch,
    })
    await expect(envelopeProvider.getHistory('BTC-EUR')).rejects.toThrow(
      /invalid kraken ohlc candle/i,
    )
  })

  it('rejects OHLC history that is not in ascending time order', async () => {
    const outOfOrder = makeFetch([
      makeResponse({
        error: [],
        result: {
          XBTEUR: [
            [
              1_700_000_000,
              '61500.0',
              '63000.0',
              '61000.0',
              '62500.0',
              '62000.0',
              '13.0',
              25,
            ],
            [
              1_699_900_000,
              '60000.0',
              '62000.0',
              '59500.0',
              '61500.0',
              '61000.0',
              '12.5',
              24,
            ],
          ],
          last: 1_700_000_000,
        },
      }),
    ])
    const provider = new KrakenMarketDataProvider({ fetch: outOfOrder.fetch })

    await expect(provider.getHistory('BTC-EUR')).rejects.toThrow(/ascending/i)
  })

  it('returns a provisional candle when the open candle is the only row', async () => {
    const onlyOpen = makeFetch([
      makeResponse({
        error: [],
        result: {
          XBTEUR: [
            [
              1_700_000_000,
              '61500.0',
              '63000.0',
              '61000.0',
              '62500.0',
              '62000.0',
              '13.0',
              25,
            ],
          ],
          last: 1_700_000_000,
        },
      }),
    ])
    const provider = new KrakenMarketDataProvider({ fetch: onlyOpen.fetch })

    await expect(provider.getHistory('BTC-EUR')).resolves.toMatchObject([
      { isClosed: false, close: 62_500 },
    ])
  })

  it('surfaces HTTP failures with the Kraken path', async () => {
    const failed = makeFetch([
      makeResponse({ error: ['EService:Rate limit exceeded'] }, false, 429),
    ])
    const provider = new KrakenMarketDataProvider({ fetch: failed.fetch })

    await expect(provider.getInstruments()).rejects.toThrow(
      /Kraken HTTP 429 for \/api\/market\/instruments/i,
    )
  })

  it('does not request or invent unsupported instruments', async () => {
    const { provider, fetchCalls } = makeProvider()

    await expect(provider.getHistory('TTWO')).rejects.toThrow(
      /unsupported instrument/i,
    )
    expect(() => provider.subscribe(['SPCX'], () => {})).toThrow(
      /unsupported instrument/i,
    )
    expect(fetchCalls).toHaveLength(0)
  })

  it('satisfies the read-only MarketDataProvider contract without order methods', () => {
    const { provider } = makeProvider()
    const contract: MarketDataProvider = provider

    expect(typeof contract.getInstruments).toBe('function')
    expect(typeof contract.getHistory).toBe('function')
    expect(typeof contract.subscribe).toBe('function')
    expect('preview' in provider).toBe(false)
    expect('submit' in provider).toBe(false)
  })
})

describe('KrakenMarketDataProvider WebSocket v2 ticker contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the public BTC/EUR ticker channel and maps a snapshot quote', () => {
    const { provider, sockets } = makeProvider({
      now: () => Date.parse('2026-09-20T12:00:01.250Z'),
    })
    const quotes: Quote[] = []
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )
    const socket = sockets[0]!

    socket.open()
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['BTC/EUR'] },
      }),
    )
    expect(socket.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        method: 'subscribe',
        params: { channel: 'trade', symbol: ['BTC/EUR'], snapshot: true },
      }),
    )

    socket.message(TICKER_BASE)
    unsubscribe()

    expect(quotes).toEqual([
      {
        instrumentId: 'BTC-EUR',
        price: 62_000.5,
        change: 1000.5,
        changePercent: 1.63,
        timestamp: '2026-09-20T12:00:00.000Z',
        status: 'live',
        eventTime: '2026-09-20T12:00:00.000Z',
        receivedTime: '2026-09-20T12:00:01.250Z',
        displayTime: '2026-09-20T12:00:01.250Z',
        freshnessAgeMs: 1250,
        freshnessIsStale: false,
      },
    ])
  })

  it('maps ticker updates and ignores subscribe acknowledgements and heartbeats', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()

    socket.message(TICKER_BASE)
    socket.message({
      method: 'subscribe',
      success: true,
      result: { channel: 'ticker', symbol: 'BTC/EUR' },
    })
    socket.message({ channel: 'status', type: 'heartbeat' })
    socket.message({
      channel: 'ticker',
      type: 'update',
      data: [
        {
          ...TICKER_BASE.data[0]!,
          last: 63_000,
          change: 2000.5,
          change_pct: 3.28,
          timestamp: '2026-09-20T12:00:01.000Z',
        },
      ],
    })

    expect(quotes.map((quote) => quote.status)).toEqual(['live', 'live'])
    expect(quotes.map((quote) => quote.price)).toEqual([62_000.5, 63_000])
    expect(quotes[1]).toMatchObject({ change: 2000.5, changePercent: 3.28 })
    expect(sockets).toHaveLength(1)
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('maps trade snapshots and updates immediately with ticker change metadata', () => {
    const { provider, sockets } = makeProvider({
      now: () => Date.parse('2026-09-20T12:00:01.250Z'),
    })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)
    socket.message(TRADE_BASE)
    socket.message({
      channel: 'trade',
      type: 'update',
      data: [
        {
          ...TRADE_BASE.data[0]!,
          price: 62_002.25,
          trade_id: 1002,
          timestamp: '2026-09-20T12:00:00.750Z',
        },
      ],
    })

    expect(quotes.slice(1)).toEqual([
      {
        instrumentId: 'BTC-EUR',
        price: 62_001.5,
        change: 1000.5,
        changePercent: 1.63,
        timestamp: '2026-09-20T12:00:00.500Z',
        status: 'live',
        eventTime: '2026-09-20T12:00:00.500Z',
        receivedTime: '2026-09-20T12:00:01.250Z',
        displayTime: '2026-09-20T12:00:01.250Z',
        freshnessAgeMs: 750,
        freshnessIsStale: false,
      },
      {
        instrumentId: 'BTC-EUR',
        price: 62_002.25,
        change: 1000.5,
        changePercent: 1.63,
        timestamp: '2026-09-20T12:00:00.750Z',
        status: 'live',
        eventTime: '2026-09-20T12:00:00.750Z',
        receivedTime: '2026-09-20T12:00:01.250Z',
        displayTime: '2026-09-20T12:00:01.250Z',
        freshnessAgeMs: 500,
        freshnessIsStale: false,
      },
    ])
  })

  it('uses deterministic zero change fallback when trade data precedes ticker data', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TRADE_BASE)

    expect(quotes[0]).toMatchObject({
      price: 62_001.5,
      change: 0,
      changePercent: 0,
      status: 'live',
    })
  })

  it('skips duplicate and out-of-order trade ids without failing the socket', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TRADE_BASE)
    socket.message({
      channel: 'trade',
      type: 'update',
      data: [
        {
          ...TRADE_BASE.data[0]!,
          price: 61_000,
          trade_id: 1001,
          timestamp: '2026-09-20T12:00:00.600Z',
        },
      ],
    })
    socket.message({
      channel: 'trade',
      type: 'update',
      data: [
        {
          ...TRADE_BASE.data[0]!,
          price: 60_000,
          trade_id: 1000,
          timestamp: '2026-09-20T12:00:00.400Z',
        },
      ],
    })
    socket.message({
      channel: 'trade',
      type: 'update',
      data: [
        {
          ...TRADE_BASE.data[0]!,
          price: 62_003,
          trade_id: 1002,
          timestamp: '2026-09-20T12:00:00.700Z',
        },
      ],
    })

    expect(quotes.map((quote) => quote.price)).toEqual([62_001.5, 62_003])
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('skips duplicate and out-of-order ticker timestamps without failing the socket', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()

    socket.message(TICKER_BASE)
    socket.message({
      channel: 'ticker',
      type: 'update',
      data: [
        {
          ...TICKER_BASE.data[0]!,
          last: 63_000,
          timestamp: '2026-09-20T12:00:00.000Z',
        },
      ],
    })
    socket.message({
      channel: 'ticker',
      type: 'update',
      data: [
        {
          ...TICKER_BASE.data[0]!,
          last: 61_000,
          timestamp: '2026-09-20T11:59:59.000Z',
        },
      ],
    })
    socket.message({
      channel: 'ticker',
      type: 'update',
      data: [
        {
          ...TICKER_BASE.data[0]!,
          last: 63_000,
          timestamp: '2026-09-20T12:00:01.000Z',
        },
      ],
    })

    expect(quotes).toHaveLength(2)
    expect(quotes.map((quote) => quote.price)).toEqual([62_000.5, 63_000])
    expect(socket.close).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('ignores ticker data for symbols other than the subscribed BTC/EUR channel', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()

    socket.message({
      channel: 'ticker',
      type: 'snapshot',
      data: [{ ...TICKER_BASE.data[0]!, symbol: 'ETH/EUR', last: 2500 }],
    })

    expect(quotes).toHaveLength(0)
    expect(socket.close).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('marks the last quote stale and reconnects after a real socket close', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)
    socket.serverClose()

    expect(quotes.at(-1)).toMatchObject({
      price: 62_000.5,
      status: 'stale',
      freshnessIsStale: true,
    })
    expect(socket.close).toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(2)
  })

  it('marks the last quote stale and reconnects after a socket error', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)
    socket.serverError()

    expect(quotes.at(-1)).toMatchObject({ price: 62_000.5, status: 'stale' })
    expect(socket.close).toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(2)
  })

  it('marks the latest trade stale and reconnects when a subscription fails', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)
    socket.message(TRADE_BASE)
    socket.message({
      method: 'subscribe',
      success: false,
      error: 'EGeneral:Subscription failed',
    })

    expect(quotes.at(-1)).toMatchObject({
      price: 62_001.5,
      status: 'stale',
      freshnessIsStale: true,
    })
    expect(socket.close).toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(2)
  })

  it('marks the last quote stale and reconnects after invalid ticker data', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)
    socket.message({
      channel: 'ticker',
      type: 'update',
      data: [{ ...TICKER_BASE.data[0]!, last: 'not-a-number' }],
    })

    expect(quotes.at(-1)).toMatchObject({ price: 62_000.5, status: 'stale' })
    expect(socket.close).toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(2)
  })

  it('marks the last quote stale after the configurable freshness threshold', () => {
    const { provider, sockets } = makeProvider({ staleAfterMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER_BASE)

    vi.advanceTimersByTime(99)
    expect(quotes).toHaveLength(1)
    vi.advanceTimersByTime(1)

    expect(quotes).toHaveLength(2)
    expect(quotes.at(-1)).toMatchObject({ price: 62_000.5, status: 'stale' })
  })

  it('invokes default browser timers with globalThis as their receiver', () => {
    vi.useRealTimers()
    const setTimeout = vi.fn(function (
      this: typeof globalThis,
      _handler: () => void,
      _timeout: number,
    ) {
      expect(this).toBe(globalThis)
      expect(_handler).toBeDefined()
      expect(_timeout).toBeDefined()
      return 1 as ReturnType<typeof globalThis.setTimeout>
    })
    const clearTimeout = vi.fn(function (
      this: typeof globalThis,
      _handle: ReturnType<typeof globalThis.setTimeout>,
    ) {
      expect(this).toBe(globalThis)
      expect(_handle).toBeDefined()
    })
    vi.stubGlobal('setTimeout', setTimeout)
    vi.stubGlobal('clearTimeout', clearTimeout)

    try {
      const { provider, sockets } = makeProvider()
      const unsubscribe = provider.subscribe(['BTC-EUR'], () => {})
      sockets[0]!.open()
      sockets[0]!.message(TICKER_BASE)
      unsubscribe()

      expect(setTimeout).toHaveBeenCalled()
      expect(clearTimeout).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses exponential reconnect backoff capped at the configured maximum', () => {
    const { provider, sockets } = makeProvider({
      reconnectBaseMs: 100,
      reconnectMaxMs: 250,
    })
    provider.subscribe(['BTC-EUR'], () => {})

    sockets[0]!.serverClose()
    vi.advanceTimersByTime(99)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)

    sockets[1]!.serverClose()
    vi.advanceTimersByTime(199)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)

    sockets[2]!.serverClose()
    vi.advanceTimersByTime(249)
    expect(sockets).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(4)
  })

  it('marks the last quote stale after invalid JSON and cleans every socket and timer on unsubscribe', () => {
    const { provider, sockets } = makeProvider({
      staleAfterMs: 100,
      reconnectBaseMs: 100,
    })
    const quotes: Quote[] = []
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )
    sockets[0]!.open()
    sockets[0]!.message(TICKER_BASE)
    sockets[0]!.invalidMessage()
    expect(sockets[0]!.close).toHaveBeenCalled()
    expect(quotes.at(-1)).toMatchObject({ price: 62_000.5, status: 'stale' })

    unsubscribe()
    vi.runAllTimers()

    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(sockets[0]!.close).toHaveBeenCalled()
  })
})
