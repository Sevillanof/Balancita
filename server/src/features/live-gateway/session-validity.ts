/**
 * Validity of a published session block at the gateway (Issue #187,
 * BAL-DECISION-187-01). OFFLINE: nothing serves a session block yet; this is
 * the pure rule the route will call once #185/#186 give an authoritative
 * session.
 *
 * The gateway only DEGRADES. It compares the age of the report against the
 * limit the publisher carries in the block (`verification.thresholds`) with
 * its own clock, and it may turn `fresh` into `stale` or `unknown`. It never
 * promotes `fresh`, never touches `verified`, `reasons` or the positions (the
 * publisher's `paper_live_publish.verification()` is the only producer of
 * those), and it has no default limit: a missing, zero or negative limit, or
 * an age it cannot measure, leaves the validity `unknown`.
 */
export type GatewayReason =
  'report_age_over_limit' | 'report_age_unknown' | 'threshold_missing'

export interface GatewayValidity {
  readonly published_at_ms: number | null
  readonly evaluated_ms: number
  /** `null` when the age cannot be measured (no publication time or a clock going back). */
  readonly age_ms: number | null
  readonly reason: GatewayReason | null
}

export interface ValidityInput {
  /** Gateway clock. */
  readonly nowMs: number
  /** When the gateway received this report; `null` if it does not know. */
  readonly publishedAtMs: number | null
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

/**
 * Returns the same block with `verification.freshness` possibly degraded and a
 * `gateway` object that says what was measured. Throws if the block has no
 * verification: an unknown shape is an error, not a guess.
 */
export function degradeValidity(block: unknown, input: ValidityInput): Json {
  if (!isRecord(block) || !isRecord(block.verification))
    throw new Error('respuesta inesperada: verification')
  const verification = block.verification
  const limit = isRecord(verification.thresholds)
    ? validLimit(verification.thresholds.report_max_age_ms)
    : null
  const published =
    input.publishedAtMs !== null && Number.isFinite(input.publishedAtMs)
      ? input.publishedAtMs
      : null
  const age =
    published !== null && input.nowMs >= published
      ? input.nowMs - published
      : null

  let reason: GatewayReason | null = null
  let freshness: unknown = verification.freshness
  if (limit === null) {
    reason = 'threshold_missing'
  } else if (age === null) {
    reason = 'report_age_unknown'
  } else if (age > limit) {
    reason = 'report_age_over_limit'
  }
  if (reason === 'report_age_over_limit') {
    freshness = 'stale'
  } else if (reason !== null && freshness === 'fresh') {
    // Cannot confirm the freshness the publisher gave: never keep `fresh`.
    freshness = 'unknown'
  }

  const gateway: GatewayValidity = {
    published_at_ms: published,
    evaluated_ms: input.nowMs,
    age_ms: age,
    reason,
  }
  return {
    ...block,
    verification: { ...verification, freshness },
    gateway,
  }
}
