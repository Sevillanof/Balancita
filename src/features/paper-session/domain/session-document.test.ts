import { describe, expect, it } from 'vitest'
import documents from '../../../../docs/mission-control/b3/documento-bloques-publicador-real.json'
import { decodeSessionBlocks } from './session-blocks.ts'

// The documents come from the REAL publisher (python/tests/session_document_187.py): this checks the
// decoder reads what Python writes next to the heartbeat, not what a fixture imagines.
describe('session document decoder against documents the real publisher emitted', () => {
  it('decodes every scenario the publisher produced', () => {
    for (const [name, raw] of Object.entries(documents)) {
      expect(() => decodeSessionBlocks(raw), name).not.toThrow()
    }
  })

  it('a document is derived, has no authority and claims no age', () => {
    for (const [name, raw] of Object.entries(documents)) {
      const doc = decodeSessionBlocks(raw)
      expect(doc.positions.verification.freshness, name).toBe('unknown')
      expect(doc.positions.verification.verified, name).toBe(false)
      expect(doc.positions.gateway, name).toBeNull()
      expect(doc.status.gateway, name).toBeNull()
      expect(doc.status.liveness, name).not.toBe('alive')
    }
  })

  it('carries the three blocks of one session', () => {
    const doc = decodeSessionBlocks(documents.operating_threshold_hypothesis)
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.thresholds?.status).toBe('hypothesis')
    expect(doc.positions.positions).toHaveLength(1)
    expect(doc.intervals.intervals.length).toBeGreaterThan(0)
    expect(doc.sessionId).toBeTruthy()
    expect(doc.steps).toBe(2)
  })

  it('carries the mark of the run that wrote it, and a document without it is refused', () => {
    const doc = decodeSessionBlocks(documents.operating_threshold_hypothesis)
    expect(doc.runPid).toBe(4242)
    const withoutRun: Record<string, unknown> = {
      ...documents.operating_threshold_hypothesis,
    }
    delete withoutRun.run
    expect(() => decodeSessionBlocks(withoutRun)).toThrow()
  })

  it('a session without a heartbeat is unavailable and has no identity', () => {
    const doc = decodeSessionBlocks(documents.without_status)
    expect(doc.status.phase).toBe('unavailable')
    expect(doc.sessionId).toBeNull()
  })

  it('rejects a document that claims authority or is not derived', () => {
    const ok = documents.operating_no_threshold
    const bad: unknown[] = [
      null,
      { ...ok, schema: 'other' },
      { ...ok, derived: false },
      { ...ok, authority: 'session' },
      { ...ok, status: null },
      { ...ok, status: { ...ok.status, phase: 'RUNNING' } },
      { ...ok, positions: { ...ok.positions, schema: 'other' } },
      { ...ok, intervals: [] },
    ]
    for (const raw of bad) expect(() => decodeSessionBlocks(raw)).toThrow()
  })
})
