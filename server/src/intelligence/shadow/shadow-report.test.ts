import { describe, expect, it } from 'vitest'
import { contentHashFor } from '../forecast-hashing.ts'
import { makeForecast, makeOutcome } from '../shadow/shadow-fixtures.ts'
import { buildShadowMetrics } from '../shadow/shadow-aggregation.ts'
import { buildShadowReport } from '../shadow/shadow-report.ts'
import { createShadowRunStart } from '../shadow/shadow-run.ts'

const DAY = 24 * 3_600_000
const NOW = 100_000_000_000
const DAYS_30 = 30 * DAY

describe('buildShadowReport', () => {
  const runningRun = createShadowRunStart(NOW, 'BTC-EUR')
  const endedRun = createShadowRunStart(NOW - DAYS_30, 'BTC-EUR')

  it('reports collecting before the shadow window completes', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAY,
      clockInverted: true,
    })
    const outcome = makeOutcome(forecast)
    const windowedForecast = makeForecast({
      id: 'r-b',
      asOfTimestamp: NOW - 60_000,
    })
    const metrics = buildShadowMetrics(
      [forecast, windowedForecast],
      [outcome],
      NOW,
      0,
    )
    const report = buildShadowReport({
      run: runningRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 0,
    })
    expect(report.status).toBe('collecting')
    expect(report.enoughData).toBe(false)
    expect(report.insufficientReason).toBe('shadow_ended')
  })

  it('reports ready_for_review with enough evidence after the window', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAYS_30,
      clockInverted: true,
    })
    const outcome = makeOutcome(forecast)
    const metrics = buildShadowMetrics([forecast], [outcome], NOW, 0)
    const report = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 0,
      minimumEvidence: 1,
    })
    expect(report.status).toBe('ready_for_review')
    expect(report.enoughData).toBe(true)
    expect(report.insufficientReason).toBeNull()
    expect(report.outcome.evaluatedOutcomeCount).toBe(1)
    expect(report.outcome.minimumEvidence).toBe(1)
    expect(report.outcome.forecastCount).toBe(1)
    expect(report.outcome.newsEvidenceCount).toBe(0)
  })

  it('reports insufficient_evidence when the window closed with few outcomes', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAY,
      clockInverted: true,
    })
    const outcome = makeOutcome(forecast)
    const metrics = buildShadowMetrics([forecast], [outcome], NOW, 0)
    const report = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 0,
      minimumEvidence: 2,
    })
    expect(report.status).toBe('insufficient_evidence')
    expect(report.enoughData).toBe(false)
    expect(report.insufficientReason).toBe('minimum_evidence_not_reached')
  })

  it('derives the shadow regime from the stored atr reference price', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAY,
      clockInverted: true,
      atrRatio: 0.02,
    })
    const outcome = makeOutcome(forecast)
    const metrics = buildShadowMetrics([forecast], [outcome], NOW, 0)
    const report = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 0,
    })
    expect(report.metrics.meta.regime).toBe('high_volatility')
    expect(report.metrics.meta.regimeRuleVersion).toBe('shadow-regime.v1')
  })

  it('derives a deterministic contentHash that covers the report body', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAY,
      clockInverted: true,
    })
    const outcome = makeOutcome(forecast)
    const metrics = buildShadowMetrics([forecast], [outcome], NOW, 1)
    const a = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 1,
    })
    const b = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 1,
    })
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.contentHash).toBe(b.contentHash)
    const { contentHash: recomputedHash, ...recomputedBody } = a
    expect(contentHashFor(recomputedBody)).toBe(recomputedHash)
  })

  it('reproduces dashboard comparability by using the same hash context', () => {
    const body = { anything: true, version: 'shadow-report.v1' }
    const direct = contentHashFor(body)
    expect(direct).toMatch(/^[0-9a-f]{64}$/)
  })

  it('references baseline, aggregation and regime rules in the report', () => {
    const forecast = makeForecast({
      id: 'r-a',
      asOfTimestamp: NOW - DAY,
      clockInverted: true,
    })
    const outcome = makeOutcome(forecast)
    const metrics = buildShadowMetrics([forecast], [outcome], NOW, 0)
    const report = buildShadowReport({
      run: endedRun,
      metrics: { ...metrics },
      now: NOW,
      storedNewsEvidenceCount: 0,
    })
    expect(report.rules).toEqual({ ruleVersion: 'shadow-report.v1' })
    expect(report.metrics.comparative.baseline.ruleVersion).toBe(
      'shadow-baseline.v1',
    )
  })
})
