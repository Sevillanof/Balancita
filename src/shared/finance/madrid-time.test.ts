import { describe, expect, it } from 'vitest'
import { madridOffsetMs, madridParts, madridWallToUtc } from './madrid-time.ts'

const HOUR = 3_600_000

const intl = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})

function viaIntl(ms: number) {
  const part = Object.fromEntries(
    intl.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]),
  )
  return {
    year: part.year,
    month: part.month! - 1,
    day: part.day,
    hour: part.hour,
    minute: part.minute,
  }
}

describe('Madrid wall clock', () => {
  it('moves from UTC+1 to UTC+2 at 01:00 UTC on the last Sunday of March', () => {
    expect(madridOffsetMs(Date.UTC(2026, 2, 29, 0, 59, 59))).toBe(HOUR)
    expect(madridOffsetMs(Date.UTC(2026, 2, 29, 1, 0, 0))).toBe(2 * HOUR)
  })

  it('moves back to UTC+1 at 01:00 UTC on the last Sunday of October', () => {
    expect(madridOffsetMs(Date.UTC(2026, 9, 25, 0, 59, 59))).toBe(2 * HOUR)
    expect(madridOffsetMs(Date.UTC(2026, 9, 25, 1, 0, 0))).toBe(HOUR)
  })

  it('agrees with Intl hour by hour around both changes, 2024 to 2032', () => {
    for (let year = 2024; year <= 2032; year += 1) {
      for (const [month, from] of [
        [2, 20],
        [9, 20],
      ] as const) {
        const start = Date.UTC(year, month, from)
        for (let ms = start; ms < start + 16 * 24 * HOUR; ms += HOUR / 2) {
          expect(madridParts(ms), new Date(ms).toISOString()).toEqual(
            viaIntl(ms),
          )
        }
      }
    }
  })

  it('turns a wall time back into the instant, skipping the hour that never exists', () => {
    // 29 Mar 2026: 02:30 does not exist; 03:30 CEST is 01:30 UTC.
    expect(madridWallToUtc(Date.UTC(2026, 2, 29, 2, 30))).toBeNull()
    expect(madridWallToUtc(Date.UTC(2026, 2, 29, 3, 30))).toBe(
      Date.UTC(2026, 2, 29, 1, 30),
    )
    // 25 Oct 2026: 02:30 happens twice; the first one (CEST) is 00:30 UTC.
    expect(madridWallToUtc(Date.UTC(2026, 9, 25, 2, 30))).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    )
    expect(madridWallToUtc(Date.UTC(2026, 9, 25, 3, 30))).toBe(
      Date.UTC(2026, 9, 25, 2, 30),
    )
  })
})
