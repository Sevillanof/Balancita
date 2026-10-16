import { record } from '../../../shared/wire/decode.ts'
import {
  decodeSessionBlocks,
  type SessionBlocksDocument,
} from '../domain/session-blocks.ts'

/**
 * Read-only route of the live gateway (`GET /api/paper-session/blocks`,
 * Issue #187, BAL-DECISION-187-05): the derived file the Supervisor publishes,
 * with its age measured by the server. Absent and invalid are answers, not
 * errors: they are shown as such and never as an empty session. A shape that
 * does not match is an error, never a guess.
 */
export const SESSION_BLOCKS_URL = '/api-live/paper-session/blocks'

export type SessionBlocksReading =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | {
      state: 'ok'
      publishedAtMs: number
      evaluatedMs: number
      document: SessionBlocksDocument
    }

export function decodeSessionBlocksReading(raw: unknown): SessionBlocksReading {
  const r = record(raw)
  if (r.state === 'absent') return { state: 'absent' }
  if (r.state === 'invalid')
    return {
      state: 'invalid',
      reason: typeof r.reason === 'string' ? r.reason : 'unknown',
    }
  if (
    r.state !== 'ok' ||
    typeof r.published_at_ms !== 'number' ||
    typeof r.evaluated_ms !== 'number'
  )
    throw new Error('respuesta inesperada: paper-session/blocks')
  return {
    state: 'ok',
    publishedAtMs: r.published_at_ms,
    evaluatedMs: r.evaluated_ms,
    document: decodeSessionBlocks(r.document),
  }
}

export async function fetchSessionBlocks(
  signal: AbortSignal,
): Promise<SessionBlocksReading> {
  const response = await fetch(SESSION_BLOCKS_URL, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return decodeSessionBlocksReading(await response.json())
}
