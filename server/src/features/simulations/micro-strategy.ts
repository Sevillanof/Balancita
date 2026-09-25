import type { MicroStrategy } from './candidate-manifest.ts'

export type MicroExposure = 'flat' | 'long'
export type MicroRegime = 'trend' | 'range' | null

export interface MicroStrategyFeatures {
  readonly ema9: number | null
  readonly ema21: number | null
  readonly sma50: number | null
  readonly rsi14: number | null
  readonly close: number
  readonly bollingerLower: number | null
  readonly bollingerMid: number | null
  readonly atr14: number | null
  readonly priorAtrSma20: number | null
  readonly donchianHigh20: number | null
  readonly donchianLow20?: number | null
  readonly donchianMid20: number | null
  readonly volume: number
  readonly priorVolumeSma20: number | null
  readonly atrPercentile50: number | null
  readonly ready: boolean
}

export interface MicroStrategyState {
  readonly exposure: MicroExposure
  readonly regime: MicroRegime
}

export function initialMicroState(): MicroStrategyState {
  return { exposure: 'flat', regime: null }
}

export type C27ExitReason = 'take-profit' | 'time-stop' | 'stop-loss' | 'hold'

export function evaluateC27Exit(input: {
  readonly entryPrice: number
  readonly close: number
  readonly donchianMid: number | null
  readonly barsHeld: number
}): C27ExitReason {
  if (input.close >= input.entryPrice * 1.008) return 'take-profit'
  if (input.barsHeld >= 10 && input.close < input.entryPrice * 1.003)
    return 'time-stop'
  if (
    input.close <= input.entryPrice * 0.994 ||
    (input.donchianMid !== null && input.close < input.donchianMid)
  )
    return 'stop-loss'
  return 'hold'
}

export function evaluateMicroTarget(
  strategy: MicroStrategy,
  features: MicroStrategyFeatures,
  prior: MicroStrategyState,
): {
  readonly target: MicroExposure
  readonly state: MicroStrategyState
  readonly abstained: boolean
} {
  if (!features.ready) {
    return {
      target: 'flat',
      state: { exposure: 'flat', regime: prior.regime },
      abstained: true,
    }
  }
  if (strategy === 'regime-adapter') {
    const percentile = features.atrPercentile50
    const regime =
      percentile !== null && percentile > 60
        ? 'trend'
        : percentile !== null && percentile < 40
          ? 'range'
          : prior.regime
    if (regime === null) {
      return {
        target: 'flat',
        state: { exposure: 'flat', regime: null },
        abstained: true,
      }
    }
    const selected =
      regime === 'trend' ? 'trend-pullback' : 'bollinger-reversion'
    const result = evaluateDirect(selected, features, prior.exposure)
    return {
      ...result,
      state: { exposure: result.target, regime },
      abstained: false,
    }
  }
  const result = evaluateDirect(strategy, features, prior.exposure)
  return {
    ...result,
    state: { exposure: result.target, regime: prior.regime },
    abstained: false,
  }
}

function evaluateDirect(
  strategy: Exclude<MicroStrategy, 'regime-adapter'>,
  features: MicroStrategyFeatures,
  exposure: MicroExposure,
): { readonly target: MicroExposure } {
  const enter =
    strategy === 'trend-pullback'
      ? features.ema9! > features.ema21! &&
        features.close > features.sma50! &&
        features.rsi14! < 42
      : strategy === 'bollinger-reversion'
        ? features.close < features.bollingerLower! &&
          features.rsi14! < 32 &&
          features.atr14! < features.priorAtrSma20!
        : features.close > features.donchianHigh20! &&
          features.volume > 1.25 * features.priorVolumeSma20!
  const exit =
    strategy === 'trend-pullback'
      ? features.close < features.ema21! || features.rsi14! > 68
      : strategy === 'bollinger-reversion'
        ? features.close >= features.bollingerMid! || features.rsi14! > 55
        : features.close < features.donchianMid20!
  if (exposure === 'long') return { target: exit ? 'flat' : 'long' }
  return { target: enter ? 'long' : 'flat' }
}
