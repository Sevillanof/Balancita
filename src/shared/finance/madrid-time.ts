/**
 * Europe/Madrid wall clock by arithmetic, for the places that label thousands of
 * instants a frame (chart axes) or need the calendar parts without building a
 * string. Spain follows the EU rule: UTC+1, and UTC+2 from 01:00 UTC on the last
 * Sunday of March to 01:00 UTC on the last Sunday of October. The test compares
 * every half hour around both changes with `Intl`, which the display formatters
 * in `format.ts` use.
 */

const HOUR_MS = 3_600_000

/** Short Spanish month names, the way the screens write them («3 feb»). */
export const MESES_CORTOS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const

/** 01:00 UTC on the last Sunday of the month. */
function lastSundayChange(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1)
}

/** Milliseconds Madrid is ahead of UTC at that instant: 1 h in winter, 2 h in summer. */
export function madridOffsetMs(ms: number): number {
  const year = new Date(ms).getUTCFullYear()
  const summer =
    ms >= lastSundayChange(year, 2) && ms < lastSundayChange(year, 9)
  return summer ? 2 * HOUR_MS : HOUR_MS
}

/** The Madrid wall clock of an instant, written as if it were UTC (read it with `getUTC*`). */
export function madridWallMs(ms: number): number {
  return ms + madridOffsetMs(ms)
}

/**
 * The instant at which Madrid shows that wall clock (given as if UTC), or null if
 * it never showed it (the hour skipped in spring). An hour that happens twice in
 * autumn gives the first one.
 */
export function madridWallToUtc(wallMs: number): number | null {
  for (const offset of [2 * HOUR_MS, HOUR_MS]) {
    const instant = wallMs - offset
    if (madridOffsetMs(instant) === offset) return instant
  }
  return null
}

export interface MadridParts {
  year: number
  /** 0-11 */
  month: number
  day: number
  hour: number
  minute: number
}

export function madridParts(ms: number): MadridParts {
  const wall = new Date(madridWallMs(ms))
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
  }
}
