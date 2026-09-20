import { describe, expect, it } from 'vitest'
import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../domain/market-data'
import { toCandlestickData, toCandlestickDataset } from './candlestick-data'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: overrides.time ?? '2024-01-01T00:00:00.000Z',
    open: overrides.open ?? 100,
    high: overrides.high ?? 105,
    low: overrides.low ?? 99,
    close: overrides.close ?? 104,
    volume: overrides.volume ?? 1000,
  }
}

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
