import { analysisAction } from './terminal-labels.ts'

/** Why a decision has no marker on the chart; null when it has one. */
export type MarkerGap =
  'no_time' | 'no_candles' | 'wait' | 'rebuilt' | 'before_chart'

/** A verdict older than this was rebuilt from a backfill, not decided then. */
const MAX_VERDICT_LAG_MS = 15_000

/**
 * The single rule for which decisions the chart marks. The chart builds its
 * markers from it, and the detail strip names the gap with it, so the two
 * never disagree.
 */
export function markerGap(
  analysis: Record<string, unknown>,
  options: { firstCandleMs: number | null; entriesOnly: boolean },
): MarkerGap | null {
  const time = analysis.decision_time_ms
  if (!Number.isSafeInteger(time)) return 'no_time'
  if (options.firstCandleMs === null) return 'no_candles'
  if (options.entriesOnly) {
    const action = analysisAction(analysis)
    if (action !== 'LONG' && action !== 'SHORT') return 'wait'
    // Rebuilt verdicts were not decisions taken at that time (paper execution
    // ignores them too: max_verdict_lag_ms).
    if (Number(analysis.knowledge_lag_ms) > MAX_VERDICT_LAG_MS) return 'rebuilt'
    // A verdict older than the chart has no candle: do not pile it on the first.
    if (Number(time) < options.firstCandleMs) return 'before_chart'
  }
  return null
}

const GAP_TEXT: Record<MarkerGap, string> = {
  no_time: 'no trae hora de decisión',
  no_candles: 'no hay velas verificables en el gráfico',
  wait: 'solo las entradas LONG/SHORT se marcan',
  rebuilt:
    'se reconstruyó a partir de un backfill y no fue una decisión tomada en ese momento',
  before_chart: 'ocurrió antes de las velas visibles',
}

export function markerGapNote(gap: MarkerGap): string {
  return `Esta decisión no tiene marcador en el gráfico: ${GAP_TEXT[gap]}.`
}
