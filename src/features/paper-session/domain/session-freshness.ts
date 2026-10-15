import type { PositionsBlock, SessionPosition } from './session-blocks.ts'

/**
 * What the screen may present as current (Issue #187, BAL-DECISION-187-01).
 *
 * The publisher judges the report against the limit it carries (`freshness`).
 * That limit is an experiment until someone approves it, so the screen never
 * calls anything `fresh` on a limit that is not approved: with a missing or
 * hypothetical limit the presented freshness is `unknown`, except that `stale`
 * is kept (a report older than its limit degrades, hypothetical or not). There is no
 * default threshold here, no phase is derived, and `verified` is only ever
 * degraded, never promoted or rebuilt. The publisher (PR #192, de6e857)
 * already refuses `fresh` and `verified` without an approved limit; this rule
 * is the defensive second line for a block that did not.
 */
export type PresentedFreshness = 'fresh' | 'stale' | 'unknown'

export function presentedFreshness(
  block: Pick<PositionsBlock, 'verification'>,
): PresentedFreshness {
  const { freshness, thresholds } = block.verification
  // Degrading is always allowed: a report older than its own limit is stale
  // even when that limit is only a hypothesis.
  if (freshness === 'stale') return 'stale'
  // Promoting is not: `fresh` needs an approved limit.
  if (thresholds.status !== 'approved') return 'unknown'
  if (thresholds.reportMaxAgeMs === null) return 'unknown'
  return freshness
}

/** Operation is presented as current only on an approved, fresh limit. */
export function isCurrent(
  block: Pick<PositionsBlock, 'verification'>,
): boolean {
  return presentedFreshness(block) === 'fresh'
}

export type EffectiveVerification = 'verified' | 'not_verified' | 'not_current'

/**
 * A publisher `false` stays `false`. A `true` is shown only while the block is
 * current; otherwise it is «not current». The block-level `verified` is the
 * publisher's too: if it says false, no position is promoted by its own flag.
 */
export function effectiveVerification(
  block: Pick<PositionsBlock, 'verification'>,
  position: Pick<SessionPosition, 'verified'>,
): EffectiveVerification {
  if (!position.verified || !block.verification.verified) return 'not_verified'
  return isCurrent(block) ? 'verified' : 'not_current'
}

/** Short Spanish label for the threshold state, as the publisher reports it. */
export function thresholdLabel(
  block: Pick<PositionsBlock, 'verification'>,
): string {
  switch (block.verification.thresholds.status) {
    case 'approved':
      return 'Límite de vigencia aprobado'
    case 'hypothesis':
      return 'Límite de vigencia en hipótesis: sin aprobar'
    default:
      return 'Umbral no aprobado'
  }
}
