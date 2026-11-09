import { describe, expect, it } from 'vitest'
import {
  amount,
  compactUsd,
  usd,
  usdFromString,
  madridDateTime,
  utcDateTime,
} from './format.ts'

const plain = (text: string) => text.replace(/\u00a0/g, ' ')

describe('es-ES finance formatting', () => {
  it('formats USD numbers and wire strings the same way', () => {
    expect(plain(usd(1234.5)!)).toBe('1234,50 US$')
    expect(plain(usdFromString('1234.5')!)).toBe('1234,50 US$')
    expect(usdFromString('abc')).toBeNull()
    expect(usd(null)).toBe('—')
  })

  it('formats amounts, compact USD and UTC date-times', () => {
    expect(amount(3.14159, 2)).toBe('3,14')
    expect(amount(undefined)).toBe('—')
    expect(compactUsd(null)).toBe('—')
    expect(utcDateTime(0)).toBe('1/1/1970, 0:00:00 UTC')
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
})
