import { describe, expect, it } from 'vitest'
import {
  evaluateC27Exit,
  evaluateC27ExitWithMacroContext,
  evaluateMicroTarget,
  initialMicroState,
} from './micro-strategy.ts'

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
  it('applies C27 close-only exit thresholds in priority order with causal hold bars', () => {
    const input = {
      entryPrice: 100,
      close: 100.8,
      donchianMid: 99,
      barsHeld: 29,
    }
    expect(evaluateC27Exit(input)).toBe('take-profit')
    expect(evaluateC27Exit({ ...input, close: 100.3 })).toBe('hold')
    expect(evaluateC27Exit({ ...input, close: 100.299, barsHeld: 9 })).toBe(
      'hold',
    )
    expect(evaluateC27Exit({ ...input, close: 100.299, barsHeld: 29 })).toBe(
      'hold',
    )
    expect(evaluateC27Exit({ ...input, close: 100.299, barsHeld: 30 })).toBe(
      'time-stop',
    )
    expect(evaluateC27Exit({ ...input, close: 99.4, barsHeld: 1 })).toBe(
      'stop-loss',
    )
    expect(
      evaluateC27Exit({
        ...input,
        close: 100,
        donchianMid: 100.01,
        barsHeld: 1,
      }),
    ).toBe('stop-loss')
    expect(evaluateC27Exit({ ...input, close: 99.4, barsHeld: 30 })).toBe(
      'time-stop',
    )
    expect(evaluateC27Exit({ ...input, close: 100.3, barsHeld: 30 })).toBe(
      'hold',
    )
    expect(evaluateC27Exit({ ...input, close: 100.8, barsHeld: 30 })).toBe(
      'take-profit',
    )
    expect(
      evaluateC27Exit({
        ...input,
        close: 100,
        donchianMid: 100.01,
        barsHeld: 30,
      }),
    ).toBe('time-stop')
  })

  it('uses the macro Donchian mid for C27 stop-loss rather than a differing 1m mid', () => {
    const base = {
      entryPrice: 100,
      close: 99.5,
      barsHeld: 1,
      macroContext: {
        atrPercentile50: 50,
        donchianHigh20: 101,
        donchianMid20: 100,
      },
    }
    expect(evaluateC27ExitWithMacroContext(base)).toBe('stop-loss')
    expect(
      evaluateC27ExitWithMacroContext({
        ...base,
        macroContext: { ...base.macroContext, donchianMid20: 99 },
      }),
    ).toBe('hold')
    expect(
      evaluateC27ExitWithMacroContext({ ...base, macroContext: null }),
    ).toBe('hold')
  })

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

  it('classifies C28 from the supplied macro ATR percentile, retaining neutral prior regimes', () => {
    expect(
      evaluateMicroTarget(
        'regime-adapter',
        readyFeatures,
        initialMicroState(),
        { atrPercentile50: 70, donchianHigh20: null, donchianMid20: null },
      ).state.regime,
    ).toBe('trend')
    expect(
      evaluateMicroTarget(
        'regime-adapter',
        readyFeatures,
        initialMicroState(),
        { atrPercentile50: 30, donchianHigh20: null, donchianMid20: null },
      ).state.regime,
    ).toBe('range')
    expect(
      evaluateMicroTarget(
        'regime-adapter',
        readyFeatures,
        { exposure: 'flat', regime: 'trend' },
        { atrPercentile50: 50, donchianHigh20: null, donchianMid20: null },
      ).state.regime,
    ).toBe('trend')
    expect(
      evaluateMicroTarget(
        'regime-adapter',
        readyFeatures,
        initialMicroState(),
        null,
      ).abstained,
    ).toBe(true)
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

  it('uses macro Donchian high for C27 while preserving 1m close and volume confirmation', () => {
    const belowMacroHigh = evaluateMicroTarget(
      'donchian-breakout',
      readyFeatures,
      initialMicroState(),
      { atrPercentile50: 70, donchianHigh20: 13, donchianMid20: 12 },
    )
    expect(belowMacroHigh.target).toBe('flat')

    const aboveMacroHigh = evaluateMicroTarget(
      'donchian-breakout',
      readyFeatures,
      initialMicroState(),
      { atrPercentile50: 70, donchianHigh20: 11, donchianMid20: 10 },
    )
    expect(aboveMacroHigh.target).toBe('long')

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
        readyFeatures,
        initialMicroState(),
        null,
      ).target,
    ).toBe('flat')
  })
})
