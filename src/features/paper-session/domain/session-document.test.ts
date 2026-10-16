import { describe, expect, it } from 'vitest'
import documents from '../../../../docs/mission-control/b3/documento-bloques-publicador-real.json'
import { decodeSessionBlocks, newestFirst } from './session-blocks.ts'

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
    expect(doc.runId).toBe('run-synthetic-0001')
    const withoutRun: Record<string, unknown> = {
      ...documents.operating_threshold_hypothesis,
    }
    delete withoutRun.run
    expect(() => decodeSessionBlocks(withoutRun)).toThrow()
  })

  it('keeps the signal, decision and order detail of every interval as the publisher wrote it', () => {
    const doc = decodeSessionBlocks(documents.operating_threshold_hypothesis)
    const byAction = Object.fromEntries(
      doc.intervals.intervals.map((i) => [i.signal.action, i]),
    )
    expect(byAction.BUY.order.state).toBe('opened')
    expect(byAction.BUY.order.entryMs).toBeGreaterThan(0)
    expect(byAction.BUY.decision.decidedMs).toBeGreaterThan(0)
    expect(byAction.WAIT.signal.state).toBe('recorded')
    expect(byAction.WAIT.order.state).toBe('none')
    expect(doc.intervals.signalReferences).toEqual({
      verified: 2,
      unverified: [],
    })
  })

  it('a signal without decision that happened BEFORE a decision is listed after it, and carries the earlier time', () => {
    const rows = decodeSessionBlocks(documents.intervals_wait_before_decision)
      .intervals.intervals
    expect(rows.map((r) => r.signal.action)).toEqual(['BUY', 'WAIT'])
    expect(rows[1].atMs).not.toBeNull()
    expect(rows[1].atMs as number).toBeLessThan(rows[0].atMs as number)
    expect(newestFirst(rows).map((r) => r.signal.action)).toEqual([
      'BUY',
      'WAIT',
    ])
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
