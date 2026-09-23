import { describe, expect, it } from 'vitest'
import { parseTimestampMs } from '../../domain/contracts.ts'
import {
  calculateGapRate,
  calculateReceiveLatency,
  calculateStaleRate,
  deriveDataFreshness,
  summarizeGapTransitions,
  summarizePercentiles,
  validateMetricWindow,
} from './slis.ts'

const time = (value: number) => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

describe('intelligence SLIs', () => {
  it('derives freshness from display minus event and uses a strict stale threshold', () => {
    expect(
      deriveDataFreshness({
        eventTime: time(1_000),
        displayTime: time(1_500),
        staleAfterMs: 500,
      }),
    ).toEqual({
      valid: true,
      value: { ageMs: 500, isStale: false, clockInverted: false },
    })

    expect(
      deriveDataFreshness({
        eventTime: time(1_000),
        displayTime: time(1_501),
        staleAfterMs: 500,
      }),
    ).toEqual({
      valid: true,
      value: { ageMs: 501, isStale: true, clockInverted: false },
    })
  })

  it('rejects or explicitly clamps inverted clocks according to policy', () => {
    const input = {
      eventTime: time(2_000),
      displayTime: time(1_000),
      staleAfterMs: 500,
    }
    const rejected = deriveDataFreshness(input)
    expect(rejected.valid).toBe(false)
    if (!rejected.valid) expect(rejected.issues[0]?.code).toBe('clock_inverted')

    expect(
      deriveDataFreshness({ ...input, clockSkewPolicy: 'clamp_to_zero' }),
    ).toEqual({
      valid: true,
      value: { ageMs: 0, isStale: false, clockInverted: true },
    })
  })

  it('calculates non-negative receive latency with the same clock policy', () => {
    expect(
      calculateReceiveLatency({
        eventTime: time(100),
        receivedTime: time(250),
      }),
    ).toEqual({ valid: true, value: 150 })
    expect(
      calculateReceiveLatency({
        eventTime: time(250),
        receivedTime: time(100),
      }),
    ).toMatchObject({ valid: false })
  })

  it('uses deterministic nearest-rank percentiles and handles empty and singleton windows', () => {
    expect(summarizePercentiles([10, 20, 30, 40])).toEqual({
      valid: true,
      value: { count: 4, p50: 20, p95: 40 },
    })
    expect(summarizePercentiles([])).toEqual({
      valid: true,
      value: { count: 0, p50: null, p95: null },
    })
    expect(summarizePercentiles([42])).toEqual({
      valid: true,
      value: { count: 1, p50: 42, p95: 42 },
    })
    expect(summarizePercentiles([1, Number.NaN])).toMatchObject({
      valid: false,
    })
  })

  it('uses stale snapshots as the denominator and returns null for no observations', () => {
    expect(calculateStaleRate([true, false, true, false])).toEqual({
      valid: true,
      value: { staleCount: 2, totalCount: 4, rate: 0.5 },
    })
    expect(calculateStaleRate([])).toEqual({
      valid: true,
      value: { staleCount: 0, totalCount: 0, rate: null },
    })
  })

  it('uses gap transitions divided by expected messages and reports absent sequences', () => {
    expect(
      calculateGapRate({ sequences: [10, 11, 14], expectedOpportunities: 4 }),
    ).toEqual({
      valid: true,
      value: {
        gapCount: 1,
        expectedOpportunities: 4,
        rate: 0.25,
        sequenceAvailable: true,
      },
    })
    expect(
      calculateGapRate({ sequences: [], expectedOpportunities: 0 }),
    ).toEqual({
      valid: true,
      value: {
        gapCount: 0,
        expectedOpportunities: 0,
        rate: null,
        sequenceAvailable: false,
      },
    })
    expect(
      calculateGapRate({ sequences: [10, 9], expectedOpportunities: 2 }),
    ).toMatchObject({ valid: false })
  })

  it('summarizes persisted collector gaps without treating ticker sequence jumps as gaps', () => {
    expect(
      summarizeGapTransitions({
        gapCount: 2,
        observedMessages: 8,
        sequenceAvailable: true,
      }),
    ).toEqual({
      valid: true,
      value: {
        gapCount: 2,
        expectedOpportunities: 10,
        rate: 0.2,
        sequenceAvailable: true,
      },
    })
  })

  it('validates finite non-negative metric windows and exact boundaries', () => {
    expect(validateMetricWindow({ start: time(100), end: time(100) })).toEqual({
      valid: true,
      value: { start: time(100), end: time(100) },
    })
    expect(
      validateMetricWindow({ start: time(101), end: time(100) }),
    ).toMatchObject({
      valid: false,
    })
    expect(
      validateMetricWindow({ start: time(0), end: time(100) }),
    ).toMatchObject({
      valid: true,
    })
  })
})
