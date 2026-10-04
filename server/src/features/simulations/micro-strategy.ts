import type { MicroStrategy } from './candidate-manifest.ts'
import type { DecisionCondition } from '../../domain/contracts.ts'

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

export interface MicroStrategyDiagnostic {
  readonly reasonCode: string
  readonly conditions: readonly DecisionCondition[]
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

export function evaluateC27Exit(
  input: {
    readonly entryPrice: number
    readonly close: number
    readonly donchianMid: number | null
    readonly barsHeld: number
  },
  onDiagnostic?: (diagnostic: MicroStrategyDiagnostic) => void,
): C27ExitReason {
  const conditions: DecisionCondition[] = []
  const emit = (reasonCode: string) =>
    onDiagnostic?.({ reasonCode, conditions })
  if (
    compareAndRecord(
      conditions,
      'c27_close_at_take_profit',
      input.close,
      '>=',
      input.entryPrice * 1.018,
    )
  ) {
    emit('c27_take_profit')
    return 'take-profit'
  }
  if (
    compareAndRecord(
      conditions,
      'c27_close_at_stop_loss',
      input.close,
      '<=',
      input.entryPrice * 0.991,
    ) ||
    (recordAvailability(
      conditions,
      'c27_donchian_mid_available',
      input.donchianMid !== null,
    ) &&
      compareAndRecord(
        conditions,
        'c27_close_below_donchian_mid',
        input.close,
        '<',
        input.donchianMid!,
      ))
  ) {
    emit('c27_stop_loss')
    return 'stop-loss'
  }
  if (
    compareAndRecord(
      conditions,
      'c27_bars_held_reached_time_stop',
      input.barsHeld,
      '>=',
      8,
    ) &&
    compareAndRecord(
      conditions,
      'c27_close_below_time_stop_threshold',
      input.close,
      '<',
      input.entryPrice * 1.005,
    )
  ) {
    emit('c27_time_stop')
    return 'time-stop'
  }
  emit('c27_hold')
  return 'hold'
}

export function evaluateC27ExitWithMacroContext(
  input: {
    readonly entryPrice: number
    readonly close: number
    readonly macroContext: MicroStrategyMacroContext | null
    readonly barsHeld: number
  },
  onDiagnostic?: (diagnostic: MicroStrategyDiagnostic) => void,
): C27ExitReason {
  return evaluateC27Exit(
    {
      entryPrice: input.entryPrice,
      close: input.close,
      donchianMid: input.macroContext?.donchianMid20 ?? null,
      barsHeld: input.barsHeld,
    },
    onDiagnostic,
  )
}

export function evaluateMicroTarget(
  strategy: MicroStrategy,
  features: MicroStrategyFeatures,
  prior: MicroStrategyState,
  macroContext?: MicroStrategyMacroContext | null,
  onDiagnostic?: (diagnostic: MicroStrategyDiagnostic) => void,
): {
  readonly target: MicroExposure
  readonly state: MicroStrategyState
  readonly abstained: boolean
} {
  if (!features.ready) {
    onDiagnostic?.({
      reasonCode: 'features_not_ready',
      conditions: [
        {
          code: 'features_ready',
          value: false,
          operator: 'is',
          threshold: true,
          passed: false,
        },
      ],
    })
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
    const regimeConditions: DecisionCondition[] = []
    const percentileAvailable = percentile !== null
    regimeConditions.push({
      code: 'atr_percentile_available',
      value: percentileAvailable,
      operator: 'is',
      threshold: true,
      passed: percentileAvailable,
    })
    let regime = prior.regime
    if (
      percentile !== null &&
      compareAndRecord(
        regimeConditions,
        'atr_percentile_above_trend_threshold',
        percentile,
        '>',
        60,
      )
    ) {
      regime = 'trend'
    } else if (
      percentile !== null &&
      compareAndRecord(
        regimeConditions,
        'atr_percentile_below_range_threshold',
        percentile,
        '<',
        40,
      )
    ) {
      regime = 'range'
    }
    if (regime === null) {
      onDiagnostic?.({
        reasonCode: 'regime_unavailable',
        conditions: regimeConditions,
      })
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
    onDiagnostic?.({
      reasonCode: result.reasonCode,
      conditions: [...regimeConditions, ...result.conditions],
    })
    return {
      target: result.target,
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
  onDiagnostic?.({
    reasonCode: result.reasonCode,
    conditions: result.conditions,
  })
  return {
    target: result.target,
    state: { exposure: result.target, regime: prior.regime },
    abstained: false,
  }
}

function evaluateDirect(
  strategy: Exclude<MicroStrategy, 'regime-adapter'>,
  features: MicroStrategyFeatures,
  exposure: MicroExposure,
  macroDonchianHigh20: number | null,
): {
  readonly target: MicroExposure
  readonly reasonCode: string
  readonly conditions: readonly DecisionCondition[]
} {
  const conditions: DecisionCondition[] = []
  const compare = (
    code: string,
    value: number,
    operator: '>' | '>=' | '<' | '<=',
    threshold: number,
  ): boolean => compareAndRecord(conditions, code, value, operator, threshold)
  const available = (code: string, value: number | null): value is number =>
    recordAvailability(conditions, code, value !== null)
  const enter =
    strategy === 'trend-pullback'
      ? compare(
          'entry_ema9_above_ema21',
          features.ema9!,
          '>',
          features.ema21!,
        ) &&
        compare(
          'entry_close_above_sma50',
          features.close,
          '>',
          features.sma50!,
        ) &&
        compare('entry_rsi_below_45', features.rsi14!, '<', 45)
      : strategy === 'bollinger-reversion'
        ? compare(
            'entry_close_below_bollinger_lower',
            features.close,
            '<',
            features.bollingerLower!,
          ) &&
          compare('entry_rsi_below_30', features.rsi14!, '<', 30) &&
          compare(
            'entry_bollinger_width_ratio_at_least_0_01',
            (features.bollingerWidth ?? 0) / features.close,
            '>=',
            0.01,
          )
        : available('entry_donchian_high_available', macroDonchianHigh20) &&
          compare(
            'entry_close_above_donchian_high',
            features.close,
            '>',
            macroDonchianHigh20,
          ) &&
          compare(
            'entry_volume_above_1_25_prior_average',
            features.volume,
            '>',
            1.25 * features.priorVolumeSma20!,
          )
  const exit =
    strategy === 'trend-pullback'
      ? compare(
          'exit_close_below_ema21',
          features.close,
          '<',
          features.ema21!,
        ) || compare('exit_rsi_above_68', features.rsi14!, '>', 68)
      : strategy === 'bollinger-reversion'
        ? compare(
            'exit_close_at_or_above_bollinger_mid',
            features.close,
            '>=',
            features.bollingerMid!,
          ) || compare('exit_rsi_above_55', features.rsi14!, '>', 55)
        : compare(
            'exit_close_below_donchian_mid',
            features.close,
            '<',
            features.donchianMid20!,
          )
  const target =
    exposure === 'long' ? (exit ? 'flat' : 'long') : enter ? 'long' : 'flat'
  const reasonCode =
    exposure === 'long'
      ? exit
        ? 'exit_conditions_met'
        : 'exit_conditions_not_met'
      : enter
        ? 'entry_conditions_met'
        : 'entry_conditions_not_met'
  return { target, reasonCode, conditions }
}

function compareAndRecord(
  conditions: DecisionCondition[],
  code: string,
  value: number,
  operator: '>' | '>=' | '<' | '<=',
  threshold: number,
): boolean {
  const passed =
    operator === '>'
      ? value > threshold
      : operator === '>='
        ? value >= threshold
        : operator === '<'
          ? value < threshold
          : value <= threshold
  conditions.push({ code, value, operator, threshold, passed })
  return passed
}

function recordAvailability(
  conditions: DecisionCondition[],
  code: string,
  available: boolean,
): boolean {
  conditions.push({
    code,
    value: available,
    operator: 'is',
    threshold: true,
    passed: available,
  })
  return available
}
