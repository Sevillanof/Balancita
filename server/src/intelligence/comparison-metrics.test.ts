import { describe, expect, it } from 'vitest'
import {
  calculateComparativeMetrics,
  type ComparativeMetricEntry,
  type EvaluatedSignal,
} from './comparison-metrics.ts'

const signal = (
  probabilityUp: number,
  probabilityDown: number,
  probabilityFlat: number,
  expectedReturn?: number,
): EvaluatedSignal => ({
  status: 'scored',
  probabilities: { probabilityUp, probabilityDown, probabilityFlat },
  ...(expectedReturn === undefined ? {} : { expectedReturn }),
})

const abstain = (): EvaluatedSignal => ({
  status: 'abstain',
  abstentionReasons: ['uncertain_evidence'],
})

const entries: readonly ComparativeMetricEntry[] = [
  {
    horizon: '1h',
    regime: 'low',
    technical: signal(0.8, 0.1, 0.1, 0.08),
    news: signal(0.3, 0.4, 0.3, 0),
    outcome: { label: 'up', realizedReturn: 0.1 },
  },
  {
    horizon: '1h',
    regime: 'low',
    technical: signal(0.2, 0.7, 0.1, -0.04),
    news: signal(0.7, 0.2, 0.1, 0.02),
    outcome: { label: 'down', realizedReturn: -0.05 },
  },
  {
    horizon: '4h',
    regime: 'high',
    technical: abstain(),
    news: null,
    outcome: { label: 'flat', realizedReturn: 0 },
  },
]

describe('phase G comparative metrics', () => {
  it('calculates source coverage, known probabilistic metrics and neutral deltas', () => {
    const report = calculateComparativeMetrics(entries)

    expect(report).toMatchObject({
      version: 'comparison-metrics.v1',
      ruleVersion: 'neutral-baseline.v1',
      coverage: {
        total: 3,
        agreement: 0,
        disagreement: 2,
        abstention: 1,
      },
      sources: {
        technical: {
          coverage: { total: 3, issued: 2, abstained: 1 },
          brierScore: 0.1,
          directionalAccuracy: 1,
        },
        news: {
          coverage: { total: 3, issued: 2, abstained: 1 },
          brierScore: 0.94,
          directionalAccuracy: 0,
        },
      },
      baselineNeutral: {
        coverage: { total: 3, issued: 3, abstained: 0, coverage: 1 },
      },
    })
    expect(report.sources.technical.brierScore).toBeCloseTo(0.1, 12)
    expect(report.sources.technical.returnMae).toBeCloseTo(0.015, 12)
    expect(
      report.sources.technical.incrementalVsNeutral.brierScoreDelta,
    ).toBeCloseTo(0.1 - 2 / 3, 12)
    expect(report.sources.news.logLoss).toBeCloseTo(
      (-Math.log(0.3) - Math.log(0.2)) / 2,
      12,
    )
    expect(report.sources.technical.calibration).toHaveLength(3)
    expect(report.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('segments agreement and source metrics by horizon and regime without reordering entries', () => {
    const report = calculateComparativeMetrics(entries)

    expect(report.segments.map((segment) => segment.key)).toEqual([
      '1h:low',
      '4h:high',
    ])
    expect(report.segments[0]).toMatchObject({
      horizon: '1h',
      regime: 'low',
      coverage: { agreement: 0, disagreement: 2, abstention: 0 },
    })
    expect(report.segments[1]).toMatchObject({
      horizon: '4h',
      regime: 'high',
      coverage: { agreement: 0, disagreement: 0, abstention: 1 },
      sources: {
        technical: { brierScore: null },
        news: { brierScore: null },
      },
    })
  })

  it('returns null aggregates for empty data and rejects invalid scored probabilities', () => {
    const empty = calculateComparativeMetrics([])
    expect(empty.sources.technical.coverage).toEqual({
      total: 0,
      issued: 0,
      abstained: 0,
      coverage: null,
      abstentionRate: null,
    })
    expect(empty.sources.technical.brierScore).toBeNull()
    expect(empty.baselineNeutral.logLoss).toBeNull()
    expect(() =>
      calculateComparativeMetrics([
        {
          horizon: '1h',
          technical: signal(0.8, 0.8, 0),
          news: null,
          outcome: { label: 'up', realizedReturn: 0 },
        },
      ]),
    ).toThrow(/probabilities/i)
  })

  it('does not claim profitability or causality and supports MAE only when a source supplied an expected return', () => {
    const report = calculateComparativeMetrics(entries)
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/descriptive/i),
        expect.stringMatching(/causal/i),
        expect.stringMatching(/profit/i),
        expect.stringMatching(/random/i),
      ]),
    )
    expect(report.sources.news.returnMae).toBe(0.085)
  })
})
