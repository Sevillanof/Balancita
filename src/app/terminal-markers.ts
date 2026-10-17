/** Why a decision has no marker on the chart; null when it has one. */
export type MarkerGap =
  | 'no_time'
  | 'no_candles'
  | 'rebuilt'
  | 'before_chart'
  | 'no_candle'
  | 'after_chart'

/** Seconds between two candles when the series has fewer than two. */
const DEFAULT_STEP_SECONDS = 60

/**
 * The candle a decision belongs to, or null when the series has none for it.
 * The verifiable bucket is the verdict's own `bucket_start_ms`; without it,
 * the minute of the decision time. The candle must COVER that instant: a hole
 * in the series, or an instant after the last candle, never falls back to an
 * earlier candle. `candleSeconds` is ascending.
 */
export function candleForDecision(
  candleSeconds: readonly number[],
  analysis: Record<string, unknown>,
): { time: number | null; gap: 'no_candle' | 'after_chart' | null } {
  const bucket = Number.isSafeInteger(analysis.bucket_start_ms)
    ? Number(analysis.bucket_start_ms)
    : Number(analysis.decision_time_ms)
  if (!Number.isFinite(bucket) || candleSeconds.length === 0)
    return { time: null, gap: 'no_candle' }
  const seconds = Math.floor(bucket / 1000)
  let step = Infinity
  for (let i = 1; i < candleSeconds.length; i++)
    step = Math.min(step, candleSeconds[i]! - candleSeconds[i - 1]!)
  if (!(step > 0) || !Number.isFinite(step)) step = DEFAULT_STEP_SECONDS
  let low = 0
  let high = candleSeconds.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (candleSeconds[middle]! <= seconds) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  if (found < 0) return { time: null, gap: 'no_candle' }
  const time = candleSeconds[found]!
  if (seconds < time + step) return { time, gap: null }
  return {
    time: null,
    gap: found === candleSeconds.length - 1 ? 'after_chart' : 'no_candle',
  }
}

/** A verdict older than this was rebuilt from a backfill, not decided then. */
const MAX_VERDICT_LAG_MS = 15_000

/**
 * The single rule for which decisions the chart marks. The chart builds its
 * markers from it, and the detail strip names the gap with it, so the two
 * never disagree.
 */
export function markerGap(
  analysis: Record<string, unknown>,
  options: {
    firstCandleMs: number | null
    /** Candle times (seconds, ascending): when given, a missing one is a gap. */
    candleSeconds?: readonly number[]
  },
): MarkerGap | null {
  const time = analysis.decision_time_ms
  if (!Number.isSafeInteger(time)) return 'no_time'
  if (options.firstCandleMs === null) return 'no_candles'
  // Every verdict (LONG, SHORT and WAIT) is marked, WAIT grouped.
  // Rebuilt verdicts were not decisions taken at that time (paper execution
  // ignores them too: max_verdict_lag_ms).
  if (Number(analysis.knowledge_lag_ms) > MAX_VERDICT_LAG_MS) return 'rebuilt'
  // A verdict older than the chart has no candle: do not pile it on the first.
  if (Number(time) < options.firstCandleMs) return 'before_chart'
  if (options.candleSeconds) {
    const { gap } = candleForDecision(options.candleSeconds, analysis)
    // Before the first candle is already said by `before_chart` (live).
    if (gap) return gap
  }
  return null
}

const GAP_TEXT: Record<MarkerGap, string> = {
  no_time: 'no trae hora de decisión',
  no_candles: 'no hay velas verificables en el gráfico',
  rebuilt:
    'se reconstruyó a partir de un backfill y no fue una decisión tomada en ese momento',
  before_chart: 'ocurrió antes de las velas visibles',
  no_candle:
    'no hay vela de su minuto en el gráfico (hueco en las velas); sigue en el historial',
  after_chart: 'ocurrió después de la última vela disponible',
}

export function markerGapNote(gap: MarkerGap): string {
  return `Esta decisión no tiene marcador en el gráfico: ${GAP_TEXT[gap]}.`
}
