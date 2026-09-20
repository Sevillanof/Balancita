import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CoinbaseFetch,
  CoinbaseMarketDataProviderOptions,
  CoinbaseWebSocket,
} from './coinbase-market-data'
import { CoinbaseMarketDataProvider } from './coinbase-market-data'
import type {
  Instrument,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'

const PRODUCT = {
  id: 'BTC-EUR',
  base_currency: 'BTC',
  quote_currency: 'EUR',
  base_min_size: '0.0001',
  base_max_size: '1000',
  base_increment: '0.00000001',
  quote_increment: '0.01',
  display_name: 'BTC-EUR',
  min_market_funds: '10',
  max_market_funds: '1000000',
  status: 'online',
  status_message: null,
  cancel_only: false,
  limit_only: false,
  post_only: false,
  trading_disabled: false,
  fx_stablecoin: false,
}

const TICKER = {
  type: 'ticker',
  sequence: 10,
  product_id: 'BTC-EUR',
  price: '62000.50',
  open_24h: '61000.00',
  volume_24h: '100.5',
  time: '2026-09-20T12:00:00.000Z',
}

class FakeWebSocket implements CoinbaseWebSocket {
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
  fetch: CoinbaseFetch
  calls: string[]
} {
  const calls: string[] = []
  let index = 0
  const fetch: CoinbaseFetch = async (input) => {
    calls.push(input)
    return responses[index++] ?? makeResponse({}, false, 500)
  }
  return { fetch, calls }
}

function makeProvider(
  overrides: Partial<CoinbaseMarketDataProviderOptions> = {},
): {
  provider: CoinbaseMarketDataProvider
  sockets: FakeWebSocket[]
  fetchCalls: string[]
} {
  const { fetch, calls } = makeFetch([makeResponse(PRODUCT)])
  const sockets: FakeWebSocket[] = []
  const provider = new CoinbaseMarketDataProvider({
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

describe('CoinbaseMarketDataProvider REST contract', () => {
  it('maps the exact BTC-EUR product and preserves Coinbase metadata', async () => {
    const { fetch, calls } = makeFetch([makeResponse(PRODUCT)])
    const provider = new CoinbaseMarketDataProvider({ fetch })

    const instruments: Instrument[] = await provider.getInstruments()

    expect(instruments).toEqual([
      expect.objectContaining({
        id: 'BTC-EUR',
        symbol: 'BTC-EUR',
        displayName: 'BTC-EUR',
        assetClass: 'crypto',
        currency: 'EUR',
        exchange: 'Coinbase Exchange',
        providerSymbols: { coinbase: 'BTC-EUR' },
        providerMetadata: PRODUCT,
      }),
    ])
    expect(calls).toEqual([
      'https://api.exchange.coinbase.com/products/BTC-EUR',
    ])
  })

  it('maps candles to ascending ISO Candle values and caps oversized history at 300 items', async () => {
    const candles = [
      [1_757_765_000, 60_000, 62_000, 61_000, 61_500, 12.5],
      [1_757_678_600, 59_000, 61_000, 60_500, 60_000, 10],
    ]
    const { fetch, calls } = makeFetch([makeResponse(candles)])
    const provider = new CoinbaseMarketDataProvider({ fetch })

    await expect(provider.getHistory('BTC-EUR')).resolves.toEqual([
      {
        time: new Date(1_757_678_600 * 1000).toISOString(),
        open: 60_500,
        high: 61_000,
        low: 59_000,
        close: 60_000,
        volume: 10,
      },
      {
        time: new Date(1_757_765_000 * 1000).toISOString(),
        open: 61_000,
        high: 62_000,
        low: 60_000,
        close: 61_500,
        volume: 12.5,
      },
    ])
    expect(calls).toEqual([
      'https://api.exchange.coinbase.com/products/BTC-EUR/candles?granularity=86400',
    ])
  })

  it('rejects malformed JSON shapes and incomplete candles', async () => {
    const malformed = makeFetch([makeResponse({ candles: [] })])
    const provider = new CoinbaseMarketDataProvider({ fetch: malformed.fetch })
    await expect(provider.getHistory('BTC-EUR')).rejects.toThrow(
      /invalid candles response/i,
    )

    const incomplete = makeFetch([makeResponse([[1_757_678_600, 1, 2]])])
    const incompleteProvider = new CoinbaseMarketDataProvider({
      fetch: incomplete.fetch,
    })
    await expect(incompleteProvider.getHistory('BTC-EUR')).rejects.toThrow(
      /invalid candle/i,
    )
  })

  it('surfaces HTTP failures and caps the first 300 candles from an oversized response', async () => {
    const failed = makeFetch([
      makeResponse({ message: 'rate limited' }, false, 429),
    ])
    const failedProvider = new CoinbaseMarketDataProvider({
      fetch: failed.fetch,
    })
    await expect(failedProvider.getInstruments()).rejects.toThrow(/HTTP 429/)

    const oversizedResponse = Array.from({ length: 350 }, (_, index) => [
      350 - index,
      1,
      3,
      2,
      2.5,
      1,
    ])
    const oversized = makeFetch([makeResponse(oversizedResponse)])
    const oversizedProvider = new CoinbaseMarketDataProvider({
      fetch: oversized.fetch,
    })
    const history = await oversizedProvider.getHistory('BTC-EUR')

    expect(history).toHaveLength(300)
    expect(history[0]?.time).toBe(new Date(51 * 1000).toISOString())
    expect(history.at(-1)?.time).toBe(new Date(350 * 1000).toISOString())
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

describe('CoinbaseMarketDataProvider WebSocket contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the public BTC-EUR ticker channel and maps quotes', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )
    const socket = sockets[0]!

    socket.open()
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-EUR'],
        channels: ['ticker'],
      }),
    )

    socket.message(TICKER)
    unsubscribe()

    expect(quotes).toEqual([
      {
        instrumentId: 'BTC-EUR',
        price: 62000.5,
        change: 1000.5,
        changePercent: expect.closeTo((1000.5 / 61000) * 100, 10),
        timestamp: TICKER.time,
        status: 'live',
      },
    ])
  })

  it('accepts sequence gaps and keeps the ticker socket open', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER)
    socket.message({ ...TICKER, sequence: 12, price: '63000' })

    expect(quotes.map((quote) => quote.status)).toEqual(['live', 'live'])
    expect(quotes.at(-1)?.price).toBe(63000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('ignores duplicate and out-of-order sequences without closing the socket', () => {
    const { provider, sockets } = makeProvider()
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER)
    socket.message({ ...TICKER, sequence: 10, price: '63000' })
    socket.message({ ...TICKER, sequence: 9, price: '61000' })

    expect(quotes).toHaveLength(1)
    expect(quotes[0]?.price).toBe(Number(TICKER.price))
    expect(socket.close).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('marks the last quote stale and reconnects after a real socket close', () => {
    const { provider, sockets } = makeProvider({ reconnectBaseMs: 100 })
    const quotes: Quote[] = []
    provider.subscribe(['BTC-EUR'], (quote) => quotes.push(quote))
    const socket = sockets[0]!
    socket.open()
    socket.message(TICKER)
    socket.serverClose()

    expect(quotes.at(-1)).toMatchObject({ price: 62000.5, status: 'stale' })
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
    socket.message(TICKER)
    socket.serverError()

    expect(quotes.at(-1)).toMatchObject({ price: 62000.5, status: 'stale' })
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
    socket.message(TICKER)
    socket.message({ ...TICKER, price: 'not-a-number' })

    expect(quotes.at(-1)).toMatchObject({ price: 62000.5, status: 'stale' })
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
    socket.message(TICKER)

    vi.advanceTimersByTime(99)
    expect(quotes).toHaveLength(1)
    vi.advanceTimersByTime(1)

    expect(quotes).toHaveLength(2)
    expect(quotes.at(-1)).toMatchObject({ price: 62000.5, status: 'stale' })
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
    sockets[0]!.message(TICKER)
    sockets[0]!.invalidMessage()
    expect(sockets[0]!.close).toHaveBeenCalled()
    expect(quotes.at(-1)).toMatchObject({ price: 62000.5, status: 'stale' })

    unsubscribe()
    vi.runAllTimers()

    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(sockets[0]!.close).toHaveBeenCalled()
  })
})
