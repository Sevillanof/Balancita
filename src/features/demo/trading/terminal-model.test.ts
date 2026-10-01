import { describe, expect, it } from 'vitest'
import { bucketForEvent, resampleCandles } from './terminal-model.ts'
import type { DemoCandle } from './types.ts'

const candles: DemoCandle[] = Array.from({ length: 60 }, (_, index) => ({
  time: 1_800_000_000 + index * 60,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: index + 1,
}))

describe('terminal interval model', () => {
  it('resamples the same minute history into coherent chart candles', () => {
    const candles15m = resampleCandles(candles, 900)
    expect(candles15m).toHaveLength(4)
    expect(candles15m[0]).toEqual({
      time: candles[0]!.time,
      open: candles[0]!.open,
      high: candles[14]!.high,
      low: candles[0]!.low,
      close: candles[14]!.close,
      volume: candles
        .slice(0, 15)
        .reduce((sum, candle) => sum + candle.volume, 0),
    })
  })

  it('maps exact event times to interval buckets without altering event identity', () => {
    const eventTime = candles[16]!.time + 12
    expect(bucketForEvent(eventTime, 900)).toBe(candles[15]!.time)
    expect(eventTime).not.toBe(bucketForEvent(eventTime, 900))
  })

  it('keeps the latest incomplete candle visible for longer intervals', () => {
    expect(resampleCandles(candles.slice(0, 30), 3600)).toHaveLength(1)
  })
})
