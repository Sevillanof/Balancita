import type { TimestampMs } from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import type { ShadowDecisionType } from './shadow-contracts.ts'
import {
  SHADOW_DECISION_VERSION,
  SHADOW_REPORT_VERSION,
} from './shadow-contracts.ts'

export interface ShadowDecisionRecord {
  readonly id: string
  readonly version: typeof SHADOW_DECISION_VERSION
  readonly runId: string
  readonly decision: ShadowDecisionType
  readonly reportId: string
  readonly reportVersion: typeof SHADOW_REPORT_VERSION
  readonly reportHash: string
  readonly setUpstream: boolean
  readonly upstreamEnabledFrom?: TimestampMs
  readonly actor: string
  readonly reason: string
  readonly decidedAt: TimestampMs
  readonly contentHash: string
}

export interface ShadowDecisionInput {
  readonly runId: string
  readonly decision: ShadowDecisionType
  readonly reportHash: string
  readonly reportId?: string
  readonly actor: string
  readonly reason?: string
  readonly decidedAt: number
}

export function createShadowDecisionInput(
  input: ShadowDecisionInput,
): ShadowDecisionRecord {
  if (input.decision !== 'go' && input.decision !== 'no_go')
    throw new Error(
      `Decision must be exactly go or no_go, received ${String(input.decision)}.`,
    )
  const actor = input.actor.trim()
  if (actor.length === 0)
    throw new Error('Decision actor must be a non-empty string.')
  const reason = (input.reason ?? 'manual_decision').trim()
  if (reason.length === 0)
    throw new Error('Decision reason must be a non-empty string.')

  const signature = {
    version: SHADOW_DECISION_VERSION,
    runId: input.runId,
    decision: input.decision,
    reportId:
      input.reportId ??
      `report:${input.runId}:${input.reportHash.slice(0, 16)}`,
    reportVersion: SHADOW_REPORT_VERSION,
    reportHash: input.reportHash,
    setUpstream: input.decision === 'go',
    ...(input.decision === 'go'
      ? { upstreamEnabledFrom: input.decidedAt as TimestampMs }
      : {}),
    actor,
    reason,
    decidedAt: input.decidedAt as TimestampMs,
  }
  const id = `dec:${contentHashFor(signature).slice(0, 16)}`
  const contentHash = contentHashFor({ id, ...signature })
  return { id, ...signature, contentHash }
}

export function restoreShadowDecision(
  persisted: ShadowDecisionRecord,
): ShadowDecisionRecord {
  const { contentHash, id, ...signature } = persisted
  const rebuiltId = `dec:${contentHashFor(signature).slice(0, 16)}`
  const recomputed = contentHashFor({ id: rebuiltId, ...signature })
  if (recomputed !== contentHash)
    throw new Error('Shadow decision content hash does not match its body.')
  if (rebuiltId !== id)
    throw new Error('Shadow decision id does not match its content hash.')
  return { id: rebuiltId, ...signature, contentHash: recomputed }
}
