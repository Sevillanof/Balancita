import { record } from '../../../shared/wire/decode.ts'
import {
  fail,
  getJson,
  integer,
  list,
  maybeInteger,
  maybeText,
  text,
} from './observability-api.ts'

/**
 * B6, read-only (`docs/observabilidad-velas-api.md`): official candles already
 * stored, of one product and interval, in a bounded range. Prices stay the
 * decimal strings the backend sent: they become numbers only to be drawn.
 */
export const CANDLES_URL = '/api-live/observability/candles'
/** Server cap: a range may not span more than this many aligned buckets. */
export const MAX_CANDLE_BUCKETS = 1500

export type CandleItem = {
  bucketStartMs: number
  closeAtMs: number
  knownAtMs: number | null
  open: string
  high: string
  low: string
  close: string
  volumeBtc: string
  closed: boolean
}

export type CandleGap = { fromMs: number; toMs: number; missing: number }

export type CandlesEvidence = {
  source: string
  origin: string | null
  state: string
  detail: string | null
  rule: string
}

export type CandlesBlock =
  | {
      state: 'ok'
      evidence: CandlesEvidence
      count: number
      expected: number
      missing: number
      gaps: CandleGap[]
      gapsTruncated: boolean
      items: CandleItem[]
    }
  | { state: 'unavailable'; evidence: CandlesEvidence; detail: string }

export type CandlesReport = {
  product: string
  interval: string
  intervalMs: number
  limit: number
  fromMs: number
  toMs: number
  truncated: boolean
  generatedAtMs: number
  candles: CandlesBlock
}

function decimal(value: unknown, what: string): string {
  const s = text(value, what)
  return Number.isFinite(Number(s)) && s.trim() !== '' ? s : fail(what)
}

function decodeItem(raw: unknown): CandleItem {
  const c = record(raw)
  return {
    bucketStartMs: integer(c.bucket_start_ms, 'candle.bucket_start_ms'),
    closeAtMs: integer(c.close_at_ms, 'candle.close_at_ms'),
    knownAtMs: maybeInteger(c.known_at_ms),
    open: decimal(c.open, 'candle.open'),
    high: decimal(c.high, 'candle.high'),
    low: decimal(c.low, 'candle.low'),
    close: decimal(c.close, 'candle.close'),
    volumeBtc: decimal(c.volume_btc, 'candle.volume_btc'),
    closed: c.closed === true,
  }
}

export function decodeCandles(raw: unknown): CandlesReport {
  const r = record(raw)
  if (r.schema !== 'observability-candles.v1') fail('schema')
  const c = record(r.candles)
  const e = record(c.evidence)
  const evidence: CandlesEvidence = {
    source: text(e.source, 'evidence.source'),
    origin: maybeText(e.origin),
    state: text(e.state, 'evidence.state'),
    detail: maybeText(e.detail),
    rule: text(e.rule, 'evidence.rule'),
  }
  let candles: CandlesBlock
  if (c.state === 'unavailable')
    candles = {
      state: 'unavailable',
      evidence,
      detail: text(c.detail, 'candles.detail'),
    }
  else if (c.state === 'ok')
    candles = {
      state: 'ok',
      evidence,
      count: integer(c.count, 'candles.count'),
      expected: integer(c.expected, 'candles.expected'),
      missing: integer(c.missing, 'candles.missing'),
      gaps: list(c.gaps, 'candles.gaps').map((g) => {
        const x = record(g)
        return {
          fromMs: integer(x.from_ms, 'gap.from_ms'),
          toMs: integer(x.to_ms, 'gap.to_ms'),
          missing: integer(x.missing, 'gap.missing'),
        }
      }),
      gapsTruncated: c.gaps_truncated === true,
      items: list(c.items, 'candles.items').map(decodeItem),
    }
  else fail('candles.state')
  return {
    product: text(r.product, 'product'),
    interval: text(r.interval, 'interval'),
    intervalMs: integer(r.interval_ms, 'interval_ms'),
    limit: integer(r.limit, 'limit'),
    fromMs: integer(r.from_ms, 'from_ms'),
    toMs: integer(r.to_ms, 'to_ms'),
    truncated: r.truncated === true,
    generatedAtMs: integer(r.generated_at_ms, 'generated_at_ms'),
    candles,
  }
}

export async function fetchCandles(
  query: {
    product: string
    interval: string
    fromMs: number
    toMs: number
  },
  signal: AbortSignal,
): Promise<CandlesReport> {
  const params = new URLSearchParams({
    product: query.product,
    interval: query.interval,
    from: String(query.fromMs),
    to: String(query.toMs),
    limit: String(MAX_CANDLE_BUCKETS),
  })
  return decodeCandles(await getJson(`${CANDLES_URL}?${params}`, signal))
}
