import { describe, expect, it } from 'vitest'
import { latestDecision } from './latest-decision.ts'

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
