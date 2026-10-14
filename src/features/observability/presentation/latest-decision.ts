/**
 * The most recent decision among the analyses the Terminal stream delivered
 * for the product on screen. It reads only real analysis records (action,
 * reason_code, regime, decision_time_ms, bucket_start_ms); it never deduces a
 * decision from the B2 aggregates and returns null when nothing qualifies.
 */
export interface LatestDecision {
  action: string
  reasonCode: string | null
  regime: string | null
  decisionTimeMs: number
  bucketStartMs: number | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function latestDecision(
  analyses: readonly unknown[],
): LatestDecision | null {
  let best: LatestDecision | null = null
  for (const value of analyses) {
    if (typeof value !== 'object' || value === null) continue
    const analysis = value as Record<string, unknown>
    const time = analysis.decision_time_ms
    const selector =
      typeof analysis.selector === 'object' && analysis.selector !== null
        ? (analysis.selector as Record<string, unknown>)
        : {}
    const action = text(analysis.action) ?? text(selector.action)
    if (analysis.runtime_version !== VERDICT_RUNTIME) continue
    if (!Number.isSafeInteger(time) || action === null) continue
    if (best !== null && Number(time) < best.decisionTimeMs) continue
    best = {
      action: action.toUpperCase(),
      reasonCode: text(analysis.reason_code) ?? text(selector.reason_code),
      regime: text(analysis.regime),
      decisionTimeMs: Number(time),
      bucketStartMs: Number.isSafeInteger(analysis.bucket_start_ms)
        ? Number(analysis.bucket_start_ms)
        : null,
    }
  }
  return best
}

/**
 * Provenance the gateway stamps on every analysis it builds from the engine's
 * verdicts (`runtime_version` in paper-engine-follower.ts). An analysis
 * without it is not shown in AHORA: its origin cannot be proven.
 */
export const VERDICT_RUNTIME = 'futures-verdict.v1'

/** A verdict is one per minute: three missed cycles and it is no longer «now». */
export const CURRENT_MAX_AGE_MS = 180_000
const CLOCK_SKEW_MS = 5_000

export type DecisionStanding = 'current' | 'historic' | 'unprovable'

/**
 * `current`: fresh enough to describe the engine now. `historic`: real but
 * old (the verdicts DB keeps the last 100 after a stop). `unprovable`: dated
 * in the future of this clock, so its age cannot be told.
 */
export function decisionStanding(
  decision: LatestDecision,
  nowMs: number,
): DecisionStanding {
  const age = nowMs - decision.decisionTimeMs
  if (age < -CLOCK_SKEW_MS) return 'unprovable'
  return age > CURRENT_MAX_AGE_MS ? 'historic' : 'current'
}
