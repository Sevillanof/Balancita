import { describe, expect, it } from 'vitest'
import { assessBacktestReadiness } from './backtest-readiness.ts'

describe('backtest evidence gate', () => {
  const complete = {
    tradeCount: 500,
    windowDays: 730,
    profitFactor: 1.5,
    maxDrawdownPct: 10,
    commissionRate: 0.001,
    regimeCoverage: 'bull_bear_sideways' as const,
  }
  it('reports missing evidence independently even for profitable short runs', () => {
    const result = assessBacktestReadiness({
      ...complete,
      tradeCount: 5,
      windowDays: 1,
      regimeCoverage: 'not_evaluated',
    })
    expect(result.status).toBe('insufficient')
    expect(result.reasons).toHaveLength(3)
  })
  it('treats 1.3 PF and 20% drawdown as failures, and undefined PF as unknown', () => {
    expect(
      assessBacktestReadiness({
        ...complete,
        profitFactor: 1.3,
        maxDrawdownPct: 20,
      }).reasons,
    ).toHaveLength(2)
    expect(
      assessBacktestReadiness({ ...complete, profitFactor: null }).status,
    ).toBe('insufficient')
  })
  it('marks adequate historical evidence as review, never permission to trade', () => {
    expect(assessBacktestReadiness(complete).status).toBe('review')
  })
})
