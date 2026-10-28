/**
 * What an operation could have earned, read from the candles it lived in: the best move in either
 * direction from the entry until a little after the exit, less the cost of going in and out.
 * It is a measure of the decision, not a promise: nobody sells the exact top.
 */

/** Taker in and taker out on Kraken (0,05 % each side). */
export const ROUND_TRIP_COST_BP = 10
/** Below this the right call was to wait: the move would not have paid for the costs. */
export const WORTH_IT_BP = 15
/** How far past the exit the best exit may be, as a share of the time held. */
const AFTER_EXIT_SHARE = 0.25

export type PotentialCandle = {
  time_ms: number
  open: string
  high: string
  low: string
  close: string
}

export type Potential = {
  /** Best net gain available, bp, never below 0. */
  best: number
  /** When that best exit happened; `null` when waiting was right. */
  bestAtMs: number | null
  /** `1` long, `-1` short, `0` wait. */
  right: 1 | 0 | -1
}

const none: Potential = { best: 0, bestAtMs: null, right: 0 }

export function tradePotential(
  candles: PotentialCandle[],
  trade: { entryMs: number; exitMs: number; entryPrice: number | null },
): Potential {
  const until = trade.exitMs + (trade.exitMs - trade.entryMs) * AFTER_EXIT_SHARE
  const inside = candles.filter(
    (candle) => candle.time_ms >= trade.entryMs && candle.time_ms <= until,
  )
  const first = inside[0]
  if (!first) return none
  const entry = trade.entryPrice ?? Number(first.open)
  if (!Number.isFinite(entry) || entry <= 0) return none
  let up = 0
  let upAt = first.time_ms
  let down = 0
  let downAt = first.time_ms
  for (const candle of inside) {
    const high = ((Number(candle.high) - entry) / entry) * 1e4
    const low = ((entry - Number(candle.low)) / entry) * 1e4
    if (high > up) {
      up = high
      upAt = candle.time_ms
    }
    if (low > down) {
      down = low
      downAt = candle.time_ms
    }
  }
  const long = up >= down
  const best = Math.max((long ? up : down) - ROUND_TRIP_COST_BP, 0)
  if (best < WORTH_IT_BP) return { best, bestAtMs: null, right: 0 }
  return { best, bestAtMs: long ? upAt : downAt, right: long ? 1 : -1 }
}
