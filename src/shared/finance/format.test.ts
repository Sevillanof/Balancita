import { describe, expect, it } from 'vitest'
import {
  amount,
  compactUsd,
  usd,
  usdFromString,
  utcDateTime,
} from './format.ts'

const plain = (text: string) => text.replace(/ /g, ' ')

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
