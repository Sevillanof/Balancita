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
  rsi14: 29,
  close: 12,
  bollingerLower: 13,
  bollingerMid: 14,
  bollingerWidth: 2,
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
      close: 100.5,
      donchianMid: 99,
      barsHeld: 7,
    }
    expect(evaluateC27Exit({ ...input, close: 101.8 })).toBe('take-profit')
    expect(evaluateC27Exit({ ...input, close: 100.5 })).toBe('hold')
    expect(evaluateC27Exit({ ...input, close: 100.49, barsHeld: 8 })).toBe(
      'time-stop',
    )
    expect(evaluateC27Exit({ ...input, close: 99.1 })).toBe('stop-loss')
    expect(evaluateC27Exit({ ...input, close: 100, donchianMid: 100.01 })).toBe(
      'stop-loss',
    )
    expect(evaluateC27Exit({ ...input, close: 99.1, barsHeld: 8 })).toBe(
      'stop-loss',
    )
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

  it('exposes branch-computed entry and exit facts without changing the result shape', () => {
    const diagnostics: unknown[] = []
    const entered = evaluateMicroTarget(
      'trend-pullback',
      readyFeatures,
      initialMicroState(),
      undefined,
      (diagnostic) => diagnostics.push(diagnostic),
    )
    expect(entered).toEqual({
      target: 'long',
      state: { exposure: 'long', regime: null },
      abstained: false,
    })
    expect(diagnostics[0]).toMatchObject({
      reasonCode: 'entry_conditions_met',
      conditions: expect.arrayContaining([
        {
          code: 'entry_ema9_above_ema21',
          value: 12,
          operator: '>',
          threshold: 11,
          passed: true,
        },
        {
          code: 'entry_close_above_sma50',
          value: 12,
          operator: '>',
          threshold: 10,
          passed: true,
        },
        {
          code: 'entry_rsi_below_45',
          value: 29,
          operator: '<',
          threshold: 45,
          passed: true,
        },
      ]),
    })

    const failedDiagnostics: unknown[] = []
    const failed = evaluateMicroTarget(
      'trend-pullback',
      { ...readyFeatures, ema9: 10 },
      initialMicroState(),
      undefined,
      (diagnostic) => failedDiagnostics.push(diagnostic),
    )
    expect(failed.target).toBe('flat')
    expect(failedDiagnostics[0]).toMatchObject({
      reasonCode: 'entry_conditions_not_met',
      conditions: expect.arrayContaining([
        {
          code: 'entry_ema9_above_ema21',
          value: 10,
          operator: '>',
          threshold: 11,
          passed: false,
        },
      ]),
    })
    expect(
      (failedDiagnostics[0] as { conditions: unknown[] }).conditions,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'entry_close_above_sma50' }),
      ]),
    )
  })

  it('reports readiness and regime-abstention predicates only when evaluated', () => {
    const unready: unknown[] = []
    expect(
      evaluateMicroTarget(
        'trend-pullback',
        { ...readyFeatures, ready: false },
        initialMicroState(),
        undefined,
        (diagnostic) => unready.push(diagnostic),
      ),
    ).toMatchObject({ target: 'flat', abstained: true })
    expect(unready[0]).toMatchObject({
      reasonCode: 'features_not_ready',
      conditions: expect.arrayContaining([
        {
          code: 'features_ready',
          value: false,
          operator: 'is',
          threshold: true,
          passed: false,
        },
      ]),
    })

    const regime: unknown[] = []
    const result = evaluateMicroTarget(
      'regime-adapter',
      readyFeatures,
      initialMicroState(),
      null,
      (diagnostic) => regime.push(diagnostic),
    )
    expect(result).toMatchObject({ target: 'flat', abstained: true })
    expect(regime[0]).toMatchObject({
      reasonCode: 'regime_unavailable',
      conditions: expect.arrayContaining([
        {
          code: 'atr_percentile_available',
          value: false,
          operator: 'is',
          threshold: true,
          passed: false,
        },
      ]),
    })

    for (const percentile of [40, 60]) {
      const boundary: unknown[] = []
      const decision = evaluateMicroTarget(
        'regime-adapter',
        { ...readyFeatures, atrPercentile50: percentile },
        initialMicroState(),
        undefined,
        (diagnostic) => boundary.push(diagnostic),
      )
      expect(decision.abstained).toBe(true)
      expect(boundary[0]).toMatchObject({
        reasonCode: 'regime_unavailable',
        conditions: expect.arrayContaining([
          expect.objectContaining({
            value: percentile,
            passed: false,
          }),
        ]),
      })
    }

    for (const [percentile, expectedRegime] of [
      [39.99, 'range'],
      [60.01, 'trend'],
    ] as const) {
      const decision = evaluateMicroTarget(
        'regime-adapter',
        { ...readyFeatures, atrPercentile50: percentile },
        initialMicroState(),
      )
      expect(decision.state.regime).toBe(expectedRegime)
    }
  })

  it('reports the existing long-position exit predicates without changing target', () => {
    const diagnostics: unknown[] = []
    const decision = evaluateMicroTarget(
      'trend-pullback',
      readyFeatures,
      { exposure: 'long', regime: null },
      undefined,
      (diagnostic) => diagnostics.push(diagnostic),
    )
    expect(decision.target).toBe('long')
    expect(diagnostics[0]).toMatchObject({
      reasonCode: 'exit_conditions_not_met',
      conditions: expect.arrayContaining([
        {
          code: 'exit_close_below_ema21',
          value: 12,
          operator: '<',
          threshold: 11,
          passed: false,
        },
        {
          code: 'exit_rsi_above_68',
          value: 29,
          operator: '>',
          threshold: 68,
          passed: false,
        },
      ]),
    })
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
