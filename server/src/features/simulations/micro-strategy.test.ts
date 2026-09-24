import { describe, expect, it } from 'vitest'
import { evaluateMicroTarget, initialMicroState } from './micro-strategy.ts'

const readyFeatures = {
  ema9: 12,
  ema21: 11,
  sma50: 10,
  rsi14: 30,
  close: 12,
  bollingerLower: 13,
  bollingerMid: 14,
  atr14: 1,
  priorAtrSma20: 2,
  donchianHigh20: 11,
  donchianMid20: 10,
  volume: 3,
  priorVolumeSma20: 2,
  atrPercentile50: 70,
  ready: true,
} as const

describe('micro strategy target state', () => {
  it('enters/exits candidate 25 by its explicit EMA, price and RSI rules', () => {
    const flat = initialMicroState()
    const long = evaluateMicroTarget('trend-pullback', readyFeatures, flat)
    expect(long.target).toBe('long')
    expect(
      evaluateMicroTarget(
        'trend-pullback',
        { ...readyFeatures, close: 10 },
        long.state,
      ).target,
    ).toBe('flat')
  })

  it('uses trend/range regime hysteresis and starts flat without a regime', () => {
    const initial = initialMicroState()
    expect(
      evaluateMicroTarget('regime-adapter', readyFeatures, initial),
    ).toMatchObject({ target: 'long', state: { regime: 'trend' } })
    const retained = evaluateMicroTarget(
      'regime-adapter',
      { ...readyFeatures, atrPercentile50: 50, close: 10 },
      { exposure: 'long', regime: 'trend' },
    )
    expect(retained.target).toBe('flat')
    expect(retained.state.regime).toBe('trend')
    expect(
      evaluateMicroTarget(
        'regime-adapter',
        { ...readyFeatures, ready: false },
        initial,
      ),
    ).toMatchObject({ target: 'flat', abstained: true })
  })

  it('applies Bollinger regime reversion and prior-volume Donchian breakout rules', () => {
    expect(
      evaluateMicroTarget(
        'bollinger-reversion',
        readyFeatures,
        initialMicroState(),
      ).target,
    ).toBe('long')
    expect(
      evaluateMicroTarget(
        'bollinger-reversion',
        { ...readyFeatures, close: 14 },
        { exposure: 'long', regime: null },
      ).target,
    ).toBe('flat')
    expect(
      evaluateMicroTarget(
        'donchian-breakout',
        readyFeatures,
        initialMicroState(),
      ).target,
    ).toBe('long')
    expect(
      evaluateMicroTarget(
        'donchian-breakout',
        { ...readyFeatures, close: 9 },
        { exposure: 'long', regime: null },
      ).target,
    ).toBe('flat')
    expect(
      evaluateMicroTarget(
        'donchian-breakout',
        { ...readyFeatures, volume: 2.5 },
        initialMicroState(),
      ).target,
    ).toBe('flat')
  })
})
