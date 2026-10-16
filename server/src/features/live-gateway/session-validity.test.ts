import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { degradeValidity } from './session-validity.ts'

// SYNTHETIC blocks in the shape paper_live_publish.py (#192) emits.
const block = (verification: Record<string, unknown> = {}) => ({
  schema: 'balancita-paper-session-positions.v1',
  clock_ms: 1_000_000,
  verification: {
    verified: true,
    reasons: [],
    freshness: 'fresh',
    thresholds: { report_max_age_ms: 60_000, status: 'approved' },
    ...verification,
  },
  positions: [{ intent_id: 'syn-1', verified: true }],
})

const freshness = (out: Record<string, unknown>) =>
  (out.verification as Record<string, unknown>).freshness

describe('degradeValidity: the gateway only degrades', () => {
  it('operational: a report inside its limit is left as the publisher said', () => {
    const out = degradeValidity(block(), {
      nowMs: 1_030_000,
      publishedAtMs: 1_000_000,
    })
    expect(freshness(out)).toBe('fresh')
    expect(out.gateway).toEqual({
      published_at_ms: 1_000_000,
      evaluated_ms: 1_030_000,
      age_ms: 30_000,
      reason: null,
    })
  })

  it('degraded: a report older than its limit becomes stale, verified untouched', () => {
    const input = block()
    const out = degradeValidity(input, {
      nowMs: 1_061_000,
      publishedAtMs: 1_000_000,
    })
    expect(freshness(out)).toBe('stale')
    expect((out.gateway as { reason: string }).reason).toBe(
      'report_age_over_limit',
    )
    // `verified`, reasons and positions are the publisher's: not rebuilt.
    expect(out.verification).toMatchObject({ verified: true, reasons: [] })
    expect(out.positions).toEqual(input.positions)
  })

  it('the limit itself is still inside it (age == limit)', () => {
    const out = degradeValidity(block(), {
      nowMs: 1_060_000,
      publishedAtMs: 1_000_000,
    })
    expect(freshness(out)).toBe('fresh')
  })

  it('never promotes: unknown and stale stay, even inside the limit', () => {
    for (const given of ['unknown', 'stale']) {
      const out = degradeValidity(block({ freshness: given }), {
        nowMs: 1_001_000,
        publishedAtMs: 1_000_000,
      })
      expect(freshness(out)).toBe(given)
    }
  })

  it('an age it cannot measure never stays fresh', () => {
    const noTime = degradeValidity(block(), {
      nowMs: 1_001_000,
      publishedAtMs: null,
    })
    expect(freshness(noTime)).toBe('unknown')
    expect((noTime.gateway as { reason: string }).reason).toBe(
      'report_age_unknown',
    )
    // A clock that went back is not a negative age.
    const backwards = degradeValidity(block(), {
      nowMs: 999_000,
      publishedAtMs: 1_000_000,
    })
    expect(freshness(backwards)).toBe('unknown')
    expect((backwards.gateway as { age_ms: unknown }).age_ms).toBeNull()
  })

  it('invents no limit: missing, zero or negative leaves a fresh report unknown', () => {
    for (const limit of [null, 0, -1, undefined]) {
      const out = degradeValidity(
        block({
          thresholds: { report_max_age_ms: limit, status: 'not_approved' },
        }),
        { nowMs: 1_000_500, publishedAtMs: 1_000_000 },
      )
      expect(freshness(out)).toBe('unknown')
      expect((out.gateway as { reason: string }).reason).toBe(
        'threshold_missing',
      )
    }
  })

  it('does not touch a publisher verified:false and never sets it true', () => {
    const out = degradeValidity(
      block({ verified: false, reasons: ['source_stale'] }),
      { nowMs: 1_001_000, publishedAtMs: 1_000_000 },
    )
    expect(out.verification).toMatchObject({
      verified: false,
      reasons: ['source_stale'],
    })
  })

  it('refuses a block without verification instead of guessing', () => {
    expect(() =>
      degradeValidity({ schema: 'x' }, { nowMs: 1, publishedAtMs: 1 }),
    ).toThrow(/verification/)
    expect(() => degradeValidity(null, { nowMs: 1, publishedAtMs: 1 })).toThrow(
      /verification/,
    )
  })
})

// ---- against blocks the REAL publisher emitted (python/tests/session_blocks_187.py, invented events) ----

const real = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../docs/mission-control/b3/bloques-publicador-real.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>

describe('degradeValidity on a block the real publisher emitted', () => {
  const published = 5_000_000
  const approved = real.positions_threshold_approved

  it("operating: inside the limit the verdict is exactly the publisher's", () => {
    const out = degradeValidity(approved, {
      nowMs: published + 10_000,
      publishedAtMs: published,
    })
    expect(freshness(out)).toBe('fresh')
    expect((out.gateway as { reason: unknown }).reason).toBeNull()
    expect(out.verification).toEqual(approved.verification)
    expect(out.positions).toEqual(approved.positions)
  })

  it('degraded: over the limit it becomes stale and nothing else changes', () => {
    const out = degradeValidity(approved, {
      nowMs: published + 15_001,
      publishedAtMs: published,
    })
    expect(freshness(out)).toBe('stale')
    expect((out.gateway as { reason: string }).reason).toBe(
      'report_age_over_limit',
    )
    expect(out.positions).toEqual(approved.positions)
    expect((out.verification as Record<string, unknown>).verified).toBe(
      (approved.verification as Record<string, unknown>).verified,
    )
  })

  it("a hypothesis threshold: the publisher's unknown is never promoted", () => {
    const out = degradeValidity(real.positions, {
      nowMs: published + 1_000,
      publishedAtMs: published,
    })
    expect(freshness(out)).toBe('unknown')
  })
})
