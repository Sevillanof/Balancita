import { describe, expect, it } from 'vitest'
import {
  addDecimal,
  decimalFromPython,
  isDecimal,
  unrealizedPnl,
} from './decimal-string.ts'

describe('decimal strings', () => {
  it('normalizes Python Decimal text exactly without changing the plain-decimal wire contract', () => {
    expect(decimalFromPython('1.2300E-8')).toBe('0.0000000123')
    expect(decimalFromPython('-0E-27')).toBe('0')
    expect(decimalFromPython('1E+3')).toBe('1000')
    expect(decimalFromPython('NaN')).toBeNull()
    expect(decimalFromPython('1e1000000')).toBeNull()
    expect(isDecimal('1e5')).toBe(false)
  })

  it('adds exactly and normalizes', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3')
    expect(addDecimal('9999.50494555', '0.99')).toBe('10000.49494555')
    expect(addDecimal('1', '-1')).toBe('0')
    expect(addDecimal('-0.5', '0.25')).toBe('-0.25')
    expect(addDecimal('x', '1')).toBeNull()
  })

  it('computes unrealized PnL for a long and a short', () => {
    expect(unrealizedPnl('long', '0.0099', '100011', '100111')).toBe('0.99')
    expect(unrealizedPnl('long', '0.0099', '100011', '99911')).toBe('-0.99')
    expect(unrealizedPnl('short', '0.0099', '100011', '100111')).toBe('-0.99')
    expect(unrealizedPnl('short', '0.0099', '100011.5', '99911.25')).toBe(
      '0.992475',
    )
    expect(unrealizedPnl('long', '1', '5', '5')).toBe('0')
    expect(unrealizedPnl('flat', '1', '5', '6')).toBeNull()
    expect(unrealizedPnl('long', '1', '5', 'NaN')).toBeNull()
  })

  it('recognizes plain decimal text only', () => {
    expect(isDecimal('-12.5')).toBe(true)
    expect(isDecimal('1e5')).toBe(false)
    expect(isDecimal(5)).toBe(false)
  })
})
