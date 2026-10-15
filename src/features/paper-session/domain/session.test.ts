import { describe, expect, it } from 'vitest'
import { decodeIntervalsBlock, decodePositionsBlock } from './session-blocks.ts'
import {
  effectiveVerification,
  isCurrent,
  presentedFreshness,
  thresholdLabel,
} from './session-freshness.ts'
import {
  coverage,
  position,
  positionsBlock,
  trace,
  verification,
} from '../testing/fixtures.ts'

const decode = (raw: unknown) => decodePositionsBlock(raw)

describe('decodePositionsBlock', () => {
  it('keeps what the publisher said, without computing anything', () => {
    const block = decode(verification.hypothesisFresh())
    expect(block.verification).toEqual({
      verified: true,
      reasons: [],
      freshness: 'fresh',
      thresholds: { reportMaxAgeMs: 60_000, status: 'hypothesis' },
    })
    expect(block.positions[0]).toMatchObject({
      productId: 'PF_XBTUSD',
      verified: true,
      accountingVerified: true,
      stopProtection: 'observed',
    })
    expect(block.unrealizedClass).toBe('estimated')
  })

  it('refuses another schema, an unknown freshness or threshold status', () => {
    expect(() => decode({ ...positionsBlock(), schema: 'otro' })).toThrow(
      /schema/,
    )
    expect(() => decode(positionsBlock({ freshness: 'recent' }))).toThrow(
      /verification.freshness/,
    )
    expect(() =>
      decode(
        positionsBlock({
          thresholds: { report_max_age_ms: 1, status: 'maybe' },
        }),
      ),
    ).toThrow(/thresholds.status/)
  })

  it('refuses a zero or negative limit: it is not a threshold', () => {
    for (const bad of [0, -5])
      expect(() =>
        decode(
          positionsBlock({
            thresholds: { report_max_age_ms: bad, status: 'hypothesis' },
          }),
        ),
      ).toThrow(/report_max_age_ms/)
  })

  it('refuses a position without a side or with a non-boolean verified', () => {
    expect(() =>
      decode(positionsBlock({}, [position({ side: 'FLAT' })])),
    ).toThrow(/side/)
    expect(() =>
      decode(positionsBlock({}, [position({ verified: 'yes' })])),
    ).toThrow(/verified/)
  })

  it('reads missing stop evidence as null, not as protected', () => {
    const block = decode(coverage.noStopEvidence())
    expect(block.positions[0].stopProtection).toBeNull()
    expect(block.positions[0].verified).toBe(false)
  })

  it('counts coverage gaps and keeps the silence of the product', () => {
    const p = decode(coverage.gaps()).positions[0]
    expect(p.coverage).toEqual({ gaps: 2, silentNowMs: 45_000 })
  })
})

describe('presented freshness: never fresh on a limit that is not approved', () => {
  it('is unknown with a hypothetical limit even if the publisher said fresh', () => {
    const block = decode(verification.hypothesisFresh())
    expect(block.verification.freshness).toBe('fresh')
    expect(presentedFreshness(block)).toBe('unknown')
    expect(isCurrent(block)).toBe(false)
    expect(thresholdLabel(block)).toMatch(/hipótesis/)
  })

  it('is unknown with no limit at all, and says «Umbral no aprobado»', () => {
    const block = decode(verification.notApproved())
    expect(presentedFreshness(block)).toBe('unknown')
    expect(thresholdLabel(block)).toBe('Umbral no aprobado')
  })

  it('is fresh only with an approved limit and a fresh report', () => {
    const block = decode(verification.approvedFresh())
    expect(presentedFreshness(block)).toBe('fresh')
    expect(isCurrent(block)).toBe(true)
  })

  it('keeps stale as stale on an approved limit', () => {
    const block = decode(verification.approvedStale())
    expect(presentedFreshness(block)).toBe('stale')
    expect(isCurrent(block)).toBe(false)
  })

  it('does not become fresh if an approved block has no limit', () => {
    const block = decode(
      positionsBlock({
        thresholds: { report_max_age_ms: null, status: 'approved' },
      }),
    )
    expect(presentedFreshness(block)).toBe('unknown')
  })
})

describe('effective verification: only degrades, never promotes', () => {
  it('a publisher false stays false in every freshness', () => {
    for (const fixture of [
      verification.notApproved(),
      verification.approvedStale(),
      verification.sourceStale(),
      verification.stopUnwatched(),
      coverage.gaps(),
    ]) {
      const block = decode(fixture)
      for (const p of block.positions)
        if (!p.verified)
          expect(effectiveVerification(block, p)).toBe('not_verified')
    }
  })

  it('a stop nobody watched is not verified even with accounting verified', () => {
    const block = decode(verification.stopUnwatched())
    const p = block.positions[0]
    expect(p.accountingVerified).toBe(true)
    expect(effectiveVerification(block, p)).toBe('not_verified')
  })

  it('a publisher true on a hypothetical limit is «not current»', () => {
    const block = decode(verification.hypothesisFresh())
    expect(effectiveVerification(block, block.positions[0])).toBe('not_current')
  })

  it('a publisher true is shown verified only on an approved fresh limit', () => {
    const block = decode(verification.approvedFresh())
    expect(effectiveVerification(block, block.positions[0])).toBe('verified')
  })

  it('a block-level false removes verification from a position that says true', () => {
    const block = decode(
      positionsBlock({
        verified: false,
        reasons: ['audit_violations'],
        thresholds: { report_max_age_ms: 60_000, status: 'approved' },
      }),
    )
    expect(block.positions[0].verified).toBe(true)
    expect(effectiveVerification(block, block.positions[0])).toBe(
      'not_verified',
    )
  })
})

describe('decodeIntervalsBlock: an incomplete trace stays incomplete', () => {
  it('reports the missing signal stage and does not invent it', () => {
    const block = decodeIntervalsBlock(trace.signalMissing())
    expect(block.contract).toEqual({
      complete: false,
      stagesMissing: ['signal'],
    })
    expect(block.intervals[0].signal.state).toBe('not_available')
    expect(block.intervals[1].decision.state).toBe('none')
    expect(block.intervals[1].order.reasons).toEqual(['risk_limit'])
    expect(block.intervals[1].trade.tradeId).toBeNull()
  })

  it('refuses another schema or a missing contract flag', () => {
    expect(() =>
      decodeIntervalsBlock({ ...trace.signalMissing(), schema: 'x' }),
    ).toThrow(/schema/)
    const bad = trace.signalMissing()
    bad.contract = { stages_missing: [] }
    expect(() => decodeIntervalsBlock(bad)).toThrow(/contract.complete/)
  })
})
