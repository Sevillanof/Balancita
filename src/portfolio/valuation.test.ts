import { describe, expect, it } from 'vitest'
import { MONEY_ZERO, moneyFromString, moneyToNumber } from '../domain/money'
import type { Holding } from '../domain/portfolio'
import { costOf, profitLossOf, profitLossPercentOf, valueOf } from './valuation'

const holding: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: moneyFromString('2'),
  averageCost: moneyFromString('51000'),
}

describe('portfolio valuation', () => {
  it('computes the cost basis as quantity times average cost', () => {
    expect(costOf(holding)).toEqual(moneyFromString('102000'))
  })

  it('computes the current value as quantity times price', () => {
    expect(valueOf(holding, moneyFromString('54250'))).toEqual(
      moneyFromString('108500'),
    )
  })

  it('computes profit and loss as value minus cost', () => {
    expect(profitLossOf(holding, moneyFromString('54250'))).toEqual(
      moneyFromString('6500'),
    )
    expect(profitLossOf(holding, moneyFromString('49000'))).toEqual(
      moneyFromString('-4000'),
    )
  })

  it('computes percentage profit and loss relative to cost', () => {
    const gain =
      (moneyToNumber(profitLossOf(holding, moneyFromString('54250'))) /
        moneyToNumber(costOf(holding))) *
      100
    expect(
      moneyToNumber(profitLossPercentOf(holding, moneyFromString('54250'))),
    ).toBeCloseTo(gain, 6)
    const loss =
      (moneyToNumber(profitLossOf(holding, moneyFromString('49000'))) /
        moneyToNumber(costOf(holding))) *
      100
    expect(
      moneyToNumber(profitLossPercentOf(holding, moneyFromString('49000'))),
    ).toBeCloseTo(loss, 6)
  })

  it('returns zero percentage when the position has no cost', () => {
    const freeHolding: Holding = { ...holding, averageCost: MONEY_ZERO }
    expect(profitLossPercentOf(freeHolding, moneyFromString('10'))).toEqual(
      MONEY_ZERO,
    )
    expect(costOf(freeHolding)).toEqual(MONEY_ZERO)
  })
})
