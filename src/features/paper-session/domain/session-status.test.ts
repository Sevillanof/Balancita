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
    for (const raw of [statuses.stopped_orderly, statuses.unavailable]) {
      const s = decodeSessionStatus(raw)
      expect(s.funding.source).toBe('unknown')
      expect(s.funding.pnlVerified).toBe(false)
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
})
