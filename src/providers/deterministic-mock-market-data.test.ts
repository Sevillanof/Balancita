import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Instrument,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'
import { DeterministicMockMarketDataProvider } from './deterministic-mock-market-data'

const INSTRUMENT_IDS = ['BTC-EUR', 'TTWO', 'SPCX'] as const

describe('catalog', () => {
  it('returns exactly the three seed instruments with mock symbols', async () => {
    const provider = new DeterministicMockMarketDataProvider(1)
    const instruments: Instrument[] = await provider.getInstruments()

    expect(instruments.map((i) => i.id)).toEqual([...INSTRUMENT_IDS])
    expect(instruments.every((i) => i.providerSymbols.mock === i.id)).toBe(true)
  })

  it('identifies BTC-EUR and TTWO with verified asset class, currency and exchange', async () => {
    const instruments: Instrument[] =
      await new DeterministicMockMarketDataProvider(1).getInstruments()
    const byId = new Map(instruments.map((i) => [i.id, i]))

    expect(byId.get('BTC-EUR')).toMatchObject({
      symbol: 'BTC-EUR',
      displayName: 'Bitcoin / Euro',
      assetClass: 'crypto',
      currency: 'EUR',
      exchange: 'Coinbase',
    })
    expect(byId.get('TTWO')).toMatchObject({
      symbol: 'TTWO',
      assetClass: 'equity',
      currency: 'USD',
      exchange: 'NASDAQ',
    })
  })

  it('keeps SPCX unconfirmed: unknown asset class, no exchange, no invented name', async () => {
    const instruments: Instrument[] =
      await new DeterministicMockMarketDataProvider(1).getInstruments()
    const spcx = instruments.find((i) => i.id === 'SPCX')

    expect(spcx).toBeDefined()
    expect(spcx!.assetClass).toBe('unknown')
    expect(spcx!.exchange).toBeUndefined()
    expect(spcx!.displayName).toBe('SPCX')
    expect(spcx!.currency).toBe('USD')
  })

  it('satisfies the MarketDataProvider contract', () => {
    const provider: MarketDataProvider =
      new DeterministicMockMarketDataProvider(1)
    expect(typeof provider.getInstruments).toBe('function')
    expect(typeof provider.getHistory).toBe('function')
    expect(typeof provider.subscribe).toBe('function')
  })
})

describe('history', () => {
  const provider = new DeterministicMockMarketDataProvider(2024)

  it('is identical for the same seed and same clock', async () => {
    const clock = () => 1_750_000_000_000
    const a = new DeterministicMockMarketDataProvider(42, clock)
    const b = new DeterministicMockMarketDataProvider(42, clock)

    for (const id of INSTRUMENT_IDS) {
      expect(await a.getHistory(id)).toEqual(await b.getHistory(id))
    }
  })

  it('is reproducible across calls for the same provider', async () => {
    expect(await provider.getHistory('BTC-EUR')).toEqual(
      await provider.getHistory('BTC-EUR'),
    )
  })

  it('differs for a different seed', async () => {
    const other = new DeterministicMockMarketDataProvider(43)
    expect(await other.getHistory('BTC-EUR')).not.toEqual(
      await provider.getHistory('BTC-EUR'),
    )
  })

  it('yields only positive prices and volume', async () => {
    for (const id of INSTRUMENT_IDS) {
      const history = await provider.getHistory(id)
      expect(history.length).toBeGreaterThan(0)

      for (const candle of history) {
        expect(candle.open).toBeGreaterThan(0)
        expect(candle.high).toBeGreaterThan(0)
        expect(candle.low).toBeGreaterThan(0)
        expect(candle.close).toBeGreaterThan(0)
        expect(candle.volume).toBeGreaterThan(0)
      }
    }
  })

  it('respects OHLC invariants across every instrument', async () => {
    for (const id of INSTRUMENT_IDS) {
      const history = await provider.getHistory(id)

      for (const candle of history) {
        expect(candle.high).toBeGreaterThanOrEqual(
          Math.max(candle.open, candle.close),
        )
        expect(candle.low).toBeLessThanOrEqual(
          Math.min(candle.open, candle.close),
        )
        expect(candle.high).toBeGreaterThanOrEqual(candle.low)
      }
    }
  })

  it('uses strictly ascending ISO timestamps', async () => {
    const history = await provider.getHistory('BTC-EUR')

    for (let i = 0; i < history.length; i++) {
      const time = history[i].time
      expect(time).toBe(new Date(time).toISOString())

      if (i > 0) {
        expect(Date.parse(time)).toBeGreaterThan(
          Date.parse(history[i - 1].time),
        )
      }
    }
  })

  it('rejects unknown instruments explicitly', async () => {
    await expect(provider.getHistory('NOPE')).rejects.toThrow(
      /unknown instrument/i,
    )
  })
})

describe('subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a cleanup function and leaves no active timers after cleanup', () => {
    const provider = new DeterministicMockMarketDataProvider(7)
    const unsubscribe = provider.subscribe(['BTC-EUR'], () => {})

    expect(vi.getTimerCount()).toBe(1)

    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops emitting after cleanup', () => {
    const quotes: Quote[] = []
    const provider = new DeterministicMockMarketDataProvider(7)
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )

    vi.advanceTimersByTime(1_000)
    expect(quotes).toHaveLength(1)

    unsubscribe()
    vi.advanceTimersByTime(10_000)
    expect(quotes).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('emits one mock quote per subscribed instrument on each tick', () => {
    const quotes: Quote[] = []
    const provider = new DeterministicMockMarketDataProvider(7)
    const unsubscribe = provider.subscribe(
      ['BTC-EUR', 'TTWO', 'SPCX'],
      (quote) => quotes.push(quote),
    )

    vi.advanceTimersByTime(2_000)
    unsubscribe()

    expect(quotes).toHaveLength(6)
    expect(quotes.every((quote) => quote.status === 'mock')).toBe(true)
  })

  it('uses the injectable clock for quote timestamps', () => {
    const fixed = new Date('2026-01-05T12:34:56.789Z')
    const provider = new DeterministicMockMarketDataProvider(7, () => fixed)
    const quotes: Quote[] = []
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )

    vi.advanceTimersByTime(1_000)
    unsubscribe()

    expect(quotes[0].timestamp).toBe('2026-01-05T12:34:56.789Z')
  })

  it('keeps change and changePercent consistent with the emitted price sequence', () => {
    const quotes: Quote[] = []
    const provider = new DeterministicMockMarketDataProvider(7)
    const unsubscribe = provider.subscribe(['BTC-EUR'], (quote) =>
      quotes.push(quote),
    )

    vi.advanceTimersByTime(3_000)
    unsubscribe()

    expect(quotes.length).toBe(3)
    for (let i = 1; i < quotes.length; i++) {
      const previousPrice = quotes[i - 1].price
      const quote = quotes[i]
      expect(quote.change).toBeCloseTo(quote.price - previousPrice, 2)
      expect(quote.changePercent).toBeCloseTo(
        (quote.change / previousPrice) * 100,
        2,
      )
    }
  })

  it('is reproducible for the same seed and clock', () => {
    const clock = () => 1_750_000_000_000
    const a = new DeterministicMockMarketDataProvider(42, clock)
    const b = new DeterministicMockMarketDataProvider(42, clock)
    const quotesA: Quote[] = []
    const quotesB: Quote[] = []

    const unsubscribeA = a.subscribe(['BTC-EUR', 'TTWO'], (quote) =>
      quotesA.push(quote),
    )
    const unsubscribeB = b.subscribe(['BTC-EUR', 'TTWO'], (quote) =>
      quotesB.push(quote),
    )

    vi.advanceTimersByTime(3_000)
    unsubscribeA()
    unsubscribeB()

    expect(quotesA).toHaveLength(6)
    expect(quotesA).toEqual(quotesB)
  })

  it('rejects unknown instrument ids', () => {
    const provider = new DeterministicMockMarketDataProvider(7)
    expect(() => provider.subscribe(['VOO'], () => {})).toThrow(
      /unknown instrument/i,
    )
  })
})
