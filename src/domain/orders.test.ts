import { describe, expect, it } from 'vitest'
import { moneyFromString } from './money'
import {
  DEFAULT_ORDER_SIMULATOR_CONFIG,
  averageCostAfterBuy,
  driftWithinTolerance,
  estimatePreview,
} from './orders'

describe('order preview projection', () => {
  it('projects a zero-cost market buy with no slippage or commission', () => {
    const projection = estimatePreview(
      'buy',
      moneyFromString('0.5'),
      moneyFromString('60000'),
      moneyFromString('0'),
      moneyFromString('0'),
    )
    expect(projection.slippedPrice).toEqual(moneyFromString('60000'))
    expect(projection.slippageApplied).toEqual(moneyFromString('0'))
    expect(projection.commission).toEqual(moneyFromString('0'))
    expect(projection.subtotal).toEqual(moneyFromString('30000'))
    expect(projection.estimatedTotal).toEqual(moneyFromString('30000'))
  })

  it('adds slippage asymmetrically: buys pay more, sells receive less', () => {
    const slippage = moneyFromString('0.001')
    const commission = moneyFromString('0')
    const buy = estimatePreview(
      'buy',
      moneyFromString('0.5'),
      moneyFromString('60000'),
      slippage,
      commission,
    )
    expect(buy.slippedPrice).toEqual(moneyFromString('60060'))
    expect(buy.slippageApplied).toEqual(slippage)
    expect(buy.estimatedTotal).toEqual(moneyFromString('30030'))

    const sell = estimatePreview(
      'sell',
      moneyFromString('0.5'),
      moneyFromString('60000'),
      slippage,
      commission,
    )
    expect(sell.slippedPrice).toEqual(moneyFromString('59940'))
    expect(sell.estimatedTotal).toEqual(moneyFromString('29970'))
  })

  it('adds a flat commission on buys and subtracts it on sells', () => {
    const buy = estimatePreview(
      'buy',
      moneyFromString('0.5'),
      moneyFromString('60000'),
      moneyFromString('0'),
      moneyFromString('0.5'),
    )
    expect(buy.subtotal).toEqual(moneyFromString('30000'))
    expect(buy.estimatedTotal).toEqual(moneyFromString('30000.5'))

    const sell = estimatePreview(
      'sell',
      moneyFromString('0.5'),
      moneyFromString('60000'),
      moneyFromString('0'),
      moneyFromString('0.5'),
    )
    expect(sell.estimatedTotal).toEqual(moneyFromString('29999.5'))
  })

  it('keeps decimal precision in float-trap scenarios', () => {
    const projection = estimatePreview(
      'buy',
      moneyFromString('0.1'),
      moneyFromString('151.25'),
      moneyFromString('0'),
      moneyFromString('0'),
    )
    expect(projection.slippedPrice).toEqual(moneyFromString('151.25'))
    expect(projection.estimatedTotal).toEqual(moneyFromString('15.125'))
  })
})

describe('average cost after buy', () => {
  it('seeds a fresh position with the outlay basis', () => {
    const position = averageCostAfterBuy(
      null,
      moneyFromString('0.5'),
      moneyFromString('30000.5'),
    )
    expect(position.quantity).toEqual(moneyFromString('0.5'))
    expect(position.averageCost).toEqual(moneyFromString('60001'))
  })

  it('weights the average cost across existing and new quantity', () => {
    const position = averageCostAfterBuy(
      {
        quantity: moneyFromString('0.5'),
        averageCost: moneyFromString('50000'),
      },
      moneyFromString('0.5'),
      moneyFromString('27125'),
    )
    expect(position.quantity).toEqual(moneyFromString('1'))
    expect(position.averageCost).toEqual(moneyFromString('52125'))
  })

  it('keeps exact decimal math across uneven quantities', () => {
    const position = averageCostAfterBuy(
      {
        quantity: moneyFromString('0.1'),
        averageCost: moneyFromString('0.2'),
      },
      moneyFromString('0.1'),
      moneyFromString('0.02'),
    )
    expect(position.quantity).toEqual(moneyFromString('0.2'))
    expect(position.averageCost).toEqual(moneyFromString('0.2'))
  })
})

describe('preview drift tolerance', () => {
  const tolerance = moneyFromString('0.005')

  it('accepts prices within the tolerance', () => {
    expect(
      driftWithinTolerance(
        moneyFromString('60000'),
        moneyFromString('60250'),
        tolerance,
      ),
    ).toBe(true)
    expect(
      driftWithinTolerance(
        moneyFromString('60000'),
        moneyFromString('59750'),
        tolerance,
      ),
    ).toBe(true)
  })

  it('accepts prices exactly at the tolerance boundary', () => {
    expect(
      driftWithinTolerance(
        moneyFromString('60000'),
        moneyFromString('60300'),
        tolerance,
      ),
    ).toBe(true)
  })

  it('rejects prices beyond the tolerance', () => {
    expect(
      driftWithinTolerance(
        moneyFromString('60000'),
        moneyFromString('60400'),
        tolerance,
      ),
    ).toBe(false)
  })
})

describe('order simulator config defaults', () => {
  it('documents zero slippage, zero commission and a 0.5% tolerance', () => {
    expect(DEFAULT_ORDER_SIMULATOR_CONFIG).toEqual({
      slippage: 0,
      commission: 0,
      previewTolerance: 0.005,
      initialCash: { EUR: 10_000, USD: 10_000 },
    })
  })
})
