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
