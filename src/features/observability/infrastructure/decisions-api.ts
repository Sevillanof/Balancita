import { record, type JsonRecord } from '../../../shared/wire/decode.ts'
import {
  fail,
  getJson,
  integer,
  list,
  maybeInteger,
  maybeText,
  section,
  strings,
  text,
  type Section,
} from './observability-api.ts'

/**
 * B3, read-only (`docs/observabilidad-decisiones-api.md`): the verdicts the
 * engine wrote, listed by interval and traced one by one. Like B1 and B2 the
 * decoders keep what the backend said: a field that is not in the payload is
 * `null` (the screen says «No disponible»), a shape that does not match is an
 * error, and nothing is attributed, computed or filled in.
 */
export const DECISIONS_URL = '/api-live/observability/decisions'

export type DecisionItem = {
  product: string
  bucketStartMs: number
  intervalMs: number
  decisionKnownAtMs: number
  regime: string
  action: string
  reasonCode: string
  verdictHash: string
  writtenAtMs: number
  /** Strategy the payload names for the selected proposal; null for discards. */
  selectedStrategyId: string | null
}

export type DecisionsReport = {
  product: string
  fromMs: number
  toMs: number
  limit: number
  filter: { action: string | null; reasonCode: string | null }
  generatedAtMs: number
  decisions: Section<{
    rangeTotal: number
    byAction: { action: string; count: number }[]
    matching: number
    items: DecisionItem[]
    nextCursor: string | null
    notRecorded: string[]
  }>
}

/** A JSON scalar of the payload, kept as the engine wrote it. */
export type Scalar = string | number | boolean | null

export type TraceCondition = {
  code: string
  value: Scalar
  operator: string | null
  threshold: Scalar
  passed: boolean | null
}

export type TraceProposal = {
  strategyId: string
  action: string
  reasonCode: string
  status: string | null
  featureAgeMs: number | null
  /** The strategy the proposal delegates to (C28 adapter), when it says so. */
  delegatedStrategyId: string | null
  invalidation: string | null
  proposedStop: string | null
  proposedTarget: string | null
  estimatedRoundTripCostBps: string | null
  signalKey: string | null
  conditions: TraceCondition[]
}

export type TraceSelected = {
  action: string
  reasonCode: string
  /** Present only when the selector chose a proposal; waits carry none. */
  strategyId: string | null
  /** The chosen proposal itself (stop, target, cost), when the payload has it. */
  proposal: TraceProposal | null
}

export type TraceFeatureSet = { key: string; entries: [string, Scalar][] }

export type TracePayload = {
  schemaVersion: string | null
  closeAtMs: number | null
  decisionKnownAtMs: number | null
  knowledgeLagMs: number | null
  previousRegime: string | null
  regime: string | null
  selected: TraceSelected | null
  /** Null: the payload carries no `proposals` list. */
  proposals: TraceProposal[] | null
  features: TraceFeatureSet[]
}

export type PayloadState = 'ok' | 'unparseable' | 'not_an_object' | 'too_large'

export type TraceEvidence = {
  source: string
  origin: string | null
  state: string
  detail: string | null
  rule: string
}

export type ModelDecision = {
  questionId: string
  questionVersion: number
  questionType: string
  modelRef: string
  chosen: string
  value: number | null
  confidence: number | null
  probabilitySource: string
  /** The stored probabilities by option, as numbers; null if not stored. */
  probabilities: [string, number][] | null
  matchesVerdict: boolean
  writtenAtMs: number
}

export type ModelDecisions =
  | { state: 'ok'; evidence: TraceEvidence; items: ModelDecision[] }
  | { state: 'unavailable'; evidence: TraceEvidence; detail: string }

export type DecisionTrace =
  | {
      state: 'ok'
      product: string
      bucketStartMs: number
      evidence: TraceEvidence
      decision: Omit<DecisionItem, 'selectedStrategyId'>
      payloadState: PayloadState
      payload: TracePayload | null
      /** Columns the payload repeats and contradicts. */
      mismatches: string[]
      modelDecisions: ModelDecisions
      notRecorded: string[]
    }
  | {
      state: 'not_found'
      product: string
      bucketStartMs: number
      evidence: TraceEvidence
    }
  | {
      state: 'unavailable'
      product: string
      bucketStartMs: number
      evidence: TraceEvidence
      detail: string
    }

const PAYLOAD_STATES: readonly string[] = [
  'ok',
  'unparseable',
  'not_an_object',
  'too_large',
]
const FEATURE_KEYS = ['1m', '1m_previous', '5m'] as const

function scalar(value: unknown): Scalar {
  return typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : null
}

function decodeItem(raw: unknown): DecisionItem {
  const r = record(raw)
  return {
    product: text(r.product, 'item.product'),
    bucketStartMs: integer(r.bucket_start_ms, 'item.bucket_start_ms'),
    intervalMs: integer(r.interval_ms, 'item.interval_ms'),
    decisionKnownAtMs: integer(
      r.decision_known_at_ms,
      'item.decision_known_at_ms',
    ),
    regime: text(r.regime, 'item.regime'),
    action: text(r.action, 'item.action'),
    reasonCode: text(r.reason_code, 'item.reason_code'),
    verdictHash: text(r.verdict_hash, 'item.verdict_hash'),
    writtenAtMs: integer(r.written_at_ms, 'item.written_at_ms'),
    selectedStrategyId: maybeText(r.selected_strategy_id),
  }
}

export function decodeDecisions(raw: unknown): DecisionsReport {
  const r = record(raw)
  if (r.schema !== 'observability-decisions.v1') fail('schema')
  const filter = record(r.filter)
  return {
    product: text(r.product, 'product'),
    fromMs: integer(r.from_ms, 'from_ms'),
    toMs: integer(r.to_ms, 'to_ms'),
    limit: integer(r.limit, 'limit'),
    generatedAtMs: integer(r.generated_at_ms, 'generated_at_ms'),
    filter: {
      action: maybeText(filter.action),
      reasonCode: maybeText(filter.reason_code),
    },
    decisions: section(r.decisions, 'decisions', (s) => ({
      rangeTotal: integer(s.range_total, 'range_total'),
      byAction: list(s.by_action, 'by_action').map((item) => {
        const a = record(item)
        return {
          action: text(a.action, 'by_action.action'),
          count: integer(a.count, 'by_action.count'),
        }
      }),
      matching: integer(s.matching, 'matching'),
      items: list(s.items, 'items').map(decodeItem),
      nextCursor: maybeText(s.next_cursor),
      notRecorded: strings(s.not_recorded),
    })),
  }
}

function decodeCondition(raw: unknown): TraceCondition {
  const c = record(raw)
  return {
    code: text(c.code, 'condition.code'),
    value: scalar(c.value),
    operator: maybeText(c.operator),
    threshold: scalar(c.threshold),
    passed: typeof c.passed === 'boolean' ? c.passed : null,
  }
}

function decodeProposal(raw: unknown): TraceProposal {
  const p = record(raw)
  return {
    strategyId: text(p.strategy_id, 'proposal.strategy_id'),
    action: text(p.action, 'proposal.action'),
    reasonCode: text(p.reason_code, 'proposal.reason_code'),
    status: maybeText(p.status),
    featureAgeMs: maybeInteger(p.feature_age_ms),
    delegatedStrategyId: maybeText(p.delegated_strategy_id),
    invalidation: maybeText(p.invalidation),
    proposedStop: maybeText(p.proposed_stop),
    proposedTarget: maybeText(p.proposed_target),
    estimatedRoundTripCostBps: maybeText(p.estimated_round_trip_cost_bps),
    signalKey: maybeText(p.signal_key),
    conditions: Array.isArray(p.conditions)
      ? p.conditions.map(decodeCondition)
      : [],
  }
}

function decodePayload(raw: unknown): TracePayload {
  const p = record(raw)
  const features = record(p.features)
  const selected = p.selected === undefined ? null : record(p.selected)
  return {
    schemaVersion: maybeText(p.schema_version),
    closeAtMs: maybeInteger(p.close_at_ms),
    decisionKnownAtMs: maybeInteger(p.decision_known_at_ms),
    knowledgeLagMs: maybeInteger(p.knowledge_lag_ms),
    previousRegime: maybeText(p.previous_regime),
    regime: maybeText(p.regime),
    selected: selected && {
      action: text(selected.action, 'selected.action'),
      reasonCode: text(selected.reason_code, 'selected.reason_code'),
      strategyId: maybeText(selected.strategy_id),
      proposal:
        typeof selected.strategy_id === 'string'
          ? decodeProposal(selected)
          : null,
    },
    proposals:
      p.proposals === undefined
        ? null
        : list(p.proposals, 'proposals').map(decodeProposal),
    features: FEATURE_KEYS.flatMap((key) => {
      if (features[key] === undefined || features[key] === null) return []
      const set: JsonRecord = record(features[key])
      return [
        {
          key,
          entries: Object.entries(set)
            .filter(
              ([, value]) =>
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean',
            )
            .map(([name, value]): [string, Scalar] => [name, scalar(value)]),
        },
      ]
    }),
  }
}

function decodeTraceEvidence(raw: unknown): TraceEvidence {
  const e = record(raw)
  return {
    source: text(e.source, 'evidence.source'),
    origin: maybeText(e.origin),
    state: text(e.state, 'evidence.state'),
    detail: maybeText(e.detail),
    rule: text(e.rule, 'evidence.rule'),
  }
}

function decodeModel(raw: unknown): ModelDecisions {
  const m = record(raw)
  const evidence = decodeTraceEvidence(m.evidence)
  if (m.state === 'unavailable')
    return { state: 'unavailable', evidence, detail: text(m.detail, 'detail') }
  if (m.state !== 'ok') fail('model_decisions.state')
  return {
    state: 'ok',
    evidence,
    items: list(m.items, 'model_decisions.items').map((item) => {
      const d = record(item)
      const probabilities = record(d.probabilities)
      return {
        questionId: text(d.question_id, 'model.question_id'),
        questionVersion: integer(d.question_version, 'model.question_version'),
        questionType: text(d.question_type, 'model.question_type'),
        modelRef: text(d.model_ref, 'model.model_ref'),
        chosen: text(d.chosen, 'model.chosen'),
        value: maybeInteger(d.value),
        confidence: maybeInteger(d.confidence),
        probabilitySource: text(
          d.probability_source,
          'model.probability_source',
        ),
        probabilities:
          d.probabilities === null || d.probabilities === undefined
            ? null
            : Object.entries(probabilities)
                .filter(([, value]) => typeof value === 'number')
                .map(([name, value]): [string, number] => [
                  name,
                  value as number,
                ]),
        matchesVerdict: d.matches_verdict === true,
        writtenAtMs: integer(d.written_at_ms, 'model.written_at_ms'),
      }
    }),
  }
}

export function decodeTrace(raw: unknown): DecisionTrace {
  const r = record(raw)
  if (r.schema !== 'observability-decision-trace.v1') fail('schema')
  const base = {
    product: text(r.product, 'product'),
    bucketStartMs: integer(r.bucket_start_ms, 'bucket_start_ms'),
    evidence: decodeTraceEvidence(r.evidence),
  }
  if (r.state === 'not_found') return { state: 'not_found', ...base }
  if (r.state === 'unavailable')
    return { state: 'unavailable', ...base, detail: text(r.detail, 'detail') }
  if (r.state !== 'ok') fail('state')
  const { selectedStrategyId: _omit, ...decision } = decodeItem({
    ...record(r.decision),
    selected_strategy_id: null,
  })
  void _omit
  const payloadState = r.payload_state
  if (
    typeof payloadState !== 'string' ||
    !PAYLOAD_STATES.includes(payloadState)
  )
    fail('payload_state')
  return {
    state: 'ok',
    ...base,
    decision,
    payloadState: payloadState as PayloadState,
    payload:
      payloadState === 'ok' && r.payload !== null
        ? decodePayload(r.payload)
        : null,
    mismatches: strings(r.mismatches),
    modelDecisions: decodeModel(r.model_decisions),
    notRecorded: strings(r.not_recorded),
  }
}

export type DecisionsRequest = {
  product: string
  fromMs?: number
  toMs?: number
  limit?: number
  cursor?: string | null
  action?: string | null
  reasonCode?: string | null
}

export async function fetchDecisions(
  request: DecisionsRequest,
  signal: AbortSignal,
): Promise<DecisionsReport> {
  const query = new URLSearchParams({ product: request.product })
  if (request.fromMs !== undefined) query.set('from', String(request.fromMs))
  if (request.toMs !== undefined) query.set('to', String(request.toMs))
  if (request.limit !== undefined) query.set('limit', String(request.limit))
  if (request.cursor) query.set('cursor', request.cursor)
  if (request.action) query.set('action', request.action)
  if (request.reasonCode) query.set('reason_code', request.reasonCode)
  return decodeDecisions(await getJson(`${DECISIONS_URL}?${query}`, signal))
}

export async function fetchTrace(
  product: string,
  bucketStartMs: number,
  signal: AbortSignal,
): Promise<DecisionTrace> {
  return decodeTrace(
    await getJson(
      `${DECISIONS_URL}/${encodeURIComponent(product)}/${bucketStartMs}`,
      signal,
    ),
  )
}
