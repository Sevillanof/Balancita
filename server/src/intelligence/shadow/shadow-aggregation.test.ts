import { describe, expect, it } from 'vitest'
import type { ForecastOutcome, ForecastRecord } from '../contracts.ts'
import {
  buildShadowMetrics,
  derivedShadowRegime,
  REGIME_THRESHOLD_RATIO,
  shadowAggregationFor,
} from '../shadow/shadow-aggregation.ts'
import {
  makeForecast,
  makeOutcome,
  makeNewsReference,
} from '../shadow/shadow-fixtures.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 100_000_000_000

function windowedFixture(): {
  forecast: ForecastRecord
  evaluated: ForecastRecord
  outcome: ForecastOutcome
} {
  const forecast = makeForecast({
    id: 'windowed-active',
    asOfTimestamp: NOW - 60_000,
  })
  const evaluated = makeForecast({
    id: 'windowed-evaluated',
    asOfTimestamp: NOW - (2 * DAY + 60_000),
    clockInverted: true,
    stale: true,
    gapCount: 1,
    atrRatio: 0.03,
    newsEvidenceReferences: [makeNewsReference()],
  })
  const outcome = makeOutcome(evaluated)
  return { forecast, evaluated, outcome }
}

describe('shadowAggregationFor input validation', () => {
  it('throws when set versions exceed the policy versions', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    expect(() =>
      shadowAggregationFor({
        run: {
          plannedEndAt: NOW + DAY,
          versions: { aggregationRuleVersion: 'shadow-aggregation.v2' },
        },
        inputs: {
          forecasts: [forecast, evaluated],
          outcomes: [outcome],
          asOfTimestamp: NOW,
          now: NOW,
          storedNewsEvidenceCount: 1,
        },
      }),
    ).toThrowError(/aggregation rule/i)
  })

  it('rejects look-ahead/duplicate outcomes by re-filtering against asOf + horizon', () => {
    const forecast = makeForecast({
      id: 'in-window',
      asOfTimestamp: NOW - 60_000,
    })
    const outcome = makeOutcome(forecast)
    const later = makeForecast({
      id: 'not-yet',
      asOfTimestamp: NOW - 3_600_000,
    })
    const lateOutcome = makeOutcome(later, { evaluatedAt: NOW + 1 })
    const result = shadowAggregationFor({
      run: {
        plannedEndAt: NOW + DAY,
        versions: { aggregationRuleVersion: 'shadow-aggregation.v1' },
      },
      inputs: {
        forecasts: [forecast, later],
        outcomes: [outcome, lateOutcome],
        asOfTimestamp: NOW,
        now: NOW,
        storedNewsEvidenceCount: 0,
      },
    })
    expect(result.outcomes.outcomeCount).toBe(1)
    expect(result.outcomes.outcomeForecastIds).toEqual([
      `${later.id}:${later.version}`,
    ])
    expect(result.coverage.evaluatedOutcomeCount).toBe(1)
  })

  it('throws when -infinity or NaN returns leak into outcomes', () => {
    const forecast = makeForecast({ id: 'nan', asOfTimestamp: NOW - 60_000 })
    const outcome = makeOutcome(forecast, { realizedReturn: -Infinity })
    expect(() =>
      shadowAggregationFor({
        run: {
          plannedEndAt: NOW + DAY,
          versions: { aggregationRuleVersion: 'shadow-aggregation.v1' },
        },
        inputs: {
          forecasts: [forecast],
          outcomes: [{ ...outcome }],
          asOfTimestamp: NOW,
          now: NOW,
          storedNewsEvidenceCount: 0,
        },
      }),
    ).toThrowError(/finite|infinity|NaN/i)
  })
})

describe('buildShadowMetrics', () => {
  it('computes neutral-baseline comparison metrics for technical signals', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const metrics = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 1)
    expect(metrics.coverage.forecastCount).toBe(2)
    expect(metrics.coverage.evaluatedOutcomeCount).toBe(1)
    expect(metrics.comparative.computedAt).toBe(NOW)
    expect(metrics.comparative.technical.signals).toBe(1)
    expect(metrics.comparative.technical.agreement).toBe(1)
    expect(metrics.comparative.news.available).toBe(false)
    expect(metrics.comparative.baseline).toEqual({
      ruleVersion: 'shadow-baseline.v1',
      parameters: { thresholdRatio: REGIME_THRESHOLD_RATIO },
    })
  })

  it('reports news metrics as unavailable when news evidence is not persisted', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const metrics = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 0)
    expect(metrics.news).toEqual({
      available: false,
      unavailableReason: 'news_scores_not_persisted',
      evidenceCount: 0,
    })
    expect(metrics.comparative.news.available).toBe(false)
    expect(metrics.comparative.news.explained).toBe(false)
  })

  it('segments comparative metrics per regime derived from atr ratio', () => {
    const already = makeForecast({
      id: 'high-vol',
      asOfTimestamp: NOW - (2 * DAY + 60_000),
      atrRatio: 0.03,
    })
    const outcome = makeOutcome(already)
    const low = makeForecast({
      id: 'low-vol',
      asOfTimestamp: NOW - (2 * DAY + 60_000),
      atrRatio: 0.005,
      probabilityUp: 0.5,
    })
    const lowOutcome = makeOutcome(low, { label: 'flat', observedPrice: 100 })
    const metrics = buildShadowMetrics(
      [already, low],
      [outcome, lowOutcome],
      NOW,
      0,
    )
    expect(derivedShadowRegime(already)).toBe('high_volatility')
    expect(derivedShadowRegime(low)).toBe('low_volatility')
    const segments = metrics.segments.perRegime
    expect(Object.keys(segments)).toEqual(
      expect.arrayContaining(['1h:high_volatility', '1h:low_volatility']),
    )
    expect(segments['1h:high_volatility'].forecastCount).toBe(1)
    expect(segments['1h:high_volatility'].evaluatedOutcomeCount).toBe(1)
    expect(segments['1h:low_volatility'].evaluatedOutcomeCount).toBe(1)
    expect(metrics.segments.all).toBeDefined()
  })

  it('includes per-horizon segment metrics', () => {
    const evaluated = makeForecast({
      id: '2d-evaluated',
      asOfTimestamp: NOW - (2 * DAY + 60_000),
    })
    const outcome = makeOutcome(evaluated)
    const horizonMetrics = buildShadowMetrics([evaluated], [outcome], NOW, 0)
      .segments.perHorizon['1h']
    expect(horizonMetrics).toBeDefined()
    expect(horizonMetrics.evaluatedOutcomeCount).toBe(1)
    expect(horizonMetrics.forecastCount).toBe(1)
  })

  it('reports missingness with due and evaluated counts', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const missing = makeForecast({
      id: 'due-without-outcome',
      asOfTimestamp: NOW - 2 * DAY,
    })
    const metrics = buildShadowMetrics(
      [forecast, evaluated, missing],
      [outcome],
      NOW,
      0,
    )
    expect(metrics.missingness).toEqual({
      dueForecastCount: 2,
      evaluatedForecastCount: 1,
      missingOutcomeCount: 1,
    })
  })

  it('reports freshness metrics including stale rate and gap rate', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const metrics = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 0)
    expect(metrics.freshness.forecastCount).toBe(2)
    expect(metrics.freshness.staleRate).toBe(0.5)
    expect(metrics.freshness.gapRate).toBeGreaterThan(0)
    expect(metrics.freshness.gapRate).toBeLessThanOrEqual(1)
    expect(metrics.freshness.maxFreshnessAgeMs).toBe(5_000_000)
  })

  it('computes consistent comparisons with the neutral dashboard baseline', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const metrics = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 1)
    expect(metrics.comparative.technical).toBeDefined()
    expect(metrics.comparative.technical.disagreement).toBeDefined()
    expect(metrics.comparative.technical.callRate).toBeDefined()
    expect(metrics.comparative.baseline.ruleVersion).toBe('shadow-baseline.v1')
    expect(JSON.stringify(metrics.comparative.technical)).not.toContain('NaN')
  })

  it('returns deterministic output for identical inputs', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const a = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 1)
    const b = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 1)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not mutate its inputs', () => {
    const forecast = makeForecast({
      id: 'immutable-a',
      asOfTimestamp: NOW - 60_000,
    })
    const evaluated = makeForecast({
      id: 'immutable-b',
      asOfTimestamp: NOW - (2 * DAY + 60_000),
    })
    const forecasts = [forecast, evaluated]
    const outcomes = [makeOutcome(evaluated)]
    const beforeForecasts = structuredClone(forecasts)
    const beforeOutcomes = structuredClone(outcomes)
    buildShadowMetrics(forecasts, outcomes, NOW, 0)
    expect(forecasts).toEqual(beforeForecasts)
    expect(outcomes).toEqual(beforeOutcomes)
  })

  it('detects stale signals consistently with the dashboard reducer', () => {
    const { forecast, evaluated, outcome } = windowedFixture()
    const metrics = buildShadowMetrics([forecast, evaluated], [outcome], NOW, 0)
    expect(metrics.technical.staleCount).toBe(1)
    expect(metrics.technical.realtimeCount).toBe(1)
  })
})
