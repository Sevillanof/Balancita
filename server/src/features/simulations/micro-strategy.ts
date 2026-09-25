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
  readonly bollingerUpper?: number | null
  readonly bollingerWidth?: number | null
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

export interface MicroStrategyMacroContext {
  readonly atrPercentile50: number | null
  readonly donchianHigh20: number | null
  readonly donchianMid20: number | null
}

export function macroContextWhenReady(
  features: MicroStrategyFeatures | null,
): MicroStrategyMacroContext | null {
  if (features?.ready !== true) return null
  return {
    atrPercentile50: features.atrPercentile50,
    donchianHigh20: features.donchianHigh20,
    donchianMid20: features.donchianMid20,
  }
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
  if (input.close >= input.entryPrice * 1.018) return 'take-profit'
  if (
    input.close <= input.entryPrice * 0.991 ||
    (input.donchianMid !== null && input.close < input.donchianMid)
  )
    return 'stop-loss'
  if (input.barsHeld >= 8 && input.close < input.entryPrice * 1.005)
    return 'time-stop'
  return 'hold'
}

export function evaluateC27ExitWithMacroContext(input: {
  readonly entryPrice: number
  readonly close: number
  readonly macroContext: MicroStrategyMacroContext | null
  readonly barsHeld: number
}): C27ExitReason {
  return evaluateC27Exit({
    entryPrice: input.entryPrice,
    close: input.close,
    donchianMid: input.macroContext?.donchianMid20 ?? null,
    barsHeld: input.barsHeld,
  })
}

export function evaluateMicroTarget(
  strategy: MicroStrategy,
  features: MicroStrategyFeatures,
  prior: MicroStrategyState,
  macroContext?: MicroStrategyMacroContext | null,
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
  const donchianHigh20 =
    macroContext === undefined
      ? features.donchianHigh20
      : (macroContext?.donchianHigh20 ?? null)
  if (strategy === 'regime-adapter') {
    const percentile =
      macroContext === undefined
        ? features.atrPercentile50
        : (macroContext?.atrPercentile50 ?? null)
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
    const result = evaluateDirect(
      selected,
      features,
      prior.exposure,
      donchianHigh20,
    )
    return {
      ...result,
      state: { exposure: result.target, regime },
      abstained: false,
    }
  }
  const result = evaluateDirect(
    strategy,
    features,
    prior.exposure,
    donchianHigh20,
  )
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
  macroDonchianHigh20: number | null,
): { readonly target: MicroExposure } {
  const enter =
    strategy === 'trend-pullback'
      ? features.ema9! > features.ema21! &&
        features.close > features.sma50! &&
        features.rsi14! < 45
      : strategy === 'bollinger-reversion'
        ? features.close < features.bollingerLower! &&
          features.rsi14! < 30 &&
          (features.bollingerWidth ?? 0) / features.close >= 0.01
        : macroDonchianHigh20 !== null &&
          features.close > macroDonchianHigh20 &&
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
