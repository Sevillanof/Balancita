import { describe, expect, it } from 'vitest'
import { isApprovedAnalysis } from './terminal-approved.ts'

describe('isApprovedAnalysis', () => {
  it('hides every engine verdict while no strategy is approved', () => {
    expect(
      isApprovedAnalysis({ selected_strategy_id: 'c25-pullback-perp-v1' }),
    ).toBe(false)
    expect(
      isApprovedAnalysis({ selector: { strategy_id: 'c27-breakout-perp-v1' } }),
    ).toBe(false)
    expect(isApprovedAnalysis({ selected_strategy_id: null })).toBe(false)
    expect(isApprovedAnalysis(null)).toBe(false)
  })
})

describe('approvedChartData', () => {
  it('drops other strategies and their fills, keeps Qwen and unattributed rows', async () => {
    const { approvedChartData } = await import('./terminal-approved.ts')
    const { QWEN_STRATEGY_ID } = await import('./useQwenDecisions.ts')
    const out = approvedChartData({
      orders: [
        { order_id: 'a', strategy_id: 'C27' },
        { order_id: 'b', strategy_id: QWEN_STRATEGY_ID },
        { order_id: 'c' },
      ],
      fills: [{ order_id: 'a' }, { order_id: 'b' }, { order_id: 'c' }],
      positions: [{ strategy_id: 'C25' }, { strategy_id: QWEN_STRATEGY_ID }],
      position: { strategy_id: 'C27' },
    })
    expect(out.orders.map((o) => (o as { order_id: string }).order_id)).toEqual(
      ['b', 'c'],
    )
    expect(out.fills).toEqual([{ order_id: 'b' }, { order_id: 'c' }])
    expect(out.positions).toHaveLength(1)
    expect(out.position).toEqual({})
  })
})
