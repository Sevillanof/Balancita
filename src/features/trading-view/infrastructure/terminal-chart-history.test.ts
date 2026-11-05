import { describe, expect, it } from 'vitest'
import { prependFlow, prependHistory } from './terminal-chart-client.ts'

describe('scroll-back history merge', () => {
  it('puts older candles first and drops repeated ones', () => {
    const merged = prependHistory(
      [{ time: 1 }, { time: 2 }, { time: 3 }],
      [{ time: 3 }, { time: 4 }],
    )
    expect(merged.map((c) => c.time)).toEqual([1, 2, 3, 4])
  })
  it('keeps the current series when nothing older came', () => {
    expect(prependHistory([], [{ time: 5 }])).toEqual([{ time: 5 }])
  })
  it('does the same for flow points', () => {
    const point = (time_ms: number) => ({ time_ms }) as never
    expect(
      prependFlow([point(1), point(2)], [point(2), point(3)]).map(
        (p: { time_ms: number }) => p.time_ms,
      ),
    ).toEqual([1, 2, 3])
  })
})
