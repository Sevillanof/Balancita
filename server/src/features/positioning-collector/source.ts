import {
  analyticsUrl,
  parseAnalytics,
  type AnalyticsMetric,
  type AnalyticsPoint,
} from '../kraken-futures/market-analytics.ts'
import {
  readBoundedBody,
  type HistoricalFundingFetch,
} from '../kraken-futures/historical-funding.ts'
import { HOUR_MS, MINUTE_MS, type PremiumRow } from './store.ts'

const PRODUCT_ID = /^PF_[A-Z0-9]{2,20}$/
const MAX_BYTES = 4 * 1024 * 1024
/** Kraken returns at most 2 000 candles per request. */
export const CANDLES_PER_REQUEST = 1_800
const DECIMAL = /^-?\d+(?:\.\d+)?$/

export type PositioningSource = ReturnType<typeof createPositioningSource>

export function candlesUrl(
  kind: 'mark' | 'spot',
  productId: string,
  intervalMs: number,
  fromMs: number,
  toMs: number,
): string {
  if (!PRODUCT_ID.test(productId))
    throw new TypeError('Premium product is invalid.')
  const resolution = intervalMs === MINUTE_MS ? '1m' : '1h'
  if (intervalMs !== MINUTE_MS && intervalMs !== HOUR_MS)
    throw new RangeError('Unsupported premium interval.')
  const base =
    kind === 'mark'
      ? 'https://futures.kraken.com/api/charts/v1/mark'
      : 'https://futures.kraken.com/api/charts/v1/spot'
  return `${base}/${productId}/${resolution}?from=${Math.floor(fromMs / 1000)}&to=${Math.floor(toMs / 1000)}`
}

/** Closes of the closed candles of a mark/spot response, keyed by bucket start. */
export function parseCloses(
  raw: string,
  options: { intervalMs: number; receivedAtMs: number; settleMs: number },
): Map<number, number> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES)
    throw new RangeError('Candles response exceeds 4 MiB.')
  const body: unknown = JSON.parse(raw)
  const candles =
    typeof body === 'object' && body !== null
      ? (body as { candles?: unknown }).candles
      : undefined
  if (!Array.isArray(candles)) throw new TypeError('Invalid candles schema.')
  const closes = new Map<number, number>()
  for (const candle of candles as Record<string, unknown>[]) {
    const time = candle.time
    const close = candle.close
    if (typeof time !== 'number' || !Number.isSafeInteger(time))
      throw new TypeError('Candle time is invalid.')
    if (typeof close !== 'string' || !DECIMAL.test(close))
      throw new TypeError('Candle close is invalid.')
    if (time % options.intervalMs !== 0)
      throw new TypeError('Candle time is not interval-aligned.')
    if (time + options.intervalMs + options.settleMs > options.receivedAtMs)
      continue
    const value = Number(close)
    if (value > 0) closes.set(time, value)
  }
  return closes
}

/** Buckets present in both series; premium in basis points. */
export function premiumRows(
  productId: string,
  intervalMs: number,
  mark: ReadonlyMap<number, number>,
  spot: ReadonlyMap<number, number>,
): PremiumRow[] {
  const rows: PremiumRow[] = []
  for (const [bucketMs, markClose] of mark) {
    const spotClose = spot.get(bucketMs)
    if (spotClose === undefined) continue
    rows.push({
      productId,
      intervalMs,
      bucketMs,
      mark: markClose,
      spot: spotClose,
      premiumBp: ((markClose - spotClose) / spotClose) * 10_000,
    })
  }
  return rows.sort((left, right) => left.bucketMs - right.bucketMs)
}

export function createPositioningSource(
  options: {
    fetch?: HistoricalFundingFetch
    clock?: () => number
    timeoutMs?: number
    settleMs?: number
  } = {},
) {
  const clock = options.clock ?? Date.now
  const timeoutMs = options.timeoutMs ?? 15_000
  const settleMs = options.settleMs ?? 5_000
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const controllers = new Set<AbortController>()
  async function get(url: string): Promise<string> {
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Kraken HTTP ${response.status}.`)
      const bytes = await readBoundedBody(response, MAX_BYTES, 'Response')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }
  return {
    /** Hourly account split (`long-short-info` or `top-traders`) from `fromMs`. */
    async accounts(
      productId: string,
      metric: Extract<AnalyticsMetric, 'long-short-info' | 'top-traders'>,
      fromMs: number,
    ): Promise<{ points: readonly AnalyticsPoint[]; more: boolean }> {
      const raw = await get(analyticsUrl(productId, metric, HOUR_MS, fromMs))
      const parsed = parseAnalytics(raw, {
        productId,
        metric,
        intervalMs: HOUR_MS,
        fromMs,
        receivedAtMs: clock(),
        settleMs,
      })
      return { points: parsed.points, more: parsed.more }
    },
    /** Premium rows of up to one request of candles starting at `fromMs`. */
    async premium(
      productId: string,
      intervalMs: number,
      fromMs: number,
    ): Promise<{ rows: PremiumRow[]; nextFromMs: number; more: boolean }> {
      const now = clock()
      const toMs = Math.min(now, fromMs + CANDLES_PER_REQUEST * intervalMs)
      const read = async (kind: 'mark' | 'spot') =>
        parseCloses(
          await get(candlesUrl(kind, productId, intervalMs, fromMs, toMs)),
          { intervalMs, receivedAtMs: now, settleMs },
        )
      const [mark, spot] = [await read('mark'), await read('spot')]
      return {
        rows: premiumRows(productId, intervalMs, mark, spot),
        nextFromMs: toMs,
        more: toMs < now - intervalMs,
      }
    },
    abortInFlight(): void {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}
