import { describe, expect, it } from 'vitest'
import { listVariables } from './vectorbt-variation.ts'
import { exampleSpec } from '../testing/vectorbt-fixture.ts'
import type { StrategySpec } from './strategy-spec.ts'
import {
  MAX_VALUES,
  listValues,
  rangeValues,
  toNumberText,
} from './vectorbt-values.ts'
import {
  bpText,
  dayText,
  etaText,
  installCommands,
  shareText,
} from './vectorbt-format.ts'

describe('listVariables', () => {
  it('lists the numeric parameters with readable names and hides internal ones', () => {
    const found = listVariables(exampleSpec())
    const params = found.filter((item) => item.kind === 'param')
    expect(params.map((item) => item.vary)).toEqual([
      'volume_multiplier',
      'stop_atr',
      'target_stop_ratio',
    ])
    expect(params[1]).toMatchObject({
      label: 'Distancia del stop',
      base: '1.5',
      integerOnly: false,
    })
  })

  it('lists the numbers inside entry conditions by the path the server accepts', () => {
    const found = listVariables(exampleSpec())
    const conditions = found.filter((item) => item.kind === 'condition')
    expect(conditions).toHaveLength(1)
    expect(conditions[0]).toMatchObject({
      vary: 'rules.checks[1].node.right',
      base: '50',
      integerOnly: true,
    })
    expect(conditions[0]!.label).toContain('50')
  })

  it('walks all/any/and/not and mul, skipping ±1 factors and the exit rules', () => {
    const spec = exampleSpec()
    spec.rules!.checks = [
      {
        name: 'deep',
        node: {
          all: [
            { available: 'a', operand: '1m.rsi14' },
            {
              not: {
                any: [
                  {
                    and: [
                      {
                        cmp: 'deep_cmp',
                        left: { mul: ['5m.logret72', '-1'] },
                        op: '<',
                        right: { mul: ['3', '1m.atr14'] },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ]
    const found = listVariables(spec).filter(
      (item) => item.kind === 'condition',
    )
    expect(found.map((item) => item.vary)).toEqual([
      'rules.checks[0].node.all[1].not.any[0].and[0].right.mul[0]',
    ])
    expect(found[0]!.base).toBe('3')
  })

  it('uses the branch paths of a regime adapter and names the regime', () => {
    const base = exampleSpec()
    const spec = {
      ...base,
      kind: 'regime_adapter',
      rules: undefined,
      branches: {
        trend: { id: 'x2-trend', rules: base.rules! },
        range: { id: 'x2-range', rules: base.rules! },
      },
    } as StrategySpec
    const found = listVariables(spec).filter(
      (item) => item.kind === 'condition',
    )
    expect(found.map((item) => item.vary)).toEqual([
      'branches.trend.rules.checks[1].node.right',
      'branches.range.rules.checks[1].node.right',
    ])
    expect(found[0]!.label.startsWith('Tendencia')).toBe(true)
    expect(found[1]!.label.startsWith('Rango')).toBe(true)
  })

  it('falls back to a humanized name for a parameter it does not know and skips non-numbers', () => {
    const spec = exampleSpec()
    spec.params = { mi_umbral: '7', modo: 'rapido' }
    const params = listVariables(spec).filter((item) => item.kind === 'param')
    expect(params).toHaveLength(1)
    expect(params[0]!.label).toBe('Mi umbral')
  })
})

describe('values of an exploration', () => {
  it('builds a range without float drift', () => {
    expect(rangeValues('1', '2.5', '0.5')).toMatchObject({
      values: ['1', '1.5', '2', '2.5'],
      count: 4,
      error: null,
    })
    expect(rangeValues('0,1', '0,5', '0,1').values).toEqual([
      '0.1',
      '0.2',
      '0.3',
      '0.4',
      '0.5',
    ])
  })

  it('refuses more than the maximum and says how many would come out', () => {
    const result = rangeValues('1', '20', '1')
    expect(result.values).toEqual([])
    expect(result.count).toBe(20)
    expect(result.error).toContain('20 valores')
    expect(result.error).toContain(String(MAX_VALUES))
    expect(rangeValues('1', '12', '1').values).toHaveLength(MAX_VALUES)
  })

  it('refuses a bad range', () => {
    expect(rangeValues('', '2', '1').error).toMatch(/números/)
    expect(rangeValues('1', '2', '0').error).toMatch(/mayor que cero/)
    expect(rangeValues('3', '2', '1').error).toMatch(/máximo/)
  })

  it('reads a hand list with decimal commas, removes repeats and refuses non-numbers', () => {
    expect(listValues('1; 1,5; 2 ; 1.5').values).toEqual(['1', '1.5', '2'])
    expect(listValues('1; abc').error).toContain('«abc»')
    expect(listValues('  ').error).toMatch(/al menos un valor/)
    const many = Array.from({ length: 13 }, (_, i) => i).join(';')
    expect(listValues(many).error).toContain('13 valores')
  })

  it('writes numbers the way the server does', () => {
    expect(toNumberText('2,50')).toBe('2.5')
    expect(toNumberText('-0')).toBe('0')
    expect(toNumberText('x')).toBeNull()
  })
})

describe('texts', () => {
  it('formats pb, shares, days and time left', () => {
    expect(bpText(-4.25)).toBe('−4,3 pb')
    expect(bpText(null)).toBe('—')
    expect(shareText(0.534)).toBe('53 %')
    expect(dayText('2026-04-19T00:00:00Z')).toBe('19-abr-2026')
    expect(etaText(30)).toBe('menos de 1 min')
    expect(etaText(240)).toBe('unos 4 min')
    expect(etaText(null)).toBeNull()
  })

  it('takes the install commands out of the server message', () => {
    const reason =
      'Falta instalar: ejecutá «uv venv .venv-vectorbt» y después «uv pip install -r x.lock».'
    expect(installCommands(reason)).toEqual([
      'uv venv .venv-vectorbt',
      'uv pip install -r x.lock',
    ])
    expect(installCommands('sin comandos')).toEqual(['sin comandos'])
  })
})
