import { describe, expect, it } from 'vitest'
import { conditionSentence, featurePhrase } from './strategy-spec.ts'

describe('conditionSentence', () => {
  const params = { z_min: '2.5', sqrt_bars: '8.485281' }
  const threshold = { mul: [{ mul: ['5m.logvol288', '$z_min'] }, '$sqrt_bars'] }

  it('names windowed features by their duration', () => {
    expect(featurePhrase('5m.logret72')).toBe('Retorno 6 h')
    expect(featurePhrase('5m.logvol288')).toBe('Volatilidad 24 h')
    expect(featurePhrase('1m.rsi14')).toBe('RSI 14')
    expect(featurePhrase('5m.ema21')).toBe('EMA 21 (5 m)')
  })

  it('reads a momentum threshold as a sentence', () => {
    expect(
      conditionSentence(
        { left: '5m.logret72', op: '>', right: threshold as never },
        params,
      ),
    ).toBe('Retorno 6 h > 2,5 × 8,49 × Volatilidad 24 h')
  })

  it('moves a negated left side to the right', () => {
    expect(
      conditionSentence(
        {
          left: { mul: ['5m.logret72', '-1'] },
          op: '>',
          right: threshold as never,
        },
        params,
      ),
    ).toBe('Retorno 6 h < −2,5 × 8,49 × Volatilidad 24 h')
  })

  it('keeps plain comparisons short', () => {
    expect(conditionSentence({ left: '1m.rsi14', op: '<=', right: '30' })).toBe(
      'RSI 14 ≤ 30',
    )
  })
})
