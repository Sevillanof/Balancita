import { describe, expect, it } from 'vitest'
import {
  assessActuality,
  decisionStanding,
  gatewayClockValid,
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

describe('gatewayClockValid', () => {
  const at = 1_000_000
  it('accepts a recent, coherent message', () => {
    expect(
      gatewayClockValid({ publishedAtMs: at, receivedAtMs: at }, at + 10_000),
    ).toBe(true)
    expect(
      gatewayClockValid({ publishedAtMs: at - 2_000, receivedAtMs: at }, at),
    ).toBe(true)
  })
  it('rejects none, a future stamp, an old stamp, silence and a clock that went back', () => {
    expect(gatewayClockValid(null, at)).toBe(false)
    expect(
      gatewayClockValid({ publishedAtMs: at + 6_000, receivedAtMs: at }, at),
    ).toBe(false)
    expect(
      gatewayClockValid({ publishedAtMs: at - 46_000, receivedAtMs: at }, at),
    ).toBe(false)
    expect(
      gatewayClockValid({ publishedAtMs: at, receivedAtMs: at }, at + 46_000),
    ).toBe(false)
    expect(
      gatewayClockValid({ publishedAtMs: at, receivedAtMs: at }, at - 6_000),
    ).toBe(false)
    expect(
      gatewayClockValid({ publishedAtMs: Number.NaN, receivedAtMs: at }, at),
    ).toBe(false)
  })
})

describe('assessActuality', () => {
  const NOW = 2_000_000
  const decision: LatestDecision = {
    action: 'LONG',
    reasonCode: null,
    regime: null,
    decisionTimeMs: NOW - 60_000,
    bucketStartMs: NOW - 120_000,
    proposals: null,
  }
  const report = (
    bucket: number,
    product = 'PF_XBTUSD',
    generatedAtMs = NOW - 5_000,
  ) =>
    ({
      generatedAtMs,
      cacheMs: 15_000,
      overall: { status: 'ok', reason: '', failing: [], unverified: [] },
      components: [
        {
          id: 'decisions',
          items: [
            {
              productId: product,
              status: 'ok',
              bucketStartMs: bucket,
              writtenAtMs: null,
            },
          ],
        },
      ],
    }) as never
  const good = {
    decision,
    product: 'PF_XBTUSD',
    connected: true,
    connectedAtMs: NOW - 30_000,
    clock: { publishedAtMs: NOW, receivedAtMs: NOW },
    health: {
      data: report(NOW - 120_000),
      error: null,
      receivedAt: NOW - 1_000,
    },
    localNowMs: NOW,
  }

  it('is current only when everything holds', () => {
    expect(assessActuality(good)).toMatchObject({
      standing: 'current',
      blockers: [],
    })
  })
  it.each([
    ['disconnected', { connected: false }, 'disconnected'],
    ['no clock', { clock: null }, 'clock'],
    ['B1 read before the connection', { connectedAtMs: NOW }, 'b1_obsolete'],
    [
      'B1 with a failed refresh',
      { health: { ...good.health, error: 'x' } },
      'b1_obsolete',
    ],
    [
      'B1 old on the gateway clock',
      {
        health: {
          ...good.health,
          data: report(NOW - 120_000, 'PF_XBTUSD', NOW - 200_000),
        },
      },
      'b1_obsolete',
    ],
    [
      'B1 of another product',
      { health: { ...good.health, data: report(NOW - 120_000, 'PF_ETHUSD') } },
      'b1_mismatch',
    ],
    [
      'B1 of another bucket',
      { health: { ...good.health, data: report(NOW - 60_000) } },
      'b1_mismatch',
    ],
  ])('%s is unconfirmed', (_name, change, blocker) => {
    const result = assessActuality({ ...good, ...change })
    expect(result.standing).toBe('unconfirmed')
    expect(result.blockers).toContain(blocker)
  })
})
