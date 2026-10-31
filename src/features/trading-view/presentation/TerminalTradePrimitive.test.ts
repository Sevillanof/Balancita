import { describe, expect, it, vi } from 'vitest'
import type { Logical } from 'lightweight-charts'
import { TerminalTradePrimitive } from './TerminalTradePrimitive.ts'
import type { TerminalChartTrade } from '../domain/terminal-trade-model.ts'

const time = Date.UTC(2026, 9, 31) / 1000
const candles = Array.from({ length: 21 }, (_, i) => ({
  time: time + i * 60,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}))
const trade: TerminalChartTrade = {
  product: 'PF_ETHUSD',
  tradeNo: 2,
  side: 'SHORT',
  open: false,
  entryMs: time * 1000,
  exitMs: (time + 600) * 1000,
  entryPrice: 110,
  exitPrice: 120,
  markPrice: null,
  netUsd: -10,
  fundingComplete: true,
}

describe('recorded Terminal trade primitive', () => {
  it('includes the actual entry and recorded exit when their times are visible', () => {
    const primitive = new TerminalTradePrimitive(vi.fn())
    primitive.setData([trade], candles, 60)
    expect(primitive.autoscaleInfo(0 as Logical, 20 as Logical)).toEqual({
      priceRange: { minValue: 110, maxValue: 120 },
    })
  })

  it('does not compress the price scale for operations outside the visible period', () => {
    const primitive = new TerminalTradePrimitive(vi.fn())
    primitive.setData([trade], candles, 60)
    expect(primitive.autoscaleInfo(11 as Logical, 20 as Logical)).toBeNull()
    expect(primitive.autoscaleInfo(0 as Logical, 5 as Logical)).toEqual({
      priceRange: { minValue: 110, maxValue: 110 },
    })
    expect(primitive.paneViews()).toEqual([])
  })
})
