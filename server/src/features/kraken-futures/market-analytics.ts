import { createHash } from 'node:crypto'
import {
  readBoundedBody,
  type HistoricalFundingFetch,
} from './historical-funding.ts'

const BASE_URL = 'https://futures.kraken.com/api/charts/v1/analytics'
const PRODUCT_ID = /^PF_[A-Z0-9]{2,20}$/
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const VALUE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Public Kraken Futures analytics series captured for the terminal chart.
 * Each one is a per-bucket aggregate Kraken computes from its own market:
 * - `cvd`: aggressor buy and sell volume (base asset) and their running delta.
 * - `open-interest`: open interest OHLC (contracts = base asset for PF_*).
 * - `liquidation-volume`: liquidated volume (base asset).
 * - `long-short-info`: account counts and percentages long vs short.
 * - `top-traders`: the same split for the top 20 % of accounts by size.
 * - `orderbook`: resting liquidity within 0.05 %…100 % of best and slippage.
 * - `rolling-volatility`: Kraken's rolling realized volatility.
 */
export const ANALYTICS_METRICS = [
  'cvd',
  'open-interest',
  'liquidation-volume',
  'long-short-info',
  'top-traders',
  'orderbook',
  'rolling-volatility',
] as const
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number]

/** Bucket sizes requested: 1m for intraday charts, 1h for 1h/4h/1d charts. */
export const ANALYTICS_INTERVALS = [60_000, 3_600_000] as const
/** Kraken returns at most this many buckets per request (`more` flags the rest). */
export const ANALYTICS_POINTS_PER_REQUEST = 2_000

/** One settled bucket: flat `name -> decimal string` values. */
export type AnalyticsPoint = Readonly<{
  bucketStart: number
  values: Readonly<Record<string, string>>
}>

export type AnalyticsResponse = Readonly<{
  productId: string
  metric: AnalyticsMetric
  intervalMs: number
  fromMs: number
  receivedAtMs: number
  sha256: string
  rawResponse: string
  /** Settled buckets only: the bucket still accumulating is never included. */
  points: readonly AnalyticsPoint[]
}>

export function analyticsUrl(
  productId: string,
  metric: AnalyticsMetric,
  intervalMs: number,
  fromMs: number,
): string {
  if (!PRODUCT_ID.test(productId))
    throw new TypeError('Analytics product is invalid.')
  if (!ANALYTICS_METRICS.includes(metric))
    throw new RangeError('Unsupported analytics metric.')
  if (!(ANALYTICS_INTERVALS as readonly number[]).includes(intervalMs))
    throw new RangeError('Unsupported analytics interval.')
  if (!Number.isSafeInteger(fromMs) || fromMs < 0)
    throw new TypeError('Analytics range is invalid.')
  return `${BASE_URL}/${productId}/${metric}?since=${Math.floor(fromMs / 1000)}&interval=${intervalMs / 1000}`
}

/**
 * Flattens one series value into `name -> decimal string`. Kraken shapes:
 * a scalar per bucket (`value`), an OHLC tuple (`open/high/low/close`), or
 * nested objects of aligned arrays (`bid.liquidity_005`, `top20Percent.longPercent`).
 */
function flatten(
  data: unknown,
  index: number,
  prefix: string,
  out: Record<string, string>,
): void {
  if (Array.isArray(data)) {
    const item: unknown = data[index]
    if (Array.isArray(item)) {
      if (item.length !== 4)
        throw new TypeError('Analytics tuple must be OHLC.')
      ;['open', 'high', 'low', 'close'].forEach((name, position) => {
        out[prefix ? `${prefix}.${name}` : name] = decimal(item[position])
      })
    } else if (item !== null) out[prefix || 'value'] = decimal(item)
    // null: Kraken has no value for this bucket (e.g. no slippage for 1M USD
    // on a thin book); the name is left out rather than invented.
    return
  }
  if (typeof data !== 'object' || data === null)
    throw new TypeError('Analytics data is not a series.')
  for (const [key, value] of Object.entries(data)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key))
      throw new TypeError('Analytics series name is invalid.')
    flatten(value, index, prefix ? `${prefix}.${key}` : key, out)
  }
}

function lengths(data: unknown, found: Set<number>): void {
  if (Array.isArray(data)) found.add(data.length)
  else if (typeof data === 'object' && data !== null)
    for (const value of Object.values(data)) lengths(value, found)
}

/**
 * Validates an analytics response and keeps buckets that closed at least
 * `settleMs` before receipt (Kraken also lists the bucket still filling).
 */
export function parseAnalytics(
  raw: string,
  options: {
    productId: string
    metric: AnalyticsMetric
    intervalMs: number
    fromMs: number
    receivedAtMs: number
    settleMs?: number
  },
): AnalyticsResponse & { more: boolean } {
  const { productId, metric, intervalMs, fromMs, receivedAtMs } = options
  const settleMs = options.settleMs ?? 5_000
  analyticsUrl(productId, metric, intervalMs, fromMs)
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0)
    throw new TypeError('Analytics receipt time is invalid.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES)
    throw new RangeError('Analytics response exceeds 4 MiB.')
  const body: unknown = JSON.parse(raw)
  if (!isRecord(body) || !isRecord(body.result))
    throw new TypeError('Invalid analytics response schema.')
  if (Array.isArray(body.errors) && body.errors.length > 0)
    throw new Error(`Analytics errors: ${JSON.stringify(body.errors)}`)
  const { timestamp, data, more } = body.result
  if (!Array.isArray(timestamp))
    throw new TypeError('Analytics timestamps are missing.')
  const sizes = new Set<number>()
  lengths(data, sizes)
  if (sizes.size !== 1 || !sizes.has(timestamp.length))
    throw new TypeError('Analytics series are not aligned to timestamps.')
  const seen = new Set<number>()
  const points: AnalyticsPoint[] = []
  timestamp.forEach((seconds: unknown, index) => {
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds))
      throw new TypeError('Analytics timestamp is invalid.')
    const bucketStart = seconds * 1000
    if (bucketStart < 0 || bucketStart % intervalMs !== 0)
      throw new TypeError('Analytics timestamp is not interval-aligned.')
    if (seen.has(bucketStart))
      throw new TypeError('Analytics response has a duplicate bucket.')
    seen.add(bucketStart)
    if (bucketStart + intervalMs + settleMs > receivedAtMs) return
    const values: Record<string, string> = {}
    flatten(data, index, '', values)
    points.push({ bucketStart, values })
  })
  points.sort((left, right) => left.bucketStart - right.bucketStart)
  return {
    productId,
    metric,
    intervalMs,
    fromMs,
    receivedAtMs,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    rawResponse: raw,
    points,
    more: more === true,
  }
}

export function createAnalyticsClient(
  options: {
    fetch?: HistoricalFundingFetch
    clock?: () => number
    timeoutMs?: number
    settleMs?: number
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const clock = options.clock ?? Date.now
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const controllers = new Set<AbortController>()
  let closed = false
  return {
    async fetch(
      productId: string,
      metric: AnalyticsMetric,
      intervalMs: number,
      fromMs: number,
    ): Promise<AnalyticsResponse & { more: boolean }> {
      if (closed) throw new Error('Analytics client is closed.')
      const url = analyticsUrl(productId, metric, intervalMs, fromMs)
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Analytics HTTP ${response.status}.`)
        const bytes = await readBoundedBody(
          response,
          MAX_RESPONSE_BYTES,
          'Analytics response',
        )
        return parseAnalytics(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            productId,
            metric,
            intervalMs,
            fromMs,
            receivedAtMs: clock(),
            settleMs: options.settleMs,
          },
        )
      } finally {
        clearTimeout(timeout)
        controllers.delete(controller)
      }
    },
    close(): void {
      closed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}

/** Plain decimal string (Kraken mixes strings and JSON numbers). */
function decimal(value: unknown): string {
  const text =
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof text !== 'string' || !VALUE.test(text))
    throw new TypeError('Analytics value is not a decimal.')
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
