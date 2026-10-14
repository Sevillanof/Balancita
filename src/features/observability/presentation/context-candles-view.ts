import {
  MAX_CANDLE_BUCKETS,
  type CandlesReport,
} from '../infrastructure/candles-api.ts'

/** Buckets drawn on each side of the decision's own bucket. */
export const CONTEXT_BUCKETS_EACH_SIDE = 60

/** Intervals tried in order: the decision interval first, then a coarser one. */
export const CONTEXT_INTERVALS = [
  { id: '1m', ms: 60_000 },
  { id: '5m', ms: 300_000 },
] as const

/**
 * The range asked for: N buckets before the decision's bucket and N after,
 * never past the last closed bucket (the one still forming has no candle yet,
 * which is not an error) and never over the server's bucket cap.
 */
export function contextRange(
  decisionBucketMs: number,
  intervalMs: number,
  nowMs: number,
): { fromMs: number; toMs: number } {
  const bucket = Math.floor(decisionBucketMs / intervalMs) * intervalMs
  const lastClosedEnd = Math.floor(nowMs / intervalMs) * intervalMs
  const fromMs = bucket - CONTEXT_BUCKETS_EACH_SIDE * intervalMs
  const wantedTo = bucket + (CONTEXT_BUCKETS_EACH_SIDE + 1) * intervalMs
  const toMs = Math.max(
    Math.min(wantedTo, lastClosedEnd),
    bucket + intervalMs, // at least the decision's own bucket
  )
  if ((toMs - fromMs) / intervalMs > MAX_CANDLE_BUCKETS)
    throw new Error('context range over the bucket cap')
  return { fromMs, toMs }
}

export type DrawnCandle = {
  /** Seconds, as the chart wants them. */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Observed after the decision's bucket (shown muted). */
  after: boolean
}

export type ContextSeries = {
  /** Only the candles the backend served, strings turned to numbers to draw. */
  candles: DrawnCandle[]
  /** Aligned buckets of the range with no candle: drawn as empty space. */
  gapTimes: number[]
  gapRuns: number
  /** Bucket of the decision, aligned to the drawn interval, in seconds. */
  markerTime: number
  /** Whether a candle exists at that bucket (the marker needs one). */
  decisionCandle: boolean
  afterCount: number
}

/**
 * What to draw from a candles answer. Nothing is filled in: a bucket with no
 * item is empty space, never a copy of its neighbour, and no figure is computed
 * from the candles (no range, drawdown or result after the decision).
 */
export function contextSeries(
  report: CandlesReport,
  decisionBucketMs: number,
): ContextSeries | null {
  if (report.candles.state !== 'ok') return null
  const step = report.intervalMs
  const bucket = Math.floor(decisionBucketMs / step) * step
  const present = new Set<number>()
  const candles = report.candles.items.map((item): DrawnCandle => {
    present.add(item.bucketStartMs)
    return {
      time: item.bucketStartMs / 1000,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      after: item.bucketStartMs > bucket,
    }
  })
  const gapTimes: number[] = []
  let gapRuns = 0
  let previousWasGap = false
  const first = Math.ceil(report.fromMs / step) * step
  for (let t = first; t < report.toMs; t += step) {
    const missing = !present.has(t)
    if (missing) {
      gapTimes.push(t / 1000)
      if (!previousWasGap) gapRuns += 1
    }
    previousWasGap = missing
  }
  return {
    candles,
    gapTimes,
    gapRuns,
    markerTime: bucket / 1000,
    decisionCandle: present.has(bucket),
    afterCount: candles.filter((c) => c.after).length,
  }
}
