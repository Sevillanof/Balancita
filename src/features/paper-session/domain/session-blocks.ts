import { record } from '../../../shared/wire/decode.ts'

/**
 * Decoders for the two blocks the session publisher already produces
 * (`python/balancita_engine/paper_live_publish.py`, PR #192): positions (B5,
 * `balancita-paper-session-positions.v1`) and intervals (B3 of the session,
 * `balancita-paper-session-intervals.v1`). Issue #187, prepared offline
 * against synthetic fixtures: nothing serves these blocks yet and no screen
 * reads them. The decoders keep what the publisher said and invent nothing:
 * no verification, threshold, phase or default is computed here. A shape that
 * does not match is an error, never a guess.
 */
export const POSITIONS_SCHEMA = 'balancita-paper-session-positions.v1'
export const INTERVALS_SCHEMA = 'balancita-paper-session-intervals.v1'

/** Freshness of the report as the publisher judged it against its own limit. */
export type PublisherFreshness = 'fresh' | 'stale' | 'unknown'
/**
 * `not_approved`: the block carries no limit. `hypothesis`: it carries one, as
 * an experiment. `approved` is not emitted today; it exists so a future
 * approval is a contract change and not a guess.
 */
export type ThresholdStatus = 'not_approved' | 'hypothesis' | 'approved'

export type SessionVerification = {
  verified: boolean
  /** Stable publisher codes (`source_stale`, `freshness_threshold_not_approved`...). */
  reasons: string[]
  freshness: PublisherFreshness
  thresholds: { reportMaxAgeMs: number | null; status: ThresholdStatus }
}

export type SessionPosition = {
  intentId: string
  productId: string
  strategyId: string
  side: 'LONG' | 'SHORT'
  entryMs: number
  entryPrice: string
  stop: string
  target: string
  quantity: string
  /** Evidence that the stop was watched; `null` when the runner has none. */
  stopProtection: string | null
  accountingVerified: boolean
  /** What the publisher said: needs `accountingVerified` AND a watched stop. */
  verified: boolean
  coverage: { gaps: number; silentNowMs: number | null }
}

/**
 * What the gateway measured when it degraded the block
 * (`server/.../session-validity.ts`). Absent when the block did not go through
 * the gateway: then nothing was measured and nothing is claimed.
 */
export type GatewayReason =
  'report_age_over_limit' | 'report_age_unknown' | 'threshold_missing'
export type GatewayValidity = {
  ageMs: number | null
  reason: GatewayReason | null
}

export type PositionsBlock = {
  schema: typeof POSITIONS_SCHEMA
  mode: string
  evidenceClass: string
  executionClass: string
  clockMs: number
  verification: SessionVerification
  gateway: GatewayValidity | null
  unrealizedUsd: string
  unrealizedClass: string
  positions: SessionPosition[]
}

export type IntervalStage = { state: string }
export type SessionInterval = {
  key: string | null
  productId: string
  strategyId: string
  decidedMs: number | null
  side: string
  signal: IntervalStage
  decision: IntervalStage
  order: IntervalStage & { reasons: string[] }
  trade: IntervalStage & { tradeId: string | null; exitReason: string | null }
}

export type IntervalsBlock = {
  schema: typeof INTERVALS_SCHEMA
  mode: string
  evidenceClass: string
  executionClass: string
  clockMs: number
  /** `complete: false` while a stage (today `signal`) is not filled. */
  contract: { complete: boolean; stagesMissing: string[] }
  intervals: SessionInterval[]
}

function fail(path: string): never {
  throw new Error(`respuesta inesperada: ${path}`)
}
function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path)
  return value
}
function strOrNull(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : str(value, path)
}
function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path)
  return value
}
function numOrNull(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : num(value, path)
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path)
  return value
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path)
  return value as T
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path)
  return value
}
function stage(value: unknown, path: string): IntervalStage {
  return { state: str(record(value).state, `${path}.state`) }
}

function decodeVerification(raw: unknown): SessionVerification {
  const v = record(raw)
  const thresholds = record(v.thresholds)
  const maxAge = numOrNull(
    thresholds.report_max_age_ms,
    'verification.thresholds.report_max_age_ms',
  )
  if (maxAge !== null && maxAge <= 0)
    fail('verification.thresholds.report_max_age_ms')
  return {
    verified: bool(v.verified, 'verification.verified'),
    reasons: list(v.reasons, 'verification.reasons').map((reason, i) =>
      str(reason, `verification.reasons[${i}]`),
    ),
    freshness: oneOf(
      v.freshness,
      ['fresh', 'stale', 'unknown'],
      'verification.freshness',
    ),
    thresholds: {
      reportMaxAgeMs: maxAge,
      status: oneOf(
        thresholds.status,
        ['not_approved', 'hypothesis', 'approved'],
        'verification.thresholds.status',
      ),
    },
  }
}

function decodeGateway(raw: unknown): GatewayValidity | null {
  if (raw === undefined || raw === null) return null
  const g = record(raw)
  const reason =
    g.reason === null || g.reason === undefined
      ? null
      : oneOf(
          g.reason,
          ['report_age_over_limit', 'report_age_unknown', 'threshold_missing'],
          'gateway.reason',
        )
  return { ageMs: numOrNull(g.age_ms, 'gateway.age_ms'), reason }
}

export function decodePositionsBlock(raw: unknown): PositionsBlock {
  const r = record(raw)
  if (r.schema !== POSITIONS_SCHEMA) fail('schema')
  return {
    schema: POSITIONS_SCHEMA,
    mode: str(r.mode, 'mode'),
    evidenceClass: str(r.evidence_class, 'evidence_class'),
    executionClass: str(r.execution_class, 'execution_class'),
    clockMs: num(r.clock_ms, 'clock_ms'),
    verification: decodeVerification(r.verification),
    gateway: decodeGateway(r.gateway),
    unrealizedUsd: str(r.unrealized_usd, 'unrealized_usd'),
    unrealizedClass: str(r.unrealized_class, 'unrealized_class'),
    positions: list(r.positions, 'positions').map((p, i): SessionPosition => {
      const pos = record(p)
      const coverage = record(pos.coverage)
      return {
        intentId: str(pos.intent_id, `positions[${i}].intent_id`),
        productId: str(pos.product_id, `positions[${i}].product_id`),
        strategyId: str(pos.strategy_id, `positions[${i}].strategy_id`),
        side: oneOf(pos.side, ['LONG', 'SHORT'], `positions[${i}].side`),
        entryMs: num(pos.entry_ms, `positions[${i}].entry_ms`),
        entryPrice: str(pos.entry_price, `positions[${i}].entry_price`),
        stop: str(pos.stop, `positions[${i}].stop`),
        target: str(pos.target, `positions[${i}].target`),
        quantity: str(pos.quantity, `positions[${i}].quantity`),
        stopProtection: strOrNull(
          pos.stop_protection,
          `positions[${i}].stop_protection`,
        ),
        accountingVerified: bool(
          pos.accounting_verified,
          `positions[${i}].accounting_verified`,
        ),
        verified: bool(pos.verified, `positions[${i}].verified`),
        coverage: {
          gaps: list(coverage.gaps ?? [], `positions[${i}].coverage.gaps`)
            .length,
          silentNowMs: numOrNull(
            coverage.silent_now_ms,
            `positions[${i}].coverage.silent_now_ms`,
          ),
        },
      }
    }),
  }
}

export function decodeIntervalsBlock(raw: unknown): IntervalsBlock {
  const r = record(raw)
  if (r.schema !== INTERVALS_SCHEMA) fail('schema')
  const contract = record(r.contract)
  return {
    schema: INTERVALS_SCHEMA,
    mode: str(r.mode, 'mode'),
    evidenceClass: str(r.evidence_class, 'evidence_class'),
    executionClass: str(r.execution_class, 'execution_class'),
    clockMs: num(r.clock_ms, 'clock_ms'),
    contract: {
      complete: bool(contract.complete, 'contract.complete'),
      stagesMissing: list(
        contract.stages_missing,
        'contract.stages_missing',
      ).map((s, i) => str(s, `contract.stages_missing[${i}]`)),
    },
    intervals: list(r.intervals, 'intervals').map((v, i): SessionInterval => {
      const row = record(v)
      const stages = record(row.stages)
      const order = record(stages.order)
      const trade = record(stages.trade)
      return {
        key: strOrNull(row.key, `intervals[${i}].key`),
        productId: str(row.product_id, `intervals[${i}].product_id`),
        strategyId: str(row.strategy_id, `intervals[${i}].strategy_id`),
        decidedMs: numOrNull(row.decided_ms, `intervals[${i}].decided_ms`),
        side: str(row.side, `intervals[${i}].side`),
        signal: stage(stages.signal, `intervals[${i}].stages.signal`),
        decision: stage(stages.decision, `intervals[${i}].stages.decision`),
        order: {
          ...stage(order, `intervals[${i}].stages.order`),
          reasons: list(
            order.reasons ?? [],
            `intervals[${i}].stages.order.reasons`,
          ).map((reason, j) =>
            str(reason, `intervals[${i}].stages.order.reasons[${j}]`),
          ),
        },
        trade: {
          ...stage(trade, `intervals[${i}].stages.trade`),
          tradeId: strOrNull(
            trade.trade_id,
            `intervals[${i}].stages.trade.trade_id`,
          ),
          exitReason: strOrNull(
            trade.exit_reason,
            `intervals[${i}].stages.trade.exit_reason`,
          ),
        },
      }
    }),
  }
}
