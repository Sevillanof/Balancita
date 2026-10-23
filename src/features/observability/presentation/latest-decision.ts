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
/** The same for the decisions Qwen wrote (`/api/qwen/decisions`). */
export const QWEN_RUNTIME = 'qwen-decision.v1'

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
    if (
      analysis.runtime_version !== VERDICT_RUNTIME &&
      analysis.runtime_version !== QWEN_RUNTIME
    )
      continue
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
export const CLOCK_SKEW_MS = 5_000

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

/** The gateway sends a heartbeat every 15 s: three silent ones are a dead feed. */
export const CLOCK_MAX_AGE_MS = 45_000
/** B1 is read every 30 s: three missed reads make it obsolete. */
export const B1_MAX_AGE_MS = 90_000

/**
 * The gateway's `published_at` as the last snapshot/heartbeat of the CURRENT
 * connection delivered it, with the browser time it arrived at.
 */
export interface GatewayClock {
  publishedAtMs: number
  receivedAtMs: number
}

/**
 * Whether the gateway's clock can be trusted right now: a message was received
 * recently, its `published_at` is not in the future of its arrival (beyond the
 * skew) nor older than a few heartbeats, and the browser clock has not jumped
 * back since. Anything else and the clock is not valid.
 */
export function gatewayClockValid(
  clock: GatewayClock | null,
  localNowMs: number,
): clock is GatewayClock {
  if (clock === null) return false
  if (
    !Number.isSafeInteger(clock.publishedAtMs) ||
    !Number.isSafeInteger(clock.receivedAtMs)
  )
    return false
  const sinceArrival = localNowMs - clock.receivedAtMs
  if (sinceArrival < -CLOCK_SKEW_MS || sinceArrival > CLOCK_MAX_AGE_MS)
    return false
  const transit = clock.receivedAtMs - clock.publishedAtMs
  return transit >= -CLOCK_SKEW_MS && transit <= CLOCK_MAX_AGE_MS
}

/** The gateway's time now, advanced from its last valid message. */
export function gatewayNowMs(clock: GatewayClock, localNowMs: number): number {
  return clock.publishedAtMs + (localNowMs - clock.receivedAtMs)
}

/** What the screen needs to know about the B1 read, beyond its content. */
export interface HealthFreshness {
  data: HealthReport | null
  error: string | null
  /** Browser time of the last successful read, null when there is none. */
  receivedAt?: number | null
}

/**
 * Whether the B1 read can be trusted now: no refresh error, read since this
 * connection started, at most `B1_MAX_AGE_MS` old in the browser and in the
 * gateway's clock (which must be valid). The one rule behind both AHORA's
 * «actual» and the per-product source health: a stale or failed read never
 * says «Correcto».
 */
export function b1ReadFresh(input: {
  health: HealthFreshness
  connectedAtMs: number | null
  clockOk: boolean
  nowMs: number
  localNowMs: number
}): boolean {
  const { health, localNowMs, nowMs } = input
  const generatedAt = health.data?.generatedAtMs
  return (
    health.data !== null &&
    health.error === null &&
    typeof health.receivedAt === 'number' &&
    input.connectedAtMs !== null &&
    health.receivedAt >= input.connectedAtMs &&
    localNowMs - health.receivedAt <= B1_MAX_AGE_MS &&
    localNowMs - health.receivedAt >= -CLOCK_SKEW_MS &&
    input.clockOk &&
    typeof generatedAt === 'number' &&
    nowMs - generatedAt <= B1_MAX_AGE_MS &&
    generatedAt - nowMs <= CLOCK_SKEW_MS
  )
}

/**
 * B1's status for one product's verdict source as AHORA may show it:
 * the evidence only while the read is fresh and the connection is up
 * (`confirmed`); otherwise nothing, shown as «Sin confirmar».
 */
export function confirmedSourceEvidence(input: {
  product: string | null
  connected: boolean
  connectedAtMs: number | null
  clock: GatewayClock | null
  health: HealthFreshness
  localNowMs: number
}): { confirmed: boolean; evidence: VerdictSourceEvidence | null } {
  const clockOk = gatewayClockValid(input.clock, input.localNowMs)
  const nowMs = clockOk
    ? gatewayNowMs(input.clock!, input.localNowMs)
    : input.localNowMs
  if (
    !input.connected ||
    !b1ReadFresh({
      health: input.health,
      connectedAtMs: input.connectedAtMs,
      clockOk,
      nowMs,
      localNowMs: input.localNowMs,
    })
  )
    return { confirmed: false, evidence: null }
  return {
    confirmed: true,
    evidence: verdictSourceEvidence(input.health.data, input.product),
  }
}

export type ActualityBlocker =
  'disconnected' | 'clock' | 'b1_obsolete' | 'b1_mismatch'

export const BLOCKER_TEXT: Record<ActualityBlocker, string> = {
  disconnected: 'sin conexión WebSocket con el gateway',
  clock: 'el reloj del gateway no es válido o no llegan mensajes recientes',
  b1_obsolete:
    'la lectura de B1 falta, es obsoleta o es anterior a esta conexión',
  b1_mismatch:
    'B1 no confirma este veredicto como el último de la fuente de este producto',
}

export interface Actuality {
  standing: DecisionStanding
  /** Why a young decision is not «current»; empty only when it is. */
  blockers: ActualityBlocker[]
  /** True when the age was measured on the gateway's valid clock. */
  gatewayClock: boolean
  nowMs: number
}

/**
 * A decision is «current» only when ALL hold at this very moment: the
 * WebSocket is connected, the gateway clock is valid, B1 was read since this
 * connection started and is not obsolete, and B1 reads the same verdict
 * (same `bucket_start_ms`) with an «ok» source for the product in question.
 * Nothing is carried over from before a disconnection: each evaluation uses
 * only evidence of the current connection.
 */
export function assessActuality(input: {
  decision: LatestDecision
  product: string | null
  connected: boolean
  connectedAtMs: number | null
  clock: GatewayClock | null
  health: HealthFreshness
  localNowMs: number
}): Actuality {
  const { decision, connected, health, localNowMs } = input
  const clockOk = gatewayClockValid(input.clock, localNowMs)
  const nowMs = clockOk ? gatewayNowMs(input.clock!, localNowMs) : localNowMs
  const blockers: ActualityBlocker[] = []
  if (!connected) blockers.push('disconnected')
  if (!clockOk) blockers.push('clock')
  const b1Fresh = b1ReadFresh({
    health,
    connectedAtMs: input.connectedAtMs,
    clockOk,
    nowMs,
    localNowMs,
  })
  if (!b1Fresh) blockers.push('b1_obsolete')
  const evidence = verdictSourceEvidence(health.data, input.product)
  let standing = decisionStanding(decision, nowMs, evidence)
  if (standing === 'unconfirmed' && b1Fresh) blockers.push('b1_mismatch')
  if (standing === 'current' && blockers.length > 0) standing = 'unconfirmed'
  return { standing, blockers, gatewayClock: clockOk, nowMs }
}
