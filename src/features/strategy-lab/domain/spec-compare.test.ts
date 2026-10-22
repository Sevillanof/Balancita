import { describe, expect, it } from 'vitest'
import { sameRules } from './spec-compare.ts'
import type { StrategySpec } from './strategy-spec.ts'

const base = {
  schema: 'balancita-strategy.v1',
  id: 'c40-x',
  version: 1,
  name: 'Uno',
  params: { a: '1', b: '2' },
} as StrategySpec

describe('sameRules', () => {
  it('ignores id, version, name, description and key order', () => {
    expect(
      sameRules(base, {
        ...base,
        id: 'otro',
        version: 7,
        name: 'Dos',
        description: 'nueva',
        params: { b: '2', a: '1' },
      }),
    ).toBe(true)
  })

  it('sees a changed parameter or an added rule', () => {
    expect(sameRules(base, { ...base, params: { a: '1', b: '3' } })).toBe(false)
    expect(sameRules(base, { ...base, kind: 'regime_adapter' })).toBe(false)
  })
})
