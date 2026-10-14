import type {
  HealthReport,
  HealthStatus,
} from '../infrastructure/observability-api.ts'

/**
 * Provenance the gateway stamps on every analysis it builds from the engine's
 * verdicts (`runtime_version` in paper-engine-follower.ts). An analysis
 * without it is not shown in AHORA: its origin cannot be proven.
 */
export const VERDICT_RUNTIME = 'futures-verdict.v1'

/**
 * The most recent decision among the analyses the Terminal stream delivered
 * for the product on screen. It reads only real analysis records (action,
 * reason_code, regime, decision_time_ms, bucket_start_ms, proposals); it never
 * deduces a decision from the B2 aggregates and returns null when nothing
 * qualifies.
 */
export interface LatestDecision {
  action: string
  reasonCode: string | null
  regime: string | null
  decisionTimeMs: number
  bucketStartMs: number | null
  /**
   * What the verdict says about the strategies' proposals, or null when the
   * analysis carries no `proposals` list (nothing can then be said about them).
   */
  proposals: { total: number; directional: number } | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function proposalsOf(
  value: unknown,
): { total: number; directional: number } | null {
  if (!Array.isArray(value)) return null
  let directional = 0
  for (const item of value) {
    const action =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>).action
        : null
    if (typeof action === 'string') {
      const upper = action.toUpperCase()
      if (upper === 'LONG' || upper === 'SHORT') directional += 1
    }
  }
  return { total: value.length, directional }
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
      proposals: proposalsOf(analysis.proposals),
    }
  }
  return best
}

/**
 * A verdict is one per minute; B1 itself judges the source «ok» up to three
 * cycles (VERDICT_OK_MS). Past that a decision cannot be «now». This is a
 * necessary bound, never the proof: see `decisionStanding`.
 */
export const CURRENT_MAX_AGE_MS = 180_000
const CLOCK_SKEW_MS = 5_000

/**
 * What B1 says about the verdict source for one product: the status the
 * gateway computed with its own clock and the bucket of the newest verdict it
 * read in the verdicts database.
 */
export interface VerdictSourceEvidence {
  status: HealthStatus
  bucketStartMs: number | null
}

/** B1's reading for `product` (`decisions` component), or null without one. */
export function verdictSourceEvidence(
  health: HealthReport | null,
  product: string | null,
): VerdictSourceEvidence | null {
  if (!health || !product) return null
  const item = health.components
    .find((component) => component.id === 'decisions')
    ?.items?.find((entry) => entry.productId === product)
  return item
    ? { status: item.status, bucketStartMs: item.bucketStartMs }
    : null
}

export type DecisionStanding =
  'current' | 'unconfirmed' | 'historic' | 'unprovable'

/**
 * `current`: young enough AND B1 reads the same verdict (same bucket) as the
 * newest one of its verdict source, with an «ok» source. `unconfirmed`: young
 * enough but B1 gives no matching evidence (no read, source not ok, or B1
 * already sees a newer verdict). `historic`: real but too old (the verdicts
 * database keeps the last ones after a stop). `unprovable`: dated in the
 * future of the clock used, so its age cannot be told.
 *
 * `nowMs` should be the gateway's clock when the stream has delivered it.
 */
export function decisionStanding(
  decision: LatestDecision,
  nowMs: number,
  evidence: VerdictSourceEvidence | null,
): DecisionStanding {
  const age = nowMs - decision.decisionTimeMs
  if (age < -CLOCK_SKEW_MS) return 'unprovable'
  if (age > CURRENT_MAX_AGE_MS) return 'historic'
  const confirmed =
    evidence !== null &&
    evidence.status === 'ok' &&
    evidence.bucketStartMs !== null &&
    decision.bucketStartMs !== null &&
    evidence.bucketStartMs === decision.bucketStartMs
  return confirmed ? 'current' : 'unconfirmed'
}
