import { describe, expect, it } from 'vitest'
import {
  aggregate,
  bollinger,
  donchian,
  ema,
  rsi,
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
