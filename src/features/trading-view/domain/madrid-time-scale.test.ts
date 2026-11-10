import { describe, expect, it } from 'vitest'
import {
  fillMadridWeights,
  madridTickLabel,
  madridTickWeight,
} from './madrid-time-scale.ts'

const DAY = 50
const MONTH = 60
const YEAR = 70
const HOUR12 = 33
const HOUR6 = 32
const HOUR1 = 30
// TickMarkType of lightweight-charts: Year, Month, DayOfMonth, Time, TimeWithSeconds.
const TYPE = { year: 0, month: 1, day: 2, time: 3 } as const

const sec = (iso: string) => Date.parse(iso) / 1000

function series(fromIso: string, toIso: string, stepSeconds: number) {
  const points: { originalTime: number; timeWeight: number }[] = []
  for (let t = sec(fromIso); t <= sec(toIso); t += stepSeconds)
    points.push({ originalTime: t, timeWeight: 0 })
  return points
}

const dayStarts = (points: { originalTime: number; timeWeight: number }[]) =>
  points
    .filter((p) => p.timeWeight >= DAY)
    .map((p) => new Date(p.originalTime * 1000).toISOString())

describe('time axis weights follow the Madrid wall clock', () => {
  it('starts the day at Madrid midnight, not UTC midnight, in winter', () => {
    const points = series('2026-01-14T20:00:00Z', '2026-01-15T02:00:00Z', 900)
    fillMadridWeights(points, 0)
    expect(dayStarts(points.slice(1))).toEqual(['2026-01-14T23:00:00.000Z'])
  })

  it('starts the day at Madrid midnight in summer (22:00 UTC)', () => {
    const points = series('2026-07-14T20:00:00Z', '2026-07-15T02:00:00Z', 900)
    fillMadridWeights(points, 0)
    expect(dayStarts(points.slice(1))).toEqual(['2026-07-14T22:00:00.000Z'])
  })

  it('keeps one midnight per Madrid day across the spring change (23 h day)', () => {
    const points = series('2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z', 900)
    fillMadridWeights(points, 0)
    expect(dayStarts(points.slice(1))).toEqual([
      '2026-03-28T23:00:00.000Z', // 29 mar 00:00 CET
      '2026-03-29T22:00:00.000Z', // 30 mar 00:00 CEST
    ])
  })

  it('keeps one midnight per Madrid day across the autumn change (25 h day)', () => {
    const points = series('2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z', 900)
    fillMadridWeights(points, 0)
    expect(dayStarts(points.slice(1))).toEqual([
      '2026-10-24T22:00:00.000Z', // 25 oct 00:00 CEST
      '2026-10-25T23:00:00.000Z', // 26 oct 00:00 CET
    ])
  })

  it('weights months and years at Madrid midnight', () => {
    expect(
      madridTickWeight(
        sec('2026-10-31T23:00:00Z'),
        sec('2026-10-31T22:45:00Z'),
      ),
    ).toBe(MONTH)
    expect(
      madridTickWeight(
        sec('2025-12-31T23:00:00Z'),
        sec('2025-12-31T22:45:00Z'),
      ),
    ).toBe(YEAR)
    // 00:00 UTC is already 01:00 in Madrid: an hour, not a new day.
    expect(
      madridTickWeight(
        sec('2026-11-01T00:00:00Z'),
        sec('2026-10-31T23:45:00Z'),
      ),
    ).toBe(HOUR1)
  })

  it('rounds the intraday weights on Madrid hours, also on the 23 h and 25 h days', () => {
    // 12:00 in Madrid on the spring day is 10:00 UTC (CEST).
    expect(
      madridTickWeight(
        sec('2026-03-29T10:00:00Z'),
        sec('2026-03-29T09:45:00Z'),
      ),
    ).toBe(HOUR12)
    // 06:00 Madrid on the autumn day is 04:00 UTC (CEST until 01:00 UTC, then CET: 05:00 UTC).
    expect(
      madridTickWeight(
        sec('2026-10-25T05:00:00Z'),
        sec('2026-10-25T04:45:00Z'),
      ),
    ).toBe(HOUR6)
  })

  it('does not touch the candle times: only the weights are written', () => {
    const points = series('2026-03-29T00:00:00Z', '2026-03-29T03:00:00Z', 900)
    const before = points.map((p) => p.originalTime)
    fillMadridWeights(points, 0)
    expect(points.map((p) => p.originalTime)).toEqual(before)
  })

  it('only refreshes the weights from the first changed point (live update)', () => {
    const points = series('2026-01-14T22:00:00Z', '2026-01-15T00:00:00Z', 900)
    fillMadridWeights(points, 0)
    const first = points[0]!.timeWeight
    points.push({
      originalTime: points.at(-1)!.originalTime + 900,
      timeWeight: 0,
    })
    fillMadridWeights(points, points.length - 1)
    expect(points[0]!.timeWeight).toBe(first)
    expect(points.at(-1)!.timeWeight).toBeGreaterThan(0)
  })
})

describe('time axis labels in Madrid', () => {
  it('writes the hour of Madrid, on both sides of the changes', () => {
    // 29 mar 2026: 00:30 UTC is 01:30 CET; 01:00 UTC is 03:00 CEST.
    expect(madridTickLabel(sec('2026-03-29T00:30:00Z'), TYPE.time)).toBe(
      '01:30',
    )
    expect(madridTickLabel(sec('2026-03-29T01:00:00Z'), TYPE.time)).toBe(
      '03:00',
    )
    // 25 oct 2026: 00:30 UTC is 02:30 CEST; 01:30 UTC is 02:30 CET.
    expect(madridTickLabel(sec('2026-10-25T00:30:00Z'), TYPE.time)).toBe(
      '02:30',
    )
    expect(madridTickLabel(sec('2026-10-25T01:30:00Z'), TYPE.time)).toBe(
      '02:30',
    )
  })

  it('names the Madrid day, month and year', () => {
    // 28 mar 23:00 UTC is already 29 mar in Madrid.
    expect(madridTickLabel(sec('2026-03-28T23:00:00Z'), TYPE.day)).toBe('29')
    expect(madridTickLabel(sec('2026-10-31T23:00:00Z'), TYPE.month)).toBe('nov')
    expect(madridTickLabel(sec('2025-12-31T23:00:00Z'), TYPE.year)).toBe('2026')
  })
})
