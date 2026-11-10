import { describe, expect, it } from 'vitest'
import {
  amount,
  compactUsd,
  usd,
  usdFromString,
  madridDateTime,
  madridDateTimeMs,
  madridDateTimeSeconds,
  madridDayTime,
  madridTime,
} from './format.ts'

const plain = (text: string) => text.replace(/\u00a0/g, ' ')

describe('es-ES finance formatting', () => {
  it('formats USD numbers and wire strings the same way', () => {
    expect(plain(usd(1234.5)!)).toBe('1234,50 US$')
    expect(plain(usdFromString('1234.5')!)).toBe('1234,50 US$')
    expect(usdFromString('abc')).toBeNull()
    expect(usd(null)).toBe('—')
  })

  it('formats amounts and compact USD', () => {
    expect(amount(3.14159, 2)).toBe('3,14')
    expect(amount(undefined)).toBe('—')
    expect(compactUsd(null)).toBe('—')
  })
})

describe('Europe/Madrid times', () => {
  it('shows the Madrid wall clock, with winter (UTC+1) and summer (UTC+2) time', () => {
    expect(madridDateTime(Date.UTC(2026, 10, 2, 13, 5))).toBe('2 nov, 14:05')
    expect(madridDateTime(Date.UTC(2026, 6, 1, 12, 5))).toBe('1 jul, 14:05')
  })
  it('crosses midnight in Madrid, not in UTC, and writes 00:xx with 24 h clock', () => {
    expect(madridDateTime(Date.UTC(2026, 9, 30, 23, 45))).toBe('31 oct, 00:45')
  })
  it('writes just the Madrid clock (HH:MM) across both DST changes', () => {
    // Winter (CET, UTC+1) and summer (CEST, UTC+2).
    expect(madridTime(Date.UTC(2026, 0, 15, 9, 7))).toBe('10:07')
    expect(madridTime(Date.UTC(2026, 6, 15, 9, 7))).toBe('11:07')
    // Spring forward, 29 Mar 2026: 01:30 UTC is 03:30 CEST (02:30 never exists).
    expect(madridTime(Date.UTC(2026, 2, 29, 0, 59))).toBe('01:59')
    expect(madridTime(Date.UTC(2026, 2, 29, 1, 0))).toBe('03:00')
    // Fall back, 25 Oct 2026: 00:30 UTC and 01:30 UTC are both 02:30 on the wall clock.
    expect(madridTime(Date.UTC(2026, 9, 25, 0, 30))).toBe('02:30')
    expect(madridTime(Date.UTC(2026, 9, 25, 1, 30))).toBe('02:30')
    expect(madridTime(Date.UTC(2026, 9, 25, 2, 30))).toBe('03:30')
    expect(madridTime(Date.UTC(2026, 9, 30, 23, 5))).toBe('00:05')
  })
  it('shows only the clock for today (in Madrid) and the day before it for older times', () => {
    const now = Date.UTC(2026, 9, 30, 23, 30) // 31 oct 00:30 in Madrid (CET)
    expect(madridDayTime(Date.UTC(2026, 9, 30, 23, 5), now)).toBe('00:05')
    expect(madridDayTime(Date.UTC(2026, 9, 30, 22, 5), now)).toBe(
      '30 oct, 23:05',
    )
    expect(madridDayTime(Date.UTC(2026, 9, 28, 9, 0), now)).toBe(
      '28 oct, 10:00',
    )
  })
  it('writes the full Madrid stamp to the second, with no zone label', () => {
    expect(madridDateTimeSeconds(Date.UTC(2026, 10, 9, 22, 15, 2))).toBe(
      '9/11/2026, 23:15:02',
    )
    expect(madridDateTimeSeconds(Date.UTC(2026, 6, 1, 22, 5, 9))).toBe(
      '2/7/2026, 00:05:09',
    )
  })
})

describe('Madrid record timestamps', () => {
  it('writes the date and the clock to the millisecond in Madrid, in winter and summer', () => {
    expect(madridDateTimeMs(Date.UTC(2027, 0, 15, 7, 58, 30, 123))).toBe(
      '2027-01-15 08:58:30.123',
    )
    expect(madridDateTimeMs(Date.UTC(2026, 6, 14, 22, 0, 0, 7))).toBe(
      '2026-07-15 00:00:00.007',
    )
  })
  it('follows both changes of hour', () => {
    expect(madridDateTimeMs(Date.UTC(2026, 2, 29, 0, 59, 59, 999))).toBe(
      '2026-03-29 01:59:59.999',
    )
    expect(madridDateTimeMs(Date.UTC(2026, 2, 29, 1, 0, 0, 0))).toBe(
      '2026-03-29 03:00:00.000',
    )
    expect(madridDateTimeMs(Date.UTC(2026, 9, 25, 0, 30))).toBe(
      '2026-10-25 02:30:00.000',
    )
    expect(madridDateTimeMs(Date.UTC(2026, 9, 25, 1, 30))).toBe(
      '2026-10-25 02:30:00.000',
    )
  })
})
