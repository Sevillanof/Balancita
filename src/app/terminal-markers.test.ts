import { describe, expect, it } from 'vitest'
import { markerGap, markerGapNote } from './terminal-markers.ts'

const FIRST = 1_000_000
const entry = (extra: Record<string, unknown> = {}) => ({
  action: 'LONG',
  decision_time_ms: FIRST + 5_000,
  ...extra,
})

describe('markerGap', () => {
  const options = { firstCandleMs: FIRST, entriesOnly: true }

  it('is null for an entry inside the candles', () => {
    expect(markerGap(entry(), options)).toBeNull()
  })

  it('names each reason a decision has no marker', () => {
    expect(markerGap(entry({ decision_time_ms: undefined }), options)).toBe(
      'no_time',
    )
    expect(markerGap(entry(), { ...options, firstCandleMs: null })).toBe(
      'no_candles',
    )
    // A WAIT is marked now (grouped); it has the same gaps as any verdict.
    expect(markerGap(entry({ action: 'WAIT' }), options)).toBeNull()
    expect(markerGap(entry({ knowledge_lag_ms: 15_001 }), options)).toBe(
      'rebuilt',
    )
    expect(markerGap(entry({ knowledge_lag_ms: 15_000 }), options)).toBeNull()
    expect(markerGap(entry({ decision_time_ms: FIRST - 1 }), options)).toBe(
      'before_chart',
    )
  })

  it('marks every decision with a time when entries are not the only ones', () => {
    const all = { ...options, entriesOnly: false }
    expect(markerGap(entry({ action: 'WAIT' }), all)).toBeNull()
    expect(markerGap(entry({ decision_time_ms: FIRST - 1 }), all)).toBeNull()
  })

  it('writes a note per gap without inventing detail', () => {
    expect(markerGapNote('before_chart')).toBe(
      'Esta decisión no tiene marcador en el gráfico: ocurrió antes de las velas visibles.',
    )
  })
})
