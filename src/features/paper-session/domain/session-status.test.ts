import { describe, expect, it } from 'vitest'
import statuses from '../../../../docs/mission-control/b3/estado-sesion-publicador-real.json'
import { decodeSessionStatus } from './session-blocks.ts'

// The blocks come from the REAL publisher (python/tests/session_status_blocks_187.py) fed with
// invented lifecycles: this checks the decoder reads what Python emits, not what a fixture imagines.
describe('session status decoder against blocks the real publisher emitted', () => {
  it('decodes every scenario the publisher produced', () => {
    for (const [name, raw] of Object.entries(statuses)) {
      expect(() => decodeSessionStatus(raw), name).not.toThrow()
    }
  })

  it('a live process with an unapproved limit is not called alive', () => {
    const s = decodeSessionStatus(statuses.live_threshold_hypothesis)
    expect(s.phase).toBe('LIVE')
    expect(s.liveness).toBe('unknown')
    expect(s.thresholds?.status).toBe('hypothesis')
  })

  it('alive needs an approved limit', () => {
    const s = decodeSessionStatus(statuses.live_alive_threshold_approved)
    expect(s.liveness).toBe('alive')
    expect(s.thresholds?.status).toBe('approved')
  })

  it('a stale heartbeat is not reported as the phase the process claimed', () => {
    const s = decodeSessionStatus(statuses.live_heartbeat_stale)
    expect(s.liveness).toBe('stale')
    expect(s.phase).toBe('unverified')
  })

  it('a halt keeps its reason and observed funding stays unverified', () => {
    const s = decodeSessionStatus(statuses.halted_funding_diverged)
    expect(s.phase).toBe('HALTED')
    expect(s.liveness).toBe('final')
    expect(s.haltReason).toContain('funding_book_diverged')
    expect(s.funding.pnlVerified).toBe(false)
  })

  it('an orderly stop and an unavailable status never claim verified funding', () => {
    // the stopped session left a position open, so its funding report is observed but incomplete
    expect(decodeSessionStatus(statuses.stopped_orderly).funding.source).toBe(
      'observed',
    )
    expect(decodeSessionStatus(statuses.unavailable).funding.source).toBe(
      'unknown',
    )
    for (const raw of [statuses.stopped_orderly, statuses.unavailable]) {
      expect(decodeSessionStatus(raw).funding.pnlVerified).toBe(false)
    }
  })

  it('unavailable carries no limit and no counters, and says so', () => {
    const s = decodeSessionStatus(statuses.unavailable)
    expect(s.thresholds).toBeNull()
    expect(s.steps).toBeNull()
    expect(s.reasons).toContain('heartbeat_missing')
  })

  it('rejects what the publisher cannot have said', () => {
    const ok = statuses.warming_up
    const bad: unknown[] = [
      null,
      { ...ok, schema: 'other' },
      { ...ok, phase: 'RUNNING' },
      { ...ok, liveness: 'healthy' },
      { ...ok, funding: { ...ok.funding, source: 'guessed' } },
      { ...ok, funding: { ...ok.funding, pnl_verified: 'yes' } },
      { ...ok, thresholds: { ...ok.thresholds, heartbeat_max_age_ms: 0 } },
      { ...ok, thresholds: { ...ok.thresholds, status: 'ok' } },
      { ...ok, reasons: 'none' },
    ]
    for (const raw of bad) expect(() => decodeSessionStatus(raw)).toThrow()
  })

  it('keeps the funding detail the publisher gave (D-229-01)', () => {
    const s = decodeSessionStatus(statuses.halted_funding_diverged)
    expect(s.funding).toMatchObject({
      disputedTrades: [],
      quarantinedPeriods: [],
      divergenceEvidence: 1,
    })
    expect(s.funding.incompleteTrades).toHaveLength(1) // the real halted session holds one open position whose funding is not complete
    const none = decodeSessionStatus(statuses.warming_up)
    expect(none.funding.incompleteTrades).toBeNull()
    expect(none.funding.divergenceEvidence).toBeNull()
  })

  it('rejects combinations the publisher cannot produce (D-229-02)', () => {
    const live = statuses.live_threshold_hypothesis
    const halted = statuses.halted_funding_diverged
    const stale = statuses.live_heartbeat_stale
    const bad: Record<string, unknown> = {
      'alive without an approved limit': { ...live, liveness: 'alive' },
      'stale without the unverified phase': { ...live, liveness: 'stale' },
      'unverified without being stale': { ...live, phase: 'unverified' },
      'final for a running phase': { ...live, liveness: 'final' },
      'an ended phase that is not final': { ...halted, liveness: 'unknown' },
      'stale without a limit': {
        ...stale,
        thresholds: { ...stale.thresholds, heartbeat_max_age_ms: null },
      },
      'a halt reason on a running block': { ...live, halt_reason: 'x' },
      'verified synthetic funding': {
        ...live,
        funding: { ...live.funding, pnl_verified: true },
      },
      'verified unknown funding with no reasons': {
        ...live,
        funding: {
          ...live.funding,
          source: 'unknown',
          reasons: [],
          pnl_verified: true,
        },
      },
      'verified synthetic funding with no reasons': {
        ...live,
        funding: {
          ...live.funding,
          source: 'synthetic',
          reasons: [],
          pnl_verified: true,
        },
      },
      'verified funding with reasons against it': {
        ...halted,
        funding: { ...halted.funding, pnl_verified: true },
      },
      'a live block without thresholds': { ...live, thresholds: undefined },
      'an unavailable block with thresholds': {
        ...statuses.unavailable,
        thresholds: live.thresholds,
      },
      'unavailable but alive': { ...statuses.unavailable, liveness: 'alive' },
    }
    for (const [name, raw] of Object.entries(bad))
      expect(() => decodeSessionStatus(raw), name).toThrow()
  })

  it('decodes what the gateway measured when it degraded the block', () => {
    const s = decodeSessionStatus({
      ...statuses.live_heartbeat_stale,
      gateway: { age_ms: 61000, reason: 'heartbeat_age_over_limit' },
    })
    expect(s.gateway).toEqual({
      ageMs: 61000,
      reason: 'heartbeat_age_over_limit',
      heartbeatPhase: null,
    })
    expect(() =>
      decodeSessionStatus({
        ...statuses.live_heartbeat_stale,
        gateway: { age_ms: 1, reason: 'made_up' },
      }),
    ).toThrow()
  })
})
