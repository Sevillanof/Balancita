import { describe, expect, it } from 'vitest'
import {
  MONEY_ZERO,
  MoneyDivideByZeroError,
  MoneyParseError,
  moneyAdd,
  moneyDiv,
  moneyFromNumber,
  moneyFromString,
  moneyGt,
  moneyGte,
  moneyIsZero,
  moneyLt,
  moneyLte,
  moneyMul,
  moneyRound,
  moneySub,
  moneyToDecimalString,
  moneyToNumber,
} from './money.ts'

describe('fixed-point decimal money', () => {
  it('adds without float error: 0.1 + 0.2 === 0.3', () => {
    expect(moneyAdd(moneyFromString('0.1'), moneyFromString('0.2'))).toEqual(
      moneyFromString('0.3'),
    )
  })

  it('parses the float 0.1 + 0.2 result as 0.3 at the boundary', () => {
    expect(moneyFromNumber(0.1 + 0.2)).toEqual(moneyFromString('0.3'))
  })

  it('subtracts exactly: 0.3 - 0.1 === 0.2', () => {
    expect(moneySub(moneyFromString('0.3'), moneyFromString('0.1'))).toEqual(
      moneyFromString('0.2'),
    )
  })

  it('multiplies exactly: 0.1 * 0.2 === 0.02', () => {
    expect(moneyMul(moneyFromString('0.1'), moneyFromString('0.2'))).toEqual(
      moneyFromString('0.02'),
    )
  })

  it('multiplies whole values exactly', () => {
    expect(moneyMul(moneyFromString('2.5'), moneyFromString('4'))).toEqual(
      moneyFromString('10'),
    )
  })

  it('divides exactly when representable', () => {
    expect(moneyDiv(moneyFromString('10'), moneyFromString('4'))).toEqual(
      moneyFromString('2.5'),
    )
  })

  it('divides rounding half away from zero at scale 8', () => {
    expect(moneyDiv(moneyFromString('1'), moneyFromString('3'))).toEqual(
      moneyFromString('0.33333333'),
    )
  })

  it('throws a typed error on division by zero', () => {
    expect(() => moneyDiv(moneyFromString('1'), MONEY_ZERO)).toThrow(
      MoneyDivideByZeroError,
    )
  })

  it('rounds to cash at 2 decimal places, half up', () => {
    expect(moneyRound(moneyFromString('1.005'))).toEqual(
      moneyFromString('1.01'),
    )
    expect(moneyRound(moneyFromString('1.004'))).toEqual(
      moneyFromString('1.00'),
    )
    expect(moneyRound(moneyFromString('100000'))).toEqual(
      moneyFromString('100000'),
    )
  })

  it('compares exact decimal values regardless of trailing zeros', () => {
    expect(moneyLt(moneyFromString('0.1'), moneyFromString('0.2'))).toBe(true)
    expect(moneyGt(moneyFromString('0.2'), moneyFromString('0.1'))).toBe(true)
    expect(moneyLte(moneyFromString('0.10'), moneyFromString('0.1'))).toBe(true)
    expect(moneyGte(moneyFromString('0.1'), moneyFromString('0.10'))).toBe(true)
    expect(moneyGt(moneyFromString('0.01001'), moneyFromString('0.01'))).toBe(
      true,
    )
  })

  it('reports zero equality', () => {
    expect(moneyIsZero(MONEY_ZERO)).toBe(true)
    expect(moneyIsZero(moneyFromString('0'))).toBe(true)
    expect(moneyIsZero(moneyFromString('0.001'))).toBe(false)
  })

  it('serializes to a canonical decimal string', () => {
    expect(moneyToDecimalString(moneyFromString('0.5'))).toBe('0.5')
    expect(moneyToDecimalString(moneyFromString('60000'))).toBe('60000')
    expect(moneyToDecimalString(moneyFromString('151.25'))).toBe('151.25')
    expect(moneyToDecimalString(moneyFromString('0.10'))).toBe('0.1')
    expect(moneyToDecimalString(moneyFromString('0.00000001'))).toBe(
      '0.00000001',
    )
    expect(moneyToDecimalString(moneyFromString('-3.5'))).toBe('-3.5')
  })

  it('round-trips through its decimal string form', () => {
    const values = ['0.1', '1', '99999.99', '0.00000001', '123456789.12345678']
    for (const value of values) {
      const money = moneyFromString(value)
      expect(moneyFromString(moneyToDecimalString(money))).toEqual(money)
    }
  })

  it('converts to a display number without losing typical values', () => {
    expect(moneyToNumber(moneyFromString('123456789.12'))).toBeCloseTo(
      123456789.12,
      6,
    )
    expect(moneyToNumber(moneyFromString('0.00000001'))).toBeCloseTo(0.00000001)
  })

  it('rejects malformed decimal strings with a typed error', () => {
    for (const bad of [
      '',
      '   ',
      'abc',
      '1.',
      '1.2.3',
      '--1',
      '0.123456789',
      '1e9999999999',
    ]) {
      expect(() => moneyFromString(bad)).toThrow(MoneyParseError)
    }
  })

  it('parses scientific notation to exact decimal', () => {
    expect(moneyFromString('1e2')).toEqual(moneyFromString('100'))
    expect(moneyFromString('1.5e1')).toEqual(moneyFromString('15'))
  })

  it('rejects non-finite boundary numbers', () => {
    expect(() => moneyFromNumber(NaN)).toThrow(MoneyParseError)
    expect(() => moneyFromNumber(Infinity)).toThrow(MoneyParseError)
  })
})
