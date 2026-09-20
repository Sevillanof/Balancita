import { describe, expect, it } from 'vitest'
import { moneyFromString } from './money'
import { calculateCommission, type FeePolicy, ZERO_FEE_POLICY } from './orders'

const percentageWithMinimum: FeePolicy = {
  id: 'test-percentage-minimum',
  label: 'Escenario de prueba',
  percentage: moneyFromString('0.001'),
  minimum: moneyFromString('2'),
  currency: 'EUR',
}

describe('FeePolicy', () => {
  it('calculates a percentage commission with exact Money arithmetic', () => {
    expect(
      calculateCommission(
        moneyFromString('30000'),
        percentageWithMinimum,
        'EUR',
      ),
    ).toEqual(moneyFromString('30'))
  })

  it('applies the minimum commission when the percentage is lower', () => {
    expect(
      calculateCommission(moneyFromString('100'), percentageWithMinimum, 'EUR'),
    ).toEqual(moneyFromString('2'))
  })

  it('rejects a policy in a different currency', () => {
    expect(() =>
      calculateCommission(moneyFromString('100'), percentageWithMinimum, 'USD'),
    ).toThrow('Fee policy currency does not match the order currency')
  })

  it('supports the documented zero development scenario', () => {
    expect(
      calculateCommission(moneyFromString('30000.125'), ZERO_FEE_POLICY, 'EUR'),
    ).toEqual(moneyFromString('0'))
  })
})
