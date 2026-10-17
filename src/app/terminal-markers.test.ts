import { describe, expect, it } from 'vitest'
import {
  candleForDecision,
  markerGap,
  markerGapNote,
} from './terminal-markers.ts'

const FIRST = 1_000_000
const entry = (extra: Record<string, unknown> = {}) => ({
  action: 'LONG',
  decision_time_ms: FIRST + 5_000,
  ...extra,
})

describe('markerGap', () => {
  const options = { firstCandleMs: FIRST }

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

  it('writes a note per gap without inventing detail', () => {
    expect(markerGapNote('before_chart')).toBe(
      'Esta decisión no tiene marcador en el gráfico: ocurrió antes de las velas visibles.',
    )
  })
})

describe('candleForDecision', () => {
  // Candles at minutes 0, 1, 3 (a hole at 2), in seconds.
  const candles = [600, 660, 780]
  const at = (ms: number, extra: Record<string, unknown> = {}) => ({
    decision_time_ms: ms,
    ...extra,
  })

  it('finds the candle that covers the instant', () => {
    expect(candleForDecision(candles, at(665_000)).time).toBe(660)
    expect(candleForDecision(candles, at(780_000)).time).toBe(780)
  })

  it('never falls back to an earlier candle across a hole', () => {
    expect(candleForDecision(candles, at(725_000))).toEqual({
      time: null,
      gap: 'no_candle',
    })
  })

  it('does not stick an event after the last candle to it', () => {
    expect(candleForDecision(candles, at(841_000))).toEqual({
      time: null,
      gap: 'after_chart',
    })
  })

  it('prefers the verdict bucket over the decision time', () => {
    expect(
      candleForDecision(candles, at(665_000, { bucket_start_ms: 600_000 }))
        .time,
    ).toBe(600)
  })

  it('never snaps prehistory to the first candle', () => {
    expect(candleForDecision(candles, at(100_000)).time).toBeNull()
  })

  it('names the hole and the late event through markerGap', () => {
    const options = {
      firstCandleMs: 600_000,
      candleSeconds: candles,
    }
    expect(markerGap(at(725_000), options)).toBe('no_candle')
    expect(markerGap(at(841_000), options)).toBe('after_chart')
    expect(markerGap(at(665_000), options)).toBeNull()
  })
})
