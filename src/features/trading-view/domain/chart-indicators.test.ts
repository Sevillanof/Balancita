import { describe, expect, it } from 'vitest'
import {
  aggregate,
  bollinger,
  donchian,
  ema,
  priorDayValueArea,
  rsi,
  valueArea,
  volumeProfile,
  vwap,
} from './chart-indicators.ts'

const candles = [10, 11, 12, 11, 13, 14].map((close, index) => ({
  time: 60 * index,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: index + 1,
}))

describe('chart indicators', () => {
  it('seeds the EMA with the SMA of the first period closes', () => {
    const points = ema(candles, 3)
    expect(points[0]).toEqual({ time: 120, value: 11 })
    // alpha = 0.5: 11*0.5 + 11*0.5 = 11, then 13*0.5 + 11*0.5 = 12
    expect(points.map((point) => point.value)).toEqual([11, 11, 12, 13])
    expect(ema(candles.slice(0, 2), 3)).toEqual([])
  })

  it('uses the population deviation for Bollinger bands', () => {
    const bands = bollinger(candles, 3, 2)
    expect(bands.middle[0]).toEqual({ time: 120, value: 11 })
    const deviation = Math.sqrt(2 / 3)
    expect(bands.upper[0]!.value).toBeCloseTo(11 + 2 * deviation)
    expect(bands.lower[0]!.value).toBeCloseTo(11 - 2 * deviation)
  })

  it('takes the Donchian channel from the previous candles only', () => {
    const channel = donchian(candles, 3)
    expect(channel.upper[0]).toEqual({ time: 180, value: 13 })
    expect(channel.lower[0]).toEqual({ time: 180, value: 8 })
  })

  it('restarts VWAP each UTC day', () => {
    const day = 86_400
    const points = vwap([
      { time: day - 60, high: 12, low: 9, close: 9, volume: 1 },
      { time: day, high: 21, low: 18, close: 18, volume: 2 },
    ])
    expect(points).toEqual([
      { time: day - 60, value: 10 },
      { time: day, value: 19 },
    ])
  })

  it('computes Wilder RSI and 50 on a flat series', () => {
    expect(rsi(candles, 3).at(-1)!.value).toBeGreaterThan(50)
    const flat = candles.map((candle) => ({ ...candle, close: 10 }))
    expect(rsi(flat, 3)[0]!.value).toBe(50)
  })

  it('folds candles into a coarser timeframe', () => {
    expect(aggregate(candles, 180)).toEqual([
      { time: 0, open: 9, high: 13, low: 8, close: 12, volume: 6 },
      { time: 180, open: 10, high: 15, low: 9, close: 14, volume: 15 },
    ])
  })
})

describe('valueArea', () => {
  it('holds 70 % of the volume around the busiest price', () => {
    const candles = [
      { time: 0, high: 101, low: 99, close: 100, volume: 800 },
      { time: 60, high: 110, low: 90, close: 100, volume: 100 },
      { time: 120, high: 100.5, low: 99.5, close: 100, volume: 100 },
    ]
    const area = valueArea(candles, 40)!
    expect(area.poc).toBeGreaterThan(99)
    expect(area.poc).toBeLessThan(101)
    expect(area.val).toBeGreaterThanOrEqual(98)
    expect(area.vah).toBeLessThanOrEqual(102)
  })
  it('uses only the day before for each candle', () => {
    const day = 86_400
    const candles = [
      { time: 0, high: 101, low: 99, close: 100, volume: 10 },
      { time: day, high: 200, low: 199, close: 200, volume: 10 },
    ]
    const area = priorDayValueArea(candles)
    expect(area.vah).toHaveLength(1)
    expect(area.vah[0]!.time).toBe(day)
    expect(area.vah[0]!.value).toBeLessThan(110)
  })
  it('draws the levels of the source candles on the target candles', () => {
    const day = 86_400
    const source = [
      { time: 0, high: 110, low: 90, close: 100, volume: 10 },
      { time: day, high: 105, low: 95, close: 100, volume: 10 },
    ]
    const target = [
      { time: day + 60, high: 101, low: 99, close: 100, volume: 1 },
      { time: day + 120, high: 101, low: 99, close: 100, volume: 1 },
    ]
    const area = priorDayValueArea(source, target)
    expect(area.vah.map((point) => point.time)).toEqual([day + 60, day + 120])
  })
  it('gives nothing for a flat or empty range', () => {
    expect(valueArea([])).toBeNull()
  })
})

describe('volumeProfile', () => {
  it('returns the bins with the traded volume and a value area inside them', () => {
    const profile = volumeProfile(
      [
        { time: 0, high: 101, low: 99, close: 100, volume: 800 },
        { time: 60, high: 110, low: 90, close: 100, volume: 200 },
      ],
      20,
    )!
    const total = profile.bins.reduce((sum, bin) => sum + bin.volume, 0)
    expect(total).toBeCloseTo(1000)
    expect(profile.val).toBeLessThanOrEqual(profile.poc)
    expect(profile.vah).toBeGreaterThanOrEqual(profile.poc)
  })
})
