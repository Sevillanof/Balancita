import { basename } from 'node:path'
import {
  num,
  rowOf,
  withDb,
  type Opened,
  type Row,
} from './observability-health.ts'

/**
 * B3, read-only: the verdicts the engine already wrote, one per product and
 * minute (`paper_futures_verdicts`).
 *
 *  - `GET /api/observability/decisions?product=&from=&to=&limit=&cursor=`
 *    lists them newest first WITHOUT their payloads.
 *  - `GET /api/observability/decisions/:product/:bucket` returns one verdict
 *    with its full payload (proposals by strategy, selector, features).
 *
 * Every read opens the SQLite `readOnly` + `query_only`, walks the
 * `(product_id, bucket_start)` primary key inside a bounded range and closes
 * it: nothing here writes, launches or infers. A source that cannot be read is
 * `unavailable` and says why; a missing row is `not_found`, never an empty
 * decision. `reason_code` is the code the engine wrote for the verdict: it is
 * not attributed to a strategy unless the payload itself names one.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const DECISIONS_DEFAULT_SPAN_MS = 3 * HOUR
/** Widest range one request may cover: bounds the rows a filter can scan. */
export const DECISIONS_MAX_SPAN_MS = 7 * 24 * HOUR
export const DECISIONS_DEFAULT_LIMIT = 50
export const DECISIONS_MAX_LIMIT = 200
/** A stored payload larger than this is not parsed nor sent (real ones are KB). */
export const MAX_PAYLOAD_CHARS = 512_000
const MAX_REASON_CHARS = 80
const MAX_CACHE_ENTRIES = 64

export const DECISION_ACTIONS = ['LONG', 'SHORT', 'WAIT', 'ABSTAIN'] as const
export type DecisionAction = (typeof DECISION_ACTIONS)[number]

export type DecisionsErrorCode =
  | 'invalid_product'
  | 'invalid_range'
  | 'range_too_large'
  | 'invalid_limit'
  | 'invalid_cursor'
  | 'invalid_action'
  | 'invalid_reason_code'
  | 'invalid_bucket'

/** A rejected request: the gateway answers 400 with `{ error: { code } }`. */
export class DecisionsRequestError extends RangeError {
  readonly code: DecisionsErrorCode
  constructor(code: DecisionsErrorCode) {
    super(code)
    this.code = code
  }
}

export interface DecisionsEvidence {
  readonly source: string
  readonly origin: string | null
  readonly state: 'read' | 'missing' | 'unreadable'
  readonly detail?: string
  readonly rule: string
}

export interface DecisionItem {
  readonly product: string
  readonly bucket_start_ms: number
  readonly interval_ms: number
  readonly decision_known_at_ms: number
  readonly regime: string
  readonly action: string
  readonly reason_code: string
  readonly verdict_hash: string
  readonly written_at_ms: number
  /**
   * `selected.strategy_id` of the payload, only when the payload names one
   * (a directional proposal). Null for waits and abstentions: their code comes
   * from the selector and is not attributed to a strategy.
   */
  readonly selected_strategy_id: string | null
}

export interface ActionCount {
  readonly action: string
  readonly count: number
}

type Section<T> =
  | ({ readonly state: 'ok'; readonly evidence: DecisionsEvidence } & T)
  | {
      readonly state: 'unavailable'
      readonly evidence: DecisionsEvidence
      readonly detail: string
    }

export interface DecisionsQuery {
  readonly product: string
  readonly fromMs?: number
  readonly toMs?: number
  readonly limit?: number
  readonly cursor?: string
  readonly action?: string
  readonly reasonCode?: string
}

export interface DecisionsReport {
  readonly schema: 'observability-decisions.v1'
  readonly generated_at_ms: number
  readonly cache_ttl_ms: number
  readonly product: string
  readonly from_ms: number
  /** Exclusive upper bound. */
  readonly to_ms: number
  readonly limit: number
  readonly filter: {
    readonly action: string | null
    readonly reason_code: string | null
  }
  readonly decisions: Section<{
    /** Verdicts in the range, whatever the filter. */
    readonly range_total: number
    readonly by_action: readonly ActionCount[]
    /** Verdicts in the range that match the filter. */
    readonly matching: number
    readonly items: readonly DecisionItem[]
    /** Pass it back as `cursor` for the next (older) page; null: no more. */
    readonly next_cursor: string | null
    readonly not_recorded: readonly string[]
  }>
}

export type PayloadState = 'ok' | 'unparseable' | 'not_an_object' | 'too_large'

export interface DecisionRow {
  readonly product: string
  readonly bucket_start_ms: number
  readonly interval_ms: number
  readonly decision_known_at_ms: number
  readonly regime: string
  readonly action: string
  readonly reason_code: string
  readonly verdict_hash: string
  readonly written_at_ms: number
}

export interface ModelDecision {
  readonly question_id: string
  readonly question_version: number
  readonly question_type: string
  readonly model_ref: string
  readonly chosen: string
  readonly value: number | null
  readonly confidence: number | null
  readonly probability_source: string
  /** The stored probabilities, parsed; null if absent, oversized or not JSON. */
  readonly probabilities: unknown
  /** The `verdict_hash` the model row was written against equals this verdict's. */
  readonly matches_verdict: boolean
  readonly written_at_ms: number
}

export type ModelDecisions =
  | {
      readonly state: 'ok'
      readonly evidence: DecisionsEvidence
      /** Empty: the DB was read and has no model row for this minute. */
      readonly items: readonly ModelDecision[]
    }
  | {
      readonly state: 'unavailable'
      readonly evidence: DecisionsEvidence
      readonly detail: string
    }

export type DecisionTrace =
  | {
      readonly schema: 'observability-decision-trace.v1'
      readonly generated_at_ms: number
      readonly cache_ttl_ms: number
      readonly product: string
      readonly bucket_start_ms: number
      readonly state: 'ok'
      readonly evidence: DecisionsEvidence
      readonly decision: DecisionRow
      readonly payload_state: PayloadState
      /** The stored payload exactly as parsed; null unless `payload_state` is ok. */
      readonly payload: Row | null
      /** Columns the payload repeats that do not agree with the row. */
      readonly mismatches: readonly string[]
      /**
       * Model rows stored for this product and minute. Shown by that
       * correlation only: nothing says the model took part in the action.
       */
      readonly model_decisions: ModelDecisions
      readonly not_recorded: readonly string[]
    }
  | {
      readonly schema: 'observability-decision-trace.v1'
      readonly generated_at_ms: number
      readonly cache_ttl_ms: number
      readonly product: string
      readonly bucket_start_ms: number
      /** The source was read and holds no verdict for this product and minute. */
      readonly state: 'not_found'
      readonly evidence: DecisionsEvidence
    }
  | {
      readonly schema: 'observability-decision-trace.v1'
      readonly generated_at_ms: number
      readonly cache_ttl_ms: number
      readonly product: string
      readonly bucket_start_ms: number
      readonly state: 'unavailable'
      readonly evidence: DecisionsEvidence
      readonly detail: string
    }

export interface ObservabilityDecisionsOptions {
  readonly products: readonly string[]
  readonly verdictsDbPath?: string
  /** Decisions DB of the model (Qwen), joined to a verdict by (product, bucket). */
  readonly decisionsDbPath?: string
  readonly cacheMs?: number
  readonly clock?: () => number
}

export interface ObservabilityDecisions {
  /** Throws `DecisionsRequestError` on a request that is not valid. */
  list(query: DecisionsQuery): DecisionsReport
  trace(product: string, bucketStartMs: number): DecisionTrace
}

/**
 * What the verdict store does not persist per decision, so the page cannot show
 * it as data. Listed so that its absence is not read as «nothing happened».
 */
export const NOT_RECORDED: readonly string[] = [
  'libro de órdenes y spread al decidir',
  'funding, flujo y volatilidad de mercado más allá de los indicadores del payload',
  'decisión del modelo en los minutos en que no se lo consultó (solo hay fila si el modelo respondió)',
  'qué participación tuvo el modelo en la acción del selector (la correlación es por producto y minuto)',
  'rechazos del motor de riesgo',
  'operación del forward asociada a este veredicto (B5)',
  'resultado posterior a 15/60/240/1440 min (B3 completo)',
]

function evidenceOf(
  path: string | undefined,
  opened: Opened<unknown>,
  rule: string,
): DecisionsEvidence {
  return {
    source: 'paper_futures_verdicts',
    origin: path ? basename(path) : null,
    state: opened.state,
    ...(opened.state !== 'read' ? { detail: opened.detail } : {}),
    rule,
  }
}

const LIST_RULE =
  'filas de paper_futures_verdicts de un producto con bucket_start en [from, to), más nuevas primero; sin leer el payload salvo selected.strategy_id de las filas devueltas'
const TRACE_RULE =
  'la fila de paper_futures_verdicts con la clave (producto, bucket_start) y su payload_json tal como se guardó'

function isMinuteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const CURSOR = /^\d{1,15}$/

function decisionItem(r: Row): DecisionItem {
  const strategy = r.strategy
  return {
    product: String(r.product_id),
    bucket_start_ms: num(r.bucket_start) ?? 0,
    interval_ms: num(r.interval_ms) ?? 0,
    decision_known_at_ms: num(r.decision_known_at) ?? 0,
    regime: String(r.regime),
    action: String(r.action),
    reason_code: String(r.reason_code),
    verdict_hash: String(r.verdict_hash),
    written_at_ms: num(r.written_at) ?? 0,
    selected_strategy_id:
      typeof strategy === 'string' && strategy !== '' ? strategy : null,
  }
}

interface ListRead {
  readonly rangeTotal: number
  readonly byAction: readonly ActionCount[]
  readonly matching: number
  readonly items: readonly DecisionItem[]
  readonly nextCursor: string | null
}

function readList(
  options: ObservabilityDecisionsOptions,
  q: {
    product: string
    fromMs: number
    toMs: number
    limit: number
    cursor: number | null
    action: string | null
    reason: string | null
  },
): Opened<ListRead> {
  return withDb(options.verdictsDbPath, (db) => {
    const grouped = db
      .prepare(
        `SELECT action, COUNT(*) AS n FROM paper_futures_verdicts
          WHERE product_id = ? AND bucket_start >= ? AND bucket_start < ?
          GROUP BY action ORDER BY action`,
      )
      .all(q.product, q.fromMs, q.toMs) as Row[]
    const byAction = grouped.map((r) => ({
      action: String(r.action),
      count: num(r.n) ?? 0,
    }))
    const rangeTotal = byAction.reduce((sum, a) => sum + a.count, 0)

    // `? IS NULL OR ...` keeps one statement for every filter combination.
    const filter = `product_id = ? AND bucket_start >= ? AND bucket_start < ?
          AND (? IS NULL OR action = ?) AND (? IS NULL OR reason_code = ?)`
    const filterArgs = [
      q.product,
      q.fromMs,
      q.toMs,
      q.action,
      q.action,
      q.reason,
      q.reason,
    ]
    const matching =
      num(
        rowOf(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM paper_futures_verdicts WHERE ${filter}`,
            )
            .get(...filterArgs),
        ).n,
      ) ?? 0
    // SQLite evaluates the payload expression only for the rows it returns.
    const rows = db
      .prepare(
        `SELECT product_id, bucket_start, interval_ms, decision_known_at, regime,
                action, reason_code, verdict_hash, written_at,
                CASE WHEN json_valid(payload_json)
                     THEN json_extract(payload_json, '$.selected.strategy_id') END AS strategy
           FROM paper_futures_verdicts
          WHERE ${filter} AND (? IS NULL OR bucket_start < ?)
          ORDER BY bucket_start DESC LIMIT ?`,
      )
      .all(...filterArgs, q.cursor, q.cursor, q.limit + 1) as Row[]
    const page = rows.slice(0, q.limit).map(decisionItem)
    return {
      rangeTotal,
      byAction,
      matching,
      items: page,
      nextCursor:
        rows.length > q.limit && page.length > 0
          ? String(page[page.length - 1]!.bucket_start_ms)
          : null,
    }
  })
}

/** Columns the payload repeats; a disagreement is reported, never hidden. */
function mismatchesOf(row: DecisionRow, payload: Row): string[] {
  const pairs: [string, unknown, unknown][] = [
    ['product_id', row.product, payload.product_id],
    ['bucket_start_ms', row.bucket_start_ms, payload.bucket_start_ms],
    ['interval_ms', row.interval_ms, payload.interval_ms],
    [
      'decision_known_at_ms',
      row.decision_known_at_ms,
      payload.decision_known_at_ms,
    ],
    ['regime', row.regime, payload.regime],
    ['action', row.action, payload.action],
    ['reason_code', row.reason_code, payload.reason_code],
    ['verdict_hash', row.verdict_hash, payload.verdict_hash],
  ]
  // A field the payload does not carry is absent, not a mismatch.
  return pairs
    .filter(([, , inPayload]) => inPayload !== undefined)
    .filter(([, inRow, inPayload]) => inRow !== inPayload)
    .map(([field]) => field)
}

function readTrace(
  options: ObservabilityDecisionsOptions,
  product: string,
  bucket: number,
): Opened<{
  row: DecisionRow
  payloadState: PayloadState
  payload: Row | null
  mismatches: string[]
} | null> {
  return withDb(options.verdictsDbPath, (db) => {
    const found = db
      .prepare(
        `SELECT product_id, bucket_start, interval_ms, decision_known_at, regime,
                action, reason_code, verdict_hash, written_at, payload_json
           FROM paper_futures_verdicts WHERE product_id = ? AND bucket_start = ?`,
      )
      .get(product, bucket) as Row | undefined
    if (!found) return null
    const item = decisionItem(found)
    const { selected_strategy_id: _ignored, ...row } = item
    void _ignored
    let payloadState: PayloadState = 'ok'
    let payload: Row | null = null
    const raw = found.payload_json
    if (typeof raw !== 'string') payloadState = 'unparseable'
    else if (raw.length > MAX_PAYLOAD_CHARS) payloadState = 'too_large'
    else {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          payload = parsed as Row
        else payloadState = 'not_an_object'
      } catch {
        payloadState = 'unparseable'
      }
    }
    return {
      row,
      payloadState,
      payload,
      mismatches: payload ? mismatchesOf(row, payload) : [],
    }
  })
}

const MAX_MODEL_ROWS = 20
const MAX_PROBABILITIES_CHARS = 8_000

const MODEL_RULE =
  'filas de paper_futures_llm_decisions con la misma clave (producto, bucket_start), sin state_text ni logprobs'

function parseProbabilities(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_PROBABILITIES_CHARS)
    return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Model rows of the same product and minute (primary-key prefix). The heavy
 * columns (prompt text, logprobs, timings) are never selected.
 */
function readModelDecisions(
  options: ObservabilityDecisionsOptions,
  product: string,
  bucket: number,
  verdictHash: string,
): ModelDecisions {
  const opened = withDb(options.decisionsDbPath, (db) =>
    (
      db
        .prepare(
          `SELECT question_id, question_version, question_type, model_ref, chosen, value,
                  confidence, probability_source, probabilities_json, verdict_hash, written_at
             FROM paper_futures_llm_decisions
            WHERE product_id = ? AND bucket_start = ?
            ORDER BY question_id, question_version LIMIT ?`,
        )
        .all(product, bucket, MAX_MODEL_ROWS) as Row[]
    ).map((r): ModelDecision => ({
      question_id: String(r.question_id),
      question_version: num(r.question_version) ?? 0,
      question_type: String(r.question_type),
      model_ref: String(r.model_ref),
      chosen: String(r.chosen),
      value: num(r.value),
      confidence: num(r.confidence),
      probability_source: String(r.probability_source),
      probabilities: parseProbabilities(r.probabilities_json),
      matches_verdict: r.verdict_hash === verdictHash,
      written_at_ms: num(r.written_at) ?? 0,
    })),
  )
  const evidence: DecisionsEvidence = {
    source: 'paper_futures_llm_decisions',
    origin: options.decisionsDbPath ? basename(options.decisionsDbPath) : null,
    state: opened.state,
    ...(opened.state !== 'read' ? { detail: opened.detail } : {}),
    rule: MODEL_RULE,
  }
  return opened.state === 'read'
    ? { state: 'ok', evidence, items: opened.value }
    : { state: 'unavailable', evidence, detail: opened.detail }
}

export function createObservabilityDecisions(
  options: ObservabilityDecisionsOptions,
): ObservabilityDecisions {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 10_000
  const cache = new Map<string, { at: number; value: unknown }>()

  function cached<T>(key: string, now: number, make: () => T): T {
    const hit = cache.get(key)
    if (hit && now - hit.at >= 0 && now - hit.at < cacheMs)
      return hit.value as T
    const value = make()
    cache.delete(key)
    cache.set(key, { at: now, value })
    // Bounded: the oldest entry goes first, so any query mix stays small.
    while (cache.size > MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value as string)
    return value
  }

  function validProduct(product: unknown): string {
    if (typeof product !== 'string' || !options.products.includes(product))
      throw new DecisionsRequestError('invalid_product')
    return product
  }

  return {
    list(query) {
      const product = validProduct(query.product)
      const now = clock()
      const defaultTo = now - (now % MINUTE)
      const toMs = query.toMs ?? defaultTo
      const fromMs = query.fromMs ?? toMs - DECISIONS_DEFAULT_SPAN_MS
      if (!isMinuteInt(toMs) || !isMinuteInt(fromMs) || fromMs >= toMs)
        throw new DecisionsRequestError('invalid_range')
      if (toMs - fromMs > DECISIONS_MAX_SPAN_MS)
        throw new DecisionsRequestError('range_too_large')
      const limit = query.limit ?? DECISIONS_DEFAULT_LIMIT
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > DECISIONS_MAX_LIMIT
      )
        throw new DecisionsRequestError('invalid_limit')
      let cursor: number | null = null
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== 'string' || !CURSOR.test(query.cursor))
          throw new DecisionsRequestError('invalid_cursor')
        cursor = Number(query.cursor)
      }
      if (
        query.action !== undefined &&
        !(DECISION_ACTIONS as readonly string[]).includes(query.action)
      )
        throw new DecisionsRequestError('invalid_action')
      if (
        query.reasonCode !== undefined &&
        (typeof query.reasonCode !== 'string' ||
          query.reasonCode === '' ||
          query.reasonCode.length > MAX_REASON_CHARS)
      )
        throw new DecisionsRequestError('invalid_reason_code')
      const action = query.action ?? null
      const reason = query.reasonCode ?? null
      const key = `list|${product}|${fromMs}|${toMs}|${limit}|${cursor ?? ''}|${action ?? ''}|${reason ?? ''}`
      return cached(key, now, (): DecisionsReport => {
        const opened = readList(options, {
          product,
          fromMs,
          toMs,
          limit,
          cursor,
          action,
          reason,
        })
        const evidence = evidenceOf(options.verdictsDbPath, opened, LIST_RULE)
        return {
          schema: 'observability-decisions.v1',
          generated_at_ms: now,
          cache_ttl_ms: cacheMs,
          product,
          from_ms: fromMs,
          to_ms: toMs,
          limit,
          filter: { action, reason_code: reason },
          decisions:
            opened.state === 'read'
              ? {
                  state: 'ok',
                  evidence,
                  range_total: opened.value.rangeTotal,
                  by_action: opened.value.byAction,
                  matching: opened.value.matching,
                  items: opened.value.items,
                  next_cursor: opened.value.nextCursor,
                  not_recorded: NOT_RECORDED,
                }
              : { state: 'unavailable', evidence, detail: opened.detail },
        }
      })
    },
    trace(product, bucketStartMs) {
      validProduct(product)
      if (!isMinuteInt(bucketStartMs))
        throw new DecisionsRequestError('invalid_bucket')
      const now = clock()
      return cached(
        `trace|${product}|${bucketStartMs}`,
        now,
        (): DecisionTrace => {
          const opened = readTrace(options, product, bucketStartMs)
          const evidence = evidenceOf(
            options.verdictsDbPath,
            opened,
            TRACE_RULE,
          )
          const base = {
            schema: 'observability-decision-trace.v1' as const,
            generated_at_ms: now,
            cache_ttl_ms: cacheMs,
            product,
            bucket_start_ms: bucketStartMs,
          }
          if (opened.state !== 'read')
            return {
              ...base,
              state: 'unavailable',
              evidence,
              detail: opened.detail,
            }
          if (opened.value === null)
            return { ...base, state: 'not_found', evidence }
          return {
            ...base,
            state: 'ok',
            evidence,
            decision: opened.value.row,
            payload_state: opened.value.payloadState,
            payload: opened.value.payload,
            mismatches: opened.value.mismatches,
            model_decisions: readModelDecisions(
              options,
              product,
              bucketStartMs,
              opened.value.row.verdict_hash,
            ),
            not_recorded: NOT_RECORDED,
          }
        },
      )
    },
  }
}

const INTEGER = /^\d{1,15}$/

function single(value: unknown, code: DecisionsErrorCode): string | undefined {
  if (value === undefined) return undefined
  // A repeated parameter arrives as an array: ambiguous, so invalid.
  if (typeof value !== 'string') throw new DecisionsRequestError(code)
  return value
}

function integerParam(
  value: unknown,
  code: DecisionsErrorCode,
): number | undefined {
  const text = single(value, code)
  if (text === undefined) return undefined
  if (!INTEGER.test(text)) throw new DecisionsRequestError(code)
  return Number(text)
}

/** The HTTP query string as a `DecisionsQuery`; invalid values throw 400 codes. */
export function parseDecisionsQuery(
  query: Readonly<Record<string, unknown>>,
): DecisionsQuery {
  const product = single(query.product, 'invalid_product')
  if (product === undefined) throw new DecisionsRequestError('invalid_product')
  return {
    product,
    fromMs: integerParam(query.from, 'invalid_range'),
    toMs: integerParam(query.to, 'invalid_range'),
    limit: integerParam(query.limit, 'invalid_limit'),
    cursor: single(query.cursor, 'invalid_cursor'),
    action: single(query.action, 'invalid_action'),
    reasonCode: single(query.reason_code, 'invalid_reason_code'),
  }
}

/** The `:bucket` path segment: digits only. */
export function parseBucket(value: string): number {
  if (!INTEGER.test(value)) throw new DecisionsRequestError('invalid_bucket')
  return Number(value)
}
