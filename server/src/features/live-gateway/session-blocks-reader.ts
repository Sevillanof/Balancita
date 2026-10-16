import { readFileSync, statSync } from 'node:fs'
import { degradeValidity } from './session-validity.ts'

/**
 * Read-only reader of the session blocks file the Supervisor publishes
 * (Issue #187, BAL-DECISION-187-05, option A). The server has no trading
 * authority here: it reads one derived file, measures its age with its own
 * clock (the file's mtime) and may only DEGRADE what the publisher said. It
 * never promotes `fresh`/`alive`, never rebuilds a block and has no default
 * limit. Absent and invalid files are reported as such, never as an empty
 * session.
 */
export const BLOCKS_SCHEMA = 'balancita-paper-session-blocks.v1'

export type SessionBlocksReading =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly reason: string }
  | {
      readonly state: 'ok'
      readonly published_at_ms: number
      readonly evaluated_ms: number
      readonly document: Record<string, unknown>
    }

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FINAL = new Set(['STOPPED', 'HALTED', 'REFUSED'])

/**
 * Degrades the liveness of a running session whose heartbeat the gateway
 * cannot confirm. Only moves `alive` to `unknown` or `stale`, and `stale`
 * also turns the phase into `unverified` (the publisher's own pairing).
 * Final and unavailable statuses are left as they are.
 */
export function degradeStatus(
  status: unknown,
  input: { nowMs: number; publishedAtMs: number | null },
): Json {
  if (!isRecord(status)) throw new Error('respuesta inesperada: status')
  const phase = status.phase
  if (
    typeof phase !== 'string' ||
    phase === 'unavailable' ||
    FINAL.has(phase) ||
    status.liveness === 'final'
  )
    return { ...status, gateway: null }
  const limit =
    isRecord(status.thresholds) &&
    typeof status.thresholds.heartbeat_max_age_ms === 'number' &&
    Number.isFinite(status.thresholds.heartbeat_max_age_ms) &&
    status.thresholds.heartbeat_max_age_ms > 0
      ? status.thresholds.heartbeat_max_age_ms
      : null
  const published =
    Number.isFinite(input.publishedAtMs) && input.publishedAtMs !== null
      ? input.publishedAtMs
      : null
  const age =
    published !== null && input.nowMs >= published
      ? input.nowMs - published
      : null
  let reason: string | null = null
  if (limit === null) reason = 'threshold_missing'
  else if (age === null) reason = 'heartbeat_age_unknown'
  else if (age > limit) reason = 'heartbeat_age_over_limit'

  let liveness = status.liveness
  let nextPhase: unknown = phase
  const reasons = Array.isArray(status.reasons) ? [...status.reasons] : []
  if (reason === 'heartbeat_age_over_limit') {
    liveness = 'stale'
    nextPhase = 'unverified'
    if (!reasons.includes('heartbeat_stale')) reasons.push('heartbeat_stale')
  } else if (reason !== null && liveness === 'alive') {
    liveness = 'unknown'
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  return {
    ...status,
    phase: nextPhase,
    liveness,
    reasons,
    gateway: { age_ms: age, reason },
  }
}

function readHeartbeat(heartbeatPath: string | undefined): Json | null {
  if (!heartbeatPath) return null
  try {
    const beat: unknown = JSON.parse(readFileSync(heartbeatPath, 'utf8'))
    return isRecord(beat) ? beat : null
  } catch {
    return null
  }
}

/**
 * The file must come from the run whose heartbeat is on disk now
 * (session_id, config_digest, the pid and the run id of the process start that
 * wrote it). A file left by an earlier run keeps a recent mtime after a
 * restart; without this check it would be shown as the current session
 * (D-223-01 again).
 */
function sameRun(document: Json, beat: Json | null): boolean {
  if (!beat) return false
  const run = isRecord(document.run) ? document.run : {}
  return (
    typeof beat.session_id === 'string' &&
    typeof beat.config_digest === 'string' &&
    typeof beat.pid === 'number' &&
    typeof beat.run_id === 'string' &&
    document.session_id === beat.session_id &&
    document.config_digest === beat.config_digest &&
    run.pid === beat.pid &&
    run.id === beat.run_id
  )
}

/**
 * Whether the heartbeat is ahead of the document (D-234-01). The Supervisor
 * writes the heartbeat after the publication of the same attempt and counts the
 * attempts in both: a failed publication leaves the previous document of the
 * SAME run next to a heartbeat that has moved on, and that document is not the
 * current state of the session. Without the counters in the heartbeat nothing
 * can be confirmed, which also counts as behind.
 */
function publicationBehind(document: Json, beat: Json): boolean {
  const publication = isRecord(beat.publication) ? beat.publication : null
  return (
    publication === null ||
    typeof publication.attempts !== 'number' ||
    document.attempt !== publication.attempts ||
    document.observed_now_ms !== beat.observed_now_ms ||
    document.steps !== beat.steps
  )
}

export function readSessionBlocks(
  path: string,
  nowMs: number,
  heartbeatPath?: string,
): SessionBlocksReading {
  let raw: string
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { state: 'absent' }
    return { state: 'invalid', reason: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'invalid', reason: 'not_json' }
  }
  if (!isRecord(parsed) || parsed.schema !== BLOCKS_SCHEMA)
    return { state: 'invalid', reason: 'schema_unknown' }
  if (parsed.derived !== true || parsed.authority !== 'none')
    return { state: 'invalid', reason: 'not_derived' }
  if (
    !isRecord(parsed.status) ||
    !isRecord(parsed.positions) ||
    !isRecord(parsed.intervals)
  )
    return { state: 'invalid', reason: 'block_missing' }
  const beat = readHeartbeat(heartbeatPath)
  if (!sameRun(parsed, beat) || beat === null)
    return { state: 'invalid', reason: 'other_run' }
  const publishedAtMs = Math.round(mtimeMs)
  try {
    const validity = { nowMs, publishedAtMs }
    const behind = publicationBehind(parsed, beat)
    let status = degradeStatus(parsed.status, validity)
    let positions = degradeValidity(parsed.positions, validity)
    if (behind) {
      // The document is the last one that could be written, not the latest state.
      const gateway = isRecord(status.gateway) ? status.gateway : {}
      status = {
        ...status,
        liveness: status.liveness === 'alive' ? 'unknown' : status.liveness,
        gateway: {
          age_ms: gateway.age_ms ?? null,
          reason: 'publication_behind',
          heartbeat_phase: typeof beat.phase === 'string' ? beat.phase : null,
        },
      }
      const verification = isRecord(positions.verification)
        ? positions.verification
        : {}
      positions = {
        ...positions,
        verification: {
          ...verification,
          freshness:
            verification.freshness === 'fresh'
              ? 'unknown'
              : verification.freshness,
        },
      }
    }
    return {
      state: 'ok',
      published_at_ms: publishedAtMs,
      evaluated_ms: nowMs,
      document: { ...parsed, status, positions },
    }
  } catch {
    return { state: 'invalid', reason: 'block_shape' }
  }
}
