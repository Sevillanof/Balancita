import { describe, expect, it } from 'vitest'
import {
  createShadowDecisionInput,
  restoreShadowDecision,
} from '../shadow/shadow-decision.ts'
import { contentHashFor } from '../forecast-hashing.ts'

describe('createShadowDecisionInput', () => {
  it('creates a go decision that explicitly turns the upstream source on', () => {
    const decision = createShadowDecisionInput({
      runId: 'run-abc',
      decision: 'go',
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      reason: '30 days completed, metrics look good',
      decidedAt: 1_700_000_000_000,
    })
    expect(decision.decision).toBe('go')
    expect(decision.setUpstream).toBe(true)
    expect(decision.upstreamEnabledFrom).toBe(1_700_000_000_000)
    expect(decision.id).toMatch(/^dec:/)
    expect(decision.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const { contentHash, id, ...body } = decision
    expect(contentHashFor({ id, ...body })).toBe(contentHash)
  })

  it('creates a no_go decision that leaves the upstream source off', () => {
    const decision = createShadowDecisionInput({
      runId: 'run-abc',
      decision: 'no_go',
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      reason: 'coverage below minimum',
      decidedAt: 1_700_000_000_000,
    })
    expect(decision.decision).toBe('no_go')
    expect(decision.setUpstream).toBe(false)
    expect(decision.upstreamEnabledFrom).toBeUndefined()
  })

  it('uses a default reason when omitted', () => {
    const decision = createShadowDecisionInput({
      runId: 'run-abc',
      decision: 'no_go',
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      decidedAt: 1_700_000_000_000,
    })
    expect(decision.reason).toBe('manual_decision')
  })

  it('rejects empty actor or reason', () => {
    expect(() =>
      createShadowDecisionInput({
        runId: 'run-abc',
        decision: 'go',
        reportHash: 'deadbeef'.repeat(8),
        actor: '',
        reason: 'because',
        decidedAt: 1_700_000_000_000,
      }),
    ).toThrowError(/actor/i)
    expect(() =>
      createShadowDecisionInput({
        runId: 'run-abc',
        decision: 'go',
        reportHash: 'deadbeef'.repeat(8),
        actor: 'admin',
        reason: '  ',
        decidedAt: 1_700_000_000_000,
      }),
    ).toThrowError(/reason/i)
  })

  it('rejects decisions that are not go or no_go', () => {
    expect(() =>
      createShadowDecisionInput({
        runId: 'run-abc',
        decision: 'maybe' as never,
        reportHash: 'deadbeef'.repeat(8),
        actor: 'admin',
        reason: 'because',
        decidedAt: 1_700_000_000_000,
      }),
    ).toThrowError(/decision/i)
  })

  it('hashes differently for different decisions on the same report', () => {
    const runId = 'run-abc'
    const reportHash = 'deadbeef'.repeat(8)
    const go = createShadowDecisionInput({
      runId,
      decision: 'go',
      reportHash,
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: 1_700_000_000_000,
    })
    const noGo = createShadowDecisionInput({
      runId,
      decision: 'no_go',
      reportHash,
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: 1_700_000_000_000,
    })
    expect(go.contentHash).not.toBe(noGo.contentHash)
  })

  it('restores a persisted decision to an identical object', () => {
    const created = createShadowDecisionInput({
      runId: 'run-abc',
      decision: 'go',
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: 1_700_000_000_000,
    })
    const stored = restoreShadowDecision({
      ...created,
      id: created.id,
      contentHash: created.contentHash,
    })
    expect(stored).toEqual(created)
  })
})
