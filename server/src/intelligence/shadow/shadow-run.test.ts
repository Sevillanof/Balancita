import { describe, expect, it } from 'vitest'
import type { SupportedInstrumentId } from '../contracts.ts'
import {
  createShadowRunStart,
  defaultShadowRunStart,
  SHADOW_DURATION_MS,
} from '../shadow/shadow-run.ts'

describe('createShadowRunStart', () => {
  it('creates a run start with a default 30-day planned end', () => {
    const startedAt = 1_700_000_000_000
    const start = createShadowRunStart(startedAt, 'BTC-EUR')
    expect(start.id).toBe('shadow:BTC-EUR')
    expect(start.instrumentId).toBe('BTC-EUR')
    expect(start.startedAt).toBe(startedAt)
    expect(start.plannedEndAt).toBe(startedAt + SHADOW_DURATION_MS)
    expect(start.status).toBe('collecting')
    expect(start.versions.policyVersion).toBe('shadow-policy.v1')
    expect(start.versions.aggregationRuleVersion).toBe('shadow-aggregation.v1')
    expect(start.versions.baselineRuleVersion).toBe('shadow-baseline.v1')
    expect(start.versions.regimeRuleVersion).toBe('shadow-regime.v1')
    expect(start.versions.reportVersion).toBe('shadow-report.v1')
    expect(start.versions.decisionVersion).toBe('shadow-decision.v1')
    expect(start.sourceConstraints.realtimeOnly).toBe(true)
    expect(start.sourceConstraints.technicalFreshnessToleranceMs).toBe(60_000)
    expect(start.sourceConstraints).toHaveProperty('newsScoresNotPersisted')
    expect(start.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives a deterministic content hash that changes when fields change', () => {
    const a = createShadowRunStart(1_700_000_000_000, 'BTC-EUR')
    const b = createShadowRunStart(1_700_000_000_001, 'BTC-EUR')
    const c = createShadowRunStart(
      1_700_000_000_000,
      'XBT-EUR' as SupportedInstrumentId,
    )
    expect(a.contentHash).toBe(a.contentHash)
    expect(b.contentHash).not.toBe(a.contentHash)
    expect(c.contentHash).not.toBe(a.contentHash)
  })

  it('reproduces the same run description across recreations', () => {
    const a = defaultShadowRunStart(1_700_000_000_000, 'BTC-EUR')
    const b = defaultShadowRunStart(1_700_000_000_000, 'BTC-EUR')
    expect(a).toEqual(b)
  })

  it('keeps status collecting and prohibits manual decisions in the schema', () => {
    const start = createShadowRunStart(1_700_000_000_000, 'BTC-EUR')
    expect(start.status).toBe('collecting')
    expect(start).not.toHaveProperty('decision')
    expect(start).not.toHaveProperty('setUpstream')
    expect(start).not.toHaveProperty('upstreamEnabledFrom')
  })
})
