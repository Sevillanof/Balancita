import { describe, expect, it } from 'vitest'
import {
  decisionStanding,
  latestDecision,
  type LatestDecision,
} from './latest-decision.ts'

describe('latestDecision', () => {
  it('ignores an analysis whose origin is not the engine verdicts', () => {
    expect(
      latestDecision([{ action: 'LONG', decision_time_ms: 5_000 }]),
    ).toBeNull()
    expect(
      latestDecision([
        { action: 'LONG', decision_time_ms: 5_000, runtime_version: 'other' },
      ]),
    ).toBeNull()
  })

  it('is null without real analyses', () => {
    expect(latestDecision([])).toBeNull()
    expect(latestDecision([null, 3, 'x', {}])).toBeNull()
  })

  it('takes the newest decision by its time, not by position', () => {
    const found = latestDecision([
      {
        runtime_version: 'futures-verdict.v1',
        action: 'LONG',
        reason_code: 'c25_long',
        regime: 'trend',
        decision_time_ms: 2_000,
        bucket_start_ms: 1_000,
      },
      {
        runtime_version: 'futures-verdict.v1',
        action: 'WAIT',
        decision_time_ms: 1_000,
      },
    ])
    expect(found).toEqual({
      action: 'LONG',
      reasonCode: 'c25_long',
      regime: 'trend',
      decisionTimeMs: 2_000,
      bucketStartMs: 1_000,
      proposals: null,
    })
  })

  it('ignores analyses without a verifiable time or action', () => {
    expect(
      latestDecision([
        { action: 'LONG', decision_time_ms: 'soon' },
        { decision_time_ms: 5_000 },
      ]),
    ).toBeNull()
  })

  it('falls back to the selector for action and reason', () => {
    expect(
      latestDecision([
        {
          runtime_version: 'futures-verdict.v1',
          decision_time_ms: 9,
          selector: { action: 'short', reason_code: 'r' },
        },
      ]),
    ).toMatchObject({ action: 'SHORT', reasonCode: 'r', regime: null })
  })
})

describe('latestDecision proposals', () => {
  it('counts directional proposals only when the list is present', () => {
    const base = {
      runtime_version: 'futures-verdict.v1',
      action: 'WAIT',
      decision_time_ms: 10,
    }
    expect(latestDecision([base])?.proposals).toBeNull()
    expect(
      latestDecision([
        {
          ...base,
          proposals: [{ action: 'WAIT' }, { action: 'long' }, null],
        },
      ])?.proposals,
    ).toEqual({ total: 3, directional: 1 })
    expect(latestDecision([{ ...base, proposals: [] }])?.proposals).toEqual({
      total: 0,
      directional: 0,
    })
  })
})

describe('decisionStanding', () => {
  const decision: LatestDecision = {
    action: 'WAIT',
    reasonCode: null,
    regime: null,
    decisionTimeMs: 1_000_000,
    bucketStartMs: 940_000,
    proposals: null,
  }
  const same = { status: 'ok' as const, bucketStartMs: 940_000 }

  it('is current only with age and B1 evidence together', () => {
    expect(decisionStanding(decision, 1_030_000, same)).toBe('current')
    // Age alone is not proof.
    expect(decisionStanding(decision, 1_030_000, null)).toBe('unconfirmed')
    expect(
      decisionStanding(decision, 1_030_000, { ...same, status: 'warning' }),
    ).toBe('unconfirmed')
    expect(
      decisionStanding(decision, 1_030_000, {
        ...same,
        bucketStartMs: 1_000_000,
      }),
    ).toBe('unconfirmed')
    expect(
      decisionStanding({ ...decision, bucketStartMs: null }, 1_030_000, same),
    ).toBe('unconfirmed')
  })

  it('B1 cannot make an old decision current', () => {
    expect(decisionStanding(decision, 1_000_000 + 600_000, same)).toBe(
      'historic',
    )
  })

  it('does not date a decision in the future of the clock', () => {
    expect(decisionStanding(decision, 900_000, same)).toBe('unprovable')
  })
})
