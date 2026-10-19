import { describe, expect, it } from 'vitest'
import {
  formatActiveTime,
  isProtectedStrategy,
} from './lifecycle-text.ts'

describe('formatActiveTime', () => {
  it('says never when it was never active', () => {
    expect(formatActiveTime(0)).toBe('nunca estuvo activa')
  })
  it('writes days and hours, hours and minutes, minutes', () => {
    expect(formatActiveTime(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 días 4 h')
    expect(formatActiveTime(86_400_000)).toBe('1 día')
    expect(formatActiveTime(5 * 3_600_000 + 10 * 60_000)).toBe('5 h 10 min')
    expect(formatActiveTime(12 * 60_000)).toBe('12 min')
    expect(formatActiveTime(30_000)).toBe('menos de 1 min')
  })
})

describe('isProtectedStrategy', () => {
  it('protects Qwen and Kronos only', () => {
    expect(isProtectedStrategy('kronos-small-1h-h4-v1')).toBe(true)
    expect(isProtectedStrategy('c31-qwen-exit-perp-v1')).toBe(true)
    expect(isProtectedStrategy('c29-momentum-perp-v1')).toBe(false)
  })
})
