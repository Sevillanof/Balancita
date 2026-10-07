import { describe, expect, it } from 'vitest'
import { expandVariants, parseParamValues } from './variants.ts'
import { validateSpec } from './strategy-spec.ts'
import { C25 } from '../infrastructure/base-strategies.ts'

describe('parseParamValues', () => {
  it('accepts comma or dot decimals separated by semicolons', () => {
    expect(parseParamValues('35; 40;45')).toEqual(['35', '40', '45'])
    expect(parseParamValues('1,5')).toEqual(['1.5'])
    expect(parseParamValues('40; 40')).toEqual(['40'])
  })

  it('rejects empty, non numeric and oversized lists', () => {
    expect(parseParamValues('')).toBeNull()
    expect(parseParamValues('40; abc')).toBeNull()
    expect(parseParamValues('1;2;3;4;5;6;7')).toBeNull()
  })
})

describe('expandVariants', () => {
  it('builds one labelled spec per value without touching the original', () => {
    const variants = expandVariants(C25, 'rsi_min', ['35', '40'])
    expect(variants.map((variant) => variant.label)).toEqual([
      'rsi_min 35',
      'rsi_min 40',
    ])
    expect(variants[1]!.spec.params.rsi_min).toBe('40')
    expect(C25.params.rsi_min).toBe('45')
  })
})

describe('validateSpec', () => {
  it('accepts the base strategies and rejects unknown operands', () => {
    expect(validateSpec(C25).errors).toEqual([])
    const broken = {
      ...C25,
      entry: { LONG: { left: 'os.system', op: '>', right: '1' }, SHORT: null },
    }
    expect(validateSpec(broken).errors).toContain(
      'entry.LONG.left: operando desconocido',
    )
    expect(validateSpec({ schema: 'x' }).spec).toBeNull()
  })
})
