import { createHash } from 'node:crypto'
import { FUTURES_PRODUCT } from './futures-market.ts'
import {
  readBoundedBody,
  type HistoricalFundingFetch,
} from './historical-funding.ts'

const BASE_URL = `https://futures.kraken.com/api/charts/v1/trade/${FUTURES_PRODUCT}`
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Kraken returns at most this many candles per request. */
export const OFFICIAL_CANDLES_PER_REQUEST = 1_800
const RESOLUTIONS: Readonly<Record<number, string>> = {
  60_000: '1m',
  300_000: '5m',
}
// 5m first: on a 5-minute boundary the closed 5m candle must be known before the 1m candle that closes with it.
export const OFFICIAL_CANDLE_INTERVALS = [300_000, 60_000] as const

/**
 * One closed official Kraken candle. Kraken's convention: open is the
 * previous close and high/low include it; quiet minutes are flat with zero
 * volume, so the series has no gaps.
 */
export type OfficialCandle = Readonly<{
  intervalMs: number
  bucketStart: number
  open: string
  high: string
  low: string
  close: string
  volumeBtc: string
}>

export type OfficialCandleResponse = Readonly<{
  intervalMs: number
  fromMs: number
  toMs: number
  receivedAtMs: number
  sha256: string
  rawResponse: string
  /** Settled closed candles only; the open candle is never included. */
  candles: readonly OfficialCandle[]
}>

export function officialCandlesUrl(
  intervalMs: number,
  fromMs: number,
  toMs: number,
): string {
  const resolution = RESOLUTIONS[intervalMs]
  if (resolution === undefined)
    throw new RangeError('Unsupported official candle interval.')
  for (const value of [fromMs, toMs])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Official candle range is invalid.')
  return `${BASE_URL}/${resolution}?from=${Math.floor(fromMs / 1000)}&to=${Math.floor(toMs / 1000)}`
}

/**
 * Validates a charts response and keeps candles that closed at least
 * `settleMs` before receipt, so a just-closed bucket is not stored while
 * Kraken may still be adding its last trades.
 */
export function parseOfficialCandles(
  raw: string,
  options: {
    intervalMs: number
    fromMs: number
    toMs: number
    receivedAtMs: number
    settleMs?: number
  },
): OfficialCandleResponse {
  const { intervalMs, fromMs, toMs, receivedAtMs } = options
  const settleMs = options.settleMs ?? 2_000
  officialCandlesUrl(intervalMs, fromMs, toMs)
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0)
    throw new TypeError('Official candle receipt time is invalid.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES)
    throw new RangeError('Official candle response exceeds 2 MiB.')
  const body: unknown = JSON.parse(raw)
  if (!isRecord(body) || !Array.isArray(body.candles))
    throw new TypeError('Invalid official candle response schema.')
  const seen = new Set<number>()
  const candles: OfficialCandle[] = []
  for (const item of body.candles) {
    if (!isRecord(item)) throw new TypeError('Invalid official candle.')
    const bucketStart = item.time
    if (
      typeof bucketStart !== 'number' ||
      !Number.isSafeInteger(bucketStart) ||
      bucketStart < 0 ||
      bucketStart % intervalMs !== 0
    )
      throw new TypeError('Official candle time is not interval-aligned.')
    if (seen.has(bucketStart))
      throw new TypeError('Official candle response has a duplicate bucket.')
    seen.add(bucketStart)
    const candle = {
      intervalMs,
      bucketStart,
      open: decimalText(item.open),
      high: decimalText(item.high),
      low: decimalText(item.low),
      close: decimalText(item.close),
      volumeBtc: decimalText(item.volume),
    }
    const [open, high, low, close] = [
      candle.open,
      candle.high,
      candle.low,
      candle.close,
    ].map(Number) as [number, number, number, number]
    if (
      low <= 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      throw new TypeError('Official candle OHLC is inconsistent.')
    if (bucketStart + intervalMs + settleMs <= receivedAtMs)
      candles.push(candle)
  }
  candles.sort((a, b) => a.bucketStart - b.bucketStart)
  return {
    intervalMs,
    fromMs,
    toMs,
    receivedAtMs,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    rawResponse: raw,
    candles,
  }
}

export function createOfficialCandlesClient(
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
      intervalMs: number,
      fromMs: number,
      toMs: number,
    ): Promise<OfficialCandleResponse> {
      if (closed) throw new Error('Official candle client is closed.')
      const url = officialCandlesUrl(intervalMs, fromMs, toMs)
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok)
          throw new Error(`Official candles HTTP ${response.status}.`)
        const bytes = await readBoundedBody(
          response,
          MAX_RESPONSE_BYTES,
          'Official candle response',
        )
        return parseOfficialCandles(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            intervalMs,
            fromMs,
            toMs,
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

/** Plain nonnegative decimal string without trailing fractional zeros. */
function decimalText(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
    throw new TypeError('Official candle value is not a decimal string.')
  let text = value.replace(/^0+(?=\d)/, '')
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
