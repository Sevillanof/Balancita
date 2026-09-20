import { describe, expect, it } from 'vitest'
import type { Holding } from '../domain/portfolio'
import { costOf, profitLossOf, profitLossPercentOf, valueOf } from './valuation'

const holding: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: 2,
  averageCost: 51_000,
}

describe('portfolio valuation', () => {
  it('computes the cost basis as quantity times average cost', () => {
    expect(costOf(holding)).toBe(102_000)
  })

  it('computes the current value as quantity times price', () => {
    expect(valueOf(holding, 54_250)).toBe(108_500)
  })

  it('computes profit and loss as value minus cost', () => {
    expect(profitLossOf(holding, 54_250)).toBe(6_500)
    expect(profitLossOf(holding, 49_000)).toBe(-4_000)
  })

  it('computes percentage profit and loss relative to cost', () => {
    const gain = (profitLossOf(holding, 54_250) / costOf(holding)) * 100
    expect(profitLossPercentOf(holding, 54_250)).toBeCloseTo(gain, 10)
    const loss = (profitLossOf(holding, 49_000) / costOf(holding)) * 100
    expect(profitLossPercentOf(holding, 49_000)).toBeCloseTo(loss, 10)
  })

  it('returns zero percentage when the position has no cost', () => {
    const freeHolding: Holding = { ...holding, averageCost: 0 }
    expect(profitLossPercentOf(freeHolding, 10)).toBe(0)
    expect(costOf(freeHolding)).toBe(0)
  })
})
