import { basename } from 'node:path'
import { rowOf, withDb, type Opened, type Row } from './observability-health.ts'

/**
 * B6, read-only: stored OFFICIAL Kraken candles of one product and timeframe
 * in a bounded time range, to draw the context chart of a decision.
 *
 *  - `GET /api/observability/candles?product=&interval=&from=&to=&limit=`
 *
 * Every read opens the market SQLite `readOnly` + `query_only`, walks the
 * `(product_id, interval_ms, bucket_start)` primary-key prefix inside the
 * range and closes it. Nothing here writes, derives prices or fills holes: a
 * bucket Kraken never published (capture down, quiet market) is reported in
 * `gaps`, never invented. Prices and volume are the decimal strings stored.
 * The forming candle and the trade-built («observed») candles are not served:
 * only candles already published as closed. A source that cannot be read is
 * `unavailable` and says why; it is still a 200 (the route exists).
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Timeframes the endpoint accepts (label -> ms). Which ones hold data is the capture's business. */
export const CANDLE_INTERVALS = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '4h': 4 * HOUR,
  '1d': 24 * HOUR,
} as const
export type CandleInterval = keyof typeof CANDLE_INTERVALS

export const CANDLES_DEFAULT_LIMIT = 500
/** Most candles one request may return AND most buckets a range may span. */
export const CANDLES_MAX_LIMIT = 1_500
/** Most gap runs listed; the counts stay exact. */
export const CANDLES_MAX_GAPS = 100
export const CANDLES_CACHE_MS = 5_000
const MAX_CACHE_ENTRIES = 64
const MAX_TIME_MS = 8_640_000_000_000_000

export type CandlesErrorCode =
  | 'invalid_product'
  | 'invalid_interval'
  | 'invalid_range'
  | 'range_too_large'
  | 'invalid_limit'

/** A rejected request: the gateway answers 400 with `{ error: { code } }`. */
export class CandlesRequestError extends RangeError {
  readonly code: CandlesErrorCode
  constructor(code: CandlesErrorCode) {
    super(code)
    this.code = code
  }
}

export interface CandlesEvidence {
  readonly source: string
  readonly origin: string | null
  readonly state: 'read' | 'missing' | 'unreadable'
  readonly detail?: string
  readonly rule: string
}

export interface CandleItem {
  readonly bucket_start_ms: number
  /** Exclusive end of the bucket: `bucket_start_ms + interval_ms`. */
  readonly close_at_ms: number
  /** When the first stored revision of this candle became known. */
  readonly known_at_ms: number
  readonly open: string
  readonly high: string
  readonly low: string
  readonly close: string
  readonly volume_btc: string
  /** The bucket ended before `generated_at_ms`. */
  readonly closed: boolean
}

export interface CandleGap {
  /** First missing bucket start. */
  readonly from_ms: number
  /** Exclusive end of the last missing bucket of the run. */
  readonly to_ms: number
  readonly missing: number
}

export type CandlesSection =
  | {
      readonly state: 'ok'
      readonly evidence: CandlesEvidence
      readonly count: number
      /** Aligned buckets in the effective range. */
      readonly expected: number
      /** `expected - count`: buckets with no stored candle (not filled in). */
      readonly missing: number
      readonly gaps: readonly CandleGap[]
      readonly gaps_truncated: boolean
      readonly first_bucket_ms: number | null
      readonly last_bucket_ms: number | null
      /** Null when there are no candles. */
      readonly last_candle_closed: boolean | null
      /** Oldest first. */
      readonly items: readonly CandleItem[]
    }
  | {
      readonly state: 'unavailable'
      readonly evidence: CandlesEvidence
      readonly detail: string
    }

export interface CandlesReport {
  readonly schema: 'observability-candles.v1'
  readonly generated_at_ms: number
  readonly cache_ttl_ms: number
  readonly product: string
  readonly interval: string
  readonly interval_ms: number
  /** Effective range [from_ms, to_ms): `to_ms` is exclusive. */
  readonly from_ms: number
  readonly to_ms: number
  readonly limit: number
  /** More candles matched the range than `limit`: the newest `limit` are served and `from_ms` moved up. */
  readonly truncated: boolean
  readonly candles: CandlesSection
}

export interface CandlesQuery {
  readonly product: string
  readonly interval: string
  readonly from?: string
  readonly to?: string
  readonly limit?: string
}

export interface ObservabilityCandlesOptions {
  readonly products: readonly string[]
  readonly marketDbPath?: string
  readonly clock?: () => number
  readonly cacheMs?: number
}

export interface ObservabilityCandles {
  /** Throws `CandlesRequestError` on a rejected query. */
  report(query: CandlesQuery): CandlesReport
}

export function isCandleInterval(value: unknown): value is CandleInterval {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CANDLE_INTERVALS, value)
  )
}

const INTEGER = /^\d{1,16}$/

function parseTime(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!INTEGER.test(raw)) throw new CandlesRequestError('invalid_range')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_TIME_MS)
    throw new CandlesRequestError('invalid_range')
  return value
}

/** Aligned bucket starts inside `[from, to)`. */
function expectedBuckets(from: number, to: number, step: number): number {
  const first = Math.ceil(from / step) * step
  return first >= to ? 0 : Math.floor((to - 1 - first) / step) + 1
}

const RULE =
  'velas oficiales cerradas de paper_futures_official_candles (primera revisión conocida de cada bucket) con bucket_start en [from_ms, to_ms); los buckets sin vela se listan en gaps y no se rellenan'

function evidenceOf(
  path: string | undefined,
  state: CandlesEvidence['state'],
  detail?: string,
): CandlesEvidence {
  return {
    source: 'paper_futures_official_candles',
    origin: path ? basename(path) : null,
    state,
    ...(detail === undefined ? {} : { detail }),
    rule: RULE,
  }
}

/** Exported so a test can check its query plan. */
export const CANDLES_SQL = `WITH ranked AS (
         SELECT bucket_start, known_at, open_price, high_price, low_price,
           close_price, volume_btc,
           ROW_NUMBER() OVER (
             PARTITION BY bucket_start ORDER BY known_at, rowid
           ) AS revision_rank
         FROM paper_futures_official_candles
         WHERE product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<?
       )
       SELECT * FROM (
         SELECT * FROM ranked WHERE revision_rank=1
         ORDER BY bucket_start DESC LIMIT ?
       ) ORDER BY bucket_start`

function readCandles(
  db: Parameters<Parameters<typeof withDb>[1]>[0],
  product: string,
  intervalMs: number,
  fromMs: number,
  toMs: number,
  limit: number,
): Row[] | 'no_product_column' {
  const columns = db
    .prepare(
      "SELECT name FROM pragma_table_info('paper_futures_official_candles')",
    )
    .all() as Row[]
  if (!columns.some((c) => c.name === 'product_id')) return 'no_product_column'
  // The range rides the primary key (product_id, interval_ms, bucket_start,
  // revision_hash); the window function only ranks revisions of those rows.
  return db
    .prepare(CANDLES_SQL)
    .all(product, intervalMs, fromMs, toMs, limit) as Row[]
}

function gapsOf(
  items: readonly CandleItem[],
  fromMs: number,
  toMs: number,
  step: number,
): { gaps: CandleGap[]; truncated: boolean } {
  const gaps: CandleGap[] = []
  let truncated = false
  let cursor = Math.ceil(fromMs / step) * step
  const push = (start: number, end: number) => {
    if (end <= start) return
    if (gaps.length >= CANDLES_MAX_GAPS) truncated = true
    else
      gaps.push({ from_ms: start, to_ms: end, missing: (end - start) / step })
  }
  for (const item of items) {
    push(cursor, item.bucket_start_ms)
    cursor = item.bucket_start_ms + step
  }
  const last = Math.ceil(toMs / step) * step
  push(cursor, last)
  return { gaps, truncated }
}

export function createObservabilityCandles(
  options: ObservabilityCandlesOptions,
): ObservabilityCandles {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? CANDLES_CACHE_MS
  const cache = new Map<string, { at: number; value: CandlesReport }>()
  return {
    report(query) {
      if (!options.products.includes(query.product))
        throw new CandlesRequestError('invalid_product')
      if (!isCandleInterval(query.interval))
        throw new CandlesRequestError('invalid_interval')
      const step = CANDLE_INTERVALS[query.interval]
      let limit = CANDLES_DEFAULT_LIMIT
      if (query.limit !== undefined) {
        if (!/^\d{1,6}$/.test(query.limit))
          throw new CandlesRequestError('invalid_limit')
        limit = Number(query.limit)
        if (limit < 1 || limit > CANDLES_MAX_LIMIT)
          throw new CandlesRequestError('invalid_limit')
      }
      const now = clock()
      const givenFrom = parseTime(query.from)
      const givenTo = parseTime(query.to)
      // Default `to`: end of the bucket in progress, so repeated calls inside
      // one bucket share a cache entry.
      const toMs = givenTo ?? (Math.floor(now / step) + 1) * step
      const fromMs = givenFrom ?? Math.max(0, toMs - limit * step)
      if (fromMs >= toMs) throw new CandlesRequestError('invalid_range')
      if (expectedBuckets(fromMs, toMs, step) > CANDLES_MAX_LIMIT)
        throw new CandlesRequestError('range_too_large')

      const key = `${query.product}|${step}|${fromMs}|${toMs}|${limit}`
      const hit = cache.get(key)
      if (hit && now - hit.at >= 0 && now - hit.at < cacheMs) return hit.value

      const opened: Opened<Row[] | 'no_product_column'> = withDb(
        options.marketDbPath,
        (db) => readCandles(db, query.product, step, fromMs, toMs, limit),
      )
      const base = {
        schema: 'observability-candles.v1' as const,
        generated_at_ms: now,
        cache_ttl_ms: cacheMs,
        product: query.product,
        interval: query.interval,
        interval_ms: step,
        limit,
      }
      let value: CandlesReport
      if (opened.state !== 'read' || opened.value === 'no_product_column') {
        const detail =
          opened.state !== 'read' ? opened.detail : 'schema_without_product_id'
        value = {
          ...base,
          from_ms: fromMs,
          to_ms: toMs,
          truncated: false,
          candles: {
            state: 'unavailable',
            evidence: evidenceOf(
              options.marketDbPath,
              opened.state === 'read' ? 'unreadable' : opened.state,
              detail,
            ),
            detail,
          },
        }
      } else {
        const items: CandleItem[] = opened.value.map((raw) => {
          const row = rowOf(raw)
          const start = Number(row.bucket_start)
          return {
            bucket_start_ms: start,
            close_at_ms: start + step,
            known_at_ms: Number(row.known_at),
            open: String(row.open_price),
            high: String(row.high_price),
            low: String(row.low_price),
            close: String(row.close_price),
            volume_btc: String(row.volume_btc),
            closed: start + step <= now,
          }
        })
        const expectedAll = expectedBuckets(fromMs, toMs, step)
        // The newest `limit` were kept; if the range is fuller, older ones were cut.
        const truncated = items.length === limit && expectedAll > limit
        const effectiveFrom = truncated ? items[0].bucket_start_ms : fromMs
        const expected = expectedBuckets(effectiveFrom, toMs, step)
        const { gaps, truncated: gapsTruncated } = gapsOf(
          items,
          effectiveFrom,
          toMs,
          step,
        )
        value = {
          ...base,
          from_ms: effectiveFrom,
          to_ms: toMs,
          truncated,
          candles: {
            state: 'ok',
            evidence: evidenceOf(options.marketDbPath, 'read'),
            count: items.length,
            expected,
            missing: expected - items.length,
            gaps,
            gaps_truncated: gapsTruncated,
            first_bucket_ms: items[0]?.bucket_start_ms ?? null,
            last_bucket_ms: items.at(-1)?.bucket_start_ms ?? null,
            last_candle_closed: items.at(-1)?.closed ?? null,
            items,
          },
        }
      }
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, { at: now, value })
      return value
    },
  }
}
