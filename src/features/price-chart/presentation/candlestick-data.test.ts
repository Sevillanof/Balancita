import { describe, expect, it } from 'vitest'
import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle, Quote } from '../../market-data/domain/market-data.ts'
import {
  mergeQuoteIntoCandles,
  toCandlestickData,
  toCandlestickDataset,
} from './candlestick-data.ts'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: overrides.time ?? '2024-01-01T00:00:00.000Z',
    open: overrides.open ?? 100,
    high: overrides.high ?? 105,
    low: overrides.low ?? 99,
    close: overrides.close ?? 104,
    volume: overrides.volume ?? 1000,
    ...(overrides.isClosed === undefined
      ? {}
      : { isClosed: overrides.isClosed }),
  }
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    instrumentId: 'BTC-EUR',
    price: 103,
    change: 0,
    changePercent: 0,
    timestamp: '2024-01-01T00:00:30.000Z',
    status: 'live',
    ...overrides,
  }
}

describe('mergeQuoteIntoCandles', () => {
  it('updates the provisional candle in the quote minute', () => {
    const candles = [
      makeCandle({
        time: '2024-01-01T00:00:00.000Z',
        open: 100,
        high: 105,
        low: 99,
        close: 104,
        isClosed: false,
      }),
    ]

    expect(
      mergeQuoteIntoCandles(
        candles,
        makeQuote({ price: 107, eventTime: '2024-01-01T00:00:45.000Z' }),
      ),
    ).toEqual([
      {
        ...candles[0],
        high: 107,
        low: 99,
        close: 107,
        isClosed: false,
      },
    ])
  })

  it('appends a provisional candle for a new UTC minute', () => {
    const candles = [
      makeCandle({
        time: '2024-01-01T00:00:00.000Z',
        isClosed: true,
      }),
    ]

    expect(
      mergeQuoteIntoCandles(
        candles,
        makeQuote({
          price: 108,
          timestamp: '2024-01-01T00:01:05.000Z',
        }),
      ),
    ).toEqual([
      ...candles,
      {
        time: '2024-01-01T00:01:00.000Z',
        open: 108,
        high: 108,
        low: 108,
        close: 108,
        volume: 0,
        isClosed: false,
      },
    ])
  })

  it('does not mutate a closed candle', () => {
    const candles = [
      makeCandle({
        time: '2024-01-01T00:00:00.000Z',
        close: 104,
        isClosed: true,
      }),
    ]

    expect(
      mergeQuoteIntoCandles(
        candles,
        makeQuote({ price: 109, timestamp: '2024-01-01T00:00:59.000Z' }),
      ),
    ).toEqual(candles)
  })

  it('uses the quote timing fields to keep the chart latest close current', () => {
    const merged = mergeQuoteIntoCandles(
      [
        makeCandle({
          time: '2024-01-01T00:00:00.000Z',
          close: 104,
          isClosed: false,
        }),
      ],
      makeQuote({
        price: 111,
        timestamp: '2024-01-01T00:02:00.000Z',
        eventTime: '2024-01-01T00:01:30.000Z',
      }),
    )

    expect(merged.at(-1)?.close).toBe(111)
    expect(merged.at(-1)?.time).toBe('2024-01-01T00:01:00.000Z')
  })
})

describe('toCandlestickData', () => {
  it('converts a UTC ISO time to a UTCTimestamp in seconds', () => {
    const candle = makeCandle({ time: '2024-01-01T00:00:00.000Z' })

    const data = toCandlestickData(candle)

    expect(data.time).toBe(1704067200 as UTCTimestamp)
  })

  it('keeps open, high, low and close', () => {
    const candle = makeCandle({
      open: 100,
      high: 105,
      low: 99,
      close: 104,
    })

    const data = toCandlestickData(candle)

    expect(data.open).toBe(100)
    expect(data.high).toBe(105)
    expect(data.low).toBe(99)
    expect(data.close).toBe(104)
  })

  it('does not carry the volume field', () => {
    const data = toCandlestickData(makeCandle({ volume: 999 }))

    expect(data).not.toHaveProperty('volume')
  })

  it('throws on a non-ISO timestamp', () => {
    expect(() => toCandlestickData(makeCandle({ time: 'yesterday' }))).toThrow(
      'Invalid candle time',
    )
  })
})

describe('toCandlestickDataset', () => {
  it('maps every candle preserving order and time precision', () => {
    const candles = [
      makeCandle({ time: '2024-01-01T00:00:00.000Z' }),
      makeCandle({
        time: '2024-01-02T12:30:45.000Z',
        open: 104,
        close: 106,
      }),
    ]

    const data = toCandlestickDataset(candles)

    expect(data).toHaveLength(2)
    expect(data[0].time).toBe(1704067200 as UTCTimestamp)
    expect(data[1].time).toBe(1704198645 as UTCTimestamp)
    expect(data[1].open).toBe(104)
    expect(data[1].close).toBe(106)
  })
})
