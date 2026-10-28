import { describe, expect, it } from 'vitest'
import { tradePotential, type PotentialCandle } from './trade-potential.ts'

const candle = (
  time_ms: number,
  open: number,
  high: number,
  low: number,
): PotentialCandle => ({
  time_ms,
  open: String(open),
  high: String(high),
  low: String(low),
  close: String(open),
})

describe('tradePotential', () => {
  it('says long when the best move was up, net of costs', () => {
    const candles = [
      candle(0, 100, 100, 100),
      candle(60, 100, 101, 99.9),
      candle(120, 101, 102, 100.5),
    ]
    const result = tradePotential(candles, {
      entryMs: 0,
      exitMs: 100,
      entryPrice: 100,
    })
    expect(result.right).toBe(1)
    expect(result.bestAtMs).toBe(120)
    expect(Math.round(result.best)).toBe(190)
  })

  it('says short when the price fell the most', () => {
    const candles = [candle(0, 100, 100, 100), candle(60, 100, 100.1, 98)]
    const result = tradePotential(candles, {
      entryMs: 0,
      exitMs: 60,
      entryPrice: 100,
    })
    expect(result.right).toBe(-1)
    expect(result.bestAtMs).toBe(60)
  })

  it('says wait when the move would not pay the costs', () => {
    const candles = [
      candle(0, 100, 100.1, 99.9),
      candle(60, 100, 100.12, 99.95),
    ]
    const result = tradePotential(candles, {
      entryMs: 0,
      exitMs: 60,
      entryPrice: 100,
    })
    expect(result.right).toBe(0)
    expect(result.bestAtMs).toBeNull()
    expect(result.best).toBeCloseTo(2)
  })

  it('does not look further than a quarter of the hold past the exit', () => {
    const candles = [candle(0, 100, 100, 100), candle(1000, 100, 150, 100)]
    const result = tradePotential(candles, {
      entryMs: 0,
      exitMs: 100,
      entryPrice: 100,
    })
    expect(result.right).toBe(0)
  })

  it('has nothing to say without candles', () => {
    expect(
      tradePotential([], { entryMs: 0, exitMs: 10, entryPrice: 1 }).right,
    ).toBe(0)
  })
})
