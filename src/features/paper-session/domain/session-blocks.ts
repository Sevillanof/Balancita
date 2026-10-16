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
export type SignalStage = IntervalStage & {
  /** `BUY`, `SELL`, `WAIT`, `HOLD`...: what the signal said, as recorded. */
  action: string | null
  origin: string | null
  seq: number | null
}
export type SessionInterval = {
  key: string | null
  productId: string
  strategyId: string
  decidedMs: number | null
  /** Decision time, or signal generation time when there is no decision: the order key (the array is not chronological). */
  atMs: number | null
  side: string
  signal: SignalStage
  decision: IntervalStage & { decidedMs: number | null }
  order: IntervalStage & { reasons: string[]; entryMs: number | null }
  trade: IntervalStage & { tradeId: string | null; exitReason: string | null }
}

export type IntervalsBlock = {
  schema: typeof INTERVALS_SCHEMA
  mode: string
  evidenceClass: string
  executionClass: string
  clockMs: number
  /** `complete: false` while a stage is not filled or a signal reference is unverified. */
  contract: { complete: boolean; stagesMissing: string[] }
  /** Signal references the publisher could (`verified`) or could not (`unverified`) trace. */
  signalReferences: { verified: number; unverified: unknown[] }
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
    signalReferences: {
      verified: num(
        record(r.signal_references).verified ?? 0,
        'signal_references.verified',
      ),
      unverified: list(
        record(r.signal_references).unverified ?? [],
        'signal_references.unverified',
      ),
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
        atMs: numOrNull(row.at_ms, `intervals[${i}].at_ms`),
        side: str(row.side, `intervals[${i}].side`),
        signal: {
          ...stage(stages.signal, `intervals[${i}].stages.signal`),
          action: strOrNull(
            record(stages.signal).action,
            `intervals[${i}].stages.signal.action`,
          ),
          origin: strOrNull(
            record(stages.signal).origin,
            `intervals[${i}].stages.signal.origin`,
          ),
          seq: numOrNull(
            record(stages.signal).seq,
            `intervals[${i}].stages.signal.seq`,
          ),
        },
        decision: {
          ...stage(stages.decision, `intervals[${i}].stages.decision`),
          decidedMs: numOrNull(
            record(stages.decision).decided_ms,
            `intervals[${i}].stages.decision.decided_ms`,
          ),
        },
        order: {
          ...stage(order, `intervals[${i}].stages.order`),
          entryMs: numOrNull(
            order.entry_ms,
            `intervals[${i}].stages.order.entry_ms`,
          ),
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

export const STATUS_SCHEMA = 'balancita-paper-session-status.v1'

/** The process's own word for its phase; `unverified` and `unavailable` are what the publisher says when it cannot confirm it. */
export const SESSION_PHASES = [
  'INIT',
  'WARMING_UP',
  'LIVE',
  'STOPPING',
  'STOPPED',
  'HALTED',
  'REFUSED',
  'unverified',
  'unavailable',
] as const
export type SessionPhase = (typeof SESSION_PHASES)[number]

export type SessionFunding = {
  /** `synthetic` never verifies a result; `unknown` means nothing was given, which is not "fine". */
  source: 'synthetic' | 'observed' | 'unknown'
  pnlVerified: boolean
  reasons: string[]
  /**
   * The detail the publisher gives for an observed source, kept as it came:
   * `null` is "not given", which is not the same as an empty list (D-229-01).
   */
  incompleteTrades: unknown[] | null
  disputedTrades: unknown[] | null
  quarantinedPeriods: unknown[] | null
  divergenceEvidence: number | null
}

/**
 * What the gateway measured when it degraded the status block. Absent when the
 * block did not go through the gateway: then nothing was measured.
 */
export type StatusGatewayReason =
  | 'heartbeat_age_over_limit'
  | 'heartbeat_age_unknown'
  | 'threshold_missing'
  | 'publication_behind'
export type StatusGatewayValidity = {
  ageMs: number | null
  reason: StatusGatewayReason | null
  /** With `publication_behind`: what the latest heartbeat says, ahead of the document. */
  heartbeatPhase: string | null
}

/**
 * The operating block of the session (`paper_live_publish.session_status`):
 * phase, liveness, stop reason, funding origin. `resources` and `clock` are
 * kept opaque on purpose: this decoder does not interpret them.
 */
export type SessionStatusBlock = {
  schema: typeof STATUS_SCHEMA
  mode: string
  evidenceClass: string
  phase: SessionPhase
  reportedPhase: string | null
  liveness: 'unknown' | 'alive' | 'stale' | 'final'
  reasons: string[]
  /** `null` when the publisher says `unavailable`: then it measured nothing and gives no limit. */
  thresholds: {
    heartbeatMaxAgeMs: number | null
    status: ThresholdStatus
  } | null
  haltReason: string | null
  orderlyStop: Record<string, unknown> | null
  steps: number | null
  observedNowMs: number | null
  pendingOrders: number | null
  openPositions: number | null
  resources: Record<string, unknown> | null
  clock: Record<string, unknown> | null
  funding: SessionFunding
  gateway: StatusGatewayValidity | null
}

function listOrNull(value: unknown, path: string): unknown[] | null {
  return value === null || value === undefined ? null : list(value, path)
}

function decodeStatusGateway(raw: unknown): StatusGatewayValidity | null {
  if (raw === undefined || raw === null) return null
  const g = record(raw)
  const reason =
    g.reason === null || g.reason === undefined
      ? null
      : oneOf(
          g.reason,
          [
            'heartbeat_age_over_limit',
            'heartbeat_age_unknown',
            'threshold_missing',
            'publication_behind',
          ],
          'gateway.reason',
        )
  return {
    ageMs: numOrNull(g.age_ms, 'gateway.age_ms'),
    reason,
    heartbeatPhase: strOrNull(g.heartbeat_phase, 'gateway.heartbeat_phase'),
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : record(value)
}

export function decodeSessionStatus(raw: unknown): SessionStatusBlock {
  const r = record(raw)
  if (r.schema !== STATUS_SCHEMA) fail('schema')
  const rawThresholds =
    r.thresholds === undefined || r.thresholds === null
      ? null
      : record(r.thresholds)
  let thresholds: SessionStatusBlock['thresholds'] = null
  if (rawThresholds) {
    const heartbeatMaxAge = numOrNull(
      rawThresholds.heartbeat_max_age_ms,
      'thresholds.heartbeat_max_age_ms',
    )
    if (heartbeatMaxAge !== null && heartbeatMaxAge <= 0)
      fail('thresholds.heartbeat_max_age_ms')
    thresholds = {
      heartbeatMaxAgeMs: heartbeatMaxAge,
      status: oneOf(
        rawThresholds.status,
        ['not_approved', 'hypothesis', 'approved'],
        'thresholds.status',
      ),
    }
  }
  const funding = record(r.funding)
  const status: SessionStatusBlock = {
    schema: STATUS_SCHEMA,
    mode: str(r.mode, 'mode'),
    evidenceClass: str(r.evidence_class, 'evidence_class'),
    phase: oneOf(r.phase, SESSION_PHASES, 'phase'),
    reportedPhase: strOrNull(r.reported_phase, 'reported_phase'),
    liveness: oneOf(
      r.liveness,
      ['unknown', 'alive', 'stale', 'final'],
      'liveness',
    ),
    reasons: list(r.reasons, 'reasons').map((s, i) => str(s, `reasons[${i}]`)),
    thresholds,
    haltReason: strOrNull(r.halt_reason, 'halt_reason'),
    orderlyStop: recordOrNull(r.orderly_stop),
    steps: numOrNull(r.steps, 'steps'),
    observedNowMs: numOrNull(r.observed_now_ms, 'observed_now_ms'),
    pendingOrders: numOrNull(r.pending_orders, 'pending_orders'),
    openPositions: numOrNull(r.open_positions, 'open_positions'),
    resources: recordOrNull(r.resources),
    clock: recordOrNull(r.clock),
    funding: {
      source: oneOf(
        funding.source,
        ['synthetic', 'observed', 'unknown'],
        'funding.source',
      ),
      pnlVerified: bool(funding.pnl_verified, 'funding.pnl_verified'),
      reasons: list(funding.reasons, 'funding.reasons').map((s, i) =>
        str(s, `funding.reasons[${i}]`),
      ),
      incompleteTrades: listOrNull(
        funding.incomplete_trades,
        'funding.incomplete_trades',
      ),
      disputedTrades: listOrNull(
        funding.disputed_trades,
        'funding.disputed_trades',
      ),
      quarantinedPeriods: listOrNull(
        funding.quarantined_periods,
        'funding.quarantined_periods',
      ),
      divergenceEvidence: numOrNull(
        funding.divergence_evidence,
        'funding.divergence_evidence',
      ),
    },
    gateway: decodeStatusGateway(r.gateway),
  }
  checkStatusInvariants(status)
  return status
}

const ENDED_PHASES: readonly SessionPhase[] = ['STOPPED', 'HALTED', 'REFUSED']

/**
 * Combinations the publisher cannot produce (D-229-02). A block that carries one
 * was altered or came from something else, and it is an error, not a guess:
 * the screen would otherwise show a state nobody can stand behind.
 */
function checkStatusInvariants(s: SessionStatusBlock): void {
  if ((s.phase === 'unverified') !== (s.liveness === 'stale'))
    fail('phase/liveness: unverified and stale go together')
  if (ENDED_PHASES.includes(s.phase) !== (s.liveness === 'final'))
    fail('phase/liveness: final goes with a phase that ended')
  if (s.phase === 'unavailable' && s.liveness !== 'unknown')
    fail('phase/liveness: unavailable is unknown')
  if (s.phase === 'unavailable' ? s.thresholds !== null : s.thresholds === null)
    fail('thresholds: only an unavailable block has none')
  if (
    s.liveness === 'alive' &&
    (s.thresholds?.status !== 'approved' ||
      s.thresholds.heartbeatMaxAgeMs === null)
  )
    fail('liveness: alive needs an approved limit')
  if (s.liveness === 'stale' && s.thresholds?.heartbeatMaxAgeMs == null)
    fail('liveness: stale needs a limit')
  if (s.haltReason !== null && s.phase !== 'HALTED')
    fail('halt_reason: only a halted block has one')
  if (s.funding.pnlVerified && s.funding.source !== 'observed')
    fail('funding: only an observed source can be verified')
  if (s.funding.pnlVerified && s.funding.reasons.length > 0)
    fail('funding: verified with reasons against it')
}

export const BLOCKS_SCHEMA = 'balancita-paper-session-blocks.v1'

/**
 * The document a session leaves for its readers (`paper_live_publish.session_blocks`):
 * the three blocks together. It is derived and has no authority over the
 * session. The writer measures no age; the reader does.
 */
export type SessionBlocksDocument = {
  schema: typeof BLOCKS_SCHEMA
  sessionId: string | null
  configDigest: string | null
  /** The process run that wrote it (its pid): a reader refuses a file of another run. */
  runPid: number | null
  /** One per process start; a pid repeats inside a container. */
  runId: string | null
  observedNowMs: number | null
  steps: number | null
  status: SessionStatusBlock
  positions: PositionsBlock
  intervals: IntervalsBlock
}

export function decodeSessionBlocks(raw: unknown): SessionBlocksDocument {
  const r = record(raw)
  if (r.schema !== BLOCKS_SCHEMA) fail('schema')
  if (r.derived !== true) fail('derived')
  if (r.authority !== 'none') fail('authority')
  if (typeof r.run !== 'object' || r.run === null) fail('run')
  return {
    schema: BLOCKS_SCHEMA,
    sessionId: strOrNull(r.session_id, 'session_id'),
    configDigest: strOrNull(r.config_digest, 'config_digest'),
    runPid: numOrNull(record(r.run).pid, 'run.pid'),
    runId: strOrNull(record(r.run).id, 'run.id'),
    observedNowMs: numOrNull(r.observed_now_ms, 'observed_now_ms'),
    steps: numOrNull(r.steps, 'steps'),
    status: decodeSessionStatus(r.status),
    positions: decodePositionsBlock(r.positions),
    intervals: decodeIntervalsBlock(r.intervals),
  }
}

/**
 * Newest first by `atMs` (decision time, or the signal's generation time when it
 * had no decision). The publisher's array is not chronological (decided rows,
 * then signals without a decision), so its order is not used; rows without a
 * time keep the array order and go last, as the oldest.
 */
export function newestFirst(intervals: SessionInterval[]): SessionInterval[] {
  return intervals
    .map((interval, index) => ({ interval, index }))
    .sort((a, b) => {
      const ta = a.interval.atMs
      const tb = b.interval.atMs
      if (ta !== null && tb !== null && ta !== tb) return tb - ta
      if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1
      return b.index - a.index
    })
    .map((entry) => entry.interval)
}
